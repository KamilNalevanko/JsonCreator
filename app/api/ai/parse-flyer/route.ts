import OpenAI from "openai";
import { pathToFileURL } from "url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PAGES = 78;

interface Product {
  name: string;
  amount: string;
  unit: string;
  price_sale: string;
  price_regular: string;
  note: string;
  page?: number;
}

interface ParsedResponse {
  meta?: {
    date_from?: string;
    date_to?: string;
  };
  products?: Product[];
}
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/** Remove internal PDF print/layout identifiers and other noise from extracted text */
function cleanPageText(text: string): string {
  return text
    // Kaufland internal page IDs: e.g. S1-SK-KW10-LFT-TITULKA-1020-11
    .replace(/\bS\d+-SK-[A-Z]{2}\d+-LFT-[A-Z0-9_]+-\d+-\d+\b/g, "")
    // Generic fallback: ALL-CAPS token with 3+ dashes (internal layout codes)
    .replace(/\b[A-Z0-9]{2,}-[A-Z0-9]{2,}-[A-Z0-9]{2,}-[A-Z0-9_]{3,}(?:-[A-Z0-9_]+){2,}\b/g, "")
    // Collapse multiple spaces left by removed tokens
    .replace(/ {2,}/g, " ")
    .trim();
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return Response.json(
        { error: "Chýba OPENAI_API_KEY v prostredí." },
        { status: 500 }
      );
    }

    const form = await req.formData();
    const file = form.get("file");

    if (!file || !(file instanceof File)) {
      return Response.json({ error: "Chýba PDF súbor." }, { status: 400 });
    }

    // Extract text from PDF
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const requireAny = eval("require");

    const buffer = new Uint8Array(await file.arrayBuffer());

    if (pdfjs?.GlobalWorkerOptions) {
      try {
        const workerPath = requireAny.resolve("pdfjs-dist/build/pdf.worker.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).toString();
      } catch {
        pdfjs.GlobalWorkerOptions.workerSrc = "";
      }
      pdfjs.GlobalWorkerOptions.workerPort = null;
    }

    const doc = await pdfjs.getDocument({
      data: buffer,
    }).promise;

    const pages = Math.min(doc.numPages, MAX_PAGES);
    const pageTexts: { text: string; pageNum: number }[] = [];

    // Extract text from each page, sorted by visual reading order (top→bottom, left→right)
    for (let i = 1; i <= pages; i++) {
      try {
        const page = await doc.getPage(i);
        const textContent = await page.getTextContent();

        // Each item has a `transform` matrix: [scaleX, skewX, skewY, scaleY, tx, ty]
        // tx = X position, ty = Y position in PDF units (Y increases upward)
        const LINE_TOLERANCE = 5; // px tolerance to group items into the same line

        interface PdfTextItem {
          str?: string;
          transform?: number[];
        }

        const positioned = (textContent?.items || [] as PdfTextItem[])
          .map((item) => {
            const it = item as PdfTextItem;
            const str = (it?.str || "").toString().trim();
            const tx = it.transform?.[4] ?? 0;
            const ty = it.transform?.[5] ?? 0;
            return { str, tx, ty };
          })
          .filter((it) => it.str.length > 0);

        // Sort: descending Y (top of page first), then ascending X (left to right)
        positioned.sort((a, b) => {
          const yDiff = b.ty - a.ty;
          if (Math.abs(yDiff) > LINE_TOLERANCE) return yDiff;
          return a.tx - b.tx;
        });

        const raw = positioned.map((it) => it.str).join(" ");
        const text = cleanPageText(raw);
        pageTexts.push({ text, pageNum: i });
      } catch (error) {
        console.error(`Chyba pri extrakcii textu zo strany ${i}:`, error);
        pageTexts.push({ text: "", pageNum: i });
      }
    }

    const allPageTexts = pageTexts.filter((p) => p.text.length > 0);

    if (allPageTexts.length === 0) {
      return Response.json(
        { error: "PDF neobsahuje žiadny čitateľný text." },
        { status: 400 }
      );
    }

    const combinedText = allPageTexts.map((p) => `=== STRANA ${p.pageNum} ===\n${p.text}`).join("\n\n---\n\n");
    console.log(`Spracovávam ${pages} strán v dávkach...`);

    // Split pages into batches of 10 to avoid output token limits
    const BATCH_SIZE = 10;
    const batches: { text: string; pageNum: number }[][] = [];
    for (let i = 0; i < allPageTexts.length; i += BATCH_SIZE) {
      batches.push(allPageTexts.slice(i, i + BATCH_SIZE));
    }

    const meta = { date_from: "", date_to: "" };
    const allProducts: Product[] = [];

    const PRODUCT_SCHEMA = `{
  "meta": { "date_from": "DD.MM.YYYY alebo null", "date_to": "DD.MM.YYYY alebo null" },
  "products": [{ "name": "...", "amount": "...", "unit": "g/kg/ml/l/ks/null", "price_sale": "...", "price_regular": "...", "note": "...", "page": N }]
}`;

    const PRODUCT_RULES = `PRAVIDLÁ:
- Extrahovať IBA potraviny a nápoje
- Ignorovať: kvety, dekorácie, čistiace prostriedky, papier, oblečenie, elektroniku, krmivo pre zvieratá, parkside náradie
- name musí byť jasný a konkrétny
- Dátumy v tvare DD.MM.YYYY alebo null
- page: číslo strany z === STRANA N === hlavičky kde bol produkt nájdený`;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batchText = batches[batchIdx].map((p) => `=== STRANA ${p.pageNum} ===\n${p.text}`).join("\n\n---\n\n");
      const isFirst = batchIdx === 0;

      const response = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        max_tokens: 16000,
        messages: [
          {
            role: "user",
            content: `Analyzuj text z PDF letáčka supermarketu (dávka ${batchIdx + 1}/${batches.length}) a extrahuj všetky potraviny a nápoje.

VÝSTUP v JSON:
${PRODUCT_SCHEMA}

${PRODUCT_RULES}
${!isFirst ? '- meta.date_from a meta.date_to môžeš nastaviť na null ak dátumy nie sú v tejto dávke viditeľné' : ''}

TEXT:
${batchText}`,
          },
        ],
      });

      const responseText = response.choices?.[0]?.message?.content?.trim() ?? "";
      if (!responseText) continue;

      let parsed: ParsedResponse = {};
      try {
        parsed = JSON.parse(responseText) as ParsedResponse;
      } catch {
        const start = responseText.indexOf("{");
        const end = responseText.lastIndexOf("}");
        if (start !== -1 && end !== -1 && end > start) {
          try {
            parsed = JSON.parse(responseText.slice(start, end + 1)) as ParsedResponse;
          } catch {
            console.error(`Dávka ${batchIdx + 1}: neplatný JSON, preskakujem`);
            continue;
          }
        }
      }

      // Pick up meta from first batch that has dates
      if (!meta.date_from && parsed.meta?.date_from) {
        meta.date_from = parsed.meta.date_from;
      }
      if (!meta.date_to && parsed.meta?.date_to) {
        meta.date_to = parsed.meta.date_to;
      }

      if (Array.isArray(parsed.products)) {
        allProducts.push(...parsed.products);
      }
    }

    // Deduplicate by name (keep first occurrence)
    const seen = new Set<string>();
    const deduped = allProducts.filter((p) => {
      const key = (p.name || "").toLowerCase().trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const items = deduped.map((item: Product) => ({
      name: item.name || "",
      amount: item.amount || "",
      unit: item.unit || "",
      price_sale: item.price_sale || "",
      price_regular: item.price_regular || "",
      note: item.note || "",
      date_from: meta.date_from,
      date_to: meta.date_to,
      page: item.page ?? null,
    }));

    // Return format expected by handleAiExtract
    const result: Record<string, unknown> = {
      meta,
      items,
    };

    // Add debug text if requested
    if (form.get("debug") === "1") {
      result.debugText = combinedText;
    }

    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Neznáma chyba";
    console.error("Chyba pri spracovaní PDF:", message);
    return Response.json(
      { error: message, success: false },
      { status: 500 }
    );
  }
}

export async function GET() {
  return Response.json({
    message: "PDF Parser API (Text only - OpenAI)",
    status: "ready",
    apiKeyConfigured: !!process.env.OPENAI_API_KEY,
  });
}
