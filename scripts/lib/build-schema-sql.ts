import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Builds the single-file, authoritative bootstrap SQL (`docs/database/schema.sql`)
 * from the ordered Drizzle migrations in `drizzle/`.
 *
 * The output is NOT hand-written DDL: every DDL statement is copied verbatim from the
 * migration files listed in `drizzle/meta/_journal.json`, in journal order, split on the
 * same `--> statement-breakpoint` marker the Drizzle migrator uses. The file also records
 * each migration in `drizzle.__drizzle_migrations` with the identical sha256 hash and
 * `created_at` (= journal `when`) that `drizzle-orm/node-postgres/migrator` writes, so a
 * database bootstrapped from schema.sql is indistinguishable from one created with
 * `npm run db:migrate`, and future migrations apply normally on top of it.
 *
 * The output is deterministic (no timestamps) so it can be checked in CI.
 */

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface MigrationInfo {
  idx: number;
  tag: string;
  when: number;
  hash: string;
  statements: string[];
}

export function readMigrations(migrationsDir: string): MigrationInfo[] {
  const journalPath = path.join(migrationsDir, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: JournalEntry[] };
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  const seenTags = new Set<string>();
  let lastWhen = -Infinity;
  entries.forEach((entry, position) => {
    if (entry.idx !== position) {
      throw new Error(`Journal idx gap/duplicate: expected idx ${position}, found ${entry.idx}`);
    }
    if (seenTags.has(entry.tag)) throw new Error(`Duplicate migration tag: ${entry.tag}`);
    seenTags.add(entry.tag);
    if (!(entry.when > lastWhen)) {
      throw new Error(`Journal 'when' not strictly increasing at ${entry.tag}`);
    }
    lastWhen = entry.when;
  });

  const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  const orphan = sqlFiles.filter((f) => !seenTags.has(f.replace(/\.sql$/, "")));
  if (orphan.length > 0) {
    throw new Error(`Migration file(s) not registered in journal: ${orphan.join(", ")}`);
  }

  return entries.map((entry) => {
    const raw = fs.readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), "utf8");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const statements = raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { idx: entry.idx, tag: entry.tag, when: entry.when, hash, statements };
  });
}

function terminate(statement: string): string {
  return statement.endsWith(";") ? statement : `${statement};`;
}

export function buildSchemaSql(migrationsDir: string): string {
  const migrations = readMigrations(migrationsDir);
  const out: string[] = [];

  out.push(
    "-- =============================================================================",
    "-- Fresh Distribution Business OS Bekasi — authoritative database bootstrap",
    "-- GENERATED FILE — DO NOT EDIT BY HAND.",
    "--   Source : drizzle/*.sql in drizzle/meta/_journal.json order",
    "--   Regen  : npm run db:schema-sql        Check: npm run db:schema-sql:check",
    "--",
    "-- Contains schema only: tables, constraints, indexes, foreign keys, functions,",
    "-- triggers, RLS enablement and Supabase grants hardening. It contains NO rows of",
    "-- business data, NO users/accounts, NO settings (the costing.policy_approval gate",
    "-- stays unapproved) and NO secrets.",
    "--",
    "-- Target: an EMPTY PostgreSQL 14+ database (local) or a NEW Supabase project",
    "-- (SQL editor / psql as the `postgres` role). Runs in a single transaction and",
    "-- aborts without changes if application tables already exist.",
    "--",
    "-- Migrations included:",
    ...migrations.map((m) => `--   ${m.tag}.sql  sha256=${m.hash}`),
    "-- =============================================================================",
    "",
    "BEGIN;",
    "",
    "-- Safety guard: refuse to run against a database that already has the app schema.",
    "DO $$",
    "BEGIN",
    "  IF to_regclass('public.users') IS NOT NULL",
    "     OR to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN",
    "    RAISE EXCEPTION 'schema.sql must only be applied to an EMPTY database (application tables or drizzle migration history already present). Use `npm run db:migrate` for existing databases.';",
    "  END IF;",
    "END",
    "$$;",
    "",
  );

  for (const m of migrations) {
    out.push(
      "-- -----------------------------------------------------------------------------",
      `-- Migration ${m.tag} (${m.statements.length} statements)`,
      "-- -----------------------------------------------------------------------------",
    );
    for (const stmt of m.statements) {
      out.push(terminate(stmt), "");
    }
  }

  out.push(
    "-- -----------------------------------------------------------------------------",
    "-- Drizzle migration bookkeeping (identical to drizzle-orm node-postgres migrator)",
    "-- -----------------------------------------------------------------------------",
    "CREATE SCHEMA IF NOT EXISTS drizzle;",
    "",
    "CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (",
    "  id SERIAL PRIMARY KEY,",
    "  hash text NOT NULL,",
    "  created_at bigint",
    ");",
    "",
    'INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES',
    migrations.map((m) => `  ('${m.hash}', ${m.when})`).join(",\n") + ";",
    "",
    "COMMIT;",
    "",
  );

  return out.join("\n");
}
