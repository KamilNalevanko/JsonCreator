"use client";

import React, { useMemo, useState, useEffect, useRef } from "react";
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
  "Obchody"?: string[];
};

type ProductEntry = {
  id: string;
  product: FlyerProduct;
};

type LoadedProductRef = {
  categoryIndex: number;
  subcategoryIndex: number;
  placementIndex: number;
  productIndex: number;
};

type LoadedProductEntry = {
  id: string;
  name: string;
  product: FlyerProduct;
  categoryKey: string;
  subcategoryKey: string;
  placementKey: string;
  ref: LoadedProductRef;
};

type AiExtractItem = {
  name: string;
  amount?: string;
  unit?: string;
  price_sale?: string;
  price_regular?: string;
  note?: string;
  date_from?: string;
  date_to?: string;
  page?: number | null;
  product?: FlyerProduct;
  match?: null;
  suggestions?: [];
  categoryKey?: string;
  subcategoryKey?: string;
  placementKey?: string;
};

type AiExtractMeta = {
  date_from?: string;
  date_to?: string;
};

const hierarchy = hierarchyData as HierarchyCategory[];
const languageMap = {
  sk: skLabels,
  cz: czLabels,
  pl: plLabels,
} as Record<string, Record<string, string>>;
const labelMap = skLabels as Record<string, string>;

const unitOptions = ["g", "kg", "ml", "l", "ks", "bal"];

// helper removed - use `locLabelFor` instead

const calculateUnitPrice = (price: string, amount: string, unit: string): string => {
  if (!price?.trim() || !amount?.trim()) return '';
  const priceNum = parseFloat(price.replace(',', '.'));
  const amountNum = parseFloat(amount.replace(',', '.'));
  if (isNaN(priceNum) || isNaN(amountNum) || amountNum === 0) return '';
  
  // Pre gramy a mililitry prepočítaj na kg/l (vynásob 1000)
  let multiplier = 1;
  if (unit === 'g' || unit === 'ml') {
    multiplier = 1000;
  }
  
  const unitPrice = (priceNum / amountNum) * multiplier;
  return unitPrice.toFixed(2).replace('.', ',');
};

const normalizePrice = (value: string) => (value || "").replace(/\./g, ",").trim();

const foldSpecialLatin = (s: string) =>
  (s || "")
    // PL
    .replace(/ł/g, "l")
    .replace(/Ł/g, "l")
    // bonus (neškodí)
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .replace(/ß/g, "ss")
    .replace(/ø/g, "o")
    .replace(/Ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/Æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/Œ/g, "oe");

const normalizeKey = (value: string) =>
  foldSpecialLatin(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

// “zlepená” verzia – odstráni medzery, pomlčky, bodky… nech ostane len a-z/0-9
const normalizeKeyTight = (value: string) =>
  normalizeKey(value).replace(/[^a-z0-9]+/g, "");

const GLOBAL_SHOP_TOKEN = "global";
const SHOP_ALIASES: Record<string, string> = {
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
  auchanhypermarket: "auchanhipermarket",
  auchanhipermarket: "auchanhipermarket",
  auchansupermarket: "auchansupermarket",
  aldi: "aldi",
  dino: "dino",
  lewiatan: "lewiatan",
  carrefour: "carrefour",
  carrefourmarket: "carrefourmarket",
  carrefourexpress: "carrefourexpress",
  stokrotkaexpress: "stokrotkaexpress",
  stokrotkamarket: "stokrotkamarket",
  stokrotkasupermarket: "stokrotkasupermarket",
  zabka: "zabka",
  potraviny: "potraviny",
};
const normalizeShopToken = (value: string) => {
  const normalized = normalizeKeyTight(value);
  return SHOP_ALIASES[normalized] ?? normalized;
};
const productMatchesShop = (product: FlyerProduct, shopKey: string) => {
  const target = normalizeShopToken(shopKey);
  const tokens = (product["Obchody"] ?? []).map(normalizeShopToken);
  if (tokens.length === 0) return true;
  if (tokens.includes(GLOBAL_SHOP_TOKEN)) return true;

  const allowedTargets = new Set([target]);
  if (target === "tempo") {
    allowedTargets.add("potraviny");
  }
  if (target === "supermarket") {
    allowedTargets.add("potraviny");
    allowedTargets.add("tempo");
  }
  if (target === "tescohypermarket") {
    allowedTargets.add("tescosupermarket");
  }
  if (target === "stokrotkamarket") {
    allowedTargets.add("stokrotkaexpress");
  }
  if (target === "stokrotkasupermarket") {
    allowedTargets.add("stokrotkamarket");
    allowedTargets.add("stokrotkaexpress");
  }
  if (target === "auchanhipermarket") {
    allowedTargets.add("auchansupermarket");
  }
  if (target === "carrefourmarket") {
    allowedTargets.add("carrefourexpress");
  }
  if (target === "carrefour") {
    allowedTargets.add("carrefourmarket");
    allowedTargets.add("carrefourexpress");
  }

  return tokens.some((token) => allowedTargets.has(token));
};

// ✅ jeden matcher pre všetko (názvy, info, zoznam…)
const matchesSearch = (candidate: string, query: string) => {
  const q = normalizeKey(query);
  if (!q) return true;

  const c = normalizeKey(candidate);
  if (c.includes(q)) return true;

  const qt = normalizeKeyTight(query);
  const ct = normalizeKeyTight(candidate);
  return qt.length > 0 && ct.includes(qt);
};




const parseDateFromSk = (dateStr: string): Date | null => {
  if (!dateStr) return null;
  const [day, month, year] = dateStr.split(".");
  return new Date(`${year}-${month}-${day}`);
};

const formatDateToSk = (date: Date): string => {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
};

const getDateDifference = (dateFrom: string, dateTo: string): number => {
  const from = parseDateFromSk(dateFrom);
  const to = parseDateFromSk(dateTo);
  if (!from || !to) return 0;
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
};

const addDaysToDate = (dateStr: string, days: number): string => {
  const date = parseDateFromSk(dateStr);
  if (!date) return "";
  date.setDate(date.getDate() + days);
  return formatDateToSk(date);
};

const getTodayDate = (): string => {
  const today = new Date();
  return formatDateToSk(today);
};

const formatDateRange = (dateFrom?: string, dateTo?: string) => {
  if (dateFrom && dateTo) {
    if (dateFrom === dateTo) return dateFrom;
    return `${dateFrom} – ${dateTo}`;
  }
  if (dateFrom) return `od ${dateFrom}`;
  if (dateTo) return `do ${dateTo}`;
  return "";
};

const makeId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [palette, setPalette] = useState("blue");
  const [customPalette, setCustomPalette] = useState({
    background: "#ffffff",
    form: "#e9eef2",
  });
  const [showCustomPalette, setShowCustomPalette] = useState(false);
  const [language, setLanguage] = useState("sk");
  const [aiPdfFile, setAiPdfFile] = useState<File | null>(null);
  const [aiExtracted, setAiExtracted] = useState<AiExtractItem[]>([]);
  const [aiExtractMeta, setAiExtractMeta] = useState<AiExtractMeta>({});
  const [aiExtractStatus, setAiExtractStatus] = useState("");
  const [aiExtractError, setAiExtractError] = useState("");
  const [aiDebugText, setAiDebugText] = useState("");
  const [aiEditingIdx, setAiEditingIdx] = useState<number | null>(null);
  const [aiDetectedShop, setAiDetectedShop] = useState("");
  const [aiDetectedCountry, setAiDetectedCountry] = useState("");
  const [aiSaveModal, setAiSaveModal] = useState(false);
  const [aiSaveShop, setAiSaveShop] = useState("");
  const [aiSaveCountry, setAiSaveCountry] = useState("sk");
  const [aiSaveStatus, setAiSaveStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isAiSaving, setIsAiSaving] = useState(false);
  const [isAiExtracting, setIsAiExtracting] = useState(false);
  const [shop, setShop] = useState("billa");
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
    priceRegular: "",
    priceRegularUnit: "",
    priceSale: "",
    priceSaleUnit: "",
    info: "",
    dateFrom: "",
    dateTo: "",
  });
  const [products, setProducts] = useState<ProductEntry[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loadedFlyer, setLoadedFlyer] = useState<HierarchyCategory[] | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [bucketPath, setBucketPath] = useState("sk");
  const [editingLoadedRef, setEditingLoadedRef] = useState<LoadedProductRef | null>(null);
  const [dbEditRef, setDbEditRef] = useState<LoadedProductRef | null>(null);
  const [previewProduct, setPreviewProduct] = useState<{
    id?: string;
    name: string;
    product: FlyerProduct;
    categoryKey: string;
    subcategoryKey: string;
    placementKey: string;
    ref?: LoadedProductRef;
  } | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState<typeof loadedProductsList>([]);
  const [showInfoSuggestions, setShowInfoSuggestions] = useState(false);
  const [filteredInfoSuggestions, setFilteredInfoSuggestions] = useState<string[]>([]);
  const [activeInfoSuggestionIndex, setActiveInfoSuggestionIndex] = useState<number>(-1);
  const infoSuggestionItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const suggestionsBoxRef = useRef<HTMLDivElement | null>(null);
  const infoInputRef = useRef<HTMLInputElement | null>(null);
  const infoSuggestionsBoxRef = useRef<HTMLDivElement | null>(null);
  const dateFromInputRef = useRef<HTMLInputElement | null>(null);
  const dateToInputRef = useRef<HTMLInputElement | null>(null);
  const aiFileInputRef = useRef<HTMLInputElement | null>(null);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState<number>(-1);
  const suggestionItemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [productListQuery, setProductListQuery] = useState("");
  const [showUploadConfirm, setShowUploadConfirm] = useState(false);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);
  const [dbDeleteConfirmRef, setDbDeleteConfirmRef] = useState<{
    ref: LoadedProductRef;
    name: string;
  } | null>(null);
  const lastLoadKeyRef = useRef<string>("");
  const appendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingAppendRef = useRef(0);
  const [isAppending, setIsAppending] = useState(false);
  const [isDbUpdating, setIsDbUpdating] = useState(false);
  const shopOptionsByFolder: Record<
    string,
    Array<{ value: string; label: string }>
  > = {
    sk: [
      { value: "billa", label: "Billa" },
      { value: "coop-jednota", label: "COOP Jednota" },
      { value: "coop-jednota-supermarket", label: "COOP Jednota Supermarket" },
      { value: "coop-tempo", label: "COOP Tempo" },
      { value: "fresh", label: "Fresh" },
      { value: "kaufland", label: "Kaufland" },
      { value: "lidl", label: "Lidl" },
      { value: "milk-agro", label: "Milk Agro" },
      { value: "moj-obchod", label: "Môj Obchod" },
      { value: "tesco-hypermarket", label: "Tesco Hypermarket" },
      { value: "tesco-supermarket", label: "Tesco Supermarket" },
      { value: "biedronka", label: "Biedronka" },
    ],
    pl: [
      { value: "biedronka", label: "Biedronka" },
      { value: "lidl", label: "Lidl" },
      { value: "kaufland", label: "Kaufland" },
      { value: "auchan-hypermarket", label: "Auchan Hipermarket" },
      { value: "auchan-supermarket", label: "Auchan Supermarket" },
      { value: "aldi", label: "Aldi" },
      { value: "dino", label: "Dino" },
      { value: "stokrotka-express", label: "Stokrotka Express" },
      { value: "stokrotka-market", label: "Stokrotka Market" },
      { value: "stokrotka-supermarket", label: "Stokrotka Supermarket" },
      { value: "lewiatan", label: "Lewiatan" },
      { value: "carrefour-express", label: "Carrefour Express" },
      { value: "carrefour-market", label: "Carrefour Market" },
      { value: "carrefour", label: "Carrefour" },
      { value: "zabka", label: "Żabka" },
    ],
    cz: [
      { value: "tesco-hypermarket", label: "Tesco Hypermarket" },
      { value: "tesco-supermarket", label: "Tesco Supermarket" },
      { value: "peny", label: "Peny" },
      { value: "lidl", label: "Lidl" },
      { value: "kaufland", label: "Kaufland" },
      { value: "globus", label: "Globus" },
      { value: "billa-velka", label: "Billa veľká" },
      { value: "billa-mala", label: "Billa malá" },
      { value: "bala", label: "Bala" },
      { value: "albert-hypermarket", label: "Albert Hypermarket" },
      { value: "albert-supermarket", label: "Albert Supermarket" },
    ],
  };
  const countryFileByFolder: Record<string, string> = {
    sk: "slovakia",
    pl: "poland",
    cz: "czechia",
  };
  const shopOptions = useMemo(
    () => shopOptionsByFolder[bucketPath] ?? [],
    [bucketPath]
  );

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "dark" || saved === "light") {
      setTheme(saved);
    }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("palette");
    if (
      saved === "blue" ||
      saved === "turquoise" ||
      saved === "green" ||
      saved === "classic" ||
      saved === "pink" ||
      saved === "custom"
    ) {
      setPalette(saved);
    }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("customPalette");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed?.background && parsed?.form) {
          setCustomPalette(parsed);
        }
      } catch {
        // ignore invalid storage
      }
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.palette = palette;
    localStorage.setItem("palette", palette);
  }, [palette]);

  useEffect(() => {
    if (palette === "custom" && theme === "light") {
      document.documentElement.style.setProperty("--background", customPalette.background);
      document.documentElement.style.setProperty("--form", customPalette.form);
      document.documentElement.style.setProperty("--paper", customPalette.form);
    } else {
      document.documentElement.style.removeProperty("--background");
      document.documentElement.style.removeProperty("--form");
      document.documentElement.style.removeProperty("--paper");
    }
    localStorage.setItem("customPalette", JSON.stringify(customPalette));
  }, [palette, theme, customPalette]);


  useEffect(() => {
    const available = shopOptionsByFolder[bucketPath] ?? [];
    const hasCurrent = available.some((option) => option.value === shop);
    if (!hasCurrent) {
      setShop(available[0]?.value ?? "");
    }
    setError("");
    setLoadedFlyer(null);
    setProducts([]);
    setEditingId(null);
    setEditingLoadedRef(null);
    setDbEditRef(null);
  }, [bucketPath]);

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

  const handleAiExtract = async () => {
    setAiExtractError("");
    setAiExtractStatus("");
    if (!aiPdfFile) {
      setAiExtractError(t("ai_extract_error_no_file"));
      return;
    }
    if (!supabase) {
      setAiExtractError("Supabase nie je nakonfigurovaný (chýba URL/KEY).");
      return;
    }
    let storagePath = "";
    try {
      setIsAiExtracting(true);

      // Upload PDF to Supabase Storage via signed URL (bypasses RLS)
      let pdfStoragePath = "";
      {
        // 1) Get a signed upload URL from our API (small JSON, no Vercel limit)
        const urlRes = await fetch("/api/ai/signed-upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: aiPdfFile.name }),
        });
        const urlData = await urlRes.json().catch(() => ({}));
        if (!urlRes.ok || !urlData.signedUrl) {
          setAiExtractError(`Nepodarilo sa získať upload URL: ${urlData.error || "unknown"}`);
          return;
        }
        // 2) Upload PDF directly to Supabase (bypasses Vercel entirely)
        const uploadRes = await fetch(urlData.signedUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/pdf" },
          body: aiPdfFile,
        });
        if (!uploadRes.ok) {
          setAiExtractError(`Upload PDF na Supabase zlyhal: ${uploadRes.status}`);
          return;
        }
        pdfStoragePath = urlData.storagePath;
        storagePath = urlData.storagePath;
      }

      // 3) Send only the storage path to API (small JSON payload)
      const response = await fetch("/api/ai/parse-flyer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storagePath: pdfStoragePath,
          country: bucketPath,
          shop: shop,
          debug: "1",
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setAiExtractError(payload?.error || t("ai_extract_failed"));
        return;
      }
      const meta =
        payload?.meta && typeof payload.meta === "object" ? payload.meta : {};
      const items = Array.isArray(payload?.items) ? payload.items : [];
      setAiExtractMeta(meta);
      setAiExtracted(items);
      setAiDebugText(typeof payload?.debugText === "string" ? payload.debugText : "");
      setAiDetectedShop(typeof payload?.detectedShop === "string" ? payload.detectedShop : "");
      setAiDetectedCountry(typeof payload?.detectedCountry === "string" ? payload.detectedCountry : "");
      setAiSaveStatus(null);

      const nextDateFrom = typeof meta?.date_from === "string" ? meta.date_from : "";
      const nextDateTo = typeof meta?.date_to === "string" ? meta.date_to : "";

      if (nextDateFrom || nextDateTo) {
        setForm((prev) => ({
          ...prev,
          dateFrom: nextDateFrom || prev.dateFrom,
          dateTo: nextDateTo || prev.dateTo,
        }));
      }

      const dateLabel = formatDateRange(nextDateFrom, nextDateTo);
      setAiExtractStatus(
        `${t("ai_found_items")}: ${items.length}${dateLabel ? ` • Leták: ${dateLabel}` : ""}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : t("ai_extract_failed");
      setAiExtractError(message);
    } finally {
      // Clean up temp PDF from Supabase Storage
      if (supabase && storagePath) {
        supabase.storage.from("cap-data").remove([storagePath]).catch(() => {});
      }
      setIsAiExtracting(false);
    }
  };

  const applyAiItem = (item: AiExtractItem) => {
    const nextPriceRegular = item.price_regular || "";
    const nextPriceSale = item.price_sale || "";
    const nextAmount = item.amount || "";
    const nextUnit = item.unit || "kg";

    setForm((prev) => ({
      ...prev,
      name: item.name || "",
      amount: nextAmount,
      unit: nextUnit,
      priceRegular: nextPriceRegular,
      priceRegularUnit: calculateUnitPrice(nextPriceRegular, nextAmount, nextUnit),
      priceSale: nextPriceSale,
      priceSaleUnit: calculateUnitPrice(nextPriceSale, nextAmount, nextUnit),
      info: item.note || prev.info,
      dateFrom: item.date_from || aiExtractMeta.date_from || "",
      dateTo: item.date_to || aiExtractMeta.date_to || "",
    }));

    focusNameInput();
  };

  const resolveProductShops = (ref?: LoadedProductRef | null, entryId?: string | null) => {
    if (ref && loadedFlyer) {
      const { categoryIndex, subcategoryIndex, placementIndex, productIndex } = ref;
      const original =
        loadedFlyer[categoryIndex]?.["Podkategórie"]?.[subcategoryIndex]?.["Zaradenia"]?.[
          placementIndex
        ]?.["Produkty"]?.[productIndex];
      return Array.isArray(original?.["Obchody"]) ? original["Obchody"] : [];
    }
    if (entryId) {
      const existing = products.find((entry) => entry.id === entryId);
      return Array.isArray(existing?.product?.["Obchody"]) ? existing!.product["Obchody"] : [];
    }
    const normalized = normalizeShopToken(shop);
    return normalized ? [normalized] : [];
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

  // Close suggestion dropdowns when clicking outside inputs/dropdowns
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;

      if (showSuggestions) {
        const insideName = nameInputRef.current && nameInputRef.current.contains(target as Node);
        const insideSuggestions = suggestionsBoxRef.current && suggestionsBoxRef.current.contains(target as Node);
        if (!insideName && !insideSuggestions) {
          setShowSuggestions(false);
          setFilteredSuggestions([]);
        }
      }

      if (showInfoSuggestions) {
        const insideInfo = infoInputRef.current && infoInputRef.current.contains(target as Node);
        const insideInfoSuggestions = infoSuggestionsBoxRef.current && infoSuggestionsBoxRef.current.contains(target as Node);
        if (!insideInfo && !insideInfoSuggestions) {
          setShowInfoSuggestions(false);
          setFilteredInfoSuggestions([]);
          setActiveInfoSuggestionIndex(-1);
        }
      }
    };

    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSuggestions, showInfoSuggestions]);

  // Keep keyboard highlight visible inside the info suggestions dropdown
  useEffect(() => {
    if (!showInfoSuggestions) return;
    if (activeInfoSuggestionIndex < 0) return;
    const el = infoSuggestionItemRefs.current[activeInfoSuggestionIndex];
    if (el) el.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [activeInfoSuggestionIndex, showInfoSuggestions, filteredInfoSuggestions.length]);

  // Keep keyboard highlight visible inside the suggestions dropdown
  useEffect(() => {
    if (!showSuggestions) return;
    if (activeSuggestionIndex < 0) return;
    const el = suggestionItemRefs.current[activeSuggestionIndex];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [activeSuggestionIndex, showSuggestions, filteredSuggestions.length]);


  const selectedSubcategory = useMemo(
    () =>
      selectedCategory?.["Podkategórie"].find(
        (item) => item["Podkategória"] === subcategoryKey
      ),
    [selectedCategory, subcategoryKey]
  );

  const sortedPlacements = useMemo(() => {
    const placements = selectedSubcategory?.["Zaradenia"] ?? [];
    return [...placements].sort((a, b) => {
      const aIsSpecial = normalizeKey(a["Zaradenie"]) === "rozne druhy";
      const bIsSpecial = normalizeKey(b["Zaradenie"]) === "rozne druhy";
      if (aIsSpecial === bIsSpecial) return 0;
      return aIsSpecial ? -1 : 1;
    });
  }, [selectedSubcategory]);

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

  useEffect(() => {
    const hasData = products.length > 0 || loadedFlyer !== null;
    
    if (!hasData) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'Máš neuložené zmeny v letáku. Naozaj chceš opustiť stránku?';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [products, loadedFlyer]);

  const flyerData = useMemo(() => {
    const productMap = new Map<string, FlyerProduct[]>();

    // include products added during this session
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
  }, [products, hierarchy]);

  const normalizeLoadedFlyer = (payload: unknown): HierarchyCategory[] | null => {
    if (Array.isArray(payload)) return payload as HierarchyCategory[];
    const data = (payload as { data?: unknown })?.data;
    if (Array.isArray(data)) return data as HierarchyCategory[];
    const items = (payload as { items?: unknown })?.items;
    if (Array.isArray(items)) return items as HierarchyCategory[];
    return null;
  };

  // Extrahovať všetky produkty z loadedFlyer s ich metadátami
  const loadedProductsList = useMemo<LoadedProductEntry[]>(() => {
    if (!loadedFlyer || !Array.isArray(loadedFlyer)) return [];

    const allProducts: LoadedProductEntry[] = [];

    loadedFlyer.forEach((category: HierarchyCategory, categoryIndex: number) => {
      const categoryKey = category["Kategória"];
      (category["Podkategórie"] ?? []).forEach((subcategory: HierarchySubcategory, subcategoryIndex: number) => {
        const subcategoryKey = subcategory["Podkategória"];
        (subcategory["Zaradenia"] ?? []).forEach((placement: HierarchyPlacement, placementIndex: number) => {
          const placementKey = placement["Zaradenie"];
          (placement["Produkty"] ?? []).forEach((product: FlyerProduct, productIndex: number) => {
            if (!productMatchesShop(product, shop)) return;
            allProducts.push({
              id: `loaded-${categoryIndex}-${subcategoryIndex}-${placementIndex}-${productIndex}`,
              name: product["Názov"],
              product,
              categoryKey,
              subcategoryKey,
              placementKey,
              ref: {
                categoryIndex,
                subcategoryIndex,
                placementIndex,
                productIndex,
              },
            });
          });
        });
      });
    });

    return allProducts;
  }, [loadedFlyer, shop]);

  const selectedLoadedEntry = useMemo(() => {
    if (!editingLoadedRef) return null;
    return (
      loadedProductsList.find(
        (entry) =>
          entry.ref.categoryIndex === editingLoadedRef.categoryIndex &&
          entry.ref.subcategoryIndex === editingLoadedRef.subcategoryIndex &&
          entry.ref.placementIndex === editingLoadedRef.placementIndex &&
          entry.ref.productIndex === editingLoadedRef.productIndex
      ) ?? null
    );
  }, [editingLoadedRef, loadedProductsList]);

  const dbEditEntry = useMemo(() => {
    if (!dbEditRef) return null;
    return (
      loadedProductsList.find(
        (entry) =>
          entry.ref.categoryIndex === dbEditRef.categoryIndex &&
          entry.ref.subcategoryIndex === dbEditRef.subcategoryIndex &&
          entry.ref.placementIndex === dbEditRef.placementIndex &&
          entry.ref.productIndex === dbEditRef.productIndex
      ) ?? null
    );
  }, [dbEditRef, loadedProductsList]);

  // Extrahovať všetky unikátne doplnkové info z loadedFlyer
  const loadedExtraInfosList = useMemo(() => {
    if (!loadedFlyer || !Array.isArray(loadedFlyer)) return [];
    
    const infos = new Set<string>();
    for (const category of loadedFlyer as HierarchyCategory[]) {
      for (const subcategory of category["Podkategórie"] ?? [] as HierarchySubcategory[]) {
        for (const placement of subcategory["Zaradenia"] ?? [] as HierarchyPlacement[]) {
          for (const product of placement["Produkty"] ?? [] as FlyerProduct[]) {
            if (!productMatchesShop(product, shop)) continue;
            const info = product["Doplnková Informácia"]?.trim();
            if (info) {
              infos.add(info);
            }
          }
        }
      }
    }

    return Array.from(infos).sort();
  }, [loadedFlyer, shop]);

  const jsonPreview = useMemo(() => {
    return JSON.stringify(flyerData, null, 2);
  }, [flyerData]);


  const resetFormFields = () => {
    setForm((prev) => ({
      ...prev,
      name: "",
      amount: "",
      priceRegular: "",
      priceRegularUnit: "",
      priceSale: "",
      priceSaleUnit: "",
      info: "",
    }));
  };

  // Keď vyberiem produkt zo zoznamu, naplní sa všetko
  const handleSelectProduct = (selectedProductData: {
    name: string;
    product: FlyerProduct;
    categoryKey: string;
    subcategoryKey: string;
    placementKey: string;
    ref?: LoadedProductRef;
  }) => {
    setDbEditRef(null);
    if (selectedProductData.ref) {
      setEditingLoadedRef(selectedProductData.ref);
      setEditingId(null);
    } else {
      // Skontroluj či je tento produkt už v zozname
      const existingProduct = products.find(
        (p) => p.product["Názov"].toLowerCase() === selectedProductData.name.toLowerCase() &&
        p.product["Kategória"] === selectedProductData.categoryKey &&
        p.product["Podkategória"] === selectedProductData.subcategoryKey &&
        p.product["Zaradenie"] === selectedProductData.placementKey
      );

      // Ak je, nastav na edit mode
      if (existingProduct) {
        setEditingId(existingProduct.id);
      } else {
        // Ak nie, buď to nový produkt
        setEditingId(null);
      }
      setEditingLoadedRef(null);
    }

    setCategoryKey(selectedProductData.categoryKey);
    setSubcategoryKey(selectedProductData.subcategoryKey);
    setPlacementKey(selectedProductData.placementKey);
    setForm((prev) => ({
      ...prev,
      name: selectedProductData.product["Názov"],
      amount: selectedProductData.product["Množstvo"],
      unit: selectedProductData.product["Merná jednotka"],
      priceRegular: selectedProductData.product["Bežná cena za bal."],
      priceRegularUnit: selectedProductData.product["Bežná jednotková cena"],
      priceSale: selectedProductData.product["Akciová cena"],
      priceSaleUnit: selectedProductData.product["Akciová jednotková cena"],
      info: selectedProductData.product["Doplnková Informácia"] || "",
      dateFrom: selectedProductData.product["Dátum akcie od"] || "",
      dateTo: selectedProductData.product["Dátum akcie do"] || "",
    }));
    setPreviewProduct(null);
  };

  const selectLoadedSuggestion = (p: LoadedProductEntry) => {
    handleSelectProduct({
      name: p.name,
      product: p.product,
      categoryKey: p.categoryKey,
      subcategoryKey: p.subcategoryKey,
      placementKey: p.placementKey,
      ref: p.ref,
    });
    setShowSuggestions(false);
    setFilteredSuggestions([]);
    setActiveSuggestionIndex(-1);
  };


  // Global keyboard nav for suggestion dropdowns (prevents page scroll when focus is not on the input)
  useEffect(() => {
    const hasNameList = showSuggestions && filteredSuggestions.length > 0;
    const hasInfoList = showInfoSuggestions && filteredInfoSuggestions.length > 0;
    if (!hasNameList && !hasInfoList) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key;
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Enter" && key !== "Escape") return;

      // Skip if focus is on an input element (local handlers will manage it)
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) {
        return;
      }

      // If any list is open, consume keys so the page doesn't scroll.
      e.preventDefault();

      if (key === "Escape") {
        if (hasNameList) {
          setShowSuggestions(false);
          setFilteredSuggestions([]);
          setActiveSuggestionIndex(-1);
        }
        if (hasInfoList) {
          setShowInfoSuggestions(false);
          setFilteredInfoSuggestions([]);
          setActiveInfoSuggestionIndex(-1);
        }
        return;
      }

      if (key === "Enter") {
        if (hasInfoList) {
          const picked = filteredInfoSuggestions[activeInfoSuggestionIndex];
          if (picked) {
            setForm((prev) => ({ ...prev, info: picked }));
          }
          setShowInfoSuggestions(false);
          setFilteredInfoSuggestions([]);
          setActiveInfoSuggestionIndex(-1);
          focusInfoInput();
          return;
        }

        if (hasNameList) {
          const p = filteredSuggestions[activeSuggestionIndex];
          if (p) {
            selectLoadedSuggestion(p);
          }
        }
        return;
      }

      if (key === "ArrowDown") {
        if (hasInfoList) {
          setActiveInfoSuggestionIndex((prev) =>
            Math.min((prev < 0 ? 0 : prev) + 1, filteredInfoSuggestions.length - 1)
          );
          return;
        }
        if (hasNameList) {
          setActiveSuggestionIndex((prev) =>
            Math.min((prev < 0 ? 0 : prev) + 1, filteredSuggestions.length - 1)
          );
        }
        return;
      }

      if (key === "ArrowUp") {
        if (hasInfoList) {
          setActiveInfoSuggestionIndex((prev) => Math.max((prev < 0 ? 0 : prev) - 1, 0));
          return;
        }
        if (hasNameList) {
          setActiveSuggestionIndex((prev) => Math.max((prev < 0 ? 0 : prev) - 1, 0));
        }
      }
    };

    // capture=true so we catch it even if focus is on body/button and stop page scrolling
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", onKeyDown, { capture: true } as any);
  }, [
    showSuggestions,
    filteredSuggestions.length,
    activeSuggestionIndex,
    showInfoSuggestions,
    filteredInfoSuggestions.length,
    activeInfoSuggestionIndex,
  ]);



  const handleConfirmProduct = () => {
    if (previewProduct) {
      handleSelectProduct(previewProduct);
    }
  };

  const handleCancelPreview = () => {
    setPreviewProduct(null);
    setForm((prev) => ({ ...prev, name: "" }));
  };

  const displayProducts = useMemo(() => {
    return products.map((entry) => ({
      type: "new" as const,
      id: entry.id,
      product: entry.product,
      entry,
    }));
  }, [products]);

  const filteredDisplayProducts = useMemo(() => {
    const query = normalizeKey(productListQuery.trim());
    if (!query) {
      return displayProducts;
    }
    return displayProducts.filter((item) =>
      normalizeKey(item.product["Názov"]).includes(query)
    );
  }, [displayProducts, productListQuery]);

  const isProductInLoadedFlyer = (product: FlyerProduct) =>
    loadedProductsList.some(
      (item) =>
        normalizeKey(item.product["Názov"]) ===
          normalizeKey(product["Názov"]) &&
        item.product["Kategória"] === product["Kategória"] &&
        item.product["Podkategória"] === product["Podkategória"] &&
        item.product["Zaradenie"] === product["Zaradenie"]
    );

  const findLoadedEntryForProduct = (product: FlyerProduct) =>
    loadedProductsList.find(
      (item) =>
        normalizeKey(item.product["Názov"]) ===
          normalizeKey(product["Názov"]) &&
        item.product["Kategória"] === product["Kategória"] &&
        item.product["Podkategória"] === product["Podkategória"] &&
        item.product["Zaradenie"] === product["Zaradenie"]
    ) ?? null;

  const isProductInLoadedFlyerExact = (product: FlyerProduct) =>
    loadedProductsList.some(
      (item) =>
        (item.product["Názov"] || "").trim() ===
          (product["Názov"] || "").trim() &&
        item.product["Kategória"] === product["Kategória"] &&
        item.product["Podkategória"] === product["Podkategória"] &&
        item.product["Zaradenie"] === product["Zaradenie"]
    );

  const normalizeProductValue = (value: unknown) => {
    if (Array.isArray(value)) {
      return [...value].map(String).sort().join("|");
    }
    if (typeof value === "string") return value.trim();
    if (value == null) return "";
    return value;
  };

  const hasProductChanges = (original: FlyerProduct, next: FlyerProduct) => {
    const keys: (keyof FlyerProduct)[] = [
      "Názov",
      "Kategória",
      "Podkategória",
      "Zaradenie",
      "Množstvo",
      "Merná jednotka",
      "Bežná cena za bal.",
      "Bežná jednotková cena",
      "Akciová cena",
      "Akciová jednotková cena",
      "Doplnková Informácia",
      "Dátum akcie od",
      "Dátum akcie do",
      "Obchody",
    ];

    return keys.some(
      (key) =>
        normalizeProductValue(original[key]) !== normalizeProductValue(next[key])
    );
  };

  const appendProductToLoadedFlyer = (product: FlyerProduct) => {
    setLoadedFlyer((prev: HierarchyCategory[] | null) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev)) as HierarchyCategory[];
      const categoryIndex = next.findIndex(
        (c: HierarchyCategory) => c["Kategória"] === product["Kategória"]
      );
      if (categoryIndex === -1) return prev;
      const subIndex = (next[categoryIndex]["Podkategórie"] ?? []).findIndex(
        (s: HierarchySubcategory) => s["Podkategória"] === product["Podkategória"]
      );
      if (subIndex === -1) return prev;
      const placementIndex = (
        next[categoryIndex]["Podkategórie"][subIndex]["Zaradenia"] ?? []
      ).findIndex(
        (p: HierarchyPlacement) => p["Zaradenie"] === product["Zaradenie"]
      );
      if (placementIndex === -1) return prev;

      const placement =
        next[categoryIndex]["Podkategórie"][subIndex]["Zaradenia"][
          placementIndex
        ];
      if (!placement["Produkty"]) placement["Produkty"] = [];
      const exists = placement["Produkty"].some(
        (p: FlyerProduct) =>
          normalizeKey(p["Názov"]) === normalizeKey(product["Názov"])
      );
      if (exists) return prev;
      placement["Produkty"].push(product);
      return next;
    });
  };

  const persistNewProduct = async (product: FlyerProduct) => {
    // Persist into the country JSON stored in Supabase Storage (server-side upsert).
    if (!bucketPath) return { ok: false, added: false };
    try {
      const run = async () => {
        pendingAppendRef.current += 1;
        setIsAppending(true);
        const response = await fetch("/api/master-products/append", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ country: bucketPath, product }),
        });

        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          console.error("Master append failed:", payload);
          setError(
            t("error_upload_failed_detail", {
              message: payload?.error || "Append failed",
            })
          );
          return { ok: false, added: false };
        }

        if (payload?.added) {
          setStatus("Produkt bol pridany do databazy.");
        } else {
          setStatus("Produkt uz existuje v databaze.");
        }

        return { ok: true, added: !!payload?.added };
      };

      const queued = appendQueueRef.current.then(run, run);
      appendQueueRef.current = queued.then(
        () => {},
        () => {}
      );
      return await queued;
    } catch (err) {
      console.error("Master append failed:", err);
      setError(
        t("error_upload_failed_detail", { message: "Append failed" })
      );
      return { ok: false, added: false };
    } finally {
      pendingAppendRef.current = Math.max(0, pendingAppendRef.current - 1);
      if (pendingAppendRef.current === 0) {
        setIsAppending(false);
      }
    }
  };

  const persistUpdatedProduct = async (ref: LoadedProductRef, product: FlyerProduct) => {
    if (!bucketPath) return { ok: false };
    setError("");
    setStatus("");

    try {
      setIsDbUpdating(true);
      const response = await fetch("/api/master-products/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country: bucketPath, ref, product }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok) {
        setError(
          t("error_upload_failed_detail", {
            message: payload?.error || "Update failed",
          })
        );
        return { ok: false };
      }

      setStatus("Produkt v databaze bol upraveny.");
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(t("error_upload_failed_detail", { message }));
      return { ok: false };
    } finally {
      setIsDbUpdating(false);
    }
  };


  const addProduct = () => {
    setError("");
    setStatus("");
    if (isAppending) {
      setStatus("Prebieha ukladanie. Skus o chvilu.");
      return;
    }
    if (!categoryKey || !subcategoryKey) {
      setError(t("error_select_hierarchy"));
      return;
    }
    if (!form.name.trim()) {
      setError(t("error_product_name"));
      return;
    }

    const shops = resolveProductShops(editingLoadedRef, editingId);

    const product: FlyerProduct = {
      "Názov": form.name.trim(),
      "Kategória": categoryKey,
      "Podkategória": subcategoryKey,
      "Zaradenie": placementKey,
      "Množstvo": form.amount.trim(),
      "Merná jednotka": form.unit,
      "Bežná cena za bal.": normalizePrice(form.priceRegular),
      "Bežná jednotková cena": normalizePrice(form.priceRegularUnit),
      "Akciová cena": normalizePrice(form.priceSale),
      "Akciová jednotková cena": normalizePrice(form.priceSaleUnit),
      "Doplnková Informácia": form.info?.trim() || "",
      "Dátum akcie od": form.dateFrom?.trim() || "",
      "Dátum akcie do": form.dateTo?.trim() || "",
      "Obchody": shops,
    };

    const alreadyInLoadedFlyer = isProductInLoadedFlyer(product);

    const isCloneFromLoaded = (() => {
      if (!editingLoadedRef || !loadedFlyer) return false;
      const { categoryIndex, subcategoryIndex, placementIndex, productIndex } =
        editingLoadedRef;
      const original =
        loadedFlyer[categoryIndex]?.["Podkategórie"]?.[subcategoryIndex]?.[
          "Zaradenia"
        ]?.[placementIndex]?.["Produkty"]?.[productIndex];
      if (!original) return false;
      const originalName = (original["Názov"] || "").trim();
      const nextName = (product["Názov"] || "").trim();
      return originalName !== nextName;
    })();

    if (isCloneFromLoaded) {
      setEditingLoadedRef(null);
      setEditingId(null);
      setProducts((prev) => [...prev, { id: makeId(), product }]);
      if (!isProductInLoadedFlyerExact(product)) {
        appendProductToLoadedFlyer(product);
       void persistNewProduct(product); // bez reloadu, nech sa pridá do mastera a bude vidieť pri ďalšom načítaní letáku
      }
      resetFormFields();
      focusNameInput();
      return;
    }

    if (editingLoadedRef && loadedFlyer) {
      const refToUpdate = editingLoadedRef;
      const originalProduct =
        loadedFlyer[refToUpdate.categoryIndex]?.["Podkategórie"]?.[
          refToUpdate.subcategoryIndex
        ]?.["Zaradenia"]?.[refToUpdate.placementIndex]?.["Produkty"]?.[
          refToUpdate.productIndex
        ];
      const shouldUpdateDb =
        !originalProduct || hasProductChanges(originalProduct, product);
      const { categoryIndex, subcategoryIndex, placementIndex, productIndex } = editingLoadedRef;
      setLoadedFlyer((prev: HierarchyCategory[] | null) => {
        if (!prev) return prev;
        const next = JSON.parse(JSON.stringify(prev));

        // original placement reference
        const originalPlacement = next[categoryIndex]?.["Podkategórie"]?.[subcategoryIndex]?.["Zaradenia"]?.[placementIndex];

        // If the hierarchy didn't change, simply replace the product in-place
        if (
          originalPlacement &&
          originalPlacement["Produkty"] &&
          originalPlacement["Produkty"][productIndex]
        ) {
          // check if target location equals original
          const targetCategoryKey = product["Kategória"];
          const targetSubcategoryKey = product["Podkategória"];
          const targetPlacementKey = product["Zaradenie"];

          const sameCategory = next[categoryIndex] && next[categoryIndex]["Kategória"] === targetCategoryKey;
          const sameSubcategory = sameCategory && next[categoryIndex]["Podkategórie"]?.[subcategoryIndex]?.["Podkategória"] === targetSubcategoryKey;
          const samePlacement = sameSubcategory && next[categoryIndex]["Podkategórie"]?.[subcategoryIndex]?.["Zaradenia"]?.[placementIndex]?.["Zaradenie"] === targetPlacementKey;

          if (samePlacement) {
            originalPlacement["Produkty"][productIndex] = product;
            return next;
          }

          // remove from original location
          originalPlacement["Produkty"].splice(productIndex, 1);

          // find target indices
          const newCategoryIndex = next.findIndex((c: HierarchyCategory) => c["Kategória"] === targetCategoryKey);
          if (newCategoryIndex === -1) {
            // can't find target category: put it back into original and bail
            originalPlacement["Produkty"].splice(productIndex, 0, product);
            return next;
          }
          const newSubIndex = (next[newCategoryIndex]["Podkategórie"] ?? []).findIndex((s: HierarchySubcategory) => s["Podkategória"] === targetSubcategoryKey);
          if (newSubIndex === -1) {
            // can't find target subcategory: restore and bail
            originalPlacement["Produkty"].splice(productIndex, 0, product);
            return next;
          }
          const newPlacementIndex = (next[newCategoryIndex]["Podkategórie"]?.[newSubIndex]["Zaradenia"] ?? []).findIndex((p: HierarchyPlacement) => p["Zaradenie"] === targetPlacementKey);
          if (newPlacementIndex === -1) {
            // can't find target placement: restore and bail
            originalPlacement["Produkty"].splice(productIndex, 0, product);
            return next;
          }

          const targetPlacement = next[newCategoryIndex]["Podkategórie"][newSubIndex]["Zaradenia"][newPlacementIndex];
          if (!targetPlacement["Produkty"]) targetPlacement["Produkty"] = [];
          targetPlacement["Produkty"].push(product);
        }
        return next;
      });
      // Keep edited items in the export list (products) so export is "clean" and minimal
      setProducts((prev) => {
        const targetName = normalizeKey(product["Názov"]);
        const next = [...prev];
        const existingIndex = next.findIndex((item) =>
          normalizeKey(item.product["Názov"]) === targetName &&
          item.product["Kategória"] === product["Kategória"] &&
          item.product["Podkategória"] === product["Podkategória"] &&
          item.product["Zaradenie"] === product["Zaradenie"]
        );
        if (existingIndex >= 0) {
          next[existingIndex] = { id: next[existingIndex].id, product };
          return next;
        }
        return [...next, { id: makeId(), product }];
      });
      if (shouldUpdateDb) {
        void persistUpdatedProduct(refToUpdate, product);
      }
      setEditingLoadedRef(null);
    } else if (editingId) {
      setProducts((prev) =>
        prev.map((item) =>
          item.id === editingId ? { id: item.id, product } : item
        )
      );
      setEditingId(null);
    } else {
      setProducts((prev) => [...prev, { id: makeId(), product }]);
      if (!alreadyInLoadedFlyer) {
        appendProductToLoadedFlyer(product);
        void persistNewProduct(product);
      }
    }
    resetFormFields();
       focusNameInput();
  };

  const startDbEdit = (entry: LoadedProductEntry) => {
    setEditingLoadedRef(null);
    setEditingId(null);
    setDbEditRef(entry.ref);
    setShowSuggestions(false);
    setFilteredSuggestions([]);
    setActiveSuggestionIndex(-1);
    setCategoryKey(entry.categoryKey);
    setSubcategoryKey(entry.subcategoryKey);
    setPlacementKey(entry.placementKey);
    setForm((prev) => ({
      ...prev,
      name: entry.product["Názov"] ?? "",
      amount: entry.product["Množstvo"] ?? "",
      unit: entry.product["Merná jednotka"] ?? "kg",
      priceRegular: normalizePrice(entry.product["Bežná cena za bal."] ?? ""),
      priceRegularUnit: normalizePrice(entry.product["Bežná jednotková cena"] ?? ""),
      priceSale: normalizePrice(entry.product["Akciová cena"] ?? ""),
      priceSaleUnit: normalizePrice(entry.product["Akciová jednotková cena"] ?? ""),
      info: entry.product["Doplnková Informácia"] ?? "",
      dateFrom: entry.product["Dátum akcie od"] ?? prev.dateFrom,
      dateTo: entry.product["Dátum akcie do"] ?? prev.dateTo,
    }));
  };

  const cancelDbEdit = () => {
    setDbEditRef(null);
    resetFormFields();
    focusNameInput();
  };

  const updateProductInDb = async () => {
    if (!dbEditRef || !bucketPath) return;
    setError("");
    setStatus("");

    if (!form.name.trim()) {
      setError(t("error_product_name"));
      return;
    }

    const shops = resolveProductShops(dbEditRef, null);
    const product: FlyerProduct = {
      "Názov": form.name.trim(),
      "Kategória": categoryKey,
      "Podkategória": subcategoryKey,
      "Zaradenie": placementKey,
      "Množstvo": form.amount.trim(),
      "Merná jednotka": form.unit,
      "Bežná cena za bal.": normalizePrice(form.priceRegular),
      "Bežná jednotková cena": normalizePrice(form.priceRegularUnit),
      "Akciová cena": normalizePrice(form.priceSale),
      "Akciová jednotková cena": normalizePrice(form.priceSaleUnit),
      "Doplnková Informácia": form.info?.trim() || "",
      "Dátum akcie od": form.dateFrom?.trim() || "",
      "Dátum akcie do": form.dateTo?.trim() || "",
      "Obchody": shops,
    };

    try {
      setIsDbUpdating(true);
      const response = await fetch("/api/master-products/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country: bucketPath, ref: dbEditRef, product }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok) {
        setError(
          t("error_upload_failed_detail", {
            message: payload?.error || "Update failed",
          })
        );
        return;
      }

      setLoadedFlyer((prev) => {
        if (!prev) return prev;
        const next = JSON.parse(JSON.stringify(prev));
        const { categoryIndex, subcategoryIndex, placementIndex, productIndex } = dbEditRef;
        const placement =
          next?.[categoryIndex]?.["Podkategórie"]?.[subcategoryIndex]?.["Zaradenia"]?.[
            placementIndex
          ];
        if (placement?.["Produkty"]?.[productIndex]) {
          placement["Produkty"][productIndex] = product;
        }
        return next;
      });

      setStatus("Produkt v databaze bol upraveny.");
      setDbEditRef(null);
      resetFormFields();
      focusNameInput();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(t("error_upload_failed_detail", { message }));
    } finally {
      setIsDbUpdating(false);
    }
  };

  const deleteProductFromDb = async (ref: LoadedProductRef, name: string) => {
    if (!bucketPath) return;
    setDbDeleteConfirmRef({ ref, name });
  };

  const confirmDeleteProductFromDb = async () => {
    if (!dbDeleteConfirmRef) {
      setError("Chyba: nie je vybrany produkt na zmazanie.");
      return;
    }
    if (!bucketPath) {
      setError("Chyba: nie je vybrana krajina.");
      return;
    }
    const entry = dbDeleteConfirmRef;
    setDbDeleteConfirmRef(null);
    setError("");
    setStatus("");

    try {
      setIsDbUpdating(true);
      const response = await fetch("/api/master-products/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country: bucketPath,
          ref: entry.ref,
          product: {
            "Názov": entry.name,
            "Kategória": categoryKey,
            "Podkategória": subcategoryKey,
            "Zaradenie": placementKey,
          },
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok) {
        setError(
          t("error_upload_failed_detail", {
            message: payload?.error || "Delete failed",
          })
        );
        return;
      }

      setLoadedFlyer((prev) => {
        if (!prev) return prev;
        const next = JSON.parse(JSON.stringify(prev));
        const { categoryIndex, subcategoryIndex, placementIndex, productIndex } = entry.ref;
        const placement =
          next?.[categoryIndex]?.["Podkategórie"]?.[subcategoryIndex]?.["Zaradenia"]?.[
            placementIndex
          ];
        if (placement?.["Produkty"]) {
          placement["Produkty"].splice(productIndex, 1);
        }
        return next;
      });

      if (
        dbEditRef &&
        dbEditRef.categoryIndex === entry.ref.categoryIndex &&
        dbEditRef.subcategoryIndex === entry.ref.subcategoryIndex &&
        dbEditRef.placementIndex === entry.ref.placementIndex &&
        dbEditRef.productIndex === entry.ref.productIndex
      ) {
        setDbEditRef(null);
        resetFormFields();
      }

      setStatus("Produkt bol zmazany z databazy.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(t("error_upload_failed_detail", { message }));
    } finally {
      setIsDbUpdating(false);
    }
  };

  const removeProduct = (id: string) => {
    setProducts((prev) => prev.filter((item) => item.id !== id));
    if (editingId === id) {
      setEditingId(null);
      resetFormFields();
      focusNameInput();
    }
  };


  const focusNameInput = () => {
  requestAnimationFrame(() => {
    nameInputRef.current?.focus();
    nameInputRef.current?.select(); // voliteľné - označí text
  });
};

  // dôležité: keď otvoríš dropdown cez šípku, focus sa môže stratiť z inputu
  // a potom šípky hore/dole nevolajú onKeyDown na inpute.
  const focusInfoInput = () => {
    requestAnimationFrame(() => {
      infoInputRef.current?.focus();
      infoInputRef.current?.select();
    });
  };

  const removeLoadedProduct = (ref: LoadedProductRef) => {
    const { categoryIndex, subcategoryIndex, placementIndex, productIndex } = ref;
    setLoadedFlyer((prev: HierarchyCategory[] | null) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev));
      const placement = next[categoryIndex]?.["Podkategórie"]?.[subcategoryIndex]?.["Zaradenia"]?.[placementIndex];
      if (placement?.["Produkty"]) {
        placement["Produkty"].splice(productIndex, 1);
      }
      return next;
    });
    if (
      editingLoadedRef &&
      editingLoadedRef.categoryIndex === ref.categoryIndex &&
      editingLoadedRef.subcategoryIndex === ref.subcategoryIndex &&
      editingLoadedRef.placementIndex === ref.placementIndex &&
      editingLoadedRef.productIndex === ref.productIndex
    ) {
      setEditingLoadedRef(null);
      resetFormFields();
    }
  };

  const startEdit = (entry: ProductEntry) => {
    setError("");
    setStatus("");
    const loadedEntry = findLoadedEntryForProduct(entry.product);
    if (loadedEntry) {
      setEditingLoadedRef(loadedEntry.ref);
      setEditingId(null);
    } else {
      setEditingId(entry.id);
      setEditingLoadedRef(null);
    }
    setCategoryKey(entry.product["Kategória"] ?? "");
    setSubcategoryKey(entry.product["Podkategória"] ?? "");
    setPlacementKey(entry.product["Zaradenie"] ?? "");
    setForm((prev) => ({
      ...prev,
      name: entry.product["Názov"] ?? "",
      amount: entry.product["Množstvo"] ?? "",
      unit: entry.product["Merná jednotka"] ?? "kg",
      priceRegular: normalizePrice(entry.product["Bežná cena za bal."] ?? ""),
      priceRegularUnit: normalizePrice(
        entry.product["Bežná jednotková cena"] ?? ""
      ),
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
    setEditingLoadedRef(null);
    setEditingId(null);
    resetFormFields();
  };

  const loadShopJson = async (shopKey: string) => {
    try {
      setError("");
      setStatus("");
      if (!bucketPath) return;
      const response = await fetch(
        `/api/master-products/list?country=${encodeURIComponent(bucketPath)}`,
        { cache: "no-store" }
      );

      if (!response.ok) {
        setLoadedFlyer(null);
        setError(t("error_load_json"));
        return;
      }

      const data = await response.json();
      const normalized = normalizeLoadedFlyer(data);
      if (!normalized) {
        setLoadedFlyer(null);
        setError(t("error_load_json"));
        return;
      }

      setLoadedFlyer(normalized);
      setStatus(t("status_loaded_file"));
    } catch (err) {
      setLoadedFlyer(null);
      setError(t("error_load_json"));
      console.error("Load JSON error:", err);
    }
  };

  useEffect(() => {
    if (!shop) return;
    const available = shopOptionsByFolder[bucketPath] ?? [];
    const hasCurrent = available.some((option) => option.value === shop);
    if (!hasCurrent) return;
    const nextKey = `${bucketPath}:${shop}`;
    if (lastLoadKeyRef.current === nextKey) return;
    lastLoadKeyRef.current = nextKey;
    loadShopJson(shop);
  }, [shop, bucketPath]);

  const buildFileName = () => {
    const safeShop = shop
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "");

    return `${safeShop || "letak"}.json`;
  };

  const resolvedFileName = useMemo(() => {
    return buildFileName();
  }, [shop]);

  const downloadJson = () => {
    setStatus("");
    const safeName = resolvedFileName.endsWith(".json")
      ? resolvedFileName
      : `${resolvedFileName}.json`;
    const nameStem = safeName.replace(/\.json$/i, "");
    const nameExt = ".json";
    const blob = new Blob([jsonPreview], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeName;
    link.click();
    URL.revokeObjectURL(url);
  };
  const handleUploadClick = () => {
    setShowUploadConfirm(true);
  };

  const handleClearAllClick = () => {
    setShowClearAllConfirm(true);
  };

  const confirmClearAll = () => {
    setShowClearAllConfirm(false);
    setProducts([]);
    setEditingId(null);
  };

  const uploadToSupabase = async () => {
    setShowUploadConfirm(false);
    setError("");
    setStatus("");
    
    const safeName = resolvedFileName.endsWith(".json")
      ? resolvedFileName
      : `${resolvedFileName}.json`;
    const shop = safeName.replace(/\.json$/i, "");

    try {
      setIsUploading(true);
      
      const response = await fetch("/api/rotating-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country: bucketPath,
          shop: shop,
          payload: jsonPreview,
        }),
      });

      const result = await response.json();

      if (!response.ok || !result.ok) {
        setError(
          t("error_upload_failed_detail", { message: result.error || "Unknown error" })
        );
        return;
      }

      setStatus(t("status_uploaded") + ` (${result.path})`);
      setProducts([]);
      setEditingId(null);
      setEditingLoadedRef(null);
      setDbEditRef(null);
      setPreviewProduct(null);
      setShowSuggestions(false);
      setFilteredSuggestions([]);
      setActiveSuggestionIndex(-1);
      resetFormFields();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(t("error_upload_failed_detail", { message }));
      console.error("Upload failed:", err);
    } finally {
      setIsUploading(false);
    }
  };




const deleteDebugFile = async () => {
  setError("");
  setStatus("");

  if (!supabase) {
    setError(t("error_supabase_env"));
    return;
  }

  const countryFolder = "sk";
  const fileName = "lidl.json";
  const filePath = `databazy/${countryFolder}/${fileName}`;

  if (!confirm(`Naozaj chces zmazat ${filePath}?`)) return;

  try {
    setIsDeleting(true);

    // 1) Skús rovno zmazať – ak nemáš práva, uvidíš 403, ak neexistuje, uvidíš chybu/empty.
    const { data, error } = await supabase.storage
      .from("cap-data")
      .remove([filePath]);

    if (error) {
      // Najčastejšie: 403 (policy), alebo 404 (path)
      const detail = `${error.message} (status: ${error.statusCode ?? "?"}, code: ${(error as any).error ?? "?"}, path: ${filePath})`;
      setError(t("error_upload_failed_detail", { message: detail }));
      return;
    }

    // Supabase niekedy vráti data aj keď nič nezmazal? – ošetri prázdne.
    if (!data || data.length === 0) {
      setError(`Nepodarilo sa zmazať alebo súbor neexistuje: ${filePath}`);
      return;
    }

    // data má položky s name/path podľa verzie SDK
    const removedNames = data
      .map((item: any) => item?.name ?? item?.path ?? filePath)
      .join(", ");

    setStatus(`Subor zmazany: ${removedNames}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    setError(t("error_upload_failed_detail", { message }));
    console.error("Delete failed:", err);
  } finally {
    setIsDeleting(false);
  }
};



  return (
    <div className="relative min-h-screen">
      

      <main className="relative mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-6 pb-12 pt-2">
        <header className="flex flex-col gap-2">
          <h1 className="sr-only">{t("app_title")}</h1>
        </header>

        <section className="grid gap-6 lg:grid-cols-[minmax(980px,3fr)_minmax(300px,1fr)]">
          <div className="relative rounded-3xl bg-[color:var(--form)] p-5 shadow-[var(--shadow)] animate-[fade-in_0.6s_ease-out]">
            <div className="absolute top-4 right-6 z-10 flex flex-col items-end gap-2">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                  className="rounded-xl border border-black/10 bg-white px-5 py-3 text-sm font-semibold text-[color:var(--ink)] outline-none transition hover:border-black/30"
                >
                  {theme === "dark" ? t("btn_light_mode") : t("btn_dark_mode")}
                </button>
                <select
                  className="rounded-xl border border-black/10 bg-white px-5 py-3 text-sm font-semibold text-[color:var(--ink)] outline-none"
                  value={palette}
                  onClick={() => {
                    if (palette === "custom") {
                      setShowCustomPalette(true);
                    }
                  }}
                  onChange={(event) => {
                    const nextPalette = event.target.value;
                    setPalette(nextPalette);
                    if (nextPalette === "custom") {
                      setShowCustomPalette(true);
                    }
                  }}
                >
                  <option value="blue">Modrá</option>
                  <option value="turquoise">Tyrkysová</option>
                  <option value="green">Zelená</option>
                  <option value="classic">Svetlá biela</option>
                  <option value="pink">Ružová</option>
                  <option value="custom">Vlastná</option>
                </select>
                <select
                  className="rounded-xl border border-black/10 bg-white px-5 py-3 text-sm font-semibold text-[color:var(--ink)] outline-none"
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                >
                  <option value="sk">🇸🇰 {t("lang_sk")}</option>
                  <option value="cz">🇨🇿 {t("lang_cz")}</option>
                  <option value="pl">🇵🇱 {t("lang_pl")}</option>
                </select>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-[color:var(--ink)]">
                Počet produktov pre reťazec <span>{loadedProductsList.length}</span>
              </div>
            </div>

            <div className="mt-16 rounded-2xl border border-black/10 bg-white/70 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--muted)]">
                  AI import PDF (test)
                </div>
                {aiExtracted.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(JSON.stringify(aiExtracted, null, 2));
                    }}
                    className="rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] font-semibold text-[color:var(--ink)] shadow-sm transition hover:border-black/25 active:scale-95"
                  >
                    {t("btn_copy_json_count")} ({aiExtracted.length})
                  </button>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <input
                  ref={aiFileInputRef}
                  type="file"
                  accept="application/pdf"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    setAiPdfFile(file);
                    setAiExtracted([]);
                    setAiExtractMeta({});
                    setAiDebugText("");
                    setAiExtractStatus("");
                    setAiExtractError("");
                  }}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => aiFileInputRef.current?.click()}
                  className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-[color:var(--ink)] shadow-sm transition hover:border-black/25"
                >
                  {t("btn_select_pdf")}
                </button>
                <span className="text-xs text-[color:var(--muted)]">
                  {aiPdfFile?.name ? aiPdfFile.name : t("no_file_selected")}
                </span>
                <button
                  type="button"
                  onClick={handleAiExtract}
                  disabled={isAiExtracting}
                  className="rounded-full bg-[color:var(--btn-neutral-bg)] px-4 py-2 text-xs font-semibold text-white shadow-[var(--btn-neutral-shadow)] transition hover:brightness-110 disabled:opacity-60"
                >
                  {isAiExtracting ? t("btn_processing") : t("btn_analyze_pdf")}
                </button>
                {aiExtractStatus ? (
                  <span className="text-xs text-[color:var(--muted)]">{aiExtractStatus}</span>
                ) : null}
              </div>
              {aiExtractError ? (
                <div className="mt-2 text-xs text-red-600">{aiExtractError}</div>
              ) : null}
              {aiExtractMeta.date_from || aiExtractMeta.date_to ? (
                <div className="mt-2 text-xs font-medium text-[color:var(--ink)]">
                  Leták: {formatDateRange(aiExtractMeta.date_from, aiExtractMeta.date_to)}
                </div>
              ) : null}
              {aiExtracted.length > 0 ? (
                <div className="mt-3 grid max-h-[420px] gap-1.5 overflow-y-auto pr-1">
                  {aiExtracted.map((item, idx) => {
                      const showPageDivider = item.page != null && item.page !== aiExtracted[idx - 1]?.page;
                      const upd = (field: keyof AiExtractItem, value: string) =>
                        setAiExtracted(prev => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it));
                      const inp = "rounded-md border border-black/10 bg-transparent px-1.5 py-0.5 text-xs text-[color:var(--ink)] focus:border-black/30 focus:outline-none";
                      const sel = "rounded-md border border-black/10 bg-transparent px-1 py-0.5 text-[10px] text-[color:var(--ink)] focus:border-black/30 focus:outline-none cursor-pointer";
                      const lbl = "text-[10px] font-semibold uppercase tracking-wide text-[color:var(--muted)] shrink-0";
                      // hierarchy pre tento item
                      const aiCat = item.categoryKey || "";
                      const aiSubcats = aiCat ? (hierarchy.find(c => c["Kategória"] === aiCat)?.["Podkategórie"] || []) : [];
                      const aiSubcat = item.subcategoryKey || "";
                      const aiPlacements = aiSubcat ? (aiSubcats.find(s => s["Podkategória"] === aiSubcat)?.["Zaradenia"] || []) : [];
                      return (
                    <React.Fragment key={idx}>
                    {showPageDivider && (
                      <div className="flex items-center gap-3 px-1 pt-3 pb-1">
                        <div className="h-px w-4 bg-black/30" />
                        <span className="text-[11px] font-bold uppercase tracking-widest text-[color:var(--ink)]">{t("ai_page")} {item.page}</span>
                        <div className="h-px flex-1 bg-black/30" />
                      </div>
                    )}
                    <div className="rounded-xl border border-black/10 bg-white px-3 py-2 text-xs space-y-0">
                      {/* R1: Názov + delete */}
                      <div className="flex items-center gap-2 pb-1">
                        <span className={lbl} style={{width: "3.5rem"}}>{t("ai_label_name")}</span>
                        <input className={`${inp} flex-1 font-semibold`} value={item.name || ""} placeholder={t("ai_label_name")} onChange={e => upd("name", e.target.value)} />
                        <button tabIndex={-1} onClick={() => { if (window.confirm(`Zmazať „${item.name || "produkt"}"?`)) setAiExtracted(prev => prev.filter((_, i) => i !== idx)); }}
                          className="shrink-0 rounded-md bg-red-50 px-1.5 py-0.5 text-[10px] font-bold text-red-600 hover:bg-red-100 transition" title="Zmazať">🗑</button>
                      </div>
                      {/* R2: Info + Gramáž na jednom riadku */}
                      <div className="flex items-center gap-3 border-t border-black/[0.05] py-1 flex-wrap">
                        <div className="flex items-center gap-1">
                          <span className={lbl}>{t("ai_label_info")}</span>
                          <input className={`${inp} w-36`} value={item.note || ""} placeholder={t("ai_label_info")} onChange={e => upd("note", e.target.value)} />
                        </div>
                        <div className="flex items-center gap-1">
                          <span className={lbl}>{t("ai_label_weight")}</span>
                          <input className={`${inp} w-14`} value={item.amount || ""} placeholder="0" onChange={e => upd("amount", e.target.value)} />
                          <input className={`${inp} w-8 text-center`} value={item.unit || ""} placeholder="jed" onChange={e => upd("unit", e.target.value)} />
                        </div>
                      </div>
                      {/* R3: Ceny + Dátumy */}
                      <div className="flex items-center gap-3 border-t border-black/[0.05] py-1 flex-wrap">
                        <div className="flex items-center gap-1">
                          <span className={lbl}>{t("ai_label_sale")}</span>
                          <input className={`${inp} w-16 font-semibold`} value={item.price_sale || ""} placeholder="0,00" onChange={e => upd("price_sale", e.target.value)} />
                        </div>
                        <div className="flex items-center gap-1">
                          <span className={lbl}>{t("ai_label_unit")}</span>
                          <input tabIndex={-1} readOnly className={`${inp} w-16 bg-black/[0.03] text-[color:var(--muted)]`} value={calculateUnitPrice(item.price_sale || "", item.amount || "", item.unit || "")} placeholder="—" />
                        </div>
                        <div className="flex items-center gap-1">
                          <span className={lbl}>{t("ai_label_regular")}</span>
                          <input className={`${inp} w-16`} value={item.price_regular || ""} placeholder="0,00" onChange={e => upd("price_regular", e.target.value)} />
                        </div>
                        <div className="flex items-center gap-1">
                          <span className={lbl}>{t("ai_label_from")}</span>
                          <input className={`${inp} w-[5.5rem]`} value={item.date_from || ""} placeholder="DD.MM.YYYY" onChange={e => upd("date_from", e.target.value)} />
                        </div>
                        <div className="flex items-center gap-1">
                          <span className={lbl}>{t("ai_label_to")}</span>
                          <input className={`${inp} w-[5.5rem]`} value={item.date_to || ""} placeholder="DD.MM.YYYY" onChange={e => upd("date_to", e.target.value)} />
                        </div>
                      </div>
                      {/* R4: Zaradenie (Kategória / Podkategória / Zaradenie) */}
                      <div className="flex items-center gap-2 border-t border-black/[0.05] py-1 flex-wrap">
                        <select className={sel} value={aiCat} onFocus={e => { try { e.currentTarget.showPicker(); } catch {} }} onChange={e => {
                          const nc = e.target.value;
                          const nsubs = hierarchy.find(c => c["Kategória"] === nc)?.["Podkategórie"] || [];
                          const ns = nsubs[0]?.["Podkategória"] || "";
                          const np = nsubs[0]?.["Zaradenia"]?.[0]?.["Zaradenie"] || "";
                          setAiExtracted(prev => prev.map((it, i) => i === idx ? { ...it, categoryKey: nc, subcategoryKey: ns, placementKey: np } : it));
                        }}>
                          <option value="">{t("ai_select_category")}</option>
                          {hierarchy.map(c => <option key={c["Kategória"]} value={c["Kategória"]}>{locLabelFor(c["Kategória"])}</option>)}
                        </select>
                        <select className={sel} value={aiSubcat} disabled={!aiCat} onFocus={e => { if (aiCat) try { e.currentTarget.showPicker(); } catch {} }} onChange={e => {
                          const ns = e.target.value;
                          const np = aiSubcats.find(s => s["Podkategória"] === ns)?.["Zaradenia"]?.[0]?.["Zaradenie"] || "";
                          setAiExtracted(prev => prev.map((it, i) => i === idx ? { ...it, subcategoryKey: ns, placementKey: np } : it));
                        }}>
                          <option value="">{t("ai_select_subcategory")}</option>
                          {aiSubcats.map(s => <option key={s["Podkategória"]} value={s["Podkategória"]}>{locLabelFor(s["Podkategória"])}</option>)}
                        </select>
                        <select className={sel} value={item.placementKey || ""} disabled={!aiSubcat} onFocus={e => { if (aiSubcat) try { e.currentTarget.showPicker(); } catch {} }} onChange={e => upd("placementKey", e.target.value)}>
                          <option value="">{t("ai_select_placement")}</option>
                          {aiPlacements.map(p => <option key={p["Zaradenie"]} value={p["Zaradenie"]}>{locLabelFor(p["Zaradenie"])}</option>)}
                        </select>
                      </div>
                    </div>
                    </React.Fragment>
                      );
                    })}
                </div>
              ) : null}
              {aiExtracted.length > 0 ? (
                <div className="mt-3 flex justify-end">
                  <button
                    onClick={() => {
                      setAiSaveShop(aiDetectedShop || "");
                      setAiSaveCountry(aiDetectedCountry || "sk");
                      setAiSaveStatus(null);
                      setAiSaveModal(true);
                    }}
                    className="rounded-xl bg-black px-4 py-2 text-xs font-semibold text-white transition hover:bg-black/75"
                  >
                    💾 {t("ai_save_to_db")} ({aiExtracted.length})
                  </button>
                </div>
              ) : null}

              {aiSaveModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                  <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
                    <h3 className="mb-4 text-base font-bold text-[color:var(--ink)]">{t("ai_save_to_db")}</h3>
                    <div className="grid gap-3">
                      <label className="flex flex-col gap-1 text-xs font-semibold text-[color:var(--muted)] uppercase tracking-wide">
                        {t("ai_label_country")}
                        <select
                          className="rounded-xl border border-black/15 bg-black/[0.02] px-3 py-2 text-sm text-[color:var(--ink)] focus:outline-none focus:ring-1 focus:ring-black/20"
                          value={aiSaveCountry}
                          onChange={e => { setAiSaveCountry(e.target.value); setAiSaveShop(""); }}
                        >
                          <option value="sk">🇸🇰 {t("storage_sk")}</option>
                          <option value="cz">🇨🇿 {t("storage_cz")}</option>
                          <option value="pl">🇵🇱 {t("storage_pl")}</option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-semibold text-[color:var(--muted)] uppercase tracking-wide">
                        {t("ai_label_shop")}
                        {aiDetectedShop ? (
                          <span className="mb-0.5 text-[11px] font-normal normal-case text-[color:var(--accent)]">
                            ✓ {t("ai_detected")}: {shopOptionsByFolder[aiSaveCountry]?.find(s => s.value === aiDetectedShop)?.label ?? aiDetectedShop}
                          </span>
                        ) : null}
                        <select
                          className="rounded-xl border border-black/15 bg-black/[0.02] px-3 py-2 text-sm text-[color:var(--ink)] focus:outline-none focus:ring-1 focus:ring-black/20"
                          value={aiSaveShop}
                          onChange={e => setAiSaveShop(e.target.value)}
                        >
                          <option value="">{t("ai_select_shop")}</option>
                          {(shopOptionsByFolder[aiSaveCountry] ?? []).map(s => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                          ))}
                        </select>
                      </label>
                      {aiSaveStatus && (
                        <p className={`rounded-lg px-3 py-2 text-xs font-medium ${aiSaveStatus.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
                          {aiSaveStatus.msg}
                        </p>
                      )}
                    </div>
                    <div className="mt-5 flex justify-end gap-2">
                      <button
                        onClick={() => setAiSaveModal(false)}
                        className="rounded-xl px-4 py-2 text-xs font-semibold text-[color:var(--muted)] hover:bg-black/[0.05] transition"
                      >{t("ai_btn_cancel")}</button>
                      <button
                        disabled={!aiSaveShop || isAiSaving}
                        onClick={async () => {
                          if (!aiSaveShop) return;
                          setIsAiSaving(true);
                          setAiSaveStatus(null);
                          try {
                            const res = await fetch("/api/ai/bulk-save", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ country: aiSaveCountry, shop: aiSaveShop, items: aiExtracted }),
                            });
                            const json = await res.json();
                            if (json.ok) {
                              setAiSaveStatus({ ok: true, msg: `✓ ${t("ai_save_ok", { count: String(json.saved) })}` });
                            } else {
                              setAiSaveStatus({ ok: false, msg: json.error || t("ai_save_error") });
                            }
                          } catch {
                            setAiSaveStatus({ ok: false, msg: t("ai_net_error") });
                          } finally {
                            setIsAiSaving(false);
                          }
                        }}
                        className="rounded-xl bg-black px-4 py-2 text-xs font-semibold text-white transition hover:bg-black/75 disabled:opacity-40"
                      >
                        {isAiSaving ? t("ai_saving") : `${t("ai_btn_save_items")} ${aiExtracted.length}`}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {aiDebugText ? (
                <details className="mt-3 rounded-xl border border-black/10 bg-white/80 px-3 py-2 text-xs text-[color:var(--muted)]">
                  <summary className="cursor-pointer font-semibold text-[color:var(--ink)]">
                    Textova vrstva PDF (debug)
                  </summary>
                  <pre className="mt-2 max-h-[220px] overflow-y-auto whitespace-pre-wrap text-[11px] leading-4">
                    {aiDebugText}
                  </pre>
                </details>
              ) : null}
            </div>

            <div className="mt-5 grid gap-3">
              <div className="grid gap-3 md:grid-cols-[0.25fr_0.75fr]">
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_storage_folder")}
                  <select
                    className="rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                    value={bucketPath}
                    onChange={(event) => setBucketPath(event.target.value)}
                  >
                    <option value="sk">{t("storage_sk")}</option>
                    <option value="cz">{t("storage_cz")}</option>
                    <option value="pl">{t("storage_pl")}</option>
                  </select>
                </label>

                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)] md:flex-1">
                    {t("label_shop")}
                    <select
                      className="rounded-xl border border-black/10 bg-white px-5 py-4 text-lg md:text-xl text-[color:var(--ink)] outline-none transition focus:border-black/30 focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                      value={shop}
                      onChange={(event) => {
                        const nextShop = event.target.value;
                        setShop(nextShop);
                      }}
                    >
                      {shopOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                {t("label_product_name")}
                <div className="flex items-center gap-2">
                  <div className="relative flex-1 max-w-[600px]">
                    <input
                      ref={nameInputRef}
                      className="w-full rounded-xl border border-black/10 bg-white px-5 py-4 pr-10 text-xl text-[color:var(--ink)] outline-none transition focus:border-black/30 focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                      value={form.name}
                      onChange={(event) => {
                        const newName = event.target.value;
                        setForm((prev) => ({ ...prev, name: newName }));
                        
                        // Filtrujem podľa obsahovania textu v názve (case-insensitive)
                        if (newName.trim() && loadedFlyer) {
                         const filtered = loadedProductsList.filter((p) =>
                          matchesSearch(p.name, newName)
                          );

                          setFilteredSuggestions(filtered);
                          setShowSuggestions(filtered.length > 0);
                          setActiveSuggestionIndex(filtered.length > 0 ? 0 : -1);
                        } else {
                          setShowSuggestions(false);
                          setFilteredSuggestions([]);
                          setActiveSuggestionIndex(-1);
                          // Resetuj previewProduct len ak je input prázdny
                          if (!newName.trim()) {
                            setPreviewProduct(null);
                          }
                        }
                      }}
                      onFocus={() => {
                        if (form.name.trim() && filteredSuggestions.length > 0) {
                          setShowSuggestions(true);
                          setActiveSuggestionIndex((prev) => (prev < 0 ? 0 : prev));
                        }
                      }}
                      onKeyDown={(e) => {
                        const hasList = showSuggestions && filteredSuggestions.length > 0;

                        if (!hasList && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                          if (filteredSuggestions.length > 0) {
                            e.preventDefault();
                            setShowSuggestions(true);
                            setActiveSuggestionIndex((prev) => (prev < 0 ? 0 : prev));
                          }
                          return;
                        }

                        if (!hasList) return;

                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setActiveSuggestionIndex((prev) =>
                            Math.min(prev + 1, filteredSuggestions.length - 1)
                          );
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setActiveSuggestionIndex((prev) => Math.max(prev - 1, 0));
                        } else if (e.key === "Enter") {
                          e.preventDefault();
                          const p = filteredSuggestions[activeSuggestionIndex];
                          if (p) {
                            selectLoadedSuggestion(p);
                          }
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setShowSuggestions(false);
                          setFilteredSuggestions([]);
                          setActiveSuggestionIndex(-1);
                        }
                      }}
                      placeholder={t("placeholder_product_name")}
                    />
                    
                    {/* Chevron button pre zobrazenie všetkých možnností */}
                      {loadedFlyer && loadedProductsList.length > 0 && (
                      <button
                        type="button"
                        tabIndex={-1}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          if (showSuggestions) {
                            setShowSuggestions(false);
                            setFilteredSuggestions([]);
                            setActiveSuggestionIndex(-1);
                          } else {
                            setFilteredSuggestions(loadedProductsList);
                            setShowSuggestions(true);
                            setActiveSuggestionIndex(0);
                            focusNameInput();
                          }
                        }}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
                      >
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M6 8l4 4 4-4" />
                        </svg>
                      </button>
                    )}
                    
                    {/* Custom dropdown menu */}
                      {showSuggestions && filteredSuggestions.length > 0 && (
                      <div ref={suggestionsBoxRef} className="absolute top-full left-0 right-0 mt-1 max-h-[300px] overflow-y-auto rounded-xl border border-black/10 bg-white shadow-lg z-10">
                        {filteredSuggestions.map((p, idx) => (
                          <div
                            key={p.id ?? idx}
                            ref={(el) => {
                              suggestionItemRefs.current[idx] = el;
                            }}
                            onMouseEnter={() => setActiveSuggestionIndex(idx)}
                            onMouseDown={(e) => {
                              // Use mouse down so the click isn't lost due to input blur
                              e.preventDefault();
                              selectLoadedSuggestion(p);
                            }}
                            className={`w-full px-4 py-3 text-left text-sm text-[color:var(--ink)] transition border-b border-black/5 last:border-b-0 h-auto flex items-center justify-between gap-3 cursor-pointer ${
                              idx === activeSuggestionIndex
                                ? "bg-[color:var(--dropdown-highlight-bg)]"
                                : "hover:bg-[color:var(--dropdown-highlight-bg)]"
                            }`}
                          >
                            <span className="flex-1 text-left">{p.name}</span>
                            <div className="flex items-center gap-2" />
                          </div>
                        ))}
                    </div>
                  )}
                </div>
                {/* Buttons vedľa inputu - viditeľné iba keď je vybraný produkt z DB */}
                {selectedLoadedEntry && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() =>
                        deleteProductFromDb(
                          selectedLoadedEntry.ref,
                          selectedLoadedEntry.name
                        )
                      }
                      tabIndex={-1}
                      className="rounded-md border border-[color:var(--btn-danger-outline-border)] px-5 py-3 text-base font-semibold text-[color:var(--btn-danger-outline-text)] transition hover:border-[color:var(--btn-danger-outline-border-hover)] hover:scale-[1.02] active:scale-[0.99]"
                    >
                      Zmazat z DB
                    </button>
                  </div>
                )}
              </div>
            </label>

              {/* Preview BOX pre vybraný produkt */}
              {previewProduct && (
                <div className="rounded-xl border-2 border-[color:var(--accent)]/30 bg-[color:var(--accent)]/10 p-4">
                  <div className="mb-3 max-h-[250px] space-y-2 overflow-y-auto text-sm">
                    <div className="font-semibold text-[color:var(--ink)]">
                      {previewProduct.name}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs text-[color:var(--muted)]">
                      <div>
                        <span className="font-medium">{t("label_category")}:</span>
                        <div className="text-[color:var(--ink)]">
                          {locLabelFor(previewProduct.categoryKey)}
                        </div>
                      </div>
                      <div>
                        <span className="font-medium">{t("label_subcategory")}:</span>
                        <div className="text-[color:var(--ink)]">
                          {locLabelFor(previewProduct.subcategoryKey)}
                        </div>
                      </div>
                      <div className="col-span-2">
                        <span className="font-medium">{t("label_placement")}:</span>
                        <div className="text-[color:var(--ink)]">
                          {locLabelFor(previewProduct.placementKey)}
                        </div>
                      </div>
                    </div>

                    <div className="border-t border-[color:var(--accent)]/20 pt-2">
                      <div className="space-y-1 text-xs">
                        {previewProduct.product["Bežná cena za bal."] && (
                          <div>
                            <span className="font-medium">{t("label_regular_price")}:</span>
                            <span className="ml-2 text-[color:var(--ink)]">
                              {previewProduct.product["Bežná cena za bal."]}
                            </span>
                          </div>
                        )}
                        {previewProduct.product["Akciová cena"] && (
                          <div>
                            <span className="font-medium">{t("label_sale_price")}:</span>
                            <span className="ml-2 text-[color:var(--ink)]">
                              {previewProduct.product["Akciová cena"]}
                            </span>
                          </div>
                        )}
                        {previewProduct.product["Doplnková Informácia"] && (
                          <div>
                            <span className="font-medium">{t("label_extra_info")}:</span>
                            <span className="ml-2 text-[color:var(--ink)]">
                              {previewProduct.product["Doplnková Informácia"]}
                            </span>
                          </div>
                        )}
                        {previewProduct.product["Dátum akcie od"] && (
                          <div>
                            <span className="font-medium">{t("label_date_from")}:</span>
                            <span className="ml-2 text-[color:var(--ink)]">
                              {previewProduct.product["Dátum akcie od"]}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={handleConfirmProduct}
                      className="flex-1 rounded-lg bg-[color:var(--accent)] px-3 py-2 text-sm font-medium text-white transition hover:brightness-90"
                    >
                      {t("btn_add")}
                    </button>
                    <button
                      onClick={handleCancelPreview}
                      className="flex-1 rounded-lg border border-[color:var(--accent)]/30 px-3 py-2 text-sm font-medium text-[color:var(--accent)] transition hover:bg-[color:var(--accent)]/10"
                    >
                      {t("btn_cancel")}
                    </button>
                  </div>
                </div>
              )}

              <div className="grid gap-6">
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                    {t("label_category")}
                    <select
                      className="w-full max-w-[380px] rounded-xl border border-black/10 bg-white px-4 py-3 text-lg text-[color:var(--ink)] outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                      value={categoryKey}
                      onChange={(event) => setCategoryKey(event.target.value)}
                    >
                      {hierarchy.map((item) => (
                        <option key={item["Kategória"]} value={item["Kategória"]}>
                          {locLabelFor(item["Kategória"]) }
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                    {t("label_subcategory")}
                    <select
                      className="rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                      value={subcategoryKey}
                      onChange={(event) => setSubcategoryKey(event.target.value)}
                    >
                      {selectedCategory?.["Podkategórie"].map((item) => (
                        <option key={item["Podkategória"]} value={item["Podkategória"]}>
                          {locLabelFor(item["Podkategória"]) }
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                    {t("label_placement")}
                    <select
                      className="rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                      value={placementKey}
                      onChange={(event) => setPlacementKey(event.target.value)}
                    >
                      {sortedPlacements.map((item) => (
                        <option key={item["Zaradenie"]} value={item["Zaradenie"]}>
                          {locLabelFor(item["Zaradenie"]) }
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_amount")}
                  <input
                    className="w-full max-w-[160px] rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                    value={form.amount || ""}
                    onChange={(event) => {
                      const newAmount = event.target.value;
                      setForm((prev) => ({
                        ...prev,
                        amount: newAmount,
                        priceRegularUnit: calculateUnitPrice(prev.priceRegular, newAmount, prev.unit),
                        priceSaleUnit: calculateUnitPrice(prev.priceSale, newAmount, prev.unit),
                      }));
                    }}
                  />
                </label>
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_unit")}
                  <select
                    className="w-full max-w-[160px] rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                    value={form.unit}
                    onChange={(event) => {
                      const newUnit = event.target.value;
                      setForm((prev) => ({
                        ...prev,
                        unit: newUnit,
                        priceRegularUnit: calculateUnitPrice(prev.priceRegular, prev.amount, newUnit),
                        priceSaleUnit: calculateUnitPrice(prev.priceSale, prev.amount, newUnit),
                      }));
                    }}
                  >
                    {unitOptions.map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_regular_price")}
                  <input
                    className="w-full max-w-[200px] rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                    value={form.priceRegular || ""}
                    onChange={(event) => {
                      const newPrice = normalizePrice(event.target.value);
                      setForm((prev) => ({
                        ...prev,
                        priceRegular: newPrice,
                        priceRegularUnit: calculateUnitPrice(newPrice, prev.amount, prev.unit),
                      }));
                    }}
                  />
                </label>
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_regular_unit_price")}
                  <input
                    tabIndex={-1}
                    readOnly
                    className="w-full max-w-[200px] rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                    value={form.priceRegularUnit}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        priceRegularUnit: normalizePrice(event.target.value),
                      }))
                    }
                  />
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_sale_price")}
                  <input
                    className="w-full max-w-[200px] rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                    value={form.priceSale || ""}
                    onChange={(event) => {
                      const newPrice = normalizePrice(event.target.value);
                      setForm((prev) => ({
                        ...prev,
                        priceSale: newPrice,
                        priceSaleUnit: calculateUnitPrice(newPrice, prev.amount, prev.unit),
                      }));
                    }}
                  />
                </label>
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_sale_unit_price")}
                  <input
                    tabIndex={-1}
                    readOnly
                    className="w-full max-w-[200px] rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                    value={form.priceSaleUnit}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        priceSaleUnit: normalizePrice(event.target.value),
                      }))
                    }
                  />
                </label>
              </div>

              <div className="grid gap-3 grid-cols-[1fr_1fr_1.5fr]">
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_date_from")}
                  <div className="relative">
                    <input
                      ref={dateFromInputRef}
                      type="date"
                      className="w-full rounded-xl border border-black/10 bg-white px-5 py-4 pr-10 text-xl text-[color:var(--ink)] outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                      value={form.dateFrom ? form.dateFrom.split(".").reverse().join("-") : ""}
                      onChange={(event) => {
                        if (event.target.value) {
                          const [year, month, day] = event.target.value.split("-");
                          if (year.length === 4) {
                            const newFromDate = `${day}.${month}.${year}`;
                            setForm((prev) => ({ ...prev, dateFrom: newFromDate }));
                          }
                        } else {
                          setForm((prev) => ({ ...prev, dateFrom: "" }));
                        }
                      }}
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        dateFromInputRef.current?.showPicker?.();
                        dateFromInputRef.current?.focus();
                      }}
                      aria-label="Otvoriť kalendár"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="4" width="18" height="18" rx="2" />
                        <path d="M16 2v4M8 2v4M3 10h18" />
                      </svg>
                    </button>
                  </div>
                </label>
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_date_to")}
                  <div className="relative">
                    <input
                      ref={dateToInputRef}
                      type="date"
                      className="w-full rounded-xl border border-black/10 bg-white px-5 py-4 pr-10 text-xl text-[color:var(--ink)] outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                      value={form.dateTo ? form.dateTo.split(".").reverse().join("-") : ""}
                      onChange={(event) => {
                        if (event.target.value) {
                          const [year, month, day] = event.target.value.split("-");
                          if (year.length === 4) {
                            setForm((prev) => ({
                              ...prev,
                              dateTo: `${day}.${month}.${year}`,
                            }));
                          }
                        } else {
                          setForm((prev) => ({
                            ...prev,
                            dateTo: "",
                          }));
                        }
                      }}
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        dateToInputRef.current?.showPicker?.();
                        dateToInputRef.current?.focus();
                      }}
                      aria-label="Otvoriť kalendár"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="4" width="18" height="18" rx="2" />
                        <path d="M16 2v4M8 2v4M3 10h18" />
                      </svg>
                    </button>
                  </div>
                </label>
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_extra_info")}
                  <div className="relative">
                    <input
                      className="w-full rounded-xl border border-black/10 bg-white px-5 py-4 pr-10 text-xl text-[color:var(--ink)] outline-none transition focus:border-black/30 focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                      value={form.info || ""}
                      onChange={(event) => {
                        const newInfo = event.target.value;
                        setForm((prev) => ({ ...prev, info: newInfo }));
                        
                        if (newInfo.trim() && loadedFlyer) {
                          const filtered = loadedExtraInfosList.filter((info) =>
                            matchesSearch(info, newInfo)
                          );
                          setFilteredInfoSuggestions(filtered);
                          setShowInfoSuggestions(filtered.length > 0);
                          setActiveInfoSuggestionIndex(filtered.length > 0 ? 0 : -1);
                        } else {
                          setShowInfoSuggestions(false);
                          setFilteredInfoSuggestions([]);
                          setActiveInfoSuggestionIndex(-1);
                        }
                      }}
                      onFocus={() => {
                        if (form.info.trim() && filteredInfoSuggestions.length > 0) {
                          setShowInfoSuggestions(true);
                          setActiveInfoSuggestionIndex((prev) => (prev < 0 ? 0 : prev));
                        }
                      }}
                                            onKeyDown={(e) => {
                        const hasList = showInfoSuggestions && filteredInfoSuggestions.length > 0;

                        if (!hasList && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                          if (filteredInfoSuggestions.length > 0) {
                            e.preventDefault();
                            setShowInfoSuggestions(true);
                            setActiveInfoSuggestionIndex((prev) => (prev < 0 ? 0 : prev));
                          }
                          return;
                        }

                        if (!hasList) return;

                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setActiveInfoSuggestionIndex((prev) =>
                            Math.min(prev + 1, filteredInfoSuggestions.length - 1)
                          );
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setActiveInfoSuggestionIndex((prev) => Math.max(prev - 1, 0));
                        } else if (e.key === "Enter") {
                          e.preventDefault();
                          const picked = filteredInfoSuggestions[activeInfoSuggestionIndex];
                          if (picked) {
                            setForm((prev) => ({ ...prev, info: picked }));
                            setShowInfoSuggestions(false);
                            setFilteredInfoSuggestions([]);
                            setActiveInfoSuggestionIndex(-1);
                          }
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setShowInfoSuggestions(false);
                          setFilteredInfoSuggestions([]);
                          setActiveInfoSuggestionIndex(-1);
                        }
                      }}
placeholder={t("placeholder_extra_info")}
                    />
                    
                    {loadedFlyer && loadedExtraInfosList.length > 0 && (
                      <button
                        type="button"
                        tabIndex={-1}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          if (showInfoSuggestions) {
                            setShowInfoSuggestions(false);
                            setFilteredInfoSuggestions([]);
                            setActiveInfoSuggestionIndex(-1);
                          } else {
                            setFilteredInfoSuggestions(loadedExtraInfosList);
                            setShowInfoSuggestions(true);
                            setActiveInfoSuggestionIndex(0);
                            focusInfoInput();
                          }
                        }}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
                      >
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M6 8l4 4 4-4" />
                        </svg>
                      </button>
                    )}
                    
                    {showInfoSuggestions && filteredInfoSuggestions.length > 0 && (
                      <div ref={infoSuggestionsBoxRef} className="absolute top-full left-0 right-0 mt-1 max-h-[300px] overflow-y-auto rounded-xl border border-black/10 bg-white shadow-lg z-10">
                        {filteredInfoSuggestions.map((info, idx) => (
                          <button
                            key={idx}
                            ref={(el) => {
                              infoSuggestionItemRefs.current[idx] = el;
                            }}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setForm((prev) => ({ ...prev, info }));
                              setShowInfoSuggestions(false);
                              setFilteredInfoSuggestions([]);
                              setActiveInfoSuggestionIndex(-1);
                            }}
                            onMouseEnter={() => setActiveInfoSuggestionIndex(idx)}
                            className={`w-full px-4 py-3 text-left text-sm text-[color:var(--ink)] transition border-b border-black/5 last:border-b-0 h-[2.75rem] flex items-center ${
                              idx === activeInfoSuggestionIndex
                                ? "bg-[color:var(--dropdown-highlight-bg)]"
                                : "hover:bg-[color:var(--dropdown-highlight-bg)]"
                            }`}
                          >
                            {info}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </label>
              </div>

              {error ? (
                <div className="rounded-xl border border-[color:var(--notice-error-border)] bg-[color:var(--notice-error-bg)] px-4 py-3 text-sm text-[color:var(--notice-error-text)]">
                  {error}
                </div>
              ) : null}
              {status ? (
                <div className="rounded-xl border border-[color:var(--notice-info-border)] bg-[color:var(--notice-info-bg)] px-4 py-3 text-sm text-[color:var(--notice-info-text)]">
                  {status}
                </div>
              ) : null}

              <div className="flex items-center gap-3 flex-nowrap">
                {dbEditRef ? (
                  <>
                    <button
                      className="rounded-full bg-[color:var(--btn-primary-bg)] px-6 py-3 text-sm font-semibold text-white shadow-[var(--btn-primary-shadow)] transition hover:brightness-95 hover:scale-[1.02] active:scale-[0.99] disabled:opacity-60"
                      onClick={updateProductInDb}
                      type="button"
                      disabled={isDbUpdating}
                    >
                      {isDbUpdating ? "Ukladam..." : "Ulozit zmeny do DB"}
                    </button>
                    <button
                      className="rounded-full border border-black/10 px-6 py-3 text-sm font-semibold text-[color:var(--ink)] transition hover:border-black/30 hover:scale-[1.02] active:scale-[0.99]"
                      onClick={cancelDbEdit}
                      type="button"
                    >
                      Zrusit zmeny DB
                    </button>
                    <button
                      className="rounded-full bg-[color:var(--btn-danger-bg)] px-6 py-3 text-sm font-semibold text-white shadow-[var(--btn-danger-shadow)] transition hover:bg-[color:var(--btn-danger-hover)] hover:scale-[1.02] active:scale-[0.99] disabled:opacity-60"
                      onClick={() => {
                        if (!dbEditRef) return;
                        const name = form.name.trim() || dbEditEntry?.name || "produkt";
                        deleteProductFromDb(dbEditRef, name);
                      }}
                      tabIndex={-1}
                      type="button"
                      disabled={isDbUpdating}
                    >
                      Zmazat produkt z DB
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="rounded-full bg-[color:var(--btn-primary-bg)] px-6 py-3 text-sm font-semibold text-white shadow-[var(--btn-primary-shadow)] transition hover:brightness-95 hover:scale-[1.02] active:scale-[0.99] disabled:opacity-60"
                      onClick={addProduct}
                      type="button"
                      disabled={isAppending}
                    >
                      {editingId || editingLoadedRef ? t("btn_save_changes") : t("btn_add_product")}
                    </button>
                    {editingId || editingLoadedRef ? (
                      <button
                        className="rounded-full border border-[color:var(--btn-neutral-outline-border)] px-6 py-3 text-sm font-semibold text-[color:var(--ink)] transition hover:border-[color:var(--btn-neutral-outline-border-hover)] hover:scale-[1.02] active:scale-[0.99]"
                        onClick={cancelEdit}
                        type="button"
                      >
                        {t("btn_cancel_edit")}
                      </button>
                    ) : null}
                    <button
                      className="rounded-full bg-[color:var(--btn-neutral-bg)] px-6 py-3 text-sm font-semibold text-white shadow-[var(--btn-neutral-shadow)] transition hover:brightness-110 hover:scale-[1.02] active:scale-[0.99]"
                      onClick={downloadJson}
                      type="button"
                    >
                      {t("btn_download_file")}
                    </button>
                    <button
                      className="rounded-full bg-[color:var(--btn-neutral-bg)] px-6 py-3 text-sm font-semibold text-white shadow-[var(--btn-neutral-shadow)] transition hover:brightness-110 hover:scale-[1.02] active:scale-[0.99] disabled:opacity-60"
                      onClick={handleUploadClick}
                      type="button"
                      disabled={isUploading}
                    >
                      {isUploading ? "Nahrávam..." : "Nahrať na server"}
                    </button>
                    <button
                      className="ml-auto rounded-full bg-[color:var(--btn-danger-bg)] px-6 py-3 text-sm font-semibold text-white shadow-[var(--btn-danger-shadow)] transition hover:bg-[color:var(--btn-danger-hover)] hover:scale-[1.02] active:scale-[0.99]"
                      onClick={handleClearAllClick}
                      type="button"
                    >
                      {t("btn_clear_all")}
                    </button>
                  </>
                )}
                {/*
                <button
                  className="rounded-full border border-red-200 bg-white px-6 py-3 text-sm font-semibold text-red-700 transition hover:border-red-300 disabled:opacity-60"
                  onClick={deleteDebugFile}
                  type="button"
                  disabled={isDeleting}
                >
                  {isDeleting ? "Mažem..." : "Debug: zmazať lidl.json"}
                </button>
                */}
              </div>
            </div>

            <div className="mt-8 border-t border-black/5 pt-6">
              <h3 className="font-[var(--font-display)] text-lg text-[color:var(--ink)]">
                Produkty letáku
              </h3>
              <div className="mt-4 grid gap-3">
                <input
                  className="w-full rounded-xl border border-black/10 bg-white px-4 py-3 text-sm text-[color:var(--ink)] outline-none transition focus:border-black/30"
                  value={productListQuery}
                  onChange={(event) => setProductListQuery(event.target.value)}
                  placeholder="Hľadať produkt v zozname..."
                />
              </div>
              <div className="mt-3 grid max-h-[520px] gap-3 overflow-y-auto pr-1">
                {displayProducts.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-[color:var(--box-highlight-border)] bg-[color:var(--box-highlight-bg)] px-4 py-6 text-sm text-[color:var(--muted)]">
                    {t("empty_products")}
                  </div>
                ) : filteredDisplayProducts.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-[color:var(--box-highlight-border)] bg-[color:var(--box-highlight-bg)] px-4 py-6 text-sm text-[color:var(--muted)]">
                    Žiadne výsledky.
                  </div>
                ) : (
                  filteredDisplayProducts.map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-black/5 bg-white px-4 py-4"
                    >
                      <div>
                        <div className="text-sm font-semibold text-[color:var(--ink)]">
                          {item.product["Názov"]}
                        </div>
                        <div className="text-xs text-[color:var(--muted)]">
                          {formatCategoryPath(
                            item.product["Kategória"],
                            item.product["Podkategória"],
                            item.product["Zaradenie"]
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          className="rounded-full border border-black/10 px-3 py-1 text-xs font-semibold text-[color:var(--muted)] transition hover:border-black/30"
                          onClick={() => startEdit(item.entry)}
                          type="button"
                        >
                          {t("btn_edit")}
                        </button>
                        <button
                          className="rounded-full border border-black/10 px-3 py-1 text-xs font-semibold text-[color:var(--muted)] transition hover:border-black/30"
                          onClick={() => removeProduct(item.entry.id)}
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


          </div>
        </section>
      </main>

      {/* Delete Confirmation Modal */}
      {dbDeleteConfirmRef && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-[fade-in_0.2s_ease-out]">
          <div className="relative mx-4 w-full max-w-md rounded-3xl bg-[color:var(--modal-bg)] p-8 text-white shadow-2xl animate-[float-in_0.3s_ease-out]">
            <h3 className="font-[var(--font-display)] text-2xl font-semibold mb-3">
              Zmazať z databázy?
            </h3>
            <p className="text-sm text-white/70 mb-6">
              Naozaj chceš zmazať produkt <strong>"{dbDeleteConfirmRef.name}"</strong> z databázy?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDbDeleteConfirmRef(null)}
                type="button"
                className="flex-1 rounded-full border-2 border-[color:var(--modal-border)] px-6 py-3 text-sm font-semibold text-white hover:bg-[color:var(--modal-cancel-hover)] transition-colors"
              >
                {t("btn_cancel")}
              </button>
              <button
                onClick={confirmDeleteProductFromDb}
                disabled={isDbUpdating}
                type="button"
                className="flex-1 rounded-full bg-[color:var(--btn-danger-bg)] px-6 py-3 text-sm font-semibold text-white hover:bg-[color:var(--btn-danger-hover)] disabled:opacity-50 transition-colors"
              >
                {isDbUpdating ? "Mažu..." : "Zmazať"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upload Confirmation Modal */}
      {showUploadConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-[fade-in_0.2s_ease-out]">
          <div className="relative mx-4 w-full max-w-md rounded-3xl bg-[color:var(--modal-bg)] p-8 text-white shadow-2xl animate-[float-in_0.3s_ease-out]">
            <h3 className="font-[var(--font-display)] text-2xl font-semibold mb-3">
              {t("confirm_upload")}
            </h3>
            <p className="text-sm text-white/70 mb-6">
              Leták bude nahraný do databázy.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowUploadConfirm(false)}
                className="flex-1 rounded-full border-2 border-[color:var(--modal-border)] px-6 py-3 text-sm font-semibold text-white hover:bg-[color:var(--modal-cancel-hover)] transition-colors"
              >
                {t("btn_cancel")}
              </button>
              <button
                onClick={uploadToSupabase}
                className="flex-1 rounded-full bg-[color:var(--btn-primary-bg)] px-6 py-3 text-sm font-semibold text-white hover:brightness-90 transition-colors"
              >
                {t("btn_confirm_upload")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear All Confirmation Modal */}
      {showClearAllConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-[fade-in_0.2s_ease-out]">
          <div className="relative mx-4 w-full max-w-md rounded-3xl bg-[color:var(--modal-bg)] p-8 text-white shadow-2xl animate-[float-in_0.3s_ease-out]">
            <h3 className="font-[var(--font-display)] text-2xl font-semibold mb-3">
              Naozaj chceš vymazať všetko?
            </h3>
            <p className="text-sm text-white/70 mb-6">
              Týmto sa vymažú všetky produkty z aktuálneho letáku.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowClearAllConfirm(false)}
                className="flex-1 rounded-full border-2 border-[color:var(--modal-border)] px-6 py-3 text-sm font-semibold text-white hover:bg-[color:var(--modal-cancel-hover)] transition-colors"
              >
                {t("btn_cancel")}
              </button>
              <button
                onClick={confirmClearAll}
                className="flex-1 rounded-full bg-[color:var(--btn-danger-bg)] px-6 py-3 text-sm font-semibold text-white hover:bg-[color:var(--btn-danger-hover)] transition-colors"
              >
                {t("btn_clear_all")}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );

      {/* Custom Palette Modal */}
      {showCustomPalette && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-[fade-in_0.2s_ease-out]">
          <div className="relative mx-4 w-full max-w-md rounded-3xl bg-[color:var(--modal-bg)] p-8 text-white shadow-2xl animate-[float-in_0.3s_ease-out]">
            <h3 className="font-[var(--font-display)] text-2xl font-semibold mb-3">
              Vlastna paleta
            </h3>
            <div className="grid gap-4">
              <label className="flex items-center justify-between gap-3 text-sm font-semibold text-white/80">
                Pozadie
                <input
                  type="color"
                  value={customPalette.background}
                  onChange={(event) =>
                    setCustomPalette((prev) => ({
                      ...prev,
                      background: event.target.value,
                    }))
                  }
                  className="h-8 w-12 cursor-pointer"
                />
              </label>
              <label className="flex items-center justify-between gap-3 text-sm font-semibold text-white/80">
                Form
                <input
                  type="color"
                  value={customPalette.form}
                  onChange={(event) =>
                    setCustomPalette((prev) => ({
                      ...prev,
                      form: event.target.value,
                    }))
                  }
                  className="h-8 w-12 cursor-pointer"
                />
              </label>
            </div>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setShowCustomPalette(false)}
                type="button"
                className="flex-1 rounded-full border-2 border-[color:var(--modal-border)] px-6 py-3 text-sm font-semibold text-white hover:bg-[color:var(--modal-cancel-hover)] transition-colors"
              >
                Zavriet
              </button>
            </div>
          </div>
        </div>
      )}
}
