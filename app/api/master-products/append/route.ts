import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
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

    const { data: existing, error: existingError } = await supabase
      .from("master_products_v2")
      .select("id,shop")
      .eq("country", baseRecord.country)
      .eq("name_key", baseRecord.name_key)
      .in("shop", shops);

    if (existingError) {
      return NextResponse.json(
        { ok: false, error: existingError.message },
        { status: 500 }
      );
    }

    const existingShops = new Set((existing || []).map((row) => row.shop));
    const added = shops.some((shop) => !existingShops.has(shop));

    const records = shops.map((shop) => ({ ...baseRecord, shop }));
    const { error: insertError } = await supabase
      .from("master_products_v2")
      .upsert(records, { onConflict: "country,shop,name_key" });

    if (insertError) {
      return NextResponse.json(
        { ok: false, error: insertError.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, added });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
