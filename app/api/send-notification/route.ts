import { NextResponse } from "next/server";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

// ---------------------------------------------------------------------------
// Push notifikácie zákazníkom (broadcast) cez Firebase Cloud Messaging.
//
// Appka sa prihlasuje na topic `deals_<krajina>`, kde krajina = normalizeCountryCode
// v appke (sk / cs / pl). Editor používa pre Česko kód "cz" → mapujeme na "cs",
// aby topic sedel s tým, na ktorý je appka prihlásená.
//
// Potrebné: v `.env.local` nastav FIREBASE_SERVICE_ACCOUNT = celý JSON service
// account kľúča (Firebase konzola → Project settings → Service accounts →
// Generate new private key). Kľúč zostáva LEN lokálne (editor sa nenasadzuje).
// ---------------------------------------------------------------------------

function getAdminApp(): App {
  const existing = getApps();
  if (existing.length) return existing[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error(
      "Chýba FIREBASE_SERVICE_ACCOUNT v .env.local (JSON service account kľúča).",
    );
  }
  const serviceAccount = JSON.parse(raw);
  return initializeApp({ credential: cert(serviceAccount) });
}

function normalizeCountry(country: string): string {
  const c = country.toLowerCase().trim();
  return c === "cz" ? "cs" : c;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const country = (body?.country || "").toString().toLowerCase().trim();
    const title = (body?.title || "").toString().trim();
    const message = (body?.message || body?.body || "").toString().trim();

    if (!country || !["sk", "cz", "pl", "cs"].includes(country)) {
      return NextResponse.json(
        { ok: false, error: "Neplatná krajina. Použi sk/cz/pl." },
        { status: 400 },
      );
    }
    if (!title && !message) {
      return NextResponse.json(
        { ok: false, error: "Chýba titul aj text správy." },
        { status: 400 },
      );
    }

    // Voliteľný deep-link cieľ — po tapnutí hodí užívateľa do zaradenia/produktu
    // (rovnaké kľúče ako strážny pes). Ak nič nezadáš, notifikácia len otvorí appku.
    const data: Record<string, string> = { country: normalizeCountry(country) };
    for (const k of ["category", "subcategory", "placement", "product", "shop"]) {
      const v = body?.[k];
      if (v !== undefined && v !== null && v.toString().trim() !== "") {
        data[k] = v.toString();
      }
    }

    const topic = `deals_${normalizeCountry(country)}`;
    const messaging = getMessaging(getAdminApp());
    const id = await messaging.send({
      topic,
      notification: { title, body: message },
      data,
      android: {
        priority: "high",
        notification: { channelId: "watchdog_alerts", sound: "default" },
      },
      apns: {
        payload: { aps: { sound: "default", badge: 1 } },
      },
    });

    return NextResponse.json({ ok: true, topic, id });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Neznáma chyba";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
