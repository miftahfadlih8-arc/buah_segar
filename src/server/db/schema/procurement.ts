import {
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
import {
  packagingTypes,
  productGrades,
  products,
  suppliers,
  uoms,
  warehouseLocations,
  warehouses,
} from "./master";
import { approvals, users } from "./platform";

/**
 * Phase 3 Procurement, Goods Receiving (GRN), Weighing, Quality Inspection (QC),
 * Grading & Yield, and Landed Cost tables.
 */

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: text("id").primaryKey(),
    poNumber: text("po_number").notNull().unique(),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    status: text("status", {
      enum: [
        "draft",
        "submitted",
        "approved",
        "partially_received",
        "received",
        "closed",
        "cancelled",
      ],
    })
      .notNull()
      .default("draft"),
    orderDate: text("order_date").notNull(), // YYYY-MM-DD
    expectedDeliveryAt: timestamp("expected_delivery_at", { withTimezone: true }),
    originRegion: text("origin_region").notNull(),
    paymentTermsDays: integer("payment_terms_days").notNull().default(0),
    currency: text("currency").notNull().default("IDR"),
    subtotalAmount: numeric("subtotal_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    qtyTolerancePct: numeric("qty_tolerance_pct", { precision: 6, scale: 2 })
      .notNull()
      .default("5.00"),
    priceVarianceTolerancePct: numeric("price_variance_tolerance_pct", { precision: 6, scale: 2 })
      .notNull()
      .default("0.00"),
    notes: text("notes"),
    revisionNo: integer("revision_no").notNull().default(0),
    submittedBy: text("submitted_by").references(() => users.id, { onDelete: "set null" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("purchase_orders_supplier_idx").on(t.supplierId),
    index("purchase_orders_warehouse_status_idx").on(t.warehouseId, t.status),
  ],
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: text("id").primaryKey(),
    purchaseOrderId: text("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    expectedGradeCode: text("expected_grade_code").notNull().default("A"),
    orderedUomCode: text("ordered_uom_code")
      .notNull()
      .references(() => uoms.code, { onDelete: "restrict" }),
    orderedQty: numeric("ordered_qty", { precision: 14, scale: 3 }).notNull(),
    orderedQtyBase: numeric("ordered_qty_base", { precision: 14, scale: 3 }).notNull(),
    receivedNetQtyBase: numeric("received_net_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    acceptedQtyBase: numeric("accepted_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    rejectedQtyBase: numeric("rejected_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    unitPriceBase: numeric("unit_price_base", { precision: 18, scale: 4 }).notNull(),
    lineSubtotal: numeric("line_subtotal", { precision: 18, scale: 2 }).notNull(),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("purchase_order_lines_po_lineno_uidx").on(t.purchaseOrderId, t.lineNo),
    index("purchase_order_lines_product_idx").on(t.productId),
  ],
);

export const purchaseOrderRevisions = pgTable(
  "purchase_order_revisions",
  {
    id: text("id").primaryKey(),
    purchaseOrderId: text("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    revisionNo: integer("revision_no").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    reason: text("reason").notNull(),
    revisedBy: text("revised_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    revisedAt: timestamp("revised_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("purchase_order_revisions_po_rev_uidx").on(t.purchaseOrderId, t.revisionNo)],
);

export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: text("id").primaryKey(),
    grnNumber: text("grn_number").notNull().unique(),
    purchaseOrderId: text("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "restrict" }),
    supplierId: text("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    receivingLocationId: text("receiving_location_id")
      .notNull()
      .references(() => warehouseLocations.id, { onDelete: "restrict" }),
    putawayLocationId: text("putaway_location_id")
      .notNull()
      .references(() => warehouseLocations.id, { onDelete: "restrict" }),
    quarantineLocationId: text("quarantine_location_id").references(() => warehouseLocations.id, {
      onDelete: "restrict",
    }),
    supplierDeliveryNoteNo: text("supplier_delivery_note_no").notNull(),
    supplierLotRef: text("supplier_lot_ref"),
    vehiclePlateNo: text("vehicle_plate_no"),
    driverName: text("driver_name"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    harvestedAt: timestamp("harvested_at", { withTimezone: true }),
    arrivalTempC: numeric("arrival_temp_c", { precision: 5, scale: 1 }),
    status: text("status", {
      enum: ["draft", "inspecting", "graded", "pending_approval", "posted", "cancelled"],
    })
      .notNull()
      .default("draft"),
    notes: text("notes"),
    receivedBy: text("received_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    postedBy: text("posted_by").references(() => users.id, { onDelete: "restrict" }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("goods_receipts_po_idx").on(t.purchaseOrderId),
    index("goods_receipts_warehouse_status_idx").on(t.warehouseId, t.status),
  ],
);

export const goodsReceiptLines = pgTable(
  "goods_receipt_lines",
  {
    id: text("id").primaryKey(),
    goodsReceiptId: text("goods_receipt_id")
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    purchaseOrderLineId: text("purchase_order_line_id").references(() => purchaseOrderLines.id, {
      onDelete: "restrict",
    }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    isSubstitution: boolean("is_substitution").notNull().default(false),
    substitutionApprovalId: text("substitution_approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    overToleranceApprovalId: text("over_tolerance_approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    priceVarianceApprovalId: text("price_variance_approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    receivedUomCode: text("received_uom_code")
      .notNull()
      .references(() => uoms.code, { onDelete: "restrict" }),
    packageCount: integer("package_count").notNull().default(0),
    packagingTypeId: text("packaging_type_id").references(() => packagingTypes.id, {
      onDelete: "set null",
    }),
    grossWeightKg: numeric("gross_weight_kg", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    tareWeightKg: numeric("tare_weight_kg", { precision: 14, scale: 3 }).notNull().default("0.000"),
    netWeightKg: numeric("net_weight_kg", { precision: 14, scale: 3 }).notNull().default("0.000"),
    acceptedQtyBase: numeric("accepted_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    trimLossQtyBase: numeric("trim_loss_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    rejectedQtyBase: numeric("rejected_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    actualUnitCostBase: numeric("actual_unit_cost_base", { precision: 18, scale: 4 }).notNull(),
    billableQtyBase: numeric("billable_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    lineGoodsCost: numeric("line_goods_cost", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    allocatedLandedCost: numeric("allocated_landed_cost", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    totalLineCost: numeric("total_line_cost", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("goods_receipt_lines_grn_lineno_uidx").on(t.goodsReceiptId, t.lineNo),
    index("goods_receipt_lines_product_idx").on(t.productId),
  ],
);

export const weighings = pgTable(
  "weighings",
  {
    id: text("id").primaryKey(),
    goodsReceiptLineId: text("goods_receipt_line_id")
      .notNull()
      .references(() => goodsReceiptLines.id, { onDelete: "cascade" }),
    sequenceNo: integer("sequence_no").notNull().default(1),
    grossWeightKg: numeric("gross_weight_kg", { precision: 14, scale: 3 }).notNull(),
    packagingTypeId: text("packaging_type_id").references(() => packagingTypes.id, {
      onDelete: "set null",
    }),
    packageCount: integer("package_count").notNull().default(0),
    tareSource: text("tare_source", {
      enum: ["packaging_rule", "measured_actual"],
    })
      .notNull()
      .default("packaging_rule"),
    tareWeightKg: numeric("tare_weight_kg", { precision: 14, scale: 3 }).notNull(),
    netWeightKg: numeric("net_weight_kg", { precision: 14, scale: 3 }).notNull(),
    scaleTicketRef: text("scale_ticket_ref"),
    weighedBy: text("weighed_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    weighedAt: timestamp("weighed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("weighings_grn_line_idx").on(t.goodsReceiptLineId)],
);

export const qualityInspections = pgTable(
  "quality_inspections",
  {
    id: text("id").primaryKey(),
    goodsReceiptLineId: text("goods_receipt_line_id")
      .notNull()
      .references(() => goodsReceiptLines.id, { onDelete: "cascade" }),
    brixPct: numeric("brix_pct", { precision: 5, scale: 2 }),
    firmnessScore: integer("firmness_score"),
    ripenessStage: text("ripeness_stage", {
      enum: ["mentah", "mengkal", "matang_siap_jual", "terlalu_matang"],
    })
      .notNull()
      .default("mengkal"),
    temperatureC: numeric("temperature_c", { precision: 5, scale: 1 }),
    pestOrDiseaseFound: boolean("pest_or_disease_found").notNull().default(false),
    bruisingPct: numeric("bruising_pct", { precision: 5, scale: 2 }).notNull().default("0.00"),
    rotPct: numeric("rot_pct", { precision: 5, scale: 2 }).notNull().default("0.00"),
    outcome: text("outcome", {
      enum: ["accepted", "partially_accepted", "rejected"],
    }).notNull(),
    rejectionReasonCode: text("rejection_reason_code"),
    rejectionNotes: text("rejection_notes"),
    evidenceUrls: jsonb("evidence_urls"),
    inspectedBy: text("inspected_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    inspectedAt: timestamp("inspected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("quality_inspections_grn_line_idx").on(t.goodsReceiptLineId)],
);

export const gradingResults = pgTable(
  "grading_results",
  {
    id: text("id").primaryKey(),
    goodsReceiptLineId: text("goods_receipt_line_id")
      .notNull()
      .references(() => goodsReceiptLines.id, { onDelete: "cascade" }),
    lineType: text("line_type", {
      enum: ["accepted_grade", "trim_loss", "rejected"],
    }).notNull(),
    gradeId: text("grade_id").references(() => productGrades.id, { onDelete: "restrict" }),
    gradeCode: text("grade_code"),
    qtyBase: numeric("qty_base", { precision: 14, scale: 3 }).notNull(),
    packageCount: integer("package_count").notNull().default(0),
    rejectDisposition: text("reject_disposition", {
      enum: ["return_to_supplier", "dispose_on_site"],
    }),
    rejectReasonCode: text("reject_reason_code"),
    relativeValueMultiplierPct: numeric("relative_value_multiplier_pct", {
      precision: 6,
      scale: 2,
    }),
    allocatedCostTotal: numeric("allocated_cost_total", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    allocatedUnitCost: numeric("allocated_unit_cost", { precision: 18, scale: 4 })
      .notNull()
      .default("0.0000"),
    gradedBy: text("graded_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    gradedAt: timestamp("graded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("grading_results_grn_line_idx").on(t.goodsReceiptLineId)],
);

export const landedCosts = pgTable(
  "landed_costs",
  {
    id: text("id").primaryKey(),
    goodsReceiptId: text("goods_receipt_id")
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: "cascade" }),
    costType: text("cost_type", {
      enum: ["freight", "unloading", "ice_cooling", "packaging", "other"],
    }).notNull(),
    description: text("description").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("landed_costs_grn_idx").on(t.goodsReceiptId)],
);
