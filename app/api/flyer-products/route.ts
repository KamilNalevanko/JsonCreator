import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  calculateUnitPrice,
  normalizeNameKey,
  normalizePrice,
  normalizeSkDate,
} from "../../../lib/normalize";

// ---------------------------------------------------------------------------
// Produkty tak, ako ich reálne vidí appka — teda z PUBLIKOVANÝCH letákov
// (`databazy/{country}/{shop}_N.json`), nie z tabuľky master_products_v2.
//
//  GET    /api/flyer-products?country=sk&shop=tesco-hypermarket
//  PATCH  /api/flyer-products   → prepíše JEDEN záznam v JEDNOM slote
//  DELETE /api/flyer-products   → zmaže JEDEN záznam z JEDNÉHO slotu
//
// Prečo to existuje: editor hľadá v databáze, kde je na (obchod + názov) len
// JEDEN riadok. Leták si ale drží týždenný snímok, takže v ňom bežne visia
// záznamy, ku ktorým sa cez databázu nedá dostať — staršie týždne aj druhá
// veľkosť toho istého produktu. Bez tohto API sa taký záznam nedá nájsť,
// opraviť ani zmazať, hoci ho appka zobrazuje.
//
// Zapisuje sa LEN do letáka. Do master_products_v2 to zámerne nesiaha —
// tam je na názov jediný riadok s hodnotami z posledného importu a prepísať
// ho starším týždňom by pokazilo dáta, ktoré sú v poriadku.
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
  // Akcia len s vernostnou kartou / aplikáciou obchodu — appka pri nej ukáže
  // odznak a ponúkne kartu.
  requiresCard: boolean;
  inDb: boolean;
};

const str = (value: unknown) => (value == null ? "" : String(value));
const isTrue = (value: unknown) =>
  value === true || ["true", "áno", "ano", "1"].includes(str(value).trim().toLowerCase());

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

/** Stiahne slot ako JSON. Ide cez REST s náhodným parametrom v adrese, nie
 *  cez `storage.download()` — to totiž vracia obsah z CDN cache a hneď po
 *  zápise by sme čítali starú verziu. Prakticky to znamenalo, že po uložení
 *  ukázal editor pôvodnú cenu a ďalšia úprava skončila na „produkt sa
 *  v slote nenašiel". */
async function downloadJson(path: string): Promise<unknown | null> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  const url = `${base}/storage/v1/object/${BUCKET}/${path}?cb=${Date.now()}-${Math.random()}`;
  try {
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
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

/** Nájde (alebo vytvorí) pole Produkty pre cieľové zaradenie v hierarchii
 *  letáka. Slúži na presun produktu do iného zaradenia. */
function ensurePlacementProducts(
  flyer: unknown,
  categoryKey: string,
  subcategoryKey: string,
  placementKey: string,
): FlyerProduct[] | null {
  if (!Array.isArray(flyer)) return null;
  let category = flyer.find((c) => str(c?.["Kategória"]) === categoryKey);
  if (!category) {
    category = { "Kategória": categoryKey, "Podkategórie": [] };
    flyer.push(category);
  }
  if (!Array.isArray(category["Podkategórie"])) category["Podkategórie"] = [];
  let sub = category["Podkategórie"].find(
    (s: FlyerProduct) => str(s?.["Podkategória"]) === subcategoryKey,
  );
  if (!sub) {
    sub = { "Podkategória": subcategoryKey, "Zaradenia": [] };
    category["Podkategórie"].push(sub);
  }
  if (!Array.isArray(sub["Zaradenia"])) sub["Zaradenia"] = [];
  let plc = sub["Zaradenia"].find(
    (z: FlyerProduct) => str(z?.["Zaradenie"]) === placementKey,
  );
  if (!plc) {
    plc = { "Zaradenie": placementKey, "Produkty": [] };
    sub["Zaradenia"].push(plc);
  }
  if (!Array.isArray(plc["Produkty"])) plc["Produkty"] = [];
  return plc["Produkty"] as FlyerProduct[];
}

/** Po zápise do slotu treba zdvihnúť verziu indexu, inak si appky ďalej
 *  čítajú starý obsah z diskovej cache a zmenu nikdy neuvidia. */
async function bumpIndexVersion(
  supabase: SupabaseClient,
  basePath: string,
  fileBase: string,
): Promise<string | null> {
  const indexPath = `${basePath}/_indexes/${fileBase}.json`;
  const loaded = await downloadJson(indexPath);
  if (!loaded || typeof loaded !== "object") return null;
  const index = loaded as Record<string, unknown>;
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
    const flyer = await downloadJson(`${basePath}/${file}`);
    if (flyer === null) {
      warnings.push(`${file}: stiahnutie zlyhalo alebo nečitateľný JSON`);
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
        requiresCard: isTrue(product["Vyžaduje kartu"]),
        inDb: dbRecords.has(
          recordKey(normalizeNameKey(name), amount, unit, priceSale, dateFrom),
        ),
      });
    });
  }

  return NextResponse.json({ ok: true, shop, country, slots: files, items, warnings });
}


// --- Zápis do slotu -------------------------------------------------------
// DELETE aj PATCH robia to isté dokola: overiť vstup, stiahnuť slot, nájsť
// PRESNE ten jeden záznam, zapísať a zdvihnúť verziu indexu. Preto je to tu
// raz a handlery dodajú len to, čo sa má so záznamom stať.

type SlotTarget = {
  name?: string;
  amount?: string;
  unit?: string;
  priceSale?: string;
  dateFrom?: string;
  dateTo?: string;
};

type SlotMutation =
  | { kind: "delete" }
  | {
      kind: "update";
      patch: Record<string, string | boolean>;
      // Ak je zadané a líši sa od súčasného umiestnenia, produkt sa presunie
      // do iného zaradenia v hierarchii letáka.
      move?: { category: string; subcategory: string; placement: string };
    };

async function mutateSlotRecord(
  body: Record<string, unknown>,
  mutation: SlotMutation,
) {
  const country = str(body?.country).toLowerCase().trim();
  const shop = str(body?.shop).trim();
  const slot = str(body?.slot).trim();
  const target = body?.product as SlotTarget | undefined;

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
  const flyer = await downloadJson(path);
  if (flyer === null) {
    return NextResponse.json(
      { ok: false, error: "Slot sa nepodarilo stiahnuť alebo nie je platný JSON." },
      { status: 500 },
    );
  }

  // Presná zhoda vrátane množstva, ceny a dátumov — ten istý názov má bežne
  // viac variantov (veľkosť M/L) a zasahovať sa smie len do vybraného.
  const targetKey = normalizeNameKey(target.name);
  const same = (a: string, b: string) => a.trim() === b.trim();

  // Najprv nájdeme všetky zhody (nemutujeme počas prechodu — pri presune totiž
  // potrebujeme siahať do inej vetvy hierarchie).
  const found: { product: FlyerProduct; siblings: FlyerProduct[] }[] = [];
  walkProducts(flyer, (product, siblings) => {
    if (normalizeNameKey(str(product["Názov"])) !== targetKey) return;
    if (!same(str(product["Množstvo"]), str(target.amount ?? ""))) return;
    if (!same(str(product["Merná jednotka"]), str(target.unit ?? ""))) return;
    if (!same(str(product["Akciová cena"]), str(target.priceSale ?? ""))) return;
    if (!same(str(product["Dátum akcie od"]), str(target.dateFrom ?? ""))) return;
    if (!same(str(product["Dátum akcie do"]), str(target.dateTo ?? ""))) return;
    found.push({ product, siblings });
  });

  const touched = found.length;

  for (const { product, siblings } of found) {
    if (mutation.kind === "delete") {
      const i = siblings.indexOf(product);
      if (i >= 0) siblings.splice(i, 1);
      continue;
    }
    // update
    Object.assign(product, mutation.patch);
    if (mutation.move) {
      const dest = ensurePlacementProducts(
        flyer,
        mutation.move.category,
        mutation.move.subcategory,
        mutation.move.placement,
      );
      // Presun len ak cieľ existuje a je to iné pole než súčasné.
      if (dest && dest !== siblings) {
        const i = siblings.indexOf(product);
        if (i >= 0) siblings.splice(i, 1);
        dest.push(product);
      }
    }
  }

  if (touched === 0) {
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
    touched,
    slot,
    version,
    warning: version
      ? null
      : "Verziu indexu sa nepodarilo zdvihnúť — appky môžu ešte chvíľu ukazovať starý obsah.",
  });
}

export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({}));
  return mutateSlotRecord(body, { kind: "delete" });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  const changes = body?.changes as Record<string, string | boolean> | undefined;

  if (!changes || typeof changes !== "object") {
    return NextResponse.json({ ok: false, error: "Chýbajú zmeny." }, { status: 400 });
  }

  const name = str(changes.name).trim();
  if (!name) {
    return NextResponse.json({ ok: false, error: "Názov nesmie byť prázdny." }, { status: 400 });
  }

  // Ceny a dátumy do rovnakého tvaru, v akom ich píše import — appka inak
  // mieša „0.45" s „0,45" a dátumy si nevie prečítať.
  const amount = str(changes.amount).trim();
  const unit = str(changes.unit).trim();
  const priceRegular = normalizePrice(changes.priceRegular ?? "");
  const priceSale = normalizePrice(changes.priceSale ?? "");

  const patch: Record<string, string | boolean> = {
    "Názov": name,
    "Množstvo": amount,
    "Merná jednotka": unit,
    "Bežná cena za bal.": priceRegular,
    // Jednotkové ceny sa neprepisujú ručne — vždy sa dopočítajú, aby
    // nemohlo vzniknúť niečo ako 20 ks za 1,48 € = 0,07 €/ks.
    "Bežná jednotková cena": calculateUnitPrice(priceRegular, amount, unit),
    "Akciová cena": priceSale,
    "Akciová jednotková cena": calculateUnitPrice(priceSale, amount, unit),
    "Doplnková Informácia": str(changes.info).trim(),
    "Dátum akcie od": normalizeSkDate(changes.dateFrom ?? ""),
    "Dátum akcie do": normalizeSkDate(changes.dateTo ?? ""),
  };

  // „Len s kartou" — ukladáme ako skutočný boolean, appka ho číta priamo.
  if (changes.requiresCard !== undefined) {
    patch["Vyžaduje kartu"] = isTrue(changes.requiresCard);
  }

  // Zaradenie meníme len ak sú zadané všetky tri kľúče — inak by sme produkt
  // hodili do prázdna. Vtedy sa prepíšu aj polia a produkt sa presunie.
  const category = str(changes.category).trim();
  const subcategory = str(changes.subcategory).trim();
  const placement = str(changes.placement).trim();
  let move: { category: string; subcategory: string; placement: string } | undefined;
  if (category && subcategory && placement) {
    patch["Kategória"] = category;
    patch["Podkategória"] = subcategory;
    patch["Zaradenie"] = placement;
    move = { category, subcategory, placement };
  }

  return mutateSlotRecord(body, { kind: "update", patch, move });
}
