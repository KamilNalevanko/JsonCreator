import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import hierarchyData from "../../../../assets/hierarchia.json";
import skLabels from "../../../../assets/langs/sk.json";
import czLabels from "../../../../assets/langs/cs.json";
import plLabels from "../../../../assets/langs/pl.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_PAGES = 15;

interface Product {
  name: string;
  amount: string;
  unit: string;
  price_sale: string;
  price_regular: string;
  note: string;
  page?: number;
  placementKey?: string;
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

    // Support two modes:
    // 1) JSON body with storagePath (PDF stored in Supabase) — used on Vercel
    // 2) FormData with file (direct upload) — fallback / local dev
    let buffer: Uint8Array;
    let formCountry = "";

    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await req.json();
      formCountry = (body.country as string) || "";
      const storagePath = (body.storagePath as string) || "";
      if (!storagePath) {
        return Response.json({ error: "Chýba PDF (storagePath)." }, { status: 400 });
      }
      // Download PDF from Supabase Storage
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
      const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseUrl || !serviceRole) {
        return Response.json({ error: "Missing SUPABASE env." }, { status: 500 });
      }
      const sb = createClient(supabaseUrl, serviceRole);
      const { data: blob, error: dlErr } = await sb.storage.from("cap-data").download(storagePath);
      if (dlErr || !blob) {
        return Response.json({ error: `PDF download failed: ${dlErr?.message || "no data"}` }, { status: 400 });
      }
      buffer = new Uint8Array(await blob.arrayBuffer());
      // Clean up temp file (fire and forget)
      sb.storage.from("cap-data").remove([storagePath]).catch(() => {});
    } else {
      const form = await req.formData();
      const file = form.get("file");
      formCountry = (form.get("country") as string | null) || "";
      if (!file || !(file instanceof File)) {
        return Response.json({ error: "Chýba PDF súbor." }, { status: 400 });
      }
      buffer = new Uint8Array(await file.arrayBuffer());
    }

    // Extract text from PDF
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

    // Point worker to the module specifier so pdfjs can resolve it in Node.js / Vercel
    pdfjs.GlobalWorkerOptions.workerSrc = "pdfjs-dist/legacy/build/pdf.worker.mjs";

    const { createCanvas } = await import("@napi-rs/canvas");

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

    // Determine language: prefer auto-detection from PDF content, fallback to form
    const country = detectedCountry || formCountry || "sk";
    const lang = country === "pl" ? "pl" : country === "cz" ? "cz" : "sk";

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

    // Batch pages for vision API (4 pages per call)
    const VISION_BATCH_SIZE = 4;
    const batches: { pageNum: number; imageData: string }[][] = [];
    for (let i = 0; i < pageImages.length; i += VISION_BATCH_SIZE) {
      batches.push(pageImages.slice(i, i + VISION_BATCH_SIZE));
    }

    const PRODUCT_SCHEMA = `{
  "meta": { "date_from": "DD.MM.YYYY or null", "date_to": "DD.MM.YYYY or null" },
  "products": [{ "name": "...", "amount": "...", "unit": "g/kg/ml/l/ks/null", "price_sale": "...", "price_regular": "...", "note": "...", "page": N, "placementKey": "..." }]
}`;

    // Build placement lookup + translated list for AI
    type HierarchyItem = { "Kategória": string; "Podkategórie": { "Podkategória": string; "Zaradenia": { "Zaradenie": string }[] }[] };
    const labelsMap: Record<string, Record<string, string>> = { sk: skLabels, cz: czLabels, pl: plLabels };
    const labels = labelsMap[lang] || skLabels;
    const placementLookup: Record<string, { categoryKey: string; subcategoryKey: string }> = {};
    const placementPairs: string[] = [];
    for (const cat of hierarchyData as HierarchyItem[]) {
      for (const sub of cat["Podkategórie"]) {
        for (const z of sub["Zaradenia"]) {
          const key = z["Zaradenie"];
          placementLookup[key] = {
            categoryKey: cat["Kategória"],
            subcategoryKey: sub["Podkategória"],
          };
          const label = (labels as Record<string, string>)[key] || key;
          placementPairs.push(`${key}:${label}`);
        }
      }
    }
    const PLACEMENTS_PROMPT = placementPairs.join(", ");

    // Load known products from DB for classification hints
    let knownProductsPrompt = "";
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
      const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (supabaseUrl && serviceRole) {
        const supabaseDb = createClient(supabaseUrl, serviceRole);
        const { data: rows } = await supabaseDb
          .from("master_products_v2")
          .select("name, placement")
          .not("placement", "eq", "")
          .limit(3000);
        if (rows && rows.length > 0) {
          // Deduplicate: unique name→placement pairs
          const seen = new Set<string>();
          const pairs: string[] = [];
          for (const r of rows) {
            const key = (r.name || "").toLowerCase().trim();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            pairs.push(`${r.name}→${r.placement}`);
          }
          if (pairs.length > 0) {
            // Limit to ~1500 to keep prompt size reasonable
            const limited = pairs.slice(0, 1500);
            knownProductsPrompt = `\n\nKNOWN PRODUCTS from database (product name → placementKey). Use these as reference when classifying similar products:\n${limited.join("\n")}`;
          }
        }
      }
    } catch (e) {
      console.error("Failed to load known products from DB:", e);
    }

    // Language-specific prompt parts
    const LANG_CONFIG = {
      sk: {
        intro: "Analyzuj obrázky strán z letáka supermarketu a extrahuj všetky potraviny a nápoje.",
        nameRule: `POLE "name":
- Všetky názvy MUSIA byť v SLOVENČINE — presne ako sú napísané v letáku
- Používaj správnu slovenskú diakritiku: á, é, í, ó, ú, ý, š, č, ž, ť, ď, ň, ľ, ĺ, ŕ, ä, ô
- Skombinuj popis produktu z textu letáka + značku/názov produktu
- Príklady: "Tavený syr syrokrém", "Sladené kondenzované mlieko Salko", "Dezert Toffifee", "Svetlý ležiak Pilsner Urquell", "Maslo 82%", "Jablko červené"`,
        noteRule: `POLE "note": LEN popisný text pod názvom: "rôzne druhy", "bez kosti", "pevný podiel 120 g", "8x0.5l"`,
        examples: `[
  {"name":"Jablko červené","amount":"1","unit":"kg","price_sale":"0,69","price_regular":"1,29","note":"","page":1},
  {"name":"Tavený syr syrokrém","amount":"200","unit":"g","price_sale":"1,59","price_regular":"3,49","note":"","page":1},
  {"name":"Tuniak","amount":"170","unit":"g","price_sale":"1,39","price_regular":"2,49","note":"rôzne druhy","page":1},
  {"name":"Svetlý ležiak Pilsner Urquell","amount":"0,5","unit":"l","price_sale":"6,99","price_regular":"7,89","note":"8x0.5l","page":1}
]`,
        noDateHint: "meta dátumy môžeš nastaviť na null ak nie sú na týchto stranách viditeľné",
      },
      pl: {
        intro: "Przeanalizuj zdjęcia stron z gazetki supermarketu i wyodrębnij wszystkie produkty spożywcze i napoje.",
        nameRule: `POLE "name":
- Wszystkie nazwy MUSZĄ być po POLSKU — dokładnie jak są napisane w gazetce
- Używaj poprawnej polskiej pisowni: ą, ę, ć, ł, ń, ó, ś, ź, ż
- Połącz opis produktu z tekstu gazetki + markę/nazwę produktu
- Przykłady: "Masło extra 82%", "Ser żółty Gouda", "Piwo Żywiec", "Jabłko Red Delicious", "Szynka konserwowa"`,
        noteRule: `POLE "note": TYLKO tekst opisowy pod nazwą: "różne rodzaje", "bez kości", "5 sztuk", "6x0.33l"`,
        examples: `[
  {"name":"Jabłko czerwone","amount":"1","unit":"kg","price_sale":"3,99","price_regular":"5,99","note":"","page":1},
  {"name":"Masło extra 82%","amount":"200","unit":"g","price_sale":"4,49","price_regular":"6,99","note":"","page":1},
  {"name":"Ser żółty Gouda","amount":"300","unit":"g","price_sale":"7,99","price_regular":"10,99","note":"różne rodzaje","page":1}
]`,
        noDateHint: "meta daty ustaw na null jeśli nie są widoczne na tych stronach",
      },
      cz: {
        intro: "Analyzuj obrázky stránek z letáku supermarketu a extrahuj všechny potraviny a nápoje.",
        nameRule: `POLE "name":
- Všechny názvy MUSÍ být v ČEŠTINĚ — přesně jak jsou napsány v letáku
- Používej správnou českou diakritiku: á, é, í, ó, ú, ý, š, č, ž, ť, ď, ň, ě, ř, ů
- Zkombinuj popis produktu z textu letáku + značku/název produktu
- Příklady: "Tavený sýr", "Slazené kondenzované mléko", "Dezert Toffifee", "Pivo Pilsner Urquell", "Máslo 82%", "Jablko červené"`,
        noteRule: `POLE "note": JEN popisný text pod názvem: "různé druhy", "bez kosti", "5 kusů", "8x0.5l"`,
        examples: `[
  {"name":"Jablko červené","amount":"1","unit":"kg","price_sale":"19,90","price_regular":"29,90","note":"","page":1},
  {"name":"Tavený sýr","amount":"200","unit":"g","price_sale":"34,90","price_regular":"49,90","note":"","page":1},
  {"name":"Pivo Pilsner Urquell","amount":"0,5","unit":"l","price_sale":"19,90","price_regular":"27,90","note":"různé druhy","page":1}
]`,
        noDateHint: "meta data nastav na null pokud nejsou na těchto stránkách viditelná",
      },
    };

    const lc = LANG_CONFIG[lang as keyof typeof LANG_CONFIG] || LANG_CONFIG.sk;

    const PRODUCT_RULES = `RULES:

EXTRACT:
- ONLY food, drinks and alcohol (beer, wine, spirits, flour, sugar, canned food, legumes, nuts, spices, tea, coffee, pasta, rice, oils, sauces, jams, honey, salami, sausages, ham, bacon, smoked meats)
- EVERY product on the page — small, in corners, partially cropped, private label (K-Classic, Clever, etc.)
- IGNORE: flowers, decorations, cleaning products, toilet paper, clothing, electronics, pet food, tools, cosmetics
- IGNORE: baby food, infant formula, baby milk, follow-on milk (Bebilon, Nutrilon, Bobovita baby, HiPP baby, Lupilu baby, Nestlé baby, NAN, Humana, Hami, Kendamil)
- ONE product = ONE record

${lc.nameRule}
- NOT here: weight in grams, volume in ml/l, number of packs

${lc.noteRule}
- NOT here: discount percentages (-43%, -50%, Card -45%), prices, weight if already in "amount"
- If no extra info, use empty ""

FIELD "amount" and "unit":
- amount: only number (e.g. "200", "1", "0.5")
- unit: g / kg / ml / l / ks / null
- Multipacks: amount = single item size, multipack info in "note"

FIELD "price_sale" and "price_regular":
- price_sale = BIGGEST, MOST PROMINENT price = sale/Card price (always lowest)
- price_regular = CROSSED OUT original price
- If 3 prices: price_sale = Card price (lowest), price_regular = crossed out (highest)
- price_sale MUST BE LOWER than price_regular  
- IGNORE: prices in brackets "(=1 kg ...)", "(=1 l ...)", lines "A: X,XX", "KC: X,XX"
- If you can't see a price, leave it empty — DO NOT INVENT

EXAMPLE output:
${lc.examples}

CLASSIFICATION — assign "placementKey" from this list (key:label format):
${PLACEMENTS_PROMPT}
- Use ONLY the key part (before colon), the label is just a hint for you
- Pick the single best matching placement key for each product
- If no good match, use ""

OTHER:
- Dates as DD.MM.YYYY or null
- "page": page number from text === STRANA/STRONA N ===
- Better to extract a product with incomplete data than to skip it${knownProductsPrompt}`;

    type VisionContentPart =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail: "high" | "low" | "auto" } };

    // Helper: call OpenAI with retry on rate limit (429)
    async function callWithRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T | null> {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err: unknown) {
          const status = (err as { status?: number })?.status;
          if (status === 429 && attempt < maxRetries) {
            const waitMs = Math.min(2000 * Math.pow(2, attempt), 15000);
            console.log(`Rate limit, čakám ${waitMs}ms (pokus ${attempt + 1}/${maxRetries})...`);
            await new Promise(r => setTimeout(r, waitMs));
          } else {
            throw err;
          }
        }
      }
      return null;
    }

    // Process batches with limited concurrency (max 4 parallel)
    const MAX_CONCURRENT = 4;
    const batchResults: (ParsedResponse | null)[] = new Array(batches.length).fill(null);

    for (let start = 0; start < batches.length; start += MAX_CONCURRENT) {
      const chunk = batches.slice(start, start + MAX_CONCURRENT);
      const chunkResults = await Promise.all(
        chunk.map(async (batch, chunkIdx) => {
          const batchIdx = start + chunkIdx;
          const isFirst = batchIdx === 0;

          return callWithRetry(async () => {
            const content: VisionContentPart[] = [
              {
                type: "text",
                text: `${lc.intro} (dávka ${batchIdx + 1}/${batches.length})\n\nVÝSTUP v JSON:\n${PRODUCT_SCHEMA}\n\n${PRODUCT_RULES}${!isFirst ? `\n- ${lc.noDateHint}` : ""}`,
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
              model: "gpt-5.1",
              response_format: { type: "json_object" },
              max_completion_tokens: 16000,
              messages: [{ role: "user", content: content as OpenAI.Chat.ChatCompletionContentPart[] }],
            });

            const responseText = response.choices?.[0]?.message?.content?.trim() ?? "";
            if (!responseText) return null;

            try {
              return JSON.parse(responseText) as ParsedResponse;
            } catch {
              const jsonStart = responseText.indexOf("{");
              const jsonEnd = responseText.lastIndexOf("}");
              if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
                try {
                  return JSON.parse(responseText.slice(jsonStart, jsonEnd + 1)) as ParsedResponse;
                } catch {
                  console.error(`Dávka ${batchIdx + 1}: neplatný JSON, preskakujem`);
                }
              }
              return null;
            }
          });
        })
      );

      chunkResults.forEach((result, chunkIdx) => {
        batchResults[start + chunkIdx] = result;
      });

      console.log(`Spracované dávky ${start + 1}-${Math.min(start + MAX_CONCURRENT, batches.length)} / ${batches.length}`);
    }

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

    const items = deduped.map((item: Product) => {
      const pk = item.placementKey || "";
      const parent = pk ? placementLookup[pk] : undefined;
      return {
        name: item.name || "",
        amount: item.amount || "",
        unit: item.unit || "",
        price_sale: item.price_sale || "",
        price_regular: item.price_regular || "",
        note: item.note || "",
        date_from: meta.date_from,
        date_to: meta.date_to,
        page: item.page ?? null,
        categoryKey: parent?.categoryKey || "",
        subcategoryKey: parent?.subcategoryKey || "",
        placementKey: pk,
      };
    });

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
