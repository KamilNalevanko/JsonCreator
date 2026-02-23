import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

type IndexState = {
  next: number;
  isFull: boolean;
};

const clampIndex = (value: number) => {
  if (!Number.isFinite(value)) return 1;
  if (value < 1) return 1;
  return value;
};

const sanitizeBase = (value: string) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "letak";

const defaultIndex: IndexState = { next: 1, isFull: false };

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getExistingState = async (
  supabase: SupabaseClient<any>,
  basePath: string,
  fileBase: string
) => {
  const listRes = await supabase.storage.from("cap-data").list(basePath, {
    limit: 1000,
  });

  if (listRes.error || !listRes.data) {
    return {
      ok: false,
      state: { ...defaultIndex },
      hasBase: false,
      hasSlotOne: false,
    } as const;
  }

  const baseName = `${fileBase}.json`;
  const slotRegex = new RegExp(`^${escapeRegExp(fileBase)}_(\\d{1,2})\\.json$`);

  let maxIndex = 0;
  let hasBase = false;
  let hasSlotOne = false;

  for (const item of listRes.data) {
    const name = item?.name;
    if (!name) continue;
    if (name === baseName) {
      hasBase = true;
      continue;
    }
    const match = name.match(slotRegex);
    if (!match) continue;
    const idx = Number(match[1]);
    if (!Number.isFinite(idx)) continue;
    if (idx === 1) hasSlotOne = true;
    if (idx > maxIndex) maxIndex = idx;
  }

  let maxSlot = maxIndex;
  if (hasBase && maxSlot < 1) {
    maxSlot = 1;
  }

  const state: IndexState = {
    next: maxSlot >= 1 ? maxSlot + 1 : 1,
    isFull: maxSlot >= 10,
  };

  return { ok: true, state, hasBase, hasSlotOne } as const;
};

const readIndex = async (
  supabase: SupabaseClient<any>,
  indexPath: string
): Promise<{ found: boolean; state: IndexState }> => {
  const dl = await supabase.storage.from("cap-data").download(indexPath);
  if (dl.error || !dl.data) {
    return { found: false, state: { ...defaultIndex } };
  }
  try {
    const text = await dl.data.text();
    const parsed = JSON.parse(text) as Partial<IndexState>;
    const next = clampIndex(Number(parsed?.next ?? 1));
    const isFull = Boolean(parsed?.isFull);
    return { found: true, state: { next, isFull } };
  } catch {
    return { found: false, state: { ...defaultIndex } };
  }
};

const writeIndex = async (
  supabase: SupabaseClient<any>,
  indexPath: string,
  state: IndexState
) => {
  const payload = JSON.stringify(state, null, 2);
  return supabase.storage.from("cap-data").upload(indexPath, payload, {
    contentType: "application/json",
    upsert: true,
    cacheControl: "0",
  });
};

const uploadQueue = new Map<string, Promise<void>>();

const withUploadLock = async <T>(
  key: string,
  work: () => Promise<T>
): Promise<T> => {
  const prior = uploadQueue.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  uploadQueue.set(key, prior.then(() => gate));
  await prior;
  try {
    return await work();
  } finally {
    release();
    if (uploadQueue.get(key) === gate) {
      uploadQueue.delete(key);
    }
  }
};

const rotateFiles = async (
  supabase: SupabaseClient<any>,
  basePath: string,
  fileBase: string
) => {
  const removePaths = Array.from({ length: 5 }, (_, idx) =>
    `${basePath}/${fileBase}_${idx + 1}.json`
  );
  const removeRes = await supabase.storage.from("cap-data").remove(removePaths);
  if (removeRes.error) {
    return {
      ok: false,
      error: `Failed to remove old files: ${removeRes.error.message}`,
    } as const;
  }

  for (let i = 6; i <= 10; i += 1) {
    const from = `${basePath}/${fileBase}_${i}.json`;
    const to = `${basePath}/${fileBase}_${i - 5}.json`;
    const moveRes = await supabase.storage.from("cap-data").move(from, to);
    if (moveRes.error) {
      return {
        ok: false,
        error: `Failed to move ${from} -> ${to}: ${moveRes.error.message}`,
      } as const;
    }
  }

  return { ok: true } as const;
};

export async function POST(req: Request) {
  try {
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRole) {
      return NextResponse.json(
        { ok: false, error: "Missing SUPABASE env (URL or SERVICE_ROLE_KEY)." },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const country = (body?.country || "").toString().toLowerCase().trim();
    const shop = (body?.shop || "").toString().trim();
    const payload = body?.payload;

    if (!country || !["sk", "cz", "pl"].includes(country)) {
      return NextResponse.json(
        { ok: false, error: "Invalid country. Use sk/cz/pl." },
        { status: 400 }
      );
    }

    if (!shop) {
      return NextResponse.json(
        { ok: false, error: "Missing shop." },
        { status: 400 }
      );
    }

    const content =
      typeof payload === "string" ? payload : JSON.stringify(payload ?? {});

    if (!content || content.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: "Missing JSON payload." },
        { status: 400 }
      );
    }

    const fileBase = sanitizeBase(shop);
    const basePath = `data/${country}`;
    const indexPath = `${basePath}/_indexes/${fileBase}.json`;

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    return await withUploadLock(`${basePath}/${fileBase}`, async () => {
      const existing = await getExistingState(supabase, basePath, fileBase);

      if (existing.ok && existing.hasBase && !existing.hasSlotOne) {
        const from = `${basePath}/${fileBase}.json`;
        const to = `${basePath}/${fileBase}_1.json`;
        const moveRes = await supabase.storage.from("cap-data").move(from, to);
        if (!moveRes.error) {
          existing.state.next = Math.max(existing.state.next, 2);
        }
      }

      const { found, state: storedIndex } = await readIndex(
        supabase,
        indexPath
      );
      let indexState = found ? storedIndex : existing.state;

      if (existing.ok) {
        if (
          existing.state.next < indexState.next ||
          existing.state.isFull !== indexState.isFull
        ) {
          indexState = existing.state;
        }
      }

      if (indexState.next > 10 && indexState.isFull) {
        const rotate = await rotateFiles(supabase, basePath, fileBase);
        if (!rotate.ok) {
          return NextResponse.json(
            { ok: false, error: rotate.error },
            { status: 500 }
          );
        }
        indexState = { next: 6, isFull: true };
      } else if (indexState.next > 10) {
        indexState = { next: 1, isFull: false };
      }

      const slot = clampIndex(indexState.next);
      const targetPath = `${basePath}/${fileBase}_${slot}.json`;

      const uploadRes = await supabase.storage
        .from("cap-data")
        .upload(targetPath, content, {
          contentType: "application/json",
          upsert: true,
          cacheControl: "0",
        });

      if (uploadRes.error) {
        return NextResponse.json(
          { ok: false, error: uploadRes.error.message, path: targetPath },
          { status: 500 }
        );
      }

      const next = slot + 1;
      const isFull = indexState.isFull || next > 10;
      const nextState: IndexState = { next, isFull };

      const indexRes = await writeIndex(supabase, indexPath, nextState);
      if (indexRes.error) {
        return NextResponse.json(
          { ok: false, error: indexRes.error.message },
          { status: 500 }
        );
      }

      return NextResponse.json({
        ok: true,
        path: targetPath,
        next: nextState.next,
        isFull: nextState.isFull,
      });
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
