import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  normalizeNameKey,
  normalizePrice,
  calculateUnitPrice,
} from "../../../../lib/normalize";
import { bumpIndexVersionsForFiles } from "../../_lib/slot-index";

// Uloží KOMPLETNÚ sadu akcií (promo inštancií) jedného produktu do letákov.
// Rieši pridanie / úpravu / zmazanie naraz jednoduchým princípom "replace":
//  1) odstráni VŠETKY inštancie produktu (podľa názvu + gramáž + jednotka) zo
//     všetkých slotov obchodu,
//  2) pridá zadané akcie do jedného cieľového slotu (najnovší podľa dátumu),
//  3) upsertne jeden reprezentatívny riadok do DB (unikát na názov).
// Nikdy sa nedotkne iných produktov.

type PromoIn = {
  date_from?: string;
  date_to?: string;
  price_sale?: string;
  price_regular?: string;
  note?: string;
  amount?: string;
  unit?: string;
  categoryKey?: string;
  subcategoryKey?: string;
  placementKey?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FlyerNode = Record<string, any>;

const sanitizeBase = (value: string) =>
  (value || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "letak";
const normAmount = (v: unknown) =>
  String(v ?? "").toLowerCase().replace(/,/g, ".").replace(/\s+/g, " ").trim();
const ymd = (s: string) => {
  const m = String(s || "").match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  return m ? +m[3] * 10000 + +m[2] * 100 + +m[1] : 0;
};

function ensurePlacementProducts(
  flyer: FlyerNode[],
  catKey: string,
  subKey: string,
  plcKey: string,
): FlyerNode[] {
  let cat = flyer.find((c) => c?.["Kategória"] === catKey);
  if (!cat) {
    cat = { "Kategória": catKey, "Podkategórie": [] };
    flyer.push(cat);
  }
  if (!Array.isArray(cat["Podkategórie"])) cat["Podkategórie"] = [];
  let sub = cat["Podkategórie"].find((s: FlyerNode) => s?.["Podkategória"] === subKey);
  if (!sub) {
    sub = { "Podkategória": subKey, "Zaradenia": [] };
    cat["Podkategórie"].push(sub);
  }
  if (!Array.isArray(sub["Zaradenia"])) sub["Zaradenia"] = [];
  let plc = sub["Zaradenia"].find((z: FlyerNode) => z?.["Zaradenie"] === plcKey);
  if (!plc) {
    plc = { "Zaradenie": plcKey, "Produkty": [] };
    sub["Zaradenia"].push(plc);
  }
  if (!Array.isArray(plc["Produkty"])) plc["Produkty"] = [];
  return plc["Produkty"];
}

export async function POST(req: Request) {
  try {
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRole) {
      return NextResponse.json({ ok: false, error: "Missing SUPABASE env." }, { status: 500 });
    }

    const body = await req.json().catch(() => ({}));
    const country = (body?.country || "").toString().toLowerCase().trim();
    const shop = (body?.shop || "").toString().toLowerCase().trim();
    const product = body?.product as {
      name?: string;
      amount?: string;
      unit?: string;
      categoryKey?: string;
      subcategoryKey?: string;
      placementKey?: string;
    } | undefined;
    const promos: PromoIn[] = Array.isArray(body?.promos) ? body.promos : [];

    if (!country || !["sk", "cz", "pl"].includes(country)) {
      return NextResponse.json({ ok: false, error: "Invalid country." }, { status: 400 });
    }
    if (!shop || !product?.name?.trim()) {
      return NextResponse.json({ ok: false, error: "Missing shop or product name." }, { status: 400 });
    }

    const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

    const nameKey = normalizeNameKey(product.name);
    const targetAmount = product.amount ? normAmount(product.amount) : null;
    const targetUnit = product.unit ? String(product.unit).toLowerCase().trim() : null;

    const basePath = `databazy/${country}`;
    const listRes = await supabase.storage.from("cap-data").list(basePath, { limit: 2000 });
    if (listRes.error || !listRes.data) {
      return NextResponse.json({ ok: false, error: listRes.error?.message || "list failed" }, { status: 500 });
    }
    const fileBase = sanitizeBase(shop);
    const slotRegex = new RegExp(`^${fileBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(_\\d{1,2})?\\.json$`);
    const files = listRes.data.map((f) => f?.name || "").filter((n) => slotRegex.test(n)).sort();

    const warnings: string[] = [];
    const changedFiles = new Set<string>();

    // Stiahni všetky sloty, zapamätaj si aj max dátum (na výber cieľa).
    type Loaded = { name: string; flyer: FlyerNode[]; maxDate: number };
    const loaded: Loaded[] = [];
    for (const fn of files) {
      const dl = await supabase.storage.from("cap-data").download(`${basePath}/${fn}`);
      if (dl.error || !dl.data) { warnings.push(`${fn}: stiahnutie zlyhalo`); continue; }
      let flyer: unknown;
      try { flyer = JSON.parse(await dl.data.text()); } catch { warnings.push(`${fn}: JSON chyba`); continue; }
      if (!Array.isArray(flyer)) continue;
      let maxDate = 0;
      for (const c of flyer as FlyerNode[])
        for (const s of c?.["Podkategórie"] ?? [])
          for (const z of s?.["Zaradenia"] ?? [])
            for (const p of z?.["Produkty"] ?? [])
              { const d = ymd(p?.["Dátum akcie do"]); if (d > maxDate) maxDate = d; }
      loaded.push({ name: fn, flyer: flyer as FlyerNode[], maxDate });
    }

    // 1) Odstráň všetky inštancie produktu zo všetkých slotov.
    let removed = 0;
    for (const L of loaded) {
      for (const c of L.flyer)
        for (const s of c?.["Podkategórie"] ?? [])
          for (const z of s?.["Zaradenia"] ?? []) {
            const prods = z?.["Produkty"];
            if (!Array.isArray(prods)) continue;
            const before = prods.length;
            z["Produkty"] = prods.filter((p: FlyerNode) => {
              if (normalizeNameKey(p?.["Názov"] || "") !== nameKey) return true;
              if (targetAmount !== null && normAmount(p?.["Množstvo"]) !== targetAmount) return true;
              if (targetUnit !== null && String(p?.["Merná jednotka"] ?? "").toLowerCase().trim() !== targetUnit) return true;
              return false; // match → odstrániť
            });
            if (z["Produkty"].length !== before) { removed += before - z["Produkty"].length; changedFiles.add(L.name); }
          }
    }

    // 2) Vyber cieľový slot (najnovší podľa dátumu, tie-break main {shop}.json).
    let target: Loaded | null = null;
    for (const L of loaded) {
      if (!target || L.maxDate > target.maxDate ||
          (L.maxDate === target.maxDate && L.name === `${fileBase}.json`)) target = L;
    }
    let targetName = target ? target.name : `${fileBase}.json`;
    let targetFlyer = target ? target.flyer : ([] as FlyerNode[]);
    if (!target) loaded.push({ name: targetName, flyer: targetFlyer, maxDate: 0 });

    // 3) Vlož akcie do cieľa (každá do svojho zaradenia).
    let added = 0;
    for (const pr of promos) {
      const cat = pr.categoryKey || product.categoryKey || "";
      const sub = pr.subcategoryKey || product.subcategoryKey || "";
      const plc = pr.placementKey || product.placementKey || "";
      const amt = pr.amount ?? product.amount ?? "";
      const un = pr.unit ?? product.unit ?? "";
      const priceSale = normalizePrice(pr.price_sale);
      const priceReg = normalizePrice(pr.price_regular);
      const node: FlyerNode = {
        "Názov": product.name,
        "Kategória": cat,
        "Podkategória": sub,
        "Zaradenie": plc,
        "Množstvo": amt,
        "Merná jednotka": un,
        "Bežná cena za bal.": priceReg,
        "Bežná jednotková cena": calculateUnitPrice(priceReg, amt, un),
        "Akciová cena": priceSale,
        "Akciová jednotková cena": calculateUnitPrice(priceSale, amt, un),
        "Doplnková Informácia": (pr.note || "").trim(),
        "Dátum akcie od": pr.date_from || "",
        "Dátum akcie do": pr.date_to || "",
        "Obchody": [shop],
      };
      ensurePlacementProducts(targetFlyer, cat, sub, plc).push(node);
      added += 1;
    }
    changedFiles.add(targetName);

    // 4) Nahraj zmenené sloty.
    const targetLoaded = loaded.find((L) => L.name === targetName)!;
    for (const L of loaded) {
      if (!changedFiles.has(L.name)) continue;
      const up = await supabase.storage.from("cap-data").upload(
        `${basePath}/${L.name}`,
        JSON.stringify(L === targetLoaded ? targetFlyer : L.flyer, null, 2),
        { contentType: "application/json", upsert: true, cacheControl: "0" },
      );
      if (up.error) warnings.push(`${L.name}: upload zlyhal — ${up.error.message}`);
    }

    // Bez zdvihnutia verzie indexu si appky ďalej čítajú staré akcie z cache.
    warnings.push(
      ...(await bumpIndexVersionsForFiles(supabase, basePath, [...changedFiles])),
    );

    // 5) DB: upsert jeden reprezentatívny riadok (najdlhšie trvajúca akcia).
    let dbUpdated = false;
    if (promos.length > 0) {
      const rep = [...promos].sort((a, b) => ymd(b.date_to || "") - ymd(a.date_to || ""))[0];
      const amt = rep.amount ?? product.amount ?? "";
      const un = rep.unit ?? product.unit ?? "";
      const priceSale = normalizePrice(rep.price_sale);
      const priceReg = normalizePrice(rep.price_regular);
      const record = {
        country,
        shop,
        name: product.name,
        name_key: nameKey,
        category: rep.categoryKey || product.categoryKey || "",
        subcategory: rep.subcategoryKey || product.subcategoryKey || "",
        placement: rep.placementKey || product.placementKey || "",
        amount: amt,
        unit: un,
        price_regular: priceReg,
        price_regular_unit: calculateUnitPrice(priceReg, amt, un),
        price_sale: priceSale,
        price_sale_unit: calculateUnitPrice(priceSale, amt, un),
        info: (rep.note || "").trim(),
        date_from: rep.date_from || "",
        date_to: rep.date_to || "",
      };
      const { error: upErr } = await supabase
        .from("master_products_v2")
        .upsert([record], { onConflict: "country,shop,name_key" });
      if (upErr) warnings.push(`DB upsert: ${upErr.message}`);
      else dbUpdated = true;
    } else {
      // Žiadne akcie → produkt sa maže aj z DB (pre tento obchod).
      const { error: delErr } = await supabase
        .from("master_products_v2")
        .delete()
        .eq("country", country)
        .eq("name_key", nameKey)
        .eq("shop", shop);
      if (delErr) warnings.push(`DB delete: ${delErr.message}`);
      else dbUpdated = true;
    }

    // Nový/upravený produkt v DB → HNEĎ skús poslať watchdog push tým, čo ho
    // sledujú (nečaká sa na denný cron o 08:00). Funkcia je dedup-safe, takže
    // sa nič neposiela dvakrát. Fire & forget — neblokuje odpoveď editora.
    if (dbUpdated) {
      const fnUrl = process.env.WATCHDOG_PUSH_URL ||
        "https://dkvfpvhaozcxosoiojce.functions.supabase.co/watchdog-push";
      fetch(fnUrl, { method: "POST" }).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      removed,
      added,
      changedFiles: [...changedFiles],
      dbUpdated,
      warnings,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Unknown error" }, { status: 500 });
  }
}
