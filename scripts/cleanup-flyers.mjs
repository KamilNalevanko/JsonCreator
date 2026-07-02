// Jednorazové/opakovateľné čistenie letákov v Supabase Storage (cap-data/databazy).
//
// Čo robí pre každú krajinu (sk, cz, pl):
//  1. Zmaže legacy/odpadové súbory (slovakia.json, czechia.json, poland.json, idl_4.json).
//  2. Zmaže sloty letákov, ktoré sú PLNE expirované (žiadny produkt s platnosťou dnes/v budúcnosti).
//     - Dátumy s nezmyselným rokom (mimo 2024..budúci rok) sa považujú za neplatné → expirované
//       (rieši preklepy typu 2062 / 2202 / 0026, ktoré by inak držali leták "aktívny" naveky).
//  3. Prečísluje zvyšné sloty na súvislé {shop}_1..{shop}_K (appka sa zastaví na prvej diere!).
//     Základný súbor {shop}.json (bez čísla) sa zaradí ako najstarší.
//  4. Prepíše index _indexes/{shop}.json na {next: K+1, isFull: false}.
//
// Spustenie:  node scripts/cleanup-flyers.mjs           (dry-run, nič nemení)
//             node scripts/cleanup-flyers.mjs --apply   (reálne vykoná zmeny)

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APPLY = process.argv.includes("--apply");
const BUCKET = "cap-data";
const COUNTRIES = ["sk", "cz", "pl"];
const BLACKLIST = new Set(["slovakia.json", "czechia.json", "poland.json", "idl_4.json"]);

// ---- env ----
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
for (const line of readFileSync(join(root, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Chýba NEXT_PUBLIC_SUPABASE_URL alebo SUPABASE_SERVICE_ROLE_KEY v .env.local");
  process.exit(1);
}
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

// ---- helpers ----
const today = new Date();
today.setHours(0, 0, 0, 0);
const minYear = 2024;
const maxYear = today.getFullYear() + 1;

function parseDate(s) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec((s ?? "").toString().trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < minYear || y > maxYear || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, mo - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Slot má zmysel držať, ak obsahuje produkt viditeľný dnes alebo v budúcnosti:
// obidva dátumy platné (vrátane rozumného roka) a "do" >= dnes.
function slotIsAlive(dbJson) {
  if (!Array.isArray(dbJson)) return false;
  for (const cat of dbJson) {
    for (const sub of cat?.["Podkategórie"] ?? []) {
      for (const zar of sub?.["Zaradenia"] ?? []) {
        for (const p of zar?.["Produkty"] ?? []) {
          const from = parseDate(p?.["Dátum akcie od"]);
          const to = parseDate(p?.["Dátum akcie do"]);
          if (from && to && to >= today) return true;
        }
      }
    }
  }
  return false;
}

async function listAll(prefix) {
  const out = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await sb.storage.from(BUCKET).list(prefix, { limit: 100, offset });
    if (error) throw new Error(`list ${prefix}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 100) break;
    offset += 100;
  }
  return out;
}

async function download(path) {
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error) throw new Error(`download ${path}: ${error.message}`);
  return JSON.parse(await data.text());
}

async function remove(paths) {
  if (!paths.length) return;
  const { error } = await sb.storage.from(BUCKET).remove(paths);
  if (error) throw new Error(`remove: ${error.message}`);
}

async function move(from, to) {
  const { error } = await sb.storage.from(BUCKET).move(from, to);
  if (error) throw new Error(`move ${from} -> ${to}: ${error.message}`);
}

async function uploadJson(path, obj) {
  const { error } = await sb.storage.from(BUCKET).upload(path, JSON.stringify(obj, null, 2), {
    contentType: "application/json",
    upsert: true,
  });
  if (error) throw new Error(`upload ${path}: ${error.message}`);
}

// ---- main ----
let deletions = 0, moves = 0, indexUpdates = 0;

for (const country of COUNTRIES) {
  const base = `databazy/${country}`;
  console.log(`\n======== ${country.toUpperCase()} (${base}) ========`);
  const entries = (await listAll(base)).filter((e) => e.name.endsWith(".json"));

  // Rozdeľ na skupiny podľa obchodu; base súbor {shop}.json = slot 0.
  const shops = new Map(); // shop -> [{slot, name}]
  const toDelete = [];

  for (const e of entries) {
    if (BLACKLIST.has(e.name)) {
      toDelete.push(`${base}/${e.name}`);
      console.log(`  DELETE (blacklist)  ${e.name}`);
      continue;
    }
    const m = /^(.+?)(?:_(\d+))?\.json$/.exec(e.name);
    if (!m) continue;
    const shop = m[1];
    const slot = m[2] ? Number(m[2]) : 0;
    if (!shops.has(shop)) shops.set(shop, []);
    shops.get(shop).push({ slot, name: e.name });
  }

  for (const [shop, files] of [...shops.entries()].sort()) {
    files.sort((a, b) => a.slot - b.slot);
    const alive = [];
    for (const f of files) {
      let json;
      try {
        json = await download(`${base}/${f.name}`);
      } catch (err) {
        console.log(`  DELETE (nečitateľný) ${f.name}  (${err.message})`);
        toDelete.push(`${base}/${f.name}`);
        continue;
      }
      if (slotIsAlive(json)) {
        alive.push(f);
      } else {
        toDelete.push(`${base}/${f.name}`);
        console.log(`  DELETE (expirovaný) ${f.name}`);
      }
    }

    // Prečíslovanie preživších na _1.._K (v pôvodnom poradí slotov).
    const planMoves = [];
    alive.forEach((f, i) => {
      const target = `${shop}_${i + 1}.json`;
      if (f.name !== target) planMoves.push({ from: `${base}/${f.name}`, to: `${base}/${target}` });
    });
    for (const mv of planMoves) console.log(`  MOVE   ${mv.from.split("/").pop()} -> ${mv.to.split("/").pop()}`);

    const nextIndex = { next: alive.length + 1, isFull: false };
    console.log(`  INDEX  _indexes/${shop}.json = ${JSON.stringify(nextIndex)}  (živých slotov: ${alive.length})`);

    if (APPLY) {
      // Poradie: najprv mazanie (uvoľní čísla), potom presuny vzostupne, potom index.
      // (mazanie tejto skupiny sa vykoná nižšie spolu s ostatnými — presuny až po ňom)
      shops.get(shop).moves = planMoves;
      shops.get(shop).index = nextIndex;
    }
    deletions += files.length - alive.length;
    moves += planMoves.length;
    indexUpdates += 1;
  }

  if (APPLY) {
    await remove(toDelete);
    for (const [shop, files] of [...shops.entries()].sort()) {
      for (const mv of files.moves ?? []) await move(mv.from, mv.to);
      if (files.index) await uploadJson(`${base}/_indexes/${shop}.json`, files.index);
    }
    console.log(`  ✔ ${country}: aplikované (${toDelete.length} zmazaných)`);
  }
}

console.log(`\n==== SÚHRN ${APPLY ? "(APLIKOVANÉ)" : "(DRY-RUN — nič sa nezmenilo)"} ====`);
console.log(`Zmazať: ${deletions + 0} dátových súborov | Presunúť: ${moves} | Indexy: ${indexUpdates}`);
if (!APPLY) console.log("Spusti s --apply pre vykonanie.");
