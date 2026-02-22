import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export const runtime = "nodejs";

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

const normalizeKey = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const sanitizeSegment = (value: string) =>
  value.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      bucketPath?: string;
      shop?: string;
      product?: FlyerProduct;
    };

    const safeFolder = sanitizeSegment(body.bucketPath ?? "");
    const safeShop = sanitizeSegment(body.shop ?? "");
    const product = body.product;

    if (!safeFolder || !safeShop || !product) {
      return NextResponse.json(
        { error: "Missing bucketPath, shop, or product." },
        { status: 400 }
      );
    }

    const baseDir = path.resolve(process.cwd(), "public", "data");
    const filePath = path.resolve(baseDir, safeFolder, `${safeShop}.json`);

    if (!filePath.startsWith(baseDir)) {
      return NextResponse.json({ error: "Invalid path." }, { status: 400 });
    }

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        return NextResponse.json(
          { error: "Source JSON not found." },
          { status: 404 }
        );
      }
      throw err;
    }

    const data = JSON.parse(raw) as HierarchyCategory[];

    const categoryIndex = data.findIndex(
      (c) => c["Kategória"] === product["Kategória"]
    );
    if (categoryIndex === -1) {
      return NextResponse.json(
        { error: "Category not found." },
        { status: 400 }
      );
    }

    const subIndex = (data[categoryIndex]["Podkategórie"] ?? []).findIndex(
      (s) => s["Podkategória"] === product["Podkategória"]
    );
    if (subIndex === -1) {
      return NextResponse.json(
        { error: "Subcategory not found." },
        { status: 400 }
      );
    }

    const placementIndex = (
      data[categoryIndex]["Podkategórie"][subIndex]["Zaradenia"] ?? []
    ).findIndex((p) => p["Zaradenie"] === product["Zaradenie"]);
    if (placementIndex === -1) {
      return NextResponse.json(
        { error: "Placement not found." },
        { status: 400 }
      );
    }

    const placement =
      data[categoryIndex]["Podkategórie"][subIndex]["Zaradenia"][
        placementIndex
      ];
    if (!placement["Produkty"]) placement["Produkty"] = [];

    const exists = placement["Produkty"].some(
      (p) =>
        normalizeKey(p["Názov"]) === normalizeKey(product["Názov"]) &&
        p["Kategória"] === product["Kategória"] &&
        p["Podkategória"] === product["Podkategória"] &&
        p["Zaradenie"] === product["Zaradenie"]
    );

    if (!exists) {
      placement["Produkty"].push(product);
      await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    }

    return NextResponse.json({ status: exists ? "exists" : "added" });
  } catch (err) {
    console.error("Append product error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
