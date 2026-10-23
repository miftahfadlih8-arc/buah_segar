import { runMigrations } from "../src/server/db/migrate";

async function main() {
  const url = process.env.DATABASE_URL ?? "postgres://localhost:5432/buah_dev";
  console.log(`Menjalankan migrasi database ke ${url.replace(/\/\/.*@/, "//***@")}...`);
  await runMigrations(url);
  console.log("Migrasi berhasil diterapkan.");
}

main().catch((err) => {
  console.error("Migrasi gagal:", err);
  process.exit(1);
});
