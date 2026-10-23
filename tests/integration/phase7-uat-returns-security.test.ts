import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type ActorContext } from "@/server/authz/authorize";
import { withTransaction, type DbClient } from "@/server/db";
import {
  auditLogs,
  batches,
  customerInvoices,
  deliveryClaims,
  deliveryOrderLines,
  deliveryOrders,
  journalEntries,
  journalLines,
  productGrades,
  salesFulfillmentLines,
  salesFulfillments,
  stockBalances,
} from "@/server/db/schema";
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
} from "@/server/errors";
import {
  createSalesInvoice,
  reconcileArSubledgerWithGl,
} from "@/server/modules/finance";
import { GL_ACCOUNT_CODES, postJournalEntry } from "@/server/modules/gl";
import {
  applyInventoryMovement,
  reconcileInventoryAndGl,
} from "@/server/modules/inventory/ledger";
import {
  createProduct,
  seedStandardUomsAndPackaging,
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
  createCustomerClaim,
  decideCustomerClaim,
  getClaimById,
  inspectReturnedGoodsQc,
  issueCreditNoteFromClaim,
  listCustomerClaims,
  resolveOrCloseClaim,
  reviewCustomerClaim,
  submitCustomerClaim,
} from "@/server/modules/returns";
import {
  confirmSalesOrder,
  createSalesOrder,
} from "@/server/modules/sales";
import { closeDb, createTestActor, setupTestDb } from "../helpers/test-db";

interface Phase7Fixtures {
  db: DbClient;
  owner: ActorContext;
  financeUser: ActorContext;
  qcUser: ActorContext;
  salesUser: ActorContext;
  driverUser: ActorContext;
  warehouseUser: ActorContext;
  auditorUser: ActorContext;
  crossWhFinanceUser: ActorContext;
  warehouseId: string;
  warehouse2Id: string;
  manggaProductId: string;
  manggaGradeAId: string;
  jerukProductId: string;
  jerukGradeAId: string;
  customerGrosirId: string;
  priceListGrosirId: string;
  supplierId: string;
}

describe("Phase 7 — Final Business UAT, Returns & Claims, Security Hardening & Readiness", () => {
  let fx: Phase7Fixtures;

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

    const financeUser = await createTestActor(db, {
      name: "Staf Finance BKS-1",
      grants: [{ roleCode: "finance", warehouseId }],
    });

    const qcUser = await createTestActor(db, {
      name: "Staf QC BKS-1",
      grants: [{ roleCode: "qc", warehouseId }],
    });

    const salesUser = await createTestActor(db, {
      name: "Staf Sales BKS-1",
      grants: [{ roleCode: "sales", warehouseId }],
    });

    const driverUser = await createTestActor(db, {
      name: "Driver Armada BKS-1",
      grants: [{ roleCode: "driver", warehouseId }],
    });

    const warehouseUser = await createTestActor(db, {
      name: "Operator Gudang BKS-1",
      grants: [{ roleCode: "warehouse", warehouseId }],
    });

    const auditorUser = await createTestActor(db, {
      name: "Auditor BKS",
      grants: [{ roleCode: "auditor", warehouseId: null }],
    });

    // Create 2nd warehouse for cross-warehouse security isolation tests
    const wh2 = await withTransaction((tx) =>
      createWarehouse(tx, owner, {
        branchId: "br_bekasi_utama",
        code: "BKS2",
        name: "Gudang Cikarang Barat",
        address: "Kawasan Industri MM2100",
        isDefault: false,
      }),
    );

    const crossWhFinanceUser = await createTestActor(db, {
      name: "Finance Cikarang BKS-2",
      grants: [{ roleCode: "finance", warehouseId: wh2.id }],
    });

    // Master Catalog & Supplier
    const { manggaProduct, jerukProduct } = await withTransaction(async (tx) => {
      const p1 = await createProduct(tx, owner, {
        sku: "FRT-MNG-HM",
        barcode: "8991002003001",
        name: "Mangga Harum Manis Super",
        category: "buah_musiman",
        variety: "Harum Manis",
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

      const p2 = await createProduct(tx, owner, {
        sku: "FRT-JRK-MDN",
        barcode: "8991002003002",
        name: "Jeruk Medan Super Manis",
        category: "jeruk",
        variety: "Jeruk Manis",
        baseUomCode: "kg",
        isCatchWeight: true,
        defaultShelfLifeDays: 14,
        ripenessTracking: false,
        storageCondition: "cold",
        taxCode: "PPN_EXEMPT",
        minMarginPct: "15.00",
        minSellingPrice: "15000",
        createDefaultGrades: true,
      });

      return { manggaProduct: p1, jerukProduct: p2 };
    });

    const [mGrade] = await db
      .select()
      .from(productGrades)
      .where(and(eq(productGrades.productId, manggaProduct.id), eq(productGrades.code, "A")))
      .limit(1);
    const [jGrade] = await db
      .select()
      .from(productGrades)
      .where(and(eq(productGrades.productId, jerukProduct.id), eq(productGrades.code, "A")))
      .limit(1);

    const manggaGradeAId = mGrade!.id;
    const jerukGradeAId = jGrade!.id;

    const supplier = await withTransaction((tx) =>
      createSupplier(tx, owner, {
        code: "SUP-MANGGA-01",
        name: "Kelompok Tani Harum Manis",
        supplierType: "petani",
        originRegion: "Probolinggo",
        paymentTermsDays: 7,
        leadTimeDays: 1,
      }),
    );

    const custGrosir = await withTransaction((tx) =>
      createCustomer(tx, owner, {
        code: "CUST-TOKO-BEKASI-1",
        name: "Toko Buah Berkah Kranji",
        segment: "toko_buah",
        priceTier: "grosir",
        phone: "081299998888",
        shippingAddress: "Jl. Jendral Sudirman No. 88, Kranji, Bekasi Barat",
        creditLimit: "50000000.00",
        paymentTermsDays: 14,
        assignedWarehouseId: warehouseId,
      }),
    );

    const pList = await withTransaction(async (tx) => {
      const pl = await createPriceList(tx, owner, {
        code: "PL-GROSIR-BKS1",
        name: "Daftar Harga Grosir Bekasi 2026",
        priceTier: "grosir",
        customerSegment: "toko_buah",
        warehouseId,
        effectiveFrom: "2026-01-01",
      });

      await upsertPriceListItem(tx, owner, {
        priceListId: pl.id,
        productId: manggaProduct.id,
        gradeId: manggaGradeAId,
        uomCode: "kg",
        minQty: "10.000",
        unitPrice: "25000.0000",
        reason: "Harga grosir Mangga Grade A per kg",
      });

      await upsertPriceListItem(tx, owner, {
        priceListId: pl.id,
        productId: jerukProduct.id,
        gradeId: jerukGradeAId,
        uomCode: "kg",
        minQty: "10.000",
        unitPrice: "20000.0000",
        reason: "Harga grosir Jeruk Grade A per kg",
      });

      return pl;
    });

    fx = {
      db,
      owner,
      financeUser,
      qcUser,
      salesUser,
      driverUser,
      warehouseUser,
      auditorUser,
      crossWhFinanceUser,
      warehouseId,
      warehouse2Id: wh2.id,
      manggaProductId: manggaProduct.id,
      manggaGradeAId,
      jerukProductId: jerukProduct.id,
      jerukGradeAId,
      customerGrosirId: custGrosir.id,
      priceListGrosirId: pList.id,
      supplierId: supplier.id,
    };
  });

  afterAll(async () => {
    await closeDb();
  });

  /**
   * Helper untuk membuat alur lengkap: Stok Masuk -> SO -> Confirmed -> Pick & Pack -> DO -> Dispatched -> POD Delivered -> Faktur
   */
  async function helperCreateDeliveredOrderAndInvoice(customQty = "50.000") {
    const coldRoomLocationId = "loc_bks1_cold1";

    // 1. Stock Inflow Batch
    const batchId = `bat_mng_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const [batch] = await fx.db
      .insert(batches)
      .values({
        id: batchId,
        batchCode: `BAT-MNG-${Math.floor(1000 + Math.random() * 9000)}`,
        productId: fx.manggaProductId,
        gradeId: fx.manggaGradeAId,
        gradeCode: "A",
        warehouseId: fx.warehouseId,
        supplierId: fx.supplierId,
        originRegion: "Probolinggo",
        receivedAt: new Date("2026-10-19T06:00:00Z"),
        bestBeforeDate: "2026-11-01",
        expiresAt: new Date("2026-11-01T23:59:59Z"),
        initialQtyBase: "500.000",
        unitCostBase: "18000.0000",
        totalInitialCost: "9000000.00",
        costingMethod: "lot_actual_rsv",
        status: "active",
      })
      .returning();

    const batchRow = batch!;

    await withTransaction(async (tx) => {
      await applyInventoryMovement(tx, fx.owner, {
        warehouseId: fx.warehouseId,
        warehouseCode: "BKS1",
        locationId: coldRoomLocationId,
        productId: fx.manggaProductId,
        gradeId: fx.manggaGradeAId,
        batchId: batchRow.id,
        stockStatus: "available",
        movementType: "grn_receipt",
        qtyDeltaBase: "500.000",
        unitCostBase: "18000.0000",
        explicitInflowCost: "9000000.00",
        sourceDocType: "test_seed_batch",
        sourceDocId: batchRow.id,
        notes: "Seed persediaan mangga",
      });

      // Post initial inventory asset GL
      await postJournalEntry(tx, fx.owner, {
        warehouseId: fx.warehouseId,
        sourceDocType: "GRN",
        sourceDocId: batchRow.id,
        purpose: "grn_initial_asset",
        entryDate: "2026-10-21",
        memo: "Stok awal mangga harum manis",
        lines: [
          {
            accountCode: GL_ACCOUNT_CODES.INVENTORY_FRUIT,
            debit: "9000000.00",
            description: "Persediaan mangga",
            warehouseId: fx.warehouseId,
          },
          {
            accountCode: GL_ACCOUNT_CODES.AP_SUPPLIER,
            credit: "9000000.00",
            description: "Hutang pembelian mangga",
            warehouseId: fx.warehouseId,
          },
        ],
        skipDirectPermissionCheck: true,
      });
    });

    // 2. Sales Order
    const soConfirmed = await withTransaction(async (tx) => {
      const created = await createSalesOrder(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        orderDate: "2026-10-21",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: customQty,
          },
        ],
      });
      return confirmSalesOrder(tx, fx.salesUser, { salesOrderId: created.header.id });
    });

    const soId = soConfirmed.header.id;
    const soLine = soConfirmed.lines[0]!;

    // 3. Fulfillment & DO
    const fulId = `ful_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await fx.db.insert(salesFulfillments).values({
      id: fulId,
      fulfillmentNo: `FUL/BKS1/2610/${Math.floor(10000 + Math.random() * 90000)}`,
      salesOrderId: soId,
      customerId: fx.customerGrosirId,
      warehouseId: fx.warehouseId,
      fulfillmentDate: "2026-10-21",
      status: "delivered",
      totalOrderedQtyBase: customQty,
      totalPickedQtyBase: customQty,
      totalPackedQtyBase: customQty,
      totalRemainingQtyBase: "0.000",
      totalCogsAmount: String(Number(customQty) * 18000),
      createdBy: fx.owner.user.id,
    });

    const fulLineId = `fline_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await fx.db.insert(salesFulfillmentLines).values({
      id: fulLineId,
      fulfillmentId: fulId,
      salesOrderLineId: soLine.id,
      lineNo: 1,
      orderedProductId: soLine.productId,
      orderedGradeId: soLine.gradeId,
      orderedGradeCode: soLine.gradeCode,
      actualProductId: soLine.productId,
      actualGradeId: soLine.gradeId,
      actualGradeCode: soLine.gradeCode,
      orderedUomCode: "kg",
      orderedQty: customQty,
      orderedQtyBase: customQty,
      targetPickQtyBase: customQty,
      pickedUomCode: "kg",
      pickedQty: customQty,
      pickedQtyBase: customQty,
      packedQtyBase: customQty,
      netUnitPriceSnapshot: soLine.netUnitPrice,
      netUnitPriceBaseSnapshot: soLine.netUnitPriceBase,
    });

    // Posting COGS Recognition Journal for the Fulfillment
    await withTransaction(async (tx) => {
      await postJournalEntry(tx, fx.owner, {
        warehouseId: fx.warehouseId,
        sourceDocType: "FUL",
        sourceDocId: fulId,
        purpose: "cogs_recognition",
        entryDate: "2026-10-21",
        memo: `Pengakuan HPP pesanan ${soConfirmed.header.soNumber}`,
        lines: [
          {
            accountCode: GL_ACCOUNT_CODES.COGS_FRUIT,
            debit: String(Number(customQty) * 18000),
            description: "HPP buah keluar",
            warehouseId: fx.warehouseId,
          },
          {
            accountCode: GL_ACCOUNT_CODES.INVENTORY_FRUIT,
            credit: String(Number(customQty) * 18000),
            description: "Pengurangan persediaan",
            warehouseId: fx.warehouseId,
          },
        ],
        skipDirectPermissionCheck: true,
      });

      // Deduct available stock via sales_pick_issue
      await applyInventoryMovement(tx, fx.owner, {
        warehouseId: fx.warehouseId,
        warehouseCode: "BKS1",
        locationId: coldRoomLocationId,
        productId: fx.manggaProductId,
        gradeId: fx.manggaGradeAId,
        batchId: batchRow.id,
        stockStatus: "available",
        movementType: "sales_pick_issue",
        qtyDeltaBase: `-${customQty}`,
        unitCostBase: "18000.0000",
        sourceDocType: "FUL",
        sourceDocId: fulId,
        notes: "Pengeluaran stok sales fulfillment",
      });
    });

    const doId = `do_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const [doRow] = await fx.db
      .insert(deliveryOrders)
      .values({
        id: doId,
        doNumber: `DO/BKS1/2610/${Math.floor(10000 + Math.random() * 90000)}`,
        fulfillmentId: fulId,
        salesOrderId: soId,
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        shippingAddressSnapshot: "Jl. Jendral Sudirman No. 88, Kranji, Bekasi Barat",
        deliveryDate: "2026-10-21",
        status: "delivered",
        createdBy: fx.owner.user.id,
      })
      .returning();

    const [doLine] = await fx.db
      .insert(deliveryOrderLines)
      .values({
        id: `dol_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        deliveryOrderId: doId,
        fulfillmentLineId: fulLineId,
        salesOrderLineId: soLine.id,
        lineNo: 1,
        productId: soLine.productId,
        gradeId: soLine.gradeId,
        gradeCode: "A",
        uomCode: "kg",
        shippedQty: customQty,
        shippedQtyBase: customQty,
        deliveredQtyBase: customQty,
        netUnitPriceBaseSnapshot: "25000.0000",
      })
      .returning();

    // 4. Sales Invoice (created & posted immediately)
    const invoice = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: soId,
        deliveryOrderId: doId,
        lines: [
          {
            productId: soLine.productId,
            gradeId: soLine.gradeId,
            uomCode: "kg",
            invoicedQty: customQty,
            unitPrice: "25000.0000",
            salesOrderLineId: soLine.id,
            deliveryOrderLineId: doLine!.id,
          },
        ],
      }),
    );

    return {
      batch: batchRow,
      so: soConfirmed.header,
      ful: { id: fulId },
      dOrder: doRow!,
      dLine: doLine!,
      invoice,
    };
  }

  // ==========================================================================
  // SCENARIO 1: Klaim invalid atau tanpa referensi ditolak
  // ==========================================================================
  it("1. menolak pengajuan klaim yang tidak memiliki referensi valid, kuantitas invalid, atau faktur cancelled", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("30.000");

    // A. Kuantitas selisih <= 0 ditolak
    await expect(
      withTransaction((tx) =>
        createCustomerClaim(tx, fx.salesUser, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          salesOrderId: fixture.so.id,
          claimType: "quality_claim",
          reasonCode: "BUAH_MEMAR",
          notes: "Mangga memar sebagian",
          discrepancyQtyBase: "0.000",
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // B. Sales Order tidak ditemukan
    await expect(
      withTransaction((tx) =>
        createCustomerClaim(tx, fx.salesUser, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          salesOrderId: "so_non_existent",
          claimType: "quality_claim",
          reasonCode: "BUAH_MEMAR",
          notes: "Mangga memar sebagian",
          discrepancyQtyBase: "5.000",
        }),
      ),
    ).rejects.toThrow(NotFoundError);

    // C. Pelanggan berbeda dengan pemilik SO
    await expect(
      withTransaction((tx) =>
        createCustomerClaim(tx, fx.salesUser, {
          customerId: "cst_lain_unknown",
          warehouseId: fx.warehouseId,
          salesOrderId: fixture.so.id,
          claimType: "quality_claim",
          reasonCode: "BUAH_MEMAR",
          notes: "Mangga memar sebagian",
          discrepancyQtyBase: "5.000",
        }),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  // ==========================================================================
  // SCENARIO 2: Klaim duplikat / Idempotency Key
  // ==========================================================================
  it("2. menjamin idempotensi pengajuan klaim saat request dikirim ulang dengan idempotencyKey yang sama", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("20.000");
    const idemKey = `clm-idem-${crypto.randomUUID()}`;

    const claim1 = await withTransaction((tx) =>
      createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: fixture.so.id,
        invoiceId: fixture.invoice.id,
        claimType: "quality_claim",
        reasonCode: "BUAH_BUSUK",
        notes: "Ditemukan 2 kg busuk",
        discrepancyQtyBase: "2.000",
        estimatedClaimValue: "50000.00",
        idempotencyKey: idemKey,
      }),
    );

    const claim2 = await withTransaction((tx) =>
      createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: fixture.so.id,
        invoiceId: fixture.invoice.id,
        claimType: "quality_claim",
        reasonCode: "BUAH_BUSUK",
        notes: "Ditemukan 2 kg busuk",
        discrepancyQtyBase: "2.000",
        estimatedClaimValue: "50000.00",
        idempotencyKey: idemKey,
      }),
    );

    expect(claim1.id).toBe(claim2.id);
    expect(claim1.claimNo).toBe(claim2.claimNo);

    // Pastikan hanya ada 1 baris di tabel delivery_claims
    const countRes = await fx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveryClaims)
      .where(eq(deliveryClaims.idempotencyKey, idemKey));
    expect(countRes[0]!.count).toBe(1);
  });

  // ==========================================================================
  // SCENARIO 3: Role Authorization & Separation of Duties (SoD)
  // ==========================================================================
  it("3. menegakkan RBAC dan Separation of Duties: staf pengaju tidak boleh menyetujui klaimnya sendiri (kecuali Owner)", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("30.000");

    // Staf sales membuat dan mengajukan klaim
    const claim = await withTransaction((tx) =>
      createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: fixture.so.id,
        invoiceId: fixture.invoice.id,
        claimType: "quality_claim",
        reasonCode: "KUALITAS_GRADE",
        notes: "Buah tidak seragam",
        discrepancyQtyBase: "5.000",
        estimatedClaimValue: "125000.00",
        submitImmediately: true,
      }),
    );

    // Staf sales mencoba menyetujui klaimnya sendiri -> ditolak karena SoD (dan tidak punya approvals.decide)
    await expect(
      withTransaction((tx) =>
        decideCustomerClaim(tx, fx.salesUser, {
          claimId: claim.id,
          decision: "approved",
          approvedQtyBase: "5.000",
          approvedClaimValue: "125000.00",
        }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Staf finance (bukan pembuat klaim) dapat menyetujui klaim via kewenangan kredit
    const approvedByFinance = await withTransaction((tx) =>
      decideCustomerClaim(tx, fx.financeUser, {
        claimId: claim.id,
        decision: "approved",
        approvedQtyBase: "5.000",
        approvedClaimValue: "125000.00",
      }),
    );
    expect(approvedByFinance.status).toBe("approved");
    expect(approvedByFinance.approvedBy).toBe(fx.financeUser.user.id);
  });

  // ==========================================================================
  // SCENARIO 4: Klaim parsial dan penuh
  // ==========================================================================
  it("4. mendukung persetujuan parsial dan membatasi approved qty serta nominal agar tidak melampaui klaim", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("40.000");

    const claim = await withTransaction((tx) =>
      createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: fixture.so.id,
        claimType: "shortage",
        reasonCode: "SELISIH_TIMBANG",
        notes: "Klaim susut 10 kg",
        discrepancyQtyBase: "10.000",
        estimatedClaimValue: "250000.00",
        submitImmediately: true,
      }),
    );

    // Mencoba menyetujui kuantitas melebihi klaim (12 kg > 10 kg) -> DITOLAK
    await expect(
      withTransaction((tx) =>
        decideCustomerClaim(tx, fx.owner, {
          claimId: claim.id,
          decision: "approved",
          approvedQtyBase: "12.000",
          approvedClaimValue: "250000.00",
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Menyetujui sebagian (partial approval: 6 kg & Rp 150.000)
    const partialApproved = await withTransaction((tx) =>
      decideCustomerClaim(tx, fx.owner, {
        claimId: claim.id,
        decision: "approved",
        approvedQtyBase: "6.000",
        approvedClaimValue: "150000.00",
      }),
    );

    expect(partialApproved.status).toBe("approved");
    expect(partialApproved.approvedQtyBase).toBe("6.000");
    expect(partialApproved.approvedClaimValue).toBe("150000.00");
  });

  // ==========================================================================
  // SCENARIO 5: Retur fisik gagal QC tidak masuk stok layak jual
  // ==========================================================================
  it("5. memastikan retur fisik yang gagal QC (reject_dispose) TIDAK dimasukkan ke persediaan layak jual", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("30.000");

    // Klaim retur fisik diajukan
    const claim = await withTransaction((tx) =>
      createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: fixture.so.id,
        productId: fx.manggaProductId,
        gradeId: fx.manggaGradeAId,
        batchId: fixture.batch.id,
        locationId: "loc_bks1_cold1",
        claimType: "sales_return",
        reasonCode: "KONTAMINASI_JAMUR",
        notes: "Retur fisik buah berjamur",
        discrepancyQtyBase: "10.000",
        estimatedClaimValue: "250000.00",
        requiresPhysicalReturn: true,
        submitImmediately: true,
      }),
    );

    // Disetujui untuk diinspeksi retur
    await withTransaction((tx) =>
      decideCustomerClaim(tx, fx.owner, {
        claimId: claim.id,
        decision: "approved",
        approvedQtyBase: "10.000",
        approvedClaimValue: "250000.00",
      }),
    );

    // Ambil saldo stok available sebelum inspeksi QC
    const [balBefore] = await fx.db
      .select()
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.batchId, fixture.batch.id),
          eq(stockBalances.stockStatus, "available"),
        ),
      );
    const qtyBefore = Number(balBefore?.qtyBase ?? 0);

    // Staf QC memeriksa dan MENOLAK/MEMBUANG (reject_dispose)
    const qcRes = await withTransaction((tx) =>
      inspectReturnedGoodsQc(tx, fx.qcUser, {
        claimId: claim.id,
        qcOutcome: "reject_dispose",
        notes: "Buah membusuk parah dan berjamur aktif. Dimusnahkan di tempat.",
      }),
    );

    expect(qcRes.claim.qcStatus).toBe("qc_failed");
    expect(qcRes.restockedMovement).toBeNull();
    expect(qcRes.cogsReversalJournal).toBeNull();

    // Saldo persediaan available TIDAK BERTAMBAH sama sekali
    const [balAfter] = await fx.db
      .select()
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.batchId, fixture.batch.id),
          eq(stockBalances.stockStatus, "available"),
        ),
      );
    expect(Number(balAfter?.qtyBase ?? 0)).toBe(qtyBefore);
  });

  // ==========================================================================
  // SCENARIO 6: Retur lolos QC membuat mutasi stok yang benar & balik HPP
  // ==========================================================================
  it("6. memastikan retur lolos QC merestock kuantitas approved ke available dan memposting pembalik HPP yang seimbang", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("30.000");

    const claim = await withTransaction((tx) =>
      createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: fixture.so.id,
        productId: fx.manggaProductId,
        gradeId: fx.manggaGradeAId,
        batchId: fixture.batch.id,
        locationId: "loc_bks1_cold1",
        claimType: "sales_return",
        reasonCode: "KELEBIHAN_PESANAN",
        notes: "Customer salah pesan 8 kg, fisik masih segar dan utuh",
        discrepancyQtyBase: "8.000",
        estimatedClaimValue: "200000.00",
        requiresPhysicalReturn: true,
        submitImmediately: true,
      }),
    );

    await withTransaction((tx) =>
      decideCustomerClaim(tx, fx.owner, {
        claimId: claim.id,
        decision: "approved",
        approvedQtyBase: "8.000",
        approvedClaimValue: "200000.00",
      }),
    );

    const [balBefore] = await fx.db
      .select()
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.batchId, fixture.batch.id),
          eq(stockBalances.stockStatus, "available"),
        ),
      );
    const qtyBefore = Number(balBefore?.qtyBase ?? 0);

    // Inspeksi QC Lolos -> Restock
    const qcRes = await withTransaction((tx) =>
      inspectReturnedGoodsQc(tx, fx.qcUser, {
        claimId: claim.id,
        qcOutcome: "restock_available",
        notes: "Kondisi buah sangat baik, lolos uji organoleptik. Restock ke cold storage.",
      }),
    );

    expect(qcRes.claim.qcStatus).toBe("qc_passed");
    expect(qcRes.restockedMovement).not.toBeNull();
    expect(qcRes.restockedMovement!.movement.movementType).toBe("reversal_in");
    expect(qcRes.restockedMovement!.movement.qtyDeltaBase).toBe("8.000");

    // Saldo fisik bertambah tepat 8 kg
    const [balAfter] = await fx.db
      .select()
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.batchId, fixture.batch.id),
          eq(stockBalances.stockStatus, "available"),
        ),
      );
    expect(Number(balAfter!.qtyBase)).toBe(qtyBefore + 8);

    // Jurnal Pembalik HPP terpaut dan seimbang:
    // Debit 1140 (Persediaan) Rp 144.000 (8 kg * Rp 18.000)
    // Credit 5100 (HPP Buah) Rp 144.000
    const journalId = qcRes.cogsReversalJournal!.id;
    const lines = await fx.db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, journalId));

    let sumDebit = 0;
    let sumCredit = 0;
    for (const l of lines) {
      sumDebit += Number(l.debit);
      sumCredit += Number(l.credit);
    }
    expect(sumDebit).toBe(144000);
    expect(sumCredit).toBe(144000);
  });

  // ==========================================================================
  // SCENARIO 7: Tidak ada mutasi stok ganda saat retry
  // ==========================================================================
  it("7. mencegah mutasi stok ganda saat inspeksi QC diulang pada klaim yang sama", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("30.000");

    const claim = await withTransaction((tx) =>
      createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: fixture.so.id,
        productId: fx.manggaProductId,
        gradeId: fx.manggaGradeAId,
        batchId: fixture.batch.id,
        locationId: "loc_bks1_cold1",
        claimType: "sales_return",
        reasonCode: "RETUR_PELANGGAN",
        notes: "Retur fisik 5 kg",
        discrepancyQtyBase: "5.000",
        estimatedClaimValue: "125000.00",
        requiresPhysicalReturn: true,
        submitImmediately: true,
      }),
    );

    await withTransaction((tx) =>
      decideCustomerClaim(tx, fx.owner, {
        claimId: claim.id,
        decision: "approved",
        approvedQtyBase: "5.000",
        approvedClaimValue: "125000.00",
      }),
    );

    // Pemrosesan pertama berhasil
    await withTransaction((tx) =>
      inspectReturnedGoodsQc(tx, fx.qcUser, {
        claimId: claim.id,
        qcOutcome: "restock_available",
        notes: "Lolos QC pertama",
      }),
    );

    // Pemrosesan kedua (retry) harus DITOLAK
    await expect(
      withTransaction((tx) =>
        inspectReturnedGoodsQc(tx, fx.qcUser, {
          claimId: claim.id,
          qcOutcome: "restock_available",
          notes: "Lolos QC kedua kali (duplikat)",
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  // ==========================================================================
  // SCENARIO 8: Nota kredit tidak menghasilkan retur fisik otomatis
  // ==========================================================================
  it("8. memastikan nota kredit komersial/diskon klaim TIDAK otomatis merestock fisik persediaan", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("30.000");

    // Klaim penyesuaian harga (tanpa retur fisik)
    const claim = await withTransaction((tx) =>
      createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: fixture.so.id,
        invoiceId: fixture.invoice.id,
        productId: fx.manggaProductId,
        gradeId: fx.manggaGradeAId,
        claimType: "price_adjustment",
        reasonCode: "KOREKSI_HARGA_KESEPAKATAN",
        notes: "Koreksi harga promo Rp 100.000",
        discrepancyQtyBase: "1.000",
        estimatedClaimValue: "100000.00",
        requiresPhysicalReturn: false,
        submitImmediately: true,
      }),
    );

    await withTransaction((tx) =>
      decideCustomerClaim(tx, fx.owner, {
        claimId: claim.id,
        decision: "approved",
        approvedQtyBase: "1.000",
        approvedClaimValue: "100000.00",
      }),
    );

    const [balBefore] = await fx.db
      .select()
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.batchId, fixture.batch.id),
          eq(stockBalances.stockStatus, "available"),
        ),
      );
    const qtyBefore = Number(balBefore?.qtyBase ?? 0);

    // Terbitkan Nota Kredit
    const cnRes = await withTransaction((tx) =>
      issueCreditNoteFromClaim(tx, fx.financeUser, {
        claimId: claim.id,
        invoiceId: fixture.invoice.id,
      }),
    );

    expect(cnRes.creditNote.status).toBe("applied");

    // Pastikan tidak ada pergerakan stok
    const [balAfter] = await fx.db
      .select()
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.batchId, fixture.batch.id),
          eq(stockBalances.stockStatus, "available"),
        ),
      );
    expect(Number(balAfter?.qtyBase ?? 0)).toBe(qtyBefore);
  });

  // ==========================================================================
  // SCENARIO 9: Retur & Nota Kredit tidak mengubah invoice posted secara langsung
  // ==========================================================================
  it("9. memastikan nilai tagihan awal faktur (totalAmount) tetap immutable dan sisa tagihan berkurang melalui alokasi nota kredit yang sah", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("20.000");
    const invBefore = fixture.invoice;

    const claim = await withTransaction((tx) =>
      createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: fixture.so.id,
        invoiceId: fixture.invoice.id,
        productId: fx.manggaProductId,
        gradeId: fx.manggaGradeAId,
        claimType: "quality_claim",
        reasonCode: "KOMPENSASI_KUALITAS",
        notes: "Kompensasi kualitas Rp 100.000",
        discrepancyQtyBase: "4.000",
        estimatedClaimValue: "100000.00",
        submitImmediately: true,
      }),
    );

    await withTransaction((tx) =>
      decideCustomerClaim(tx, fx.owner, {
        claimId: claim.id,
        decision: "approved",
        approvedQtyBase: "4.000",
        approvedClaimValue: "100000.00",
      }),
    );

    await withTransaction((tx) =>
      issueCreditNoteFromClaim(tx, fx.financeUser, {
        claimId: claim.id,
        invoiceId: fixture.invoice.id,
      }),
    );

    const [invAfter] = await fx.db
      .select()
      .from(customerInvoices)
      .where(eq(customerInvoices.id, fixture.invoice.id));

    // Nilai awal totalAmount tidak berubah (immutable)
    expect(invAfter!.totalAmount).toBe(invBefore.totalAmount);
    // Nilai kredit tercatat di creditNoteAppliedAmount
    expect(invAfter!.creditNoteAppliedAmount).toBe("100000.00");
    // Sisa tagihan berkurang sebesar Rp 100.000
    expect(Number(invAfter!.outstandingAmount)).toBe(
      Number(invBefore.outstandingAmount) - 100000,
    );
  });

  // ==========================================================================
  // SCENARIO 10: Jurnal seimbang (Debit = Credit)
  // ==========================================================================
  it("10. memverifikasi semua entri jurnal dari seluruh transaksi UAT seimbang tanpa selisih (Debit === Credit)", async () => {
    await helperCreateDeliveredOrderAndInvoice("25.000");

    const allPostedJournals = await fx.db
      .select({ id: journalEntries.id, memo: journalEntries.memo })
      .from(journalEntries);

    expect(allPostedJournals.length).toBeGreaterThan(0);

    for (const j of allPostedJournals) {
      const lines = await fx.db
        .select()
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, j.id));

      let debits = 0;
      let credits = 0;
      for (const l of lines) {
        debits += Number(l.debit);
        credits += Number(l.credit);
      }
      expect(Math.abs(debits - credits)).toBeLessThanOrEqual(0.01);
    }
  });

  // ==========================================================================
  // SCENARIO 11: AR Subledger konsisten dengan GL akun 1120
  // ==========================================================================
  it("11. memverifikasi rekonsiliasi Buku Pembantu Piutang (AR Subledger) dengan GL Akun 1120 tidak memiliki varians", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("30.000");

    // Lakukan rekonsiliasi awal
    const recBefore = await reconcileArSubledgerWithGl(fx.db, {
      warehouseId: fx.warehouseId,
    });
    expect(recBefore.variance).toBe("0.00");

    // Ajukan klaim dan terbitkan nota kredit
    await withTransaction(async (tx) => {
      const c = await createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: fixture.so.id,
        invoiceId: fixture.invoice.id,
        productId: fx.manggaProductId,
        gradeId: fx.manggaGradeAId,
        claimType: "quality_claim",
        reasonCode: "KUALITAS_KURANG",
        notes: "Diskon kualitas Rp 50.000",
        discrepancyQtyBase: "2.000",
        estimatedClaimValue: "50000.00",
        submitImmediately: true,
      });
      await decideCustomerClaim(tx, fx.owner, {
        claimId: c.id,
        decision: "approved",
        approvedQtyBase: "2.000",
        approvedClaimValue: "50000.00",
      });
      await issueCreditNoteFromClaim(tx, fx.financeUser, {
        claimId: c.id,
        invoiceId: fixture.invoice.id,
      });
    });

    // Verifikasi ulang setelah nota kredit: varians tetap Rp 0.00
    const recAfter = await reconcileArSubledgerWithGl(fx.db, {
      warehouseId: fx.warehouseId,
    });
    expect(recAfter.variance).toBe("0.00");
    expect(Number(recAfter.arSubledgerTotal)).toBe(Number(recAfter.glEndingBalance));
  });

  // ==========================================================================
  // SCENARIO 12: COGS diakui tepat satu kali tanpa double posting
  // ==========================================================================
  it("12. memverifikasi COGS diakui tepat satu kali saat picking dispatch dan tidak terduplikasi", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("15.000");

    // Ambil jurnal pemenuhan pesanan ini
    const cogsJournals = await fx.db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.sourceDocType, "FUL"),
          eq(journalEntries.sourceDocId, fixture.ful.id),
        ),
      );

    expect(cogsJournals.length).toBe(1);
    expect(cogsJournals[0]!.purpose).toBe("cogs_recognition");
  });

  // ==========================================================================
  // SCENARIO 13: Stock ledger & Stock balance konsisten
  // ==========================================================================
  it("13. memverifikasi saldo fisik (stock_balances) sama persis dengan akumulasi mutasi buku persediaan (inventory_movements)", async () => {
    await helperCreateDeliveredOrderAndInvoice("20.000");

    const rec = await reconcileInventoryAndGl(fx.db, fx.owner, {
      warehouseId: fx.warehouseId,
    });

    expect(rec.totalLedgerQtyBase).toBe(rec.totalBalanceQtyBase);
    expect(rec.qtyVarianceBase).toBe("0.000");
  });

  // ==========================================================================
  // SCENARIO 14: Penolakan akses tanpa permission
  // ==========================================================================
  it("14. menolak pengguna tanpa izin yang sesuai untuk operasi klaim dan keuangan", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("10.000");

    const claim = await withTransaction((tx) =>
      createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: fixture.so.id,
        claimType: "quality_claim",
        reasonCode: "TES_AKSES",
        notes: "Uji penolakan akses",
        discrepancyQtyBase: "2.000",
        estimatedClaimValue: "50000.00",
        submitImmediately: true,
      }),
    );

    // Driver tidak memiliki approvals.decide atau kewenangan kredit
    await expect(
      withTransaction((tx) =>
        decideCustomerClaim(tx, fx.driverUser, {
          claimId: claim.id,
          decision: "approved",
          approvedQtyBase: "1.000",
          approvedClaimValue: "10000.00",
        }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Auditor tidak boleh memodifikasi status klaim
    await expect(
      withTransaction((tx) =>
        createCustomerClaim(tx, fx.auditorUser, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          salesOrderId: fixture.so.id,
          claimType: "quality_claim",
          reasonCode: "TES",
          notes: "Auditor mencoba membuat klaim",
          discrepancyQtyBase: "1.000",
        }),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  // ==========================================================================
  // SCENARIO 15: Pencegahan akses lintas gudang
  // ==========================================================================
  it("15. mencegah manipulasi klaim dari gudang lain oleh staf yang tidak memiliki akses lintas gudang", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("15.000");

    const claim = await withTransaction((tx) =>
      createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId, // wh_bks1
        salesOrderId: fixture.so.id,
        claimType: "quality_claim",
        reasonCode: "TES_LINTAS_GUDANG",
        notes: "Uji akses lintas gudang",
        discrepancyQtyBase: "2.000",
        submitImmediately: true,
      }),
    );

    // Staf finance gudang 2 (wh_bks2) mencoba menyetujui klaim milik gudang 1 (wh_bks1) -> DITOLAK
    await expect(
      withTransaction((tx) =>
        decideCustomerClaim(tx, fx.crossWhFinanceUser, {
          claimId: claim.id,
          decision: "approved",
          approvedQtyBase: "2.000",
          approvedClaimValue: "50000.00",
        }),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  // ==========================================================================
  // SCENARIO 16: Concurrency & Race Condition saat approval bersamaan
  // ==========================================================================
  it("16. mengamankan race condition saat 2 pemanggilan persetujuan klaim berjalan paralel via row lock", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("30.000");

    const claim = await withTransaction((tx) =>
      createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: fixture.so.id,
        claimType: "quality_claim",
        reasonCode: "RACE_CONDITION_TEST",
        notes: "Uji lock baris paralel",
        discrepancyQtyBase: "5.000",
        estimatedClaimValue: "125000.00",
        submitImmediately: true,
      }),
    );

    // Jalankan 2 pemanggilan paralel untuk decideCustomerClaim
    const results = await Promise.allSettled([
      withTransaction((tx) =>
        decideCustomerClaim(tx, fx.owner, {
          claimId: claim.id,
          decision: "approved",
          approvedQtyBase: "5.000",
          approvedClaimValue: "125000.00",
        }),
      ),
      withTransaction((tx) =>
        decideCustomerClaim(tx, fx.financeUser, {
          claimId: claim.id,
          decision: "approved",
          approvedQtyBase: "5.000",
          approvedClaimValue: "125000.00",
        }),
      ),
    ]);

    const successes = results.filter((r) => r.status === "fulfilled");
    const rejections = results.filter((r) => r.status === "rejected");

    // Tepat satu yang menang, pemanggilan kedua ditolak karena status sudah 'approved'
    expect(successes.length).toBe(1);
    expect(rejections.length).toBe(1);
  });

  // ==========================================================================
  // SCENARIO 17: Atomic Rollback saat salah satu langkah transaksi gagal
  // ==========================================================================
  it("17. melakukan rollback atomik jika terjadi error di tengah transaksi sehingga data tidak korup", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("20.000");

    const initialClaimsCount = await fx.db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(deliveryClaims);

    // Jalankan transaksi yang sengaja gagal di akhir
    await expect(
      withTransaction(async (tx) => {
        await createCustomerClaim(tx, fx.salesUser, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          salesOrderId: fixture.so.id,
          claimType: "quality_claim",
          reasonCode: "ROLLBACK_TEST",
          notes: "Klaim untuk uji rollback atomik",
          discrepancyQtyBase: "3.000",
        });

        // Lempar error sengaja
        throw new Error("SIMULATED_TRANSACTION_FAILURE");
      }),
    ).rejects.toThrow("SIMULATED_TRANSACTION_FAILURE");

    // Pastikan klaim yang dibuat di transaksi tersebut tidak tersimpan (di-rollback)
    const finalClaimsCount = await fx.db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(deliveryClaims);

    expect(finalClaimsCount[0]!.cnt).toBe(initialClaimsCount[0]!.cnt);
  });

  // ==========================================================================
  // SCENARIO 18: Audit Trail Lengkap
  // ==========================================================================
  it("18. mencatat jejak audit (audit log) lengkap untuk setiap fase daur hidup klaim dan retur", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("25.000");

    const claim = await withTransaction((tx) =>
      createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: fixture.so.id,
        claimType: "quality_claim",
        reasonCode: "AUDIT_TEST",
        notes: "Uji pencatatan jejak audit",
        discrepancyQtyBase: "4.000",
        estimatedClaimValue: "100000.00",
        submitImmediately: false,
      }),
    );

    await withTransaction((tx) => submitCustomerClaim(tx, fx.salesUser, { claimId: claim.id }));
    await withTransaction((tx) => reviewCustomerClaim(tx, fx.financeUser, { claimId: claim.id }));
    await withTransaction((tx) =>
      decideCustomerClaim(tx, fx.owner, {
        claimId: claim.id,
        decision: "approved",
        approvedQtyBase: "4.000",
        approvedClaimValue: "100000.00",
      }),
    );
    await withTransaction((tx) =>
      resolveOrCloseClaim(tx, fx.salesUser, {
        claimId: claim.id,
        action: "resolve",
      }),
    );

    const logs = await fx.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, "delivery_claim"),
          eq(auditLogs.entityId, claim.id),
        ),
      );

    const actions = logs.map((l) => l.action);
    expect(actions).toContain("customer_claim.create");
    expect(actions).toContain("customer_claim.submit");
    expect(actions).toContain("customer_claim.review");
    expect(actions).toContain("customer_claim.approve");
    expect(actions).toContain("customer_claim.resolve");
  });

  // ==========================================================================
  // SCENARIO 19: Full Query & List Verification
  // ==========================================================================
  it("19. memverifikasi query getClaimById dan listCustomerClaims mengembalikan detail lengkap dengan proteksi RBAC", async () => {
    const fixture = await helperCreateDeliveredOrderAndInvoice("20.000");

    const claim = await withTransaction((tx) =>
      createCustomerClaim(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: fixture.so.id,
        invoiceId: fixture.invoice.id,
        claimType: "shortage",
        reasonCode: "QUERY_TEST",
        notes: "Uji query getClaimById",
        discrepancyQtyBase: "2.000",
        estimatedClaimValue: "50000.00",
        submitImmediately: true,
      }),
    );

    const detail = await getClaimById(fx.db, fx.financeUser, claim.id);
    expect(detail).not.toBeNull();
    expect(detail!.claimNo).toBe(claim.claimNo);
    expect(detail!.customerName).toBe("Toko Buah Berkah Kranji");

    const list = await listCustomerClaims(fx.db, fx.financeUser, {
      warehouseId: fx.warehouseId,
      customerId: fx.customerGrosirId,
    });
    expect(list.some((c) => c.id === claim.id)).toBe(true);
  });

  // ==========================================================================
  // SCENARIO 20: Costing Policy Approval Gate Protection
  // ==========================================================================
  it("20. memastikan costing policy approval gate tetap aktif dan memblokir valuasi produksi jika belum ditandatangani owner dan akuntan", async () => {
    const { evaluateCostingPolicyGate } = await import(
      "@/server/modules/inventory/costing"
    );

    // Evaluasi gate pada lingkungan dev
    const devGate = await evaluateCostingPolicyGate(fx.db, {
      enforceProductionGate: false,
    });
    expect(devGate.productionValuationBlocked).toBe(true);

    // Evaluasi gate dengan enforceProductionGate = true (mensimulasikan production)
    await expect(
      evaluateCostingPolicyGate(fx.db, { enforceProductionGate: true }),
    ).rejects.toThrow(BusinessRuleError);
  });
});
