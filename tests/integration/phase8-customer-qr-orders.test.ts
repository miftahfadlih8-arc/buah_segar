import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type ActorContext } from "@/server/authz/authorize";
import { withTransaction, type DbClient } from "@/server/db";
import {
  batches,
  customerOrderRequestEvents,
  customerOrderRequests,
  customerOrderSessions,
  customers,
  inventoryMovements,
  journalEntries,
  productGrades,
  products,
  salesOrders,
  stockReservations,
} from "@/server/db/schema";
import {
  BusinessRuleError,
  ForbiddenError,
  ValidationError,
} from "@/server/errors";
import {
  confirmCustomerOrder,
  generateStoreQrCode,
  getCustomerOrderRequestDetails,
  getCustomerOrderStatus,
  getMerchantQrisConfig,
  getOrCreateOrderSession,
  getPublicFruitCatalog,
  listCustomerOrderRequests,
  readPrivateProofFile,
  rejectCustomerOrder,
  savePaymentProofFile,
  submitCustomerOrderRequest,
  updateMerchantQrisConfig,
  updateSessionCart,
  validateStoreCode,
  verifyCustomerOrderPayment,
} from "@/server/modules/customer-orders";
import { applyInventoryMovement } from "@/server/modules/inventory/ledger";
import { createProduct, seedStandardUomsAndPackaging } from "@/server/modules/master/catalog";
import { createCustomer, seedDefaultBekasiZones } from "@/server/modules/master/customers";
import { createSupplier } from "@/server/modules/master/suppliers";
import { seedDefaultBekasiWarehouse } from "@/server/modules/master/warehouses";
import { createPriceList, upsertPriceListItem } from "@/server/modules/pricing";
import { closeDb, createTestActor, setupTestDb } from "../helpers/test-db";

interface Phase8Fixtures {
  db: DbClient;
  owner: ActorContext;
  salesUser: ActorContext;
  financeUser: ActorContext;
  unauthorizedUser: ActorContext;
  warehouseId: string;
  storeCodeActive: string;
  storeCodeInactive: string;
  storeActiveId: string;
  storeInactiveId: string;
  jerukProductId: string;
  jerukGradeAId: string;
  apelProductId: string;
  apelGradeAId: string;
  sharedPriceListId: string;
}

describe("Phase 8 — Customer QR Order Portal + QR Generator Integration Tests", () => {
  let fx: Phase8Fixtures;

  beforeEach(async () => {
    const db = await setupTestDb();

    await withTransaction(async (tx) => {
      await seedStandardUomsAndPackaging(tx);
      await seedDefaultBekasiWarehouse(tx);
      await seedDefaultBekasiZones(tx);
    });

    const warehouseId = "wh_bks1";

    const owner = await createTestActor(db, {
      name: "Owner Bekasi",
      grants: [{ roleCode: "owner", warehouseId: null }],
    });

    const salesUser = await createTestActor(db, {
      name: "Staf Sales BKS",
      grants: [{ roleCode: "sales", warehouseId }],
    });

    const financeUser = await createTestActor(db, {
      name: "Staf Finance BKS",
      grants: [{ roleCode: "finance", warehouseId }],
    });

    const unauthorizedUser = await createTestActor(db, {
      name: "Operator Gudang Budi",
      grants: [{ roleCode: "warehouse", warehouseId }],
    });

    // Create Active and Inactive Stores (Customers)
    const storeActiveCode = "TKB001";
    const storeInactiveCode = "TKB002";

    const activeCust = await withTransaction(async (tx) => {
      return await createCustomer(tx, owner, {
        code: storeActiveCode,
        name: "Toko Buah Sinar Rejeki",
        segment: "toko_buah",
        priceTier: "grosir",
        shippingAddress: "Jl. Pemuda No. 45, Kranji, Bekasi Barat",
        assignedWarehouseId: warehouseId,
      });
    });

    const inactiveCust = await withTransaction(async (tx) => {
      return await createCustomer(tx, owner, {
        code: storeInactiveCode,
        name: "Kios Buah Tutup Sementara",
        segment: "toko_buah",
        priceTier: "grosir",
        shippingAddress: "Jl. Cut Mutia No. 12, Bekasi Timur",
        assignedWarehouseId: warehouseId,
      });
    });

    // Mark store 2 as inactive
    await db
      .update(customers)
      .set({ isActive: false })
      .where(eq(customers.id, inactiveCust.id));

    // Create Products: Jeruk Medan & Apel Fuji
    const jeruk = await withTransaction(async (tx) => {
      return await createProduct(tx, owner, {
        sku: "JRK-MDN",
        name: "Jeruk Medan Manis",
        category: "Jeruk",
        baseUomCode: "kg",
        defaultShelfLifeDays: 14,
        storageCondition: "ambient",
        minSellingPrice: "10000.0000",
      });
    });

    const [jerukGradeA] = await db
      .select()
      .from(productGrades)
      .where(eq(productGrades.productId, jeruk.id))
      .limit(1);

    const apel = await withTransaction(async (tx) => {
      return await createProduct(tx, owner, {
        sku: "APL-FJI",
        name: "Apel Fuji Super",
        category: "Apel",
        baseUomCode: "kg",
        defaultShelfLifeDays: 30,
        storageCondition: "cold",
        minSellingPrice: "15000.0000",
      });
    });

    const [apelGradeA] = await db
      .select()
      .from(productGrades)
      .where(eq(productGrades.productId, apel.id))
      .limit(1);

    // Create Shared Price List (Grosir)
    const sharedPriceList = await withTransaction(async (tx) => {
      return await createPriceList(tx, owner, {
        code: "PL-GROSIR-BEKASI",
        name: "Daftar Harga Grosir Bersama Seluruh Toko",
        priceTier: "grosir",
        effectiveFrom: "2026-01-01",
      });
    });

    // Upsert Price List Items
    await withTransaction(async (tx) => {
      // Jeruk: Rp 12.000 / kg
      await upsertPriceListItem(tx, owner, {
        priceListId: sharedPriceList.id,
        productId: jeruk.id,
        gradeId: jerukGradeA!.id,
        uomCode: "kg",
        minQty: 1,
        unitPrice: 12000,
        reason: "Penetapan harga grosir jeruk medan",
      });

      // Apel: Rp 18.000 / kg
      await upsertPriceListItem(tx, owner, {
        priceListId: sharedPriceList.id,
        productId: apel.id,
        gradeId: apelGradeA!.id,
        uomCode: "kg",
        minQty: 1,
        unitPrice: 18000,
        reason: "Penetapan harga grosir apel fuji",
      });
    });

    // Create Supplier and seed initial stock batches for Jeruk & Apel in wh_bks1
    // to satisfy FEFO reservation and cost basis resolution during order confirmation
    const supplier = await withTransaction(async (tx) => {
      return await createSupplier(tx, owner, {
        code: "SUP-TEST-P8",
        name: "Kelompok Tani Buah Nusantara",
        supplierType: "petani",
        originRegion: "Medan & Malang",
        paymentTermsDays: 14,
        leadTimeDays: 2,
      });
    });

    await withTransaction(async (tx) => {
      await tx.insert(batches).values({
        id: "bat_p8_jrk_01",
        batchCode: "LOT/BKS1/2610/00001",
        productId: jeruk.id,
        gradeId: jerukGradeA!.id,
        gradeCode: "A",
        supplierId: supplier.id,
        warehouseId,
        originRegion: "Medan",
        harvestedAt: new Date("2026-10-18T00:00:00Z"),
        receivedAt: new Date("2026-10-19T06:00:00Z"),
        bestBeforeDate: "2026-11-05",
        expiresAt: new Date("2026-11-05T23:59:59Z"),
        ripenessStage: "matang_siap_jual",
        initialQtyBase: "100.000",
        unitCostBase: "8000.0000",
        totalInitialCost: "800000.00",
        costingMethod: "batch_specific_rsv_synthetic_dev",
        status: "active",
      });

      await applyInventoryMovement(tx, owner, {
        warehouseId,
        warehouseCode: "BKS1",
        locationId: "loc_bks1_cold1",
        batchId: "bat_p8_jrk_01",
        productId: jeruk.id,
        gradeId: jerukGradeA!.id,
        stockStatus: "available",
        movementType: "grn_receipt",
        qtyDeltaBase: "100.000",
        unitCostBase: "8000.0000",
        explicitInflowCost: "800000.00",
        sourceDocType: "test_seed_batch",
        sourceDocId: "bat_p8_jrk_01",
        notes: "Seed batch awal Jeruk Medan Phase 8",
      });

      await tx.insert(batches).values({
        id: "bat_p8_apl_01",
        batchCode: "LOT/BKS1/2610/00002",
        productId: apel.id,
        gradeId: apelGradeA!.id,
        gradeCode: "A",
        supplierId: supplier.id,
        warehouseId,
        originRegion: "Malang",
        harvestedAt: new Date("2026-10-18T00:00:00Z"),
        receivedAt: new Date("2026-10-19T06:00:00Z"),
        bestBeforeDate: "2026-11-20",
        expiresAt: new Date("2026-11-20T23:59:59Z"),
        ripenessStage: "matang_siap_jual",
        initialQtyBase: "100.000",
        unitCostBase: "12000.0000",
        totalInitialCost: "1200000.00",
        costingMethod: "batch_specific_rsv_synthetic_dev",
        status: "active",
      });

      await applyInventoryMovement(tx, owner, {
        warehouseId,
        warehouseCode: "BKS1",
        locationId: "loc_bks1_cold1",
        batchId: "bat_p8_apl_01",
        productId: apel.id,
        gradeId: apelGradeA!.id,
        stockStatus: "available",
        movementType: "grn_receipt",
        qtyDeltaBase: "100.000",
        unitCostBase: "12000.0000",
        explicitInflowCost: "1200000.00",
        sourceDocType: "test_seed_batch",
        sourceDocId: "bat_p8_apl_01",
        notes: "Seed batch awal Apel Fuji Phase 8",
      });
    });

    fx = {
      db,
      owner,
      salesUser,
      financeUser,
      unauthorizedUser,
      warehouseId,
      storeCodeActive: storeActiveCode,
      storeCodeInactive: storeInactiveCode,
      storeActiveId: activeCust.id,
      storeInactiveId: inactiveCust.id,
      jerukProductId: jeruk.id,
      jerukGradeAId: jerukGradeA!.id,
      apelProductId: apel.id,
      apelGradeAId: apelGradeA!.id,
      sharedPriceListId: sharedPriceList.id,
    };
  });

  afterAll(async () => {
    await closeDb();
  });

  // ==========================================================================
  // SCENARIO 1: STORE CODE VALIDATION & BRUTE FORCE PROTECTION
  // ==========================================================================
  it("1. memvalidasi kode toko aktif, menolak kode toko tidak valid/nonaktif dengan pesan aman tanpa kebocoran data", async () => {
    // A. Valid code
    const validRes = await validateStoreCode(fx.db, "tkb001");
    expect(validRes.valid).toBe(true);
    expect(validRes.store?.name).toBe("Toko Buah Sinar Rejeki");
    expect(validRes.store?.code).toBe("TKB001");

    // B. Inactive code
    const inactiveRes = await validateStoreCode(fx.db, "TKB002");
    expect(inactiveRes.valid).toBe(false);
    expect(inactiveRes.error).toContain("tidak ditemukan atau tidak aktif");
    expect(inactiveRes.store).toBeUndefined();

    // C. Non-existent code (Brute force attempt)
    const randomRes = await validateStoreCode(fx.db, "HACKER999");
    expect(randomRes.valid).toBe(false);
    expect(randomRes.error).toContain("tidak ditemukan atau tidak aktif");

    // D. Empty or malformed input
    const emptyRes = await validateStoreCode(fx.db, "  ");
    expect(emptyRes.valid).toBe(false);
  });

  // ==========================================================================
  // SCENARIO 2: CATALOG & SHARED PRICE LIST
  // ==========================================================================
  it("2. mengambil katalog buah publik dengan harga aktif dari shared price list dan ketersediaan indikatif", async () => {
    const catalogData = await getPublicFruitCatalog(fx.db, fx.storeCodeActive);
    expect(catalogData.store.code).toBe("TKB001");
    expect(catalogData.products.length).toBeGreaterThanOrEqual(2);

    const jerukItem = catalogData.products.find((p) => p.id === fx.jerukProductId);
    expect(jerukItem).toBeDefined();
    expect(parseFloat(jerukItem!.unitPrice)).toBe(12000);
    expect(jerukItem!.indicativeAvailability).toBe("Tersedia");

    const apelItem = catalogData.products.find((p) => p.id === fx.apelProductId);
    expect(apelItem).toBeDefined();
    expect(parseFloat(apelItem!.unitPrice)).toBe(18000);
    expect(apelItem!.indicativeAvailability).toBe("Tersedia");
  });

  // ==========================================================================
  // SCENARIO 3: DRAFT SESSION & CART MANAGEMENT (REFRESH RESILIENCE)
  // ==========================================================================
  it("3. mengelola draft order session, menambah/mengubah item, dan mempertahankan isi cart saat refresh", async () => {
    // 1. Create or get session
    const session = await getOrCreateOrderSession(fx.db, {
      storeCode: fx.storeCodeActive,
    });
    expect(session.sessionToken).toBeDefined();
    expect(session.cartItems).toEqual([]);

    // 2. Update cart: 2 kg Jeruk (2 * 12.000 = 24.000), 1 kg Apel (1 * 18.000 = 18.000)
    const updated = await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [
        {
          productId: fx.jerukProductId,
          gradeId: fx.jerukGradeAId,
          uomCode: "kg",
          quantity: 2,
        },
        {
          productId: fx.apelProductId,
          gradeId: fx.apelGradeAId,
          uomCode: "kg",
          quantity: 1,
        },
      ],
      customerNotes: "Pilih jeruk yang manis untuk display depan toko",
    });

    expect(updated.cartItems.length).toBe(2);
    expect(parseFloat(updated.cartItems[0]!.subtotal)).toBe(24000);
    expect(parseFloat(updated.cartItems[1]!.subtotal)).toBe(18000);

    // 3. Simulate browser refresh by fetching session using existing token
    const restoredSession = await getOrCreateOrderSession(fx.db, {
      storeCode: fx.storeCodeActive,
      sessionToken: session.sessionToken,
    });
    expect(restoredSession.sessionToken).toBe(session.sessionToken);
    expect(restoredSession.cartItems.length).toBe(2);
    expect(restoredSession.customerNotes).toBe("Pilih jeruk yang manis untuk display depan toko");
  });

  // ==========================================================================
  // SCENARIO 4: SERVER-SIDE PRICE RECALCULATION (ANTI-TAMPERING)
  // ==========================================================================
  it("4. menghitung ulang harga dan subtotal di server dan mengabaikan manipulasi harga dari browser", async () => {
    const session = await getOrCreateOrderSession(fx.db, {
      storeCode: fx.storeCodeActive,
    });

    // Client requests 3 kg Jeruk
    await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [
        {
          productId: fx.jerukProductId,
          gradeId: fx.jerukGradeAId,
          uomCode: "kg",
          quantity: 3, // 3 * 12.000 = 36.000
        },
      ],
    });

    const [dbSession] = await fx.db
      .select()
      .from(customerOrderSessions)
      .where(eq(customerOrderSessions.sessionToken, session.sessionToken));

    const items = dbSession!.cartItems as Array<{ unitPrice: string; subtotal: string }>;
    expect(parseFloat(items[0]!.unitPrice)).toBe(12000);
    expect(parseFloat(items[0]!.subtotal)).toBe(36000);
  });

  // ==========================================================================
  // SCENARIO 5: PAYMENT PROOF UPLOAD & PRIVATE STORAGE VALIDATION
  // ==========================================================================
  it("5. memvalidasi upload bukti pembayaran (MIME, magic bytes, batas ukuran) dan menyimpannya di storage privat", async () => {
    const session = await getOrCreateOrderSession(fx.db, {
      storeCode: fx.storeCodeActive,
    });

    // A. Valid JPEG buffer (with real magic bytes FF D8 FF)
    const validJpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const validJpgBody = Buffer.alloc(1024, 0xaa);
    const validJpg = Buffer.concat([validJpgHeader, validJpgBody]);

    const uploadRes = await savePaymentProofFile(fx.db, {
      sessionToken: session.sessionToken,
      fileBuffer: validJpg,
      fileName: "bukti_transfer_bank_bca.jpg",
      mimeType: "image/jpeg",
    });

    expect(uploadRes.success).toBe(true);
    expect(uploadRes.fileName).toMatch(/^proof_\d+_[a-f0-9]+\.jpg$/);

    // Verify file exists in private storage and can be read
    const readBack = await readPrivateProofFile(uploadRes.fileName);
    expect(readBack).not.toBeNull();
    expect(readBack!.mime).toBe("image/jpeg");

    // B. Invalid MIME type (PDF or executable)
    await expect(
      savePaymentProofFile(fx.db, {
        sessionToken: session.sessionToken,
        fileBuffer: Buffer.from("fake-script-payload"),
        fileName: "malicious.sh",
        mimeType: "application/x-sh",
      }),
    ).rejects.toThrow(ValidationError);

    // C. Fake MIME with corrupted magic bytes
    await expect(
      savePaymentProofFile(fx.db, {
        sessionToken: session.sessionToken,
        fileBuffer: Buffer.from("Not a real JPEG header"),
        fileName: "fake.jpg",
        mimeType: "image/jpeg",
      }),
    ).rejects.toThrow(ValidationError);

    // D. Oversized file (> 5 MB)
    const hugeBuffer = Buffer.alloc(6 * 1024 * 1024);
    await expect(
      savePaymentProofFile(fx.db, {
        sessionToken: session.sessionToken,
        fileBuffer: hugeBuffer,
        fileName: "huge_video.jpg",
        mimeType: "image/jpeg",
      }),
    ).rejects.toThrow(ValidationError);
  });

  // ==========================================================================
  // SCENARIO 6: RESILIENCE — UPLOAD FAILURE DOES NOT WIPE CART OR DRAFT
  // ==========================================================================
  it("6. mempertahankan cart dan draft pesanan saat upload bukti pembayaran gagal lalu dicoba ulang (retry)", async () => {
    const session = await getOrCreateOrderSession(fx.db, {
      storeCode: fx.storeCodeActive,
    });

    // Populate cart
    await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [
        {
          productId: fx.apelProductId,
          gradeId: fx.apelGradeAId,
          uomCode: "kg",
          quantity: 2,
        },
      ],
    });

    // Try uploading corrupted file -> Expect failure
    try {
      await savePaymentProofFile(fx.db, {
        sessionToken: session.sessionToken,
        fileBuffer: Buffer.from("corrupted"),
        fileName: "corrupt.jpg",
        mimeType: "image/jpeg",
      });
    } catch {
      // Expected error
    }

    // Verify cart is still 100% intact after upload failure!
    const restored = await getOrCreateOrderSession(fx.db, {
      storeCode: fx.storeCodeActive,
      sessionToken: session.sessionToken,
    });
    expect(restored.cartItems.length).toBe(1);
    expect(restored.cartItems[0]!.productId).toBe(fx.apelProductId);

    // Now retry with valid PNG
    const validPngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const validPng = Buffer.concat([validPngHeader, Buffer.alloc(512)]);

    const retryRes = await savePaymentProofFile(fx.db, {
      sessionToken: session.sessionToken,
      fileBuffer: validPng,
      fileName: "bukti_qris_dana.png",
      mimeType: "image/png",
    });
    expect(retryRes.success).toBe(true);
  });

  // ==========================================================================
  // SCENARIO 7: ORDER SUBMISSION & IDEMPOTENCY
  // ==========================================================================
  it("7. mengirim pesanan customer, mencegah submit berulang dengan idempotency key, dan menerbitkan No. Order stabil", async () => {
    // 1. Setup session with cart and proof
    const session = await getOrCreateOrderSession(fx.db, {
      storeCode: fx.storeCodeActive,
    });

    await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [
        { productId: fx.jerukProductId, gradeId: fx.jerukGradeAId, uomCode: "kg", quantity: 2 }, // 24.000
        { productId: fx.apelProductId, gradeId: fx.apelGradeAId, uomCode: "kg", quantity: 1 },  // 18.000
      ],
    });

    const validJpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    await savePaymentProofFile(fx.db, {
      sessionToken: session.sessionToken,
      fileBuffer: Buffer.concat([validJpgHeader, Buffer.alloc(100)]),
      fileName: "bukti_qris_mandiri.jpg",
      mimeType: "image/jpeg",
    });

    // 2. Submit order request
    const idempotencyKey = `idem_sub_${Date.now()}`;
    const orderResult1 = await withTransaction(async (tx) => {
      return await submitCustomerOrderRequest(tx, {
        sessionToken: session.sessionToken,
        idempotencyKey,
        customerNotes: "Kirim sebelum jam 10 pagi",
      });
    });

    expect(orderResult1.orderNumber).toMatch(/^#RQ\d{8}\d{3}$/);
    expect(parseFloat(orderResult1.totalAmount)).toBe(42000); // 24.000 + 18.000 = 42.000
    expect(orderResult1.status).toBe("pending_review");
    expect(orderResult1.isDuplicate).toBe(false);

    // 3. Repeated submit with same idempotency key -> Returns SAME order!
    const orderResult2 = await withTransaction(async (tx) => {
      return await submitCustomerOrderRequest(tx, {
        sessionToken: session.sessionToken,
        idempotencyKey,
      });
    });

    expect(orderResult2.orderNumber).toBe(orderResult1.orderNumber);
    expect(orderResult2.statusToken).toBe(orderResult1.statusToken);
    expect(orderResult2.isDuplicate).toBe(true);

    // Verify DB count: exactly 1 request created, no duplication!
    const reqs = await fx.db
      .select()
      .from(customerOrderRequests)
      .where(eq(customerOrderRequests.orderNumber, orderResult1.orderNumber));
    expect(reqs.length).toBe(1);
  });

  // ==========================================================================
  // SCENARIO 8: SECURE STATUS TRACKING & IDOR PREVENTION
  // ==========================================================================
  it("8. melacak status pesanan secara aman menggunakan high-entropy statusToken dan mencegah akses IDOR", async () => {
    // Setup and submit order
    const session = await getOrCreateOrderSession(fx.db, { storeCode: fx.storeCodeActive });
    await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [{ productId: fx.jerukProductId, gradeId: fx.jerukGradeAId, uomCode: "kg", quantity: 1 }],
    });
    const validJpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    await savePaymentProofFile(fx.db, {
      sessionToken: session.sessionToken,
      fileBuffer: Buffer.concat([validJpgHeader, Buffer.alloc(100)]),
      fileName: "bukti.jpg",
      mimeType: "image/jpeg",
    });

    const submitRes = await withTransaction(async (tx) => {
      return await submitCustomerOrderRequest(tx, { sessionToken: session.sessionToken });
    });

    // Valid token inquiry
    const statusData = await getCustomerOrderStatus(fx.db, submitRes.statusToken);
    expect(statusData).not.toBeNull();
    expect(statusData!.orderNumber).toBe(submitRes.orderNumber);
    expect(statusData!.orderStatus).toBe("pending_review");
    expect(statusData!.lines.length).toBe(1);

    // Attacker tries guessing by sequential order number or fake token
    const attackerInquiry = await getCustomerOrderStatus(fx.db, "fake_token_12345");
    expect(attackerInquiry).toBeNull();
  });

  // ==========================================================================
  // SCENARIO 9: PHYSICAL INVENTORY INTEGRITY (NO STOCK DEDUCTED ON DRAFT)
  // ==========================================================================
  it("9. memastikan stok fisik inventaris TIDAK berkurang saat draft atau order request dibuat", async () => {
    // Check initial inventory movements count
    const initialMovements = await fx.db.select().from(inventoryMovements);

    const session = await getOrCreateOrderSession(fx.db, { storeCode: fx.storeCodeActive });
    await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [{ productId: fx.jerukProductId, gradeId: fx.jerukGradeAId, uomCode: "kg", quantity: 50 }],
    });
    const validJpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    await savePaymentProofFile(fx.db, {
      sessionToken: session.sessionToken,
      fileBuffer: Buffer.concat([validJpgHeader, Buffer.alloc(100)]),
      fileName: "bukti.jpg",
      mimeType: "image/jpeg",
    });

    await withTransaction(async (tx) => {
      await submitCustomerOrderRequest(tx, { sessionToken: session.sessionToken });
    });

    // Movements count must remain exactly unchanged!
    const postMovements = await fx.db.select().from(inventoryMovements);
    expect(postMovements.length).toBe(initialMovements.length);
  });

  // ==========================================================================
  // SCENARIO 10: NO PREMATURE GL OR INVOICE ON ORDER REQUEST
  // ==========================================================================
  it("10. memastikan order request tidak menciptakan jurnal GL atau faktur secara prematur", async () => {
    const initialJournals = await fx.db.select().from(journalEntries);

    const session = await getOrCreateOrderSession(fx.db, { storeCode: fx.storeCodeActive });
    await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [{ productId: fx.jerukProductId, gradeId: fx.jerukGradeAId, uomCode: "kg", quantity: 1 }],
    });
    const validJpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    await savePaymentProofFile(fx.db, {
      sessionToken: session.sessionToken,
      fileBuffer: Buffer.concat([validJpgHeader, Buffer.alloc(100)]),
      fileName: "bukti.jpg",
      mimeType: "image/jpeg",
    });

    await withTransaction(async (tx) => {
      await submitCustomerOrderRequest(tx, { sessionToken: session.sessionToken });
    });

    const postJournals = await fx.db.select().from(journalEntries);
    expect(postJournals.length).toBe(initialJournals.length);
  });

  // ==========================================================================
  // SCENARIO 11: ADMIN INBOX, REVIEW & PAYMENT VERIFICATION
  // ==========================================================================
  it("11. memverifikasi alur verifikasi bukti pembayaran oleh role berwenang dan menolak role tanpa izin", async () => {
    const session = await getOrCreateOrderSession(fx.db, { storeCode: fx.storeCodeActive });
    await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [{ productId: fx.jerukProductId, gradeId: fx.jerukGradeAId, uomCode: "kg", quantity: 1 }],
    });
    const validJpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    await savePaymentProofFile(fx.db, {
      sessionToken: session.sessionToken,
      fileBuffer: Buffer.concat([validJpgHeader, Buffer.alloc(100)]),
      fileName: "bukti.jpg",
      mimeType: "image/jpeg",
    });

    const submitRes = await withTransaction(async (tx) => {
      return await submitCustomerOrderRequest(tx, { sessionToken: session.sessionToken });
    });

    const [orderReq] = await fx.db
      .select()
      .from(customerOrderRequests)
      .where(eq(customerOrderRequests.orderNumber, submitRes.orderNumber));

    // A. Unauthorized user (driver) tries verifying payment -> Forbidden!
    await expect(
      withTransaction(async (tx) => {
        return await verifyCustomerOrderPayment(tx, fx.unauthorizedUser, {
          orderRequestId: orderReq!.id,
          action: "verify",
        });
      }),
    ).rejects.toThrow(ForbiddenError);

    // B. Authorized finance user verifies payment
    const verifyRes = await withTransaction(async (tx) => {
      return await verifyCustomerOrderPayment(tx, fx.financeUser, {
        orderRequestId: orderReq!.id,
        action: "verify",
      });
    });

    expect(verifyRes.paymentStatus).toBe("verified");

    // Status in DB updated
    const [updatedReq] = await fx.db
      .select()
      .from(customerOrderRequests)
      .where(eq(customerOrderRequests.id, orderReq!.id));
    expect(updatedReq!.paymentStatus).toBe("verified");
    expect(updatedReq!.paymentVerifiedBy).toBe(fx.financeUser.user.id);
  });

  // ==========================================================================
  // SCENARIO 12: ADMIN CONFIRMATION CONVERTS TO OFFICIAL SALES ORDER
  // ==========================================================================
  it("12. mengonfirmasi pesanan QR pelanggan dan mengonversinya menjadi Sales Order resmi secara idempoten", async () => {
    const session = await getOrCreateOrderSession(fx.db, { storeCode: fx.storeCodeActive });
    await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [{ productId: fx.jerukProductId, gradeId: fx.jerukGradeAId, uomCode: "kg", quantity: 5 }],
    });
    const validJpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    await savePaymentProofFile(fx.db, {
      sessionToken: session.sessionToken,
      fileBuffer: Buffer.concat([validJpgHeader, Buffer.alloc(100)]),
      fileName: "bukti.jpg",
      mimeType: "image/jpeg",
    });

    const submitRes = await withTransaction(async (tx) => {
      return await submitCustomerOrderRequest(tx, { sessionToken: session.sessionToken });
    });

    const [orderReq] = await fx.db
      .select()
      .from(customerOrderRequests)
      .where(eq(customerOrderRequests.orderNumber, submitRes.orderNumber));

    // Admin Sales confirms order
    const confirmRes1 = await withTransaction(async (tx) => {
      return await confirmCustomerOrder(tx, fx.salesUser, {
        orderRequestId: orderReq!.id,
      });
    });

    expect(confirmRes1.success).toBe(true);
    expect(confirmRes1.salesOrderId).toBeDefined();
    expect(confirmRes1.alreadyConfirmed).toBe(false);

    // Verify Sales Order exists in official table
    const [so] = await fx.db
      .select()
      .from(salesOrders)
      .where(eq(salesOrders.id, confirmRes1.salesOrderId));
    expect(so).toBeDefined();
    expect(so!.customerId).toBe(fx.storeActiveId);

    // Repeated confirmation attempt is idempotent!
    const confirmRes2 = await withTransaction(async (tx) => {
      return await confirmCustomerOrder(tx, fx.salesUser, {
        orderRequestId: orderReq!.id,
      });
    });

    expect(confirmRes2.salesOrderId).toBe(confirmRes1.salesOrderId);
    expect(confirmRes2.alreadyConfirmed).toBe(true);
  });

  // ==========================================================================
  // SCENARIO 13: ORDER REJECTION WITH MANDATORY REASON
  // ==========================================================================
  it("13. menolak pesanan QR dengan alasan wajib dan mencatat penolakan pada status dan timeline", async () => {
    const session = await getOrCreateOrderSession(fx.db, { storeCode: fx.storeCodeActive });
    await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [{ productId: fx.apelProductId, gradeId: fx.apelGradeAId, uomCode: "kg", quantity: 10 }],
    });
    const validJpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    await savePaymentProofFile(fx.db, {
      sessionToken: session.sessionToken,
      fileBuffer: Buffer.concat([validJpgHeader, Buffer.alloc(100)]),
      fileName: "bukti.jpg",
      mimeType: "image/jpeg",
    });

    const submitRes = await withTransaction(async (tx) => {
      return await submitCustomerOrderRequest(tx, { sessionToken: session.sessionToken });
    });

    const [orderReq] = await fx.db
      .select()
      .from(customerOrderRequests)
      .where(eq(customerOrderRequests.orderNumber, submitRes.orderNumber));

    // Reject without reason -> Validation error
    await expect(
      withTransaction(async (tx) => {
        return await rejectCustomerOrder(tx, fx.salesUser, {
          orderRequestId: orderReq!.id,
          reason: "  ",
        });
      }),
    ).rejects.toThrow(ValidationError);

    // Reject with proper reason
    const rejectRes = await withTransaction(async (tx) => {
      return await rejectCustomerOrder(tx, fx.salesUser, {
        orderRequestId: orderReq!.id,
        reason: "Stok Apel Fuji di cold storage sedang habis, pengiriman baru besok pagi",
      });
    });

    expect(rejectRes.orderStatus).toBe("rejected");

    // Status inquiry reflects rejection reason
    const statusData = await getCustomerOrderStatus(fx.db, submitRes.statusToken);
    expect(statusData!.orderStatus).toBe("rejected");
    expect(statusData!.rejectionReason).toContain("sedang habis");
  });

  // ==========================================================================
  // SCENARIO 14: SCANNABLE STORE QR GENERATION (PNG + SVG)
  // ==========================================================================
  it("14. menghasilkan QR Code toko yang dapat dipindai (scannable) dalam format PNG dan SVG dengan base URL resmi", async () => {
    const qrResult = await generateStoreQrCode(fx.db, fx.storeCodeActive, {
      baseUrl: "https://os.suplayerbuahbekasi.com",
    });

    expect(qrResult.storeCode).toBe("TKB001");
    expect(qrResult.orderUrl).toBe("https://os.suplayerbuahbekasi.com/order?store=TKB001");
    expect(qrResult.qrPngDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(qrResult.qrSvgString).toContain("<svg");
    expect(qrResult.isActive).toBe(true);
  });

  // ==========================================================================
  // SCENARIO 15: MERCHANT QRIS CONFIGURATION MANAGEMENT
  // ==========================================================================
  it("15. mengelola konfigurasi QRIS merchant resmi terpusat dan mencegah tampilan QR dummy saat QRIS belum aktif", async () => {
    // Initial state: not enabled
    const initialConfig = await getMerchantQrisConfig(fx.db);
    expect(initialConfig.isEnabled).toBe(false);

    // Update config by owner
    await updateMerchantQrisConfig(fx.db, fx.owner, {
      merchantName: "PT Suplayer Buah Bekasi",
      nmid: "ID102003004005",
      qrisImageUrl: "https://os.suplayerbuahbekasi.com/qris/merchant_qris_official.png",
      instructions: "Transfer sesuai total Rupiah",
      isEnabled: true,
    });

    const activeConfig = await getMerchantQrisConfig(fx.db);
    expect(activeConfig.isEnabled).toBe(true);
    expect(activeConfig.merchantName).toBe("PT Suplayer Buah Bekasi");
    expect(activeConfig.nmid).toBe("ID102003004005");
  });

  // ==========================================================================
  // SCENARIO 16: EDIT CART QUANTITY & LINE NOTES WITHOUT RESETTING DRAFT
  // ==========================================================================
  it("16. mengedit kuantitas dan catatan per baris di cart session tanpa mereset draft", async () => {
    const session = await getOrCreateOrderSession(fx.db, { storeCode: fx.storeCodeActive });
    
    // Step 1: Initial cart with 2 kg Jeruk
    await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [
        {
          productId: fx.jerukProductId,
          gradeId: fx.jerukGradeAId,
          uomCode: "kg",
          quantity: 2,
          notes: "Pilih yang kulitnya mulus",
        },
      ],
    });

    // Step 2: Edit cart to 15 kg Jeruk with updated notes
    const updated = await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [
        {
          productId: fx.jerukProductId,
          gradeId: fx.jerukGradeAId,
          uomCode: "kg",
          quantity: 15,
          notes: "Pilih yang manis dan matang",
        },
      ],
    });

    expect(updated.cartItems.length).toBe(1);
    expect(parseFloat(updated.cartItems[0]!.quantity)).toBe(15);
    expect(updated.cartItems[0]!.notes).toBe("Pilih yang manis dan matang");
  });

  // ==========================================================================
  // SCENARIO 17: SAFE PRIVATE PROOF STORAGE & PATH TRAVERSAL DEFENSE
  // ==========================================================================
  it("17. memvalidasi pembacaan file bukti privat dan memastikan pencegahan path traversal", async () => {
    const session = await getOrCreateOrderSession(fx.db, { storeCode: fx.storeCodeActive });
    const validPngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const saveRes = await savePaymentProofFile(fx.db, {
      sessionToken: session.sessionToken,
      fileBuffer: Buffer.concat([validPngHeader, Buffer.alloc(50)]),
      fileName: "struk_transfer.png",
      mimeType: "image/png",
    });

    // Valid read
    const fileData = await readPrivateProofFile(saveRes.fileName);
    expect(fileData).not.toBeNull();
    expect(fileData!.mime).toBe("image/png");
    expect(fileData!.buffer.length).toBeGreaterThan(0);

    // Path traversal attempt
    const traversalAttempt = await readPrivateProofFile("../../../../../etc/passwd");
    expect(traversalAttempt).toBeNull();
  });

  // ==========================================================================
  // SCENARIO 18: DYNAMIC CUSTOMER DEACTIVATION BLOCKS ORDER SESSION
  // ==========================================================================
  it("18. menolak pembuatan sesi order baru saat customer dinonaktifkan secara dinamis", async () => {
    // Deactivate active store temporarily
    await fx.db
      .update(customers)
      .set({ isActive: false })
      .where(eq(customers.id, fx.storeActiveId));

    try {
      await expect(
        getOrCreateOrderSession(fx.db, { storeCode: fx.storeCodeActive }),
      ).rejects.toThrow(BusinessRuleError);
    } finally {
      // Restore active status
      await fx.db
        .update(customers)
        .set({ isActive: true })
        .where(eq(customers.id, fx.storeActiveId));
    }
  });

  // ==========================================================================
  // SCENARIO 19: INACTIVE PRODUCTS AUTOMATICALLY EXCLUDED FROM PUBLIC CATALOG
  // ==========================================================================
  it("19. memastikan produk nonaktif otomatis dikecualikan dari katalog publik", async () => {
    // Mark Apel as inactive
    await fx.db
      .update(products)
      .set({ isActive: false })
      .where(eq(products.id, fx.apelProductId));

    try {
      const catalog = await getPublicFruitCatalog(fx.db, fx.storeCodeActive);
      const apelInCatalog = catalog.products.find((p) => p.id === fx.apelProductId);
      expect(apelInCatalog).toBeUndefined();

      const jerukInCatalog = catalog.products.find((p) => p.id === fx.jerukProductId);
      expect(jerukInCatalog).toBeDefined();
    } finally {
      // Restore Apel to active
      await fx.db
        .update(products)
        .set({ isActive: true })
        .where(eq(products.id, fx.apelProductId));
    }
  });

  // ==========================================================================
  // SCENARIO 20: PREVENT CART MODIFICATION ONCE ORDER IS SUBMITTED
  // ==========================================================================
  it("20. mencegah modifikasi keranjang (cart) setelah pesanan berhasil disubmit", async () => {
    const session = await getOrCreateOrderSession(fx.db, { storeCode: fx.storeCodeActive });
    await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [{ productId: fx.jerukProductId, gradeId: fx.jerukGradeAId, uomCode: "kg", quantity: 3 }],
    });
    const validJpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    await savePaymentProofFile(fx.db, {
      sessionToken: session.sessionToken,
      fileBuffer: Buffer.concat([validJpgHeader, Buffer.alloc(100)]),
      fileName: "bukti.jpg",
      mimeType: "image/jpeg",
    });

    await withTransaction(async (tx) => {
      await submitCustomerOrderRequest(tx, { sessionToken: session.sessionToken });
    });

    // Attempting to update cart on a submitted session must be rejected
    await expect(
      updateSessionCart(fx.db, {
        sessionToken: session.sessionToken,
        cartItems: [{ productId: fx.jerukProductId, gradeId: fx.jerukGradeAId, uomCode: "kg", quantity: 10 }],
      }),
    ).rejects.toThrow(BusinessRuleError);
  });

  // ==========================================================================
  // SCENARIO 21: TIMELINE AUDIT EVENTS RECORDED FOR ORDER LIFECYCLE
  // ==========================================================================
  it("21. merekam seluruh riwayat audit events pada timeline siklus hidup pesanan", async () => {
    const session = await getOrCreateOrderSession(fx.db, { storeCode: fx.storeCodeActive });
    await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [{ productId: fx.jerukProductId, gradeId: fx.jerukGradeAId, uomCode: "kg", quantity: 2 }],
    });
    const validJpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    await savePaymentProofFile(fx.db, {
      sessionToken: session.sessionToken,
      fileBuffer: Buffer.concat([validJpgHeader, Buffer.alloc(100)]),
      fileName: "bukti.jpg",
      mimeType: "image/jpeg",
    });

    const submitRes = await withTransaction(async (tx) => {
      return await submitCustomerOrderRequest(tx, { sessionToken: session.sessionToken });
    });

    const [orderReq] = await fx.db
      .select()
      .from(customerOrderRequests)
      .where(eq(customerOrderRequests.orderNumber, submitRes.orderNumber));

    // Finance verifies payment
    await withTransaction(async (tx) => {
      await verifyCustomerOrderPayment(tx, fx.financeUser, {
        orderRequestId: orderReq!.id,
        action: "verify",
      });
    });

    // Sales confirms order
    await withTransaction(async (tx) => {
      await confirmCustomerOrder(tx, fx.salesUser, {
        orderRequestId: orderReq!.id,
      });
    });

    // Check order details via getCustomerOrderRequestDetails
    const details = await getCustomerOrderRequestDetails(fx.db, fx.salesUser, orderReq!.id);
    expect(details.events.length).toBeGreaterThanOrEqual(3);

    const eventTypes = details.events.map((e) => e.eventType);
    expect(eventTypes).toContain("order_submitted");
    expect(eventTypes).toContain("payment_verified");
    expect(eventTypes).toContain("order_confirmed");

    // Also verify directly in DB table customer_order_request_events
    const dbEvents = await fx.db
      .select()
      .from(customerOrderRequestEvents)
      .where(eq(customerOrderRequestEvents.orderRequestId, orderReq!.id));
    expect(dbEvents.length).toBeGreaterThanOrEqual(3);
  });

  // ==========================================================================
  // SCENARIO 22: PAYMENT PROOF REJECTION WITH REASON
  // ==========================================================================
  it("22. menolak verifikasi pembayaran bukti transfer dengan alasan penolakan yang tercatat", async () => {
    const session = await getOrCreateOrderSession(fx.db, { storeCode: fx.storeCodeActive });
    await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [{ productId: fx.jerukProductId, gradeId: fx.jerukGradeAId, uomCode: "kg", quantity: 1 }],
    });
    const validJpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    await savePaymentProofFile(fx.db, {
      sessionToken: session.sessionToken,
      fileBuffer: Buffer.concat([validJpgHeader, Buffer.alloc(100)]),
      fileName: "bukti.jpg",
      mimeType: "image/jpeg",
    });

    const submitRes = await withTransaction(async (tx) => {
      return await submitCustomerOrderRequest(tx, { sessionToken: session.sessionToken });
    });

    const [orderReq] = await fx.db
      .select()
      .from(customerOrderRequests)
      .where(eq(customerOrderRequests.orderNumber, submitRes.orderNumber));

    // Reject payment proof without reason -> Validation error
    await expect(
      withTransaction(async (tx) => {
        return await verifyCustomerOrderPayment(tx, fx.financeUser, {
          orderRequestId: orderReq!.id,
          action: "reject",
          rejectionReason: "   ",
        });
      }),
    ).rejects.toThrow(ValidationError);

    // Reject payment proof with reason
    const rejectPayRes = await withTransaction(async (tx) => {
      return await verifyCustomerOrderPayment(tx, fx.financeUser, {
        orderRequestId: orderReq!.id,
        action: "reject",
        rejectionReason: "Bukti transfer buram dan nama pengirim tidak cocok",
      });
    });

    expect(rejectPayRes.paymentStatus).toBe("rejected");

    const [updated] = await fx.db
      .select()
      .from(customerOrderRequests)
      .where(eq(customerOrderRequests.id, orderReq!.id));
    expect(updated!.paymentStatus).toBe("rejected");
    expect(updated!.rejectionReason).toContain("buram");
  });

  // ==========================================================================
  // SCENARIO 23: FEFO STOCK RESERVATION UPON SALES ORDER CONFIRMATION
  // ==========================================================================
  it("23. mengalokasikan reservasi stok FEFO secara otomatis saat pesanan dikonfirmasi sales", async () => {
    const session = await getOrCreateOrderSession(fx.db, { storeCode: fx.storeCodeActive });
    await updateSessionCart(fx.db, {
      sessionToken: session.sessionToken,
      cartItems: [{ productId: fx.jerukProductId, gradeId: fx.jerukGradeAId, uomCode: "kg", quantity: 10 }],
    });
    const validJpgHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    await savePaymentProofFile(fx.db, {
      sessionToken: session.sessionToken,
      fileBuffer: Buffer.concat([validJpgHeader, Buffer.alloc(100)]),
      fileName: "bukti.jpg",
      mimeType: "image/jpeg",
    });

    const submitRes = await withTransaction(async (tx) => {
      return await submitCustomerOrderRequest(tx, { sessionToken: session.sessionToken });
    });

    const [orderReq] = await fx.db
      .select()
      .from(customerOrderRequests)
      .where(eq(customerOrderRequests.orderNumber, submitRes.orderNumber));

    const confirmRes = await withTransaction(async (tx) => {
      return await confirmCustomerOrder(tx, fx.salesUser, {
        orderRequestId: orderReq!.id,
      });
    });

    // Check stockReservations table in DB for matching salesOrderId
    const reservations = await fx.db
      .select()
      .from(stockReservations)
      .where(eq(stockReservations.sourceDocId, confirmRes.salesOrderId));

    expect(reservations.length).toBeGreaterThan(0);
    expect(reservations[0]!.productId).toBe(fx.jerukProductId);
    expect(parseFloat(reservations[0]!.reservedQtyBase)).toBe(10);
    expect(reservations[0]!.status).toBe("active");
  });

  // ==========================================================================
  // SCENARIO 24: ROLE-BASED ACCESS CONTROL ON MERCHANT QRIS CONFIG
  // ==========================================================================
  it("24. menolak update konfigurasi QRIS merchant resmi dari pengguna tanpa wewenang", async () => {
    await expect(
      updateMerchantQrisConfig(fx.db, fx.unauthorizedUser, {
        merchantName: "Hacked Merchant",
        nmid: "ID000000000000",
        qrisImageUrl: "https://example.com/fake.png",
        isEnabled: true,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  // ==========================================================================
  // SCENARIO 25: ADMIN INBOX STATUS FILTERING
  // ==========================================================================
  it("25. mendukung filter status pesanan pada inbox admin (pending_review, confirmed, rejected)", async () => {
    // Fetch pending list
    const pendingOrders = await listCustomerOrderRequests(fx.db, fx.salesUser, {
      orderStatus: "pending_review",
    });
    for (const ord of pendingOrders) {
      expect(ord.orderStatus).toBe("pending_review");
    }

    // Fetch confirmed list
    const confirmedOrders = await listCustomerOrderRequests(fx.db, fx.salesUser, {
      orderStatus: "confirmed",
    });
    for (const ord of confirmedOrders) {
      expect(ord.orderStatus).toBe("confirmed");
    }
  });
});
