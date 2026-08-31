import { NextResponse } from "next/server";

import {
  deleteFlyerObjects,
  listFlyerObjects,
  putFlyerObject,
  readFlyerText,
  usingR2,
} from "../_lib/flyer-storage";

// ---------------------------------------------------------------------------
// Priebežné upratovanie úložiska letákov.
//
// Nahrávanie samo drží len posledné N letákov na obchod, ale keď sa do obchodu
// dlho nič nenahrá, ostanú tam staré (a dávno neplatné) letáky. Toto ich zmaže:
//
//  1. letáky staršie ako MAX_AGE_DAYS (podľa dátumu nahratia),
//  2. letáky nad rámec MAX_FLYERS_PER_SHOP,
//  3. „siroty" — priečinky so stranami, ktoré už v index.json nie sú
//     (napr. po prerušenom nahrávaní).
//
// Vždy sa nechá aspoň jeden najnovší leták, aby obchod neostal prázdny.
// Spúšťa sa tlačidlom v editore; `?dry=1` len vypíše, čo by zmazal.
// ---------------------------------------------------------------------------

const MAX_AGE_DAYS = 35;
const MAX_FLYERS_PER_SHOP = 3;
const COUNTRIES = ["sk", "cz", "pl"];

type FlyerEntry = {
  id: string;
  pages: number;
  dateFrom: string | null;
  dateTo: string | null;
  uploadedAt: string;
};

function ageInDays(entry: FlyerEntry): number {
  const stamp = Date.parse(entry.uploadedAt || "");
  const ms = Number.isNaN(stamp) ? Number(entry.id) : stamp;
  if (!ms || Number.isNaN(ms)) return 0;
  return (Date.now() - ms) / 86_400_000;
}

/** Kľúče pod `letaky/{country}/` → zoznam obchodov. */
async function shopsInCountry(country: string): Promise<string[]> {
  const keys = await listFlyerObjects(`letaky/${country}`);
  const shops = new Set<string>();
  for (const key of keys) {
    const parts = key.split("/");
    if (parts.length >= 3 && parts[2]) shops.add(parts[2]);
  }
  return [...shops];
}

export async function POST(req: Request) {
  const dryRun = new URL(req.url).searchParams.get("dry") === "1";
  try {
    const report: {
      shop: string;
      removedFlyers: string[];
      removedFiles: number;
    }[] = [];
    let totalFiles = 0;

    for (const country of COUNTRIES) {
      for (const shop of await shopsInCountry(country)) {
        const base = `letaky/${country}/${shop}`;
        const text = await readFlyerText(`${base}/index.json`);
        if (!text) continue;

        let flyers: FlyerEntry[] = [];
        let width: number | undefined;
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed?.flyers)) flyers = parsed.flyers;
          if (typeof parsed?.width === "number") width = parsed.width;
        } catch {
          continue;
        }
        if (!flyers.length) continue;

        // Najnovší ostáva vždy, aj keby bol starý — obchod nesmie ostať prázdny.
        const sorted = [...flyers].sort((a, b) => ageInDays(a) - ageInDays(b));
        const keep = sorted
          .slice(0, MAX_FLYERS_PER_SHOP)
          .filter((f, i) => i === 0 || ageInDays(f) <= MAX_AGE_DAYS);
        const keepIds = new Set(keep.map((f) => f.id));
        const dropped = sorted.filter((f) => !keepIds.has(f.id));

        // Siroty: priečinky strán, ktoré v indexe vôbec nie sú.
        const allKeys = await listFlyerObjects(base);
        const orphanIds = new Set<string>();
        for (const key of allKeys) {
          const rel = key.slice(base.length + 1);
          const folder = rel.split("/")[0];
          if (!folder || folder === "index.json") continue;
          if (!keepIds.has(folder) && !flyers.some((f) => f.id === folder)) {
            orphanIds.add(folder);
          }
        }

        const toDelete = [...dropped.map((f) => f.id), ...orphanIds];
        if (!toDelete.length) continue;

        let removedFiles = 0;
        for (const id of toDelete) {
          const paths = allKeys.filter((k) => k.startsWith(`${base}/${id}/`));
          removedFiles += paths.length;
          if (!dryRun) await deleteFlyerObjects(paths);
        }

        if (!dryRun && dropped.length) {
          await putFlyerObject(
            `${base}/index.json`,
            JSON.stringify({ flyers: keep, width }, null, 2),
            "application/json",
          );
        }

        totalFiles += removedFiles;
        report.push({ shop: `${country}/${shop}`, removedFlyers: toDelete, removedFiles });
      }
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      storage: usingR2 ? "r2" : "supabase",
      shopsTouched: report.length,
      removedFiles: totalFiles,
      detail: report,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Neznáma chyba";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
