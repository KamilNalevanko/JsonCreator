import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

interface AiItem {
  name: string;
  amount?: string;
  unit?: string;
  price_sale?: string;
  price_regular?: string;
  note?: string;
  date_from?: string;
  date_to?: string;
  categoryKey?: string;
  subcategoryKey?: string;
  placementKey?: string;
}

const normalizeNameKey = (value: string) =>
  (value || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");

/* Pomocná fn: vráti novú hodnotu, ale ak je prázdna, ponechá starú z DB */
const mergeField = (aiValue: string, dbValue: string) =>
  aiValue || dbValue || "";

/* Vypočíta jednotkovú cenu (rovnaká logika ako na frontende) */
const calculateUnitPrice = (price: string, amount: string, unit: string): string => {
  if (!price?.trim() || !amount?.trim()) return "";
  const priceNum = parseFloat(price.replace(",", "."));
  const amountNum = parseFloat(amount.replace(",", "."));
  if (isNaN(priceNum) || isNaN(amountNum) || amountNum === 0) return "";
  let multiplier = 1;
  if (unit === "g" || unit === "ml") multiplier = 1000;
  const unitPrice = (priceNum / amountNum) * multiplier;
  return unitPrice.toFixed(2).replace(".", ",");
};

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
    const shop = (body?.shop || "").toString().toLowerCase().trim();
    const items: AiItem[] = Array.isArray(body?.items) ? body.items : [];

    if (!["sk", "cz", "pl"].includes(country)) {
      return NextResponse.json(
        { ok: false, error: "Neplatná krajina. Použi sk/cz/pl." },
        { status: 400 }
      );
    }
    if (!shop) {
      return NextResponse.json(
        { ok: false, error: "Chýba názov obchodu." },
        { status: 400 }
      );
    }
    if (items.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Žiadne položky na uloženie." },
        { status: 400 }
      );
    }

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    const validItems = items.filter((item) => item.name?.trim());
    if (validItems.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Žiadne platné položky (chýba názov)." },
        { status: 400 }
      );
    }

    // Načítaj existujúce záznamy z DB pre exact match (country + shop + name_key)
    const nameKeys = validItems.map((item) => normalizeNameKey(item.name));
    const { data: existingRows } = await supabase
      .from("master_products_v2")
      .select("name_key,name,category,subcategory,placement,amount,unit,price_regular,price_regular_unit,price_sale,price_sale_unit,info,date_from,date_to")
      .eq("country", country)
      .eq("shop", shop)
      .in("name_key", nameKeys);

    const allShopRowsList = existingRows || [];

    // Exact match mapa
    const existingMap = new Map(
      allShopRowsList.map((row) => [row.name_key as string, row])
    );

    const records = validItems.map((item) => {
      const nameKey = normalizeNameKey(item.name);
      const existing = existingMap.get(nameKey);
      const db = existing || {} as Record<string, string>;

      // Pre existujúce záznamy: zachovaj name/category/subcategory/placement z DB
      // Pre nové záznamy: použi AI hodnoty
      const resolvedNameKey = nameKey;
      const resolvedName = existing ? (db.name || item.name.trim()) : item.name.trim();
      const resolvedCategory = existing ? (db.category || item.categoryKey || "") : (item.categoryKey || "");
      const resolvedSubcategory = existing ? (db.subcategory || item.subcategoryKey || "") : (item.subcategoryKey || "");
      const resolvedPlacement = existing ? (db.placement || item.placementKey || "") : (item.placementKey || "");

      const resolvedAmount = mergeField(item.amount || "", db.amount || "");
      const resolvedUnit = mergeField(item.unit || "", db.unit || "");

      return {
        country,
        shop,
        name: resolvedName,
        name_key: resolvedNameKey,
        category: resolvedCategory,
        subcategory: resolvedSubcategory,
        placement: resolvedPlacement,
        amount: resolvedAmount,
        unit: resolvedUnit,
        price_regular: mergeField(item.price_regular || "", db.price_regular || ""),
        price_regular_unit: calculateUnitPrice(
          mergeField(item.price_regular || "", db.price_regular || ""),
          resolvedAmount,
          resolvedUnit
        ),
        price_sale: mergeField(item.price_sale || "", db.price_sale || ""),
        price_sale_unit: calculateUnitPrice(
          mergeField(item.price_sale || "", db.price_sale || ""),
          resolvedAmount,
          resolvedUnit
        ),
        info: mergeField(item.note || "", db.info || ""),
        date_from: mergeField(item.date_from || "", db.date_from || ""),
        date_to: mergeField(item.date_to || "", db.date_to || ""),
        autoscrap: true,
      };
    });

    const { error } = await supabase
      .from("master_products_v2")
      .upsert(records, { onConflict: "country,shop,name_key" });

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, saved: records.length, merged: records });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Neznáma chyba";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
