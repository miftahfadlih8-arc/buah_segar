import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { glAccounts } from "./gl";
import { productGrades, products, warehouses } from "./master";
import { users } from "./platform";
import {
  customerCreditNotes,
  customerInvoices,
  customerPayments,
  salesOrderLines,
} from "./sales";

/**
 * Phase 6 Schema:
 * - Sales Invoice Line Items (`customer_invoice_lines` / `sales_invoice_lines`)
 * - Payment Allocations (`payment_allocations`)
 * - Bank Accounts & Operational Cash (`bank_accounts`)
 * - Bank Statement Transactions & Settlement (`bank_transactions`)
 * - Credit Note Lines (`customer_credit_note_lines`)
 */

export const customerInvoiceLines = pgTable(
  "customer_invoice_lines",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => customerInvoices.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    salesOrderLineId: text("sales_order_line_id").references(() => salesOrderLines.id, {
      onDelete: "set null",
    }),
    deliveryOrderLineId: text("delivery_order_line_id"),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    productNameSnapshot: text("product_name_snapshot").notNull(),
    gradeId: text("grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    gradeCodeSnapshot: text("grade_code_snapshot").notNull(),
    uomCode: text("uom_code").notNull(),
    invoicedQty: numeric("invoiced_qty", { precision: 14, scale: 3 }).notNull(),
    invoicedQtyBase: numeric("invoiced_qty_base", { precision: 14, scale: 3 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    discountAmount: numeric("discount_amount", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    taxRatePct: numeric("tax_rate_pct", { precision: 5, scale: 2 }).notNull().default("0.00"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0.00"),
    lineNetAmount: numeric("line_net_amount", { precision: 18, scale: 2 }).notNull(),
    lineTotalAmount: numeric("line_total_amount", { precision: 18, scale: 2 }).notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("customer_invoice_lines_inv_lineno_uidx").on(t.invoiceId, t.lineNo),
    index("customer_invoice_lines_invoice_idx").on(t.invoiceId),
    index("customer_invoice_lines_product_idx").on(t.productId, t.gradeId),
  ],
);

export const salesInvoiceLines = customerInvoiceLines;

export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: text("id").primaryKey(),
    paymentId: text("payment_id")
      .notNull()
      .references(() => customerPayments.id, { onDelete: "restrict" }),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => customerInvoices.id, { onDelete: "restrict" }),
    allocatedAmount: numeric("allocated_amount", { precision: 18, scale: 2 }).notNull(),
    status: text("status", {
      enum: ["active", "reversed"],
    })
      .notNull()
      .default("active"),
    reversalReason: text("reversal_reason"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: text("reversed_by").references(() => users.id, { onDelete: "set null" }),
    reversalGlJournalId: text("reversal_gl_journal_id"),
    allocatedAt: timestamp("allocated_at", { withTimezone: true }).notNull().defaultNow(),
    allocatedBy: text("allocated_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    notes: text("notes"),
  },
  (t) => [
    index("payment_allocations_payment_idx").on(t.paymentId),
    index("payment_allocations_invoice_idx").on(t.invoiceId),
  ],
);

export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    accountType: text("account_type", {
      enum: ["bank", "cash", "ewallet"],
    }).notNull(),
    bankName: text("bank_name"),
    accountNumber: text("account_number"),
    holderName: text("holder_name"),
    glAccountId: text("gl_account_id")
      .notNull()
      .references(() => glAccounts.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),
    currency: text("currency").notNull().default("IDR"),
    currentBalance: numeric("current_balance", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("bank_accounts_type_idx").on(t.accountType)],
);

export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: text("id").primaryKey(),
    bankAccountId: text("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "restrict" }),
    transactionDate: text("transaction_date").notNull(), // YYYY-MM-DD
    valueDate: text("value_date"), // YYYY-MM-DD
    referenceNo: text("reference_no"),
    description: text("description").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    direction: text("direction", {
      enum: ["in", "out"],
    }).notNull(),
    matchedPaymentId: text("matched_payment_id")
      .unique()
      .references(() => customerPayments.id, { onDelete: "set null" }),
    matchStatus: text("match_status", {
      enum: ["unmatched", "matched", "discrepancy"],
    })
      .notNull()
      .default("unmatched"),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    matchedBy: text("matched_by").references(() => users.id, { onDelete: "set null" }),
    discrepancyReason: text("discrepancy_reason"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("bank_transactions_bank_date_idx").on(t.bankAccountId, t.transactionDate),
    index("bank_transactions_status_idx").on(t.matchStatus),
  ],
);

export const customerCreditNoteLines = pgTable(
  "customer_credit_note_lines",
  {
    id: text("id").primaryKey(),
    creditNoteId: text("credit_note_id")
      .notNull()
      .references(() => customerCreditNotes.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    productNameSnapshot: text("product_name_snapshot").notNull(),
    gradeId: text("grade_id")
      .notNull()
      .references(() => productGrades.id, { onDelete: "restrict" }),
    gradeCodeSnapshot: text("grade_code_snapshot").notNull(),
    uomCode: text("uom_code").notNull(),
    qty: numeric("qty", { precision: 14, scale: 3 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    lineTotalAmount: numeric("line_total_amount", { precision: 18, scale: 2 }).notNull(),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("customer_credit_note_lines_cn_lineno_uidx").on(t.creditNoteId, t.lineNo),
    index("customer_credit_note_lines_cn_idx").on(t.creditNoteId),
  ],
);
