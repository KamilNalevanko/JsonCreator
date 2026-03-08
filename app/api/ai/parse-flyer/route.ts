import OpenAI from "openai";
import { pathToFileURL } from "url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PAGES = 3;
const buildPrompt = () => {
  return `
Si extraktor produktov z reklamných letákov supermarketov.

Na obrázkoch sú strany reklamného letáku supermarketu.
Produkty sú zvyčajne zobrazené ako bloky obsahujúce:
- obrázok produktu
- názov
- množstvo
- cenu

TVOJ CIEĽ
Vráť čo najviac produktov z letáku, ale iba ak ide o produkty určené na konzumáciu ľuďmi.

Je lepšie vrátiť produkt s neúplným názvom než produkt nevrátiť vôbec.
Ak si však nie si istý, či ide o potravinu alebo nápoj, radšej ho nevráť.

EXTRAHUJ IBA:
- potraviny
- nápoje
- všetko určené na konzumáciu ľuďmi

NIKDY NEEXTRAHUJ:
- kvety
- kytice
- dekorácie
- drogériu
- čistiace prostriedky
- papierové výrobky
- potreby pre zvieratá
- kuchynské potreby
- oblečenie
- elektroniku
- domáce potreby

------------------------------------------------

DÁTUM LETÁKU

Dátum platnosti musí byť zistený iba z letáku.

Ignoruj:
- názov súboru
- URL
- HTML
- metadata
- text mimo letáku

Ak existuje viac dátumov, vyber dátum platnosti celej akcie.

meta.date_from = začiatok
meta.date_to = koniec

Formát:
DD.MM.YYYY

Ak dátum nie je jasný → null.

------------------------------------------------

TVORBA NAME

NAME musí identifikovať produkt čo najpresnejšie.

PRAVIDLÁ PRI TVORBE NAME:

1. Textová vrstva PDF je iba pomocný zdroj pre názov produktu.
2. Vždy over názov podľa vizuálneho obsahu produktu na obrázku.
3. Obrázok produktu má prednosť pri určovaní značky a overení typu produktu.
4. Značku doplň z obalu produktu, ak je čitateľná.
5. Ak je značka jasne čitateľná na obale, MUSÍ byť v name.
6. Ak značka nie je jednoznačne čitateľná, nepridávaj ju.
7. Ak má produkt jasný názov obsahujúci variant alebo typ, použi ho.
8. Neber textovú vrstvu ako absolútne správnu, ak je v rozpore s obrázkom.

DO NAME NEPATRÍ:
- množstvo
- cena
- percento zľavy
- marketingové slogany
- doplnkové informácie, ktoré nie sú súčasťou názvu produktu

------------------------------------------------
CENY

price_sale = hlavná akciová cena.

price_regular použi iba ak ide o pôvodnú alebo preškrtnutú cenu.

Ak je len jedna cena:
price_sale = táto cena
price_regular = null

Percento zľavy (napr. -10 %, -20 %, -42 %):
- nie je cena
- nie je name
- nie je note

Ak cena nie je jasná:
price_sale = null
price_regular = null

Produkt kvôli tomu nevynechávaj.

------------------------------------------------

MNOŽSTVO

Ak je jasné množstvo, vyplň:

amount
unit

Príklady:
200 g
500 ml
1 kg
0,75 l

Multipack zapisuj napr:
6x0,5 l

Ak množstvo nie je jasné → null.

------------------------------------------------

NOTE

note obsahuje krátku dôležitú doplnkovú informáciu.

Do note patrí:
- vlastnosť produktu
- typ suroviny
- kvalita produktu
- chuťový variant
- promo mechanika, ak je priamo relevantná k produktu

Do note NEPATRÍ:
- percento zľavy
- reklamné slogany
- jednotková cena
- dlhé vety

------------------------------------------------

VÝSTUP

Vráť iba JSON.

{
  "meta": {
    "date_from": string|null,
    "date_to": string|null
  },
  "items": [
    {
      "name": string,
      "amount": string|null,
      "unit": string|null,
      "price_sale": string|null,
      "price_regular": string|null,
      "date_from": string|null,
      "date_to": string|null,
      "note": string|null
    }
  ]
}
`.trim();
};

const buildTextHint = (text: string) => {
  if (!text.trim()) return "";
  return `\n\nTEXTOVA VRSTVA Z PDF (iba pomocny zdroj, obrazok ma prednost):\n${text}\n`;
};
const normalizeKey = (value: string) =>
  (value || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const normalizeKeyTight = (value: string) =>
  normalizeKey(value).replace(/[^a-z0-9]+/g, "");

const normalizeTokens = (value: string) => {
  const normalized = normalizeKey(value)
    .replace(/[0-9]+([.,][0-9]+)?\s*%/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ");

  const rawTokens = normalized.split(/\s+/g).filter(Boolean);

  const stop = new Set(["kg", "g", "ml", "l", "ks", "bal", "pack", "pcs", "x", "alk"]);

  return Array.from(
    new Set(rawTokens.filter((token) => token.length > 2 && !stop.has(token) && !/^[0-9]+$/.test(token)))
  );
};

const ALLOWED_UNITS = new Set(["g", "kg", "ml", "l", "ks", "bal"]);

const normalizeUnit = (value: string) => {
  const v = normalizeKey(value);
  if (v === "kus" || v === "kusy") return "ks";
  if (v === "gram" || v === "gramov") return "g";
  if (v === "kilogram" || v === "kilogramy") return "kg";
  if (v === "mililiter" || v === "mililitrov") return "ml";
  if (v === "liter" || v === "litre") return "l";
  if (v === "balenie") return "bal";
  return ALLOWED_UNITS.has(v) ? v : "";
};

const normalizeAmount = (value: string) => (value || "").trim().replace(/\s+/g, "");

const normalizePrice = (value: string) => {
  const v = (value || "").trim().replace(/\s+/g, "");
  if (!v) return "";
  const match = v.match(/\d+[.,]\d{2}/);
  return match ? match[0] : "";
};

const normalizeDate = (value: string) => {
  const v = (value || "").trim();
  if (!v) return "";
  const match = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return match ? v : "";
};

const isWeakName = (name: string) => {
  const tokens = normalizeTokens(name);
  if (tokens.length >= 2) return false;
  const weakSingles = new Set([
    "syr",
    "maslo",
    "dezert",
    "muka",
    "pivo",
    "mlieko",
    "jogurt",
    "spagety",
    "kolienka",
    "penne",
    "cestoviny",
  ]);
  return tokens.length === 1 && weakSingles.has(tokens[0]);
};

const NON_FOOD_HINTS = [
  "kytica",
  "kvety",
  "ruza",
  "ruze",
  "tulipany",
  "orchidea",
  "dekoracia",
  "dekoracie",
  "sviecka",
  "sviecky",
  "sampon",
  "toaletny papier",
  "avivaz",
  "granule",
  "krmivo",
  "miskas",
  "misky",
  "hračka",
  "hracka",
];

const looksNonFood = (name: string, note: string) => {
  const hay = normalizeKey(`${name} ${note}`);
  return NON_FOOD_HINTS.some((token) => hay.includes(normalizeKey(token)));
};

const sanitizeExtractedItems = (items: unknown[]) => {
  return items
    .map((item) => {
      const obj = item as Record<string, unknown>;

      const name = typeof obj.name === "string" ? obj.name.trim().replace(/\s+/g, " ") : "";
      const amount = typeof obj.amount === "string" && obj.amount.trim() ? normalizeAmount(obj.amount) : "";
      const rawUnit = typeof obj.unit === "string" && obj.unit.trim() ? obj.unit.trim() : "";
      const note = typeof obj.note === "string" && obj.note.trim() ? obj.note.trim().replace(/\s+/g, " ") : "";
      const priceSale = typeof obj.price_sale === "string" ? normalizePrice(obj.price_sale) : "";
      const priceRegular = typeof obj.price_regular === "string" ? normalizePrice(obj.price_regular) : "";
      const dateFrom = typeof obj.date_from === "string" ? normalizeDate(obj.date_from) : "";
      const dateTo = typeof obj.date_to === "string" ? normalizeDate(obj.date_to) : "";
      const unit = normalizeUnit(rawUnit);

      if (!name) return null;
      if (isWeakName(name)) return null;
      if (looksNonFood(name, note)) return null;

      return {
        name,
        amount,
        unit,
        price_sale: priceSale,
        price_regular: priceRegular,
        date_from: dateFrom,
        date_to: dateTo,
        note,
      };
    })
    .filter(Boolean) as Array<{
      name: string;
      amount: string;
      unit: string;
      price_sale: string;
      price_regular: string;
      date_from: string;
      date_to: string;
      note: string;
    }>;
};

const dedupeItems = <
  T extends {
    name: string;
    amount?: string;
    unit?: string;
    price_sale?: string;
    price_regular?: string;
    date_from?: string;
    date_to?: string;
  }
>(
  items: T[]
) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [
      normalizeKeyTight(item.name),
      item.amount || "",
      item.unit || "",
      item.price_sale || "",
      item.price_regular || "",
      item.date_from || "",
      item.date_to || "",
    ].join("|");

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return Response.json({ error: "Chýba OPENAI_API_KEY v prostredí." }, { status: 500 });
    }

    const form = await req.formData();
    const file = form.get("file");
    const debug = (form.get("debug") || "").toString() === "1";
    if (!file || !(file instanceof File)) {
      return Response.json({ error: "Chýba PDF súbor." }, { status: 400 });
    }

    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const requireAny = eval("require") as any;
    const { createCanvas } = requireAny("@napi-rs/canvas");

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

    const doc = await pdfjs.getDocument({ data: buffer, disableWorker: true }).promise;
    const pages = Math.min(doc.numPages, MAX_PAGES);

    const images: string[] = [];
    const pageTexts: string[] = [];
    for (let i = 1; i <= pages; i += 1) {
      const page = await doc.getPage(i);
      try {
        const textContent = await page.getTextContent();
        const textItems = (textContent?.items || []) as Array<{ str?: string }>;
        const text = textItems
          .map((item) => (item?.str || "").toString().trim())
          .filter(Boolean)
          .join(" ");
        pageTexts.push(text);
      } catch {
        pageTexts.push("");
      }
    }

    const combinedText = pageTexts.filter(Boolean).join("\n\n");
    const useImages = combinedText.trim().length < 200;

    if (useImages) {
      for (let i = 1; i <= pages; i += 1) {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 4 });
        const canvas = createCanvas(viewport.width, viewport.height);
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx as any, viewport }).promise;
        const pngBuffer = canvas.toBuffer("image/png");
        const base64 = pngBuffer.toString("base64");
        images.push(`data:image/png;base64,${base64}`);
      }
    }

    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: "gpt-4.1", 
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildPrompt() + buildTextHint(combinedText) },
            ...images.map((url) => ({
              type: "image_url",
              image_url: { url },
            })),
          ] as any,
        },
      ],
    } as any);

    const text = response.choices?.[0]?.message?.content?.trim() ?? "";

    let parsed: { meta?: unknown; items?: unknown } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        parsed = JSON.parse(text.slice(start, end + 1));
      } else {
        return Response.json({ error: "AI nevrátil validný JSON.", raw: text }, { status: 500 });
      }
    }

    const rawMeta =
      parsed.meta && typeof parsed.meta === "object"
        ? (parsed.meta as Record<string, unknown>)
        : {};

    const meta = {
      date_from:
        typeof rawMeta.date_from === "string" ? normalizeDate(rawMeta.date_from) : "",
      date_to:
        typeof rawMeta.date_to === "string" ? normalizeDate(rawMeta.date_to) : "",
    };

    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    const items = dedupeItems(sanitizeExtractedItems(rawItems)).map((item) => ({
      ...item,
      date_from: item.date_from || meta.date_from || "",
      date_to: item.date_to || meta.date_to || "",
    }));

    return Response.json({ meta, items, pages, debugText: debug ? combinedText : undefined });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Neznáma chyba";
    return Response.json({ error: message }, { status: 500 });
  }
}
