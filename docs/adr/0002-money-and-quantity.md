# ADR 0002 — Money, Quantity, Catch-Weight, and Inventory Valuation Policy

- **Status:** Accepted (Draft pending final accountant sign-off before Phase 3 go-live)
- **Date:** 2026-10-20

## 1. Currency & Rounding

- Currency is **IDR (Indonesian Rupiah)**.
- Never use IEEE-754 `number` for financial or quantity calculations; all calculations use `decimal.js` (`ROUND_HALF_UP`).
- Unit prices and unit costs use `NUMERIC(18,4)`.
- Document line totals and invoice totals are rounded to whole Rupiah (`NUMERIC(18,2)` with `.00` fractional part, rounded to `Rp 1` using `ROUND_HALF_UP`).

## 2. Quantities & Catch-Weight

- Every product defines a **base unit of measure** (`kg` or `pcs`), stored as `NUMERIC(14,3)` (gram precision for `kg`).
- Secondary packaging units (`peti`, `krat`, `box`, `ikat`, ` sisir`) define conversion rules in `product_uom_conversions`.
- When `is_nominal = true` or `requires_actual_weight = true`, the conversion factor may only be used for planning/estimation (`purpose = "estimate"`). Invoicing and stock movements require actual measured weight (`purpose = "billing"`).

## 3. Inventory Costing Policy (Default for Phase 3)

- **Lot-level actual cost** with **FEFO** (First Expired, First Out) dispatch priority.
- Relative sales value allocation across graded outputs (Grade A / B / C) from a single goods receipt line.
- Trim/sorting loss at receiving is absorbed into accepted grade unit cost and tracked separately as yield metrics.
- Post-receiving spoilage, damage, and shrinkage are expensed to *Beban Susut & Kerusakan Persediaan* at the batch's actual unit cost.
