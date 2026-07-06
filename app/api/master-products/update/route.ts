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
  warnings: string[];
};

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
): Promise<FlyerFileSummary> {
  const summary: FlyerFileSummary = {
    updatedFiles: [],
    updatedProducts: 0,
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

    const { error: deleteError } = await supabase
      .from("master_products_v2")
      .delete()
      .eq("country", baseRecord.country)
      .eq("name_key", baseRecord.name_key);

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
      warnings: [],
    };
    try {
      const original = body?.original as
        | { name?: string; amount?: string; unit?: string }
        | undefined;
      flyers = await syncProductIntoFlyers(
        supabase,
        country,
        rawShops,
        product,
        original,
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
