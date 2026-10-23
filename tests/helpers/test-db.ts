import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { loadActorContext, type ActorContext } from "@/server/authz/authorize";
import { seedPermissionsAndRoles } from "@/server/authz/seed-roles";
import { closeDb, getDb, type DbClient } from "@/server/db";
import { runMigrations } from "@/server/db/migrate";
import { userRoleAssignments, users } from "@/server/db/schema";

const DEFAULT_TEST_URL = "postgres://localhost:5432/buah_test";

let migrated = false;

export function getTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL;
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `Keamanan pengujian: TEST_DATABASE_URL harus mengarah ke database berakhiran '_test', ditemukan: '${dbName}'`,
    );
  }
  return url;
}

export async function setupTestDb(): Promise<DbClient> {
  const testUrl = getTestDatabaseUrl();
  process.env.DATABASE_URL = testUrl;

  if (!migrated) {
    await runMigrations(testUrl);
    migrated = true;
  }

  const db = getDb();
  await db.execute(sql`
    TRUNCATE TABLE
      customer_order_request_events,
      customer_order_request_lines,
      customer_order_requests,
      customer_order_sessions,
      bank_transactions,
      bank_accounts,
      payment_allocations,
      customer_credit_note_lines,
      customer_invoice_lines,
      delivery_claims,
      proof_of_delivery_lines,
      proof_of_deliveries,
      delivery_order_lines,
      delivery_orders,
      fulfillment_exceptions,
      fulfillment_pick_allocations,
      sales_fulfillment_lines,
      sales_fulfillments,
      customer_credit_notes,
      customer_payments,
      customer_invoices,
      sales_order_lines,
      sales_orders,
      sales_quotation_lines,
      sales_quotations,
      price_list_history,
      price_list_items,
      price_lists,
      customer_contacts,
      stock_count_lines,
      stock_counts,
      stock_adjustment_lines,
      stock_adjustments,
      stock_reservations,
      stock_balances,
      inventory_movements,
      batches,
      landed_costs,
      grading_results,
      quality_inspections,
      weighings,
      goods_receipt_lines,
      goods_receipts,
      purchase_order_revisions,
      purchase_order_lines,
      purchase_orders,
      journal_lines,
      journal_entries,
      fiscal_periods,
      gl_accounts,
      audit_logs,
      idempotency_keys,
      document_sequences,
      approvals,
      settings,
      user_role_assignments,
      sessions,
      accounts,
      verifications,
      users,
      product_uom_conversions,
      product_grades,
      products,
      packaging_types,
      uoms,
      customers,
      delivery_zones,
      suppliers,
      warehouse_locations,
      warehouses,
      branches
    RESTART IDENTITY CASCADE
  `);

  await seedPermissionsAndRoles(db);
  return db;
}

export async function createTestActor(
  db: DbClient,
  options: {
    name?: string;
    email?: string;
    username?: string;
    status?: "active" | "suspended";
    grants: Array<{ roleCode: string; warehouseId?: string | null }>;
  },
): Promise<ActorContext> {
  const userId = `usr_${crypto.randomUUID().slice(0, 8)}`;
  const suffix = crypto.randomUUID().slice(0, 6);
  await db.insert(users).values({
    id: userId,
    name: options.name ?? `Pengguna Uji ${suffix}`,
    email: options.email ?? `uji.${suffix}@bekasi-buah.test`,
    username: options.username ?? `uji_${suffix}`,
    emailVerified: true,
    status: options.status ?? "active",
  });

  for (const g of options.grants) {
    await db.insert(userRoleAssignments).values({
      id: `ura_${crypto.randomUUID().slice(0, 8)}`,
      userId,
      roleId: `role_${g.roleCode}`,
      warehouseId: g.warehouseId ?? null,
    });
  }

  const ctx = await loadActorContext(db, userId, {
    requestId: `req_${suffix}`,
    ipAddress: "127.0.0.1",
  });
  if (!ctx) throw new Error("Gagal memuat ActorContext uji");
  return ctx;
}

export { closeDb };
