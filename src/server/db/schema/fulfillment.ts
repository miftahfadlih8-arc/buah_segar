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
import { journalEntries } from "./gl";
import { batches, inventoryMovements, stockReservations } from "./inventory";
import {
  customers,
  deliveryZones,
  productGrades,
  products,
  uoms,
  warehouseLocations,
  warehouses,
} from "./master";
import { approvals, users } from "./platform";
import {
  customerCreditNotes,
  customerInvoices,
  salesOrderLines,
  salesOrders,
} from "./sales";

/**
 * Phase 5 Schema:
 * - Warehouse Fulfillment (`sales_fulfillments`, `sales_fulfillment_lines`, `fulfillment_pick_allocations`)
 * - Picking & Packing Exceptions (`fulfillment_exceptions`)
 * - Delivery Orders / Surat Jalan (`delivery_orders`, `delivery_order_lines`)
 * - Proof of Delivery / POD (`proof_of_deliveries`, `proof_of_delivery_lines`)
 * - Actionable Delivery Claims / Discrepancies (`delivery_claims`)
 */

export const salesFulfillments = pgTable(
  "sales_fulfillments",
  {
    id: text("id").primaryKey(),
    fulfillmentNo: text("fulfillment_no").notNull().unique(),
    salesOrderId: text("sales_order_id")
      .notNull()
      .references(() => salesOrders.id, { onDelete: "restrict" }),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    fulfillmentDate: text("fulfillment_date").notNull(), // YYYY-MM-DD
    status: text("status", {
      enum: [
        "draft",
        "picking",
        "exception_hold",
        "picked",
        "packed",
        "dispatched",
        "delivered",
        "partially_delivered",
        "failed",
        "returned",
        "cancelled",
      ],
    })
      .notNull()
      .default("draft"),
    isPartialFulfillment: boolean("is_partial_fulfillment").notNull().default(false),
    qtyTolerancePct: numeric("qty_tolerance_pct", { precision: 6, scale: 2 })
      .notNull()
      .default("5.00"),
    packingChecklist: jsonb("packing_checklist"),
    totalOrderedQtyBase: numeric("total_ordered_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    totalPickedQtyBase: numeric("total_picked_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    totalPackedQtyBase: numeric("total_packed_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    totalRemainingQtyBase: numeric("total_remaining_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    totalCogsAmount: numeric("total_cogs_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    journalEntryId: text("journal_entry_id").references(() => journalEntries.id, {
      onDelete: "restrict",
    }),
    pickedBy: text("picked_by").references(() => users.id, { onDelete: "set null" }),
    pickedAt: timestamp("picked_at", { withTimezone: true }),
    packedBy: text("packed_by").references(() => users.id, { onDelete: "set null" }),
    packedAt: timestamp("packed_at", { withTimezone: true }),
    notes: text("notes"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sales_fulfillments_so_idx").on(t.salesOrderId),
    index("sales_fulfillments_warehouse_status_idx").on(t.warehouseId, t.status),
  ],
);

export const salesFulfillmentLines = pgTable(
  "sales_fulfillment_lines",
  {
    id: text("id").primaryKey(),
    fulfillmentId: text("fulfillment_id")
      .notNull()
      .references(() => salesFulfillments.id, { onDelete: "cascade" }),
    salesOrderLineId: text("sales_order_line_id")
      .notNull()
      .references(() => salesOrderLines.id, { onDelete: "restrict" }),
    lineNo: integer("line_no").notNull(),
    orderedProductId: text("ordered_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    orderedGradeId: text("ordered_grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    orderedGradeCode: text("ordered_grade_code").notNull(),
    actualProductId: text("actual_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    actualGradeId: text("actual_grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    actualGradeCode: text("actual_grade_code").notNull(),
    isSubstitution: boolean("is_substitution").notNull().default(false),
    substitutionApprovalId: text("substitution_approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    varianceApprovalId: text("variance_approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    orderedUomCode: text("ordered_uom_code")
      .notNull()
      .references(() => uoms.code, { onDelete: "restrict" }),
    orderedQty: numeric("ordered_qty", { precision: 14, scale: 3 }).notNull(),
    uomFactorToBaseSnapshot: numeric("uom_factor_to_base_snapshot", {
      precision: 14,
      scale: 4,
    })
      .notNull()
      .default("1.0000"),
    orderedQtyBase: numeric("ordered_qty_base", { precision: 14, scale: 3 }).notNull(),
    previouslyFulfilledQtyBase: numeric("previously_fulfilled_qty_base", {
      precision: 14,
      scale: 3,
    })
      .notNull()
      .default("0.000"),
    targetPickQtyBase: numeric("target_pick_qty_base", { precision: 14, scale: 3 }).notNull(),
    pickedUomCode: text("picked_uom_code")
      .notNull()
      .references(() => uoms.code, { onDelete: "restrict" }),
    pickedQty: numeric("picked_qty", { precision: 14, scale: 3 }).notNull().default("0.000"),
    grossWeightKg: numeric("gross_weight_kg", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    tareWeightKg: numeric("tare_weight_kg", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    netWeightKg: numeric("net_weight_kg", { precision: 14, scale: 3 }).notNull().default("0.000"),
    pickedQtyBase: numeric("picked_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    packedQtyBase: numeric("packed_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    remainingBackorderQtyBase: numeric("remaining_backorder_qty_base", {
      precision: 14,
      scale: 3,
    })
      .notNull()
      .default("0.000"),
    varianceQtyBase: numeric("variance_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    variancePct: numeric("variance_pct", { precision: 7, scale: 2 }).notNull().default("0.00"),
    netUnitPriceSnapshot: numeric("net_unit_price_snapshot", {
      precision: 18,
      scale: 4,
    }).notNull(),
    netUnitPriceBaseSnapshot: numeric("net_unit_price_base_snapshot", {
      precision: 18,
      scale: 4,
    }).notNull(),
    lineCogsAmount: numeric("line_cogs_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    backorderStatus: text("backorder_status", {
      enum: ["none", "open_backorder", "fulfilled", "cancelled"],
    })
      .notNull()
      .default("none"),
    isStockIssued: boolean("is_stock_issued").notNull().default(false),
    scannedBarcode: text("scanned_barcode"),
    pickedBy: text("picked_by").references(() => users.id, { onDelete: "set null" }),
    pickedAt: timestamp("picked_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("sales_fulfillment_lines_ful_lineno_uidx").on(t.fulfillmentId, t.lineNo),
    index("sales_fulfillment_lines_sol_idx").on(t.salesOrderLineId),
  ],
);

export const fulfillmentPickAllocations = pgTable(
  "fulfillment_pick_allocations",
  {
    id: text("id").primaryKey(),
    fulfillmentId: text("fulfillment_id")
      .notNull()
      .references(() => salesFulfillments.id, { onDelete: "cascade" }),
    fulfillmentLineId: text("fulfillment_line_id")
      .notNull()
      .references(() => salesFulfillmentLines.id, { onDelete: "cascade" }),
    reservationId: text("reservation_id").references(() => stockReservations.id, {
      onDelete: "set null",
    }),
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
    sourceStockStatus: text("source_stock_status", {
      enum: ["reserved", "available"],
    }).notNull(),
    pickedQtyBase: numeric("picked_qty_base", { precision: 14, scale: 3 }).notNull(),
    unitCostBase: numeric("unit_cost_base", { precision: 18, scale: 4 }).notNull(),
    costOutflow: numeric("cost_outflow", { precision: 18, scale: 2 }).notNull(),
    movementId: text("movement_id")
      .notNull()
      .references(() => inventoryMovements.id, { onDelete: "restrict" }),
    scannedBarcode: text("scanned_barcode"),
    pickedBy: text("picked_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    pickedAt: timestamp("picked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("fulfillment_pick_allocations_line_idx").on(t.fulfillmentLineId),
    index("fulfillment_pick_allocations_batch_idx").on(t.batchId),
  ],
);

export const fulfillmentExceptions = pgTable(
  "fulfillment_exceptions",
  {
    id: text("id").primaryKey(),
    fulfillmentId: text("fulfillment_id")
      .notNull()
      .references(() => salesFulfillments.id, { onDelete: "cascade" }),
    fulfillmentLineId: text("fulfillment_line_id").references(() => salesFulfillmentLines.id, {
      onDelete: "cascade",
    }),
    exceptionType: text("exception_type", {
      enum: [
        "weight_variance",
        "damaged_goods",
        "batch_unavailable",
        "substitution",
        "price_variance",
      ],
    }).notNull(),
    severity: text("severity", {
      enum: ["warning", "blocking"],
    })
      .notNull()
      .default("blocking"),
    status: text("status", {
      enum: ["open", "approved", "resolved", "rejected"],
    })
      .notNull()
      .default("open"),
    approvalId: text("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    reasonCode: text("reason_code").notNull(),
    description: text("description").notNull(),
    resolutionNotes: text("resolution_notes"),
    reportedBy: text("reported_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    resolvedBy: text("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("fulfillment_exceptions_ful_status_idx").on(t.fulfillmentId, t.status)],
);

export const deliveryOrders = pgTable(
  "delivery_orders",
  {
    id: text("id").primaryKey(),
    doNumber: text("do_number").notNull().unique(),
    fulfillmentId: text("fulfillment_id")
      .notNull()
      .references(() => salesFulfillments.id, { onDelete: "restrict" }),
    salesOrderId: text("sales_order_id")
      .notNull()
      .references(() => salesOrders.id, { onDelete: "restrict" }),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    deliveryZoneId: text("delivery_zone_id").references(() => deliveryZones.id, {
      onDelete: "set null",
    }),
    driverUserId: text("driver_user_id").references(() => users.id, { onDelete: "set null" }),
    driverName: text("driver_name"),
    vehiclePlateNo: text("vehicle_plate_no"),
    vehicleType: text("vehicle_type"),
    shippingAddressSnapshot: text("shipping_address_snapshot").notNull(),
    deliveryDate: text("delivery_date").notNull(), // YYYY-MM-DD
    status: text("status", {
      enum: [
        "draft",
        "ready",
        "dispatched",
        "in_transit",
        "delivered",
        "partially_delivered",
        "failed",
        "returned",
        "cancelled",
      ],
    })
      .notNull()
      .default("draft"),
    dispatchedBy: text("dispatched_by").references(() => users.id, { onDelete: "set null" }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    inTransitAt: timestamp("in_transit_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    notes: text("notes"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("delivery_orders_so_idx").on(t.salesOrderId),
    index("delivery_orders_fulfillment_idx").on(t.fulfillmentId),
    index("delivery_orders_warehouse_status_idx").on(t.warehouseId, t.status),
  ],
);

export const deliveryOrderLines = pgTable(
  "delivery_order_lines",
  {
    id: text("id").primaryKey(),
    deliveryOrderId: text("delivery_order_id")
      .notNull()
      .references(() => deliveryOrders.id, { onDelete: "cascade" }),
    fulfillmentLineId: text("fulfillment_line_id")
      .notNull()
      .references(() => salesFulfillmentLines.id, { onDelete: "restrict" }),
    salesOrderLineId: text("sales_order_line_id")
      .notNull()
      .references(() => salesOrderLines.id, { onDelete: "restrict" }),
    lineNo: integer("line_no").notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    gradeId: text("grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    gradeCode: text("grade_code").notNull(),
    uomCode: text("uom_code")
      .notNull()
      .references(() => uoms.code, { onDelete: "restrict" }),
    shippedQty: numeric("shipped_qty", { precision: 14, scale: 3 }).notNull(),
    shippedQtyBase: numeric("shipped_qty_base", { precision: 14, scale: 3 }).notNull(),
    deliveredQtyBase: numeric("delivered_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    shortageQtyBase: numeric("shortage_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    damagedQtyBase: numeric("damaged_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    refusedQtyBase: numeric("refused_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    netUnitPriceBaseSnapshot: numeric("net_unit_price_base_snapshot", {
      precision: 18,
      scale: 4,
    }).notNull(),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("delivery_order_lines_do_lineno_uidx").on(t.deliveryOrderId, t.lineNo),
  ],
);

export const proofOfDeliveries = pgTable(
  "proof_of_deliveries",
  {
    id: text("id").primaryKey(),
    podNumber: text("pod_number").notNull().unique(),
    deliveryOrderId: text("delivery_order_id")
      .notNull()
      .unique()
      .references(() => deliveryOrders.id, { onDelete: "restrict" }),
    salesOrderId: text("sales_order_id")
      .notNull()
      .references(() => salesOrders.id, { onDelete: "restrict" }),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    recipientName: text("recipient_name").notNull(),
    recipientRoleOrId: text("recipient_role_or_id").notNull(),
    recipientPhone: text("recipient_phone"),
    handoverAt: timestamp("handover_at", { withTimezone: true }).notNull().defaultNow(),
    outcomeStatus: text("outcome_status", {
      enum: ["delivered", "partially_delivered", "refused", "failed", "returned"],
    }).notNull(),
    totalShippedQtyBase: numeric("total_shipped_qty_base", {
      precision: 14,
      scale: 3,
    }).notNull(),
    totalDeliveredQtyBase: numeric("total_delivered_qty_base", {
      precision: 14,
      scale: 3,
    }).notNull(),
    totalDiscrepancyQtyBase: numeric("total_discrepancy_qty_base", {
      precision: 14,
      scale: 3,
    })
      .notNull()
      .default("0.000"),
    deliveryNotes: text("delivery_notes"),
    recordedBy: text("recorded_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("proof_of_deliveries_so_idx").on(t.salesOrderId),
    index("proof_of_deliveries_warehouse_idx").on(t.warehouseId, t.outcomeStatus),
  ],
);

export const proofOfDeliveryLines = pgTable(
  "proof_of_delivery_lines",
  {
    id: text("id").primaryKey(),
    podId: text("pod_id")
      .notNull()
      .references(() => proofOfDeliveries.id, { onDelete: "cascade" }),
    deliveryOrderLineId: text("delivery_order_line_id")
      .notNull()
      .references(() => deliveryOrderLines.id, { onDelete: "restrict" }),
    lineNo: integer("line_no").notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    gradeId: text("grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    shippedQtyBase: numeric("shipped_qty_base", { precision: 14, scale: 3 }).notNull(),
    deliveredQtyBase: numeric("delivered_qty_base", { precision: 14, scale: 3 }).notNull(),
    shortageQtyBase: numeric("shortage_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    damagedQtyBase: numeric("damaged_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    refusedQtyBase: numeric("refused_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    discrepancyReasonCode: text("discrepancy_reason_code"),
    discrepancyNotes: text("discrepancy_notes"),
  },
  (t) => [uniqueIndex("proof_of_delivery_lines_pod_lineno_uidx").on(t.podId, t.lineNo)],
);

export const deliveryClaims = pgTable(
  "delivery_claims",
  {
    id: text("id").primaryKey(),
    claimNo: text("claim_no").notNull().unique(),
    podId: text("pod_id").references(() => proofOfDeliveries.id, { onDelete: "restrict" }),
    deliveryOrderId: text("delivery_order_id").references(() => deliveryOrders.id, { onDelete: "restrict" }),
    salesOrderId: text("sales_order_id")
      .notNull()
      .references(() => salesOrders.id, { onDelete: "restrict" }),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    claimType: text("claim_type", {
      enum: [
        "shortage",
        "damaged_in_transit",
        "refused_by_customer",
        "failed_delivery",
        "mixed_discrepancy",
        "quality_claim",
        "sales_return",
        "price_adjustment",
      ],
    }).notNull(),
    status: text("status", {
      enum: [
        "draft",
        "submitted",
        "open",
        "under_review",
        "investigating",
        "approved",
        "rejected",
        "resolved",
        "closed",
        "cancelled",
      ],
    })
      .notNull()
      .default("open"),
    discrepancyQtyBase: numeric("discrepancy_qty_base", { precision: 14, scale: 3 }).notNull(),
    estimatedClaimValue: numeric("estimated_claim_value", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    reasonCode: text("reason_code").notNull(),
    notes: text("notes").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

    // Phase 7 Extended Fields:
    invoiceId: text("invoice_id").references(() => customerInvoices.id, { onDelete: "restrict" }),
    batchId: text("batch_id").references(() => batches.id, { onDelete: "restrict" }),
    locationId: text("location_id").references(() => warehouseLocations.id, { onDelete: "restrict" }),
    productId: text("product_id").references(() => products.id, { onDelete: "restrict" }),
    gradeId: text("grade_id").references(() => productGrades.id, { onDelete: "restrict" }),
    claimedQtyBase: numeric("claimed_qty_base", { precision: 14, scale: 3 }),
    approvedQtyBase: numeric("approved_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    approvedClaimValue: numeric("approved_claim_value", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    evidenceRef: text("evidence_ref"),
    submittedBy: text("submitted_by").references(() => users.id, { onDelete: "set null" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    requiresPhysicalReturn: boolean("requires_physical_return").notNull().default(false),
    qcStatus: text("qc_status", {
      enum: ["not_required", "pending_qc", "qc_passed", "qc_failed"],
    })
      .notNull()
      .default("not_required"),
    qcInspectedBy: text("qc_inspected_by").references(() => users.id, { onDelete: "set null" }),
    qcInspectedAt: timestamp("qc_inspected_at", { withTimezone: true }),
    qcNotes: text("qc_notes"),
    restockMovementId: text("restock_movement_id").references(() => inventoryMovements.id, {
      onDelete: "set null",
    }),
    cogsReversalJournalId: text("cogs_reversal_journal_id").references(() => journalEntries.id, {
      onDelete: "set null",
    }),
    creditNoteId: text("credit_note_id").references(() => customerCreditNotes.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key"),
  },
  (t) => [
    index("delivery_claims_so_idx").on(t.salesOrderId),
    index("delivery_claims_warehouse_status_idx").on(t.warehouseId, t.status),
    index("delivery_claims_invoice_idx").on(t.invoiceId),
    uniqueIndex("delivery_claims_idempotency_uidx").on(t.idempotencyKey),
  ],
);
