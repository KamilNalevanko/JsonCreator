"use client";

import { useState, useEffect, useRef } from "react";
import hierarchyData from "../../assets/hierarchia.json";

type Country = "sk" | "cz" | "pl";

const COUNTRY_LABELS: Record<Country, string> = {
  sk: "🇸🇰 Slovensko",
  cz: "🇨🇿 Česko",
  pl: "🇵🇱 Poľsko",
};

const CURRENCY: Record<Country, string> = { sk: "€", cz: "Kč", pl: "zł" };

type HierPlacement = { Zaradenie: string };
type HierSub = { "Podkategória": string; Zaradenia: HierPlacement[] };
type HierCat = { "Kategória": string; "Podkategórie": HierSub[] };
const HIERARCHY = hierarchyData as unknown as HierCat[];

type ProductHit = {
  name: string;
  shop: string;
  category: string;
  subcategory: string;
  placement: string;
  amount: string;
  unit: string;
  price_sale: string;
  price_sale_unit: string;
  date_from: string;
  date_to: string;
  active: boolean;
};

// Jednotková cena je počítaná na kg/l (g/ml sa násobí ×1000), preto label
// jednotky prepočítaj: g→kg, ml→l. Package (množstvo) ostáva v pôvodnej jednotke.
const unitLabel = (u: string) => {
  const x = (u || "").toLowerCase().trim();
  if (x === "g") return "kg";
  if (x === "ml") return "l";
  return x;
};

type ShopOption = { value: string; label: string };

// Odporúčaná štruktúra receptu (placeholder v poli) — nech to používateľ nahodí
// jednotne. Je to len vzor, môže si upraviť.
const RECIPE_TEMPLATE = `Názov: Kuracie stehná na cesnaku

Porcie: 4
Čas: 45 min

Ingrediencie:
- 8 ks kuracích stehien
- 6 strúčikov cesnaku
- 2 lyžice olivového oleja
- soľ, korenie

Postup:
1. Stehná osolíme a okoreníme.
2. Cesnak nasekáme, zmiešame s olejom, potrieme mäso.
3. Pečieme pri 200 °C cca 40 min.

Tip: podávaj so zemiakmi alebo ryžou.`;

export default function NotifikacieModal({
  open,
  onClose,
  defaultCountry = "sk",
  shopsByCountry,
  labelFor,
}: {
  open: boolean;
  onClose: () => void;
  defaultCountry?: Country;
  shopsByCountry: Record<string, ShopOption[]>;
  labelFor: (key?: string) => string;
}) {
  const [country, setCountry] = useState<Country>(defaultCountry);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  // Režim receptu: pošle sa ako recept (typ=recipe) → v appke sa uloží do obálky
  // a dá sa uložiť do „Moje recepty". ID sa generuje automaticky.
  const [recipeMode, setRecipeMode] = useState(false);
  const [recipeName, setRecipeName] = useState("");
  const [recipeText, setRecipeText] = useState("");
  // Testovací režim: pošle LEN na jeden telefón (device token), nie všetkým.
  const [testMode, setTestMode] = useState(false);
  const [deviceToken, setDeviceToken] = useState("");
  const [devices, setDevices] = useState<
    { token: string; country: string; updated_at: string; tokenTail: string }[]
  >([]);
  const [loadingDevices, setLoadingDevices] = useState(false);

  // Plánovanie: pošle sa cez Supabase cron o zvolenom čase (PC môže byť vypnuté).
  const [scheduleMode, setScheduleMode] = useState(false);
  const [sendAt, setSendAt] = useState("");
  type Scheduled = {
    id: string;
    country: string;
    title: string;
    message: string;
    data: Record<string, unknown>;
    token: string | null;
    send_at: string;
  };
  const [scheduled, setScheduled] = useState<Scheduled[]>([]);

  // Vlastný potvrdzovací dialóg (namiesto natívneho window.confirm).
  const [confirmBox, setConfirmBox] = useState<{
    message: string;
    tone: "blue" | "amber" | "indigo";
    resolve: (ok: boolean) => void;
  } | null>(null);
  const askConfirm = (message: string, tone: "blue" | "amber" | "indigo") =>
    new Promise<boolean>((resolve) =>
      setConfirmBox({ message, tone, resolve }),
    );
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  // Filtre (ako na hlavnej obrazovke).
  const [fShop, setFShop] = useState("");
  const [fCat, setFCat] = useState("");
  const [fSub, setFSub] = useState("");
  const [fPlc, setFPlc] = useState("");

  // Vyhľadávač produktu na deep-link.
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [showHits, setShowHits] = useState(false);
  const [selected, setSelected] = useState<ProductHit | null>(null);

  // Predvoľ krajinu podľa aktuálne zvolenej v editore pri každom otvorení
  // a načítaj čakajúce naplánované notifikácie.
  useEffect(() => {
    if (open) {
      setCountry(defaultCountry);
      loadScheduled();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultCountry]);

  // Zavretie klávesou Esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Pri zmene krajiny zahoď výber aj filtre z inej krajiny.
  useEffect(() => {
    setSelected(null);
    setQuery("");
    setHits([]);
    setFShop("");
    setFCat("");
    setFSub("");
    setFPlc("");
  }, [country]);

  const hasFilter = !!(fShop || fCat || fSub || fPlc);

  // Debounced hľadanie produktov pri písaní / zmene filtra.
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current);
    const q = query.trim();
    if (q.length < 2 && !hasFilter) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ country });
        if (q.length >= 2) params.set("q", q);
        if (fShop) params.set("shop", fShop);
        if (fCat) params.set("category", fCat);
        if (fSub) params.set("subcategory", fSub);
        if (fPlc) params.set("placement", fPlc);
        const res = await fetch(`/api/notification-products?${params}`);
        const json = await res.json();
        setHits(json?.ok && Array.isArray(json.products) ? json.products : []);
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debRef.current) clearTimeout(debRef.current);
    };
  }, [query, country, fShop, fCat, fSub, fPlc, hasFilter]);

  const loadDevices = async () => {
    setLoadingDevices(true);
    try {
      const res = await fetch("/api/notification-token");
      const json = await res.json();
      const list = json?.ok && Array.isArray(json.devices) ? json.devices : [];
      setDevices(list);
      // Auto-vyplň najnovšiu registráciu (najpravdepodobnejšie tvoj telefón).
      if (list[0]?.token) setDeviceToken(list[0].token);
    } catch {
      setDevices([]);
    } finally {
      setLoadingDevices(false);
    }
  };

  const loadScheduled = async () => {
    try {
      const res = await fetch("/api/schedule-notification");
      const json = await res.json();
      setScheduled(
        json?.ok && Array.isArray(json.scheduled) ? json.scheduled : [],
      );
    } catch {
      setScheduled([]);
    }
  };

  const cancelScheduled = async (id: string) => {
    try {
      await fetch(`/api/schedule-notification?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      setScheduled((prev) => prev.filter((s) => s.id !== id));
    } catch {
      /* ignore */
    }
  };

  if (!open) return null;

  const shops = shopsByCountry[country] ?? [];
  const cats = HIERARCHY;
  const subs = fCat
    ? cats.find((c) => c["Kategória"] === fCat)?.["Podkategórie"] ?? []
    : [];
  const plcs = fSub
    ? subs.find((s) => s["Podkategória"] === fSub)?.["Zaradenia"] ?? []
    : [];

  const dateRange = (h: { date_from: string; date_to: string }) =>
    h.date_from || h.date_to ? `${h.date_from || "?"} – ${h.date_to || "?"}` : "";

  // Deep-link kľúče z vybraného produktu (prázdne = obyčajný oznam).
  const deepLink = selected
    ? {
        product: selected.name,
        shop: selected.shop,
        category: selected.category,
        subcategory: selected.subcategory,
        placement: selected.placement,
      }
    : {};

  // Ak je vybraný produkt, info o ňom (názov + obchod + cena + gramáž + €/kg +
  // platnosť) sa do notifikácie pridá VŽDY — aj keď si napíšeš vlastný text.
  const prettyShop = (key: string) =>
    shopsByCountry[country]?.find((s) => s.value === key)?.label || key;
  const productLine = selected
    ? `${selected.name} v akcii${
        selected.shop ? ` v ${prettyShop(selected.shop)}` : ""
      }${selected.price_sale ? ` — ${selected.price_sale} ${CURRENCY[country]}` : ""}${
        selected.amount ? ` • ${selected.amount} ${selected.unit}` : ""
      }${
        selected.price_sale_unit
          ? ` (${selected.price_sale_unit} ${CURRENCY[country]}/${unitLabel(selected.unit)})`
          : ""
      }${
        selected.date_to ? `, platí do ${selected.date_to}` : ""
      }`
    : "";
  // Telo: produktový riadok (aby cena/gramáž boli vidno hneď) + prípadne tvoj text.
  const outMessage = selected
    ? `${productLine}${message.trim() ? ` ${message.trim()}` : ""}`.slice(0, 230)
    : message.trim();
  // Titul: tvoj; ak prázdny a je produkt, predvyplní sa z produktu.
  const outTitle =
    title.trim() || (selected ? `${selected.name} v akcii` : "");

  const clearForm = () => {
    setTitle("");
    setMessage("");
    setSelected(null);
    setQuery("");
    setRecipeName("");
    setRecipeText("");
  };

  const send = async () => {
    if (!recipeMode && !title.trim() && !message.trim() && !selected) {
      setResult({ ok: false, text: "Vyplň aspoň titul alebo text správy." });
      return;
    }
    if (recipeMode && (!recipeName.trim() || !recipeText.trim())) {
      setResult({ ok: false, text: "Recept: vyplň názov aj text receptu." });
      return;
    }
    if (testMode && !deviceToken.trim()) {
      setResult({
        ok: false,
        text: "Testovací režim: vlož device token svojho telefónu.",
      });
      return;
    }

    // Finálny obsah + extra data podľa režimu (recept vs oznam/deep-link).
    const isRecipe = recipeMode;
    const finalTitle = isRecipe ? recipeName.trim() : outTitle;
    const finalMessage = isRecipe
      ? "🍲 Nový recept — otvor v obálke a ulož si ho"
      : outMessage;
    const extraData: Record<string, string> = isRecipe
      ? {
          type: "recipe",
          recipe: recipeText.trim(),
          recipeId: `recipe_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 8)}`,
        }
      : (deepLink as Record<string, string>);

    // ---- Naplánovanie na neskôr (odošle Supabase cron) --------------------
    if (scheduleMode) {
      if (!sendAt) {
        setResult({ ok: false, text: "Vyber dátum a čas odoslania." });
        return;
      }
      const when = new Date(sendAt);
      if (isNaN(when.getTime()) || when.getTime() < Date.now() - 60_000) {
        setResult({ ok: false, text: "Čas odoslania musí byť v budúcnosti." });
        return;
      }
      const confirmed = await askConfirm(
        `Naplánovať na ${when.toLocaleString("sk-SK")} ` +
          (testMode ? `(TEST — len tvoj telefón)?\n\n` : `pre VŠETKÝCH (${COUNTRY_LABELS[country]})?\n\n`) +
          (isRecipe
            ? `Recept: ${finalTitle || "(bez názvu)"}`
            : `Titul: ${finalTitle || "(prázdny)"}\nText: ${finalMessage || "(prázdny)"}` +
              (selected ? `\nPreklik na: ${selected.name} (${selected.shop})` : "")),
        testMode ? "amber" : "indigo",
      );
      if (!confirmed) return;

      setSending(true);
      setResult(null);
      try {
        const res = await fetch("/api/schedule-notification", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            country,
            title: finalTitle,
            message: finalMessage,
            send_at: when.toISOString(),
            ...(testMode && deviceToken.trim()
              ? { token: deviceToken.trim() }
              : {}),
            data: extraData,
          }),
        });
        const json = await res.json();
        if (json.ok) {
          setResult({
            ok: true,
            text: `Naplánované ✅ na ${when.toLocaleString("sk-SK")}. Pošle sa aj keď bude PC vypnuté.`,
          });
          clearForm();
          loadScheduled();
        } else {
          const notDeployed = /scheduled_notifications|schema cache/i.test(
            String(json.error || ""),
          );
          setResult({
            ok: false,
            text: notDeployed
              ? "Plánovač ešte nie je nasadený na serveri (chýba tabuľka scheduled_notifications). Spusti SQL v Supabase a nasaď edge function scheduled-push."
              : `Chyba: ${json.error}`,
          });
        }
      } catch (e) {
        setResult({
          ok: false,
          text: `Chyba siete: ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        setSending(false);
      }
      return;
    }

    // ---- Okamžité odoslanie ----------------------------------------------
    const confirmed = await askConfirm(
      (testMode
        ? `TEST — pošle sa LEN na 1 telefón (tvoj token).\n\n`
        : `Naozaj poslať ${isRecipe ? "RECEPT" : "notifikáciu"} VŠETKÝM používateľom (${COUNTRY_LABELS[country]})?\n\n`) +
        (isRecipe
          ? `Recept: ${finalTitle || "(bez názvu)"}`
          : `Titul: ${finalTitle || "(prázdny)"}\nText: ${finalMessage || "(prázdny)"}` +
            (selected ? `\nPreklik na: ${selected.name} (${selected.shop})` : "")),
      testMode ? "amber" : "blue",
    );
    if (!confirmed) return;

    setSending(true);
    setResult(null);
    try {
      const res = await fetch("/api/send-notification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country,
          title: finalTitle,
          message: finalMessage,
          ...(testMode && deviceToken.trim()
            ? { token: deviceToken.trim() }
            : {}),
          ...extraData,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setResult({
          ok: true,
          text:
            json.target === "device"
              ? "Test odoslaný ✅ len na tvoj telefón."
              : `Odoslané ✅ VŠETKÝM (kanál ${json.topic}). Doručí sa aj na vypnuté telefóny.`,
        });
        clearForm();
      } else {
        setResult({ ok: false, text: `Chyba: ${json.error}` });
      }
    } catch (e) {
      setResult({
        ok: false,
        text: `Chyba siete: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setSending(false);
    }
  };

  const cur = CURRENCY[country];

  const inputCls =
    "w-full rounded-xl border border-black/10 bg-[var(--surface)] px-3 py-2 text-[color:var(--ink)] outline-none focus:border-blue-500";
  const selectCls =
    "w-full rounded-xl border border-black/10 bg-[var(--surface)] px-3 py-2 text-sm text-[color:var(--ink)] outline-none focus:border-blue-500";
  const labelCls = "mb-1 block text-sm font-semibold text-[color:var(--ink)]";

  return (
    <>
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative my-8 w-full max-w-2xl rounded-3xl bg-[color:var(--form)] p-6 text-[color:var(--ink)] shadow-[var(--shadow)] ring-1 ring-black/10"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Zavrieť"
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full border border-black/10 bg-[var(--surface)] text-lg leading-none text-[color:var(--ink)] transition hover:border-black/30"
        >
          ✕
        </button>

        <h2 className="text-2xl font-bold">📣 Poslať notifikáciu</h2>
        <p className="mt-1 text-sm opacity-70">
          Notifikácia príde všetkým používateľom s vybraným jazykom appky —
          <strong> aj keď majú appku vypnutú</strong> (pípne + odznak).
        </p>

        <div className="mt-6 space-y-4">
          <div>
            <label className={labelCls}>Krajina</label>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(COUNTRY_LABELS) as Country[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCountry(c)}
                  className={`rounded-xl border px-4 py-2 text-sm font-semibold transition ${
                    country === c
                      ? "border-blue-500 bg-blue-600 text-white"
                      : "border-black/10 bg-[var(--surface)] text-[color:var(--ink)] hover:border-black/30"
                  }`}
                >
                  {COUNTRY_LABELS[c]}
                </button>
              ))}
            </div>
          </div>

          {/* Prepínač: obyčajný oznam vs recept */}
          <label className="flex cursor-pointer items-center gap-2 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm font-semibold">
            <input
              type="checkbox"
              checked={recipeMode}
              onChange={(e) => setRecipeMode(e.target.checked)}
              className="h-4 w-4"
            />
            🍲 Poslať recept (uloží sa do obálky → dá sa uložiť do receptov)
          </label>

          {recipeMode ? (
            <>
              <div>
                <label className={labelCls}>Názov receptu</label>
                <input
                  value={recipeName}
                  onChange={(e) => setRecipeName(e.target.value)}
                  maxLength={80}
                  placeholder="napr. Kuracie stehná na cesnaku"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>Text receptu</label>
                <textarea
                  value={recipeText}
                  onChange={(e) => setRecipeText(e.target.value)}
                  rows={14}
                  placeholder={RECIPE_TEMPLATE}
                  className={`${inputCls} resize-y font-mono text-xs`}
                />
                <div className="text-right text-xs opacity-50">
                  {recipeText.length} znakov
                </div>
                <p className="mt-1 text-xs opacity-70">
                  Vlož recept podľa vzoru (názov, ingrediencie, postup). <b>ID sa
                  vygeneruje automaticky.</b> Notifikácia ukáže len názov + „nový
                  recept"; celý text sa uloží do obálky v appke.
                </p>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className={labelCls}>Titul</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={60}
                  placeholder="napr. Najlacnejšie kuracie stehná! 🐔"
                  className={inputCls}
                />
                <div className="text-right text-xs opacity-50">
                  {title.length}/60
                </div>
              </div>

              <div>
                <label className={labelCls}>Text správy</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  maxLength={180}
                  rows={3}
                  placeholder="napr. Tento týždeň len za 2,99 €/kg v akcii. Pozri sa!"
                  className={`${inputCls} resize-none`}
                />
                <div className="text-right text-xs opacity-50">
                  {message.length}/180
                </div>
              </div>
            </>
          )}

          <div className="rounded-2xl border border-black/10 bg-[var(--surface)]/40 p-4">
            <label className={labelCls}>
              Produkt na preklik{" "}
              <span className="font-normal opacity-60">
                (voliteľné — bez neho ide obyčajný oznam)
              </span>
            </label>

            {/* Filtre ako na hlavnej obrazovke */}
            <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <select
                className={selectCls}
                value={fShop}
                onChange={(e) => setFShop(e.target.value)}
              >
                <option value="">— všetky obchody —</option>
                {shops.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <select
                className={selectCls}
                value={fCat}
                onChange={(e) => {
                  setFCat(e.target.value);
                  setFSub("");
                  setFPlc("");
                }}
              >
                <option value="">— všetky kategórie —</option>
                {cats.map((c) => (
                  <option key={c["Kategória"]} value={c["Kategória"]}>
                    {labelFor(c["Kategória"])}
                  </option>
                ))}
              </select>
              <select
                className={selectCls}
                value={fSub}
                disabled={!fCat}
                onChange={(e) => {
                  setFSub(e.target.value);
                  setFPlc("");
                }}
              >
                <option value="">— všetky podkategórie —</option>
                {subs.map((s) => (
                  <option key={s["Podkategória"]} value={s["Podkategória"]}>
                    {labelFor(s["Podkategória"])}
                  </option>
                ))}
              </select>
              <select
                className={selectCls}
                value={fPlc}
                disabled={!fSub}
                onChange={(e) => setFPlc(e.target.value)}
              >
                <option value="">— všetky zaradenia —</option>
                {plcs.map((p) => (
                  <option key={p["Zaradenie"]} value={p["Zaradenie"]}>
                    {labelFor(p["Zaradenie"])}
                  </option>
                ))}
              </select>
            </div>

            {selected ? (
              // Vybraný produkt — doťahnuté kľúče pre spoľahlivý deep-link.
              <div className="flex items-center justify-between gap-3 rounded-xl border border-blue-500 bg-blue-500/10 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{selected.name}</div>
                  <div className="truncate text-xs opacity-70">
                    {selected.shop}
                    {selected.price_sale
                      ? ` · ${selected.price_sale} ${cur}`
                      : ""}
                    {selected.amount ? ` • ${selected.amount} ${selected.unit}` : ""}
                    {selected.price_sale_unit
                      ? ` (${selected.price_sale_unit} ${cur}/${unitLabel(selected.unit)})`
                      : ""}
                    {selected.active ? " · akcia beží" : " · mimo akcie"}
                  </div>
                  {productLine && (
                    <div className="mt-1 space-y-0.5 text-[11px] italic opacity-70">
                      <div className="truncate">Titul: „{outTitle}"</div>
                      <div className="line-clamp-2">Text: „{outMessage}"</div>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    setQuery("");
                  }}
                  className="shrink-0 rounded-lg border border-black/10 bg-[var(--surface)] px-2 py-1 text-xs hover:border-black/30"
                >
                  Zmeniť
                </button>
              </div>
            ) : (
              <div className="relative">
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setShowHits(true);
                  }}
                  onFocus={() => setShowHits(true)}
                  placeholder="Začni písať názov produktu… (alebo vyber filter hore)"
                  className={inputCls}
                />
                {(showHits || hasFilter) &&
                  (query.trim().length >= 2 || hasFilter) && (
                  <div className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-black/10 bg-[var(--surface)] shadow-xl">
                    {searching && (
                      <div className="px-3 py-2 text-sm opacity-60">Hľadám…</div>
                    )}
                    {!searching && hits.length === 0 && (
                      <div className="px-3 py-2 text-sm opacity-60">
                        Nič sa nenašlo
                      </div>
                    )}
                    {!searching &&
                      hits.map((h, i) => (
                        <button
                          key={`${h.name}|${h.shop}|${i}`}
                          type="button"
                          onClick={() => {
                            setSelected(h);
                            setShowHits(false);
                          }}
                          className="flex w-full items-center justify-between gap-3 border-b border-black/5 px-3 py-2 text-left last:border-b-0 hover:bg-black/5"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {h.name}
                            </span>
                            <span className="block truncate text-xs opacity-60">
                              {h.shop}
                              {h.price_sale ? ` · ${h.price_sale} ${cur}` : ""}
                              {dateRange(h) ? ` · ${dateRange(h)}` : ""}
                            </span>
                          </span>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              h.active
                                ? "bg-green-500/20 text-green-700"
                                : "bg-black/10 opacity-60"
                            }`}
                          >
                            {h.active ? "akcia" : "mimo"}
                          </span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}

            <p className="mt-2 text-xs opacity-60">
              Vyber konkrétny produkt → po tapnutí na notifikáciu otvorí appka
              rovno tento produkt. Nechaj prázdne = obyčajný oznam, len otvorí
              appku.
            </p>
          </div>

          <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={testMode}
                onChange={(e) => setTestMode(e.target.checked)}
                className="h-4 w-4"
              />
              🧪 Testovací režim — pošli LEN na môj telefón
            </label>
            {testMode && (
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={loadDevices}
                    disabled={loadingDevices}
                    className="rounded-lg border border-black/10 bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold hover:border-black/30 disabled:opacity-50"
                  >
                    {loadingDevices ? "Načítavam…" : "🔑 Načítať môj token"}
                  </button>
                  <span className="text-xs opacity-60">
                    (najnovšia registrácia = tvoj telefón)
                  </span>
                </div>

                {devices.length > 0 && (
                  <select
                    className={selectCls}
                    value={deviceToken}
                    onChange={(e) => setDeviceToken(e.target.value)}
                  >
                    {devices.map((d, i) => (
                      <option key={d.token} value={d.token}>
                        {i === 0 ? "★ najnovšie · " : ""}
                        {d.country.toUpperCase()} · …{d.tokenTail} ·{" "}
                        {d.updated_at
                          ? new Date(d.updated_at).toLocaleString("sk-SK")
                          : ""}
                      </option>
                    ))}
                  </select>
                )}

                <textarea
                  value={deviceToken}
                  onChange={(e) => setDeviceToken(e.target.value)}
                  rows={2}
                  placeholder="…alebo sem ručne vlož FCM device token svojho telefónu"
                  className={`${inputCls} resize-none font-mono text-xs`}
                />
                <p className="text-xs opacity-70">
                  Notifikácia pôjde IBA na toto zariadenie, nie ostatným. Tip:
                  na telefóne zapni/obnov strážneho psa a hneď klikni „Načítať
                  môj token" — najnovšia registrácia bude tvoja.
                </p>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-black/10 bg-[var(--surface)]/40 p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={scheduleMode}
                onChange={(e) => setScheduleMode(e.target.checked)}
                className="h-4 w-4"
              />
              ⏰ Naplánovať na neskôr
            </label>
            {scheduleMode && (
              <div className="mt-2 space-y-1">
                <input
                  type="datetime-local"
                  value={sendAt}
                  min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                  onChange={(e) => setSendAt(e.target.value)}
                  className={inputCls}
                />
                <p className="text-xs opacity-70">
                  Notifikáciu odošle server v zvolený čas — <strong>PC ani
                  editor nemusia bežať</strong>. Čas je v našom čase (SK).
                </p>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={send}
            disabled={sending}
            className={`w-full rounded-xl px-4 py-3 font-semibold text-white transition disabled:opacity-50 ${
              scheduleMode
                ? "bg-indigo-600 hover:bg-indigo-500"
                : testMode
                  ? "bg-amber-600 hover:bg-amber-500"
                  : "bg-blue-600 hover:bg-blue-500"
            }`}
          >
            {sending
              ? "Pracujem…"
              : scheduleMode
                ? testMode
                  ? "⏰ Naplánovať test"
                  : "⏰ Naplánovať odoslanie"
                : testMode
                  ? "🧪 Poslať test len mne"
                  : "📣 Poslať notifikáciu všetkým"}
          </button>

          {result && (
            <div
              className={`rounded-xl px-4 py-3 text-sm ${
                result.ok
                  ? "border border-green-500/40 bg-green-500/10 text-green-700"
                  : "border border-red-500/40 bg-red-500/10 text-red-700"
              }`}
            >
              {result.text}
            </div>
          )}

          {scheduled.length > 0 && (
            <div className="rounded-2xl border border-black/10 p-3">
              <div className="mb-2 text-sm font-semibold">
                ⏰ Naplánované ({scheduled.length})
              </div>
              <div className="space-y-2">
                {scheduled.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-black/10 bg-[var(--surface)] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {new Date(s.send_at).toLocaleString("sk-SK")} ·{" "}
                        {s.country.toUpperCase()}
                        {s.token ? " · TEST" : ""}
                      </div>
                      <div className="truncate text-xs opacity-60">
                        {s.title || s.message || "(bez textu)"}
                        {s.data && (s.data as Record<string, unknown>).product
                          ? ` · → ${(s.data as Record<string, unknown>).product}`
                          : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => cancelScheduled(s.id)}
                      className="shrink-0 rounded-lg border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-700 hover:bg-red-500/20"
                    >
                      Zrušiť
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>

    {confirmBox && (
      <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
        <div className="w-full max-w-sm rounded-2xl bg-[color:var(--form)] p-5 text-[color:var(--ink)] shadow-[var(--shadow)] ring-1 ring-black/10">
          <div className="whitespace-pre-line text-sm leading-relaxed">
            {confirmBox.message}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                confirmBox.resolve(false);
                setConfirmBox(null);
              }}
              className="rounded-xl border border-black/10 bg-[var(--surface)] px-4 py-2 text-sm font-semibold hover:border-black/30"
            >
              Zrušiť
            </button>
            <button
              type="button"
              autoFocus
              onClick={() => {
                confirmBox.resolve(true);
                setConfirmBox(null);
              }}
              className={`rounded-xl px-4 py-2 text-sm font-semibold text-white transition ${
                confirmBox.tone === "amber"
                  ? "bg-amber-600 hover:bg-amber-500"
                  : confirmBox.tone === "indigo"
                    ? "bg-indigo-600 hover:bg-indigo-500"
                    : "bg-blue-600 hover:bg-blue-500"
              }`}
            >
              Potvrdiť
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
