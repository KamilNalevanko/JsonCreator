import { NextResponse } from "next/server";
import { BUCKET, getSupabase, slugify } from "../_store";

// Nahranie fotky receptu. Prehliadač ju už zmenší a pošle ako JPEG data URL.
// POST { name, dataUrl } → { path: "recepty/img/<názov>-<čas>.jpg" }

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const dataUrl = (body?.dataUrl || "").toString();
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl);
    if (!m) {
      return NextResponse.json({ ok: false, error: "Neplatný obrázok." }, { status: 400 });
    }
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 3 * 1024 * 1024) {
      return NextResponse.json({ ok: false, error: "Obrázok je príliš veľký." }, { status: 400 });
    }
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const path = `recepty/img/${slugify(body?.name || "recept")}-${Date.now()}.${ext}`;
    const { error } = await getSupabase()
      .storage.from(BUCKET)
      .upload(path, buf, {
        contentType: `image/${m[1]}`,
        upsert: true,
        cacheControl: "31536000",
      });
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, path });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
