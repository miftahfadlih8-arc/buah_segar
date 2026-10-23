import fs from "node:fs";
import path from "node:path";
import { buildSchemaSql } from "./lib/build-schema-sql";

/**
 * Usage:
 *   npm run db:schema-sql         -> (re)writes docs/database/schema.sql
 *   npm run db:schema-sql:check   -> exits 1 if docs/database/schema.sql is stale
 * Pure file operation: never connects to a database.
 */
const root = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(root, "drizzle");
const target = path.join(root, "docs", "database", "schema.sql");

const generated = buildSchemaSql(migrationsDir);

if (process.argv.includes("--check")) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (current !== generated) {
    console.error(
      "docs/database/schema.sql is out of date with drizzle/ migrations. Run `npm run db:schema-sql`.",
    );
    process.exit(1);
  }
  console.log("docs/database/schema.sql is up to date.");
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, generated);
  console.log(`Wrote ${path.relative(root, target)} (${generated.length} bytes).`);
}
