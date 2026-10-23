import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveAuthConfig } from "@/server/auth";
import { buildSchemaSql, readMigrations } from "../../scripts/lib/build-schema-sql";

const root = path.resolve(import.meta.dirname, "../..");
const migrationsDir = path.join(root, "drizzle");

describe("docs/database/schema.sql — generated from Drizzle migrations", () => {
  it("is up to date with drizzle/ journal (run `npm run db:schema-sql` if this fails)", () => {
    const committed = fs.readFileSync(path.join(root, "docs/database/schema.sql"), "utf8");
    expect(committed).toBe(buildSchemaSql(migrationsDir));
  });

  it("has a gap-free, strictly ordered journal with every .sql file registered", () => {
    const migrations = readMigrations(migrationsDir);
    expect(migrations.map((m) => m.idx)).toEqual(migrations.map((_, i) => i));
    expect(migrations.at(-1)?.tag).toBe("0007_supabase_rls_hardening");
  });

  it("contains no business data, accounts, settings, or secrets", () => {
    const sql = buildSchemaSql(migrationsDir);
    const inserts = sql.match(/^INSERT INTO .*$/gim) ?? [];
    expect(inserts).toEqual(['INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES']);
    expect(sql).not.toMatch(/^\s*(TRUNCATE|DROP TABLE|DROP SCHEMA|DELETE FROM)\b/im);
    expect(sql).not.toMatch(/postgres(ql)?:\/\/[^\s'"]+:[^\s'"]+@/i);
    expect(sql).not.toMatch(/BekasiSegar|service_role_key|eyJhbGciOi/i);
  });

  it("enables RLS and hardens Supabase grants in the final migration", () => {
    const sql = buildSchemaSql(migrationsDir);
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I");
    expect(sql).not.toMatch(/FORCE ROW LEVEL SECURITY/i);
  });

  it("enforces fail-closed auth configuration in production and isolates demo credentials from client bundle", () => {
    expect(() =>
      resolveAuthConfig({ NODE_ENV: "production", BETTER_AUTH_URL: "https://erp.example.com" }),
    ).toThrow(/BETTER_AUTH_SECRET/);

    expect(() =>
      resolveAuthConfig({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "dev-test-fallback-secret-minimum-32-chars-buah-bekasi",
        BETTER_AUTH_URL: "https://erp.example.com",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);

    expect(() =>
      resolveAuthConfig({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "a".repeat(36),
      }),
    ).toThrow(/BETTER_AUTH_URL/);

    const vercelPreviewCfg = resolveAuthConfig({
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "b".repeat(36),
      VERCEL_URL: "buah-bekasi-preview.vercel.app",
    });
    expect(vercelPreviewCfg.baseURL).toBe("https://buah-bekasi-preview.vercel.app");

    const loginFormSource = fs.readFileSync(
      path.join(root, "src/app/masuk/login-form.tsx"),
      "utf8",
    );
    expect(loginFormSource).not.toMatch(/BekasiSegar|owner_demo|admin_demo/);
  });
});
