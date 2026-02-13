"use client";

import { useMemo, useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
import hierarchyData from "../assets/hierarchia.json";
import skLabels from "../assets/langs/sk.json";
import czLabels from "../assets/langs/cs.json";
import plLabels from "../assets/langs/pl.json";

type HierarchyCategory = {
  "Kategória": string;
  "Podkategórie": HierarchySubcategory[];
};

type HierarchySubcategory = {
  "Podkategória": string;
  "Zaradenia": HierarchyPlacement[];
};

type HierarchyPlacement = {
  "Zaradenie": string;
  "Produkty": FlyerProduct[];
};

type FlyerProduct = {
  "Názov": string;
  "Kategória": string;
  "Podkategória": string;
  "Zaradenie": string;
  "Množstvo": string;
  "Merná jednotka": string;
  "Bežná cena za bal.": string;
  "Bežná jednotková cena": string;
  "Akciová cena": string;
  "Akciová jednotková cena": string;
  "Doplnková Informácia": string;
  "Dátum akcie od": string;
  "Dátum akcie do": string;
};

type ProductEntry = {
  id: string;
  product: FlyerProduct;
};

const hierarchy = hierarchyData as HierarchyCategory[];
const languageMap = {
  sk: skLabels,
  cz: czLabels,
  pl: plLabels,
} as Record<string, Record<string, string>>;
const labelMap = skLabels as Record<string, string>;

const unitOptions = ["g", "kg", "ml", "l", "ks", "bal"];

const labelFor = (key: string) => labelMap[key] ?? key.replace(/_/g, " ");

const calculateUnitPrice = (price: string, amount: string): string => {
  if (!price.trim() || !amount.trim()) return '';
  const priceNum = parseFloat(price.replace(',', '.'));
  const amountNum = parseFloat(amount.replace(',', '.'));
  if (isNaN(priceNum) || isNaN(amountNum) || amountNum === 0) return '';
  const unitPrice = priceNum / amountNum;
  return unitPrice.toFixed(2).replace('.', ',');
};

const normalizePrice = (value: string) => value.replace(/\./g, ",").trim();

const makeId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export default function Home() {
  const [language, setLanguage] = useState("sk");
  const [shop, setShop] = useState("billa");
  const [flyerDateFrom, setFlyerDateFrom] = useState("");
  const [flyerDateTo, setFlyerDateTo] = useState("");
  const [categoryKey, setCategoryKey] = useState(
    hierarchy[0]?.["Kategória"] ?? ""
  );
  const [subcategoryKey, setSubcategoryKey] = useState(
    hierarchy[0]?.["Podkategórie"]?.[0]?.["Podkategória"] ?? ""
  );
  const [placementKey, setPlacementKey] = useState(
    hierarchy[0]?.["Podkategórie"]?.[0]?.["Zaradenia"]?.[0]?.["Zaradenie"] ??
      ""
  );
  const [form, setForm] = useState({
    name: "",
    amount: "",
    unit: "kg",
    priceSale: "",
    priceSaleUnit: "",
    info: "",
    dateFrom: "",
    dateTo: "",
  });
  const [products, setProducts] = useState<ProductEntry[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loadedFlyer, setLoadedFlyer] = useState<typeof flyerData | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [bucketPath, setBucketPath] = useState("sk");

  const currentLabels = useMemo(
    () => languageMap[language as keyof typeof languageMap] || languageMap.sk,
    [language]
  );

  const locLabelFor = (key?: string) => {
    if (!key) return "";
    return currentLabels[key] ?? key.replace(/_/g, " ");
  };
  const t = (key: string, vars: Record<string, string> = {}) => {
    const template = currentLabels[key] ?? key.replace(/_/g, " ");
    return Object.entries(vars).reduce(
      (acc, [varKey, value]) =>
        acc.replace(new RegExp(`\\{${varKey}\\}`, "g"), value),
      template
    );
  };

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const supabase = useMemo(() => {
    if (!supabaseUrl || !supabaseKey) {
      return null;
    }
    return createClient(supabaseUrl, supabaseKey);
  }, [supabaseUrl, supabaseKey]);

  const formatCategoryPath = (cat?: string, subcat?: string, placement?: string) => {
    const parts = [cat, subcat, placement].filter(Boolean).map(p => locLabelFor(p));
    return parts.join(" / ");
  };

  const selectedCategory = useMemo(
    () => hierarchy.find((item) => item["Kategória"] === categoryKey),
    [categoryKey]
  );

  const selectedSubcategory = useMemo(
    () =>
      selectedCategory?.["Podkategórie"].find(
        (item) => item["Podkategória"] === subcategoryKey
      ),
    [selectedCategory, subcategoryKey]
  );

  useEffect(() => {
    if (!selectedCategory) {
      return;
    }
    const hasSubcategory = selectedCategory["Podkategórie"].some(
      (item) => item["Podkategória"] === subcategoryKey
    );
    if (hasSubcategory) {
      return;
    }
    const nextSub = selectedCategory["Podkategórie"][0]?.["Podkategória"] ?? "";
    setSubcategoryKey(nextSub);
  }, [selectedCategory, subcategoryKey]);

  useEffect(() => {
    if (!selectedSubcategory) {
      return;
    }
    const hasPlacement = selectedSubcategory["Zaradenia"].some(
      (item) => item["Zaradenie"] === placementKey
    );
    if (hasPlacement) {
      return;
    }
    const nextPlacement =
      selectedSubcategory["Zaradenia"][0]?.["Zaradenie"] ?? "";
    setPlacementKey(nextPlacement);
  }, [selectedSubcategory, placementKey]);

  const flyerData = useMemo(() => {
    const productMap = new Map<string, FlyerProduct[]>();
    for (const entry of products) {
      const key = `${entry.product["Kategória"]}||${entry.product["Podkategória"]}||${entry.product["Zaradenie"]}`;
      const existing = productMap.get(key) ?? [];
      productMap.set(key, [...existing, entry.product]);
    }

    return hierarchy.map((category) => ({
      "Kategória": category["Kategória"],
      "Podkategórie": category["Podkategórie"].map((subcategory) => ({
        "Podkategória": subcategory["Podkategória"],
        "Zaradenia": subcategory["Zaradenia"].map((placement) => {
          const key = `${category["Kategória"]}||${subcategory["Podkategória"]}||${placement["Zaradenie"]}`;
          return {
            "Zaradenie": placement["Zaradenie"],
            "Produkty": productMap.get(key) ?? [],
          };
        }),
      })),
    }));
  }, [products]);

  const jsonPreview = useMemo(() => {
    // Ak máme načítané dáta, kombinujem ich s novými produktami
    if (loadedFlyer) {
      const mergedData = JSON.parse(JSON.stringify(loadedFlyer));
      
      // Ak je to hierarchická štruktúra, updatem produkty
      if (mergedData.Podkategórie && Array.isArray(mergedData.Podkategórie)) {
        for (const cat of mergedData.Podkategórie) {
          if (cat.Zaradenia && Array.isArray(cat.Zaradenia)) {
            for (const zaradenie of cat.Zaradenia) {
              // Nájdi zodpovedajúce produkty z flyerData
              const newProds = flyerData
                .find((fc) => fc["Kategória"] === mergedData["Kategória"])
                ?.[
                  "Podkategórie"
                ]?.find((sub) => sub["Podkategória"] === cat["Podkategória"])
                ?.["Zaradenia"].find((z) => z["Zaradenie"] === zaradenie["Zaradenie"])
                ?.[
                  "Produkty"
                ] ?? [];
              
              // Kombinujem staré + nové
              if (!zaradenie["Produkty"]) {
                zaradenie["Produkty"] = [];
              }
              zaradenie["Produkty"] = [
                ...zaradenie["Produkty"],
                ...newProds,
              ];
            }
          }
        }
      }
      
      return JSON.stringify(mergedData, null, 2);
    }
    
    return JSON.stringify(flyerData, null, 2);
  }, [flyerData, loadedFlyer]);


  const resetFormFields = () => {
    setForm((prev) => ({
      ...prev,
      name: "",
      amount: "",
      priceSale: "",
      priceSaleUnit: "",
      info: "",
    }));
  };

  const addProduct = () => {
    setError("");
    setStatus("");
    if (!categoryKey || !subcategoryKey || !placementKey) {
      setError(t("error_select_hierarchy"));
      return;
    }
    if (!form.name.trim()) {
      setError(t("error_product_name"));
      return;
    }

    const product: FlyerProduct = {
      "Názov": form.name.trim(),
      "Kategória": categoryKey,
      "Podkategória": subcategoryKey,
      "Zaradenie": placementKey,
      "Množstvo": form.amount.trim(),
      "Merná jednotka": form.unit,
      "Akciová cena": normalizePrice(form.priceSale),
      "Akciová jednotková cena": normalizePrice(form.priceSaleUnit),
      "Doplnková Informácia": form.info.trim(),
      "Dátum akcie od": form.dateFrom.trim(),
      "Dátum akcie do": form.dateTo.trim(),
    };

    if (editingId) {
      setProducts((prev) =>
        prev.map((item) =>
          item.id === editingId ? { id: item.id, product } : item
        )
      );
      setEditingId(null);
    } else {
      setProducts((prev) => [...prev, { id: makeId(), product }]);
    }
    resetFormFields();
  };

  const removeProduct = (id: string) => {
    setProducts((prev) => prev.filter((item) => item.id !== id));
    if (editingId === id) {
      setEditingId(null);
      resetFormFields();
    }
  };

  const startEdit = (entry: ProductEntry) => {
    setError("");
    setStatus("");
    setEditingId(entry.id);
    setCategoryKey(entry.product["Kategória"] ?? "");
    setSubcategoryKey(entry.product["Podkategória"] ?? "");
    setPlacementKey(entry.product["Zaradenie"] ?? "");
    setForm((prev) => ({
      ...prev,
      name: entry.product["Názov"] ?? "",
      amount: entry.product["Množstvo"] ?? "",
      unit: entry.product["Merná jednotka"] ?? "kg",
      priceSale: normalizePrice(entry.product["Akciová cena"] ?? ""),
      priceSaleUnit: normalizePrice(
        entry.product["Akciová jednotková cena"] ?? ""
      ),
      info: entry.product["Doplnková Informácia"] ?? "",
      dateFrom: entry.product["Dátum akcie od"] ?? prev.dateFrom,
      dateTo: entry.product["Dátum akcie do"] ?? prev.dateTo,
    }));
  };

  const cancelEdit = () => {
    setEditingId(null);
    resetFormFields();
  };

  const handleLoadJson = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      
      // Uloži nahraný flyer bez zmeny produktov v UI
      setLoadedFlyer(data);
      // Nastav názov súboru automaticky
      setFileName(file.name);
      setStatus(t("status_loaded_file"));
      setError("");
      
      // Reset file input
      if (event.target) {
        event.target.value = "";
      }
    } catch (err) {
      setError(t("error_load_json"));
      console.error("Load JSON error:", err);
    }
  };

  const buildFileName = () => {
    const safeShop = shop
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    
    // Get current date as fallback
    const today = new Date();
    const fallbackDay = String(today.getDate()).padStart(2, "0");
    const fallbackMonth = String(today.getMonth() + 1).padStart(2, "0");
    const fallbackYear = today.getFullYear();
    const fallbackDate = `${fallbackDay}.${fallbackMonth}.${fallbackYear}`;
    
    // Use flyerDateFrom and flyerDateTo for filename generation
    const from = flyerDateFrom || fallbackDate;
    const to = flyerDateTo || fallbackDate;
    
    // Extract day.month from 'from' (DD.MM.YYYY format)
    const fromParts = from.split(".");
    const fromShort = fromParts.length === 3 ? `${fromParts[0]}.${fromParts[1]}` : from;
    
    // Keep full 'to' date (DD.MM.YYYY format)
    return `${safeShop || "letak"}_${fromShort}-${to}.json`;
  };

  const resolvedFileName = useMemo(() => {
    return buildFileName();
  }, [shop, flyerDateFrom, flyerDateTo]);

  const downloadJson = () => {
    setStatus("");
    const safeName = resolvedFileName.endsWith(".json")
      ? resolvedFileName
      : `${resolvedFileName}.json`;
    const blob = new Blob([jsonPreview], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeName;
    link.click();
    URL.revokeObjectURL(url);
  };

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(jsonPreview);
      setStatus(t("status_copied"));
    } catch {
      setError(t("error_copy"));
    }
  };

  const uploadToSupabase = async () => {
    setError("");
    setStatus("");
    if (!supabase) {
      setError(t("error_supabase_env"));
      return;
    }
    const safeName = resolvedFileName.endsWith(".json")
      ? resolvedFileName
      : `${resolvedFileName}.json`;
    const safeShop = shop
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const basePath = `databazy/${bucketPath}`;
    const targetPath = `${basePath}/${safeShop || "nezaradene"}/${safeName}`;

    try {
      setIsUploading(true);
      const { error: uploadError } = await supabase.storage
        .from("cap-data")
        .upload(targetPath, jsonPreview, {
          contentType: "application/json",
          upsert: false,
        });

      if (uploadError) {
        setError(
          t("error_upload_failed_detail", { message: uploadError.message })
        );
        return;
      }
      setStatus(t("status_uploaded"));
    } catch (err) {
      setError(t("error_upload_failed"));
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="relative min-h-screen">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-24 top-16 h-64 w-64 rounded-full bg-[#ffd8b8] blur-3xl" />
        <div className="absolute bottom-12 right-12 h-72 w-72 rounded-full bg-[#b8d8ff] blur-[120px]" />
      </div>

      <main className="relative mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-8 pb-16 pt-12">
        <header className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-sm uppercase tracking-[0.3em] text-[color:var(--muted)]">
              {t("app_badge")}
            </span>
            <select
              className="rounded-xl border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-[color:var(--ink)] outline-none"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
            >
              <option value="sk">🇸🇰 {t("lang_sk")}</option>
              <option value="cz">🇨🇿 {t("lang_cz")}</option>
              <option value="pl">🇵🇱 {t("lang_pl")}</option>
            </select>
          </div>
          <h1 className="font-[var(--font-display)] text-4xl font-semibold text-[color:var(--ink)] md:text-5xl">
            {t("app_title")}
          </h1>
          <p className="max-w-2xl text-base text-[color:var(--muted)]">
            {t("app_subtitle")}
          </p>
        </header>

        <section className="grid gap-6 lg:grid-cols-[minmax(760px,1fr)_840px]">
          <div className="rounded-3xl bg-[color:var(--panel)] p-6 shadow-[var(--shadow)] animate-[fade-in_0.6s_ease-out]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className="font-[var(--font-display)] text-2xl text-[color:var(--ink)]">
                {t("section_input")}
              </h2>
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-[color:var(--muted)]">
                {t("products_count")} <span>{products.length}</span>
              </div>
            </div>

            <div className="mt-6 grid gap-4">
              <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                {t("label_shop")}
                <input
                  className="rounded-xl border border-black/10 bg-white px-4 py-3 text-[color:var(--ink)] outline-none transition focus:border-black/30"
                  value={shop}
                  onChange={(event) => setShop(event.target.value)}
                  placeholder="billa"
                />
              </label>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                  {t("label_flyer_date_from")}
                  <input
                    type="date"
                    className="rounded-xl border border-black/10 bg-white px-4 py-3 text-[color:var(--ink)] outline-none transition focus:border-black/30"
                    value={flyerDateFrom ? flyerDateFrom.split(".").reverse().join("-") : ""}
                    onChange={(event) => {
                      if (event.target.value) {
                        const [year, month, day] = event.target.value.split("-");
                        setFlyerDateFrom(`${day}.${month}.${year}`);
                      } else {
                        setFlyerDateFrom("");
                      }
                    }}
                  />
                </label>
                <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                  {t("label_flyer_date_to")}
                  <input
                    type="date"
                    className="rounded-xl border border-black/10 bg-white px-4 py-3 text-[color:var(--ink)] outline-none transition focus:border-black/30"
                    value={flyerDateTo ? flyerDateTo.split(".").reverse().join("-") : ""}
                    onChange={(event) => {
                      if (event.target.value) {
                        const [year, month, day] = event.target.value.split("-");
                        setFlyerDateTo(`${day}.${month}.${year}`);
                      } else {
                        setFlyerDateTo("");
                      }
                    }}
                  />
                </label>
              </div>

              <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                <strong>📄 {t("label_final_filename")}:</strong>
                <div className="mt-1 font-mono text-gray-700">{resolvedFileName}</div>
              </div>

              <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                {t("label_storage_folder")}
                <select
                  className="rounded-xl border border-black/10 bg-white px-3 py-3 text-[color:var(--ink)] outline-none"
                  value={bucketPath}
                  onChange={(event) => setBucketPath(event.target.value)}
                >
                  <option value="sk">{t("storage_sk")}</option>
                  <option value="cz">{t("storage_cz")}</option>
                  <option value="pl">{t("storage_pl")}</option>
                </select>
              </label>

              <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                {t("label_load_json")}
                <input
                  className="rounded-xl border border-black/10 bg-white px-4 py-3 text-[color:var(--ink)] outline-none transition focus:border-black/30 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-orange-500 file:text-white hover:file:brightness-95"
                  type="file"
                  accept=".json"
                  onChange={handleLoadJson}
                />
              </label>

              <div className="grid gap-3 md:grid-cols-3">
                <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                  {t("label_category")}
                  <select
                    className="rounded-xl border border-black/10 bg-white px-3 py-3 text-[color:var(--ink)] outline-none"
                    value={categoryKey}
                    onChange={(event) => setCategoryKey(event.target.value)}
                  >
                    {hierarchy.map((item) => (
                      <option key={item["Kategória"]} value={item["Kategória"]}>
                        {locLabelFor(item["Kategória"])}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                  {t("label_subcategory")}
                  <select
                    className="rounded-xl border border-black/10 bg-white px-3 py-3 text-[color:var(--ink)] outline-none"
                    value={subcategoryKey}
                    onChange={(event) => setSubcategoryKey(event.target.value)}
                  >
                    {selectedCategory?.["Podkategórie"].map((item) => (
                      <option key={item["Podkategória"]} value={item["Podkategória"]}>
                        {locLabelFor(item["Podkategória"])}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                  {t("label_placement")}
                  <select
                    className="rounded-xl border border-black/10 bg-white px-3 py-3 text-[color:var(--ink)] outline-none"
                    value={placementKey}
                    onChange={(event) => setPlacementKey(event.target.value)}
                  >
                    {selectedSubcategory?.["Zaradenia"].map((item) => (
                      <option key={item["Zaradenie"]} value={item["Zaradenie"]}>
                        {locLabelFor(item["Zaradenie"])}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                {t("label_product_name")}
                <input
                  className="rounded-xl border border-black/10 bg-white px-4 py-3 text-[color:var(--ink)] outline-none transition focus:border-black/30"
                  value={form.name}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, name: event.target.value }))
                  }
                  placeholder={t("placeholder_product_name")}
                />
              </label>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                  {t("label_amount")}
                  <input
                    className="w-full max-w-[160px] rounded-xl border border-black/10 bg-white px-4 py-3 text-[color:var(--ink)] outline-none"
                    value={form.amount}
                    onChange={(event) => {
                      const newAmount = event.target.value;
                      setForm((prev) => ({
                        ...prev,
                        amount: newAmount,
                        priceSaleUnit: calculateUnitPrice(prev.priceSale, newAmount),
                      }));
                    }}
                    placeholder="1"
                  />
                </label>
                <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                  {t("label_unit")}
                  <select
                    className="w-full max-w-[160px] rounded-xl border border-black/10 bg-white px-3 py-3 text-[color:var(--ink)] outline-none"
                    value={form.unit}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, unit: event.target.value }))
                    }
                  >
                    {unitOptions.map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                {t("label_extra_info")}
                <input
                  className="rounded-xl border border-black/10 bg-white px-4 py-3 text-[color:var(--ink)] outline-none"
                  value={form.info}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, info: event.target.value }))
                  }
                  placeholder={t("placeholder_extra_info")}
                />
              </label>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                  {t("label_sale_price")}
                  <input
                    className="w-full max-w-[200px] rounded-xl border border-black/10 bg-white px-4 py-3 text-[color:var(--ink)] outline-none"
                    value={form.priceSale}
                    onChange={(event) => {
                      const newPrice = normalizePrice(event.target.value);
                      setForm((prev) => ({
                        ...prev,
                        priceSale: newPrice,
                        priceSaleUnit: calculateUnitPrice(newPrice, prev.amount),
                      }));
                    }}
                    placeholder="3,49"
                  />
                </label>
                <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                  {t("label_sale_unit_price")}
                  <input
                    className="w-full max-w-[200px] rounded-xl border border-black/10 bg-white px-4 py-3 text-[color:var(--ink)] outline-none"
                    value={form.priceSaleUnit}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        priceSaleUnit: normalizePrice(event.target.value),
                      }))
                    }
                    placeholder="3.49 / kg"
                  />
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                  {t("label_date_from")}
                  <input
                    type="date"
                    className="w-full max-w-[200px] rounded-xl border border-black/10 bg-white px-4 py-3 text-[color:var(--ink)] outline-none"
                    value={form.dateFrom ? form.dateFrom.split(".").reverse().join("-") : ""}
                    onChange={(event) => {
                      if (event.target.value) {
                        const [year, month, day] = event.target.value.split("-");
                        setForm((prev) => ({
                          ...prev,
                          dateFrom: `${day}.${month}.${year}`,
                        }));
                      } else {
                        setForm((prev) => ({
                          ...prev,
                          dateFrom: "",
                        }));
                      }
                    }}
                  />
                </label>
                <label className="grid gap-2 text-sm text-[color:var(--muted)]">
                  {t("label_date_to")}
                  <input
                    type="date"
                    className="w-full max-w-[200px] rounded-xl border border-black/10 bg-white px-4 py-3 text-[color:var(--ink)] outline-none"
                    value={form.dateTo ? form.dateTo.split(".").reverse().join("-") : ""}
                    onChange={(event) => {
                      if (event.target.value) {
                        const [year, month, day] = event.target.value.split("-");
                        setForm((prev) => ({
                          ...prev,
                          dateTo: `${day}.${month}.${year}`,
                        }));
                      } else {
                        setForm((prev) => ({
                          ...prev,
                          dateTo: "",
                        }));
                      }
                    }}
                  />
                </label>
              </div>

              {error ? (
                <div className="rounded-xl border border-[#ffd3b6] bg-[#fff1e6] px-4 py-3 text-sm text-[#8a3e00]">
                  {error}
                </div>
              ) : null}
              {status ? (
                <div className="rounded-xl border border-[#cfe8ff] bg-[#eaf4ff] px-4 py-3 text-sm text-[#0f335a]">
                  {status}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <button
                  className="rounded-full bg-[color:var(--accent)] px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-orange-200 transition hover:brightness-95"
                  onClick={addProduct}
                  type="button"
                >
                  {editingId ? t("btn_save_changes") : t("btn_add_product")}
                </button>
                {editingId ? (
                  <button
                    className="rounded-full border border-black/10 px-6 py-3 text-sm font-semibold text-[color:var(--ink)] transition hover:border-black/30"
                    onClick={cancelEdit}
                    type="button"
                  >
                    {t("btn_cancel_edit")}
                  </button>
                ) : null}
                <button
                  className="rounded-full border border-black/10 px-6 py-3 text-sm font-semibold text-[color:var(--ink)] transition hover:border-black/30"
                  onClick={() => {
                    setProducts([]);
                    setLoadedFlyer(null);
                  }}
                  type="button"
                >
                  {t("btn_clear_all")}
                </button>
              </div>
            </div>

            <div className="mt-8 border-t border-black/5 pt-6">
              <h3 className="font-[var(--font-display)] text-lg text-[color:var(--ink)]">
                {t("section_products")}
              </h3>
              <div className="mt-4 grid gap-3">
                {products.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-black/10 bg-[#faf7f2] px-4 py-6 text-sm text-[color:var(--muted)]">
                    {t("empty_products")}
                  </div>
                ) : (
                  products.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-black/5 bg-white px-4 py-4"
                    >
                      <div>
                        <div className="text-sm font-semibold text-[color:var(--ink)]">
                          {entry.product["Názov"]}
                        </div>
                        <div className="text-xs text-[color:var(--muted)]">
                          {formatCategoryPath(
                            entry.product["Kategória"],
                            entry.product["Podkategória"],
                            entry.product["Zaradenie"]
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          className="rounded-full border border-black/10 px-3 py-1 text-xs font-semibold text-[color:var(--muted)] transition hover:border-black/30"
                          onClick={() => startEdit(entry)}
                          type="button"
                        >
                          {t("btn_edit")}
                        </button>
                        <button
                          className="rounded-full border border-black/10 px-3 py-1 text-xs font-semibold text-[color:var(--muted)] transition hover:border-black/30"
                          onClick={() => removeProduct(entry.id)}
                          type="button"
                        >
                          {t("btn_remove")}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="mt-8 rounded-3xl border border-black/5 bg-white/70 p-6 text-sm text-[color:var(--muted)] shadow-[var(--shadow)]">
              <h3 className="font-[var(--font-display)] text-lg text-[color:var(--ink)]">
                {t("section_note")}
              </h3>
              <p className="mt-2">
                {t("note_body")}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-6">
            <div className="flex flex-col rounded-3xl bg-[#0f1b2b] p-6 text-white shadow-[var(--shadow)] animate-[float-in_0.6s_ease-out]">
              <h2 className="font-[var(--font-display)] text-2xl">
                {t("section_output")}
              </h2>
              <p className="mt-2 text-sm text-white/70">
                {t("output_subtitle")}
              </p>
              <div className="mt-4 flex flex-wrap gap-3 lg:justify-end">
                <button
                  className="rounded-full bg-white px-4 py-2 text-xs font-semibold text-[#0f1b2b]"
                  onClick={copyJson}
                  type="button"
                >
                  {t("btn_copy_json")}
                </button>
                <button
                  className="rounded-full border border-white/40 px-4 py-2 text-xs font-semibold text-white"
                  onClick={downloadJson}
                  type="button"
                >
                  {t("btn_download_file")}
                </button>
                <button
                  className="rounded-full border border-white/40 px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
                  onClick={uploadToSupabase}
                  type="button"
                  disabled={isUploading}
                >
                  {isUploading ? t("btn_uploading") : t("btn_upload_supabase")}
                </button>
              </div>
              <pre className="mt-4 max-h-[900px] overflow-auto rounded-2xl bg-[#0b1220] p-4 text-xs leading-5 text-white/80">
                {jsonPreview}
              </pre>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
