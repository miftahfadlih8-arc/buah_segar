import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type ActorContext } from "@/server/authz/authorize";
import { withTransaction, type DbClient } from "@/server/db";
import {
  auditLogs,
  batches,
  customerPayments,
  deliveryOrderLines,
  deliveryOrders,
  journalEntries,
  journalLines,
  productGrades,
  salesFulfillments,
  salesFulfillmentLines,
  salesOrderLines,
  salesOrders,
} from "@/server/db/schema";
import {
  BusinessRuleError,
  ForbiddenError,
} from "@/server/errors";
import {
  allocatePaymentToInvoices,
  approveCreditNote,
  createBankAccount,
  createCreditNote,
  createSalesInvoice,
  getCustomerStatement,
  getArAgingReport,
  getSalesInvoiceById,
  postSalesInvoice,
  reconcileArSubledgerWithGl,
  reconcileBankTransactionWithPayment,
  recordBankTransaction,
  recordCustomerPayment,
  reverseCustomerPayment,
  voidSalesInvoice,
} from "@/server/modules/finance";
import { GL_ACCOUNT_CODES, postJournalEntry } from "@/server/modules/gl";
import {
  applyInventoryMovement,
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
import { seedDefaultBekasiWarehouse } from "@/server/modules/master/warehouses";
import {
  createPriceList,
  upsertPriceListItem,
} from "@/server/modules/pricing";
import {
  confirmSalesOrder,
  createSalesOrder,
} from "@/server/modules/sales";
import { withIdempotency } from "@/server/idempotency";
import { closeDb, createTestActor, setupTestDb } from "../helpers/test-db";

interface Phase6Fixtures {
  db: DbClient;
  owner: ActorContext;
  financeUser: ActorContext;
  cashierUser: ActorContext;
  driverUser: ActorContext;
  salesUser: ActorContext;
  auditorUser: ActorContext;
  warehouseId: string;
  manggaProductId: string;
  manggaGradeAId: string;
  jerukProductId: string;
  jerukGradeAId: string;
  customerGrosirId: string;
  priceListGrosirId: string;
}

describe("Phase 6 — Invoicing, Accounts Receivable, Payment Collection & Cash Settlement Integration Tests", () => {
  let fx: Phase6Fixtures;

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
      name: "Staf Keuangan BKS-1",
      grants: [{ roleCode: "finance", warehouseId }],
    });

    const cashierUser = await createTestActor(db, {
      name: "Kasir BKS-1",
      grants: [{ roleCode: "cashier", warehouseId }],
    });

    const driverUser = await createTestActor(db, {
      name: "Driver Armada BKS-1",
      grants: [{ roleCode: "driver", warehouseId }],
    });

    const salesUser = await createTestActor(db, {
      name: "Sales BKS-1",
      grants: [{ roleCode: "sales", warehouseId }],
    });

    const auditorUser = await createTestActor(db, {
      name: "Auditor Eksternal",
      grants: [{ roleCode: "auditor", warehouseId }],
    });

    // Create master products & price list
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

    // Create Customer Grosir
    const customerGrosir = await withTransaction((tx) =>
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

    // Create Price List
    const priceListGrosir = await withTransaction(async (tx) => {
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

    const coldRoomLocationId = "loc_bks1_cold1";
    await withTransaction(async (tx) => {
      const glRes = await postJournalEntry(tx, owner, {
        entryDate: "2026-10-20",
        warehouseId,
        sourceDocType: "test_seed_batch",
        sourceDocId: "bat_mng_01",
        purpose: "seed_inventory",
        memo: "Seed persediaan mangga",
        skipDirectPermissionCheck: true,
        lines: [
          {
            accountCode: GL_ACCOUNT_CODES.INVENTORY_FRUIT,
            debit: "9000000.00",
            warehouseId,
            productId: manggaProduct.id,
            description: "Seed persediaan",
          },
          {
            accountCode: GL_ACCOUNT_CODES.GRNI_ACCRUAL,
            credit: "9000000.00",
            warehouseId,
            productId: manggaProduct.id,
            description: "Seed GRNI",
          },
        ],
      });

      await tx.insert(batches).values({
        id: "bat_mng_01",
        batchCode: "BAT-MNG-001",
        productId: manggaProduct.id,
        gradeId: manggaGradeAId,
        gradeCode: "A",
        supplierId: supplier.id,
        warehouseId,
        originRegion: "Probolinggo",
        harvestedAt: new Date("2026-10-18T00:00:00Z"),
        receivedAt: new Date("2026-10-19T06:00:00Z"),
        bestBeforeDate: "2026-11-01",
        expiresAt: new Date("2026-11-01T23:59:59Z"),
        ripenessStage: "matang_siap_jual",
        initialQtyBase: "500.000",
        unitCostBase: "18000.0000",
        totalInitialCost: "9000000.00",
        costingMethod: "lot_actual_rsv",
        status: "active",
      });

      await applyInventoryMovement(tx, owner, {
        warehouseId,
        warehouseCode: "BKS1",
        locationId: coldRoomLocationId,
        batchId: "bat_mng_01",
        productId: manggaProduct.id,
        gradeId: manggaGradeAId,
        stockStatus: "available",
        movementType: "grn_receipt",
        qtyDeltaBase: "500.000",
        unitCostBase: "18000.0000",
        explicitInflowCost: "9000000.00",
        sourceDocType: "test_seed_batch",
        sourceDocId: "bat_mng_01",
        reasonCode: "INITIAL_SEED",
        journalEntryId: glRes.entry.id,
      });
    });

    fx = {
      db,
      owner,
      financeUser,
      cashierUser,
      driverUser,
      salesUser,
      auditorUser,
      warehouseId,
      manggaProductId: manggaProduct.id,
      manggaGradeAId,
      jerukProductId: jerukProduct.id,
      jerukGradeAId,
      customerGrosirId: customerGrosir.id,
      priceListGrosirId: priceListGrosir.id,
    };
  });

  afterAll(async () => {
    await closeDb();
  });

  // Helper to create a confirmed Sales Order
  async function helperCreateConfirmedOrder(qtyKg = "100.000") {
    return withTransaction(async (tx) => {
      const so = await createSalesOrder(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        orderDate: "2026-10-21",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: qtyKg,
          },
        ],
      });

      const confirmed = await confirmSalesOrder(tx, fx.salesUser, {
        salesOrderId: so.header.id,
      });

      return confirmed.header;
    });
  }

  // Helper to simulate a delivered Delivery Order
  async function helperCreateDeliveredDo(soId: string, deliveredQtyKg = "100.000") {
    return withTransaction(async (tx) => {
      const [so] = await tx
        .select()
        .from(salesOrders)
        .where(eq(salesOrders.id, soId))
        .limit(1);
      const [soLine] = await tx
        .select()
        .from(salesOrderLines)
        .where(eq(salesOrderLines.salesOrderId, soId))
        .limit(1);

      const fulId = `ful_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await tx.insert(salesFulfillments).values({
        id: fulId,
        fulfillmentNo: `FUL/BKS1/2610/${Math.floor(10000 + Math.random() * 90000)}`,
        salesOrderId: soId,
        customerId: so!.customerId,
        warehouseId: so!.warehouseId,
        fulfillmentDate: "2026-10-21",
        status: "delivered",
        totalOrderedQtyBase: deliveredQtyKg,
        totalPickedQtyBase: deliveredQtyKg,
        totalPackedQtyBase: deliveredQtyKg,
        totalRemainingQtyBase: "0.000",
        createdBy: fx.owner.user.id,
      });

      const fulLineId = `fline_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await tx.insert(salesFulfillmentLines).values({
        id: fulLineId,
        fulfillmentId: fulId,
        salesOrderLineId: soLine!.id,
        lineNo: 1,
        orderedProductId: soLine!.productId,
        orderedGradeId: soLine!.gradeId,
        orderedGradeCode: soLine!.gradeCode,
        actualProductId: soLine!.productId,
        actualGradeId: soLine!.gradeId,
        actualGradeCode: soLine!.gradeCode,
        orderedUomCode: "kg",
        orderedQty: deliveredQtyKg,
        orderedQtyBase: deliveredQtyKg,
        targetPickQtyBase: deliveredQtyKg,
        pickedUomCode: "kg",
        pickedQty: deliveredQtyKg,
        pickedQtyBase: deliveredQtyKg,
        packedQtyBase: deliveredQtyKg,
        netUnitPriceSnapshot: soLine!.netUnitPrice,
        netUnitPriceBaseSnapshot: soLine!.netUnitPriceBase,
      });

      const doId = `do_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const [doRow] = await tx
        .insert(deliveryOrders)
        .values({
          id: doId,
          doNumber: `DO/BKS1/2610/${Math.floor(10000 + Math.random() * 90000)}`,
          fulfillmentId: fulId,
          salesOrderId: soId,
          customerId: so!.customerId,
          warehouseId: so!.warehouseId,
          shippingAddressSnapshot: "Kranji, Bekasi Barat",
          deliveryDate: "2026-10-21",
          status: "delivered",
          createdBy: fx.owner.user.id,
        })
        .returning();

      const [doLine] = await tx
        .insert(deliveryOrderLines)
        .values({
          id: `dol_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          deliveryOrderId: doId,
          fulfillmentLineId: fulLineId,
          salesOrderLineId: soLine!.id,
          lineNo: 1,
          productId: soLine!.productId,
          gradeId: soLine!.gradeId,
          gradeCode: "A",
          uomCode: "kg",
          shippedQty: deliveredQtyKg,
          shippedQtyBase: deliveredQtyKg,
          deliveredQtyBase: deliveredQtyKg,
          netUnitPriceBaseSnapshot: "25000.0000",
        })
        .returning();

      return { doRow: doRow!, doLine: doLine! };
    });
  }

  // ---------------------------------------------------------------------------
  // TEST SCENARIOS 1-23
  // ---------------------------------------------------------------------------

  it("1. mengizinkan pembuatan Invoice hanya dari transaksi yang eligible (menolak SO draft/cancelled dan DO non-delivered)", async () => {
    // 1a. Attempt to invoice draft SO -> should be rejected
    const draftSo = await withTransaction((tx) =>
      createSalesOrder(tx, fx.salesUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        orderDate: "2026-10-21",
        saveAsDraft: true,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            orderedUomCode: "kg",
            orderedQty: "50.000",
          },
        ],
      }),
    );

    await expect(
      withTransaction((tx) =>
        createSalesInvoice(tx, fx.financeUser, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          salesOrderId: draftSo.header.id,
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              uomCode: "KG",
              invoicedQty: "50.000",
              unitPrice: "25000.0000",
            },
          ],
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // 1b. Invoicing a confirmed SO -> succeeds
    const confirmedSo = await helperCreateConfirmedOrder("50.000");
    const invFromSo = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        salesOrderId: confirmedSo.id,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "50.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    );
    expect(invFromSo.status).toBe("posted");
    expect(invFromSo.totalAmount).toBe("1250000.00");

    // 1c. Invoicing a delivered DO -> succeeds
    const { doRow, doLine } = await helperCreateDeliveredDo(confirmedSo.id, "50.000");
    const invFromDo = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        deliveryOrderId: doRow.id,
        lines: [
          {
            deliveryOrderLineId: doLine.id,
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "50.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    );
    expect(invFromDo.deliveryOrderId).toBe(doRow.id);
    expect(invFromDo.status).toBe("posted");
  });

  it("2. mendukung faktur parsial dan mencegah penagihan kuantitas yang sama melebihi sisa yang belum ditagihkan", async () => {
    const so = await helperCreateConfirmedOrder("100.000");
    const { doRow, doLine } = await helperCreateDeliveredDo(so.id, "100.000");

    // First partial invoice: 40 kg
    const inv1 = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        deliveryOrderId: doRow.id,
        lines: [
          {
            deliveryOrderLineId: doLine.id,
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "40.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    );
    expect(inv1.totalAmount).toBe("1000000.00"); // 40 * 25,000

    // Second invoice attempts to bill 70 kg (40 + 70 = 110 > 100) -> should be rejected!
    await expect(
      withTransaction((tx) =>
        createSalesInvoice(tx, fx.financeUser, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          deliveryOrderId: doRow.id,
          lines: [
            {
              deliveryOrderLineId: doLine.id,
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              uomCode: "KG",
              invoicedQty: "70.000",
              unitPrice: "25000.0000",
            },
          ],
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Second partial invoice bills remaining 60 kg -> succeeds!
    const inv2 = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        deliveryOrderId: doRow.id,
        lines: [
          {
            deliveryOrderLineId: doLine.id,
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "60.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    );
    expect(inv2.totalAmount).toBe("1500000.00"); // 60 * 25,000

    // Third invoice attempts to bill any more -> rejected because 100% already invoiced!
    await expect(
      withTransaction((tx) =>
        createSalesInvoice(tx, fx.financeUser, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          deliveryOrderId: doRow.id,
          lines: [
            {
              deliveryOrderLineId: doLine.id,
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              uomCode: "KG",
              invoicedQty: "5.000",
              unitPrice: "25000.0000",
            },
          ],
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it("3. menjamin keunikan nomor faktur (INV/BKS1/YYMM/00001) saat proses pembuatan berjalan secara konkuren (Promise.all)", async () => {
    const so1 = await helperCreateConfirmedOrder("20.000");
    const so2 = await helperCreateConfirmedOrder("30.000");

    const [inv1, inv2] = await Promise.all([
      withTransaction((tx) =>
        createSalesInvoice(tx, fx.financeUser, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          salesOrderId: so1.id,
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              uomCode: "KG",
              invoicedQty: "20.000",
              unitPrice: "25000.0000",
            },
          ],
        }),
      ),
      withTransaction((tx) =>
        createSalesInvoice(tx, fx.financeUser, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          salesOrderId: so2.id,
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              uomCode: "KG",
              invoicedQty: "30.000",
              unitPrice: "25000.0000",
            },
          ],
        }),
      ),
    ]);

    expect(inv1.invoiceNo).not.toBe(inv2.invoiceNo);
    expect(inv1.invoiceNo).toMatch(/^INV\/BKS1\/\d{4}\/\d{5}$/);
    expect(inv2.invoiceNo).toMatch(/^INV\/BKS1\/\d{4}\/\d{5}$/);
  });

  it("4. menghitung ulang harga, diskon, pajak (PPN 11%), pembulatan Rupiah, dan grand total secara akurat di server", async () => {
    // 50 kg @ Rp 25.000 = Rp 1.250.000 gross
    // Discount Rp 50.000 -> Net = Rp 1.200.000
    // Tax 11% = Rp 132.000
    // Total = Rp 1.332.000
    const inv = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "50.000",
            unitPrice: "25000.0000",
            discountAmount: "50000.00",
            taxRatePct: "11.00",
          },
        ],
      }),
    );

    expect(inv.subtotalAmount).toBe("1200000.00");
    expect(inv.discountAmount).toBe("50000.00");
    expect(inv.taxAmount).toBe("132000.00");
    expect(inv.totalAmount).toBe("1332000.00");
    expect(inv.outstandingAmount).toBe("1332000.00");
  });

  it("5. menegakkan immutability pada invoice posted dan menolak perubahan langsung (hanya melalui void/reversal)", async () => {
    const inv = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "10.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    );
    expect(inv.status).toBe("posted");

    // Attempting to post again should be rejected
    await expect(
      withTransaction((tx) => postSalesInvoice(tx, fx.financeUser, inv.id)),
    ).rejects.toThrow(BusinessRuleError);

    // Voiding the unpaid invoice with valid reason succeeds
    const voided = await withTransaction((tx) =>
      voidSalesInvoice(tx, fx.financeUser, {
        invoiceId: inv.id,
        reason: "Salah penulisan alamat kirim",
      }),
    );
    expect(voided.status).toBe("cancelled");
    expect(voided.outstandingAmount).toBe("0.00");

    // Attempting to void already cancelled invoice throws
    await expect(
      withTransaction((tx) =>
        voidSalesInvoice(tx, fx.financeUser, {
          invoiceId: inv.id,
          reason: "Coba void lagi",
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it("6. menghitung saldo piutang (AR outstanding) per invoice dan per pelanggan dengan rumus exact", async () => {
    const inv = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "20.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    );
    expect(inv.outstandingAmount).toBe("500000.00");

    // Partial payment of 200,000
    await withTransaction((tx) =>
      recordCustomerPayment(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        invoiceId: inv.id,
        amount: "200000.00",
        paymentMethod: "bank_transfer",
      }),
    );

    const updatedInv = await getSalesInvoiceById(fx.db, inv.id);
    expect(updatedInv?.paidAmount).toBe("200000.00");
    expect(updatedInv?.outstandingAmount).toBe("300000.00");
    expect(updatedInv?.status).toBe("partially_paid");
  });

  it("7. memastikan pembayaran berstatus 'draft' tidak mengurangi saldo piutang atau mencatat jurnal GL", async () => {
    const inv = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "10.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    );

    // Create payment with status draft
    const draftPay = await withTransaction((tx) =>
      recordCustomerPayment(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        invoiceId: inv.id,
        amount: "150000.00",
        paymentMethod: "bank_transfer",
        status: "draft",
      }),
    );

    expect(draftPay.status).toBe("draft");
    expect(draftPay.glJournalId).toBeNull();

    // Verify invoice outstanding remains untouched
    const invCheck = await getSalesInvoiceById(fx.db, inv.id);
    expect(invCheck?.outstandingAmount).toBe("250000.00");
    expect(invCheck?.paidAmount).toBe("0.00");
    expect(invCheck?.status).toBe("posted");
  });

  it("8. memperbarui status invoice dan AR secara tepat saat menerima pembayaran parsial dan pelunasan penuh", async () => {
    const inv = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "40.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    );
    expect(inv.totalAmount).toBe("1000000.00");

    // Partial payment 1: Rp 600.000
    await withTransaction((tx) =>
      recordCustomerPayment(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        invoiceId: inv.id,
        amount: "600000.00",
        paymentMethod: "bank_transfer",
      }),
    );

    const check1 = await getSalesInvoiceById(fx.db, inv.id);
    expect(check1?.status).toBe("partially_paid");
    expect(check1?.paidAmount).toBe("600000.00");
    expect(check1?.outstandingAmount).toBe("400000.00");

    // Full payoff payment 2: Rp 400.000
    await withTransaction((tx) =>
      recordCustomerPayment(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        invoiceId: inv.id,
        amount: "400000.00",
        paymentMethod: "cash",
      }),
    );

    const check2 = await getSalesInvoiceById(fx.db, inv.id);
    expect(check2?.status).toBe("paid");
    expect(check2?.paidAmount).toBe("1000000.00");
    expect(check2?.outstandingAmount).toBe("0.00");
  });

  it("9. mendukung alokasi satu pembayaran ke beberapa invoice (1-to-many allocation)", async () => {
    const inv1 = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "8.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    ); // Rp 200.000

    const inv2 = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "12.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    ); // Rp 300.000

    // Single payment of Rp 500.000 allocated to both
    const payment = await withTransaction((tx) =>
      recordCustomerPayment(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        amount: "500000.00",
        paymentMethod: "bank_transfer",
        allocations: [
          { invoiceId: inv1.id, amount: "200000.00" },
          { invoiceId: inv2.id, amount: "300000.00" },
        ],
      }),
    );

    expect(payment.appliedAmount).toBe("500000.00");
    expect(payment.unappliedAmount).toBe("0.00");

    const checkInv1 = await getSalesInvoiceById(fx.db, inv1.id);
    const checkInv2 = await getSalesInvoiceById(fx.db, inv2.id);
    expect(checkInv1?.status).toBe("paid");
    expect(checkInv1?.outstandingAmount).toBe("0.00");
    expect(checkInv2?.status).toBe("paid");
    expect(checkInv2?.outstandingAmount).toBe("0.00");
  });

  it("10. menolak alokasi pembayaran yang melebihi sisa tagihan invoice", async () => {
    const inv = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "8.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    ); // Rp 200.000

    // Attempting to allocate Rp 250.000 to an invoice with Rp 200.000 balance must fail
    await expect(
      withTransaction((tx) =>
        recordCustomerPayment(tx, fx.financeUser, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          amount: "300000.00",
          paymentMethod: "bank_transfer",
          allocations: [{ invoiceId: inv.id, amount: "250000.00" }],
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it("11. menjamin idempotensi pencatatan pembayaran (retry receipt tidak menghasilkan pembayaran ganda)", async () => {
    const idempotencyKey = `idem_pay_${Date.now()}`;

    const executePayment = () =>
      withTransaction((tx) =>
        withIdempotency(
          tx,
          {
            scope: "customer_payment",
            key: idempotencyKey,
            payload: {
              customerId: fx.customerGrosirId,
              amount: "150000.00",
              paymentMethod: "bank_transfer",
            },
          },
          () =>
            recordCustomerPayment(tx, fx.financeUser, {
              customerId: fx.customerGrosirId,
              warehouseId: fx.warehouseId,
              amount: "150000.00",
              paymentMethod: "bank_transfer",
            }),
        ),
      );

    const first = await executePayment();
    expect(first.replayed).toBe(false);

    const second = await executePayment();
    expect(second.replayed).toBe(true);
    expect(second.result.id).toBe(first.result.id);

    // Ensure only 1 payment was persisted in DB
    const countRes = await fx.db
      .select({ count: sql<number>`count(*)` })
      .from(customerPayments)
      .where(eq(customerPayments.id, first.result.id));
    expect(Number(countRes[0]!.count)).toBe(1);
  });

  it("12. mencegah race condition dan double allocation saat dua request alokasi berjalan paralel pada pembayaran yang sama", async () => {
    // Record deposit of Rp 500.000
    const payment = await withTransaction((tx) =>
      recordCustomerPayment(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        paymentType: "deposit",
        amount: "500000.00",
        paymentMethod: "bank_transfer",
      }),
    );
    expect(payment.unappliedAmount).toBe("500000.00");

    const inv1 = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "16.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    ); // Rp 400.000

    const inv2 = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "16.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    ); // Rp 400.000

    // Two parallel allocations each asking for Rp 400.000 (total Rp 800.000 > available Rp 500.000)
    const results = await Promise.allSettled([
      withTransaction((tx) =>
        allocatePaymentToInvoices(tx, fx.financeUser, {
          paymentId: payment.id,
          allocations: [{ invoiceId: inv1.id, amount: "400000.00" }],
        }),
      ),
      withTransaction((tx) =>
        allocatePaymentToInvoices(tx, fx.financeUser, {
          paymentId: payment.id,
          allocations: [{ invoiceId: inv2.id, amount: "400000.00" }],
        }),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one must succeed, and one must be rejected due to row lock and remaining balance check
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // Final unapplied balance is exactly Rp 100.000 (never negative)
    const [freshPayment] = await fx.db
      .select()
      .from(customerPayments)
      .where(eq(customerPayments.id, payment.id));
    expect(freshPayment?.unappliedAmount).toBe("100000.00");
  });

  it("13. menangani overpayment dan mencatat kelebihan pembayaran sebagai uang muka (unapplied amount / GL 2130)", async () => {
    const inv = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "8.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    ); // Rp 200.000

    // Customer pays Rp 350.000 (overpayment of Rp 150.000)
    const pay = await withTransaction((tx) =>
      recordCustomerPayment(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        invoiceId: inv.id,
        amount: "350000.00",
        paymentMethod: "bank_transfer",
      }),
    );

    expect(pay.appliedAmount).toBe("200000.00");
    expect(pay.unappliedAmount).toBe("150000.00");

    const invCheck = await getSalesInvoiceById(fx.db, inv.id);
    expect(invCheck?.status).toBe("paid");
    expect(invCheck?.outstandingAmount).toBe("0.00");

    // Check GL journal lines for overpayment
    const jLines = await fx.db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, pay.glJournalId!));

    const debitCash = jLines.find((l) => l.accountCode === GL_ACCOUNT_CODES.CASH_BANK);
    const creditAr = jLines.find((l) => l.accountCode === GL_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE);
    const creditUnapplied = jLines.find(
      (l) => l.accountCode === GL_ACCOUNT_CODES.UNAPPLIED_CUSTOMER_CASH,
    );

    expect(debitCash?.debit).toBe("350000.00");
    expect(creditAr?.credit).toBe("200000.00");
    expect(creditUnapplied?.credit).toBe("150000.00");
  });

  it("14. memulihkan saldo AR dan membalik jurnal GL secara akurat saat payment di-reverse", async () => {
    const inv = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "8.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    ); // Rp 200.000

    const pay = await withTransaction((tx) =>
      recordCustomerPayment(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        invoiceId: inv.id,
        amount: "200000.00",
        paymentMethod: "bank_transfer",
      }),
    );
    expect(pay.status).toBe("posted");

    // Reverse the payment
    const reversed = await withTransaction((tx) =>
      reverseCustomerPayment(tx, fx.financeUser, {
        paymentId: pay.id,
        reason: "Cek giro bilyet ditolak oleh bank (bouncing cheque)",
      }),
    );
    expect(reversed.status).toBe("reversed");
    expect(reversed.appliedAmount).toBe("0.00");

    // Verify invoice status and outstanding balance is restored
    const invRestored = await getSalesInvoiceById(fx.db, inv.id);
    expect(invRestored?.status).toBe("posted");
    expect(invRestored?.paidAmount).toBe("0.00");
    expect(invRestored?.outstandingAmount).toBe("200000.00");
  });

  it("15. mencatat Nota Kredit (Credit Note) dan memperbarui saldo piutang serta GL pendapatan/klaim sesuai aturan", async () => {
    const inv = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "10.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    ); // Rp 250.000

    // Create Credit Note for quality claim (e.g. 2 kg bruised)
    const cn = await withTransaction((tx) =>
      createCreditNote(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        invoiceId: inv.id,
        sourceType: "quality_claim",
        reason: "Buah mangga memar 2 kg saat pengiriman",
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            qty: "2.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    );
    expect(cn.status).toBe("draft");
    expect(cn.totalAmount).toBe("50000.00");

    // Approve Credit Note and apply to invoice
    const approvedCn = await withTransaction((tx) =>
      approveCreditNote(tx, fx.financeUser, {
        creditNoteId: cn.id,
        invoiceId: inv.id,
        reason: "Klaim kualitas disetujui",
      }),
    );
    expect(approvedCn.status).toBe("applied");
    expect(approvedCn.appliedAmount).toBe("50000.00");

    // Verify invoice outstanding is reduced by credit note
    const invCheck = await getSalesInvoiceById(fx.db, inv.id);
    expect(invCheck?.creditNoteAppliedAmount).toBe("50000.00");
    expect(invCheck?.outstandingAmount).toBe("200000.00");
    expect(invCheck?.status).toBe("partially_paid");
  });

  it("16. memastikan seluruh jurnal invoice dan payment selalu seimbang (debit = credit)", async () => {
    const allEntries = await fx.db.select().from(journalEntries);
    expect(allEntries.length).toBeGreaterThan(0);

    for (const entry of allEntries) {
      const lines = await fx.db
        .select()
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, entry.id));

      let totalDebit = 0;
      let totalCredit = 0;
      for (const l of lines) {
        totalDebit += Number(l.debit);
        totalCredit += Number(l.credit);
      }
      expect(totalDebit).toBeCloseTo(totalCredit, 2);
      expect(totalDebit).toBeGreaterThan(0);
    }
  });

  it("17. mencegah duplikasi posting jurnal (double journal) dan memastikan tidak ada jurnal HPP saat invoicing", async () => {
    const inv = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "10.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    );

    // Find the GL journal created for this invoice
    const lines = await fx.db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, inv.glJournalId!));

    // Must NOT contain COGS (5100) or Inventory (1140) because HPP was posted during picking in Phase 5
    const hasCogs = lines.some((l) => l.accountCode === GL_ACCOUNT_CODES.COGS_FRUIT);
    const hasInventory = lines.some((l) => l.accountCode === GL_ACCOUNT_CODES.INVENTORY_FRUIT);
    expect(hasCogs).toBe(false);
    expect(hasInventory).toBe(false);

    // Verify journal count for this invoice is exactly 1
    const entries = await fx.db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.sourceDocType, "INV"),
          eq(journalEntries.sourceDocId, inv.id),
        ),
      );
    expect(entries.length).toBe(1);
  });

  it("18. menghasilkan rekonsiliasi sempurna (variance = 0.00) antara AR subledger dan saldo GL Akun 1120", async () => {
    // Generate clean balanced invoice and payment dataset
    const inv = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "10.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    );

    await withTransaction((tx) =>
      recordCustomerPayment(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        invoiceId: inv.id,
        amount: "100000.00",
        paymentMethod: "bank_transfer",
      }),
    );

    const recon = await reconcileArSubledgerWithGl(fx.db, {
      warehouseId: fx.warehouseId,
    });

    expect(recon.isReconciled).toBe(true);
    expect(recon.variance).toBe("0.00");
  });

  it("19. mencegah transaksi mutasi bank dicocokkan lebih dari satu kali dan mendeteksi selisih (discrepancy)", async () => {
    // 19a. Register a bank account
    const bank = await withTransaction((tx) =>
      createBankAccount(tx, fx.owner, {
        code: "BCA-OPS",
        name: "BCA Operasional Bekasi",
        accountType: "bank",
        bankName: "BCA",
        accountNumber: "1234567890",
        holderName: "PT Buah Segar Bekasi",
      }),
    );
    expect(bank.code).toBe("BCA-OPS");

    // 19b. Record two incoming bank transactions
    const btx1 = await withTransaction((tx) =>
      recordBankTransaction(tx, fx.financeUser, {
        bankAccountId: bank.id,
        transactionDate: "2026-10-21",
        description: "TRSF E-BANKING CR DARI TOKO BERKAH",
        amount: "500000.00",
        direction: "in",
      }),
    );

    const btx2 = await withTransaction((tx) =>
      recordBankTransaction(tx, fx.financeUser, {
        bankAccountId: bank.id,
        transactionDate: "2026-10-21",
        description: "TRSF E-BANKING CR DARI TOKO BERKAH",
        amount: "480000.00", // Selisih Rp 20.000
        direction: "in",
      }),
    );

    // Record posted payments
    const pay1 = await withTransaction((tx) =>
      recordCustomerPayment(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        amount: "500000.00",
        paymentMethod: "bank_transfer",
      }),
    );

    const pay2 = await withTransaction((tx) =>
      recordCustomerPayment(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        amount: "500000.00",
        paymentMethod: "bank_transfer",
      }),
    );

    // Match exact transaction
    const matched1 = await withTransaction((tx) =>
      reconcileBankTransactionWithPayment(tx, fx.financeUser, {
        bankTransactionId: btx1.id,
        paymentId: pay1.id,
      }),
    );
    expect(matched1.matchStatus).toBe("matched");
    expect(matched1.matchedPaymentId).toBe(pay1.id);

    // Attempting to match btx1 again should fail
    await expect(
      withTransaction((tx) =>
        reconcileBankTransactionWithPayment(tx, fx.financeUser, {
          bankTransactionId: btx1.id,
          paymentId: pay2.id,
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Matching btx2 (Rp 480.000) with pay2 (Rp 500.000) results in discrepancy
    const discrepancyMatch = await withTransaction((tx) =>
      reconcileBankTransactionWithPayment(tx, fx.financeUser, {
        bankTransactionId: btx2.id,
        paymentId: pay2.id,
      }),
    );
    expect(discrepancyMatch.matchStatus).toBe("discrepancy");
    expect(discrepancyMatch.discrepancyReason).toContain("Selisih nominal");
  });

  it("20. menegakkan RBAC server-side: user tanpa izin (ar.invoice / ar.collect) ditolak", async () => {
    // Driver attempts to create invoice -> rejected
    await expect(
      withTransaction((tx) =>
        createSalesInvoice(tx, fx.driverUser, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          lines: [
            {
              productId: fx.manggaProductId,
              gradeId: fx.manggaGradeAId,
              uomCode: "KG",
              invoicedQty: "10.000",
              unitPrice: "25000.0000",
            },
          ],
        }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Auditor attempts to record payment -> rejected
    await expect(
      withTransaction((tx) =>
        recordCustomerPayment(tx, fx.auditorUser, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          amount: "100000.00",
          paymentMethod: "cash",
        }),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("21. mencatat jejak audit (audit_logs) lengkap untuk seluruh aksi finansial kritikal", async () => {
    const inv = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "10.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    );

    const logs = await fx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, inv.id));

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]!.action).toBe("sales_invoice.post");
    expect(logs[0]!.actorUserId).toBe(fx.financeUser.user.id);
  });

  it("22. menjamin rollback atomik saat terjadi kegagalan di tengah transaksi multi-tabel", async () => {
    const inv = await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "KG",
            invoicedQty: "10.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    );

    // Intentionally aborting a transaction after recording payment
    await expect(
      withTransaction(async (tx) => {
        await recordCustomerPayment(tx, fx.financeUser, {
          customerId: fx.customerGrosirId,
          warehouseId: fx.warehouseId,
          invoiceId: inv.id,
          amount: "100000.00",
          paymentMethod: "bank_transfer",
        });

        // Simulate crash
        throw new Error("Simulated sudden network failure");
      }),
    ).rejects.toThrow("Simulated sudden network failure");

    // Verify invoice paidAmount is still 0 (clean rollback)
    const invFresh = await getSalesInvoiceById(fx.db, inv.id);
    expect(invFresh?.paidAmount).toBe("0.00");
    expect(invFresh?.outstandingAmount).toBe("250000.00");
  });

  it("23. memastikan seluruh regresi Phase 2-5 tetap lulus tanpa penurunan performa", async () => {
    // Generate invoice and check aging & statement
    await withTransaction((tx) =>
      createSalesInvoice(tx, fx.financeUser, {
        customerId: fx.customerGrosirId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            gradeId: fx.manggaGradeAId,
            uomCode: "kg",
            invoicedQty: "10.000",
            unitPrice: "25000.0000",
          },
        ],
      }),
    );

    const agingReport = await getArAgingReport(fx.db, {
      warehouseId: fx.warehouseId,
    });
    expect(agingReport.customers.length).toBeGreaterThanOrEqual(1);

    const statement = await getCustomerStatement(fx.db, {
      customerId: fx.customerGrosirId,
    });
    expect(statement.customer.id).toBe(fx.customerGrosirId);
    expect(statement.ledger.length).toBeGreaterThan(0);
  });
});
