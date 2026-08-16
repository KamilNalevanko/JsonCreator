// ===========================================================================
// Edge Function: watchdog-push
// Personalizovaný strážny pes — pošle push aj keď je appka vypnutá.
// Beží denne (pg_cron). Prejde subscriptions, porovná sledované produkty s
// aktívnymi akciami v master_products_v2 a pošle každému jeho zhody (bez
// opakovania cez watchdog_push_log).
//
// Secrets (Supabase → Edge Functions → watchdog-push → Secrets):
//   FIREBASE_SERVICE_ACCOUNT = celý JSON service account kľúča
//   (SUPABASE_URL a SUPABASE_SERVICE_ROLE_KEY sú dostupné automaticky)
//
// Deploy:  supabase functions deploy watchdog-push --no-verify-jwt
// ===========================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FIREBASE_SA = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT")!);

const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

function currency(country: string): string {
  return country === "cs" ? "Kč" : country === "pl" ? "zł" : "€";
}

function parseDMY(s?: string | null): number | null {
  if (!s) return null;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s.trim());
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
}

function isActive(from?: string | null, to?: string | null): boolean {
  const f = parseDMY(from);
  const t = parseDMY(to);
  if (f === null || t === null) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return today >= f && today <= t;
}

// ---- FCM v1: OAuth access token zo service account (RS256 JWT) --------------
let cachedToken: { token: string; exp: number } | null = null;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.exp - 60_000) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) =>
    b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned =
    `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
      iss: FIREBASE_SA.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })}`;
  const key = await importPrivateKey(FIREBASE_SA.private_key);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const j = await res.json();
  cachedToken = {
    token: j.access_token,
    exp: Date.now() + (j.expires_in ?? 3600) * 1000,
  };
  return cachedToken.token;
}

// Vráti { ok, dead } — dead=true znamená neplatný token (odinštalovaná appka /
// rotovaný token), takže volajúci ho z DB zmaže, nech sa tabuľka nezasviní.
async function sendFcm(
  token: string,
  title: string,
  body: string,
  data: Record<string, string>,
): Promise<{ ok: boolean; dead: boolean }> {
  const at = await getAccessToken();
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${FIREBASE_SA.project_id}/messages:send`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${at}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data,
          android: {
            priority: "HIGH",
            notification: { channel_id: "watchdog_alerts", sound: "default" },
          },
          apns: { payload: { aps: { sound: "default", badge: 1 } } },
        },
      }),
    },
  );
  if (res.ok) return { ok: true, dead: false };
  let dead = false;
  try {
    const j = await res.json();
    const status = j?.error?.status;
    const codes = (j?.error?.details ?? [])
      .map((d: { errorCode?: string }) => d?.errorCode)
      .filter(Boolean);
    if (res.status === 404 || status === "NOT_FOUND" ||
        codes.includes("UNREGISTERED")) {
      dead = true;
    }
  } catch (_) { /* ignore */ }
  return { ok: false, dead };
}

// deno-lint-ignore no-explicit-any
Deno.serve(async () => {
  try {
    const { data: subs } = await sb
      .from("watchdog_subscriptions")
      .select("token,country,watches");
    if (!subs || subs.length === 0) {
      return Response.json({ ok: true, sent: 0 });
    }

    // Načítaj aktívne akcie raz na krajinu.
    const countries = [...new Set(subs.map((s) => s.country))];
    const promosByCountry: Record<string, any[]> = {};
    for (const c of countries) {
      const { data: rows } = await sb
        .from("master_products_v2")
        .select(
          "name,name_key,shop,category,subcategory,placement,date_from,date_to,price_sale,price_sale_unit,unit",
        )
        .eq("country", c);
      promosByCountry[c] = (rows ?? []).filter((r) =>
        isActive(r.date_from, r.date_to)
      );
    }

    // Uprac starý log, nech watchdog_push_log nerastie donekonečna.
    const cutoff = new Date(Date.now() - 60 * 864e5).toISOString();
    await sb.from("watchdog_push_log").delete().lt("sent_at", cutoff);

    let sent = 0;
    const deadTokens = new Set<string>();
    for (const sub of subs) {
      const rows = promosByCountry[sub.country] ?? [];
      const watches = Array.isArray(sub.watches) ? sub.watches : [];
      outer:
      for (const w of watches) {
        const matches = rows.filter((r) => {
          if (w.type === "product") {
            if (r.name_key !== w.productNameKey) return false;
          } else {
            if (r.placement !== w.placementKey) return false;
          }
          if (
            Array.isArray(w.shops) && w.shops.length > 0 &&
            !w.shops.includes(r.shop)
          ) {
            return false;
          }
          return true;
        });

        for (const r of matches) {
          const signature =
            `${w.productNameKey ?? w.placementKey}|${r.name_key}|${r.shop}|${r.date_from}|${r.date_to}`;
          // Dedupe: zaloguj PRED odoslaním (PK konflikt = už poslané → preskoč).
          const { error: logErr } = await sb
            .from("watchdog_push_log")
            .insert({ token: sub.token, signature });
          if (logErr) continue;

          const cur = currency(sub.country);
          const priceLine = r.price_sale
            ? ` — ${r.price_sale} ${cur}${
              r.price_sale_unit
                ? ` (${r.price_sale_unit} ${cur}${r.unit ? "/" + r.unit : ""})`
                : ""
            }`
            : "";
          const resp = await sendFcm(
            sub.token,
            "Strážny pes: nová akcia",
            `${r.name} v akcii v ${r.shop}${priceLine}`,
            {
              country: sub.country,
              category: r.category ?? "",
              subcategory: r.subcategory ?? "",
              placement: r.placement ?? "",
              product: r.name ?? "",
              shop: r.shop ?? "",
            },
          );
          if (resp.ok) {
            sent++;
          } else if (resp.dead) {
            // Neplatný token (odinštalovaná appka) → zmaž ho, netreba ďalej skúšať.
            deadTokens.add(sub.token);
            break outer;
          }
        }
      }
    }

    // Zmaž mŕtve tokeny (odinštalované appky / rotované tokeny) aj ich log —
    // aby sa tabuľky nezasvinili neaktívnymi zariadeniami.
    for (const t of deadTokens) {
      await sb.from("watchdog_subscriptions").delete().eq("token", t);
      await sb.from("watchdog_push_log").delete().eq("token", t);
    }

    return Response.json({ ok: true, sent, cleaned: deadTokens.size });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
