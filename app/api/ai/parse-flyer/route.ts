import OpenAI from "openai";
import { pathToFileURL } from "url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PAGES = 78;

interface Product {
  name: string;
  amount: string;
  unit: string;
  price_sale: string;
  price_regular: string;
  note: string;
  page?: number;
}

interface ParsedResponse {
  meta?: {
    date_from?: string;
    date_to?: string;
  };
  products?: Product[];
}
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SHOP_PATTERNS: Array<{ pattern: RegExp; shop: string; country?: string }> = [
  { pattern: /\bkaufland\b/i, shop: "kaufland" },
  { pattern: /\blidl\b/i, shop: "lidl" },
  { pattern: /\bbilla\b/i, shop: "billa" },
  { pattern: /\btesco\b/i, shop: "tesco-hypermarket" },
  { pattern: /\bcoop\s*jednota\b/i, shop: "coop-jednota" },
  { pattern: /\balbert\b/i, shop: "albert-hypermarket" },
  { pattern: /\bglobus\b/i, shop: "globus" },
  { pattern: /\bpenny\b/i, shop: "peny" },
  { pattern: /\baldi\b/i, shop: "aldi" },
  { pattern: /\bbiedronka\b/i, shop: "biedronka", country: "pl" },
  { pattern: /\bauchan\b/i, shop: "auchan-hypermarket" },
  { pattern: /\bcarrefour\b/i, shop: "carrefour" },
  { pattern: /\b[zż]abka\b/i, shop: "zabka", country: "pl" },
  { pattern: /\blewiatan\b/i, shop: "lewiatan", country: "pl" },
  { pattern: /\bdino\b/i, shop: "dino", country: "pl" },
];

const COUNTRY_PATTERNS: Array<{ pattern: RegExp; country: string }> = [
  { pattern: /\b(slovakia|slovensko|slovenská republika)\b/i, country: "sk" },
  { pattern: /\b(czech|česká republika|czechia)\b/i, country: "cz" },
  { pattern: /\b(poland|polska|rzeczpospolita)\b/i, country: "pl" },
  // price format hints
  { pattern: /\b\d+[,.]\d+\s*€/i, country: "sk" },
  { pattern: /\b\d+[,.]\d+\s*Kč/i, country: "cz" },
  { pattern: /\b\d+[,.]\d+\s*zł/i, country: "pl" },
];

function detectShopAndCountry(text: string): { shop: string | null; country: string | null } {
  let shop: string | null = null;
  let country: string | null = null;

  for (const { pattern, shop: s, country: c } of SHOP_PATTERNS) {
    if (pattern.test(text)) {
      shop = s;
      if (c) country = c;
      break;
    }
  }
  if (!country) {
    for (const { pattern, country: c } of COUNTRY_PATTERNS) {
      if (pattern.test(text)) {
        country = c;
        break;
      }
    }
  }
  return { shop, country };
}


export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return Response.json(
        { error: "Chýba OPENAI_API_KEY v prostredí." },
        { status: 500 }
      );
    }

    const form = await req.formData();
    const file = form.get("file");

    if (!file || !(file instanceof File)) {
      return Response.json({ error: "Chýba PDF súbor." }, { status: 400 });
    }

    // Extract text from PDF
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const requireAny = eval("require");

    const buffer = new Uint8Array(await file.arrayBuffer());

    if (pdfjs?.GlobalWorkerOptions) {
      try {
        const workerPath = requireAny.resolve("pdfjs-dist/build/pdf.worker.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).toString();
      } catch {
        pdfjs.GlobalWorkerOptions.workerSrc = "";
      }
      pdfjs.GlobalWorkerOptions.workerPort = null;
    }

    const { createCanvas } = await import("@napi-rs/canvas");

    // pdfjs v5.5 in Node.js auto-uses its built-in NodeCanvasFactory with @napi-rs/canvas
    const doc = await pdfjs.getDocument({
      data: buffer,
    }).promise;

    const pages = Math.min(doc.numPages, MAX_PAGES);

    // Quick text extraction from first few pages for shop/country detection
    interface PdfTextItem { str?: string; }
    const textSamplePages: string[] = [];
    for (let i = 1; i <= Math.min(3, pages); i++) {
      try {
        const page = await doc.getPage(i);
        const textContent = await page.getTextContent();
        const text = (textContent?.items ?? [])
          .map((it) => ((it as PdfTextItem)?.str ?? "").trim())
          .filter(Boolean)
          .join(" ");
        textSamplePages.push(text);
      } catch { /* skip */ }
    }
    const { shop: detectedShop, country: detectedCountry } = detectShopAndCountry(textSamplePages.join(" "));

    // Render all pages to JPEG images (serially to keep memory usage stable)
    const RENDER_SCALE = 1.5;
    const pageImages: { pageNum: number; imageData: string }[] = [];

    for (let i = 1; i <= pages; i++) {
      try {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
        const ctx = canvas.getContext("2d");

        await page.render({
          canvasContext: ctx as unknown as CanvasRenderingContext2D,
          canvas: canvas as unknown as HTMLCanvasElement,
          viewport,
        }).promise;

        const jpegBuffer = await canvas.encode("jpeg", 85);
        const imageData = Buffer.from(jpegBuffer).toString("base64");
        pageImages.push({ pageNum: i, imageData });
      } catch (e) {
        console.error(`Chyba pri renderovaní strany ${i}:`, e);
      }
    }

    if (pageImages.length === 0) {
      return Response.json(
        { error: "Nepodarilo sa vyrenderovať žiadnu stranu PDF." },
        { status: 400 }
      );
    }

    console.log(`Vyrenderovaných ${pageImages.length} strán, spracovávam cez Vision AI...`);

    // Batch pages for vision API (2 pages per call for better accuracy)
    const VISION_BATCH_SIZE = 2;
    const batches: { pageNum: number; imageData: string }[][] = [];
    for (let i = 0; i < pageImages.length; i += VISION_BATCH_SIZE) {
      batches.push(pageImages.slice(i, i + VISION_BATCH_SIZE));
    }

    const PRODUCT_SCHEMA = `{
  "meta": { "date_from": "DD.MM.YYYY alebo null", "date_to": "DD.MM.YYYY alebo null" },
  "products": [{ "name": "...", "amount": "...", "unit": "g/kg/ml/l/ks/null", "price_sale": "...", "price_regular": "...", "note": "...", "page": N }]
}`;

    const PRODUCT_RULES = `PRAVIDLÁ:

ČO EXTRAHOVAŤ:
- IBA potraviny, nápoje a alkohol (vrátane piva, vína, destilátov, múky, cukru, atď.)
- KAŽDÝ produkt na strane — aj malé, aj v rohoch, aj čiastočne orezané
- Ignorovať: kvety, dekorácie, čistiace prostriedky, toaletný papier, oblečenie, elektroniku, krmivo pre zvieratá, náradie, kozmetiku
- JEDEN produkt = JEDEN záznam. Ak obrázok a text vedľa patria k tomu istému produktu, je to JEDEN produkt

POLE "name":
- Skombinuj popis produktu z textu letáka + značku/názov produktu
- Príklady správnych názvov:
  • "Tavený syr syrokrém" (text letáka "Tavený syr" + značka "syrokrém")
  • "Sladené kondenzované mlieko Salko" (popis + značka)
  • "Dezert Toffifee" (kategória + značka)
  • "Svetlý ležiak Pilsner Urquell" (typ + značka)
  • "Maslo 82%" (produkt + špecifikácia)
  • "Jablko červené" (produkt + farba/druh)
- NEPATRÍ sem: hmotnosť v gramoch, objem v ml/l, počet kusov v balení

POLE "note" (doplnková informácia):
- LEN popisný text menším písmom pod názvom produktu: "rôzne druhy", "bez kosti", "pevný podiel 120 g"
- Pri multipackoch: "8x0.5l", "5 kusov"
- NEPATRÍ sem: percentá zľavy (-43%, -50%, Card -45%), ceny, hmotnosť ak je v "amount", "pultový predaj"
- Ak produkt nemá žiadny popis pod názvom, nechaj prázdne ""

POLE "amount" a "unit":
- amount: len číslo (napr. "200", "1", "0.5")
- unit: g / kg / ml / l / ks / zväzok / null
- Pri multipackoch: amount = veľkosť jedného kusu, multipack info do "note"

POLE "price_sale" a "price_regular":
- price_sale = NAJVÄČŠIA, NAJZVÝRAZNENEJŠIA cena pri produkte = akciová/Card cena (vždy najnižšia)
- price_regular = PREČIARKNUTÁ pôvodná cena
- Ak sú 3 ceny: price_sale = Card cena (najnižšia), price_regular = prečiarknutá (najvyššia)
- price_sale MUSÍ BYŤ NIŽŠIA ako price_regular
- IGNORUJ: ceny v zátvorkách "(=1 kg ...)", "(=1 l ...)", riadky "A: X,XX", "KC: X,XX"
- Ak cenu nevidíš, nechaj pole prázdne — NEVYMÝŠĽAJ

PRÍKLAD výstupu pre jednu stranu:
[
  {"name":"Jablko červené","amount":"1","unit":"kg","price_sale":"0,69","price_regular":"1,29","note":"","page":1},
  {"name":"Tavený syr syrokrém","amount":"200","unit":"g","price_sale":"1,59","price_regular":"3,49","note":"","page":1},
  {"name":"Tuniak","amount":"170","unit":"g","price_sale":"1,39","price_regular":"2,49","note":"rôzne druhy","page":1},
  {"name":"Dezert Toffifee","amount":"125","unit":"g","price_sale":"1,35","price_regular":"2,65","note":"rôzne druhy","page":1},
  {"name":"Svetlý ležiak Pilsner Urquell","amount":"0,5","unit":"l","price_sale":"6,99","price_regular":"7,89","note":"8x0.5l","page":1}
]

OSTATNÉ:
- Dátumy v tvare DD.MM.YYYY alebo null
- "page": číslo strany z textu === STRANA N === nad obrázkom
- Radšej extrahuj produkt s neúplnými údajmi ako ho vynechať`;

    type VisionContentPart =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail: "high" | "low" | "auto" } };

    // Run all vision batches in parallel
    const batchResults = await Promise.all(
      batches.map(async (batch, batchIdx) => {
        const isFirst = batchIdx === 0;

        const content: VisionContentPart[] = [
          {
            type: "text",
            text: `Analyzuj obrázky strán z letáka supermarketu (dávka ${batchIdx + 1}/${batches.length}) a extrahuj všetky potraviny a nápoje.\n\nVÝSTUP v JSON:\n${PRODUCT_SCHEMA}\n\n${PRODUCT_RULES}${!isFirst ? "\n- meta dátumy môžeš nastaviť na null ak nie sú na týchto stranách viditeľné" : ""}`,
          },
        ];

        for (const pg of batch) {
          content.push({ type: "text", text: `=== STRANA ${pg.pageNum} ===` });
          content.push({
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${pg.imageData}`,
              detail: "high",
            },
          });
        }

        const response = await client.chat.completions.create({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          max_tokens: 8000,
          messages: [{ role: "user", content: content as OpenAI.Chat.ChatCompletionContentPart[] }],
        });

        const responseText = response.choices?.[0]?.message?.content?.trim() ?? "";
        if (!responseText) return null;

        try {
          return JSON.parse(responseText) as ParsedResponse;
        } catch {
          const start = responseText.indexOf("{");
          const end = responseText.lastIndexOf("}");
          if (start !== -1 && end !== -1 && end > start) {
            try {
              return JSON.parse(responseText.slice(start, end + 1)) as ParsedResponse;
            } catch {
              console.error(`Dávka ${batchIdx + 1}: neplatný JSON, preskakujem`);
            }
          }
          return null;
        }
      })
    );

    const meta = { date_from: "", date_to: "" };
    const allProducts: Product[] = [];

    for (const parsed of batchResults) {
      if (!parsed) continue;
      if (!meta.date_from && parsed.meta?.date_from) meta.date_from = parsed.meta.date_from;
      if (!meta.date_to && parsed.meta?.date_to) meta.date_to = parsed.meta.date_to;
      if (Array.isArray(parsed.products)) allProducts.push(...parsed.products);
    }

    // Deduplicate by name (keep first occurrence)
    const seen = new Set<string>();
    const deduped = allProducts.filter((p) => {
      const key = (p.name || "").toLowerCase().trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const items = deduped.map((item: Product) => ({
      name: item.name || "",
      amount: item.amount || "",
      unit: item.unit || "",
      price_sale: item.price_sale || "",
      price_regular: item.price_regular || "",
      note: item.note || "",
      date_from: meta.date_from,
      date_to: meta.date_to,
      page: item.page ?? null,
    }));

    const result: Record<string, unknown> = {
      meta,
      items,
      detectedShop: detectedShop ?? null,
      detectedCountry: detectedCountry ?? null,
    };

    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Neznáma chyba";
    console.error("Chyba pri spracovaní PDF:", message);
    return Response.json(
      { error: message, success: false },
      { status: 500 }
    );
  }
}

export async function GET() {
  return Response.json({
    message: "PDF Parser API (Text only - OpenAI)",
    status: "ready",
    apiKeyConfigured: !!process.env.OPENAI_API_KEY,
  });
}
