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
  customers,
  deliveryZones,
  productGrades,
  products,
  uoms,
  warehouses,
} from "./master";
import { approvals, users } from "./platform";

/**
 * Phase 4 Schema:
 * - Customer Contacts (`customer_contacts`)
 * - Price Lists, Items & Immutable History (`price_lists`, `price_list_items`, `price_list_history`)
 * - Sales Quotations & Lines (`sales_quotations`, `sales_quotation_lines`)
 * - Sales Orders & Lines (`sales_orders`, `sales_order_lines`)
 * - Customer Invoices, Payments/Deposits, and Credit Notes/Returns for Credit Control & CRM 360
 *   (`customer_invoices`, `customer_payments`, `customer_credit_notes`)
 */

export const customerContacts = pgTable(
  "customer_contacts",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    roleTitle: text("role_title").notNull(),
    phone: text("phone"),
    whatsapp: text("whatsapp"),
    email: text("email"),
    isPrimary: boolean("is_primary").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customer_contacts_customer_idx").on(t.customerId)],
);

export const priceLists = pgTable(
  "price_lists",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    priceTier: text("price_tier", {
      enum: ["grosir", "semi_grosir", "ritel", "horeca"],
    }).notNull(),
    customerSegment: text("customer_segment", {
      enum: [
        "toko_buah",
        "pedagang_pasar",
        "ritel_reseller",
        "horeca",
        "kedai_jus",
        "korporat",
        "konsumen_langsung",
      ],
    }),
    warehouseId: text("warehouse_id").references(() => warehouses.id, { onDelete: "restrict" }),
    currency: text("currency").notNull().default("IDR"),
    effectiveFrom: text("effective_from").notNull(), // YYYY-MM-DD
    effectiveTo: text("effective_to"), // YYYY-MM-DD nullable
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("price_lists_lookup_idx").on(
      t.priceTier,
      t.customerSegment,
      t.isActive,
      t.effectiveFrom,
    ),
  ],
);

export const priceListItems = pgTable(
  "price_list_items",
  {
    id: text("id").primaryKey(),
    priceListId: text("price_list_id")
      .notNull()
      .references(() => priceLists.id, { onDelete: "cascade" }),
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
    minQty: numeric("min_qty", { precision: 14, scale: 3 }).notNull().default("1.000"),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    unitPriceBase: numeric("unit_price_base", { precision: 18, scale: 4 }).notNull(),
    maxDiscountPct: numeric("max_discount_pct", { precision: 6, scale: 2 })
      .notNull()
      .default("0.00"),
    effectiveFrom: text("effective_from"),
    effectiveTo: text("effective_to"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("price_list_items_unique_tier_uidx").on(
      t.priceListId,
      t.productId,
      t.gradeId,
      t.uomCode,
      t.minQty,
    ),
    index("price_list_items_product_grade_idx").on(t.productId, t.gradeId, t.uomCode),
  ],
);

export const priceListHistory = pgTable(
  "price_list_history",
  {
    id: text("id").primaryKey(),
    priceListId: text("price_list_id")
      .notNull()
      .references(() => priceLists.id, { onDelete: "restrict" }),
    priceListItemId: text("price_list_item_id"),
    changeType: text("change_type", {
      enum: ["create_list", "update_list", "upsert_item", "deactivate"],
    }).notNull(),
    previousSnapshot: jsonb("previous_snapshot"),
    newSnapshot: jsonb("new_snapshot").notNull(),
    reason: text("reason").notNull(),
    changedBy: text("changed_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("price_list_history_list_idx").on(t.priceListId, t.changedAt)],
);

export const salesQuotations = pgTable(
  "sales_quotations",
  {
    id: text("id").primaryKey(),
    quotationNo: text("quotation_no").notNull().unique(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    quoteDate: text("quote_date").notNull(), // YYYY-MM-DD
    validUntil: text("valid_until").notNull(), // YYYY-MM-DD
    status: text("status", {
      enum: [
        "draft",
        "sent",
        "pending_approval",
        "approved",
        "rejected",
        "expired",
        "converted",
        "cancelled",
      ],
    })
      .notNull()
      .default("draft"),
    paymentTermsDays: integer("payment_terms_days").notNull().default(0),
    currency: text("currency").notNull().default("IDR"),
    subtotalAmount: numeric("subtotal_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    discountTotalAmount: numeric("discount_total_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    taxTotalAmount: numeric("tax_total_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    shippingFeeAmount: numeric("shipping_fee_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    handlingFeeAmount: numeric("handling_fee_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    grandTotalAmount: numeric("grand_total_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    requiresMarginApproval: boolean("requires_margin_approval").notNull().default(false),
    marginApprovalId: text("margin_approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    revisionNo: integer("revision_no").notNull().default(0),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sales_quotations_customer_idx").on(t.customerId),
    index("sales_quotations_warehouse_status_idx").on(t.warehouseId, t.status),
  ],
);

export const salesQuotationLines = pgTable(
  "sales_quotation_lines",
  {
    id: text("id").primaryKey(),
    salesQuotationId: text("sales_quotation_id")
      .notNull()
      .references(() => salesQuotations.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    gradeId: text("grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    gradeCode: text("grade_code").notNull(),
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
    priceListId: text("price_list_id").references(() => priceLists.id, { onDelete: "set null" }),
    priceListItemId: text("price_list_item_id").references(() => priceListItems.id, {
      onDelete: "set null",
    }),
    listUnitPrice: numeric("list_unit_price", { precision: 18, scale: 4 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    discountPct: numeric("discount_pct", { precision: 6, scale: 2 }).notNull().default("0.00"),
    discountAmountPerUnit: numeric("discount_amount_per_unit", {
      precision: 18,
      scale: 4,
    })
      .notNull()
      .default("0.0000"),
    netUnitPrice: numeric("net_unit_price", { precision: 18, scale: 4 }).notNull(),
    netUnitPriceBase: numeric("net_unit_price_base", { precision: 18, scale: 4 }).notNull(),
    unitCostBasisBase: numeric("unit_cost_basis_base", { precision: 18, scale: 4 }).notNull(),
    marginPct: numeric("margin_pct", { precision: 7, scale: 2 }).notNull(),
    minMarginPctSnapshot: numeric("min_margin_pct_snapshot", { precision: 6, scale: 2 }).notNull(),
    isBelowMinMargin: boolean("is_below_min_margin").notNull().default(false),
    taxCodeSnapshot: text("tax_code_snapshot").notNull(),
    taxRatePctSnapshot: numeric("tax_rate_pct_snapshot", { precision: 5, scale: 2 })
      .notNull()
      .default("0.00"),
    lineGrossAmount: numeric("line_gross_amount", { precision: 18, scale: 2 }).notNull(),
    lineDiscountAmount: numeric("line_discount_amount", { precision: 18, scale: 2 }).notNull(),
    lineNetAmount: numeric("line_net_amount", { precision: 18, scale: 2 }).notNull(),
    lineTaxAmount: numeric("line_tax_amount", { precision: 18, scale: 2 }).notNull(),
    lineTotalAmount: numeric("line_total_amount", { precision: 18, scale: 2 }).notNull(),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("sales_quotation_lines_sq_lineno_uidx").on(t.salesQuotationId, t.lineNo),
  ],
);

export const salesOrders = pgTable(
  "sales_orders",
  {
    id: text("id").primaryKey(),
    soNumber: text("so_number").notNull().unique(),
    quotationId: text("quotation_id").references(() => salesQuotations.id, {
      onDelete: "set null",
    }),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    deliveryZoneId: text("delivery_zone_id").references(() => deliveryZones.id, {
      onDelete: "set null",
    }),
    orderDate: text("order_date").notNull(), // YYYY-MM-DD
    requestedDeliveryDate: text("requested_delivery_date"),
    status: text("status", {
      enum: [
        "draft",
        "submitted",
        "pending_approval",
        "confirmed",
        "picking",
        "packed",
        "shipped",
        "delivered",
        "invoiced",
        "rejected",
        "cancelled",
      ],
    })
      .notNull()
      .default("draft"),
    paymentTermsDays: integer("payment_terms_days").notNull().default(0),
    isCreditOrder: boolean("is_credit_order").notNull().default(false),
    shippingAddressSnapshot: text("shipping_address_snapshot").notNull(),
    customerSegmentSnapshot: text("customer_segment_snapshot").notNull(),
    priceTierSnapshot: text("price_tier_snapshot").notNull(),
    currency: text("currency").notNull().default("IDR"),
    subtotalAmount: numeric("subtotal_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    discountTotalAmount: numeric("discount_total_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    taxTotalAmount: numeric("tax_total_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    shippingFeeAmount: numeric("shipping_fee_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    handlingFeeAmount: numeric("handling_fee_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    grandTotalAmount: numeric("grand_total_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    requiresMarginApproval: boolean("requires_margin_approval").notNull().default(false),
    marginApprovalId: text("margin_approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    requiresCreditApproval: boolean("requires_credit_approval").notNull().default(false),
    creditApprovalId: text("credit_approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    reserveStockOnConfirm: boolean("reserve_stock_on_confirm").notNull().default(true),
    isStockReserved: boolean("is_stock_reserved").notNull().default(false),
    isInvoiced: boolean("is_invoiced").notNull().default(false),
    minRemainingShelfLifeDays: integer("min_remaining_shelf_life_days").notNull().default(1),
    notes: text("notes"),
    cancelReason: text("cancel_reason"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    confirmedBy: text("confirmed_by").references(() => users.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sales_orders_customer_status_idx").on(t.customerId, t.status),
    index("sales_orders_warehouse_status_idx").on(t.warehouseId, t.status),
  ],
);

export const salesOrderLines = pgTable(
  "sales_order_lines",
  {
    id: text("id").primaryKey(),
    salesOrderId: text("sales_order_id")
      .notNull()
      .references(() => salesOrders.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    gradeId: text("grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    gradeCode: text("grade_code").notNull(),
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
    reservedQtyBase: numeric("reserved_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    fulfilledQtyBase: numeric("fulfilled_qty_base", { precision: 14, scale: 3 })
      .notNull()
      .default("0.000"),
    priceListId: text("price_list_id").references(() => priceLists.id, { onDelete: "set null" }),
    priceListItemId: text("price_list_item_id").references(() => priceListItems.id, {
      onDelete: "set null",
    }),
    listUnitPrice: numeric("list_unit_price", { precision: 18, scale: 4 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    discountPct: numeric("discount_pct", { precision: 6, scale: 2 }).notNull().default("0.00"),
    discountAmountPerUnit: numeric("discount_amount_per_unit", {
      precision: 18,
      scale: 4,
    })
      .notNull()
      .default("0.0000"),
    netUnitPrice: numeric("net_unit_price", { precision: 18, scale: 4 }).notNull(),
    netUnitPriceBase: numeric("net_unit_price_base", { precision: 18, scale: 4 }).notNull(),
    unitCostBasisBase: numeric("unit_cost_basis_base", { precision: 18, scale: 4 }).notNull(),
    marginPct: numeric("margin_pct", { precision: 7, scale: 2 }).notNull(),
    minMarginPctSnapshot: numeric("min_margin_pct_snapshot", { precision: 6, scale: 2 }).notNull(),
    isBelowMinMargin: boolean("is_below_min_margin").notNull().default(false),
    taxCodeSnapshot: text("tax_code_snapshot").notNull(),
    taxRatePctSnapshot: numeric("tax_rate_pct_snapshot", { precision: 5, scale: 2 })
      .notNull()
      .default("0.00"),
    lineGrossAmount: numeric("line_gross_amount", { precision: 18, scale: 2 }).notNull(),
    lineDiscountAmount: numeric("line_discount_amount", { precision: 18, scale: 2 }).notNull(),
    lineNetAmount: numeric("line_net_amount", { precision: 18, scale: 2 }).notNull(),
    lineTaxAmount: numeric("line_tax_amount", { precision: 18, scale: 2 }).notNull(),
    lineTotalAmount: numeric("line_total_amount", { precision: 18, scale: 2 }).notNull(),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("sales_order_lines_so_lineno_uidx").on(t.salesOrderId, t.lineNo),
    index("sales_order_lines_product_idx").on(t.productId, t.gradeId),
  ],
);

export const customerInvoices = pgTable(
  "customer_invoices",
  {
    id: text("id").primaryKey(),
    invoiceNo: text("invoice_no").notNull().unique(),
    salesOrderId: text("sales_order_id").references(() => salesOrders.id, {
      onDelete: "restrict",
    }),
    deliveryOrderId: text("delivery_order_id"),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    invoiceDate: text("invoice_date").notNull(), // YYYY-MM-DD
    dueDate: text("due_date").notNull(), // YYYY-MM-DD
    status: text("status", {
      enum: ["draft", "posted", "partially_paid", "paid", "overdue", "cancelled"],
    })
      .notNull()
      .default("posted"),
    subtotalAmount: numeric("subtotal_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    discountAmount: numeric("discount_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 2 }).notNull(),
    paidAmount: numeric("paid_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    creditNoteAppliedAmount: numeric("credit_note_applied_amount", {
      precision: 18,
      scale: 2,
    })
      .notNull()
      .default("0.00"),
    outstandingAmount: numeric("outstanding_amount", { precision: 18, scale: 2 }).notNull(),
    glJournalId: text("gl_journal_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: text("posted_by").references(() => users.id, { onDelete: "set null" }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => users.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),
    notes: text("notes"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customer_invoices_customer_status_idx").on(t.customerId, t.status)],
);

export const customerPayments = pgTable(
  "customer_payments",
  {
    id: text("id").primaryKey(),
    paymentNo: text("payment_no").notNull().unique(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    invoiceId: text("invoice_id").references(() => customerInvoices.id, { onDelete: "restrict" }),
    bankAccountId: text("bank_account_id"),
    paymentType: text("payment_type", {
      enum: ["deposit", "invoice_payment"],
    }).notNull(),
    paymentMethod: text("payment_method", {
      enum: ["cash", "bank_transfer", "qris", "giro"],
    }).notNull(),
    paymentDate: text("payment_date").notNull(), // YYYY-MM-DD
    status: text("status", {
      enum: ["draft", "posted", "reversed"],
    })
      .notNull()
      .default("posted"),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    appliedAmount: numeric("applied_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    unappliedAmount: numeric("unapplied_amount", { precision: 18, scale: 2 }).notNull(),
    verificationStatus: text("verification_status", {
      enum: ["pending_verification", "verified", "rejected"],
    })
      .notNull()
      .default("pending_verification"),
    verifiedBy: text("verified_by").references(() => users.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    glJournalId: text("gl_journal_id"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: text("reversed_by").references(() => users.id, { onDelete: "set null" }),
    reversalReason: text("reversal_reason"),
    reversalGlJournalId: text("reversal_gl_journal_id"),
    referenceNo: text("reference_no"),
    notes: text("notes"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("customer_payments_customer_verif_idx").on(t.customerId, t.verificationStatus),
  ],
);

export const customerCreditNotes = pgTable(
  "customer_credit_notes",
  {
    id: text("id").primaryKey(),
    creditNoteNo: text("credit_note_no").notNull().unique(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    invoiceId: text("invoice_id").references(() => customerInvoices.id, { onDelete: "restrict" }),
    deliveryClaimId: text("delivery_claim_id"),
    appliedToInvoiceId: text("applied_to_invoice_id"),
    sourceType: text("source_type", {
      enum: ["sales_return", "quality_claim", "price_adjustment"],
    }).notNull(),
    issueDate: text("issue_date").notNull(), // YYYY-MM-DD
    status: text("status", {
      enum: ["draft", "approved", "applied", "cancelled"],
    })
      .notNull()
      .default("draft"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 2 }).notNull(),
    appliedAmount: numeric("applied_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    unappliedAmount: numeric("unapplied_amount", { precision: 18, scale: 2 }).notNull(),
    reason: text("reason").notNull(),
    glJournalId: text("gl_journal_id"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customer_credit_notes_customer_status_idx").on(t.customerId, t.status)],
);
