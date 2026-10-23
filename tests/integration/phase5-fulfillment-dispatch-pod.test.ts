import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type ActorContext } from "@/server/authz/authorize";
import { withTransaction, type DbClient } from "@/server/db";
import {
  batches,
  inventoryMovements,
  productGrades,
  salesOrderLines,
  salesOrders,
  stockBalances,
  stockReservations,
} from "@/server/db/schema";
import {
  BusinessRuleError,
  ForbiddenError,
  IdempotencyConflictError,
} from "@/server/errors";
import {
  STOCK_LIFECYCLE_POLICY,
  createDeliveryOrder,
  createSalesFulfillment,
  dispatchDeliveryOrder,
  finalizeFulfillmentPacking,
  listDeliveryClaims,
  listDeliveryOrders,
  listReadySalesOrdersForFulfillment,
  listSalesFulfillments,
  markDeliveryOrderReady,
  recordFulfillmentPicking,
  recordProofOfDelivery,
  reportFulfillmentException,
  resolveFulfillmentException,
  updateDeliveryOrderStatus,
} from "@/server/modules/fulfillment";
import { GL_ACCOUNT_CODES, getGlAccountBalance, postJournalEntry } from "@/server/modules/gl";
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
  createCustomer,
  seedDefaultBekasiZones,
} from "@/server/modules/master/customers";
import { createSupplier } from "@/server/modules/master/suppliers";
import {
  createWarehouse,
  seedDefaultBekasiWarehouse,
} from "@/server/modules/master/warehouses";
import {
  createPriceList,
  upsertPriceListItem,
} from "@/server/modules/pricing";
import {
  confirmSalesOrder,
  createSalesOrder,
} from "@/server/modules/sales";
import { closeDb, createTestActor, setupTestDb } from "../helpers/test-db";

interface Phase5Fixtures {
  db: DbClient;
  owner: ActorContext;
  warehouseUserWh1: ActorContext;
  warehouseUserWh2: ActorContext;
  driverUserWh1: ActorContext;
  driverUserWh2: ActorContext;
  salesUserWh1: ActorContext;
  warehouse1Id: string;
  warehouse2Id: string;
  coldRoomLocationId: string;
  supplierId: string;
  manggaProductId: string;
  manggaGradeAId: string;
  manggaGradeBId: string;
  jerukProductId: string;
  jerukGradeAId: string;
  customerGrosirId: string;
  priceListGrosirId: string;
}

async function seedBatchWithGl(
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
    status?: "active" | "quarantine" | "expired";
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
      harvestedAt: new Date("2026-10-18T00:00:00Z"),
      receivedAt: params.receivedAt ?? new Date("2026-10-19T06:00:00Z"),
      bestBeforeDate: params.bestBeforeDate,
      expiresAt: new Date(`${params.bestBeforeDate}T23:59:59Z`),
      ripenessStage: "matang_siap_jual",
      initialQtyBase: params.qtyBase,
      unitCostBase: params.unitCostBase,
      totalInitialCost,
      costingMethod: "lot_actual_rsv",
      status: params.status ?? "active",
    });

    const glRes = await postJournalEntry(tx, actor, {
      entryDate: "2026-10-20",
      warehouseId: params.warehouseId,
      sourceDocType: "test_seed_batch",
      sourceDocId: params.batchId,
      purpose: "seed_inventory",
      memo: `Seed stok awal batch ${params.batchCode}`,
      skipDirectPermissionCheck: true,
      lines: [
        {
          accountCode: GL_ACCOUNT_CODES.INVENTORY_FRUIT,
          debit: totalInitialCost,
          warehouseId: params.warehouseId,
          productId: params.productId,
          batchId: params.batchId,
          description: `Seed persediaan ${params.batchCode}`,
        },
        {
          accountCode: GL_ACCOUNT_CODES.GRNI_ACCRUAL,
          credit: totalInitialCost,
          warehouseId: params.warehouseId,
          productId: params.productId,
          batchId: params.batchId,
          description: `Seed GRNI ${params.batchCode}`,
        },
      ],
    });

    await applyInventoryMovement(tx, actor, {
      warehouseId: params.warehouseId,
      warehouseCode: "BKS1",
      locationId: params.locationId,
      batchId: params.batchId,
      productId: params.productId,
      gradeId: params.gradeId,
      stockStatus: params.status === "quarantine" ? "quarantine" : "available",
      movementType: "grn_receipt",
      qtyDeltaBase: params.qtyBase,
      unitCostBase: params.unitCostBase,
      explicitInflowCost: totalInitialCost,
      sourceDocType: "test_seed_batch",
      sourceDocId: params.batchId,
      reasonCode: "INITIAL_SEED",
      journalEntryId: glRes.entry.id,
    });
  });
}

describe("Phase 5 — Warehouse Fulfillment, Dispatch, Delivery & POD Integration Tests", () => {
  let fx: Phase5Fixtures;

  beforeEach(async () => {
    const db = await setupTestDb();

    await withTransaction(async (tx) => {
      await seedStandardUomsAndPackaging(tx);
      await seedDefaultBekasiWarehouse(tx);
      await seedDefaultBekasiZones(tx);
    });

    const warehouse1Id = "wh_bks1";
    const coldRoomLocationId = "loc_bks1_cold1";

    const owner = await createTestActor(db, {
      name: "Owner Bekasi",
      grants: [{ roleCode: "owner", warehouseId: null }],
    });

    const wh2 = await withTransaction((tx) =>
      createWarehouse(tx, owner, {
        branchId: "br_bekasi_utama",
        code: "BKS-2",
        name: "Gudang Cabang Cibitung",
        address: "Jl. Imam Bonjol Cibitung, Bekasi",
        isDefault: false,
      }),
    );

    const warehouseUserWh1 = await createTestActor(db, {
      name: "Kepala Gudang BKS-1",
      grants: [{ roleCode: "warehouse", warehouseId: warehouse1Id }],
    });

    const warehouseUserWh2 = await createTestActor(db, {
      name: "Kepala Gudang BKS-2",
      grants: [{ roleCode: "warehouse", warehouseId: wh2.id }],
    });

    const driverUserWh1 = await createTestActor(db, {
      name: "Sopir Armada BKS-1 (Pak Budi)",
      grants: [{ roleCode: "driver", warehouseId: warehouse1Id }],
    });

    const driverUserWh2 = await createTestActor(db, {
      name: "Sopir Armada BKS-2",
      grants: [{ roleCode: "driver", warehouseId: wh2.id }],
    });

    const salesUserWh1 = await createTestActor(db, {
      name: "Sales BKS-1",
      grants: [{ roleCode: "sales", warehouseId: warehouse1Id }],
    });

    const supplier = await withTransaction((tx) =>
      createSupplier(tx, owner, {
        code: "SUP-MANGGA-01",
        name: "Kelompok Tani Harum Manis Probolinggo",
        supplierType: "petani",
        originRegion: "Probolinggo",
        paymentTermsDays: 7,
        leadTimeDays: 1,
      }),
    );

    const manggaProduct = await withTransaction(async (tx) => {
      const p = await createProduct(tx, owner, {
        sku: "FRT-MNG-HM",
        barcode: "8991002003001",
        name: "Mangga Harum Manis",
        category: "buah_musiman",
        variety: "Harum Manis Super",
        baseUomCode: "kg",
        isCatchWeight: true,
        defaultShelfLifeDays: 10,
        ripenessTracking: true,
        storageCondition: "cold",
        taxCode: "PPN_EXEMPT",
        minMarginPct: "15.00",
        minSellingPrice: "18000",
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

      await upsertProductUomConversion(tx, owner, {
        productId: p.id,
        uomCode: "box",
        factorToBase: "10.0000",
        isNominal: false,
        requiresActualWeight: false,
      });

      return p;
    });

    const manggaGrades = await db
      .select()
      .from(productGrades)
      .where(eq(productGrades.productId, manggaProduct.id));
    const manggaGradeA = manggaGrades.find((g) => g.code === "A")!;
    const manggaGradeB = manggaGrades.find((g) => g.code === "B")!;

    const jerukProduct = await withTransaction((tx) =>
      createProduct(tx, owner, {
        sku: "FRT-JRK-MDN",
        barcode: "8991002003002",
        name: "Jeruk Medan Super",
        category: "buah_lokal",
        variety: "Medan",
        baseUomCode: "kg",
        isCatchWeight: true,
        defaultShelfLifeDays: 14,
        ripenessTracking: true,
        storageCondition: "cold",
        taxCode: "PPN_EXEMPT",
        minMarginPct: "12.00",
        minSellingPrice: "15000",
        createDefaultGrades: true,
      }),
    );

    const jerukGrades = await db
      .select()
      .from(productGrades)
      .where(eq(productGrades.productId, jerukProduct.id));
    const jerukGradeA = jerukGrades.find((g) => g.code === "A")!;

    const customerGrosir = await withTransaction((tx) =>
      createCustomer(tx, owner, {
        code: "CUST-BKS-01",
        name: "Toko Buah Segar Jaya Kranji",
        segment: "toko_buah",
        priceTier: "grosir",
        contactPerson: "H. Rahmat",
        phone: "081299887766",
        whatsapp: "081299887766",
        shippingAddress: "Pasar Kranji Baru Blok A No. 12, Bekasi Barat",
        deliveryZoneId: "zone_bks_barat",
        assignedWarehouseId: warehouse1Id,
        paymentTermsDays: 14,
        creditLimit: "50000000",
      }),
    );

    const plGrosir = await withTransaction(async (tx) => {
      const pl = await createPriceList(tx, owner, {
        code: "PL-GROSIR-2026",
        name: "Daftar Harga Grosir Bekasi",
        priceTier: "grosir",
        warehouseId: warehouse1Id,
        effectiveFrom: "2026-01-01",
        isActive: true,
        reason: "Penetapan harga grosir Bekasi 2026",
      });

      await upsertPriceListItem(tx, owner, {
        priceListId: pl.id,
        productId: manggaProduct.id,
        gradeId: manggaGradeA.id,
        uomCode: "kg",
        minQty: "1.000",
        unitPrice: "25000",
        maxDiscountPct: "10.00",
        reason: "Harga grosir Mangga Grade A per kg",
      });

      await upsertPriceListItem(tx, owner, {
        priceListId: pl.id,
        productId: manggaProduct.id,
        gradeId: manggaGradeB.id,
        uomCode: "kg",
        minQty: "1.000",
        unitPrice: "20000",
        maxDiscountPct: "10.00",
        reason: "Harga grosir Mangga Grade B per kg",
      });

      await upsertPriceListItem(tx, owner, {
        priceListId: pl.id,
        productId: manggaProduct.id,
        gradeId: manggaGradeA.id,
        uomCode: "box",
        minQty: "1.000",
        unitPrice: "250000",
        maxDiscountPct: "10.00",
        reason: "Harga grosir Mangga Grade A per box",
      });

      await upsertPriceListItem(tx, owner, {
        priceListId: pl.id,
        productId: manggaProduct.id,
        gradeId: manggaGradeA.id,
        uomCode: "peti",
        minQty: "1.000",
        unitPrice: "500000",
        maxDiscountPct: "10.00",
        reason: "Harga grosir Mangga Grade A per peti",
      });

      await upsertPriceListItem(tx, owner, {
        priceListId: pl.id,
        productId: jerukProduct.id,
        gradeId: jerukGradeA.id,
        uomCode: "kg",
        minQty: "1.000",
        unitPrice: "22000",
        maxDiscountPct: "10.00",
        reason: "Harga grosir Jeruk Grade A per kg",
      });

      return pl;
    });

    fx = {
      db,
      owner,
      warehouseUserWh1,
      warehouseUserWh2,
      driverUserWh1,
      driverUserWh2,
      salesUserWh1,
      warehouse1Id,
      warehouse2Id: wh2.id,
      coldRoomLocationId,
      supplierId: supplier.id,
      manggaProductId: manggaProduct.id,
      manggaGradeAId: manggaGradeA.id,
      manggaGradeBId: manggaGradeB.id,
      jerukProductId: jerukProduct.id,
      jerukGradeAId: jerukGradeA.id,
      customerGrosirId: customerGrosir.id,
      priceListGrosirId: plGrosir.id,
    };
  });

  afterAll(async () => {
    await closeDb();
  });

  // --------------------------------------------------------------------------
  // TEST 1: Approved SO eligible for fulfillment while unapproved SO is rejected
  // --------------------------------------------------------------------------
  it("1. mengizinkan pembuatan Fulfillment hanya untuk Sales Order yang telah dikonfirmasi ('confirmed') dan menolak SO berstatus 'draft'", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t1_01",
      batchCode: "LOT/BKS1/2610/00001",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "100.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-28",
    });

    const draftSo = await withTransaction((tx) =>
      createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        saveAsDraft: true,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "20.000",
          },
        ],
      }),
    );

    expect(draftSo.header.status).toBe("draft");

    // Attempting to create fulfillment on unconfirmed (draft) SO must fail
    await expect(
      withTransaction((tx) =>
        createSalesFulfillment(tx, fx.warehouseUserWh1, {
          salesOrderId: draftSo.header.id,
          fulfillmentDate: "2026-10-20",
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Confirm the SO -> now eligible
    const confirmed = await withTransaction((tx) =>
      confirmSalesOrder(tx, fx.salesUserWh1, {
        salesOrderId: draftSo.header.id,
      }),
    );
    expect(confirmed.header.status).toBe("confirmed");

    const readyOrders = await listReadySalesOrdersForFulfillment(fx.db, fx.warehouseUserWh1, {
      warehouseId: fx.warehouse1Id,
    });
    expect(readyOrders.some((o) => o.id === draftSo.header.id)).toBe(true);

    const fulRes = await withTransaction((tx) =>
      createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: draftSo.header.id,
        fulfillmentDate: "2026-10-20",
      }),
    );

    expect(fulRes.fulfillment.fulfillmentNo).toMatch(/^FUL\/BKS1\/\d{4}\/00001$/);
    expect(fulRes.fulfillment.status).toBe("draft");
    expect(fulRes.lines).toHaveLength(1);
    expect(fulRes.lines[0]!.targetPickQtyBase).toBe("20.000");
  });

  // --------------------------------------------------------------------------
  // TEST 2: FEFO batch selection during picking (older expiry picked first, expired/blocked excluded)
  // --------------------------------------------------------------------------
  it("2. memilih batch secara FEFO (masa simpan terdekat diambil lebih dulu) dan memblokir batch kadaluarsa atau karantina", async () => {
    // Seed 1 expired batch, 1 quarantine batch, 1 older valid batch (Oct 24), and 1 newer valid batch (Oct 29)
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t2_expired",
      batchCode: "LOT/BKS1/2610/00010",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "50.000",
      unitCostBase: "14000.0000",
      bestBeforeDate: "2026-10-18", // Already expired relative to 2026-10-20
    });

    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t2_quarantine",
      batchCode: "LOT/BKS1/2610/00011",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "50.000",
      unitCostBase: "14000.0000",
      bestBeforeDate: "2026-10-22",
      status: "quarantine",
    });

    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t2_older",
      batchCode: "LOT/BKS1/2610/00012",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "30.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-24",
    });

    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t2_newer",
      batchCode: "LOT/BKS1/2610/00013",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "40.000",
      unitCostBase: "16000.0000",
      bestBeforeDate: "2026-10-29",
    });

    const so = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "45.000",
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    const ful = await withTransaction((tx) =>
      createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
      }),
    );

    // Explicitly trying to force-pick the expired batch must fail
    await expect(
      withTransaction((tx) =>
        recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
          fulfillmentId: ful.fulfillment.id,
          picks: [
            {
              fulfillmentLineId: ful.lines[0]!.id,
              grossWeightKg: "46.000",
              tareWeightKg: "1.000",
              batchAllocations: [{ batchId: "batch_t2_expired", qtyBase: "45.000" }],
            },
          ],
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Automatic FEFO picking picks 30 kg from batch_t2_older (Oct 24) and 15 kg from batch_t2_newer (Oct 29)
    const pickRes = await withTransaction((tx) =>
      recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: ful.lines[0]!.id,
            grossWeightKg: "46.200",
            tareWeightKg: "1.200", // Net = 45.000 kg
          },
        ],
      }),
    );

    expect(pickRes.fulfillment.status).toBe("picked");
    expect(pickRes.allocations).toHaveLength(2);
    expect(pickRes.allocations[0]!.batchId).toBe("batch_t2_older");
    expect(pickRes.allocations[0]!.pickedQtyBase).toBe("30.000");
    expect(pickRes.allocations[1]!.batchId).toBe("batch_t2_newer");
    expect(pickRes.allocations[1]!.pickedQtyBase).toBe("15.000");
  });

  // --------------------------------------------------------------------------
  // TEST 3: Reservation consumption during picking without double consumption
  // --------------------------------------------------------------------------
  it("3. mengonsumsi reservasi FEFO saat picking dan mencegah konsumsi ganda pada reservasi yang sama", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t3_01",
      batchCode: "LOT/BKS1/2610/00021",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "50.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-27",
    });

    const so = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "25.000",
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    // Two draft fulfillments created before picking starts
    const ful1 = await withTransaction((tx) =>
      createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
      }),
    );
    const ful2 = await withTransaction((tx) =>
      createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
      }),
    );

    // Ful1 consumes the 25 kg reservation
    const pick1 = await withTransaction((tx) =>
      recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful1.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: ful1.lines[0]!.id,
            grossWeightKg: "26.000",
            tareWeightKg: "1.000",
          },
        ],
      }),
    );
    expect(pick1.allocations[0]!.sourceStockStatus).toBe("reserved");

    const [resRow] = await fx.db
      .select()
      .from(stockReservations)
      .where(eq(stockReservations.sourceDocId, so.header.id));
    expect(resRow!.status).toBe("fulfilled");
    expect(resRow!.fulfilledQtyBase).toBe("25.000");

    // Ful2 attempting to pick against the already-consumed reservation must fail
    await expect(
      withTransaction((tx) =>
        recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
          fulfillmentId: ful2.fulfillment.id,
          picks: [
            {
              fulfillmentLineId: ful2.lines[0]!.id,
              grossWeightKg: "26.000",
              tareWeightKg: "1.000",
            },
          ],
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  // --------------------------------------------------------------------------
  // TEST 4: Partial fulfillment with accurate remaining/backorder quantity
  // --------------------------------------------------------------------------
  it("4. mendukung pemenuhan sebagian (partial fulfillment) dengan perhitungan sisa backorder yang akurat", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t4_01",
      batchCode: "LOT/BKS1/2610/00031",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "100.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-27",
    });

    const so = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "60.000",
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    // Partial fulfillment for 35 kg out of 60 kg
    const ful1 = await withTransaction((tx) =>
      createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
        lines: [
          {
            salesOrderLineId: so.lines[0]!.id,
            targetPickQtyBase: "35.000",
          },
        ],
      }),
    );

    expect(ful1.fulfillment.isPartialFulfillment).toBe(true);

    const pick1 = await withTransaction((tx) =>
      recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful1.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: ful1.lines[0]!.id,
            grossWeightKg: "36.500",
            tareWeightKg: "1.500", // Net = 35.000 kg
          },
        ],
      }),
    );

    expect(pick1.lines[0]!.pickedQtyBase).toBe("35.000");
    expect(pick1.lines[0]!.remainingBackorderQtyBase).toBe("25.000");
    expect(pick1.lines[0]!.backorderStatus).toBe("open_backorder");
    expect(pick1.fulfillment.totalRemainingQtyBase).toBe("25.000");

    const [solAfter] = await fx.db
      .select()
      .from(salesOrderLines)
      .where(eq(salesOrderLines.id, so.lines[0]!.id));
    expect(solAfter!.fulfilledQtyBase).toBe("35.000");
  });

  // --------------------------------------------------------------------------
  // TEST 5: Prevention of picking more than available/reserved or allowed quantity
  // --------------------------------------------------------------------------
  it("5. mencegah picking melebihi stok tersedia/reserved atau melebihi batas kuantitas pesanan", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t5_01",
      batchCode: "LOT/BKS1/2610/00041",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "20.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-27",
    });

    const so = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "20.000",
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    const ful = await withTransaction((tx) =>
      createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
        qtyTolerancePct: "10.00",
      }),
    );

    // Attempting to pick 20.5 kg when total physical stock is only 20.0 kg must fail
    await expect(
      withTransaction((tx) =>
        recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
          fulfillmentId: ful.fulfillment.id,
          picks: [
            {
              fulfillmentLineId: ful.lines[0]!.id,
              grossWeightKg: "21.500",
              tareWeightKg: "1.000", // Net 20.500 kg > 20.000 kg physical stock
            },
          ],
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  // --------------------------------------------------------------------------
  // TEST 6: Weighing and UoM conversion during picking/packing
  // --------------------------------------------------------------------------
  it("6. memvalidasi penimbangan aktual (bruto, tara, neto) dan konversi satuan (UoM) saat picking", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t6_01",
      batchCode: "LOT/BKS1/2610/00051",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "100.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-28",
    });

    // Create SO in BOX (1 BOX = 10 KG exact)
    const soBox = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "box",
            orderedQty: "2.000", // 20 kg base
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    const fulBox = await withTransaction((tx) =>
      createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: soBox.header.id,
        fulfillmentDate: "2026-10-20",
      }),
    );

    // 1. Invalid tare >= gross must be rejected
    await expect(
      withTransaction((tx) =>
        recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
          fulfillmentId: fulBox.fulfillment.id,
          picks: [
            {
              fulfillmentLineId: fulBox.lines[0]!.id,
              pickedUomCode: "kg",
              grossWeightKg: "5.000",
              tareWeightKg: "5.500",
            },
          ],
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // 2. Picking using nominal/catch-weight UoM (CRATE) without actual weighing must be rejected
    await expect(
      withTransaction((tx) =>
        recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
          fulfillmentId: fulBox.fulfillment.id,
          picks: [
            {
              fulfillmentLineId: fulBox.lines[0]!.id,
              pickedUomCode: "peti",
              pickedQty: "1.000",
            },
          ],
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // 3. Picking with CRATE + actual gross & tare weighing succeeds and uses exact netWeightKg
    const pickRes = await withTransaction((tx) =>
      recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: fulBox.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: fulBox.lines[0]!.id,
            pickedUomCode: "peti",
            pickedQty: "1.000",
            grossWeightKg: "21.800",
            tareWeightKg: "1.800", // Net = 20.000 kg
            scannedBarcode: "8991002003001",
          },
        ],
      }),
    );

    expect(pickRes.lines[0]!.grossWeightKg).toBe("21.800");
    expect(pickRes.lines[0]!.tareWeightKg).toBe("1.800");
    expect(pickRes.lines[0]!.netWeightKg).toBe("20.000");
    expect(pickRes.lines[0]!.pickedQtyBase).toBe("20.000");
  });

  // --------------------------------------------------------------------------
  // TEST 7: Product/grade substitution or out-of-tolerance variance requiring approval
  // --------------------------------------------------------------------------
  it("7. memblokir substitusi produk/grade atau selisih berat di luar toleransi hingga mendapat persetujuan (approval)", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t7_gradeA",
      batchCode: "LOT/BKS1/2610/00061",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "50.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-28",
    });

    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t7_gradeB",
      batchCode: "LOT/BKS1/2610/00062",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeBId,
      gradeCode: "B",
      supplierId: fx.supplierId,
      qtyBase: "50.000",
      unitCostBase: "12000.0000",
      bestBeforeDate: "2026-10-28",
    });

    const so = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "20.000",
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    const ful = await withTransaction((tx) =>
      createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
        qtyTolerancePct: "5.00",
      }),
    );

    // 1. Direct grade substitution (Grade A -> Grade B) without approval request is rejected
    await expect(
      withTransaction((tx) =>
        recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
          fulfillmentId: ful.fulfillment.id,
          picks: [
            {
              fulfillmentLineId: ful.lines[0]!.id,
              actualGradeId: fx.manggaGradeBId,
              grossWeightKg: "21.000",
              tareWeightKg: "1.000",
            },
          ],
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // 2. Requesting override approval places fulfillment in 'exception_hold' without issuing stock
    const holdRes = await withTransaction((tx) =>
      recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: ful.lines[0]!.id,
            actualGradeId: fx.manggaGradeBId,
            grossWeightKg: "23.000",
            tareWeightKg: "1.000", // 22.000 kg (+10% > 5% tolerance) + Grade B substitution
            requestOverrideApproval: true,
            overrideReason: "Pelanggan setuju substitusi sebagian ke Grade B dengan timbangan 22 kg",
          },
        ],
      }),
    );

    expect(holdRes.fulfillment.status).toBe("exception_hold");
    expect(holdRes.allocations).toHaveLength(0);
    expect(holdRes.exceptions).toHaveLength(2); // substitution + weight_variance
    expect(holdRes.approvals).toHaveLength(2);

    // 3. Owner resolves/approves both exceptions
    for (const exc of holdRes.exceptions) {
      await withTransaction((tx) =>
        resolveFulfillmentException(tx, fx.owner, {
          exceptionId: exc.id,
          resolutionStatus: "approved",
          resolutionNotes: "Disetujui oleh Owner setelah konfirmasi dengan pelanggan",
        }),
      );
    }

    // 4. Re-running picking now succeeds using the approved substitution & variance override
    const pickAfterApproval = await withTransaction((tx) =>
      recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: ful.lines[0]!.id,
            actualGradeId: fx.manggaGradeBId,
            grossWeightKg: "23.000",
            tareWeightKg: "1.000",
          },
        ],
      }),
    );

    expect(pickAfterApproval.fulfillment.status).toBe("picked");
    expect(pickAfterApproval.lines[0]!.isSubstitution).toBe(true);
    expect(pickAfterApproval.lines[0]!.actualGradeCode).toBe("B");
    expect(pickAfterApproval.lines[0]!.pickedQtyBase).toBe("22.000");
  });

  // --------------------------------------------------------------------------
  // TEST 8: Packing completion and blocking when unresolved exceptions exist
  // --------------------------------------------------------------------------
  it("8. memvalidasi packing checklist dan memblokir finalisasi packing apabila masih ada exception yang belum selesai", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t8_01",
      batchCode: "LOT/BKS1/2610/00071",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "50.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-28",
    });

    const so = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "20.000",
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    const ful = await withTransaction((tx) =>
      createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
      }),
    );

    await withTransaction((tx) =>
      recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: ful.lines[0]!.id,
            grossWeightKg: "21.000",
            tareWeightKg: "1.000",
          },
        ],
      }),
    );

    // Report a blocking damaged_goods exception discovered at the packing table
    const exc = await withTransaction((tx) =>
      reportFulfillmentException(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        fulfillmentLineId: ful.lines[0]!.id,
        exceptionType: "damaged_goods",
        severity: "blocking",
        reasonCode: "PACKING_BRUISED_FRUIT",
        description: "Ditemukan 2 buah memar saat pengepakan peti, perlu penggantian buah setara",
      }),
    );

    // Attempting to finalize packing while exception is open must fail
    await expect(
      withTransaction((tx) =>
        finalizeFulfillmentPacking(tx, fx.warehouseUserWh1, {
          fulfillmentId: ful.fulfillment.id,
          checklist: {
            qualityChecked: true,
            packagingVerified: true,
            labelAttached: true,
            packageCount: 1,
          },
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Resolve exception
    await withTransaction((tx) =>
      resolveFulfillmentException(tx, fx.warehouseUserWh1, {
        exceptionId: exc.id,
        resolutionStatus: "resolved",
        resolutionNotes: "Buah memar telah diganti dari peti sortir yang sama",
      }),
    );

    // Incomplete checklist (labelAttached: false) must also be rejected
    await expect(
      withTransaction((tx) =>
        finalizeFulfillmentPacking(tx, fx.warehouseUserWh1, {
          fulfillmentId: ful.fulfillment.id,
          checklist: {
            qualityChecked: true,
            packagingVerified: true,
            labelAttached: false,
            packageCount: 1,
          },
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Complete checklist succeeds
    const packed = await withTransaction((tx) =>
      finalizeFulfillmentPacking(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        checklist: {
          qualityChecked: true,
          packagingVerified: true,
          labelAttached: true,
          packageCount: 1,
          notes: "1 Peti plastik biru tersegel",
        },
      }),
    );

    expect(packed.status).toBe("packed");
    expect(packed.totalPackedQtyBase).toBe("20.000");
  });

  // --------------------------------------------------------------------------
  // TEST 9: Delivery Order creation and blocking dispatch before packing is ready
  // --------------------------------------------------------------------------
  it("9. memblokir pembuatan Surat Jalan dan keberangkatan (dispatch) sebelum Fulfillment berstatus 'packed' dan DO berstatus 'ready'", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t9_01",
      batchCode: "LOT/BKS1/2610/00081",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "50.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-28",
    });

    const so = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "15.000",
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    const ful = await withTransaction((tx) =>
      createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
      }),
    );

    // Cannot create Delivery Order while fulfillment is still 'draft'
    await expect(
      withTransaction((tx) =>
        createDeliveryOrder(tx, fx.warehouseUserWh1, {
          fulfillmentId: ful.fulfillment.id,
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    await withTransaction((tx) =>
      recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: ful.lines[0]!.id,
            grossWeightKg: "16.000",
            tareWeightKg: "1.000",
          },
        ],
      }),
    );

    // Still cannot create Delivery Order while fulfillment is only 'picked' (not 'packed')
    await expect(
      withTransaction((tx) =>
        createDeliveryOrder(tx, fx.warehouseUserWh1, {
          fulfillmentId: ful.fulfillment.id,
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    await withTransaction((tx) =>
      finalizeFulfillmentPacking(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        checklist: {
          qualityChecked: true,
          packagingVerified: true,
          labelAttached: true,
          packageCount: 1,
        },
      }),
    );

    // Now Delivery Order creation succeeds
    const doRes = await withTransaction((tx) =>
      createDeliveryOrder(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
      }),
    );

    expect(doRes.deliveryOrder.doNumber).toMatch(/^DO\/BKS1\/\d{4}\/00001$/);
    expect(doRes.deliveryOrder.status).toBe("draft");

    // Cannot dispatch while DO is still 'draft' (and missing driver/vehicle)
    await expect(
      withTransaction((tx) =>
        dispatchDeliveryOrder(tx, fx.warehouseUserWh1, {
          deliveryOrderId: doRes.deliveryOrder.id,
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Cannot mark ready without driver & vehicle plate
    await expect(
      withTransaction((tx) =>
        markDeliveryOrderReady(tx, fx.warehouseUserWh1, {
          deliveryOrderId: doRes.deliveryOrder.id,
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    const readyDo = await withTransaction((tx) =>
      markDeliveryOrderReady(tx, fx.warehouseUserWh1, {
        deliveryOrderId: doRes.deliveryOrder.id,
        driverUserId: fx.driverUserWh1.user.id,
        vehiclePlateNo: "B 9123 KAA",
        vehicleType: "Blind Van Pendingin",
      }),
    );
    expect(readyDo.status).toBe("ready");

    const dispatchedDo = await withTransaction((tx) =>
      dispatchDeliveryOrder(tx, fx.driverUserWh1, {
        deliveryOrderId: readyDo.id,
      }),
    );
    expect(dispatchedDo.status).toBe("dispatched");
  });

  // --------------------------------------------------------------------------
  // TEST 10: Delivery Order status transition validation
  // --------------------------------------------------------------------------
  it("10. menegakkan aturan transisi status Delivery Order dan menolak transisi ilegal", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t10_01",
      batchCode: "LOT/BKS1/2610/00091",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "50.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-28",
    });

    const so = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "15.000",
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    const ful = await withTransaction(async (tx) => {
      const f = await createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
      });
      await recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: f.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: f.lines[0]!.id,
            grossWeightKg: "16.000",
            tareWeightKg: "1.000",
          },
        ],
      });
      await finalizeFulfillmentPacking(tx, fx.warehouseUserWh1, {
        fulfillmentId: f.fulfillment.id,
        checklist: {
          qualityChecked: true,
          packagingVerified: true,
          labelAttached: true,
          packageCount: 1,
        },
      });
      return f;
    });

    const doRes = await withTransaction((tx) =>
      createDeliveryOrder(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        driverUserId: fx.driverUserWh1.user.id,
        vehiclePlateNo: "B 9456 KBB",
      }),
    );

    // Illegal jump from 'draft' -> 'in_transit' must fail
    await expect(
      withTransaction((tx) =>
        updateDeliveryOrderStatus(tx, fx.driverUserWh1, {
          deliveryOrderId: doRes.deliveryOrder.id,
          targetStatus: "in_transit",
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Valid transition: draft -> ready -> dispatched -> in_transit
    await withTransaction((tx) =>
      markDeliveryOrderReady(tx, fx.warehouseUserWh1, {
        deliveryOrderId: doRes.deliveryOrder.id,
      }),
    );
    await withTransaction((tx) =>
      dispatchDeliveryOrder(tx, fx.driverUserWh1, {
        deliveryOrderId: doRes.deliveryOrder.id,
      }),
    );
    const inTransit = await withTransaction((tx) =>
      updateDeliveryOrderStatus(tx, fx.driverUserWh1, {
        deliveryOrderId: doRes.deliveryOrder.id,
        targetStatus: "in_transit",
      }),
    );
    expect(inTransit.status).toBe("in_transit");

    // Transition to 'failed' without reason must fail
    await expect(
      withTransaction((tx) =>
        updateDeliveryOrderStatus(tx, fx.driverUserWh1, {
          deliveryOrderId: doRes.deliveryOrder.id,
          targetStatus: "failed",
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  // --------------------------------------------------------------------------
  // TEST 11: Multiple deliveries for a partially fulfilled Sales Order
  // --------------------------------------------------------------------------
  it("11. mendukung beberapa pengiriman (multiple Delivery Orders) untuk satu Sales Order yang dipenuhi bertahap", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t11_01",
      batchCode: "LOT/BKS1/2610/00101",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "100.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-28",
    });

    const so = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "50.000",
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    // Delivery #1: 30 kg
    const do1 = await withTransaction(async (tx) => {
      const f1 = await createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
        lines: [{ salesOrderLineId: so.lines[0]!.id, targetPickQtyBase: "30.000" }],
      });
      await recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: f1.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: f1.lines[0]!.id,
            grossWeightKg: "31.000",
            tareWeightKg: "1.000",
          },
        ],
      });
      await finalizeFulfillmentPacking(tx, fx.warehouseUserWh1, {
        fulfillmentId: f1.fulfillment.id,
        checklist: {
          qualityChecked: true,
          packagingVerified: true,
          labelAttached: true,
          packageCount: 2,
        },
      });
      const d1 = await createDeliveryOrder(tx, fx.warehouseUserWh1, {
        fulfillmentId: f1.fulfillment.id,
        driverUserId: fx.driverUserWh1.user.id,
        vehiclePlateNo: "B 9001 KAA",
      });
      await markDeliveryOrderReady(tx, fx.warehouseUserWh1, {
        deliveryOrderId: d1.deliveryOrder.id,
      });
      await dispatchDeliveryOrder(tx, fx.driverUserWh1, {
        deliveryOrderId: d1.deliveryOrder.id,
      });
      return recordProofOfDelivery(tx, fx.driverUserWh1, {
        deliveryOrderId: d1.deliveryOrder.id,
        recipientName: "H. Rahmat",
        recipientRoleOrId: "Pemilik Toko",
      });
    });

    expect(do1.pod.totalDeliveredQtyBase).toBe("30.000");

    // SO should still be 'shipped' (since 30 / 50 delivered)
    const [soMid] = await fx.db
      .select()
      .from(salesOrders)
      .where(eq(salesOrders.id, so.header.id));
    expect(soMid!.status).toBe("shipped");

    // Delivery #2: Remaining 20 kg
    const do2 = await withTransaction(async (tx) => {
      const f2 = await createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
      });
      expect(f2.lines[0]!.targetPickQtyBase).toBe("20.000");

      await recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: f2.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: f2.lines[0]!.id,
            grossWeightKg: "21.000",
            tareWeightKg: "1.000",
          },
        ],
      });
      await finalizeFulfillmentPacking(tx, fx.warehouseUserWh1, {
        fulfillmentId: f2.fulfillment.id,
        checklist: {
          qualityChecked: true,
          packagingVerified: true,
          labelAttached: true,
          packageCount: 1,
        },
      });
      const d2 = await createDeliveryOrder(tx, fx.warehouseUserWh1, {
        fulfillmentId: f2.fulfillment.id,
        driverUserId: fx.driverUserWh1.user.id,
        vehiclePlateNo: "B 9002 KAA",
      });
      await markDeliveryOrderReady(tx, fx.warehouseUserWh1, {
        deliveryOrderId: d2.deliveryOrder.id,
      });
      await dispatchDeliveryOrder(tx, fx.driverUserWh1, {
        deliveryOrderId: d2.deliveryOrder.id,
      });
      return recordProofOfDelivery(tx, fx.driverUserWh1, {
        deliveryOrderId: d2.deliveryOrder.id,
        recipientName: "H. Rahmat",
        recipientRoleOrId: "Pemilik Toko",
      });
    });

    expect(do2.pod.totalDeliveredQtyBase).toBe("20.000");

    const [soFinal] = await fx.db
      .select()
      .from(salesOrders)
      .where(eq(salesOrders.id, so.header.id));
    expect(soFinal!.status).toBe("delivered");
  });

  // --------------------------------------------------------------------------
  // TEST 12: POD recording and duplicate POD submission prevention
  // --------------------------------------------------------------------------
  it("12. mencatat Proof of Delivery (POD) dan menolak pengiriman POD ganda pada Surat Jalan yang sama", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t12_01",
      batchCode: "LOT/BKS1/2610/00111",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "50.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-28",
    });

    const dispatchedDoId = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "20.000",
          },
        ],
      });
      await confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
      const f = await createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: created.header.id,
        fulfillmentDate: "2026-10-20",
      });
      await recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: f.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: f.lines[0]!.id,
            grossWeightKg: "21.000",
            tareWeightKg: "1.000",
          },
        ],
      });
      await finalizeFulfillmentPacking(tx, fx.warehouseUserWh1, {
        fulfillmentId: f.fulfillment.id,
        checklist: {
          qualityChecked: true,
          packagingVerified: true,
          labelAttached: true,
          packageCount: 1,
        },
      });
      const d = await createDeliveryOrder(tx, fx.warehouseUserWh1, {
        fulfillmentId: f.fulfillment.id,
        driverUserId: fx.driverUserWh1.user.id,
        vehiclePlateNo: "B 9111 KAA",
      });
      await markDeliveryOrderReady(tx, fx.warehouseUserWh1, {
        deliveryOrderId: d.deliveryOrder.id,
      });
      const disp = await dispatchDeliveryOrder(tx, fx.driverUserWh1, {
        deliveryOrderId: d.deliveryOrder.id,
      });
      return disp.id;
    });

    const pod1 = await withTransaction((tx) =>
      recordProofOfDelivery(tx, fx.driverUserWh1, {
        deliveryOrderId: dispatchedDoId,
        recipientName: "Ibu Siti",
        recipientRoleOrId: "Kasir Penerima",
        recipientPhone: "081299998888",
        deliveryNotes: "Diterima lengkap kondisi segar",
      }),
    );

    expect(pod1.pod.podNumber).toMatch(/^POD\/BKS1\/\d{4}\/00001$/);
    expect(pod1.pod.outcomeStatus).toBe("delivered");
    expect(pod1.claim).toBeNull();

    // Second POD submission for the same Delivery Order must be rejected
    await expect(
      withTransaction((tx) =>
        recordProofOfDelivery(tx, fx.driverUserWh1, {
          deliveryOrderId: dispatchedDoId,
          recipientName: "Ibu Siti",
          recipientRoleOrId: "Kasir Penerima",
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  // --------------------------------------------------------------------------
  // TEST 13: POD discrepancy handling (shortage, damaged, refused) creates actionable claim
  // --------------------------------------------------------------------------
  it("13. menangani selisih POD (kurang, rusak, ditolak) dengan membuat klaim pengiriman (delivery_claims) tanpa memutasi ledger stok atau harga SO secara diam-diam", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t13_01",
      batchCode: "LOT/BKS1/2610/00121",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "50.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-28",
    });

    const { soId, doId, doLineId, originalGrandTotal } = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "20.000", // 20 kg @ Rp 25.000 = Rp 500.000
          },
        ],
      });
      await confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
      const f = await createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: created.header.id,
        fulfillmentDate: "2026-10-20",
      });
      await recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: f.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: f.lines[0]!.id,
            grossWeightKg: "21.000",
            tareWeightKg: "1.000",
          },
        ],
      });
      await finalizeFulfillmentPacking(tx, fx.warehouseUserWh1, {
        fulfillmentId: f.fulfillment.id,
        checklist: {
          qualityChecked: true,
          packagingVerified: true,
          labelAttached: true,
          packageCount: 1,
        },
      });
      const d = await createDeliveryOrder(tx, fx.warehouseUserWh1, {
        fulfillmentId: f.fulfillment.id,
        driverUserId: fx.driverUserWh1.user.id,
        vehiclePlateNo: "B 9222 KAA",
      });
      await markDeliveryOrderReady(tx, fx.warehouseUserWh1, {
        deliveryOrderId: d.deliveryOrder.id,
      });
      await dispatchDeliveryOrder(tx, fx.driverUserWh1, {
        deliveryOrderId: d.deliveryOrder.id,
      });
      return {
        soId: created.header.id,
        doId: d.deliveryOrder.id,
        doLineId: d.lines[0]!.id,
        originalGrandTotal: created.header.grandTotalAmount,
      };
    });

    const movementsBeforePod = await fx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.warehouseId, fx.warehouse1Id));

    // Customer accepts 17 kg, reports 1 kg shortage, 1.5 kg damaged in transit, 0.5 kg refused (sum = 20 kg)
    const podRes = await withTransaction((tx) =>
      recordProofOfDelivery(tx, fx.driverUserWh1, {
        deliveryOrderId: doId,
        recipientName: "Pak Hendra",
        recipientRoleOrId: "Supervisor Gudang Toko",
        deliveryNotes: "1 kg susut, 1.5 kg memar di perjalanan, 0.5 kg ukuran kecil ditolak",
        lines: [
          {
            deliveryOrderLineId: doLineId,
            deliveredQtyBase: "17.000",
            shortageQtyBase: "1.000",
            damagedQtyBase: "1.500",
            refusedQtyBase: "0.500",
            discrepancyReasonCode: "TRANSIT_DAMAGE_AND_SHORTAGE",
          },
        ],
      }),
    );

    expect(podRes.pod.outcomeStatus).toBe("partially_delivered");
    expect(podRes.pod.totalDeliveredQtyBase).toBe("17.000");
    expect(podRes.pod.totalDiscrepancyQtyBase).toBe("3.000");
    expect(podRes.deliveryOrder.status).toBe("partially_delivered");

    // Claim must be created automatically with 3 kg * Rp 25,000 = Rp 75,000 estimated value
    expect(podRes.claim).not.toBeNull();
    expect(podRes.claim!.claimNo).toMatch(/^CLM\/BKS1\/\d{4}\/00001$/);
    expect(podRes.claim!.claimType).toBe("mixed_discrepancy");
    expect(podRes.claim!.status).toBe("open");
    expect(podRes.claim!.discrepancyQtyBase).toBe("3.000");
    expect(podRes.claim!.estimatedClaimValue).toBe("75000.00");

    // Verify no silent inventory movement mutation or silent SO price alteration occurred
    const movementsAfterPod = await fx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.warehouseId, fx.warehouse1Id));
    expect(movementsAfterPod).toHaveLength(movementsBeforePod.length);

    const [soAfter] = await fx.db
      .select()
      .from(salesOrders)
      .where(eq(salesOrders.id, soId));
    expect(soAfter!.grandTotalAmount).toBe(originalGrandTotal);
  });

  // --------------------------------------------------------------------------
  // TEST 14: RBAC and warehouse scope enforcement for warehouse and driver operations
  // --------------------------------------------------------------------------
  it("14. menegakkan RBAC server-side dan membatasi akses berdasarkan cakupan gudang (warehouse scope) untuk Warehouse & Driver", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t14_01",
      batchCode: "LOT/BKS1/2610/00131",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "50.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-28",
    });

    const so = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "15.000",
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    // 1. Driver (who only has delivery.execute, not fulfillment.pick_pack) cannot create fulfillment or pick
    await expect(
      withTransaction((tx) =>
        createSalesFulfillment(tx, fx.driverUserWh1, {
          salesOrderId: so.header.id,
        }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // 2. Warehouse user assigned to BKS-2 cannot create fulfillment for BKS-1 Sales Order
    await expect(
      withTransaction((tx) =>
        createSalesFulfillment(tx, fx.warehouseUserWh2, {
          salesOrderId: so.header.id,
        }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // 3. Warehouse user BKS-1 creates fulfillment, picks, packs, and prepares DO
    const doId = await withTransaction(async (tx) => {
      const f = await createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
      });
      await recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: f.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: f.lines[0]!.id,
            grossWeightKg: "16.000",
            tareWeightKg: "1.000",
          },
        ],
      });
      await finalizeFulfillmentPacking(tx, fx.warehouseUserWh1, {
        fulfillmentId: f.fulfillment.id,
        checklist: {
          qualityChecked: true,
          packagingVerified: true,
          labelAttached: true,
          packageCount: 1,
        },
      });
      const d = await createDeliveryOrder(tx, fx.warehouseUserWh1, {
        fulfillmentId: f.fulfillment.id,
        driverUserId: fx.driverUserWh1.user.id,
        vehiclePlateNo: "B 9333 KAA",
      });
      await markDeliveryOrderReady(tx, fx.warehouseUserWh1, {
        deliveryOrderId: d.deliveryOrder.id,
      });
      return d.deliveryOrder.id;
    });

    // 4. Driver assigned to BKS-2 cannot dispatch or record POD for BKS-1 Delivery Order
    await expect(
      withTransaction((tx) =>
        dispatchDeliveryOrder(tx, fx.driverUserWh2, {
          deliveryOrderId: doId,
        }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // 5. Sales user (who lacks delivery.execute and fulfillment.pick_pack) cannot dispatch
    await expect(
      withTransaction((tx) =>
        dispatchDeliveryOrder(tx, fx.salesUserWh1, {
          deliveryOrderId: doId,
        }),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  // --------------------------------------------------------------------------
  // TEST 15: Immutable inventory movement and balanced GL/COGS impact
  // --------------------------------------------------------------------------
  it("15. menghasilkan mutasi stok immutable ('sales_pick_issue') dan jurnal HPP (COGS) yang seimbang tepat satu kali", async () => {
    expect(STOCK_LIFECYCLE_POLICY.PICKED_AND_ISSUED_ON).toBe("fulfillment.pick");
    expect(STOCK_LIFECYCLE_POLICY.COGS_POSTED_ON).toBe("fulfillment.pick");

    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t15_01",
      batchCode: "LOT/BKS1/2610/00141",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "40.000",
      unitCostBase: "15500.0000",
      bestBeforeDate: "2026-10-28",
    });

    const so = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "20.000",
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    const ful = await withTransaction((tx) =>
      createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
      }),
    );

    const pickRes = await withTransaction((tx) =>
      recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: ful.lines[0]!.id,
            grossWeightKg: "21.000",
            tareWeightKg: "1.000", // 20 kg * Rp 15,500 = Rp 310,000 COGS
          },
        ],
      }),
    );

    expect(pickRes.fulfillment.totalCogsAmount).toBe("310000.00");
    expect(pickRes.journalEntry).not.toBeNull();
    expect(pickRes.journalEntry!.totalDebit).toBe("310000.00");
    expect(pickRes.journalEntry!.totalCredit).toBe("310000.00");

    const cogsBalance = await getGlAccountBalance(fx.db, GL_ACCOUNT_CODES.COGS_FRUIT, {
      warehouseId: fx.warehouse1Id,
    });
    expect(cogsBalance.netBalance).toBe("310000.00");

    // Verify movement is immutable (attempting to UPDATE inventory_movements is blocked by PostgreSQL trigger)
    const movId = pickRes.allocations[0]!.movementId;
    await expect(
      fx.db
        .update(inventoryMovements)
        .set({ notes: "coba ubah" })
        .where(eq(inventoryMovements.id, movId)),
    ).rejects.toThrow();
  });

  // --------------------------------------------------------------------------
  // TEST 16: Concurrency test where two pickers attempt to pick the same scarce batch/reservation
  // --------------------------------------------------------------------------
  it("16. menangani konkurensi (Promise.all) saat dua proses picking memperebutkan reservasi/batch langka yang sama tanpa saldo negatif", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t16_scarce",
      batchCode: "LOT/BKS1/2610/00151",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "30.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-28",
    });

    const so = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "30.000",
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    // Two concurrent fulfillment documents created for the same 30 kg order
    const fulA = await withTransaction((tx) =>
      createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
      }),
    );
    const fulB = await withTransaction((tx) =>
      createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
      }),
    );

    const results = await Promise.allSettled([
      withTransaction((tx) =>
        recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
          fulfillmentId: fulA.fulfillment.id,
          picks: [
            {
              fulfillmentLineId: fulA.lines[0]!.id,
              grossWeightKg: "31.000",
              tareWeightKg: "1.000",
            },
          ],
        }),
      ),
      withTransaction((tx) =>
        recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
          fulfillmentId: fulB.fulfillment.id,
          picks: [
            {
              fulfillmentLineId: fulB.lines[0]!.id,
              grossWeightKg: "31.000",
              tareWeightKg: "1.000",
            },
          ],
        }),
      ),
    ]);

    const fulfilledCount = results.filter((r) => r.status === "fulfilled").length;
    const rejectedCount = results.filter((r) => r.status === "rejected").length;

    expect(fulfilledCount).toBe(1);
    expect(rejectedCount).toBe(1);

    const balances = await fx.db
      .select()
      .from(stockBalances)
      .where(eq(stockBalances.batchId, "batch_t16_scarce"));

    for (const b of balances) {
      expect(Number(b.qtyBase)).toBeGreaterThanOrEqual(0);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 17: Idempotency test for repeated picking, dispatch, and POD submissions
  // --------------------------------------------------------------------------
  it("17. menjamin idempotensi untuk request berulang pada picking, dispatch, dan pencatatan POD tanpa duplikasi efek samping", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t17_01",
      batchCode: "LOT/BKS1/2610/00161",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "50.000",
      unitCostBase: "15000.0000",
      bestBeforeDate: "2026-10-28",
    });

    const so = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "20.000",
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    const ful = await withTransaction((tx) =>
      createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
      }),
    );

    const pickPayload = {
      fulfillmentId: ful.fulfillment.id,
      idempotencyKey: "idem-pick-t17-001",
      picks: [
        {
          fulfillmentLineId: ful.lines[0]!.id,
          grossWeightKg: "21.000",
          tareWeightKg: "1.000",
        },
      ],
    };

    const pickFirst = await withTransaction((tx) =>
      recordFulfillmentPicking(tx, fx.warehouseUserWh1, pickPayload),
    );
    const pickReplay = await withTransaction((tx) =>
      recordFulfillmentPicking(tx, fx.warehouseUserWh1, pickPayload),
    );

    expect(pickReplay.fulfillment.id).toBe(pickFirst.fulfillment.id);
    expect(pickReplay.allocations[0]!.movementId).toBe(pickFirst.allocations[0]!.movementId);

    // Reusing the same idempotencyKey with a different payload must throw IdempotencyConflictError
    await expect(
      withTransaction((tx) =>
        recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
          ...pickPayload,
          picks: [
            {
              fulfillmentLineId: ful.lines[0]!.id,
              grossWeightKg: "22.000",
              tareWeightKg: "1.000",
            },
          ],
        }),
      ),
    ).rejects.toThrow(IdempotencyConflictError);

    await withTransaction((tx) =>
      finalizeFulfillmentPacking(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        checklist: {
          qualityChecked: true,
          packagingVerified: true,
          labelAttached: true,
          packageCount: 1,
        },
      }),
    );

    const doRes = await withTransaction(async (tx) => {
      const d = await createDeliveryOrder(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        driverUserId: fx.driverUserWh1.user.id,
        vehiclePlateNo: "B 9777 KAA",
      });
      await markDeliveryOrderReady(tx, fx.warehouseUserWh1, {
        deliveryOrderId: d.deliveryOrder.id,
      });
      return d.deliveryOrder;
    });

    // Idempotent dispatch
    const disp1 = await withTransaction((tx) =>
      dispatchDeliveryOrder(tx, fx.driverUserWh1, {
        deliveryOrderId: doRes.id,
        idempotencyKey: "idem-disp-t17-001",
      }),
    );
    const disp2 = await withTransaction((tx) =>
      dispatchDeliveryOrder(tx, fx.driverUserWh1, {
        deliveryOrderId: doRes.id,
        idempotencyKey: "idem-disp-t17-001",
      }),
    );
    expect(disp2.id).toBe(disp1.id);

    // Idempotent POD submission
    const podPayload = {
      deliveryOrderId: doRes.id,
      idempotencyKey: "idem-pod-t17-001",
      recipientName: "Pak Jaya",
      recipientRoleOrId: "Kepala Toko",
    };
    const pod1 = await withTransaction((tx) =>
      recordProofOfDelivery(tx, fx.driverUserWh1, podPayload),
    );
    const pod2 = await withTransaction((tx) =>
      recordProofOfDelivery(tx, fx.driverUserWh1, podPayload),
    );
    expect(pod2.pod.id).toBe(pod1.pod.id);
    expect(pod2.pod.podNumber).toBe(pod1.pod.podNumber);
  });

  // --------------------------------------------------------------------------
  // TEST 18: Full reconciliation between stock_balances, inventory_movements, and GL after fulfillment
  // --------------------------------------------------------------------------
  it("18. mempertahankan rekonsiliasi 100% antara stock_balances, inventory_movements, dan akun GL Persediaan (1140) setelah seluruh siklus pemenuhan & pengiriman", async () => {
    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t18_01",
      batchCode: "LOT/BKS1/2610/00171",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.manggaProductId,
      gradeId: fx.manggaGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "80.000",
      unitCostBase: "15250.0000",
      bestBeforeDate: "2026-10-25",
    });

    await seedBatchWithGl(fx.db, fx.owner, {
      batchId: "batch_t18_02",
      batchCode: "LOT/BKS1/2610/00172",
      warehouseId: fx.warehouse1Id,
      locationId: fx.coldRoomLocationId,
      productId: fx.jerukProductId,
      gradeId: fx.jerukGradeAId,
      gradeCode: "A",
      supplierId: fx.supplierId,
      qtyBase: "60.000",
      unitCostBase: "14500.0000",
      bestBeforeDate: "2026-10-29",
    });

    const so = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUserWh1, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouse1Id,
        orderDate: "2026-10-20",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "35.000",
          },
          {
            productId: fx.jerukProductId,
            gradeId: fx.jerukGradeAId,
            orderedUomCode: "kg",
            orderedQty: "20.000",
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUserWh1, { salesOrderId: created.header.id });
    });

    await withTransaction(async (tx) => {
      const ful = await createSalesFulfillment(tx, fx.warehouseUserWh1, {
        salesOrderId: so.header.id,
        fulfillmentDate: "2026-10-20",
      });

      await recordFulfillmentPicking(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        picks: [
          {
            fulfillmentLineId: ful.lines[0]!.id,
            grossWeightKg: "36.500",
            tareWeightKg: "1.500", // 35 kg Mangga
          },
          {
            fulfillmentLineId: ful.lines[1]!.id,
            grossWeightKg: "21.000",
            tareWeightKg: "1.000", // 20 kg Jeruk
          },
        ],
      });

      await finalizeFulfillmentPacking(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        checklist: {
          qualityChecked: true,
          packagingVerified: true,
          labelAttached: true,
          packageCount: 3,
        },
      });

      const d = await createDeliveryOrder(tx, fx.warehouseUserWh1, {
        fulfillmentId: ful.fulfillment.id,
        driverUserId: fx.driverUserWh1.user.id,
        vehiclePlateNo: "B 9888 KAA",
      });

      await markDeliveryOrderReady(tx, fx.warehouseUserWh1, {
        deliveryOrderId: d.deliveryOrder.id,
      });

      await dispatchDeliveryOrder(tx, fx.driverUserWh1, {
        deliveryOrderId: d.deliveryOrder.id,
      });

      await recordProofOfDelivery(tx, fx.driverUserWh1, {
        deliveryOrderId: d.deliveryOrder.id,
        recipientName: "Ibu Dewi",
        recipientRoleOrId: "Manajer Toko",
      });
    });

    const recon = await reconcileInventoryAndGl(fx.db, fx.owner, {
      warehouseId: fx.warehouse1Id,
    });

    expect(recon.isReconciled).toBe(true);
    expect(recon.qtyVarianceBase).toBe("0.000");
    expect(recon.ledgerVsBalanceValueVariance).toBe("0.00");
    expect(recon.inventoryVsGlVariance).toBe("0.00");

    // Verify list queries also return the created documents cleanly
    const fulfillments = await listSalesFulfillments(fx.db, fx.warehouseUserWh1, {
      warehouseId: fx.warehouse1Id,
    });
    expect(fulfillments).toHaveLength(1);

    const deliveries = await listDeliveryOrders(fx.db, fx.driverUserWh1, {
      warehouseId: fx.warehouse1Id,
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.pod).not.toBeNull();

    const claims = await listDeliveryClaims(fx.db, fx.warehouseUserWh1, {
      warehouseId: fx.warehouse1Id,
    });
    expect(claims).toHaveLength(0);
  });
});
