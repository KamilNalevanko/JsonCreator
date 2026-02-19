"use client";

import { useMemo, useState, useEffect, useRef } from "react";
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

const makeId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [language, setLanguage] = useState("sk");
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
  const [bucketPath, setBucketPath] = useState("sk");
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
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const suggestionsBoxRef = useRef<HTMLDivElement | null>(null);
  const infoInputRef = useRef<HTMLInputElement | null>(null);
  const infoSuggestionsBoxRef = useRef<HTMLDivElement | null>(null);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState<number>(-1);
  const suggestionItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [productListQuery, setProductListQuery] = useState("");
  const [showUploadConfirm, setShowUploadConfirm] = useState(false);
  const shopOptionsByFolder: Record<
    string,
    Array<{ value: string; label: string }>
  > = {
    sk: [
      { value: "lidl", label: "Lidl" },
      { value: "billa", label: "Billa" },
    ],
    pl: [{ value: "lidl", label: "Lidl" }],
    cz: [],
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
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    const available = shopOptionsByFolder[bucketPath] ?? [];
    const hasCurrent = available.some((option) => option.value === shop);
    if (!hasCurrent) {
      setShop(available[0]?.value ?? "");
    }
    setLoadedFlyer(null);
    setProducts([]);
    setEditingId(null);
    setEditingLoadedRef(null);
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
        }
      }
    };

    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSuggestions, showInfoSuggestions]);

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

  // Extrahovať všetky produkty z loadedFlyer s ich metadátami
  const loadedProductsList = useMemo<LoadedProductEntry[]>(() => {
    if (!loadedFlyer) return [];

    const allProducts: LoadedProductEntry[] = [];

    loadedFlyer.forEach((category: HierarchyCategory, categoryIndex: number) => {
      const categoryKey = category["Kategória"];
      (category["Podkategórie"] ?? []).forEach((subcategory: HierarchySubcategory, subcategoryIndex: number) => {
        const subcategoryKey = subcategory["Podkategória"];
        (subcategory["Zaradenia"] ?? []).forEach((placement: HierarchyPlacement, placementIndex: number) => {
          const placementKey = placement["Zaradenie"];
          (placement["Produkty"] ?? []).forEach((product: FlyerProduct, productIndex: number) => {
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
    for (const category of loadedFlyer as HierarchyCategory[]) {
      for (const subcategory of category["Podkategórie"] ?? [] as HierarchySubcategory[]) {
        for (const placement of subcategory["Zaradenia"] ?? [] as HierarchyPlacement[]) {
          for (const product of placement["Produkty"] ?? [] as FlyerProduct[]) {
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
    if (!bucketPath || !shop) return;
    try {
      const response = await fetch("/api/append-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucketPath, shop, product }),
      });
      if (!response.ok) {
        const message = await response.text();
        console.error("Append product failed:", message);
      }
    } catch (err) {
      console.error("Append product failed:", err);
    }
  };

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

    const alreadyInLoadedFlyer = isProductInLoadedFlyer(product);

    if (editingLoadedRef && loadedFlyer) {
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

  const loadShopJson = async (shopKey: string) => {
    try {
      setError("");
      setStatus("");
      const safeFolder = (bucketPath || "sk").toLowerCase().trim();
      const safeShop = (shopKey || "").toLowerCase().trim();
      if (!safeShop || !safeFolder) return;
   const base = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
const candidates = [
  `${base}/data/${safeFolder}/${safeShop}.json`,
  `${base}/data/${safeFolder}/${safeShop}/${safeShop}.json`, // fallback ak raz prejdeš na zložky
];

// ak nechceš env, stačí aj čisto relatívne:
// const candidates = [`data/${safeFolder}/${safeShop}.json`, `data/${safeFolder}/${safeShop}/${safeShop}.json`];

      let response: Response | null = null;
      let lastUrl = "";
      for (const candidate of candidates) {
        lastUrl = candidate;
        const attempt = await fetch(candidate, { cache: "no-store" });
        if (attempt.ok) {
          response = attempt;
          break;
        }
      }

      if (!response) {
        setLoadedFlyer(null);
        setError(`${t("error_load_json")} (${lastUrl})`);
        return;
      }

      const data = await response.json();
      setLoadedFlyer(data);
      setStatus(t("status_loaded_file"));
    } catch (err) {
      setLoadedFlyer(null);
      setError(t("error_load_json"));
      console.error("Load JSON error:", err);
    }
  };

  useEffect(() => {
    if (!shop) return;
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
    const nameStem = safeName.replace(/\.json$/i, "");
    const nameExt = ".json";
    const safeShop = shop
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const basePath = `databazy/${bucketPath}`;

    try {
      setIsUploading(true);
      const maxAttempts = 50;
      let attempt = 0;
      while (attempt < maxAttempts) {
        const fileName = attempt === 0 ? safeName : `${nameStem}_${attempt}${nameExt}`;
        const attemptPath = `${basePath}/${safeShop || "nezaradene"}/${fileName}`;
        const { error: uploadError } = await supabase.storage
          .from("cap-data")
          .upload(attemptPath, jsonPreview, {
            contentType: "application/json",
            upsert: false,
          });

        if (!uploadError) {
          setStatus(t("status_uploaded"));
          return;
        }

        if (uploadError.message?.toLowerCase().includes("already exists")) {
          attempt += 1;
          continue;
        }

        setError(
          t("error_upload_failed_detail", { message: uploadError.message })
        );
        return;
      }

      setError(
        t("error_upload_failed_detail", {
          message: "Nepodarilo sa najst volny nazov suboru.",
        })
      );
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(t("error_upload_failed_detail", { message }));
      console.error("Upload failed:", err);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-gray-200">
      

      <main className="relative mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-8 pb-16 pt-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm uppercase tracking-[0.3em] text-[color:var(--muted)]">
              {t("app_badge")}
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="rounded-xl border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-[color:var(--ink)] outline-none transition hover:border-black/30"
              >
                {theme === "dark" ? "Svetlý režim" : "Tmavý režim"}
              </button>
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
          </div>
          <h1 className="font-[var(--font-display)] text-4xl font-semibold text-[color:var(--ink)] md:text-5xl">
            {t("app_title")}
          </h1>
        </header>

        <section className="grid gap-6 lg:grid-cols-[minmax(980px,3fr)_minmax(300px,1fr)]">
          <div className="rounded-3xl bg-[color:var(--panel)] p-6 shadow-[var(--shadow)] animate-[fade-in_0.6s_ease-out]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-[color:var(--muted)]">
                Počet produktov pre reťazec <span>{loadedProductsList.length}</span>
              </div>
            </div>

            <div className="mt-6 grid gap-4">
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
                <div className="relative">
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
                        setPreviewProduct(null);
                      } else {
                        setShowSuggestions(false);
                        setFilteredSuggestions([]);
                        setActiveSuggestionIndex(-1);
                        setPreviewProduct(null);
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
                        <button
                          key={p.id ?? idx}
                          ref={(el) => {
                            suggestionItemRefs.current[idx] = el;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            // Use mouse down so the click isn't lost due to input blur
                            e.preventDefault();
                            selectLoadedSuggestion(p);
                          }}
                          onMouseEnter={() => setActiveSuggestionIndex(idx)}
                          className={`w-full px-4 py-2 text-left text-sm text-[color:var(--ink)] transition border-b border-black/5 last:border-b-0 ${
                            idx === activeSuggestionIndex ? "bg-[color:var(--accent)]/10" : "hover:bg-[color:var(--accent)]/10"
                          }`}
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
                  <input
                    type="date"
                    className="w-full rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                    value={form.dateFrom ? form.dateFrom.split(".").reverse().join("-") : ""}
                    onChange={(event) => {
                      if (event.target.value) {
                        const [year, month, day] = event.target.value.split("-");
                        const newFromDate = `${day}.${month}.${year}`;
                        setForm((prev) => ({ ...prev, dateFrom: newFromDate }));
                      } else {
                        setForm((prev) => ({ ...prev, dateFrom: "" }));
                      }
                    }}
                  />
                </label>
                <label className="grid gap-2 text-xl font-semibold text-[color:var(--ink)]">
                  {t("label_date_to")}
                  <input
                    type="date"
                    className="w-full rounded-xl border border-black/10 bg-white px-5 py-4 text-xl text-[color:var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
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
                      className="w-full rounded-xl border border-black/10 bg-white px-5 py-4 pr-10 text-xl text-[color:var(--ink)] outline-none transition focus:border-black/30 focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-opacity-30 focus-visible:ring-offset-1"
                      value={form.info || ""}
                      onChange={(event) => {
                        const newInfo = event.target.value;
                        setForm((prev) => ({ ...prev, info: newInfo }));
                        
                        if (newInfo.trim() && loadedFlyer) {
                          const filtered = loadedExtraInfosList.filter((info) =>
                            normalizeKey(info).includes(normalizeKey(newInfo))
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
                        onMouseDown={(e) => e.preventDefault()}
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
                      <div ref={infoSuggestionsBoxRef} className="absolute top-full left-0 right-0 mt-1 max-h-[300px] overflow-y-auto rounded-xl border border-black/10 bg-white shadow-lg z-10">
                        {filteredInfoSuggestions.map((info, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => {
                              setForm((prev) => ({ ...prev, info }));
                              setShowInfoSuggestions(false);
                              setFilteredInfoSuggestions([]);
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-[color:var(--ink)] hover:bg-[color:var(--accent)]/10 transition border-b border-black/5 last:border-b-0"
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

              <div className="flex items-center gap-3 flex-nowrap">
                <button
                  className="rounded-full bg-[color:var(--accent)] px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-green-300/50 transition hover:brightness-95"
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
                    setEditingId(null);
                  }}
                  type="button"
                >
                  {t("btn_clear_all")}
                </button>
                <button
                  className="rounded-full bg-[#0f1b2b] px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-black/20 transition hover:brightness-110"
                  onClick={downloadJson}
                  type="button"
                >
                  {t("btn_download_file")}
                </button>
                <button
                  className="rounded-full bg-[#0f1b2b] px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-black/20 transition hover:brightness-110 disabled:opacity-60"
                  onClick={handleUploadClick}
                  type="button"
                  disabled={isUploading}
                >
                  {isUploading ? "Nahrávam..." : "Nahrať na server"}
                </button>
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
                  <div className="rounded-2xl border border-dashed border-black/10 bg-[#f0f8f4] px-4 py-6 text-sm text-[color:var(--muted)]">
                    {t("empty_products")}
                  </div>
                ) : filteredDisplayProducts.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-black/10 bg-[#f0f8f4] px-4 py-6 text-sm text-[color:var(--muted)]">
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
                className="flex-1 rounded-full bg-[color:var(--accent)] px-6 py-3 text-sm font-semibold text-white hover:brightness-90 transition-colors"
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
