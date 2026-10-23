import crypto from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  MoneyDecimal,
  parseMoney,
  roundRupiah,
  roundUnitPrice,
  toDbAmount,
  toDbUnitPrice,
  type Money,
} from "@/lib/money";
import { parseQty, roundQty, toDbQty } from "@/lib/quantity";
import { recordAudit } from "@/server/audit";
import { authorize, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import {
  batches,
  priceListHistory,
  priceListItems,
  priceLists,
  productGrades,
  productUomConversions,
  products,
  stockBalances,
  uoms,
} from "@/server/db/schema";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/server/errors";
import { evaluateCostingPolicyGate } from "@/server/modules/inventory/costing";
import { getSetting } from "@/server/settings";

function roundPct(value: Money): Money {
  return value.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP);
}

/**
 * ============================================================================
 * DOCUMENTED MARGIN & PRICING POLICY ENGINE (PHASE 4)
 * ============================================================================
 *
 * 1. UOM CONVERSION:
 *    - If `orderedUomCode === product.baseUomCode`, `uomFactorToBase = 1.0000`.
 *    - Otherwise, resolved from `product_uom_conversions` (`fromUomCode = orderedUomCode`,
 *      `toUomCode = product.baseUomCode`).
 *    - `orderedQtyBase = roundQty(orderedQty * uomFactorToBase)` (3 decimal places).
 *
 * 2. UNIT PRICE & DISCOUNT:
 *    - `listUnitPrice` is resolved from active `price_lists` + `price_list_items` matching
 *      product, grade, UoM, customer segment/priceTier, warehouse, minQty, and effective date.
 *    - `discountAmountPerUnit = roundUnitPrice(unitPrice * (discountPct / 100))`
 *    - `netUnitPrice = roundUnitPrice(unitPrice - discountAmountPerUnit)`
 *    - `netUnitPriceBase = roundUnitPrice(netUnitPrice / uomFactorToBase)`
 *
 * 3. EXPLICIT GROSS MARGIN FORMULA:
 *    - `Margin % = ((netUnitPriceBase - unitCostBasisBase) / netUnitPriceBase) * 100`
 *      rounded to 2 decimal places (`HALF_UP`).
 *    - `unitCostBasisBase` is the weighted-average available batch cost (`stock_balances` where
 *      `stock_status = 'available'` and `qty_base > 0`) for `(warehouseId, productId, gradeId)`.
 *    - CRITICAL GATE: If `enforceProductionGate: true` (or `NODE_ENV === "production"`),
 *      `evaluateCostingPolicyGate` blocks using unapproved/synthetic batch costs as a
 *      production margin cost basis.
 *
 * 4. MINIMUM MARGIN & FLOOR PRICE CONTROL:
 *    - Effective minimum margin % = `max(product.defaultMinMarginPct, grade.minMarginPctOverride ?? 0)`.
 *    - A line is flagged `isBelowMinMargin = true` if:
 *      * `marginPct < minMarginPctSnapshot`, OR
 *      * `netUnitPriceBase < product.minSellingPrice` (when `minSellingPrice > 0`), OR
 *      * `discountPct > priceListItem.maxDiscountPct`, OR
 *      * `unitPrice < listUnitPrice`
 */

export const MARGIN_FORMULA_DESCRIPTION =
  "MarginPct = ((NetUnitPriceBase - UnitCostBasisBase) / NetUnitPriceBase) * 100";

export const createPriceListSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{3,32}$/, "Kode daftar harga harus 3–32 karakter alfanumerik."),
  name: z.string().trim().min(3, "Nama daftar harga minimal 3 karakter."),
  priceTier: z.enum(["grosir", "semi_grosir", "ritel", "horeca"]),
  customerSegment: z
    .enum([
      "toko_buah",
      "pedagang_pasar",
      "ritel_reseller",
      "horeca",
      "kedai_jus",
      "korporat",
      "konsumen_langsung",
    ])
    .optional()
    .nullable(),
  warehouseId: z.string().optional().nullable(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal mulai berlaku harus YYYY-MM-DD."),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal akhir berlaku harus YYYY-MM-DD.")
    .optional()
    .nullable(),
  isActive: z.boolean().default(true),
  notes: z.string().trim().optional().nullable(),
  reason: z.string().trim().default("Pembuatan daftar harga baru."),
});

export const upsertPriceListItemSchema = z.object({
  priceListId: z.string().min(1),
  productId: z.string().min(1),
  gradeId: z.string().min(1),
  uomCode: z.string().trim().min(1),
  minQty: z.union([z.string(), z.number()]).default("1.000"),
  unitPrice: z.union([z.string(), z.number()]),
  maxDiscountPct: z.union([z.string(), z.number()]).default("0.00"),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  reason: z.string().trim().min(3, "Alasan penetapan/perubahan harga wajib diisi."),
});

export async function resolveUomFactorToBase(
  tx: DbExecutor,
  productId: string,
  orderedUomCodeRaw: string,
): Promise<{
  product: typeof products.$inferSelect;
  orderedUomCode: string;
  factorToBase: Money;
}> {
  const orderedUomCode = orderedUomCodeRaw.trim().toLowerCase();
  const [product] = await tx
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!product) {
    throw new NotFoundError(`Produk '${productId}' tidak ditemukan.`);
  }
  if (!product.isActive) {
    throw new BusinessRuleError(`Produk '${product.name}' sedang berstatus nonaktif.`);
  }

  const [uomRow] = await tx
    .select()
    .from(uoms)
    .where(eq(uoms.code, orderedUomCode))
    .limit(1);
  if (!uomRow) {
    throw new NotFoundError(`Satuan (UoM) '${orderedUomCode}' tidak terdaftar pada master data.`);
  }

  const baseUom = product.baseUomCode.trim().toLowerCase();
  if (orderedUomCode === baseUom) {
    return {
      product,
      orderedUomCode,
      factorToBase: new MoneyDecimal(1),
    };
  }

  const [conv] = await tx
    .select()
    .from(productUomConversions)
    .where(
      and(
        eq(productUomConversions.productId, product.id),
        eq(productUomConversions.uomCode, orderedUomCode),
      ),
    )
    .limit(1);

  if (!conv) {
    throw new BusinessRuleError(
      `Konversi satuan dari '${orderedUomCode}' ke satuan dasar '${baseUom}' belum dikonfigurasi untuk produk '${product.name}'.`,
    );
  }

  const factor = new MoneyDecimal(conv.factorToBase);
  if (factor.lte(0)) {
    throw new BusinessRuleError("Faktor konversi UoM harus lebih besar dari 0.");
  }

  return {
    product,
    orderedUomCode,
    factorToBase: factor,
  };
}

export async function createPriceList(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createPriceListSchema>,
) {
  authorize(
    ctx,
    "pricing.write",
    rawInput.warehouseId ? { warehouseId: rawInput.warehouseId } : undefined,
  );
  const parsed = createPriceListSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  if (data.effectiveTo && data.effectiveTo < data.effectiveFrom) {
    throw new BusinessRuleError(
      "Tanggal berakhir daftar harga tidak boleh lebih awal dari tanggal mulai berlaku.",
    );
  }

  const [dup] = await tx
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(eq(priceLists.code, data.code))
    .limit(1);
  if (dup) {
    throw new ConflictError(`Kode daftar harga '${data.code}' sudah digunakan.`);
  }

  const id = `pl_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(priceLists)
    .values({
      id,
      code: data.code,
      name: data.name,
      priceTier: data.priceTier,
      customerSegment: data.customerSegment ?? null,
      warehouseId: data.warehouseId ?? null,
      currency: "IDR",
      effectiveFrom: data.effectiveFrom,
      effectiveTo: data.effectiveTo ?? null,
      isActive: data.isActive,
      notes: data.notes ?? null,
      createdBy: ctx.user.id,
    })
    .returning();

  await tx.insert(priceListHistory).values({
    id: `plh_${crypto.randomUUID().slice(0, 8)}`,
    priceListId: id,
    priceListItemId: null,
    changeType: "create_list",
    previousSnapshot: null,
    newSnapshot: created!,
    reason: data.reason,
    changedBy: ctx.user.id,
  });

  await recordAudit(tx, {
    ctx,
    action: "price_list.create",
    entityType: "price_list",
    entityId: id,
    afterData: created,
    reason: data.reason,
  });

  return created!;
}

export async function upsertPriceListItem(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof upsertPriceListItemSchema>,
) {
  const parsed = upsertPriceListItemSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [pl] = await tx
    .select()
    .from(priceLists)
    .where(eq(priceLists.id, data.priceListId))
    .limit(1);
  if (!pl) {
    throw new NotFoundError("Daftar harga (price list) tidak ditemukan.");
  }

  authorize(ctx, "pricing.write", pl.warehouseId ? { warehouseId: pl.warehouseId } : undefined);

  const { product, orderedUomCode, factorToBase } = await resolveUomFactorToBase(
    tx,
    data.productId,
    data.uomCode,
  );

  const [grade] = await tx
    .select()
    .from(productGrades)
    .where(and(eq(productGrades.id, data.gradeId), eq(productGrades.productId, product.id)))
    .limit(1);
  if (!grade) {
    throw new NotFoundError(`Grade produk '${data.gradeId}' tidak ditemukan untuk produk '${product.name}'.`);
  }

  const minQty = roundQty(parseQty(data.minQty));
  if (minQty.lte(0)) {
    throw new BusinessRuleError("Kuantitas minimum (minQty) harus lebih besar dari 0.");
  }

  const unitPrice = roundUnitPrice(parseMoney(data.unitPrice));
  if (unitPrice.lte(0)) {
    throw new BusinessRuleError("Harga satuan pada daftar harga harus lebih besar dari Rp 0.");
  }

  const maxDiscountPct = new MoneyDecimal(data.maxDiscountPct.toString());
  if (maxDiscountPct.lt(0) || maxDiscountPct.gt(100)) {
    throw new BusinessRuleError("Persentase diskon maksimum harus berada di antara 0% dan 100%.");
  }

  if (data.effectiveFrom && data.effectiveTo && data.effectiveTo < data.effectiveFrom) {
    throw new BusinessRuleError(
      "Tanggal akhir berlaku item harga tidak boleh lebih awal dari tanggal mulai berlaku.",
    );
  }

  const unitPriceBase = roundUnitPrice(unitPrice.div(factorToBase));

  const [existing] = await tx
    .select()
    .from(priceListItems)
    .where(
      and(
        eq(priceListItems.priceListId, pl.id),
        eq(priceListItems.productId, product.id),
        eq(priceListItems.gradeId, grade.id),
        eq(priceListItems.uomCode, orderedUomCode),
        eq(priceListItems.minQty, toDbQty(minQty)),
      ),
    )
    .limit(1);

  if (existing) {
    const [updated] = await tx
      .update(priceListItems)
      .set({
        unitPrice: toDbUnitPrice(unitPrice),
        unitPriceBase: toDbUnitPrice(unitPriceBase),
        maxDiscountPct: maxDiscountPct.toFixed(2),
        effectiveFrom: data.effectiveFrom ?? null,
        effectiveTo: data.effectiveTo ?? null,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(priceListItems.id, existing.id))
      .returning();

    await tx.insert(priceListHistory).values({
      id: `plh_${crypto.randomUUID().slice(0, 8)}`,
      priceListId: pl.id,
      priceListItemId: existing.id,
      changeType: "upsert_item",
      previousSnapshot: existing,
      newSnapshot: updated!,
      reason: data.reason,
      changedBy: ctx.user.id,
    });

    await recordAudit(tx, {
      ctx,
      action: "price_list_item.update",
      entityType: "price_list_item",
      entityId: existing.id,
      beforeData: existing,
      afterData: updated,
      reason: data.reason,
    });

    return updated!;
  }

  const id = `pli_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(priceListItems)
    .values({
      id,
      priceListId: pl.id,
      productId: product.id,
      gradeId: grade.id,
      gradeCode: grade.code,
      uomCode: orderedUomCode,
      minQty: toDbQty(minQty),
      unitPrice: toDbUnitPrice(unitPrice),
      unitPriceBase: toDbUnitPrice(unitPriceBase),
      maxDiscountPct: maxDiscountPct.toFixed(2),
      effectiveFrom: data.effectiveFrom ?? null,
      effectiveTo: data.effectiveTo ?? null,
    })
    .returning();

  await tx.insert(priceListHistory).values({
    id: `plh_${crypto.randomUUID().slice(0, 8)}`,
    priceListId: pl.id,
    priceListItemId: id,
    changeType: "upsert_item",
    previousSnapshot: null,
    newSnapshot: created!,
    reason: data.reason,
    changedBy: ctx.user.id,
  });

  await recordAudit(tx, {
    ctx,
    action: "price_list_item.create",
    entityType: "price_list_item",
    entityId: id,
    afterData: created,
    reason: data.reason,
  });

  return created!;
}

export interface ResolveActivePriceInput {
  productId: string;
  gradeId: string;
  uomCode: string;
  orderedQty: Money;
  customerSegment: string;
  priceTier: string;
  warehouseId: string;
  documentDate: string;
}

export interface ResolvedActivePriceResult {
  priceList: typeof priceLists.$inferSelect;
  priceListItem: typeof priceListItems.$inferSelect;
}

/**
 * Resolves the active price list item for a product, grade, UoM, quantity, customer segment,
 * price tier, warehouse, and date.
 */
export async function resolveActivePrice(
  tx: DbExecutor,
  input: ResolveActivePriceInput,
): Promise<ResolvedActivePriceResult | null> {
  const normalizedUom = input.uomCode.trim().toLowerCase();

  const candidateLists = await tx
    .select()
    .from(priceLists)
    .where(
      and(
        eq(priceLists.isActive, true),
        eq(
          priceLists.priceTier,
          input.priceTier as "grosir" | "semi_grosir" | "ritel" | "horeca",
        ),
      ),
    );

  const activeLists = candidateLists.filter((pl) => {
    if (pl.effectiveFrom > input.documentDate) return false;
    if (pl.effectiveTo && pl.effectiveTo < input.documentDate) return false;
    if (pl.customerSegment && pl.customerSegment !== input.customerSegment) return false;
    if (pl.warehouseId && pl.warehouseId !== input.warehouseId) return false;
    return true;
  });

  if (activeLists.length === 0) {
    return null;
  }

  activeLists.sort((a, b) => {
    const scoreA = (a.customerSegment ? 2 : 0) + (a.warehouseId ? 1 : 0);
    const scoreB = (b.customerSegment ? 2 : 0) + (b.warehouseId ? 1 : 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return b.effectiveFrom.localeCompare(a.effectiveFrom);
  });

  for (const pl of activeLists) {
    const items = await tx
      .select()
      .from(priceListItems)
      .where(
        and(
          eq(priceListItems.priceListId, pl.id),
          eq(priceListItems.productId, input.productId),
          eq(priceListItems.gradeId, input.gradeId),
          eq(priceListItems.uomCode, normalizedUom),
        ),
      );

    const eligibleItems = items.filter((item) => {
      if (item.effectiveFrom && item.effectiveFrom > input.documentDate) return false;
      if (item.effectiveTo && item.effectiveTo < input.documentDate) return false;
      const itemMinQty = new MoneyDecimal(item.minQty);
      return input.orderedQty.gte(itemMinQty);
    });

    if (eligibleItems.length > 0) {
      eligibleItems.sort((a, b) =>
        new MoneyDecimal(b.minQty).cmp(new MoneyDecimal(a.minQty)),
      );
      return {
        priceList: pl,
        priceListItem: eligibleItems[0]!,
      };
    }
  }

  return null;
}

export interface ResolveProductCostBasisInput {
  warehouseId: string;
  productId: string;
  gradeId: string;
  enforceProductionGate?: boolean;
  fallbackCostBasisBase?: string | number;
}

export interface ResolvedCostBasisResult {
  unitCostBasisBase: Money;
  source: "available_stock_weighted_avg" | "latest_batch_cost" | "fallback_cost_basis";
  costingPolicyStatus: "approved" | "synthetic_dev_blocked_prod";
}

/**
 * Resolves the unit cost basis per base UoM (`unitCostBasisBase`) for margin control.
 *
 * CRITICAL RULE:
 * If `enforceProductionGate: true` (or `NODE_ENV === "production"`), and the costing policy
 * (`costing.policy_approval`) has not been approved by both Owner and Accountant, OR any
 * contributing batch uses synthetic dev costing, this function throws a `BLOCKED` BusinessRuleError.
 */
export async function resolveProductCostBasis(
  tx: DbExecutor,
  input: ResolveProductCostBasisInput,
): Promise<ResolvedCostBasisResult> {
  const gate = await evaluateCostingPolicyGate(tx, {
    enforceProductionGate: input.enforceProductionGate,
  });

  const mustEnforceProd =
    input.enforceProductionGate === true || process.env.NODE_ENV === "production";

  const availableRows = await tx
    .select({
      qtyBase: stockBalances.qtyBase,
      totalCost: stockBalances.totalCost,
      unitCostBase: stockBalances.unitCostBase,
      costingMethod: batches.costingMethod,
    })
    .from(stockBalances)
    .innerJoin(batches, eq(batches.id, stockBalances.batchId))
    .where(
      and(
        eq(stockBalances.warehouseId, input.warehouseId),
        eq(stockBalances.productId, input.productId),
        eq(stockBalances.gradeId, input.gradeId),
        eq(stockBalances.stockStatus, "available"),
        eq(batches.status, "active"),
      ),
    );

  const positiveRows = availableRows.filter((r) => new MoneyDecimal(r.qtyBase).gt(0));

  if (positiveRows.length > 0) {
    if (mustEnforceProd) {
      const hasSynthetic = positiveRows.some((r) => r.costingMethod.includes("synthetic"));
      if (hasSynthetic) {
        throw new BusinessRuleError(
          "BLOCKED: Batch persediaan masih menggunakan perhitungan HPP sintetis (belum disetujui untuk produksi). Tidak dapat digunakan sebagai dasar margin produksi.",
        );
      }
    }

    let totalQty = new MoneyDecimal(0);
    let totalCost = new MoneyDecimal(0);
    for (const r of positiveRows) {
      totalQty = totalQty.plus(new MoneyDecimal(r.qtyBase));
      totalCost = totalCost.plus(new MoneyDecimal(r.totalCost));
    }

    const weightedUnitCost = roundUnitPrice(totalCost.div(totalQty));
    return {
      unitCostBasisBase: weightedUnitCost,
      source: "available_stock_weighted_avg",
      costingPolicyStatus: gate.status,
    };
  }

  const [latestBatch] = await tx
    .select()
    .from(batches)
    .where(
      and(
        eq(batches.warehouseId, input.warehouseId),
        eq(batches.productId, input.productId),
        eq(batches.gradeId, input.gradeId),
      ),
    )
    .orderBy(desc(batches.receivedAt))
    .limit(1);

  if (latestBatch) {
    if (mustEnforceProd && latestBatch.costingMethod.includes("synthetic")) {
      throw new BusinessRuleError(
        "BLOCKED: Batch persediaan terakhir menggunakan HPP sintetis. Tidak dapat digunakan sebagai dasar margin produksi.",
      );
    }
    return {
      unitCostBasisBase: roundUnitPrice(new MoneyDecimal(latestBatch.unitCostBase)),
      source: "latest_batch_cost",
      costingPolicyStatus: gate.status,
    };
  }

  if (input.fallbackCostBasisBase !== undefined) {
    if (mustEnforceProd) {
      throw new BusinessRuleError(
        "BLOCKED: Dasar HPP fallback sintetis tidak diizinkan pada mode produksi.",
      );
    }
    const fb = roundUnitPrice(parseMoney(input.fallbackCostBasisBase));
    if (fb.lt(0)) {
      throw new BusinessRuleError("Dasar HPP tidak boleh negatif.");
    }
    return {
      unitCostBasisBase: fb,
      source: "fallback_cost_basis",
      costingPolicyStatus: gate.status,
    };
  }

  throw new BusinessRuleError(
    "Tidak ditemukan batch persediaan / HPP untuk produk dan grade ini di gudang tujuan guna memvalidasi margin.",
  );
}

export async function resolveTaxRatePct(
  tx: DbExecutor,
  taxCodeRaw: string,
): Promise<{ taxCode: string; taxRatePct: Money }> {
  const taxCode = taxCodeRaw.trim().toUpperCase();
  if (taxCode === "PPN_EXEMPT" || taxCode === "NON_PPN" || taxCode === "BEBAS_PPN") {
    return { taxCode: "PPN_EXEMPT", taxRatePct: new MoneyDecimal(0) };
  }

  const configured = await getSetting<Record<string, number | string>>(tx, "sales.tax_rates");
  if (configured?.value && configured.value[taxCode] !== undefined) {
    const rate = new MoneyDecimal(configured.value[taxCode]!.toString());
    if (rate.lt(0) || rate.gt(100)) {
      throw new BusinessRuleError(`Tarif pajak untuk kode '${taxCode}' tidak valid.`);
    }
    return { taxCode, taxRatePct: rate };
  }

  if (taxCode === "PPN_11") {
    return { taxCode: "PPN_11", taxRatePct: new MoneyDecimal(11) };
  }

  throw new BusinessRuleError(
    `Kode perlakuan pajak '${taxCode}' belum dikonfirmasi/dikonfigurasi pada pengaturan sistem.`,
  );
}

export interface CalculateLinePricingInput {
  warehouseId: string;
  customerSegment: string;
  priceTier: string;
  documentDate: string;
  productId: string;
  gradeId: string;
  orderedUomCode: string;
  orderedQty: string | number;
  customUnitPrice?: string | number | null;
  discountPct?: string | number;
  taxCodeOverride?: string | null;
  enforceProductionCostingGate?: boolean;
  fallbackCostBasisBase?: string | number;
  // Optional client-asserted fields to detect browser request tampering:
  clientAssertedUnitPrice?: string | number;
  clientAssertedLineTotalAmount?: string | number;
  clientAssertedMarginPct?: string | number;
  clientAssertedUnitCostBasisBase?: string | number;
  notes?: string | null;
}

export interface CalculatedLinePricingResult {
  productId: string;
  productSku: string;
  productName: string;
  gradeId: string;
  gradeCode: string;
  orderedUomCode: string;
  orderedQty: string;
  uomFactorToBaseSnapshot: string;
  orderedQtyBase: string;
  priceListId: string | null;
  priceListItemId: string | null;
  listUnitPrice: string;
  unitPrice: string;
  discountPct: string;
  discountAmountPerUnit: string;
  netUnitPrice: string;
  netUnitPriceBase: string;
  unitCostBasisBase: string;
  marginPct: string;
  minMarginPctSnapshot: string;
  minSellingPriceBaseSnapshot: string;
  maxDiscountPctSnapshot: string;
  isBelowMinMargin: boolean;
  marginViolationReasons: string[];
  taxCodeSnapshot: string;
  taxRatePctSnapshot: string;
  lineGrossAmount: string;
  lineDiscountAmount: string;
  lineNetAmount: string;
  lineTaxAmount: string;
  lineTotalAmount: string;
  notes: string | null;
}

/**
 * 100% server-side calculation and validation of line pricing, UoM conversion, discount,
 * cost basis, gross margin %, floor price, and tax.
 * Rejects tampered client totals/assertions and flags any margin/floor-price violations.
 */
export async function calculateAndValidateLinePricing(
  tx: DbExecutor,
  input: CalculateLinePricingInput,
): Promise<CalculatedLinePricingResult> {
  const orderedQty = roundQty(parseQty(input.orderedQty));
  if (orderedQty.lte(0)) {
    throw new BusinessRuleError("Kuantitas pesanan harus lebih besar dari 0.");
  }

  const { product, orderedUomCode, factorToBase } = await resolveUomFactorToBase(
    tx,
    input.productId,
    input.orderedUomCode,
  );

  const [grade] = await tx
    .select()
    .from(productGrades)
    .where(and(eq(productGrades.id, input.gradeId), eq(productGrades.productId, product.id)))
    .limit(1);
  if (!grade || !grade.isActive) {
    throw new NotFoundError(
      `Grade '${input.gradeId}' tidak ditemukan atau tidak aktif untuk produk '${product.name}'.`,
    );
  }

  const orderedQtyBase = roundQty(orderedQty.mul(factorToBase));

  const resolvedPrice = await resolveActivePrice(tx, {
    productId: product.id,
    gradeId: grade.id,
    uomCode: orderedUomCode,
    orderedQty,
    customerSegment: input.customerSegment,
    priceTier: input.priceTier,
    warehouseId: input.warehouseId,
    documentDate: input.documentDate,
  });

  if (!resolvedPrice && (input.customUnitPrice === undefined || input.customUnitPrice === null)) {
    throw new BusinessRuleError(
      `Tidak ditemukan harga aktif pada Price List (${input.priceTier}) untuk produk '${product.name}' Grade ${grade.code} satuan '${orderedUomCode}' pada tanggal ${input.documentDate}.`,
    );
  }

  const listUnitPriceDec = resolvedPrice
    ? roundUnitPrice(new MoneyDecimal(resolvedPrice.priceListItem.unitPrice))
    : roundUnitPrice(parseMoney(input.customUnitPrice!));

  const unitPriceDec =
    input.customUnitPrice !== undefined && input.customUnitPrice !== null
      ? roundUnitPrice(parseMoney(input.customUnitPrice))
      : listUnitPriceDec;

  if (unitPriceDec.lte(0)) {
    throw new BusinessRuleError("Harga jual satuan harus lebih besar dari Rp 0.");
  }

  if (input.clientAssertedUnitPrice !== undefined) {
    const assertedUp = roundUnitPrice(parseMoney(input.clientAssertedUnitPrice));
    if (!assertedUp.eq(unitPriceDec)) {
      throw new BusinessRuleError(
        `Manipulasi harga terdeteksi: harga dari klien (Rp ${toDbUnitPrice(assertedUp)}) tidak sesuai dengan harga server (Rp ${toDbUnitPrice(unitPriceDec)}).`,
      );
    }
  }

  const discountPctDec = new MoneyDecimal((input.discountPct ?? "0").toString());
  if (discountPctDec.lt(0) || discountPctDec.gt(100)) {
    throw new BusinessRuleError("Persentase diskon harus di antara 0% dan 100%.");
  }

  const maxDiscountPctDec = resolvedPrice
    ? new MoneyDecimal(resolvedPrice.priceListItem.maxDiscountPct)
    : new MoneyDecimal(0);

  const discountAmountPerUnitDec = roundUnitPrice(
    unitPriceDec.mul(discountPctDec).div(100),
  );
  const netUnitPriceDec = roundUnitPrice(unitPriceDec.minus(discountAmountPerUnitDec));
  if (netUnitPriceDec.lte(0)) {
    throw new BusinessRuleError("Harga jual bersih (setelah diskon) harus lebih besar dari Rp 0.");
  }

  const netUnitPriceBaseDec = roundUnitPrice(netUnitPriceDec.div(factorToBase));

  const costBasis = await resolveProductCostBasis(tx, {
    warehouseId: input.warehouseId,
    productId: product.id,
    gradeId: grade.id,
    enforceProductionGate: input.enforceProductionCostingGate,
    fallbackCostBasisBase: input.fallbackCostBasisBase,
  });

  const unitCostBasisBaseDec = costBasis.unitCostBasisBase;

  if (input.clientAssertedUnitCostBasisBase !== undefined) {
    const assertedCost = roundUnitPrice(parseMoney(input.clientAssertedUnitCostBasisBase));
    if (!assertedCost.eq(unitCostBasisBaseDec)) {
      throw new BusinessRuleError(
        `Manipulasi HPP terdeteksi: dasar HPP dari klien (Rp ${toDbUnitPrice(assertedCost)}) tidak sesuai dengan HPP aktual server (Rp ${toDbUnitPrice(unitCostBasisBaseDec)}).`,
      );
    }
  }

  const marginPctDec = roundPct(
    netUnitPriceBaseDec.minus(unitCostBasisBaseDec).div(netUnitPriceBaseDec).mul(100),
  );

  if (input.clientAssertedMarginPct !== undefined) {
    const assertedMargin = roundPct(new MoneyDecimal(input.clientAssertedMarginPct.toString()));
    if (!assertedMargin.eq(marginPctDec)) {
      throw new BusinessRuleError(
        `Manipulasi margin terdeteksi: margin dari klien (${assertedMargin.toFixed(2)}%) tidak sesuai dengan perhitungan margin server (${marginPctDec.toFixed(2)}%).`,
      );
    }
  }

  const effectiveMinMarginPctDec = new MoneyDecimal(product.minMarginPct);
  const minSellingPriceBaseDec = roundUnitPrice(new MoneyDecimal(product.minSellingPrice));

  const marginViolationReasons: string[] = [];
  if (marginPctDec.lt(effectiveMinMarginPctDec)) {
    marginViolationReasons.push(
      `Margin baris produk '${product.name}' Grade ${grade.code} (${marginPctDec.toFixed(2)}%) berada di bawah batas minimum margin (${effectiveMinMarginPctDec.toFixed(2)}%).`,
    );
  }
  if (minSellingPriceBaseDec.gt(0) && netUnitPriceBaseDec.lt(minSellingPriceBaseDec)) {
    marginViolationReasons.push(
      `Harga bersih per satuan dasar produk '${product.name}' (Rp ${toDbUnitPrice(netUnitPriceBaseDec)}/${product.baseUomCode}) berada di bawah harga dasar minimum (Rp ${toDbUnitPrice(minSellingPriceBaseDec)}/${product.baseUomCode}).`,
    );
  }
  if (resolvedPrice && discountPctDec.gt(maxDiscountPctDec)) {
    marginViolationReasons.push(
      `Diskon (${discountPctDec.toFixed(2)}%) melebihi batas diskon maksimum daftar harga (${maxDiscountPctDec.toFixed(2)}%).`,
    );
  }
  if (resolvedPrice && unitPriceDec.lt(listUnitPriceDec)) {
    marginViolationReasons.push(
      `Harga satuan kustom (Rp ${toDbUnitPrice(unitPriceDec)}) di bawah harga daftar resmi (Rp ${toDbUnitPrice(listUnitPriceDec)}).`,
    );
  }

  const isBelowMinMargin = marginViolationReasons.length > 0;

  const lineGrossAmountDec = roundRupiah(orderedQty.mul(unitPriceDec));
  const lineNetAmountDec = roundRupiah(orderedQty.mul(netUnitPriceDec));
  const lineDiscountAmountDec = roundRupiah(lineGrossAmountDec.minus(lineNetAmountDec));

  const { taxCode, taxRatePct } = await resolveTaxRatePct(
    tx,
    input.taxCodeOverride ?? product.taxCode ?? "PPN_EXEMPT",
  );
  const lineTaxAmountDec = roundRupiah(lineNetAmountDec.mul(taxRatePct).div(100));
  const lineTotalAmountDec = roundRupiah(lineNetAmountDec.plus(lineTaxAmountDec));

  if (input.clientAssertedLineTotalAmount !== undefined) {
    const assertedTotal = roundRupiah(parseMoney(input.clientAssertedLineTotalAmount));
    if (!assertedTotal.eq(lineTotalAmountDec)) {
      throw new BusinessRuleError(
        `Manipulasi total baris terdeteksi: total dari klien (Rp ${toDbAmount(assertedTotal)}) tidak sesuai dengan perhitungan server (Rp ${toDbAmount(lineTotalAmountDec)}).`,
      );
    }
  }

  return {
    productId: product.id,
    productSku: product.sku,
    productName: product.name,
    gradeId: grade.id,
    gradeCode: grade.code,
    orderedUomCode,
    orderedQty: toDbQty(orderedQty),
    uomFactorToBaseSnapshot: factorToBase.toFixed(4),
    orderedQtyBase: toDbQty(orderedQtyBase),
    priceListId: resolvedPrice?.priceList.id ?? null,
    priceListItemId: resolvedPrice?.priceListItem.id ?? null,
    listUnitPrice: toDbUnitPrice(listUnitPriceDec),
    unitPrice: toDbUnitPrice(unitPriceDec),
    discountPct: discountPctDec.toFixed(2),
    discountAmountPerUnit: toDbUnitPrice(discountAmountPerUnitDec),
    netUnitPrice: toDbUnitPrice(netUnitPriceDec),
    netUnitPriceBase: toDbUnitPrice(netUnitPriceBaseDec),
    unitCostBasisBase: toDbUnitPrice(unitCostBasisBaseDec),
    marginPct: marginPctDec.toFixed(2),
    minMarginPctSnapshot: effectiveMinMarginPctDec.toFixed(2),
    minSellingPriceBaseSnapshot: toDbUnitPrice(minSellingPriceBaseDec),
    maxDiscountPctSnapshot: maxDiscountPctDec.toFixed(2),
    isBelowMinMargin,
    marginViolationReasons,
    taxCodeSnapshot: taxCode,
    taxRatePctSnapshot: taxRatePct.toFixed(2),
    lineGrossAmount: toDbAmount(lineGrossAmountDec),
    lineDiscountAmount: toDbAmount(lineDiscountAmountDec),
    lineNetAmount: toDbAmount(lineNetAmountDec),
    lineTaxAmount: toDbAmount(lineTaxAmountDec),
    lineTotalAmount: toDbAmount(lineTotalAmountDec),
    notes: input.notes ?? null,
  };
}

export async function listPriceLists(db: DbExecutor, ctx: ActorContext) {
  authorize(ctx, "customer.read");
  const lists = await db.select().from(priceLists).orderBy(desc(priceLists.effectiveFrom));
  const items = await db.select().from(priceListItems).orderBy(asc(priceListItems.minQty));
  const history = await db
    .select()
    .from(priceListHistory)
    .orderBy(desc(priceListHistory.changedAt))
    .limit(50);

  return {
    priceLists: lists,
    items,
    history,
  };
}
