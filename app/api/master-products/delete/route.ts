import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeNameKey } from "../../../../lib/normalize";

type ProductIdentity = {
  "Názov"?: string;
  "Kategória"?: string;
  "Podkategória"?: string;
  "Zaradenie"?: string;
  "Množstvo"?: string;
  "Merná jednotka"?: string;
  "Obchody"?: string[];
};

const NO_SHOP_TOKEN = "<NO_SHOP>";

const normalizeShops = (value?: string[]) =>
  Array.isArray(value) ? value.map((item) => String(item)) : [];

// Same file-name sanitizer as rotating-upload / update so we hit the same paths.
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

type FlyerDeleteSummary = {
  removedFiles: string[];
  removedProducts: number;
  warnings: string[];
};

// Remove the product from the shop's flyer JSON files in Storage
// (databazy/{country}/{shop}.json + {shop}_N.json). Matches by name_key and —
// when provided — amount+unit, to avoid deleting a same-name size variant.
// Any failure here is a warning; it never fails the DB delete.
async function deleteProductFromFlyers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  country: string,
  shops: string[],
  target: { name: string; amount?: string; unit?: string },
): Promise<FlyerDeleteSummary> {
  const summary: FlyerDeleteSummary = {
    removedFiles: [],
    removedProducts: 0,
    warnings: [],
  };

  const targetKey = normalizeNameKey(target.name);
  const targetAmount =
    target.amount !== undefined && String(target.amount).trim() !== ""
      ? normAmount(target.amount)
      : null;
  const targetUnit =
    target.unit !== undefined && String(target.unit).trim() !== ""
      ? String(target.unit).toLowerCase().trim()
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
    const slotRegex = new RegExp(
      `^${fileBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(_\\d{1,2})?\\.json$`,
    );
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

        let removedInFile = 0;
        for (const cat of flyer) {
          for (const sub of cat?.["Podkategórie"] ?? []) {
            for (const plc of sub?.["Zaradenia"] ?? []) {
              const products = plc?.["Produkty"];
              if (!Array.isArray(products)) continue;
              // Collect matching indexes.
              const matchIdx: number[] = [];
              products.forEach((p, index) => {
                if (normalizeNameKey(p?.["Názov"] || "") !== targetKey) return;
                // If amount/unit are known, require them to match so we don't
                // delete a different-size product with the same name.
                if (targetAmount !== null) {
                  if (normAmount(p?.["Množstvo"]) !== targetAmount) return;
                  if (
                    targetUnit !== null &&
                    String(p?.["Merná jednotka"] ?? "").toLowerCase().trim() !==
                      targetUnit
                  ) {
                    return;
                  }
                }
                matchIdx.push(index);
              });
              // Remove from the end so indexes stay valid.
              for (let i = matchIdx.length - 1; i >= 0; i--) {
                products.splice(matchIdx[i], 1);
                removedInFile += 1;
              }
            }
          }
        }

        if (removedInFile > 0) {
          const upload = await supabase.storage
            .from("cap-data")
            .upload(path, JSON.stringify(flyer, null, 2), {
              contentType: "application/json",
              upsert: true,
              cacheControl: "0",
            });
          if (upload.error) {
            summary.warnings.push(
              `${fileName}: upload po zmazaní zlyhal — ${upload.error.message}`,
            );
          } else {
            summary.removedFiles.push(fileName);
            summary.removedProducts += removedInFile;
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
    const product = body?.product as ProductIdentity | undefined;

    if (!country || !["sk", "cz", "pl"].includes(country)) {
      return NextResponse.json(
        { ok: false, error: "Invalid country. Use sk/cz/pl." },
        { status: 400 }
      );
    }

    if (!product?.["Názov"]) {
      return NextResponse.json(
        { ok: false, error: "Missing product name." },
        { status: 400 }
      );
    }

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    const nameKey = normalizeNameKey(product["Názov"]);
    const shops = normalizeShops(product["Obchody"]);

    // Delete from the DB. Scope to the given shop(s) when known so we don't wipe
    // the same-named product of OTHER shops (cross-shop safety, same fix as the
    // update route).
    let deleteQuery = supabase
      .from("master_products_v2")
      .delete()
      .eq("country", country)
      .eq("name_key", nameKey);
    if (shops.length > 0) {
      deleteQuery = deleteQuery.in("shop", shops);
    }
    const { data, error } = await deleteQuery.select("id");

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      );
    }

    const dbDeleted = data?.length ?? 0;
    // POZOR: keď v DB nič nenájde, NEkončíme chybou — produkt môže byť už
    // osirotený (zmazaný z DB, ale ostal v letáku). Aj tak skúsime zmazať
    // z letákových súborov, aby ho appka prestala zobrazovať.

    // Also remove the product from the shop's flyer JSON files in Storage.
    // Failures here are warnings — the DB row is already gone.
    let flyers: FlyerDeleteSummary = {
      removedFiles: [],
      removedProducts: 0,
      warnings: [],
    };
    if (shops.length > 0) {
      try {
        flyers = await deleteProductFromFlyers(supabase, country, shops, {
          name: product["Názov"],
          amount: product["Množstvo"],
          unit: product["Merná jednotka"],
        });
      } catch (e) {
        flyers.warnings.push(
          e instanceof Error ? e.message : "Mazanie z letákov zlyhalo",
        );
      }
    } else {
      flyers.warnings.push(
        "Obchod neznámy — z letákov sa nemazalo (len z DB).",
      );
    }

    // Ak sa nezmazalo ani z DB, ani z letáka, produkt sme nenašli.
    if (dbDeleted === 0 && flyers.removedProducts === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "Produkt sa nenašiel v DB ani v letákoch.",
          flyers,
        },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true, dbDeleted, flyers });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
