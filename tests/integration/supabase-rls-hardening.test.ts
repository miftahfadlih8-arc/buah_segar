import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool } from "@/server/db";
import { closeDb, setupTestDb } from "../helpers/test-db";

/**
 * Supabase deployment guard (migration 0007_supabase_rls_hardening).
 *
 * The app talks to PostgreSQL server-side as the table owner and authorizes in the
 * application layer (RBAC + warehouse scope). The database must therefore be
 * deny-by-default for every OTHER role, so that Supabase's public Data API
 * (anon / authenticated keys) can never read or write business data.
 */
describe("Supabase hardening — RLS deny-by-default on every application table", () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("enables (but does not force) RLS on every public table, with no permissive policies", async () => {
    const db = await setupTestDb();
    const tables = await db.execute<{ relname: string; rls: boolean; forced: boolean }>(sql`
      SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       ORDER BY c.relname
    `);
    expect(tables.rows.length).toBeGreaterThanOrEqual(74);
    const withoutRls = tables.rows.filter((t) => !t.rls).map((t) => t.relname);
    expect(withoutRls, "new tables must run ALTER TABLE ... ENABLE ROW LEVEL SECURITY").toEqual([]);
    // FORCE would lock the owner (the application itself) out of its own tables.
    expect(tables.rows.filter((t) => t.forced).map((t) => t.relname)).toEqual([]);

    const policies = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`,
    );
    expect(policies.rows[0]?.n).toBe(0);
  });

  it("exposes no views and no SECURITY DEFINER functions that could bypass RLS", async () => {
    const db = await setupTestDb();
    const views = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
    `);
    expect(views.rows[0]?.n).toBe(0);

    const definers = await db.execute<{ proname: string }>(sql`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
    `);
    expect(definers.rows).toEqual([]);

    const searchPath = await db.execute<{ proname: string; cfg: string[] | null }>(sql`
      SELECT p.proname, p.proconfig AS cfg FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('prevent_immutable_row_mutation', 'verify_journal_entry_balance')
    `);
    expect(searchPath.rows).toHaveLength(2);
    for (const fn of searchPath.rows) {
      expect(fn.cfg?.join(",") ?? "").toContain("search_path=public, pg_temp");
    }
  });

  it("hides and blocks rows for a non-owner role even when it holds table grants", async (ctx) => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const priv = await client.query<{ ok: boolean }>(
        "SELECT (rolsuper OR rolcreaterole) AS ok FROM pg_roles WHERE rolname = current_user",
      );
      if (!priv.rows[0]?.ok) {
        ctx.skip();
        return;
      }

      // Everything below runs in ONE transaction and is rolled back: the probe role,
      // grants and rows never persist (CREATE ROLE is transactional in PostgreSQL).
      await client.query("BEGIN");
      await client.query("CREATE ROLE buah_rls_probe_it NOLOGIN");
      await client.query("GRANT USAGE ON SCHEMA public TO buah_rls_probe_it");
      await client.query(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON public.branches, public.customers, public.customer_invoices, public.users TO buah_rls_probe_it",
      );
      await client.query(
        "INSERT INTO public.branches (id, code, name, city) VALUES ('br_rls_probe', 'RLSP', 'Probe', 'Bekasi')",
      );

      await client.query("SET LOCAL ROLE buah_rls_probe_it");
      for (const table of ["branches", "customers", "customer_invoices", "users"]) {
        const r = await client.query<{ n: string }>(`SELECT count(*) AS n FROM public.${table}`);
        expect(Number(r.rows[0]?.n), `${table} must be invisible to non-owner roles`).toBe(0);
      }

      const upd = await client.query("UPDATE public.branches SET name = 'hacked'");
      expect(upd.rowCount).toBe(0);

      await client.query("SAVEPOINT before_insert");
      await expect(
        client.query(
          "INSERT INTO public.branches (id, code, name, city) VALUES ('br_rls_probe2', 'RLS2', 'X', 'Bekasi')",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT before_insert");

      await client.query("RESET ROLE");
      const owner = await client.query<{ name: string }>(
        "SELECT name FROM public.branches WHERE id = 'br_rls_probe'",
      );
      expect(owner.rows[0]?.name).toBe("Probe");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});
