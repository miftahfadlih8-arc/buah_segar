import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { decideApproval } from "@/server/approvals";
import { listAuditLogs } from "@/server/audit";
import { type ActorContext } from "@/server/authz/authorize";
import { withTransaction, type DbClient } from "@/server/db";
import {
  batches,
  inventoryMovements,
  journalEntries,
  productGrades,
  stockBalances,
} from "@/server/db/schema";
import { BusinessRuleError, ForbiddenError } from "@/server/errors";
import {
  GL_ACCOUNT_CODES,
  getGlAccountBalance,
  postJournalEntry,
  reverseJournalEntry,
} from "@/server/modules/gl";
import { COSTING_POLICY_SETTING_KEY, evaluateCostingPolicyGate } from "@/server/modules/inventory/costing";
import {
  applyInventoryMovement,
  createAndPostStockCount,
  createStockAdjustment,
  issueStockFefo,
  postStockAdjustment,
  reconcileInventoryAndGl,
  selectFefoCandidates,
} from "@/server/modules/inventory/ledger";
import {
  createProduct,
  seedStandardUomsAndPackaging,
  upsertProductUomConversion,
} from "@/server/modules/master/catalog";
import { createSupplier } from "@/server/modules/master/suppliers";
import { seedDefaultBekasiWarehouse } from "@/server/modules/master/warehouses";
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrderWithDetails,
  revisePurchaseOrder,
  submitPurchaseOrder,
} from "@/server/modules/procurement";
import {
  createGoodsReceipt,
  postGoodsReceipt,
  recordGradingAndYield,
  recordQualityInspection,
  recordWeighing,
} from "@/server/modules/receiving";
import { setSetting } from "@/server/settings";
import { closeDb, createTestActor, setupTestDb } from "../helpers/test-db";

interface Phase3TestFixtures {
  db: DbClient;
  owner: ActorContext;
  procurementUser: ActorContext;
  warehouseUser: ActorContext;
  qcUser: ActorContext;
  financeUser: ActorContext;
  salesUser: ActorContext;
  warehouseId: string;
  receivingLocationId: string;
  coldRoomLocationId: string;
  quarantineLocationId: string;
  supplierId: string;
  manggaProductId: string;
  jerukProductId: string;
  manggaGrades: Record<string, string>;
}

async function seedPhase3Fixtures(): Promise<Phase3TestFixtures> {
  const db = await setupTestDb();
  await withTransaction(async (tx) => {
    await seedStandardUomsAndPackaging(tx);
    await seedDefaultBekasiWarehouse(tx);
  });

  const owner = await createTestActor(db, {
    name: "Owner Bekasi",
    grants: [{ roleCode: "owner" }],
  });
  const procurementUser = await createTestActor(db, {
    name: "Staf Pengadaan",
    grants: [{ roleCode: "procurement", warehouseId: "wh_bks1" }],
  });
  const warehouseUser = await createTestActor(db, {
    name: "Operator Gudang",
    grants: [{ roleCode: "warehouse", warehouseId: "wh_bks1" }],
  });
  const qcUser = await createTestActor(db, {
    name: "Inspektur QC",
    grants: [{ roleCode: "qc", warehouseId: "wh_bks1" }],
  });
  const financeUser = await createTestActor(db, {
    name: "Staf Keuangan",
    grants: [{ roleCode: "finance", warehouseId: "wh_bks1" }],
  });
  const salesUser = await createTestActor(db, {
    name: "Staf Sales",
    grants: [{ roleCode: "sales", warehouseId: "wh_bks1" }],
  });

  const supplier = await withTransaction((tx) =>
    createSupplier(tx, procurementUser, {
      code: "SUP-MNG-01",
      name: "Kelompok Tani Harum Probolinggo",
      supplierType: "petani",
      originRegion: "Probolinggo, Jawa Timur",
      paymentTermsDays: 7,
      leadTimeDays: 1,
    }),
  );

  const mangga = await withTransaction(async (tx) => {
    const p = await createProduct(tx, procurementUser, {
      sku: "MNG-HARUM-01",
      name: "Mangga Harum Manis Super",
      category: "Buah Tropis",
      baseUomCode: "kg",
      defaultShelfLifeDays: 6,
      isCatchWeight: true,
      ripenessTracking: true,
      storageCondition: "cold",
      taxCode: "PPN_EXEMPT",
      minMarginPct: "12.00",
      minSellingPrice: "22000",
      createDefaultGrades: true,
    });
    await upsertProductUomConversion(tx, procurementUser, {
      productId: p.id,
      uomCode: "peti",
      factorToBase: "20.0000",
      isNominal: true,
      requiresActualWeight: true,
      defaultPackagingTypeId: "pkg_peti_kayu",
    });
    return p;
  });

  const jeruk = await withTransaction((tx) =>
    createProduct(tx, procurementUser, {
      sku: "JRK-MEDAN-01",
      name: "Jeruk Manis Berastagi",
      category: "Buah Sitrus",
      baseUomCode: "kg",
      defaultShelfLifeDays: 10,
      isCatchWeight: true,
      ripenessTracking: false,
      storageCondition: "cold",
      taxCode: "PPN_EXEMPT",
      minMarginPct: "10.00",
      minSellingPrice: "19000",
      createDefaultGrades: true,
    }),
  );

  const grades = await db
    .select()
    .from(productGrades)
    .where(eq(productGrades.productId, mangga.id));
  const manggaGrades = Object.fromEntries(grades.map((g) => [g.code, g.id]));

  return {
    db,
    owner,
    procurementUser,
    warehouseUser,
    qcUser,
    financeUser,
    salesUser,
    warehouseId: "wh_bks1",
    receivingLocationId: "loc_bks1_rcv",
    coldRoomLocationId: "loc_bks1_cold1",
    quarantineLocationId: "loc_bks1_qc",
    supplierId: supplier.id,
    manggaProductId: mangga.id,
    jerukProductId: jeruk.id,
    manggaGrades,
  };
}

describe("Phase 3 — Procurement, Receiving, Inventory & GL Foundation (12 Required Automated Tests)", () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("1. handles PO lifecycle (draft, submit, approve, revision with snapshot, partial receipt, full receipt, and cancellation rules)", async () => {
    const fx = await seedPhase3Fixtures();

    // Create PO in peti (5 peti * 20 kg nominal = 100 kg base)
    const poCreated = await withTransaction((tx) =>
      createPurchaseOrder(tx, fx.procurementUser, {
        supplierId: fx.supplierId,
        warehouseId: fx.warehouseId,
        qtyTolerancePct: "5.00",
        lines: [
          {
            productId: fx.manggaProductId,
            orderedUomCode: "peti",
            orderedQty: "5",
            unitPriceBase: "15000",
          },
        ],
      }),
    );
    expect(poCreated.header.status).toBe("draft");
    expect(poCreated.lines[0]!.orderedQtyBase).toBe("100.000");

    // Submit & Approve PO
    const submitted = await withTransaction((tx) =>
      submitPurchaseOrder(tx, fx.procurementUser, { purchaseOrderId: poCreated.header.id }),
    );
    expect(submitted.status).toBe("submitted");

    const approved = await withTransaction((tx) =>
      approvePurchaseOrder(tx, fx.owner, { purchaseOrderId: poCreated.header.id }),
    );
    expect(approved.status).toBe("approved");

    // Revise PO to 6 peti (120 kg) while preserving original snapshot (revision 0 and revision 1)
    const revised = await withTransaction((tx) =>
      revisePurchaseOrder(tx, fx.procurementUser, {
        purchaseOrderId: poCreated.header.id,
        reason: "Penambahan pesanan 1 peti dari petani",
        lines: [
          {
            id: poCreated.lines[0]!.id,
            productId: fx.manggaProductId,
            orderedUomCode: "peti",
            orderedQty: "6",
            unitPriceBase: "15000",
          },
        ],
      }),
    );
    expect(revised.header.revisionNo).toBe(1);
    expect(revised.lines[0]!.orderedQtyBase).toBe("120.000");

    const detailsBeforeGrn = await getPurchaseOrderWithDetails(
      fx.db,
      fx.procurementUser,
      poCreated.header.id,
    );
    expect(detailsBeforeGrn.revisions.length).toBe(2); // Rev 0 (original 100kg) + Rev 1 (120kg)

    // Partial Receipt #1: Receive 70 kg net
    await withTransaction(async (tx) => {
      const grn1 = await createGoodsReceipt(tx, fx.warehouseUser, {
        purchaseOrderId: poCreated.header.id,
        receivingLocationId: fx.receivingLocationId,
        putawayLocationId: fx.coldRoomLocationId,
        supplierDeliveryNoteNo: "SJ-PART-01",
        lines: [
          {
            purchaseOrderLineId: poCreated.lines[0]!.id,
            productId: fx.manggaProductId,
            actualUnitCostBase: "15000",
          },
        ],
      });
      const line1 = grn1.lines[0]!;
      await recordWeighing(tx, fx.warehouseUser, {
        goodsReceiptLineId: line1.id,
        grossWeightKg: "74.000",
        tareSource: "measured_actual",
        measuredTareWeightKg: "4.000",
      });
      await recordQualityInspection(tx, fx.qcUser, {
        goodsReceiptLineId: line1.id,
        outcome: "accepted",
      });
      await recordGradingAndYield(tx, fx.qcUser, {
        goodsReceiptLineId: line1.id,
        grades: [
          { gradeCode: "A", qtyBase: "50.000" },
          { gradeCode: "B", qtyBase: "20.000" },
        ],
      });
      const post1 = await postGoodsReceipt(tx, fx.warehouseUser, {
        goodsReceiptId: grn1.header.id,
      });
      expect(post1.poStatus).toBe("partially_received");
    });

    // Cannot cancel a partially_received PO
    await expect(
      withTransaction((tx) =>
        cancelPurchaseOrder(tx, fx.procurementUser, {
          purchaseOrderId: poCreated.header.id,
          reason: "Coba batalkan PO yang sudah diterima sebagian",
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Partial Receipt #2: Receive remaining 50 kg net -> PO becomes "received"
    await withTransaction(async (tx) => {
      const grn2 = await createGoodsReceipt(tx, fx.warehouseUser, {
        purchaseOrderId: poCreated.header.id,
        receivingLocationId: fx.receivingLocationId,
        putawayLocationId: fx.coldRoomLocationId,
        supplierDeliveryNoteNo: "SJ-PART-02",
        lines: [
          {
            purchaseOrderLineId: poCreated.lines[0]!.id,
            productId: fx.manggaProductId,
            actualUnitCostBase: "15000",
          },
        ],
      });
      const line2 = grn2.lines[0]!;
      await recordWeighing(tx, fx.warehouseUser, {
        goodsReceiptLineId: line2.id,
        grossWeightKg: "53.000",
        tareSource: "measured_actual",
        measuredTareWeightKg: "3.000",
      });
      await recordQualityInspection(tx, fx.qcUser, {
        goodsReceiptLineId: line2.id,
        outcome: "accepted",
      });
      await recordGradingAndYield(tx, fx.qcUser, {
        goodsReceiptLineId: line2.id,
        grades: [{ gradeCode: "A", qtyBase: "50.000" }],
      });
      const post2 = await postGoodsReceipt(tx, fx.warehouseUser, {
        goodsReceiptId: grn2.header.id,
      });
      expect(post2.poStatus).toBe("received");
    });

    const finalPo = await getPurchaseOrderWithDetails(
      fx.db,
      fx.procurementUser,
      poCreated.header.id,
    );
    expect(finalPo.header.status).toBe("received");
    expect(finalPo.lines[0]!.line.receivedNetQtyBase).toBe("120.000");
    expect(finalPo.lines[0]!.line.acceptedQtyBase).toBe("120.000");
  });

  it("2. ensures retried GRN posting is idempotent and never duplicates stock movements or batches", async () => {
    const fx = await seedPhase3Fixtures();

    const grnId = await withTransaction(async (tx) => {
      const po = await createPurchaseOrder(tx, fx.procurementUser, {
        supplierId: fx.supplierId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            orderedUomCode: "kg",
            orderedQty: "50",
            unitPriceBase: "15000",
          },
        ],
      });
      await approvePurchaseOrder(tx, fx.owner, { purchaseOrderId: po.header.id });

      const grn = await createGoodsReceipt(tx, fx.warehouseUser, {
        purchaseOrderId: po.header.id,
        receivingLocationId: fx.receivingLocationId,
        putawayLocationId: fx.coldRoomLocationId,
        supplierDeliveryNoteNo: "SJ-IDEM-01",
        lines: [
          {
            purchaseOrderLineId: po.lines[0]!.id,
            productId: fx.manggaProductId,
            actualUnitCostBase: "15000",
          },
        ],
      });
      const line = grn.lines[0]!;
      await recordWeighing(tx, fx.warehouseUser, {
        goodsReceiptLineId: line.id,
        grossWeightKg: "52.000",
        tareSource: "measured_actual",
        measuredTareWeightKg: "2.000",
      });
      await recordQualityInspection(tx, fx.qcUser, {
        goodsReceiptLineId: line.id,
        outcome: "accepted",
      });
      await recordGradingAndYield(tx, fx.qcUser, {
        goodsReceiptLineId: line.id,
        grades: [{ gradeCode: "A", qtyBase: "50.000" }],
      });
      return grn.header.id;
    });

    const firstPost = await withTransaction((tx) =>
      postGoodsReceipt(tx, fx.warehouseUser, {
        goodsReceiptId: grnId,
        idempotencyKey: "idem-grn-post-001",
      }),
    );
    expect(firstPost.idempotentReplay).toBe(false);
    expect(firstPost.batches.length).toBe(1);

    // Retry with same idempotencyKey
    const secondPost = await withTransaction((tx) =>
      postGoodsReceipt(tx, fx.warehouseUser, {
        goodsReceiptId: grnId,
        idempotencyKey: "idem-grn-post-001",
      }),
    );
    expect(secondPost.idempotentReplay).toBe(true);

    // Retry with a different idempotencyKey on already-posted GRN
    const thirdPost = await withTransaction((tx) =>
      postGoodsReceipt(tx, fx.warehouseUser, {
        goodsReceiptId: grnId,
        idempotencyKey: "idem-grn-post-002",
      }),
    );
    expect(thirdPost.idempotentReplay).toBe(true);

    const allMovements = await fx.db.select().from(inventoryMovements);
    const allBatches = await fx.db.select().from(batches);
    const allJournals = await fx.db.select().from(journalEntries);
    expect(allMovements.length).toBe(1);
    expect(allBatches.length).toBe(1);
    expect(allJournals.length).toBe(1);
  });

  it("3. rejects out-of-tolerance, substitution, or price-variance receiving until approved", async () => {
    const fx = await seedPhase3Fixtures();

    const po = await withTransaction(async (tx) => {
      const c = await createPurchaseOrder(tx, fx.procurementUser, {
        supplierId: fx.supplierId,
        warehouseId: fx.warehouseId,
        qtyTolerancePct: "5.00", // Max allowed = 105 kg
        priceVarianceTolerancePct: "0.00",
        lines: [
          {
            productId: fx.manggaProductId,
            orderedUomCode: "kg",
            orderedQty: "100",
            unitPriceBase: "15000",
          },
        ],
      });
      await approvePurchaseOrder(tx, fx.owner, { purchaseOrderId: c.header.id });
      return c;
    });

    // Create GRN delivering 115 kg (> 105 kg max tolerance) and price 16500 (> 15000)
    const grn = await withTransaction(async (tx) => {
      const g = await createGoodsReceipt(tx, fx.warehouseUser, {
        purchaseOrderId: po.header.id,
        receivingLocationId: fx.receivingLocationId,
        putawayLocationId: fx.coldRoomLocationId,
        supplierDeliveryNoteNo: "SJ-OVERTOL-01",
        lines: [
          {
            purchaseOrderLineId: po.lines[0]!.id,
            productId: fx.manggaProductId,
            actualUnitCostBase: "16500",
          },
        ],
      });
      const line = g.lines[0]!;
      await recordWeighing(tx, fx.warehouseUser, {
        goodsReceiptLineId: line.id,
        grossWeightKg: "120.000",
        tareSource: "measured_actual",
        measuredTareWeightKg: "5.000",
      });
      await recordQualityInspection(tx, fx.qcUser, {
        goodsReceiptLineId: line.id,
        outcome: "accepted",
      });
      await recordGradingAndYield(tx, fx.qcUser, {
        goodsReceiptLineId: line.id,
        grades: [{ gradeCode: "A", qtyBase: "115.000" }],
      });
      return g;
    });

    // Direct post without approval fails
    await expect(
      withTransaction((tx) =>
        postGoodsReceipt(tx, fx.warehouseUser, { goodsReceiptId: grn.header.id }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Request approval for discrepancies
    const pendingRes = await withTransaction((tx) =>
      postGoodsReceipt(tx, fx.warehouseUser, {
        goodsReceiptId: grn.header.id,
        requestApprovalIfDiscrepancy: true,
      }),
    );
    expect(pendingRes.status).toBe("pending_approval");
    expect(pendingRes.pendingApprovals.length).toBe(2); // over_tolerance + price_variance

    // Owner approves both pending approvals
    await withTransaction(async (tx) => {
      for (const app of pendingRes.pendingApprovals) {
        await decideApproval(tx, fx.owner, {
          approvalId: app.id,
          decision: "approved",
          decisionNote: "Disetujui pemilik karena kualitas mangga sangat bagus",
          expectedVersion: app.version,
        });
      }
    });

    // Now posting succeeds
    const postedRes = await withTransaction((tx) =>
      postGoodsReceipt(tx, fx.warehouseUser, { goodsReceiptId: grn.header.id }),
    );
    expect(postedRes.status).toBe("posted");
    expect(postedRes.batches[0]!.initialQtyBase).toBe("115.000");
  });

  it("4. validates grade totals, rejected quantities, unknown grade codes, and yield conservation in DB", async () => {
    const fx = await seedPhase3Fixtures();

    const grnLineId = await withTransaction(async (tx) => {
      const po = await createPurchaseOrder(tx, fx.procurementUser, {
        supplierId: fx.supplierId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            orderedUomCode: "kg",
            orderedQty: "100",
            unitPriceBase: "15000",
          },
        ],
      });
      await approvePurchaseOrder(tx, fx.owner, { purchaseOrderId: po.header.id });
      const grn = await createGoodsReceipt(tx, fx.warehouseUser, {
        purchaseOrderId: po.header.id,
        receivingLocationId: fx.receivingLocationId,
        putawayLocationId: fx.coldRoomLocationId,
        supplierDeliveryNoteNo: "SJ-YIELD-01",
        lines: [
          {
            purchaseOrderLineId: po.lines[0]!.id,
            productId: fx.manggaProductId,
            actualUnitCostBase: "15000",
          },
        ],
      });
      const line = grn.lines[0]!;
      // Use packaging_rule tare: 5 peti kayu * 2.500 kg = 12.500 kg tare -> 112.500 - 12.500 = 100.000 kg net
      await recordWeighing(tx, fx.warehouseUser, {
        goodsReceiptLineId: line.id,
        grossWeightKg: "112.500",
        tareSource: "packaging_rule",
        packagingTypeId: "pkg_peti_kayu",
        packageCount: 5,
      });
      await recordQualityInspection(tx, fx.qcUser, {
        goodsReceiptLineId: line.id,
        outcome: "partially_accepted",
        rejectionReasonCode: "MEMAR_ANGKUT",
      });
      return line.id;
    });

    // Rejects unknown grade code "Z"
    await expect(
      withTransaction((tx) =>
        recordGradingAndYield(tx, fx.qcUser, {
          goodsReceiptLineId: grnLineId,
          grades: [{ gradeCode: "Z", qtyBase: "100.000" }],
        }),
      ),
    ).rejects.toThrow(/tidak dikenal/i);

    // Rejects when sum of grades + trim + reject != 100.000 kg net
    await expect(
      withTransaction((tx) =>
        recordGradingAndYield(tx, fx.qcUser, {
          goodsReceiptLineId: grnLineId,
          grades: [{ gradeCode: "A", qtyBase: "70.000" }],
          trimLossQtyBase: "5.000",
        }),
      ),
    ).rejects.toThrow(/melebihi batas toleransi/i);

    // Succeeds when Grade A (60) + Grade B (25) + Grade C (8) + Trim (2) + Reject (5) = 100.000 kg
    const graded = await withTransaction((tx) =>
      recordGradingAndYield(tx, fx.qcUser, {
        goodsReceiptLineId: grnLineId,
        grades: [
          { gradeCode: "A", qtyBase: "60.000" },
          { gradeCode: "B", qtyBase: "25.000" },
          { gradeCode: "C", qtyBase: "8.000" },
        ],
        trimLossQtyBase: "2.000",
        rejects: [
          { qtyBase: "5.000", disposition: "return_to_supplier", reasonCode: "MEMAR_ANGKUT" },
        ],
      }),
    );
    expect(graded.yieldSummary.acceptedQtyBase).toBe("93.000");
    expect(graded.yieldSummary.yieldPct).toBe("93.00");
    expect(graded.yieldSummary.billableQtyBase).toBe("95.000");
  });

  it("5. guarantees stock ledger and stock balances always match and blocks mutation of posted movements", async () => {
    const fx = await seedPhase3Fixtures();

    const batchId = await withTransaction(async (tx) => {
      const po = await createPurchaseOrder(tx, fx.procurementUser, {
        supplierId: fx.supplierId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            orderedUomCode: "kg",
            orderedQty: "80",
            unitPriceBase: "15000",
          },
        ],
      });
      await approvePurchaseOrder(tx, fx.owner, { purchaseOrderId: po.header.id });
      const grn = await createGoodsReceipt(tx, fx.warehouseUser, {
        purchaseOrderId: po.header.id,
        receivingLocationId: fx.receivingLocationId,
        putawayLocationId: fx.coldRoomLocationId,
        supplierDeliveryNoteNo: "SJ-LEDGER-01",
        lines: [
          {
            purchaseOrderLineId: po.lines[0]!.id,
            productId: fx.manggaProductId,
            actualUnitCostBase: "15000",
          },
        ],
      });
      const line = grn.lines[0]!;
      await recordWeighing(tx, fx.warehouseUser, {
        goodsReceiptLineId: line.id,
        grossWeightKg: "83.000",
        tareSource: "measured_actual",
        measuredTareWeightKg: "3.000",
      });
      await recordQualityInspection(tx, fx.qcUser, {
        goodsReceiptLineId: line.id,
        outcome: "accepted",
      });
      await recordGradingAndYield(tx, fx.qcUser, {
        goodsReceiptLineId: line.id,
        grades: [{ gradeCode: "A", qtyBase: "80.000" }],
      });
      const posted = await postGoodsReceipt(tx, fx.warehouseUser, {
        goodsReceiptId: grn.header.id,
      });
      return posted.batches[0]!.id;
    });

    // Issue 25 kg via FEFO
    await withTransaction((tx) =>
      issueStockFefo(tx, fx.warehouseUser, {
        warehouseId: fx.warehouseId,
        productId: fx.manggaProductId,
        requestedQtyBase: "25.000",
        sourceDocType: "sales_order",
        sourceDocId: "so_test_001",
        postCogsJournal: true,
      }),
    );

    const recon = await reconcileInventoryAndGl(fx.db, fx.financeUser, {
      warehouseId: fx.warehouseId,
    });
    expect(recon.isReconciled).toBe(true);
    expect(recon.totalLedgerQtyBase).toBe("55.000");
    expect(recon.totalBalanceQtyBase).toBe("55.000");

    // Attempt to UPDATE or DELETE inventory_movements must fail via PostgreSQL trigger
    await expect(
      fx.db.execute(sql`UPDATE inventory_movements SET qty_delta_base = 999 WHERE batch_id = ${batchId}`),
    ).rejects.toThrow();

    await expect(
      fx.db.execute(sql`DELETE FROM inventory_movements WHERE batch_id = ${batchId}`),
    ).rejects.toThrow();
  });

  it("6. prevents negative stock when two concurrent picking/issue transactions race on the same batch", async () => {
    const fx = await seedPhase3Fixtures();

    // Seed 50 kg available in a single batch
    await withTransaction(async (tx) => {
      const po = await createPurchaseOrder(tx, fx.procurementUser, {
        supplierId: fx.supplierId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            orderedUomCode: "kg",
            orderedQty: "50",
            unitPriceBase: "16000",
          },
        ],
      });
      await approvePurchaseOrder(tx, fx.owner, { purchaseOrderId: po.header.id });
      const grn = await createGoodsReceipt(tx, fx.warehouseUser, {
        purchaseOrderId: po.header.id,
        receivingLocationId: fx.receivingLocationId,
        putawayLocationId: fx.coldRoomLocationId,
        supplierDeliveryNoteNo: "SJ-RACE-01",
        lines: [
          {
            purchaseOrderLineId: po.lines[0]!.id,
            productId: fx.manggaProductId,
            actualUnitCostBase: "16000",
          },
        ],
      });
      const line = grn.lines[0]!;
      await recordWeighing(tx, fx.warehouseUser, {
        goodsReceiptLineId: line.id,
        grossWeightKg: "52.000",
        tareSource: "measured_actual",
        measuredTareWeightKg: "2.000",
      });
      await recordQualityInspection(tx, fx.qcUser, {
        goodsReceiptLineId: line.id,
        outcome: "accepted",
      });
      await recordGradingAndYield(tx, fx.qcUser, {
        goodsReceiptLineId: line.id,
        grades: [{ gradeCode: "A", qtyBase: "50.000" }],
      });
      await postGoodsReceipt(tx, fx.warehouseUser, { goodsReceiptId: grn.header.id });
    });

    // Two concurrent transactions both try to pick 40 kg from the 50 kg batch
    const [res1, res2] = await Promise.allSettled([
      withTransaction((tx) =>
        issueStockFefo(tx, fx.warehouseUser, {
          warehouseId: fx.warehouseId,
          productId: fx.manggaProductId,
          requestedQtyBase: "40.000",
          sourceDocType: "sales_pick",
          sourceDocId: "pick_concurrent_1",
        }),
      ),
      withTransaction((tx) =>
        issueStockFefo(tx, fx.warehouseUser, {
          warehouseId: fx.warehouseId,
          productId: fx.manggaProductId,
          requestedQtyBase: "40.000",
          sourceDocType: "sales_pick",
          sourceDocId: "pick_concurrent_2",
        }),
      ),
    ]);

    const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
    const rejected = [res1, res2].filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const [bal] = await fx.db.select().from(stockBalances);
    expect(bal!.qtyBase).toBe("10.000"); // 50 - 40 = 10.000 >= 0
  });

  it("7. selects eligible batches using FEFO ordering and excludes expired, short-shelf-life, or quarantined batches", async () => {
    const fx = await seedPhase3Fixtures();
    const gradeAId = fx.manggaGrades.A!;

    // Seed 4 batches directly with distinct bestBeforeDate and zones
    await withTransaction(async (tx) => {
      const testBatches = [
        {
          id: "bat_expired",
          code: "LOT-EXPIRED",
          bestBefore: "2026-10-18", // Expired relative to 2026-10-20
          locId: fx.coldRoomLocationId,
          qty: "30.000",
        },
        {
          id: "bat_short_1d",
          code: "LOT-SHORT-1D",
          bestBefore: "2026-10-21", // Only 1 day left relative to 2026-10-20
          locId: fx.coldRoomLocationId,
          qty: "25.000",
        },
        {
          id: "bat_good_early",
          code: "LOT-GOOD-EARLY",
          bestBefore: "2026-10-23", // 3 days left (should be picked FIRST when minRemainingShelfLifeDays = 2)
          locId: fx.coldRoomLocationId,
          qty: "40.000",
        },
        {
          id: "bat_good_later",
          code: "LOT-GOOD-LATER",
          bestBefore: "2026-10-26", // 6 days left (should be picked SECOND)
          locId: fx.coldRoomLocationId,
          qty: "50.000",
        },
        {
          id: "bat_quarantine",
          code: "LOT-QUARANTINE",
          bestBefore: "2026-10-22",
          locId: fx.quarantineLocationId, // Quarantined zone -> must be excluded
          qty: "100.000",
        },
      ];

      for (const b of testBatches) {
        await tx.insert(batches).values({
          id: b.id,
          batchCode: b.code,
          productId: fx.manggaProductId,
          gradeId: gradeAId,
          gradeCode: "A",
          supplierId: fx.supplierId,
          warehouseId: fx.warehouseId,
          originRegion: "Probolinggo",
          receivedAt: new Date("2026-10-20T01:00:00Z"),
          ripenessStage: "matang_siap_jual",
          bestBeforeDate: b.bestBefore,
          expiresAt: new Date(`${b.bestBefore}T16:59:59Z`),
          initialQtyBase: b.qty,
          unitCostBase: "15000.0000",
          totalInitialCost: "600000.00",
          status: "active",
        });

        await applyInventoryMovement(tx, fx.warehouseUser, {
          warehouseId: fx.warehouseId,
          locationId: b.locId,
          batchId: b.id,
          productId: fx.manggaProductId,
          gradeId: gradeAId,
          stockStatus: "available",
          movementType: "grn_receipt",
          qtyDeltaBase: b.qty,
          unitCostBase: "15000.0000",
          sourceDocType: "test_seed",
          sourceDocId: b.id,
        });
      }
    });

    // Query FEFO candidates as of 2026-10-20 requiring at least 2 days remaining shelf life
    const candidates = await selectFefoCandidates(fx.db, fx.warehouseUser, {
      warehouseId: fx.warehouseId,
      productId: fx.manggaProductId,
      asOfDate: "2026-10-20",
      minRemainingShelfLifeDays: 2,
    });

    expect(candidates.map((c) => c.batchCode)).toEqual(["LOT-GOOD-EARLY", "LOT-GOOD-LATER"]);

    // Issue 55 kg with minRemainingShelfLifeDays = 2 -> takes 40 kg from LOT-GOOD-EARLY and 15 kg from LOT-GOOD-LATER
    const issueRes = await withTransaction((tx) =>
      issueStockFefo(tx, fx.warehouseUser, {
        warehouseId: fx.warehouseId,
        productId: fx.manggaProductId,
        requestedQtyBase: "55.000",
        asOfDate: "2026-10-20",
        minRemainingShelfLifeDays: 2,
        sourceDocType: "sales_order",
        sourceDocId: "so_fefo_01",
      }),
    );

    expect(issueRes.allocations).toEqual([
      expect.objectContaining({ batchCode: "LOT-GOOD-EARLY", pickedQtyBase: "40.000" }),
      expect.objectContaining({ batchCode: "LOT-GOOD-LATER", pickedQtyBase: "15.000" }),
    ]);
  });

  it("8. enforces permissions, approval workflow, GL posting, and audit trail for spoilage and stock adjustments", async () => {
    const fx = await seedPhase3Fixtures();

    const batchId = await withTransaction(async (tx) => {
      const po = await createPurchaseOrder(tx, fx.procurementUser, {
        supplierId: fx.supplierId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            orderedUomCode: "kg",
            orderedQty: "50",
            unitPriceBase: "20000",
          },
        ],
      });
      await approvePurchaseOrder(tx, fx.owner, { purchaseOrderId: po.header.id });
      const grn = await createGoodsReceipt(tx, fx.warehouseUser, {
        purchaseOrderId: po.header.id,
        receivingLocationId: fx.receivingLocationId,
        putawayLocationId: fx.coldRoomLocationId,
        supplierDeliveryNoteNo: "SJ-SPL-01",
        lines: [
          {
            purchaseOrderLineId: po.lines[0]!.id,
            productId: fx.manggaProductId,
            actualUnitCostBase: "20000",
          },
        ],
      });
      const line = grn.lines[0]!;
      await recordWeighing(tx, fx.warehouseUser, {
        goodsReceiptLineId: line.id,
        grossWeightKg: "52.000",
        tareSource: "measured_actual",
        measuredTareWeightKg: "2.000",
      });
      await recordQualityInspection(tx, fx.qcUser, {
        goodsReceiptLineId: line.id,
        outcome: "accepted",
      });
      await recordGradingAndYield(tx, fx.qcUser, {
        goodsReceiptLineId: line.id,
        grades: [{ gradeCode: "A", qtyBase: "50.000" }],
      });
      const posted = await postGoodsReceipt(tx, fx.warehouseUser, {
        goodsReceiptId: grn.header.id,
      });
      return posted.batches[0]!.id;
    });

    // Warehouse operator (has inventory.adjust, does NOT have inventory.approve) submits 15 kg spoilage
    const createdAdj = await withTransaction((tx) =>
      createStockAdjustment(tx, fx.warehouseUser, {
        warehouseId: fx.warehouseId,
        adjustmentCategory: "spoilage",
        reasonCode: "BUSUK_COLD_STORAGE",
        notes: "Mangga terlalu matang di rak bawah",
        lines: [
          {
            locationId: fx.coldRoomLocationId,
            batchId,
            qtyDeltaBase: "-15.000",
          },
        ],
      }),
    );
    expect(createdAdj.header.status).toBe("pending_approval");
    expect(createdAdj.header.requiresApproval).toBe(true);
    expect(createdAdj.approval?.status).toBe("pending");

    // Warehouse operator cannot approve/post the adjustment
    await expect(
      withTransaction((tx) =>
        postStockAdjustment(tx, fx.warehouseUser, {
          stockAdjustmentId: createdAdj.header.id,
        }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Owner approves and posts the spoilage adjustment
    const postedAdj = await withTransaction((tx) =>
      postStockAdjustment(tx, fx.owner, {
        stockAdjustmentId: createdAdj.header.id,
        approvalNote: "Disetujui penghapusan 15 kg mangga busuk",
      }),
    );
    expect(postedAdj.header.status).toBe("posted");
    expect(postedAdj.header.journalEntryId).toBeTruthy();

    // Check GL Spoilage Expense (5210) balance = 15 kg * 20,000 = Rp 300,000.00
    const spoilageBal = await getGlAccountBalance(fx.db, GL_ACCOUNT_CODES.SPOILAGE_EXPENSE);
    expect(spoilageBal.netBalance).toBe("300000.00");

    // Check audit logs recorded both creation and posting
    const audits = await listAuditLogs(fx.db, fx.owner, { entityType: "stock_adjustment" });
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["inventory.adjustment_create", "inventory.adjustment_post"]),
    );
  });

  it("9. blocks unauthorized users from posting receiving, inventory adjustments, or GL journals", async () => {
    const fx = await seedPhase3Fixtures();

    // Sales user cannot create PO
    await expect(
      withTransaction((tx) =>
        createPurchaseOrder(tx, fx.salesUser, {
          supplierId: fx.supplierId,
          warehouseId: fx.warehouseId,
          lines: [
            {
              productId: fx.manggaProductId,
              orderedUomCode: "kg",
              orderedQty: "10",
              unitPriceBase: "15000",
            },
          ],
        }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Procurement user cannot approve PO
    const po = await withTransaction((tx) =>
      createPurchaseOrder(tx, fx.procurementUser, {
        supplierId: fx.supplierId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            orderedUomCode: "kg",
            orderedQty: "10",
            unitPriceBase: "15000",
          },
        ],
      }),
    );
    await expect(
      withTransaction((tx) =>
        approvePurchaseOrder(tx, fx.procurementUser, { purchaseOrderId: po.header.id }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Sales user cannot post GL journal
    await expect(
      withTransaction((tx) =>
        postJournalEntry(tx, fx.salesUser, {
          warehouseId: fx.warehouseId,
          sourceDocType: "manual",
          sourceDocId: "man_01",
          purpose: "test",
          memo: "Jurnal tidak sah",
          lines: [
            { accountCode: GL_ACCOUNT_CODES.CASH_BANK, debit: "10000" },
            { accountCode: GL_ACCOUNT_CODES.OWNER_EQUITY, credit: "10000" },
          ],
        }),
      ),
    ).rejects.toThrow(ForbiddenError);

    // Sales user cannot create stock adjustment
    await expect(
      withTransaction((tx) =>
        createStockAdjustment(tx, fx.salesUser, {
          warehouseId: fx.warehouseId,
          adjustmentCategory: "spoilage",
          reasonCode: "BUSUK",
          notes: "Coba akses ilegal",
          lines: [{ locationId: fx.coldRoomLocationId, batchId: "bat_none", qtyDeltaBase: "-1" }],
        }),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("10. enforces balanced journal entries (debit = credit), immutability triggers, and contra-entry reversals", async () => {
    const fx = await seedPhase3Fixtures();

    // Unbalanced journal entry rejected by service validation
    await expect(
      withTransaction((tx) =>
        postJournalEntry(tx, fx.financeUser, {
          warehouseId: fx.warehouseId,
          sourceDocType: "test_doc",
          sourceDocId: "doc_unbalanced",
          purpose: "test",
          memo: "Jurnal tidak seimbang",
          lines: [
            { accountCode: GL_ACCOUNT_CODES.INVENTORY_FRUIT, debit: "150000.00" },
            { accountCode: GL_ACCOUNT_CODES.GRNI_ACCRUAL, credit: "140000.00" },
          ],
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Post valid balanced journal entry
    const posted = await withTransaction((tx) =>
      postJournalEntry(tx, fx.financeUser, {
        warehouseId: fx.warehouseId,
        sourceDocType: "test_doc",
        sourceDocId: "doc_balanced_1",
        purpose: "test",
        memo: "Setoran modal awal uji",
        lines: [
          { accountCode: GL_ACCOUNT_CODES.CASH_BANK, debit: "500000.00" },
          { accountCode: GL_ACCOUNT_CODES.OWNER_EQUITY, credit: "500000.00" },
        ],
      }),
    );
    expect(posted.entry.totalDebit).toBe("500000.00");
    expect(posted.entry.totalCredit).toBe("500000.00");

    // Direct SQL UPDATE or DELETE on journal_entries / journal_lines is blocked by PostgreSQL trigger
    await expect(
      fx.db.execute(
        sql`UPDATE journal_entries SET memo = 'Diubah paksa' WHERE id = ${posted.entry.id}`,
      ),
    ).rejects.toThrow();
    await expect(
      fx.db.execute(
        sql`DELETE FROM journal_lines WHERE journal_entry_id = ${posted.entry.id}`,
      ),
    ).rejects.toThrow();

    // Direct SQL insertion of an unbalanced journal entry + lines is rejected by PostgreSQL constraint trigger
    await expect(
      withTransaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO journal_entries (
            id, entry_no, entry_date, fiscal_period_id, source_doc_type, source_doc_id, purpose,
            memo, total_debit, total_credit, posted_by
          ) VALUES (
            'je_bad_sql', 'JRN/BKS1/2610/99999', '2026-10-20', '2026-10', 'raw_sql', 'raw_1', 'raw',
            'Bypass coba', 100000.00, 100000.00, ${fx.financeUser.user.id}
          )
        `);
        await tx.execute(sql`
          INSERT INTO journal_lines (id, journal_entry_id, line_no, account_code, debit, credit)
          VALUES
            ('jl_bad_1', 'je_bad_sql', 1, '1110', 100000.00, 0.00),
            ('jl_bad_2', 'je_bad_sql', 2, '3100', 0.00, 80000.00)
        `);
        await tx.execute(sql`SET CONSTRAINTS trg_journal_entry_balanced IMMEDIATE`);
      }),
    ).rejects.toThrow();

    // Reverse journal entry via contra-entry
    const reversed = await withTransaction((tx) =>
      reverseJournalEntry(tx, fx.financeUser, {
        journalEntryId: posted.entry.id,
        reason: "Koreksi nominal setoran",
      }),
    );
    expect(reversed.entry.isReversal).toBe(true);
    expect(reversed.entry.reversalOfEntryId).toBe(posted.entry.id);

    // Cannot reverse the same entry twice
    await expect(
      withTransaction((tx) =>
        reverseJournalEntry(tx, fx.financeUser, {
          journalEntryId: posted.entry.id,
          reason: "Reversal ganda",
        }),
      ),
    ).rejects.toThrow(BusinessRuleError);

    const cashBal = await getGlAccountBalance(fx.db, GL_ACCOUNT_CODES.CASH_BANK);
    expect(cashBal.netBalance).toBe("0.00");
  });

  it("11. rolls back all multi-table changes atomically on mid-transaction failure", async () => {
    const fx = await seedPhase3Fixtures();

    await expect(
      withTransaction(async (tx) => {
        const po = await createPurchaseOrder(tx, fx.procurementUser, {
          supplierId: fx.supplierId,
          warehouseId: fx.warehouseId,
          lines: [
            {
              productId: fx.manggaProductId,
              orderedUomCode: "kg",
              orderedQty: "40",
              unitPriceBase: "15000",
            },
          ],
        });
        await approvePurchaseOrder(tx, fx.owner, { purchaseOrderId: po.header.id });
        const grn = await createGoodsReceipt(tx, fx.warehouseUser, {
          purchaseOrderId: po.header.id,
          receivingLocationId: fx.receivingLocationId,
          putawayLocationId: fx.coldRoomLocationId,
          supplierDeliveryNoteNo: "SJ-ROLLBACK-01",
          lines: [
            {
              purchaseOrderLineId: po.lines[0]!.id,
              productId: fx.manggaProductId,
              actualUnitCostBase: "15000",
            },
          ],
        });
        const line = grn.lines[0]!;
        await recordWeighing(tx, fx.warehouseUser, {
          goodsReceiptLineId: line.id,
          grossWeightKg: "42.000",
          tareSource: "measured_actual",
          measuredTareWeightKg: "2.000",
        });
        await recordQualityInspection(tx, fx.qcUser, {
          goodsReceiptLineId: line.id,
          outcome: "accepted",
        });
        await recordGradingAndYield(tx, fx.qcUser, {
          goodsReceiptLineId: line.id,
          grades: [{ gradeCode: "A", qtyBase: "40.000" }],
        });
        await postGoodsReceipt(tx, fx.warehouseUser, { goodsReceiptId: grn.header.id });

        // Simulate failure after GRN post inside the same transaction
        throw new Error("Kegagalan jaringan/sistem simulasi di tengah transaksi");
      }),
    ).rejects.toThrow(/simulasi/i);

    const remBatches = await fx.db.select().from(batches);
    const remMovements = await fx.db.select().from(inventoryMovements);
    const remBalances = await fx.db.select().from(stockBalances);
    const remJournals = await fx.db.select().from(journalEntries);

    expect(remBatches.length).toBe(0);
    expect(remMovements.length).toBe(0);
    expect(remBalances.length).toBe(0);
    expect(remJournals.length).toBe(0);
  });

  it("12. verifies synthetic dataset manual calculation vs system valuation, reconciliation service, and costing policy gate", async () => {
    const fx = await seedPhase3Fixtures();

    // Verify production costing policy gate is BLOCKED before owner & accountant approval
    const initialGate = await evaluateCostingPolicyGate(fx.db);
    expect(initialGate.productionValuationBlocked).toBe(true);
    expect(initialGate.status).toBe("synthetic_dev_blocked_prod");

    await expect(
      evaluateCostingPolicyGate(fx.db, { enforceProductionGate: true }),
    ).rejects.toThrow(/BLOCKED/i);

    // Step 1: Receive 100 kg bruto Mangga (5 kg tare -> 95 kg neto)
    // Default grades: Grade A (100%), Grade B (85%), Grade C (65%)
    // Graded: Grade A = 50 kg (index 5000), Grade B = 20 kg (index 1700), Grade C = 20 kg (index 1300) -> Total Index W = 8000
    // Trim = 2 kg, Reject (return_to_supplier) = 3 kg -> Billable = 92 kg @ Rp 15,000 = Rp 1,380,000 + Freight Rp 220,000 = Total Lot Cost Rp 1,600,000
    // Manual RSV Allocation:
    // - Grade A: 1,600,000 * 5000 / 8000 = Rp 1,000,000.00 (50 kg -> Rp 20,000.0000 / kg)
    // - Grade B: 1,600,000 * 1700 / 8000 = Rp 340,000.00   (20 kg -> Rp 17,000.0000 / kg)
    // - Grade C: 1,600,000 * 1300 / 8000 = Rp 260,000.00   (20 kg -> Rp 13,000.0000 / kg)
    const grnPosted = await withTransaction(async (tx) => {
      const po = await createPurchaseOrder(tx, fx.procurementUser, {
        supplierId: fx.supplierId,
        warehouseId: fx.warehouseId,
        lines: [
          {
            productId: fx.manggaProductId,
            orderedUomCode: "kg",
            orderedQty: "100",
            unitPriceBase: "15000",
          },
        ],
      });
      await approvePurchaseOrder(tx, fx.owner, { purchaseOrderId: po.header.id });

      const grn = await createGoodsReceipt(tx, fx.warehouseUser, {
        purchaseOrderId: po.header.id,
        receivingLocationId: fx.receivingLocationId,
        putawayLocationId: fx.coldRoomLocationId,
        supplierDeliveryNoteNo: "SJ-SYNTH-001",
        lines: [
          {
            purchaseOrderLineId: po.lines[0]!.id,
            productId: fx.manggaProductId,
            actualUnitCostBase: "15000",
          },
        ],
        landedCosts: [
          {
            costType: "freight",
            description: "Sewa truk pendingin Probolinggo-Bekasi",
            amount: "220000",
          },
        ],
      });

      const line = grn.lines[0]!;
      await recordWeighing(tx, fx.warehouseUser, {
        goodsReceiptLineId: line.id,
        grossWeightKg: "100.000",
        tareSource: "measured_actual",
        measuredTareWeightKg: "5.000",
      });
      await recordQualityInspection(tx, fx.qcUser, {
        goodsReceiptLineId: line.id,
        brixPct: "15.5",
        ripenessStage: "matang_siap_jual",
        outcome: "partially_accepted",
        rejectionReasonCode: "BUSUK_ANGKUT",
      });
      await recordGradingAndYield(tx, fx.qcUser, {
        goodsReceiptLineId: line.id,
        grades: [
          { gradeCode: "A", qtyBase: "50.000" },
          { gradeCode: "B", qtyBase: "20.000" },
          { gradeCode: "C", qtyBase: "20.000" },
        ],
        trimLossQtyBase: "2.000",
        rejects: [
          { qtyBase: "3.000", disposition: "return_to_supplier", reasonCode: "BUSUK_ANGKUT" },
        ],
      });

      return postGoodsReceipt(tx, fx.warehouseUser, { goodsReceiptId: grn.header.id });
    });

    const batchByGrade = Object.fromEntries(grnPosted.batches.map((b) => [b.gradeCode, b]));
    expect(batchByGrade.A?.totalInitialCost).toBe("1000000.00");
    expect(batchByGrade.A?.unitCostBase).toBe("20000.0000");
    expect(batchByGrade.B?.totalInitialCost).toBe("340000.00");
    expect(batchByGrade.B?.unitCostBase).toBe("17000.0000");
    expect(batchByGrade.C?.totalInitialCost).toBe("260000.00");
    expect(batchByGrade.C?.unitCostBase).toBe("13000.0000");

    // Step 2: Issue 20 kg of Grade A via FEFO (20 kg * Rp 20,000 = Rp 400,000 COGS)
    await withTransaction((tx) =>
      issueStockFefo(tx, fx.warehouseUser, {
        warehouseId: fx.warehouseId,
        productId: fx.manggaProductId,
        gradeId: fx.manggaGrades.A,
        requestedQtyBase: "20.000",
        sourceDocType: "sales_order",
        sourceDocId: "so_synth_01",
        postCogsJournal: true,
      }),
    );

    // Step 3: Post-receiving spoilage of 2 kg on Grade B (2 kg * Rp 17,000 = Rp 34,000 Spoilage Expense 5210)
    await withTransaction((tx) =>
      createStockAdjustment(tx, fx.owner, {
        warehouseId: fx.warehouseId,
        adjustmentCategory: "spoilage",
        reasonCode: "BUSUK_SIMPAN",
        notes: "2 kg Mangga Grade B busuk pasca simpan",
        lines: [
          {
            locationId: fx.coldRoomLocationId,
            batchId: batchByGrade.B!.id,
            qtyDeltaBase: "-2.000",
          },
        ],
        autoPostIfPermitted: true,
      }),
    );

    // Step 4: Physical Stock Count on Grade C finding 19 kg vs 20 kg system (-1 kg * Rp 13,000 = Rp 13,000 Variance 5220)
    await withTransaction((tx) =>
      createAndPostStockCount(tx, fx.owner, {
        warehouseId: fx.warehouseId,
        locationId: fx.coldRoomLocationId,
        notes: "Opname fisik harian Grade C",
        lines: [
          {
            locationId: fx.coldRoomLocationId,
            batchId: batchByGrade.C!.id,
            countedQtyBase: "19.000",
            reasonCode: "SELISIH_OPNAME",
          },
        ],
      }),
    );

    // Manual Calculation Expected Totals:
    // - Remaining Qty = 30 kg (A) + 18 kg (B) + 19 kg (C) = 67.000 kg
    // - Remaining Value = 600,000 (A) + 306,000 (B) + 247,000 (C) = Rp 1,153,000.00
    // - GL 1140 (Inventory): 1,600,000 - 400,000 - 34,000 - 13,000 = Rp 1,153,000.00
    // - GL 2115 (GRNI): Rp 1,600,000.00
    // - GL 5100 (COGS): Rp 400,000.00
    // - GL 5210 (Spoilage): Rp 34,000.00
    // - GL 5220 (Stock Count Variance): Rp 13,000.00
    const recon = await reconcileInventoryAndGl(fx.db, fx.financeUser, {
      warehouseId: fx.warehouseId,
    });
    expect(recon.isReconciled).toBe(true);
    expect(recon.ledgerBalanceDiscrepancies).toEqual([]);
    expect(recon.totalLedgerQtyBase).toBe("67.000");
    expect(recon.totalBalanceQtyBase).toBe("67.000");
    expect(recon.qtyVarianceBase).toBe("0.000");
    expect(recon.totalLedgerValue).toBe("1153000.00");
    expect(recon.totalBalanceValue).toBe("1153000.00");
    expect(recon.glInventoryAccountBalance).toBe("1153000.00");
    expect(recon.inventoryVsGlVariance).toBe("0.00");

    const grniBal = await getGlAccountBalance(fx.db, GL_ACCOUNT_CODES.GRNI_ACCRUAL);
    const cogsBal = await getGlAccountBalance(fx.db, GL_ACCOUNT_CODES.COGS_FRUIT);
    const spoilBal = await getGlAccountBalance(fx.db, GL_ACCOUNT_CODES.SPOILAGE_EXPENSE);
    const varBal = await getGlAccountBalance(fx.db, GL_ACCOUNT_CODES.INVENTORY_VARIANCE);

    expect(grniBal.netBalance).toBe("1600000.00");
    expect(cogsBal.netBalance).toBe("400000.00");
    expect(spoilBal.netBalance).toBe("340000.00".slice(0, 0) || "34000.00");
    expect(varBal.netBalance).toBe("13000.00");

    // Step 5: Verify that once Owner and Accountant approve the costing policy setting, production gate passes
    await withTransaction((tx) =>
      setSetting(tx, fx.owner, {
        key: COSTING_POLICY_SETTING_KEY,
        value: {
          approvedByOwner: true,
          approvedByAccountant: true,
          policyVersion: "1.0.0",
        },
        reason: "Persetujuan resmi kebijakan HPP Lot Actual + RSV oleh Pemilik dan Akuntan",
      }),
    );

    const approvedGate = await evaluateCostingPolicyGate(fx.db, { enforceProductionGate: true });
    expect(approvedGate.status).toBe("approved");
    expect(approvedGate.productionValuationBlocked).toBe(false);
  });
});
