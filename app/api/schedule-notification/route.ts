import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Naplánované notifikácie: editor sem zapíše notifikáciu s časom odoslania.
// Samotné odoslanie robí Supabase Edge Function `scheduled-push` (pg_cron
// každú minútu), takže PC/editor môže byť medzitým vypnuté.

function getClient() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return null;
  return createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false },
  });
}

// POST — naplánuj notifikáciu.
export async function POST(req: Request) {
  try {
    const supabase = getClient();
    if (!supabase) {
      return NextResponse.json(
        { ok: false, error: "Missing SUPABASE env." },
        { status: 500 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const country = (body?.country || "").toString().toLowerCase().trim();
    const title = (body?.title || "").toString().trim();
    const message = (body?.message || "").toString().trim();
    const sendAt = (body?.send_at || "").toString().trim();
    const token = (body?.token || "").toString().trim();
    const data =
      body?.data && typeof body.data === "object" ? body.data : {};

    if (!country || !["sk", "cz", "pl"].includes(country)) {
      return NextResponse.json(
        { ok: false, error: "Neplatná krajina." },
        { status: 400 },
      );
    }
    if (!title && !message) {
      return NextResponse.json(
        { ok: false, error: "Chýba titul aj text správy." },
        { status: 400 },
      );
    }
    const when = new Date(sendAt);
    if (!sendAt || isNaN(when.getTime())) {
      return NextResponse.json(
        { ok: false, error: "Neplatný čas odoslania." },
        { status: 400 },
      );
    }
    if (when.getTime() < Date.now() - 60_000) {
      return NextResponse.json(
        { ok: false, error: "Čas odoslania je v minulosti." },
        { status: 400 },
      );
    }

    const { data: inserted, error } = await supabase
      .from("scheduled_notifications")
      .insert({
        country,
        title,
        message,
        data,
        token: token || null,
        send_at: when.toISOString(),
      })
      .select("id,send_at")
      .single();

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, id: inserted?.id, send_at: inserted?.send_at });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// GET — zoznam čakajúcich (ešte neodoslaných) naplánovaných notifikácií.
export async function GET() {
  try {
    const supabase = getClient();
    if (!supabase) {
      return NextResponse.json(
        { ok: false, error: "Missing SUPABASE env." },
        { status: 500 },
      );
    }

    const { data, error } = await supabase
      .from("scheduled_notifications")
      .select("id,country,title,message,data,token,send_at,created_at")
      .eq("sent", false)
      .order("send_at", { ascending: true })
      .limit(100);

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, scheduled: data ?? [] });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// DELETE — zruš naplánovanú notifikáciu (len ak ešte nebola odoslaná).
export async function DELETE(req: Request) {
  try {
    const supabase = getClient();
    if (!supabase) {
      return NextResponse.json(
        { ok: false, error: "Missing SUPABASE env." },
        { status: 500 },
      );
    }

    const { searchParams } = new URL(req.url);
    const id = (searchParams.get("id") || "").trim();
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Chýba id." },
        { status: 400 },
      );
    }

    const { error } = await supabase
      .from("scheduled_notifications")
      .delete()
      .eq("id", id)
      .eq("sent", false);

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
