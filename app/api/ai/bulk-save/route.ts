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
}

const normalizeNameKey = (value: string) =>
  (value || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");

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

    const records = items
      .filter((item) => item.name?.trim())
      .map((item) => ({
        country,
        shop,
        name: item.name.trim(),
        name_key: normalizeNameKey(item.name),
        category: "",
        subcategory: "",
        placement: "",
        amount: item.amount || "",
        unit: item.unit || "",
        price_regular: item.price_regular || "",
        price_regular_unit: "",
        price_sale: item.price_sale || "",
        price_sale_unit: "",
        info: item.note || "",
        date_from: item.date_from || "",
        date_to: item.date_to || "",
        autoscrap: true,
      }));

    if (records.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Žiadne platné položky (chýba názov)." },
        { status: 400 }
      );
    }

    const { error } = await supabase
      .from("master_products_v2")
      .upsert(records, { onConflict: "country,shop,name_key" });

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, saved: records.length });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Neznáma chyba";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
