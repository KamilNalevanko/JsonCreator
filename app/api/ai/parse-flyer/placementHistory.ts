import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Pamäť zaradení: kam sa produkty s rovnakým (očisteným) názvom zaraďovali
// doteraz. Bez ďalšieho volania AI — len spočítané riadky z master_products_v2.
//
//  • vote(name)      → najčastejšie zaradenie a koľkokrát (napr. pliecko 5 z 6),
//  • topPairs(shop)  → najčastejšie produkty obchodu ako príklady pre AI
//                      (namiesto prvých N náhodných riadkov).
//
// História obsahuje aj staré chyby, preto sa používa opatrne: návrh až pri
// jasnej väčšine, automatická oprava len pri veľmi silnej zhode (prahy nižšie).
// ---------------------------------------------------------------------------

export const HISTORY_SUGGEST_MIN = Number(process.env.HISTORY_SUGGEST_MIN || 3);
export const HISTORY_SUGGEST_SHARE = Number(process.env.HISTORY_SUGGEST_SHARE || 0.75);
export const HISTORY_AUTO_MIN = Number(process.env.HISTORY_AUTO_MIN || 5);
export const HISTORY_AUTO_SHARE = Number(process.env.HISTORY_AUTO_SHARE || 0.9);

const CACHE_MS = 30 * 60 * 1000;
const PAGE = 1000;
const PARALLEL = 6;

// Obchody a vlastné značky na začiatku názvu nemenia, čo produkt JE.
const NOISE_WORDS = new Set([
  "lidl", "kaufland", "billa", "tesco", "coop", "jednota", "biedronka", "albert",
  "auchan", "carrefour", "globus", "penny", "dino", "zabka", "netto", "terno",
  "fresh", "kraj", "k", "classic", "clever", "pilos", "milbona", "chef", "select",
  "purland", "pult", "z", "zo", "s", "so", "na", "v", "vo", "a", "i", "w", "ze",
  "cca", "akcia", "novinka", "plus", "extra", "super", "cena",
]);

/**
 * Kľúč názvu: bez diakritiky, čísel, gramáží, obchodov a výplňových slov;
 * slová skrátené na koreň (5 písmen, „pliecko“ = „pliecka“) a bez ohľadu na
 * poradie. Overené na 86 tis. zaradeniach: návrh sedí v ~95 % prípadov.
 */
export function historyKey(name: string): string {
  const base = (name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\d+([.,]\d+)?\s*(%|x|ks|kg|g|ml|cl|dl|l)\b/g, " ")
    .replace(/[^\p{L}\s]/gu, " ");
  const roots = new Set(
    base
      .split(/\s+/)
      .filter((w) => w.length > 1 && !NOISE_WORDS.has(w))
      .map((w) => w.slice(0, 5)),
  );
  return [...roots].sort().join(" ");
}

export type HistoryVote = {
  placementKey: string;
  count: number; // koľkokrát toto zaradenie
  total: number; // koľkokrát sa názov vyskytol celkovo
  share: number;
};

type Bucket = { name: string; counts: Map<string, number>; shops: Map<string, number> };

export type PlacementHistory = {
  size: number;
  vote(name: string): HistoryVote | null;
  topPairs(shop: string, limit: number): string[];
};

const cache = new Map<string, { at: number; history: Promise<PlacementHistory> }>();

function build(rows: { name: string; placement: string; shop: string }[]): PlacementHistory {
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const key = historyKey(r.name);
    if (!key || !r.placement) continue;
    let b = buckets.get(key);
    if (!b) {
      b = { name: r.name, counts: new Map(), shops: new Map() };
      buckets.set(key, b);
    }
    b.counts.set(r.placement, (b.counts.get(r.placement) || 0) + 1);
    b.shops.set(r.shop, (b.shops.get(r.shop) || 0) + 1);
  }

  const voteOf = (b: Bucket): HistoryVote => {
    let best = "";
    let bestCount = 0;
    let total = 0;
    for (const [pk, c] of b.counts) {
      total += c;
      if (c > bestCount) {
        best = pk;
        bestCount = c;
      }
    }
    return { placementKey: best, count: bestCount, total, share: total ? bestCount / total : 0 };
  };

  return {
    size: buckets.size,
    vote(name) {
      const b = buckets.get(historyKey(name));
      return b ? voteOf(b) : null;
    },
    topPairs(shop, limit) {
      const shopKey = (shop || "").toLowerCase();
      const ranked: { name: string; pk: string; n: number }[] = [];
      for (const b of buckets.values()) {
        const v = voteOf(b);
        if (v.total < 2 || v.share < HISTORY_SUGGEST_SHARE) continue;
        const inShop = shopKey
          ? [...b.shops.entries()].some(([s]) => (s || "").toLowerCase().startsWith(shopKey.split("-")[0]))
          : true;
        // Produkty tohto obchodu dostanú prednosť, potom zvyšok krajiny.
        ranked.push({ name: b.name, pk: v.placementKey, n: v.total + (inShop ? 1_000_000 : 0) });
      }
      ranked.sort((a, b) => b.n - a.n);
      return ranked.slice(0, limit).map((r) => `${r.name}→${r.pk}`);
    },
  };
}

async function load(db: SupabaseClient, country: string): Promise<PlacementHistory> {
  const t0 = Date.now();
  const { count } = await db
    .from("master_products_v2")
    .select("id", { count: "exact", head: true })
    .eq("country", country)
    .neq("placement", "");
  const total = count || 0;
  const rows: { name: string; placement: string; shop: string }[] = [];
  const offsets: number[] = [];
  for (let o = 0; o < total; o += PAGE) offsets.push(o);
  for (let i = 0; i < offsets.length; i += PARALLEL) {
    const pages = await Promise.all(
      offsets.slice(i, i + PARALLEL).map(async (o) => {
        const { data, error } = await db
          .from("master_products_v2")
          .select("name, placement, shop")
          .eq("country", country)
          .neq("placement", "")
          .order("id")
          .range(o, o + PAGE - 1);
        if (error) throw error;
        return data || [];
      }),
    );
    for (const p of pages) rows.push(...p);
  }
  const history = build(rows);
  console.log(
    `[history] ${country}: ${rows.length} zaradení → ${history.size} názvov (${Date.now() - t0} ms)`,
  );
  return history;
}

/** História krajiny, v pamäti 30 min (editor ju pri ďalšom letáku nesťahuje znova). */
export function getPlacementHistory(db: SupabaseClient, country: string): Promise<PlacementHistory> {
  const hit = cache.get(country);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.history;
  const history = load(db, country).catch((e) => {
    cache.delete(country);
    throw e;
  });
  cache.set(country, { at: Date.now(), history });
  return history;
}
