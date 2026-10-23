import Decimal from "decimal.js";

/**
 * Money helpers for Indonesian Rupiah (IDR).
 *
 * Policy (documented in docs/adr/0002-money-and-quantity.md):
 * - Never use JS `number` for money arithmetic; use Decimal.
 * - Unit prices / unit costs keep 4 decimals (NUMERIC(18,4)).
 * - Document amounts (line totals, invoice totals) are rounded to whole Rupiah, ROUND_HALF_UP.
 * - Values cross the DB boundary as strings (pg returns NUMERIC as string).
 */
export const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Money = InstanceType<typeof MoneyDecimal>;

export const UNIT_PRICE_SCALE = 4;
export const AMOUNT_SCALE = 0;

/** Parse user / DB input into Money. Accepts "1250000", "1.250.000" (id-ID grouping), "1250000,50". */
export function parseMoney(input: string | number | Money): Money {
  if (input instanceof MoneyDecimal) return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new RangeError("Nilai uang tidak valid");
    return new MoneyDecimal(input.toString());
  }
  const normalized = normalizeIdNumber(input);
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) throw new RangeError(`Nilai uang tidak valid: "${input}"`);
  return new MoneyDecimal(normalized);
}

/** Round a document amount to whole Rupiah (half-up). */
export function roundRupiah(value: Money): Money {
  return value.toDecimalPlaces(AMOUNT_SCALE, MoneyDecimal.ROUND_HALF_UP);
}

/** Round a unit price / unit cost to 4 decimals (half-up). */
export function roundUnitPrice(value: Money): Money {
  return value.toDecimalPlaces(UNIT_PRICE_SCALE, MoneyDecimal.ROUND_HALF_UP);
}

/** Line total = round_rupiah(qty × unit price − discount). */
export function lineTotal(qty: Money, unitPrice: Money, discount: Money = new MoneyDecimal(0)): Money {
  return roundRupiah(qty.mul(unitPrice).minus(discount));
}

/** Serialize for NUMERIC columns. */
export function toDbAmount(value: Money): string {
  return roundRupiah(value).toFixed(2);
}
export function toDbUnitPrice(value: Money): string {
  return roundUnitPrice(value).toFixed(UNIT_PRICE_SCALE);
}

const rupiahFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** "Rp 1.250.000" — display only. */
export function formatRupiah(value: Money | string | number): string {
  const d = parseMoney(typeof value === "string" ? value : value);
  // Intl outputs "Rp 1.250.000" with a non-breaking space; keep it for layout stability.
  return rupiahFormatter.format(Number(roundRupiah(d).toString()));
}

/**
 * Normalize Indonesian-formatted numbers: "." = thousands separator, "," = decimal separator.
 * Plain machine numbers ("1250000.5") are accepted only when there is exactly one dot followed by
 * other than exactly 3 digits — ambiguous inputs like "1.250" are treated as id-ID (1250).
 */
export function normalizeIdNumber(raw: string): string {
  const s = raw.trim().replace(/^Rp\s*/i, "").replace(/\s|\u00a0/g, "");
  if (s.includes(",")) {
    return s.replace(/\./g, "").replace(",", ".");
  }
  const dotCount = (s.match(/\./g) ?? []).length;
  if (dotCount === 1) {
    const [, frac = ""] = s.split(".");
    if (frac.length === 3) return s.replace(".", ""); // "1.250" → 1250 (id-ID grouping)
    return s; // "12.5" machine decimal
  }
  if (dotCount > 1) return s.replace(/\./g, "");
  return s;
}
