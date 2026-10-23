import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { resolveDatabaseUrl } from "./index";

const { Pool } = pg;

export async function runMigrations(databaseUrl: string = resolveDatabaseUrl()): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const db = drizzle(pool);
    const migrationsFolder = path.resolve(import.meta.dirname, "../../../drizzle");
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}
