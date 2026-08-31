import { NextResponse } from "next/server";

import {
  deleteFlyerObjects,
  listFlyerObjects,
  putFlyerObject,
  readFlyerText,
  R2_PUBLIC_URL,
  usingR2,
} from "../_lib/flyer-storage";

// ---------------------------------------------------------------------------
// Prehľad letákov v appke + mazanie.
//
//  GET    /api/flyers?country=sk   → čo je v appke pre danú krajinu
//  DELETE /api/flyers              → zmaže jeden leták (strany + záznam v indexe)
//
// Mazanie ide vždy cez toto API, nie ručne v Cloudflare — inak by v indexe
// ostal záznam bez strán a appka by ukazovala prázdnu kartu.
// ---------------------------------------------------------------------------

const COUNTRIES = ["sk", "cz", "pl"];
const SUPABASE_PUBLIC =
  (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "") +
  "/storage/v1/object/public/cap-data";

type FlyerEntry = {
  id: string;
  pages: number;
  dateFrom: string | null;
  dateTo: string | null;
  uploadedAt: string;
};

/** Základ verejnej adresy — podľa toho, kde letáky reálne ležia. */
function publicRoot(): string {
  return usingR2 ? R2_PUBLIC_URL : SUPABASE_PUBLIC;
}

async function shopsInCountry(country: string): Promise<string[]> {
  const keys = await listFlyerObjects(`letaky/${country}`);
  const shops = new Set<string>();
  for (const key of keys) {
    const parts = key.split("/");
    if (parts.length >= 3 && parts[2]) shops.add(parts[2]);
  }
  return [...shops].sort();
}

async function readIndex(
  base: string,
): Promise<{ flyers: FlyerEntry[]; width?: number }> {
  const text = await readFlyerText(`${base}/index.json`);
  if (!text) return { flyers: [] };
  try {
    const parsed = JSON.parse(text);
    return {
      flyers: Array.isArray(parsed?.flyers) ? parsed.flyers : [],
      width: typeof parsed?.width === "number" ? parsed.width : undefined,
    };
  } catch {
    return { flyers: [] };
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const only = (url.searchParams.get("country") || "").toLowerCase();
    const countries = COUNTRIES.includes(only) ? [only] : COUNTRIES;

    const result: {
      country: string;
      shop: string;
      flyers: (FlyerEntry & { cover: string })[];
    }[] = [];

    for (const country of countries) {
      for (const shop of await shopsInCountry(country)) {
        const base = `letaky/${country}/${shop}`;
        const { flyers } = await readIndex(base);
        if (!flyers.length) continue;
        result.push({
          country,
          shop,
          flyers: flyers.map((f) => ({
            ...f,
            cover: `${publicRoot()}/${base}/${f.id}/p1.jpg`,
          })),
        });
      }
    }

    return NextResponse.json({ ok: true, storage: usingR2 ? "r2" : "supabase", shops: result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Neznáma chyba";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const country = (body?.country || "").toString().toLowerCase().trim();
    const shop = (body?.shop || "").toString().trim();
    const flyerId = (body?.flyerId || "").toString().trim();

    if (!COUNTRIES.includes(country) || !shop || !flyerId) {
      return NextResponse.json(
        { ok: false, error: "Chýba krajina, obchod alebo leták." },
        { status: 400 },
      );
    }

    const base = `letaky/${country}/${shop}`;
    const { flyers, width } = await readIndex(base);

    // Najprv index (aby appka leták prestala ponúkať), až potom strany —
    // opačné poradie by na chvíľu nechalo v appke prázdnu kartu.
    const rest = flyers.filter((f) => f.id !== flyerId);
    await putFlyerObject(
      `${base}/index.json`,
      JSON.stringify({ flyers: rest, width }, null, 2),
      "application/json",
    );

    const paths = await listFlyerObjects(`${base}/${flyerId}`);
    const removed = await deleteFlyerObjects(paths);

    return NextResponse.json({ ok: true, removedFiles: removed, remaining: rest.length });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Neznáma chyba";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
