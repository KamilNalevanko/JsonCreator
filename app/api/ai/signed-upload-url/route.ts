import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { fileName } = await req.json();
    if (!fileName || typeof fileName !== "string") {
      return Response.json({ error: "Missing fileName." }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRole) {
      return Response.json({ error: "Missing SUPABASE env." }, { status: 500 });
    }

    const sb = createClient(supabaseUrl, serviceRole);
    const storagePath = `temp/ai-pdf-${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    const { data, error } = await sb.storage
      .from("cap-data")
      .createSignedUploadUrl(storagePath);

    if (error || !data) {
      return Response.json(
        { error: `Failed to create upload URL: ${error?.message || "unknown"}` },
        { status: 500 }
      );
    }

    return Response.json({
      signedUrl: data.signedUrl,
      path: data.path,
      token: data.token,
      storagePath,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
