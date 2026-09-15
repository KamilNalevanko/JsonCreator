import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeNameKey } from "../../../lib/normalize";

// ---------------------------------------------------------------------------
// Produkty tak, ako ich reálne vidí appka — teda z PUBLIKOVANÝCH letákov
// (`databazy/{country}/{shop}_N.json`), nie z tabuľky master_products_v2.
//
//  GET    /api/flyer-products?country=sk&shop=tesco-hypermarket
//  DELETE /api/flyer-products   → zmaže JEDEN záznam z JEDNÉHO slotu
//
// Prečo to existuje: editor hľadá v databáze, kde je na (obchod + názov) len
// JEDEN riadok. Leták si ale drží týždenný snímok, takže v ňom bežne visia
// záznamy, ku ktorým sa cez databázu nedá dostať — staršie týždne aj druhá
// veľkosť toho istého produktu. Bez tohto API sa taký záznam nedá nájsť
// ani zmazať, hoci ho appka zobrazuje.
// ---------------------------------------------------------------------------

const BUCKET = "cap-data";
const COUNTRIES = ["sk", "cz", "pl"];

type FlyerProduct = Record<string, unknown>;

type FlyerHit = {
  slot: string;
  name: string;
  category: string;
  subcategory: string;
  placement: string;
  amount: string;
  unit: string;
  priceRegular: string;
  priceSale: string;
  priceSaleUnit: string;
  info: string;
  dateFrom: string;
  dateTo: string;
  inDb: boolean;
};

const str = (value: unknown) => (value == null ? "" : String(value));

// Rovnaký sanitizer ako v rotating-upload / delete — inak by sme siahali inam.
const sanitizeBase = (value: string) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "letak";

function supabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Názvy slotov obchodu (`shop.json` aj `shop_N.json`), zoradené podľa čísla. */
async function slotFiles(
  supabase: SupabaseClient,
  basePath: string,
  fileBase: string,
): Promise<string[]> {
  const listed = await supabase.storage
    .from(BUCKET)
    .list(basePath, { limit: 1000 });
  if (listed.error || !listed.data) return [];
  const escaped = fileBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`^${escaped}(_\\d{1,2})?\\.json$`);
  return listed.data
    .map((f) => f?.name || "")
    .filter((name) => rx.test(name))
    .sort((a, b) => {
      const num = (n: string) => Number(n.match(/_(\d{1,2})\.json$/)?.[1] ?? 0);
      return num(a) - num(b);
    });
}

/** Prejde hierarchiu letáka a zavolá `fn` nad každým produktom.
 *  Ide odzadu, takže sa smie mazať priamo v callbacku. */
function walkProducts(
  flyer: unknown,
  fn: (product: FlyerProduct, siblings: FlyerProduct[], index: number) => void,
) {
  if (!Array.isArray(flyer)) return;
  for (const category of flyer) {
    const subs = (category?.["Podkategórie"] ?? []) as FlyerProduct[];
    if (!Array.isArray(subs)) continue;
    for (const sub of subs) {
      const placements = (sub?.["Zaradenia"] ?? []) as FlyerProduct[];
      if (!Array.isArray(placements)) continue;
      for (const plc of placements) {
        const products = plc?.["Produkty"];
        if (!Array.isArray(products)) continue;
        for (let i = products.length - 1; i >= 0; i--) {
          fn(products[i], products, i);
        }
      }
    }
  }
}

/** Po zápise do slotu treba zdvihnúť verziu indexu, inak si appky ďalej
 *  čítajú starý obsah z diskovej cache a zmenu nikdy neuvidia. */
async function bumpIndexVersion(
  supabase: SupabaseClient,
  basePath: string,
  fileBase: string,
): Promise<string | null> {
  const indexPath = `${basePath}/_indexes/${fileBase}.json`;
  const dl = await supabase.storage.from(BUCKET).download(indexPath);
  if (dl.error || !dl.data) return null;
  let index: Record<string, unknown>;
  try {
    index = JSON.parse(await dl.data.text());
  } catch {
    return null;
  }
  const version = new Date().toISOString();
  index.version = version;
  const up = await supabase.storage
    .from(BUCKET)
    .upload(indexPath, JSON.stringify(index, null, 2), {
      contentType: "application/json",
      upsert: true,
      cacheControl: "0",
    });
  return up.error ? null : version;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const country = (searchParams.get("country") || "").toLowerCase().trim();
  const shop = (searchParams.get("shop") || "").trim();

  if (!COUNTRIES.includes(country)) {
    return NextResponse.json({ ok: false, error: "Neplatná krajina." }, { status: 400 });
  }
  if (!shop) {
    return NextResponse.json({ ok: false, error: "Chýba obchod." }, { status: 400 });
  }

  const supabase = supabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Chýba SUPABASE konfigurácia." },
      { status: 500 },
    );
  }

  const basePath = `databazy/${country}`;
  const fileBase = sanitizeBase(shop);
  const files = await slotFiles(supabase, basePath, fileBase);
  const warnings: string[] = [];

  // Záznamy z databázy — aby sa dalo označiť, čo sa cez editor NEDÁ nájsť.
  //
  // Porovnáva sa celý záznam (názov + množstvo + cena + začiatok akcie), nie
  // len názov. Na (obchod + názov) je v databáze totiž vždy len JEDEN riadok
  // s poslednými hodnotami, takže samotný názov sedí skoro vždy a nič by to
  // nepovedalo. Rozdiel v cene či dátume ale znamená, že presne tento záznam
  // z letáka v databáze nie je — a teda sa cez ňu nedá ani opraviť.
  //
  // Po stránkach: jeden obchod má bežne niekoľko tisíc riadkov a Supabase
  // vracia naraz najviac 1000.
  const recordKey = (
    nameKey: string,
    amount: string,
    unit: string,
    priceSale: string,
    dateFrom: string,
  ) => [nameKey, amount.trim(), unit.trim().toLowerCase(), priceSale.trim(), dateFrom.trim()].join("|");

  const dbRecords = new Set<string>();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const dbRes = await supabase
      .from("master_products_v2")
      .select("name_key,amount,unit,price_sale,date_from")
      .eq("country", country)
      .eq("shop", shop)
      .range(offset, offset + pageSize - 1);
    if (dbRes.error) {
      warnings.push(`Databázu sa nepodarilo prečítať: ${dbRes.error.message}`);
      break;
    }
    const rows = dbRes.data ?? [];
    for (const row of rows) {
      dbRecords.add(
        recordKey(
          str(row.name_key),
          str(row.amount),
          str(row.unit),
          str(row.price_sale),
          str(row.date_from),
        ),
      );
    }
    if (rows.length < pageSize) break;
  }

  const items: FlyerHit[] = [];

  for (const file of files) {
    const dl = await supabase.storage.from(BUCKET).download(`${basePath}/${file}`);
    if (dl.error || !dl.data) {
      warnings.push(`${file}: stiahnutie zlyhalo`);
      continue;
    }
    let flyer: unknown;
    try {
      flyer = JSON.parse(await dl.data.text());
    } catch {
      warnings.push(`${file}: nečitateľný JSON`);
      continue;
    }
    walkProducts(flyer, (product) => {
      const name = str(product["Názov"]);
      if (!name) return;
      const amount = str(product["Množstvo"]);
      const unit = str(product["Merná jednotka"]);
      const priceSale = str(product["Akciová cena"]);
      const dateFrom = str(product["Dátum akcie od"]);
      items.push({
        slot: file,
        name,
        category: str(product["Kategória"]),
        subcategory: str(product["Podkategória"]),
        placement: str(product["Zaradenie"]),
        amount,
        unit,
        priceRegular: str(product["Bežná cena za bal."]),
        priceSale,
        priceSaleUnit: str(product["Akciová jednotková cena"]),
        info: str(product["Doplnková Informácia"]),
        dateFrom,
        dateTo: str(product["Dátum akcie do"]),
        inDb: dbRecords.has(
          recordKey(normalizeNameKey(name), amount, unit, priceSale, dateFrom),
        ),
      });
    });
  }

  return NextResponse.json({ ok: true, shop, country, slots: files, items, warnings });
}

export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({}));
  const country = str(body?.country).toLowerCase().trim();
  const shop = str(body?.shop).trim();
  const slot = str(body?.slot).trim();
  const target = body?.product as Record<string, string> | undefined;

  if (!COUNTRIES.includes(country)) {
    return NextResponse.json({ ok: false, error: "Neplatná krajina." }, { status: 400 });
  }
  if (!shop || !slot || !target?.name) {
    return NextResponse.json(
      { ok: false, error: "Chýba obchod, slot alebo produkt." },
      { status: 400 },
    );
  }

  const supabase = supabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Chýba SUPABASE konfigurácia." },
      { status: 500 },
    );
  }

  const basePath = `databazy/${country}`;
  const fileBase = sanitizeBase(shop);

  // Slot musí patriť tomuto obchodu — inak by sa dalo zapísať kamkoľvek.
  const allowed = await slotFiles(supabase, basePath, fileBase);
  if (!allowed.includes(slot)) {
    return NextResponse.json(
      { ok: false, error: `Slot ${slot} k obchodu ${shop} nepatrí.` },
      { status: 400 },
    );
  }

  const path = `${basePath}/${slot}`;
  const dl = await supabase.storage.from(BUCKET).download(path);
  if (dl.error || !dl.data) {
    return NextResponse.json(
      { ok: false, error: "Slot sa nepodarilo stiahnuť." },
      { status: 500 },
    );
  }

  let flyer: unknown;
  try {
    flyer = JSON.parse(await dl.data.text());
  } catch {
    return NextResponse.json({ ok: false, error: "Slot nie je platný JSON." }, { status: 500 });
  }

  // Presná zhoda vrátane množstva, ceny a dátumov — ten istý názov má bežne
  // viac variantov (veľkosť M/L) a zmazať sa smie len ten vybraný.
  const targetKey = normalizeNameKey(target.name);
  const same = (a: string, b: string) => a.trim() === b.trim();
  let removed = 0;

  walkProducts(flyer, (product, siblings, index) => {
    if (normalizeNameKey(str(product["Názov"])) !== targetKey) return;
    if (!same(str(product["Množstvo"]), str(target.amount ?? ""))) return;
    if (!same(str(product["Merná jednotka"]), str(target.unit ?? ""))) return;
    if (!same(str(product["Akciová cena"]), str(target.priceSale ?? ""))) return;
    if (!same(str(product["Dátum akcie od"]), str(target.dateFrom ?? ""))) return;
    if (!same(str(product["Dátum akcie do"]), str(target.dateTo ?? ""))) return;
    siblings.splice(index, 1);
    removed += 1;
  });

  if (removed === 0) {
    return NextResponse.json(
      { ok: false, error: "Produkt sa v slote nenašiel — leták sa medzitým mohol zmeniť." },
      { status: 404 },
    );
  }

  const up = await supabase.storage
    .from(BUCKET)
    .upload(path, JSON.stringify(flyer, null, 2), {
      contentType: "application/json",
      upsert: true,
      cacheControl: "0",
    });
  if (up.error) {
    return NextResponse.json(
      { ok: false, error: `Zápis slotu zlyhal: ${up.error.message}` },
      { status: 500 },
    );
  }

  const version = await bumpIndexVersion(supabase, basePath, fileBase);

  return NextResponse.json({
    ok: true,
    removed,
    slot,
    version,
    warning: version
      ? null
      : "Verziu indexu sa nepodarilo zdvihnúť — appky môžu ešte chvíľu ukazovať starý obsah.",
  });
}
