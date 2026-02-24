import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type FlyerProduct = {
  "Názov": string;
  "Kategória": string;
  "Podkategória": string;
  "Zaradenie": string;
  "Množstvo": string;
  "Merná jednotka": string;
  "Bežná cena za bal.": string;
  "Bežná jednotková cena": string;
  "Akciová cena": string;
  "Akciová jednotková cena": string;
  "Doplnková Informácia": string;
  "Dátum akcie od": string;
  "Dátum akcie do": string;
};

type HierarchyPlacement = {
  "Zaradenie": string;
  "Produkty"?: FlyerProduct[];
};

type HierarchySubcategory = {
  "Podkategória": string;
  "Zaradenia": HierarchyPlacement[];
};

type HierarchyCategory = {
  "Kategória": string;
  "Podkategórie": HierarchySubcategory[];
};

const trimName = (value: string) => (value || "").toString().trim();
const productExistsInPlacement = (
  placement: HierarchyPlacement,
  product: FlyerProduct
) =>
  (placement["Produkty"] ?? []).some(
    (p) =>
      trimName(p["Názov"]) === trimName(product["Názov"]) &&
      p["Kategória"] === product["Kategória"] &&
      p["Podkategória"] === product["Podkategória"] &&
      p["Zaradenie"] === product["Zaradenie"]
  );

const appendQueue = new Map<string, Promise<void>>();

const withAppendLock = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
  const prior = appendQueue.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  appendQueue.set(key, prior.then(() => gate));
  await prior;
  try {
    return await work();
  } finally {
    release();
    if (appendQueue.get(key) === gate) {
      appendQueue.delete(key);
    }
  }
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

    return await withAppendLock(storagePath, async () => {
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
      const categoryIndex = data.findIndex(
        (c) => c["Kategória"] === product["Kategória"]
      );
      if (categoryIndex === -1) {
        return NextResponse.json(
          { ok: false, error: "Category not found.", path: storagePath },
          { status: 400 }
        );
      }

      const subIndex = (data[categoryIndex]["Podkategórie"] ?? []).findIndex(
        (s) => s["Podkategória"] === product["Podkategória"]
      );
      if (subIndex === -1) {
        return NextResponse.json(
          { ok: false, error: "Subcategory not found.", path: storagePath },
          { status: 400 }
        );
      }

      const placementIndex = (
        data[categoryIndex]["Podkategórie"][subIndex]["Zaradenia"] ?? []
      ).findIndex((p) => p["Zaradenie"] === product["Zaradenie"]);
      if (placementIndex === -1) {
        return NextResponse.json(
          { ok: false, error: "Placement not found.", path: storagePath },
          { status: 400 }
        );
      }

      const placement =
        data[categoryIndex]["Podkategórie"][subIndex]["Zaradenia"][
          placementIndex
        ];
      if (!placement["Produkty"]) placement["Produkty"] = [];

      const exists = productExistsInPlacement(placement, product);
      if (!exists) {
        placement["Produkty"].push(product);
      }

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

      return NextResponse.json({
        ok: true,
        path: storagePath,
        added: !exists,
      });
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
