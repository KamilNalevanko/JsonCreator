import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Read-only pomocník pre TESTOVACÍ režim notifikácií: vráti posledné
// registrácie zariadení (watchdog_subscriptions). Najnovšia = telefón, na ktorom
// si práve zapol/obnovil strážneho psa → to je tvoj token na test „len mne".
// Editor je len lokálny (single-user), takže čítanie tokenov je v poriadku.

export async function GET() {
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

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    const { data, error } = await supabase
      .from("watchdog_subscriptions")
      .select("token,country,updated_at")
      .order("updated_at", { ascending: false })
      .limit(8);

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    }

    const devices = (data ?? []).map((r) => ({
      token: r.token as string,
      country: (r.country as string) || "",
      updated_at: (r.updated_at as string) || "",
      // Kratší náhľad na identifikáciu bez ukazovania celého tokenu.
      tokenTail: String(r.token || "").slice(-10),
    }));

    return NextResponse.json({ ok: true, devices });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
