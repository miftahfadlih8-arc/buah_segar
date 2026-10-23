import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type ActorContext } from "@/server/authz/authorize";
import { withTransaction, type DbClient } from "@/server/db";
import {
  approvals,
  batches,
  priceListHistory,
  productGrades,
  salesOrders,
  stockBalances,
  stockReservations,
} from "@/server/db/schema";
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  IdempotencyConflictError,
} from "@/server/errors";
import {
  approveCustomerCreditNote,
  calculateCustomerCreditExposure,
  createCustomerCreditNote,
  createCustomerInvoice,
  recordCustomerPayment,
  verifyCustomerPayment,
} from "@/server/modules/finance/credit";
import { COSTING_POLICY_SETTING_KEY } from "@/server/modules/inventory/costing";
import {
  applyInventoryMovement,
  reconcileInventoryAndGl,
} from "@/server/modules/inventory/ledger";
import {
  createProduct,
  seedStandardUomsAndPackaging,
  upsertProductUomConversion,
} from "@/server/modules/master/catalog";
import {
  addCustomerContact,
  createCustomer,
  getCustomerCrmProfile,
  listCustomers,
  seedDefaultBekasiZones,
  updateCustomer,
  updateCustomerCreditPolicy,
} from "@/server/modules/master/customers";
import { createSupplier } from "@/server/modules/master/suppliers";
import {
  createWarehouse,
  seedDefaultBekasiWarehouse,
} from "@/server/modules/master/warehouses";
import {
  calculateAndValidateLinePricing,
  createPriceList,
  resolveActivePrice,
  upsertPriceListItem,
} from "@/server/modules/pricing";
import {
  cancelSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
  createSalesQuotation,
  decideSalesOrderApproval,
  transitionSalesOrderFulfillmentStatus,
} from "@/server/modules/sales";
import { setSetting } from "@/server/settings";
import { closeDb, createTestActor, setupTestDb } from "../helpers/test-db";

interface Phase4TestFixtures {
  db: DbClient;
  owner: ActorContext;
  financeUser: ActorContext;
  salesUserWh1: ActorContext;
  salesUserWh2: ActorContext;
  warehouseUser: ActorContext;
  auditorNoPii: ActorContext;
  warehouseId: string;
  warehouse2Id: string;
  coldRoomLocationId: string;
  supplierId: string;
  manggaProductId: string;
  manggaGradeAId: string;
  manggaGradeBId: string;
  customerGrosirId: string;
  customerHorecaId: string;
  priceListGrosirId: string;
}

async function seedStockBatch(
  db: DbClient,
  actor: ActorContext,
  params: {
    batchId: string;
    batchCode: string;
    warehouseId: string;
    locationId: string;
    productId: string;
    gradeId: string;
    gradeCode: string;
    supplierId: string;
    qtyBase: string;
    unitCostBase: string;
    bestBeforeDate: string;
    receivedAt?: Date;
    costingMethod?: string;
  },
) {
  await withTransaction(async (tx) => {
    const totalInitialCost = (
      Number(params.qtyBase) * Number(params.unitCostBase)
    ).toFixed(2);
    await tx.insert(batches).values({
      id: params.batchId,
      batchCode: params.batchCode,
      productId: params.productId,
      gradeId: params.gradeId,
      gradeCode: params.gradeCode,
      supplierId: params.supplierId,
      warehouseId: params.warehouseId,
      originRegion: "Probolinggo, Jawa Timur",
      harvestedAt: new Date("2026-10-19T00:00:00Z"),
      receivedAt: params.receivedAt ?? new Date("2026-10-20T06:00:00Z"),
      bestBeforeDate: params.bestBeforeDate,
      expiresAt: new Date(`${params.bestBeforeDate}T23:59:59Z`),
      ripenessStage: "matang_siap_jual",
      initialQtyBase: params.qtyBase,
      unitCostBase: params.unitCostBase,
      totalInitialCost,
      costingMethod: params.costingMethod ?? "batch_specific_rsv_synthetic_dev",
      status: "active",
    });

    await applyInventoryMovement(tx, actor, {
      warehouseId: params.warehouseId,
      warehouseCode: "BKS-1",
      locationId: params.locationId,
      batchId: params.batchId,
      productId: params.productId,
      gradeId: params.gradeId,
      stockStatus: "available",
      movementType: "grn_receipt",
      qtyDeltaBase: params.qtyBase,
      unitCostBase: params.unitCostBase,
      explicitInflowCost: totalInitialCost,
      sourceDocType: "test_seed_batch",
      sourceDocId: params.batchId,
      notes: "Seed batch awal pengujian Phase 4",
    });
  });
}

async function seedPhase4Fixtures(): Promise<Phase4TestFixtures> {
  const db = await setupTestDb();

  await withTransaction(async (tx) => {
    await seedStandardUomsAndPackaging(tx);
    await seedDefaultBekasiWarehouse(tx);
    await seedDefaultBekasiZones(tx);
  });

  const owner = await createTestActor(db, {
    name: "Owner Bekasi",
    grants: [{ roleCode: "owner" }],
  });
  const financeUser = await createTestActor(db, {
    name: "Staf Keuangan Bekasi",
    grants: [{ roleCode: "finance", warehouseId: "wh_bks1" }],
  });
  const salesUserWh1 = await createTestActor(db, {
    name: "Sales Gudang BKS-1",
    grants: [{ roleCode: "sales", warehouseId: "wh_bks1" }],
  });

  const wh2 = await withTransaction((tx) =>
    createWarehouse(tx, owner, {
      branchId: "br_bekasi_utama",
      code: "BKS-2",
      name: "Gudang Cabang Cikarang BKS-2",
      address: "Kawasan Jababeka Cikarang, Kab. Bekasi",
      isDefault: false,
    }),
  );

  const salesUserWh2 = await createTestActor(db, {
    name: "Sales Gudang BKS-2",
    grants: [{ roleCode: "sales", warehouseId: wh2.id }],
  });
  const warehouseUser = await createTestActor(db, {
    name: "Operator Gudang BKS-1",
    grants: [{ roleCode: "warehouse", warehouseId: "wh_bks1" }],
  });
  const auditorNoPii = await createTestActor(db, {
    name: "Procurement Tanpa PII Pelanggan",
    grants: [{ roleCode: "procurement", warehouseId: "wh_bks1" }],
  });

  const supplier = await withTransaction((tx) =>
    createSupplier(tx, owner, {
      code: "SUP-MNG-P4",
      name: "Petani Mangga Probolinggo",
      supplierType: "petani",
      originRegion: "Probolinggo",
      paymentTermsDays: 7,
      leadTimeDays: 1,
    }),
  );

  // Mangga Harum Manis: minMarginPct = 20.00%, minSellingPrice = Rp 19.000/kg
  // 1 peti = 20 kg
  const mangga = await withTransaction(async (tx) => {
    const p = await createProduct(tx, owner, {
      sku: "MNG-HRM-P4",
      name: "Mangga Harum Manis Grade Ekspor",
      category: "Buah Tropis",
      baseUomCode: "kg",
      defaultShelfLifeDays: 7,
      isCatchWeight: true,
      ripenessTracking: true,
      storageCondition: "cold",
      taxCode: "PPN_EXEMPT",
      minMarginPct: "20.00",
      minSellingPrice: "19000",
      createDefaultGrades: true,
    });
    await upsertProductUomConversion(tx, owner, {
      productId: p.id,
      uomCode: "peti",
      factorToBase: "20.0000",
      isNominal: true,
      requiresActualWeight: true,
      defaultPackagingTypeId: "pkg_peti_kayu",
    });
    return p;
  });

  const grades = await db
    .select()
    .from(productGrades)
    .where(eq(productGrades.productId, mangga.id));
  const gradeA = grades.find((g) => g.code === "A")!;
  const gradeB = grades.find((g) => g.code === "B")!;

  // Seed initial batch of Mangga Grade A: 100 kg @ unit cost Rp 16.000/kg
  // With cost = 16.000/kg and minMarginPct = 20%, minimum price for 20% margin is Rp 20.000/kg:
  // ((20000 - 16000) / 20000) * 100 = 20.00%
  await seedStockBatch(db, warehouseUser, {
    batchId: "bat_p4_mng_a1",
    batchCode: "LOT/BKS-1/2610/00001",
    warehouseId: "wh_bks1",
    locationId: "loc_bks1_cold1",
    productId: mangga.id,
    gradeId: gradeA.id,
    gradeCode: "A",
    supplierId: supplier.id,
    qtyBase: "100.000",
    unitCostBase: "16000.0000",
    bestBeforeDate: "2026-10-28",
  });

  await seedStockBatch(db, warehouseUser, {
    batchId: "bat_p4_mng_b1",
    batchCode: "LOT/BKS-1/2610/00002",
    warehouseId: "wh_bks1",
    locationId: "loc_bks1_cold1",
    productId: mangga.id,
    gradeId: gradeB.id,
    gradeCode: "B",
    supplierId: supplier.id,
    qtyBase: "80.000",
    unitCostBase: "12000.0000",
    bestBeforeDate: "2026-10-28",
  });

  const customerGrosir = await withTransaction((tx) =>
    createCustomer(tx, owner, {
      code: "CUST-GROSIR-01",
      name: "Toko Buah Segar Kranji",
      segment: "toko_buah",
      priceTier: "grosir",
      contactPerson: "H. Ridwan",
      phone: "081299887766",
      whatsapp: "081299887766",
      email: "ridwan@kranjibuah.id",
      shippingAddress: "Jl. Pemuda Pasar Kranji Baru Blok A No. 12, Bekasi Barat",
      deliveryZoneId: "zone_bks_barat",
      assignedWarehouseId: "wh_bks1",
      paymentTermsDays: 14,
      creditLimit: "5000000",
    }),
  );

  const customerHoreca = await withTransaction((tx) =>
    createCustomer(tx, owner, {
      code: "CUST-HORECA-01",
      name: "Hotel Horison Ultima Bekasi",
      segment: "horeca",
      priceTier: "horeca",
      contactPerson: "Chef Hendra",
      phone: "081122334455",
      whatsapp: "081122334455",
      email: "purchasing@horisonbekasi.id",
      shippingAddress: "Jl. KH. Noer Ali Kalimalang, Bekasi Selatan",
      deliveryZoneId: "zone_bks_selatan",
      assignedWarehouseId: "wh_bks1",
      paymentTermsDays: 30,
      creditLimit: "10000000",
    }),
  );

  const plGrosir = await withTransaction(async (tx) => {
    const pl = await createPriceList(tx, financeUser, {
      code: "PL-GROSIR-OCT26",
      name: "Daftar Harga Grosir Bekasi Oktober 2026",
      priceTier: "grosir",
      warehouseId: "wh_bks1",
      effectiveFrom: "2026-10-01",
      effectiveTo: "2026-10-31",
      isActive: true,
      reason: "Penetapan harga grosir Oktober 2026",
    });

    // 1 kg Mangga Grade A = Rp 25.000/kg (margin = (25000-16000)/25000 = 36.00%)
    await upsertPriceListItem(tx, financeUser, {
      priceListId: pl.id,
      productId: mangga.id,
      gradeId: gradeA.id,
      uomCode: "kg",
      minQty: "1.000",
      unitPrice: "25000",
      maxDiscountPct: "10.00",
      reason: "Harga grosir reguler per kg",
    });

    // Tier grosir >= 50 kg Mangga Grade A = Rp 22.500/kg
    await upsertPriceListItem(tx, financeUser, {
      priceListId: pl.id,
      productId: mangga.id,
      gradeId: gradeA.id,
      uomCode: "kg",
      minQty: "50.000",
      unitPrice: "22500",
      maxDiscountPct: "5.00",
      reason: "Harga grosir partai >= 50 kg",
    });

    // 1 peti (20 kg) Mangga Grade A = Rp 500.000/peti (Rp 25.000/kg)
    await upsertPriceListItem(tx, financeUser, {
      priceListId: pl.id,
      productId: mangga.id,
      gradeId: gradeA.id,
      uomCode: "peti",
      minQty: "1.000",
      unitPrice: "500000",
      maxDiscountPct: "10.00",
      reason: "Harga grosir per peti kayu 20 kg",
    });

    return pl;
  });

  return {
    db,
    owner,
    financeUser,
    salesUserWh1,
    salesUserWh2,
    warehouseUser,
    auditorNoPii,
    warehouseId: "wh_bks1",
    warehouse2Id: wh2.id,
    coldRoomLocationId: "loc_bks1_cold1",
    supplierId: supplier.id,
    manggaProductId: mangga.id,
    manggaGradeAId: gradeA.id,
    manggaGradeBId: gradeB.id,
    customerGrosirId: customerGrosir.id,
    customerHorecaId: customerHoreca.id,
    priceListGrosirId: plGrosir.id,
  };
}

describe("Phase 4 Integration Tests — CRM, Pricing, Margin, Sales Orders & Credit Control", () => {
  let fx: Phase4TestFixtures;

  beforeEach(async () => {
    fx = await seedPhase4Fixtures();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("1. CRM pelanggan: profil, kontak, segmen B2C gate, status aktif/nonaktif, warehouse scoping RBAC, dan audit perubahan", async () => {
    // Add primary and secondary contacts
    const contact1 = await withTransaction((tx) =>
      addCustomerContact(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        name: "Ibu Siti (Kasir Toko)",
        roleTitle: "Bagian Pembelian & Pembayaran",
        phone: "081311112222",
        whatsapp: "081311112222",
        email: "siti@kranjibuah.id",
        isPrimary: true,
      }),
    );
    expect(contact1.isPrimary).toBe(true);

    // Sales user scoped to wh2 (BKS-2) CANNOT view or edit customer assigned to wh_bks1
    await expect(
      getCustomerCrmProfile(fx.db, fx.salesUserWh2, fx.customerGrosirId),
    ).rejects.toThrow(ForbiddenError);

    await expect(
      withTransaction((tx) =>
        addCustomerContact(tx, fx.salesUserWh2, {
          customerId: fx.customerGrosirId,
          name: "Kontak Ilegal",
          roleTitle: "Sales",
        }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Segment B2C (konsumen_langsung) is blocked when sales.enable_direct_consumer is false
    await expect(
      withTransaction((tx) =>
        createCustomer(tx, fx.salesUserWh1, {
          code: "CUST-B2C-01",
          name: "Bapak Budi Perorangan",
          segment: "konsumen_langsung",
          priceTier: "ritel",
          shippingAddress: "Perumahan Galaxy Jl. Taman Aster No. 5, Bekasi Selatan",
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Profile 360 view for authorized salesUserWh1 returns contacts, credit exposure, and audit logs
    const crm360 = await getCustomerCrmProfile(fx.db, fx.salesUserWh1, fx.customerGrosirId);
    expect(crm360.customer.code).toBe("CUST-GROSIR-01");
    expect(crm360.contacts.length).toBe(1);
    expect(crm360.creditExposure.creditLimit).toBe("5000000.00");
    expect(crm360.auditHistory.length).toBeGreaterThanOrEqual(1);

    // Deactivating customer blocks order creation and records audit log
    await withTransaction((tx) =>
      updateCustomer(tx, fx.salesUserWh1, {
        id: fx.customerGrosirId,
        code: "CUST-GROSIR-01",
        name: "Toko Buah Segar Kranji (Nonaktif Sementara)",
        segment: "toko_buah",
        priceTier: "grosir",
        shippingAddress: "Jl. Pemuda Pasar Kranji Baru Blok A No. 12, Bekasi Barat",
        assignedWarehouseId: "wh_bks1",
        paymentTermsDays: 14,
        isActive: false,
        expectedVersion: crm360.customer.version,
      }),
    );

    await expect(
      withTransaction((tx) =>
        createSalesOrder(tx, fx.salesUserWh1, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          orderDate: "2026-10-21",
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              orderedUomCode: "kg",
              orderedQty: "10",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/nonaktif/i);

    const updatedCustomers = await listCustomers(fx.db, fx.salesUserWh1, {
      warehouseId: fx.warehouseId,
    });
    expect(updatedCustomers.length).toBe(2);
  });

  it("2. Lookup harga aktif berdasarkan produk, grade, unit, segmen, minQty, periode berlaku, dan imutabilitas histori harga", async () => {
    // 10 kg on 2026-10-21 resolves to minQty=1.000 tier (Rp 25.000/kg)
    const price10kg = await resolveActivePrice(fx.db, {
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      uomCode: "kg",
      orderedQty: (await import("@/lib/money")).parseMoney("10"),
      customerSegment: "toko_buah",
      priceTier: "grosir",
      warehouseId: fx.warehouseId,
      documentDate: "2026-10-21",
    });
    expect(price10kg).not.toBeNull();
    expect(price10kg!.priceListItem.unitPrice).toBe("25000.0000");

    // 60 kg on 2026-10-21 resolves to minQty=50.000 tier (Rp 22.500/kg)
    const price60kg = await resolveActivePrice(fx.db, {
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      uomCode: "kg",
      orderedQty: (await import("@/lib/money")).parseMoney("60"),
      customerSegment: "toko_buah",
      priceTier: "grosir",
      warehouseId: fx.warehouseId,
      documentDate: "2026-10-21",
    });
    expect(price60kg).not.toBeNull();
    expect(price60kg!.priceListItem.unitPrice).toBe("22500.0000");

    // Date outside effective period (2026-11-15 > 2026-10-31) returns null
    const expiredLookup = await resolveActivePrice(fx.db, {
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      uomCode: "kg",
      orderedQty: (await import("@/lib/money")).parseMoney("10"),
      customerSegment: "toko_buah",
      priceTier: "grosir",
      warehouseId: fx.warehouseId,
      documentDate: "2026-11-15",
    });
    expect(expiredLookup).toBeNull();

    // Updating item price appends to price_list_history; trigger blocks UPDATE/DELETE on price_list_history
    await withTransaction((tx) =>
      upsertPriceListItem(tx, fx.financeUser, {
        priceListId: fx.priceListGrosirId,
        productId: fx.manggaProductId,
        gradeId: fx.manggaGradeAId,
        uomCode: "kg",
        minQty: "1.000",
        unitPrice: "26000",
        maxDiscountPct: "10.00",
        reason: "Kenaikan harga mangga pasar induk",
      }),
    );

    const historyRows = await fx.db
      .select()
      .from(priceListHistory)
      .where(eq(priceListHistory.priceListId, fx.priceListGrosirId));
    expect(historyRows.length).toBeGreaterThanOrEqual(4);

    // Immutability trigger blocks direct mutation on price_list_history
    await expect(
      fx.db.execute(sql`DELETE FROM price_list_history WHERE id = ${historyRows[0]!.id}`),
    ).rejects.toThrow();
  });

  it("3. Konversi unit pada quotation dan sales order konsisten dengan master UoM (peti -> kg)", async () => {
    // 3 peti (factor 20.0000 kg/peti = 60.000 kg) @ Rp 500.000/peti (Rp 25.000/kg), diskon 4%
    // Net unit price per peti = Rp 480.000, net unit price per kg = Rp 24.000/kg
    // Line net/total = 3 * 480.000 = Rp 1.440.000,00
    // Margin % = ((24000 - 16000) / 24000) * 100 = 33.33%
    const sq = await withTransaction((tx) =>
      createSalesQuotation(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        quoteDate: "2026-10-21",
        validUntil: "2026-10-25",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "peti",
            orderedQty: "3",
            discountPct: "4",
          },
        ],
      }),
    );

    const line = sq.lines[0]!;
    expect(line.orderedUomCode).toBe("peti");
    expect(line.orderedQty).toBe("3.000");
    expect(line.uomFactorToBaseSnapshot).toBe("20.0000");
    expect(line.orderedQtyBase).toBe("60.000");
    expect(line.listUnitPrice).toBe("500000.0000");
    expect(line.netUnitPrice).toBe("480000.0000");
    expect(line.netUnitPriceBase).toBe("24000.0000");
    expect(line.unitCostBasisBase).toBe("16000.0000");
    expect(line.marginPct).toBe("33.33");
    expect(line.lineGrossAmount).toBe("1500000.00");
    expect(line.lineDiscountAmount).toBe("60000.00");
    expect(line.lineNetAmount).toBe("1440000.00");
    expect(line.lineTotalAmount).toBe("1440000.00");
    expect(sq.header.grandTotalAmount).toBe("1440000.00");
  });

  it("4. Pembuatan quotation dan konversi menjadi sales order menyimpan snapshot lengkap serta mencegah konversi ganda", async () => {
    const sq = await withTransaction((tx) =>
      createSalesQuotation(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        quoteDate: "2026-10-21",
        validUntil: "2026-10-26",
        shippingFeeAmount: "35000",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "20",
          },
        ],
      }),
    );
    expect(sq.header.status).toBe("sent");
    expect(sq.header.grandTotalAmount).toBe("535000.00"); // 20 * 25.000 + 35.000

    const so = await withTransaction((tx) =>
      createSalesOrder(tx, fx.salesUserWh1, {
        quotationId: sq.header.id,
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        orderDate: "2026-10-22",
      }),
    );
    expect(so.header.quotationId).toBe(sq.header.id);
    expect(so.header.status).toBe("submitted");
    expect(so.header.grandTotalAmount).toBe("535000.00");
    expect(so.lines.length).toBe(1);
    expect(so.lines[0]!.orderedQtyBase).toBe("20.000");

    // Converting the same quotation a second time is rejected with ConflictError
    await expect(
      withTransaction((tx) =>
        createSalesOrder(tx, fx.salesUserWh1, {
          quotationId: sq.header.id,
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          orderDate: "2026-10-22",
        }),
      ),
    ).rejects.toThrow(ConflictError);
  });

  it("5. Quotation yang sudah kedaluwarsa tidak dapat dikonversi menjadi sales order", async () => {
    const expiredSq = await withTransaction((tx) =>
      createSalesQuotation(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        quoteDate: "2026-10-01",
        validUntil: "2026-10-07",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "10",
          },
        ],
      }),
    );

    await expect(
      withTransaction((tx) =>
        createSalesOrder(tx, fx.salesUserWh1, {
          quotationId: expiredSq.header.id,
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          orderDate: "2026-10-21",
        }),
      ),
    ).rejects.toThrow(/kedaluwarsa/i);
  });

  it("6. Kontrol margin: harga di atas minimum margin lulus; harga di bawah minimum margin ditolak atau masuk pending_approval; serta gate costing produksi tetap aktif", async () => {
    // 6a. Production costing gate blocks using synthetic batch costs as production margin cost basis
    await expect(
      withTransaction((tx) =>
        calculateAndValidateLinePricing(tx, {
          warehouseId: fx.warehouseId,
          customerSegment: "toko_buah",
          priceTier: "grosir",
          documentDate: "2026-10-21",
          productId: fx.manggaProductId,
          gradeId: fx.manggaGradeAId,
          orderedUomCode: "kg",
          orderedQty: "10",
          enforceProductionCostingGate: true,
        }),
      ),
    ).rejects.toThrow(/BLOCKED/i);

    // Even if setting is marked approved, a batch whose costingMethod is still synthetic is blocked in production mode
    await withTransaction((tx) =>
      setSetting(tx, fx.owner, {
        key: COSTING_POLICY_SETTING_KEY,
        value: {
          approvedByOwner: true,
          approvedByAccountant: true,
          policyVersion: "1.0",
        },
        reason: "Uji gate batch sintetis",
      }),
    );
    await expect(
      withTransaction((tx) =>
        calculateAndValidateLinePricing(tx, {
          warehouseId: fx.warehouseId,
          customerSegment: "toko_buah",
          priceTier: "grosir",
          documentDate: "2026-10-21",
          productId: fx.manggaProductId,
          gradeId: fx.manggaGradeAId,
          orderedUomCode: "kg",
          orderedQty: "10",
          enforceProductionCostingGate: true,
        }),
      ),
    ).rejects.toThrow(/BLOCKED/i);

    // Reset costing policy to unapproved default
    await withTransaction((tx) =>
      setSetting(tx, fx.owner, {
        key: COSTING_POLICY_SETTING_KEY,
        value: {
          approvedByOwner: false,
          approvedByAccountant: false,
          policyVersion: "1.0",
        },
        reason: "Kembalikan gate costing",
      }),
    );

    // 6b. Order above min margin (Rp 25.000/kg -> margin 36.00% >= 20.00%) passes directly
    const normalOrder = await withTransaction((tx) =>
      createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        orderDate: "2026-10-21",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "10",
          },
        ],
      }),
    );
    expect(normalOrder.header.status).toBe("submitted");
    expect(normalOrder.header.requiresMarginApproval).toBe(false);

    // 6c. Order below min margin (customUnitPrice Rp 18.000/kg -> margin 11.11% < 20.00% and < minSellingPrice Rp 19.000)
    // Rejected when requestMarginOverride is false
    await expect(
      withTransaction((tx) =>
        createSalesOrder(tx, fx.salesUserWh1, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          orderDate: "2026-10-21",
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              orderedUomCode: "kg",
              orderedQty: "10",
              customUnitPrice: "18000",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/Kontrol Margin/i);

    // 6d. Enters pending_approval when requestMarginOverride=true with valid reason
    const overrideOrder = await withTransaction((tx) =>
      createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        orderDate: "2026-10-21",
        requestMarginOverride: true,
        marginOverrideReason: "Cuci gudang stok mendekati matang penuh untuk pelanggan loyal",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "10",
            customUnitPrice: "18000",
          },
        ],
      }),
    );
    expect(overrideOrder.header.status).toBe("pending_approval");
    expect(overrideOrder.header.requiresMarginApproval).toBe(true);
    expect(overrideOrder.header.marginApprovalId).toBeTruthy();
  });

  it("7. Manipulasi harga, diskon, HPP, margin, atau total dari browser/client ditolak oleh server", async () => {
    // 7a. Tampered line total (10 kg * Rp 25.000 = Rp 250.000, client asserts Rp 100.000)
    await expect(
      withTransaction((tx) =>
        createSalesOrder(tx, fx.salesUserWh1, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          orderDate: "2026-10-21",
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              orderedUomCode: "kg",
              orderedQty: "10",
              clientAssertedLineTotalAmount: "100000",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/Manipulasi total baris terdeteksi/i);

    // 7b. Tampered grand total
    await expect(
      withTransaction((tx) =>
        createSalesOrder(tx, fx.salesUserWh1, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          orderDate: "2026-10-21",
          clientAssertedGrandTotalAmount: "50000",
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              orderedUomCode: "kg",
              orderedQty: "10",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/Manipulasi total order terdeteksi/i);

    // 7c. Tampered cost basis to fake passing margin check
    await expect(
      withTransaction((tx) =>
        createSalesOrder(tx, fx.salesUserWh1, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          orderDate: "2026-10-21",
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              orderedUomCode: "kg",
              orderedQty: "10",
              customUnitPrice: "18000",
              clientAssertedUnitCostBasisBase: "5000",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/Manipulasi HPP terdeteksi/i);

    // 7d. Tampered margin % assertion
    await expect(
      withTransaction((tx) =>
        createSalesOrder(tx, fx.salesUserWh1, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          orderDate: "2026-10-21",
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              orderedUomCode: "kg",
              orderedQty: "10",
              customUnitPrice: "18000",
              clientAssertedMarginPct: "50.00",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/Manipulasi margin terdeteksi/i);
  });

  it("8. Approval override harga/margin mencatat alasan dan identitas approver serta memblokir self-approval oleh pemohon non-owner", async () => {
    const lowMarginOrder = await withTransaction((tx) =>
      createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        orderDate: "2026-10-21",
        requestMarginOverride: true,
        marginOverrideReason: "Diskon khusus pembukaan cabang baru pelanggan",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "10",
            customUnitPrice: "18500",
          },
        ],
      }),
    );
    expect(lowMarginOrder.header.status).toBe("pending_approval");

    // Sales user cannot approve their own request (lacks approvals.decide)
    await expect(
      withTransaction((tx) =>
        decideSalesOrderApproval(tx, fx.salesUserWh1, {
          salesOrderId: lowMarginOrder.header.id,
          decision: "approved",
          decisionNote: "Setuju sendiri",
        }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Cannot confirm while still pending_approval
    await expect(
      withTransaction((tx) =>
        confirmSalesOrder(tx, fx.salesUserWh1, {
          salesOrderId: lowMarginOrder.header.id,
        }),
      ),
    ).rejects.toThrow(/pending_approval/i);

    // Owner approves the override with reason
    const approved = await withTransaction((tx) =>
      decideSalesOrderApproval(tx, fx.owner, {
        salesOrderId: lowMarginOrder.header.id,
        decision: "approved",
        decisionNote: "Disetujui Owner untuk akuisisi pelanggan strategis Kranji",
      }),
    );
    expect(approved.header.status).toBe("submitted");

    const [appRecord] = await fx.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, lowMarginOrder.header.marginApprovalId!));
    expect(appRecord!.status).toBe("approved");
    expect(appRecord!.decidedBy).toBe(fx.owner.user.id);
    expect(appRecord!.decisionNote).toBe(
      "Disetujui Owner untuk akuisisi pelanggan strategis Kranji",
    );
  });

  it("9. Kredit pelanggan: order di dalam limit lulus, order melebihi limit atau saat credit hold ditolak atau memerlukan credit_limit_override approval", async () => {
    // Customer Grosir has creditLimit = Rp 5.000.000, paymentTermsDays = 14
    // Order 1: 120 kg -> wait, stock is 100 kg, let's order 6 peti (120 kg) without auto-confirm, or 4 peti (80 kg) = Rp 4.000.000
    const order1 = await withTransaction((tx) =>
      createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        orderDate: "2026-10-21",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "peti",
            orderedQty: "8", // 8 * 500.000 = Rp 4.000.000 <= Rp 5.000.000
          },
        ],
      }),
    );
    expect(order1.header.status).toBe("submitted");
    expect(order1.header.grandTotalAmount).toBe("4000000.00");

    // Order 2: 3 peti = Rp 1.500.000 -> Projected Exposure = 4.000.000 + 1.500.000 = Rp 5.500.000 > Rp 5.000.000
    // Rejected by default
    await expect(
      withTransaction((tx) =>
        createSalesOrder(tx, fx.salesUserWh1, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          orderDate: "2026-10-21",
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              orderedUomCode: "peti",
              orderedQty: "3",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/Kontrol Kredit/i);

    // Order 2 with requestCreditOverride=true enters pending_approval
    const order2Override = await withTransaction((tx) =>
      createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        orderDate: "2026-10-21",
        requestCreditOverride: true,
        creditOverrideReason: "Pelanggan sedang proses transfer pelunasan giro sore ini",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "peti",
            orderedQty: "3",
          },
        ],
      }),
    );
    expect(order2Override.header.status).toBe("pending_approval");
    expect(order2Override.header.requiresCreditApproval).toBe(true);
    expect(order2Override.header.creditApprovalId).toBeTruthy();
  });

  it("10 & 11. Eksposur kredit sintetis manual vs sistem: invoice belum lunas, pembayaran parsial, deposit terverifikasi, credit note disetujui, perubahan limit finance, serta pembayaran/retur belum diverifikasi TIDAK mengurangi eksposur", async () => {
    /**
     * MANUAL SYNTHETIC CREDIT EXPOSURE DATASET (CUST-GROSIR-01):
     * - Initial Credit Limit: Rp 5.000.000,00
     * 1) Posted Invoice INV-1 = Rp 3.000.000,00
     * 2) Partial Verified Payment on INV-1 = Rp 1.200.000,00
     *    -> Outstanding Invoices = 3.000.000 - 1.200.000 = Rp 1.800.000,00
     * 3) Open Uninvoiced Credit Sales Order SO-1 (40 kg * Rp 25.000) = Rp 1.000.000,00
     *    -> Open Uninvoiced Credit Orders = Rp 1.000.000,00
     * 4) Verified Unapplied Deposit DEP-1 = Rp 400.000,00
     *    -> Verified Unapplied Payments = Rp 400.000,00
     * 5) Approved Unapplied Return / Credit Note CN-1 = Rp 250.000,00
     *    -> Approved Unapplied Credit Notes = Rp 250.000,00
     *
     * Manual Calculation #1:
     *   NetCreditExposure = 1.800.000 + 1.000.000 - 400.000 - 250.000 = Rp 2.150.000,00
     *   AvailableCredit   = 5.000.000 - 2.150.000 = Rp 2.850.000,00
     *
     * 6) Unverified Manual Payment PAY-UNVERIFIED = Rp 900.000,00 (pending_verification)
     * 7) Unapproved Draft Return Credit Note CN-DRAFT = Rp 350.000,00 (draft)
     *   -> Neither reduces exposure! NetCreditExposure MUST remain Rp 2.150.000,00!
     *
     * 8) Finance increases Credit Limit from Rp 5.000.000,00 to Rp 7.500.000,00:
     *   -> NetCreditExposure = Rp 2.150.000,00
     *   -> AvailableCredit   = 7.500.000 - 2.150.000 = Rp 5.350.000,00
     */

    // Step 1: Create Posted Invoice INV-1 for Rp 3.000.000
    const inv1 = await withTransaction((tx) =>
      createCustomerInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        invoiceDate: "2026-10-15",
        dueDate: "2026-10-29",
        totalAmount: "3000000",
        notes: "Tagihan pengiriman awal Oktober",
      }),
    );
    expect(inv1.outstandingAmount).toBe("3000000.00");

    // Step 2: Record & Verify Partial Payment of Rp 1.200.000 against INV-1
    await withTransaction((tx) =>
      recordCustomerPayment(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        invoiceId: inv1.id,
        paymentType: "invoice_payment",
        paymentMethod: "bank_transfer",
        paymentDate: "2026-10-18",
        amount: "1200000",
        autoVerify: true,
      }),
    );

    // Step 3: Create Open Uninvoiced Credit Order SO-1 for 40 kg * Rp 25.000 = Rp 1.000.000
    await withTransaction((tx) =>
      createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        orderDate: "2026-10-21",
        paymentTermsDays: 14,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "40",
          },
        ],
      }),
    );

    // Step 4: Record & Verify Unapplied Deposit DEP-1 for Rp 400.000
    await withTransaction((tx) =>
      recordCustomerPayment(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        paymentType: "deposit",
        paymentMethod: "bank_transfer",
        paymentDate: "2026-10-20",
        amount: "400000",
        autoVerify: true,
      }),
    );

    // Step 5: Create & Approve Unapplied Credit Note CN-1 for Rp 250.000
    await withTransaction((tx) =>
      createCustomerCreditNote(tx, fx.owner, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        sourceType: "sales_return",
        issueDate: "2026-10-20",
        totalAmount: "250000",
        reason: "Retur 10 kg mangga memar saat pengiriman",
        autoApprove: true,
      }),
    );

    const expAfterVerified = await calculateCustomerCreditExposure(fx.db, fx.customerGrosirId);
    expect(expAfterVerified.outstandingInvoicesAmount).toBe("1800000.00");
    expect(expAfterVerified.openUninvoicedCreditOrdersAmount).toBe("1000000.00");
    expect(expAfterVerified.verifiedUnappliedPaymentsAmount).toBe("400000.00");
    expect(expAfterVerified.approvedUnappliedCreditNotesAmount).toBe("250000.00");
    expect(expAfterVerified.netCreditExposure).toBe("2150000.00");
    expect(expAfterVerified.availableCredit).toBe("2850000.00");

    // Step 6 & 7: Record UNVERIFIED manual payment (Rp 900.000) and UNAPPROVED draft credit note (Rp 350.000)
    const unverifiedPay = await withTransaction((tx) =>
      recordCustomerPayment(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        invoiceId: inv1.id,
        paymentType: "invoice_payment",
        paymentMethod: "cash",
        paymentDate: "2026-10-21",
        amount: "900000",
        autoVerify: false, // Pending verification!
      }),
    );
    expect(unverifiedPay.verificationStatus).toBe("pending_verification");

    const draftCn = await withTransaction((tx) =>
      createCustomerCreditNote(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        sourceType: "quality_claim",
        issueDate: "2026-10-21",
        totalAmount: "350000",
        reason: "Klaim kualitas belum diverifikasi QC/Finance",
        autoApprove: false, // Draft!
      }),
    );
    expect(draftCn.status).toBe("draft");

    // Verify neither unverified payment nor draft return reduces credit exposure!
    const expWithUnverified = await calculateCustomerCreditExposure(fx.db, fx.customerGrosirId);
    expect(expWithUnverified.unverifiedPaymentsAmount).toBe("900000.00");
    expect(expWithUnverified.unapprovedCreditNotesAmount).toBe("350000.00");
    expect(expWithUnverified.netCreditExposure).toBe("2150000.00");
    expect(expWithUnverified.availableCredit).toBe("2850000.00");

    // Step 8: Finance updates creditLimit to Rp 7.500.000
    await withTransaction((tx) =>
      updateCustomerCreditPolicy(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        creditLimit: "7500000",
        paymentTermsDays: 14,
        creditHold: false,
        reason: "Kenaikan plafon kredit musim panen mangga",
        expectedVersion: 1,
      }),
    );

    const expAfterLimitChange = await calculateCustomerCreditExposure(fx.db, fx.customerGrosirId);
    expect(expAfterLimitChange.creditLimit).toBe("7500000.00");
    expect(expAfterLimitChange.netCreditExposure).toBe("2150000.00");
    expect(expAfterLimitChange.availableCredit).toBe("5350000.00");

    // Finally, when Finance verifies the Rp 900.000 payment and approves the Rp 350.000 credit note:
    // NetCreditExposure = 2.150.000 - 900.000 - 350.000 = Rp 900.000,00
    // AvailableCredit = 7.500.000 - 900.000 = Rp 6.600.000,00
    await withTransaction(async (tx) => {
      await verifyCustomerPayment(tx, fx.financeUser, {
        paymentId: unverifiedPay.id,
        reason: "Setoran tunai telah diterima kasir pusat",
      });
      await approveCustomerCreditNote(tx, fx.financeUser, {
        creditNoteId: draftCn.id,
        reason: "Bukti foto QC klaim kualitas disetujui",
      });
    });

    const expFinal = await calculateCustomerCreditExposure(fx.db, fx.customerGrosirId);
    expect(expFinal.outstandingInvoicesAmount).toBe("900000.00");
    expect(expFinal.approvedUnappliedCreditNotesAmount).toBe("600000.00");
    expect(expFinal.netCreditExposure).toBe("900000.00");
    expect(expFinal.availableCredit).toBe("6600000.00");
  });

  it("12. Idempotency pada pembuatan sales order mencegah duplikasi order dan menolak perubahan payload", async () => {
    const payload = {
      idempotencyKey: "idem-so-bks1-001",
      customerId: fx.customerGrosirId,
      warehouseId: fx.warehouseId,
      orderDate: "2026-10-21",
      lines: [
        {
          productId: fx.manggaProductId,
          gradeId: fx.manggaGradeAId,
          orderedUomCode: "kg",
          orderedQty: "15",
        },
      ],
    };

    const firstCall = await withTransaction((tx) =>
      createSalesOrder(tx, fx.salesUserWh1, payload),
    );
    const secondCall = await withTransaction((tx) =>
      createSalesOrder(tx, fx.salesUserWh1, payload),
    );

    expect(secondCall.header.id).toBe(firstCall.header.id);
    expect(secondCall.header.soNumber).toBe(firstCall.header.soNumber);

    const allOrders = await fx.db.select().from(salesOrders);
    expect(allOrders.length).toBe(1);

    // Same idempotencyKey with different quantity throws IdempotencyConflictError
    await expect(
      withTransaction((tx) =>
        createSalesOrder(tx, fx.salesUserWh1, {
          ...payload,
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              orderedUomCode: "kg",
              orderedQty: "25",
            },
          ],
        }),
      ),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("13. Reservasi stok FEFO saat konfirmasi order dan pelepasan reservasi saat pembatalan order tanpa mengurangi stok fisik", async () => {
    // Seed an earlier-expiring batch (2026-10-24, 30 kg) so we have:
    // - Batch Early (bat_p4_mng_early): 30 kg, expires 2026-10-24
    // - Batch Main  (bat_p4_mng_a1):   100 kg, expires 2026-10-28
    await seedStockBatch(fx.db, fx.warehouseUser, {
      batchId: "bat_p4_mng_early",
      batchCode: "LOT/BKS-1/2610/00000",
      warehouseId: fx.warehouseId,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "30.000",
      unitCostBase: "16000.0000",
      bestBeforeDate: "2026-10-24",
      receivedAt: new Date("2026-10-18T06:00:00Z"),
    });

    // Create order for 45 kg (not confirmed yet -> no reservation yet)
    const createdSo = await withTransaction((tx) =>
      createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        orderDate: "2026-10-21",
        reserveStockOnConfirm: true,
        autoConfirm: false,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "45",
          },
        ],
      }),
    );
    expect(createdSo.header.status).toBe("submitted");
    expect(createdSo.header.isStockReserved).toBe(false);

    // Confirm order -> reserves 30 kg from bat_p4_mng_early (FEFO first) + 15 kg from bat_p4_mng_a1
    const confirmedSo = await withTransaction((tx) =>
      confirmSalesOrder(tx, fx.salesUserWh1, {
        salesOrderId: createdSo.header.id,
      }),
    );
    expect(confirmedSo.header.status).toBe("confirmed");
    expect(confirmedSo.header.isStockReserved).toBe(true);
    expect(confirmedSo.lines[0]!.reservedQtyBase).toBe("45.000");
    expect(confirmedSo.reservations.length).toBe(2);
    expect(confirmedSo.reservations[0]!.batchId).toBe("bat_p4_mng_early");
    expect(confirmedSo.reservations[0]!.reservedQtyBase).toBe("30.000");
    expect(confirmedSo.reservations[1]!.batchId).toBe("bat_p4_mng_a1");
    expect(confirmedSo.reservations[1]!.reservedQtyBase).toBe("15.000");

    // Verify stock_balances:
    // bat_p4_mng_early: available = 0.000, reserved = 30.000
    // bat_p4_mng_a1:    available = 85.000, reserved = 15.000
    // Total physical stock across Grade A is still 130.000 kg!
    const balancesAfterConfirm = await fx.db
      .select()
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.warehouseId, fx.warehouseId),
          eq(stockBalances.productId, fx.manggaProductId),
          eq(stockBalances.gradeId, fx.manggaGradeAId),
        ),
      );

    const earlyAvail = balancesAfterConfirm.find(
      (b) => b.batchId === "bat_p4_mng_early" && b.stockStatus === "available",
    )!;
    const earlyRes = balancesAfterConfirm.find(
      (b) => b.batchId === "bat_p4_mng_early" && b.stockStatus === "reserved",
    )!;
    const mainAvail = balancesAfterConfirm.find(
      (b) => b.batchId === "bat_p4_mng_a1" && b.stockStatus === "available",
    )!;
    const mainRes = balancesAfterConfirm.find(
      (b) => b.batchId === "bat_p4_mng_a1" && b.stockStatus === "reserved",
    )!;

    expect(earlyAvail.qtyBase).toBe("0.000");
    expect(earlyRes.qtyBase).toBe("30.000");
    expect(mainAvail.qtyBase).toBe("85.000");
    expect(mainRes.qtyBase).toBe("15.000");

    // Cancel the confirmed order -> releases both reservations back to available
    const cancelledSo = await withTransaction((tx) =>
      cancelSalesOrder(tx, fx.salesUserWh1, {
        salesOrderId: createdSo.header.id,
        cancelReason: "Pelanggan meminta penjadwalan ulang pengiriman minggu depan",
      }),
    );
    expect(cancelledSo.header.status).toBe("cancelled");
    expect(cancelledSo.header.isStockReserved).toBe(false);
    expect(cancelledSo.releasedReservations.length).toBe(2);

    const balancesAfterCancel = await fx.db
      .select()
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.warehouseId, fx.warehouseId),
          eq(stockBalances.productId, fx.manggaProductId),
          eq(stockBalances.gradeId, fx.manggaGradeAId),
        ),
      );

    const earlyAvailRestored = balancesAfterCancel.find(
      (b) => b.batchId === "bat_p4_mng_early" && b.stockStatus === "available",
    )!;
    const earlyResRestored = balancesAfterCancel.find(
      (b) => b.batchId === "bat_p4_mng_early" && b.stockStatus === "reserved",
    )!;
    const mainAvailRestored = balancesAfterCancel.find(
      (b) => b.batchId === "bat_p4_mng_a1" && b.stockStatus === "available",
    )!;
    const mainResRestored = balancesAfterCancel.find(
      (b) => b.batchId === "bat_p4_mng_a1" && b.stockStatus === "reserved",
    )!;

    expect(earlyAvailRestored.qtyBase).toBe("30.000");
    expect(earlyResRestored.qtyBase).toBe("0.000");
    expect(mainAvailRestored.qtyBase).toBe("100.000");
    expect(mainResRestored.qtyBase).toBe("0.000");

    // Verify inventory ledger <-> stock_balances reconciliation is 100% clean
    const recon = await reconcileInventoryAndGl(fx.db, fx.owner, {
      warehouseId: fx.warehouseId,
    });
    expect(recon.qtyVarianceBase).toBe("0.000");
    expect(recon.ledgerVsBalanceValueVariance).toBe("0.00");
    expect(recon.ledgerBalanceDiscrepancies).toHaveLength(0);
  });

  it("14. Pembatalan ditolak jika sales order sudah memasuki tahap picking, packing, pengiriman, atau invoice", async () => {
    const so = await withTransaction((tx) =>
      createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        orderDate: "2026-10-21",
        autoConfirm: true,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "10",
          },
        ],
      }),
    );
    expect(so.header.status).toBe("confirmed");

    // Transition to picking
    await withTransaction((tx) =>
      transitionSalesOrderFulfillmentStatus(tx, fx.warehouseUser, {
        salesOrderId: so.header.id,
        nextStatus: "picking",
      }),
    );

    // Attempt to cancel while in picking -> rejected!
    await expect(
      withTransaction((tx) =>
        cancelSalesOrder(tx, fx.salesUserWh1, {
          salesOrderId: so.header.id,
          cancelReason: "Coba batalkan saat sedang di-pick",
        }),
      ),
    ).rejects.toThrow(/melewati batas operasional pembatalan/i);

    // Reservation remains active and untouched
    const activeRes = await fx.db
      .select()
      .from(stockReservations)
      .where(
        and(
          eq(stockReservations.sourceDocId, so.header.id),
          eq(stockReservations.status, "active"),
        ),
      );
    expect(activeRes.length).toBe(1);
    expect(activeRes[0]!.reservedQtyBase).toBe("10.000");
  });

  it("15. Concurrency: dua order paralel terhadap credit limit atau stok FEFO yang sama tidak boleh keduanya lolos jika melampaui batas", async () => {
    // 15A. Parallel Credit Limit Concurrency Race:
    // Customer Grosir has creditLimit = Rp 5.000.000.
    // Two parallel transactions each attempt to create a credit order for 6 peti = Rp 3.000.000.
    // Total if both passed = Rp 6.000.000 > Rp 5.000.000.
    // Row lock `SELECT ... FROM customers WHERE id = $1 FOR UPDATE` serializes them so exactly 1 succeeds and 1 fails!
    const creditRaceResults = await Promise.allSettled([
      withTransaction((tx) =>
        createSalesOrder(tx, fx.salesUserWh1, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          orderDate: "2026-10-21",
          paymentTermsDays: 14,
          reserveStockOnConfirm: false,
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              orderedUomCode: "peti",
              orderedQty: "6", // Rp 3.000.000
            },
          ],
        }),
      ),
      withTransaction((tx) =>
        createSalesOrder(tx, fx.salesUserWh1, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          orderDate: "2026-10-21",
          paymentTermsDays: 14,
          reserveStockOnConfirm: false,
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              orderedUomCode: "peti",
              orderedQty: "6", // Rp 3.000.000
            },
          ],
        }),
      ),
    ]);

    const creditFulfilled = creditRaceResults.filter((r) => r.status === "fulfilled");
    const creditRejected = creditRaceResults.filter((r) => r.status === "rejected");
    expect(creditFulfilled.length).toBe(1);
    expect(creditRejected.length).toBe(1);

    const exposureAfterRace = await calculateCustomerCreditExposure(fx.db, fx.customerGrosirId);
    expect(exposureAfterRace.netCreditExposure).toBe("3000000.00");
    expect(exposureAfterRace.availableCredit).toBe("2000000.00");

    // 15B. Parallel Stock Reservation Concurrency Race:
    // Available Mangga Grade A stock in wh_bks1 is 100 kg.
    // Two parallel cash orders (paymentTermsDays = 0, so no credit limit constraint) each request
    // autoConfirm + FEFO reservation for 60 kg (total 120 kg > 100 kg available).
    // Row lock `FOR UPDATE OF sb` on `stock_balances` guarantees 1 succeeds and 1 fails!
    const stockRaceResults = await Promise.allSettled([
      withTransaction((tx) =>
        createSalesOrder(tx, fx.salesUserWh1, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          orderDate: "2026-10-21",
          paymentTermsDays: 0,
          reserveStockOnConfirm: true,
          autoConfirm: true,
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              orderedUomCode: "kg",
              orderedQty: "60",
            },
          ],
        }),
      ),
      withTransaction((tx) =>
        createSalesOrder(tx, fx.salesUserWh1, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          orderDate: "2026-10-21",
          paymentTermsDays: 0,
          reserveStockOnConfirm: true,
          autoConfirm: true,
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              orderedUomCode: "kg",
              orderedQty: "60",
            },
          ],
        }),
      ),
    ]);

    const stockFulfilled = stockRaceResults.filter((r) => r.status === "fulfilled");
    const stockRejected = stockRaceResults.filter((r) => r.status === "rejected");
    expect(stockFulfilled.length).toBe(1);
    expect(stockRejected.length).toBe(1);

    const [availAfterRace] = await fx.db
      .select()
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.batchId, "bat_p4_mng_a1"),
          eq(stockBalances.stockStatus, "available"),
        ),
      );
    const [resAfterRace] = await fx.db
      .select()
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.batchId, "bat_p4_mng_a1"),
          eq(stockBalances.stockStatus, "reserved"),
        ),
      );
    expect(availAfterRace!.qtyBase).toBe("40.000");
    expect(resAfterRace!.qtyBase).toBe("60.000");
  });
});
