import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// This route **upserts** a product into the country DB JSON stored in Supabase Storage.
// It supports both shapes:
// 1) Hierarchy array: [{"Kategória":..., "Podkategórie":[...]}]
// 2) Legacy object: { Produkty: [...] }
//
// Upsert key (hierarchy mode): (Kategória, Podkategória, Zaradenie, normalized Názov)
// If product already exists, it is REPLACED (so edited dates/prices persist).

type FlyerProduct = Record<string, any>;

type HierarchyCategory = {
  "Kategória": string;
  "Podkategórie"?: Array<{
    "Podkategória": string;
    "Zaradenia"?: Array<{
      "Zaradenie": string;
      "Produkty"?: FlyerProduct[];
    }>;
  }>;
};

const norm = (s: string) =>
  (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");

const normalizeLoadedFlyer = (payload: any): HierarchyCategory[] | null => {
  if (Array.isArray(payload)) return payload as HierarchyCategory[];
  if (Array.isArray(payload?.data)) return payload.data as HierarchyCategory[];
  if (Array.isArray(payload?.items)) return payload.items as HierarchyCategory[];
  return null;
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

    // 1) Download existing JSON
    const dl = await supabase.storage.from("cap-data").download(storagePath);

    if (dl.error || !dl.data) {
      return NextResponse.json(
        {
          ok: false,
          error: `Cannot download existing JSON: ${storagePath}`,
          detail: dl.error?.message || "Unknown download error",
          path: storagePath,
        },
        { status: 404 }
      );
    }

    const text = await dl.data.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { ok: false, error: "Stored JSON is not valid JSON.", path: storagePath },
        { status: 500 }
      );
    }

    const nameKey = norm(product["Názov"]);

    // 2) Try hierarchy mode first
    const flyer = normalizeLoadedFlyer(parsed);
    if (flyer) {
      const catKey = product["Kategória"];
      const subKey = product["Podkategória"];
      const plcKey = product["Zaradenie"];

      if (!catKey || !subKey || !plcKey) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Missing hierarchy keys in product (Kategória/Podkategória/Zaradenie).",
          },
          { status: 400 }
        );
      }

      const cat = flyer.find((c) => c?.["Kategória"] === catKey);
      const sub = cat?.["Podkategórie"]?.find((s) => s?.["Podkategória"] === subKey);
      const plc = sub?.["Zaradenia"]?.find((p) => p?.["Zaradenie"] === plcKey);

      if (!cat || !sub || !plc) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Target hierarchy path not found in master JSON (category/subcategory/placement).",
            detail: { catKey, subKey, plcKey },
          },
          { status: 400 }
        );
      }

      if (!Array.isArray(plc["Produkty"])) plc["Produkty"] = [];

      const idx = plc["Produkty"].findIndex(
        (p: any) => norm(p?.["Názov"] || "") === nameKey
      );

      const action = idx >= 0 ? "updated" : "inserted";
      if (idx >= 0) plc["Produkty"][idx] = product;
      else plc["Produkty"].push(product);

      const payload = JSON.stringify(flyer, null, 2);
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
        mode: "hierarchy",
        action,
      });
    }

    // 3) Legacy mode: { Produkty: [...] } — still upsert by name
    if (!parsed || typeof parsed !== "object") parsed = {};
    if (!Array.isArray(parsed.Produkty)) parsed.Produkty = [];

    const idx = parsed.Produkty.findIndex(
      (p: any) => norm(p?.["Názov"] || "") === nameKey
    );
    const action = idx >= 0 ? "updated" : "inserted";
    if (idx >= 0) parsed.Produkty[idx] = product;
    else parsed.Produkty.push(product);

    const payload = JSON.stringify(parsed, null, 2);
    const up = await supabase.storage.from("cap-data").upload(storagePath, payload, {
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
      mode: "legacy",
      action,
      total: parsed.Produkty.length,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
