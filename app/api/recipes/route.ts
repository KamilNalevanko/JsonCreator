import { NextResponse } from "next/server";
import {
  RECIPE_CATEGORIES,
  readRecipes,
  sanitizeRecipe,
  slugify,
  toLang,
  writeRecipes,
  withRecipeLock,
  type Recipe,
} from "./_store";

// Recepty pre appku: zoznam, uloženie (nový / úprava) a zmazanie.
// GET    /api/recipes?country=sk
// POST   /api/recipes   { country, recipe }        → uloží a vráti recept
// DELETE /api/recipes?country=sk&id=...

function err(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function GET(req: Request) {
  try {
    const lang = toLang(new URL(req.url).searchParams.get("country") || "");
    if (!lang) return err("Neplatná krajina.");
    const { recipes, fromSamples } = await readRecipes(lang);
    return NextResponse.json({ ok: true, recipes, fromSamples });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const lang = toLang(body?.country || "");
    if (!lang) return err("Neplatná krajina.");
    const recipe = sanitizeRecipe((body?.recipe || {}) as Partial<Recipe>);
    if (!recipe.title) return err("Recept nemá názov.");
    if (!(RECIPE_CATEGORIES[recipe.section] || []).includes(recipe.category)) {
      return err("Vyber sekciu a kategóriu (neznáma kategória).");
    }
    if (!recipe.ingredients.length) return err("Pridaj aspoň jednu ingredienciu.");
    if (!recipe.steps.length) return err("Pridaj aspoň jeden krok postupu.");

    await withRecipeLock(lang, async () => {
      const { recipes } = await readRecipes(lang);
      if (!recipe.id) {
        // Rovnaké id vo všetkých jazykoch → obľúbené a preklady k sebe sedia.
        const base = (body?.id || "").toString().trim() || slugify(recipe.title);
        let id = base;
        for (let n = 2; recipes.some((r) => r.id === id); n++) id = `${base}-${n}`;
        recipe.id = id;
      }
      const idx = recipes.findIndex((r) => r.id === recipe.id);
      // Nové recepty idú navrch, nech ich ľudia v appke vidia hneď.
      if (idx >= 0) recipes[idx] = recipe;
      else recipes.unshift(recipe);
      await writeRecipes(lang, recipes);
    });
    return NextResponse.json({ ok: true, recipe });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
}

export async function DELETE(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const lang = toLang(params.get("country") || "");
    const id = (params.get("id") || "").trim();
    if (!lang || !id) return err("Chýba krajina alebo id.");
    const removed = await withRecipeLock(lang, async () => {
      const { recipes } = await readRecipes(lang);
      const next = recipes.filter((r) => r.id !== id);
      if (next.length === recipes.length) return false;
      await writeRecipes(lang, next);
      return true;
    });
    if (!removed) return err("Recept sa nenašiel.", 404);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
}
