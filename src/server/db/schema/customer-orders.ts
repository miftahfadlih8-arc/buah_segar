import {
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
  productGrades,
  products,
  uoms,
  warehouses,
} from "./master";
import { users } from "./platform";
import { salesOrders } from "./sales";

/**
 * Phase 8 — Customer QR Order Portal & Request Management Schema
 *
 * Provides:
 * 1. Customer order draft/sessions for resilient mobile ordering (no reset on payment/refresh)
 * 2. Customer order requests and request lines with strict server-side price recalculation
 * 3. Customer order events history for auditability
 */

export const customerOrderSessions = pgTable(
  "customer_order_sessions",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    sessionToken: text("session_token").notNull().unique(),
    cartItems: jsonb("cart_items").notNull().default([]),
    status: text("status", { enum: ["active", "submitted", "expired"] })
      .notNull()
      .default("active"),
    paymentProofRef: text("payment_proof_ref"),
    paymentProofOriginalName: text("payment_proof_original_name"),
    paymentProofMime: text("payment_proof_mime"),
    paymentProofSize: integer("payment_proof_size"),
    paymentProofUploadedAt: timestamp("payment_proof_uploaded_at", { withTimezone: true }),
    customerNotes: text("customer_notes"),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cust_order_sessions_customer_idx").on(t.customerId),
    index("cust_order_sessions_token_idx").on(t.sessionToken),
    index("cust_order_sessions_status_exp_idx").on(t.status, t.expiresAt),
  ],
);

export const customerOrderRequests = pgTable(
  "customer_order_requests",
  {
    id: text("id").primaryKey(),
    orderNumber: text("order_number").notNull().unique(),
    orderSessionId: text("order_session_id").references(() => customerOrderSessions.id, {
      onDelete: "set null",
    }),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    customerStoreCodeSnapshot: text("customer_store_code_snapshot").notNull(),
    customerStoreNameSnapshot: text("customer_store_name_snapshot").notNull(),
    shippingAddressSnapshot: text("shipping_address_snapshot").notNull(),
    totalItems: integer("total_items").notNull(),
    subtotalAmount: numeric("subtotal_amount", { precision: 18, scale: 2 }).notNull(),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    totalAmount: numeric("total_amount", { precision: 18, scale: 2 }).notNull(),
    paymentMethod: text("payment_method").notNull().default("qris_statis"),
    paymentProofRef: text("payment_proof_ref").notNull(),
    paymentProofOriginalName: text("payment_proof_original_name"),
    paymentProofMime: text("payment_proof_mime").notNull(),
    paymentProofSize: integer("payment_proof_size").notNull(),
    paymentProofUploadedAt: timestamp("payment_proof_uploaded_at", { withTimezone: true }).notNull(),
    orderStatus: text("order_status", {
      enum: ["pending_review", "confirmed", "rejected", "cancelled"],
    })
      .notNull()
      .default("pending_review"),
    paymentStatus: text("payment_status", {
      enum: ["pending_verification", "verified", "rejected"],
    })
      .notNull()
      .default("pending_verification"),
    statusToken: text("status_token").notNull().unique(),
    rejectionReason: text("rejection_reason"),
    reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "restrict" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    salesOrderId: text("sales_order_id").references(() => salesOrders.id, {
      onDelete: "set null",
    }),
    paymentVerifiedBy: text("payment_verified_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    paymentVerifiedAt: timestamp("payment_verified_at", { withTimezone: true }),
    paymentReceiptId: text("payment_receipt_id"),
    customerNotes: text("customer_notes"),
    idempotencyKey: text("idempotency_key").unique(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cust_order_req_customer_idx").on(t.customerId),
    index("cust_order_req_status_idx").on(t.orderStatus, t.paymentStatus),
    index("cust_order_req_order_no_idx").on(t.orderNumber),
    index("cust_order_req_status_token_idx").on(t.statusToken),
    index("cust_order_req_created_idx").on(t.createdAt),
  ],
);

export const customerOrderRequestLines = pgTable(
  "customer_order_request_lines",
  {
    id: text("id").primaryKey(),
    orderRequestId: text("order_request_id")
      .notNull()
      .references(() => customerOrderRequests.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    productNameSnapshot: text("product_name_snapshot").notNull(),
    gradeId: text("grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    gradeCodeSnapshot: text("grade_code_snapshot").notNull(),
    uomCode: text("uom_code")
      .notNull()
      .references(() => uoms.code, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    subtotal: numeric("subtotal", { precision: 18, scale: 2 }).notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cust_order_req_lines_order_lineno_uidx").on(t.orderRequestId, t.lineNo),
    index("cust_order_req_lines_product_idx").on(t.productId),
  ],
);

export const customerOrderRequestEvents = pgTable(
  "customer_order_request_events",
  {
    id: text("id").primaryKey(),
    orderRequestId: text("order_request_id")
      .notNull()
      .references(() => customerOrderRequests.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorId: text("actor_id"),
    actorRole: text("actor_role"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cust_order_req_events_order_idx").on(t.orderRequestId),
    index("cust_order_req_events_type_idx").on(t.eventType),
  ],
);
