import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const loadEnvFile = (fileName) => {
  const filePath = path.resolve(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return;
    const key = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    if (!key || process.env[key]) return;
    const value = rawValue.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
    process.env[key] = value;
  });
};

loadEnvFile(".env.local");

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRole) {
  console.error("Missing SUPABASE env (URL or SERVICE_ROLE_KEY).");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRole, {
  auth: { persistSession: false },
});

const normalizeNameKey = (value) =>
  (value || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");

const foldSpecialLatin = (value) =>
  (value || "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "l")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .replace(/ß/g, "ss")
    .replace(/ø/g, "o")
    .replace(/Ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/Æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/Œ/g, "oe");

const normalizeKey = (value) =>
  foldSpecialLatin(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const normalizeKeyTight = (value) =>
  normalizeKey(value).replace(/[^a-z0-9]+/g, "");

const SHOP_ALIASES = {
  billa: "billa",
  coopjednota: "potraviny",
  coopjednotasupermarket: "supermarket",
  cooptempo: "tempo",
  fresh: "fresh",
  kaufland: "kaufland",
  lidl: "lidl",
  milkagro: "milkagro",
  mojobchod: "mojobchod",
  tescohypermarket: "tescohypermarket",
  tescosupermarket: "tescosupermarket",
  biedronka: "biedronka",
  potraviny: "potraviny",
  supermarket: "supermarket",
  tempo: "tempo",
};

const normalizeShopToken = (value) => {
  const normalized = normalizeKeyTight(value);
  return SHOP_ALIASES[normalized] ?? normalized;
};

const normalizeShops = (value) => {
  if (!Array.isArray(value)) return [];
  const normalized = value.map((item) => normalizeShopToken(String(item)));
  return Array.from(new Set(normalized.filter(Boolean)));
};

const countries = [
  { code: "sk", file: "slovakia" },
  { code: "cz", file: "czechia" },
  { code: "pl", file: "poland" },
];

const parseCountryFilter = () => {
  const raw = (process.env.MIGRATE_COUNTRIES || "").trim().toLowerCase();
  if (!raw) return null;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const downloadJson = async (country, file) => {
  const storagePath = `databazy/${country}/${file}.json`;
  const { data, error } = await supabase.storage
    .from("cap-data")
    .download(storagePath);
  if (error || !data) {
    throw new Error(
      `Cannot download ${storagePath}: ${error?.message || "Unknown"}`
    );
  }
  const text = await data.text();
  return JSON.parse(text);
};

const flattenHierarchyExplodeByShop = (country, payload) => {
  if (!Array.isArray(payload)) {
    throw new Error("Expected hierarchy JSON array.");
  }

  const rows = [];

  payload.forEach((category) => {
    const catKey = category?.["Kategória"] || "";
    (category?.["Podkategórie"] || []).forEach((subcategory) => {
      const subKey = subcategory?.["Podkategória"] || "";
      (subcategory?.["Zaradenia"] || []).forEach((placement) => {
        const plcKey = placement?.["Zaradenie"] || "";
        (placement?.["Produkty"] || []).forEach((product) => {
          const name = product?.["Názov"] || "";
          if (!name || !catKey || !subKey || !plcKey) return;

          const shops = normalizeShops(product?.["Obchody"]);
          const name_key = normalizeNameKey(name);

          // ak by náhodou chýbali obchody – dáme sentinel (nech sa to nestratí)
          const effectiveShops = shops.length ? shops : ["<NO_SHOP>"];

          for (const shop of effectiveShops) {
            rows.push({
              country,
              shop,
              name,
              name_key,
              category: catKey,
              subcategory: subKey,
              placement: plcKey,
              amount: product?.["Množstvo"] || "",
              unit: product?.["Merná jednotka"] || "",
              price_regular: product?.["Bežná cena za bal."] || "",
              price_regular_unit: product?.["Bežná jednotková cena"] || "",
              price_sale: product?.["Akciová cena"] || "",
              price_sale_unit: product?.["Akciová jednotková cena"] || "",
              info: product?.["Doplnková Informácia"] || "",
              date_from: product?.["Dátum akcie od"] || "",
              date_to: product?.["Dátum akcie do"] || "",
            });
          }
        });
      });
    });
  });

  // ✅ dôležité: dedup len v rámci (country, shop, name_key)
  const deduped = new Map();
  rows.forEach((row) => {
    const key = [row.country, row.shop, row.name_key].join("||");
    deduped.set(key, row);
  });

  return Array.from(deduped.values());
};

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const run = async () => {
  const filter = parseCountryFilter();
  const selected = filter
    ? countries.filter((item) => filter.includes(item.code))
    : countries;

  for (const { code, file } of selected) {
    console.log(`Importing ${code} (${file})...`);
    const payload = await downloadJson(code, file);
    const rows = flattenHierarchyExplodeByShop(code, payload);
    console.log(`  rows: ${rows.length}`);

    for (const batch of chunk(rows, 500)) {
      const { error } = await supabase
        .from("master_products_v2")
        .upsert(batch, { onConflict: "country,shop,name_key" });
      if (error) throw new Error(`Upsert failed: ${error.message}`);
    }
  }

  console.log("Done.");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});