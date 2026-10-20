"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import hierarchyData from "../../assets/hierarchia.json";

// ---------------------------------------------------------------------------
// Recepty do appky (sekcia Recepty). Zoznam receptov krajiny + formulár so
// všetkým, čo appka zobrazuje: obrázok, čas, náročnosť, porcie, ingrediencie
// (zaradenie / konkrétny produkt / vlastná položka) a postup. Uloženie ho
// hneď zverejní v appke; voliteľne preloží do CZ/PL a pošle notifikáciu.
// ---------------------------------------------------------------------------

type Country = "sk" | "cz" | "pl";
type Lang = "sk" | "cs" | "pl";
const LANG_OF: Record<Country, Lang> = { sk: "sk", cz: "cs", pl: "pl" };
const FLAG: Record<Country, string> = { sk: "🇸🇰", cz: "🇨🇿", pl: "🇵🇱" };
// Názvy krajín v pádoch: „v Česku“, „do Česka“, „pre Česko“.
const COUNTRY_NAME = {
  v: { sk: "Slovensku", cz: "Česku", pl: "Poľsku" },
  do: { sk: "Slovenska", cz: "Česka", pl: "Poľska" },
  pre: { sk: "Slovensko", cz: "Česko", pl: "Poľsko" },
} as const;
/** Ostatné krajiny okrem [c], napr. „Česku a Poľsku“. */
const others = (c: Country, pad: keyof typeof COUNTRY_NAME = "v") =>
  (["sk", "cz", "pl"] as Country[])
    .filter((x) => x !== c)
    .map((x) => COUNTRY_NAME[pad][x])
    .join(" a ");

type HierPlacement = { Zaradenie: string };
type HierSub = { "Podkategória": string; Zaradenia: HierPlacement[] };
type HierCat = { "Kategória": string; "Podkategórie": HierSub[] };
const HIERARCHY = hierarchyData as unknown as HierCat[];

type Zar = { c: string; s: string; p: string };
type Ingredient = {
  name: string;
  amount: string;
  mode: "zaradenie" | "produkt" | "vlastna";
  zaradenie?: Zar;
  produkt?: { name: string; shop: string };
};
type Recipe = {
  id: string;
  section: string;
  category: string;
  title: string;
  image: string;
  timeMin: number;
  difficulty: number;
  servings: number;
  ingredients: Ingredient[];
  steps: string[];
  publishAt?: string;
};
type StoredIngredient = Omit<Ingredient, "mode">;
type ProductHit = {
  name: string;
  shop: string;
  category: string;
  subcategory: string;
  placement: string;
  price_sale: string;
  active: boolean;
};

// Kostra receptov — rovnaká ako v appke (lib/recepty/recipe_catalog.dart).
const SECTIONS: { key: string; label: string; categories: { key: string; label: string }[] }[] = [
  { key: "masite", label: "Mäsité", categories: [
    { key: "hydina", label: "Hydina" }, { key: "bravcove", label: "Bravčové" },
    { key: "hovadzie", label: "Hovädzie" }, { key: "zajac", label: "Zajac" },
    { key: "jahnacina", label: "Jahňacina" }, { key: "ryby", label: "Ryby a morské plody" },
  ] },
  { key: "bezmasite", label: "Bezmäsité", categories: [
    { key: "zeleninove", label: "Zeleninové jedlá a šaláty" },
    { key: "strukoviny", label: "Jedlá zo strukovín a obilnín" },
    { key: "syrove_tofu", label: "Syrové jedlá a tofu" },
    { key: "sladke_jedla", label: "Sladké jedlá (palacinky, parené buchty)" },
  ] },
  { key: "cestoviny", label: "Cestoviny, halušky a rizotá", categories: [
    { key: "cestoviny_jedla", label: "Cestoviny" },
    { key: "halusky", label: "Halušky, gnocchi a pirohy" },
    { key: "rizota", label: "Rizotá" },
  ] },
  { key: "polievky", label: "Polievky", categories: [
    { key: "vyvary", label: "Vývary a čisté polievky" },
    { key: "kremove", label: "Krémové a zeleninové" },
    { key: "syte", label: "Sýte polievky" },
  ] },
  { key: "pecenie", label: "Sladké a pečenie", categories: [
    { key: "hrnckove", label: "Rýchle hrnčekové koláče" },
    { key: "zakusky", label: "Zákusky a krémové koláče" },
    { key: "nepecene", label: "Nepečené dezerty" },
    { key: "chlieb", label: "Domáci chlieb a pečivo" },
    { key: "slane_kolace", label: "Slané koláče a pizza" },
  ] },
  { key: "prilohy", label: "Prílohy", categories: [
    { key: "zemiaky", label: "Zemiaky" }, { key: "ryza", label: "Ryža" },
    { key: "cestoviny_prilohy", label: "Cestoviny" }, { key: "knedle", label: "Knedle" },
  ] },
];

// Kým nie je vonku verzia appky so sekciou Recepty, staršie appky by
// notifikáciu s receptom nevedeli otvoriť — push ide len na testovací telefón.
// Po vydaní appky prepnúť na true.
const RECIPE_PUSH_TO_ALL = false;

const PUSH_TEXT: Record<Lang, string> = {
  sk: "🍲 Nový recept — pozri si ho v appke",
  cs: "🍲 Nový recept — podívej se na něj v appce",
  pl: "🍲 Nowy przepis — zobacz go w aplikacji",
};

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");

function imageSrc(image: string): string {
  if (!image) return "";
  if (image.startsWith("http")) return image;
  // Ukážkové recepty majú obrázok zabalený v appke — v editore z public/.
  if (image.startsWith("assets/images/recepty/")) {
    return `/recepty-samples/${image.split("/").pop()}`;
  }
  return `${SUPABASE_URL}/storage/v1/object/public/cap-data/${image}`;
}

/** ISO čas → hodnota pre <input type="datetime-local"> (miestny čas). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const isScheduled = (r: { publishAt?: string }) =>
  !!r.publishAt && Date.parse(r.publishAt) > Date.now();

function emptyRecipe(): Recipe {
  return {
    id: "",
    section: "",
    category: "",
    title: "",
    image: "",
    timeMin: 30,
    difficulty: 1,
    servings: 4,
    ingredients: [{ name: "", amount: "", mode: "zaradenie" }],
    steps: [],
  };
}

function fromStored(r: Omit<Recipe, "ingredients"> & { ingredients: StoredIngredient[] }): Recipe {
  return {
    ...r,
    ingredients: r.ingredients.map((i) => ({
      ...i,
      amount: i.amount || "",
      mode: i.produkt?.name ? "produkt" : i.zaradenie?.p ? "zaradenie" : "vlastna",
    })),
  };
}

function toStored(r: Recipe) {
  return {
    ...r,
    ingredients: r.ingredients
      .filter((i) => i.name.trim())
      .map((i) => ({
        name: i.name.trim(),
        amount: i.amount.trim(),
        ...(i.mode !== "vlastna" && i.zaradenie?.p ? { zaradenie: i.zaradenie } : {}),
        ...(i.mode === "produkt" && i.produkt?.name ? { produkt: i.produkt } : {}),
      })),
    steps: r.steps.map((s) => s.trim()).filter(Boolean),
  };
}

/** Zmenší fotku v prehliadači (max 1200 px, JPEG) pred nahraním. */
async function shrinkImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function RecipeForm({
  country,
  testToken,
  labelFor,
}: {
  country: Country;
  /** Vyplnený = notifikácia ide len na tento telefón (testovací režim). */
  testToken: string;
  labelFor: (key?: string) => string;
}) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [fromSamples, setFromSamples] = useState(false);
  // Filter zoznamu ako dlaždice v appke: sekcia → kategória ("" = všetky).
  const [fSection, setFSection] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Recipe | null>(null);
  // Stav receptu pri otvorení — podľa neho sa pri odchode pýtame na zmeny.
  const openedRef = useRef<string>("");
  const [isNew, setIsNew] = useState(true);
  const [aiText, setAiText] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [translate, setTranslate] = useState(true);
  const [notify, setNotify] = useState(false);
  // Časovač: recept sa v appke ukáže (a notifikácia odíde) až v zadaný čas.
  const [scheduleOn, setScheduleOn] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/recipes?country=${country}`);
      const json = await res.json();
      if (json.ok) {
        setRecipes((json.recipes || []).map(fromStored));
        setFromSamples(!!json.fromSamples);
      } else setMsg({ ok: false, text: json.error });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setEditing(null);
    setMsg(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country]);

  const startNew = () => {
    const fresh = emptyRecipe();
    openedRef.current = JSON.stringify(fresh);
    setEditing(fresh);
    setIsNew(true);
    setTranslate(true);
    setNotify(false);
    setScheduleOn(false);
    setScheduleAt("");
    setAiText("");
    setMsg(null);
  };

  const startEdit = (r: Recipe) => {
    openedRef.current = JSON.stringify(r);
    setEditing(structuredClone(r));
    setIsNew(false);
    // Úprava slovenského receptu sa predvolene prenesie aj do CZ/PL, nech sú
    // všetky krajiny rovnaké. Úprava CZ/PL býva oprava prekladu — tá nie.
    setTranslate(country === "sk");
    setNotify(false);
    setScheduleOn(isScheduled(r));
    setScheduleAt(isScheduled(r) ? toLocalInput(r.publishAt!) : "");
    setAiText("");
    setMsg(null);
  };

  const set = (patch: Partial<Recipe>) => setEditing((e) => (e ? { ...e, ...patch } : e));
  const setIng = (idx: number, patch: Partial<Ingredient>) =>
    setEditing((e) =>
      e ? { ...e, ingredients: e.ingredients.map((i, n) => (n === idx ? { ...i, ...patch } : i)) } : e,
    );

  const runAi = async () => {
    if (!editing) return;
    setBusy("ai");
    setMsg(null);
    try {
      const res = await fetch("/api/recipes/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "parse", text: aiText, country }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      const r = json.recipe;
      set({
        title: r.title || editing.title,
        section: r.section || editing.section,
        category: r.category || editing.category,
        timeMin: r.timeMin || editing.timeMin,
        difficulty: r.difficulty || editing.difficulty,
        servings: r.servings || editing.servings,
        steps: r.steps?.length ? r.steps : editing.steps,
        ingredients: (r.ingredients || []).map((i: StoredIngredient) => ({
          name: i.name,
          amount: i.amount || "",
          mode: i.zaradenie?.p ? "zaradenie" : "vlastna",
          zaradenie: i.zaradenie,
        })),
      });
      setMsg({ ok: true, text: "AI vyplnila recept — skontroluj hlavne zaradenia ingrediencií." });
    } catch (e) {
      setMsg({ ok: false, text: `AI: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy("");
    }
  };

  const uploadImage = async (file: File) => {
    if (!editing) return;
    setBusy("img");
    setMsg(null);
    try {
      const dataUrl = await shrinkImage(file);
      const res = await fetch("/api/recipes/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editing.title || "recept", dataUrl }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      set({ image: json.path });
    } catch (e) {
      setMsg({ ok: false, text: `Obrázok: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy("");
    }
  };

  const saveOne = async (c: Country, recipe: ReturnType<typeof toStored>) => {
    const res = await fetch("/api/recipes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ country: c, recipe }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`${c.toUpperCase()}: ${json.error}`);
    return json.recipe as ReturnType<typeof toStored>;
  };

  const push = async (c: Country, title: string, recipeId: string) => {
    const res = await fetch("/api/send-notification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        country: c,
        title,
        message: PUSH_TEXT[LANG_OF[c]],
        type: "catalog_recipe",
        recipeId,
        ...(testToken ? { token: testToken } : {}),
      }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Notifikácia ${c.toUpperCase()}: ${json.error}`);
  };

  /** Notifikácia o recepte naplánovaná na čas zverejnenia (Supabase plánovač). */
  const schedulePush = async (c: Country, title: string, recipeId: string, sendAt: string) => {
    const res = await fetch("/api/schedule-notification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        country: c,
        title,
        message: PUSH_TEXT[LANG_OF[c]],
        send_at: sendAt,
        data: { type: "catalog_recipe", recipeId },
        ...(testToken ? { token: testToken } : {}),
      }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Naplánovanie notifikácie ${c.toUpperCase()}: ${json.error}`);
  };

  const canNotify = RECIPE_PUSH_TO_ALL || !!testToken;

  const validate = (r: Recipe): string | null => {
    if (!r.title.trim()) return "Vyplň názov receptu.";
    const sec = SECTIONS.find((x) => x.key === r.section);
    if (!sec || !sec.categories.some((c) => c.key === r.category)) {
      return "Vyber sekciu a kategóriu.";
    }
    if (!r.ingredients.some((i) => i.name.trim())) return "Pridaj aspoň jednu ingredienciu.";
    const noZar = r.ingredients.find((i) => i.name.trim() && i.mode === "zaradenie" && !i.zaradenie?.p);
    if (noZar) return `Ingrediencia „${noZar.name}“ nemá vybrané zaradenie (alebo ju prepni na vlastnú položku).`;
    const noProd = r.ingredients.find((i) => i.name.trim() && i.mode === "produkt" && !i.produkt?.name);
    if (noProd) return `Ingrediencia „${noProd.name}“ nemá vybraný produkt.`;
    if (!r.steps.some((s) => s.trim())) return "Pridaj postup (aspoň jeden krok).";
    return null;
  };

  const save = async () => {
    if (!editing) return;
    const problem = validate(editing);
    if (problem) {
      setMsg({ ok: false, text: problem });
      return;
    }
    let publishAt = "";
    if (scheduleOn) {
      const t = new Date(scheduleAt).getTime();
      if (!scheduleAt || Number.isNaN(t) || t < Date.now() + 60_000) {
        setMsg({ ok: false, text: "Vyber čas zverejnenia v budúcnosti (aspoň o minútu)." });
        return;
      }
      publishAt = new Date(t).toISOString();
    }
    const when = publishAt ? new Date(publishAt).toLocaleString("sk-SK") : "";
    const targets: Country[] = translate
      ? (["sk", "cz", "pl"] as Country[])
      : [country];
    const who = testToken ? "len na tvoj telefón (test)" : "VŠETKÝM používateľom";
    if (
      !window.confirm(
        (publishAt
          ? `Naplánovať recept „${editing.title}“ — v appke sa ukáže ${when} (${targets.map((t) => t.toUpperCase()).join(", ")})?`
          : `Zverejniť recept „${editing.title}“ v appke (${targets.map((t) => t.toUpperCase()).join(", ")})?`) +
          (notify && canNotify
            ? `

${publishAt ? `O ${when} sa` : "Pošle sa"} aj notifikácia ${who}.`
            : ""),
      )
    )
      return;

    const notifyNow = async (c: Country, title: string, id: string) => {
      if (!(notify && canNotify)) return;
      if (publishAt) await schedulePush(c, title, id, publishAt);
      else await push(c, title, id);
    };

    setBusy("save");
    setMsg(null);
    try {
      const saved = await saveOne(country, { ...toStored(editing), publishAt });
      const done: string[] = [country.toUpperCase()];
      await notifyNow(country, saved.title, saved.id);
      for (const t of targets.filter((t) => t !== country)) {
        const res = await fetch("/api/recipes/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "translate", recipe: saved, to: LANG_OF[t] }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(`Preklad ${t.toUpperCase()}: ${json.error}`);
        const tr = await saveOne(t, { ...json.recipe, id: saved.id, publishAt });
        await notifyNow(t, tr.title, tr.id);
        done.push(t.toUpperCase());
      }
      const notified = notify && canNotify;
      setMsg({
        ok: true,
        text: publishAt
          ? `Naplánované ⏰ (${done.join(", ")}) — v appke sa ukáže ${when}${notified ? " a vtedy odíde aj notifikácia" : ""}.`
          : `Zverejnené ✅ (${done.join(", ")})${notified ? " + notifikácia odoslaná" : ""}. V appke sa ukáže do pár minút.`,
      });
      setEditing(null);
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  };

  /** Zmaže recept vo všetkých krajinách (preklady majú rovnaké id). */
  const remove = async (r: Recipe) => {
    if (!window.confirm(`Zmazať recept „${r.title}“ z appky vo všetkých krajinách (SK, CZ, PL)?`)) return;
    setBusy("del");
    try {
      const deleted: string[] = [];
      for (const c of ["sk", "cz", "pl"] as Country[]) {
        const res = await fetch(`/api/recipes?country=${c}&id=${encodeURIComponent(r.id)}`, {
          method: "DELETE",
        });
        const json = await res.json();
        if (json.ok) deleted.push(c.toUpperCase());
        else if (res.status !== 404) throw new Error(`${c.toUpperCase()}: ${json.error}`);
      }
      setEditing(null);
      setMsg({ ok: true, text: `Recept zmazaný (${deleted.join(", ")}).` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  };

  /** Späť na zoznam bez uloženia (pri zmenách sa najprv opýta). */
  const leave = () => {
    if (
      editing &&
      JSON.stringify(editing) !== openedRef.current &&
      !window.confirm("Zahodiť neuložené zmeny v recepte?")
    )
      return;
    setEditing(null);
    setMsg(null);
  };

  const inputCls =
    "w-full rounded-xl border border-black/10 bg-[var(--surface)] px-3 py-2 text-sm text-[color:var(--ink)] outline-none focus:border-emerald-500";
  const labelCls = "mb-1 block text-sm font-semibold";

  // ---------------------------------------------------------------- zoznam
  if (!editing) {
    return (
      <div className="space-y-3 rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold">
            Recepty v appke {FLAG[country]}{" "}
            <span className="font-normal opacity-60">({recipes.length})</span>
          </div>
          <button
            type="button"
            onClick={startNew}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
          >
            ＋ Nový recept
          </button>
        </div>
        {fromSamples && (
          <p className="text-xs opacity-70">
            Zatiaľ sú v appke len ukážkové recepty. Prvým uložením sa začne
            používať tvoj zoznam (ukážky v ňom ostanú, môžeš ich upraviť alebo zmazať).
          </p>
        )}
        {msg && <Msg {...msg} />}
        {/* Rozdelenie ako v appke: sekcie a v nich kategórie */}
        <div className="flex flex-wrap gap-1.5">
          <Chip active={!fSection} onClick={() => { setFSection(""); setFCategory(""); }}>
            Všetky ({recipes.length})
          </Chip>
          {SECTIONS.map((sec) => (
            <Chip
              key={sec.key}
              active={fSection === sec.key}
              onClick={() => { setFSection(sec.key); setFCategory(""); }}
            >
              {sec.label} ({recipes.filter((r) => r.section === sec.key).length})
            </Chip>
          ))}
        </div>
        {fSection && (
          <div className="flex flex-wrap gap-1.5 pl-2">
            <Chip small active={!fCategory} onClick={() => setFCategory("")}>
              Celá sekcia
            </Chip>
            {SECTIONS.find((sec) => sec.key === fSection)?.categories.map((c) => (
              <Chip key={c.key} small active={fCategory === c.key} onClick={() => setFCategory(c.key)}>
                {c.label} ({recipes.filter((r) => r.category === c.key).length})
              </Chip>
            ))}
          </div>
        )}
        {loading ? (
          <div className="text-sm opacity-60">Načítavam…</div>
        ) : (
          <div className="max-h-[480px] space-y-3 overflow-y-auto">
            {SECTIONS.flatMap((sec) =>
              sec.categories.map((cat) => ({ sec, cat })),
            )
              .filter(({ sec, cat }) => (!fSection || sec.key === fSection) && (!fCategory || cat.key === fCategory))
              .map(({ sec, cat }) => ({ sec, cat, items: recipes.filter((r) => r.category === cat.key) }))
              .filter(({ items }) => items.length > 0 || !!fCategory)
              .map(({ sec, cat, items }) => (
                <div key={cat.key}>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-60">
                    {sec.label} › {cat.label} ({items.length})
                  </div>
                  {items.length === 0 ? (
                    <div className="text-xs opacity-50">V tejto kategórii zatiaľ nie je žiadny recept.</div>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {items.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => startEdit(r)}
                          className="flex items-center gap-3 rounded-xl border border-black/10 bg-[var(--surface)] p-2 text-left hover:border-emerald-500"
                        >
                          {r.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={imageSrc(r.image)} alt="" className="h-14 w-14 rounded-lg object-cover" />
                          ) : (
                            <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-black/5">🍲</div>
                          )}
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold">{r.title}</div>
                            {isScheduled(r) && (
                              <div className="text-xs font-semibold text-indigo-600">
                                ⏰ v appke od {new Date(r.publishAt!).toLocaleString("sk-SK")}
                              </div>
                            )}
                            <div className="text-xs opacity-60">
                              {r.timeMin} min · {["", "ľahké", "stredné", "náročné"][r.difficulty]} · {r.ingredients.length} ingr.
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            {recipes.length === 0 && (
              <div className="text-sm opacity-60">Zatiaľ tu nie je žiadny recept. Pridaj prvý cez ＋ Nový recept.</div>
            )}
          </div>
        )}
      </div>
    );
  }

  // --------------------------------------------------------------- formulár
  const section = SECTIONS.find((s) => s.key === editing.section);
  return (
    <div className="space-y-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">
          {isNew ? "Nový recept" : "Úprava receptu"} {FLAG[country]}
        </div>
        <button
          type="button"
          onClick={leave}
          className="rounded-lg border border-black/10 px-3 py-1 text-xs hover:border-black/30"
        >
          ← Späť na zoznam
        </button>
      </div>

      {/* AI vyplnenie z textu */}
      <details className="rounded-xl border border-black/10 bg-[var(--surface)]/60 p-3" open={isNew}>
        <summary className="cursor-pointer text-sm font-semibold">
          ✨ Vložiť text receptu a nechať AI vyplniť formulár
        </summary>
        <textarea
          value={aiText}
          onChange={(e) => setAiText(e.target.value)}
          rows={7}
          placeholder={"Názov, ingrediencie a postup — hocijako, napr. skopírovaný z webu alebo z poznámok."}
          className={`${inputCls} mt-2 resize-y`}
        />
        <button
          type="button"
          onClick={runAi}
          disabled={busy !== "" || aiText.trim().length < 20}
          className="mt-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {busy === "ai" ? "AI pracuje…" : "✨ Vyplniť pomocou AI"}
        </button>
      </details>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[180px_1fr]">
        {/* Obrázok */}
        <div>
          <label className={labelCls}>Obrázok</label>
          <ImagePicker
            src={imageSrc(editing.image)}
            busy={busy === "img"}
            onFile={uploadImage}
            onClear={() => set({ image: "" })}
          />
        </div>

        <div className="space-y-3">
          <div>
            <label className={labelCls}>Názov receptu</label>
            <input
              value={editing.title}
              onChange={(e) => set({ title: e.target.value })}
              maxLength={80}
              placeholder="napr. Kuracie stehná na cesnaku"
              className={inputCls}
            />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label className={labelCls}>Sekcia</label>
              <select
                value={editing.section}
                onChange={(e) => set({ section: e.target.value, category: "" })}
                className={inputCls}
              >
                <option value="">— vyber —</option>
                {SECTIONS.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Kategória</label>
              <select
                value={editing.category}
                onChange={(e) => set({ category: e.target.value })}
                className={inputCls}
                disabled={!section}
              >
                <option value="">— vyber —</option>
                {section?.categories.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className={labelCls}>Čas (min)</label>
              <input
                type="number"
                min={1}
                value={editing.timeMin || ""}
                onChange={(e) => set({ timeMin: Number(e.target.value) })}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Náročnosť</label>
              <select
                value={editing.difficulty}
                onChange={(e) => set({ difficulty: Number(e.target.value) })}
                className={inputCls}
              >
                <option value={1}>Ľahké</option>
                <option value={2}>Stredné</option>
                <option value={3}>Náročné</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Porcie</label>
              <input
                type="number"
                min={1}
                value={editing.servings || ""}
                onChange={(e) => set({ servings: Number(e.target.value) })}
                className={inputCls}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Ingrediencie */}
      <div>
        <label className={labelCls}>Ingrediencie</label>
        <p className="mb-2 text-xs opacity-70">
          <b>Zaradenie</b> = appka sama nájde najlacnejšiu akciu. <b>Konkrétny produkt</b> =
          ponúkne presne tento (kým je v akcii, potom najlacnejší zo zaradenia).
          <b> Vlastná položka</b> = len text, bez akcie.
        </p>
        <div className="space-y-2">
          {editing.ingredients.map((ing, idx) => (
            <IngredientEditor
              key={idx}
              index={idx}
              ing={ing}
              country={country}
              labelFor={labelFor}
              onChange={(p) => setIng(idx, p)}
              onRemove={() =>
                set({ ingredients: editing.ingredients.filter((_, n) => n !== idx) })
              }
              onMove={(dir) => {
                const list = [...editing.ingredients];
                const to = idx + dir;
                if (to < 0 || to >= list.length) return;
                [list[idx], list[to]] = [list[to], list[idx]];
                set({ ingredients: list });
              }}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() =>
            set({ ingredients: [...editing.ingredients, { name: "", amount: "", mode: "zaradenie" }] })
          }
          className="mt-2 rounded-xl border border-black/10 bg-[var(--surface)] px-3 py-1.5 text-sm font-semibold hover:border-black/30"
        >
          ＋ Pridať ingredienciu
        </button>
      </div>

      {/* Postup */}
      <div>
        <label className={labelCls}>Postup <span className="font-normal opacity-60">(každý krok na nový riadok)</span></label>
        <textarea
          value={editing.steps.join("\n")}
          onChange={(e) => set({ steps: e.target.value.split("\n") })}
          rows={7}
          placeholder={"Rúru predhrej na 200 °C.\nStehná osoľ a okoreň.\n…"}
          className={`${inputCls} resize-y`}
        />
      </div>

      {/* Zverejnenie */}
      <div className="space-y-2 rounded-xl border border-black/10 bg-[var(--surface)]/60 p-3 text-sm">
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={scheduleOn}
            onChange={(e) => {
              setScheduleOn(e.target.checked);
              if (e.target.checked && !scheduleAt) {
                // Predvoľba: zajtra o 8:00.
                const d = new Date();
                d.setDate(d.getDate() + 1);
                d.setHours(8, 0, 0, 0);
                setScheduleAt(toLocalInput(d.toISOString()));
              }
            }}
            className="mt-0.5 h-4 w-4"
          />
          <span className="flex-1">
            <b>⏰ Naplánovať zverejnenie</b>
            <span className="mt-1 block text-xs opacity-75">
              {scheduleOn
                ? "Recept sa uloží hneď, ale v appke sa ukáže až v zadaný čas. Ak je zaškrtnutá notifikácia, odíde v ten istý čas (pošle ju server, editor nemusí bežať)."
                : "Nezaškrtnuté: recept sa v appke ukáže hneď po uložení."}
            </span>
            {scheduleOn && (
              <input
                type="datetime-local"
                value={scheduleAt}
                min={toLocalInput(new Date(Date.now() + 60_000).toISOString())}
                onChange={(e) => setScheduleAt(e.target.value)}
                className="mt-2 rounded-lg border border-black/10 bg-[var(--surface)] px-2 py-1 text-sm"
              />
            )}
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2">
          <input type="checkbox" checked={translate} onChange={(e) => setTranslate(e.target.checked)} className="mt-0.5 h-4 w-4" />
          <span>
            <b>
              🌍{" "}
              {isNew
                ? `Zverejniť aj v ${others(country)} (AI recept preloží)`
                : `Preniesť túto úpravu aj do ${others(country, "do")}`}
            </b>
            <span className="mt-1 block text-xs opacity-75">
              {translate ? (
                <>
                  ✅ Zaškrtnuté: recept sa uloží v {FLAG[country]} {country.toUpperCase()} a AI z neho
                  {isNew ? " vytvorí" : " znova vytvorí"} aj verzie pre {others(country, "pre")}.
                  {!isNew && " Ak niekto v nich ručne opravoval preklad, tieto opravy sa prepíšu."}
                </>
              ) : (
                <>
                  ⬜ Nezaškrtnuté: {isNew ? "recept bude" : "zmena sa uloží"} len v {FLAG[country]}{" "}
                  {country.toUpperCase()}. V {others(country)} {isNew ? "nebude" : "ostane stará verzia"}.
                </>
              )}
            </span>
          </span>
        </label>
        <label className={`flex items-start gap-2 ${canNotify ? "cursor-pointer" : "opacity-60"}`}>
          <input
            type="checkbox"
            checked={notify && canNotify}
            disabled={!canNotify}
            onChange={(e) => setNotify(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            📣 Poslať notifikáciu{" "}
            {testToken ? <b className="text-amber-600">len na môj telefón (test)</b> : "všetkým"} — po klepnutí sa otvorí recept
            {!canNotify && (
              <span className="mt-1 block text-xs">
                Notifikácie všetkým sa zapnú, keď vyjde nová verzia appky so sekciou Recepty
                (staršie appky by recept nevedeli otvoriť). Na skúšku zapni hore 🧪 Testovací režim.
              </span>
            )}
          </span>
        </label>
      </div>

      {msg && <Msg {...msg} />}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={leave}
          disabled={busy !== ""}
          className="rounded-xl border border-black/15 bg-[var(--surface)] px-4 py-3 text-sm font-semibold hover:border-black/30 disabled:opacity-50"
        >
          ← Späť bez uloženia
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy !== ""}
          className="flex-1 rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy === "save" ? "Ukladám…" : scheduleOn ? "⏰ Uložiť a naplánovať" : "✅ Uložiť a zverejniť v appke"}
        </button>
        {!isNew && (
          <button
            type="button"
            onClick={() => remove(editing)}
            disabled={busy !== ""}
            className="rounded-xl border border-red-500/50 px-4 py-3 text-sm font-semibold text-red-600 hover:bg-red-500/10 disabled:opacity-50"
          >
            🗑 Zmazať
          </button>
        )}
      </div>
    </div>
  );
}

function Chip({
  active,
  small,
  onClick,
  children,
}: {
  active: boolean;
  small?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border font-semibold transition ${small ? "px-2.5 py-0.5 text-[11px]" : "px-3 py-1 text-xs"} ${
        active
          ? "border-emerald-600 bg-emerald-600 text-white"
          : "border-black/10 bg-[var(--surface)] hover:border-emerald-500"
      }`}
    >
      {children}
    </button>
  );
}

function Msg({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div
      className={`rounded-xl px-3 py-2 text-sm ${
        ok ? "bg-emerald-500/15 text-emerald-700" : "bg-red-500/15 text-red-700"
      }`}
    >
      {text}
    </div>
  );
}

function ImagePicker({
  src,
  busy,
  onFile,
  onClear,
}: {
  src: string;
  busy: boolean;
  onFile: (f: File) => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => ref.current?.click()}
        className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-black/15 bg-[var(--surface)] text-center text-xs opacity-90 hover:border-emerald-500"
      >
        {busy ? (
          "Nahrávam…"
        ) : src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="h-full w-full object-cover" />
        ) : (
          <span>📷<br />Klikni a vyber fotku</span>
        )}
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      {src && (
        <button type="button" onClick={onClear} className="w-full text-xs text-red-600 hover:underline">
          Odstrániť obrázok
        </button>
      )}
    </div>
  );
}

function IngredientEditor({
  index,
  ing,
  country,
  labelFor,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  ing: Ingredient;
  country: Country;
  labelFor: (key?: string) => string;
  onChange: (p: Partial<Ingredient>) => void;
  onRemove: () => void;
  onMove: (dir: number) => void;
}) {
  // Názvy dlaždíc v appke majú zalomenia riadkov — tu ich netreba.
  const lab = (k?: string) => labelFor(k).replace(/\s+/g, " ").trim();
  const cat = HIERARCHY.find((c) => c["Kategória"] === ing.zaradenie?.c);
  const sub = cat?.["Podkategórie"].find((s) => s["Podkategória"] === ing.zaradenie?.s);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [searching, setSearching] = useState(false);

  // Hľadanie konkrétneho produktu v akciách (rovnaké API ako preklik v notifikácii).
  useEffect(() => {
    if (ing.mode !== "produkt") return;
    const text = q.trim();
    if (text.length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/notification-products?${new URLSearchParams({ country, q: text })}`);
        const json = await res.json();
        setHits(json?.ok ? json.products : []);
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q, country, ing.mode]);

  const selectCls =
    "min-w-0 flex-1 rounded-lg border border-black/10 bg-[var(--surface)] px-2 py-1.5 text-xs outline-none focus:border-emerald-500";
  const zarLabel = useMemo(
    () =>
      ing.zaradenie?.p
        ? `${lab(ing.zaradenie.c)} › ${lab(ing.zaradenie.s)} › ${lab(ing.zaradenie.p)}`
        : "",
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ing.zaradenie, labelFor],
  );

  return (
    <div className="rounded-xl border border-black/10 bg-[var(--surface)] p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-5 text-center text-xs font-bold opacity-60">{index + 1}.</span>
        <input
          value={ing.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Ingrediencia (napr. Kuracie stehná)"
          className="min-w-[160px] flex-[2] rounded-lg border border-black/10 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
        />
        <input
          value={ing.amount}
          onChange={(e) => onChange({ amount: e.target.value })}
          placeholder="Množstvo (8 ks, 2 PL…)"
          className="w-36 rounded-lg border border-black/10 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
        />
        <select
          value={ing.mode}
          onChange={(e) => onChange({ mode: e.target.value as Ingredient["mode"] })}
          className="rounded-lg border border-black/10 bg-transparent px-2 py-1.5 text-xs"
        >
          <option value="zaradenie">Zaradenie</option>
          <option value="produkt">Konkrétny produkt</option>
          <option value="vlastna">Vlastná položka</option>
        </select>
        <div className="flex gap-1">
          <button type="button" onClick={() => onMove(-1)} className="px-1 text-xs opacity-60 hover:opacity-100" title="Vyššie">▲</button>
          <button type="button" onClick={() => onMove(1)} className="px-1 text-xs opacity-60 hover:opacity-100" title="Nižšie">▼</button>
          <button type="button" onClick={onRemove} className="px-1 text-sm text-red-600" title="Odstrániť">✕</button>
        </div>
      </div>

      {ing.mode === "zaradenie" && (
        <div className="mt-2 flex flex-wrap gap-2 pl-7">
          <select
            className={selectCls}
            value={ing.zaradenie?.c || ""}
            onChange={(e) => onChange({ zaradenie: { c: e.target.value, s: "", p: "" } })}
          >
            <option value="">— kategória —</option>
            {HIERARCHY.map((c) => (
              <option key={c["Kategória"]} value={c["Kategória"]}>{lab(c["Kategória"])}</option>
            ))}
          </select>
          <select
            className={selectCls}
            value={ing.zaradenie?.s || ""}
            disabled={!cat}
            onChange={(e) => onChange({ zaradenie: { c: ing.zaradenie!.c, s: e.target.value, p: "" } })}
          >
            <option value="">— podkategória —</option>
            {cat?.["Podkategórie"].map((s) => (
              <option key={s["Podkategória"]} value={s["Podkategória"]}>{lab(s["Podkategória"])}</option>
            ))}
          </select>
          <select
            className={selectCls}
            value={ing.zaradenie?.p || ""}
            disabled={!sub}
            onChange={(e) => onChange({ zaradenie: { ...ing.zaradenie!, p: e.target.value } })}
          >
            <option value="">— zaradenie —</option>
            {sub?.Zaradenia.map((z) => (
              <option key={z.Zaradenie} value={z.Zaradenie}>{lab(z.Zaradenie)}</option>
            ))}
          </select>
        </div>
      )}

      {ing.mode === "produkt" && (
        <div className="mt-2 space-y-1 pl-7">
          {ing.produkt?.name && (
            <div className="text-xs">
              ✅ <b>{ing.produkt.name}</b> ({ing.produkt.shop}) · {zarLabel}
            </div>
          )}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Hľadaj produkt v akciách (min. 2 znaky)…"
            className="w-full rounded-lg border border-black/10 bg-transparent px-2 py-1.5 text-xs outline-none focus:border-emerald-500"
          />
          {searching && <div className="text-xs opacity-60">Hľadám…</div>}
          {hits.length > 0 && (
            <div className="max-h-48 overflow-y-auto rounded-lg border border-black/10">
              {hits.map((h, n) => (
                <button
                  key={`${h.shop}-${h.name}-${n}`}
                  type="button"
                  onClick={() => {
                    onChange({
                      produkt: { name: h.name, shop: h.shop },
                      zaradenie: { c: h.category, s: h.subcategory, p: h.placement },
                    });
                    setQ("");
                    setHits([]);
                  }}
                  className="block w-full border-b border-black/5 px-2 py-1 text-left text-xs hover:bg-emerald-500/10"
                >
                  {h.active ? "🟢" : "⚪"} {h.name} · {h.shop} · {h.price_sale}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {ing.mode === "zaradenie" && zarLabel && (
        <div className="mt-1 pl-7 text-[11px] opacity-60">{zarLabel}</div>
      )}
    </div>
  );
}
