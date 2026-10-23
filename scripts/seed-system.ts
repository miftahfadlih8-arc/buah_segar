import { seedPermissionsAndRoles } from "../src/server/authz/seed-roles";
import { closeDb, getDb, withTransaction } from "../src/server/db";
import { seedStandardUomsAndPackaging } from "../src/server/modules/master/catalog";
import { seedDefaultBekasiZones } from "../src/server/modules/master/customers";
import { seedDefaultBekasiWarehouse } from "../src/server/modules/master/warehouses";

async function main() {
  const db = getDb();
  console.log("Menyemai data sistem dasar (RBAC, UoM, Kemasan, Gudang Bekasi, Zona Pengiriman)...");
  await seedPermissionsAndRoles(db);
  await withTransaction(async (tx) => {
    await seedStandardUomsAndPackaging(tx);
    await seedDefaultBekasiWarehouse(tx);
    await seedDefaultBekasiZones(tx);
  });
  console.log("Data sistem dasar berhasil disemai.");
  await closeDb();
}

main().catch((err) => {
  console.error("Gagal menyemai data sistem:", err);
  process.exit(1);
});
