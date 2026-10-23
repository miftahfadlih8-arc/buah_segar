import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

export type DbSchema = typeof schema;
export type DbClient = NodePgDatabase<DbSchema>;
export type DbTx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
export type DbExecutor = DbClient | DbTx;

declare global {
  var __buahPgPool: pg.Pool | undefined;
  var __buahDb: DbClient | undefined;
  var __buahPoolUrl: string | undefined;
}

export function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Never silently fall back to the local development database in production.
    if (process.env.NODE_ENV === "production") {
      throw new Error("Konfigurasi tidak lengkap: DATABASE_URL wajib diisi pada lingkungan produksi.");
    }
    return "postgres://localhost:5432/buah_dev";
  }
  return url;
}

export function getPool(): pg.Pool {
  const url = resolveDatabaseUrl();
  if (globalThis.__buahPgPool && globalThis.__buahPoolUrl === url) {
    return globalThis.__buahPgPool;
  }
  if (globalThis.__buahPgPool) {
    void globalThis.__buahPgPool.end().catch(() => undefined);
  }
  const isSupabaseOrCloudSsl =
    /supabase\.(co|com)/i.test(url) || /[?&]sslmode=(require|prefer|no-verify)/i.test(url);
  // Strip sslmode from URL when we pass explicit ssl options so pg-connection-string >= 2.14
  // does not override rejectUnauthorized:false with verify-full on Supabase pooler certs.
  const normalizedUrl = isSupabaseOrCloudSsl
    ? url.replace(/([?&])sslmode=[^&]+(&|$)/i, (_, p1: string, p2: string) =>
        p2 === "&" ? p1 : "",
      )
    : url;
  const pool = new Pool({
    connectionString: normalizedUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    ...(isSupabaseOrCloudSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  globalThis.__buahPgPool = pool;
  globalThis.__buahPoolUrl = url;
  globalThis.__buahDb = drizzle(pool, { schema });
  return pool;
}

export function getDb(): DbClient {
  getPool();
  return globalThis.__buahDb!;
}

/**
 * Run `fn` inside a database transaction. If `existingTx` is already a transaction,
 * reuses it so nested domain calls remain atomic in the same transaction.
 */
export async function withTransaction<T>(
  fn: (tx: DbExecutor) => Promise<T>,
  existingTx?: DbExecutor,
): Promise<T> {
  if (existingTx) {
    return fn(existingTx);
  }
  const db = getDb();
  return db.transaction(async (tx) => fn(tx));
}

export async function closeDb(): Promise<void> {
  if (globalThis.__buahPgPool) {
    await globalThis.__buahPgPool.end();
    globalThis.__buahPgPool = undefined;
    globalThis.__buahDb = undefined;
    globalThis.__buahPoolUrl = undefined;
  }
}
