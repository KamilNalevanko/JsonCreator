import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Verzia indexu slotov — `databazy/{country}/_indexes/{shop}.json`.
//
// Appka si sťahuje letáky LEN keď sa `version` líši od jej diskovej cache
// (lib/databazy_loader.dart). Keď sa teda prepíše slot a verzia ostane stará,
// telefóny, ktoré si dáta už stiahli, zmenu NIKDY neuvidia — presne tak ostali
// Niťovky v pečive, hoci v dátach už boli v cestovinách.
//
// Preto každá cesta, ktorá zapisuje do slotu, musí na konci zdvihnúť verziu.
// ---------------------------------------------------------------------------

const BUCKET = "cap-data";

/** Stiahne JSON mimo CDN cache (storage odpovede bývajú chvíľu cachované). */
async function downloadFreshJson(path: string): Promise<unknown | null> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  const url = `${base}/storage/v1/object/${BUCKET}/${path}?cb=${Date.now()}-${Math.random()}`;
  try {
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** `lidl_4.json` aj `lidl.json` → `lidl`. */
export function fileBaseFromSlotName(fileName: string): string {
  return fileName.replace(/\.json$/i, "").replace(/_\d+$/, "");
}

/** Zdvihne verziu indexu jedného obchodu. Vráti novú verziu, alebo null. */
export async function bumpIndexVersion(
  supabase: SupabaseClient,
  basePath: string,
  fileBase: string,
): Promise<string | null> {
  // Pár pokusov — keď verzia ostane stará, telefóny zmenu v letáku nevidia
  // (1. 10.: Tesco cena ostala v appkách stará, hoci slot už mal novú).
  for (let attempt = 0; attempt < 3; attempt++) {
    const version = await bumpIndexVersionOnce(supabase, basePath, fileBase);
    if (version) return version;
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
  return null;
}

async function bumpIndexVersionOnce(
  supabase: SupabaseClient,
  basePath: string,
  fileBase: string,
): Promise<string | null> {
  const indexPath = `${basePath}/_indexes/${fileBase}.json`;
  const loaded = await downloadFreshJson(indexPath);
  if (!loaded || typeof loaded !== "object") return null;
  const index = loaded as Record<string, unknown>;
  const version = new Date().toISOString();
  index.version = version;
  const up = await supabase.storage
    .from(BUCKET)
    .upload(indexPath, JSON.stringify(index, null, 2), {
      contentType: "application/json",
      upsert: true,
      cacheControl: "0",
    });
  return up.error ? null : version;
}

/**
 * Zdvihne verziu pre všetky obchody, ktorých slotov sa zápis dotkol.
 * Dostane názvy súborov (`lidl_4.json`, …) a vráti varovania pre tie obchody,
 * kde sa to nepodarilo — appky by im inak ukazovali starý obsah.
 */
export async function bumpIndexVersionsForFiles(
  supabase: SupabaseClient,
  basePath: string,
  fileNames: string[],
): Promise<string[]> {
  const warnings: string[] = [];
  const bases = [...new Set(fileNames.map(fileBaseFromSlotName))].filter(Boolean);
  for (const base of bases) {
    const version = await bumpIndexVersion(supabase, basePath, base);
    if (!version) {
      warnings.push(
        `${base}: verziu indexu sa nepodarilo zdvihnúť — appky môžu ešte ukazovať starý obsah.`,
      );
    }
  }
  return warnings;
}
