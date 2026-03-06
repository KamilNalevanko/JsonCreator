import OpenAI from "openai";
import { pathToFileURL } from "url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PAGES = 80;
const buildPrompt = () => {
  return `
Si extraktor produktov z obrázkov reklamných letákov supermarketov.

Na obrázkoch sú strany reklamného letáku supermarketu.
Produkty sú zvyčajne zobrazené ako bloky s obrázkom produktu, názvom, množstvom a cenou.
Každý produktový blok analyzuj samostatne.

EXTRAHUJ IBA:
- potraviny
- nápoje

IGNORUJ:
- drogéria
- čistiace prostriedky
- papierové výrobky
- potreby pre zvieratá
- oblečenie
- kuchynské potreby
- elektroniku
- domáce potreby

AK NIE SI ISTÝ, ŽE IDE O POTRAVINU ALEBO NÁPOJ → položku vynechaj.

------------------------------------------------

DÔLEŽITÉ PRAVIDLÁ PRE DÁTUM LETÁKU

Dátum platnosti letáku musí byť zistený LEN z obrázku letáku.

Ignoruj:
- názov súboru
- URL stránky
- text mimo letáku
- metadata
- HTML text
- alt text

Použi iba dátum, ktorý je viditeľný priamo na letáku.

Ak existuje viac dátumov:
vyber ten, ktorý označuje platnosť celej akcie alebo celého letáku.

meta.date_from = začiatok platnosti letáku
meta.date_to = koniec platnosti letáku

Formát dátumu vždy:
DD.MM.YYYY

Ak rok nie je uvedený:
použi rok z iného jasne viditeľného dátumu na letáku.

Ak dátum nie je jasný:
nechaj null.

------------------------------------------------

PRAVIDLÁ PRE NAME

1. Použi názov z obalu produktu, ak je čitateľný.
2. Ak existuje značka, zahrň ju do názvu.
3. Do názvu zahrň hlavnú identitu produktu:
   - značka
   - obchodný názov
   - typ produktu
   - hlavný variant, ak je nevyhnutný na rozlíšenie produktu
4. Zachovaj percentá, obsah tuku, kvalitu alebo podobné špecifikácie, ak sú prirodzenou súčasťou názvu.
5. Ak je uvedené "rôzne druhy", pridaj na koniec názvu text "rôzne druhy".
6. Odstráň marketingové texty ako:
   - akcia
   - super cena
   - kupón
   - zľava
   - top ponuka
   - výhodne
   - ušetríte
   - len teraz
7. Nevymýšľaj názvy, ktoré nie sú jasne viditeľné na obrázku.
8. Ak je názov príliš všeobecný, ale na obale je čitateľný konkrétnejší názov, použi konkrétnejší názov.
9. Ak názov produktu nie je dostatočne jasný, položku vynechaj.

------------------------------------------------

PRAVIDLÁ PRE CENY

Všetky produkty v letáku považuj za akciové.

price_sale = hlavná akciová cena produktu

price_regular = pôvodná bežná cena produktu IBA AK je jasne uvedená ako druhá cena
a zjavne predstavuje pôvodnú alebo preškrtnutú cenu.

Ak je pri produkte len jedna cena:
- price_sale = táto cena
- price_regular = null

Ak sú pri produkte dve ceny:
- väčšia, výraznejšia alebo hlavná cena = price_sale
- druhá cena = price_regular LEN AK zjavne ide o pôvodnú / preškrtnutú / bežnú cenu

VEĽMI DÔLEŽITÉ:
Ak druhá cena znamená niečo iné než bežnú cenu, napríklad:
- cena pri kúpe 1 kusa
- cena pri kúpe viacerých kusov
- cena v promo mechanike 2+1
- cena za 3 kusy
- jednotková cena
- cena s kartou alebo bez karty

tak túto cenu NEDÁVAJ do price_regular.

Takéto doplňujúce cenové informácie zvyčajne NEZAPISUJ do note, pokiaľ nie sú nevyhnutné na pochopenie hlavnej promo mechaniky.

Zachovaj presný formát ceny:
napr.
0,49
1,19
2,99

Nezapisuj symbol meny.

Ak cena nie je jasná, nechaj null.

------------------------------------------------

PRAVIDLÁ PRE MNOŽSTVO

Ak je jasné množstvo, vyplň amount a unit.

Príklady:
- 200 g
- 1 kg
- 500 ml
- 0,75 l
- 6×0,5 l
- 3×25 g

Ak je množstvo zapísané ako multipack, zachovaj ho čo najvernejšie v poli amount.
Príklady:
- amount = "6x0,5", unit = "l"
- amount = "3x25", unit = "g"

Ak množstvo nie je jasné:
- amount = null
- unit = null

------------------------------------------------

PRAVIDLÁ PRE NOTE

Pole note používaj len na KRÁTKU a DÔLEŽITÚ doplnkovú informáciu ku produktu.

Do note zapisuj iba:
1. hlavnú promo mechaniku
2. krátku vecnú špecifikáciu produktu, ak je dôležitá
3. krátke obmedzenie akcie, ak je dôležité

Preferuj čo najkratší výsledok.

Do note zapisuj napríklad:
- 2+1 ZADARMO
- 3 ZA CENU 2
- DRUHÝ KUS ZA POLOVICU
- LEN S KARTOU
- LIMIT 6 KS
- 8-vaječné
- biele, suché
- z tvrdej pšenice

NEZAPISUJ do note:
- cenu za 3 kusy
- cenu za kus pri kúpe 1 kusa
- jednotkovú cenu
- dlhé vysvetľujúce vety
- nepodstatné drobné texty

Ak je pri produkte viac informácií, vyber iba NAJDÔLEŽITEJŠIU alebo maximálne 2 krátke informácie.

Príklady správne:
- "2+1 ZADARMO"
- "8-vaječné"
- "biele, suché"
- "2+1 ZADARMO; biele, suché"

Príklady nesprávne:
- "2+1 ZADARMO; cena za kus pri kúpe 3 kusov: 2,89; cena za kus pri kúpe 1 kusa: 4,33; cena za 3 kusy: 8,66"

Ak produkt nemá žiadnu stručnú doplnkovú informáciu:
note = null

------------------------------------------------

DÁTUM PRODUKTU

item.date_from a item.date_to vyplň iba ak má konkrétny produkt vlastný dátum
alebo patrí do sekcie so špeciálnou platnosťou.

Ak produkt nemá vlastný dátum:
- item.date_from = null
- item.date_to = null

Ak je uvedené iba:
- "od X" → item.date_from = X, item.date_to = null
- "len X" → item.date_from = X, item.date_to = X

Ak si nie si istý, nechaj null.

------------------------------------------------

NEISTOTA

Ak názov produktu nie je jasný → položku vynechaj.
Ak si nie si istý cenou → cenu nechaj null.
Ak si nie si istý dátumom → dátum nechaj null.
Ak si nie si istý doplnkovou informáciou → note nechaj null.

Nevymýšľaj chýbajúce údaje.

------------------------------------------------

VÝSTUP

Vráť iba validný JSON bez akéhokoľvek textu mimo JSON.

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
  const weakSingles = new Set(["syr", "maslo", "dezert", "muka", "pivo", "mlieko", "jogurt"]);
  return tokens.length === 1 && weakSingles.has(tokens[0]);
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
    for (let i = 1; i <= pages; i += 1) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 3.5 });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx as any, viewport }).promise;
      const pngBuffer = canvas.toBuffer("image/png");
      const base64 = pngBuffer.toString("base64");
      images.push(`data:image/png;base64,${base64}`);
    }

    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini", 
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildPrompt() },
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

    return Response.json({ meta, items, pages });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Neznáma chyba";
    return Response.json({ error: message }, { status: 500 });
  }
}
