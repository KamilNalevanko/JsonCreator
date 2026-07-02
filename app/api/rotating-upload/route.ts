import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

type IndexState = {
  next: number;
  isFull: boolean;
};

const BUCKET = "cap-data";
const MAX_SLOTS = 10;

const sanitizeBase = (value: string) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "letak";

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// Dátumy: parsovanie + kontrola rozumného roka.
// Preklepy typu 25.02.0026, 22.06.2202, 04.03.2062 by inak držali leták
// "aktívny" naveky (appka porovnáva len dnešok <= do).
// ---------------------------------------------------------------------------
const MIN_YEAR = 2024;
const maxYear = () => new Date().getFullYear() + 1;

const parsePromoDate = (raw: unknown): Date | null => {
  const s = (raw ?? "").toString().trim();
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (year < MIN_YEAR || year > maxYear()) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
};

const todayMidnight = () => {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t;
};

type FlyerProductLite = {
  ["Názov"]?: unknown;
  ["Dátum akcie od"]?: unknown;
  ["Dátum akcie do"]?: unknown;
};

const iterateProducts = function* (db: unknown): Generator<FlyerProductLite> {
  if (!Array.isArray(db)) return;
  for (const cat of db) {
    const subs = (cat as any)?.["Podkategórie"];
    if (!Array.isArray(subs)) continue;
    for (const sub of subs) {
      const zars = (sub as any)?.["Zaradenia"];
      if (!Array.isArray(zars)) continue;
      for (const zar of zars) {
        const prods = (zar as any)?.["Produkty"];
        if (!Array.isArray(prods)) continue;
        for (const p of prods) yield p as FlyerProductLite;
      }
    }
  }
};

/// Vráti zoznam produktov s neplatným/nezmyselným dátumom (max `limit` príkladov).
const findInvalidDates = (db: unknown, limit = 10): string[] => {
  const problems: string[] = [];
  for (const p of iterateProducts(db)) {
    const from = parsePromoDate(p?.["Dátum akcie od"]);
    const to = parsePromoDate(p?.["Dátum akcie do"]);
    if (!from || !to) {
      const name = (p?.["Názov"] ?? "?").toString().slice(0, 60);
      problems.push(
        `${name} (od: "${p?.["Dátum akcie od"] ?? ""}", do: "${p?.["Dátum akcie do"] ?? ""}")`
      );
      if (problems.length >= limit) break;
    }
  }
  return problems;
};

/// Leták má zmysel držať, ak obsahuje aspoň jeden produkt platný dnes alebo v budúcnosti.
const flyerIsAlive = (db: unknown): boolean => {
  const today = todayMidnight();
  for (const p of iterateProducts(db)) {
    const from = parsePromoDate(p?.["Dátum akcie od"]);
    const to = parsePromoDate(p?.["Dátum akcie do"]);
    if (from && to && to >= today) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
const listShopFiles = async (
  supabase: SupabaseClient<any>,
  basePath: string,
  fileBase: string
) => {
  const listRes = await supabase.storage.from(BUCKET).list(basePath, {
    limit: 1000,
  });
  if (listRes.error || !listRes.data) {
    throw new Error(`Storage list failed: ${listRes.error?.message ?? "?"}`);
  }

  const baseName = `${fileBase}.json`;
  const slotRegex = new RegExp(`^${escapeRegExp(fileBase)}_(\\d{1,2})\\.json$`);

  // slot 0 = základný súbor bez čísla (legacy), inak číslo slotu.
  const files: { slot: number; name: string }[] = [];
  for (const item of listRes.data) {
    const name = item?.name;
    if (!name) continue;
    if (name === baseName) {
      files.push({ slot: 0, name });
      continue;
    }
    const match = name.match(slotRegex);
    if (match) {
      files.push({ slot: Number(match[1]), name });
    }
  }
  files.sort((a, b) => a.slot - b.slot);
  return files;
};

const writeIndex = async (
  supabase: SupabaseClient<any>,
  indexPath: string,
  state: IndexState
) => {
  const payload = JSON.stringify(state, null, 2);
  return supabase.storage.from(BUCKET).upload(indexPath, payload, {
    contentType: "application/json",
    upsert: true,
    cacheControl: "0",
  });
};

const uploadQueue = new Map<string, Promise<void>>();

const withUploadLock = async <T>(
  key: string,
  work: () => Promise<T>
): Promise<T> => {
  const prior = uploadQueue.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  uploadQueue.set(key, prior.then(() => gate));
  await prior;
  try {
    return await work();
  } finally {
    release();
    if (uploadQueue.get(key) === gate) {
      uploadQueue.delete(key);
    }
  }
};

// ---------------------------------------------------------------------------
// POST: nahraj nový leták + uprac sloty obchodu.
//
// Postup (pod zámkom pre daný obchod):
//  1. Validácia payloadu: JSON + rozumné dátumy (inak 400 so zoznamom problémov).
//  2. Stiahni existujúce sloty, zisti ktoré sú ešte "živé" (platné dnes/v budúcnosti).
//  3. Expirované zmaž, živé prečísluj na súvislé _1.._K (appka číta sloty od _1
//     a zastaví sa na prvej diere — súvislosť je nutná).
//  4. Nový leták zapíš ako _{K+1}. Pri prekročení MAX_SLOTS zmaž najstarší.
//  5. Index = { next: K+2, isFull: false }.
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  try {
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRole) {
      return NextResponse.json(
        { ok: false, error: "Missing SUPABASE env (URL or SERVICE_ROLE_KEY)." },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const country = (body?.country || "").toString().toLowerCase().trim();
    const shop = (body?.shop || "").toString().trim();
    const payload = body?.payload;

    if (!country || !["sk", "cz", "pl"].includes(country)) {
      return NextResponse.json(
        { ok: false, error: "Invalid country. Use sk/cz/pl." },
        { status: 400 }
      );
    }

    if (!shop) {
      return NextResponse.json(
        { ok: false, error: "Missing shop." },
        { status: 400 }
      );
    }

    const content =
      typeof payload === "string" ? payload : JSON.stringify(payload ?? {});

    if (!content || content.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: "Missing JSON payload." },
        { status: 400 }
      );
    }

    // 1) Validácia obsahu: parsovateľný JSON + rozumné dátumy akcií.
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(content);
    } catch {
      return NextResponse.json(
        { ok: false, error: "Payload nie je platný JSON." },
        { status: 400 }
      );
    }

    const invalidDates = findInvalidDates(parsedPayload);
    if (invalidDates.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Leták obsahuje produkty s chýbajúcim alebo nezmyselným dátumom akcie " +
            `(očakávam DD.MM.RRRR s rokom ${MIN_YEAR}–${maxYear()}). Oprav ich a nahraj znova.`,
          invalidProducts: invalidDates,
        },
        { status: 400 }
      );
    }

    if (!flyerIsAlive(parsedPayload)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Leták neobsahuje žiadny produkt platný dnes ani v budúcnosti — nenahrávam expirovaný leták.",
        },
        { status: 400 }
      );
    }

    const fileBase = sanitizeBase(shop);
    const basePath = `databazy/${country}`;
    const indexPath = `${basePath}/_indexes/${fileBase}.json`;

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    return await withUploadLock(`${basePath}/${fileBase}`, async () => {
      // 2) Zisti stav existujúcich slotov.
      const files = await listShopFiles(supabase, basePath, fileBase);
      const alive: { slot: number; name: string }[] = [];
      const dead: string[] = [];

      for (const f of files) {
        const dl = await supabase.storage
          .from(BUCKET)
          .download(`${basePath}/${f.name}`);
        if (dl.error || !dl.data) {
          // Nečitateľný súbor — radšej ho odstrániť, appka by ho aj tak nespracovala.
          dead.push(f.name);
          continue;
        }
        try {
          const json = JSON.parse(await dl.data.text());
          if (flyerIsAlive(json)) {
            alive.push(f);
          } else {
            dead.push(f.name);
          }
        } catch {
          dead.push(f.name);
        }
      }

      // 3) Zmaž expirované, prečísluj živé na _1.._K.
      if (dead.length > 0) {
        const removeRes = await supabase.storage
          .from(BUCKET)
          .remove(dead.map((name) => `${basePath}/${name}`));
        if (removeRes.error) {
          return NextResponse.json(
            { ok: false, error: `Cleanup failed: ${removeRes.error.message}` },
            { status: 500 }
          );
        }
      }

      // Ak by aj po vyčistení bolo príliš veľa živých slotov, zahoď najstaršie.
      while (alive.length >= MAX_SLOTS) {
        const oldest = alive.shift()!;
        await supabase.storage
          .from(BUCKET)
          .remove([`${basePath}/${oldest.name}`]);
      }

      for (let i = 0; i < alive.length; i += 1) {
        const target = `${fileBase}_${i + 1}.json`;
        if (alive[i].name !== target) {
          const moveRes = await supabase.storage
            .from(BUCKET)
            .move(`${basePath}/${alive[i].name}`, `${basePath}/${target}`);
          if (moveRes.error) {
            return NextResponse.json(
              {
                ok: false,
                error: `Renumber failed (${alive[i].name} -> ${target}): ${moveRes.error.message}`,
              },
              { status: 500 }
            );
          }
          alive[i] = { slot: i + 1, name: target };
        }
      }

      // 4) Zapíš nový leták ako ďalší slot v poradí.
      const slot = alive.length + 1;
      const targetPath = `${basePath}/${fileBase}_${slot}.json`;

      const uploadRes = await supabase.storage
        .from(BUCKET)
        .upload(targetPath, content, {
          contentType: "application/json",
          upsert: true,
          cacheControl: "0",
        });

      if (uploadRes.error) {
        return NextResponse.json(
          { ok: false, error: uploadRes.error.message, path: targetPath },
          { status: 500 }
        );
      }

      // 5) Aktualizuj index.
      const nextState: IndexState = { next: slot + 1, isFull: slot >= MAX_SLOTS };
      const indexRes = await writeIndex(supabase, indexPath, nextState);
      if (indexRes.error) {
        return NextResponse.json(
          { ok: false, error: indexRes.error.message },
          { status: 500 }
        );
      }

      return NextResponse.json({
        ok: true,
        path: targetPath,
        next: nextState.next,
        isFull: nextState.isFull,
        removedExpired: dead,
        keptSlots: alive.length + 1,
      });
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
