import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { businessDate } from "@/lib/datetime";
import {
  MoneyDecimal,
  roundRupiah,
  roundUnitPrice,
  toDbAmount,
  toDbUnitPrice,
  type Money,
} from "@/lib/money";
import { parseQty, roundQty, toDbQty } from "@/lib/quantity";
import { requestApproval, decideApproval } from "@/server/approvals";
import { recordAudit } from "@/server/audit";
import { authorize, hasPermission, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import {
  batches,
  inventoryMovements,
  products,
  productGrades,
  stockAdjustmentLines,
  stockAdjustments,
  stockBalances,
  stockCountLines,
  stockCounts,
  warehouseLocations,
  warehouses,
} from "@/server/db/schema";
import { BusinessRuleError, NotFoundError } from "@/server/errors";
import { withIdempotency } from "@/server/idempotency";
import { GL_ACCOUNT_CODES, getGlAccountBalance, postJournalEntry } from "@/server/modules/gl";
import { calculateOutflowCost } from "@/server/modules/inventory/costing";
import { nextDocumentNumber } from "@/server/sequences";

export type StockStatus = "available" | "reserved" | "quarantine" | "damaged" | "rejected";
export type MovementType =
  | "grn_receipt"
  | "grn_reject_quarantine"
  | "qc_release"
  | "internal_transfer_out"
  | "internal_transfer_in"
  | "regrade_out"
  | "regrade_in"
  | "reservation_hold"
  | "reservation_release"
  | "sales_pick_issue"
  | "spoilage_writeoff"
  | "shrinkage_writeoff"
  | "stock_adjustment_in"
  | "stock_adjustment_out"
  | "stock_count_gain"
  | "stock_count_loss"
  | "reversal_in"
  | "reversal_out";

export interface RecordMovementInput {
  warehouseId: string;
  warehouseCode?: string;
  locationId: string;
  batchId: string;
  productId: string;
  gradeId: string;
  stockStatus: StockStatus;
  movementType: MovementType;
  qtyDeltaBase: string | number; // positive = inflow, negative = outflow
  /** Required for inflows; for outflows, if omitted, uses the locked balance's unitCostBase */
  unitCostBase?: string | number;
  /** Optional explicit total cost delta for inflows (e.g., exact RSV allocated cost) */
  explicitInflowCost?: string | number;
  sourceDocType: string;
  sourceDocId: string;
  sourceLineId?: string | null;
  reasonCode?: string | null;
  notes?: string | null;
  reversalOfMovementId?: string | null;
  journalEntryId?: string | null;
}

/**
 * Core atomic primitive: locks the `(locationId, batchId, stockStatus)` balance row with `FOR UPDATE`,
 * validates that stock never goes negative, computes exact decimal cost delta, updates `stock_balances`,
 * and appends an immutable row to `inventory_movements`.
 */
export async function applyInventoryMovement(
  tx: DbExecutor,
  ctx: ActorContext,
  input: RecordMovementInput,
) {
  const qtyDelta = roundQty(parseQty(input.qtyDeltaBase));
  if (qtyDelta.isZero()) {
    throw new BusinessRuleError("Mutasi stok tidak boleh memiliki kuantitas 0.");
  }

  let whCode = input.warehouseCode;
  if (!whCode) {
    const [wh] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(eq(warehouses.id, input.warehouseId))
      .limit(1);
    whCode = wh?.code ?? "BKS1";
  }

  // Ensure balance row exists before locking if this is an inflow
  if (qtyDelta.gt(0)) {
    await tx
      .insert(stockBalances)
      .values({
        id: `sb_${crypto.randomUUID()}`,
        warehouseId: input.warehouseId,
        locationId: input.locationId,
        batchId: input.batchId,
        productId: input.productId,
        gradeId: input.gradeId,
        stockStatus: input.stockStatus,
        qtyBase: "0.000",
        unitCostBase: "0.0000",
        totalCost: "0.00",
      })
      .onConflictDoNothing({
        target: [stockBalances.locationId, stockBalances.batchId, stockBalances.stockStatus],
      });
  }

  // Acquire row-level lock on stock_balances
  const lockRes = await tx.execute<{
    id: string;
    qty_base: string;
    unit_cost_base: string;
    total_cost: string;
    version: number;
  }>(sql`
    SELECT id, qty_base, unit_cost_base, total_cost, version
    FROM stock_balances
    WHERE location_id = ${input.locationId}
      AND batch_id = ${input.batchId}
      AND stock_status = ${input.stockStatus}
    FOR UPDATE
  `);

  const locked = lockRes.rows[0];
  if (!locked) {
    throw new BusinessRuleError(
      `Saldo stok tidak ditemukan atau tidak mencukupi untuk lokasi ${input.locationId} dan batch ${input.batchId}.`,
    );
  }

  const curQty = roundQty(parseQty(locked.qty_base));
  const curCost = roundRupiah(new MoneyDecimal(locked.total_cost));
  const curUnitCost = roundUnitPrice(new MoneyDecimal(locked.unit_cost_base));

  let newQty: Money;
  let newTotalCost: Money;
  let newUnitCost: Money;
  let movementUnitCost: Money;
  let costDelta: Money;

  if (qtyDelta.gt(0)) {
    // Inflow
    const inUnitCost =
      input.unitCostBase !== undefined
        ? roundUnitPrice(new MoneyDecimal(input.unitCostBase.toString()))
        : curUnitCost;
    if (inUnitCost.lt(0)) {
      throw new BusinessRuleError("Harga pokok per satuan pada mutasi masuk tidak boleh negatif.");
    }
    const inCost =
      input.explicitInflowCost !== undefined
        ? roundRupiah(new MoneyDecimal(input.explicitInflowCost.toString()))
        : roundRupiah(qtyDelta.mul(inUnitCost));

    if (inCost.lt(0)) {
      throw new BusinessRuleError("Nilai biaya mutasi masuk tidak boleh negatif.");
    }

    newQty = roundQty(curQty.plus(qtyDelta));
    newTotalCost = roundRupiah(curCost.plus(inCost));
    newUnitCost = newQty.gt(0) ? roundUnitPrice(newTotalCost.div(newQty)) : inUnitCost;
    movementUnitCost = inUnitCost;
    costDelta = inCost;
  } else {
    // Outflow
    const outQty = qtyDelta.abs();
    if (outQty.gt(curQty)) {
      throw new BusinessRuleError(
        `Stok tidak mencukupi pada batch ${input.batchId} (status ${input.stockStatus}): dibutuhkan ${toDbQty(outQty)}, tersedia ${toDbQty(curQty)}. Stok negatif tidak diizinkan.`,
      );
    }

    const outflowCalc = calculateOutflowCost({
      currentQtyBase: toDbQty(curQty),
      currentTotalCost: toDbAmount(curCost),
      unitCostBase: toDbUnitPrice(curUnitCost),
      outflowQtyBase: toDbQty(outQty),
    });

    const outCost = new MoneyDecimal(outflowCalc.costOutflow);
    newQty = new MoneyDecimal(outflowCalc.remainingQtyBase);
    newTotalCost = new MoneyDecimal(outflowCalc.remainingTotalCost);
    newUnitCost = curUnitCost;
    movementUnitCost = curUnitCost;
    costDelta = outCost.negated();
  }

  // Update stock_balances
  const [updatedBalance] = await tx
    .update(stockBalances)
    .set({
      qtyBase: toDbQty(newQty),
      unitCostBase: toDbUnitPrice(newUnitCost),
      totalCost: toDbAmount(newTotalCost),
      version: locked.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(stockBalances.id, locked.id))
    .returning();

  // Append immutable inventory movement
  const movementNo = await nextDocumentNumber(tx, {
    docType: "MOV",
    warehouseCode: whCode,
  });
  const movementId = `mov_${crypto.randomUUID()}`;

  const [createdMovement] = await tx
    .insert(inventoryMovements)
    .values({
      id: movementId,
      movementNo,
      warehouseId: input.warehouseId,
      locationId: input.locationId,
      batchId: input.batchId,
      productId: input.productId,
      gradeId: input.gradeId,
      stockStatus: input.stockStatus,
      movementType: input.movementType,
      qtyDeltaBase: toDbQty(qtyDelta),
      unitCostBase: toDbUnitPrice(movementUnitCost),
      costDelta: toDbAmount(costDelta),
      sourceDocType: input.sourceDocType,
      sourceDocId: input.sourceDocId,
      sourceLineId: input.sourceLineId ?? null,
      reasonCode: input.reasonCode ?? null,
      notes: input.notes ?? null,
      reversalOfMovementId: input.reversalOfMovementId ?? null,
      journalEntryId: input.journalEntryId ?? null,
      createdBy: ctx.user.id,
    })
    .returning();

  // Check if batch is now completely depleted across active statuses
  if (newQty.isZero()) {
    const [remainingActive] = await tx
      .select({
        totalRemaining: sql<string>`COALESCE(SUM(${stockBalances.qtyBase}), 0)::numeric(14,3)`,
      })
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.batchId, input.batchId),
          inArray(stockBalances.stockStatus, ["available", "reserved", "quarantine"]),
        ),
      );
    if (new MoneyDecimal(remainingActive?.totalRemaining ?? "0").lte(0)) {
      await tx
        .update(batches)
        .set({ status: "depleted", updatedAt: new Date() })
        .where(and(eq(batches.id, input.batchId), eq(batches.status, "active")));
    }
  } else if (
    input.stockStatus === "available" ||
    input.stockStatus === "reserved" ||
    input.stockStatus === "quarantine"
  ) {
    await tx
      .update(batches)
      .set({ status: "active", updatedAt: new Date() })
      .where(and(eq(batches.id, input.batchId), eq(batches.status, "depleted")));
  }

  return {
    movement: createdMovement!,
    balance: updatedBalance!,
  };
}

export interface SelectFefoCandidatesInput {
  warehouseId: string;
  productId: string;
  gradeId?: string;
  asOfDate?: string; // YYYY-MM-DD, defaults to today's Jakarta date
  minRemainingShelfLifeDays?: number;
}

export interface FefoCandidateRow {
  balanceId: string;
  locationId: string;
  locationCode: string;
  batchId: string;
  batchCode: string;
  productId: string;
  gradeId: string;
  gradeCode: string;
  bestBeforeDate: string;
  receivedAt: Date;
  availableQtyBase: string;
  unitCostBase: string;
  totalCost: string;
}

/**
 * Selects eligible FEFO (First Expired, First Out) batches for picking/allocation.
 * - Excludes expired batches (`bestBeforeDate < minRequiredDate`), quarantined/depleted/recalled batches,
 *   and quarantine/reject zones.
 * - Sorted deterministically by `bestBeforeDate ASC`, `receivedAt ASC`, `batchCode ASC`, `locationId ASC`.
 */
export async function selectFefoCandidates(
  db: DbExecutor,
  ctx: ActorContext,
  input: SelectFefoCandidatesInput,
): Promise<FefoCandidateRow[]> {
  authorize(ctx, "inventory.read", { warehouseId: input.warehouseId });

  const baseDateStr = input.asOfDate ?? businessDate();
  let minBestBeforeDate = baseDateStr;
  if (input.minRemainingShelfLifeDays && input.minRemainingShelfLifeDays > 0) {
    const d = new Date(`${baseDateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + input.minRemainingShelfLifeDays);
    minBestBeforeDate = d.toISOString().slice(0, 10);
  }

  const gradeFilter = input.gradeId ? sql`AND sb.grade_id = ${input.gradeId}` : sql``;

  const res = await db.execute<{
    balance_id: string;
    location_id: string;
    location_code: string;
    batch_id: string;
    batch_code: string;
    product_id: string;
    grade_id: string;
    grade_code: string;
    best_before_date: string;
    received_at: Date;
    qty_base: string;
    unit_cost_base: string;
    total_cost: string;
  }>(sql`
    SELECT
      sb.id AS balance_id,
      sb.location_id,
      wl.code AS location_code,
      sb.batch_id,
      b.batch_code,
      sb.product_id,
      sb.grade_id,
      b.grade_code,
      b.best_before_date,
      b.received_at,
      sb.qty_base,
      sb.unit_cost_base,
      sb.total_cost
    FROM stock_balances sb
    INNER JOIN batches b ON b.id = sb.batch_id
    INNER JOIN warehouse_locations wl ON wl.id = sb.location_id
    WHERE sb.warehouse_id = ${input.warehouseId}
      AND sb.product_id = ${input.productId}
      ${gradeFilter}
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
  `);

  return res.rows.map((r) => ({
    balanceId: r.balance_id,
    locationId: r.location_id,
    locationCode: r.location_code,
    batchId: r.batch_id,
    batchCode: r.batch_code,
    productId: r.product_id,
    gradeId: r.grade_id,
    gradeCode: r.grade_code,
    bestBeforeDate: r.best_before_date,
    receivedAt: new Date(r.received_at),
    availableQtyBase: r.qty_base,
    unitCostBase: r.unit_cost_base,
    totalCost: r.total_cost,
  }));
}

export interface IssueStockFefoInput {
  idempotencyKey?: string;
  warehouseId: string;
  productId: string;
  gradeId?: string;
  requestedQtyBase: string | number;
  sourceDocType: string;
  sourceDocId: string;
  asOfDate?: string;
  minRemainingShelfLifeDays?: number;
  notes?: string;
  postCogsJournal?: boolean;
}

/**
 * Concurrency-safe FEFO stock issue/picking:
 * - Acquires `FOR UPDATE` row locks on candidate `stock_balances` rows in deterministic FEFO order.
 * - Prevents negative stock or partial under-allocation when two pickers issue concurrently.
 */
export async function issueStockFefo(
  tx: DbExecutor,
  ctx: ActorContext,
  input: IssueStockFefoInput,
) {
  authorize(ctx, "fulfillment.pick_pack", { warehouseId: input.warehouseId });

  const requestedQty = roundQty(parseQty(input.requestedQtyBase));
  if (requestedQty.lte(0)) {
    throw new BusinessRuleError("Kuantitas pengeluaran stok FEFO harus lebih besar dari 0.");
  }

  const executeIssue = async () => {
    const baseDateStr = input.asOfDate ?? businessDate();
    let minBestBeforeDate = baseDateStr;
    if (input.minRemainingShelfLifeDays && input.minRemainingShelfLifeDays > 0) {
      const d = new Date(`${baseDateStr}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + input.minRemainingShelfLifeDays);
      minBestBeforeDate = d.toISOString().slice(0, 10);
    }

    const gradeFilter = input.gradeId ? sql`AND sb.grade_id = ${input.gradeId}` : sql``;

    // Lock eligible stock_balances rows in deterministic FEFO order (`FOR UPDATE OF sb`)
    const lockRes = await tx.execute<{
      balance_id: string;
      location_id: string;
      batch_id: string;
      batch_code: string;
      product_id: string;
      grade_id: string;
      best_before_date: string;
      qty_base: string;
    }>(sql`
      SELECT
        sb.id AS balance_id,
        sb.location_id,
        sb.batch_id,
        b.batch_code,
        sb.product_id,
        sb.grade_id,
        b.best_before_date,
        sb.qty_base
      FROM stock_balances sb
      INNER JOIN batches b ON b.id = sb.batch_id
      INNER JOIN warehouse_locations wl ON wl.id = sb.location_id
      WHERE sb.warehouse_id = ${input.warehouseId}
        AND sb.product_id = ${input.productId}
        ${gradeFilter}
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
    for (const row of lockRes.rows) {
      totalAvailable = totalAvailable.plus(parseQty(row.qty_base));
    }

    if (totalAvailable.lt(requestedQty)) {
      throw new BusinessRuleError(
        `Stok FEFO yang memenuhi syarat tidak mencukupi: diminta ${toDbQty(requestedQty)}, tersedia ${toDbQty(totalAvailable)}.`,
      );
    }

    let remainingToPick = requestedQty;
    const allocations: Array<{
      batchId: string;
      batchCode: string;
      locationId: string;
      bestBeforeDate: string;
      pickedQtyBase: string;
      costOutflow: string;
      movementId: string;
    }> = [];

    for (const row of lockRes.rows) {
      if (remainingToPick.lte(0)) break;
      const avail = roundQty(parseQty(row.qty_base));
      if (avail.lte(0)) continue;

      const takeQty = remainingToPick.lte(avail) ? remainingToPick : avail;
      const res = await applyInventoryMovement(tx, ctx, {
        warehouseId: input.warehouseId,
        locationId: row.location_id,
        batchId: row.batch_id,
        productId: row.product_id,
        gradeId: row.grade_id,
        stockStatus: "available",
        movementType: "sales_pick_issue",
        qtyDeltaBase: toDbQty(takeQty.negated()),
        sourceDocType: input.sourceDocType,
        sourceDocId: input.sourceDocId,
        notes: input.notes ?? `Pengeluaran FEFO untuk ${input.sourceDocType} ${input.sourceDocId}`,
      });

      allocations.push({
        batchId: row.batch_id,
        batchCode: row.batch_code,
        locationId: row.location_id,
        bestBeforeDate: row.best_before_date,
        pickedQtyBase: toDbQty(takeQty),
        costOutflow: toDbAmount(new MoneyDecimal(res.movement.costDelta).abs()),
        movementId: res.movement.id,
      });

      remainingToPick = roundQty(remainingToPick.minus(takeQty));
    }

    const totalCostOutflow = allocations.reduce(
      (acc, a) => acc.plus(new MoneyDecimal(a.costOutflow)),
      new MoneyDecimal(0),
    );

    let journalEntryId: string | null = null;
    if (input.postCogsJournal && totalCostOutflow.gt(0)) {
      const je = await postJournalEntry(tx, ctx, {
        warehouseId: input.warehouseId,
        sourceDocType: input.sourceDocType,
        sourceDocId: input.sourceDocId,
        purpose: "sales_pick_cogs",
        memo: `HPP Pengeluaran Stok FEFO (${input.sourceDocType} ${input.sourceDocId})`,
        skipDirectPermissionCheck: true,
        lines: [
          {
            accountCode: GL_ACCOUNT_CODES.COGS_FRUIT,
            debit: toDbAmount(totalCostOutflow),
            warehouseId: input.warehouseId,
            productId: input.productId,
            description: "Beban HPP Buah Segar (FEFO)",
          },
          {
            accountCode: GL_ACCOUNT_CODES.INVENTORY_FRUIT,
            credit: toDbAmount(totalCostOutflow),
            warehouseId: input.warehouseId,
            productId: input.productId,
            description: "Pengurangan Persediaan Buah Segar (FEFO)",
          },
        ],
      });
      journalEntryId = je.entry.id;
    }

    await recordAudit(tx, {
      ctx,
      action: "inventory.fefo_issue",
      entityType: input.sourceDocType,
      entityId: input.sourceDocId,
      warehouseId: input.warehouseId,
      afterData: {
        requestedQtyBase: toDbQty(requestedQty),
        totalCostOutflow: toDbAmount(totalCostOutflow),
        allocations,
        journalEntryId,
      },
      reason: input.notes ?? "Pengeluaran stok dengan prioritas FEFO",
    });

    return {
      requestedQtyBase: toDbQty(requestedQty),
      totalCostOutflow: toDbAmount(totalCostOutflow),
      allocations,
      journalEntryId,
    };
  };

  if (input.idempotencyKey) {
    const idem = await withIdempotency(
      tx,
      {
        scope: "inventory.issue_fefo",
        key: input.idempotencyKey,
        payload: {
          warehouseId: input.warehouseId,
          productId: input.productId,
          gradeId: input.gradeId,
          requestedQtyBase: toDbQty(requestedQty),
          sourceDocType: input.sourceDocType,
          sourceDocId: input.sourceDocId,
        },
        actorUserId: ctx.user.id,
      },
      executeIssue,
    );
    return idem.result;
  }

  return executeIssue();
}

export interface CreateStockAdjustmentLineInput {
  locationId: string;
  batchId: string;
  stockStatus?: StockStatus;
  qtyDeltaBase: string | number; // negative for spoilage/loss, positive for gain
  reasonNote?: string;
}

export interface CreateStockAdjustmentInput {
  idempotencyKey?: string;
  warehouseId: string;
  adjustmentCategory: "spoilage" | "shrinkage" | "damage" | "quality_downgrade" | "manual_adjustment";
  reasonCode: string;
  notes: string;
  evidenceUrls?: string[];
  lines: CreateStockAdjustmentLineInput[];
  /**
   * If true and the actor holds `inventory.approve`, immediately approves and posts
   * the adjustment + GL journal in the same transaction.
   */
  autoPostIfPermitted?: boolean;
}

export const ADJUSTMENT_APPROVAL_COST_THRESHOLD = new MoneyDecimal("500000.00");
export const ADJUSTMENT_APPROVAL_QTY_THRESHOLD = new MoneyDecimal("10.000");

/**
 * Creates a Spoilage, Shrinkage, Damage, or Manual Stock Adjustment document.
 * - Requires `inventory.adjust`.
 * - Enforces reason codes, notes, and audit trail.
 * - Determines whether approval (`inventory.approve` / `approvals.decide`) is required.
 */
export async function createStockAdjustment(
  tx: DbExecutor,
  ctx: ActorContext,
  input: CreateStockAdjustmentInput,
) {
  authorize(ctx, "inventory.adjust", { warehouseId: input.warehouseId });

  if (!input.reasonCode?.trim()) {
    throw new BusinessRuleError("Kode alasan (reason code) susut/penyesuaian stok wajib diisi.");
  }
  if (!input.notes?.trim()) {
    throw new BusinessRuleError("Catatan penjelasan susut/penyesuaian stok wajib diisi.");
  }
  if (!input.lines || input.lines.length === 0) {
    throw new BusinessRuleError("Dokumen penyesuaian stok wajib memiliki minimal 1 baris batch.");
  }

  const runCreate = async () => {
    const [wh] = await tx
      .select()
      .from(warehouses)
      .where(eq(warehouses.id, input.warehouseId))
      .limit(1);
    if (!wh) throw new NotFoundError("Gudang tidak ditemukan.");

    const docType =
      input.adjustmentCategory === "spoilage" ||
      input.adjustmentCategory === "shrinkage" ||
      input.adjustmentCategory === "damage"
        ? "SPL"
        : "ADJ";

    const adjustmentNo = await nextDocumentNumber(tx, {
      docType,
      warehouseCode: wh.code,
    });
    const adjustmentId = `adj_${crypto.randomUUID()}`;

    let totalAbsQty = new MoneyDecimal(0);
    let totalAbsCost = new MoneyDecimal(0);

    const preparedLines = [];
    for (let i = 0; i < input.lines.length; i++) {
      const l = input.lines[i]!;
      const qtyDelta = roundQty(parseQty(l.qtyDeltaBase));
      if (qtyDelta.isZero()) {
        throw new BusinessRuleError(`Baris penyesuaian #${i + 1} tidak boleh memiliki kuantitas 0.`);
      }
      if (
        (input.adjustmentCategory === "spoilage" ||
          input.adjustmentCategory === "shrinkage" ||
          input.adjustmentCategory === "damage") &&
        qtyDelta.gt(0)
      ) {
        throw new BusinessRuleError(
          `Kategori '${input.adjustmentCategory}' hanya mengizinkan pengurangan stok (kuantitas negatif).`,
        );
      }

      const [batch] = await tx
        .select()
        .from(batches)
        .where(eq(batches.id, l.batchId))
        .limit(1);
      if (!batch || batch.warehouseId !== input.warehouseId) {
        throw new NotFoundError(`Batch ${l.batchId} tidak ditemukan di gudang ini.`);
      }

      const unitCost = roundUnitPrice(new MoneyDecimal(batch.unitCostBase));
      const estCostDelta = roundRupiah(qtyDelta.mul(unitCost));

      totalAbsQty = totalAbsQty.plus(qtyDelta.abs());
      totalAbsCost = totalAbsCost.plus(estCostDelta.abs());

      preparedLines.push({
        id: `adjl_${crypto.randomUUID()}`,
        stockAdjustmentId: adjustmentId,
        lineNo: i + 1,
        locationId: l.locationId,
        batchId: batch.id,
        productId: batch.productId,
        gradeId: batch.gradeId,
        stockStatus: l.stockStatus ?? ("available" as const),
        qtyDeltaBase: toDbQty(qtyDelta),
        unitCostBase: toDbUnitPrice(unitCost),
        totalCostDelta: toDbAmount(estCostDelta),
        reasonNote: l.reasonNote ?? null,
      });
    }

    const canApproveDirectly = hasPermission(ctx, "inventory.approve", {
      warehouseId: input.warehouseId,
    });
    const exceedsThreshold =
      totalAbsCost.gte(ADJUSTMENT_APPROVAL_COST_THRESHOLD) ||
      totalAbsQty.gte(ADJUSTMENT_APPROVAL_QTY_THRESHOLD);
    const requiresApproval = exceedsThreshold || !canApproveDirectly;

    const [createdHeader] = await tx
      .insert(stockAdjustments)
      .values({
        id: adjustmentId,
        adjustmentNo,
        warehouseId: input.warehouseId,
        adjustmentCategory: input.adjustmentCategory,
        reasonCode: input.reasonCode.trim(),
        status: "pending_approval",
        requiresApproval,
        notes: input.notes.trim(),
        evidenceUrls: input.evidenceUrls ?? null,
        requestedBy: ctx.user.id,
      })
      .returning();

    const createdLines = await tx
      .insert(stockAdjustmentLines)
      .values(preparedLines)
      .returning();

    let approvalRecord = null;
    if (requiresApproval) {
      approvalRecord = await requestApproval(tx, ctx, {
        approvalType: "stock_adjustment",
        sourceDocType: "stock_adjustment",
        sourceDocId: adjustmentId,
        warehouseId: input.warehouseId,
        requestReason: `${input.adjustmentCategory.toUpperCase()} (${input.reasonCode}): ${input.notes.trim()}`,
        ruleSnapshot: {
          totalAbsQty: toDbQty(totalAbsQty),
          totalAbsCost: toDbAmount(totalAbsCost),
          adjustmentCategory: input.adjustmentCategory,
        },
      });

      await tx
        .update(stockAdjustments)
        .set({ approvalId: approvalRecord.id })
        .where(eq(stockAdjustments.id, adjustmentId));
    }

    await recordAudit(tx, {
      ctx,
      action: "inventory.adjustment_create",
      entityType: "stock_adjustment",
      entityId: adjustmentId,
      warehouseId: input.warehouseId,
      afterData: {
        header: { ...createdHeader, approvalId: approvalRecord?.id ?? null },
        lines: createdLines,
      },
      reason: `${input.reasonCode}: ${input.notes.trim()}`,
    });

    if (input.autoPostIfPermitted && canApproveDirectly) {
      return postStockAdjustment(tx, ctx, {
        stockAdjustmentId: adjustmentId,
        approvalNote: `Disetujui & diposting langsung: ${input.notes.trim()}`,
      });
    }

    return {
      header: { ...createdHeader!, approvalId: approvalRecord?.id ?? null },
      lines: createdLines,
      approval: approvalRecord,
    };
  };

  if (input.idempotencyKey) {
    const idem = await withIdempotency(
      tx,
      {
        scope: "inventory.create_adjustment",
        key: input.idempotencyKey,
        payload: {
          warehouseId: input.warehouseId,
          adjustmentCategory: input.adjustmentCategory,
          reasonCode: input.reasonCode,
          lines: input.lines,
        },
        actorUserId: ctx.user.id,
      },
      runCreate,
    );
    return idem.result;
  }

  return runCreate();
}

export interface PostStockAdjustmentInput {
  stockAdjustmentId: string;
  approvalNote?: string;
}

/**
 * Approves and posts a Stock Adjustment / Spoilage document to the immutable inventory ledger,
 * updates `stock_balances`, and posts the corresponding GL journal entry (`5210` for spoilage/shrinkage/damage,
 * `5220` for manual adjustment variance).
 */
export async function postStockAdjustment(
  tx: DbExecutor,
  ctx: ActorContext,
  input: PostStockAdjustmentInput,
) {
  const [header] = await tx
    .select()
    .from(stockAdjustments)
    .where(eq(stockAdjustments.id, input.stockAdjustmentId))
    .limit(1);

  if (!header) {
    throw new NotFoundError("Dokumen penyesuaian stok tidak ditemukan.");
  }

  authorize(ctx, "inventory.approve", { warehouseId: header.warehouseId });

  if (header.status === "posted") {
    const existingLines = await tx
      .select()
      .from(stockAdjustmentLines)
      .where(eq(stockAdjustmentLines.stockAdjustmentId, header.id))
      .orderBy(asc(stockAdjustmentLines.lineNo));
    return { header, lines: existingLines, approval: null };
  }

  if (header.status !== "pending_approval" && header.status !== "approved" && header.status !== "draft") {
    throw new BusinessRuleError(
      `Dokumen penyesuaian stok ${header.adjustmentNo} berstatus '${header.status}' dan tidak dapat diposting.`,
    );
  }

  // If there is a pending approval record and the user has approvals.decide, approve it
  if (header.approvalId && hasPermission(ctx, "approvals.decide", { warehouseId: header.warehouseId })) {
    const isOwner = ctx.roles.some((r) => r.roleCode === "owner");
    if (header.requestedBy !== ctx.user.id || isOwner) {
      try {
        await decideApproval(tx, ctx, {
          approvalId: header.approvalId,
          decision: "approved",
          decisionNote: input.approvalNote ?? `Penyesuaian stok ${header.adjustmentNo} disetujui.`,
          expectedVersion: 1,
        });
      } catch {
        // Ignore if already decided
      }
    }
  }

  const lines = await tx
    .select()
    .from(stockAdjustmentLines)
    .where(eq(stockAdjustmentLines.stockAdjustmentId, header.id))
    .orderBy(asc(stockAdjustmentLines.lineNo));

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, header.warehouseId))
    .limit(1);

  const journalLinesToPost: Array<{
    accountCode: string;
    debit?: string;
    credit?: string;
    warehouseId: string;
    productId: string;
    batchId: string;
    description: string;
  }> = [];

  const expenseAccountCode =
    header.adjustmentCategory === "spoilage" ||
    header.adjustmentCategory === "shrinkage" ||
    header.adjustmentCategory === "damage"
      ? GL_ACCOUNT_CODES.SPOILAGE_EXPENSE
      : GL_ACCOUNT_CODES.INVENTORY_VARIANCE;

  for (const line of lines) {
    const qtyDelta = roundQty(parseQty(line.qtyDeltaBase));
    const movementType: MovementType =
      header.adjustmentCategory === "spoilage" || header.adjustmentCategory === "damage"
        ? "spoilage_writeoff"
        : header.adjustmentCategory === "shrinkage"
          ? "shrinkage_writeoff"
          : qtyDelta.gt(0)
            ? "stock_adjustment_in"
            : "stock_adjustment_out";

    const movRes = await applyInventoryMovement(tx, ctx, {
      warehouseId: header.warehouseId,
      warehouseCode: wh?.code ?? "BKS1",
      locationId: line.locationId,
      batchId: line.batchId,
      productId: line.productId,
      gradeId: line.gradeId,
      stockStatus: line.stockStatus as StockStatus,
      movementType,
      qtyDeltaBase: line.qtyDeltaBase,
      unitCostBase: line.unitCostBase,
      sourceDocType: "stock_adjustment",
      sourceDocId: header.id,
      sourceLineId: line.id,
      reasonCode: header.reasonCode,
      notes: header.notes,
    });

    // Update line totalCostDelta with the exact costDelta recorded by the ledger
    await tx
      .update(stockAdjustmentLines)
      .set({ totalCostDelta: movRes.movement.costDelta })
      .where(eq(stockAdjustmentLines.id, line.id));

    const actualCostAbs = new MoneyDecimal(movRes.movement.costDelta).abs();
    if (actualCostAbs.gt(0)) {
      if (qtyDelta.lt(0)) {
        // Loss / Spoilage: Dr Expense (5210 or 5220), Cr Inventory (1140)
        journalLinesToPost.push(
          {
            accountCode: expenseAccountCode,
            debit: toDbAmount(actualCostAbs),
            warehouseId: header.warehouseId,
            productId: line.productId,
            batchId: line.batchId,
            description: `${header.adjustmentCategory.toUpperCase()} (${header.reasonCode}) - ${header.adjustmentNo}`,
          },
          {
            accountCode: GL_ACCOUNT_CODES.INVENTORY_FRUIT,
            credit: toDbAmount(actualCostAbs),
            warehouseId: header.warehouseId,
            productId: line.productId,
            batchId: line.batchId,
            description: `Pengurangan Persediaan ${header.adjustmentNo}`,
          },
        );
      } else {
        // Gain: Dr Inventory (1140), Cr Variance (5220)
        journalLinesToPost.push(
          {
            accountCode: GL_ACCOUNT_CODES.INVENTORY_FRUIT,
            debit: toDbAmount(actualCostAbs),
            warehouseId: header.warehouseId,
            productId: line.productId,
            batchId: line.batchId,
            description: `Penambahan Persediaan ${header.adjustmentNo}`,
          },
          {
            accountCode: GL_ACCOUNT_CODES.INVENTORY_VARIANCE,
            credit: toDbAmount(actualCostAbs),
            warehouseId: header.warehouseId,
            productId: line.productId,
            batchId: line.batchId,
            description: `Selisih Lebih Penyesuaian Stok (${header.reasonCode}) - ${header.adjustmentNo}`,
          },
        );
      }
    }
  }

  let journalEntryId: string | null = null;
  if (journalLinesToPost.length >= 2) {
    const jeRes = await postJournalEntry(tx, ctx, {
      warehouseId: header.warehouseId,
      sourceDocType: "stock_adjustment",
      sourceDocId: header.id,
      purpose: "adjustment_posting",
      memo: `Posting ${header.adjustmentCategory.toUpperCase()} ${header.adjustmentNo} (${header.reasonCode}): ${header.notes}`,
      skipDirectPermissionCheck: true,
      lines: journalLinesToPost,
    });
    journalEntryId = jeRes.entry.id;
  }

  const [updatedHeader] = await tx
    .update(stockAdjustments)
    .set({
      status: "posted",
      journalEntryId,
      postedBy: ctx.user.id,
      postedAt: new Date(),
      version: header.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(stockAdjustments.id, header.id))
    .returning();

  const updatedLines = await tx
    .select()
    .from(stockAdjustmentLines)
    .where(eq(stockAdjustmentLines.stockAdjustmentId, header.id))
    .orderBy(asc(stockAdjustmentLines.lineNo));

  await recordAudit(tx, {
    ctx,
    action: "inventory.adjustment_post",
    entityType: "stock_adjustment",
    entityId: header.id,
    warehouseId: header.warehouseId,
    beforeData: header,
    afterData: { header: updatedHeader, lines: updatedLines, journalEntryId },
    reason: input.approvalNote ?? header.notes,
  });

  return { header: updatedHeader!, lines: updatedLines, approval: null };
}

export interface CreateAndPostStockCountInput {
  warehouseId: string;
  locationId?: string;
  countDate?: string;
  notes?: string;
  lines: Array<{
    locationId: string;
    batchId: string;
    stockStatus?: StockStatus;
    countedQtyBase: string | number;
    reasonCode?: string;
  }>;
}

/**
 * Records and posts a physical cycle count (Stock Opname):
 * - Compares counted quantity against locked `stock_balances` system quantity.
 * - Posts `stock_count_gain` / `stock_count_loss` movements and GL variance journal (`1140` vs `5220`).
 */
export async function createAndPostStockCount(
  tx: DbExecutor,
  ctx: ActorContext,
  input: CreateAndPostStockCountInput,
) {
  authorize(ctx, "inventory.adjust", { warehouseId: input.warehouseId });
  authorize(ctx, "inventory.approve", { warehouseId: input.warehouseId });

  if (!input.lines || input.lines.length === 0) {
    throw new BusinessRuleError("Stok opname wajib memiliki minimal 1 baris batch.");
  }

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, input.warehouseId))
    .limit(1);
  if (!wh) throw new NotFoundError("Gudang tidak ditemukan.");

  const countNo = await nextDocumentNumber(tx, {
    docType: "CNT",
    warehouseCode: wh.code,
  });
  const countId = `cnt_${crypto.randomUUID()}`;
  const countDate = input.countDate ?? businessDate();

  const [header] = await tx
    .insert(stockCounts)
    .values({
      id: countId,
      countNo,
      warehouseId: input.warehouseId,
      locationId: input.locationId ?? null,
      countDate,
      status: "draft",
      notes: input.notes ?? null,
      countedBy: ctx.user.id,
    })
    .returning();

  const journalLinesToPost: Array<{
    accountCode: string;
    debit?: string;
    credit?: string;
    warehouseId: string;
    productId: string;
    batchId: string;
    description: string;
  }> = [];

  const createdLines = [];

  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i]!;
    const countedQty = roundQty(parseQty(l.countedQtyBase));
    if (countedQty.lt(0)) {
      throw new BusinessRuleError(`Kuantitas hasil hitung fisik pada baris #${i + 1} tidak boleh negatif.`);
    }

    const [batch] = await tx
      .select()
      .from(batches)
      .where(eq(batches.id, l.batchId))
      .limit(1);
    if (!batch) throw new NotFoundError(`Batch ${l.batchId} tidak ditemukan.`);

    const stockStatus = l.stockStatus ?? "available";
    const [bal] = await tx
      .select()
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.locationId, l.locationId),
          eq(stockBalances.batchId, l.batchId),
          eq(stockBalances.stockStatus, stockStatus),
        ),
      )
      .limit(1);

    const systemQty = roundQty(parseQty(bal?.qtyBase ?? "0.000"));
    const varianceQty = roundQty(countedQty.minus(systemQty));
    const unitCost = roundUnitPrice(new MoneyDecimal(bal?.unitCostBase ?? batch.unitCostBase));

    let varianceCost = new MoneyDecimal(0);
    if (!varianceQty.isZero()) {
      const movRes = await applyInventoryMovement(tx, ctx, {
        warehouseId: input.warehouseId,
        warehouseCode: wh.code,
        locationId: l.locationId,
        batchId: batch.id,
        productId: batch.productId,
        gradeId: batch.gradeId,
        stockStatus,
        movementType: varianceQty.gt(0) ? "stock_count_gain" : "stock_count_loss",
        qtyDeltaBase: toDbQty(varianceQty),
        unitCostBase: toDbUnitPrice(unitCost),
        sourceDocType: "stock_count",
        sourceDocId: countId,
        reasonCode: l.reasonCode ?? "OPNAME_FISIK",
        notes: input.notes ?? `Selisih opname fisik ${countNo}`,
      });
      varianceCost = new MoneyDecimal(movRes.movement.costDelta);

      const absCost = varianceCost.abs();
      if (absCost.gt(0)) {
        if (varianceQty.gt(0)) {
          journalLinesToPost.push(
            {
              accountCode: GL_ACCOUNT_CODES.INVENTORY_FRUIT,
              debit: toDbAmount(absCost),
              warehouseId: input.warehouseId,
              productId: batch.productId,
              batchId: batch.id,
              description: `Selisih Lebih Stok Opname ${countNo}`,
            },
            {
              accountCode: GL_ACCOUNT_CODES.INVENTORY_VARIANCE,
              credit: toDbAmount(absCost),
              warehouseId: input.warehouseId,
              productId: batch.productId,
              batchId: batch.id,
              description: `Selisih Lebih Stok Opname ${countNo}`,
            },
          );
        } else {
          journalLinesToPost.push(
            {
              accountCode: GL_ACCOUNT_CODES.INVENTORY_VARIANCE,
              debit: toDbAmount(absCost),
              warehouseId: input.warehouseId,
              productId: batch.productId,
              batchId: batch.id,
              description: `Selisih Kurang Stok Opname ${countNo}`,
            },
            {
              accountCode: GL_ACCOUNT_CODES.INVENTORY_FRUIT,
              credit: toDbAmount(absCost),
              warehouseId: input.warehouseId,
              productId: batch.productId,
              batchId: batch.id,
              description: `Selisih Kurang Stok Opname ${countNo}`,
            },
          );
        }
      }
    }

    const [createdLine] = await tx
      .insert(stockCountLines)
      .values({
        id: `cntl_${crypto.randomUUID()}`,
        stockCountId: countId,
        lineNo: i + 1,
        locationId: l.locationId,
        batchId: batch.id,
        productId: batch.productId,
        gradeId: batch.gradeId,
        stockStatus,
        systemQtyBase: toDbQty(systemQty),
        countedQtyBase: toDbQty(countedQty),
        varianceQtyBase: toDbQty(varianceQty),
        unitCostBase: toDbUnitPrice(unitCost),
        varianceCost: toDbAmount(varianceCost),
        reasonCode: l.reasonCode ?? "OPNAME_FISIK",
      })
      .returning();
    createdLines.push(createdLine!);
  }

  let journalEntryId: string | null = null;
  if (journalLinesToPost.length >= 2) {
    const jeRes = await postJournalEntry(tx, ctx, {
      warehouseId: input.warehouseId,
      sourceDocType: "stock_count",
      sourceDocId: countId,
      purpose: "stock_count_variance",
      memo: `Posting Selisih Stok Opname ${countNo}`,
      skipDirectPermissionCheck: true,
      lines: journalLinesToPost,
    });
    journalEntryId = jeRes.entry.id;
  }

  const [updatedHeader] = await tx
    .update(stockCounts)
    .set({
      status: "posted",
      journalEntryId,
      postedBy: ctx.user.id,
      postedAt: new Date(),
      version: header!.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(stockCounts.id, countId))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "inventory.stock_count_post",
    entityType: "stock_count",
    entityId: countId,
    warehouseId: input.warehouseId,
    afterData: { header: updatedHeader, lines: createdLines, journalEntryId },
    reason: input.notes ?? `Posting Stok Opname ${countNo}`,
  });

  return { header: updatedHeader!, lines: createdLines, journalEntryId };
}

export interface LedgerBalanceDiscrepancy {
  locationId: string;
  batchId: string;
  stockStatus: string;
  ledgerQtyBase: string;
  balanceQtyBase: string;
  ledgerCost: string;
  balanceCost: string;
}

export interface InventoryGlReconciliationReport {
  warehouseId: string | null;
  totalLedgerQtyBase: string;
  totalBalanceQtyBase: string;
  qtyVarianceBase: string;
  totalLedgerValue: string;
  totalBalanceValue: string;
  glInventoryAccountBalance: string;
  ledgerVsBalanceValueVariance: string;
  inventoryVsGlVariance: string;
  ledgerBalanceDiscrepancies: LedgerBalanceDiscrepancy[];
  isReconciled: boolean;
}

/**
 * Reconciles:
 * 1. `SUM(inventory_movements)` vs `stock_balances` per `(location_id, batch_id, stock_status)` and in aggregate.
 * 2. Total inventory valuation (`SUM(stock_balances.total_cost)`) vs GL Inventory account (`1140`) net balance.
 */
export async function reconcileInventoryAndGl(
  db: DbExecutor,
  ctx: ActorContext,
  options?: { warehouseId?: string },
): Promise<InventoryGlReconciliationReport> {
  authorize(ctx, "inventory.read", { warehouseId: options?.warehouseId });

  const whFilterMov = options?.warehouseId
    ? sql`WHERE m.warehouse_id = ${options.warehouseId}`
    : sql``;
  const whFilterBal = options?.warehouseId
    ? sql`WHERE b.warehouse_id = ${options.warehouseId}`
    : sql``;

  const compRes = await db.execute<{
    location_id: string;
    batch_id: string;
    stock_status: string;
    ledger_qty: string;
    balance_qty: string;
    ledger_cost: string;
    balance_cost: string;
  }>(sql`
    WITH ledger AS (
      SELECT
        m.location_id,
        m.batch_id,
        m.stock_status,
        COALESCE(SUM(m.qty_delta_base), 0)::numeric(14,3) AS ledger_qty,
        COALESCE(SUM(m.cost_delta), 0)::numeric(18,2) AS ledger_cost
      FROM inventory_movements m
      ${whFilterMov}
      GROUP BY m.location_id, m.batch_id, m.stock_status
    ),
    bal AS (
      SELECT
        b.location_id,
        b.batch_id,
        b.stock_status,
        b.qty_base AS balance_qty,
        b.total_cost AS balance_cost
      FROM stock_balances b
      ${whFilterBal}
    )
    SELECT
      COALESCE(ledger.location_id, bal.location_id) AS location_id,
      COALESCE(ledger.batch_id, bal.batch_id) AS batch_id,
      COALESCE(ledger.stock_status, bal.stock_status) AS stock_status,
      COALESCE(ledger.ledger_qty, 0)::numeric(14,3) AS ledger_qty,
      COALESCE(bal.balance_qty, 0)::numeric(14,3) AS balance_qty,
      COALESCE(ledger.ledger_cost, 0)::numeric(18,2) AS ledger_cost,
      COALESCE(bal.balance_cost, 0)::numeric(18,2) AS balance_cost
    FROM ledger
    FULL OUTER JOIN bal
      ON ledger.location_id = bal.location_id
     AND ledger.batch_id = bal.batch_id
     AND ledger.stock_status = bal.stock_status
  `);

  let totalLedgerQty = new MoneyDecimal(0);
  let totalBalanceQty = new MoneyDecimal(0);
  let totalLedgerVal = new MoneyDecimal(0);
  let totalBalanceVal = new MoneyDecimal(0);
  const discrepancies: LedgerBalanceDiscrepancy[] = [];

  for (const r of compRes.rows) {
    const lQty = roundQty(parseQty(r.ledger_qty));
    const bQty = roundQty(parseQty(r.balance_qty));
    const lCost = roundRupiah(new MoneyDecimal(r.ledger_cost));
    const bCost = roundRupiah(new MoneyDecimal(r.balance_cost));

    totalLedgerQty = totalLedgerQty.plus(lQty);
    totalBalanceQty = totalBalanceQty.plus(bQty);
    totalLedgerVal = totalLedgerVal.plus(lCost);
    totalBalanceVal = totalBalanceVal.plus(bCost);

    if (!lQty.eq(bQty) || !lCost.eq(bCost)) {
      discrepancies.push({
        locationId: r.location_id,
        batchId: r.batch_id,
        stockStatus: r.stock_status,
        ledgerQtyBase: toDbQty(lQty),
        balanceQtyBase: toDbQty(bQty),
        ledgerCost: toDbAmount(lCost),
        balanceCost: toDbAmount(bCost),
      });
    }
  }

  const glBal = await getGlAccountBalance(db, GL_ACCOUNT_CODES.INVENTORY_FRUIT, {
    warehouseId: options?.warehouseId,
  });
  const glInventoryVal = roundRupiah(new MoneyDecimal(glBal.netBalance));

  const qtyVariance = roundQty(totalLedgerQty.minus(totalBalanceQty));
  const ledgerVsBalanceValVar = roundRupiah(totalLedgerVal.minus(totalBalanceVal));
  const inventoryVsGlVar = roundRupiah(totalBalanceVal.minus(glInventoryVal));

  const isReconciled =
    discrepancies.length === 0 &&
    qtyVariance.isZero() &&
    ledgerVsBalanceValVar.isZero() &&
    inventoryVsGlVar.isZero();

  return {
    warehouseId: options?.warehouseId ?? null,
    totalLedgerQtyBase: toDbQty(totalLedgerQty),
    totalBalanceQtyBase: toDbQty(totalBalanceQty),
    qtyVarianceBase: toDbQty(qtyVariance),
    totalLedgerValue: toDbAmount(totalLedgerVal),
    totalBalanceValue: toDbAmount(totalBalanceVal),
    glInventoryAccountBalance: toDbAmount(glInventoryVal),
    ledgerVsBalanceValueVariance: toDbAmount(ledgerVsBalanceValVar),
    inventoryVsGlVariance: toDbAmount(inventoryVsGlVar),
    ledgerBalanceDiscrepancies: discrepancies,
    isReconciled,
  };
}

export async function listBatchesWithBalances(
  db: DbExecutor,
  ctx: ActorContext,
  options?: { warehouseId?: string },
) {
  authorize(ctx, "inventory.read", { warehouseId: options?.warehouseId });
  const rows = await db
    .select({
      balance: stockBalances,
      batch: batches,
      product: products,
      grade: productGrades,
      location: warehouseLocations,
    })
    .from(stockBalances)
    .innerJoin(batches, eq(batches.id, stockBalances.batchId))
    .innerJoin(products, eq(products.id, stockBalances.productId))
    .innerJoin(productGrades, eq(productGrades.id, stockBalances.gradeId))
    .innerJoin(warehouseLocations, eq(warehouseLocations.id, stockBalances.locationId))
    .where(options?.warehouseId ? eq(stockBalances.warehouseId, options.warehouseId) : undefined)
    .orderBy(asc(batches.bestBeforeDate), asc(batches.receivedAt));
  return rows;
}

export async function listInventoryMovements(
  db: DbExecutor,
  ctx: ActorContext,
  options?: { warehouseId?: string; limit?: number },
) {
  authorize(ctx, "inventory.read", { warehouseId: options?.warehouseId });
  return db
    .select({
      movement: inventoryMovements,
      product: products,
      grade: productGrades,
      batch: batches,
      location: warehouseLocations,
    })
    .from(inventoryMovements)
    .innerJoin(products, eq(products.id, inventoryMovements.productId))
    .innerJoin(productGrades, eq(productGrades.id, inventoryMovements.gradeId))
    .innerJoin(batches, eq(batches.id, inventoryMovements.batchId))
    .innerJoin(warehouseLocations, eq(warehouseLocations.id, inventoryMovements.locationId))
    .where(
      options?.warehouseId ? eq(inventoryMovements.warehouseId, options.warehouseId) : undefined,
    )
    .orderBy(desc(inventoryMovements.createdAt))
    .limit(options?.limit ?? 100);
}

export async function listStockAdjustments(
  db: DbExecutor,
  ctx: ActorContext,
  options?: { warehouseId?: string },
) {
  authorize(ctx, "inventory.read", { warehouseId: options?.warehouseId });
  return db
    .select()
    .from(stockAdjustments)
    .where(options?.warehouseId ? eq(stockAdjustments.warehouseId, options.warehouseId) : undefined)
    .orderBy(desc(stockAdjustments.createdAt))
    .limit(50);
}
