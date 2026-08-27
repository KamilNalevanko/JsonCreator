import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Vyhľadávač produktov pre deep-link v notifikácii. Vracia reálne riadky z
// master_products_v2 (vrátane category/subcategory/placement/shop kľúčov), aby
// sa po tapnutí na notifikáciu appka spoľahlivo dostala k danému produktu —
// rovnaká sada kľúčov, akú posiela strážny pes (watchdog-push).

const parseDMY = (s?: string | null): number | null => {
  if (!s) return null;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s.trim());
  if (!m) return null;
  return Number(m[3]) * 10000 + Number(m[2]) * 100 + Number(m[1]);
};

export async function GET(req: Request) {
  try {
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRole) {
      return NextResponse.json(
        { ok: false, error: "Missing SUPABASE env." },
        { status: 500 },
      );
    }

    const { searchParams } = new URL(req.url);
    const country = (searchParams.get("country") || "").toLowerCase().trim();
    const q = (searchParams.get("q") || "").trim();
    const shop = (searchParams.get("shop") || "").trim();
    const category = (searchParams.get("category") || "").trim();
    const subcategory = (searchParams.get("subcategory") || "").trim();
    const placement = (searchParams.get("placement") || "").trim();

    if (!country || !["sk", "cz", "pl"].includes(country)) {
      return NextResponse.json(
        { ok: false, error: "Invalid country." },
        { status: 400 },
      );
    }

    const hasFilter = !!(shop || category || subcategory || placement);
    // Hľadanie beží ak je aspoň 2-znakový text ALEBO je zvolený nejaký filter
    // (obchod/kategória/…). Vtedy funguje aj čisté „prezeranie" bez textu.
    if (q.length < 2 && !hasFilter) {
      return NextResponse.json({ ok: true, products: [] });
    }

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    let query = supabase
      .from("master_products_v2")
      .select(
        "name,shop,category,subcategory,placement,amount,unit,price_sale,price_sale_unit,date_from,date_to",
      )
      .eq("country", country);
    if (q.length >= 2) query = query.ilike("name", `%${q}%`);
    if (shop) query = query.eq("shop", shop);
    if (category) query = query.eq("category", category);
    if (subcategory) query = query.eq("subcategory", subcategory);
    if (placement) query = query.eq("placement", placement);

    const { data, error } = await query.limit(300);

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    }

    // Zoraď: aktuálne prebiehajúce akcie hore, potom podľa neskoršieho dátumu DO.
    const now = new Date();
    const todayNum =
      now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    const rows = (data ?? []).map((r) => {
      const to = parseDMY(r.date_to);
      const from = parseDMY(r.date_from);
      const active =
        from !== null && to !== null && todayNum >= from && todayNum <= to;
      return { r, to: to ?? 0, active };
    });
    rows.sort(
      (a, b) => Number(b.active) - Number(a.active) || b.to - a.to,
    );

    const products = rows.slice(0, 40).map(({ r, active }) => ({
      name: r.name || "",
      shop: r.shop || "",
      category: r.category || "",
      subcategory: r.subcategory || "",
      placement: r.placement || "",
      amount: r.amount || "",
      unit: r.unit || "",
      price_sale: r.price_sale || "",
      price_sale_unit: r.price_sale_unit || "",
      date_from: r.date_from || "",
      date_to: r.date_to || "",
      active,
    }));

    return NextResponse.json({ ok: true, products });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
