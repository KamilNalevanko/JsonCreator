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
const SHOP_PATTERNS: Array<{
  pattern: RegExp;
  shop: string;
  country?: string;
}> = [
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

function detectShopAndCountry(text: string): {
  shop: string | null;
  country: string | null;
} {
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

function pad2(value: string): string {
  return value.padStart(2, "0");
}

function detectFlyerDateRange(
  text: string,
): { date_from: string; date_to: string } | null {
  const patterns = [
    /plat[íi]\s+od\s+(\d{1,2})\.\s*(\d{1,2})\.?\s+do\s+(\d{1,2})\.\s*(\d{1,2})\.?\s*(20\d{2})/i,
    /od\s+\w+\s+(\d{1,2})\.\s*(\d{1,2})\.?\s+do\s+(\d{1,2})\.\s*(\d{1,2})\.?\s*(20\d{2})/i,
    /od\s+(\d{1,2})\.\s*(\d{1,2})\.?\s+do\s+(\d{1,2})\.\s*(\d{1,2})\.?\s*(20\d{2})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const [, d1, m1, d2, m2, year] = match;
      return {
        date_from: `${pad2(d1)}.${pad2(m1)}.${year}`,
        date_to: `${pad2(d2)}.${pad2(m2)}.${year}`,
      };
    }
  }

  return null;
}

function cleanProductName(name: string, retailerHints: string[]): string {
  let cleaned = (name || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";

  const retailerWords = [
    ...retailerHints,
    "lidl",
    "kaufland",
    "billa",
    "tesco",
    "coop",
    "jednota",
    "biedronka",
    "albert",
    "auchan",
    "carrefour",
    "globus",
    "penny",
    "dino",
    "zabka",
    "żabka",
    "lewiatan",
  ]
    .map((v) => v.replace(/[-_]+/g, " ").trim())
    .filter(Boolean);

  for (const word of retailerWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`^${escaped}\\s+`, "i"), "").trim();
  }

  cleaned = cleaned
    .replace(/^(s\s+)?lidl\s+plus\s+/i, "")
    .replace(/^cenov[ýy]\s+(lider|líder)\s+/i, "")
    .replace(/^dlhodobo\s+zlacnen[ée]\s+/i, "")
    .replace(/^super\s*cena\s+/i, "")
    .replace(/^supercena\s+/i, "")
    .replace(/^ušetr[ií]te\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned;
}

function appendNote(note: string, extra: string): string {
  const cleanNote = (note || "").replace(/\s+/g, " ").trim();
  const cleanExtra = (extra || "").replace(/\s+/g, " ").trim();
  if (!cleanExtra) return cleanNote;
  if (!cleanNote) return cleanExtra;
  if (cleanNote.toLowerCase().includes(cleanExtra.toLowerCase()))
    return cleanNote;
  return `${cleanNote}, ${cleanExtra}`;
}

function cleanSupplementalNote(note: string): string {
  let cleaned = (note || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";

  cleaned = cleaned
    // per-unit prices and technical price formulas belong nowhere in the product record
    .replace(
      /\(?\s*=\s*1\s*(kg|l|liter|litre|pranie|dávka|porcia)\s+[^),;]+[),;]?/gi,
      " ",
    )
    .replace(/\b(1\s*(kg|l|liter|litre))\s*[=:]\s*\d+[,.]\d+\s*€?/gi, " ")
    .replace(/\b(KC|BC|A)\s*:?\s*\d+[,.]\d+\b/gi, " ")
    .replace(/\bB-?C\s*\d+[,.]\d+[^,;]*/gi, " ")
    .replace(/\bdiscount\s*\d+%/gi, " ")
    .replace(/[-–]\s*\d+\s*%/g, " ")
    // remove empty generic packaging notes when amount/unit already captured it
    .replace(/^(s\s+)?balením$/i, "")
    .replace(/^balenie$/i, "")
    .replace(/^balení$/i, "")
    .replace(/^opakowanie$/i, "")
    .replace(/\s*,\s*,+/g, ", ")
    .replace(/^\s*,\s*|\s*,\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Do not keep long editorial/tasting descriptions in note.
  // Notes should stay as short sale/package metadata, not product copywriting.
  if (cleaned.length > 140) {
    cleaned = cleaned
      .slice(0, 140)
      .replace(/[,;]\s*[^,;]*$/, "")
      .trim();
  }

  return cleaned;
}

function moveNameDetailsToNote(
  name: string,
  note: string,
): { name: string; note: string } {
  let cleanedName = (name || "").replace(/\s+/g, " ").trim();
  let cleanedNote = note || "";

  const detailPatterns: RegExp[] = [
    /\b(rôzne\s+druhy|různé\s+druhy|różne\s+rodzaje|różne\s+smaki|various\s+(types|kinds|flavours|flavors))\b/gi,
    /\b(pultový\s+predaj|pultový\s+prodej|pultovy\s+predaj|pultovy\s+prodej|na\s+váhu|na\s+váze|luzem|luzowy|counter\s+sale)\b/gi,
    /\b(bez\s+drobov|bez\s+drobů|bez\s+kości|bez\s+kosti|without\s+giblets)\b/gi,
    /\b(pevný\s+podiel\s*\d+\s*(g|%))\b/gi,
    /\b(cena\s+za\s+1\s*kg|cena\s+za\s+100\s*g|price\s+per\s+1\s*kg|price\s+per\s+100\s*g)\b/gi,
    /\b(mimoriadna\s+ponuka|mimořádná\s+nabídka|oferta\s+specjalna|do\s+vypredania\s+zásob|do\s+vyčerpania\s+zásob|do\s+vyprodání\s+zásob|do\s+wyczerpania\s+zapasów)\b/gi,
    /\b(chladené|chlazené|chłodzone|mrazené|mražené|mrożone|balené|pakované|pakowane|packaged)\b/gi,
    /\b(\d+\s*[+x×]\s*\d+\s*(zadarmo|zdarma|gratis|free))\b/gi,
  ];

  for (const pattern of detailPatterns) {
    cleanedName = cleanedName.replace(pattern, (match) => {
      cleanedNote = appendNote(cleanedNote, match);
      return " ";
    });
  }

  cleanedName = cleanedName
    .replace(/\s+alebo\s*$/i, "")
    .replace(/\s+nebo\s*$/i, "")
    .replace(/\s+lub\s*$/i, "")
    .replace(/\s+albo\s*$/i, "")
    .replace(/\s*,\s*,+/g, ", ")
    .replace(/^\s*[,;/-]\s*|\s*[,;/-]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return { name: cleanedName, note: cleanSupplementalNote(cleanedNote) };
}

function normalizeExtractedAmountUnitNote(
  amountValue: unknown,
  unitValue: unknown,
  noteValue: unknown,
): { amount: string; unit: string; note: string } {
  const amount =
    amountValue === null || amountValue === undefined
      ? ""
      : String(amountValue).trim();
  let unit =
    unitValue === null || unitValue === undefined
      ? ""
      : String(unitValue).trim().toLowerCase();
  let note =
    noteValue === null || noteValue === undefined
      ? ""
      : String(noteValue).replace(/\s+/g, " ").trim();

  unit = unit
    .replace(/^litre?$/i, "l")
    .replace(/^liter$/i, "l")
    .replace(/^gramy?$/i, "g")
    .replace(/^grams?$/i, "g")
    .replace(/^kilogramy?$/i, "kg")
    .replace(/^kusy?$/i, "ks")
    .replace(/^kus$/i, "ks")
    .replace(/^piece$/i, "ks")
    .replace(/^pcs?$/i, "ks")
    .replace(/^svazok$/i, "zväzok")
    .replace(/^zvazok$/i, "zväzok")
    .replace(/^svazek$/i, "zväzok")
    .replace(/^pęczek$/i, "zväzok")
    .replace(/^peczek$/i, "zväzok")
    .replace(/^bunch$/i, "zväzok");

  if (unit === "null" || unit === "none" || unit === "undefined") unit = "";

  const allowedUnits = ["g", "kg", "ml", "l", "ks", "zväzok", ""];
  if (!allowedUnits.includes(unit)) {
    note = appendNote(note, `${amount} ${unit}`.trim());
    unit = "";
  }

  return { amount, unit, note: cleanSupplementalNote(note) };
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

async function createOpenAIChatCompletion(
  payload: Record<string, unknown>,
): Promise<ChatCompletionResponse> {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  const functionName =
    process.env.SUPABASE_OPENAI_FUNCTION || "openai-chat-completion";

  if (!supabaseUrl) {
    throw new Error(
      "Chýba NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL v prostredí.",
    );
  }
  if (!supabaseAnonKey) {
    throw new Error(
      "Chýba NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_ANON_KEY v prostredí.",
    );
  }

  const response = await fetch(
    `${supabaseUrl.replace(/\/$/, "")}/functions/v1/${functionName}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify(payload),
    },
  );

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
    const error = new Error(
      `Supabase OpenAI function failed (${response.status}): ${message}`,
    ) as Error & { status?: number };
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
        return Response.json(
          { error: "Chýba PDF (storagePath)." },
          { status: 400 },
        );
      }
      // Download PDF from Supabase Storage
      const supabaseUrl =
        process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
      const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseUrl || !serviceRole) {
        return Response.json(
          { error: "Missing SUPABASE env." },
          { status: 500 },
        );
      }
      const sb = createClient(supabaseUrl, serviceRole);
      sbClient = sb;
      const { data: blob, error: dlErr } = await sb.storage
        .from("cap-data")
        .download(storagePath);
      if (dlErr || !blob) {
        return Response.json(
          { error: `PDF download failed: ${dlErr?.message || "no data"}` },
          { status: 400 },
        );
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
      } catch {
        /* skip */
      }
    }
    const textSample = textSamplePages.join(" ");
    const { shop: detectedShop, country: detectedCountry } =
      detectShopAndCountry(textSample);
    const detectedDateRange = detectFlyerDateRange(textSample);

    // Determine language: prefer auto-detection from PDF content, fallback to form
    const country = detectedCountry || formCountry || "sk";
    const lang = country === "pl" ? "pl" : country === "cz" ? "cz" : "sk";

    // Render all pages to JPEG images (serially to keep memory usage stable)
    // Accuracy modes:
    // - fast: cheapest production default, lower image quality, 4-page batches
    // - balanced: optional higher quality
    // - accurate: optional debug/quality mode, higher image quality
    const ACCURACY_MODE = (process.env.PDF_ACCURACY_MODE || "fast")
      .trim()
      .toLowerCase();
    const isAccurateMode = ACCURACY_MODE === "accurate";
    const isFastMode = ACCURACY_MODE === "fast";

    const RENDER_SCALE = Number(
      process.env.PDF_RENDER_SCALE ||
        (isAccurateMode ? 1.15 : isFastMode ? 0.8 : 1.0),
    );
    const JPEG_QUALITY = Number(
      process.env.PDF_JPEG_QUALITY ||
        (isAccurateMode ? 85 : isFastMode ? 70 : 78),
    );
    const PAGE_TEXT_LIMIT = Number(
      process.env.PAGE_TEXT_LAYER_LIMIT ||
        (isAccurateMode ? 6000 : isFastMode ? 2800 : 4500),
    );
    const rawImageDetail = (
      process.env.OPENAI_IMAGE_DETAIL || (isAccurateMode ? "high" : "auto")
    )
      .trim()
      .toLowerCase();
    const IMAGE_DETAIL: "high" | "low" | "auto" =
      rawImageDetail === "high" || rawImageDetail === "low"
        ? rawImageDetail
        : "auto";

    const MAX_BASE64_SIZE = 3_500_000; // ~2.6 MB JPEG — safety cap per image
    const pageImages: {
      pageNum: number;
      imageData: string;
      textData: string;
    }[] = [];

    for (let i = 0; i < pages; i++) {
      try {
        const page = doc.loadPage(i);
        let textData = "";
        try {
          textData = page
            .toStructuredText()
            .asText()
            .replace(/\n{3,}/g, "\n\n")
            .trim()
            .slice(0, PAGE_TEXT_LIMIT);
        } catch {
          textData = "";
        }
        const pixmap = page.toPixmap(
          mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE),
          mupdf.ColorSpace.DeviceRGB,
          false, // no alpha (required for JPEG output)
          true, // render annotations
        );
        let jpegData = pixmap.asJPEG(JPEG_QUALITY, false);
        let imageData = Buffer.from(jpegData).toString("base64");

        // If image is too large, re-render at lower quality to stay within OpenAI payload limits
        if (imageData.length > MAX_BASE64_SIZE) {
          console.log(
            `[render] Page ${i + 1}: ${(imageData.length / 1024).toFixed(0)} KB base64 — too large, re-compressing at quality 50`,
          );
          jpegData = pixmap.asJPEG(50, false);
          imageData = Buffer.from(jpegData).toString("base64");
        }

        console.log(
          `[render] Page ${i + 1}: ${(imageData.length / 1024).toFixed(0)} KB base64`,
        );
        pixmap.destroy();
        pageImages.push({ pageNum: i + 1, imageData, textData });
      } catch (e) {
        console.error(`Chyba pri renderovaní strany ${i + 1}:`, e);
      }
    }
    // Release the PDF document
    doc.destroy();

    if (pageImages.length === 0) {
      return Response.json(
        { error: "Nepodarilo sa vyrenderovať žiadnu stranu PDF." },
        { status: 400 },
      );
    }

    console.log(
      `Vyrenderovaných ${pageImages.length} strán, spracovávam cez Vision AI...`,
    );
    console.log(
      `[settings] mode=${ACCURACY_MODE} renderScale=${RENDER_SCALE} jpeg=${JPEG_QUALITY} textLimit=${PAGE_TEXT_LIMIT} imageDetail=${IMAGE_DETAIL}`,
    );

    // Batch pages for vision API.
    // Production default is 4 pages/request to keep analysis cheap and reasonably fast.
    // You can still override with VISION_BATCH_SIZE=1 or 2 only for debugging quality.
    const VISION_BATCH_SIZE = Number(process.env.VISION_BATCH_SIZE || 4);

    // Keep this OFF by default. When enabled, dense pages may be sent alone,
    // which improves accuracy but increases request count/cost.
    const AUTO_BATCH_BY_DENSITY =
      (process.env.VISION_AUTO_BATCH_BY_DENSITY || "false").toLowerCase() ===
      "true";

    const priceLikeCount = (text: string) =>
      (text.match(/\b\d{1,3}[,.]\d{2}\b/g) || []).length;
    const isDenseOfferPage = (text: string) =>
      priceLikeCount(text) >= 10 || text.length > 4200;

    const batches: {
      pageNum: number;
      imageData: string;
      textData: string;
    }[][] = [];
    if (AUTO_BATCH_BY_DENSITY && VISION_BATCH_SIZE > 1) {
      let current: { pageNum: number; imageData: string; textData: string }[] =
        [];
      const flush = () => {
        if (current.length) {
          batches.push(current);
          current = [];
        }
      };

      for (const page of pageImages) {
        // Dense flyer pages have many prices/product boxes. Keep them isolated to reduce hallucinated names.
        if (isDenseOfferPage(page.textData)) {
          flush();
          batches.push([page]);
          continue;
        }
        current.push(page);
        if (current.length >= VISION_BATCH_SIZE) flush();
      }
      flush();
    } else {
      for (let i = 0; i < pageImages.length; i += VISION_BATCH_SIZE) {
        batches.push(pageImages.slice(i, i + VISION_BATCH_SIZE));
      }
    }

    const PRODUCT_SCHEMA = `{
  "meta": { "date_from": "DD.MM.YYYY or null", "date_to": "DD.MM.YYYY or null" },
  "products": [{ "name": "...", "amount": "...", "unit": "g/kg/ml/l/ks/zväzok/null", "price_sale": "...", "price_regular": "...", "note": "...", "page": N, "placementKey": "..." }]
}`;

    // Build placement lookup + translated list for AI
    type HierarchyItem = {
      Kategória: string;
      Podkategórie: {
        Podkategória: string;
        Zaradenia: { Zaradenie: string }[];
      }[];
    };
    const labelsMap: Record<string, Record<string, string>> = {
      sk: skLabels,
      cz: czLabels,
      pl: plLabels,
    };
    const labels = labelsMap[lang] || skLabels;
    const placementLookup: Record<
      string,
      { categoryKey: string; subcategoryKey: string }
    > = {};
    const placementLines: string[] = [];
    for (const cat of hierarchyData as HierarchyItem[]) {
      const catLabel =
        (labels as Record<string, string>)[cat["Kategória"]] ||
        cat["Kategória"];
      placementLines.push(`\n## ${catLabel}`);
      for (const sub of cat["Podkategórie"]) {
        const subLabel =
          (labels as Record<string, string>)[sub["Podkategória"]] ||
          sub["Podkategória"];
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
      const supabaseUrl =
        process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
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
          const seenNames = new Set(
            pairs.map((p) => p.split("→")[0].toLowerCase().trim()),
          );
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
          // Keep the prompt compact. The full map is still kept locally for post-processing.
          const promptPairs = pairs.slice(
            0,
            Number(
              process.env.KNOWN_PRODUCTS_PROMPT_LIMIT ||
                (isAccurateMode ? 80 : isFastMode ? 180 : 120),
            ),
          );
          knownProductsPrompt = `\n\nKNOWN PRODUCTS from this shop/country (name→placementKey). Use these only as hints for OCR correction and classification of similar visible products. Do not copy products that are not visible in the flyer pages. Do not override a clearly visible flyer/product-package name with a different database name:\n${promptPairs.join("\n")}`;
          // Populate DB known map for post-AI reclassification
          for (const p of pairs) {
            const idx = p.indexOf("→");
            if (idx > 0) {
              dbKnownMap.set(
                p.slice(0, idx).toLowerCase().trim(),
                p.slice(idx + 1).trim(),
              );
            }
          }
        }
      }
    } catch (e) {
      console.error("Failed to load known products from DB:", e);
    }

    const targetLanguageName =
      lang === "pl" ? "Polish" : lang === "cz" ? "Czech" : "Slovak";

    const PRODUCT_RULES = `You are extracting supermarket flyer products for country="${country}", language="${targetLanguageName}".
Return ONLY valid JSON in the requested schema.

CORE TASK:
- Extract ONLY food, drinks and alcohol.
- ONE visible product offer = ONE record.
- Include small products in corners if they are food/drinks.
- Skip pages or areas that contain only non-food or campaign/legal text.

PRODUCT NAME:
- "name" must be a short clean product name only.
- Keep the original language from the flyer or package. Do NOT translate.
- Include manufacturer/brand only when it is clearly printed on the package or attached to that exact product block.
- Do NOT include retailer names, loyalty programs, slogans, page headers, campaign titles, country flags, awards, medals, QR text, website text or neighbouring product text.
- Do NOT include supplementary sale/package details in "name".
- Never add words that are not supported by the same product block.
- If text layer and image disagree, prefer the text that is visually attached to the same product/package.
- If unsure between a short generic name and a longer uncertain name, choose the shorter clean name.

PUT THESE INTO "note", NOT INTO "name":
- various kinds/flavours/types
- counter sale / sold loose / by weight
- chilled/frozen/packaged
- without giblets/bone/free etc.
- multipack or 1+1 / 3+3 promo
- deposit info, card/coupon conditions
- fixed drained weight / drained weight
- special offer / while stocks last
Keep notes short. Do NOT include discount percentages, crossed prices, per-kg/per-l formulas, legal text or product marketing descriptions.

AMOUNT AND UNIT:
- "amount" must be a string, never a JSON number.
- Use the sold unit/package amount, not the per-kg/per-l comparison price.
- Allowed "unit": "g", "kg", "ml", "l", "ks", "zväzok", or "".
- For bunch/bundle products use unit "zväzok".
- For multipacks, amount should describe one sold package when clear; put multipack details in "note".

PRICES:
- "price_sale" = the main final customer price for the offer. Card/coupon price can be used only when it is the actual prominent advertised price.
- "price_regular" = crossed-out previous/original price, if visible.
- Ignore comparison prices in brackets, such as per kg/per l/per wash.
- Do not invent missing prices.

TEXT LAYER + IMAGE:
- Each page is provided as text layer plus image.
- Use the text layer to verify product names, amounts and prices.
- Use the image/layout to decide which text belongs to which product.
- Ignore text layer lines from legal footer, banners, campaign blocks, QR, websites and unrelated non-food areas.

SKIP NON-FOOD COMPLETELY:
Pet food, cosmetics, hygiene, oral care, cleaning/laundry, baby formula/food, flowers, plants, clothing, electronics, tools, toys, dishes, household paper/foil/bags.

CLASSIFICATION:
- Choose "placementKey" from the list below.
- Classify by the actual product, not by the brand.
- If an exact placement exists, use it.
- If only a broad/near placement exists, use it only when it is clearly the same product family.
- Do NOT map an unknown exotic fruit to an unrelated known fruit just to fill the field.
- Empty placementKey is better than a confidently wrong placement.
- Still try to classify common food/drink/alcohol products whenever a reasonable placement exists.

PLACEMENT LIST:
${PLACEMENTS_PROMPT}

Use ONLY the key before ":" as placementKey.
Dates may be null. "page" must match the provided page marker.
${knownProductsPrompt}`;

    type VisionContentPart =
      | { type: "text"; text: string }
      | {
          type: "image_url";
          image_url: { url: string; detail: "high" | "low" | "auto" };
        };

    // Helper: call OpenAI with retry on rate limit (429)
    async function callWithRetry<T>(
      fn: () => Promise<T>,
      maxRetries = 5,
    ): Promise<T | null> {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err: unknown) {
          const status = (err as { status?: number })?.status;
          if (status === 429 && attempt < maxRetries) {
            // Parse "try again in X.XXXs" from error message
            const msg = (err as { message?: string })?.message ?? "";
            const retryMatch = msg.match(/try again in ([\d.]+)s/i);
            const apiWaitMs = retryMatch
              ? Math.ceil(parseFloat(retryMatch[1]) * 1000) + 500
              : 0;
            const fallbackMs = Math.min(3000 * Math.pow(2, attempt), 30000);
            const waitMs = Math.max(apiWaitMs, fallbackMs);
            console.log(
              `Rate limit, čakám ${(waitMs / 1000).toFixed(1)}s (pokus ${attempt + 1}/${maxRetries})...`,
            );
            await new Promise((r) => setTimeout(r, waitMs));
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
      batches: [] as {
        batch: number;
        promptTokens: number;
        completionTokens: number;
        promptChars: number;
      }[],
    };
    // Log prompt size (chars + rough token estimate: ~1 char ≈ 0.25 tokens for text; images billed separately)
    const systemPromptChars = PRODUCT_RULES.length;
    const systemPromptTokenEst = Math.round(systemPromptChars / 4);
    console.log(
      `[tokens] System prompt: ${systemPromptChars} chars ≈ ${systemPromptTokenEst} tokens (text only, excl. images)`,
    );
    console.log(
      `[tokens] knownProducts block: ${knownProductsPrompt.length} chars ≈ ${Math.round(knownProductsPrompt.length / 4)} tokens`,
    );
    console.log(
      `[tokens] Batches: ${batches.length} × up to ${VISION_BATCH_SIZE} pages each`,
    );

    // Process batches with limited concurrency. Too much parallel vision work can cause rate limits and noisier results.
    const MAX_CONCURRENT = Number(
      process.env.VISION_MAX_CONCURRENT || (isAccurateMode ? 2 : 3),
    );
    const batchResults: (ParsedResponse | null)[] = new Array(
      batches.length,
    ).fill(null);

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
                  text: `Analyze these supermarket flyer pages (batch ${batchIdx + 1}/${batches.length}).\n\nOUTPUT JSON SCHEMA:\n${PRODUCT_SCHEMA}\n\n${PRODUCT_RULES}${!isFirst ? "\nFor this non-first batch, meta dates may be null." : ""}`,
                },
              ];

              for (const pg of batch) {
                content.push({
                  type: "text",
                  text: `=== PAGE ${pg.pageNum} TEXT LAYER ===\n${pg.textData || "(no text layer)"}`,
                });
                content.push({
                  type: "text",
                  text: `=== PAGE ${pg.pageNum} IMAGE ===`,
                });
                content.push({
                  type: "image_url",
                  image_url: {
                    url: `data:image/jpeg;base64,${pg.imageData}`,
                    detail: IMAGE_DETAIL,
                  },
                });
              }

              const promptChars = content.reduce(
                (sum, p) => sum + (p.type === "text" ? p.text.length : 200),
                0,
              );
              const payloadSizeMB =
                content.reduce(
                  (sum, p) =>
                    sum +
                    (p.type === "text"
                      ? p.text.length
                      : (p as { image_url: { url: string } }).image_url.url
                          .length),
                  0,
                ) /
                (1024 * 1024);
              console.log(
                `[payload] Batch ${batchIdx + 1}/${batches.length}: ~${payloadSizeMB.toFixed(1)} MB (${batch.length} pages)`,
              );

              const response = await createOpenAIChatCompletion({
                model: (
                  process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini"
                ).trim(),
                response_format: { type: "json_object" },
                temperature: 0,
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
                console.log(
                  `[tokens] Batch ${batchIdx + 1}/${batches.length}: prompt=${usage.prompt_tokens} compl=${usage.completion_tokens} total=${usage.total_tokens} (promptChars=${promptChars})`,
                );
              }

              const responseText =
                response.choices?.[0]?.message?.content?.trim() ?? "";
              if (!responseText) return null;

              try {
                return JSON.parse(responseText) as ParsedResponse;
              } catch {
                const jsonStart = responseText.indexOf("{");
                const jsonEnd = responseText.lastIndexOf("}");
                if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
                  try {
                    return JSON.parse(
                      responseText.slice(jsonStart, jsonEnd + 1),
                    ) as ParsedResponse;
                  } catch {
                    console.error(
                      `Dávka ${batchIdx + 1}: neplatný JSON, preskakujem`,
                    );
                  }
                }
                return null;
              }
            });
          } catch (err) {
            console.error(
              `Dávka ${batchIdx + 1}/${batches.length} zlyhala: ${(err as Error).message}`,
            );
            return null;
          }
        }),
      );

      chunkResults.forEach((result, chunkIdx) => {
        batchResults[start + chunkIdx] = result;
      });

      console.log(
        `Spracované dávky ${start + 1}-${Math.min(start + MAX_CONCURRENT, batches.length)} / ${batches.length}`,
      );
    }

    const meta = { date_from: "", date_to: "" };
    const allProducts: Product[] = [];

    for (const parsed of batchResults) {
      if (!parsed) continue;
      if (!meta.date_from && parsed.meta?.date_from)
        meta.date_from = parsed.meta.date_from;
      if (!meta.date_to && parsed.meta?.date_to)
        meta.date_to = parsed.meta.date_to;
      if (Array.isArray(parsed.products)) allProducts.push(...parsed.products);
    }

    // Prefer dates read from PDF text layer when available. This fixes common vision mistakes with years.
    if (detectedDateRange) {
      meta.date_from = detectedDateRange.date_from;
      meta.date_to = detectedDateRange.date_to;
    }

    // Sort by page number numerically before deduplication
    allProducts.sort((a, b) => (a.page ?? 0) - (b.page ?? 0));

    // Deduplicate by stable offer key, not only by name.
    // Same product name can appear with a different size/price on another page.
    const seen = new Set<string>();
    const deduped = allProducts.filter((p) => {
      const nameKey = (p.name || "").toLowerCase().replace(/\s+/g, " ").trim();
      const key = [
        nameKey,
        String(p.amount || "")
          .toLowerCase()
          .trim(),
        String(p.unit || "")
          .toLowerCase()
          .trim(),
        String(p.price_sale || "").trim(),
      ].join("|");
      if (!nameKey || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const retailerHints = [formShop, detectedShop || ""].filter(Boolean);

    const keywordFallbacks: Array<{
      re: RegExp;
      placementKey: string;
      force?: boolean;
    }> = [
      { re: /mango|manga/i, placementKey: "mango" },
      { re: /mung|faz[uó]l|fazuľ|fasol|bean/i, placementKey: "fazu_a" },
      { re: /paradaj|rajč|pomidor|tomat/i, placementKey: "paradajky" },
      {
        re: /dyň|dyna|mel[oó]n|arbuz|watermelon/i,
        placementKey: "mel_n",
        force: true,
      },
      { re: /avok[aá]d|awokad/i, placementKey: "avok_do" },
      { re: /hrozno|winogron|hrozny|grape/i, placementKey: "hrozno" },
      { re: /jabl|jabł|apple/i, placementKey: "jablk" },
      { re: /nektar|brosk|brzoskw|peach/i, placementKey: "broskyne" },
      {
        re: /marhu[ľl]|meru[nň]|morel|apricot/i,
        placementKey: "marhule",
        force: true,
      },
      { re: /cibuľ|cibul|cebula|onion/i, placementKey: "cibu_a" },
      { re: /mrkv|marchew|carrot/i, placementKey: "mrkva" },
      { re: /anan[aá]s|pineapple/i, placementKey: "anan_s" },
      {
        re: /kur[čc]a|kurac|kuřec|kurczak|chicken/i,
        placementKey: "kur_a",
        force: true,
      },
      {
        re: /mlet[éeá].*brav|vepř.*mlet|wieprz.*miel/i,
        placementKey: "mlet_brav_ov",
      },
      { re: /maslo|máslo|masło|butter/i, placementKey: "maslo_82" },
      { re: /mlieko|mléko|mleko|milk/i, placementKey: "plnotu_n_mlieko" },
      { re: /smotana|smetana|śmietana|cream/i, placementKey: "kysl_smotana" },
      { re: /mozzarella/i, placementKey: "mozarella" },
      { re: /slanina|boczek|bacon/i, placementKey: "slanina" },
      {
        re: /cestovin|těstovin|makaron|spag|špag|spag/i,
        placementKey: "pagety",
      },
      { re: /olivov.*olej|olive.*oil|oliwa/i, placementKey: "olivov_olej" },
      { re: /tequila|vodka|rum|gin/i, placementKey: "biely_alkohol" },
      { re: /whisk|whisk(e)?y/i, placementKey: "ko_ak_a_whiskey" },
      { re: /víno|vino|winn|wine|velt/i, placementKey: "biele_v_no" },
      { re: /pivo|piwo|beer|lež[iá]k/i, placementKey: "alkoholick_pivo" },
      {
        re: /nanuk|mrazen[ýy]\s+kr[eé]m|mražen[ýy]\s+kr[eé]m|zmrzlin|lody|ice\s*cream/i,
        placementKey: "zmrzlina",
        force: true,
      },
      {
        re: /k[aá]va|kávy|coffee|kawa|espresso|crema|cappuccino/i,
        placementKey: "instantn",
      },
    ];

    const items = deduped.map((item: Product) => {
      let pk = item.placementKey || "";
      // Validate placementKey — clear invalid ones so reclassification can fix them
      if (pk && !placementLookup[pk]) {
        console.log(
          `[reclass] Invalid placementKey "${pk}" for "${item.name}" — clearing`,
        );
        pk = "";
      }

      const normalized = normalizeExtractedAmountUnitNote(
        item.amount,
        item.unit,
        item.note,
      );
      const cleanedBaseName = cleanProductName(item.name || "", retailerHints);
      const moved = moveNameDetailsToNote(cleanedBaseName, normalized.note);

      const parent = pk ? placementLookup[pk] : undefined;
      return {
        name: moved.name,
        amount: normalized.amount,
        unit: normalized.unit,
        price_sale: item.price_sale || "",
        price_regular: item.price_regular || "",
        note: moved.note,
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
    const needsReclass = items.filter(
      (it) => !it.placementKey || !it.categoryKey,
    );
    if (needsReclass.length > 0 && refMap.size > 0) {
      // Tokenize reference names for keyword matching
      const tokenize = (s: string) =>
        s
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]/gu, " ")
          .split(/\s+/)
          .filter((w) => w.length > 2);
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
          const shared = itemTokens.filter((t) =>
            ref.tokens.includes(t),
          ).length;
          // Require at least 2 shared tokens or 50% of item tokens
          const minRequired = Math.max(2, Math.ceil(itemTokens.length * 0.4));
          if (shared >= minRequired && shared > bestScore) {
            bestScore = shared;
            bestPk = ref.placement;
          }
        }

        if (bestPk && placementLookup[bestPk]) {
          const parent = placementLookup[bestPk];
          console.log(
            `[reclass] "${item.name}" → ${bestPk} (score ${bestScore}/${itemTokens.length})`,
          );
          item.placementKey = bestPk;
          item.categoryKey = parent.categoryKey;
          item.subcategoryKey = parent.subcategoryKey;
          reclassified++;
        }
      }
      if (reclassified > 0) {
        console.log(
          `[reclass] Fixed ${reclassified}/${needsReclass.length} unclassified products`,
        );
      }
    }

    // Final lightweight multilingual fallback for common food names.
    // High-confidence rules may override a wrong AI placement, otherwise only fill empty placementKey.
    let fallbackClassified = 0;
    for (const item of items) {
      const found = keywordFallbacks.find(
        (rule) => rule.re.test(item.name) && placementLookup[rule.placementKey],
      );
      if (!found) continue;

      const canOverride =
        !item.placementKey ||
        !item.categoryKey ||
        found.force === true ||
        ["pomaran_e", "panenka_brav_ov"].includes(item.placementKey);

      if (!canOverride) continue;

      const parent = placementLookup[found.placementKey];
      item.placementKey = found.placementKey;
      item.categoryKey = parent.categoryKey;
      item.subcategoryKey = parent.subcategoryKey;
      fallbackClassified++;
    }
    if (fallbackClassified > 0) {
      console.log(
        `[reclass] Keyword fallback fixed/overrode ${fallbackClassified} products`,
      );
    }

    // Post-processing: filter out non-food products that AI failed to skip
    const NON_FOOD_RE = new RegExp(
      [
        // Candles, grave supplies, LED inserts (PL/SK/CZ)
        "świec[aąy]",
        "sviečk",
        "svíčk",
        "znicz",
        "zniczy",
        "kahán",
        "wkład.*(znic|led|olejow)",
        "subito",
        // Air fresheners, wardrobe sachets
        "odświeżacz",
        "osviežovač",
        "osvěžovač",
        "saszetk.*szaf",
        // Cleaning & laundry
        "proszek do prania",
        "prací práš",
        "płyn do prania",
        "avivá[zž]",
        "tabletk.*(zmywark|umývačk|myčk)",
        "środek czystości",
        "čistic.*prostřed",
        // Toilet/kitchen paper, paper towels
        "papier toaletow",
        "toaletn[ýí] papí",
        "ręcznik.*papierow",
        "papírov.*utěr",
        "ręcznik.*kuchen",
        "utierky kuchyn",
        // Cosmetics & body care
        "szampon",
        "šampón",
        "šampon",
        "odżywk.*włos",
        "kondicionér.*vlas",
        "kondicionér.*vlas",
        "żel pod prysznic",
        "sprchov.* g[eé]l",
        "dezodorant",
        "antiperspiran",
        "farb.*(włos|vlas)",
        "barv.*vlas",
        "lakier do włos",
        "lak na vlas",
        "maszyn[eę]k.*golen",
        "holic[ií]",
        "piank.*golen",
        "pěn.*holen",
        "żel do golen",
        "żel po golen",
        "piank.*do twarzy",
        "piank.*na tvár",
        "pěn.*na obličej",
        "żel do mycia",
        "sprchov.* g[eé]l",
        "parfém",
        "perfum",
        "woda toaletow",
        "eau de toilette",
        "płatk.*pod oczy",
        "balsam do ciała",
        "krem do twarzy",
        "mgiełk.*ciał",
        "mleczko do ciał",
        "woda po golen",
        "balsam po golen",
        "patyczk.*kosmetycz",
        // Oral hygiene
        "pasta do zębów",
        "zubn[áí] past",
        "szczoteczk.*zębów",
        "zubn[áí] kefk",
        "zubn[íi] kartáč",
        "ústn[aí] vod",
        "płyn do płukania.*ust",
        // Feminine hygiene & diapers
        "podpask[iy]",
        "tampon[yů]",
        "wkładk.*higien",
        "pieluch[iy]",
        "pieluszk",
        "\\bplienk",
        "\\bplenk",
        // Pet food
        "karma dla",
        "\\bkrmivo\\b",
        "whiskas",
        "pedigree",
        "sheba",
        // Misc non-food
        "żarówk",
        "žiarovk",
        "žárovk",
      ].join("|"),
      "i",
    );

    const foodItems = items.filter((p) => !NON_FOOD_RE.test(p.name));
    if (foodItems.length < items.length) {
      const removed = items.filter((p) => NON_FOOD_RE.test(p.name));
      console.log(
        `[filter] Removed ${removed.length} non-food: ${removed.map((p) => p.name).join(", ")}`,
      );
    }

    // Final token summary log
    const totalTokens =
      tokenStats.totalPromptTokens + tokenStats.totalCompletionTokens;
    // gpt-4.1-mini pricing (as of 2025): $0.40/1M prompt, $1.60/1M completion (vision prompt charged separately)
    const costUsd =
      (tokenStats.totalPromptTokens / 1_000_000) * 0.4 +
      (tokenStats.totalCompletionTokens / 1_000_000) * 1.6;
    console.log(`[tokens] ===== SUMMARY =====`);
    console.log(
      `[tokens] Prompt tokens total:     ${tokenStats.totalPromptTokens}`,
    );
    console.log(
      `[tokens] Completion tokens total: ${tokenStats.totalCompletionTokens}`,
    );
    console.log(`[tokens] Grand total:             ${totalTokens}`);
    console.log(
      `[tokens] Est. text cost (USD):    $${costUsd.toFixed(4)} (excl. image tokens)`,
    );
    console.log(
      `[tokens] knownProducts chars:     ${knownProductsPrompt.length} ≈ ${Math.round(knownProductsPrompt.length / 4)} est. tokens`,
    );

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
      debugSettings: {
        accuracyMode: ACCURACY_MODE,
        renderScale: RENDER_SCALE,
        jpegQuality: JPEG_QUALITY,
        pageTextLimit: PAGE_TEXT_LIMIT,
        imageDetail: IMAGE_DETAIL,
        visionBatchSize: VISION_BATCH_SIZE,
        autoBatchByDensity: AUTO_BATCH_BY_DENSITY,
        maxConcurrent: MAX_CONCURRENT,
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
      } catch {
        /* ignore */
      }
    }
    const message = err instanceof Error ? err.message : "Neznáma chyba";
    console.error("Chyba pri spracovaní PDF:", message);
    return Response.json({ error: message, success: false }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({
    message: "PDF Parser API (Text only - OpenAI)",
    status: "ready",
    apiKeyConfiguredInSupabaseFunction: true,
  });
}
