import { NextResponse } from "next/server";
import hierarchyData from "../../../../assets/hierarchia.json";
import skLabels from "../../../../assets/langs/sk.json";
import { RECIPE_CATEGORIES, type Recipe } from "../_store";

// AI pomocník pre recepty (cez rovnakú Supabase funkciu ako čítanie letákov):
//  • action "parse"     — z vloženého textu poskladá recept a ingredienciám
//                          navrhne zaradenie v appke,
//  • action "translate" — preloží recept do češtiny / poľštiny (štruktúra,
//                          zaradenia a obrázok ostávajú).

type HierPlacement = { Zaradenie: string };
type HierSub = { "Podkategória": string; Zaradenia: HierPlacement[] };
type HierCat = { "Kategória": string; "Podkategórie": HierSub[] };
const HIERARCHY = hierarchyData as unknown as HierCat[];
const LABELS = skLabels as Record<string, string>;

const PLACEMENTS = HIERARCHY.flatMap((c) =>
  (c["Podkategórie"] || []).flatMap((s) =>
    (s.Zaradenia || []).map((z) => ({
      key: `${c["Kategória"]}|${s["Podkategória"]}|${z.Zaradenie}`,
      label: `${LABELS[c["Kategória"]] || c["Kategória"]} › ${LABELS[s["Podkategória"]] || s["Podkategória"]} › ${LABELS[z.Zaradenie] || z.Zaradenie}`,
    })),
  ),
);
const VALID = new Set(PLACEMENTS.map((p) => p.key));

const CATEGORIES = RECIPE_CATEGORIES;

const SECTIONS = `masite: hydina, bravcove, hovadzie, zajac, jahnacina, ryby
bezmasite: zeleninove, strukoviny, syrove_tofu, sladke_jedla (palacinky, parené buchty)
cestoviny: cestoviny_jedla, halusky (halušky, gnocchi, pirohy), rizota
polievky: vyvary (vývary a čisté), kremove (krémové a zeleninové), syte (sýte polievky)
pecenie: hrnckove (hrnčekové koláče), zakusky (zákusky a krémové koláče), nepecene (nepečené dezerty), chlieb (chlieb a pečivo), slane_kolace (slané koláče a pizza)
prilohy: zemiaky, ryza, cestoviny_prilohy, knedle`;

const LANG_NAMES: Record<string, string> = { sk: "Slovak", cs: "Czech", pl: "Polish" };

async function chat(system: string, user: string): Promise<Record<string, unknown>> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  const fn = process.env.SUPABASE_OPENAI_FUNCTION || "openai-chat-completion";
  if (!supabaseUrl || !anon) throw new Error("Chýba Supabase URL / anon kľúč v .env.local.");
  const model = (process.env.OPENAI_RECIPE_MODEL || "gpt-4.1-mini").trim();
  const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anon,
      Authorization: `Bearer ${anon}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      temperature: 0,
      max_completion_tokens: 6000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AI zlyhala (${res.status}): ${text.slice(0, 300)}`);
  const data = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

async function parseRecipe(text: string, lang: string) {
  const system = `You turn a free-form cooking recipe into structured JSON for a grocery app.
Write all texts in ${LANG_NAMES[lang] || "Slovak"} (keep the author's wording, fix only obvious typos).
Return JSON: {"title","section","category","timeMin","difficulty","servings","ingredients":[{"name","amount","placement"}],"steps":[...]}
- section/category: pick EXACTLY one key from this list (section: categories); never invent other keys (chicken = hydina, pork = bravcove, beef = hovadzie):
${SECTIONS}
- timeMin: total minutes (integer); difficulty: 1 easy, 2 medium, 3 hard; servings: integer (default 4).
- ingredients: one per item. "name" = the grocery item in nominative (e.g. "Kuracie stehná", "Cesnak"), "amount" = quantity with unit ("8 ks", "2 PL", "podľa chuti").
  Split combined lines like "soľ, korenie" into separate ingredients.
- placement: the key from PLACEMENT LIST that best matches what you would buy in a shop, or "" if nothing fits (e.g. water, fresh herbs not in the list). Use ONLY keys from the list.
- steps: short imperative steps without numbering.

PLACEMENT LIST (key = label):
${PLACEMENTS.map((p) => `${p.key} = ${p.label}`).join("\n")}`;
  const out = await chat(system, text);
  const ingredients = (Array.isArray(out.ingredients) ? out.ingredients : []).map(
    (i: Record<string, unknown>) => {
      const key = (i.placement || "").toString();
      const [c, s, p] = key.split("|");
      return {
        name: (i.name || "").toString(),
        amount: (i.amount || "").toString(),
        ...(VALID.has(key) ? { zaradenie: { c, s, p } } : {}),
      };
    },
  );
  return {
    title: (out.title || "").toString(),
    section: CATEGORIES[String(out.section)] ? String(out.section) : "",
    category: (CATEGORIES[String(out.section)] || []).includes(String(out.category))
      ? String(out.category)
      : "",
    timeMin: Number(out.timeMin) || 0,
    difficulty: Number(out.difficulty) || 1,
    servings: Number(out.servings) || 4,
    ingredients,
    steps: (Array.isArray(out.steps) ? out.steps : []).map((s) => String(s)),
  };
}

async function translateRecipe(recipe: Recipe, to: string): Promise<Recipe> {
  const system = `Translate this recipe to ${LANG_NAMES[to]}. Return JSON {"title","ingredients":[{"name","amount"}],"steps":[...]}
with exactly the same number and order of ingredients and steps. Use natural culinary terms of the target country
(units like "PL" → "lžíce"/"łyżki", "ČL" → "lžička"/"łyżeczka", "ks" → "ks"/"szt.").`;
  const out = await chat(
    system,
    JSON.stringify({
      title: recipe.title,
      ingredients: recipe.ingredients.map((i) => ({ name: i.name, amount: i.amount || "" })),
      steps: recipe.steps,
    }),
  );
  const ti = Array.isArray(out.ingredients) ? (out.ingredients as Record<string, unknown>[]) : [];
  const ts = Array.isArray(out.steps) ? (out.steps as unknown[]) : [];
  return {
    ...recipe,
    title: (out.title || recipe.title).toString(),
    ingredients: recipe.ingredients.map((i, idx) => ({
      ...i,
      name: (ti[idx]?.name || i.name).toString(),
      amount: (ti[idx]?.amount ?? i.amount ?? "").toString(),
      // Konkrétny produkt je zo slovenských akcií — v inej krajine neplatí.
      produkt: undefined,
    })),
    steps: recipe.steps.map((s, idx) => (ts[idx] ?? s).toString()),
  };
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action === "parse") {
      const text = (body?.text || "").toString().trim();
      if (text.length < 20) {
        return NextResponse.json({ ok: false, error: "Vlož text receptu." }, { status: 400 });
      }
      const lang = body?.country === "cz" ? "cs" : (body?.country || "sk").toString();
      return NextResponse.json({ ok: true, recipe: await parseRecipe(text, lang) });
    }
    if (body?.action === "translate") {
      const to = (body?.to || "").toString();
      if (!["cs", "pl"].includes(to)) {
        return NextResponse.json({ ok: false, error: "Neplatný jazyk." }, { status: 400 });
      }
      return NextResponse.json({ ok: true, recipe: await translateRecipe(body.recipe as Recipe, to) });
    }
    return NextResponse.json({ ok: false, error: "Neznáma akcia." }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
