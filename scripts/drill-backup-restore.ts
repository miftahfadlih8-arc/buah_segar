import { execSync } from "node:child_process";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import pg from "pg";

const { Pool } = pg;

const SOURCE_DB = "buah_test";
const DRILL_DB = "buah_restore_drill_test";
const DUMP_FILE = "/tmp/buah_backup_drill.dump";

async function main() {
  console.log("=== MEMULAI BACKUP & RESTORE DRILL (PHASE 7) ===");
  console.log(`Source Database: ${SOURCE_DB}`);
  console.log(`Target Restore Drill Database: ${DRILL_DB}`);
  console.log(`Dump File: ${DUMP_FILE}`);

  // 1. Eksekusi Backup (pg_dump)
  console.log("\n[1/5] Menjalankan pg_dump (Custom Format -Fc)...");
  const dumpStart = performance.now();
  execSync(
    `/opt/homebrew/bin/pg_dump -h localhost -p 5432 -Fc -b -f ${DUMP_FILE} ${SOURCE_DB}`,
    { stdio: "inherit" },
  );
  const dumpDurationMs = Math.round(performance.now() - dumpStart);
  const dumpStats = fs.statSync(DUMP_FILE);
  console.log(
    `✓ Backup selesai dalam ${dumpDurationMs} ms (${(dumpDurationMs / 1000).toFixed(2)} detik). Ukuran file: ${(dumpStats.size / 1024).toFixed(2)} KB.`,
  );

  // 2. Buat database drill terisolasi
  console.log(`\n[2/5] Menyiapkan database terisolasi '${DRILL_DB}'...`);
  try {
    execSync(`/opt/homebrew/bin/dropdb --if-exists -h localhost -p 5432 ${DRILL_DB}`, {
      stdio: "pipe",
    });
  } catch {}
  execSync(`/opt/homebrew/bin/createdb -h localhost -p 5432 ${DRILL_DB}`, { stdio: "inherit" });
  console.log(`✓ Database '${DRILL_DB}' berhasil dibuat.`);

  // 3. Eksekusi Restore (pg_restore)
  console.log("\n[3/5] Menjalankan pg_restore ke database drill...");
  const restoreStart = performance.now();
  try {
    execSync(
      `/opt/homebrew/bin/pg_restore -h localhost -p 5432 -d ${DRILL_DB} --no-owner --no-privileges ${DUMP_FILE}`,
      { stdio: "inherit" },
    );
  } catch (err: unknown) {
    // pg_restore returns exit code 1 if there are minor warnings, check error
    console.warn("pg_restore output warning/exit:", (err as Error).message);
  }
  const restoreDurationMs = Math.round(performance.now() - restoreStart);
  console.log(
    `✓ Restore selesai dalam ${restoreDurationMs} ms (${(restoreDurationMs / 1000).toFixed(2)} detik).`,
  );

  // 4. Verifikasi Integritas Data & Schema Hasil Restore
  console.log("\n[4/5] Memeriksa integritas data & skema pada database hasil restore...");
  const pool = new Pool({
    connectionString: `postgres://localhost:5432/${DRILL_DB}`,
  });

  try {
    // Check migrations
    const migRes = await pool.query(
      "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id ASC",
    );
    console.log(`- Jumlah migrasi Drizzle terverifikasi: ${migRes.rowCount} migrasi.`);
    for (const row of migRes.rows) {
      console.log(`  * Migration ${row.id}: hash=${row.hash.slice(0, 10)}... (${row.created_at})`);
    }

    // Check table count
    const tblRes = await pool.query(
      "SELECT count(*)::int as count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    console.log(`- Total tabel dalam skema public: ${tblRes.rows[0].count} tabel.`);

    // Check GL balance invariant: sum(debit) == sum(credit)
    const glRes = await pool.query(
      "SELECT COALESCE(SUM(debit), 0)::numeric(18,2) as sum_debit, COALESCE(SUM(credit), 0)::numeric(18,2) as sum_credit FROM journal_lines",
    );
    const sumDebit = glRes.rows[0].sum_debit;
    const sumCredit = glRes.rows[0].sum_credit;
    const isGlBalanced = Number(sumDebit) === Number(sumCredit);
    console.log(
      `- Invarian GL (Buku Besar): Total Debit = Rp ${sumDebit}, Total Credit = Rp ${sumCredit}. Status: ${
        isGlBalanced ? "SEIMBANG (ZERO VARIANCE)" : "SELISIH!"
      }`,
    );

    // Check audit logs count
    const auditRes = await pool.query("SELECT count(*)::int as count FROM audit_logs");
    console.log(`- Jumlah baris audit logs: ${auditRes.rows[0].count} entri.`);

    // Check inventory movements
    const movRes = await pool.query("SELECT count(*)::int as count FROM inventory_movements");
    console.log(`- Jumlah mutasi persediaan: ${movRes.rows[0].count} mutasi.`);

    if (!isGlBalanced) {
      throw new Error("Restore drill gagal: Invarian buku besar (Debit != Credit) tidak seimbang!");
    }
  } finally {
    await pool.end();
  }

  // 5. Cleanup Database Drill & Dump File
  console.log("\n[5/5] Membersihkan database drill dan file dump...");
  execSync(`/opt/homebrew/bin/dropdb -h localhost -p 5432 ${DRILL_DB}`, { stdio: "inherit" });
  if (fs.existsSync(DUMP_FILE)) {
    fs.unlinkSync(DUMP_FILE);
  }
  console.log(`✓ Database '${DRILL_DB}' dan file '${DUMP_FILE}' telah dibersihkan.`);

  console.log("\n=== HASIL DRILL BACKUP & RESTORE: SUKSES (PASS) ===");
  console.log({
    sourceDb: SOURCE_DB,
    drillDb: DRILL_DB,
    dumpFormat: "pg_dump -Fc (Custom Archive, Compressed)",
    dumpSizeBytes: dumpStats.size,
    dumpDurationMs,
    restoreDurationMs,
    totalDrillDurationMs: dumpDurationMs + restoreDurationMs,
    status: "PASS",
  });
}

main().catch((err) => {
  console.error("Backup & restore drill gagal:", err);
  process.exit(1);
});
