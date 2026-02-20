import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type FlyerProduct = Record<string, any>;

const normName = (s: string) =>
  (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");

export async function POST(req: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
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

    const fileBase =
      country === "sk" ? "slovakia" : country === "cz" ? "czechia" : "poland";
    const storagePath = `databazy/${country}/${fileBase}.json`;

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    // 1) Download existing master JSON
    const dl = await supabase.storage.from("cap-data").download(storagePath);

    if (dl.error || !dl.data) {
      // IMPORTANT: do NOT overwrite when we cannot download the existing file
      return NextResponse.json(
        {
          ok: false,
          error: `Cannot download existing master JSON: ${storagePath}`,
          detail: dl.error?.message || "Unknown download error",
          path: storagePath,
        },
        { status: 404 }
      );
    }

    const text = await dl.data.text();
    let master: any;
    try {
      master = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { ok: false, error: "Master JSON is not valid JSON.", path: storagePath },
        { status: 500 }
      );
    }

    if (!master || typeof master !== "object") master = {};
    if (!Array.isArray(master.Produkty)) master.Produkty = [];

    // 2) Deduplicate by NAME only (as you want)
    const targetName = normName(product["Názov"]);
    const exists = master.Produkty.some(
      (p: any) => normName(p?.["Názov"] || "") === targetName
    );

    if (!exists) {
      master.Produkty.push(product);
    }

    // 3) Upload back (upsert)
    const payload = JSON.stringify(master, null, 2);
    const up = await supabase.storage
      .from("cap-data")
      .upload(storagePath, payload, {
        contentType: "application/json",
        upsert: true,
      });

    if (up.error) {
      return NextResponse.json(
        {
          ok: false,
          error: `Upload failed for ${storagePath}`,
          detail: up.error.message,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      path: storagePath,
      added: !exists,
      total: master.Produkty.length,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
