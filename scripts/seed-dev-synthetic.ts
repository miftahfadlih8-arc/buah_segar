import { eq } from "drizzle-orm";
import { getAuth } from "../src/server/auth";
import { loadActorContext } from "../src/server/authz/authorize";
import { seedPermissionsAndRoles } from "../src/server/authz/seed-roles";
import { closeDb, getDb, withTransaction } from "../src/server/db";
import { customers, products, suppliers, userRoleAssignments, users } from "../src/server/db/schema";
import {
  createProduct,
  seedStandardUomsAndPackaging,
  upsertProductUomConversion,
} from "../src/server/modules/master/catalog";
import { createCustomer, seedDefaultBekasiZones } from "../src/server/modules/master/customers";
import { createSupplier } from "../src/server/modules/master/suppliers";
import { seedDefaultBekasiWarehouse } from "../src/server/modules/master/warehouses";

async function main() {
  if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production") {
    throw new Error("DILARANG: seed-dev-synthetic tidak boleh dijalankan di lingkungan produksi.");
  }

  const db = getDb();
  await seedPermissionsAndRoles(db);
  await withTransaction(async (tx) => {
    await seedStandardUomsAndPackaging(tx);
    await seedDefaultBekasiWarehouse(tx);
    await seedDefaultBekasiZones(tx);
  });

  const auth = getAuth();
  const devPassword = process.env.DEV_SEED_PASSWORD?.trim();
  if (!devPassword || devPassword.length < 8) {
    throw new Error(
      "Harap tetapkan DEV_SEED_PASSWORD (minimal 8 karakter) pada .env.local sebelum menjalankan seed-dev-synthetic.",
    );
  }

  const demoAccounts = [
    {
      username: "admin_demo",
      name: "Budi Santoso (Admin Sistem - SINTETIS)",
      email: "admin.demo@bekasi-buah.test",
      roleCode: "admin",
      warehouseId: null,
    },
    {
      username: "owner_demo",
      name: "Hendra Kusuma (Pemilik - SINTETIS)",
      email: "owner.demo@bekasi-buah.test",
      roleCode: "owner",
      warehouseId: null,
    },
    {
      username: "pembelian_demo",
      name: "Siti Rahma (Pengadaan - SINTETIS)",
      email: "pembelian.demo@bekasi-buah.test",
      roleCode: "procurement",
      warehouseId: null,
    },
    {
      username: "gudang_bks1",
      name: "Rudi Hartono (Gudang BKS1 - SINTETIS)",
      email: "gudang.bks1@bekasi-buah.test",
      roleCode: "warehouse",
      warehouseId: "wh_bks1",
    },
    {
      username: "qc_bks1",
      name: "Dewi Lestari (QC BKS1 - SINTETIS)",
      email: "qc.bks1@bekasi-buah.test",
      roleCode: "qc",
      warehouseId: "wh_bks1",
    },
    {
      username: "sales_demo",
      name: "Andi Pratama (Sales - SINTETIS)",
      email: "sales.demo@bekasi-buah.test",
      roleCode: "sales",
      warehouseId: null,
    },
    {
      username: "keuangan_demo",
      name: "Maya Sari (Keuangan - SINTETIS)",
      email: "keuangan.demo@bekasi-buah.test",
      roleCode: "finance",
      warehouseId: null,
    },
  ];

  for (const acc of demoAccounts) {
    const [existing] = await db.select().from(users).where(eq(users.username, acc.username)).limit(1);
    if (!existing) {
      const res = await auth.api.signUpEmail({
        body: {
          name: acc.name,
          email: acc.email,
          password: devPassword,
          username: acc.username,
          status: "active",
        },
      });
      await db.insert(userRoleAssignments).values({
        id: `ura_seed_${acc.username}`,
        userId: res.user.id,
        roleId: `role_${acc.roleCode}`,
        warehouseId: acc.warehouseId,
      });
    }
  }

  const [ownerUser] = await db.select().from(users).where(eq(users.username, "owner_demo")).limit(1);
  const ownerCtx = await loadActorContext(db, ownerUser!.id);
  if (!ownerCtx) throw new Error("Gagal memuat konteks owner_demo");

  const existingProducts = await db.select().from(products);
  if (existingProducts.length === 0) {
    await withTransaction(async (tx) => {
      const mangga = await createProduct(tx, ownerCtx, {
        sku: "MNG-HRM-PRO",
        barcode: "8990001000011",
        name: "Mangga Harum Manis Probolinggo",
        category: "Buah Lokal Musiman",
        variety: "Harum Manis Tua Pohon",
        baseUomCode: "kg",
        isCatchWeight: true,
        defaultShelfLifeDays: 6,
        ripenessTracking: true,
        storageCondition: "ambient",
        taxCode: "PPN_EXEMPT",
        minMarginPct: "12.00",
        minSellingPrice: "18500",
      });
      await upsertProductUomConversion(tx, ownerCtx, {
        productId: mangga.id,
        uomCode: "peti",
        factorToBase: "22",
        isNominal: true,
        requiresActualWeight: true,
        defaultPackagingTypeId: "pkg_peti_kayu",
      });

      const jeruk = await createProduct(tx, ownerCtx, {
        sku: "JRK-MDN-BRS",
        barcode: "8990001000028",
        name: "Jeruk Manis Berastagi Medan",
        category: "Buah Lokal Harian",
        variety: "Siam Madu Berastagi",
        baseUomCode: "kg",
        isCatchWeight: true,
        defaultShelfLifeDays: 10,
        ripenessTracking: false,
        storageCondition: "cold",
        taxCode: "PPN_EXEMPT",
        minMarginPct: "10.00",
        minSellingPrice: "21000",
      });
      await upsertProductUomConversion(tx, ownerCtx, {
        productId: jeruk.id,
        uomCode: "krat",
        factorToBase: "20",
        isNominal: true,
        requiresActualWeight: true,
        defaultPackagingTypeId: "pkg_krat_std",
      });

      const pisang = await createProduct(tx, ownerCtx, {
        sku: "PSG-CAV-LPG",
        barcode: "8990001000035",
        name: "Pisang Cavendish Lampung",
        category: "Buah Lokal Harian",
        variety: "Cavendish Sunpride Setara",
        baseUomCode: "kg",
        isCatchWeight: true,
        defaultShelfLifeDays: 5,
        ripenessTracking: true,
        storageCondition: "cold",
        taxCode: "PPN_EXEMPT",
        minMarginPct: "11.00",
        minSellingPrice: "15500",
      });
      await upsertProductUomConversion(tx, ownerCtx, {
        productId: pisang.id,
        uomCode: "box",
        factorToBase: "13",
        isNominal: true,
        requiresActualWeight: true,
        defaultPackagingTypeId: "pkg_box_impor",
      });

      await createProduct(tx, ownerCtx, {
        sku: "APL-FUJI-IMP",
        barcode: "8990001000042",
        name: "Apel Fuji Blush RRC",
        category: "Buah Impor",
        variety: "Fuji Size 88/100",
        baseUomCode: "kg",
        isCatchWeight: true,
        defaultShelfLifeDays: 21,
        ripenessTracking: false,
        storageCondition: "cold",
        taxCode: "PPN_EXEMPT",
        minMarginPct: "10.00",
        minSellingPrice: "32000",
      });
    });
  }

  const existingSuppliers = await db.select().from(suppliers);
  if (existingSuppliers.length === 0) {
    await withTransaction(async (tx) => {
      await createSupplier(tx, ownerCtx, {
        code: "SUP-PROB-01",
        name: "Kelompok Tani Harum Jaya (SINTETIS)",
        supplierType: "koperasi",
        originRegion: "Probolinggo, Jawa Timur",
        contactPerson: "H. Slamet Riyadi",
        phone: "081200001111",
        address: "Kec. Dringu, Kab. Probolinggo",
        paymentTermsDays: 7,
        bankName: "BRI",
        bankAccountNo: "004101009988770",
        bankAccountHolder: "KT Harum Jaya",
        leadTimeDays: 2,
      });
      await createSupplier(tx, ownerCtx, {
        code: "SUP-BRS-02",
        name: "Kebun Jeruk Sinabung Makmur (SINTETIS)",
        supplierType: "kebun",
        originRegion: "Berastagi, Karo, Sumatera Utara",
        contactPerson: "Bang Togar",
        phone: "081300002222",
        address: "Jl. Jamin Ginting, Berastagi",
        paymentTermsDays: 14,
        bankName: "Bank Mandiri",
        bankAccountNo: "1050099887766",
        bankAccountHolder: "CV Sinabung Makmur",
        leadTimeDays: 3,
      });
    });
  }

  const existingCustomers = await db.select().from(customers);
  if (existingCustomers.length === 0) {
    await withTransaction(async (tx) => {
      await createCustomer(tx, ownerCtx, {
        code: "CUST-PASAR-01",
        name: "Toko Buah Segar Kranji (SINTETIS)",
        segment: "toko_buah",
        priceTier: "grosir",
        contactPerson: "Ibu Hj. Nani",
        phone: "081500003331",
        whatsapp: "081500003331",
        email: "nani.kranji@bekasi-buah.test",
        shippingAddress: "Pasar Baru Kranji Blok B No. 12, Bekasi Barat",
        deliveryZoneId: "zone_bks_barat",
        paymentTermsDays: 3,
        creditLimit: "15000000",
        marketingConsent: true,
        operationalConsent: true,
      });
      await createCustomer(tx, ownerCtx, {
        code: "CUST-HRC-02",
        name: "Resto & Kafe Summarecon Bekasi (SINTETIS)",
        segment: "horeca",
        priceTier: "horeca",
        contactPerson: "Chef Dimas",
        phone: "081600004442",
        whatsapp: "081600004442",
        email: "purchasing.horeca@bekasi-buah.test",
        shippingAddress: "Boulevard Ahmad Yani, Summarecon Bekasi, Bekasi Utara",
        deliveryZoneId: "zone_bks_utara",
        paymentTermsDays: 14,
        creditLimit: "35000000",
        marketingConsent: false,
        operationalConsent: true,
      });
      await createCustomer(tx, ownerCtx, {
        code: "CUST-JUS-03",
        name: "Kedai Jus Tropika Galaxy (SINTETIS)",
        segment: "kedai_jus",
        priceTier: "semi_grosir",
        contactPerson: "Mas Bayu",
        phone: "081700005553",
        whatsapp: "081700005553",
        email: "tropika.galaxy@bekasi-buah.test",
        shippingAddress: "Jl. Pulo Sirih Utama, Taman Galaxy, Bekasi Selatan",
        deliveryZoneId: "zone_bks_selatan",
        paymentTermsDays: 0,
        creditLimit: "0",
        marketingConsent: true,
        operationalConsent: true,
      });
    });
  }

  console.log("Data sintetis pengembangan berhasil disemai ke buah_dev.");
  await closeDb();
}

main().catch((err) => {
  console.error("Gagal menyemai data sintetis:", err);
  process.exit(1);
});
