import { MoneyDecimal, normalizeIdNumber, type Money } from "./money";

/**
 * Quantity helpers. Quantities are stored in the product's BASE unit (kg or pcs)
 * as NUMERIC(14,3) — gram precision for kilograms.
 */
export const QTY_SCALE = 3;
export type Qty = Money;

export function parseQty(input: string | number | Qty): Qty {
  if (input instanceof MoneyDecimal) return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new RangeError("Kuantitas tidak valid");
    return new MoneyDecimal(input.toString());
  }
  const normalized = normalizeQtyInput(input);
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) throw new RangeError(`Kuantitas tidak valid: "${input}"`);
  return new MoneyDecimal(normalized);
}

/**
 * Quantities are typed by operators as "12,5" (id-ID) or "12.5". Unlike money there is no
 * thousands grouping for weights in practice, so a single "." is always a decimal point.
 */
function normalizeQtyInput(raw: string): string {
  const s = raw.trim().replace(/\s|\u00a0/g, "");
  if (s.includes(",")) return s.replace(/\./g, "").replace(",", ".");
  if ((s.match(/\./g) ?? []).length > 1) return normalizeIdNumber(s);
  return s;
}

export function roundQty(q: Qty): Qty {
  return q.toDecimalPlaces(QTY_SCALE, MoneyDecimal.ROUND_HALF_UP);
}

export function toDbQty(q: Qty): string {
  return roundQty(q).toFixed(QTY_SCALE);
}

export interface UomConversion {
  /** How many base units one of this UoM equals (e.g. 1 peti = 20 kg → 20). */
  factorToBase: string;
  /** Nominal conversions are estimates; they must never be used for invoicing. */
  isNominal: boolean;
  /** Catch-weight: the actual measured weight must be captured. */
  requiresActualWeight: boolean;
}

export class ConversionNotAllowedError extends Error {}

/**
 * Convert a quantity in a given UoM to base units.
 * `purpose: "billing"` rejects nominal / catch-weight conversions — the caller must
 * supply a measured base quantity instead.
 */
export function toBaseQty(qty: Qty, conversion: UomConversion, purpose: "estimate" | "billing"): Qty {
  const factor = parseQty(conversion.factorToBase);
  if (factor.lte(0)) throw new RangeError("Faktor konversi harus lebih dari 0");
  if (purpose === "billing" && (conversion.isNominal || conversion.requiresActualWeight)) {
    throw new ConversionNotAllowedError(
      "Konversi satuan ini hanya perkiraan. Gunakan berat/jumlah aktual hasil timbang untuk penagihan.",
    );
  }
  return roundQty(qty.mul(factor));
}

/** Net weight = gross − tare, must be ≥ 0. */
export function netWeight(grossKg: Qty, tareKg: Qty): Qty {
  const net = grossKg.minus(tareKg);
  if (net.lt(0)) throw new RangeError("Berat tara melebihi berat bruto");
  return roundQty(net);
}

const qtyFormatter = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 0, maximumFractionDigits: 3 });

export function formatQty(q: Qty | string | number, unit?: string): string {
  const d = parseQty(q);
  const text = qtyFormatter.format(Number(roundQty(d).toString()));
  return unit ? `${text} ${unit}` : text;
}
