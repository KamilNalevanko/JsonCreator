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

/** Remove internal PDF print/layout identifiers and other noise from extracted text */
function cleanPageText(text: string): string {
  return text
    // Kaufland internal page IDs: e.g. S1-SK-KW10-LFT-TITULKA-1020-11
    .replace(/\bS\d+-SK-[A-Z]{2}\d+-LFT-[A-Z0-9_]+-\d+-\d+\b/g, "")
    // Generic fallback: ALL-CAPS token with 3+ dashes (internal layout codes)
    .replace(/\b[A-Z0-9]{2,}-[A-Z0-9]{2,}-[A-Z0-9]{2,}-[A-Z0-9_]{3,}(?:-[A-Z0-9_]+){2,}\b/g, "")
    // Collapse multiple spaces left by removed tokens
    .replace(/ {2,}/g, " ")
    .trim();
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

    const doc = await pdfjs.getDocument({
      data: buffer,
    }).promise;

    const pages = Math.min(doc.numPages, MAX_PAGES);
    const pageTexts: { text: string; pageNum: number }[] = [];

    // Extract text from each page, sorted by visual reading order (top→bottom, left→right)
    for (let i = 1; i <= pages; i++) {
      try {
        const page = await doc.getPage(i);
        const textContent = await page.getTextContent();

        interface PdfTextItem {
          str?: string;
        }

        const items = (textContent?.items || [] as PdfTextItem[])
          .map((item) => ((item as PdfTextItem)?.str || "").toString().trim())
          .filter((str) => str.length > 0);

        if (items.length === 0) {
          pageTexts.push({ text: "", pageNum: i });
          continue;
        }

        // Use raw pdfjs order — content stream order matches visual block order
        // in professionally-made PDFs (InDesign/Illustrator)
        const raw = items.join(" ");

        const text = cleanPageText(raw);
        pageTexts.push({ text, pageNum: i });
      } catch (error) {
        console.error(`Chyba pri extrakcii textu zo strany ${i}:`, error);
        pageTexts.push({ text: "", pageNum: i });
      }
    }

    const allPageTexts = pageTexts.filter((p) => p.text.length > 0);

    if (allPageTexts.length === 0) {
      return Response.json(
        { error: "PDF neobsahuje žiadny čitateľný text." },
        { status: 400 }
      );
    }

    const combinedText = allPageTexts.map((p) => `=== STRANA ${p.pageNum} ===\n${p.text}`).join("\n\n---\n\n");
    console.log(`Spracovávam ${pages} strán v dávkach...`);

    // Detect shop and country from first few pages
    const sampleText = allPageTexts.slice(0, 5).map((p) => p.text).join(" ");
    const { shop: detectedShop, country: detectedCountry } = detectShopAndCountry(sampleText);

    // Split pages into batches of 10 to avoid output token limits
    const BATCH_SIZE = 10;
    const batches: { text: string; pageNum: number }[][] = [];
    for (let i = 0; i < allPageTexts.length; i += BATCH_SIZE) {
      batches.push(allPageTexts.slice(i, i + BATCH_SIZE));
    }

    const PRODUCT_SCHEMA = `{
  "meta": { "date_from": "DD.MM.YYYY alebo null", "date_to": "DD.MM.YYYY alebo null" },
  "products": [{ "name": "...", "amount": "...", "unit": "g/kg/ml/l/ks/null", "price_sale": "...", "price_regular": "...", "note": "...", "page": N }]
}`;

    const PRODUCT_RULES = `PRAVIDLÁ:

ČO EXTRAHOVAŤ:
- IBA potraviny, nápoje a alkohol
- Ignorovať: kvety, dekorácie, čistiace prostriedky, toaletný papier, oblečenie, elektroniku, krmivo pre zvieratá, náradie, kozmetiku

POLE "name":
- Len čistý názov produktu (napr. "Bravčová krkovička", "Tavený syr", "Jablko červené")
- NEPATRÍ sem: hmotnosť, objem, % alkoholu, počet kusov, "rôzne druhy" (ak nie je súčasťou názvu)
- "rôzne druhy" môže ostať ak nie je spresňujúci popis dostupný
- Špecifikácie typu "bez kosti, v celku", "pultový predaj" patria do "note"

POLE "amount" a "unit":
- amount: len číslo (napr. "200", "1", "0.5")
- unit: g / kg / ml / l / ks / zväzok / balenie / null

POLE "price_sale" a "price_regular":
- price_regular = PÔVODNÁ (prečiarknutá / väčšia) cena, napr. "4,99"
- price_sale = AKCIOVÁ (zvýraznená veľká) cena, napr. "3,49"
- DÔLEŽITÉ: price_sale musí byť NIŽŠIA ako price_regular (ak máš len jednu cenu, daj ju do price_sale)
- "Card" cena (vernostná karta) = price_sale
- Ceny v zátvorkách ako "(=1 kg KC: 3,61 / BC: 6,80)" alebo "(=1 kus 0,27)" SÚ CENY ZA KG/KUS, NIE skutočné ceny balenia — IGNORUJ ICH
- Ak cenu nevidíš alebo si nie si istý, nechaj pole prázdne — NEVYMÝŠĽAJ

POLE "note":
- Sem patria: "pultový predaj", "bez kosti", "v celku", "pevný podiel 120g", "+ záloh za obaly 1,04", zľavové percentá

OSTATNÉ:
- Dátumy v tvare DD.MM.YYYY alebo null
- page: číslo strany z === STRANA N === hlavičky kde bol produkt nájdený`;

    // Run all batches in parallel for ~8x speedup
    const batchResults = await Promise.all(
      batches.map(async (batch, batchIdx) => {
        const batchText = batch.map((p) => `=== STRANA ${p.pageNum} ===\n${p.text}`).join("\n\n---\n\n");
        const isFirst = batchIdx === 0;

        const response = await client.chat.completions.create({
          model: "gpt-4.1-mini",
          response_format: { type: "json_object" },
          max_tokens: 16000,
          messages: [
            {
              role: "user",
              content: `Analyzuj text z PDF letáčka supermarketu (dávka ${batchIdx + 1}/${batches.length}) a extrahuj všetky potraviny a nápoje.

VÝSTUP v JSON:
${PRODUCT_SCHEMA}

${PRODUCT_RULES}
${!isFirst ? '- meta.date_from a meta.date_to môžeš nastaviť na null ak dátumy nie sú v tejto dávke viditeľné' : ''}

TEXT:
${batchText}`,
            },
          ],
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

    // Return format expected by handleAiExtract
    const result: Record<string, unknown> = {
      meta,
      items,
      detectedShop: detectedShop ?? null,
      detectedCountry: detectedCountry ?? null,
    };

    // Add debug text if requested
    if (form.get("debug") === "1") {
      result.debugText = combinedText;
    }

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
