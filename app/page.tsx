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

const hierarchy = hierarchyData as HierarchyCategory[];
const languageMap = {
  sk: skLabels,
  cz: czLabels,
  pl: plLabels,
} as Record<string, Record<string, string>>;
const labelMap = skLabels as Record<string, string>;

const unitOptions = ["g", "kg", "ml", "l", "ks", "bal"];

const labelFor = (key: string) => labelMap[key] ?? key.replace(/_/g, " ");

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
const normalizeKey = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

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
  const [loadedFlyer, setLoadedFlyer] = useState<typeof flyerData | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [bucketPath, setBucketPath] = useState("sk");
  const [loadedFileName, setLoadedFileName] = useState("");
  const [editingLoadedRef, setEditingLoadedRef] = useState<LoadedProductRef | null>(null);
  const [previewProduct, setPreviewProduct] = useState<{
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
  const [productListQuery, setProductListQuery] = useState("");
  const [showUploadConfirm, setShowUploadConfirm] = useState(false);

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

  // Extrahovať všetky produkty z loadedFlyer s ich metadátami
  const loadedProductsList = useMemo<LoadedProductEntry[]>(() => {
    if (!loadedFlyer) return [];

    const allProducts: LoadedProductEntry[] = [];

    loadedFlyer.forEach((category, categoryIndex) => {
      const categoryKey = category["Kategória"];
      (category["Podkategórie"] ?? []).forEach((subcategory, subcategoryIndex) => {
        const subcategoryKey = subcategory["Podkategória"];
        (subcategory["Zaradenia"] ?? []).forEach((placement, placementIndex) => {
          const placementKey = placement["Zaradenie"];
          (placement["Produkty"] ?? []).forEach((product, productIndex) => {
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
  }, [loadedFlyer]);

  // Extrahovať všetky unikátne doplnkové info z loadedFlyer
  const loadedExtraInfosList = useMemo(() => {
    if (!loadedFlyer) return [];
    
    const infos = new Set<string>();
    for (const category of loadedFlyer) {
      for (const subcategory of category["Podkategórie"] ?? []) {
        for (const placement of subcategory["Zaradenia"] ?? []) {
          for (const product of placement["Produkty"] ?? []) {
            const info = product["Doplnková Informácia"]?.trim();
            if (info) {
              infos.add(info);
            }
          }
        }
      }
    }

    return Array.from(infos).sort();
  }, [loadedFlyer]);

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
    const loaded = loadedProductsList.map((entry) => ({
      type: "loaded" as const,
      id: entry.id,
      product: entry.product,
      entry,
    }));
    const added = products.map((entry) => ({
      type: "new" as const,
      id: entry.id,
      product: entry.product,
      entry,
    }));
    return [...loaded, ...added];
  }, [loadedProductsList, products]);

  const filteredDisplayProducts = useMemo(() => {
    const query = productListQuery.trim().toLowerCase();
    if (!query) {
      return displayProducts;
    }
    return displayProducts.filter((item) =>
      item.product["Názov"].toLowerCase().includes(query)
    );
  }, [displayProducts, productListQuery]);

  const addProduct = () => {
    setError("");
    setStatus("");
    if (!categoryKey || !subcategoryKey) {
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
      "Bežná cena za bal.": normalizePrice(form.priceRegular),
      "Bežná jednotková cena": normalizePrice(form.priceRegularUnit),
      "Akciová cena": normalizePrice(form.priceSale),
      "Akciová jednotková cena": normalizePrice(form.priceSaleUnit),
      "Doplnková Informácia": form.info?.trim() || "",
      "Dátum akcie od": form.dateFrom?.trim() || "",
      "Dátum akcie do": form.dateTo?.trim() || "",
    };

    if (editingLoadedRef && loadedFlyer) {
      const { categoryIndex, subcategoryIndex, placementIndex, productIndex } = editingLoadedRef;
      setLoadedFlyer((prev) => {
        if (!prev) return prev;
        const next = JSON.parse(JSON.stringify(prev));
        const placement = next[categoryIndex]?.["Podkategórie"]?.[subcategoryIndex]?.["Zaradenia"]?.[placementIndex];
        if (placement?.["Produkty"]?.[productIndex]) {
          placement["Produkty"][productIndex] = product;
        }
        return next;
      });
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

  const removeLoadedProduct = (ref: LoadedProductRef) => {
    const { categoryIndex, subcategoryIndex, placementIndex, productIndex } = ref;
    setLoadedFlyer((prev) => {
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
    setEditingId(entry.id);
    setEditingLoadedRef(null);
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

  const handleLoadJson = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      
      // Parsovať názov súboru aby sa automaticky nastavili shop a dátumy
      // Formát: "billa_18.06-24.06.2025.json"
      const fileName = file.name.replace(".json", "");
      const parts = fileName.split("_");
      
      if (parts.length >= 2) {
        // Prvá časť je názov siete
        const detectedShop = parts[0];
        setShop(detectedShop);
        
        // Zvyšok je dátumová časť: "18.06-24.06.2025"
        const dateString = parts.slice(1).join("_");
        
        // Parsovať dátumy: "18.06-24.06.2025"
        // Regex: DDmM-DD.MM.YYYY alebo DD.MM-DD.MM.YYYY
        const dateMatch = dateString.match(/(\d{1,2})\.(\d{2})-(\d{1,2})\.(\d{2})\.(\d{4})/);
        
        if (dateMatch) {
          const [, day1, month1, day2, month2, year] = dateMatch;
          const from = `${day1.padStart(2, "0")}.${month1}.${year}`;
          const to = `${day2.padStart(2, "0")}.${month2}.${year}`;
          setFlyerDateFrom(from);
          setFlyerDateTo(to);
        }
      }
      
      // Uloži nahraný flyer bez zmeny produktov v UI
      setLoadedFlyer(data);
      setLoadedFileName(file.name);
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

  const handleUploadClick = () => {
    setShowUploadConfirm(true);
  };

  const uploadToSupabase = async () => {
    setShowUploadConfirm(false);
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

      <main className="relative mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-8 pb-16 pt-6">
        <header className="flex flex-col gap-2">
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
        </header>

        <section className="grid gap-6 lg:grid-cols-[minmax(850px,2.6fr)_minmax(350px,1fr)]">
          <div className="rounded-3xl bg-[color:var(--panel)] p-6 shadow-[var(--shadow)] animate-[fade-in_0.6s_ease-out]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className="font-[var(--font-display)] text-2xl text-[color:var(--ink)]">
                {t("section_input")}
              </h2>
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-[color:var(--muted)]">
                {t("products_count")} <span>{loadedProductsList.length + products.length}</span>
              </div>
            </div>

            <div className="mt-6 grid gap-4">
              <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                {t("label_shop")}
                <input
                  className="rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none transition focus:border-black/30"
                  value={shop}
                  onChange={(event) => setShop(event.target.value)}
                  placeholder="billa"
                />
              </label>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_flyer_date_from")}
                  <input
                    type="date"
                    className="rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none transition focus:border-black/30"
                    value={flyerDateFrom ? flyerDateFrom.split(".").reverse().join("-") : ""}
                    onChange={(event) => {
                      if (event.target.value) {
                        const [year, month, day] = event.target.value.split("-");
                        const newFromDate = `${day}.${month}.${year}`;
                        const oldFrom = flyerDateFrom;
                        
                        setFlyerDateFrom(newFromDate);
                        
                        // Prepočítaj "Do" dátum len ak existuje a bol nastavený "Od" dátum
                        if (oldFrom && flyerDateTo) {
                          const daysDifference = getDateDifference(oldFrom, flyerDateTo);
                          const newToDate = addDaysToDate(newFromDate, daysDifference);
                          setFlyerDateTo(newToDate);
                        }
                      } else {
                        setFlyerDateFrom("");
                      }
                    }}
                  />
                </label>
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_flyer_date_to")}
                  <input
                    type="date"
                    className="rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none transition focus:border-black/30"
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

              <div className="rounded-lg border-2 border-orange-500 bg-orange-50 px-4 py-3">
                <strong className="text-sm text-gray-700">📄 {t("label_final_filename")}:</strong>
                <div className="mt-2 font-mono text-lg font-bold text-gray-900 break-all">{resolvedFileName}</div>
              </div>

              <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                {t("label_storage_folder")}
                <select
                  className="rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none"
                  value={bucketPath}
                  onChange={(event) => setBucketPath(event.target.value)}
                >
                  <option value="sk">{t("storage_sk")}</option>
                  <option value="cz">{t("storage_cz")}</option>
                  <option value="pl">{t("storage_pl")}</option>
                </select>
              </label>

              <div className="grid gap-2 text-sm text-[color:var(--muted)]">
                <div>{t("label_load_json")}</div>
                <div className="flex gap-3">
                  <label htmlFor="json-file-input" className="rounded-full bg-[color:var(--accent)] px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-orange-200 transition hover:brightness-95 cursor-pointer">
                    Vybrať súbor
                  </label>
                  <input
                    key={loadedFileName || "file-input"}
                    id="json-file-input"
                    className="absolute opacity-0 w-0 h-0"
                    type="file"
                    accept=".json"
                    onChange={handleLoadJson}
                  />
                  {loadedFileName && (
                    <div className="rounded-lg border-2 border-orange-500 bg-orange-50 px-4 py-3 flex-1 flex items-center">
                      <strong className="text-sm text-gray-700">📦 {loadedFileName}</strong>
                    </div>
                  )}
                </div>
              </div>

              <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                {t("label_product_name")}
                <div className="relative">
                  <input
                    className="w-full rounded-xl border border-black/10 bg-white px-5 py-4 pr-10 text-xl text-[color:var(--ink)] outline-none transition focus:border-black/30"
                    value={form.name}
                    onChange={(event) => {
                      const newName = event.target.value;
                      setForm((prev) => ({ ...prev, name: newName }));
                      
                      // Filtrujem podľa obsahovania textu v názve (case-insensitive)
                      if (newName.trim() && loadedFlyer) {
                        const filtered = loadedProductsList.filter((p) =>
                          p.name.toLowerCase().includes(newName.toLowerCase())
                        );
                        setFilteredSuggestions(filtered);
                        setShowSuggestions(filtered.length > 0);
                        setPreviewProduct(null);
                      } else {
                        setShowSuggestions(false);
                        setFilteredSuggestions([]);
                        setPreviewProduct(null);
                      }
                    }}
                    onFocus={() => {
                      if (form.name.trim() && filteredSuggestions.length > 0) {
                        setShowSuggestions(true);
                      }
                    }}
                    placeholder={t("placeholder_product_name")}
                  />
                  
                  {/* Chevron button pre zobrazenie všetkých možnností */}
                  {loadedFlyer && loadedProductsList.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        if (showSuggestions) {
                          setShowSuggestions(false);
                        } else {
                          setFilteredSuggestions(loadedProductsList);
                          setShowSuggestions(true);
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
                    <div className="absolute top-full left-0 right-0 mt-1 max-h-[300px] overflow-y-auto rounded-xl border border-black/10 bg-white shadow-lg z-10">
                      {filteredSuggestions.map((p, idx) => (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => {
                            setForm((prev) => ({ ...prev, name: p.name }));
                            setShowSuggestions(false);
                            setFilteredSuggestions([]);
                            setPreviewProduct(p);
                          }}
                          className="w-full px-4 py-2 text-left text-sm text-[color:var(--ink)] hover:bg-orange-50 transition border-b border-black/5 last:border-b-0"
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </label>

              {/* Preview BOX pre vybraný produkt */}
              {previewProduct && (
                <div className="rounded-xl border-2 border-orange-300 bg-orange-50 p-4">
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

                    <div className="border-t border-orange-200 pt-2">
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
                      className="flex-1 rounded-lg bg-orange-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-orange-600"
                    >
                      {t("btn_add")}
                    </button>
                    <button
                      onClick={handleCancelPreview}
                      className="flex-1 rounded-lg border border-orange-300 px-3 py-2 text-sm font-medium text-orange-600 transition hover:bg-orange-100"
                    >
                      {t("btn_cancel")}
                    </button>
                  </div>
                </div>
              )}

              <div className="grid gap-6">
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_category")}
                  <select
                    className="rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none cursor-pointer"
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

                <div className="grid gap-3 md:grid-cols-2">
                  <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                    {t("label_subcategory")}
                    <select
                      className="rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none cursor-pointer"
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

                  <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                    {t("label_placement")}
                    <select
                      className="rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none cursor-pointer"
                      value={placementKey}
                      onChange={(event) => setPlacementKey(event.target.value)}
                    >
                      {sortedPlacements.map((item) => (
                        <option key={item["Zaradenie"]} value={item["Zaradenie"]}>
                          {locLabelFor(item["Zaradenie"])}
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
                    className="w-full max-w-[160px] rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none"
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
                    placeholder="1"
                  />
                </label>
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_unit")}
                  <select
                    className="w-full max-w-[160px] rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none"
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
                    className="w-full max-w-[200px] rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none"
                    value={form.priceRegular || ""}
                    onChange={(event) => {
                      const newPrice = normalizePrice(event.target.value);
                      setForm((prev) => ({
                        ...prev,
                        priceRegular: newPrice,
                        priceRegularUnit: calculateUnitPrice(newPrice, prev.amount, prev.unit),
                      }));
                    }}
                    placeholder="1"
                  />
                </label>
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_regular_unit_price")}
                  <input
                    className="w-full max-w-[200px] rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none"
                    value={form.priceRegularUnit}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev, 
                        priceRegularUnit: normalizePrice(event.target.value),
                      }))
                    }
                    placeholder="1"
                  />
                </label>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_sale_price")}
                  <input
                    className="w-full max-w-[200px] rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none"
                    value={form.priceSale || ""}
                    onChange={(event) => {
                      const newPrice = normalizePrice(event.target.value);
                      setForm((prev) => ({
                        ...prev,
                        priceSale: newPrice,
                        priceSaleUnit: calculateUnitPrice(newPrice, prev.amount, prev.unit),
                      }));
                    }}
                    placeholder="1"
                  />
                </label>
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_sale_unit_price")}
                  <input
                    className="w-full max-w-[200px] rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none"
                    value={form.priceSaleUnit}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        priceSaleUnit: normalizePrice(event.target.value),
                      }))
                    }
                    placeholder="1"
                  />
                </label>
              </div>

              <div className="grid gap-3 grid-cols-[1fr_1fr_1.5fr]">
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_date_from")}
                  <input
                    type="date"
                    className="w-full rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none cursor-pointer"
                    value={form.dateFrom ? form.dateFrom.split(".").reverse().join("-") : ""}
                    onClick={(e) => {
                      if (!form.dateFrom) {
                        const today = getTodayDate();
                        const endDate = addDaysToDate(today, 7);
                        setForm((prev) => ({
                          ...prev,
                          dateFrom: today,
                          dateTo: endDate,
                        }));
                      }
                    }}
                    onChange={(event) => {
                      if (event.target.value) {
                        const [year, month, day] = event.target.value.split("-");
                        const newFromDate = `${day}.${month}.${year}`;
                        const oldFrom = form.dateFrom;
                        
                        setForm((prev) => {
                          const newForm = {
                            ...prev,
                            dateFrom: newFromDate,
                          };
                          
                          // Prepočítaj "Do" dátum len ak existuje a bol nastavený "Od" dátum
                          if (oldFrom && prev.dateTo) {
                            const daysDifference = getDateDifference(oldFrom, prev.dateTo);
                            const newToDate = addDaysToDate(newFromDate, daysDifference);
                            newForm.dateTo = newToDate;
                          }
                          
                          return newForm;
                        });
                      } else {
                        setForm((prev) => ({
                          ...prev,
                          dateFrom: "",
                        }));
                      }
                    }}
                  />
                </label>
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_date_to")}
                  <input
                    type="date"
                    className="w-full rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none"
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
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_extra_info")}
                  <div className="relative">
                    <input
                      className="w-full rounded-xl border border-black/10 bg-white px-5 py-4 pr-10 text-xl text-[color:var(--ink)] outline-none transition focus:border-black/30"
                      value={form.info || ""}
                      onChange={(event) => {
                        const newInfo = event.target.value;
                        setForm((prev) => ({ ...prev, info: newInfo }));
                        
                        if (newInfo.trim() && loadedFlyer) {
                          const filtered = loadedExtraInfosList.filter((info) =>
                            info.toLowerCase().includes(newInfo.toLowerCase())
                          );
                          setFilteredInfoSuggestions(filtered);
                          setShowInfoSuggestions(filtered.length > 0);
                        } else {
                          setShowInfoSuggestions(false);
                          setFilteredInfoSuggestions([]);
                        }
                      }}
                      onFocus={() => {
                        if (form.info.trim() && filteredInfoSuggestions.length > 0) {
                          setShowInfoSuggestions(true);
                        }
                      }}
                      placeholder={t("placeholder_extra_info")}
                    />
                    
                    {loadedFlyer && loadedExtraInfosList.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          if (showInfoSuggestions) {
                            setShowInfoSuggestions(false);
                          } else {
                            setFilteredInfoSuggestions(loadedExtraInfosList);
                            setShowInfoSuggestions(true);
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
                      <div className="absolute top-full left-0 right-0 mt-1 max-h-[300px] overflow-y-auto rounded-xl border border-black/10 bg-white shadow-lg z-10">
                        {filteredInfoSuggestions.map((info, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => {
                              setForm((prev) => ({ ...prev, info }));
                              setShowInfoSuggestions(false);
                              setFilteredInfoSuggestions([]);
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-[color:var(--ink)] hover:bg-orange-50 transition border-b border-black/5 last:border-b-0"
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
                  {editingId || editingLoadedRef ? t("btn_save_changes") : t("btn_add_product")}
                </button>
                {editingId || editingLoadedRef ? (
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
                    setLoadedFileName("");
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
                <input
                  className="w-full rounded-xl border border-black/10 bg-white px-4 py-3 text-sm text-[color:var(--ink)] outline-none transition focus:border-black/30"
                  value={productListQuery}
                  onChange={(event) => setProductListQuery(event.target.value)}
                  placeholder="Hľadať produkt v zozname..."
                />
              </div>
              <div className="mt-3 grid max-h-[520px] gap-3 overflow-y-auto pr-1">
                {displayProducts.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-black/10 bg-[#faf7f2] px-4 py-6 text-sm text-[color:var(--muted)]">
                    {t("empty_products")}
                  </div>
                ) : filteredDisplayProducts.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-black/10 bg-[#faf7f2] px-4 py-6 text-sm text-[color:var(--muted)]">
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
                          onClick={() =>
                            item.type === "loaded"
                              ? handleSelectProduct(item.entry)
                              : startEdit(item.entry)
                          }
                          type="button"
                        >
                          {t("btn_edit")}
                        </button>
                        <button
                          className="rounded-full border border-black/10 px-3 py-1 text-xs font-semibold text-[color:var(--muted)] transition hover:border-black/30"
                          onClick={() =>
                            item.type === "loaded"
                              ? removeLoadedProduct(item.entry.ref)
                              : removeProduct(item.entry.id)
                          }
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

          <div className="flex flex-col gap-6">
            <div className="flex flex-col rounded-3xl bg-[#0f1b2b] p-6 text-white shadow-[var(--shadow)] animate-[float-in_0.6s_ease-out]">
              <h2 className="font-[var(--font-display)] text-2xl">
                {t("section_output")}
              </h2>
              <div className="mt-4 flex flex-col gap-3">
                {/* <button
                  className="rounded-full bg-white px-4 py-2 text-xs font-semibold text-[#0f1b2b]"
                  onClick={copyJson}
                  type="button"
                >
                  {t("btn_copy_json")}
                </button> */}
                <button
                  className="rounded-full bg-white px-6 py-3 text-sm font-semibold text-[#0f1b2b] hover:bg-white/90 transition-colors"
                  onClick={downloadJson}
                  type="button"
                >
                  {t("btn_download_file")}
                </button>
                <button
                  className="rounded-full border-2 border-white/40 px-6 py-3 text-sm font-semibold text-white hover:bg-white/10 transition-colors disabled:opacity-60"
                  onClick={handleUploadClick}
                  type="button"
                  disabled={isUploading}
                >
                  {isUploading ? t("btn_uploading") : t("btn_upload_supabase")}
                </button>
              </div>
              {/* <pre className="mt-4 max-h-[900px] overflow-auto rounded-2xl bg-[#0b1220] p-4 text-xs leading-5 text-white/80">
                {jsonPreview}
              </pre> */}
            </div>
          </div>
        </section>
      </main>

      {/* Upload Confirmation Modal */}
      {showUploadConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-[fade-in_0.2s_ease-out]">
          <div className="relative mx-4 w-full max-w-md rounded-3xl bg-[#0f1b2b] p-8 text-white shadow-2xl animate-[float-in_0.3s_ease-out]">
            <h3 className="font-[var(--font-display)] text-2xl font-semibold mb-3">
              {t("confirm_upload")}
            </h3>
            <p className="text-sm text-white/70 mb-6">
              Leták bude nahraný do databázy.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowUploadConfirm(false)}
                className="flex-1 rounded-full border-2 border-white/40 px-6 py-3 text-sm font-semibold text-white hover:bg-white/10 transition-colors"
              >
                {t("btn_cancel")}
              </button>
              <button
                onClick={uploadToSupabase}
                className="flex-1 rounded-full bg-orange-500 px-6 py-3 text-sm font-semibold text-white hover:bg-orange-600 transition-colors"
              >
                {t("btn_confirm_upload")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
