import crypto from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { businessDate } from "@/lib/datetime";
import {
  MoneyDecimal,
  parseMoney,
  roundRupiah,
  roundUnitPrice,
  toDbAmount,
  toDbUnitPrice,
} from "@/lib/money";
import { parseQty, roundQty, toDbQty } from "@/lib/quantity";
import { requestApproval } from "@/server/approvals";
import { recordAudit } from "@/server/audit";
import { authorize, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import {
  approvals,
  batches,
  goodsReceiptLines,
  goodsReceipts,
  gradingResults,
  inventoryMovements,
  landedCosts,
  packagingTypes,
  productGrades,
  products,
  purchaseOrderLines,
  purchaseOrders,
  qualityInspections,
  suppliers,
  warehouses,
  weighings,
} from "@/server/db/schema";
import { BusinessRuleError, NotFoundError } from "@/server/errors";
import { withIdempotency } from "@/server/idempotency";
import { GL_ACCOUNT_CODES, postJournalEntry } from "@/server/modules/gl";
import {
  calculateGradingAndYield,
  calculateWeighing,
  type GradeSplitInput,
  type RejectSplitInput,
} from "@/server/modules/inventory/costing";
import { applyInventoryMovement } from "@/server/modules/inventory/ledger";
import { nextDocumentNumber } from "@/server/sequences";

export interface CreateGoodsReceiptLineInput {
  purchaseOrderLineId?: string;
  productId: string;
  receivedUomCode?: string;
  packageCount?: number;
  packagingTypeId?: string;
  actualUnitCostBase?: string | number;
  notes?: string;
}

export interface CreateGoodsReceiptLandedCostInput {
  costType: "freight" | "unloading" | "ice_cooling" | "packaging" | "other";
  description: string;
  amount: string | number;
}

export interface CreateGoodsReceiptInput {
  purchaseOrderId: string;
  receivingLocationId: string;
  putawayLocationId: string;
  quarantineLocationId?: string;
  supplierDeliveryNoteNo: string;
  supplierLotRef?: string;
  vehiclePlateNo?: string;
  driverName?: string;
  receivedAt?: Date;
  harvestedAt?: Date;
  arrivalTempC?: string | number;
  notes?: string;
  lines: CreateGoodsReceiptLineInput[];
  landedCosts?: CreateGoodsReceiptLandedCostInput[];
}

export async function createGoodsReceipt(
  tx: DbExecutor,
  ctx: ActorContext,
  input: CreateGoodsReceiptInput,
) {
  if (!input.supplierDeliveryNoteNo?.trim()) {
    throw new BusinessRuleError("Nomor surat jalan supplier wajib diisi.");
  }
  if (!input.lines || input.lines.length === 0) {
    throw new BusinessRuleError("Dokumen penerimaan barang (GRN) wajib memiliki minimal 1 baris.");
  }

  const [po] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, input.purchaseOrderId))
    .limit(1);
  if (!po) throw new NotFoundError("Purchase Order (PO) tidak ditemukan.");

  authorize(ctx, "receiving.write", { warehouseId: po.warehouseId });

  if (po.status !== "approved" && po.status !== "partially_received") {
    throw new BusinessRuleError(
      `Penerimaan barang hanya dapat dibuat untuk PO berstatus 'approved' atau 'partially_received' (status PO saat ini: '${po.status}').`,
    );
  }

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, po.warehouseId))
    .limit(1);
  if (!wh) throw new NotFoundError("Gudang tidak ditemukan.");

  const poLines = await tx
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id));
  const poLineMap = new Map(poLines.map((l) => [l.id, l]));

  const grnId = `grn_${crypto.randomUUID()}`;
  const grnNumber = await nextDocumentNumber(tx, {
    docType: "GRN",
    warehouseCode: wh.code,
  });

  const preparedLines = [];
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i]!;
    const [product] = await tx
      .select()
      .from(products)
      .where(eq(products.id, l.productId))
      .limit(1);
    if (!product || !product.isActive) {
      throw new NotFoundError(`Produk ${l.productId} tidak ditemukan atau tidak aktif.`);
    }

    const poLine = l.purchaseOrderLineId ? poLineMap.get(l.purchaseOrderLineId) : undefined;
    if (l.purchaseOrderLineId && !poLine) {
      throw new NotFoundError(
        `Baris PO ${l.purchaseOrderLineId} tidak ditemukan pada PO ${po.poNumber}.`,
      );
    }

    const isSubstitution = !poLine || poLine.productId !== product.id;
    const unitCost =
      l.actualUnitCostBase !== undefined
        ? roundUnitPrice(parseMoney(l.actualUnitCostBase))
        : poLine
          ? roundUnitPrice(new MoneyDecimal(poLine.unitPriceBase))
          : new MoneyDecimal(0);

    if (unitCost.lt(0)) {
      throw new BusinessRuleError("Harga beli aktual tidak boleh negatif.");
    }

    preparedLines.push({
      id: `grnl_${crypto.randomUUID()}`,
      goodsReceiptId: grnId,
      lineNo: i + 1,
      purchaseOrderLineId: poLine?.id ?? null,
      productId: product.id,
      isSubstitution,
      receivedUomCode: (l.receivedUomCode ?? product.baseUomCode).trim().toLowerCase(),
      packageCount: l.packageCount ?? 0,
      packagingTypeId: l.packagingTypeId ?? null,
      actualUnitCostBase: toDbUnitPrice(unitCost),
      notes: l.notes ?? null,
    });
  }

  const [createdHeader] = await tx
    .insert(goodsReceipts)
    .values({
      id: grnId,
      grnNumber,
      purchaseOrderId: po.id,
      supplierId: po.supplierId,
      warehouseId: po.warehouseId,
      receivingLocationId: input.receivingLocationId,
      putawayLocationId: input.putawayLocationId,
      quarantineLocationId: input.quarantineLocationId ?? null,
      supplierDeliveryNoteNo: input.supplierDeliveryNoteNo.trim(),
      supplierLotRef: input.supplierLotRef?.trim() ?? null,
      vehiclePlateNo: input.vehiclePlateNo?.trim() ?? null,
      driverName: input.driverName?.trim() ?? null,
      receivedAt: input.receivedAt ?? new Date(),
      harvestedAt: input.harvestedAt ?? null,
      arrivalTempC:
        input.arrivalTempC !== undefined
          ? new MoneyDecimal(input.arrivalTempC.toString()).toFixed(1)
          : null,
      status: "draft",
      notes: input.notes ?? null,
      receivedBy: ctx.user.id,
    })
    .returning();

  const createdLines = await tx
    .insert(goodsReceiptLines)
    .values(preparedLines)
    .returning();

  const createdLandedCosts = [];
  for (const lc of input.landedCosts ?? []) {
    const amt = roundRupiah(parseMoney(lc.amount));
    if (amt.lte(0)) {
      throw new BusinessRuleError("Biaya perolehan tambahan (landed cost) harus lebih dari 0.");
    }
    const [row] = await tx
      .insert(landedCosts)
      .values({
        id: `lc_${crypto.randomUUID()}`,
        goodsReceiptId: grnId,
        costType: lc.costType,
        description: lc.description.trim(),
        amount: toDbAmount(amt),
        createdBy: ctx.user.id,
      })
      .returning();
    createdLandedCosts.push(row!);
  }

  await recordAudit(tx, {
    ctx,
    action: "receiving.grn_create",
    entityType: "goods_receipt",
    entityId: grnId,
    warehouseId: po.warehouseId,
    afterData: {
      header: createdHeader,
      lines: createdLines,
      landedCosts: createdLandedCosts,
    },
  });

  return {
    header: createdHeader!,
    lines: createdLines,
    landedCosts: createdLandedCosts,
  };
}

export interface RecordWeighingInput {
  goodsReceiptLineId: string;
  grossWeightKg: string | number;
  tareSource: "packaging_rule" | "measured_actual";
  packagingTypeId?: string;
  packageCount?: number;
  measuredTareWeightKg?: string | number;
  scaleTicketRef?: string;
}

/**
 * Records a scale weighing (`bruto`, `tara`, `neto`) on a GRN line and updates the line's weight totals.
 */
export async function recordWeighing(
  tx: DbExecutor,
  ctx: ActorContext,
  input: RecordWeighingInput,
) {
  const [line] = await tx
    .select()
    .from(goodsReceiptLines)
    .where(eq(goodsReceiptLines.id, input.goodsReceiptLineId))
    .limit(1);
  if (!line) throw new NotFoundError("Baris penerimaan barang (GRN Line) tidak ditemukan.");

  const [grn] = await tx
    .select()
    .from(goodsReceipts)
    .where(eq(goodsReceipts.id, line.goodsReceiptId))
    .limit(1);
  if (!grn) throw new NotFoundError("Dokumen GRN tidak ditemukan.");

  authorize(ctx, "receiving.write", { warehouseId: grn.warehouseId });

  if (grn.status === "posted" || grn.status === "cancelled") {
    throw new BusinessRuleError(
      `GRN ${grn.grnNumber} berstatus '${grn.status}' dan tidak dapat ditimbang ulang.`,
    );
  }

  const pkgTypeId = input.packagingTypeId ?? line.packagingTypeId;
  let defaultTarePerPkg = "0.000";
  if (pkgTypeId) {
    const [pkg] = await tx
      .select()
      .from(packagingTypes)
      .where(eq(packagingTypes.id, pkgTypeId))
      .limit(1);
    if (!pkg) throw new NotFoundError("Jenis kemasan tidak ditemukan.");
    defaultTarePerPkg = pkg.defaultTareKg;
  }

  const calc = calculateWeighing({
    grossWeightKg: input.grossWeightKg,
    tareSource: input.tareSource,
    packageCount: input.packageCount ?? line.packageCount,
    defaultTarePerPackageKg: defaultTarePerPkg,
    measuredTareWeightKg: input.measuredTareWeightKg,
  });

  const existingWeighings = await tx
    .select()
    .from(weighings)
    .where(eq(weighings.goodsReceiptLineId, line.id));

  const [createdWeighing] = await tx
    .insert(weighings)
    .values({
      id: `wgh_${crypto.randomUUID()}`,
      goodsReceiptLineId: line.id,
      sequenceNo: existingWeighings.length + 1,
      grossWeightKg: calc.grossWeightKg,
      packagingTypeId: pkgTypeId ?? null,
      packageCount: calc.packageCount,
      tareSource: input.tareSource,
      tareWeightKg: calc.tareWeightKg,
      netWeightKg: calc.netWeightKg,
      scaleTicketRef: input.scaleTicketRef ?? null,
      weighedBy: ctx.user.id,
    })
    .returning();

  const allWeighings = [...existingWeighings, createdWeighing!];
  const totalGross = allWeighings.reduce(
    (acc, w) => acc.plus(parseQty(w.grossWeightKg)),
    new MoneyDecimal(0),
  );
  const totalTare = allWeighings.reduce(
    (acc, w) => acc.plus(parseQty(w.tareWeightKg)),
    new MoneyDecimal(0),
  );
  const totalNet = allWeighings.reduce(
    (acc, w) => acc.plus(parseQty(w.netWeightKg)),
    new MoneyDecimal(0),
  );
  const totalPkg = allWeighings.reduce((acc, w) => acc + w.packageCount, 0);

  const [updatedLine] = await tx
    .update(goodsReceiptLines)
    .set({
      packagingTypeId: pkgTypeId ?? line.packagingTypeId,
      packageCount: totalPkg,
      grossWeightKg: toDbQty(totalGross),
      tareWeightKg: toDbQty(totalTare),
      netWeightKg: toDbQty(totalNet),
    })
    .where(eq(goodsReceiptLines.id, line.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "receiving.weighing_record",
    entityType: "goods_receipt_line",
    entityId: line.id,
    warehouseId: grn.warehouseId,
    beforeData: line,
    afterData: { line: updatedLine, weighing: createdWeighing },
  });

  return { weighing: createdWeighing!, line: updatedLine! };
}

export interface RecordQualityInspectionInput {
  goodsReceiptLineId: string;
  brixPct?: string | number;
  firmnessScore?: number;
  ripenessStage?: "mentah" | "mengkal" | "matang_siap_jual" | "terlalu_matang";
  temperatureC?: string | number;
  pestOrDiseaseFound?: boolean;
  bruisingPct?: string | number;
  rotPct?: string | number;
  outcome: "accepted" | "partially_accepted" | "rejected";
  rejectionReasonCode?: string;
  rejectionNotes?: string;
  evidenceUrls?: string[];
}

/**
 * Records a Quality Control (QC) inspection on a GRN line.
 * Requires `qc.inspect` permission.
 */
export async function recordQualityInspection(
  tx: DbExecutor,
  ctx: ActorContext,
  input: RecordQualityInspectionInput,
) {
  const [line] = await tx
    .select()
    .from(goodsReceiptLines)
    .where(eq(goodsReceiptLines.id, input.goodsReceiptLineId))
    .limit(1);
  if (!line) throw new NotFoundError("Baris penerimaan barang (GRN Line) tidak ditemukan.");

  const [grn] = await tx
    .select()
    .from(goodsReceipts)
    .where(eq(goodsReceipts.id, line.goodsReceiptId))
    .limit(1);
  if (!grn) throw new NotFoundError("Dokumen GRN tidak ditemukan.");

  authorize(ctx, "qc.inspect", { warehouseId: grn.warehouseId });

  if (grn.status === "posted" || grn.status === "cancelled") {
    throw new BusinessRuleError(`GRN ${grn.grnNumber} sudah diposting atau dibatalkan.`);
  }

  if (
    (input.outcome === "rejected" || input.outcome === "partially_accepted") &&
    !input.rejectionReasonCode?.trim()
  ) {
    throw new BusinessRuleError(
      "Alasan penolakan (rejection reason code) wajib diisi apabila ada buah yang ditolak.",
    );
  }

  const [qc] = await tx
    .insert(qualityInspections)
    .values({
      id: `qc_${crypto.randomUUID()}`,
      goodsReceiptLineId: line.id,
      brixPct:
        input.brixPct !== undefined ? new MoneyDecimal(input.brixPct.toString()).toFixed(2) : null,
      firmnessScore: input.firmnessScore ?? null,
      ripenessStage: input.ripenessStage ?? "mengkal",
      temperatureC:
        input.temperatureC !== undefined
          ? new MoneyDecimal(input.temperatureC.toString()).toFixed(1)
          : null,
      pestOrDiseaseFound: input.pestOrDiseaseFound ?? false,
      bruisingPct: new MoneyDecimal((input.bruisingPct ?? "0").toString()).toFixed(2),
      rotPct: new MoneyDecimal((input.rotPct ?? "0").toString()).toFixed(2),
      outcome: input.outcome,
      rejectionReasonCode: input.rejectionReasonCode?.trim() ?? null,
      rejectionNotes: input.rejectionNotes?.trim() ?? null,
      evidenceUrls: input.evidenceUrls ?? null,
      inspectedBy: ctx.user.id,
    })
    .returning();

  if (grn.status === "draft") {
    await tx
      .update(goodsReceipts)
      .set({ status: "inspecting", updatedAt: new Date() })
      .where(eq(goodsReceipts.id, grn.id));
  }

  await recordAudit(tx, {
    ctx,
    action: "receiving.qc_inspect",
    entityType: "goods_receipt_line",
    entityId: line.id,
    warehouseId: grn.warehouseId,
    afterData: qc,
  });

  return qc!;
}

export interface RecordGradingInput {
  goodsReceiptLineId: string;
  grades: Array<{
    gradeCode: string;
    qtyBase: string | number;
    packageCount?: number;
  }>;
  trimLossQtyBase?: string | number;
  rejects?: RejectSplitInput[];
  scaleToleranceKg?: string | number;
}

/**
 * Records fruit grading (A/B/C), trim loss, and rejected quantities for a GRN line,
 * validates the yield conservation formula (`Σ grade + trim + reject = neto ± tolerance`),
 * and computes Relative-Sales-Value (RSV) cost allocation across grades.
 */
export async function recordGradingAndYield(
  tx: DbExecutor,
  ctx: ActorContext,
  input: RecordGradingInput,
) {
  const [line] = await tx
    .select()
    .from(goodsReceiptLines)
    .where(eq(goodsReceiptLines.id, input.goodsReceiptLineId))
    .limit(1);
  if (!line) throw new NotFoundError("Baris penerimaan barang (GRN Line) tidak ditemukan.");

  const [grn] = await tx
    .select()
    .from(goodsReceipts)
    .where(eq(goodsReceipts.id, line.goodsReceiptId))
    .limit(1);
  if (!grn) throw new NotFoundError("Dokumen GRN tidak ditemukan.");

  authorize(ctx, "qc.inspect", { warehouseId: grn.warehouseId });

  if (grn.status === "posted" || grn.status === "cancelled") {
    throw new BusinessRuleError(`GRN ${grn.grnNumber} sudah diposting atau dibatalkan.`);
  }

  // Load valid product grades for this product
  const validGrades = await tx
    .select()
    .from(productGrades)
    .where(and(eq(productGrades.productId, line.productId), eq(productGrades.isActive, true)));
  const gradeByCode = new Map(validGrades.map((g) => [g.code.toUpperCase(), g]));

  const acceptedGradesInput: GradeSplitInput[] = [];
  for (const g of input.grades) {
    const code = g.gradeCode.trim().toUpperCase();
    const matched = gradeByCode.get(code);
    if (!matched) {
      throw new BusinessRuleError(
        `Kode grade '${g.gradeCode}' tidak dikenal atau tidak aktif untuk produk ini.`,
      );
    }
    acceptedGradesInput.push({
      gradeId: matched.id,
      gradeCode: matched.code,
      qtyBase: g.qtyBase,
      packageCount: g.packageCount ?? 0,
      relativeValueMultiplierPct: matched.priceMultiplierPct,
    });
  }

  // Allocate GRN landed costs proportionally by line net weight
  const allGrnLines = await tx
    .select()
    .from(goodsReceiptLines)
    .where(eq(goodsReceiptLines.goodsReceiptId, grn.id));
  const grnLandedCosts = await tx
    .select()
    .from(landedCosts)
    .where(eq(landedCosts.goodsReceiptId, grn.id));

  const totalLandedCost = grnLandedCosts.reduce(
    (acc, lc) => acc.plus(new MoneyDecimal(lc.amount)),
    new MoneyDecimal(0),
  );
  const totalGrnNetWeight = allGrnLines.reduce(
    (acc, l) => acc.plus(parseQty(l.netWeightKg)),
    new MoneyDecimal(0),
  );
  const lineNetWeight = parseQty(line.netWeightKg);

  let lineLandedCost = new MoneyDecimal(0);
  if (totalLandedCost.gt(0) && totalGrnNetWeight.gt(0) && lineNetWeight.gt(0)) {
    lineLandedCost = roundRupiah(totalLandedCost.mul(lineNetWeight).div(totalGrnNetWeight));
  }

  const yieldCalc = calculateGradingAndYield({
    netWeightKg: line.netWeightKg,
    acceptedGrades: acceptedGradesInput,
    trimLossQtyBase: input.trimLossQtyBase ?? "0",
    rejects: input.rejects ?? [],
    actualUnitCostBase: line.actualUnitCostBase,
    allocatedLandedCost: toDbAmount(lineLandedCost),
    scaleToleranceKg: input.scaleToleranceKg,
  });

  // Replace previous draft gradingResults for this line
  await tx.delete(gradingResults).where(eq(gradingResults.goodsReceiptLineId, line.id));

  const rowsToInsert = [];

  for (const alloc of yieldCalc.gradeAllocations) {
    rowsToInsert.push({
      id: `grd_${crypto.randomUUID()}`,
      goodsReceiptLineId: line.id,
      lineType: "accepted_grade" as const,
      gradeId: alloc.gradeId,
      gradeCode: alloc.gradeCode,
      qtyBase: alloc.qtyBase,
      packageCount: alloc.packageCount,
      rejectDisposition: null,
      rejectReasonCode: null,
      relativeValueMultiplierPct: alloc.relativeValueMultiplierPct,
      allocatedCostTotal: alloc.allocatedCostTotal,
      allocatedUnitCost: alloc.allocatedUnitCost,
      gradedBy: ctx.user.id,
    });
  }

  if (parseQty(yieldCalc.trimLossQtyBase).gt(0)) {
    rowsToInsert.push({
      id: `grd_${crypto.randomUUID()}`,
      goodsReceiptLineId: line.id,
      lineType: "trim_loss" as const,
      gradeId: null,
      gradeCode: null,
      qtyBase: yieldCalc.trimLossQtyBase,
      packageCount: 0,
      rejectDisposition: null,
      rejectReasonCode: "TRIM_SORTIR",
      relativeValueMultiplierPct: null,
      allocatedCostTotal: "0.00",
      allocatedUnitCost: "0.0000",
      gradedBy: ctx.user.id,
    });
  }

  for (const rej of input.rejects ?? []) {
    const rq = roundQty(parseQty(rej.qtyBase));
    if (rq.gt(0)) {
      rowsToInsert.push({
        id: `grd_${crypto.randomUUID()}`,
        goodsReceiptLineId: line.id,
        lineType: "rejected" as const,
        gradeId: null,
        gradeCode: null,
        qtyBase: toDbQty(rq),
        packageCount: 0,
        rejectDisposition: rej.disposition,
        rejectReasonCode: rej.reasonCode.trim(),
        relativeValueMultiplierPct: null,
        allocatedCostTotal: "0.00",
        allocatedUnitCost: "0.0000",
        gradedBy: ctx.user.id,
      });
    }
  }

  const insertedGradings =
    rowsToInsert.length > 0
      ? await tx.insert(gradingResults).values(rowsToInsert).returning()
      : [];

  const [updatedLine] = await tx
    .update(goodsReceiptLines)
    .set({
      acceptedQtyBase: yieldCalc.acceptedQtyBase,
      trimLossQtyBase: yieldCalc.trimLossQtyBase,
      rejectedQtyBase: yieldCalc.rejectedQtyBase,
      billableQtyBase: yieldCalc.billableQtyBase,
      lineGoodsCost: yieldCalc.lineGoodsCost,
      allocatedLandedCost: yieldCalc.allocatedLandedCost,
      totalLineCost: yieldCalc.totalLineCost,
    })
    .where(eq(goodsReceiptLines.id, line.id))
    .returning();

  await tx
    .update(goodsReceipts)
    .set({ status: "graded", updatedAt: new Date() })
    .where(eq(goodsReceipts.id, grn.id));

  await recordAudit(tx, {
    ctx,
    action: "receiving.grading_record",
    entityType: "goods_receipt_line",
    entityId: line.id,
    warehouseId: grn.warehouseId,
    beforeData: line,
    afterData: {
      line: updatedLine,
      yieldSummary: yieldCalc,
      gradingRows: insertedGradings,
    },
  });

  return {
    line: updatedLine!,
    yieldSummary: yieldCalc,
    gradingRows: insertedGradings,
  };
}

export interface PostGoodsReceiptInput {
  goodsReceiptId: string;
  idempotencyKey?: string;
  requestApprovalIfDiscrepancy?: boolean;
  enforceProductionCostingGate?: boolean;
}

/**
 * Atomically posts a Goods Receipt (GRN):
 * - Enforces idempotency so retried requests never duplicate batches, movements, or journal entries.
 * - Verifies weighing, QC inspection, and grading yield conservation.
 * - Enforces PO tolerance, product substitution approval, and purchase price variance approval.
 * - Creates `batches` per accepted grade, posts `grn_receipt` `inventory_movements`, updates `stock_balances`,
 *   updates PO received/accepted/rejected quantities & PO status (`partially_received` / `received`),
 *   and posts balanced GL journal (`Dr 1140 Persediaan Buah Segar / Cr 2115 GRNI`).
 */
export async function postGoodsReceipt(
  tx: DbExecutor,
  ctx: ActorContext,
  input: PostGoodsReceiptInput,
) {
  const executePost = async () => {
    const [grn] = await tx
      .select()
      .from(goodsReceipts)
      .where(eq(goodsReceipts.id, input.goodsReceiptId))
      .limit(1);
    if (!grn) throw new NotFoundError("Dokumen penerimaan barang (GRN) tidak ditemukan.");

    authorize(ctx, "receiving.write", { warehouseId: grn.warehouseId });

    // If already posted, return existing posted artifacts without duplicating movements
    if (grn.status === "posted") {
      const existingBatches = await tx
        .select()
        .from(batches)
        .where(eq(batches.goodsReceiptId, grn.id));
      const existingMovements = await tx
        .select()
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.sourceDocType, "goods_receipt"),
            eq(inventoryMovements.sourceDocId, grn.id),
          ),
        );
      return {
        status: "posted" as const,
        grn,
        batches: existingBatches,
        movements: existingMovements,
        pendingApprovals: [],
        idempotentReplay: true,
      };
    }

    if (grn.status === "cancelled") {
      throw new BusinessRuleError(`GRN ${grn.grnNumber} sudah dibatalkan dan tidak dapat diposting.`);
    }

    const [po] = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, grn.purchaseOrderId))
      .limit(1);
    if (!po) throw new NotFoundError("Purchase Order terkait tidak ditemukan.");

    if (po.status !== "approved" && po.status !== "partially_received") {
      throw new BusinessRuleError(
        `PO ${po.poNumber} berstatus '${po.status}' sehingga GRN tidak dapat diposting.`,
      );
    }

    const [wh] = await tx
      .select()
      .from(warehouses)
      .where(eq(warehouses.id, grn.warehouseId))
      .limit(1);
    if (!wh) throw new NotFoundError("Gudang tidak ditemukan.");

    const lines = await tx
      .select()
      .from(goodsReceiptLines)
      .where(eq(goodsReceiptLines.goodsReceiptId, grn.id))
      .orderBy(asc(goodsReceiptLines.lineNo));

    const poLines = await tx
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, po.id));
    const poLineMap = new Map(poLines.map((l) => [l.id, l]));

    const pendingApprovals = [];

    // 1. Validate Weighing, QC, Grading, and PO Tolerances / Discrepancies on every line
    for (const line of lines) {
      const netKg = roundQty(parseQty(line.netWeightKg));
      if (netKg.lte(0)) {
        throw new BusinessRuleError(
          `Baris GRN #${line.lineNo} belum ditimbang (berat neto harus > 0 kg).`,
        );
      }

      const qcRows = await tx
        .select()
        .from(qualityInspections)
        .where(eq(qualityInspections.goodsReceiptLineId, line.id));
      if (qcRows.length === 0) {
        throw new BusinessRuleError(
          `Baris GRN #${line.lineNo} belum melewati pemeriksaan kualitas (QC).`,
        );
      }

      const grdRows = await tx
        .select()
        .from(gradingResults)
        .where(eq(gradingResults.goodsReceiptLineId, line.id));
      if (grdRows.length === 0) {
        throw new BusinessRuleError(
          `Baris GRN #${line.lineNo} belum memiliki hasil grading A/B/C atau reject.`,
        );
      }

      const poLine = line.purchaseOrderLineId ? poLineMap.get(line.purchaseOrderLineId) : undefined;

      // Check 1A: Product Substitution
      if (line.isSubstitution || !poLine || poLine.productId !== line.productId) {
        let subApproved = false;
        if (line.substitutionApprovalId) {
          const [app] = await tx
            .select()
            .from(approvals)
            .where(eq(approvals.id, line.substitutionApprovalId))
            .limit(1);
          subApproved = app?.status === "approved";
        }
        if (!subApproved) {
          if (input.requestApprovalIfDiscrepancy) {
            const app = await requestApproval(tx, ctx, {
              approvalType: "supplier_substitution",
              sourceDocType: "goods_receipt",
              sourceDocId: grn.id,
              warehouseId: grn.warehouseId,
              requestReason: `Substitusi produk pada GRN ${grn.grnNumber} baris #${line.lineNo}`,
              ruleSnapshot: { lineId: line.id, productId: line.productId },
            });
            await tx
              .update(goodsReceiptLines)
              .set({ substitutionApprovalId: app.id })
              .where(eq(goodsReceiptLines.id, line.id));
            pendingApprovals.push(app);
          } else {
            throw new BusinessRuleError(
              `Baris GRN #${line.lineNo} merupakan barang substitusi yang tidak ada di PO dan memerlukan persetujuan (approval).`,
            );
          }
        }
      }

      if (poLine) {
        // Check 1B: Over-delivery quantity tolerance check
        const orderedQty = roundQty(parseQty(poLine.orderedQtyBase));
        const prevReceivedNet = roundQty(parseQty(poLine.receivedNetQtyBase));
        const cumulativeNet = roundQty(prevReceivedNet.plus(netKg));
        const qtyTolPct = new MoneyDecimal(po.qtyTolerancePct);
        const maxAllowedQty = roundQty(
          orderedQty.mul(new MoneyDecimal(100).plus(qtyTolPct)).div(100),
        );

        if (cumulativeNet.gt(maxAllowedQty)) {
          let tolApproved = false;
          if (line.overToleranceApprovalId) {
            const [app] = await tx
              .select()
              .from(approvals)
              .where(eq(approvals.id, line.overToleranceApprovalId))
              .limit(1);
            tolApproved = app?.status === "approved";
          }
          if (!tolApproved) {
            if (input.requestApprovalIfDiscrepancy) {
              const app = await requestApproval(tx, ctx, {
                approvalType: "po_over_tolerance",
                sourceDocType: "goods_receipt",
                sourceDocId: grn.id,
                warehouseId: grn.warehouseId,
                requestReason: `Penerimaan melebihi toleransi PO (${toDbQty(cumulativeNet)} kg > batas maks ${toDbQty(maxAllowedQty)} kg) pada GRN ${grn.grnNumber}`,
                ruleSnapshot: {
                  orderedQtyBase: toDbQty(orderedQty),
                  cumulativeNetQtyBase: toDbQty(cumulativeNet),
                  maxAllowedQtyBase: toDbQty(maxAllowedQty),
                  qtyTolerancePct: po.qtyTolerancePct,
                },
              });
              await tx
                .update(goodsReceiptLines)
                .set({ overToleranceApprovalId: app.id })
                .where(eq(goodsReceiptLines.id, line.id));
              pendingApprovals.push(app);
            } else {
              throw new BusinessRuleError(
                `Kuantitas penerimaan kumulatif (${toDbQty(cumulativeNet)} kg) melebihi batas toleransi PO (${toDbQty(maxAllowedQty)} kg, toleransi ${po.qtyTolerancePct}%) dan memerlukan persetujuan.`,
              );
            }
          }
        }

        // Check 1C: Purchase Price Discrepancy check
        const poUnitPrice = roundUnitPrice(new MoneyDecimal(poLine.unitPriceBase));
        const actualUnitCost = roundUnitPrice(new MoneyDecimal(line.actualUnitCostBase));
        const priceTolPct = new MoneyDecimal(po.priceVarianceTolerancePct);
        const maxAllowedUnitPrice = roundUnitPrice(
          poUnitPrice.mul(new MoneyDecimal(100).plus(priceTolPct)).div(100),
        );

        if (actualUnitCost.gt(maxAllowedUnitPrice)) {
          let priceApproved = false;
          if (line.priceVarianceApprovalId) {
            const [app] = await tx
              .select()
              .from(approvals)
              .where(eq(approvals.id, line.priceVarianceApprovalId))
              .limit(1);
            priceApproved = app?.status === "approved";
          }
          if (!priceApproved) {
            if (input.requestApprovalIfDiscrepancy) {
              const app = await requestApproval(tx, ctx, {
                approvalType: "po_price_variance",
                sourceDocType: "goods_receipt",
                sourceDocId: grn.id,
                warehouseId: grn.warehouseId,
                requestReason: `Harga beli aktual (${toDbUnitPrice(actualUnitCost)}) melebihi harga PO (${toDbUnitPrice(poUnitPrice)}) pada GRN ${grn.grnNumber}`,
                ruleSnapshot: {
                  poUnitPrice: toDbUnitPrice(poUnitPrice),
                  actualUnitCost: toDbUnitPrice(actualUnitCost),
                },
              });
              await tx
                .update(goodsReceiptLines)
                .set({ priceVarianceApprovalId: app.id })
                .where(eq(goodsReceiptLines.id, line.id));
              pendingApprovals.push(app);
            } else {
              throw new BusinessRuleError(
                `Harga beli aktual (${toDbUnitPrice(actualUnitCost)}) melebihi harga PO (${toDbUnitPrice(poUnitPrice)}) di atas toleransi (${po.priceVarianceTolerancePct}%) dan memerlukan persetujuan.`,
              );
            }
          }
        }
      }
    }

    if (pendingApprovals.length > 0) {
      const [pendingGrn] = await tx
        .update(goodsReceipts)
        .set({ status: "pending_approval", updatedAt: new Date() })
        .where(eq(goodsReceipts.id, grn.id))
        .returning();

      return {
        status: "pending_approval" as const,
        grn: pendingGrn!,
        batches: [],
        movements: [],
        pendingApprovals,
        idempotentReplay: false,
      };
    }

    // 2. All validations and approvals passed -> Create batches, movements, balances, PO updates, and GL journal
    const createdBatches = [];
    const createdMovements = [];
    const journalLinesToPost: Array<{
      accountCode: string;
      debit?: string;
      credit?: string;
      warehouseId: string;
      productId: string;
      batchId: string;
      description: string;
    }> = [];

    for (const line of lines) {
      const [product] = await tx
        .select()
        .from(products)
        .where(eq(products.id, line.productId))
        .limit(1);
      if (!product) throw new NotFoundError("Produk tidak ditemukan.");

      const [latestQc] = await tx
        .select()
        .from(qualityInspections)
        .where(eq(qualityInspections.goodsReceiptLineId, line.id))
        .orderBy(desc(qualityInspections.inspectedAt))
        .limit(1);

      const grdRows = await tx
        .select()
        .from(gradingResults)
        .where(eq(gradingResults.goodsReceiptLineId, line.id));

      const acceptedGrades = grdRows.filter(
        (g) => g.lineType === "accepted_grade" && parseQty(g.qtyBase).gt(0),
      );

      // Compute best-before / expiry from receivedAt + product.defaultShelfLifeDays
      const receivedDate = new Date(grn.receivedAt);
      const expiresDate = new Date(receivedDate.getTime());
      expiresDate.setUTCDate(expiresDate.getUTCDate() + product.defaultShelfLifeDays);
      const bestBeforeStr = businessDate(expiresDate);

      for (const acc of acceptedGrades) {
        if (!acc.gradeId || !acc.gradeCode) {
          throw new BusinessRuleError("Hasil grading yang diterima wajib memiliki gradeId dan gradeCode.");
        }

        const seqCode = await nextDocumentNumber(tx, {
          docType: "LOT",
          warehouseCode: wh.code,
          at: receivedDate,
        });
        const batchCode = `${seqCode}-${product.sku}-${acc.gradeCode}`;
        const batchId = `bat_${crypto.randomUUID()}`;

        const [createdBatch] = await tx
          .insert(batches)
          .values({
            id: batchId,
            batchCode,
            productId: product.id,
            gradeId: acc.gradeId,
            gradeCode: acc.gradeCode,
            supplierId: grn.supplierId,
            warehouseId: grn.warehouseId,
            goodsReceiptId: grn.id,
            goodsReceiptLineId: line.id,
            originRegion: po.originRegion,
            harvestedAt: grn.harvestedAt,
            receivedAt: receivedDate,
            ripenessStage: latestQc?.ripenessStage ?? "mengkal",
            bestBeforeDate: bestBeforeStr,
            expiresAt: expiresDate,
            initialQtyBase: acc.qtyBase,
            unitCostBase: acc.allocatedUnitCost,
            totalInitialCost: acc.allocatedCostTotal,
            costingMethod: "lot_actual_rsv",
            status: "active",
          })
          .returning();

        createdBatches.push(createdBatch!);

        const movRes = await applyInventoryMovement(tx, ctx, {
          warehouseId: grn.warehouseId,
          warehouseCode: wh.code,
          locationId: grn.putawayLocationId,
          batchId,
          productId: product.id,
          gradeId: acc.gradeId,
          stockStatus: "available",
          movementType: "grn_receipt",
          qtyDeltaBase: acc.qtyBase,
          unitCostBase: acc.allocatedUnitCost,
          explicitInflowCost: acc.allocatedCostTotal,
          sourceDocType: "goods_receipt",
          sourceDocId: grn.id,
          sourceLineId: line.id,
          notes: `Penerimaan GRN ${grn.grnNumber} (${product.name} Grade ${acc.gradeCode})`,
        });

        createdMovements.push(movRes.movement);

        const costAmt = new MoneyDecimal(acc.allocatedCostTotal);
        if (costAmt.gt(0)) {
          journalLinesToPost.push(
            {
              accountCode: GL_ACCOUNT_CODES.INVENTORY_FRUIT,
              debit: toDbAmount(costAmt),
              warehouseId: grn.warehouseId,
              productId: product.id,
              batchId,
              description: `Persediaan Masuk ${grn.grnNumber} - ${product.name} Grade ${acc.gradeCode} (${acc.qtyBase} ${product.baseUomCode})`,
            },
            {
              accountCode: GL_ACCOUNT_CODES.GRNI_ACCRUAL,
              credit: toDbAmount(costAmt),
              warehouseId: grn.warehouseId,
              productId: product.id,
              batchId,
              description: `Akrual GRNI ${grn.grnNumber} - ${product.name} Grade ${acc.gradeCode}`,
            },
          );
        }
      }

      // Update PO line received/accepted/rejected quantities
      if (line.purchaseOrderLineId) {
        const poLine = poLineMap.get(line.purchaseOrderLineId);
        if (poLine) {
          const newRecNet = roundQty(
            parseQty(poLine.receivedNetQtyBase).plus(parseQty(line.netWeightKg)),
          );
          const newAcc = roundQty(
            parseQty(poLine.acceptedQtyBase).plus(parseQty(line.acceptedQtyBase)),
          );
          const newRej = roundQty(
            parseQty(poLine.rejectedQtyBase).plus(parseQty(line.rejectedQtyBase)),
          );
          const [updatedPoLine] = await tx
            .update(purchaseOrderLines)
            .set({
              receivedNetQtyBase: toDbQty(newRecNet),
              acceptedQtyBase: toDbQty(newAcc),
              rejectedQtyBase: toDbQty(newRej),
            })
            .where(eq(purchaseOrderLines.id, poLine.id))
            .returning();
          if (updatedPoLine) {
            poLineMap.set(poLine.id, updatedPoLine);
          }
        }
      }
    }

    // 3. Post GL Journal Entry for Inventory Valuation (Dr 1140 / Cr 2115)
    let journalEntryId: string | null = null;
    if (journalLinesToPost.length >= 2) {
      const jeRes = await postJournalEntry(tx, ctx, {
        warehouseId: grn.warehouseId,
        sourceDocType: "goods_receipt",
        sourceDocId: grn.id,
        purpose: "grn_posting",
        memo: `Posting Penerimaan Barang ${grn.grnNumber} (PO ${po.poNumber}, SJ ${grn.supplierDeliveryNoteNo})`,
        enforceProductionGate: input.enforceProductionCostingGate,
        skipDirectPermissionCheck: true,
        lines: journalLinesToPost,
      });
      journalEntryId = jeRes.entry.id;
    }

    // 4. Update PO status: partially_received vs received
    const updatedPoLines = Array.from(poLineMap.values());
    const allLinesFulfilled =
      updatedPoLines.length > 0 &&
      updatedPoLines.every((pl) =>
        parseQty(pl.receivedNetQtyBase).gte(parseQty(pl.orderedQtyBase)),
      );
    const newPoStatus = allLinesFulfilled ? "received" : "partially_received";

    await tx
      .update(purchaseOrders)
      .set({
        status: newPoStatus,
        version: po.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(purchaseOrders.id, po.id));

    // 5. Mark GRN as posted
    const [postedGrn] = await tx
      .update(goodsReceipts)
      .set({
        status: "posted",
        postedBy: ctx.user.id,
        postedAt: new Date(),
        version: grn.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(goodsReceipts.id, grn.id))
      .returning();

    await recordAudit(tx, {
      ctx,
      action: "receiving.grn_post",
      entityType: "goods_receipt",
      entityId: grn.id,
      warehouseId: grn.warehouseId,
      beforeData: grn,
      afterData: {
        grn: postedGrn,
        poStatus: newPoStatus,
        batchCount: createdBatches.length,
        movementCount: createdMovements.length,
        journalEntryId,
      },
    });

    return {
      status: "posted" as const,
      grn: postedGrn!,
      poStatus: newPoStatus,
      batches: createdBatches,
      movements: createdMovements,
      journalEntryId,
      pendingApprovals: [],
      idempotentReplay: false,
    };
  };

  if (input.idempotencyKey) {
    const idem = await withIdempotency(
      tx,
      {
        scope: "receiving.post_grn",
        key: input.idempotencyKey,
        payload: { goodsReceiptId: input.goodsReceiptId },
        actorUserId: ctx.user.id,
      },
      executePost,
    );
    return {
      ...idem.result,
      idempotentReplay: idem.replayed || idem.result.idempotentReplay,
    };
  }

  return executePost();
}

export async function listGoodsReceipts(
  db: DbExecutor,
  ctx: ActorContext,
  options?: { warehouseId?: string },
) {
  authorize(ctx, "receiving.read", { warehouseId: options?.warehouseId });
  return db
    .select({
      grn: goodsReceipts,
      po: purchaseOrders,
      supplier: suppliers,
      warehouse: warehouses,
    })
    .from(goodsReceipts)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, goodsReceipts.purchaseOrderId))
    .innerJoin(suppliers, eq(suppliers.id, goodsReceipts.supplierId))
    .innerJoin(warehouses, eq(warehouses.id, goodsReceipts.warehouseId))
    .where(options?.warehouseId ? eq(goodsReceipts.warehouseId, options.warehouseId) : undefined)
    .orderBy(desc(goodsReceipts.receivedAt))
    .limit(50);
}

export async function getGoodsReceiptWithDetails(
  db: DbExecutor,
  ctx: ActorContext,
  goodsReceiptId: string,
) {
  const [grn] = await db
    .select()
    .from(goodsReceipts)
    .where(eq(goodsReceipts.id, goodsReceiptId))
    .limit(1);
  if (!grn) throw new NotFoundError("Dokumen GRN tidak ditemukan.");

  authorize(ctx, "receiving.read", { warehouseId: grn.warehouseId });

  const lines = await db
    .select({
      line: goodsReceiptLines,
      product: products,
    })
    .from(goodsReceiptLines)
    .innerJoin(products, eq(products.id, goodsReceiptLines.productId))
    .where(eq(goodsReceiptLines.goodsReceiptId, grn.id))
    .orderBy(asc(goodsReceiptLines.lineNo));

  const lineDetails = [];
  for (const l of lines) {
    const lineWeighings = await db
      .select()
      .from(weighings)
      .where(eq(weighings.goodsReceiptLineId, l.line.id))
      .orderBy(asc(weighings.sequenceNo));
    const lineQc = await db
      .select()
      .from(qualityInspections)
      .where(eq(qualityInspections.goodsReceiptLineId, l.line.id))
      .orderBy(desc(qualityInspections.inspectedAt));
    const lineGrading = await db
      .select()
      .from(gradingResults)
      .where(eq(gradingResults.goodsReceiptLineId, l.line.id));
    lineDetails.push({
      ...l,
      weighings: lineWeighings,
      inspections: lineQc,
      gradings: lineGrading,
    });
  }

  return { header: grn, lines: lineDetails };
}
