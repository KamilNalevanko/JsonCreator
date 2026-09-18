// ---------------------------------------------------------------------------
// Automatické upratovanie letákov v Cloudflare R2.
//
// Beží ako Cloudflare Worker s časovačom (cron) — bez servera, bez kľúčov:
// k bucketu sa dostane cez „binding" BUCKET, takže tu nie je žiadne heslo ani
// prístupový kľúč. Robí to isté, čo tlačidlo „Upratať staré letáky" v editore:
//
//   1. zmaže letáky staršie ako MAX_AGE_DAYS,
//   2. zmaže letáky, ktorým skončila platnosť (platné a budúce nechá všetky),
//   3. zmaže „siroty" — strany, ktoré už v index.json nie sú.
//
// Najnovší leták obchodu sa nezmaže nikdy, aby obchod neostal prázdny.
//
// Ručné spustenie na overenie: GET https://<worker>/?dry=1 (len vypíše, čo by
// zmazal), bez `dry` maže naozaj.
// ---------------------------------------------------------------------------

const MAX_AGE_DAYS = 35;
const COUNTRIES = ["sk", "cz", "pl"];

/** Dnešok v slovenskom čase. Worker beží v UTC a appka je pre SK/CZ/PL —
 *  bez toho by sa „dnes" prehupol o polnoci UTC, nie o polnoci u nás. */
function todayLocal() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Bratislava" }).format(
    new Date(),
  );
}

/** Leták, ktorému skončila platnosť akcie — appka ho aj tak nezobrazuje. */
function isExpired(entry) {
  if (!entry.dateTo) return false;
  return entry.dateTo < todayLocal();
}

function ageInDays(entry) {
  const stamp = Date.parse(entry.uploadedAt || "");
  const ms = Number.isNaN(stamp) ? Number(entry.id) : stamp;
  if (!ms || Number.isNaN(ms)) return 0;
  return (Date.now() - ms) / 86400000;
}

async function listKeys(bucket, prefix) {
  const keys = [];
  let cursor;
  do {
    const res = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of res.objects) keys.push(o.key);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return keys;
}

async function cleanup(env, dryRun) {
  const bucket = env.BUCKET;
  const detail = [];
  let removedFiles = 0;

  for (const country of COUNTRIES) {
    const allCountryKeys = await listKeys(bucket, `letaky/${country}/`);
    const shops = new Set();
    for (const key of allCountryKeys) {
      const parts = key.split("/");
      if (parts.length >= 3 && parts[2]) shops.add(parts[2]);
    }

    for (const shop of shops) {
      const base = `letaky/${country}/${shop}`;
      const idxObj = await bucket.get(`${base}/index.json`);
      if (!idxObj) continue;

      let flyers = [];
      let width;
      try {
        const parsed = JSON.parse(await idxObj.text());
        if (Array.isArray(parsed.flyers)) flyers = parsed.flyers;
        if (typeof parsed.width === "number") width = parsed.width;
      } catch {
        continue;
      }
      if (!flyers.length) continue;

      const sorted = [...flyers].sort((a, b) => ageInDays(a) - ageInDays(b));
      // Rozhoduje PLATNOSŤ, nie poradie ani vek nahratia. Predtým sa brali
      // prvé tri podľa nahratia, lenže letáky sa nahrávajú dopredu a
      // „najstarší nahratý" býva práve ten platný — tak zmizol z Lidl CZ
      // leták 17.–20. 9. Vek rozhoduje len pri starých letákoch bez dátumu.
      const shouldKeep = (f) =>
        f.dateTo ? !isExpired(f) : ageInDays(f) <= MAX_AGE_DAYS;
      let keep = sorted.filter(shouldKeep);
      // Keď už nič neplatí, najnovší ostane, nech obchod nie je prázdny.
      if (keep.length === 0 && sorted.length > 0) keep = [sorted[0]];
      const keepIds = new Set(keep.map((f) => f.id));
      const dropped = sorted.filter((f) => !keepIds.has(f.id));

      const shopKeys = allCountryKeys.filter((k) => k.startsWith(`${base}/`));
      const orphans = new Set();
      for (const key of shopKeys) {
        const folder = key.slice(base.length + 1).split("/")[0];
        if (!folder || folder === "index.json") continue;
        if (!keepIds.has(folder) && !flyers.some((f) => f.id === folder)) {
          orphans.add(folder);
        }
      }

      // Letáky zapísané v indexe, ktorých strany už na úložisku nie sú
      // (napr. zmazané ručne) — inak appka ukáže prázdnu kartu.
      const ghostIds = keep
        .filter((f) => !shopKeys.some((k) => k.startsWith(`${base}/${f.id}/`)))
        .map((f) => f.id);
      const finalKeep = keep.filter((f) => !ghostIds.includes(f.id));

      const toDelete = [...dropped.map((f) => f.id), ...orphans];
      if (!toDelete.length && !ghostIds.length) continue;

      let files = 0;
      for (const id of toDelete) {
        const paths = shopKeys.filter((k) => k.startsWith(`${base}/${id}/`));
        files += paths.length;
        if (!dryRun) {
          // R2 zmaže naraz max 1000 kľúčov.
          for (let i = 0; i < paths.length; i += 1000) {
            await bucket.delete(paths.slice(i, i + 1000));
          }
        }
      }

      if (!dryRun && (dropped.length || ghostIds.length)) {
        await bucket.put(
          `${base}/index.json`,
          JSON.stringify({ flyers: finalKeep, width }, null, 2),
          { httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=300" } },
        );
      }

      removedFiles += files;
      detail.push({
        shop: `${country}/${shop}`,
        removedFlyers: [...toDelete, ...ghostIds],
        removedFiles: files,
      });
    }
  }

  return { dryRun, shopsTouched: detail.length, removedFiles, detail };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      cleanup(env, false).then((r) =>
        console.log("upratovanie letakov:", JSON.stringify(r)),
      ),
    );
  },

  async fetch(request, env) {
    const dry = new URL(request.url).searchParams.get("dry") === "1";
    const result = await cleanup(env, dry);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
};
