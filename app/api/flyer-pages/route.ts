import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Nahratie letáka na PREZERANIE v appke.
//
// PDF z tlačiarne má často ~100 MB (300 DPI, CMYK) — to sa na mobil sťahovať
// nedá. Preto tu PDF rozrežeme na JEDNOTLIVÉ STRANY ako JPEG v mobilnom
// rozlíšení (~1200 px), takže jedna strana má ~300 KB a appka sťahuje len tie
// strany, ktoré si používateľ naozaj pozrie.
//
// Uloženie (bucket cap-data, ten istý ako letákové JSON-y):
//   letaky/{krajina}/{obchod}/{flyerId}/p1.jpg, p2.jpg, ...
//   letaky/{krajina}/{obchod}/index.json   ← čo má appka zobraziť
//
// Endpoint je ÚPLNE oddelený od AI spracovania letáka — nič v ňom nemení.
// ---------------------------------------------------------------------------

export const maxDuration = 300;

const BUCKET = "cap-data";
// Šírka strany v pixeloch pre mobil. 1200 px = ostré aj po priblížení, ale
// stále ~300 KB na stranu.
const TARGET_WIDTH = 1200;
const JPEG_QUALITY = 72;

const sanitize = (v: string) =>
  (v || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");

export async function POST(req: Request) {
  try {
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRole) {
      return NextResponse.json(
        { ok: false, error: "Chýba SUPABASE konfigurácia." },
        { status: 500 },
      );
    }

    const form = await req.formData();
    const file = form.get("file");
    const country = sanitize((form.get("country") || "").toString());
    const shop = sanitize((form.get("shop") || "").toString());
    const dateFrom = (form.get("date_from") || "").toString().trim();
    const dateTo = (form.get("date_to") || "").toString().trim();

    if (!(file instanceof Blob)) {
      return NextResponse.json(
        { ok: false, error: "Chýba PDF súbor." },
        { status: 400 },
      );
    }
    if (!country || !["sk", "cz", "pl"].includes(country)) {
      return NextResponse.json(
        { ok: false, error: "Neplatná krajina (sk/cz/pl)." },
        { status: 400 },
      );
    }
    if (!shop) {
      return NextResponse.json(
        { ok: false, error: "Chýba obchod." },
        { status: 400 },
      );
    }

    const buffer = new Uint8Array(await file.arrayBuffer());
    const mupdf = (await import("mupdf")).default;
    const doc = mupdf.Document.openDocument(buffer, "application/pdf");
    const pageCount = doc.countPages();
    if (!pageCount) {
      return NextResponse.json(
        { ok: false, error: "PDF nemá žiadne strany." },
        { status: 400 },
      );
    }

    const sb = createClient(supabaseUrl, serviceRole);
    const base = `letaky/${country}/${shop}`;
    const flyerId = `${Date.now()}`;

    // Vyrenderuj a nahraj stranu po strane (nedržíme celé PDF v pamäti naraz).
    const uploaded: string[] = [];
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      const bounds = page.getBounds();
      const widthPt = Math.abs(bounds[2] - bounds[0]) || 595;
      const scale = TARGET_WIDTH / widthPt;
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false, // bez alfa (JPEG)
        true, // aj anotácie
      );
      const jpeg = pixmap.asJPEG(JPEG_QUALITY, false);
      pixmap.destroy();

      const path = `${base}/${flyerId}/p${i + 1}.jpg`;
      const up = await sb.storage.from(BUCKET).upload(path, jpeg, {
        contentType: "image/jpeg",
        upsert: true,
      });
      if (up.error) {
        return NextResponse.json(
          { ok: false, error: `Strana ${i + 1}: ${up.error.message}` },
          { status: 500 },
        );
      }
      uploaded.push(path);
    }

    // Zisti predošlý leták, nech ho po úspešnom nahratí vieme upratať.
    let previousId = "";
    try {
      const old = await sb.storage.from(BUCKET).download(`${base}/index.json`);
      if (old.data) {
        previousId = (JSON.parse(await old.data.text())?.flyerId || "").toString();
      }
    } catch {
      /* prvý leták pre tento obchod */
    }

    // Index — appka číta tento drobný súbor a podľa neho vie, čo zobraziť.
    const index = {
      flyerId,
      pages: pageCount,
      width: TARGET_WIDTH,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      uploadedAt: new Date().toISOString(),
    };
    const idx = await sb.storage
      .from(BUCKET)
      .upload(`${base}/index.json`, JSON.stringify(index, null, 2), {
        contentType: "application/json",
        upsert: true,
        cacheControl: "0",
      });
    if (idx.error) {
      return NextResponse.json(
        { ok: false, error: `Index: ${idx.error.message}` },
        { status: 500 },
      );
    }

    // Starý leták zmaž až TERAZ — kým sa nový nenahral celý, nechávame ho tam,
    // aby appka nikdy neostala bez letáka.
    let removed = 0;
    if (previousId && previousId !== flyerId) {
      const list = await sb.storage.from(BUCKET).list(`${base}/${previousId}`, {
        limit: 1000,
      });
      const paths = (list.data ?? []).map(
        (f) => `${base}/${previousId}/${f.name}`,
      );
      if (paths.length) {
        await sb.storage.from(BUCKET).remove(paths);
        removed = paths.length;
      }
    }

    return NextResponse.json({
      ok: true,
      flyerId,
      pages: pageCount,
      uploaded: uploaded.length,
      removedOldPages: removed,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Neznáma chyba";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
