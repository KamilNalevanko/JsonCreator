import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Recepty pre sekciu Recepty v appke. Jeden súbor na jazyk appky:
//   cap-data/recepty/<sk|cs|pl>.json   { version, updatedAt, recipes: [...] }
// Obrázky: cap-data/recepty/img/<id>-<čas>.jpg (v recepte relatívna cesta).
// Kým súbor na serveri nie je, začína sa z ukážkových receptov, ktoré má
// appka zabalené (inak by po prvom uložení ukážky z appky zmizli).
// ---------------------------------------------------------------------------

export const BUCKET = "cap-data";

export type RecipeLang = "sk" | "cs" | "pl";

/** Sekcie a kategórie receptov — musia sedieť s kostrou v appke. */
export const RECIPE_CATEGORIES: Record<string, string[]> = {
  masite: ["hydina", "bravcove", "hovadzie", "zajac", "jahnacina", "ryby"],
  bezmasite: ["zeleninove", "strukoviny", "syrove_tofu", "sladke_jedla"],
  cestoviny: ["cestoviny_jedla", "halusky", "rizota"],
  polievky: ["vyvary", "kremove", "syte"],
  pecenie: ["hrnckove", "zakusky", "nepecene", "chlieb", "slane_kolace"],
  prilohy: ["zemiaky", "ryza", "cestoviny_prilohy", "knedle"],
};

export type RecipeIngredient = {
  name: string;
  amount?: string;
  zaradenie?: { c: string; s: string; p: string };
  produkt?: { name: string; shop: string };
};

export type Recipe = {
  id: string;
  section: string;
  category: string;
  title: string;
  image: string;
  timeMin: number;
  difficulty: number;
  servings: number;
  ingredients: RecipeIngredient[];
  steps: string[];
};

type RecipeFile = { version: number; updatedAt?: string; recipes: Recipe[] };


/** Editor používa pre Česko "cz", appka "cs". */
export function toLang(country: string): RecipeLang | null {
  const c = (country || "").toLowerCase().trim();
  if (c === "cz" || c === "cs") return "cs";
  if (c === "sk" || c === "pl") return c;
  return null;
}

export function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) throw new Error("Chýba SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Načíta recepty VŽDY čerstvé. Pozor: autorizované sťahovanie zo Supabase ide
 * cez CDN a vracalo aj minútu starý súbor — editor potom pri uložení prepísal
 * medzitým pridané recepty. Verejná adresa s unikátnym parametrom a súbor
 * uložený s `no-cache` sú vždy aktuálne (overené).
 */
export async function readRecipes(
  lang: RecipeLang,
): Promise<{ recipes: Recipe[]; fromSamples: boolean }> {
  const base = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("Chýba SUPABASE_URL.");
  const res = await fetch(
    `${base}/storage/v1/object/public/${BUCKET}/recepty/${lang}.json?t=${Date.now()}-${Math.random().toString(36).slice(2)}`,
    { cache: "no-store", headers: { "Cache-Control": "no-cache" } },
  );
  if (res.status === 400 || res.status === 404) {
    const text = await res.text();
    // Súbor ešte neexistuje → prázdny zoznam. Iná chyba → radšej nič neukladať.
    if (/not_found|NoSuchKey|Object not found/i.test(text)) {
      return { recipes: [], fromSamples: false };
    }
    throw new Error(`Recepty sa nedali načítať (${res.status}).`);
  }
  if (!res.ok) throw new Error(`Recepty sa nedali načítať (${res.status}).`);
  const parsed = (await res.json()) as RecipeFile;
  if (!Array.isArray(parsed.recipes)) throw new Error("Súbor s receptami je poškodený.");
  return { recipes: parsed.recipes, fromSamples: false };
}

// Zápisy jedného jazyka idú po sebe — dve uloženia naraz by si inak
// navzájom prepísali zoznam (čítaj → uprav → zapíš).
const locks = new Map<RecipeLang, Promise<unknown>>();
export function withRecipeLock<T>(lang: RecipeLang, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(lang) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(lang, next);
  return next;
}

export async function writeRecipes(lang: RecipeLang, recipes: Recipe[]): Promise<void> {
  const body: RecipeFile = { version: 1, updatedAt: new Date().toISOString(), recipes };
  const { error } = await getSupabase()
    .storage.from(BUCKET)
    .upload(`recepty/${lang}.json`, Buffer.from(JSON.stringify(body), "utf8"), {
      contentType: "application/json",
      upsert: true,
      // no-cache: appka aj editor dostanú po uložení hneď novú verziu.
      cacheControl: "no-cache",
    });
  if (error) throw new Error(error.message);
}

/** Očistí recept z formulára — nech do appky nejde nič rozbité. */
export function sanitizeRecipe(r: Partial<Recipe>): Recipe {
  const num = (v: unknown, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : def;
  };
  return {
    id: (r.id || "").toString().trim(),
    section: (r.section || "").toString().trim(),
    category: (r.category || "").toString().trim(),
    title: (r.title || "").toString().trim(),
    image: (r.image || "").toString().trim(),
    timeMin: num(r.timeMin, 0),
    difficulty: Math.min(3, Math.max(1, num(r.difficulty, 1))),
    servings: num(r.servings, 4),
    ingredients: (r.ingredients || [])
      .map((i) => {
        const out: RecipeIngredient = {
          name: (i?.name || "").toString().trim(),
          amount: (i?.amount || "").toString().trim(),
        };
        if (i?.zaradenie?.p) {
          out.zaradenie = {
            c: i.zaradenie.c || "",
            s: i.zaradenie.s || "",
            p: i.zaradenie.p,
          };
        }
        if (i?.produkt?.name) {
          out.produkt = { name: i.produkt.name, shop: i.produkt.shop || "" };
        }
        return out;
      })
      .filter((i) => i.name),
    steps: (r.steps || []).map((s) => (s || "").toString().trim()).filter(Boolean),
  };
}

export function slugify(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "recept"
  );
}
