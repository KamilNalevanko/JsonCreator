import { NextResponse } from "next/server";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Prehľad appky — čísla z troch zdrojov na jednom mieste, spojené podľa dátumu.
//
//   GA4        → aktívni a noví používatelia (kto appku reálne používa)
//   Appodeal   → impresie, príjem, eCPM, CTR (čo zarábajú reklamy)
//   Play       → inštalácie a odinštalovania (zatiaľ chýba, viď nižšie)
//
// Zdroje sa NEZLUČUJÚ do jedného čísla — merajú rôzne veci a nič ich na úrovni
// používateľa nespája. Spájajú sa len podľa dňa, aby sa dali porovnať vedľa
// seba a dopočítať ARPDAU (príjem na denného používateľa).
// ---------------------------------------------------------------------------

const GA4_PROPERTY_ID = "549702626";

type Day = {
  date: string;
  activeUsers: number;
  newUsers: number;
  /** Vracajúci sa = aktívni mínus noví. GA4 tie dve skupiny definuje tak,
   *  že sa nekryjú, takže sa to dá odčítať. */
  returningUsers: number;
  /** Priemerný čas v appke na jedného aktívneho používateľa, v sekundách. */
  avgSeconds: number;
  impressions: number;
  revenue: number;
  ecpm: number;
  ctr: number;
  arpdau: number | null;
};

const b64url = (value: unknown) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString(
    "base64url",
  );

/** Prístupový token pre Google API zo servisného účtu (Firebase Admin SDK). */
async function googleToken(scope: string): Promise<string | null> {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  let sa: { client_email: string; private_key: string };
  try {
    sa = JSON.parse(raw);
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    `${b64url({ alg: "RS256", typ: "JWT" })}.` +
    b64url({
      iss: sa.client_email,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .sign(sa.private_key)
    .toString("base64url");

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    const data = await res.json();
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

/** Aktívni a noví používatelia po dňoch. */
type Ga4Row = { activeUsers: number; newUsers: number; engagementSeconds: number };

async function loadGa4(from: string, to: string, warnings: string[]) {
  const token = await googleToken(
    "https://www.googleapis.com/auth/analytics.readonly",
  );
  if (!token) {
    warnings.push("GA4: chýba alebo je neplatný servisný účet.");
    return new Map<string, Ga4Row>();
  }

  try {
    const res = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          dateRanges: [{ startDate: from, endDate: to }],
          dimensions: [{ name: "date" }],
          metrics: [
            { name: "activeUsers" },
            { name: "newUsers" },
            // Celkový čas strávený v appke za deň — vydelený aktívnymi dá
            // priemer na jedného človeka.
            { name: "userEngagementDuration" },
          ],
          orderBys: [{ dimension: { dimensionName: "date" } }],
        }),
      },
    );
    const data = await res.json();
    if (data.error) {
      warnings.push(`GA4: ${data.error.message}`);
      return new Map<string, Ga4Row>();
    }
    const out = new Map<string, Ga4Row>();
    for (const row of data.rows ?? []) {
      // GA4 vracia dátum ako „20260916" — prepíšeme na „2026-09-16".
      const raw = row.dimensionValues[0].value as string;
      const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
      out.set(date, {
        activeUsers: Number(row.metricValues[0].value) || 0,
        newUsers: Number(row.metricValues[1].value) || 0,
        engagementSeconds: Number(row.metricValues[2].value) || 0,
      });
    }
    return out;
  } catch (e) {
    warnings.push(`GA4: ${e instanceof Error ? e.message : "chyba"}`);
    return new Map<string, Ga4Row>();
  }
}

/** Štatistiky reklám. Appodeal pracuje na úlohy — požiadavka, čakanie, výsledok. */
async function loadAppodeal(from: string, to: string, warnings: string[]) {
  const key = process.env.APPODEAL_API_KEY;
  const user = process.env.APPODEAL_USER_ID;
  const empty = new Map<
    string,
    { impressions: number; revenue: number; ecpm: number; ctr: number }
  >();
  if (!key || !user) {
    warnings.push("Appodeal: chýba API kľúč alebo user ID.");
    return empty;
  }

  const base = "https://api-services.appodeal.com/api/v2";
  const auth = `api_key=${encodeURIComponent(key)}&user_id=${encodeURIComponent(user)}`;

  try {
    const params = new URLSearchParams({ date_from: from, date_to: to });
    params.append("detalisation[]", "date");
    const started = await (
      await fetch(`${base}/stats_api?${auth}&${params}`)
    ).json();
    if (!started.task_id) {
      warnings.push(`Appodeal: ${started.message ?? "úlohu sa nepodarilo zadať"}`);
      return empty;
    }

    // Čakáme na spracovanie. `task_status` 1 znamená hotovo.
    let ready = false;
    for (let i = 0; i < 15; i++) {
      const status = await (
        await fetch(`${base}/check_status?${auth}&task_id=${started.task_id}`)
      ).json();
      if (String(status.task_status) === "1") {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!ready) {
      warnings.push("Appodeal: štatistiky sa nestihli pripraviť.");
      return empty;
    }

    const result = await (
      await fetch(`${base}/output_result?${auth}&task_id=${started.task_id}`)
    ).json();
    for (const row of result.data ?? []) {
      empty.set(String(row.date), {
        impressions: Number(row.impressions) || 0,
        revenue: Number(row.revenue) || 0,
        ecpm: Number(row.ecpm) || 0,
        ctr: Number(row.ctr) || 0,
      });
    }
    return empty;
  } catch (e) {
    warnings.push(`Appodeal: ${e instanceof Error ? e.message : "chyba"}`);
    return empty;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  // Dátum bez času a v miestnom čase. `toISOString()` prepína do UTC a pri
  // večerných hodinách by posunul deň — z 14.–16. potom vyšli 4 dni.
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  const atMidnight = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const isDate = (v: string | null): v is string =>
    !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

  // Buď vlastné obdobie (od–do), alebo počet dní dozadu.
  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");

  let from: Date;
  let to: Date;

  if (isDate(rawFrom) && isDate(rawTo)) {
    const parse = (v: string) => {
      const [y, m, d] = v.split("-").map(Number);
      return new Date(y, m - 1, d);
    };
    from = parse(rawFrom);
    to = parse(rawTo);
    if (from > to) [from, to] = [to, from];
    // Dnešok ešte nie je uzavretý — GA4 by zaň vrátila neúplné čísla.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (to > yesterday) to = yesterday;
    // Strop na rok, nech to Appodealu netrvá večnosť.
    const maxSpan = 365 * 24 * 3600 * 1000;
    if (to.getTime() - from.getTime() > maxSpan) {
      from = new Date(to.getTime() - maxSpan);
    }
  } else {
    const span = Math.min(Math.max(Number(searchParams.get("days")) || 28, 7), 90);
    to = new Date();
    to.setDate(to.getDate() - 1);
    from = new Date(to);
    from.setDate(from.getDate() - span + 1);
  }

  from = atMidnight(from);
  to = atMidnight(to);
  const days =
    Math.round((to.getTime() - from.getTime()) / (24 * 3600 * 1000)) + 1;

  const warnings: string[] = [];
  const [ga4, ads] = await Promise.all([
    loadGa4(iso(from), iso(to), warnings),
    loadAppodeal(iso(from), iso(to), warnings),
  ]);

  // Play inštalácie sa neťahajú cez API — Google ich dáva ako mesačné CSV do
  // svojho úložiska a prístup k nemu sa po pridaní práva prepína s oneskorením.
  warnings.push("Play: inštalácie a odinštalovania zatiaľ nie sú napojené.");

  const dayList: Day[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    const date = iso(d);
    const g = ga4.get(date) ?? { activeUsers: 0, newUsers: 0, engagementSeconds: 0 };
    const a = ads.get(date) ?? { impressions: 0, revenue: 0, ecpm: 0, ctr: 0 };
    dayList.push({
      date,
      activeUsers: g.activeUsers,
      newUsers: g.newUsers,
      returningUsers: Math.max(0, g.activeUsers - g.newUsers),
      avgSeconds: g.activeUsers > 0 ? g.engagementSeconds / g.activeUsers : 0,
      ...a,
      // Príjem na denného aktívneho používateľa — jediné číslo, ktoré spája
      // Appodeal s GA4. Bez aktívnych používateľov nemá zmysel.
      arpdau: g.activeUsers > 0 ? a.revenue / g.activeUsers : null,
    });
  }

  const sum = (pick: (d: Day) => number) =>
    dayList.reduce((acc, d) => acc + pick(d), 0);

  return NextResponse.json({
    ok: true,
    from: iso(from),
    to: iso(to),
    days: dayList,
    totals: {
      newUsers: sum((d) => d.newUsers),
      impressions: sum((d) => d.impressions),
      revenue: sum((d) => d.revenue),
      // Priemer aktívnych, nie súčet — sčítať denných aktívnych nedáva zmysel,
      // ten istý človek sa počíta každý deň znova.
      avgActiveUsers: Math.round(sum((d) => d.activeUsers) / dayList.length),
      returningUsers: sum((d) => d.returningUsers),
      // Vážený priemer — dni s viac ľuďmi majú väčšiu váhu, inak by jeden
      // slabý deň s jedným dlho sediacim človekom pokrivil celé číslo.
      avgSeconds:
        sum((d) => d.avgSeconds * d.activeUsers) /
        Math.max(1, sum((d) => d.activeUsers)),
    },
    warnings,
  });
}
