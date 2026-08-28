import { NextResponse } from "next/server";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

// ---------------------------------------------------------------------------
// Upozornenie na NOVÝ LETÁK — cielené, nie broadcast.
//
// Pošle sa len tým zariadeniam, ktoré majú daný obchod ZAŠKRTNUTÝ (appka si
// zoznam zaškrtnutých obchodov nahráva do `watchdog_subscriptions.shops`).
// Kto nemá zaškrtnutý žiadny obchod, nedostane nič — letáky si však aj tak
// môže prezerať zo všetkých sietí.
//
// Volá sa automaticky po úspešnom nahratí letáka (`/api/flyer-pages`).
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// FCM zvládne 500 správ v jednej dávke.
const BATCH = 500;

function getAdminApp(): App {
  const existing = getApps();
  if (existing.length) return existing[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Chýba FIREBASE_SERVICE_ACCOUNT v .env.local.");
  return initializeApp({ credential: cert(JSON.parse(raw)) });
}

function normalizeCountry(country: string): string {
  const c = country.toLowerCase().trim();
  return c === "cz" ? "cs" : c;
}

const SHOP_NAMES: Record<string, string> = {
  billa: "Billa",
  kaufland: "Kaufland",
  lidl: "Lidl",
  tesco: "Tesco",
  "tesco-hypermarket": "Tesco",
  "tesco-supermarket": "Tesco",
  "coop-jednota": "COOP Jednota",
  "coop-jednota-supermarket": "COOP Jednota",
  "coop-tempo": "COOP Tempo",
  biedronka: "Biedronka",
  albert: "Albert",
  penny: "Penny Market",
  globus: "Globus",
  makro: "Makro",
  terno: "Terno",
  fresh: "Fresh",
};

function prettyShop(shop: string): string {
  const known = SHOP_NAMES[shop.toLowerCase()];
  if (known) return known;
  return shop
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

const TEXTS: Record<string, { title: (s: string) => string; body: string }> = {
  sk: { title: (s) => `Nový leták — ${s}`, body: "Pozri si nové akcie v letáku." },
  cs: { title: (s) => `Nový leták — ${s}`, body: "Podívej se na nové akce v letáku." },
  pl: { title: (s) => `Nowa gazetka — ${s}`, body: "Zobacz nowe promocje w gazetce." },
};

/** Vytiahne tokeny zariadení, ktoré majú daný obchod zaškrtnutý. */
async function tokensForShop(country: string, shop: string): Promise<string[]> {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Chýba SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY v .env.local.");
  }
  const tokens: string[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const url =
      `${SUPABASE_URL}/rest/v1/watchdog_subscriptions` +
      `?select=token,shops&country=eq.${encodeURIComponent(country)}` +
      `&shops=cs.${encodeURIComponent(JSON.stringify([shop]))}`;
    const res = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Range: `${from}-${from + pageSize - 1}`,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      // Stĺpec `shops` ešte nemusí v databáze existovať.
      throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
    }
    const rows = (await res.json()) as { token?: string }[];
    for (const r of rows) if (r.token) tokens.push(r.token);
    if (rows.length < pageSize) break;
  }
  return [...new Set(tokens)];
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const shop = (body?.shop || "").toString().trim();
    const country = normalizeCountry((body?.country || "").toString());
    if (!shop || !country) {
      return NextResponse.json({ error: "Chýba shop alebo country." }, { status: 400 });
    }

    const tokens = await tokensForShop(country, shop);
    if (!tokens.length) {
      return NextResponse.json({
        ok: true,
        sent: 0,
        note: "Nikto nemá tento obchod zaškrtnutý.",
      });
    }

    const t = TEXTS[country] ?? TEXTS.sk;
    const name = prettyShop(shop);
    const messaging = getMessaging(getAdminApp());

    let sent = 0;
    let failed = 0;
    const deadTokens: string[] = [];

    for (let i = 0; i < tokens.length; i += BATCH) {
      const chunk = tokens.slice(i, i + BATCH);
      const res = await messaging.sendEachForMulticast({
        tokens: chunk,
        notification: { title: t.title(name), body: t.body },
        data: { type: "flyer", shop, country },
        android: { priority: "high", notification: { channelId: "watchdog_channel" } },
        apns: { payload: { aps: { sound: "default", badge: 1 } } },
      });
      sent += res.successCount;
      failed += res.failureCount;
      res.responses.forEach((r, idx) => {
        const code = r.error?.code ?? "";
        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-argument")
        ) {
          deadTokens.push(chunk[idx]);
        }
      });
    }

    // Upratanie mŕtvych tokenov (odinštalované appky), nech zoznam nerastie.
    if (deadTokens.length) {
      const list = deadTokens.map((x) => `"${x}"`).join(",");
      await fetch(
        `${SUPABASE_URL}/rest/v1/watchdog_subscriptions?token=in.(${encodeURIComponent(list)})`,
        {
          method: "DELETE",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        },
      ).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      shop: name,
      recipients: tokens.length,
      sent,
      failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
