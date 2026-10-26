// Porovnanie AI modelov na tom istom letáku — cena aj presnosť.
//
// Leták sa oreže na prvých N strán, pošle sa bežiacemu editoru (npm run dev
// s ALLOW_MODEL_OVERRIDE=1) raz pre každý model a výsledok sa porovná so
// schválenými produktmi toho letáku v master_products_v2 (rovnaký obchod
// a dátum od). Rozpočet je strážený: po prekročení --budget sa skončí.
//
//   node --env-file=.env.local scripts/benchmark-models.mjs --pdf leták.pdf
//     --shop billa --country sk --from 28.10.2026 --pages 4
//     --models gpt-4.1-mini,gpt-4.1-nano,gemini-2.5-flash-lite --budget 0.5

import fs from "node:fs";
import * as mupdf from "mupdf";
import { createClient } from "@supabase/supabase-js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
const pages = Number(args.pages || 4);
const models = (args.models || "gpt-4.1-mini,gpt-4.1-nano").split(",");
const budget = Number(args.budget || 0.5);
const url = args.url || "http://localhost:3000";
if (!args.pdf || !args.shop || !args.from) {
  console.error("Treba --pdf, --shop a --from (dátum od, napr. 28.10.2026).");
  process.exit(1);
}

// 1) Orezanie letáku na prvých N strán.
const src = mupdf.Document.openDocument(fs.readFileSync(args.pdf), "application/pdf").asPDF();
const out = new mupdf.PDFDocument();
const n = Math.min(pages, src.countPages());
for (let i = 0; i < n; i++) out.graftPage(-1, src, i);
const trimmed = out.saveToBuffer("compress").asUint8Array();
console.log(`Leták: ${src.countPages()} strán → testujem ${n}`);

// 2) Schválené produkty letáku (pravda).
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: truth, error } = await db
  .from("master_products_v2")
  .select("name, placement, price_sale")
  .eq("country", args.country || "sk")
  .ilike("shop", `${args.shop}%`)
  .eq("date_from", args.from);
if (error) throw error;
console.log(`Schválených produktov letáku v DB: ${truth.length}`);

const words = (s) =>
  new Set(
    (s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .map((w) => w.slice(0, 5)),
  );
const sim = (a, b) => {
  const A = words(a);
  const B = words(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.max(1, Math.min(A.size, B.size));
};
const price = (p) => String(p || "").replace(",", ".").replace(/[^\d.]/g, "");

// 3) Modely jeden po druhom, so strážením rozpočtu.
let spent = 0;
const rows = [];
for (const model of models) {
  if (spent >= budget) {
    console.log(`Rozpočet $${budget} vyčerpaný — ${model} preskočený.`);
    continue;
  }
  const form = new FormData();
  form.append("file", new Blob([trimmed], { type: "application/pdf" }), "test.pdf");
  form.append("country", args.country || "sk");
  form.append("shop", args.shop);
  form.append("model", model);
  const t0 = Date.now();
  const res = await fetch(`${url}/api/ai/parse-flyer`, { method: "POST", body: form });
  const json = await res.json();
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (!res.ok) {
    console.log(`${model}: CHYBA ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    continue;
  }
  const cost = json.tokenStats?.estimatedCostUsd || 0;
  spent += cost;
  const items = json.items || [];
  let matched = 0;
  let placementOk = 0;
  let priceOk = 0;
  const wrong = [];
  for (const it of items) {
    let best = null;
    let bestSim = 0;
    for (const t of truth) {
      const s = sim(it.name, t.name);
      if (s > bestSim) {
        bestSim = s;
        best = t;
      }
    }
    if (!best || bestSim < 0.6) continue;
    matched++;
    if (it.placementKey === best.placement) placementOk++;
    else wrong.push(`${it.name}: ${it.placementKey || "—"} ≠ ${best.placement}`);
    if (price(it.price_sale) === price(best.price_sale)) priceOk++;
  }
  rows.push({ model, items: items.length, matched, placementOk, priceOk, cost, secs });
  console.log(
    `${model}: ${items.length} produktov, v DB nájdených ${matched}, zaradenie OK ${placementOk}, cena OK ${priceOk}, $${cost.toFixed(4)}, ${secs}s`,
  );
  for (const w of wrong.slice(0, 8)) console.log(`   ✗ ${w}`);
}

console.log(`\nSpolu minuté: $${spent.toFixed(4)}`);
console.table(rows);
