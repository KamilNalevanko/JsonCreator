import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeNameKey } from "../../../../lib/normalize";

type FlyerProduct = {
  "Názov": string;
  "Kategória": string;
  "Podkategória": string;
  "Zaradenie": string;
  "Množstvo": string;
  "Merná jednotka": string;
  "Bežná cena za bal.": string;
  "Bežná jednotková cena": string;
  "Akciová cena": string;
  "Akciová jednotková cena": string;
  "Doplnková Informácia": string;
  "Dátum akcie od": string;
  "Dátum akcie do": string;
  "Obchody"?: string[];
};

const normalizeShops = (value?: string[]) =>
  Array.isArray(value) ? value.map((item) => String(item)) : [];

const NO_SHOP_TOKEN = "<NO_SHOP>";

// Same file-name sanitizer as rotating-upload so we hit the same storage paths.
const sanitizeBase = (value: string) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "letak";

const normAmount = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/,/g, ".")
    .replace(/\s+/g, " ")
    .trim();

type FlyerFileSummary = {
  updatedFiles: string[];
  updatedProducts: number;
  insertedFiles: string[];
  insertedShops: string[];
  warnings: string[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FlyerNode = Record<string, any>;

// Find (or create) the category → subcategory → placement node path in a flyer
// tree by key, returning the placement's Produkty array. Flyer nodes are
// keys-only ({ "Kategória": key, "Podkategórie": [...] }), so creating a missing
// path with just the keys matches the existing on-disk shape.
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
  let plc = sub["Zaradenia"].find((p: FlyerNode) => p?.["Zaradenie"] === plcKey);
  if (!plc) {
    plc = { "Zaradenie": plcKey, "Produkty": [] };
    sub["Zaradenia"].push(plc);
  }
  if (!Array.isArray(plc["Produkty"])) plc["Produkty"] = [];
  return plc["Produkty"];
}

// DD.MM.YYYY → sortable number (0 when unparseable). Used to pick the "most
// current" flyer file (the one whose offers end latest).
const parseDateToNum = (v: unknown): number => {
  const m = String(v ?? "").match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return 0;
  return Number(m[3]) * 10000 + Number(m[2]) * 100 + Number(m[1]);
};

// SHOP-SWITCH ADD: put the product into a single shop's flyer — ONLY that shop,
// and ONLY one file (the flyer with the latest offer date). If the product is
// already in that file it's updated in place; otherwise it's inserted (node path
// created if needed). Other slots and other shops are never touched. Failures
// are recorded as warnings and never fail the DB update.
async function addProductToShopFlyer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  basePath: string,
  fileBase: string,
  files: string[],
  shop: string,
  updated: FlyerProduct,
  originalKey: string,
  originalAmount: string | null,
  originalUnit: string | null,
  summary: FlyerFileSummary,
): Promise<void> {
  type FileInfo = { name: string; flyer: FlyerNode[]; maxDate: number };
  const infos: FileInfo[] = [];
  for (const fileName of files) {
    try {
      const dl = await supabase.storage
        .from("cap-data")
        .download(`${basePath}/${fileName}`);
      if (dl.error || !dl.data) {
        summary.warnings.push(`${fileName}: stiahnutie zlyhalo`);
        continue;
      }
      const parsed = JSON.parse(await dl.data.text());
      if (!Array.isArray(parsed)) continue;
      let maxDate = 0;
      for (const cat of parsed)
        for (const sub of cat?.["Podkategórie"] ?? [])
          for (const plc of sub?.["Zaradenia"] ?? [])
            for (const p of plc?.["Produkty"] ?? []) {
              const d = parseDateToNum(p?.["Dátum akcie do"]);
              if (d > maxDate) maxDate = d;
            }
      infos.push({ name: fileName, flyer: parsed, maxDate });
    } catch (e) {
      summary.warnings.push(
        `${fileName}: ${e instanceof Error ? e.message : "chyba"}`,
      );
    }
  }

  // Most current flyer wins; ties prefer the main {shop}.json file.
  let target: FileInfo | null = null;
  for (const info of infos) {
    if (
      !target ||
      info.maxDate > target.maxDate ||
      (info.maxDate === target.maxDate && info.name === `${fileBase}.json`)
    ) {
      target = info;
    }
  }

  const targetName = target ? target.name : `${fileBase}.json`;
  const flyer: FlyerNode[] = target ? target.flyer : [];

  // Is the product already in the target file? (name + amount, or a lone name.)
  type Match = { node: FlyerNode; index: number; amountMatches: boolean };
  const matches: Match[] = [];
  for (const cat of flyer)
    for (const sub of cat?.["Podkategórie"] ?? [])
      for (const plc of sub?.["Zaradenia"] ?? []) {
        const products = plc?.["Produkty"];
        if (!Array.isArray(products)) continue;
        products.forEach((p: FlyerNode, index: number) => {
          if (normalizeNameKey(p?.["Názov"] || "") !== originalKey) return;
          const amountMatches =
            originalAmount === null ||
            (normAmount(p?.["Množstvo"]) === originalAmount &&
              (originalUnit === null ||
                String(p?.["Merná jednotka"] ?? "").toLowerCase().trim() ===
                  originalUnit));
          matches.push({ node: plc, index, amountMatches });
        });
      }

  let targets = matches.filter((m) => m.amountMatches);
  if (targets.length === 0 && matches.length === 1) targets = matches;

  const nextFields = {
    "Názov": updated["Názov"],
    "Kategória": updated["Kategória"],
    "Podkategória": updated["Podkategória"],
    "Zaradenie": updated["Zaradenie"],
    "Množstvo": updated["Množstvo"],
    "Merná jednotka": updated["Merná jednotka"],
    "Bežná cena za bal.": updated["Bežná cena za bal."],
    "Bežná jednotková cena": updated["Bežná jednotková cena"],
    "Akciová cena": updated["Akciová cena"],
    "Akciová jednotková cena": updated["Akciová jednotková cena"],
    "Doplnková Informácia": updated["Doplnková Informácia"],
    "Dátum akcie od": updated["Dátum akcie od"],
    "Dátum akcie do": updated["Dátum akcie do"],
  };

  let wasInsert = false;
  if (targets.length > 0) {
    for (const m of targets) {
      m.node["Produkty"][m.index] = {
        ...m.node["Produkty"][m.index],
        ...nextFields,
      };
    }
  } else {
    const products = ensurePlacementProducts(
      flyer,
      updated["Kategória"],
      updated["Podkategória"],
      updated["Zaradenie"],
    );
    products.push({ ...nextFields, "Obchody": [shop] });
    wasInsert = true;
  }

  const upload = await supabase.storage
    .from("cap-data")
    .upload(`${basePath}/${targetName}`, JSON.stringify(flyer, null, 2), {
      contentType: "application/json",
      upsert: true,
      cacheControl: "0",
    });
  if (upload.error) {
    summary.warnings.push(`${targetName}: zápis zlyhal — ${upload.error.message}`);
    return;
  }
  if (wasInsert) summary.insertedFiles.push(targetName);
  else summary.updatedFiles.push(targetName);
  summary.updatedProducts += 1;
  if (!summary.insertedShops.includes(shop)) summary.insertedShops.push(shop);
}

// After the DB update, propagate the change into the shop's flyer JSON files in
// Storage (databazy/{country}/{shop}.json + {shop}_N.json). Files are rewritten
// IN PLACE (same path, no slot rotation), only matched products are touched.
// Any failure here is reported as a warning — it never fails the DB update.
async function syncProductIntoFlyers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  country: string,
  shops: string[],
  updated: FlyerProduct,
  original: { name?: string; amount?: string; unit?: string } | undefined,
  // Shops that were newly added to this product (e.g. via the shop-switch
  // dropdown). For these, if the product is not already in the shop's flyer,
  // it is INSERTED into the shop's primary file rather than only updated.
  addShops: string[] = [],
): Promise<FlyerFileSummary> {
  const summary: FlyerFileSummary = {
    updatedFiles: [],
    updatedProducts: 0,
    insertedFiles: [],
    insertedShops: [],
    warnings: [],
  };

  const originalKey = normalizeNameKey(original?.name || updated["Názov"]);
  const originalAmount =
    original?.amount !== undefined ? normAmount(original.amount) : null;
  const originalUnit =
    original?.unit !== undefined
      ? String(original.unit).toLowerCase().trim()
      : null;

  const basePath = `databazy/${country}`;
  const listRes = await supabase.storage
    .from("cap-data")
    .list(basePath, { limit: 1000 });
  if (listRes.error || !listRes.data) {
    summary.warnings.push(
      `Nepodarilo sa načítať zoznam letákov: ${listRes.error?.message || "?"}`,
    );
    return summary;
  }

  for (const shop of shops) {
    if (!shop || shop === NO_SHOP_TOKEN) continue;
    const fileBase = sanitizeBase(shop);
    const slotRegex = new RegExp(`^${fileBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(_\\d{1,2})?\\.json$`);
    const files = listRes.data
      .map((f) => f?.name || "")
      .filter((name) => slotRegex.test(name));

    // Shop-switch ADD: touch only this shop, only one file. Handled separately.
    if (addShops.includes(shop)) {
      await addProductToShopFlyer(
        supabase,
        basePath,
        fileBase,
        files,
        shop,
        updated,
        originalKey,
        originalAmount,
        originalUnit,
        summary,
      );
      continue;
    }

    // Normal edit: update the product in EVERY file where it already exists
    // (keeps a shop's rotating slots consistent).
    for (const fileName of files) {
      const path = `${basePath}/${fileName}`;
      try {
        const dl = await supabase.storage.from("cap-data").download(path);
        if (dl.error || !dl.data) {
          summary.warnings.push(`${fileName}: stiahnutie zlyhalo`);
          continue;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const flyer = JSON.parse(await dl.data.text()) as any[];
        if (!Array.isArray(flyer)) continue;

        // Collect matches (node + index) across the whole hierarchy.
        type Match = {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          placementNode: any;
          index: number;
          amountMatches: boolean;
        };
        const matches: Match[] = [];
        for (const cat of flyer) {
          for (const sub of cat?.["Podkategórie"] ?? []) {
            for (const plc of sub?.["Zaradenia"] ?? []) {
              const products = plc?.["Produkty"];
              if (!Array.isArray(products)) continue;
              products.forEach((p, index) => {
                if (normalizeNameKey(p?.["Názov"] || "") !== originalKey) return;
                const amountMatches =
                  originalAmount === null ||
                  (normAmount(p?.["Množstvo"]) === originalAmount &&
                    (originalUnit === null ||
                      String(p?.["Merná jednotka"] ?? "")
                        .toLowerCase()
                        .trim() === originalUnit));
                matches.push({ placementNode: plc, index, amountMatches });
              });
            }
          }
        }
        if (matches.length === 0) continue;

        // Prefer exact amount+unit matches (protects same-name size variants);
        // fall back to a name-only match ONLY when it is unambiguous.
        let targets = matches.filter((m) => m.amountMatches);
        if (targets.length === 0) {
          if (matches.length === 1) {
            targets = matches;
          } else {
            summary.warnings.push(
              `${fileName}: ${matches.length} rovnomenné produkty, gramáž nesedí — nechané bez zmeny`,
            );
            continue;
          }
        }

        let changed = false;
        for (const m of targets) {
          const entry = m.placementNode["Produkty"][m.index];
          const nextEntry = {
            ...entry,
            "Názov": updated["Názov"],
            "Kategória": updated["Kategória"],
            "Podkategória": updated["Podkategória"],
            "Zaradenie": updated["Zaradenie"],
            "Množstvo": updated["Množstvo"],
            "Merná jednotka": updated["Merná jednotka"],
            "Bežná cena za bal.": updated["Bežná cena za bal."],
            "Bežná jednotková cena": updated["Bežná jednotková cena"],
            "Akciová cena": updated["Akciová cena"],
            "Akciová jednotková cena": updated["Akciová jednotková cena"],
            "Doplnková Informácia": updated["Doplnková Informácia"],
            "Dátum akcie od": updated["Dátum akcie od"],
            "Dátum akcie do": updated["Dátum akcie do"],
          };

          const nodeKey = m.placementNode["Zaradenie"];
          if (nodeKey !== updated["Zaradenie"]) {
            // Placement changed — move the entry to the new placement node if
            // this file has it; otherwise keep it where it is (fields updated).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let target: any = null;
            for (const cat of flyer) {
              if (cat?.["Kategória"] !== updated["Kategória"]) continue;
              for (const sub of cat?.["Podkategórie"] ?? []) {
                if (sub?.["Podkategória"] !== updated["Podkategória"]) continue;
                for (const plc of sub?.["Zaradenia"] ?? []) {
                  if (plc?.["Zaradenie"] === updated["Zaradenie"]) target = plc;
                }
              }
            }
            if (target) {
              m.placementNode["Produkty"].splice(m.index, 1);
              if (!Array.isArray(target["Produkty"])) target["Produkty"] = [];
              target["Produkty"].push(nextEntry);
            } else {
              m.placementNode["Produkty"][m.index] = nextEntry;
              summary.warnings.push(
                `${fileName}: nové zaradenie sa v letáku nenašlo — produkt upravený na pôvodnom mieste`,
              );
            }
          } else {
            m.placementNode["Produkty"][m.index] = nextEntry;
          }
          changed = true;
          summary.updatedProducts += 1;
        }

        if (changed) {
          const upload = await supabase.storage
            .from("cap-data")
            .upload(path, JSON.stringify(flyer, null, 2), {
              contentType: "application/json",
              upsert: true,
              cacheControl: "0",
            });
          if (upload.error) {
            summary.warnings.push(`${fileName}: upload zlyhal — ${upload.error.message}`);
          } else {
            summary.updatedFiles.push(fileName);
          }
        }
      } catch (e) {
        summary.warnings.push(
          `${fileName}: ${e instanceof Error ? e.message : "chyba"}`,
        );
      }
    }
  }

  return summary;
}

export async function POST(req: Request) {
  try {
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRole) {
      return NextResponse.json(
        { ok: false, error: "Missing SUPABASE env (URL or SERVICE_ROLE_KEY)." },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const country = (body?.country || "").toString().toLowerCase().trim();
    const product = body?.product as FlyerProduct | undefined;

    if (!country || !["sk", "cz", "pl"].includes(country)) {
      return NextResponse.json(
        { ok: false, error: "Invalid country. Use sk/cz/pl." },
        { status: 400 }
      );
    }

    if (!product || !product["Názov"]) {
      return NextResponse.json(
        { ok: false, error: "Missing product or product['Názov']." },
        { status: 400 }
      );
    }

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    const nameKey = normalizeNameKey(product["Názov"]);
    const baseRecord = {
      country,
      name: product["Názov"],
      name_key: nameKey,
      category: product["Kategória"],
      subcategory: product["Podkategória"],
      placement: product["Zaradenie"],
      amount: product["Množstvo"],
      unit: product["Merná jednotka"],
      price_regular: product["Bežná cena za bal."],
      price_regular_unit: product["Bežná jednotková cena"],
      price_sale: product["Akciová cena"],
      price_sale_unit: product["Akciová jednotková cena"],
      info: product["Doplnková Informácia"],
      date_from: product["Dátum akcie od"],
      date_to: product["Dátum akcie do"],
    };

    const rawShops = normalizeShops(product["Obchody"]);
    const shops = rawShops.length ? rawShops : [NO_SHOP_TOKEN];

    // Scope the delete to ONLY the shops we are about to (re)write. Without the
    // `.in("shop", …)` filter this wiped every shop that shared the same
    // country+name_key — e.g. saving Biedronka's "Czereśnie" deleted Aldi's
    // independent "Czereśnie" row too (cross-shop data loss). Each shop is an
    // independent record and must never be touched by editing another shop.
    const { error: deleteError } = await supabase
      .from("master_products_v2")
      .delete()
      .eq("country", baseRecord.country)
      .eq("name_key", baseRecord.name_key)
      .in("shop", shops);

    if (deleteError) {
      return NextResponse.json(
        { ok: false, error: deleteError.message },
        { status: 500 }
      );
    }

    const records = shops.map((shop) => ({ ...baseRecord, shop }));
    const { error: upsertError } = await supabase
      .from("master_products_v2")
      .upsert(records, {
        onConflict: "country,shop,name_key",
      });

    if (upsertError) {
      return NextResponse.json(
        { ok: false, error: upsertError.message },
        { status: 500 }
      );
    }

    // Propagate the edit into the shop's flyer files in Storage. Failures here
    // must not fail the DB update — they are returned as warnings instead.
    let flyers: FlyerFileSummary = {
      updatedFiles: [],
      updatedProducts: 0,
      insertedFiles: [],
      insertedShops: [],
      warnings: [],
    };
    try {
      const original = body?.original as
        | { name?: string; amount?: string; unit?: string }
        | undefined;
      // Shops newly added via the shop-switch dropdown — restricted to shops we
      // actually write, so a stale client value can't force unrelated inserts.
      const addShops = normalizeShops(body?.addShops).filter((s) =>
        rawShops.includes(s),
      );
      // On a shop-switch add, sync ONLY the newly added shop's flyer — the other
      // (unchanged) shops must not be re-written. A normal edit syncs all shops.
      const syncShops = addShops.length ? addShops : rawShops;
      flyers = await syncProductIntoFlyers(
        supabase,
        country,
        syncShops,
        product,
        original,
        addShops,
      );
    } catch (e) {
      flyers.warnings.push(
        e instanceof Error ? e.message : "Sync letákov zlyhal",
      );
    }

    return NextResponse.json({ ok: true, flyers });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
