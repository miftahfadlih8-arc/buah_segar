import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { businessDate } from "@/lib/datetime";
import {
  MoneyDecimal,
  parseMoney,
  roundRupiah,
  roundUnitPrice,
  toDbAmount,
  type Money,
} from "@/lib/money";
import { netWeight, parseQty, roundQty, toBaseQty, toDbQty } from "@/lib/quantity";
import { decideApproval, requestApproval } from "@/server/approvals";
import { recordAudit } from "@/server/audit";
import {
  authorize,
  hasPermission,
  type ActorContext,
} from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import {
  approvals,
  batches,
  customers,
  deliveryClaims,
  deliveryOrderLines,
  deliveryOrders,
  deliveryZones,
  fulfillmentExceptions,
  fulfillmentPickAllocations,
  productGrades,
  products,
  productUomConversions,
  proofOfDeliveries,
  proofOfDeliveryLines,
  roles,
  salesFulfillmentLines,
  salesFulfillments,
  salesOrderLines,
  salesOrders,
  stockReservations,
  userRoleAssignments,
  users,
  warehouses,
} from "@/server/db/schema";
import { BusinessRuleError, ForbiddenError, NotFoundError } from "@/server/errors";
import { withIdempotency } from "@/server/idempotency";
import { GL_ACCOUNT_CODES, postJournalEntry } from "@/server/modules/gl";
import { evaluateCostingPolicyGate } from "@/server/modules/inventory/costing";
import { applyInventoryMovement } from "@/server/modules/inventory/ledger";
import { nextDocumentNumber } from "@/server/sequences";

/**
 * ============================================================================
 * PHASE 5 STOCK & ACCOUNTING LIFECYCLE POLICY (EXPLICIT SPECIFICATION)
 * ============================================================================
 *
 * 1. `reserved` (Sales Order Confirmation — Phase 4):
 *    - When a Sales Order is confirmed (`confirmSalesOrder`), eligible FEFO batches are
 *      moved from `stock_status = 'available'` (-qty, -cost) to `stock_status = 'reserved'`
 *      (+qty, +cost) in `stock_balances`, and tracked in `stock_reservations`.
 *    - Total inventory value on hand (`available + reserved`) remains unchanged; no COGS is
 *      posted at reservation time.
 *
 * 2. `picked` & `issued` (Warehouse Picking Execution — Phase 5 `recordFulfillmentPicking`):
 *    - Physical inventory deduction (`movementType = 'sales_pick_issue'`) happens **exactly once**
 *      when picking & actual weighing are confirmed (`isStockIssued = true`).
 *    - Reserved stock for the SO is consumed first (`stock_status = 'reserved'`, negative `qtyDeltaBase`),
 *      updating `stock_reservations.fulfilledQtyBase` and transitioning completed reservations to `'fulfilled'`.
 *    - Any approved substitution or within-tolerance positive weight variance not covered by existing
 *      reservations is deducted from FEFO `stock_status = 'available'` batches locked `FOR UPDATE`.
 *    - Simultaneously in the same atomic transaction, a balanced COGS journal entry is posted to GL:
 *      * Debit `5100` (`GL_ACCOUNT_CODES.COGS_FRUIT` — Harga Pokok Penjualan Buah)
 *      * Credit `1140` (`GL_ACCOUNT_CODES.INVENTORY_FRUIT` — Persediaan Buah Segar)
 *      for the exact Rupiah `costOutflow` of all picked batch allocations.
 *
 * 3. `packed` (Packing Verification — Phase 5 `finalizeFulfillmentPacking`):
 *    - Verifies the packing checklist, confirms zero unresolved blocking exceptions or pending
 *      approvals, and locks `packedQtyBase = pickedQtyBase` with status `'packed'`.
 *    - Does NOT deduct inventory or post GL journals a second time.
 *
 * 4. `dispatched` (Surat Jalan / Delivery Order Dispatch — Phase 5 `dispatchDeliveryOrder`):
 *    - Requires `sales_fulfillments.status === 'packed'`, assigned driver, and vehicle plate number.
 *    - Transitions Delivery Order to `'dispatched'`, Fulfillment to `'dispatched'`, and Sales Order to `'shipped'`.
 *    - Does NOT deduct inventory a second time or create customer invoices (invoicing is Phase 6).
 *
 * 5. `delivered` / `claim` (Proof of Delivery — Phase 5 `recordProofOfDelivery`):
 *    - Records recipient handover details and per-line `deliveredQtyBase`, `shortageQtyBase`,
 *      `damagedQtyBase`, and `refusedQtyBase` (which must sum to `shippedQtyBase`).
 *    - Prevents duplicate POD submissions via unique constraint + state validation + idempotency.
 *    - If any discrepancy occurs (`shortage`, `damaged`, `refused`, `failed`, `returned`),
 *      automatically creates an actionable `delivery_claims` record (`status = 'open'`)
 *      without silently mutating posted `inventory_movements` or historical Sales Order prices.
 */
export const STOCK_LIFECYCLE_POLICY = {
  RESERVED_ON: "sales_order.confirm",
  PICKED_AND_ISSUED_ON: "fulfillment.pick",
  COGS_POSTED_ON: "fulfillment.pick",
  PACKED_ON: "fulfillment.pack",
  DISPATCHED_ON: "delivery_order.dispatch",
  POD_AND_CLAIM_ON: "delivery_order.pod",
} as const;

const ELIGIBLE_SO_STATUSES_FOR_FULFILLMENT = new Set([
  "confirmed",
  "picking",
  "packed",
  "shipped",
  "partially_delivered",
]);

function authorizeFulfillmentOrDeliveryRead(ctx: ActorContext, warehouseId?: string | null) {
  const allowed =
    hasPermission(ctx, "fulfillment.pick_pack", { warehouseId }) ||
    hasPermission(ctx, "delivery.execute", { warehouseId }) ||
    hasPermission(ctx, "sales.read", { warehouseId }) ||
    hasPermission(ctx, "inventory.read", { warehouseId });

  if (!allowed) {
    throw new ForbiddenError(
      "fulfillment.pick_pack",
      "Akses ditolak: Anda tidak memiliki izin untuk melihat dokumen pemenuhan atau pengiriman.",
    );
  }
}

function authorizeDeliveryWrite(ctx: ActorContext, warehouseId: string) {
  const allowed =
    hasPermission(ctx, "delivery.execute", { warehouseId }) ||
    hasPermission(ctx, "fulfillment.pick_pack", { warehouseId });

  if (!allowed) {
    throw new ForbiddenError(
      "delivery.execute",
      "Akses ditolak: membutuhkan izin 'delivery.execute' atau 'fulfillment.pick_pack'.",
    );
  }
}

// ============================================================================
// 1. CREATE SALES FULFILLMENT DOCUMENT (FROM APPROVED / CONFIRMED SO)
// ============================================================================

export interface CreateSalesFulfillmentLineTargetInput {
  salesOrderLineId: string;
  targetPickQtyBase?: string | number;
  notes?: string;
}

export interface CreateSalesFulfillmentInput {
  salesOrderId: string;
  fulfillmentDate?: string;
  qtyTolerancePct?: string | number;
  lines?: CreateSalesFulfillmentLineTargetInput[];
  notes?: string;
}

export async function createSalesFulfillment(
  tx: DbExecutor,
  ctx: ActorContext,
  input: CreateSalesFulfillmentInput,
) {
  // Lock Sales Order row FOR UPDATE to serialize fulfillment creation
  const soLockRes = await tx.execute<{
    id: string;
    so_number: string;
    customer_id: string;
    warehouse_id: string;
    status: string;
  }>(
    sql`SELECT id, so_number, customer_id, warehouse_id, status
        FROM sales_orders
        WHERE id = ${input.salesOrderId}
        FOR UPDATE`,
  );

  const so = soLockRes.rows[0];
  if (!so) {
    throw new NotFoundError("Sales Order tidak ditemukan.");
  }

  authorize(ctx, "fulfillment.pick_pack", { warehouseId: so.warehouse_id });

  if (!ELIGIBLE_SO_STATUSES_FOR_FULFILLMENT.has(so.status)) {
    throw new BusinessRuleError(
      `Sales Order ${so.so_number} berstatus '${so.status}' dan belum dapat dipenuhi. Hanya Sales Order yang sudah dikonfirmasi/disetujui ('confirmed') yang dapat dibuatkan dokumen pemenuhan (Fulfillment).`,
    );
  }

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, so.warehouse_id))
    .limit(1);
  if (!wh) {
    throw new NotFoundError("Gudang pada Sales Order tidak ditemukan.");
  }

  const soLines = await tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.salesOrderId, so.id))
    .orderBy(asc(salesOrderLines.lineNo));

  if (soLines.length === 0) {
    throw new BusinessRuleError("Sales Order tidak memiliki baris item.");
  }

  // Check if there are other active draft/picking fulfillments already locking the unfulfilled qty
  const existingFulfillments = await tx
    .select({
      id: salesFulfillments.id,
      status: salesFulfillments.status,
    })
    .from(salesFulfillments)
    .where(eq(salesFulfillments.salesOrderId, so.id));

  const requestedTargetsByLineId = new Map<string, CreateSalesFulfillmentLineTargetInput>();
  if (input.lines && input.lines.length > 0) {
    for (const l of input.lines) {
      requestedTargetsByLineId.set(l.salesOrderLineId, l);
    }
  }

  const tolerance = roundUnitPrice(parseMoney(input.qtyTolerancePct ?? "5.00"));
  if (tolerance.lt(0) || tolerance.gt(50)) {
    throw new BusinessRuleError("Batas toleransi selisih kuantitas harus berada di antara 0% dan 50%.");
  }

  let totalOrderedQtyBase = new MoneyDecimal(0);
  let totalTargetQtyBase = new MoneyDecimal(0);
  let isPartial = existingFulfillments.some((f) => f.status !== "cancelled");

  const preparedLines: Array<{
    salesOrderLine: typeof soLines[number];
    previouslyFulfilledQtyBase: string;
    targetPickQtyBase: string;
    remainingAfterTargetQtyBase: string;
    notes: string | null;
  }> = [];

  for (const sol of soLines) {
    const orderedBase = roundQty(parseQty(sol.orderedQtyBase));
    const fulfilledBase = roundQty(parseQty(sol.fulfilledQtyBase));
    const remainingUnfulfilled = roundQty(orderedBase.minus(fulfilledBase));

    const reqLine = requestedTargetsByLineId.get(sol.id);
    if (input.lines && input.lines.length > 0 && !reqLine) {
      if (remainingUnfulfilled.gt(0)) {
        isPartial = true;
      }
      continue;
    }

    if (remainingUnfulfilled.lte(0)) {
      if (reqLine) {
        throw new BusinessRuleError(
          `Baris SO #${sol.lineNo} sudah terpenuhi seluruhnya (${toDbQty(fulfilledBase)} / ${toDbQty(orderedBase)}).`,
        );
      }
      continue;
    }

    const targetBase =
      reqLine?.targetPickQtyBase !== undefined
        ? roundQty(parseQty(reqLine.targetPickQtyBase))
        : remainingUnfulfilled;

    if (targetBase.lte(0)) {
      throw new BusinessRuleError(
        `Target kuantitas picking pada baris SO #${sol.lineNo} harus lebih besar dari 0.`,
      );
    }

    if (targetBase.gt(remainingUnfulfilled)) {
      throw new BusinessRuleError(
        `Target kuantitas picking (${toDbQty(targetBase)}) pada baris SO #${sol.lineNo} melebihi sisa kuantitas yang belum dipenuhi (${toDbQty(remainingUnfulfilled)}).`,
      );
    }

    if (targetBase.lt(orderedBase)) {
      isPartial = true;
    }

    const remainingAfterTarget = roundQty(remainingUnfulfilled.minus(targetBase));
    totalOrderedQtyBase = totalOrderedQtyBase.plus(orderedBase);
    totalTargetQtyBase = totalTargetQtyBase.plus(targetBase);

    preparedLines.push({
      salesOrderLine: sol,
      previouslyFulfilledQtyBase: toDbQty(fulfilledBase),
      targetPickQtyBase: toDbQty(targetBase),
      remainingAfterTargetQtyBase: toDbQty(remainingAfterTarget),
      notes: reqLine?.notes?.trim() ?? null,
    });
  }

  if (preparedLines.length === 0) {
    throw new BusinessRuleError(
      `Seluruh baris pada Sales Order ${so.so_number} sudah terpenuhi atau tidak ada baris dengan sisa kuantitas > 0.`,
    );
  }

  const fulfillmentDate = input.fulfillmentDate ?? businessDate();
  const fulfillmentNo = await nextDocumentNumber(tx, {
    docType: "FUL",
    warehouseCode: wh.code,
  });
  const fulfillmentId = `ful_${crypto.randomUUID()}`;

  const [createdFulfillment] = await tx
    .insert(salesFulfillments)
    .values({
      id: fulfillmentId,
      fulfillmentNo,
      salesOrderId: so.id,
      customerId: so.customer_id,
      warehouseId: so.warehouse_id,
      fulfillmentDate,
      status: "draft",
      isPartialFulfillment: isPartial,
      qtyTolerancePct: tolerance.toFixed(2),
      totalOrderedQtyBase: toDbQty(totalOrderedQtyBase),
      totalPickedQtyBase: "0.000",
      totalPackedQtyBase: "0.000",
      totalRemainingQtyBase: toDbQty(totalTargetQtyBase),
      totalCogsAmount: "0.00",
      notes: input.notes?.trim() ?? null,
      createdBy: ctx.user.id,
    })
    .returning();

  const createdLines = [];
  for (let i = 0; i < preparedLines.length; i++) {
    const p = preparedLines[i]!;
    const sol = p.salesOrderLine;
    const [line] = await tx
      .insert(salesFulfillmentLines)
      .values({
        id: `full_${crypto.randomUUID()}`,
        fulfillmentId,
        salesOrderLineId: sol.id,
        lineNo: i + 1,
        orderedProductId: sol.productId,
        orderedGradeId: sol.gradeId,
        orderedGradeCode: sol.gradeCode,
        actualProductId: sol.productId,
        actualGradeId: sol.gradeId,
        actualGradeCode: sol.gradeCode,
        isSubstitution: false,
        orderedUomCode: sol.orderedUomCode,
        orderedQty: sol.orderedQty,
        uomFactorToBaseSnapshot: sol.uomFactorToBaseSnapshot,
        orderedQtyBase: sol.orderedQtyBase,
        previouslyFulfilledQtyBase: p.previouslyFulfilledQtyBase,
        targetPickQtyBase: p.targetPickQtyBase,
        pickedUomCode: sol.orderedUomCode,
        pickedQty: "0.000",
        grossWeightKg: "0.000",
        tareWeightKg: "0.000",
        netWeightKg: "0.000",
        pickedQtyBase: "0.000",
        packedQtyBase: "0.000",
        remainingBackorderQtyBase: p.remainingAfterTargetQtyBase,
        varianceQtyBase: "0.000",
        variancePct: "0.00",
        netUnitPriceSnapshot: sol.netUnitPrice,
        netUnitPriceBaseSnapshot: sol.netUnitPriceBase,
        lineCogsAmount: "0.00",
        backorderStatus: parseQty(p.remainingAfterTargetQtyBase).gt(0)
          ? "open_backorder"
          : "none",
        isStockIssued: false,
        notes: p.notes,
      })
      .returning();
    createdLines.push(line!);
  }

  await recordAudit(tx, {
    ctx,
    action: "fulfillment.create",
    entityType: "sales_fulfillment",
    entityId: fulfillmentId,
    warehouseId: so.warehouse_id,
    afterData: { fulfillment: createdFulfillment, lines: createdLines },
  });

  return {
    fulfillment: createdFulfillment!,
    lines: createdLines,
  };
}

// ============================================================================
// 2. RECORD FULFILLMENT PICKING, ACTUAL WEIGHING, FEFO ALLOCATION & COGS GL
// ============================================================================

export interface PickBatchAllocationInput {
  batchId: string;
  locationId?: string;
  qtyBase: string | number;
  scannedBarcode?: string;
}

export interface RecordFulfillmentPickLineInput {
  fulfillmentLineId: string;
  pickedUomCode?: string;
  pickedQty?: string | number;
  grossWeightKg?: string | number;
  tareWeightKg?: string | number;
  actualProductId?: string;
  actualGradeId?: string;
  scannedBarcode?: string;
  batchAllocations?: PickBatchAllocationInput[];
  substitutionApprovalId?: string;
  varianceApprovalId?: string;
  requestOverrideApproval?: boolean;
  overrideReason?: string;
  notes?: string;
}

export interface RecordFulfillmentPickingInput {
  fulfillmentId: string;
  idempotencyKey?: string;
  enforceProductionCostingGate?: boolean;
  picks: RecordFulfillmentPickLineInput[];
}

export async function recordFulfillmentPicking(
  tx: DbExecutor,
  ctx: ActorContext,
  input: RecordFulfillmentPickingInput,
) {
  const executePicking = async () => {
    // 1. Lock fulfillment row FOR UPDATE
    const fulLockRes = await tx.execute<{
      id: string;
      fulfillment_no: string;
      sales_order_id: string;
      customer_id: string;
      warehouse_id: string;
      fulfillment_date: string;
      status: string;
      qty_tolerance_pct: string;
      version: number;
    }>(
      sql`SELECT id, fulfillment_no, sales_order_id, customer_id, warehouse_id,
                 fulfillment_date, status, qty_tolerance_pct, version
          FROM sales_fulfillments
          WHERE id = ${input.fulfillmentId}
          FOR UPDATE`,
    );

    const ful = fulLockRes.rows[0];
    if (!ful) {
      throw new NotFoundError("Dokumen pemenuhan (Fulfillment) tidak ditemukan.");
    }

    authorize(ctx, "fulfillment.pick_pack", { warehouseId: ful.warehouse_id });

    // Lock parent Sales Order FOR UPDATE to serialize concurrent fulfillments on the same SO
    const soLockRes = await tx.execute<{
      id: string;
      so_number: string;
      status: string;
      version: number;
    }>(
      sql`SELECT id, so_number, status, version
          FROM sales_orders
          WHERE id = ${ful.sales_order_id}
          FOR UPDATE`,
    );
    const so = soLockRes.rows[0];
    if (!so) {
      throw new NotFoundError("Sales Order induk tidak ditemukan.");
    }

    if (!["draft", "picking", "exception_hold"].includes(ful.status)) {
      throw new BusinessRuleError(
        `Dokumen pemenuhan ${ful.fulfillment_no} berstatus '${ful.status}' dan tidak dapat dilakukan picking ulang.`,
      );
    }

    if (!input.picks || input.picks.length === 0) {
      throw new BusinessRuleError("Daftar item picking tidak boleh kosong.");
    }

    // Evaluate production costing policy gate before issuing stock & posting COGS
    await evaluateCostingPolicyGate(tx, {
      enforceProductionGate: input.enforceProductionCostingGate,
    });

    const existingLines = await tx
      .select()
      .from(salesFulfillmentLines)
      .where(eq(salesFulfillmentLines.fulfillmentId, ful.id))
      .orderBy(asc(salesFulfillmentLines.lineNo));

    const lineById = new Map(existingLines.map((l) => [l.id, l]));
    const tolerancePct = new MoneyDecimal(ful.qty_tolerance_pct);

    const createdExceptions = [];
    const createdApprovals = [];

    // First pass: validate UoM, weighing, substitution, and variance tolerance for all pick lines
    const validatedPicks: Array<{
      line: typeof existingLines[number];
      pickInput: RecordFulfillmentPickLineInput;
      actualProduct: typeof products.$inferSelect;
      actualGrade: typeof productGrades.$inferSelect;
      isSubstitution: boolean;
      pickedUomCode: string;
      pickedQty: string;
      grossWeightKg: string;
      tareWeightKg: string;
      netWeightKg: string;
      pickedQtyBase: string;
      varianceQtyBase: string;
      variancePct: string;
      substitutionApprovalId: string | null;
      varianceApprovalId: string | null;
    }> = [];

    for (const pickInput of input.picks) {
      const line = lineById.get(pickInput.fulfillmentLineId);
      if (!line) {
        throw new NotFoundError(
          `Baris pemenuhan '${pickInput.fulfillmentLineId}' tidak ditemukan pada dokumen ${ful.fulfillment_no}.`,
        );
      }

      if (line.isStockIssued) {
        throw new BusinessRuleError(
          `Baris pemenuhan #${line.lineNo} sudah pernah dikeluarkan stoknya (stock issued). Duplikasi pengeluaran stok ditolak.`,
        );
      }

      const actualProductId = pickInput.actualProductId ?? line.orderedProductId;
      const actualGradeId = pickInput.actualGradeId ?? line.orderedGradeId;

      const [actualProduct] = await tx
        .select()
        .from(products)
        .where(eq(products.id, actualProductId))
        .limit(1);
      if (!actualProduct) {
        throw new NotFoundError(`Produk '${actualProductId}' tidak ditemukan.`);
      }

      const [actualGrade] = await tx
        .select()
        .from(productGrades)
        .where(eq(productGrades.id, actualGradeId))
        .limit(1);
      if (!actualGrade || actualGrade.productId !== actualProduct.id) {
        throw new BusinessRuleError(
          `Grade '${actualGradeId}' tidak valid untuk produk ${actualProduct.name}.`,
        );
      }

      const isSubstitution =
        actualProduct.id !== line.orderedProductId || actualGrade.id !== line.orderedGradeId;

      // Validate weighing & UoM conversion
      const pickedUomCode = (pickInput.pickedUomCode ?? line.orderedUomCode).toLowerCase();
      let grossKg = new MoneyDecimal(0);
      let tareKg = new MoneyDecimal(0);
      let netKg = new MoneyDecimal(0);
      const hasWeighingInput =
        pickInput.grossWeightKg !== undefined &&
        pickInput.grossWeightKg !== null &&
        String(pickInput.grossWeightKg).trim() !== "";

      if (hasWeighingInput) {
        grossKg = roundQty(parseQty(pickInput.grossWeightKg!));
        tareKg = roundQty(parseQty(pickInput.tareWeightKg ?? "0"));
        if (grossKg.lte(0)) {
          throw new BusinessRuleError(
            `Baris #${line.lineNo}: Berat bruto timbangan harus lebih besar dari 0 kg.`,
          );
        }
        if (tareKg.lt(0) || tareKg.gte(grossKg)) {
          throw new BusinessRuleError(
            `Baris #${line.lineNo}: Berat tara (${toDbQty(tareKg)} kg) tidak boleh negatif atau melebihi/sama dengan berat bruto (${toDbQty(grossKg)} kg).`,
          );
        }
        netKg = netWeight(grossKg, tareKg);
      }

      let pickedQty =
        pickInput.pickedQty !== undefined
          ? roundQty(parseQty(pickInput.pickedQty))
          : hasWeighingInput && pickedUomCode === "kg"
            ? netKg
            : new MoneyDecimal(0);

      let pickedQtyBase: Money;

      if (pickedUomCode === actualProduct.baseUomCode.toLowerCase()) {
        if (hasWeighingInput && actualProduct.baseUomCode.toLowerCase() === "kg") {
          pickedQtyBase = netKg;
          if (pickInput.pickedQty === undefined) {
            pickedQty = netKg;
          }
        } else {
          pickedQtyBase = pickedQty;
        }
      } else {
        const [conv] = await tx
          .select()
          .from(productUomConversions)
          .where(
            and(
              eq(productUomConversions.productId, actualProduct.id),
              eq(productUomConversions.uomCode, pickedUomCode),
            ),
          )
          .limit(1);

        if (!conv) {
          throw new BusinessRuleError(
            `Baris #${line.lineNo}: Konversi satuan dari ${pickedUomCode} ke ${actualProduct.baseUomCode} untuk produk ${actualProduct.name} tidak ditemukan.`,
          );
        }

        if (conv.isNominal || conv.requiresActualWeight) {
          if (!hasWeighingInput) {
            throw new BusinessRuleError(
              `Baris #${line.lineNo}: Satuan ${pickedUomCode} bersifat estimasi/catch-weight. Wajib memasukkan hasil timbang aktual (grossWeightKg & tareWeightKg) saat picking.`,
            );
          }
          pickedQtyBase = netKg;
        } else {
          pickedQtyBase = toBaseQty(
            pickedQty,
            {
              factorToBase: conv.factorToBase,
              isNominal: conv.isNominal,
              requiresActualWeight: conv.requiresActualWeight,
            },
            "billing",
          );
        }
      }

      if (pickedQtyBase.lte(0)) {
        throw new BusinessRuleError(
          `Baris #${line.lineNo}: Kuantitas hasil picking dalam satuan dasar (${actualProduct.baseUomCode}) harus lebih besar dari 0.`,
        );
      }

      const targetBase = roundQty(parseQty(line.targetPickQtyBase));
      const varianceBase = roundQty(pickedQtyBase.minus(targetBase));
      const variancePct = targetBase.gt(0)
        ? varianceBase.div(targetBase).mul(100).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP)
        : new MoneyDecimal(0);

      // Check Substitution Approval
      let subApprovalId = pickInput.substitutionApprovalId ?? line.substitutionApprovalId ?? null;
      if (isSubstitution) {
        let subApproved = false;
        if (subApprovalId) {
          const [app] = await tx
            .select()
            .from(approvals)
            .where(eq(approvals.id, subApprovalId))
            .limit(1);
          if (app && app.status === "approved") {
            subApproved = true;
          }
        }

        if (!subApproved) {
          if (pickInput.requestOverrideApproval) {
            const reason =
              pickInput.overrideReason?.trim() ||
              `Permintaan substitusi produk/grade pada baris #${line.lineNo}: ${line.orderedGradeCode} -> ${actualGrade.code}`;
            const app = await requestApproval(tx, ctx, {
              approvalType: "fulfillment_substitution",
              sourceDocType: "sales_fulfillment",
              sourceDocId: ful.id,
              warehouseId: ful.warehouse_id,
              requestReason: reason,
              ruleSnapshot: {
                fulfillmentLineId: line.id,
                orderedProductId: line.orderedProductId,
                orderedGradeId: line.orderedGradeId,
                actualProductId: actualProduct.id,
                actualGradeId: actualGrade.id,
              },
            });
            subApprovalId = app.id;
            createdApprovals.push(app);

            const [exc] = await tx
              .insert(fulfillmentExceptions)
              .values({
                id: `fexc_${crypto.randomUUID()}`,
                fulfillmentId: ful.id,
                fulfillmentLineId: line.id,
                exceptionType: "substitution",
                severity: "blocking",
                status: "open",
                approvalId: app.id,
                reasonCode: "PRODUCT_OR_GRADE_SUBSTITUTION",
                description: reason,
                reportedBy: ctx.user.id,
              })
              .returning();
            createdExceptions.push(exc!);

            await tx
              .update(salesFulfillmentLines)
              .set({
                actualProductId: actualProduct.id,
                actualGradeId: actualGrade.id,
                actualGradeCode: actualGrade.code,
                isSubstitution: true,
                substitutionApprovalId: app.id,
              })
              .where(eq(salesFulfillmentLines.id, line.id));
          } else {
            throw new BusinessRuleError(
              `Baris #${line.lineNo}: Substitusi produk atau grade (${line.orderedGradeCode} -> ${actualGrade.code}) wajib mendapatkan persetujuan (approval) terlebih dahulu.`,
            );
          }
        }
      }

      // Check Quantity / Weight Variance Tolerance (over-picking beyond tolerance requires approval)
      let varApprovalId = pickInput.varianceApprovalId ?? line.varianceApprovalId ?? null;
      const exceedsPositiveTolerance =
        varianceBase.gt(0) && variancePct.abs().gt(tolerancePct);

      if (exceedsPositiveTolerance) {
        let varApproved = false;
        if (varApprovalId) {
          const [app] = await tx
            .select()
            .from(approvals)
            .where(eq(approvals.id, varApprovalId))
            .limit(1);
          if (app && app.status === "approved") {
            varApproved = true;
          }
        }

        if (!varApproved) {
          if (pickInput.requestOverrideApproval) {
            const reason =
              pickInput.overrideReason?.trim() ||
              `Selisih timbang/kuantitas picking baris #${line.lineNo} sebesar +${variancePct.toFixed(2)}% melebihi batas toleransi ${tolerancePct.toFixed(2)}%.`;
            const app = await requestApproval(tx, ctx, {
              approvalType: "fulfillment_variance_override",
              sourceDocType: "sales_fulfillment",
              sourceDocId: ful.id,
              warehouseId: ful.warehouse_id,
              requestReason: reason,
              ruleSnapshot: {
                fulfillmentLineId: line.id,
                targetPickQtyBase: line.targetPickQtyBase,
                pickedQtyBase: toDbQty(pickedQtyBase),
                variancePct: variancePct.toFixed(2),
                qtyTolerancePct: ful.qty_tolerance_pct,
              },
            });
            varApprovalId = app.id;
            createdApprovals.push(app);

            const [exc] = await tx
              .insert(fulfillmentExceptions)
              .values({
                id: `fexc_${crypto.randomUUID()}`,
                fulfillmentId: ful.id,
                fulfillmentLineId: line.id,
                exceptionType: "weight_variance",
                severity: "blocking",
                status: "open",
                approvalId: app.id,
                reasonCode: "OVER_TOLERANCE_WEIGHT_VARIANCE",
                description: reason,
                reportedBy: ctx.user.id,
              })
              .returning();
            createdExceptions.push(exc!);

            await tx
              .update(salesFulfillmentLines)
              .set({
                varianceApprovalId: app.id,
                varianceQtyBase: toDbQty(varianceBase),
                variancePct: variancePct.toFixed(2),
              })
              .where(eq(salesFulfillmentLines.id, line.id));
          } else {
            throw new BusinessRuleError(
              `Baris #${line.lineNo}: Selisih kuantitas/berat picking (+${variancePct.toFixed(2)}%) melebihi batas toleransi (${tolerancePct.toFixed(2)}%) dan membutuhkan persetujuan (approval).`,
            );
          }
        }
      }

      validatedPicks.push({
        line,
        pickInput,
        actualProduct,
        actualGrade,
        isSubstitution,
        pickedUomCode,
        pickedQty: toDbQty(pickedQty),
        grossWeightKg: toDbQty(grossKg),
        tareWeightKg: toDbQty(tareKg),
        netWeightKg: toDbQty(netKg),
        pickedQtyBase: toDbQty(pickedQtyBase),
        varianceQtyBase: toDbQty(varianceBase),
        variancePct: variancePct.toFixed(2),
        substitutionApprovalId: subApprovalId,
        varianceApprovalId: varApprovalId,
      });
    }

    // If any blocking exception / pending approval was triggered, hold the fulfillment without issuing stock
    if (createdExceptions.length > 0) {
      const [heldFulfillment] = await tx
        .update(salesFulfillments)
        .set({
          status: "exception_hold",
          version: ful.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(salesFulfillments.id, ful.id))
        .returning();

      await recordAudit(tx, {
        ctx,
        action: "fulfillment.exception_hold",
        entityType: "sales_fulfillment",
        entityId: ful.id,
        warehouseId: ful.warehouse_id,
        afterData: {
          fulfillment: heldFulfillment,
          exceptions: createdExceptions,
          approvals: createdApprovals,
        },
      });

      return {
        fulfillment: heldFulfillment!,
        lines: await tx
          .select()
          .from(salesFulfillmentLines)
          .where(eq(salesFulfillmentLines.fulfillmentId, ful.id))
          .orderBy(asc(salesFulfillmentLines.lineNo)),
        allocations: [],
        exceptions: createdExceptions,
        approvals: createdApprovals,
        journalEntry: null,
      };
    }

    // Second pass: lock reservations & FEFO stock balances FOR UPDATE, issue stock, and record allocations
    const allCreatedAllocations: Array<typeof fulfillmentPickAllocations.$inferSelect> = [];
    let totalFulfillmentCogs = new MoneyDecimal(0);

    for (const vp of validatedPicks) {
      const { line, pickInput, actualProduct, actualGrade, isSubstitution } = vp;
      let remainingToPick = roundQty(parseQty(vp.pickedQtyBase));
      const pickedNow = remainingToPick;
      let lineCogs = new MoneyDecimal(0);

      // Lock parent sales_order_lines FOR UPDATE to prevent concurrent double-fulfillment
      const solLockRes = await tx.execute<{
        id: string;
        ordered_qty_base: string;
        reserved_qty_base: string;
        fulfilled_qty_base: string;
      }>(
        sql`SELECT id, ordered_qty_base, reserved_qty_base, fulfilled_qty_base
            FROM sales_order_lines
            WHERE id = ${line.salesOrderLineId}
            FOR UPDATE`,
      );
      const solLocked = solLockRes.rows[0];
      if (!solLocked) {
        throw new NotFoundError("Baris Sales Order induk tidak ditemukan.");
      }

      const prevFulfilledOnSo = roundQty(parseQty(solLocked.fulfilled_qty_base));
      const orderedOnSo = roundQty(parseQty(solLocked.ordered_qty_base));
      const reservedOnSo = roundQty(parseQty(solLocked.reserved_qty_base));
      const remainingUnfulfilledOnSo = roundQty(orderedOnSo.minus(prevFulfilledOnSo));

      if (remainingUnfulfilledOnSo.lte(0)) {
        throw new BusinessRuleError(
          `Baris #${line.lineNo}: Kuantitas pesanan pada Sales Order sudah terpenuhi seluruhnya (${toDbQty(prevFulfilledOnSo)} / ${toDbQty(orderedOnSo)}). Pengambilan ganda (double picking) ditolak.`,
        );
      }

      const maxAllowedWithoutOverride = roundQty(
        remainingUnfulfilledOnSo.mul(new MoneyDecimal(1).plus(tolerancePct.div(100))),
      );
      if (pickedNow.gt(maxAllowedWithoutOverride) && !vp.varianceApprovalId) {
        throw new BusinessRuleError(
          `Baris #${line.lineNo}: Kuantitas picking (${toDbQty(pickedNow)}) melebihi sisa kuantitas Sales Order yang belum dipenuhi (${toDbQty(remainingUnfulfilledOnSo)}).`,
        );
      }

      // Verify line-level scanned barcode if provided
      if (pickInput.scannedBarcode?.trim()) {
        const scanned = pickInput.scannedBarcode.trim();
        const matchesProductSkuOrBarcode =
          scanned === actualProduct.sku ||
          (actualProduct.barcode && scanned === actualProduct.barcode);

        if (!matchesProductSkuOrBarcode) {
          // Must match one of the eligible batches for this product + grade in this warehouse
          const [matchingBatch] = await tx
            .select()
            .from(batches)
            .where(
              and(
                eq(batches.warehouseId, ful.warehouse_id),
                eq(batches.batchCode, scanned),
              ),
            )
            .limit(1);

          if (
            !matchingBatch ||
            matchingBatch.productId !== actualProduct.id ||
            matchingBatch.gradeId !== actualGrade.id
          ) {
            throw new BusinessRuleError(
              `Baris #${line.lineNo}: Barcode yang dipindai ('${scanned}') tidak cocok dengan SKU/barcode produk (${actualProduct.sku}) maupun kode batch aktif untuk ${actualProduct.name} Grade ${actualGrade.code}.`,
            );
          }
        }
      }

      // If caller provided explicit batchAllocations, validate their sum equals pickedQtyBase and check FEFO eligibility
      const explicitBatchMap = new Map<
        string,
        { qtyBase: Money; locationId?: string; scannedBarcode?: string }
      >();
      if (pickInput.batchAllocations && pickInput.batchAllocations.length > 0) {
        let sumAlloc = new MoneyDecimal(0);
        for (const ba of pickInput.batchAllocations) {
          const q = roundQty(parseQty(ba.qtyBase));
          if (q.lte(0)) {
            throw new BusinessRuleError(
              `Baris #${line.lineNo}: Kuantitas alokasi batch harus lebih besar dari 0.`,
            );
          }

          const [explicitBatch] = await tx
            .select()
            .from(batches)
            .where(eq(batches.id, ba.batchId))
            .limit(1);
          if (!explicitBatch || explicitBatch.warehouseId !== ful.warehouse_id) {
            throw new NotFoundError(`Batch '${ba.batchId}' tidak ditemukan di gudang ini.`);
          }
          if (
            explicitBatch.productId !== actualProduct.id ||
            explicitBatch.gradeId !== actualGrade.id
          ) {
            throw new BusinessRuleError(
              `Batch ${explicitBatch.batchCode} tidak sesuai dengan produk/grade yang diambil (${actualProduct.name} Grade ${actualGrade.code}).`,
            );
          }
          if (explicitBatch.status !== "active") {
            throw new BusinessRuleError(
              `Batch ${explicitBatch.batchCode} memiliki status '${explicitBatch.status}' dan diblokir dari picking.`,
            );
          }
          if (
            explicitBatch.bestBeforeDate &&
            explicitBatch.bestBeforeDate < ful.fulfillment_date
          ) {
            throw new BusinessRuleError(
              `Batch ${explicitBatch.batchCode} sudah melewati tanggal terbaik sebelum (${explicitBatch.bestBeforeDate}) pada tanggal picking ${ful.fulfillment_date} dan diblokir oleh aturan FEFO.`,
            );
          }

          sumAlloc = sumAlloc.plus(q);
          explicitBatchMap.set(ba.batchId, {
            qtyBase: q,
            locationId: ba.locationId,
            scannedBarcode: ba.scannedBarcode,
          });
        }
        if (!sumAlloc.eq(remainingToPick)) {
          throw new BusinessRuleError(
            `Baris #${line.lineNo}: Total alokasi batch (${toDbQty(sumAlloc)}) tidak sama dengan kuantitas hasil picking (${toDbQty(remainingToPick)}).`,
          );
        }
      }

      let takenFromReserved = new MoneyDecimal(0);
      const unconsumedSoReservation = reservedOnSo.gt(prevFulfilledOnSo)
        ? roundQty(reservedOnSo.minus(prevFulfilledOnSo))
        : new MoneyDecimal(0);
      const minRequiredFromReservation = !isSubstitution
        ? pickedNow.lt(unconsumedSoReservation)
          ? pickedNow
          : unconsumedSoReservation
        : new MoneyDecimal(0);

      // Step 2A: Consume active reservations for this SO line in FEFO order (if not product/grade substitution)
      if (!isSubstitution) {
        const resLock = await tx.execute<{
          reservation_id: string;
          location_id: string;
          batch_id: string;
          batch_code: string;
          best_before_date: string | null;
          batch_status: string;
          reserved_qty_base: string;
          fulfilled_qty_base: string;
          balance_qty_base: string;
        }>(
          sql`SELECT
                sr.id AS reservation_id,
                sr.location_id,
                sr.batch_id,
                b.batch_code,
                b.best_before_date,
                b.status AS batch_status,
                sr.reserved_qty_base,
                sr.fulfilled_qty_base,
                sb.qty_base AS balance_qty_base
              FROM stock_reservations sr
              INNER JOIN batches b ON b.id = sr.batch_id
              INNER JOIN stock_balances sb
                ON sb.warehouse_id = sr.warehouse_id
               AND sb.location_id = sr.location_id
               AND sb.batch_id = sr.batch_id
               AND sb.stock_status = 'reserved'
              WHERE sr.source_doc_type = 'sales_order'
                AND sr.source_doc_id = ${ful.sales_order_id}
                AND sr.product_id = ${actualProduct.id}
                AND sr.grade_id = ${actualGrade.id}
                AND sr.status = 'active'
              ORDER BY
                b.best_before_date ASC NULLS LAST,
                b.received_at ASC,
                b.batch_code ASC
              FOR UPDATE OF sr, sb, b`,
        );

        for (const r of resLock.rows) {
          if (remainingToPick.lte(0)) break;

          if (explicitBatchMap.size > 0 && !explicitBatchMap.has(r.batch_id)) {
            continue;
          }

          if (r.batch_status !== "active") {
            throw new BusinessRuleError(
              `Batch ${r.batch_code} memiliki status '${r.batch_status}' dan tidak boleh diambil untuk pengiriman.`,
            );
          }
          if (r.best_before_date && r.best_before_date < ful.fulfillment_date) {
            throw new BusinessRuleError(
              `Batch ${r.batch_code} telah melewati tanggal terbaik sebelum (best-before ${r.best_before_date}) pada tanggal pemenuhan ${ful.fulfillment_date}.`,
            );
          }

          const explicitSpec = explicitBatchMap.get(r.batch_id);
          if (explicitSpec?.scannedBarcode?.trim()) {
            const sbCode = explicitSpec.scannedBarcode.trim();
            if (
              sbCode !== r.batch_code &&
              sbCode !== actualProduct.sku &&
              sbCode !== actualProduct.barcode
            ) {
              throw new BusinessRuleError(
                `Barcode alokasi ('${sbCode}') tidak cocok dengan kode batch ${r.batch_code}.`,
              );
            }
          }

          const remRes = roundQty(
            parseQty(r.reserved_qty_base).minus(parseQty(r.fulfilled_qty_base)),
          );
          const balQty = roundQty(parseQty(r.balance_qty_base));
          let takeQty = remRes.lt(balQty) ? remRes : balQty;
          if (takeQty.gt(remainingToPick)) {
            takeQty = remainingToPick;
          }
          if (explicitSpec && takeQty.gt(explicitSpec.qtyBase)) {
            takeQty = explicitSpec.qtyBase;
          }

          if (takeQty.lte(0)) continue;

          const movResult = await applyInventoryMovement(tx, ctx, {
            warehouseId: ful.warehouse_id,
            locationId: r.location_id,
            batchId: r.batch_id,
            productId: actualProduct.id,
            gradeId: actualGrade.id,
            movementType: "sales_pick_issue",
            stockStatus: "reserved",
            qtyDeltaBase: toDbQty(takeQty.neg()),
            sourceDocType: "sales_fulfillment",
            sourceDocId: ful.id,
            sourceLineId: line.id,
            reasonCode: "SALES_PICK_ISSUE",
            notes: `Pengeluaran picking SO ${so.so_number} (${ful.fulfillment_no}) dari stok reserved batch ${r.batch_code}`,
          });

          const newFulfilledRes = roundQty(parseQty(r.fulfilled_qty_base).plus(takeQty));
          const isResComplete = newFulfilledRes.gte(parseQty(r.reserved_qty_base));

          await tx
            .update(stockReservations)
            .set({
              fulfilledQtyBase: toDbQty(newFulfilledRes),
              status: isResComplete ? "fulfilled" : "active",
              updatedAt: new Date(),
            })
            .where(eq(stockReservations.id, r.reservation_id));

          const costOut = new MoneyDecimal(movResult.movement.costDelta).abs();
          lineCogs = lineCogs.plus(costOut);
          totalFulfillmentCogs = totalFulfillmentCogs.plus(costOut);

          const [alloc] = await tx
            .insert(fulfillmentPickAllocations)
            .values({
              id: `fpa_${crypto.randomUUID()}`,
              fulfillmentId: ful.id,
              fulfillmentLineId: line.id,
              reservationId: r.reservation_id,
              warehouseId: ful.warehouse_id,
              locationId: r.location_id,
              batchId: r.batch_id,
              productId: actualProduct.id,
              gradeId: actualGrade.id,
              sourceStockStatus: "reserved",
              pickedQtyBase: toDbQty(takeQty),
              unitCostBase: movResult.movement.unitCostBase,
              costOutflow: toDbAmount(costOut),
              movementId: movResult.movement.id,
              scannedBarcode:
                explicitSpec?.scannedBarcode?.trim() ??
                pickInput.scannedBarcode?.trim() ??
                r.batch_code,
              pickedBy: ctx.user.id,
            })
            .returning();

          allCreatedAllocations.push(alloc!);
          takenFromReserved = roundQty(takenFromReserved.plus(takeQty));
          remainingToPick = roundQty(remainingToPick.minus(takeQty));
          if (explicitSpec) {
            explicitSpec.qtyBase = roundQty(explicitSpec.qtyBase.minus(takeQty));
          }
        }

        if (takenFromReserved.lt(minRequiredFromReservation)) {
          throw new BusinessRuleError(
            `Baris #${line.lineNo}: Reservasi stok FEFO untuk Sales Order ini tidak mencukupi atau sudah dikonsumsi oleh proses picking lain (dibutuhkan dari reservasi: ${toDbQty(minRequiredFromReservation)}, tersedia: ${toDbQty(takenFromReserved)}).`,
          );
        }
      }

      // Step 2B: If remainingToPick > 0 (e.g. approved substitution or within-tolerance positive variance),
      // lock and consume eligible FEFO 'available' stock balances
      if (remainingToPick.gt(0)) {
        const availLock = await tx.execute<{
          balance_id: string;
          location_id: string;
          batch_id: string;
          batch_code: string;
          best_before_date: string | null;
          batch_status: string;
          qty_base: string;
        }>(
          sql`SELECT
                sb.id AS balance_id,
                sb.location_id,
                sb.batch_id,
                b.batch_code,
                b.best_before_date,
                b.status AS batch_status,
                sb.qty_base
              FROM stock_balances sb
              INNER JOIN batches b ON b.id = sb.batch_id
              WHERE sb.warehouse_id = ${ful.warehouse_id}
                AND sb.product_id = ${actualProduct.id}
                AND sb.grade_id = ${actualGrade.id}
                AND sb.stock_status = 'available'
                AND sb.qty_base > 0
                AND b.status = 'active'
                AND (b.best_before_date IS NULL OR b.best_before_date >= ${ful.fulfillment_date})
              ORDER BY
                b.best_before_date ASC NULLS LAST,
                b.received_at ASC,
                b.batch_code ASC
              FOR UPDATE OF sb, b`,
        );

        for (const av of availLock.rows) {
          if (remainingToPick.lte(0)) break;

          if (explicitBatchMap.size > 0) {
            const spec = explicitBatchMap.get(av.batch_id);
            if (!spec || spec.qtyBase.lte(0)) continue;
          }

          const explicitSpec = explicitBatchMap.get(av.batch_id);
          if (explicitSpec?.scannedBarcode?.trim()) {
            const sbCode = explicitSpec.scannedBarcode.trim();
            if (
              sbCode !== av.batch_code &&
              sbCode !== actualProduct.sku &&
              sbCode !== actualProduct.barcode
            ) {
              throw new BusinessRuleError(
                `Barcode alokasi ('${sbCode}') tidak cocok dengan kode batch ${av.batch_code}.`,
              );
            }
          }

          const availQty = roundQty(parseQty(av.qty_base));
          let takeQty = availQty.lt(remainingToPick) ? availQty : remainingToPick;
          if (explicitSpec && takeQty.gt(explicitSpec.qtyBase)) {
            takeQty = explicitSpec.qtyBase;
          }

          if (takeQty.lte(0)) continue;

          const movResult = await applyInventoryMovement(tx, ctx, {
            warehouseId: ful.warehouse_id,
            locationId: av.location_id,
            batchId: av.batch_id,
            productId: actualProduct.id,
            gradeId: actualGrade.id,
            movementType: "sales_pick_issue",
            stockStatus: "available",
            qtyDeltaBase: toDbQty(takeQty.neg()),
            sourceDocType: "sales_fulfillment",
            sourceDocId: ful.id,
            sourceLineId: line.id,
            reasonCode: "SALES_PICK_ISSUE",
            notes: `Pengeluaran picking SO ${so.so_number} (${ful.fulfillment_no}) dari stok available batch ${av.batch_code}`,
          });

          const costOut = new MoneyDecimal(movResult.movement.costDelta).abs();
          lineCogs = lineCogs.plus(costOut);
          totalFulfillmentCogs = totalFulfillmentCogs.plus(costOut);

          const [alloc] = await tx
            .insert(fulfillmentPickAllocations)
            .values({
              id: `fpa_${crypto.randomUUID()}`,
              fulfillmentId: ful.id,
              fulfillmentLineId: line.id,
              reservationId: null,
              warehouseId: ful.warehouse_id,
              locationId: av.location_id,
              batchId: av.batch_id,
              productId: actualProduct.id,
              gradeId: actualGrade.id,
              sourceStockStatus: "available",
              pickedQtyBase: toDbQty(takeQty),
              unitCostBase: movResult.movement.unitCostBase,
              costOutflow: toDbAmount(costOut),
              movementId: movResult.movement.id,
              scannedBarcode:
                explicitSpec?.scannedBarcode?.trim() ??
                pickInput.scannedBarcode?.trim() ??
                av.batch_code,
              pickedBy: ctx.user.id,
            })
            .returning();

          allCreatedAllocations.push(alloc!);
          remainingToPick = roundQty(remainingToPick.minus(takeQty));
          if (explicitSpec) {
            explicitSpec.qtyBase = roundQty(explicitSpec.qtyBase.minus(takeQty));
          }
        }
      }

      if (remainingToPick.gt(0)) {
        throw new BusinessRuleError(
          `Baris #${line.lineNo} (${actualProduct.name} Grade ${actualGrade.code}): Stok yang memenuhi syarat FEFO tidak mencukupi. Kurang ${toDbQty(remainingToPick)} ${actualProduct.baseUomCode}.`,
        );
      }

      // Compute remaining backorder quantity on the parent Sales Order Line
      const newFulfilledOnSo = roundQty(prevFulfilledOnSo.plus(pickedNow));
      const remainingBackorder = orderedOnSo.gt(newFulfilledOnSo)
        ? roundQty(orderedOnSo.minus(newFulfilledOnSo))
        : new MoneyDecimal(0);

      const backorderStatus = remainingBackorder.gt(0) ? "open_backorder" : "fulfilled";

      await tx
        .update(salesFulfillmentLines)
        .set({
          actualProductId: actualProduct.id,
          actualGradeId: actualGrade.id,
          actualGradeCode: actualGrade.code,
          isSubstitution,
          substitutionApprovalId: vp.substitutionApprovalId,
          varianceApprovalId: vp.varianceApprovalId,
          pickedUomCode: vp.pickedUomCode,
          pickedQty: vp.pickedQty,
          grossWeightKg: vp.grossWeightKg,
          tareWeightKg: vp.tareWeightKg,
          netWeightKg: vp.netWeightKg,
          pickedQtyBase: vp.pickedQtyBase,
          packedQtyBase: vp.pickedQtyBase,
          remainingBackorderQtyBase: toDbQty(remainingBackorder),
          varianceQtyBase: vp.varianceQtyBase,
          variancePct: vp.variancePct,
          lineCogsAmount: toDbAmount(lineCogs),
          backorderStatus,
          isStockIssued: true,
          scannedBarcode: pickInput.scannedBarcode?.trim() ?? null,
          pickedBy: ctx.user.id,
          pickedAt: new Date(),
          notes: pickInput.notes?.trim() ?? line.notes,
        })
        .where(eq(salesFulfillmentLines.id, line.id));

      await tx
        .update(salesOrderLines)
        .set({
          fulfilledQtyBase: toDbQty(newFulfilledOnSo),
        })
        .where(eq(salesOrderLines.id, line.salesOrderLineId));
    }

    // Re-read all fulfillment lines to compute header totals & check if all lines are picked
    const updatedLines = await tx
      .select()
      .from(salesFulfillmentLines)
      .where(eq(salesFulfillmentLines.fulfillmentId, ful.id))
      .orderBy(asc(salesFulfillmentLines.lineNo));

    let sumPicked = new MoneyDecimal(0);
    let sumRemaining = new MoneyDecimal(0);
    let sumCogs = new MoneyDecimal(0);
    let allIssued = true;
    let hasBackorder = false;

    for (const ul of updatedLines) {
      sumPicked = sumPicked.plus(parseQty(ul.pickedQtyBase));
      sumRemaining = sumRemaining.plus(parseQty(ul.remainingBackorderQtyBase));
      sumCogs = sumCogs.plus(parseMoney(ul.lineCogsAmount));
      if (!ul.isStockIssued) {
        allIssued = false;
      }
      if (parseQty(ul.remainingBackorderQtyBase).gt(0)) {
        hasBackorder = true;
      }
    }

    // Post balanced COGS GL Journal Entry (Debit 5100 COGS_FRUIT / Credit 1140 INVENTORY_FRUIT)
    let postedJournalEntry = null;
    if (totalFulfillmentCogs.gt(0)) {
      const glRes = await postJournalEntry(tx, ctx, {
        entryDate: ful.fulfillment_date,
        warehouseId: ful.warehouse_id,
        sourceDocType: "sales_fulfillment",
        sourceDocId: ful.id,
        purpose: "sales_cogs_issue",
        memo: `HPP Pengeluaran Stok Picking ${ful.fulfillment_no} (SO ${so.so_number})`,
        enforceProductionGate: input.enforceProductionCostingGate,
        skipDirectPermissionCheck: true,
        lines: [
          {
            accountCode: GL_ACCOUNT_CODES.COGS_FRUIT,
            debit: toDbAmount(totalFulfillmentCogs),
            warehouseId: ful.warehouse_id,
            description: `Beban HPP Buah ${ful.fulfillment_no}`,
          },
          {
            accountCode: GL_ACCOUNT_CODES.INVENTORY_FRUIT,
            credit: toDbAmount(totalFulfillmentCogs),
            warehouseId: ful.warehouse_id,
            description: `Pengurangan Persediaan Buah ${ful.fulfillment_no}`,
          },
        ],
      });
      postedJournalEntry = glRes.entry;
    }

    const newFulStatus = allIssued ? "picked" : "picking";
    const [updatedFulfillment] = await tx
      .update(salesFulfillments)
      .set({
        status: newFulStatus,
        isPartialFulfillment: ful.status === "draft" ? hasBackorder : undefined,
        totalPickedQtyBase: toDbQty(sumPicked),
        totalPackedQtyBase: toDbQty(sumPicked),
        totalRemainingQtyBase: toDbQty(sumRemaining),
        totalCogsAmount: toDbAmount(sumCogs),
        journalEntryId: postedJournalEntry?.id ?? null,
        pickedBy: ctx.user.id,
        pickedAt: new Date(),
        version: ful.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(salesFulfillments.id, ful.id))
      .returning();

    if (so.status === "confirmed") {
      await tx
        .update(salesOrders)
        .set({
          status: "picking",
          version: so.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(salesOrders.id, so.id));
    }

    await recordAudit(tx, {
      ctx,
      action: "fulfillment.pick",
      entityType: "sales_fulfillment",
      entityId: ful.id,
      warehouseId: ful.warehouse_id,
      afterData: {
        fulfillment: updatedFulfillment,
        lines: updatedLines,
        allocations: allCreatedAllocations,
        journalEntryId: postedJournalEntry?.id ?? null,
      },
    });

    return {
      fulfillment: updatedFulfillment!,
      lines: updatedLines,
      allocations: allCreatedAllocations,
      exceptions: [],
      approvals: [],
      journalEntry: postedJournalEntry,
    };
  };

  if (input.idempotencyKey?.trim()) {
    const idem = await withIdempotency(
      tx,
      {
        scope: "fulfillment.pick",
        key: input.idempotencyKey.trim(),
        payload: input,
        actorUserId: ctx.user.id,
      },
      executePicking,
    );
    return idem.result;
  }

  return executePicking();
}

// ============================================================================
// 3. REPORT & RESOLVE FULFILLMENT EXCEPTIONS
// ============================================================================

export interface ReportFulfillmentExceptionInput {
  fulfillmentId: string;
  fulfillmentLineId?: string;
  exceptionType:
    | "weight_variance"
    | "damaged_goods"
    | "batch_unavailable"
    | "substitution"
    | "price_variance";
  severity?: "warning" | "blocking";
  reasonCode: string;
  description: string;
  requestApproval?: boolean;
}

export async function reportFulfillmentException(
  tx: DbExecutor,
  ctx: ActorContext,
  input: ReportFulfillmentExceptionInput,
) {
  const [ful] = await tx
    .select()
    .from(salesFulfillments)
    .where(eq(salesFulfillments.id, input.fulfillmentId))
    .limit(1);

  if (!ful) {
    throw new NotFoundError("Dokumen pemenuhan tidak ditemukan.");
  }

  authorize(ctx, "fulfillment.pick_pack", { warehouseId: ful.warehouseId });

  if (!input.reasonCode.trim() || !input.description.trim()) {
    throw new BusinessRuleError("Kode alasan dan deskripsi pengecualian wajib diisi.");
  }

  const severity = input.severity ?? "blocking";
  let approvalId: string | null = null;

  if (input.requestApproval) {
    const approvalType =
      input.exceptionType === "substitution"
        ? "fulfillment_substitution"
        : "fulfillment_variance_override";
    const app = await requestApproval(tx, ctx, {
      approvalType,
      sourceDocType: "sales_fulfillment",
      sourceDocId: ful.id,
      warehouseId: ful.warehouseId,
      requestReason: input.description.trim(),
      ruleSnapshot: {
        fulfillmentLineId: input.fulfillmentLineId ?? null,
        exceptionType: input.exceptionType,
        reasonCode: input.reasonCode.trim(),
      },
    });
    approvalId = app.id;
  }

  const [exception] = await tx
    .insert(fulfillmentExceptions)
    .values({
      id: `fexc_${crypto.randomUUID()}`,
      fulfillmentId: ful.id,
      fulfillmentLineId: input.fulfillmentLineId ?? null,
      exceptionType: input.exceptionType,
      severity,
      status: "open",
      approvalId,
      reasonCode: input.reasonCode.trim(),
      description: input.description.trim(),
      reportedBy: ctx.user.id,
    })
    .returning();

  if (severity === "blocking" && ful.status !== "packed" && ful.status !== "dispatched") {
    await tx
      .update(salesFulfillments)
      .set({
        status: "exception_hold",
        version: ful.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(salesFulfillments.id, ful.id));
  }

  await recordAudit(tx, {
    ctx,
    action: "fulfillment.exception_report",
    entityType: "fulfillment_exception",
    entityId: exception!.id,
    warehouseId: ful.warehouseId,
    afterData: exception,
    reason: input.description.trim(),
  });

  return exception!;
}

export interface ResolveFulfillmentExceptionInput {
  exceptionId: string;
  resolutionStatus: "approved" | "resolved" | "rejected";
  resolutionNotes: string;
}

export async function resolveFulfillmentException(
  tx: DbExecutor,
  ctx: ActorContext,
  input: ResolveFulfillmentExceptionInput,
) {
  const [exc] = await tx
    .select()
    .from(fulfillmentExceptions)
    .where(eq(fulfillmentExceptions.id, input.exceptionId))
    .limit(1);

  if (!exc) {
    throw new NotFoundError("Pengecualian pemenuhan tidak ditemukan.");
  }

  const [ful] = await tx
    .select()
    .from(salesFulfillments)
    .where(eq(salesFulfillments.id, exc.fulfillmentId))
    .limit(1);

  if (!ful) {
    throw new NotFoundError("Dokumen pemenuhan tidak ditemukan.");
  }

  authorize(ctx, "fulfillment.pick_pack", { warehouseId: ful.warehouseId });

  if (!input.resolutionNotes.trim()) {
    throw new BusinessRuleError("Catatan penyelesaian pengecualian wajib diisi.");
  }

  // If linked to a pending approval, decide or verify the approval
  if (exc.approvalId) {
    const [app] = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.id, exc.approvalId))
      .limit(1);

    if (app && app.status === "pending") {
      await decideApproval(tx, ctx, {
        approvalId: app.id,
        decision: input.resolutionStatus === "rejected" ? "rejected" : "approved",
        decisionNote: input.resolutionNotes.trim(),
        expectedVersion: app.version,
      });
    }
  }

  const [updatedExc] = await tx
    .update(fulfillmentExceptions)
    .set({
      status: input.resolutionStatus,
      resolutionNotes: input.resolutionNotes.trim(),
      resolvedBy: ctx.user.id,
      resolvedAt: new Date(),
    })
    .where(eq(fulfillmentExceptions.id, exc.id))
    .returning();

  // Check if any blocking open exceptions remain
  const remainingOpen = await tx
    .select()
    .from(fulfillmentExceptions)
    .where(
      and(
        eq(fulfillmentExceptions.fulfillmentId, ful.id),
        eq(fulfillmentExceptions.status, "open"),
        eq(fulfillmentExceptions.severity, "blocking"),
      ),
    );

  if (remainingOpen.length === 0 && ful.status === "exception_hold") {
    const lines = await tx
      .select()
      .from(salesFulfillmentLines)
      .where(eq(salesFulfillmentLines.fulfillmentId, ful.id));
    const allIssued = lines.length > 0 && lines.every((l) => l.isStockIssued);

    await tx
      .update(salesFulfillments)
      .set({
        status: allIssued ? "picked" : "draft",
        version: ful.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(salesFulfillments.id, ful.id));
  }

  await recordAudit(tx, {
    ctx,
    action: "fulfillment.exception_resolve",
    entityType: "fulfillment_exception",
    entityId: exc.id,
    warehouseId: ful.warehouseId,
    beforeData: exc,
    afterData: updatedExc,
    reason: input.resolutionNotes.trim(),
  });

  return updatedExc!;
}

// ============================================================================
// 4. FINALIZE FULFILLMENT PACKING
// ============================================================================

export interface PackingChecklistInput {
  qualityChecked: boolean;
  packagingVerified: boolean;
  labelAttached: boolean;
  packageCount: number;
  notes?: string;
}

export interface FinalizeFulfillmentPackingInput {
  fulfillmentId: string;
  checklist: PackingChecklistInput;
  lines?: Array<{
    fulfillmentLineId: string;
    packedQtyBase: string | number;
  }>;
}

export async function finalizeFulfillmentPacking(
  tx: DbExecutor,
  ctx: ActorContext,
  input: FinalizeFulfillmentPackingInput,
) {
  const fulLockRes = await tx.execute<{
    id: string;
    fulfillment_no: string;
    sales_order_id: string;
    warehouse_id: string;
    status: string;
    version: number;
  }>(
    sql`SELECT id, fulfillment_no, sales_order_id, warehouse_id, status, version
        FROM sales_fulfillments
        WHERE id = ${input.fulfillmentId}
        FOR UPDATE`,
  );

  const ful = fulLockRes.rows[0];
  if (!ful) {
    throw new NotFoundError("Dokumen pemenuhan tidak ditemukan.");
  }

  authorize(ctx, "fulfillment.pick_pack", { warehouseId: ful.warehouse_id });

  // Check for unresolved blocking exceptions FIRST so clear error is returned
  const openBlockingExceptions = await tx
    .select()
    .from(fulfillmentExceptions)
    .where(
      and(
        eq(fulfillmentExceptions.fulfillmentId, ful.id),
        eq(fulfillmentExceptions.status, "open"),
        eq(fulfillmentExceptions.severity, "blocking"),
      ),
    );

  if (openBlockingExceptions.length > 0) {
    throw new BusinessRuleError(
      `Pengepakan (packing) ${ful.fulfillment_no} ditolak karena masih terdapat ${openBlockingExceptions.length} pengecualian (exception) pemenuhan yang belum diselesaikan.`,
    );
  }

  if (ful.status !== "picked") {
    throw new BusinessRuleError(
      `Pengepakan (packing) hanya dapat diselesaikan untuk dokumen berstatus 'picked' (status saat ini: '${ful.status}').`,
    );
  }

  if (
    !input.checklist ||
    !input.checklist.qualityChecked ||
    !input.checklist.packagingVerified ||
    !input.checklist.labelAttached
  ) {
    throw new BusinessRuleError(
      "Daftar periksa pengepakan (pemeriksaan mutu akhir, verifikasi kemasan, dan pelabelan) wajib dicentang seluruhnya sebelum menyelesaikan packing.",
    );
  }

  if (!Number.isInteger(input.checklist.packageCount) || input.checklist.packageCount <= 0) {
    throw new BusinessRuleError("Jumlah kemasan fisik (koli/peti/box) harus bilangan bulat > 0.");
  }

  const lines = await tx
    .select()
    .from(salesFulfillmentLines)
    .where(eq(salesFulfillmentLines.fulfillmentId, ful.id))
    .orderBy(asc(salesFulfillmentLines.lineNo));

  if (lines.length === 0 || !lines.every((l) => l.isStockIssued)) {
    throw new BusinessRuleError(
      "Seluruh baris item wajib selesai dilakukan picking sebelum packing dapat difinalisasi.",
    );
  }

  // Verify no pending approvals on any line
  for (const line of lines) {
    const approvalIds = [line.substitutionApprovalId, line.varianceApprovalId].filter(
      (id): id is string => Boolean(id),
    );
    if (approvalIds.length > 0) {
      const apps = await tx
        .select()
        .from(approvals)
        .where(inArray(approvals.id, approvalIds));
      if (apps.some((a) => a.status !== "approved")) {
        throw new BusinessRuleError(
          `Baris #${line.lineNo} masih memiliki permintaan persetujuan (approval) yang belum disetujui.`,
        );
      }
    }
  }

  const packedOverrideMap = new Map<string, string | number>();
  for (const pl of input.lines ?? []) {
    packedOverrideMap.set(pl.fulfillmentLineId, pl.packedQtyBase);
  }

  let totalPackedBase = new MoneyDecimal(0);
  for (const line of lines) {
    const pickedBase = roundQty(parseQty(line.pickedQtyBase));
    const packedBase = packedOverrideMap.has(line.id)
      ? roundQty(parseQty(packedOverrideMap.get(line.id)!))
      : pickedBase;

    if (!packedBase.eq(pickedBase)) {
      throw new BusinessRuleError(
        `Baris #${line.lineNo}: Kuantitas dikemas (${toDbQty(packedBase)}) harus sama dengan kuantitas hasil picking yang telah dikeluarkan dari stok (${toDbQty(pickedBase)}).`,
      );
    }

    await tx
      .update(salesFulfillmentLines)
      .set({
        packedQtyBase: toDbQty(packedBase),
      })
      .where(eq(salesFulfillmentLines.id, line.id));

    totalPackedBase = totalPackedBase.plus(packedBase);
  }

  const [packedFulfillment] = await tx
    .update(salesFulfillments)
    .set({
      status: "packed",
      packingChecklist: input.checklist,
      totalPackedQtyBase: toDbQty(totalPackedBase),
      packedBy: ctx.user.id,
      packedAt: new Date(),
      version: ful.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(salesFulfillments.id, ful.id))
    .returning();

  await tx
    .update(salesOrders)
    .set({
      status: "packed",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(salesOrders.id, ful.sales_order_id),
        inArray(salesOrders.status, ["confirmed", "picking"]),
      ),
    );

  await recordAudit(tx, {
    ctx,
    action: "fulfillment.pack",
    entityType: "sales_fulfillment",
    entityId: ful.id,
    warehouseId: ful.warehouse_id,
    afterData: packedFulfillment,
  });

  return packedFulfillment!;
}

// ============================================================================
// 5. DELIVERY ORDER (SURAT JALAN) & DISPATCH WORKFLOW
// ============================================================================

export interface CreateDeliveryOrderInput {
  fulfillmentId: string;
  deliveryDate?: string;
  deliveryZoneId?: string | null;
  driverUserId?: string | null;
  driverName?: string | null;
  vehiclePlateNo?: string | null;
  vehicleType?: string | null;
  shippingAddressSnapshot?: string;
  notes?: string;
}

export async function createDeliveryOrder(
  tx: DbExecutor,
  ctx: ActorContext,
  input: CreateDeliveryOrderInput,
) {
  const fulLockRes = await tx.execute<{
    id: string;
    fulfillment_no: string;
    sales_order_id: string;
    customer_id: string;
    warehouse_id: string;
    status: string;
  }>(
    sql`SELECT id, fulfillment_no, sales_order_id, customer_id, warehouse_id, status
        FROM sales_fulfillments
        WHERE id = ${input.fulfillmentId}
        FOR UPDATE`,
  );

  const ful = fulLockRes.rows[0];
  if (!ful) {
    throw new NotFoundError("Dokumen pemenuhan (Fulfillment) tidak ditemukan.");
  }

  authorizeDeliveryWrite(ctx, ful.warehouse_id);

  if (ful.status !== "packed") {
    throw new BusinessRuleError(
      `Surat Jalan (Delivery Order) hanya dapat dibuat untuk dokumen pemenuhan yang telah berstatus 'packed' (status saat ini: '${ful.status}').`,
    );
  }

  const existingDo = await tx
    .select()
    .from(deliveryOrders)
    .where(eq(deliveryOrders.fulfillmentId, ful.id));

  if (existingDo.some((d) => d.status !== "cancelled")) {
    throw new BusinessRuleError(
      `Dokumen pemenuhan ${ful.fulfillment_no} sudah memiliki Surat Jalan aktif.`,
    );
  }

  const [so] = await tx
    .select()
    .from(salesOrders)
    .where(eq(salesOrders.id, ful.sales_order_id))
    .limit(1);
  if (!so) {
    throw new NotFoundError("Sales Order tidak ditemukan.");
  }

  const [customer] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, ful.customer_id))
    .limit(1);

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, ful.warehouse_id))
    .limit(1);
  if (!wh) {
    throw new NotFoundError("Gudang tidak ditemukan.");
  }

  const fulLines = await tx
    .select()
    .from(salesFulfillmentLines)
    .where(eq(salesFulfillmentLines.fulfillmentId, ful.id))
    .orderBy(asc(salesFulfillmentLines.lineNo));

  let resolvedDriverName = input.driverName?.trim() || null;
  if (input.driverUserId && !resolvedDriverName) {
    const [driverUser] = await tx
      .select()
      .from(users)
      .where(eq(users.id, input.driverUserId))
      .limit(1);
    if (driverUser) {
      resolvedDriverName = driverUser.name;
    }
  }

  const shippingAddress =
    input.shippingAddressSnapshot?.trim() ||
    so.shippingAddressSnapshot?.trim() ||
    customer?.shippingAddress?.trim() ||
    customer?.billingAddress?.trim() ||
    "Alamat pengiriman pelanggan (Bekasi)";

  const doNumber = await nextDocumentNumber(tx, {
    docType: "DO",
    warehouseCode: wh.code,
  });
  const doId = `do_${crypto.randomUUID()}`;
  const deliveryDate = input.deliveryDate ?? so.requestedDeliveryDate ?? businessDate();

  const [createdDo] = await tx
    .insert(deliveryOrders)
    .values({
      id: doId,
      doNumber,
      fulfillmentId: ful.id,
      salesOrderId: ful.sales_order_id,
      customerId: ful.customer_id,
      warehouseId: ful.warehouse_id,
      deliveryZoneId: input.deliveryZoneId ?? so.deliveryZoneId ?? customer?.deliveryZoneId ?? null,
      driverUserId: input.driverUserId ?? null,
      driverName: resolvedDriverName,
      vehiclePlateNo: input.vehiclePlateNo?.trim() || null,
      vehicleType: input.vehicleType?.trim() || null,
      shippingAddressSnapshot: shippingAddress,
      deliveryDate,
      status: "draft",
      notes: input.notes?.trim() ?? null,
      createdBy: ctx.user.id,
    })
    .returning();

  const createdDoLines = [];
  for (const fl of fulLines) {
    const [doLine] = await tx
      .insert(deliveryOrderLines)
      .values({
        id: `dol_${crypto.randomUUID()}`,
        deliveryOrderId: doId,
        fulfillmentLineId: fl.id,
        salesOrderLineId: fl.salesOrderLineId,
        lineNo: fl.lineNo,
        productId: fl.actualProductId,
        gradeId: fl.actualGradeId,
        gradeCode: fl.actualGradeCode,
        uomCode: fl.pickedUomCode,
        shippedQty: fl.pickedQty,
        shippedQtyBase: fl.packedQtyBase,
        deliveredQtyBase: "0.000",
        shortageQtyBase: "0.000",
        damagedQtyBase: "0.000",
        refusedQtyBase: "0.000",
        netUnitPriceBaseSnapshot: fl.netUnitPriceBaseSnapshot,
        notes: fl.notes,
      })
      .returning();
    createdDoLines.push(doLine!);
  }

  await recordAudit(tx, {
    ctx,
    action: "delivery_order.create",
    entityType: "delivery_order",
    entityId: doId,
    warehouseId: ful.warehouse_id,
    afterData: { deliveryOrder: createdDo, lines: createdDoLines },
  });

  return {
    deliveryOrder: createdDo!,
    lines: createdDoLines,
  };
}

export interface MarkDeliveryOrderReadyInput {
  deliveryOrderId: string;
  driverUserId?: string | null;
  driverName?: string | null;
  vehiclePlateNo?: string | null;
  vehicleType?: string | null;
  deliveryZoneId?: string | null;
}

export async function markDeliveryOrderReady(
  tx: DbExecutor,
  ctx: ActorContext,
  input: MarkDeliveryOrderReadyInput,
) {
  const doLockRes = await tx.execute<{
    id: string;
    do_number: string;
    fulfillment_id: string;
    warehouse_id: string;
    driver_user_id: string | null;
    driver_name: string | null;
    vehicle_plate_no: string | null;
    vehicle_type: string | null;
    delivery_zone_id: string | null;
    status: string;
    version: number;
  }>(
    sql`SELECT id, do_number, fulfillment_id, warehouse_id, driver_user_id,
               driver_name, vehicle_plate_no, vehicle_type, delivery_zone_id, status, version
        FROM delivery_orders
        WHERE id = ${input.deliveryOrderId}
        FOR UPDATE`,
  );

  const dOrder = doLockRes.rows[0];
  if (!dOrder) {
    throw new NotFoundError("Surat Jalan (Delivery Order) tidak ditemukan.");
  }

  authorizeDeliveryWrite(ctx, dOrder.warehouse_id);

  if (dOrder.status !== "draft") {
    throw new BusinessRuleError(
      `Surat Jalan ${dOrder.do_number} berstatus '${dOrder.status}'. Hanya Surat Jalan berstatus 'draft' yang dapat diubah menjadi 'ready'.`,
    );
  }

  const [ful] = await tx
    .select()
    .from(salesFulfillments)
    .where(eq(salesFulfillments.id, dOrder.fulfillment_id))
    .limit(1);

  if (!ful || ful.status !== "packed") {
    throw new BusinessRuleError(
      "Surat Jalan tidak dapat dinyatakan siap kirim ('ready') karena dokumen pemenuhan belum berstatus 'packed'.",
    );
  }

  const driverUserId =
    input.driverUserId !== undefined ? input.driverUserId : dOrder.driver_user_id;
  let driverName =
    input.driverName !== undefined ? input.driverName?.trim() || null : dOrder.driver_name;

  if (driverUserId && !driverName) {
    const [u] = await tx.select().from(users).where(eq(users.id, driverUserId)).limit(1);
    if (u) driverName = u.name;
  }

  const vehiclePlateNo =
    input.vehiclePlateNo !== undefined
      ? input.vehiclePlateNo?.trim() || null
      : dOrder.vehicle_plate_no;
  const vehicleType =
    input.vehicleType !== undefined ? input.vehicleType?.trim() || null : dOrder.vehicle_type;
  const deliveryZoneId =
    input.deliveryZoneId !== undefined ? input.deliveryZoneId : dOrder.delivery_zone_id;

  if (!driverName || !vehiclePlateNo) {
    throw new BusinessRuleError(
      "Nama sopir (driver) dan nomor polisi kendaraan wajib diisi sebelum Surat Jalan dinyatakan siap kirim ('ready').",
    );
  }

  const [updatedDo] = await tx
    .update(deliveryOrders)
    .set({
      driverUserId,
      driverName,
      vehiclePlateNo,
      vehicleType,
      deliveryZoneId,
      status: "ready",
      version: dOrder.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(deliveryOrders.id, dOrder.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "delivery_order.ready",
    entityType: "delivery_order",
    entityId: dOrder.id,
    warehouseId: dOrder.warehouse_id,
    afterData: updatedDo,
  });

  return updatedDo!;
}

export interface DispatchDeliveryOrderInput {
  deliveryOrderId: string;
  idempotencyKey?: string;
  notes?: string;
}

export async function dispatchDeliveryOrder(
  tx: DbExecutor,
  ctx: ActorContext,
  input: DispatchDeliveryOrderInput,
) {
  const executeDispatch = async () => {
    const doLockRes = await tx.execute<{
      id: string;
      do_number: string;
      fulfillment_id: string;
      sales_order_id: string;
      warehouse_id: string;
      driver_name: string | null;
      vehicle_plate_no: string | null;
      status: string;
      notes: string | null;
      version: number;
    }>(
      sql`SELECT id, do_number, fulfillment_id, sales_order_id, warehouse_id,
                 driver_name, vehicle_plate_no, status, notes, version
          FROM delivery_orders
          WHERE id = ${input.deliveryOrderId}
          FOR UPDATE`,
    );

    const dOrder = doLockRes.rows[0];
    if (!dOrder) {
      throw new NotFoundError("Surat Jalan (Delivery Order) tidak ditemukan.");
    }

    authorizeDeliveryWrite(ctx, dOrder.warehouse_id);

    if (dOrder.status !== "ready") {
      throw new BusinessRuleError(
        `Surat Jalan ${dOrder.do_number} berstatus '${dOrder.status}'. Hanya Surat Jalan berstatus 'ready' yang dapat diberangkatkan ('dispatched').`,
      );
    }

    if (!dOrder.driver_name || !dOrder.vehicle_plate_no) {
      throw new BusinessRuleError(
        "Sopir dan nomor polisi armada wajib ditetapkan sebelum keberangkatan (dispatch).",
      );
    }

    const [ful] = await tx
      .select()
      .from(salesFulfillments)
      .where(eq(salesFulfillments.id, dOrder.fulfillment_id))
      .limit(1);

    if (!ful || ful.status !== "packed") {
      throw new BusinessRuleError(
        "Keberangkatan (dispatch) ditolak karena dokumen pemenuhan belum berstatus 'packed'.",
      );
    }

    const now = new Date();
    const [dispatchedDo] = await tx
      .update(deliveryOrders)
      .set({
        status: "dispatched",
        dispatchedBy: ctx.user.id,
        dispatchedAt: now,
        notes: input.notes?.trim() ?? dOrder.notes,
        version: dOrder.version + 1,
        updatedAt: now,
      })
      .where(eq(deliveryOrders.id, dOrder.id))
      .returning();

    await tx
      .update(salesFulfillments)
      .set({
        status: "dispatched",
        version: ful.version + 1,
        updatedAt: now,
      })
      .where(eq(salesFulfillments.id, ful.id));

    await tx
      .update(salesOrders)
      .set({
        status: "shipped",
        updatedAt: now,
      })
      .where(
        and(
          eq(salesOrders.id, dOrder.sales_order_id),
          inArray(salesOrders.status, ["confirmed", "picking", "packed"]),
        ),
      );

    await recordAudit(tx, {
      ctx,
      action: "delivery_order.dispatch",
      entityType: "delivery_order",
      entityId: dOrder.id,
      warehouseId: dOrder.warehouse_id,
      afterData: dispatchedDo,
    });

    return dispatchedDo!;
  };

  if (input.idempotencyKey?.trim()) {
    const idem = await withIdempotency(
      tx,
      {
        scope: "delivery.dispatch",
        key: input.idempotencyKey.trim(),
        payload: input,
        actorUserId: ctx.user.id,
      },
      executeDispatch,
    );
    return idem.result;
  }

  return executeDispatch();
}

const ALLOWED_DO_STATUS_TRANSITIONS: Record<string, ReadonlyArray<string>> = {
  draft: ["ready", "cancelled"],
  ready: ["dispatched", "cancelled"],
  dispatched: ["in_transit", "failed", "returned"],
  in_transit: ["failed", "returned"],
  delivered: [],
  partially_delivered: [],
  failed: ["returned"],
  returned: [],
  cancelled: [],
};

export interface UpdateDeliveryOrderStatusInput {
  deliveryOrderId: string;
  targetStatus: "in_transit" | "failed" | "returned" | "cancelled";
  reason?: string;
}

export async function updateDeliveryOrderStatus(
  tx: DbExecutor,
  ctx: ActorContext,
  input: UpdateDeliveryOrderStatusInput,
) {
  const doLockRes = await tx.execute<{
    id: string;
    do_number: string;
    fulfillment_id: string;
    sales_order_id: string;
    customer_id: string;
    warehouse_id: string;
    status: string;
    version: number;
  }>(
    sql`SELECT id, do_number, fulfillment_id, sales_order_id, customer_id, warehouse_id, status, version
        FROM delivery_orders
        WHERE id = ${input.deliveryOrderId}
        FOR UPDATE`,
  );

  const dOrder = doLockRes.rows[0];
  if (!dOrder) {
    throw new NotFoundError("Surat Jalan (Delivery Order) tidak ditemukan.");
  }

  authorizeDeliveryWrite(ctx, dOrder.warehouse_id);

  const allowedTargets = ALLOWED_DO_STATUS_TRANSITIONS[dOrder.status] ?? [];
  if (!allowedTargets.includes(input.targetStatus)) {
    throw new BusinessRuleError(
      `Transisi status Surat Jalan ${dOrder.do_number} dari '${dOrder.status}' ke '${input.targetStatus}' tidak diizinkan.`,
    );
  }

  if (
    ["failed", "returned", "cancelled"].includes(input.targetStatus) &&
    !input.reason?.trim()
  ) {
    throw new BusinessRuleError(
      `Alasan wajib diisi ketika mengubah status Surat Jalan menjadi '${input.targetStatus}'.`,
    );
  }

  const now = new Date();
  const [updatedDo] = await tx
    .update(deliveryOrders)
    .set({
      status: input.targetStatus,
      inTransitAt: input.targetStatus === "in_transit" ? now : undefined,
      completedAt: ["failed", "returned"].includes(input.targetStatus) ? now : undefined,
      failureReason: ["failed", "returned", "cancelled"].includes(input.targetStatus)
        ? input.reason!.trim()
        : undefined,
      version: dOrder.version + 1,
      updatedAt: now,
    })
    .where(eq(deliveryOrders.id, dOrder.id))
    .returning();

  if (input.targetStatus === "failed" || input.targetStatus === "returned") {
    await tx
      .update(salesFulfillments)
      .set({
        status: input.targetStatus,
        updatedAt: now,
      })
      .where(eq(salesFulfillments.id, dOrder.fulfillment_id));
  }

  await recordAudit(tx, {
    ctx,
    action: `delivery_order.status_${input.targetStatus}`,
    entityType: "delivery_order",
    entityId: dOrder.id,
    warehouseId: dOrder.warehouse_id,
    afterData: updatedDo,
    reason: input.reason?.trim(),
  });

  return updatedDo!;
}

// ============================================================================
// 6. PROOF OF DELIVERY (POD) & ACTIONABLE DELIVERY CLAIMS
// ============================================================================

export interface RecordPodLineInput {
  deliveryOrderLineId: string;
  deliveredQtyBase: string | number;
  shortageQtyBase?: string | number;
  damagedQtyBase?: string | number;
  refusedQtyBase?: string | number;
  discrepancyReasonCode?: string;
  discrepancyNotes?: string;
}

export interface RecordProofOfDeliveryInput {
  deliveryOrderId: string;
  idempotencyKey?: string;
  recipientName: string;
  recipientRoleOrId: string;
  recipientPhone?: string;
  handoverAt?: Date;
  outcomeStatus?: "delivered" | "partially_delivered" | "refused" | "failed" | "returned";
  deliveryNotes?: string;
  lines?: RecordPodLineInput[];
}

export async function recordProofOfDelivery(
  tx: DbExecutor,
  ctx: ActorContext,
  input: RecordProofOfDeliveryInput,
) {
  const executePod = async () => {
    const doLockRes = await tx.execute<{
      id: string;
      do_number: string;
      fulfillment_id: string;
      sales_order_id: string;
      customer_id: string;
      warehouse_id: string;
      status: string;
      version: number;
    }>(
      sql`SELECT id, do_number, fulfillment_id, sales_order_id, customer_id, warehouse_id, status, version
          FROM delivery_orders
          WHERE id = ${input.deliveryOrderId}
          FOR UPDATE`,
    );

    const dOrder = doLockRes.rows[0];
    if (!dOrder) {
      throw new NotFoundError("Surat Jalan (Delivery Order) tidak ditemukan.");
    }

    authorizeDeliveryWrite(ctx, dOrder.warehouse_id);

    // Check if POD already exists for this Delivery Order
    const [existingPod] = await tx
      .select()
      .from(proofOfDeliveries)
      .where(eq(proofOfDeliveries.deliveryOrderId, dOrder.id))
      .limit(1);

    if (existingPod) {
      throw new BusinessRuleError(
        `Bukti Serah Terima (POD ${existingPod.podNumber}) untuk Surat Jalan ${dOrder.do_number} sudah pernah dicatat. Pengiriman POD ganda ditolak.`,
      );
    }

    if (!["dispatched", "in_transit"].includes(dOrder.status)) {
      throw new BusinessRuleError(
        `Bukti Serah Terima (POD) hanya dapat dicatat untuk Surat Jalan berstatus 'dispatched' atau 'in_transit' (status saat ini: '${dOrder.status}').`,
      );
    }

    if (!input.recipientName?.trim() || !input.recipientRoleOrId?.trim()) {
      throw new BusinessRuleError(
        "Nama penerima dan jabatan/identitas penerima wajib diisi pada Bukti Serah Terima (POD).",
      );
    }

    const [wh] = await tx
      .select()
      .from(warehouses)
      .where(eq(warehouses.id, dOrder.warehouse_id))
      .limit(1);
    if (!wh) {
      throw new NotFoundError("Gudang tidak ditemukan.");
    }

    const doLines = await tx
      .select()
      .from(deliveryOrderLines)
      .where(eq(deliveryOrderLines.deliveryOrderId, dOrder.id))
      .orderBy(asc(deliveryOrderLines.lineNo));

    if (doLines.length === 0) {
      throw new BusinessRuleError("Surat Jalan tidak memiliki baris item.");
    }

    const podInputByDoLineId = new Map<string, RecordPodLineInput>();
    for (const pl of input.lines ?? []) {
      podInputByDoLineId.set(pl.deliveryOrderLineId, pl);
    }

    let totalShippedBase = new MoneyDecimal(0);
    let totalDeliveredBase = new MoneyDecimal(0);
    let totalShortageBase = new MoneyDecimal(0);
    let totalDamagedBase = new MoneyDecimal(0);
    let totalRefusedBase = new MoneyDecimal(0);
    let estimatedClaimValue = new MoneyDecimal(0);
    const reasonCodes = new Set<string>();

    const normalizedPodLines: Array<{
      doLine: typeof doLines[number];
      shippedQtyBase: string;
      deliveredQtyBase: string;
      shortageQtyBase: string;
      damagedQtyBase: string;
      refusedQtyBase: string;
      discrepancyReasonCode: string | null;
      discrepancyNotes: string | null;
    }> = [];

    for (const doLine of doLines) {
      const shipped = roundQty(parseQty(doLine.shippedQtyBase));
      const spec = podInputByDoLineId.get(doLine.id);

      let delivered: Money;
      let shortage: Money;
      let damaged: Money;
      let refused: Money;

      if (spec) {
        delivered = roundQty(parseQty(spec.deliveredQtyBase));
        shortage = roundQty(parseQty(spec.shortageQtyBase ?? "0"));
        damaged = roundQty(parseQty(spec.damagedQtyBase ?? "0"));
        refused = roundQty(parseQty(spec.refusedQtyBase ?? "0"));
      } else if (
        input.outcomeStatus === "refused" ||
        input.outcomeStatus === "failed" ||
        input.outcomeStatus === "returned"
      ) {
        delivered = new MoneyDecimal(0);
        shortage = new MoneyDecimal(0);
        damaged = new MoneyDecimal(0);
        refused = shipped;
      } else {
        delivered = shipped;
        shortage = new MoneyDecimal(0);
        damaged = new MoneyDecimal(0);
        refused = new MoneyDecimal(0);
      }

      if (delivered.lt(0) || shortage.lt(0) || damaged.lt(0) || refused.lt(0)) {
        throw new BusinessRuleError(
          `Baris DO #${doLine.lineNo}: Kuantitas pada POD tidak boleh bernilai negatif.`,
        );
      }

      const accounted = roundQty(delivered.plus(shortage).plus(damaged).plus(refused));
      if (!accounted.eq(shipped)) {
        throw new BusinessRuleError(
          `Baris DO #${doLine.lineNo}: Total kuantitas POD (Diterima ${toDbQty(delivered)} + Kurang ${toDbQty(shortage)} + Rusak ${toDbQty(damaged)} + Ditolak ${toDbQty(refused)} = ${toDbQty(accounted)}) harus sama persis dengan kuantitas dikirim (${toDbQty(shipped)}).`,
        );
      }

      const lineDiscrepancy = roundQty(shortage.plus(damaged).plus(refused));
      const reasonCode =
        spec?.discrepancyReasonCode?.trim() ||
        (lineDiscrepancy.gt(0)
          ? damaged.gt(0)
            ? "DAMAGED_IN_TRANSIT"
            : shortage.gt(0)
              ? "DELIVERY_SHORTAGE"
              : "CUSTOMER_REFUSED"
          : null);

      if (reasonCode) {
        reasonCodes.add(reasonCode);
      }

      const unitPriceBase = roundUnitPrice(parseMoney(doLine.netUnitPriceBaseSnapshot));
      const lineClaimVal = roundRupiah(lineDiscrepancy.mul(unitPriceBase));
      estimatedClaimValue = estimatedClaimValue.plus(lineClaimVal);

      totalShippedBase = totalShippedBase.plus(shipped);
      totalDeliveredBase = totalDeliveredBase.plus(delivered);
      totalShortageBase = totalShortageBase.plus(shortage);
      totalDamagedBase = totalDamagedBase.plus(damaged);
      totalRefusedBase = totalRefusedBase.plus(refused);

      normalizedPodLines.push({
        doLine,
        shippedQtyBase: toDbQty(shipped),
        deliveredQtyBase: toDbQty(delivered),
        shortageQtyBase: toDbQty(shortage),
        damagedQtyBase: toDbQty(damaged),
        refusedQtyBase: toDbQty(refused),
        discrepancyReasonCode: reasonCode,
        discrepancyNotes: spec?.discrepancyNotes?.trim() ?? null,
      });
    }

    const totalDiscrepancyBase = roundQty(totalShippedBase.minus(totalDeliveredBase));

    let computedOutcome:
      | "delivered"
      | "partially_delivered"
      | "refused"
      | "failed"
      | "returned";

    if (totalDiscrepancyBase.isZero()) {
      computedOutcome = "delivered";
    } else if (totalDeliveredBase.isZero()) {
      if (input.outcomeStatus === "failed") {
        computedOutcome = "failed";
      } else if (input.outcomeStatus === "returned") {
        computedOutcome = "returned";
      } else {
        computedOutcome = "refused";
      }
    } else {
      computedOutcome = "partially_delivered";
    }

    const podNumber = await nextDocumentNumber(tx, {
      docType: "POD",
      warehouseCode: wh.code,
    });
    const podId = `pod_${crypto.randomUUID()}`;
    const handoverAt = input.handoverAt ?? new Date();

    const [createdPod] = await tx
      .insert(proofOfDeliveries)
      .values({
        id: podId,
        podNumber,
        deliveryOrderId: dOrder.id,
        salesOrderId: dOrder.sales_order_id,
        customerId: dOrder.customer_id,
        warehouseId: dOrder.warehouse_id,
        recipientName: input.recipientName.trim(),
        recipientRoleOrId: input.recipientRoleOrId.trim(),
        recipientPhone: input.recipientPhone?.trim() ?? null,
        handoverAt,
        outcomeStatus: computedOutcome,
        totalShippedQtyBase: toDbQty(totalShippedBase),
        totalDeliveredQtyBase: toDbQty(totalDeliveredBase),
        totalDiscrepancyQtyBase: toDbQty(totalDiscrepancyBase),
        deliveryNotes: input.deliveryNotes?.trim() ?? null,
        recordedBy: ctx.user.id,
      })
      .returning();

    const createdPodLines = [];
    for (const nl of normalizedPodLines) {
      const [podLine] = await tx
        .insert(proofOfDeliveryLines)
        .values({
          id: `podl_${crypto.randomUUID()}`,
          podId,
          deliveryOrderLineId: nl.doLine.id,
          lineNo: nl.doLine.lineNo,
          productId: nl.doLine.productId,
          gradeId: nl.doLine.gradeId,
          shippedQtyBase: nl.shippedQtyBase,
          deliveredQtyBase: nl.deliveredQtyBase,
          shortageQtyBase: nl.shortageQtyBase,
          damagedQtyBase: nl.damagedQtyBase,
          refusedQtyBase: nl.refusedQtyBase,
          discrepancyReasonCode: nl.discrepancyReasonCode,
          discrepancyNotes: nl.discrepancyNotes,
        })
        .returning();
      createdPodLines.push(podLine!);

      await tx
        .update(deliveryOrderLines)
        .set({
          deliveredQtyBase: nl.deliveredQtyBase,
          shortageQtyBase: nl.shortageQtyBase,
          damagedQtyBase: nl.damagedQtyBase,
          refusedQtyBase: nl.refusedQtyBase,
        })
        .where(eq(deliveryOrderLines.id, nl.doLine.id));
    }

    const doTargetStatus =
      computedOutcome === "refused" ? "returned" : computedOutcome;

    const [updatedDo] = await tx
      .update(deliveryOrders)
      .set({
        status: doTargetStatus,
        completedAt: handoverAt,
        failureReason:
          totalDiscrepancyBase.gt(0)
            ? input.deliveryNotes?.trim() ?? Array.from(reasonCodes).join(", ")
            : null,
        version: dOrder.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(deliveryOrders.id, dOrder.id))
      .returning();

    await tx
      .update(salesFulfillments)
      .set({
        status: doTargetStatus,
        updatedAt: new Date(),
      })
      .where(eq(salesFulfillments.id, dOrder.fulfillment_id));

    // Check overall Sales Order delivery progress across all Delivery Orders
    const soLines = await tx
      .select()
      .from(salesOrderLines)
      .where(eq(salesOrderLines.salesOrderId, dOrder.sales_order_id));

    const allDoForSo = await tx
      .select({ id: deliveryOrders.id })
      .from(deliveryOrders)
      .where(
        and(
          eq(deliveryOrders.salesOrderId, dOrder.sales_order_id),
          inArray(deliveryOrders.status, ["delivered", "partially_delivered"]),
        ),
      );

    let totalOrderedAcrossSo = new MoneyDecimal(0);
    for (const sol of soLines) {
      totalOrderedAcrossSo = totalOrderedAcrossSo.plus(parseQty(sol.orderedQtyBase));
    }

    let totalDeliveredAcrossSo = new MoneyDecimal(0);
    if (allDoForSo.length > 0) {
      const doIds = allDoForSo.map((d) => d.id);
      const deliveredLines = await tx
        .select({ deliveredQtyBase: deliveryOrderLines.deliveredQtyBase })
        .from(deliveryOrderLines)
        .where(inArray(deliveryOrderLines.deliveryOrderId, doIds));
      for (const dl of deliveredLines) {
        totalDeliveredAcrossSo = totalDeliveredAcrossSo.plus(parseQty(dl.deliveredQtyBase));
      }
    }

    if (totalDeliveredAcrossSo.gte(totalOrderedAcrossSo) && totalOrderedAcrossSo.gt(0)) {
      await tx
        .update(salesOrders)
        .set({
          status: "delivered",
          updatedAt: new Date(),
        })
        .where(eq(salesOrders.id, dOrder.sales_order_id));
    } else if (totalDeliveredAcrossSo.gt(0)) {
      await tx
        .update(salesOrders)
        .set({
          status: "shipped",
          updatedAt: new Date(),
        })
        .where(eq(salesOrders.id, dOrder.sales_order_id));
    }

    // Create actionable delivery_claims record if any discrepancy occurred
    let createdClaim = null;
    if (totalDiscrepancyBase.gt(0)) {
      const claimNo = await nextDocumentNumber(tx, {
        docType: "CLM",
        warehouseCode: wh.code,
      });

      const activeTypes = [
        totalShortageBase.gt(0) ? "shortage" : null,
        totalDamagedBase.gt(0) ? "damaged_in_transit" : null,
        totalRefusedBase.gt(0) ? "refused_by_customer" : null,
      ].filter((t): t is "shortage" | "damaged_in_transit" | "refused_by_customer" => Boolean(t));

      let claimType:
        | "shortage"
        | "damaged_in_transit"
        | "refused_by_customer"
        | "failed_delivery"
        | "mixed_discrepancy";

      if (computedOutcome === "failed") {
        claimType = "failed_delivery";
      } else if (activeTypes.length === 1) {
        claimType = activeTypes[0]!;
      } else {
        claimType = "mixed_discrepancy";
      }

      const [claim] = await tx
        .insert(deliveryClaims)
        .values({
          id: `clm_${crypto.randomUUID()}`,
          claimNo,
          podId: createdPod!.id,
          deliveryOrderId: dOrder.id,
          salesOrderId: dOrder.sales_order_id,
          customerId: dOrder.customer_id,
          warehouseId: dOrder.warehouse_id,
          claimType,
          status: "open",
          discrepancyQtyBase: toDbQty(totalDiscrepancyBase),
          estimatedClaimValue: toDbAmount(estimatedClaimValue),
          reasonCode:
            Array.from(reasonCodes)[0] ??
            (computedOutcome === "failed" ? "FAILED_DELIVERY" : "POD_DISCREPANCY"),
          notes:
            input.deliveryNotes?.trim() ||
            `Selisih serah terima POD ${podNumber} pada Surat Jalan ${dOrder.do_number}: Kurang ${toDbQty(totalShortageBase)}, Rusak ${toDbQty(totalDamagedBase)}, Ditolak ${toDbQty(totalRefusedBase)}.`,
          createdBy: ctx.user.id,
        })
        .returning();

      createdClaim = claim!;
    }

    await recordAudit(tx, {
      ctx,
      action: "delivery.pod_record",
      entityType: "proof_of_delivery",
      entityId: podId,
      warehouseId: dOrder.warehouse_id,
      afterData: {
        pod: createdPod,
        lines: createdPodLines,
        deliveryOrder: updatedDo,
        claim: createdClaim,
      },
    });

    return {
      pod: createdPod!,
      lines: createdPodLines,
      deliveryOrder: updatedDo!,
      claim: createdClaim,
    };
  };

  if (input.idempotencyKey?.trim()) {
    const idem = await withIdempotency(
      tx,
      {
        scope: "delivery.pod",
        key: input.idempotencyKey.trim(),
        payload: input,
        actorUserId: ctx.user.id,
      },
      executePod,
    );
    return idem.result;
  }

  return executePod();
}

// ============================================================================
// 7. READ / QUERY FUNCTIONS FOR UI & SERVER ACTIONS (RBAC-PROTECTED)
// ============================================================================

export async function listReadySalesOrdersForFulfillment(
  db: DbExecutor,
  ctx: ActorContext,
  options?: { warehouseId?: string },
) {
  authorizeFulfillmentOrDeliveryRead(ctx, options?.warehouseId);

  const conditions = [
    inArray(salesOrders.status, ["confirmed", "picking", "packed", "shipped"]),
  ];
  if (options?.warehouseId) {
    conditions.push(eq(salesOrders.warehouseId, options.warehouseId));
  }

  const orders = await db
    .select({
      id: salesOrders.id,
      soNumber: salesOrders.soNumber,
      customerId: salesOrders.customerId,
      customerName: customers.name,
      warehouseId: salesOrders.warehouseId,
      warehouseCode: warehouses.code,
      orderDate: salesOrders.orderDate,
      requestedDeliveryDate: salesOrders.requestedDeliveryDate,
      status: salesOrders.status,
      grandTotal: salesOrders.grandTotalAmount,
    })
    .from(salesOrders)
    .innerJoin(customers, eq(customers.id, salesOrders.customerId))
    .innerJoin(warehouses, eq(warehouses.id, salesOrders.warehouseId))
    .where(and(...conditions))
    .orderBy(desc(salesOrders.createdAt))
    .limit(50);

  const result = [];
  for (const ord of orders) {
    const lines = await db
      .select({
        id: salesOrderLines.id,
        lineNo: salesOrderLines.lineNo,
        productId: salesOrderLines.productId,
        productName: products.name,
        gradeId: salesOrderLines.gradeId,
        gradeCode: salesOrderLines.gradeCode,
        orderedQty: salesOrderLines.orderedQty,
        orderedUomCode: salesOrderLines.orderedUomCode,
        orderedQtyBase: salesOrderLines.orderedQtyBase,
        reservedQtyBase: salesOrderLines.reservedQtyBase,
        fulfilledQtyBase: salesOrderLines.fulfilledQtyBase,
      })
      .from(salesOrderLines)
      .innerJoin(products, eq(products.id, salesOrderLines.productId))
      .where(eq(salesOrderLines.salesOrderId, ord.id))
      .orderBy(asc(salesOrderLines.lineNo));

    const hasRemaining = lines.some((l) =>
      parseQty(l.orderedQtyBase).gt(parseQty(l.fulfilledQtyBase)),
    );

    if (hasRemaining) {
      result.push({
        ...ord,
        lines,
      });
    }
  }

  return result;
}

export async function listSalesFulfillments(
  db: DbExecutor,
  ctx: ActorContext,
  options?: { warehouseId?: string; status?: string },
) {
  authorizeFulfillmentOrDeliveryRead(ctx, options?.warehouseId);

  const conditions = [];
  if (options?.warehouseId) {
    conditions.push(eq(salesFulfillments.warehouseId, options.warehouseId));
  }

  const rows = await db
    .select({
      id: salesFulfillments.id,
      fulfillmentNo: salesFulfillments.fulfillmentNo,
      salesOrderId: salesFulfillments.salesOrderId,
      soNumber: salesOrders.soNumber,
      customerId: salesFulfillments.customerId,
      customerName: customers.name,
      warehouseId: salesFulfillments.warehouseId,
      warehouseCode: warehouses.code,
      fulfillmentDate: salesFulfillments.fulfillmentDate,
      status: salesFulfillments.status,
      isPartialFulfillment: salesFulfillments.isPartialFulfillment,
      qtyTolerancePct: salesFulfillments.qtyTolerancePct,
      totalOrderedQtyBase: salesFulfillments.totalOrderedQtyBase,
      totalPickedQtyBase: salesFulfillments.totalPickedQtyBase,
      totalPackedQtyBase: salesFulfillments.totalPackedQtyBase,
      totalRemainingQtyBase: salesFulfillments.totalRemainingQtyBase,
      totalCogsAmount: salesFulfillments.totalCogsAmount,
      packingChecklist: salesFulfillments.packingChecklist,
      createdAt: salesFulfillments.createdAt,
    })
    .from(salesFulfillments)
    .innerJoin(salesOrders, eq(salesOrders.id, salesFulfillments.salesOrderId))
    .innerJoin(customers, eq(customers.id, salesFulfillments.customerId))
    .innerJoin(warehouses, eq(warehouses.id, salesFulfillments.warehouseId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(salesFulfillments.createdAt))
    .limit(50);

  const enriched = [];
  for (const r of rows) {
    const lines = await db
      .select({
        id: salesFulfillmentLines.id,
        lineNo: salesFulfillmentLines.lineNo,
        salesOrderLineId: salesFulfillmentLines.salesOrderLineId,
        orderedProductId: salesFulfillmentLines.orderedProductId,
        orderedProductName: products.name,
        orderedGradeId: salesFulfillmentLines.orderedGradeId,
        orderedGradeCode: salesFulfillmentLines.orderedGradeCode,
        actualProductId: salesFulfillmentLines.actualProductId,
        actualGradeId: salesFulfillmentLines.actualGradeId,
        actualGradeCode: salesFulfillmentLines.actualGradeCode,
        isSubstitution: salesFulfillmentLines.isSubstitution,
        orderedUomCode: salesFulfillmentLines.orderedUomCode,
        orderedQty: salesFulfillmentLines.orderedQty,
        orderedQtyBase: salesFulfillmentLines.orderedQtyBase,
        targetPickQtyBase: salesFulfillmentLines.targetPickQtyBase,
        pickedUomCode: salesFulfillmentLines.pickedUomCode,
        pickedQty: salesFulfillmentLines.pickedQty,
        grossWeightKg: salesFulfillmentLines.grossWeightKg,
        tareWeightKg: salesFulfillmentLines.tareWeightKg,
        netWeightKg: salesFulfillmentLines.netWeightKg,
        pickedQtyBase: salesFulfillmentLines.pickedQtyBase,
        packedQtyBase: salesFulfillmentLines.packedQtyBase,
        remainingBackorderQtyBase: salesFulfillmentLines.remainingBackorderQtyBase,
        varianceQtyBase: salesFulfillmentLines.varianceQtyBase,
        variancePct: salesFulfillmentLines.variancePct,
        lineCogsAmount: salesFulfillmentLines.lineCogsAmount,
        backorderStatus: salesFulfillmentLines.backorderStatus,
        isStockIssued: salesFulfillmentLines.isStockIssued,
        scannedBarcode: salesFulfillmentLines.scannedBarcode,
      })
      .from(salesFulfillmentLines)
      .innerJoin(products, eq(products.id, salesFulfillmentLines.orderedProductId))
      .where(eq(salesFulfillmentLines.fulfillmentId, r.id))
      .orderBy(asc(salesFulfillmentLines.lineNo));

    const exceptions = await db
      .select()
      .from(fulfillmentExceptions)
      .where(eq(fulfillmentExceptions.fulfillmentId, r.id))
      .orderBy(desc(fulfillmentExceptions.createdAt));

    const allocations = await db
      .select({
        id: fulfillmentPickAllocations.id,
        fulfillmentLineId: fulfillmentPickAllocations.fulfillmentLineId,
        batchId: fulfillmentPickAllocations.batchId,
        batchCode: batches.batchCode,
        bestBeforeDate: batches.bestBeforeDate,
        sourceStockStatus: fulfillmentPickAllocations.sourceStockStatus,
        pickedQtyBase: fulfillmentPickAllocations.pickedQtyBase,
        unitCostBase: fulfillmentPickAllocations.unitCostBase,
        costOutflow: fulfillmentPickAllocations.costOutflow,
        scannedBarcode: fulfillmentPickAllocations.scannedBarcode,
      })
      .from(fulfillmentPickAllocations)
      .innerJoin(batches, eq(batches.id, fulfillmentPickAllocations.batchId))
      .where(eq(fulfillmentPickAllocations.fulfillmentId, r.id));

    enriched.push({
      ...r,
      lines,
      exceptions,
      allocations,
    });
  }

  return enriched;
}

export async function listDeliveryOrders(
  db: DbExecutor,
  ctx: ActorContext,
  options?: { warehouseId?: string },
) {
  authorizeFulfillmentOrDeliveryRead(ctx, options?.warehouseId);

  const conditions = [];
  if (options?.warehouseId) {
    conditions.push(eq(deliveryOrders.warehouseId, options.warehouseId));
  }

  const rows = await db
    .select({
      id: deliveryOrders.id,
      doNumber: deliveryOrders.doNumber,
      fulfillmentId: deliveryOrders.fulfillmentId,
      fulfillmentNo: salesFulfillments.fulfillmentNo,
      salesOrderId: deliveryOrders.salesOrderId,
      soNumber: salesOrders.soNumber,
      customerId: deliveryOrders.customerId,
      customerName: customers.name,
      warehouseId: deliveryOrders.warehouseId,
      warehouseCode: warehouses.code,
      deliveryZoneId: deliveryOrders.deliveryZoneId,
      zoneName: deliveryZones.name,
      driverUserId: deliveryOrders.driverUserId,
      driverName: deliveryOrders.driverName,
      vehiclePlateNo: deliveryOrders.vehiclePlateNo,
      vehicleType: deliveryOrders.vehicleType,
      shippingAddressSnapshot: deliveryOrders.shippingAddressSnapshot,
      deliveryDate: deliveryOrders.deliveryDate,
      status: deliveryOrders.status,
      dispatchedAt: deliveryOrders.dispatchedAt,
      inTransitAt: deliveryOrders.inTransitAt,
      completedAt: deliveryOrders.completedAt,
      failureReason: deliveryOrders.failureReason,
      notes: deliveryOrders.notes,
      createdAt: deliveryOrders.createdAt,
    })
    .from(deliveryOrders)
    .innerJoin(salesFulfillments, eq(salesFulfillments.id, deliveryOrders.fulfillmentId))
    .innerJoin(salesOrders, eq(salesOrders.id, deliveryOrders.salesOrderId))
    .innerJoin(customers, eq(customers.id, deliveryOrders.customerId))
    .innerJoin(warehouses, eq(warehouses.id, deliveryOrders.warehouseId))
    .leftJoin(deliveryZones, eq(deliveryZones.id, deliveryOrders.deliveryZoneId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(deliveryOrders.createdAt))
    .limit(50);

  const enriched = [];
  for (const r of rows) {
    const lines = await db
      .select({
        id: deliveryOrderLines.id,
        lineNo: deliveryOrderLines.lineNo,
        productId: deliveryOrderLines.productId,
        productName: products.name,
        gradeId: deliveryOrderLines.gradeId,
        gradeCode: deliveryOrderLines.gradeCode,
        uomCode: deliveryOrderLines.uomCode,
        shippedQty: deliveryOrderLines.shippedQty,
        shippedQtyBase: deliveryOrderLines.shippedQtyBase,
        deliveredQtyBase: deliveryOrderLines.deliveredQtyBase,
        shortageQtyBase: deliveryOrderLines.shortageQtyBase,
        damagedQtyBase: deliveryOrderLines.damagedQtyBase,
        refusedQtyBase: deliveryOrderLines.refusedQtyBase,
      })
      .from(deliveryOrderLines)
      .innerJoin(products, eq(products.id, deliveryOrderLines.productId))
      .where(eq(deliveryOrderLines.deliveryOrderId, r.id))
      .orderBy(asc(deliveryOrderLines.lineNo));

    const [pod] = await db
      .select()
      .from(proofOfDeliveries)
      .where(eq(proofOfDeliveries.deliveryOrderId, r.id))
      .limit(1);

    enriched.push({
      ...r,
      lines,
      pod: pod ?? null,
    });
  }

  return enriched;
}

export async function listDeliveryClaims(
  db: DbExecutor,
  ctx: ActorContext,
  options?: { warehouseId?: string },
) {
  authorizeFulfillmentOrDeliveryRead(ctx, options?.warehouseId);

  const conditions = [];
  if (options?.warehouseId) {
    conditions.push(eq(deliveryClaims.warehouseId, options.warehouseId));
  }

  return db
    .select({
      id: deliveryClaims.id,
      claimNo: deliveryClaims.claimNo,
      podId: deliveryClaims.podId,
      podNumber: proofOfDeliveries.podNumber,
      deliveryOrderId: deliveryClaims.deliveryOrderId,
      doNumber: deliveryOrders.doNumber,
      salesOrderId: deliveryClaims.salesOrderId,
      soNumber: salesOrders.soNumber,
      customerId: deliveryClaims.customerId,
      customerName: customers.name,
      warehouseId: deliveryClaims.warehouseId,
      claimType: deliveryClaims.claimType,
      status: deliveryClaims.status,
      discrepancyQtyBase: deliveryClaims.discrepancyQtyBase,
      estimatedClaimValue: deliveryClaims.estimatedClaimValue,
      reasonCode: deliveryClaims.reasonCode,
      notes: deliveryClaims.notes,
      createdAt: deliveryClaims.createdAt,
    })
    .from(deliveryClaims)
    .leftJoin(proofOfDeliveries, eq(proofOfDeliveries.id, deliveryClaims.podId))
    .leftJoin(deliveryOrders, eq(deliveryOrders.id, deliveryClaims.deliveryOrderId))
    .innerJoin(salesOrders, eq(salesOrders.id, deliveryClaims.salesOrderId))
    .innerJoin(customers, eq(customers.id, deliveryClaims.customerId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(deliveryClaims.createdAt))
    .limit(50);
}

export async function listEligibleDrivers(
  db: DbExecutor,
  ctx: ActorContext,
  options?: { warehouseId?: string },
) {
  authorizeFulfillmentOrDeliveryRead(ctx, options?.warehouseId);
  const conditions = [eq(users.status, "active"), eq(roles.code, "driver")];
  if (options?.warehouseId) {
    conditions.push(eq(userRoleAssignments.warehouseId, options.warehouseId));
  }

  return db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
    })
    .from(users)
    .innerJoin(userRoleAssignments, eq(userRoleAssignments.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoleAssignments.roleId))
    .where(and(...conditions))
    .orderBy(asc(users.name));
}
