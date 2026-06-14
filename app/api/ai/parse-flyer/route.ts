import { createClient } from "@supabase/supabase-js";
import hierarchyData from "../../../../assets/hierarchia.json";
import skLabels from "../../../../assets/langs/sk.json";
import czLabels from "../../../../assets/langs/cs.json";
import plLabels from "../../../../assets/langs/pl.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

async function createOpenAIChatCompletion(payload: Record<string, unknown>): Promise<ChatCompletionResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  const functionName = process.env.SUPABASE_OPENAI_FUNCTION || "openai-chat-completion";

  if (!supabaseUrl) {
    throw new Error("Chýba NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL v prostredí.");
  }
  if (!supabaseAnonKey) {
    throw new Error("Chýba NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_ANON_KEY v prostredí.");
  }

  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": supabaseAnonKey,
      "Authorization": `Bearer ${supabaseAnonKey}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      typeof data === "object" && data && "error" in data
        ? String((data as { error?: unknown }).error)
        : text || `HTTP ${response.status}`;
    const error = new Error(`Supabase OpenAI function failed (${response.status}): ${message}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return data as ChatCompletionResponse;
}


export async function POST(req: Request) {
  let tempStoragePath = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sbClient: any = null;
  try {
    // Support two modes:
    // 1) JSON body with storagePath (PDF stored in Supabase) — used on Vercel
    // 2) FormData with file (direct upload) — fallback / local dev
    let buffer: Uint8Array;
    let formCountry = "";
    let formShop = "";

    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await req.json();
      formCountry = (body.country as string) || "";
      formShop = (body.shop as string) || "";
      const storagePath = (body.storagePath as string) || "";
      tempStoragePath = storagePath;
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
      sbClient = sb;
      const { data: blob, error: dlErr } = await sb.storage.from("cap-data").download(storagePath);
      if (dlErr || !blob) {
        return Response.json({ error: `PDF download failed: ${dlErr?.message || "no data"}` }, { status: 400 });
      }
      buffer = new Uint8Array(await blob.arrayBuffer());
    } else {
      const form = await req.formData();
      const file = form.get("file");
      formCountry = (form.get("country") as string | null) || "";
      formShop = (form.get("shop") as string | null) || "";
      if (!file || !(file instanceof File)) {
        return Response.json({ error: "Chýba PDF súbor." }, { status: 400 });
      }
      buffer = new Uint8Array(await file.arrayBuffer());
    }

    // Parse PDF using MuPDF (WASM — full JPEG2000 / JPX support)
    const mupdf = (await import("mupdf")).default;

    const doc = mupdf.Document.openDocument(buffer, "application/pdf");
    const totalPages = doc.countPages();
    const pages = totalPages;

    // Quick text extraction from first few pages for shop/country detection
    const textSamplePages: string[] = [];
    for (let i = 0; i < Math.min(3, pages); i++) {
      try {
        const page = doc.loadPage(i);
        const text = page.toStructuredText().asText();
        textSamplePages.push(text);
      } catch { /* skip */ }
    }
    const { shop: detectedShop, country: detectedCountry } = detectShopAndCountry(textSamplePages.join(" "));

    // Determine language: prefer auto-detection from PDF content, fallback to form
    const country = detectedCountry || formCountry || "sk";
    const lang = country === "pl" ? "pl" : country === "cz" ? "cz" : "sk";

    // Render all pages to JPEG images (serially to keep memory usage stable)
    const RENDER_SCALE = 0.8; // smaller render for faster processing and smaller payloads
    const JPEG_QUALITY = 70; // lower JPEG quality to reduce base64 size
    const MAX_BASE64_SIZE = 3_500_000; // ~2.6 MB JPEG — safety cap per image
    const pageImages: { pageNum: number; imageData: string }[] = [];

    for (let i = 0; i < pages; i++) {
      try {
        const page = doc.loadPage(i);
        const pixmap = page.toPixmap(
          mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE),
          mupdf.ColorSpace.DeviceRGB,
          false, // no alpha (required for JPEG output)
          true   // render annotations
        );
        let jpegData = pixmap.asJPEG(JPEG_QUALITY, false);
        let imageData = Buffer.from(jpegData).toString("base64");

        // If image is too large, re-render at lower quality to stay within OpenAI payload limits
        if (imageData.length > MAX_BASE64_SIZE) {
          console.log(`[render] Page ${i + 1}: ${(imageData.length / 1024).toFixed(0)} KB base64 — too large, re-compressing at quality 50`);
          jpegData = pixmap.asJPEG(50, false);
          imageData = Buffer.from(jpegData).toString("base64");
        }

        console.log(`[render] Page ${i + 1}: ${(imageData.length / 1024).toFixed(0)} KB base64`);
        pixmap.destroy();
        pageImages.push({ pageNum: i + 1, imageData });
      } catch (e) {
        console.error(`Chyba pri renderovaní strany ${i + 1}:`, e);
      }
    }
    // Release the PDF document
    doc.destroy();

    if (pageImages.length === 0) {
      return Response.json(
        { error: "Nepodarilo sa vyrenderovať žiadnu stranu PDF." },
        { status: 400 }
      );
    }

    console.log(`Vyrenderovaných ${pageImages.length} strán, spracovávam cez Vision AI...`);

    // Batch pages for vision API (8 pages per call)
    const VISION_BATCH_SIZE = 8;
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
    const placementLines: string[] = [];
    for (const cat of hierarchyData as HierarchyItem[]) {
      const catLabel = (labels as Record<string, string>)[cat["Kategória"]] || cat["Kategória"];
      placementLines.push(`\n## ${catLabel}`);
      for (const sub of cat["Podkategórie"]) {
        const subLabel = (labels as Record<string, string>)[sub["Podkategória"]] || sub["Podkategória"];
        const keys: string[] = [];
        for (const z of sub["Zaradenia"]) {
          const key = z["Zaradenie"];
          placementLookup[key] = {
            categoryKey: cat["Kategória"],
            subcategoryKey: sub["Podkategória"],
          };
          const label = (labels as Record<string, string>)[key] || key;
          keys.push(`${key}:${label}`);
        }
        if (keys.length > 0) {
          placementLines.push(`  ${subLabel}: ${keys.join(", ")}`);
        }
      }
    }
    const PLACEMENTS_PROMPT = placementLines.join("\n");

    // Load known products from DB for classification hints
    // Strategy: prefer products from the same country+shop (most relevant),
    // fallback-supplement with other products from the same country if too few.
    let knownProductsPrompt = "";
    const dbKnownMap = new Map<string, string>(); // lowercase name → placementKey (for post-AI reclassification)
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
      const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const queryShop = formShop || "";
      const queryCountry = country; // already resolved (from PDF detect or form)
      if (supabaseUrl && serviceRole) {
        const supabaseDb = createClient(supabaseUrl, serviceRole);

        const dedup = (rows: { name: string; placement: string }[]) => {
          const seen = new Set<string>();
          const pairs: string[] = [];
          for (const r of rows) {
            const key = (r.name || "").toLowerCase().trim();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            pairs.push(`${r.name}→${r.placement}`);
          }
          return pairs;
        };

        let pairs: string[] = [];

        // 1) Filtered by country + shop — no row limit (shop DB can have 1000+ products)
        if (queryCountry && queryShop) {
          const { data: shopRows } = await supabaseDb
            .from("master_products_v2")
            .select("name, placement")
            .eq("country", queryCountry)
            .eq("shop", queryShop)
            .not("placement", "eq", "");
          if (shopRows) pairs = dedup(shopRows);
        }

        // 2) If fewer than 50 results (new/unknown shop), supplement with the rest of the country
        if (pairs.length < 50 && queryCountry) {
          const seenNames = new Set(pairs.map(p => p.split("→")[0].toLowerCase().trim()));
          let query = supabaseDb
            .from("master_products_v2")
            .select("name, placement")
            .eq("country", queryCountry)
            .not("placement", "eq", "")
            .limit(1000);
          if (queryShop) query = query.neq("shop", queryShop);
          const { data: countryRows } = await query;
          if (countryRows) {
            for (const r of countryRows) {
              const key = (r.name || "").toLowerCase().trim();
              if (!key || seenNames.has(key)) continue;
              seenNames.add(key);
              pairs.push(`${r.name}→${r.placement}`);
            }
          }
        }

        if (pairs.length > 0) {
          knownProductsPrompt = `\n\nKNOWN PRODUCTS from this shop (name→placementKey). Use these for correct naming AND classification of similar products:\n${pairs.join("\n")}`;
          // Populate DB known map for post-AI reclassification
          for (const p of pairs) {
            const idx = p.indexOf("→");
            if (idx > 0) {
              dbKnownMap.set(p.slice(0, idx).toLowerCase().trim(), p.slice(idx + 1).trim());
            }
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
        nameRule: `"name": v SLOVENČINE, správna diakritika (á,é,í,ó,ú,ý,š,č,ž,ť,ď,ň,ľ,ĺ,ŕ,ä,ô). VŽDY uveď značku/výrobcu + popis produktu. Značku hľadaj v texte letáka AJ na obale produktu na obrázku (napr. Pilos, Pikok, Combino, Cien, Freshona, Gelatelli, Harvest Basket, Dulano). ⚠️ Značka (z obalu) VŽDY NA ZAČIATOK názvu, popisný text z letáka za ňou! ✅ "Beli Zvolen Repkový olej" ❌ "Repkový olej Beli Zvolen", ✅ "Podravka Pasírované paradajky" ❌ "Pasírované paradajky Podravka", ✅ "Rajo Kyslá smotana" ❌ "Kyslá smotana Rajo". Bez hmotnosti/objemu (daj do amount). Príklady: "Pilos Eidam 30%", "Pikok Šunka najvyššej kvality", "Combino Špagety", "Pilsner Urquell svetlý ležiak", "Bonduelle Zlatá kukurica", "Maslo 82%"`,
        noteRule: `"note": LEN doplňujúci text: "rôzne druhy", "bez kosti", "pevný podiel 120 g", "8x0.5l"`,
        examples: `[
  {"name":"Tavený syr syrokrém","amount":"200","unit":"g","price_sale":"1,59","price_regular":"3,49","note":"","page":1},
  {"name":"Pilsner Urquell svetlý ležiak","amount":"0,5","unit":"l","price_sale":"6,99","price_regular":"7,89","note":"8x0.5l","page":1}
]`,
        noDateHint: "meta dátumy môžeš nastaviť na null ak nie sú na týchto stranách viditeľné",
      },
      pl: {
        intro: "Przeanalizuj zdjęcia stron z gazetki supermarketu i wyodrębnij wszystkie produkty spożywcze i napoje.",
        nameRule: `"name": po POLSKU, poprawna pisownia (ą,ę,ć,ł,ń,ó,ś,ź,ż). ZAWSZE podaj markę/producenta + opis produktu. Markę szukaj w tekście gazetki ORAZ na opakowaniu produktu na zdjęciu (np. Pilos, Pikok, Combino, Cien, Freshona, Gelatelli, Harvest Basket, Dulano). ⚠️ Marka (z opakowania) ZAWSZE NA POCZĄTKU nazwy, tekst opisowy z gazetki po niej! ✅ "Podravka Passata pomidorowa" ❌ "Passata pomidorowa Podravka", ✅ "Rajo Śmietana kwaśna" ❌ "Śmietana kwaśna Rajo". Bez wagi/objętości (daj do amount). Przykłady: "Pilos Ser żółty Gouda", "Pikok Szynka konserwowa", "Żywiec Piwo jasne", "Bonduelle Kukurydza złocista", "Masło extra 82%"`,
        noteRule: `"note": TYLKO tekst uzupełniający: "różne rodzaje", "bez kości", "5 sztuk", "6x0.33l"`,
        examples: `[
  {"name":"Masło extra 82%","amount":"200","unit":"g","price_sale":"4,49","price_regular":"6,99","note":"","page":1},
  {"name":"Ser żółty Gouda","amount":"300","unit":"g","price_sale":"7,99","price_regular":"10,99","note":"różne rodzaje","page":1}
]`,
        noDateHint: "meta daty ustaw na null jeśli nie są widoczne na tych stronach",
      },
      cz: {
        intro: "Analyzuj obrázky stránek z letáku supermarketu a extrahuj všechny potraviny a nápoje.",
        nameRule: `"name": v ČEŠTINĚ, správná diakritika (á,é,í,ó,ú,ý,š,č,ž,ť,ď,ň,ě,ř,ů). VŽDY uveď značku/výrobce + popis produktu. Značku hledej v textu letáku I na obalu produktu na obrázku (např. Pilos, Pikok, Combino, Cien, Freshona, Gelatelli, Harvest Basket, Dulano). ⚠️ Značka (z obalu) VŽDY NA ZAČÁTEK názvu, popisný text z letáku za ní! ✅ "Podravka Pasírovaná rajčata" ❌ "Pasírovaná rajčata Podravka", ✅ "Rajo Kyselá smetana" ❌ "Kyselá smetana Rajo". Bez hmotnosti/objemu (dej do amount). Příklady: "Pilos Eidam 30%", "Pikok Šunka nejvyšší jakosti", "Pilsner Urquell Pivo ležák", "Bonduelle Zlatá kukuřice", "Máslo 82%"`,
        noteRule: `"note": JEN doplňující text: "různé druhy", "bez kosti", "5 kusů", "8x0.5l"`,
        examples: `[
  {"name":"Tavený sýr","amount":"200","unit":"g","price_sale":"34,90","price_regular":"49,90","note":"","page":1},
  {"name":"Pilsner Urquell Pivo ležák","amount":"0,5","unit":"l","price_sale":"19,90","price_regular":"27,90","note":"různé druhy","page":1}
]`,
        noDateHint: "meta data nastav na null pokud nejsou na těchto stránkách viditelná",
      },
    };

    const lc = LANG_CONFIG[lang as keyof typeof LANG_CONFIG] || LANG_CONFIG.sk;

    const PRODUCT_RULES = `EXTRACT ONLY: food, drinks, alcohol. ONE product = ONE record. Include every food/drink on the page — small, in corners, cropped, private label.

BRAND/MANUFACTURER: ALWAYS include the brand in "name". ⚠️ Brand (read from product packaging/image) MUST come FIRST in the name, flyer descriptive text SECOND! ✅ "Beli Zvolen Repkový olej" ❌ "Repkový olej Beli Zvolen", ✅ "Podravka Pasírované paradajky" ❌ "Pasírované paradajky Podravka", ✅ "Rajo Kyslá smotana" ❌ "Kyslá smotana Rajo", ✅ "Alesto Kešu oriešky" ❌ "Kešu oriešky Alesto". Read brand from BOTH the text description AND the product packaging/image. Private-label brands (Pilos, Pikok, Combino, Freshona, Dulano, Gelatelli, Harvest Basket, Cien, W5, etc.) are just as important as well-known brands.

⛔ DO NOT EXTRACT — skip entirely, create NO record for:
- Pet food/treats (karma dla kota/psa, krmivo, Whiskas, Pedigree, Felix, Sheba, Kitty)
- Oral hygiene (pasta do zębów/zubná pasta, toothpaste, mouthwash, Colgate, elmex, Listerine, Dentix, Sensodyne — these are NOT drinks!)
- Cosmetics & body care (szampon/šampón, żel pod prysznic/sprchový gél, dezodorant, mydło, krem, farba do włosów, lakier, pianka do golenia, maszynka do golenia, woda perfumowana, płatki pod oczy)
- Household (proszek do prania, tabletki do zmywarki, papier toaletowy, ręczniki papierowe, środki czystości)
- Hygiene (wkładki, podpaski, tampony, pieluchy/pieluszki, chusteczki nawilżane)
- Baby products (Gerber, HiPP baby, Bebilon, Nutrilon, Bobo Frut, Bambino, mleko modyfikowane, dania/zupki dla niemowląt)
- Non-food (flowers, clothing, electronics, tools, toys, batteries)
If an ENTIRE page has only non-food products, return empty products array for that page.

${lc.nameRule}

${lc.noteRule}
- NOT in "note": discount %, prices, weight if already in "amount"
- Promotions "1+1 gratis/zdarma" → "note". Packaging words (chladené/chłodzone, balené/pakowane, mrazené/mrożone) → "note", NOT "name"

"amount"/"unit": amount = number only. unit = g/kg/ml/l/ks/null. Multipacks: amount = single item, multipack info in "note".

"price_sale"/"price_regular": price_sale = biggest prominent price (sale/Card = lowest). price_regular = crossed out original. price_sale < price_regular. IGNORE per-kg/per-l prices in brackets. Empty if not visible — do NOT invent.

EXAMPLE: ${lc.examples}

CLASSIFICATION — assign "placementKey" from this list (category > subcategory > key:label):
${PLACEMENTS_PROMPT}
Use ONLY the key (before colon). ALWAYS assign one — pick closest match, never leave empty.

Dates DD.MM.YYYY or null. "page" = page number from === STRANA/STRONA N ===. Better incomplete data than skipping a food product.${knownProductsPrompt}`;

    type VisionContentPart =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail: "high" | "low" | "auto" } };

    // Helper: call OpenAI with retry on rate limit (429)
    async function callWithRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T | null> {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err: unknown) {
          const status = (err as { status?: number })?.status;
          if (status === 429 && attempt < maxRetries) {
            // Parse "try again in X.XXXs" from error message
            const msg = (err as { message?: string })?.message ?? "";
            const retryMatch = msg.match(/try again in ([\d.]+)s/i);
            const apiWaitMs = retryMatch ? Math.ceil(parseFloat(retryMatch[1]) * 1000) + 500 : 0;
            const fallbackMs = Math.min(3000 * Math.pow(2, attempt), 30000);
            const waitMs = Math.max(apiWaitMs, fallbackMs);
            console.log(`Rate limit, čakám ${(waitMs / 1000).toFixed(1)}s (pokus ${attempt + 1}/${maxRetries})...`);
            await new Promise(r => setTimeout(r, waitMs));
          } else {
            throw err;
          }
        }
      }
      return null;
    }

    // Token tracking
    const tokenStats = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      batches: [] as { batch: number; promptTokens: number; completionTokens: number; promptChars: number }[],
    };
    // Log prompt size (chars + rough token estimate: ~1 char ≈ 0.25 tokens for text; images billed separately)
    const systemPromptChars = PRODUCT_RULES.length;
    const systemPromptTokenEst = Math.round(systemPromptChars / 4);
    console.log(`[tokens] System prompt: ${systemPromptChars} chars ≈ ${systemPromptTokenEst} tokens (text only, excl. images)`);
    console.log(`[tokens] knownProducts block: ${knownProductsPrompt.length} chars ≈ ${Math.round(knownProductsPrompt.length / 4)} tokens`);
    console.log(`[tokens] Batches: ${batches.length} × up to ${VISION_BATCH_SIZE} pages each`);

    // Process batches with limited concurrency (max 5 parallel for faster local runs)
    const MAX_CONCURRENT = 5;
    const batchResults: (ParsedResponse | null)[] = new Array(batches.length).fill(null);

    for (let start = 0; start < batches.length; start += MAX_CONCURRENT) {
      const chunk = batches.slice(start, start + MAX_CONCURRENT);
      const chunkResults = await Promise.all(
        chunk.map(async (batch, chunkIdx) => {
          const batchIdx = start + chunkIdx;
          const isFirst = batchIdx === 0;

          try {
          return await callWithRetry(async () => {
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
                  detail: "auto",
                },
              });
            }

            const promptChars = content.reduce((sum, p) => sum + (p.type === "text" ? p.text.length : 200), 0);
            const payloadSizeMB = content.reduce((sum, p) => sum + (p.type === "text" ? p.text.length : (p as { image_url: { url: string } }).image_url.url.length), 0) / (1024 * 1024);
            console.log(`[payload] Batch ${batchIdx + 1}/${batches.length}: ~${payloadSizeMB.toFixed(1)} MB (${batch.length} pages)`);

            const response = await createOpenAIChatCompletion({
              model: "gpt-4.1-mini",
              response_format: { type: "json_object" },
              max_completion_tokens: 24000,
              messages: [{ role: "user", content }],
            });

            const usage = response.usage;
            if (usage) {
              tokenStats.totalPromptTokens += usage.prompt_tokens;
              tokenStats.totalCompletionTokens += usage.completion_tokens;
              tokenStats.batches.push({
                batch: batchIdx + 1,
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                promptChars,
              });
              console.log(`[tokens] Batch ${batchIdx + 1}/${batches.length}: prompt=${usage.prompt_tokens} compl=${usage.completion_tokens} total=${usage.total_tokens} (promptChars=${promptChars})`);
            }

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
          } catch (err) {
            console.error(`Dávka ${batchIdx + 1}/${batches.length} zlyhala: ${(err as Error).message}`);
            return null;
          }
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

    // Sort by page number numerically before deduplication
    allProducts.sort((a, b) => (a.page ?? 0) - (b.page ?? 0));

    // Deduplicate by name (keep first occurrence)
    const seen = new Set<string>();
    const deduped = allProducts.filter((p) => {
      const key = (p.name || "").toLowerCase().trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const items = deduped.map((item: Product) => {
      let pk = item.placementKey || "";
      // Validate placementKey — clear invalid ones so reclassification can fix them
      if (pk && !placementLookup[pk]) {
        console.log(`[reclass] Invalid placementKey "${pk}" for "${item.name}" — clearing`);
        pk = "";
      }
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

    // ─── Post-AI reclassification: fix empty/invalid placementKey ───
    // Build a keyword reference from DB known products + correctly classified batch products
    const refMap = new Map<string, string>(); // lowercase name → placementKey
    // 1) DB known products (highest priority)
    for (const [name, pk] of dbKnownMap) refMap.set(name, pk);
    // 2) Products from this batch that AI classified correctly
    for (const it of items) {
      if (it.placementKey && it.categoryKey) {
        const key = it.name.toLowerCase().trim();
        if (!refMap.has(key)) refMap.set(key, it.placementKey);
      }
    }

    // For unclassified items, try to find best match from reference
    const needsReclass = items.filter(it => !it.placementKey || !it.categoryKey);
    if (needsReclass.length > 0 && refMap.size > 0) {
      // Tokenize reference names for keyword matching
      const tokenize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, " ").split(/\s+/).filter(w => w.length > 2);
      const refEntries = Array.from(refMap.entries()).map(([name, pk]) => ({
        tokens: tokenize(name),
        placement: pk,
      }));

      let reclassified = 0;
      for (const item of needsReclass) {
        const itemTokens = tokenize(item.name);
        if (itemTokens.length === 0) continue;

        // Score each reference by shared token count
        let bestPk = "";
        let bestScore = 0;
        for (const ref of refEntries) {
          const shared = itemTokens.filter(t => ref.tokens.includes(t)).length;
          // Require at least 2 shared tokens or 50% of item tokens
          const minRequired = Math.max(2, Math.ceil(itemTokens.length * 0.4));
          if (shared >= minRequired && shared > bestScore) {
            bestScore = shared;
            bestPk = ref.placement;
          }
        }

        if (bestPk && placementLookup[bestPk]) {
          const parent = placementLookup[bestPk];
          console.log(`[reclass] "${item.name}" → ${bestPk} (score ${bestScore}/${itemTokens.length})`);
          item.placementKey = bestPk;
          item.categoryKey = parent.categoryKey;
          item.subcategoryKey = parent.subcategoryKey;
          reclassified++;
        }
      }
      if (reclassified > 0) {
        console.log(`[reclass] Fixed ${reclassified}/${needsReclass.length} unclassified products`);
      }
    }

    // Post-processing: filter out non-food products that AI failed to skip
    const NON_FOOD_RE = new RegExp([
      // Candles, grave supplies, LED inserts (PL/SK/CZ)
      'świec[aąy]', 'sviečk', 'svíčk', 'znicz', 'zniczy', 'kahán',
      'wkład.*(znic|led|olejow)', 'subito',
      // Air fresheners, wardrobe sachets
      'odświeżacz', 'osviežovač', 'osvěžovač', 'saszetk.*szaf',
      // Cleaning & laundry
      'proszek do prania', 'prací práš', 'płyn do prania', 'avivá[zž]',
      'tabletk.*(zmywark|umývačk|myčk)', 'środek czystości', 'čistic.*prostřed',
      // Toilet/kitchen paper, paper towels
      'papier toaletow', 'toaletn[ýí] papí', 'ręcznik.*papierow', 'papírov.*utěr',
      'ręcznik.*kuchen', 'utierky kuchyn',
      // Cosmetics & body care
      'szampon', 'šampón', 'šampon',
      'odżywk.*włos', 'kondicionér.*vlas', 'kondicionér.*vlas',
      'żel pod prysznic', 'sprchov.* g[eé]l',
      'dezodorant', 'antiperspiran',
      'farb.*(włos|vlas)', 'barv.*vlas',
      'lakier do włos', 'lak na vlas',
      'maszyn[eę]k.*golen', 'holic[ií]', 'piank.*golen', 'pěn.*holen',
      'żel do golen', 'żel po golen',
      'piank.*do twarzy', 'piank.*na tvár', 'pěn.*na obličej',
      'żel do mycia', 'sprchov.* g[eé]l',
      'parfém', 'perfum', 'woda toaletow', 'eau de toilette',
      'płatk.*pod oczy', 'balsam do ciała', 'krem do twarzy',
      'mgiełk.*ciał', 'mleczko do ciał',
      'woda po golen', 'balsam po golen',
      'patyczk.*kosmetycz',
      // Oral hygiene
      'pasta do zębów', 'zubn[áí] past',
      'szczoteczk.*zębów', 'zubn[áí] kefk', 'zubn[íi] kartáč',
      'ústn[aí] vod', 'płyn do płukania.*ust',
      // Feminine hygiene & diapers
      'podpask[iy]', 'tampon[yů]', 'wkładk.*higien',
      'pieluch[iy]', 'pieluszk', '\\bplienk', '\\bplenk',
      // Pet food
      'karma dla', '\\bkrmivo\\b', 'whiskas', 'pedigree', 'sheba',
      // Misc non-food
      'żarówk', 'žiarovk', 'žárovk',
    ].join('|'), 'i');

    const foodItems = items.filter(p => !NON_FOOD_RE.test(p.name));
    if (foodItems.length < items.length) {
      const removed = items.filter(p => NON_FOOD_RE.test(p.name));
      console.log(`[filter] Removed ${removed.length} non-food: ${removed.map(p => p.name).join(', ')}`);
    }

    // Final token summary log
    const totalTokens = tokenStats.totalPromptTokens + tokenStats.totalCompletionTokens;
    // gpt-4.1-mini pricing (as of 2025): $0.40/1M prompt, $1.60/1M completion (vision prompt charged separately)
    const costUsd = (tokenStats.totalPromptTokens / 1_000_000) * 0.40 + (tokenStats.totalCompletionTokens / 1_000_000) * 1.60;
    console.log(`[tokens] ===== SUMMARY =====`);
    console.log(`[tokens] Prompt tokens total:     ${tokenStats.totalPromptTokens}`);
    console.log(`[tokens] Completion tokens total: ${tokenStats.totalCompletionTokens}`);
    console.log(`[tokens] Grand total:             ${totalTokens}`);
    console.log(`[tokens] Est. text cost (USD):    $${costUsd.toFixed(4)} (excl. image tokens)`);
    console.log(`[tokens] knownProducts chars:     ${knownProductsPrompt.length} ≈ ${Math.round(knownProductsPrompt.length / 4)} est. tokens`);

    const result: Record<string, unknown> = {
      meta,
      items: foodItems,
      detectedShop: detectedShop ?? null,
      detectedCountry: detectedCountry ?? null,
      tokenStats: {
        promptTokens: tokenStats.totalPromptTokens,
        completionTokens: tokenStats.totalCompletionTokens,
        totalTokens,
        estimatedCostUsd: parseFloat(costUsd.toFixed(4)),
        batches: tokenStats.batches,
        knownProductsChars: knownProductsPrompt.length,
      },
    };

    // Clean up temp PDF from Supabase Storage (must await before returning, Vercel kills process after response)
    if (tempStoragePath && sbClient) {
      try {
        await sbClient.storage.from("cap-data").remove([tempStoragePath]);
      } catch (e: unknown) {
        console.error("Failed to delete temp PDF:", e);
      }
    }

    return Response.json(result);
  } catch (err) {
    // Clean up temp PDF even on error
    if (tempStoragePath && sbClient) {
      try {
        await sbClient.storage.from("cap-data").remove([tempStoragePath]);
      } catch { /* ignore */ }
    }
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
    apiKeyConfiguredInSupabaseFunction: true,
  });
}
