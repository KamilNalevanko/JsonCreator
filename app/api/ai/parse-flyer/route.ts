import { createClient } from "@supabase/supabase-js";
import {
  pad2,
  fixFlyerYear,
  normalizeSkDate,
  normalizePrice,
  capitalizeFirst,
} from "../../../../lib/normalize";
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
  food?: boolean;
  date_from?: string;
  date_to?: string;
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

// Date/price/name normalization helpers are shared with the client — see lib/normalize.ts.

// Some flyers (e.g. Biedronka) print a per-PRODUCT validity right in the product
// text ("oferta od 29.06 do 4.07", "29.06-30.06"). Pull that range out so each
// product gets its OWN dates instead of one page/flyer range. The year is optional
// and defaults to the current year. Returns null when no clear range is present.
function extractOfferDateRange(
  text: string,
): { date_from: string; date_to: string } | null {
  const s = text || "";
  const valid = (d: string, mo: string) => {
    const dd = Number(d);
    const mm = Number(mo);
    return dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12;
  };
  const build = (
    d1: string,
    m1: string,
    y1: string | undefined,
    d2: string,
    m2: string,
    y2: string | undefined,
  ) => ({
    date_from: `${pad2(d1)}.${pad2(m1)}.${fixFlyerYear(y1 || "")}`,
    date_to: `${pad2(d2)}.${pad2(m2)}.${fixFlyerYear(y2 || "")}`,
  });
  // "od 29.06 do 4.07" (years optional)
  let m = s.match(
    /\bod\s+(\d{1,2})\.\s*(\d{1,2})\.?(?:\s*(\d{2,4}))?\s+do\s+(\d{1,2})\.\s*(\d{1,2})\.?(?:\s*(\d{2,4}))?/i,
  );
  if (m && valid(m[1], m[2]) && valid(m[4], m[5]))
    return build(m[1], m[2], m[3], m[4], m[5], m[6]);
  // "29.06-30.06" dash range
  m = s.match(
    /(\d{1,2})\.\s*(\d{1,2})\.?(?:\s*(\d{2,4}))?\s*[-–]\s*(\d{1,2})\.\s*(\d{1,2})\.?(?:\s*(\d{2,4}))?/,
  );
  if (m && valid(m[1], m[2]) && valid(m[4], m[5]))
    return build(m[1], m[2], m[3], m[4], m[5], m[6]);
  return null;
}

// Returns the first candidate that normalizes to a real "DD.MM.YYYY" date, else "".
function firstValidSkDate(
  ...candidates: (string | undefined | null)[]
): string {
  for (const c of candidates) {
    const n = normalizeSkDate(c ?? "");
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(n)) return n;
  }
  return "";
}

function detectFlyerDateRange(
  text: string,
): { date_from: string; date_to: string } | null {
  // Matches "…platí/platia od [deň] D. M. do [deň] D. M. YYYY"
  // ("platí" = Billa, "platia" = Tesco "Ceny platia"; optional weekday word).
  // FIRST match wins: the page/offer header sits ABOVE any repeated footer or
  // legal line that restates the whole-flyer validity (and above narrower
  // sub-offers), so the first hit is the authoritative range for this text.
  const re =
    /(?:plat(?:í|ia)\s+)?od\s+(?:\p{L}+\s+)?(\d{1,2})\.\s*(\d{1,2})\.?\s+do\s+(?:\p{L}+\s+)?(\d{1,2})\.\s*(\d{1,2})\.?\s*(20\d{2})/iu;
  const m = text.match(re);
  if (!m) return null;
  const [, d1, m1, d2, m2, year] = m;
  return {
    date_from: `${pad2(d1)}.${pad2(m1)}.${year}`,
    date_to: `${pad2(d2)}.${pad2(m2)}.${year}`,
  };
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
      /\(?\s*=\s*1\s*(kg|l|liter|litre|pranie|dávka|porcia)\b[\s\d.,/€-]*\)?/gi,
      " ",
    )
    // bare per-kg/per-100g price like "1 kg 9,95", "cena za 1 kg 9,95 €", "1 kg od /", "1 kg 1,73 / 1,98"
    .replace(
      /(cena\s+za\s+)?\b1\s*(kg|l|liter|litre)\b\s*(od\b)?[\s\d.,/€-]*/gi,
      " ",
    )
    .replace(/\b(1\s*(kg|l|liter|litre))\s*[=:]\s*\d+[,.]\d+\s*€?/gi, " ")
    .replace(/\b(KC|BC|A)\s*:?\s*\d+[,.]\d+\b/gi, " ")
    .replace(/\bB-?C\s*\d+[,.]\d+[^,;]*/gi, " ")
    .replace(/\bdiscount\s*\d+%/gi, " ")
    .replace(/[-–]\s*\d+\s*%/g, " ")
    // deposit / returnable-packaging fee is never useful in a product note
    // (SK/CZ "záloha (za vratný obal)", PL "kaucja", DE "Pfand"); strips a trailing price too
    .replace(
      /,?\s*(?:z[áa]loh\w*|kaucj\w*|pfand)\w*[^,;0-9]*(?:\d+[,.]\d+)?/gi,
      " ",
    )
    // loyalty-card per-unit comparison price, e.g. "= 9,68 s Clubcard", "= 5,53 s kartou"
    .replace(
      /,?\s*=?\s*(?:\d+[,.]\d+\s*)?(?:s|z|so|with)?\s*(?:clubcard|kart[a-ząé]*)\b\w*/gi,
      " ",
    )
    // offer validity dates belong in the date fields, not the note
    // ("oferta od 29.06 do 4.07", "oferta 29.06-30.06", "od 29.06 do 1.07")
    .replace(
      /,?\s*\boferta\b\s*(?:od\s*)?\d{1,2}\.\s*\d{1,2}\.?(?:\s*\d{2,4})?(?:\s*(?:do|[-–])\s*\d{1,2}\.\s*\d{1,2}\.?(?:\s*\d{2,4})?)?/gi,
      " ",
    )
    .replace(
      /,?\s*\bod\s+\d{1,2}\.\s*\d{1,2}\.?(?:\s*\d{2,4})?\s+do\s+\d{1,2}\.\s*\d{1,2}\.?(?:\s*\d{2,4})?/gi,
      " ",
    )
    // bare "discount/sale" words are not useful metadata (the price fields already say it)
    .replace(
      /\b(z[ľl]ava|sleva|akci[ae]|akcj\w*|zni[zż]k\w*|rabat\w*|obni[zż]k\w*|promocj\w*|sleva|wyprzeda[zż]\w*)\b/gi,
      " ",
    )
    // leftover lone slash / "od" after a price was stripped
    .replace(/\s+\/\s+/g, " ")
    .replace(/(^|,)\s*\/\s*(?=,|$)/g, "$1")
    // a bare currency symbol is never useful in a note (prices are excluded by design)
    .replace(/€/g, " ")
    // remove parentheses/brackets left empty after a price was stripped, e.g. "( )", "(=)", "( - )"
    .replace(/[([{][^\p{L}\p{N}]*[)\]}]/gu, " ")
    // drop a lone dangling open/close bracket with no real content around it
    .replace(/\s[([{]\s|\s[)\]}]\s/g, " ")
    .replace(/^\s*[)\]}]\s*|\s*[([{]\s*$/g, "")
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
  let amount =
    amountValue === null || amountValue === undefined
      ? ""
      : String(amountValue).trim();
  // The model sometimes puts the unit into "amount" (e.g. "500 g", "110 ml").
  // Amount must stay a bare number — the unit belongs in `unit`. Strip a trailing
  // unit, both glued ("500g") and space-separated ("500 g"). For multipacks this
  // only drops the final unit token (e.g. "8 x 0,5 l + 4 l" → "8 x 0,5 l + 4").
  amount = amount
    .replace(/^([\d.,]+)(kg|dkg|dag|hg|mg|g|ml|cl|dl|l|ks)\.?$/i, "$1")
    .replace(
      /\s+(kg|dkg|dag|hg|mg|g|ml|cl|dl|l|ks|kus(?:y|ov)?|pcs?|zv[äa]zok|svaz[eo]k|p[ęe]czek)\.?\s*$/i,
      "",
    )
    .trim();
  // Canonical decimal separator: the model alternates "1.5" / "1,5" between
  // runs — keep plain decimals comma-based like prices ("1.5" → "1,5").
  if (/^\d+\.\d+$/.test(amount)) amount = amount.replace(".", ",");
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
    prompt_tokens_details?: { cached_tokens?: number };
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
  "products": [{ "name": "Brand + product when brand is readable, e.g. Lindt Lindor pralinky", "amount": "...", "unit": "g/kg/ml/l/ks/zväzok/null", "price_sale": "...", "note": "...", "page": N, "placementKey": "...", "food": true, "date_from": "DD.MM.YYYY or empty", "date_to": "DD.MM.YYYY or empty" }]
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
    // Same-shop known product names (full, brand included). Used later as ground truth
    // to correct hallucinated own-brand prefixes (e.g. a false "K-Classic" on a product
    // the DB lists without an own brand).
    const shopKnownNames: string[] = [];
    try {
      const supabaseUrl =
        process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
      const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const queryShop = formShop || detectedShop || "";
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
          if (shopRows) {
            pairs = dedup(shopRows);
            for (const r of shopRows) {
              if (r.name) shopKnownNames.push(r.name);
            }
          }
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

    // Retailer private-label (own brand) hint — helps the model recognise small
    // stylised own-brand logos (e.g. the red "K" of Kaufland's "K-Classic") that
    // are otherwise hard to read as text.
    const PRIVATE_LABELS: Record<string, string[]> = {
      kaufland: [
        "K-Classic",
        "K-Gold",
        "K-Bio",
        "K-take it veggie",
        "K-Purland",
        "K-to go",
      ],
      lidl: [
        "Milbona",
        "Pilos",
        "Combino",
        "Freeway",
        "Crownfield",
        "Dulano",
        "Sondey",
        "Alesto",
        "Vitasia",
        "Italiamo",
        "Cien",
      ],
      billa: ["Clever", "BILLA", "Vegavita"],
      "tesco-hypermarket": ["Tesco", "Tesco Finest"],
      "coop-jednota": ["Coop", "Dobré z našej dediny"],
      peny: ["Boni", "San Fabio", "Penny"],
      globus: ["Globus", "Korrekt"],
      "albert-hypermarket": ["Albert", "Albert Excellent", "Albert Bio"],
      aldi: ["Milsani", "Almare", "Gut Bio"],
      biedronka: ["Biedronka", "Go Active", "Dada"],
      "auchan-hypermarket": ["Auchan", "Pewex"],
      carrefour: ["Carrefour", "Carrefour Bio"],
    };
    const resolvedShopKey = (detectedShop || formShop || "").toLowerCase();
    const shopOwnBrands = PRIVATE_LABELS[resolvedShopKey] || [];
    const privateLabelHint =
      shopOwnBrands.length > 0
        ? `\n\nRETAILER PRIVATE LABELS (own brands of this shop): ${shopOwnBrands.join(", ")}.
- Use one of these own brands when you can clearly see its own-brand logo on THIS product — printed ON the package itself OR as a badge beside its title. Kaufland's "K-Classic" logo = a RED square containing a white "K" with the white word "CLASSIC"; whenever you see that red-K + white-"CLASSIC" logo on a product, its brand is "K-Classic" → put "K-Classic" at the START of the name. Read the actual logo; do not infer it just because a product looks generic. If a DIFFERENT manufacturer brand is printed on the pack (e.g. "Vegeta", "Haribo", "Lindt"), that brand wins — use it instead of the store own brand.
- The badge must belong to THIS product. Do NOT carry a badge or brand over from a neighbouring offer tile (tiles are packed close together). Country-of-origin flags/coats-of-arms ("made in"), quality seals, award medals, eco/bio/vegan logos, and the plain store name ("Kaufland", "Lidl") are NOT product brands.
- If the product shows no clearly readable brand AND no own-brand badge of its own (e.g. packaging shows only a generic product type like "VLOČKY"), leave the brand EMPTY. An empty brand is better than a guessed one.`
        : "";

    const PRODUCT_RULES = `You extract supermarket flyer products. country="${country}", language="${targetLanguageName}". Return ONLY valid JSON in the schema.

TASK: Extract only food, drinks and alcohol. One visible offer = one record. Include small corner products if edible. Skip non-food and pure campaign/legal areas.

NAME (short, clean):
- BRAND FIRST (always): actively look for the product's brand on its package before naming it — check the logo even on small/dark/glossy packs; most packaged products do carry a brand, so make the effort and try not to leave it missing. When a brand is readable, the name MUST start with it, then the product type. Even if the flyer writes the product type first, REORDER so the brand leads: write "Brand + product type", never "product type + Brand". Examples: "Lindt Lindor čokoládové pralinky", "Davidoff instantná káva". Add the sub-brand/line if printed together (e.g. "Lindt Lindor", "Figaro Tatiana", "Haribo Goldbären"). Write the brand exactly as printed; do not translate it.
- Use only a brand you can actually read for that product. Never invent one, guess it, or copy it from a neighbouring tile (e.g. lollipops are not automatically "Skittles"). If you truly cannot read any brand, leave it out — but only as a last resort, after genuinely looking.
- Keep the product term in the flyer's language; do not translate. Prefer text attached to the same pack; prefer a short clean name over a long uncertain one.
- Exclude retailer names, loyalty programs, slogans, headers, campaign/award/QR/website text, and sale/package details.${privateLabelHint}

NOTE (short) — put here, not in name: various kinds/flavours; counter/loose/by weight; chilled/frozen/packaged; without giblets/bone; multipack or 1+1/3+3; drained weight; special offer/while stocks last. NEVER put in note (exclude entirely): deposit / returnable-packaging fees in ANY language (e.g. "záloha za vratný obal 0,15", "zálohované obaly", "kaucja za butelkę", "Pfand"); % discounts; crossed-out prices; per-kg/per-l comparison prices including loyalty-card formulas (e.g. "= 9,68 s Clubcard"); legal text and marketing copy.

AMOUNT/UNIT:
- "amount" = string (never a number); the sold package amount, not the per-kg/per-l comparison.
- "unit" ∈ {g, kg, ml, l, ks, zväzok, ""}; use "zväzok" for bunches. For multipacks, amount = one package, details in note.

PRICES:
- Extract ONLY "price_sale" = the main final customer price of the offer (card/coupon/app price only if it is the prominent advertised one; then mention the condition in note, e.g. "s aplikací").
- IGNORE every other number around the offer: crossed-out old prices, "BĚŽNÁ CENA", per-kg/per-l comparison prices, percentages. Do not output them anywhere.
- Many flyers (especially Czech ones, prices in Kč) print the decimal part as SMALL RAISED digits after a big number (e.g. big "129" with a small "90" = 129,90). Read such a pair as ONE price with a decimal comma — never as two prices, never as "12990", and never guess missing decimals. In the TEXT LAYER such prices appear GLUED: "13990" means 139,90 and "5990" means 59,90 (the last two digits are the decimals).
- Copy the price EXACTLY as printed on that offer. If you cannot clearly read it, leave it "" — an empty price is better than an estimated one. Never invent prices.

DATES (per product):
- If THIS product prints its OWN validity next to it (e.g. "oferta od 29.06 do 4.07", "29.06-30.06", "platí od…do…"), put that range in the product's "date_from"/"date_to" as DD.MM.YYYY. Copy the day and month exactly as printed. If the year is missing, still fill day.month and use the current year.
- If the product has NO its own printed dates (validity comes only from a page/flyer header), leave "date_from"/"date_to" EMPTY — do not copy the header date into every product.
- Do NOT keep offer dates in "note"; the date belongs only in the date fields.

INPUT: each page = text layer + image. Use the text to verify names/brands/amounts/prices; use the image to map text to the right product and to read package logos. Ignore footer/banner/QR/website/non-food text.

FOOD vs NON-FOOD (language-independent — judge by what the product actually is, not by keywords):
- This catalogue keeps ONLY human food, drinks and alcohol.
- For EVERY product you output, set "food": true if it is edible human food / drink / alcohol, otherwise "food": false.
- Non-food (food=false) includes e.g.: pet food, cosmetics, hygiene & oral care, cleaning/laundry, paper goods, flowers/plants, clothing & footwear, toys, electronics & appliances, cookware/dishes, tools, garden, stationery.
- You MAY skip obvious non-food entirely to save effort, but if you do include such an item you MUST mark it food=false. When in doubt about edibility, set food=false.

CLASSIFY ("placementKey" from the list): classify by the product, not the brand. Use an exact placement if it exists, else a clearly-matching broader one. Do not map unknown items to unrelated ones. Empty is better than confidently wrong, but do classify common items when a reasonable placement exists.
Avoid these category mix-ups — judge by what the product physically IS, not by a loosely similar word:
- A bar/stick eaten as a snack (chocolate bar, wafer bar, muesli bar) is a confectionery BAR — never a spread/cream. Spreads/creams come in a jar or tube and are spreadable.
- Canned or jarred fruit in slices, halves or pieces (in syrup/juice) is preserved/sterilized FRUIT — never jam/marmalade. Jam is a spreadable fruit purée.
- A child's fizzy or still soft DRINK (e.g. sparkling juice, kids' lemonade) is a soft drink / lemonade — not a milk or yogurt drink, unless it actually contains milk or yogurt.
- Breakfast cereals / muesli / cereal flakes are a breakfast/cereal product — never a ready-made or chilled meal.

PLACEMENT LIST:
${PLACEMENTS_PROMPT}
Use ONLY the key before ":". Dates may be null. "page" must match the page marker.${knownProductsPrompt}`;

    // Static instruction block — identical for every batch of this flyer. Kept in
    // a separate `system` message so OpenAI's automatic prompt caching reuses it
    // across batches (big saving when many/dense batches are sent per flyer).
    const SYSTEM_PROMPT = `OUTPUT JSON SCHEMA:\n${PRODUCT_SCHEMA}\n\n${PRODUCT_RULES}`;

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
      totalCachedTokens: 0,
      // Breakdown of the text-only second-pass classification calls (subset of totals).
      classifyPromptTokens: 0,
      classifyCompletionTokens: 0,
      classifyCachedTokens: 0,
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
                  text: `Analyze these supermarket flyer pages (batch ${batchIdx + 1}/${batches.length}).${!isFirst ? " For this non-first batch, meta dates may be null." : ""}`,
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
                messages: [
                  { role: "system", content: SYSTEM_PROMPT },
                  { role: "user", content },
                ],
              });

              const usage = response.usage;
              if (usage) {
                const cached = usage.prompt_tokens_details?.cached_tokens || 0;
                tokenStats.totalPromptTokens += usage.prompt_tokens;
                tokenStats.totalCompletionTokens += usage.completion_tokens;
                tokenStats.totalCachedTokens += cached;
                tokenStats.batches.push({
                  batch: batchIdx + 1,
                  promptTokens: usage.prompt_tokens,
                  completionTokens: usage.completion_tokens,
                  promptChars,
                });
                console.log(
                  `[tokens] Batch ${batchIdx + 1}/${batches.length}: prompt=${usage.prompt_tokens} (cached=${cached}) compl=${usage.completion_tokens} total=${usage.total_tokens} (promptChars=${promptChars})`,
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

    // ─── Coverage check + automatic re-run of under-extracted pages ───
    // A dense page sometimes comes back with only a couple of products (vision
    // attention failure — e.g. a photo-collage page with 11 offers returning 2).
    // Estimate the expected offer count from price-like tokens in the page's text
    // layer (each offer prints regular+sale ≈ 2 tokens); if a page yielded less
    // than half of that, re-analyze THAT page alone once with an explicit
    // completeness instruction and merge the results (dedupe below removes overlaps).
    const COVERAGE_MAX_RETRIES = Number(process.env.COVERAGE_MAX_RETRIES || 12);
    const coverageWarnings: string[] = [];
    {
      const extractedPerPage = new Map<number, number>();
      for (const p of allProducts) {
        if (p.page != null)
          extractedPerPage.set(p.page, (extractedPerPage.get(p.page) || 0) + 1);
      }
      const lowPages: { pageNum: number; expected: number; got: number }[] = [];
      for (const pg of pageImages) {
        const expected = Math.round(priceLikeCount(pg.textData) / 2);
        const got = extractedPerPage.get(pg.pageNum) || 0;
        if (expected >= 4 && got < expected * 0.5) {
          lowPages.push({ pageNum: pg.pageNum, expected, got });
        }
      }

      const parseLooseJson = (txt: string): ParsedResponse | null => {
        try {
          return JSON.parse(txt) as ParsedResponse;
        } catch {
          const a = txt.indexOf("{");
          const b = txt.lastIndexOf("}");
          if (a !== -1 && b > a) {
            try {
              return JSON.parse(txt.slice(a, b + 1)) as ParsedResponse;
            } catch {
              return null;
            }
          }
          return null;
        }
      };

      for (const low of lowPages.slice(0, COVERAGE_MAX_RETRIES)) {
        const pg = pageImages.find((p) => p.pageNum === low.pageNum);
        if (!pg) continue;
        console.log(
          `[coverage] Page ${low.pageNum}: extracted ${low.got}, expected ~${low.expected} — re-analyzing page alone`,
        );
        try {
          const parsed = await callWithRetry(async () => {
            const response = await createOpenAIChatCompletion({
              model: (process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini").trim(),
              response_format: { type: "json_object" },
              temperature: 0,
              max_completion_tokens: 24000,
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: `Re-analysis of a single flyer page. This page contains approximately ${low.expected} distinct offers — extract EVERY one of them, including small tiles and corner offers. Do not stop early.`,
                    },
                    {
                      type: "text",
                      text: `=== PAGE ${pg.pageNum} TEXT LAYER ===\n${pg.textData || "(no text layer)"}`,
                    },
                    { type: "text", text: `=== PAGE ${pg.pageNum} IMAGE ===` },
                    {
                      type: "image_url",
                      image_url: {
                        url: `data:image/jpeg;base64,${pg.imageData}`,
                        detail: IMAGE_DETAIL,
                      },
                    },
                  ] as VisionContentPart[],
                },
              ],
            });
            const usage = response.usage;
            if (usage) {
              tokenStats.totalPromptTokens += usage.prompt_tokens;
              tokenStats.totalCompletionTokens += usage.completion_tokens;
              tokenStats.totalCachedTokens +=
                usage.prompt_tokens_details?.cached_tokens || 0;
            }
            const txt = response.choices?.[0]?.message?.content?.trim() ?? "";
            return txt ? parseLooseJson(txt) : null;
          });

          const rerunProducts = parsed?.products;
          if (Array.isArray(rerunProducts) && rerunProducts.length > low.got) {
            for (const p of rerunProducts) p.page = low.pageNum;
            allProducts.push(...rerunProducts);
            console.log(
              `[coverage] Page ${low.pageNum}: re-run found ${rerunProducts.length} products (merged; dedupe cleans overlaps)`,
            );
          } else {
            coverageWarnings.push(
              `Strana ${low.pageNum}: extrahovaných ${low.got} z ~${low.expected} ponúk — skontroluj ručne.`,
            );
          }
        } catch (e) {
          console.error(
            `[coverage] Page ${low.pageNum} re-run failed: ${(e as Error).message}`,
          );
          coverageWarnings.push(
            `Strana ${low.pageNum}: re-analýza zlyhala — skontroluj ručne.`,
          );
        }
      }
      for (const low of lowPages.slice(COVERAGE_MAX_RETRIES)) {
        coverageWarnings.push(
          `Strana ${low.pageNum}: extrahovaných ${low.got} z ~${low.expected} ponúk — skontroluj ručne.`,
        );
      }
    }

    // Prefer dates read from PDF text layer when available. This fixes common vision mistakes with years.
    if (detectedDateRange) {
      meta.date_from = detectedDateRange.date_from;
      meta.date_to = detectedDateRange.date_to;
    }
    // Canonicalize the global meta so any AI-provided fallback date is consistent too.
    meta.date_from = normalizeSkDate(meta.date_from);
    meta.date_to = normalizeSkDate(meta.date_to);

    // Per-page validity: many flyers print a different "platí/platia od … do …"
    // header on each page (e.g. Tesco: page 1 = 24.6–30.6, page 2 = 24.6–7.7,
    // page 3 = 16.6–29.6). Detect each page's own range from its text layer so a
    // product gets its page's dates instead of one global range for the whole flyer.
    const pageDateRanges = new Map<
      number,
      { date_from: string; date_to: string }
    >();
    for (const pg of pageImages) {
      const r = detectFlyerDateRange(pg.textData);
      if (r) pageDateRanges.set(pg.pageNum, r);
    }

    // Sort by page number numerically before deduplication
    allProducts.sort((a, b) => (a.page ?? 0) - (b.page ?? 0));

    // Deduplicate by stable offer key, not only by name.
    // Same product name can appear with a different size/price on another page.
    const seen = new Set<string>();
    const droppedNoName: string[] = [];
    const droppedDupes: string[] = [];
    const deduped = allProducts.filter((p) => {
      const nameKey = (p.name || "").toLowerCase().replace(/\s+/g, " ").trim();
      // Key fields must be NORMALIZED: the model alternates decimal separators
      // between runs ("1.5" vs "1,5", "0.89" vs "0,89"), and the coverage re-run
      // merge relies on this dedupe to clean overlaps.
      const key = [
        nameKey,
        String(p.amount || "")
          .toLowerCase()
          .replace(/,/g, ".")
          .replace(/\s+/g, " ")
          .trim(),
        String(p.unit || "")
          .toLowerCase()
          .trim(),
        normalizePrice(p.price_sale),
      ].join("|");
      if (!nameKey) {
        droppedNoName.push(p.name || "(prázdny názov)");
        return false;
      }
      if (seen.has(key)) {
        droppedDupes.push(`${p.name} ${p.amount || ""}${p.unit || ""} @${p.price_sale || "?"}`);
        return false;
      }
      seen.add(key);
      return true;
    });
    // Make removals visible so nothing disappears silently. A "duplicate" here means
    // an identical name+amount+unit+sale-price — usually the same offer read twice.
    if (droppedDupes.length) {
      console.log(
        `[dedupe] Removed ${droppedDupes.length} duplicate offer(s): ${droppedDupes.join(", ")}`,
      );
    }
    if (droppedNoName.length) {
      console.log(
        `[dedupe] Removed ${droppedNoName.length} product(s) with empty name`,
      );
    }

    const retailerHints = [formShop, detectedShop || ""].filter(Boolean);

    // Normalize for keyword matching: strip diacritics (handles NFD/decomposed
    // accents from the model, e.g. "Brumík"/"Piškótový") and lowercase.
    const normForMatch = (s: string) =>
      (s || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase();

    // Drop non-food using the model's own food/non-food judgement (food=false).
    // Language-independent and scalable — no keyword lists to maintain per country.
    // Missing flag defaults to food (kept), so we never over-remove.
    const foodDeduped = deduped.filter((p) => p.food !== false);
    if (foodDeduped.length < deduped.length) {
      const droppedNonFood = deduped.filter((p) => p.food === false);
      console.log(
        `[filter] Removed ${droppedNonFood.length} non-food (AI food=false): ${droppedNonFood
          .map((p) => p.name)
          .join(", ")}`,
      );
    }

    const items = foodDeduped.map((item: Product) => {
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
      // Date priority for THIS product's validity:
      //   1) the AI's own per-product date (when the offer printed its own dates),
      //   2) a date parsed from the product's note text ("oferta od … do …"),
      //   3) this page's detected range, 4) the global flyer range.
      const productRange = extractOfferDateRange(item.note || "");
      const pageRange =
        item.page != null ? pageDateRanges.get(item.page) : undefined;

      return {
        name: capitalizeFirst(moved.name),
        amount: normalized.amount,
        unit: normalized.unit,
        price_sale: normalizePrice(item.price_sale),
        // Regular (crossed-out) price is no longer extracted — the AI only reads
        // the sale price. The field stays in the shape for editor/DB compatibility.
        price_regular: "",
        note: moved.note,
        date_from: firstValidSkDate(
          item.date_from,
          productRange?.date_from,
          pageRange?.date_from,
          meta.date_from,
        ),
        date_to: firstValidSkDate(
          item.date_to,
          productRange?.date_to,
          pageRange?.date_to,
          meta.date_to,
        ),
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
        normForMatch(s)
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

    // ─── Second-pass AI classification (text-only) ───
    // Replaces the old hand-written keyword regex fallback. For products still
    // unclassified after DB token-matching, we send just their names plus the full
    // placement list to the model and let it pick the best key. Language-independent
    // and scales to any country with no per-language rules to maintain. Text-only,
    // so it's cheap and the placement list is cached across this flyer's chunks.
    const stillUnclassified = items.filter(
      (it) => !it.placementKey || !it.categoryKey,
    );
    if (stillUnclassified.length > 0) {
      // Dedupe by name — many offers can share the same product name.
      const uniqueNames = Array.from(
        new Set(stillUnclassified.map((it) => it.name.trim()).filter(Boolean)),
      );

      const CLASSIFY_SYSTEM = `You classify supermarket products into a fixed placement taxonomy. Output language context: "${targetLanguageName}".
For each product name, choose the single best matching placementKey from the list below. Classify by what the product IS, not by its brand. Use an exact placement if one exists, otherwise the closest clearly-matching broader one. If no placement reasonably fits, return an empty string for that product — an empty key is better than a wrong one.
Return ONLY valid JSON: {"classifications":[{"name":"<exact input name>","placementKey":"<key from list or empty>"}]}. Use ONLY the key before ":".

PLACEMENT LIST:
${PLACEMENTS_PROMPT}`;

      const classifyModel = (
        process.env.OPENAI_CLASSIFY_MODEL ||
        process.env.OPENAI_VISION_MODEL ||
        "gpt-4.1-mini"
      ).trim();
      const CLASSIFY_CHUNK = Number(process.env.CLASSIFY_CHUNK_SIZE || 60);

      // Collect all model answers first (name → placementKey), then apply once.
      // Chunks are independent text-only calls → run them in PARALLEL (faster on
      // large flyers; the cache saving from serial runs was negligible).
      const classifyChunks: string[][] = [];
      for (let i = 0; i < uniqueNames.length; i += CLASSIFY_CHUNK) {
        classifyChunks.push(uniqueNames.slice(i, i + CLASSIFY_CHUNK));
      }
      const classMap = new Map<string, string>();
      const chunkResults = await Promise.all(
        classifyChunks.map((chunk) =>
          callWithRetry(async () => {
          const response = await createOpenAIChatCompletion({
            model: classifyModel,
            response_format: { type: "json_object" },
            temperature: 0,
            max_completion_tokens: 8000,
            messages: [
              { role: "system", content: CLASSIFY_SYSTEM },
              {
                role: "user",
                content: `Classify these products:\n${chunk
                  .map((n, idx) => `${idx + 1}. ${n}`)
                  .join("\n")}`,
              },
            ],
          });

          const usage = response.usage;
          if (usage) {
            const cached = usage.prompt_tokens_details?.cached_tokens || 0;
            tokenStats.totalPromptTokens += usage.prompt_tokens;
            tokenStats.totalCompletionTokens += usage.completion_tokens;
            tokenStats.totalCachedTokens += cached;
            tokenStats.classifyPromptTokens += usage.prompt_tokens;
            tokenStats.classifyCompletionTokens += usage.completion_tokens;
            tokenStats.classifyCachedTokens += cached;
          }

          const txt = response.choices?.[0]?.message?.content?.trim() ?? "";
          if (!txt) return null;
          const parseLoose = (s: string) => {
            try {
              return JSON.parse(s);
            } catch {
              const a = s.indexOf("{");
              const b = s.lastIndexOf("}");
              if (a !== -1 && b > a) {
                try {
                  return JSON.parse(s.slice(a, b + 1));
                } catch {
                  return null;
                }
              }
              return null;
            }
          };
          return parseLoose(txt) as {
            classifications?: { name?: string; placementKey?: string }[];
          } | null;
          }).catch((err) => {
            console.error(
              `[reclass-ai] Classification chunk failed: ${(err as Error).message}`,
            );
            return null;
          }),
        ),
      );
      for (const res of chunkResults) {
        const classifications = res?.classifications;
        if (!Array.isArray(classifications)) continue;
        for (const c of classifications) {
          const pk = (c?.placementKey || "").trim();
          const name = (c?.name || "").trim().toLowerCase();
          if (name && pk && placementLookup[pk]) classMap.set(name, pk);
        }
      }

      let secondPassClassified = 0;
      for (const item of stillUnclassified) {
        if (item.placementKey && item.categoryKey) continue;
        const pk = classMap.get(item.name.trim().toLowerCase());
        if (pk && placementLookup[pk]) {
          const parent = placementLookup[pk];
          item.placementKey = pk;
          item.categoryKey = parent.categoryKey;
          item.subcategoryKey = parent.subcategoryKey;
          secondPassClassified++;
          console.log(`[reclass-ai] "${item.name}" → ${pk}`);
        }
      }
      if (secondPassClassified > 0) {
        console.log(
          `[reclass-ai] Second-pass AI classified ${secondPassClassified}/${stillUnclassified.length} products`,
        );
      }
    }

    // ─── Sibling placement correction from hierarchy labels ───
    // Generic, language-independent fix for "valid but wrong sibling" results: if a
    // product name clearly matches a DIFFERENT placement label within the SAME
    // subcategory (e.g. an item literally called "Želé cukríky" placed under
    // "Dražé cukríky"), switch to the better-matching sibling. Driven purely by the
    // translated hierarchy labels — no per-product keyword lists to maintain.
    {
      const tokenizeWords = (s: string) =>
        normForMatch(s)
          .replace(/[^\p{L}\p{N}]/gu, " ")
          .split(/\s+/)
          .filter((w) => w.length > 2);

      // subcategoryKey → [{ key, label tokens }]
      const siblingsBySubcat = new Map<
        string,
        { key: string; tokens: string[] }[]
      >();
      for (const [key, parent] of Object.entries(placementLookup)) {
        const label = (labels as Record<string, string>)[key] || key;
        const arr = siblingsBySubcat.get(parent.subcategoryKey) || [];
        arr.push({ key, tokens: tokenizeWords(label) });
        siblingsBySubcat.set(parent.subcategoryKey, arr);
      }

      let siblingFixed = 0;
      for (const item of items) {
        if (!item.placementKey || !item.subcategoryKey) continue;
        const siblings = siblingsBySubcat.get(item.subcategoryKey);
        if (!siblings || siblings.length < 2) continue;

        const nameTokens = new Set(tokenizeWords(item.name));
        if (nameTokens.size === 0) continue;

        const currentTokens =
          siblings.find((s) => s.key === item.placementKey)?.tokens || [];
        const overlap = (tokens: string[]) =>
          tokens.filter((t) => nameTokens.has(t)).length;
        const currentScore = overlap(currentTokens);

        let bestKey = item.placementKey;
        let bestScore = currentScore;
        for (const sib of siblings) {
          if (sib.key === item.placementKey) continue;
          const s = overlap(sib.tokens);
          // Switch only on a STRONG sibling match: it must beat the current label,
          // overlap on at least TWO label words, AND contribute a distinctive word
          // (≥4 chars) the current label lacks. The ≥2 floor prevents flipping a
          // correct-but-lexically-unrelated placement (e.g. "Vegeta", "Rôzne druhy")
          // onto a sibling that merely shares one generic word like "cestoviny".
          const distinctive = sib.tokens.some(
            (t) =>
              t.length >= 4 && nameTokens.has(t) && !currentTokens.includes(t),
          );
          if (s > bestScore && s >= 2 && distinctive) {
            bestScore = s;
            bestKey = sib.key;
          }
        }

        if (bestKey !== item.placementKey) {
          const parent = placementLookup[bestKey];
          console.log(
            `[reclass-sibling] "${item.name}" ${item.placementKey} → ${bestKey}`,
          );
          item.placementKey = bestKey;
          item.categoryKey = parent.categoryKey;
          item.subcategoryKey = parent.subcategoryKey;
          siblingFixed++;
        }
      }
      if (siblingFixed > 0) {
        console.log(
          `[reclass-sibling] Corrected ${siblingFixed} sibling placements`,
        );
      }
    }

    // ─── Own-brand correction against same-shop DB ground truth ───
    // The vision model sometimes adds a retailer own-brand (e.g. "K-Classic") to a
    // product that does not carry it — a stubborn false positive that prompt/render
    // tuning does not reliably fix (the badge is a tiny image, no text-layer signal).
    // The curated DB knows the truth: if the same-shop product is listed WITHOUT an
    // own brand, strip the hallucinated prefix. Deterministic, scales with the DB.
    if (shopOwnBrands.length > 0 && shopKnownNames.length > 0) {
      // Hyphen/space-insensitive matcher for each own brand (e.g. "K-Classic" also
      // matches "K Classic", "K classic").
      const brandRes = shopOwnBrands.map((b) => ({
        label: b,
        re: new RegExp(
          b
            .split(/[-\s]+/)
            .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("[-\\s]*"),
          "i",
        ),
      }));
      const detectBrand = (name: string) =>
        brandRes.find((b) => b.re.test(name))?.label || null;
      const stripBrands = (name: string) => {
        let n = name;
        for (const b of brandRes) n = n.replace(b.re, " ");
        return n.replace(/\s+/g, " ").trim();
      };
      // Brand-stripped, order-independent key of the product's "core" name.
      const coreTokens = (name: string) =>
        normForMatch(stripBrands(name))
          .replace(/[^\p{L}\p{N}]/gu, " ")
          .split(/\s+/)
          .filter((w) => w.length > 2);
      const coreKey = (name: string) => coreTokens(name).slice().sort().join(" ");

      // DB truth: core name → own brand label, or "" when the DB lists it brand-less.
      // A definite own brand always wins over a brand-less sighting of the same core.
      const dbBrandTruth = new Map<string, string>();
      for (const nm of shopKnownNames) {
        if (coreTokens(nm).length < 2) continue; // skip generic single-word names
        const key = coreKey(nm);
        if (!key) continue;
        const b = detectBrand(nm);
        if (b) dbBrandTruth.set(key, b);
        else if (!dbBrandTruth.has(key)) dbBrandTruth.set(key, "");
      }

      let brandStripped = 0;
      for (const item of items) {
        const itemBrand = detectBrand(item.name);
        if (!itemBrand) continue; // only correct false positives (strip), never invent
        if (coreTokens(item.name).length < 2) continue;
        const truth = dbBrandTruth.get(coreKey(item.name));
        if (truth === "") {
          const stripped = stripBrands(item.name);
          if (stripped && stripped.toLowerCase() !== item.name.toLowerCase()) {
            console.log(
              `[brand] Strip "${itemBrand}" from "${item.name}" (DB lists it brand-less) → "${stripped}"`,
            );
            item.name = stripped;
            brandStripped++;
          }
        }
      }
      if (brandStripped > 0) {
        console.log(
          `[brand] Removed ${brandStripped} hallucinated own-brand prefix(es) using DB`,
        );
      }
    }

    // Non-food filtering is handled above by the AI "food" flag (food=false),
    // which is language-independent and needs no per-country keyword lists.

    // Drop offers without any usable price (e.g. teaser products like "Avokádo"
    // or "Kaizerka" shown without a number). Both prices empty => skip.
    const hasPrice = (p: { price_sale?: string; price_regular?: string }) =>
      Boolean((p.price_sale || "").trim() || (p.price_regular || "").trim());
    const pricedItems = items.filter(hasPrice);
    if (pricedItems.length < items.length) {
      const dropped = items.filter((p) => !hasPrice(p));
      console.log(
        `[filter] Removed ${dropped.length} without price: ${dropped.map((p) => p.name).join(", ")}`,
      );
    }

    // Final token summary log
    const totalTokens =
      tokenStats.totalPromptTokens + tokenStats.totalCompletionTokens;
    // gpt-4.1-mini pricing (as of 2025): $0.40/1M prompt, $0.10/1M cached prompt, $1.60/1M completion
    const estimateCost = (
      promptTokens: number,
      cachedTokens: number,
      completionTokens: number,
    ) =>
      ((promptTokens - cachedTokens) / 1_000_000) * 0.4 +
      (cachedTokens / 1_000_000) * 0.1 +
      (completionTokens / 1_000_000) * 1.6;

    const cachedPromptTokens = tokenStats.totalCachedTokens;
    const costUsd = estimateCost(
      tokenStats.totalPromptTokens,
      cachedPromptTokens,
      tokenStats.totalCompletionTokens,
    );
    // Cost of the text-only second-pass classification calls (subset of total).
    const classifyCostUsd = estimateCost(
      tokenStats.classifyPromptTokens,
      tokenStats.classifyCachedTokens,
      tokenStats.classifyCompletionTokens,
    );
    console.log(`[tokens] ===== SUMMARY =====`);
    console.log(
      `[tokens] Prompt tokens total:     ${tokenStats.totalPromptTokens} (cached ${cachedPromptTokens})`,
    );
    console.log(
      `[tokens] Completion tokens total: ${tokenStats.totalCompletionTokens}`,
    );
    console.log(`[tokens] Grand total:             ${totalTokens}`);
    console.log(
      `[tokens] Classification pass:     prompt=${tokenStats.classifyPromptTokens} (cached ${tokenStats.classifyCachedTokens}) compl=${tokenStats.classifyCompletionTokens} → $${classifyCostUsd.toFixed(4)}`,
    );
    console.log(
      `[tokens] Est. total cost (USD):   $${costUsd.toFixed(4)} (all-in: vision prompt incl. images + completion + classification pass)`,
    );
    console.log(
      `[tokens] knownProducts chars:     ${knownProductsPrompt.length} ≈ ${Math.round(knownProductsPrompt.length / 4)} est. tokens`,
    );

    const result: Record<string, unknown> = {
      meta,
      items: pricedItems,
      detectedShop: detectedShop ?? null,
      detectedCountry: detectedCountry ?? null,
      coverageWarnings,
      tokenStats: {
        promptTokens: tokenStats.totalPromptTokens,
        cachedPromptTokens: tokenStats.totalCachedTokens,
        completionTokens: tokenStats.totalCompletionTokens,
        totalTokens,
        estimatedCostUsd: parseFloat(costUsd.toFixed(4)),
        classificationPass: {
          promptTokens: tokenStats.classifyPromptTokens,
          cachedPromptTokens: tokenStats.classifyCachedTokens,
          completionTokens: tokenStats.classifyCompletionTokens,
          estimatedCostUsd: parseFloat(classifyCostUsd.toFixed(4)),
        },
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
