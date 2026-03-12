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

    // Načítaj existujúce záznamy z DB pre merge
    const nameKeys = validItems.map((item) => normalizeNameKey(item.name));
    const { data: existingRows } = await supabase
      .from("master_products_v2")
      .select("name_key,category,subcategory,placement,amount,unit,price_regular,price_regular_unit,price_sale,price_sale_unit,info,date_from,date_to")
      .eq("country", country)
      .eq("shop", shop)
      .in("name_key", nameKeys);

    const existingMap = new Map(
      (existingRows || []).map((row) => [row.name_key as string, row])
    );

    const records = validItems.map((item) => {
      const nameKey = normalizeNameKey(item.name);
      const existing = existingMap.get(nameKey);
      const db = existing || {} as Record<string, string>;

      return {
        country,
        shop,
        name: item.name.trim(),
        name_key: nameKey,
        category: mergeField(item.categoryKey || "", db.category || ""),
        subcategory: mergeField(item.subcategoryKey || "", db.subcategory || ""),
        placement: mergeField(item.placementKey || "", db.placement || ""),
        amount: mergeField(item.amount || "", db.amount || ""),
        unit: mergeField(item.unit || "", db.unit || ""),
        price_regular: mergeField(item.price_regular || "", db.price_regular || ""),
        price_regular_unit: db.price_regular_unit || "",
        price_sale: mergeField(item.price_sale || "", db.price_sale || ""),
        price_sale_unit: db.price_sale_unit || "",
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
