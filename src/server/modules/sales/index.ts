import crypto from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { businessDate } from "@/lib/datetime";
import { MoneyDecimal, parseMoney, roundRupiah, toDbAmount } from "@/lib/money";
import { parseQty, roundQty, toDbQty } from "@/lib/quantity";
import { decideApproval, requestApproval } from "@/server/approvals";
import { recordAudit } from "@/server/audit";
import { authorize, hasPermission, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import {
  approvals,
  customers,
  deliveryZones,
  salesOrderLines,
  salesOrders,
  salesQuotationLines,
  salesQuotations,
  stockReservations,
  warehouses,
} from "@/server/db/schema";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/server/errors";
import { withIdempotency } from "@/server/idempotency";
import {
  evaluateOrderCreditCheck,
  lockCustomerForCreditCheck,
} from "@/server/modules/finance/credit";
import { applyInventoryMovement } from "@/server/modules/inventory/ledger";
import {
  calculateAndValidateLinePricing,
  type CalculatedLinePricingResult,
} from "@/server/modules/pricing";
import { nextDocumentNumber } from "@/server/sequences";

export const NON_CANCELLABLE_SO_STATUSES = [
  "picking",
  "packed",
  "shipped",
  "delivered",
  "invoiced",
] as const;

export const quotationLineInputSchema = z.object({
  productId: z.string().min(1),
  gradeId: z.string().min(1),
  orderedUomCode: z.string().trim().min(1),
  orderedQty: z.union([z.string(), z.number()]),
  customUnitPrice: z.union([z.string(), z.number()]).optional().nullable(),
  discountPct: z.union([z.string(), z.number()]).optional(),
  taxCodeOverride: z.string().optional().nullable(),
  clientAssertedUnitPrice: z.union([z.string(), z.number()]).optional(),
  clientAssertedLineTotalAmount: z.union([z.string(), z.number()]).optional(),
  clientAssertedMarginPct: z.union([z.string(), z.number()]).optional(),
  clientAssertedUnitCostBasisBase: z.union([z.string(), z.number()]).optional(),
  notes: z.string().trim().optional().nullable(),
});

export const createSalesQuotationSchema = z.object({
  customerId: z.string().min(1),
  warehouseId: z.string().min(1),
  quoteDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal berlaku quotation wajib YYYY-MM-DD."),
  paymentTermsDays: z.number().int().min(0).optional(),
  shippingFeeAmount: z.union([z.string(), z.number()]).default("0"),
  handlingFeeAmount: z.union([z.string(), z.number()]).default("0"),
  requestMarginOverride: z.boolean().default(false),
  marginOverrideReason: z.string().trim().optional().nullable(),
  enforceProductionCostingGate: z.boolean().optional(),
  clientAssertedGrandTotalAmount: z.union([z.string(), z.number()]).optional(),
  autoSend: z.boolean().default(true),
  notes: z.string().trim().optional().nullable(),
  lines: z.array(quotationLineInputSchema).min(1, "Quotation minimal harus memiliki 1 baris item."),
});

export async function createSalesQuotation(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createSalesQuotationSchema>,
) {
  authorize(ctx, "sales.write", { warehouseId: rawInput.warehouseId });
  const parsed = createSalesQuotationSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [customer] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, data.customerId))
    .limit(1);
  if (!customer) {
    throw new NotFoundError("Pelanggan tidak ditemukan.");
  }
  if (!customer.isActive) {
    throw new BusinessRuleError(`Pelanggan '${customer.name}' berstatus nonaktif.`);
  }
  if (customer.assignedWarehouseId && customer.assignedWarehouseId !== data.warehouseId) {
    authorize(ctx, "sales.write", { warehouseId: customer.assignedWarehouseId });
  }

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, data.warehouseId))
    .limit(1);
  if (!wh) {
    throw new NotFoundError("Gudang tidak ditemukan.");
  }

  const quoteDate = data.quoteDate ?? businessDate();
  if (data.validUntil < quoteDate) {
    throw new BusinessRuleError(
      `Tanggal masa berlaku quotation (${data.validUntil}) tidak boleh sebelum tanggal dokumen (${quoteDate}).`,
    );
  }

  const shippingFeeDec = roundRupiah(parseMoney(data.shippingFeeAmount));
  const handlingFeeDec = roundRupiah(parseMoney(data.handlingFeeAmount));
  if (shippingFeeDec.lt(0) || handlingFeeDec.lt(0)) {
    throw new BusinessRuleError("Biaya pengiriman atau penanganan tidak boleh negatif.");
  }

  const calculatedLines: CalculatedLinePricingResult[] = [];
  for (const lineInput of data.lines) {
    const calc = await calculateAndValidateLinePricing(tx, {
      warehouseId: wh.id,
      customerSegment: customer.segment,
      priceTier: customer.priceTier,
      documentDate: quoteDate,
      productId: lineInput.productId,
      gradeId: lineInput.gradeId,
      orderedUomCode: lineInput.orderedUomCode,
      orderedQty: lineInput.orderedQty,
      customUnitPrice: lineInput.customUnitPrice,
      discountPct: lineInput.discountPct,
      taxCodeOverride: lineInput.taxCodeOverride,
      enforceProductionCostingGate: data.enforceProductionCostingGate,
      clientAssertedUnitPrice: lineInput.clientAssertedUnitPrice,
      clientAssertedLineTotalAmount: lineInput.clientAssertedLineTotalAmount,
      clientAssertedMarginPct: lineInput.clientAssertedMarginPct,
      clientAssertedUnitCostBasisBase: lineInput.clientAssertedUnitCostBasisBase,
      notes: lineInput.notes,
    });
    calculatedLines.push(calc);
  }

  const allMarginViolations = calculatedLines.flatMap((l) => l.marginViolationReasons);
  const requiresMarginApproval = calculatedLines.some((l) => l.isBelowMinMargin);

  if (requiresMarginApproval) {
    if (!data.requestMarginOverride) {
      throw new BusinessRuleError(
        `Kontrol Margin Quotation: ${allMarginViolations.join(" ")} Ajukan permintaan persetujuan (requestMarginOverride) dengan alasan yang sah.`,
      );
    }
    if (!data.marginOverrideReason || data.marginOverrideReason.trim().length < 3) {
      throw new BusinessRuleError(
        "Alasan pengecualian margin (marginOverrideReason) wajib diisi minimal 3 karakter.",
      );
    }
  }

  let subtotalDec = new MoneyDecimal(0);
  let discountTotalDec = new MoneyDecimal(0);
  let taxTotalDec = new MoneyDecimal(0);

  for (const l of calculatedLines) {
    subtotalDec = subtotalDec.plus(new MoneyDecimal(l.lineNetAmount));
    discountTotalDec = discountTotalDec.plus(new MoneyDecimal(l.lineDiscountAmount));
    taxTotalDec = taxTotalDec.plus(new MoneyDecimal(l.lineTaxAmount));
  }

  const grandTotalDec = roundRupiah(
    subtotalDec.plus(taxTotalDec).plus(shippingFeeDec).plus(handlingFeeDec),
  );

  if (data.clientAssertedGrandTotalAmount !== undefined) {
    const assertedGrand = roundRupiah(parseMoney(data.clientAssertedGrandTotalAmount));
    if (!assertedGrand.eq(grandTotalDec)) {
      throw new BusinessRuleError(
        `Manipulasi total dokumen terdeteksi: total dari klien (Rp ${toDbAmount(assertedGrand)}) tidak sesuai dengan perhitungan server (Rp ${toDbAmount(grandTotalDec)}).`,
      );
    }
  }

  const quotationNo = await nextDocumentNumber(tx, {
    docType: "SQ",
    warehouseCode: wh.code,
  });
  const quotationId = `sq_${crypto.randomUUID().slice(0, 8)}`;

  let marginApprovalId: string | null = null;
  if (requiresMarginApproval) {
    const app = await requestApproval(tx, ctx, {
      approvalType: "price_override",
      sourceDocType: "sales_quotation",
      sourceDocId: quotationId,
      warehouseId: wh.id,
      requestReason: data.marginOverrideReason!.trim(),
      ruleSnapshot: {
        violations: allMarginViolations,
        grandTotalAmount: toDbAmount(grandTotalDec),
      },
    });
    marginApprovalId = app.id;
  }

  const initialStatus = requiresMarginApproval
    ? "draft"
    : data.autoSend
      ? "sent"
      : "draft";

  const [createdHeader] = await tx
    .insert(salesQuotations)
    .values({
      id: quotationId,
      quotationNo,
      customerId: customer.id,
      warehouseId: wh.id,
      quoteDate,
      validUntil: data.validUntil,
      status: initialStatus,
      paymentTermsDays: data.paymentTermsDays ?? customer.paymentTermsDays,
      currency: "IDR",
      subtotalAmount: toDbAmount(subtotalDec),
      discountTotalAmount: toDbAmount(discountTotalDec),
      taxTotalAmount: toDbAmount(taxTotalDec),
      shippingFeeAmount: toDbAmount(shippingFeeDec),
      handlingFeeAmount: toDbAmount(handlingFeeDec),
      grandTotalAmount: toDbAmount(grandTotalDec),
      requiresMarginApproval,
      marginApprovalId,
      notes: data.notes ?? null,
      revisionNo: 0,
      createdBy: ctx.user.id,
    })
    .returning();

  const lineValues = calculatedLines.map((l, idx) => ({
    id: `sql_${crypto.randomUUID().slice(0, 8)}`,
    salesQuotationId: quotationId,
    lineNo: idx + 1,
    productId: l.productId,
    gradeId: l.gradeId,
    gradeCode: l.gradeCode,
    orderedUomCode: l.orderedUomCode,
    orderedQty: l.orderedQty,
    uomFactorToBaseSnapshot: l.uomFactorToBaseSnapshot,
    orderedQtyBase: l.orderedQtyBase,
    priceListId: l.priceListId,
    priceListItemId: l.priceListItemId,
    listUnitPrice: l.listUnitPrice,
    unitPrice: l.unitPrice,
    discountPct: l.discountPct,
    discountAmountPerUnit: l.discountAmountPerUnit,
    netUnitPrice: l.netUnitPrice,
    netUnitPriceBase: l.netUnitPriceBase,
    unitCostBasisBase: l.unitCostBasisBase,
    marginPct: l.marginPct,
    minMarginPctSnapshot: l.minMarginPctSnapshot,
    isBelowMinMargin: l.isBelowMinMargin,
    taxCodeSnapshot: l.taxCodeSnapshot,
    taxRatePctSnapshot: l.taxRatePctSnapshot,
    lineGrossAmount: l.lineGrossAmount,
    lineDiscountAmount: l.lineDiscountAmount,
    lineNetAmount: l.lineNetAmount,
    lineTaxAmount: l.lineTaxAmount,
    lineTotalAmount: l.lineTotalAmount,
    notes: l.notes,
  }));

  const createdLines = await tx.insert(salesQuotationLines).values(lineValues).returning();

  await recordAudit(tx, {
    ctx,
    action: "sales_quotation.create",
    entityType: "sales_quotation",
    entityId: quotationId,
    warehouseId: wh.id,
    afterData: {
      header: createdHeader,
      lines: createdLines,
    },
  });

  return {
    header: createdHeader!,
    lines: createdLines,
  };
}

export const decideSalesQuotationSchema = z.object({
  quotationId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  decisionNote: z.string().trim().min(3, "Catatan keputusan wajib diisi minimal 3 karakter."),
});

export async function decideSalesQuotation(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof decideSalesQuotationSchema>,
) {
  const parsed = decideSalesQuotationSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [sq] = await tx
    .select()
    .from(salesQuotations)
    .where(eq(salesQuotations.id, data.quotationId))
    .limit(1);
  if (!sq) {
    throw new NotFoundError("Quotation tidak ditemukan.");
  }

  authorize(ctx, "sales.write", { warehouseId: sq.warehouseId });

  if (sq.marginApprovalId) {
    const [app] = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.id, sq.marginApprovalId))
      .limit(1);
    if (app && app.status === "pending") {
      await decideApproval(tx, ctx, {
        approvalId: app.id,
        decision: data.decision,
        decisionNote: data.decisionNote,
        expectedVersion: app.version,
      });
    }
  }

  const newStatus = data.decision === "approved" ? "approved" : "rejected";
  const [updated] = await tx
    .update(salesQuotations)
    .set({
      status: newStatus,
      approvedBy: data.decision === "approved" ? ctx.user.id : null,
      approvedAt: data.decision === "approved" ? new Date() : null,
      version: sq.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(salesQuotations.id, sq.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: `sales_quotation.${newStatus}`,
    entityType: "sales_quotation",
    entityId: sq.id,
    warehouseId: sq.warehouseId,
    beforeData: sq,
    afterData: updated,
    reason: data.decisionNote,
  });

  return updated!;
}

export const createSalesOrderSchema = z.object({
  idempotencyKey: z.string().trim().min(1).optional(),
  quotationId: z.string().optional().nullable(),
  customerId: z.string().min(1),
  warehouseId: z.string().min(1),
  deliveryZoneId: z.string().optional().nullable(),
  orderDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  requestedDeliveryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  paymentTermsDays: z.number().int().min(0).optional(),
  shippingFeeAmount: z.union([z.string(), z.number()]).optional(),
  handlingFeeAmount: z.union([z.string(), z.number()]).optional(),
  reserveStockOnConfirm: z.boolean().default(true),
  minRemainingShelfLifeDays: z.number().int().min(0).default(1),
  saveAsDraft: z.boolean().default(false),
  autoConfirm: z.boolean().default(false),
  requestMarginOverride: z.boolean().default(false),
  marginOverrideReason: z.string().trim().optional().nullable(),
  requestCreditOverride: z.boolean().default(false),
  creditOverrideReason: z.string().trim().optional().nullable(),
  enforceProductionCostingGate: z.boolean().optional(),
  enforceZoneMinOrder: z.boolean().default(false),
  clientAssertedGrandTotalAmount: z.union([z.string(), z.number()]).optional(),
  notes: z.string().trim().optional().nullable(),
  lines: z.array(quotationLineInputSchema).optional(),
});

export async function createSalesOrder(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createSalesOrderSchema>,
) {
  authorize(ctx, "sales.write", { warehouseId: rawInput.warehouseId });
  const parsed = createSalesOrderSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const executeOrderCreation = async () => {
    // 1. Lock customer row FOR UPDATE first to serialize concurrent credit checks
    const lockedCustomer = await lockCustomerForCreditCheck(tx, data.customerId);
    if (!lockedCustomer.isActive) {
      throw new BusinessRuleError(`Pelanggan '${lockedCustomer.name}' sedang berstatus nonaktif.`);
    }
    if (
      lockedCustomer.assignedWarehouseId &&
      lockedCustomer.assignedWarehouseId !== data.warehouseId
    ) {
      authorize(ctx, "sales.write", { warehouseId: lockedCustomer.assignedWarehouseId });
    }

    const [customerFull] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, data.customerId))
      .limit(1);
    if (!customerFull) {
      throw new NotFoundError("Pelanggan tidak ditemukan.");
    }

    const [wh] = await tx
      .select()
      .from(warehouses)
      .where(eq(warehouses.id, data.warehouseId))
      .limit(1);
    if (!wh) {
      throw new NotFoundError("Gudang tidak ditemukan.");
    }

    const orderDate = data.orderDate ?? businessDate();
    let sourceQuotation: typeof salesQuotations.$inferSelect | null = null;
    let effectiveLinesInput = data.lines ?? [];

    if (data.quotationId) {
      const [sq] = await tx
        .select()
        .from(salesQuotations)
        .where(eq(salesQuotations.id, data.quotationId))
        .limit(1);
      if (!sq) {
        throw new NotFoundError("Quotation sumber tidak ditemukan.");
      }
      if (sq.customerId !== customerFull.id) {
        throw new BusinessRuleError(
          "Pelanggan pada Sales Order harus sama dengan pelanggan pada Quotation.",
        );
      }
      if (sq.status === "converted") {
        throw new ConflictError(`Quotation '${sq.quotationNo}' sudah dikonversi menjadi Sales Order.`);
      }
      if (sq.status === "rejected" || sq.status === "expired") {
        throw new BusinessRuleError(
          `Quotation '${sq.quotationNo}' berstatus '${sq.status}' dan tidak dapat dikonversi.`,
        );
      }
      if (sq.validUntil < orderDate) {
        throw new BusinessRuleError(
          `Quotation '${sq.quotationNo}' sudah kedaluwarsa (berlaku s/d ${sq.validUntil}, tanggal order ${orderDate}).`,
        );
      }
      if (sq.requiresMarginApproval && sq.marginApprovalId) {
        const [sqApp] = await tx
          .select()
          .from(approvals)
          .where(eq(approvals.id, sq.marginApprovalId))
          .limit(1);
        if (!sqApp || sqApp.status !== "approved") {
          throw new BusinessRuleError(
            `Quotation '${sq.quotationNo}' masih membutuhkan persetujuan margin sebelum dapat dikonversi menjadi Sales Order.`,
          );
        }
      }

      sourceQuotation = sq;
      if (!data.lines || data.lines.length === 0) {
        const sqLines = await tx
          .select()
          .from(salesQuotationLines)
          .where(eq(salesQuotationLines.salesQuotationId, sq.id))
          .orderBy(asc(salesQuotationLines.lineNo));

        effectiveLinesInput = sqLines.map((l) => ({
          productId: l.productId,
          gradeId: l.gradeId,
          orderedUomCode: l.orderedUomCode,
          orderedQty: l.orderedQty,
          customUnitPrice: l.unitPrice,
          discountPct: l.discountPct,
          taxCodeOverride: l.taxCodeSnapshot,
          notes: l.notes,
        }));
      }
    }

    if (!effectiveLinesInput || effectiveLinesInput.length === 0) {
      throw new BusinessRuleError("Sales Order wajib memiliki minimal 1 baris item.");
    }

    const calculatedLines: CalculatedLinePricingResult[] = [];
    for (const lineInput of effectiveLinesInput) {
      const calc = await calculateAndValidateLinePricing(tx, {
        warehouseId: wh.id,
        customerSegment: customerFull.segment,
        priceTier: customerFull.priceTier,
        documentDate: orderDate,
        productId: lineInput.productId,
        gradeId: lineInput.gradeId,
        orderedUomCode: lineInput.orderedUomCode,
        orderedQty: lineInput.orderedQty,
        customUnitPrice: lineInput.customUnitPrice,
        discountPct: lineInput.discountPct,
        taxCodeOverride: lineInput.taxCodeOverride,
        enforceProductionCostingGate: data.enforceProductionCostingGate,
        clientAssertedUnitPrice: lineInput.clientAssertedUnitPrice,
        clientAssertedLineTotalAmount: lineInput.clientAssertedLineTotalAmount,
        clientAssertedMarginPct: lineInput.clientAssertedMarginPct,
        clientAssertedUnitCostBasisBase: lineInput.clientAssertedUnitCostBasisBase,
        notes: lineInput.notes,
      });
      calculatedLines.push(calc);
    }

    const shippingFeeDec = roundRupiah(
      parseMoney(data.shippingFeeAmount ?? sourceQuotation?.shippingFeeAmount ?? "0"),
    );
    const handlingFeeDec = roundRupiah(
      parseMoney(data.handlingFeeAmount ?? sourceQuotation?.handlingFeeAmount ?? "0"),
    );
    if (shippingFeeDec.lt(0) || handlingFeeDec.lt(0)) {
      throw new BusinessRuleError("Biaya pengiriman atau penanganan tidak boleh negatif.");
    }

    let subtotalDec = new MoneyDecimal(0);
    let discountTotalDec = new MoneyDecimal(0);
    let taxTotalDec = new MoneyDecimal(0);

    for (const l of calculatedLines) {
      subtotalDec = subtotalDec.plus(new MoneyDecimal(l.lineNetAmount));
      discountTotalDec = discountTotalDec.plus(new MoneyDecimal(l.lineDiscountAmount));
      taxTotalDec = taxTotalDec.plus(new MoneyDecimal(l.lineTaxAmount));
    }

    const grandTotalDec = roundRupiah(
      subtotalDec.plus(taxTotalDec).plus(shippingFeeDec).plus(handlingFeeDec),
    );

    if (data.clientAssertedGrandTotalAmount !== undefined) {
      const assertedGrand = roundRupiah(parseMoney(data.clientAssertedGrandTotalAmount));
      if (!assertedGrand.eq(grandTotalDec)) {
        throw new BusinessRuleError(
          `Manipulasi total order terdeteksi: total dari klien (Rp ${toDbAmount(assertedGrand)}) tidak sesuai dengan perhitungan server (Rp ${toDbAmount(grandTotalDec)}).`,
        );
      }
    }

    const deliveryZoneId = data.deliveryZoneId ?? customerFull.deliveryZoneId ?? null;
    if (data.enforceZoneMinOrder && deliveryZoneId) {
      const [zone] = await tx
        .select()
        .from(deliveryZones)
        .where(eq(deliveryZones.id, deliveryZoneId))
        .limit(1);
      if (zone) {
        const minOrderDec = new MoneyDecimal(zone.minOrderAmount);
        if (subtotalDec.lt(minOrderDec)) {
          throw new BusinessRuleError(
            `Subtotal pesanan (Rp ${toDbAmount(subtotalDec)}) belum mencapai batas minimum order wilayah '${zone.name}' (Rp ${toDbAmount(minOrderDec)}).`,
          );
        }
      }
    }

    // 2. Margin Control Evaluation
    // If converted from an already-approved Quotation with approved margin override, carry it over
    const quotationMarginAlreadyApproved = Boolean(
      sourceQuotation?.requiresMarginApproval && sourceQuotation?.marginApprovalId,
    );
    const allMarginViolations = calculatedLines.flatMap((l) => l.marginViolationReasons);
    const hasMarginViolation = calculatedLines.some((l) => l.isBelowMinMargin);
    const requiresMarginApproval = hasMarginViolation && !quotationMarginAlreadyApproved;

    if (requiresMarginApproval && !data.saveAsDraft) {
      if (!data.requestMarginOverride) {
        throw new BusinessRuleError(
          `Kontrol Margin: ${allMarginViolations.join(" ")} Penjualan di bawah batas minimum margin membutuhkan persetujuan (requestMarginOverride).`,
        );
      }
      if (!data.marginOverrideReason || data.marginOverrideReason.trim().length < 3) {
        throw new BusinessRuleError(
          "Alasan pengecualian margin (marginOverrideReason) wajib diisi minimal 3 karakter.",
        );
      }
    }

    // 3. Credit Control Evaluation (Customer row is already locked FOR UPDATE)
    const paymentTermsDays =
      data.paymentTermsDays ?? sourceQuotation?.paymentTermsDays ?? customerFull.paymentTermsDays;
    const isCreditOrder = paymentTermsDays > 0;

    const creditEvaluation = await evaluateOrderCreditCheck(tx, {
      customerId: customerFull.id,
      orderGrandTotal: grandTotalDec,
      isCreditOrder,
      lockCustomerRow: false,
    });

    const requiresCreditApproval = creditEvaluation.requiresCreditApproval;
    if (requiresCreditApproval && !data.saveAsDraft) {
      if (!data.requestCreditOverride) {
        throw new BusinessRuleError(
          `Kontrol Kredit: ${creditEvaluation.violationReasons.join(" ")} Order ditolak karena melebihi batas kredit yang tersedia.`,
        );
      }
      if (!data.creditOverrideReason || data.creditOverrideReason.trim().length < 3) {
        throw new BusinessRuleError(
          "Alasan pengecualian batas kredit (creditOverrideReason) wajib diisi minimal 3 karakter.",
        );
      }
    }

    const soNumber = await nextDocumentNumber(tx, {
      docType: "SO",
      warehouseCode: wh.code,
    });
    const soId = `so_${crypto.randomUUID().slice(0, 8)}`;

    let marginApprovalId: string | null = quotationMarginAlreadyApproved
      ? sourceQuotation!.marginApprovalId
      : null;
    if (requiresMarginApproval && !data.saveAsDraft) {
      const app = await requestApproval(tx, ctx, {
        approvalType: "price_override",
        sourceDocType: "sales_order",
        sourceDocId: soId,
        warehouseId: wh.id,
        requestReason: data.marginOverrideReason!.trim(),
        ruleSnapshot: {
          violations: allMarginViolations,
          grandTotalAmount: toDbAmount(grandTotalDec),
        },
      });
      marginApprovalId = app.id;
    }

    let creditApprovalId: string | null = null;
    if (requiresCreditApproval && !data.saveAsDraft) {
      const app = await requestApproval(tx, ctx, {
        approvalType: "credit_limit_override",
        sourceDocType: "sales_order",
        sourceDocId: soId,
        warehouseId: wh.id,
        requestReason: data.creditOverrideReason!.trim(),
        ruleSnapshot: {
          violations: creditEvaluation.violationReasons,
          exposureBeforeOrder: creditEvaluation.exposureBeforeOrder,
          projectedNetExposure: creditEvaluation.projectedNetExposure,
          orderGrandTotal: toDbAmount(grandTotalDec),
        },
      });
      creditApprovalId = app.id;
    }

    const initialStatus = data.saveAsDraft
      ? "draft"
      : requiresMarginApproval || requiresCreditApproval
        ? "pending_approval"
        : "submitted";

    const [createdHeader] = await tx
      .insert(salesOrders)
      .values({
        id: soId,
        soNumber,
        quotationId: sourceQuotation?.id ?? null,
        customerId: customerFull.id,
        warehouseId: wh.id,
        deliveryZoneId,
        orderDate,
        requestedDeliveryDate: data.requestedDeliveryDate ?? null,
        status: initialStatus,
        paymentTermsDays,
        isCreditOrder,
        shippingAddressSnapshot: customerFull.shippingAddress,
        customerSegmentSnapshot: customerFull.segment,
        priceTierSnapshot: customerFull.priceTier,
        currency: "IDR",
        subtotalAmount: toDbAmount(subtotalDec),
        discountTotalAmount: toDbAmount(discountTotalDec),
        taxTotalAmount: toDbAmount(taxTotalDec),
        shippingFeeAmount: toDbAmount(shippingFeeDec),
        handlingFeeAmount: toDbAmount(handlingFeeDec),
        grandTotalAmount: toDbAmount(grandTotalDec),
        requiresMarginApproval: hasMarginViolation,
        marginApprovalId,
        requiresCreditApproval,
        creditApprovalId,
        reserveStockOnConfirm: data.reserveStockOnConfirm,
        isStockReserved: false,
        isInvoiced: false,
        minRemainingShelfLifeDays: data.minRemainingShelfLifeDays,
        notes: data.notes ?? null,
        createdBy: ctx.user.id,
      })
      .returning();

    const lineValues = calculatedLines.map((l, idx) => ({
      id: `sol_${crypto.randomUUID().slice(0, 8)}`,
      salesOrderId: soId,
      lineNo: idx + 1,
      productId: l.productId,
      gradeId: l.gradeId,
      gradeCode: l.gradeCode,
      orderedUomCode: l.orderedUomCode,
      orderedQty: l.orderedQty,
      uomFactorToBaseSnapshot: l.uomFactorToBaseSnapshot,
      orderedQtyBase: l.orderedQtyBase,
      reservedQtyBase: "0.000",
      fulfilledQtyBase: "0.000",
      priceListId: l.priceListId,
      priceListItemId: l.priceListItemId,
      listUnitPrice: l.listUnitPrice,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      discountAmountPerUnit: l.discountAmountPerUnit,
      netUnitPrice: l.netUnitPrice,
      netUnitPriceBase: l.netUnitPriceBase,
      unitCostBasisBase: l.unitCostBasisBase,
      marginPct: l.marginPct,
      minMarginPctSnapshot: l.minMarginPctSnapshot,
      isBelowMinMargin: l.isBelowMinMargin,
      taxCodeSnapshot: l.taxCodeSnapshot,
      taxRatePctSnapshot: l.taxRatePctSnapshot,
      lineGrossAmount: l.lineGrossAmount,
      lineDiscountAmount: l.lineDiscountAmount,
      lineNetAmount: l.lineNetAmount,
      lineTaxAmount: l.lineTaxAmount,
      lineTotalAmount: l.lineTotalAmount,
      notes: l.notes,
    }));

    const createdLines = await tx.insert(salesOrderLines).values(lineValues).returning();

    if (sourceQuotation) {
      await tx
        .update(salesQuotations)
        .set({
          status: "converted",
          version: sourceQuotation.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(salesQuotations.id, sourceQuotation.id));
    }

    await recordAudit(tx, {
      ctx,
      action: "sales_order.create",
      entityType: "sales_order",
      entityId: soId,
      warehouseId: wh.id,
      afterData: {
        header: createdHeader,
        lines: createdLines,
        creditEvaluation,
      },
    });

    if (data.autoConfirm && initialStatus === "submitted") {
      return confirmSalesOrder(tx, ctx, {
        salesOrderId: soId,
      });
    }

    return {
      header: createdHeader!,
      lines: createdLines,
      reservations: [] as Array<typeof stockReservations.$inferSelect>,
      creditEvaluation,
    };
  };

  if (data.idempotencyKey) {
    const idem = await withIdempotency(
      tx,
      {
        scope: "sales.order.create",
        key: data.idempotencyKey,
        payload: {
          quotationId: data.quotationId ?? null,
          customerId: data.customerId,
          warehouseId: data.warehouseId,
          orderDate: data.orderDate ?? null,
          paymentTermsDays: data.paymentTermsDays ?? null,
          shippingFeeAmount: data.shippingFeeAmount ?? "0",
          handlingFeeAmount: data.handlingFeeAmount ?? "0",
          lines: (data.lines ?? []).map((l) => ({
            productId: l.productId,
            gradeId: l.gradeId,
            orderedUomCode: l.orderedUomCode,
            orderedQty: String(l.orderedQty),
            customUnitPrice: l.customUnitPrice !== undefined ? String(l.customUnitPrice) : null,
            discountPct: l.discountPct !== undefined ? String(l.discountPct) : "0",
          })),
        },
        actorUserId: ctx.user.id,
      },
      executeOrderCreation,
    );
    return idem.result;
  }

  return executeOrderCreation();
}

export const decideSalesOrderApprovalSchema = z.object({
  salesOrderId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  decisionNote: z.string().trim().min(3, "Alasan persetujuan/penolakan wajib diisi minimal 3 karakter."),
  autoConfirmAfterApproval: z.boolean().default(false),
});

export async function decideSalesOrderApproval(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof decideSalesOrderApprovalSchema>,
) {
  const parsed = decideSalesOrderApprovalSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [so] = await tx
    .select()
    .from(salesOrders)
    .where(eq(salesOrders.id, data.salesOrderId))
    .limit(1);
  if (!so) {
    throw new NotFoundError("Sales Order tidak ditemukan.");
  }

  authorize(ctx, "approvals.decide", { warehouseId: so.warehouseId });

  if (so.status !== "pending_approval") {
    throw new BusinessRuleError(
      `Sales Order '${so.soNumber}' tidak sedang dalam status menunggu persetujuan (status saat ini: ${so.status}).`,
    );
  }

  const approvalIds = [so.marginApprovalId, so.creditApprovalId].filter(
    (id): id is string => Boolean(id),
  );
  if (approvalIds.length === 0) {
    throw new BusinessRuleError("Tidak ada dokumen persetujuan tertaut pada Sales Order ini.");
  }

  const decidedApprovals = [];
  for (const appId of approvalIds) {
    const [app] = await tx.select().from(approvals).where(eq(approvals.id, appId)).limit(1);
    if (app && app.status === "pending") {
      const dec = await decideApproval(tx, ctx, {
        approvalId: app.id,
        decision: data.decision,
        decisionNote: data.decisionNote,
        expectedVersion: app.version,
      });
      decidedApprovals.push(dec);
    }
  }

  const newStatus = data.decision === "approved" ? "submitted" : "rejected";
  const [updated] = await tx
    .update(salesOrders)
    .set({
      status: newStatus,
      version: so.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(salesOrders.id, so.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: `sales_order.approval_${data.decision}`,
    entityType: "sales_order",
    entityId: so.id,
    warehouseId: so.warehouseId,
    beforeData: so,
    afterData: updated,
    reason: data.decisionNote,
  });

  if (data.decision === "approved" && data.autoConfirmAfterApproval) {
    return confirmSalesOrder(tx, ctx, {
      salesOrderId: so.id,
    });
  }

  const lines = await tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.salesOrderId, so.id))
    .orderBy(asc(salesOrderLines.lineNo));

  return {
    header: updated!,
    lines,
    reservations: [] as Array<typeof stockReservations.$inferSelect>,
    decidedApprovals,
  };
}

export const confirmSalesOrderSchema = z.object({
  salesOrderId: z.string().min(1),
});

/**
 * Confirms a Sales Order (`submitted` or `draft` -> `confirmed`) and, when
 * `reserveStockOnConfirm === true`, atomically reserves FEFO inventory (`available` -> `reserved`)
 * without deducting physical warehouse stock.
 */
export async function confirmSalesOrder(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof confirmSalesOrderSchema>,
) {
  const parsed = confirmSalesOrderSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  // Lock sales_orders row FOR UPDATE
  const lockSoRes = await tx.execute<{ id: string }>(sql`
    SELECT id FROM sales_orders WHERE id = ${data.salesOrderId} FOR UPDATE
  `);
  if (!lockSoRes.rows[0]) {
    throw new NotFoundError("Sales Order tidak ditemukan.");
  }

  const [so] = await tx
    .select()
    .from(salesOrders)
    .where(eq(salesOrders.id, data.salesOrderId))
    .limit(1);
  if (!so) {
    throw new NotFoundError("Sales Order tidak ditemukan.");
  }

  authorize(ctx, "sales.write", { warehouseId: so.warehouseId });

  if (so.status === "confirmed") {
    const existingLines = await tx
      .select()
      .from(salesOrderLines)
      .where(eq(salesOrderLines.salesOrderId, so.id))
      .orderBy(asc(salesOrderLines.lineNo));
    const existingRes = await tx
      .select()
      .from(stockReservations)
      .where(
        and(
          eq(stockReservations.sourceDocType, "sales_order"),
          eq(stockReservations.sourceDocId, so.id),
          eq(stockReservations.status, "active"),
        ),
      );
    return {
      header: so,
      lines: existingLines,
      reservations: existingRes,
    };
  }

  if (so.status === "pending_approval") {
    throw new BusinessRuleError(
      `Sales Order '${so.soNumber}' masih berstatus 'pending_approval'. Persetujuan margin/kredit wajib diselesaikan terlebih dahulu.`,
    );
  }

  if (so.status !== "submitted" && so.status !== "draft") {
    throw new BusinessRuleError(
      `Sales Order '${so.soNumber}' berstatus '${so.status}' dan tidak dapat dikonfirmasi.`,
    );
  }

  // Verify required approvals
  if (so.requiresMarginApproval) {
    if (!so.marginApprovalId) {
      throw new BusinessRuleError("Sales Order dengan pelanggaran margin wajib memiliki persetujuan.");
    }
    const [mApp] = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.id, so.marginApprovalId))
      .limit(1);
    if (!mApp || mApp.status !== "approved") {
      throw new BusinessRuleError("Persetujuan pengecualian margin belum disetujui.");
    }
  }

  let hasApprovedCreditOverride = false;
  if (so.requiresCreditApproval) {
    if (!so.creditApprovalId) {
      throw new BusinessRuleError("Sales Order yang melebihi batas kredit wajib memiliki persetujuan.");
    }
    const [cApp] = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.id, so.creditApprovalId))
      .limit(1);
    if (!cApp || cApp.status !== "approved") {
      throw new BusinessRuleError("Persetujuan pengecualian batas kredit belum disetujui.");
    }
    hasApprovedCreditOverride = true;
  }

  // Re-verify credit exposure under FOR UPDATE customer lock if not overridden
  await lockCustomerForCreditCheck(tx, so.customerId);
  if (so.isCreditOrder && !hasApprovedCreditOverride) {
    const creditEval = await evaluateOrderCreditCheck(tx, {
      customerId: so.customerId,
      orderGrandTotal: new MoneyDecimal(so.grandTotalAmount),
      isCreditOrder: true,
      excludeSalesOrderId: so.id,
      lockCustomerRow: false,
    });
    if (!creditEval.allowedWithoutOverride) {
      throw new BusinessRuleError(
        `Kontrol Kredit saat Konfirmasi: ${creditEval.violationReasons.join(" ")}`,
      );
    }
  }

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, so.warehouseId))
    .limit(1);
  if (!wh) {
    throw new NotFoundError("Gudang tidak ditemukan.");
  }

  const lines = await tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.salesOrderId, so.id))
    .orderBy(asc(salesOrderLines.lineNo));

  const createdReservations: Array<typeof stockReservations.$inferSelect> = [];

  if (so.reserveStockOnConfirm) {
    const baseDateStr = so.orderDate ?? businessDate();
    let minBestBeforeDate = baseDateStr;
    if (so.minRemainingShelfLifeDays > 0) {
      const d = new Date(`${baseDateStr}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + so.minRemainingShelfLifeDays);
      minBestBeforeDate = d.toISOString().slice(0, 10);
    }

    for (const line of lines) {
      const neededQtyBase = roundQty(parseQty(line.orderedQtyBase));

      // Lock eligible available stock_balances rows in deterministic FEFO order
      const lockBalancesRes = await tx.execute<{
        balance_id: string;
        location_id: string;
        batch_id: string;
        batch_code: string;
        product_id: string;
        grade_id: string;
        best_before_date: string;
        qty_base: string;
        unit_cost_base: string;
      }>(sql`
        SELECT
          sb.id AS balance_id,
          sb.location_id,
          sb.batch_id,
          b.batch_code,
          sb.product_id,
          sb.grade_id,
          b.best_before_date,
          sb.qty_base,
          sb.unit_cost_base
        FROM stock_balances sb
        INNER JOIN batches b ON b.id = sb.batch_id
        INNER JOIN warehouse_locations wl ON wl.id = sb.location_id
        WHERE sb.warehouse_id = ${so.warehouseId}
          AND sb.product_id = ${line.productId}
          AND sb.grade_id = ${line.gradeId}
          AND sb.stock_status = 'available'
          AND sb.qty_base > 0
          AND b.status = 'active'
          AND b.best_before_date >= ${minBestBeforeDate}
          AND wl.zone_type IN ('cold_room', 'ambient', 'dispatch')
        ORDER BY
          b.best_before_date ASC,
          b.received_at ASC,
          b.batch_code ASC,
          sb.location_id ASC
        FOR UPDATE OF sb
      `);

      let totalAvailable = new MoneyDecimal(0);
      for (const bRow of lockBalancesRes.rows) {
        totalAvailable = totalAvailable.plus(parseQty(bRow.qty_base));
      }

      if (totalAvailable.lt(neededQtyBase)) {
        throw new BusinessRuleError(
          `Stok FEFO tersedia tidak mencukupi untuk reservasi produk '${line.productId}' Grade ${line.gradeCode}: dibutuhkan ${toDbQty(neededQtyBase)}, tersedia ${toDbQty(totalAvailable)}.`,
        );
      }

      let remainingToReserve = neededQtyBase;
      for (const bRow of lockBalancesRes.rows) {
        if (remainingToReserve.lte(0)) break;
        const avail = roundQty(parseQty(bRow.qty_base));
        if (avail.lte(0)) continue;

        const takeQty = remainingToReserve.lte(avail) ? remainingToReserve : avail;

        // 1. Outflow from `available` via `reservation_hold`
        const holdOut = await applyInventoryMovement(tx, ctx, {
          warehouseId: so.warehouseId,
          warehouseCode: wh.code,
          locationId: bRow.location_id,
          batchId: bRow.batch_id,
          productId: bRow.product_id,
          gradeId: bRow.grade_id,
          stockStatus: "available",
          movementType: "reservation_hold",
          qtyDeltaBase: toDbQty(takeQty.negated()),
          sourceDocType: "sales_order",
          sourceDocId: so.id,
          sourceLineId: line.id,
          notes: `Reservasi stok FEFO untuk SO ${so.soNumber} (keluar dari available)`,
        });

        const exactTransferredCost = new MoneyDecimal(holdOut.movement.costDelta).abs();

        // 2. Inflow to `reserved` via `reservation_hold` at exact same cost (physical stock unchanged)
        await applyInventoryMovement(tx, ctx, {
          warehouseId: so.warehouseId,
          warehouseCode: wh.code,
          locationId: bRow.location_id,
          batchId: bRow.batch_id,
          productId: bRow.product_id,
          gradeId: bRow.grade_id,
          stockStatus: "reserved",
          movementType: "reservation_hold",
          qtyDeltaBase: toDbQty(takeQty),
          unitCostBase: bRow.unit_cost_base,
          explicitInflowCost: toDbAmount(exactTransferredCost),
          sourceDocType: "sales_order",
          sourceDocId: so.id,
          sourceLineId: line.id,
          notes: `Reservasi stok FEFO untuk SO ${so.soNumber} (masuk ke reserved)`,
        });

        // 3. Record active row in stock_reservations
        const [resRow] = await tx
          .insert(stockReservations)
          .values({
            id: `sres_${crypto.randomUUID().slice(0, 8)}`,
            warehouseId: so.warehouseId,
            locationId: bRow.location_id,
            batchId: bRow.batch_id,
            productId: bRow.product_id,
            gradeId: bRow.grade_id,
            sourceDocType: "sales_order",
            sourceDocId: so.id,
            reservedQtyBase: toDbQty(takeQty),
            status: "active",
            createdBy: ctx.user.id,
          })
          .returning();

        createdReservations.push(resRow!);
        remainingToReserve = roundQty(remainingToReserve.minus(takeQty));
      }

      await tx
        .update(salesOrderLines)
        .set({ reservedQtyBase: toDbQty(neededQtyBase) })
        .where(eq(salesOrderLines.id, line.id));
    }
  }

  const [updatedHeader] = await tx
    .update(salesOrders)
    .set({
      status: "confirmed",
      isStockReserved: so.reserveStockOnConfirm,
      confirmedBy: ctx.user.id,
      confirmedAt: new Date(),
      version: so.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(salesOrders.id, so.id))
    .returning();

  const updatedLines = await tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.salesOrderId, so.id))
    .orderBy(asc(salesOrderLines.lineNo));

  await recordAudit(tx, {
    ctx,
    action: "sales_order.confirm",
    entityType: "sales_order",
    entityId: so.id,
    warehouseId: so.warehouseId,
    beforeData: so,
    afterData: {
      header: updatedHeader,
      reservations: createdReservations,
    },
  });

  return {
    header: updatedHeader!,
    lines: updatedLines,
    reservations: createdReservations,
  };
}

export const cancelSalesOrderSchema = z.object({
  salesOrderId: z.string().min(1),
  cancelReason: z.string().trim().min(3, "Alasan pembatalan Sales Order wajib diisi minimal 3 karakter."),
});

/**
 * Cancels a Sales Order and atomically releases any active FEFO stock reservations
 * (`reserved` -> `available`).
 * Strictly blocks cancellation if the order has already entered picking, packing,
 * shipping, delivery, or invoicing.
 */
export async function cancelSalesOrder(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof cancelSalesOrderSchema>,
) {
  const parsed = cancelSalesOrderSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const lockSoRes = await tx.execute<{ id: string }>(sql`
    SELECT id FROM sales_orders WHERE id = ${data.salesOrderId} FOR UPDATE
  `);
  if (!lockSoRes.rows[0]) {
    throw new NotFoundError("Sales Order tidak ditemukan.");
  }

  const [so] = await tx
    .select()
    .from(salesOrders)
    .where(eq(salesOrders.id, data.salesOrderId))
    .limit(1);
  if (!so) {
    throw new NotFoundError("Sales Order tidak ditemukan.");
  }

  authorize(ctx, "sales.write", { warehouseId: so.warehouseId });

  if (so.status === "cancelled") {
    throw new BusinessRuleError(`Sales Order '${so.soNumber}' sudah dibatalkan sebelumnya.`);
  }

  if (
    (NON_CANCELLABLE_SO_STATUSES as readonly string[]).includes(so.status) ||
    so.isInvoiced
  ) {
    throw new BusinessRuleError(
      `Sales Order '${so.soNumber}' berstatus '${so.status}' sudah melewati batas operasional pembatalan (picking/packing/pengiriman/invoice) dan tidak dapat dibatalkan.`,
    );
  }

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, so.warehouseId))
    .limit(1);
  if (!wh) {
    throw new NotFoundError("Gudang tidak ditemukan.");
  }

  const activeReservations = await tx
    .select()
    .from(stockReservations)
    .where(
      and(
        eq(stockReservations.sourceDocType, "sales_order"),
        eq(stockReservations.sourceDocId, so.id),
        eq(stockReservations.status, "active"),
      ),
    );

  const releasedReservations: Array<typeof stockReservations.$inferSelect> = [];
  for (const res of activeReservations) {
    const qtyToRelease = roundQty(parseQty(res.reservedQtyBase));

    // 1. Outflow from `reserved` via `reservation_release`
    const relOut = await applyInventoryMovement(tx, ctx, {
      warehouseId: so.warehouseId,
      warehouseCode: wh.code,
      locationId: res.locationId,
      batchId: res.batchId,
      productId: res.productId,
      gradeId: res.gradeId,
      stockStatus: "reserved",
      movementType: "reservation_release",
      qtyDeltaBase: toDbQty(qtyToRelease.negated()),
      sourceDocType: "sales_order",
      sourceDocId: so.id,
      reasonCode: "SO_CANCELLED",
      notes: `Pelepasan reservasi stok karena pembatalan SO ${so.soNumber}: ${data.cancelReason}`,
    });

    const exactReleasedCost = new MoneyDecimal(relOut.movement.costDelta).abs();

    // 2. Inflow back to `available` via `reservation_release` at exact same cost
    await applyInventoryMovement(tx, ctx, {
      warehouseId: so.warehouseId,
      warehouseCode: wh.code,
      locationId: res.locationId,
      batchId: res.batchId,
      productId: res.productId,
      gradeId: res.gradeId,
      stockStatus: "available",
      movementType: "reservation_release",
      qtyDeltaBase: toDbQty(qtyToRelease),
      unitCostBase: relOut.movement.unitCostBase,
      explicitInflowCost: toDbAmount(exactReleasedCost),
      sourceDocType: "sales_order",
      sourceDocId: so.id,
      reasonCode: "SO_CANCELLED",
      notes: `Pengembalian stok ke available karena pembatalan SO ${so.soNumber}: ${data.cancelReason}`,
    });

    const [updatedRes] = await tx
      .update(stockReservations)
      .set({
        status: "released",
        updatedAt: new Date(),
      })
      .where(eq(stockReservations.id, res.id))
      .returning();

    releasedReservations.push(updatedRes!);
  }

  await tx
    .update(salesOrderLines)
    .set({ reservedQtyBase: "0.000" })
    .where(eq(salesOrderLines.salesOrderId, so.id));

  const [updatedHeader] = await tx
    .update(salesOrders)
    .set({
      status: "cancelled",
      isStockReserved: false,
      cancelReason: data.cancelReason,
      cancelledBy: ctx.user.id,
      cancelledAt: new Date(),
      version: so.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(salesOrders.id, so.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "sales_order.cancel",
    entityType: "sales_order",
    entityId: so.id,
    warehouseId: so.warehouseId,
    beforeData: so,
    afterData: {
      header: updatedHeader,
      releasedReservations,
    },
    reason: data.cancelReason,
  });

  return {
    header: updatedHeader!,
    releasedReservations,
  };
}

export const transitionFulfillmentStatusSchema = z.object({
  salesOrderId: z.string().min(1),
  nextStatus: z.enum(["picking", "packed", "shipped", "delivered"]),
});

export async function transitionSalesOrderFulfillmentStatus(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof transitionFulfillmentStatusSchema>,
) {
  const parsed = transitionFulfillmentStatusSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [so] = await tx
    .select()
    .from(salesOrders)
    .where(eq(salesOrders.id, data.salesOrderId))
    .limit(1);
  if (!so) {
    throw new NotFoundError("Sales Order tidak ditemukan.");
  }

  authorize(ctx, "fulfillment.pick_pack", { warehouseId: so.warehouseId });

  const allowedFrom: Record<string, string[]> = {
    picking: ["confirmed"],
    packed: ["picking"],
    shipped: ["packed"],
    delivered: ["shipped"],
  };

  if (!allowedFrom[data.nextStatus]?.includes(so.status)) {
    throw new BusinessRuleError(
      `Transisi status Sales Order dari '${so.status}' ke '${data.nextStatus}' tidak diizinkan.`,
    );
  }

  const [updated] = await tx
    .update(salesOrders)
    .set({
      status: data.nextStatus,
      version: so.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(salesOrders.id, so.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: `sales_order.status_${data.nextStatus}`,
    entityType: "sales_order",
    entityId: so.id,
    warehouseId: so.warehouseId,
    beforeData: so,
    afterData: updated,
  });

  return updated!;
}

export async function listSalesQuotationsAndOrders(db: DbExecutor, ctx: ActorContext) {
  if (!hasPermission(ctx, "sales.read") && !hasPermission(ctx, "customer.read")) {
    authorize(ctx, "sales.read");
  }

  const quotations = await db
    .select()
    .from(salesQuotations)
    .orderBy(desc(salesQuotations.createdAt))
    .limit(100);
  const quotationLines = await db
    .select()
    .from(salesQuotationLines)
    .orderBy(asc(salesQuotationLines.lineNo));

  const orders = await db
    .select()
    .from(salesOrders)
    .orderBy(desc(salesOrders.createdAt))
    .limit(100);
  const orderLines = await db
    .select()
    .from(salesOrderLines)
    .orderBy(asc(salesOrderLines.lineNo));

  const reservations = await db
    .select()
    .from(stockReservations)
    .orderBy(desc(stockReservations.createdAt))
    .limit(200);

  return {
    quotations,
    quotationLines,
    orders,
    orderLines,
    reservations,
  };
}
