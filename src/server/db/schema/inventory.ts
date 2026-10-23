import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { journalEntries } from "./gl";
import { productGrades, products, suppliers, warehouseLocations, warehouses } from "./master";
import { approvals, users } from "./platform";
import { goodsReceiptLines, goodsReceipts } from "./procurement";

/**
 * Phase 3 Inventory Batches, Immutable Stock Ledger (`inventory_movements`),
 * Materialized Stock Balances (`stock_balances`), FEFO Reservations,
 * Spoilage / Stock Adjustments, and Physical Stock Counts.
 */

export const batches = pgTable(
  "batches",
  {
    id: text("id").primaryKey(),
    batchCode: text("batch_code").notNull().unique(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    gradeId: text("grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    gradeCode: text("grade_code").notNull(),
    supplierId: text("supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    goodsReceiptId: text("goods_receipt_id").references(() => goodsReceipts.id, {
      onDelete: "restrict",
    }),
    goodsReceiptLineId: text("goods_receipt_line_id").references(() => goodsReceiptLines.id, {
      onDelete: "restrict",
    }),
    originRegion: text("origin_region").notNull(),
    harvestedAt: timestamp("harvested_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    ripenessStage: text("ripeness_stage", {
      enum: ["mentah", "mengkal", "matang_siap_jual", "terlalu_matang"],
    })
      .notNull()
      .default("mengkal"),
    bestBeforeDate: text("best_before_date").notNull(), // YYYY-MM-DD for FEFO sorting
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    initialQtyBase: numeric("initial_qty_base", { precision: 14, scale: 3 }).notNull(),
    unitCostBase: numeric("unit_cost_base", { precision: 18, scale: 4 }).notNull(),
    totalInitialCost: numeric("total_initial_cost", { precision: 18, scale: 2 }).notNull(),
    costingMethod: text("costing_method").notNull().default("lot_actual_rsv"),
    status: text("status", {
      enum: ["active", "quarantine", "expired", "depleted", "recalled"],
    })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("batches_fefo_idx").on(
      t.productId,
      t.warehouseId,
      t.status,
      t.bestBeforeDate,
      t.receivedAt,
    ),
    index("batches_grn_idx").on(t.goodsReceiptId),
  ],
);

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: text("id").primaryKey(),
    movementNo: text("movement_no").notNull().unique(),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    locationId: text("location_id")
      .notNull()
      .references(() => warehouseLocations.id, { onDelete: "restrict" }),
    batchId: text("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "restrict" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    gradeId: text("grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    stockStatus: text("stock_status", {
      enum: ["available", "reserved", "quarantine", "damaged", "rejected"],
    }).notNull(),
    movementType: text("movement_type", {
      enum: [
        "grn_receipt",
        "grn_reject_quarantine",
        "qc_release",
        "internal_transfer_out",
        "internal_transfer_in",
        "regrade_out",
        "regrade_in",
        "reservation_hold",
        "reservation_release",
        "sales_pick_issue",
        "spoilage_writeoff",
        "shrinkage_writeoff",
        "stock_adjustment_in",
        "stock_adjustment_out",
        "stock_count_gain",
        "stock_count_loss",
        "reversal_in",
        "reversal_out",
      ],
    }).notNull(),
    qtyDeltaBase: numeric("qty_delta_base", { precision: 14, scale: 3 }).notNull(),
    unitCostBase: numeric("unit_cost_base", { precision: 18, scale: 4 }).notNull(),
    costDelta: numeric("cost_delta", { precision: 18, scale: 2 }).notNull(),
    sourceDocType: text("source_doc_type").notNull(),
    sourceDocId: text("source_doc_id").notNull(),
    sourceLineId: text("source_line_id"),
    reasonCode: text("reason_code"),
    notes: text("notes"),
    reversalOfMovementId: text("reversal_of_movement_id").references(
      (): AnyPgColumn => inventoryMovements.id,
      { onDelete: "restrict" },
    ),
    journalEntryId: text("journal_entry_id").references(() => journalEntries.id, {
      onDelete: "restrict",
    }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("inventory_movements_balance_key_idx").on(t.locationId, t.batchId, t.stockStatus),
    index("inventory_movements_source_idx").on(t.sourceDocType, t.sourceDocId),
    index("inventory_movements_warehouse_created_idx").on(t.warehouseId, t.createdAt),
  ],
);

export const stockBalances = pgTable(
  "stock_balances",
  {
    id: text("id").primaryKey(),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    locationId: text("location_id")
      .notNull()
      .references(() => warehouseLocations.id, { onDelete: "restrict" }),
    batchId: text("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "restrict" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    gradeId: text("grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    stockStatus: text("stock_status", {
      enum: ["available", "reserved", "quarantine", "damaged", "rejected"],
    }).notNull(),
    qtyBase: numeric("qty_base", { precision: 14, scale: 3 }).notNull().default("0.000"),
    unitCostBase: numeric("unit_cost_base", { precision: 18, scale: 4 })
      .notNull()
      .default("0.0000"),
    totalCost: numeric("total_cost", { precision: 18, scale: 2 }).notNull().default("0.00"),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("stock_balances_loc_batch_status_uidx").on(
      t.locationId,
      t.batchId,
      t.stockStatus,
    ),
    index("stock_balances_warehouse_product_idx").on(t.warehouseId, t.productId, t.stockStatus),
  ],
);

export const stockReservations = pgTable(
  "stock_reservations",
  {
    id: text("id").primaryKey(),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    locationId: text("location_id")
      .notNull()
      .references(() => warehouseLocations.id, { onDelete: "restrict" }),
    batchId: text("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "restrict" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    gradeId: text("grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    sourceDocType: text("source_doc_type").notNull(),
    sourceDocId: text("source_doc_id").notNull(),
    reservedQtyBase: numeric("reserved_qty_base", { precision: 14, scale: 3 }).notNull(),
    fulfilledQtyBase: numeric("fulfilled_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    status: text("status", {
      enum: ["active", "fulfilled", "released"],
    })
      .notNull()
      .default("active"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("stock_reservations_source_idx").on(t.sourceDocType, t.sourceDocId),
    index("stock_reservations_batch_idx").on(t.batchId, t.status),
  ],
);

export const stockAdjustments = pgTable(
  "stock_adjustments",
  {
    id: text("id").primaryKey(),
    adjustmentNo: text("adjustment_no").notNull().unique(),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    adjustmentCategory: text("adjustment_category", {
      enum: ["spoilage", "shrinkage", "damage", "quality_downgrade", "manual_adjustment"],
    }).notNull(),
    reasonCode: text("reason_code").notNull(),
    status: text("status", {
      enum: ["draft", "pending_approval", "approved", "posted", "rejected", "cancelled"],
    })
      .notNull()
      .default("draft"),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    approvalId: text("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    journalEntryId: text("journal_entry_id").references(() => journalEntries.id, {
      onDelete: "set null",
    }),
    notes: text("notes").notNull(),
    evidenceUrls: jsonb("evidence_urls"),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    postedBy: text("posted_by").references(() => users.id, { onDelete: "restrict" }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("stock_adjustments_warehouse_status_idx").on(t.warehouseId, t.status)],
);

export const stockAdjustmentLines = pgTable(
  "stock_adjustment_lines",
  {
    id: text("id").primaryKey(),
    stockAdjustmentId: text("stock_adjustment_id")
      .notNull()
      .references(() => stockAdjustments.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    locationId: text("location_id")
      .notNull()
      .references(() => warehouseLocations.id, { onDelete: "restrict" }),
    batchId: text("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "restrict" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    gradeId: text("grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    stockStatus: text("stock_status", {
      enum: ["available", "reserved", "quarantine", "damaged", "rejected"],
    })
      .notNull()
      .default("available"),
    qtyDeltaBase: numeric("qty_delta_base", { precision: 14, scale: 3 }).notNull(),
    unitCostBase: numeric("unit_cost_base", { precision: 18, scale: 4 }).notNull(),
    totalCostDelta: numeric("total_cost_delta", { precision: 18, scale: 2 }).notNull(),
    reasonNote: text("reason_note"),
  },
  (t) => [
    uniqueIndex("stock_adjustment_lines_adj_lineno_uidx").on(t.stockAdjustmentId, t.lineNo),
  ],
);

export const stockCounts = pgTable(
  "stock_counts",
  {
    id: text("id").primaryKey(),
    countNo: text("count_no").notNull().unique(),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    locationId: text("location_id").references(() => warehouseLocations.id, {
      onDelete: "restrict",
    }),
    countDate: text("count_date").notNull(), // YYYY-MM-DD
    status: text("status", {
      enum: ["draft", "submitted", "approved", "posted", "cancelled"],
    })
      .notNull()
      .default("draft"),
    approvalId: text("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    journalEntryId: text("journal_entry_id").references(() => journalEntries.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    countedBy: text("counted_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    postedBy: text("posted_by").references(() => users.id, { onDelete: "restrict" }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("stock_counts_warehouse_status_idx").on(t.warehouseId, t.status)],
);

export const stockCountLines = pgTable(
  "stock_count_lines",
  {
    id: text("id").primaryKey(),
    stockCountId: text("stock_count_id")
      .notNull()
      .references(() => stockCounts.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    locationId: text("location_id")
      .notNull()
      .references(() => warehouseLocations.id, { onDelete: "restrict" }),
    batchId: text("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "restrict" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    gradeId: text("grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    stockStatus: text("stock_status", {
      enum: ["available", "reserved", "quarantine", "damaged", "rejected"],
    })
      .notNull()
      .default("available"),
    systemQtyBase: numeric("system_qty_base", { precision: 14, scale: 3 }).notNull(),
    countedQtyBase: numeric("counted_qty_base", { precision: 14, scale: 3 }).notNull(),
    varianceQtyBase: numeric("variance_qty_base", { precision: 14, scale: 3 }).notNull(),
    unitCostBase: numeric("unit_cost_base", { precision: 18, scale: 4 }).notNull(),
    varianceCost: numeric("variance_cost", { precision: 18, scale: 2 }).notNull(),
    reasonCode: text("reason_code"),
  },
  (t) => [uniqueIndex("stock_count_lines_count_lineno_uidx").on(t.stockCountId, t.lineNo)],
);
