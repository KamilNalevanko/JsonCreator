import { NextResponse } from "next/server";
import {
  deleteFlyerObjects,
  listFlyerObjects,
  putFlyerObject,
  readFlyerText,
  usingR2,
} from "../_lib/flyer-storage";

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

// Šírka strany v pixeloch. 1600 px + kvalita 80 znesie poriadne priblíženie
// (drobné popisy pri cenách sú čitateľné) za cenu ~500 KB na stranu. Miesto
// aj prenos rieši Cloudflare R2, kde je prenos dát zadarmo.
const TARGET_WIDTH = 1600;
const JPEG_QUALITY = 80;
// Koľko letákov na obchod držíme (najnovší + staršie).
const MAX_FLYERS_PER_SHOP = 4;

const sanitize = (v: string) =>
  (v || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");

export async function POST(req: Request) {
  try {
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
      try {
        await putFlyerObject(path, Buffer.from(jpeg), "image/jpeg");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
          { ok: false, error: `Strana ${i + 1}: ${msg}` },
          { status: 500 },
        );
      }
      uploaded.push(path);
    }

    // Načítaj doterajší index — držíme DVA letáky: nový a predchádzajúci
    // („nový leták a pod ním aktuálny"). Starší sa zahodí.
    type FlyerEntry = {
      id: string;
      pages: number;
      dateFrom: string | null;
      dateTo: string | null;
      uploadedAt: string;
    };
    let existing: FlyerEntry[] = [];
    try {
      const oldText = await readFlyerText(`${base}/index.json`);
      if (oldText) {
        const parsed = JSON.parse(oldText);
        if (Array.isArray(parsed?.flyers)) {
          existing = parsed.flyers as FlyerEntry[];
        } else if (parsed?.flyerId) {
          // starý formát (jeden leták) — prenesieme ho
          existing = [
            {
              id: String(parsed.flyerId),
              pages: Number(parsed.pages) || 0,
              dateFrom: parsed.dateFrom ?? null,
              dateTo: parsed.dateTo ?? null,
              uploadedAt: parsed.uploadedAt ?? "",
            },
          ];
        }
      }
    } catch {
      /* prvý leták pre tento obchod */
    }

    const flyers: FlyerEntry[] = [
      {
        id: flyerId,
        pages: pageCount,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        uploadedAt: new Date().toISOString(),
      },
      ...existing.filter((f) => f.id !== flyerId),
    ];
    const keep = flyers.slice(0, MAX_FLYERS_PER_SHOP);
    const drop = flyers.slice(MAX_FLYERS_PER_SHOP);

    // Index — appka číta tento drobný súbor a podľa neho vie, čo zobraziť.
    const index = { flyers: keep, width: TARGET_WIDTH };
    try {
      await putFlyerObject(
        `${base}/index.json`,
        JSON.stringify(index, null, 2),
        "application/json",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { ok: false, error: `Index: ${msg}` },
        { status: 500 },
      );
    }

    // Prebytočné letáky zmaž až TERAZ — kým sa nový nenahral celý, staré
    // necháme na mieste, aby appka nikdy neostala bez letáka.
    let removed = 0;
    for (const f of drop) {
      const paths = await listFlyerObjects(`${base}/${f.id}`);
      removed += await deleteFlyerObjects(paths);
    }

    return NextResponse.json({
      ok: true,
      flyerId,
      pages: pageCount,
      uploaded: uploaded.length,
      removedOldPages: removed,
      storage: usingR2 ? "r2" : "supabase",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Neznáma chyba";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
