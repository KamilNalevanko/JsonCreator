// ===========================================================================
// Edge Function: scheduled-push
// Odošle naplánované notifikácie, ktorých čas (send_at) už nastal.
// Beží každú minútu (pg_cron). Broadcast ide na topic `deals_<krajina>`,
// alebo — ak má riadok token — len na jedno zariadenie (test).
//
// Secrets (Supabase → Edge Functions → scheduled-push → Secrets):
//   FIREBASE_SERVICE_ACCOUNT = celý JSON service account kľúča
//   (SUPABASE_URL a SUPABASE_SERVICE_ROLE_KEY sú dostupné automaticky)
//
// Deploy:  supabase functions deploy scheduled-push --no-verify-jwt
// ===========================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FIREBASE_SA = JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT")!);

const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

function normalizeCountry(country: string): string {
  const c = (country || "").toLowerCase().trim();
  return c === "cz" ? "cs" : c;
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
  if (cachedToken && Date.now() < cachedToken.exp - 60_000) {
    return cachedToken.token;
  }
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

// Pošle jednu správu na topic ALEBO token. Vráti {ok, error?}.
async function sendFcm(
  target: { topic?: string; token?: string },
  title: string,
  body: string,
  data: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
  const at = await getAccessToken();
  const message: Record<string, unknown> = {
    notification: { title, body },
    data,
    android: {
      priority: "HIGH",
      notification: { channel_id: "watchdog_alerts", sound: "default" },
    },
    apns: { payload: { aps: { sound: "default", badge: 1 } } },
  };
  if (target.token) message.token = target.token;
  else message.topic = target.topic;

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${FIREBASE_SA.project_id}/messages:send`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${at}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    },
  );
  if (res.ok) return { ok: true };
  const txt = await res.text().catch(() => "");
  return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 300)}` };
}

// deno-lint-ignore no-explicit-any
Deno.serve(async () => {
  try {
    const nowIso = new Date().toISOString();
    const { data: due, error } = await sb
      .from("scheduled_notifications")
      .select("id,country,title,message,data,token,send_at")
      .eq("sent", false)
      .lte("send_at", nowIso)
      .order("send_at", { ascending: true })
      .limit(50);

    if (error) {
      return Response.json({ ok: false, error: error.message }, { status: 500 });
    }
    if (!due || due.length === 0) {
      return Response.json({ ok: true, sent: 0 });
    }

    let sent = 0;
    for (const row of due) {
      const country = normalizeCountry(row.country);
      const d = (row.data ?? {}) as Record<string, unknown>;
      const data: Record<string, string> = { country };
      for (const k of ["category", "subcategory", "placement", "product", "shop"]) {
        const v = d[k];
        if (v !== undefined && v !== null && String(v).trim() !== "") {
          data[k] = String(v);
        }
      }

      const target = row.token
        ? { token: String(row.token) }
        : { topic: `deals_${country}` };

      const result = await sendFcm(
        target,
        String(row.title ?? ""),
        String(row.message ?? ""),
        data,
      );

      await sb
        .from("scheduled_notifications")
        .update({
          sent: true,
          sent_at: new Date().toISOString(),
          error: result.ok ? null : result.error ?? "send failed",
        })
        .eq("id", row.id);

      if (result.ok) sent++;
    }

    return Response.json({ ok: true, processed: due.length, sent });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
