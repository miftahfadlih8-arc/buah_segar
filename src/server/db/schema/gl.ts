import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { products, warehouses } from "./master";
import { users } from "./platform";

/**
 * Phase 3 Chart of Accounts (COA), Fiscal Periods, and Double-Entry General Ledger Foundation.
 * - `gl_accounts` stores the Chart of Accounts (avoiding collision with Better Auth `accounts`).
 * - `journal_entries` and `journal_lines` are append-only (guarded by `prevent_immutable_row_mutation()`).
 * - Balanced double-entry (`SUM(debit) = SUM(credit)`) is enforced both in application logic and via a PostgreSQL DEFERRABLE constraint trigger.
 */

export const glAccounts = pgTable("gl_accounts", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  accountType: text("account_type", {
    enum: ["asset", "liability", "equity", "revenue", "cogs", "expense"],
  }).notNull(),
  normalBalance: text("normal_balance", {
    enum: ["debit", "credit"],
  }).notNull(),
  parentCode: text("parent_code"),
  isPosting: boolean("is_posting").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    id: text("id").primaryKey(), // e.g. "2026-10"
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    status: text("status", {
      enum: ["open", "closed", "locked"],
    })
      .notNull()
      .default("open"),
    closedBy: text("closed_by").references(() => users.id, { onDelete: "set null" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("fiscal_periods_year_month_uidx").on(t.year, t.month)],
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: text("id").primaryKey(),
    entryNo: text("entry_no").notNull().unique(),
    entryDate: text("entry_date").notNull(), // YYYY-MM-DD in Asia/Jakarta
    fiscalPeriodId: text("fiscal_period_id")
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: "restrict" }),
    warehouseId: text("warehouse_id").references(() => warehouses.id, { onDelete: "restrict" }),
    sourceDocType: text("source_doc_type").notNull(),
    sourceDocId: text("source_doc_id").notNull(),
    purpose: text("purpose").notNull(),
    memo: text("memo").notNull(),
    isReversal: boolean("is_reversal").notNull().default(false),
    reversalOfEntryId: text("reversal_of_entry_id").references((): AnyPgColumn => journalEntries.id, {
      onDelete: "restrict",
    }),
    costingPolicyStatus: text("costing_policy_status", {
      enum: ["approved", "synthetic_dev_blocked_prod"],
    })
      .notNull()
      .default("synthetic_dev_blocked_prod"),
    totalDebit: numeric("total_debit", { precision: 18, scale: 2 }).notNull(),
    totalCredit: numeric("total_credit", { precision: 18, scale: 2 }).notNull(),
    postedBy: text("posted_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("journal_entries_source_purpose_uidx").on(
      t.sourceDocType,
      t.sourceDocId,
      t.purpose,
    ),
    uniqueIndex("journal_entries_reversal_of_uidx").on(t.reversalOfEntryId),
    index("journal_entries_date_idx").on(t.entryDate),
    index("journal_entries_warehouse_idx").on(t.warehouseId),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: text("id").primaryKey(),
    journalEntryId: text("journal_entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "restrict" }),
    lineNo: integer("line_no").notNull(),
    accountCode: text("account_code")
      .notNull()
      .references(() => glAccounts.code, { onDelete: "restrict" }),
    debit: numeric("debit", { precision: 18, scale: 2 }).notNull().default("0.00"),
    credit: numeric("credit", { precision: 18, scale: 2 }).notNull().default("0.00"),
    warehouseId: text("warehouse_id").references(() => warehouses.id, { onDelete: "restrict" }),
    productId: text("product_id").references(() => products.id, { onDelete: "restrict" }),
    batchId: text("batch_id"),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("journal_lines_entry_lineno_uidx").on(t.journalEntryId, t.lineNo),
    index("journal_lines_account_idx").on(t.accountCode),
    index("journal_lines_batch_idx").on(t.batchId),
  ],
);
