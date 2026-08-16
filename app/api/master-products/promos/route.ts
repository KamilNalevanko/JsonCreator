import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizeNameKey } from "../../../../lib/normalize";

// Read-only sken: nájde VŠETKY akcie (promo inštancie) daného produktu naprieč
// všetkými letákovými slotmi obchodu. Databáza drží len jednu (unikát na názov),
// preto tu čítame priamo letákové súbory.

const sanitizeBase = (value: string) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "letak";

const normAmount = (v: unknown) =>
  String(v ?? "").toLowerCase().replace(/,/g, ".").replace(/\s+/g, " ").trim();

export async function GET(req: Request) {
  try {
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRole) {
      return NextResponse.json(
        { ok: false, error: "Missing SUPABASE env." },
        { status: 500 },
      );
    }

    const { searchParams } = new URL(req.url);
    const country = (searchParams.get("country") || "").toLowerCase().trim();
    const shop = (searchParams.get("shop") || "").toLowerCase().trim();
    const name = (searchParams.get("name") || "").trim();
    const amount = searchParams.get("amount");
    const unit = searchParams.get("unit");

    if (!country || !["sk", "cz", "pl"].includes(country)) {
      return NextResponse.json(
        { ok: false, error: "Invalid country." },
        { status: 400 },
      );
    }
    if (!shop || !name) {
      return NextResponse.json(
        { ok: false, error: "Missing shop or name." },
        { status: 400 },
      );
    }

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    const targetKey = normalizeNameKey(name);
    const targetAmount =
      amount !== null && String(amount).trim() !== "" ? normAmount(amount) : null;
    const targetUnit =
      unit !== null && String(unit).trim() !== ""
        ? String(unit).toLowerCase().trim()
        : null;

    const basePath = `databazy/${country}`;
    const listRes = await supabase.storage
      .from("cap-data")
      .list(basePath, { limit: 2000 });
    if (listRes.error || !listRes.data) {
      return NextResponse.json(
        { ok: false, error: listRes.error?.message || "list failed" },
        { status: 500 },
      );
    }

    const fileBase = sanitizeBase(shop);
    const slotRegex = new RegExp(
      `^${fileBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(_\\d{1,2})?\\.json$`,
    );
    const files = listRes.data
      .map((f) => f?.name || "")
      .filter((n) => slotRegex.test(n))
      .sort();

    type Promo = {
      file: string;
      categoryKey: string;
      subcategoryKey: string;
      placementKey: string;
      name: string;
      amount: string;
      unit: string;
      price_sale: string;
      price_regular: string;
      note: string;
      date_from: string;
      date_to: string;
    };
    const promos: Promo[] = [];

    for (const fileName of files) {
      const dl = await supabase.storage
        .from("cap-data")
        .download(`${basePath}/${fileName}`);
      if (dl.error || !dl.data) continue;
      let flyer: unknown;
      try {
        flyer = JSON.parse(await dl.data.text());
      } catch {
        continue;
      }
      if (!Array.isArray(flyer)) continue;
      for (const cat of flyer) {
        for (const sub of cat?.["Podkategórie"] ?? []) {
          for (const plc of sub?.["Zaradenia"] ?? []) {
            for (const p of plc?.["Produkty"] ?? []) {
              if (normalizeNameKey(p?.["Názov"] || "") !== targetKey) continue;
              if (
                targetAmount !== null &&
                normAmount(p?.["Množstvo"]) !== targetAmount
              )
                continue;
              if (
                targetUnit !== null &&
                String(p?.["Merná jednotka"] ?? "").toLowerCase().trim() !==
                  targetUnit
              )
                continue;
              promos.push({
                file: fileName,
                categoryKey: cat?.["Kategória"] || "",
                subcategoryKey: sub?.["Podkategória"] || "",
                placementKey: plc?.["Zaradenie"] || "",
                name: p?.["Názov"] || "",
                amount: p?.["Množstvo"] || "",
                unit: p?.["Merná jednotka"] || "",
                price_sale: p?.["Akciová cena"] || "",
                price_regular: p?.["Bežná cena za bal."] || "",
                note: p?.["Doplnková Informácia"] || "",
                date_from: p?.["Dátum akcie od"] || "",
                date_to: p?.["Dátum akcie do"] || "",
              });
            }
          }
        }
      }
    }

    const ymd = (s: string) => {
      const m = String(s || "").match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      return m ? +m[3] * 10000 + +m[2] * 100 + +m[1] : 0;
    };

    // Dedup: tá istá prebiehajúca akcia sa v rôznych slotoch opakuje — každý
    // týždenný upload ju pridal znova s dátumom OD toho týždňa, ale rovnakou
    // cenou a rovnakým dátumom DO. Kľúč = akc.cena | bežná.cena | dátum_do;
    // z každej skupiny necháme verziu s NAJNESKORŠÍM dátumom OD (najnovší upload).
    // Rôzny dátum DO = iná akcia → ostáva.
    const byKey = new Map<string, (typeof promos)[number]>();
    for (const p of promos) {
      const k = `${normAmount(p.price_sale)}|${normAmount(p.price_regular)}|${p.date_to}`;
      const ex = byKey.get(k);
      if (!ex || ymd(p.date_from) > ymd(ex.date_from)) byKey.set(k, p);
    }
    const distinct = [...byKey.values()];

    // Filter na AKTUÁLNE/budúce akcie (dátum_do >= dnes). Expirované z minulých
    // slotov sú len šum. Ak by nič neostalo, vrátime aspoň všetky distinct.
    const now = new Date();
    const todayYmd = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    const current = distinct.filter((p) => {
      const d = ymd(p.date_to);
      return d === 0 || d >= todayYmd; // neznámy dátum radšej ponecháme
    });
    const out = current.length > 0 ? current : distinct;
    out.sort((a, b) => ymd(a.date_from) - ymd(b.date_from));

    return NextResponse.json({
      ok: true,
      promos: out,
      totalFound: promos.length,
      files,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error" },
      { status: 500 },
    );
  }
}
