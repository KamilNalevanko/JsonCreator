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
// Nahrávanie pri pridaní letáka vyhodí neplatné, ale keď sa do obchodu dlho
// nič nenahrá, ostanú tam staré (a dávno neplatné) letáky. Toto ich zmaže:
//
//  1. staré letáky bez dátumu platnosti, nahraté pred viac než MAX_AGE_DAYS,
//  2. letáky, ktorým skončila platnosť (platné a budúce nechá všetky),
//  3. „siroty" — priečinky so stranami, ktoré už v index.json nie sú
//     (napr. po prerušenom nahrávaní).
//
// Vždy sa nechá aspoň jeden najnovší leták, aby obchod neostal prázdny.
// Spúšťa sa tlačidlom v editore; `?dry=1` len vypíše, čo by zmazal.
// ---------------------------------------------------------------------------

const MAX_AGE_DAYS = 35;
const COUNTRIES = ["sk", "cz", "pl"];

type FlyerEntry = {
  id: string;
  pages: number;
  dateFrom: string | null;
  dateTo: string | null;
  uploadedAt: string;
};

/** Leták, ktorému skončila platnosť akcie — appka ho aj tak nezobrazuje.
 *  Dnešok v miestnom čase — `toISOString()` by prepol do UTC. */
function isExpired(entry: FlyerEntry): boolean {
  if (!entry.dateTo) return false;
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  return entry.dateTo < today;
}

/**
 * Má leták zostať? Rozhoduje PLATNOSŤ, nie poradie ani vek nahratia.
 *
 * Predtým sa bral prvé tri podľa dátumu nahratia a platný leták nahratý
 * pred viac než 35 dňami tiež vypadol. Letáky sa ale nahrávajú dopredu,
 * takže „najstarší nahratý" býva práve ten, ktorý dnes platí — presne tak
 * zmizol z Lidl CZ leták 17.–20. 9.
 *
 * Vek nahratia rozhoduje už len pri starých letákoch bez dátumu platnosti,
 * kde nič iné nemáme.
 */
function shouldKeep(entry: FlyerEntry): boolean {
  if (entry.dateTo) return !isExpired(entry);
  return ageInDays(entry) <= MAX_AGE_DAYS;
}

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

        const sorted = [...flyers].sort((a, b) => ageInDays(a) - ageInDays(b));
        // Platné a budúce sa nechávajú VŠETKY, bez ohľadu na limit — radšej
        // leták navyše než zmazať taký, čo ľudia práve čítajú.
        let keep = sorted.filter(shouldKeep);
        // Keď už nič neplatí, najnovší ostane, nech obchod nie je prázdny.
        if (keep.length === 0 && sorted.length > 0) keep = [sorted[0]];
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

        // Letáky, ktoré sú v indexe, ale ich strany už na úložisku nie sú
        // (napr. zmazané ručne cez Cloudflare) — treba ich z indexu vyhodiť,
        // inak appka ukazuje prázdnu kartu.
        const ghostIds = keep
          .filter(
            (f) => !allKeys.some((k: string) => k.startsWith(`${base}/${f.id}/`)),
          )
          .map((f) => f.id);
        const finalKeep = keep.filter((f) => !ghostIds.includes(f.id));

        const toDelete = [...dropped.map((f) => f.id), ...orphanIds];
        if (!toDelete.length && !ghostIds.length) continue;

        let removedFiles = 0;
        for (const id of toDelete) {
          const paths = allKeys.filter((k) => k.startsWith(`${base}/${id}/`));
          removedFiles += paths.length;
          if (!dryRun) await deleteFlyerObjects(paths);
        }

        if (!dryRun && (dropped.length || ghostIds.length)) {
          await putFlyerObject(
            `${base}/index.json`,
            JSON.stringify({ flyers: finalKeep, width }, null, 2),
            "application/json",
          );
        }

        totalFiles += removedFiles;
        report.push({
          shop: `${country}/${shop}`,
          removedFlyers: [...toDelete, ...ghostIds],
          removedFiles,
        });
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
