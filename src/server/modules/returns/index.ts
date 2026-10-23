import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  parseMoney,
  roundRupiah,
  roundUnitPrice,
  toDbAmount,
  toDbUnitPrice,
} from "@/lib/money";
import { parseQty, roundQty, toDbQty } from "@/lib/quantity";
import { recordAudit } from "@/server/audit";
import { authorize, type ActorContext } from "@/server/authz/authorize";
import { businessDate } from "@/lib/datetime";
import type { DbExecutor } from "@/server/db";
import {
  batches,
  customerCreditNotes,
  customerInvoices,
  customers,
  deliveryClaims,
  deliveryOrders,
  productGrades,
  products,
  proofOfDeliveries,
  salesOrders,
  warehouseLocations,
  warehouses,
} from "@/server/db/schema";
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/server/errors";
import { withIdempotency } from "@/server/idempotency";
import { approveCreditNote, createCreditNote } from "@/server/modules/finance";
import { GL_ACCOUNT_CODES, postJournalEntry } from "@/server/modules/gl";
import { applyInventoryMovement } from "@/server/modules/inventory/ledger";
import { nextDocumentNumber } from "@/server/sequences";

export const createCustomerClaimSchema = z.object({
  customerId: z.string().min(1, "Pelanggan wajib dipilih."),
  warehouseId: z.string().min(1, "Gudang wajib dipilih."),
  salesOrderId: z.string().min(1, "Sales Order wajib direferensikan."),
  deliveryOrderId: z.string().optional().nullable(),
  podId: z.string().optional().nullable(),
  invoiceId: z.string().optional().nullable(),
  batchId: z.string().optional().nullable(),
  locationId: z.string().optional().nullable(),
  productId: z.string().optional().nullable(),
  gradeId: z.string().optional().nullable(),
  claimType: z.enum([
    "shortage",
    "damaged_in_transit",
    "refused_by_customer",
    "failed_delivery",
    "mixed_discrepancy",
    "quality_claim",
    "sales_return",
    "price_adjustment",
  ]),
  reasonCode: z.string().trim().min(2, "Kode alasan wajib diisi."),
  notes: z.string().trim().min(3, "Catatan/penjelasan klaim wajib diisi minimal 3 karakter."),
  evidenceRef: z.string().trim().optional().nullable(),
  requiresPhysicalReturn: z.boolean().default(false),
  discrepancyQtyBase: z.union([z.string(), z.number()]),
  estimatedClaimValue: z.union([z.string(), z.number()]).default("0.00"),
  submitImmediately: z.boolean().default(false),
  idempotencyKey: z.string().optional().nullable(),
});

export type CreateCustomerClaimInput = z.input<typeof createCustomerClaimSchema>;

/**
 * Buat klaim pelanggan baru (status draft atau submitted).
 */
export async function createCustomerClaim(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: CreateCustomerClaimInput,
) {
  const parsed = createCustomerClaimSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  authorize(ctx, "returns.write", { warehouseId: data.warehouseId });

  const executeCreate = async () => {
    // 1. Validasi Gudang
    const [wh] = await tx
      .select()
      .from(warehouses)
      .where(eq(warehouses.id, data.warehouseId))
      .limit(1);
    if (!wh) throw new NotFoundError(`Gudang '${data.warehouseId}' tidak ditemukan.`);

    // 2. Validasi Pelanggan
    const [cust] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, data.customerId))
      .limit(1);
    if (!cust) throw new NotFoundError(`Pelanggan '${data.customerId}' tidak ditemukan.`);

    // 3. Validasi Sales Order
    const [so] = await tx
      .select()
      .from(salesOrders)
      .where(eq(salesOrders.id, data.salesOrderId))
      .limit(1);
    if (!so) throw new NotFoundError(`Sales Order '${data.salesOrderId}' tidak ditemukan.`);
    if (so.customerId !== data.customerId) {
      throw new BusinessRuleError("Sales Order yang direferensikan bukan milik pelanggan ini.");
    }
    if (so.warehouseId !== data.warehouseId) {
      throw new BusinessRuleError("Sales Order yang direferensikan bukan dari gudang yang sama.");
    }

    // 4. Validasi Delivery Order jika disertakan
    if (data.deliveryOrderId) {
      const [dOrder] = await tx
        .select()
        .from(deliveryOrders)
        .where(eq(deliveryOrders.id, data.deliveryOrderId))
        .limit(1);
      if (!dOrder) {
        throw new NotFoundError(`Surat Jalan (DO) '${data.deliveryOrderId}' tidak ditemukan.`);
      }
      if (dOrder.salesOrderId !== so.id) {
        throw new BusinessRuleError("Surat Jalan (DO) tidak sesuai dengan Sales Order yang dipilih.");
      }
    }

    // 5. Validasi POD jika disertakan
    if (data.podId) {
      const [pod] = await tx
        .select()
        .from(proofOfDeliveries)
        .where(eq(proofOfDeliveries.id, data.podId))
        .limit(1);
      if (!pod) throw new NotFoundError(`Bukti Kirim (POD) '${data.podId}' tidak ditemukan.`);
      if (pod.salesOrderId !== so.id) {
        throw new BusinessRuleError("POD tidak sesuai dengan Sales Order yang dipilih.");
      }
    }

    // 6. Validasi Faktur jika disertakan
    if (data.invoiceId) {
      const [inv] = await tx
        .select()
        .from(customerInvoices)
        .where(eq(customerInvoices.id, data.invoiceId))
        .limit(1);
      if (!inv) throw new NotFoundError(`Faktur '${data.invoiceId}' tidak ditemukan.`);
      if (inv.customerId !== data.customerId) {
        throw new BusinessRuleError("Faktur yang dipilih bukan milik pelanggan ini.");
      }
      if (inv.status === "cancelled") {
        throw new BusinessRuleError("Tidak dapat mengajukan klaim atas faktur yang telah dibatalkan.");
      }
    }

    // 7. Validasi Produk & Grade jika disertakan
    if (data.productId) {
      const [prod] = await tx
        .select()
        .from(products)
        .where(eq(products.id, data.productId))
        .limit(1);
      if (!prod) throw new NotFoundError(`Produk '${data.productId}' tidak ditemukan.`);
    }

    if (data.gradeId) {
      const [grd] = await tx
        .select()
        .from(productGrades)
        .where(eq(productGrades.id, data.gradeId))
        .limit(1);
      if (!grd) throw new NotFoundError(`Grade '${data.gradeId}' tidak ditemukan.`);
    }

    // 8. Validasi Kuantitas & Nilai
    const discrepancyQty = roundQty(parseQty(data.discrepancyQtyBase));
    if (discrepancyQty.lte(0)) {
      throw new BusinessRuleError("Kuantitas klaim (discrepancyQtyBase) harus lebih besar dari 0.");
    }

    const estimatedValue = roundRupiah(parseMoney(data.estimatedClaimValue));
    if (estimatedValue.lt(0)) {
      throw new BusinessRuleError("Nilai estimasi klaim tidak boleh negatif.");
    }

    // 9. Nomor Dokumen & State Awal
    const claimNo = await nextDocumentNumber(tx, {
      docType: "CLM",
      warehouseCode: wh.code,
    });

    const isSubmitted = data.submitImmediately;
    const initialStatus = isSubmitted ? "submitted" : "draft";
    const qcStatus = data.requiresPhysicalReturn ? "pending_qc" : "not_required";
    const claimId = `clm_${crypto.randomUUID().slice(0, 8)}`;

    const [created] = await tx
      .insert(deliveryClaims)
      .values({
        id: claimId,
        claimNo,
        salesOrderId: data.salesOrderId,
        customerId: data.customerId,
        warehouseId: data.warehouseId,
        deliveryOrderId: data.deliveryOrderId ?? null,
        podId: data.podId ?? null,
        invoiceId: data.invoiceId ?? null,
        batchId: data.batchId ?? null,
        locationId: data.locationId ?? null,
        productId: data.productId ?? null,
        gradeId: data.gradeId ?? null,
        claimType: data.claimType,
        status: initialStatus,
        discrepancyQtyBase: toDbQty(discrepancyQty),
        claimedQtyBase: toDbQty(discrepancyQty),
        approvedQtyBase: "0.000",
        estimatedClaimValue: toDbAmount(estimatedValue),
        approvedClaimValue: "0.00",
        reasonCode: data.reasonCode,
        notes: data.notes,
        evidenceRef: data.evidenceRef ?? null,
        requiresPhysicalReturn: data.requiresPhysicalReturn,
        qcStatus,
        submittedBy: isSubmitted ? ctx.user.id : null,
        submittedAt: isSubmitted ? new Date() : null,
        idempotencyKey: data.idempotencyKey?.trim() ?? null,
        createdBy: ctx.user.id,
      })
      .returning();

    await recordAudit(tx, {
      ctx,
      action: isSubmitted ? "customer_claim.submit" : "customer_claim.create",
      entityType: "delivery_claim",
      entityId: claimId,
      warehouseId: data.warehouseId,
      afterData: created,
    });

    return created!;
  };

  if (data.idempotencyKey?.trim()) {
    const idem = await withIdempotency(
      tx,
      {
        scope: "returns.claim_create",
        key: data.idempotencyKey.trim(),
        payload: rawInput,
        actorUserId: ctx.user.id,
      },
      executeCreate,
    );
    return idem.result;
  }

  return executeCreate();
}

/**
 * Ajukan klaim berstatus draft menjadi submitted.
 */
export async function submitCustomerClaim(
  tx: DbExecutor,
  ctx: ActorContext,
  input: { claimId: string },
) {
  await tx.execute(sql`SELECT id FROM delivery_claims WHERE id = ${input.claimId} FOR UPDATE`);
  const [claim] = await tx
    .select()
    .from(deliveryClaims)
    .where(eq(deliveryClaims.id, input.claimId))
    .limit(1);

  if (!claim) throw new NotFoundError("Klaim pelanggan tidak ditemukan.");
  authorize(ctx, "returns.write", { warehouseId: claim.warehouseId });

  if (claim.status !== "draft") {
    throw new BusinessRuleError(
      `Hanya klaim berstatus 'draft' yang dapat diajukan. Status saat ini: '${claim.status}'.`,
    );
  }

  const [updated] = await tx
    .update(deliveryClaims)
    .set({
      status: "submitted",
      submittedBy: ctx.user.id,
      submittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(deliveryClaims.id, claim.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "customer_claim.submit",
    entityType: "delivery_claim",
    entityId: claim.id,
    warehouseId: claim.warehouseId,
    beforeData: claim,
    afterData: updated,
  });

  return updated!;
}

/**
 * Pindahkan status klaim menjadi under_review untuk investigasi operasional.
 */
export async function reviewCustomerClaim(
  tx: DbExecutor,
  ctx: ActorContext,
  input: { claimId: string; notes?: string },
) {
  await tx.execute(sql`SELECT id FROM delivery_claims WHERE id = ${input.claimId} FOR UPDATE`);
  const [claim] = await tx
    .select()
    .from(deliveryClaims)
    .where(eq(deliveryClaims.id, input.claimId))
    .limit(1);

  if (!claim) throw new NotFoundError("Klaim pelanggan tidak ditemukan.");
  authorize(ctx, "returns.read", { warehouseId: claim.warehouseId });

  if (claim.status !== "submitted" && claim.status !== "open") {
    throw new BusinessRuleError(
      `Hanya klaim berstatus 'submitted' atau 'open' yang dapat ditinjau. Status saat ini: '${claim.status}'.`,
    );
  }

  const [updated] = await tx
    .update(deliveryClaims)
    .set({
      status: "under_review",
      reviewedBy: ctx.user.id,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(deliveryClaims.id, claim.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "customer_claim.review",
    entityType: "delivery_claim",
    entityId: claim.id,
    warehouseId: claim.warehouseId,
    beforeData: claim,
    afterData: updated,
    reason: input.notes,
  });

  return updated!;
}

export const decideCustomerClaimSchema = z.object({
  claimId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  approvedQtyBase: z.union([z.string(), z.number()]).optional(),
  approvedClaimValue: z.union([z.string(), z.number()]).optional(),
  rejectionReason: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

/**
 * Setujui atau tolak klaim (dengan dukungan persetujuan parsial & pemisahan tugas SoD).
 * Catatan penting: Persetujuan klaim TIDAK otomatis merestock fisik dan TIDAK otomatis membuat nota kredit!
 */
export async function decideCustomerClaim(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof decideCustomerClaimSchema>,
) {
  const parsed = decideCustomerClaimSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  await tx.execute(sql`SELECT id FROM delivery_claims WHERE id = ${data.claimId} FOR UPDATE`);
  const [claim] = await tx
    .select()
    .from(deliveryClaims)
    .where(eq(deliveryClaims.id, data.claimId))
    .limit(1);

  if (!claim) throw new NotFoundError("Klaim pelanggan tidak ditemukan.");

  // Otorisasi: approvals.decide OR customer.credit_manage OR role owner
  const isOwner = ctx.roles.some((r) => r.roleCode === "owner");
  const canDecide =
    isOwner ||
    ctx.permissionScopes.has("approvals.decide") ||
    ctx.permissionScopes.has("customer.credit_manage");

  if (!canDecide) {
    throw new ForbiddenError(
      "approvals.decide",
      "Izin 'approvals.decide' atau kewenangan kredit diperlukan untuk menyetujui/menolak klaim.",
    );
  }

  // Verifikasi cakupan gudang
  if (!isOwner) {
    const scopes = ctx.permissionScopes.get("approvals.decide") ?? ctx.permissionScopes.get("customer.credit_manage");
    if (scopes && !scopes.has("*") && !scopes.has(claim.warehouseId)) {
      throw new ForbiddenError(
        "approvals.decide",
        `Akses lintas gudang ditolak untuk gudang klaim '${claim.warehouseId}'.`,
      );
    }
  }

  // Pemisahan Tugas (Separation of Duties / SoD):
  // Staf yang membuat atau mengajukan klaim tidak boleh menyetujui/menolak klaimnya sendiri (kecuali Pemilik Bisnis/Owner).
  if (!isOwner) {
    const isSelfClaim = claim.createdBy === ctx.user.id || claim.submittedBy === ctx.user.id;
    if (isSelfClaim) {
      throw new BusinessRuleError(
        "Pemisahan tugas (Separation of Duties): Staf pembuat atau pengaju klaim tidak dapat menyetujui atau menolak klaimnya sendiri.",
      );
    }
  }

  // Validasi status state machine
  const eligibleStatuses = ["under_review", "submitted", "open", "investigating"];
  if (!eligibleStatuses.includes(claim.status)) {
    throw new BusinessRuleError(
      `Klaim ${claim.claimNo} berstatus '${claim.status}' dan tidak dapat diputuskan ulang.`,
    );
  }

  if (data.decision === "rejected") {
    if (!data.rejectionReason?.trim()) {
      throw new ValidationError({ rejectionReason: ["Alasan penolakan klaim wajib diisi."] });
    }

    const [updated] = await tx
      .update(deliveryClaims)
      .set({
        status: "rejected",
        rejectionReason: data.rejectionReason.trim(),
        approvedQtyBase: "0.000",
        approvedClaimValue: "0.00",
        approvedBy: ctx.user.id,
        approvedAt: new Date(),
        qcStatus: "not_required",
        updatedAt: new Date(),
      })
      .where(eq(deliveryClaims.id, claim.id))
      .returning();

    await recordAudit(tx, {
      ctx,
      action: "customer_claim.reject",
      entityType: "delivery_claim",
      entityId: claim.id,
      warehouseId: claim.warehouseId,
      beforeData: claim,
      afterData: updated,
      reason: data.rejectionReason,
    });

    return updated!;
  }

  // Decision === "approved" (Full atau Partial)
  const discrepancyQty = parseQty(claim.discrepancyQtyBase);
  const estimatedVal = parseMoney(claim.estimatedClaimValue);

  const approvedQty = data.approvedQtyBase !== undefined
    ? roundQty(parseQty(data.approvedQtyBase))
    : discrepancyQty;

  const approvedVal = data.approvedClaimValue !== undefined
    ? roundRupiah(parseMoney(data.approvedClaimValue))
    : estimatedVal;

  if (approvedQty.lte(0)) {
    throw new BusinessRuleError("Kuantitas yang disetujui (approvedQtyBase) harus lebih besar dari 0.");
  }
  if (approvedQty.gt(discrepancyQty)) {
    throw new BusinessRuleError(
      `Kuantitas yang disetujui (${toDbQty(approvedQty)}) tidak boleh melebihi kuantitas klaim (${toDbQty(discrepancyQty)}).`,
    );
  }

  if (approvedVal.lt(0)) {
    throw new BusinessRuleError("Nominal klaim yang disetujui tidak boleh negatif.");
  }
  if (approvedVal.gt(estimatedVal) && estimatedVal.gt(0)) {
    throw new BusinessRuleError(
      `Nominal klaim yang disetujui (Rp ${toDbAmount(approvedVal)}) tidak boleh melebihi estimasi klaim (Rp ${toDbAmount(estimatedVal)}).`,
    );
  }

  const [updated] = await tx
    .update(deliveryClaims)
    .set({
      status: "approved",
      approvedQtyBase: toDbQty(approvedQty),
      approvedClaimValue: toDbAmount(approvedVal),
      approvedBy: ctx.user.id,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(deliveryClaims.id, claim.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "customer_claim.approve",
    entityType: "delivery_claim",
    entityId: claim.id,
    warehouseId: claim.warehouseId,
    beforeData: claim,
    afterData: updated,
    reason: data.notes ?? `Persetujuan klaim ${claim.claimNo} (Qty: ${toDbQty(approvedQty)}, Nilai: Rp ${toDbAmount(approvedVal)})`,
  });

  return updated!;
}

export const inspectReturnedGoodsSchema = z.object({
  claimId: z.string().min(1),
  qcOutcome: z.enum(["restock_available", "reject_dispose", "damaged_writeoff"]),
  batchId: z.string().optional().nullable(),
  locationId: z.string().optional().nullable(),
  notes: z.string().trim().min(3, "Catatan inspeksi QC wajib diisi."),
});

/**
 * Pemeriksaan QC terhadap fisik barang retur.
 * - Jika lolos ("restock_available"): merestock fisik sebesar approvedQtyBase ke "available"
 *   dan memposting jurnal pembalik HPP (Debit 1140 Persediaan / Credit 5100 HPP).
 * - Jika ditolak/rusak ("reject_dispose" / "damaged_writeoff"): barang TIDAK dimasukkan ke stok layak jual,
 *   dan tidak merusak saldo persediaan sellable.
 */
export async function inspectReturnedGoodsQc(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof inspectReturnedGoodsSchema>,
) {
  const parsed = inspectReturnedGoodsSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  await tx.execute(sql`SELECT id FROM delivery_claims WHERE id = ${data.claimId} FOR UPDATE`);
  const [claim] = await tx
    .select()
    .from(deliveryClaims)
    .where(eq(deliveryClaims.id, data.claimId))
    .limit(1);

  if (!claim) throw new NotFoundError("Klaim pelanggan tidak ditemukan.");
  authorize(ctx, "qc.inspect", { warehouseId: claim.warehouseId });

  if (claim.status !== "approved") {
    throw new BusinessRuleError(
      `Inspeksi QC retur fisik hanya dapat dilakukan untuk klaim yang berstatus 'approved'. Status saat ini: '${claim.status}'.`,
    );
  }

  if (!claim.requiresPhysicalReturn) {
    throw new BusinessRuleError(
      `Klaim ${claim.claimNo} tidak memerlukan retur fisik barang (requiresPhysicalReturn = false).`,
    );
  }

  if (claim.qcStatus !== "pending_qc") {
    throw new BusinessRuleError(
      `Pemeriksaan QC untuk klaim ini sudah selesai diproses (Status QC: '${claim.qcStatus}').`,
    );
  }

  // Cegah restock ganda
  if (claim.restockMovementId) {
    throw new BusinessRuleError("Barang retur fisik sudah pernah direstock ke buku persediaan.");
  }

  const approvedQtyDec = parseQty(claim.approvedQtyBase);
  if (approvedQtyDec.lte(0)) {
    throw new BusinessRuleError("Kuantitas yang disetujui (approvedQtyBase) adalah 0; tidak ada barang yang dapat diproses.");
  }

  // SKENARIO A: Barang Gagal QC / Rusak / Ditolak
  if (data.qcOutcome !== "restock_available") {
    const [updatedClaim] = await tx
      .update(deliveryClaims)
      .set({
        qcStatus: "qc_failed",
        qcInspectedBy: ctx.user.id,
        qcInspectedAt: new Date(),
        qcNotes: data.notes,
        updatedAt: new Date(),
      })
      .where(eq(deliveryClaims.id, claim.id))
      .returning();

    await recordAudit(tx, {
      ctx,
      action: "customer_claim.qc_inspect_failed",
      entityType: "delivery_claim",
      entityId: claim.id,
      warehouseId: claim.warehouseId,
      beforeData: claim,
      afterData: updatedClaim,
      reason: `QC Retur Gagal (${data.qcOutcome}): ${data.notes}. Stok TIDAK dimasukkan ke persediaan layak jual.`,
    });

    return {
      claim: updatedClaim!,
      restockedMovement: null,
      cogsReversalJournal: null,
    };
  }

  // SKENARIO B: Barang Lolos QC -> Restock ke "available"
  const targetBatchId = data.batchId ?? claim.batchId;
  const targetLocationId = data.locationId ?? claim.locationId;

  if (!targetBatchId) {
    throw new BusinessRuleError(
      "Batch target penerimaan retur wajib ditentukan untuk merestock barang lolos QC.",
    );
  }
  if (!targetLocationId) {
    throw new BusinessRuleError(
      "Lokasi gudang target penerimaan retur wajib ditentukan untuk merestock barang lolos QC.",
    );
  }

  const [batch] = await tx
    .select()
    .from(batches)
    .where(eq(batches.id, targetBatchId))
    .limit(1);
  if (!batch) throw new NotFoundError(`Batch '${targetBatchId}' tidak ditemukan.`);
  if (batch.warehouseId !== claim.warehouseId) {
    throw new BusinessRuleError("Batch target tidak berada pada gudang yang sama dengan klaim.");
  }

  const [location] = await tx
    .select()
    .from(warehouseLocations)
    .where(eq(warehouseLocations.id, targetLocationId))
    .limit(1);
  if (!location) throw new NotFoundError(`Lokasi gudang '${targetLocationId}' tidak ditemukan.`);
  if (location.warehouseId !== claim.warehouseId) {
    throw new BusinessRuleError("Lokasi gudang target tidak berada pada gudang yang sama.");
  }

  const unitCostDec = parseMoney(batch.unitCostBase);
  const totalInflowCost = roundRupiah(approvedQtyDec.times(unitCostDec));

  // 1. Mutasi Stok Buku Persediaan (Inflow movementType: "reversal_in", status: "available")
  const restockMovement = await applyInventoryMovement(tx, ctx, {
    warehouseId: claim.warehouseId,
    locationId: location.id,
    productId: batch.productId,
    gradeId: batch.gradeId,
    batchId: batch.id,
    movementType: "reversal_in",
    stockStatus: "available",
    qtyDeltaBase: toDbQty(approvedQtyDec),
    unitCostBase: toDbUnitPrice(unitCostDec),
    explicitInflowCost: toDbAmount(totalInflowCost),
    sourceDocType: "CLM",
    sourceDocId: claim.id,
    notes: `Penerimaan kembali retur fisik buah lolos QC atas klaim ${claim.claimNo}: ${data.notes}`,
  });

  // 2. Jurnal Pembalik HPP Seimbang di Buku Besar (GL):
  // Debit 1140 Persediaan Buah Segar (totalInflowCost)
  // Credit 5100 Beban Pokok Penjualan Buah (totalInflowCost)
  const { entry: cogsJournal } = await postJournalEntry(tx, ctx, {
    warehouseId: claim.warehouseId,
    sourceDocType: "CLM",
    sourceDocId: claim.id,
    purpose: "return_cogs_reversal",
    entryDate: businessDate(),
    memo: `Pembalikan HPP atas retur fisik buah lolos QC klaim ${claim.claimNo}`,
    lines: [
      {
        accountCode: GL_ACCOUNT_CODES.INVENTORY_FRUIT,
        debit: toDbAmount(totalInflowCost),
        description: `Pengembalian Persediaan Buah Segar Lolos QC ${claim.claimNo} (${batch.batchCode})`,
        warehouseId: claim.warehouseId,
      },
      {
        accountCode: GL_ACCOUNT_CODES.COGS_FRUIT,
        credit: toDbAmount(totalInflowCost),
        description: `Pembalikan HPP atas Retur Barang Lolos QC ${claim.claimNo}`,
        warehouseId: claim.warehouseId,
      },
    ],
    skipDirectPermissionCheck: true,
  });

  const [updatedClaim] = await tx
    .update(deliveryClaims)
    .set({
      qcStatus: "qc_passed",
      qcInspectedBy: ctx.user.id,
      qcInspectedAt: new Date(),
      qcNotes: data.notes,
      batchId: batch.id,
      locationId: location.id,
      productId: batch.productId,
      gradeId: batch.gradeId,
      restockMovementId: restockMovement.movement.id,
      cogsReversalJournalId: cogsJournal.id,
      updatedAt: new Date(),
    })
    .where(eq(deliveryClaims.id, claim.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "customer_claim.qc_inspect_passed",
    entityType: "delivery_claim",
    entityId: claim.id,
    warehouseId: claim.warehouseId,
    beforeData: claim,
    afterData: updatedClaim,
    reason: `QC Lolos (${data.qcOutcome}): Restock ${toDbQty(approvedQtyDec)} kg @ Rp ${toDbUnitPrice(unitCostDec)} = Rp ${toDbAmount(totalInflowCost)} ke batch ${batch.batchCode}. Jurnal HPP dibalik.`,
  });

  return {
    claim: updatedClaim!,
    restockedMovement: restockMovement,
    cogsReversalJournal: cogsJournal,
  };
}

export const issueCreditNoteFromClaimSchema = z.object({
  claimId: z.string().min(1),
  invoiceId: z.string().optional().nullable(),
  reason: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
});

/**
 * Terbitkan Nota Kredit dari Klaim yang telah disetujui (status approved).
 * Mencegah penerbitan ganda dan tidak mengedit jurnal faktur asli secara langsung.
 */
export async function issueCreditNoteFromClaim(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof issueCreditNoteFromClaimSchema>,
) {
  const parsed = issueCreditNoteFromClaimSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  await tx.execute(sql`SELECT id FROM delivery_claims WHERE id = ${data.claimId} FOR UPDATE`);
  const [claim] = await tx
    .select()
    .from(deliveryClaims)
    .where(eq(deliveryClaims.id, data.claimId))
    .limit(1);

  if (!claim) throw new NotFoundError("Klaim pelanggan tidak ditemukan.");
  authorize(ctx, "ar.invoice", { warehouseId: claim.warehouseId });

  if (claim.status !== "approved") {
    throw new BusinessRuleError(
      `Nota kredit hanya dapat diterbitkan untuk klaim yang berstatus 'approved'. Status saat ini: '${claim.status}'.`,
    );
  }

  if (claim.creditNoteId) {
    throw new ConflictError(
      `Nota kredit sudah pernah diterbitkan untuk klaim ${claim.claimNo} (ID: ${claim.creditNoteId}).`,
    );
  }

  const approvedClaimValue = parseMoney(claim.approvedClaimValue);
  if (approvedClaimValue.lte(0)) {
    throw new BusinessRuleError(
      `Nominal klaim yang disetujui adalah Rp 0; tidak dapat menerbitkan nota kredit.`,
    );
  }

  // Tentukan target invoice jika ada
  const targetInvoiceId = data.invoiceId ?? claim.invoiceId ?? null;

  // Tentukan produk dan grade untuk baris nota kredit
  let lineProductId = claim.productId;
  let lineGradeId = claim.gradeId;

  if (!lineProductId || !lineGradeId) {
    // Ambil produk dan grade pertama dari SO jika tidak terspesifikasi pada klaim
    const [firstSoLine] = await tx
      .select({
        productId: products.id,
        gradeId: productGrades.id,
      })
      .from(products)
      .innerJoin(productGrades, eq(productGrades.productId, products.id))
      .limit(1);

    if (firstSoLine) {
      lineProductId = firstSoLine.productId;
      lineGradeId = firstSoLine.gradeId;
    }
  }

  if (!lineProductId || !lineGradeId) {
    throw new BusinessRuleError("Produk dan grade tidak dapat ditentukan untuk baris nota kredit.");
  }

  const approvedQtyDec = parseQty(claim.approvedQtyBase);
  const effectiveQty = approvedQtyDec.gt(0) ? approvedQtyDec : parseQty("1.000");
  const unitPriceDec = roundUnitPrice(approvedClaimValue.dividedBy(effectiveQty));

  let sourceType: "sales_return" | "quality_claim" | "price_adjustment";
  if (claim.claimType === "sales_return") {
    sourceType = "sales_return";
  } else if (claim.claimType === "price_adjustment") {
    sourceType = "price_adjustment";
  } else {
    sourceType = "quality_claim";
  }

  // 1. Buat Nota Kredit Draft
  const createdCn = await createCreditNote(tx, ctx, {
    customerId: claim.customerId,
    warehouseId: claim.warehouseId,
    invoiceId: targetInvoiceId,
    deliveryClaimId: claim.id,
    sourceType,
    reason: data.reason ?? `Kompensasi klaim ${claim.claimNo}: ${claim.notes}`,
    lines: [
      {
        productId: lineProductId,
        gradeId: lineGradeId,
        uomCode: "KG",
        qty: toDbQty(effectiveQty),
        unitPrice: toDbUnitPrice(unitPriceDec),
        notes: `Kompensasi klaim ${claim.claimNo}`,
      },
    ],
  });

  // 2. Setujui Nota Kredit dan Alokasikan ke Invoice jika ada
  const approvedCn = await approveCreditNote(tx, ctx, {
    creditNoteId: createdCn.id,
    invoiceId: targetInvoiceId ?? undefined,
    reason: `Persetujuan nota kredit otomatis atas klaim ${claim.claimNo}`,
  });

  // 3. Update klaim menjadi resolved dan tautkan creditNoteId
  const [updatedClaim] = await tx
    .update(deliveryClaims)
    .set({
      creditNoteId: approvedCn.id,
      status: "resolved",
      updatedAt: new Date(),
    })
    .where(eq(deliveryClaims.id, claim.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "customer_claim.issue_credit_note",
    entityType: "delivery_claim",
    entityId: claim.id,
    warehouseId: claim.warehouseId,
    beforeData: claim,
    afterData: updatedClaim,
    reason: `Penerbitan nota kredit ${approvedCn.creditNoteNo} sebesar Rp ${toDbAmount(approvedClaimValue)}`,
  });

  return {
    claim: updatedClaim!,
    creditNote: approvedCn,
  };
}

/**
 * Pindahkan status klaim menjadi resolved atau closed.
 */
export async function resolveOrCloseClaim(
  tx: DbExecutor,
  ctx: ActorContext,
  input: {
    claimId: string;
    action: "resolve" | "close";
    notes?: string;
  },
) {
  await tx.execute(sql`SELECT id FROM delivery_claims WHERE id = ${input.claimId} FOR UPDATE`);
  const [claim] = await tx
    .select()
    .from(deliveryClaims)
    .where(eq(deliveryClaims.id, input.claimId))
    .limit(1);

  if (!claim) throw new NotFoundError("Klaim pelanggan tidak ditemukan.");
  authorize(ctx, "returns.write", { warehouseId: claim.warehouseId });

  if (input.action === "resolve") {
    if (claim.status !== "approved") {
      throw new BusinessRuleError(
        `Hanya klaim berstatus 'approved' yang dapat diselesaikan (resolved). Status saat ini: '${claim.status}'.`,
      );
    }
  } else if (input.action === "close") {
    if (claim.status !== "resolved" && claim.status !== "rejected") {
      throw new BusinessRuleError(
        `Hanya klaim berstatus 'resolved' atau 'rejected' yang dapat ditutup (closed). Status saat ini: '${claim.status}'.`,
      );
    }
  }

  const newStatus = input.action === "resolve" ? "resolved" : "closed";

  const [updated] = await tx
    .update(deliveryClaims)
    .set({
      status: newStatus,
      updatedAt: new Date(),
    })
    .where(eq(deliveryClaims.id, claim.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: `customer_claim.${input.action}`,
    entityType: "delivery_claim",
    entityId: claim.id,
    warehouseId: claim.warehouseId,
    beforeData: claim,
    afterData: updated,
    reason: input.notes,
  });

  return updated!;
}

/**
 * Dapatkan detail lengkap klaim pelanggan berdasarkan ID.
 */
export async function getClaimById(
  db: DbExecutor,
  ctx: ActorContext,
  claimId: string,
) {
  const [claim] = await db
    .select({
      id: deliveryClaims.id,
      claimNo: deliveryClaims.claimNo,
      salesOrderId: deliveryClaims.salesOrderId,
      soNumber: salesOrders.soNumber,
      customerId: deliveryClaims.customerId,
      customerName: customers.name,
      customerCode: customers.code,
      warehouseId: deliveryClaims.warehouseId,
      warehouseCode: warehouses.code,
      warehouseName: warehouses.name,
      deliveryOrderId: deliveryClaims.deliveryOrderId,
      doNumber: deliveryOrders.doNumber,
      podId: deliveryClaims.podId,
      podNumber: proofOfDeliveries.podNumber,
      invoiceId: deliveryClaims.invoiceId,
      invoiceNo: customerInvoices.invoiceNo,
      batchId: deliveryClaims.batchId,
      batchCode: batches.batchCode,
      locationId: deliveryClaims.locationId,
      locationCode: warehouseLocations.code,
      productId: deliveryClaims.productId,
      productName: products.name,
      gradeId: deliveryClaims.gradeId,
      gradeCode: productGrades.code,
      claimType: deliveryClaims.claimType,
      status: deliveryClaims.status,
      discrepancyQtyBase: deliveryClaims.discrepancyQtyBase,
      claimedQtyBase: deliveryClaims.claimedQtyBase,
      approvedQtyBase: deliveryClaims.approvedQtyBase,
      estimatedClaimValue: deliveryClaims.estimatedClaimValue,
      approvedClaimValue: deliveryClaims.approvedClaimValue,
      reasonCode: deliveryClaims.reasonCode,
      notes: deliveryClaims.notes,
      evidenceRef: deliveryClaims.evidenceRef,
      requiresPhysicalReturn: deliveryClaims.requiresPhysicalReturn,
      qcStatus: deliveryClaims.qcStatus,
      qcInspectedAt: deliveryClaims.qcInspectedAt,
      qcNotes: deliveryClaims.qcNotes,
      restockMovementId: deliveryClaims.restockMovementId,
      cogsReversalJournalId: deliveryClaims.cogsReversalJournalId,
      creditNoteId: deliveryClaims.creditNoteId,
      creditNoteNo: customerCreditNotes.creditNoteNo,
      createdAt: deliveryClaims.createdAt,
      submittedAt: deliveryClaims.submittedAt,
      reviewedAt: deliveryClaims.reviewedAt,
      approvedAt: deliveryClaims.approvedAt,
    })
    .from(deliveryClaims)
    .innerJoin(salesOrders, eq(salesOrders.id, deliveryClaims.salesOrderId))
    .innerJoin(customers, eq(customers.id, deliveryClaims.customerId))
    .innerJoin(warehouses, eq(warehouses.id, deliveryClaims.warehouseId))
    .leftJoin(deliveryOrders, eq(deliveryOrders.id, deliveryClaims.deliveryOrderId))
    .leftJoin(proofOfDeliveries, eq(proofOfDeliveries.id, deliveryClaims.podId))
    .leftJoin(customerInvoices, eq(customerInvoices.id, deliveryClaims.invoiceId))
    .leftJoin(batches, eq(batches.id, deliveryClaims.batchId))
    .leftJoin(warehouseLocations, eq(warehouseLocations.id, deliveryClaims.locationId))
    .leftJoin(products, eq(products.id, deliveryClaims.productId))
    .leftJoin(productGrades, eq(productGrades.id, deliveryClaims.gradeId))
    .leftJoin(customerCreditNotes, eq(customerCreditNotes.id, deliveryClaims.creditNoteId))
    .where(eq(deliveryClaims.id, claimId))
    .limit(1);

  if (!claim) return null;
  authorize(ctx, "returns.read", { warehouseId: claim.warehouseId });

  return claim;
}

/**
 * Daftar seluruh klaim pelanggan dengan filter dan RBAC.
 */
export async function listCustomerClaims(
  db: DbExecutor,
  ctx: ActorContext,
  filters: {
    customerId?: string;
    warehouseId?: string;
    status?: string;
    claimType?: string;
    limit?: number;
  } = {},
) {
  authorize(ctx, "returns.read", filters.warehouseId ? { warehouseId: filters.warehouseId } : undefined);

  const conditions = [];
  if (filters.customerId) conditions.push(eq(deliveryClaims.customerId, filters.customerId));
  if (filters.warehouseId) conditions.push(eq(deliveryClaims.warehouseId, filters.warehouseId));
  if (filters.status) {
    conditions.push(
      eq(
        deliveryClaims.status,
        filters.status as
          | "draft"
          | "submitted"
          | "open"
          | "under_review"
          | "investigating"
          | "approved"
          | "rejected"
          | "resolved"
          | "closed"
          | "cancelled",
      ),
    );
  }
  if (filters.claimType) {
    conditions.push(
      eq(
        deliveryClaims.claimType,
        filters.claimType as
          | "shortage"
          | "damaged_in_transit"
          | "refused_by_customer"
          | "failed_delivery"
          | "mixed_discrepancy"
          | "quality_claim"
          | "sales_return"
          | "price_adjustment",
      ),
    );
  }

  return db
    .select({
      id: deliveryClaims.id,
      claimNo: deliveryClaims.claimNo,
      salesOrderId: deliveryClaims.salesOrderId,
      soNumber: salesOrders.soNumber,
      customerId: deliveryClaims.customerId,
      customerName: customers.name,
      customerCode: customers.code,
      warehouseId: deliveryClaims.warehouseId,
      warehouseCode: warehouses.code,
      deliveryOrderId: deliveryClaims.deliveryOrderId,
      doNumber: deliveryOrders.doNumber,
      podId: deliveryClaims.podId,
      podNumber: proofOfDeliveries.podNumber,
      invoiceId: deliveryClaims.invoiceId,
      invoiceNo: customerInvoices.invoiceNo,
      claimType: deliveryClaims.claimType,
      status: deliveryClaims.status,
      discrepancyQtyBase: deliveryClaims.discrepancyQtyBase,
      claimedQtyBase: deliveryClaims.claimedQtyBase,
      approvedQtyBase: deliveryClaims.approvedQtyBase,
      estimatedClaimValue: deliveryClaims.estimatedClaimValue,
      approvedClaimValue: deliveryClaims.approvedClaimValue,
      reasonCode: deliveryClaims.reasonCode,
      notes: deliveryClaims.notes,
      requiresPhysicalReturn: deliveryClaims.requiresPhysicalReturn,
      qcStatus: deliveryClaims.qcStatus,
      creditNoteId: deliveryClaims.creditNoteId,
      creditNoteNo: customerCreditNotes.creditNoteNo,
      createdAt: deliveryClaims.createdAt,
    })
    .from(deliveryClaims)
    .innerJoin(salesOrders, eq(salesOrders.id, deliveryClaims.salesOrderId))
    .innerJoin(customers, eq(customers.id, deliveryClaims.customerId))
    .innerJoin(warehouses, eq(warehouses.id, deliveryClaims.warehouseId))
    .leftJoin(deliveryOrders, eq(deliveryOrders.id, deliveryClaims.deliveryOrderId))
    .leftJoin(proofOfDeliveries, eq(proofOfDeliveries.id, deliveryClaims.podId))
    .leftJoin(customerInvoices, eq(customerInvoices.id, deliveryClaims.invoiceId))
    .leftJoin(customerCreditNotes, eq(customerCreditNotes.id, deliveryClaims.creditNoteId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(deliveryClaims.createdAt))
    .limit(filters.limit ?? 100);
}
