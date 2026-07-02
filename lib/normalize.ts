// Shared normalization helpers used by both the client (app/page.tsx) and the
// API routes. Single source of truth — do not re-implement these locally.

export const pad2 = (value: string): string => value.padStart(2, "0");

export function fixFlyerYear(rawYear: string): string {
  let year = Number(rawYear.length === 2 ? `20${rawYear}` : rawYear);
  const current = new Date().getFullYear();
  // Flyers are always "now-ish". A year more than 1 off (e.g. AI hallucinating
  // 2020/2023 when no year was printed) is a misread → snap to the current year.
  // The ±1 window keeps legit year-boundary flyers (e.g. late December → January).
  if (!Number.isFinite(year) || Math.abs(year - current) > 1) year = current;
  return String(year);
}

// Canonicalize any flyer date to a single format: "DD.MM.YYYY" (zero-padded).
// The AI may return "24.6.2026", "24. 6. 2026" or "2026-06-24"; mixed formats in
// one flyer break the editor's <input type="date"> round-trip and confuse the app.
// Unknown / unparseable input is returned trimmed so we never invent a date.
export function normalizeSkDate(value: unknown): string {
  const s = (value === null || value === undefined ? "" : String(value)).trim();
  if (!s) return "";
  // ISO: YYYY-MM-DD
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${pad2(iso[3])}.${pad2(iso[2])}.${fixFlyerYear(iso[1])}`;
  // DMY: D.M.YYYY / D. M. YYYY / D.M.YY
  const dmy = s.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{2,4})$/);
  if (dmy) return `${pad2(dmy[1])}.${pad2(dmy[2])}.${fixFlyerYear(dmy[3])}`;
  return s;
}

// Canonicalize a price to comma-decimal with 2 decimals ("0.45" → "0,45",
// "1,5" → "1,50", "3" → "3,00"). The AI output alternates between dot and comma
// per run, which left the DB with mixed decimal separators. Anything that is not
// a plain number (ranges, text) is returned trimmed and untouched.
export function normalizePrice(value: unknown): string {
  const s = (value === null || value === undefined ? "" : String(value)).trim();
  if (!s) return "";
  // Czech flat-price notation: "299,-" / "299.-" / "299,–" → "299,00"
  const flat = s.match(/^(\d+)\s*[.,]\s*[-–—]$/);
  if (flat) return `${flat[1]},00`;
  if (!/^\d+(?:[.,]\d+)?$/.test(s)) return s;
  const num = parseFloat(s.replace(",", "."));
  if (!Number.isFinite(num)) return s;
  return num.toFixed(2).replace(".", ",");
}

// Product names must start with an uppercase letter ("kurča maxi" → "Kurča maxi").
// Only the first character is touched — brand casing like "iRobot" stays intact.
export function capitalizeFirst(value: string): string {
  const s = (value || "").trim();
  if (!s) return "";
  return s.charAt(0).toLocaleUpperCase() + s.slice(1);
}

// DB identity key for a product name (diacritics-insensitive, whitespace-folded).
export const normalizeNameKey = (value: string): string =>
  (value || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");

// Unit price per kg/l (g/ml × 1000) formatted with a comma. Returns "" when the
// price or amount is missing or not a plain number.
export function calculateUnitPrice(
  price: unknown,
  amount: unknown,
  unit: unknown,
): string {
  const priceText = (price === null || price === undefined ? "" : String(price)).trim();
  const amountText = (amount === null || amount === undefined ? "" : String(amount)).trim();
  const unitText = (unit === null || unit === undefined ? "" : String(unit)).trim();
  if (!priceText || !amountText) return "";
  const priceNum = parseFloat(priceText.replace(",", "."));
  const amountNum = parseFloat(amountText.replace(",", "."));
  if (isNaN(priceNum) || isNaN(amountNum) || amountNum === 0) return "";
  let multiplier = 1;
  if (unitText === "g" || unitText === "ml") multiplier = 1000;
  return ((priceNum / amountNum) * multiplier).toFixed(2).replace(".", ",");
}
