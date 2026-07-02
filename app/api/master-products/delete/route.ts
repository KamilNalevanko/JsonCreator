import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeNameKey } from "../../../../lib/normalize";

type ProductIdentity = {
  "Názov"?: string;
  "Kategória"?: string;
  "Podkategória"?: string;
  "Zaradenie"?: string;
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
    const { data, error } = await supabase
      .from("master_products_v2")
      .delete()
      .eq("country", country)
      .eq("name_key", nameKey)
      .select("id");

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      );
    }

    if (!data || data.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Product not found for delete." },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
