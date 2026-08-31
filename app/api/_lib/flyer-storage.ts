import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Úložisko letákov. Dve možnosti, prepínajú sa premennými v `.env.local`:
//
//  • Cloudflare R2 (odporúčané) — keď sú vyplnené R2_* premenné. 10 GB zdarma
//    a prenos dát zadarmo, čo je pri listovaní letákov to podstatné.
//  • Supabase Storage — záloha, keď R2 nastavené nie je (pôvodné správanie).
//
// Zvyšok kódu volá `putFlyerObject` / `listFlyerObjects` / `deleteFlyerObjects`
// a nerieši, kde to reálne leží.
// ---------------------------------------------------------------------------

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "cap-letaky";
/** Verejná adresa bucketu, napr. https://pub-xxxx.r2.dev */
export const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

const SUPABASE_BUCKET = "cap-data";

export const usingR2 = Boolean(
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY,
);

let r2: S3Client | null = null;
function getR2(): S3Client {
  if (!r2) {
    r2 = new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return r2;
}

function getSupabase() {
  const url =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) throw new Error("Chýba SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key);
}

/** Nahrá jeden súbor (strana letáka alebo index.json). */
export async function putFlyerObject(
  path: string,
  body: Buffer | string,
  contentType: string,
): Promise<void> {
  const data = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  if (usingR2) {
    await getR2().send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: path,
        Body: data,
        ContentType: contentType,
        // Letáky sa nemenia — nech ich prehliadač aj CDN držia dlho.
        CacheControl: path.endsWith("index.json")
          ? "public, max-age=300"
          : "public, max-age=31536000, immutable",
      }),
    );
    return;
  }
  const { error } = await getSupabase()
    .storage.from(SUPABASE_BUCKET)
    .upload(path, data, { contentType, upsert: true });
  if (error) throw new Error(error.message);
}

/** Vypíše cesty všetkých súborov pod daným prefixom. */
export async function listFlyerObjects(prefix: string): Promise<string[]> {
  if (usingR2) {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await getR2().send(
        new ListObjectsV2Command({
          Bucket: R2_BUCKET,
          Prefix: prefix.endsWith("/") ? prefix : `${prefix}/`,
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
  const { data, error } = await getSupabase()
    .storage.from(SUPABASE_BUCKET)
    .list(prefix, { limit: 1000 });
  if (error) throw new Error(error.message);
  return (data ?? []).map((f) => `${prefix}/${f.name}`);
}

/** Zmaže súbory. Vracia počet zmazaných. */
export async function deleteFlyerObjects(paths: string[]): Promise<number> {
  if (!paths.length) return 0;
  if (usingR2) {
    let deleted = 0;
    // DeleteObjects berie max 1000 kľúčov naraz.
    for (let i = 0; i < paths.length; i += 1000) {
      const chunk = paths.slice(i, i + 1000);
      const res = await getR2().send(
        new DeleteObjectsCommand({
          Bucket: R2_BUCKET,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        }),
      );
      deleted += res.Deleted?.length ?? 0;
    }
    return deleted;
  }
  const { error } = await getSupabase()
    .storage.from(SUPABASE_BUCKET)
    .remove(paths);
  if (error) throw new Error(error.message);
  return paths.length;
}

/** Stiahne textový súbor (index.json). Vracia null, keď neexistuje. */
export async function readFlyerText(path: string): Promise<string | null> {
  if (usingR2) {
    if (!R2_PUBLIC_URL) return null;
    const res = await fetch(`${R2_PUBLIC_URL}/${path}`, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.text();
  }
  const { data, error } = await getSupabase()
    .storage.from(SUPABASE_BUCKET)
    .download(path);
  if (error || !data) return null;
  return await data.text();
}
