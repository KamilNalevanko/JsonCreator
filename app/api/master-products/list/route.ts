import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import hierarchyData from "../../../../assets/hierarchia.json";

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
  "Obchody"?: string[];
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

type DbRow = {
  id?: string; // len kvôli orderu (ak existuje)
  country: string;
  shop: string | null;
  name: string;
  category: string;
  subcategory: string;
  placement: string;
  amount: string | null;
  unit: string | null;
  price_regular: string | null;
  price_regular_unit: string | null;
  price_sale: string | null;
  price_sale_unit: string | null;
  info: string | null;
  date_from: string | null;
  date_to: string | null;
};

const NO_SHOP_TOKEN = "<NO_SHOP>";
const hierarchy = hierarchyData as HierarchyCategory[];

const toProduct = (row: DbRow): FlyerProduct => ({
  "Názov": row.name || "",
  "Kategória": row.category || "",
  "Podkategória": row.subcategory || "",
  "Zaradenie": row.placement || "",
  "Množstvo": row.amount || "",
  "Merná jednotka": row.unit || "",
  "Bežná cena za bal.": row.price_regular || "",
  "Bežná jednotková cena": row.price_regular_unit || "",
  "Akciová cena": row.price_sale || "",
  "Akciová jednotková cena": row.price_sale_unit || "",
  "Doplnková Informácia": row.info || "",
  "Dátum akcie od": row.date_from || "",
  "Dátum akcie do": row.date_to || "",
  "Obchody": [],
});

export async function GET(req: Request) {
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

    const { searchParams } = new URL(req.url);
    const country = (searchParams.get("country") || "")
      .toString()
      .toLowerCase()
      .trim();

    if (!country || !["sk", "cz", "pl"].includes(country)) {
      return NextResponse.json(
        { ok: false, error: "Invalid country. Use sk/cz/pl." },
        { status: 400 }
      );
    }

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    // ✅ pagination: Supabase často vráti max ~1000 riadkov na request
    const PAGE_SIZE = 500; // bezpečné (aj keby max_rows nie je 1000)
    let from = 0;
    const allRows: DbRow[] = [];

    while (true) {
      const query = supabase
        .from("master_products_v2")
        .select(
          "country,shop,name,category,subcategory,placement,amount,unit,price_regular,price_regular_unit,price_sale,price_sale_unit,info,date_from,date_to,id"
        )
        .eq("country", country)
        // ✅ stabilné poradie, aby range fungoval spoľahlivo
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      const { data, error } = await query;

      if (error) {
        return NextResponse.json(
          { ok: false, error: error.message },
          { status: 500 }
        );
      }

      const batch = (data ?? []) as DbRow[];
      allRows.push(...batch);

      if (batch.length < PAGE_SIZE) break; // posledná stránka
      from += PAGE_SIZE;
    }

    const productsByPlacement = new Map<string, FlyerProduct[]>();

    allRows.forEach((row) => {
      const base = toProduct(row);

      if (row.shop && row.shop !== NO_SHOP_TOKEN) {
        base["Obchody"] = [row.shop];
      } else {
        base["Obchody"] = [];
      }

      const placementKey = `${base["Kategória"]}||${base["Podkategória"]}||${base["Zaradenie"]}`;
      const list = productsByPlacement.get(placementKey) ?? [];
      list.push(base);
      productsByPlacement.set(placementKey, list);
    });

    const result = hierarchy.map((category) => ({
      "Kategória": category["Kategória"],
      "Podkategórie": category["Podkategórie"].map((subcategory) => ({
        "Podkategória": subcategory["Podkategória"],
        "Zaradenia": subcategory["Zaradenia"].map((placement) => {
          const key = `${category["Kategória"]}||${subcategory["Podkategória"]}||${placement["Zaradenie"]}`;
          return {
            "Zaradenie": placement["Zaradenie"],
            "Produkty": productsByPlacement.get(key) ?? [],
          };
        }),
      })),
    }));

    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}