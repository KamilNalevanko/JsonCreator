import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { withStorageLock } from "../storageLock";

type HierarchyPlacement = {
  "Zaradenie": string;
  "Produkty"?: unknown[];
};

type HierarchySubcategory = {
  "Podkategória": string;
  "Zaradenia": HierarchyPlacement[];
};

type HierarchyCategory = {
  "Kategória": string;
  "Podkategórie": HierarchySubcategory[];
};

type LoadedProductRef = {
  categoryIndex: number;
  subcategoryIndex: number;
  placementIndex: number;
  productIndex: number;
};


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
    const ref = body?.ref as LoadedProductRef | undefined;

    if (!country || !["sk", "cz", "pl"].includes(country)) {
      return NextResponse.json(
        { ok: false, error: "Invalid country. Use sk/cz/pl." },
        { status: 400 }
      );
    }

    if (!ref) {
      return NextResponse.json(
        { ok: false, error: "Missing product reference." },
        { status: 400 }
      );
    }

    const fileBase =
      country === "sk" ? "slovakia" : country === "cz" ? "czechia" : "poland";
    const storagePath = `databazy/${country}/${fileBase}.json`;

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    return await withStorageLock(storagePath, async () => {
      const dl = await supabase.storage.from("cap-data").download(storagePath);

      if (dl.error || !dl.data) {
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
          { ok: false, error: "Country JSON is not valid JSON.", path: storagePath },
          { status: 500 }
        );
      }

      if (!Array.isArray(master)) {
        return NextResponse.json(
          { ok: false, error: "Country JSON is not an array.", path: storagePath },
          { status: 500 }
        );
      }

      const data = master as HierarchyCategory[];
      const category = data[ref.categoryIndex];
      const subcategory = category?.["Podkategórie"]?.[ref.subcategoryIndex];
      const placement = subcategory?.["Zaradenia"]?.[ref.placementIndex];
      const products = placement?.["Produkty"];

      if (!category || !subcategory || !placement || !products) {
        return NextResponse.json(
          { ok: false, error: "Product reference is out of range.", path: storagePath },
          { status: 400 }
        );
      }

      if (!products[ref.productIndex]) {
        return NextResponse.json(
          { ok: false, error: "Product not found at reference.", path: storagePath },
          { status: 404 }
        );
      }

      products.splice(ref.productIndex, 1);

      const payload = JSON.stringify(data, null, 2);
      const up = await supabase.storage
        .from("cap-data")
        .upload(storagePath, payload, {
          contentType: "application/json",
          cacheControl: "0",
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

      return NextResponse.json({ ok: true, path: storagePath });
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
