import crypto from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { businessDate } from "@/lib/datetime";
import {
  MoneyDecimal,
  parseMoney,
  roundRupiah,
  roundUnitPrice,
  toDbAmount,
  toDbUnitPrice,
} from "@/lib/money";
import { parseQty, roundQty, toBaseQty, toDbQty } from "@/lib/quantity";
import { recordAudit } from "@/server/audit";
import { authorize, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import {
  products,
  productUomConversions,
  purchaseOrderLines,
  purchaseOrderRevisions,
  purchaseOrders,
  suppliers,
  warehouses,
} from "@/server/db/schema";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/server/errors";
import { nextDocumentNumber } from "@/server/sequences";

export interface CreatePurchaseOrderLineInput {
  productId: string;
  expectedGradeCode?: string;
  orderedUomCode?: string;
  orderedQty: string | number;
  unitPriceBase: string | number;
  notes?: string;
}

export interface CreatePurchaseOrderInput {
  supplierId: string;
  warehouseId: string;
  orderDate?: string;
  expectedDeliveryAt?: Date;
  originRegion?: string;
  paymentTermsDays?: number;
  qtyTolerancePct?: string | number;
  priceVarianceTolerancePct?: string | number;
  notes?: string;
  lines: CreatePurchaseOrderLineInput[];
}

async function resolveLineOrderedQtyBase(
  tx: DbExecutor,
  productId: string,
  orderedUomCode: string | undefined,
  orderedQtyRaw: string | number,
) {
  const [product] = await tx
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!product || !product.isActive) {
    throw new NotFoundError(`Produk ${productId} tidak ditemukan atau tidak aktif.`);
  }

  const orderedQty = roundQty(parseQty(orderedQtyRaw));
  if (orderedQty.lte(0)) {
    throw new BusinessRuleError(`Kuantitas pesanan untuk ${product.name} harus lebih besar dari 0.`);
  }

  const uomCode = (orderedUomCode ?? product.baseUomCode).trim().toLowerCase();
  if (uomCode === product.baseUomCode) {
    return {
      product,
      uomCode,
      orderedQty,
      orderedQtyBase: orderedQty,
    };
  }

  const [conv] = await tx
    .select()
    .from(productUomConversions)
    .where(
      and(
        eq(productUomConversions.productId, productId),
        eq(productUomConversions.uomCode, uomCode),
      ),
    )
    .limit(1);

  if (!conv) {
    throw new BusinessRuleError(
      `Konversi satuan '${uomCode}' belum terdaftar untuk produk ${product.name} (satuan dasar: ${product.baseUomCode}).`,
    );
  }

  const orderedQtyBase = toBaseQty(orderedQty, conv, "estimate");
  return {
    product,
    uomCode,
    orderedQty,
    orderedQtyBase,
  };
}

export async function createPurchaseOrder(
  tx: DbExecutor,
  ctx: ActorContext,
  input: CreatePurchaseOrderInput,
) {
  authorize(ctx, "procurement.write", { warehouseId: input.warehouseId });

  if (!input.lines || input.lines.length === 0) {
    throw new BusinessRuleError("Purchase Order wajib memiliki minimal 1 baris produk.");
  }

  const [supplier] = await tx
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, input.supplierId))
    .limit(1);
  if (!supplier || !supplier.isActive) {
    throw new NotFoundError("Supplier tidak ditemukan atau tidak aktif.");
  }

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, input.warehouseId))
    .limit(1);
  if (!wh || !wh.isActive) {
    throw new NotFoundError("Gudang tujuan tidak ditemukan atau tidak aktif.");
  }

  const poId = `po_${crypto.randomUUID()}`;
  const poNumber = await nextDocumentNumber(tx, {
    docType: "PO",
    warehouseCode: wh.code,
  });

  let subtotal = new MoneyDecimal(0);
  let taxTotal = new MoneyDecimal(0);

  const preparedLines = [];
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i]!;
    const resolved = await resolveLineOrderedQtyBase(
      tx,
      l.productId,
      l.orderedUomCode,
      l.orderedQty,
    );

    const unitPrice = roundUnitPrice(parseMoney(l.unitPriceBase));
    if (unitPrice.lt(0)) {
      throw new BusinessRuleError(
        `Harga beli per ${resolved.product.baseUomCode} untuk ${resolved.product.name} tidak boleh negatif.`,
      );
    }

    const lineSub = roundRupiah(resolved.orderedQtyBase.mul(unitPrice));
    subtotal = subtotal.plus(lineSub);
    if (resolved.product.taxCode === "PPN_11") {
      taxTotal = taxTotal.plus(roundRupiah(lineSub.mul("0.11")));
    }

    preparedLines.push({
      id: `pol_${crypto.randomUUID()}`,
      purchaseOrderId: poId,
      lineNo: i + 1,
      productId: resolved.product.id,
      expectedGradeCode: (l.expectedGradeCode ?? "A").toUpperCase(),
      orderedUomCode: resolved.uomCode,
      orderedQty: toDbQty(resolved.orderedQty),
      orderedQtyBase: toDbQty(resolved.orderedQtyBase),
      receivedNetQtyBase: "0.000",
      acceptedQtyBase: "0.000",
      rejectedQtyBase: "0.000",
      unitPriceBase: toDbUnitPrice(unitPrice),
      lineSubtotal: toDbAmount(lineSub),
      notes: l.notes ?? null,
    });
  }

  const totalAmount = roundRupiah(subtotal.plus(taxTotal));
  const qtyTol = new MoneyDecimal((input.qtyTolerancePct ?? "5.00").toString());
  const priceTol = new MoneyDecimal((input.priceVarianceTolerancePct ?? "0.00").toString());

  if (qtyTol.lt(0) || priceTol.lt(0)) {
    throw new BusinessRuleError("Persentase toleransi PO tidak boleh negatif.");
  }

  const [createdHeader] = await tx
    .insert(purchaseOrders)
    .values({
      id: poId,
      poNumber,
      supplierId: supplier.id,
      warehouseId: wh.id,
      status: "draft",
      orderDate: input.orderDate ?? businessDate(),
      expectedDeliveryAt: input.expectedDeliveryAt ?? null,
      originRegion: input.originRegion?.trim() || supplier.originRegion,
      paymentTermsDays: input.paymentTermsDays ?? supplier.paymentTermsDays,
      currency: "IDR",
      subtotalAmount: toDbAmount(subtotal),
      taxAmount: toDbAmount(taxTotal),
      totalAmount: toDbAmount(totalAmount),
      qtyTolerancePct: qtyTol.toFixed(2),
      priceVarianceTolerancePct: priceTol.toFixed(2),
      notes: input.notes ?? null,
      revisionNo: 0,
      createdBy: ctx.user.id,
    })
    .returning();

  const createdLines = await tx
    .insert(purchaseOrderLines)
    .values(preparedLines)
    .returning();

  // Save initial immutable revision snapshot (revisionNo = 0)
  await tx.insert(purchaseOrderRevisions).values({
    id: `porev_${crypto.randomUUID()}`,
    purchaseOrderId: poId,
    revisionNo: 0,
    snapshot: {
      header: createdHeader,
      lines: createdLines,
    },
    reason: "Pembuatan Purchase Order (PO) awal",
    revisedBy: ctx.user.id,
  });

  await recordAudit(tx, {
    ctx,
    action: "procurement.po_create",
    entityType: "purchase_order",
    entityId: poId,
    warehouseId: wh.id,
    afterData: { header: createdHeader, lines: createdLines },
  });

  return { header: createdHeader!, lines: createdLines };
}

export async function submitPurchaseOrder(
  tx: DbExecutor,
  ctx: ActorContext,
  input: { purchaseOrderId: string; expectedVersion?: number },
) {
  const [po] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, input.purchaseOrderId))
    .limit(1);
  if (!po) throw new NotFoundError("Purchase Order tidak ditemukan.");

  authorize(ctx, "procurement.write", { warehouseId: po.warehouseId });

  if (po.status !== "draft") {
    throw new BusinessRuleError(
      `Hanya PO berstatus 'draft' yang dapat diajukan (status saat ini: '${po.status}').`,
    );
  }
  if (input.expectedVersion !== undefined && po.version !== input.expectedVersion) {
    throw new ConflictError("Purchase Order telah diubah oleh pengguna lain.");
  }

  const [updated] = await tx
    .update(purchaseOrders)
    .set({
      status: "submitted",
      submittedBy: ctx.user.id,
      submittedAt: new Date(),
      version: po.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.version, po.version)))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "procurement.po_submit",
    entityType: "purchase_order",
    entityId: po.id,
    warehouseId: po.warehouseId,
    beforeData: po,
    afterData: updated,
  });

  return updated!;
}

export async function approvePurchaseOrder(
  tx: DbExecutor,
  ctx: ActorContext,
  input: { purchaseOrderId: string; expectedVersion?: number },
) {
  const [po] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, input.purchaseOrderId))
    .limit(1);
  if (!po) throw new NotFoundError("Purchase Order tidak ditemukan.");

  authorize(ctx, "procurement.approve", { warehouseId: po.warehouseId });

  if (po.status !== "submitted" && po.status !== "draft") {
    throw new BusinessRuleError(
      `PO berstatus '${po.status}' tidak dapat disetujui (harus 'draft' atau 'submitted').`,
    );
  }
  if (input.expectedVersion !== undefined && po.version !== input.expectedVersion) {
    throw new ConflictError("Purchase Order telah diubah oleh pengguna lain.");
  }

  const [updated] = await tx
    .update(purchaseOrders)
    .set({
      status: "approved",
      approvedBy: ctx.user.id,
      approvedAt: new Date(),
      version: po.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.version, po.version)))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "procurement.po_approve",
    entityType: "purchase_order",
    entityId: po.id,
    warehouseId: po.warehouseId,
    beforeData: po,
    afterData: updated,
  });

  return updated!;
}

export interface RevisePurchaseOrderInput {
  purchaseOrderId: string;
  reason: string;
  expectedVersion?: number;
  qtyTolerancePct?: string | number;
  notes?: string;
  lines: Array<{
    id?: string;
    productId: string;
    expectedGradeCode?: string;
    orderedUomCode?: string;
    orderedQty: string | number;
    unitPriceBase: string | number;
    notes?: string;
  }>;
}

/**
 * Revises a Purchase Order while preserving the full revision history in `purchase_order_revisions`.
 * Cannot reduce ordered quantity below what has already been received.
 */
export async function revisePurchaseOrder(
  tx: DbExecutor,
  ctx: ActorContext,
  input: RevisePurchaseOrderInput,
) {
  if (!input.reason?.trim()) {
    throw new BusinessRuleError("Alasan revisi Purchase Order wajib diisi.");
  }
  if (!input.lines || input.lines.length === 0) {
    throw new BusinessRuleError("Revisi PO wajib memiliki minimal 1 baris produk.");
  }

  const [po] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, input.purchaseOrderId))
    .limit(1);
  if (!po) throw new NotFoundError("Purchase Order tidak ditemukan.");

  authorize(ctx, "procurement.write", { warehouseId: po.warehouseId });

  if (po.status === "received" || po.status === "closed" || po.status === "cancelled") {
    throw new BusinessRuleError(
      `PO berstatus '${po.status}' sudah selesai/dibatalkan dan tidak dapat direvisi.`,
    );
  }
  if (input.expectedVersion !== undefined && po.version !== input.expectedVersion) {
    throw new ConflictError("Purchase Order telah diubah oleh pengguna lain.");
  }

  const existingLines = await tx
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
    .orderBy(asc(purchaseOrderLines.lineNo));

  const existingById = new Map(existingLines.map((l) => [l.id, l]));

  let subtotal = new MoneyDecimal(0);
  let taxTotal = new MoneyDecimal(0);
  const updatedLines = [];

  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i]!;
    const resolved = await resolveLineOrderedQtyBase(
      tx,
      l.productId,
      l.orderedUomCode,
      l.orderedQty,
    );
    const unitPrice = roundUnitPrice(parseMoney(l.unitPriceBase));
    if (unitPrice.lt(0)) {
      throw new BusinessRuleError("Harga beli tidak boleh negatif.");
    }

    const prev = l.id ? existingById.get(l.id) : existingLines.find((e) => e.productId === l.productId);
    const prevReceivedNet = prev ? roundQty(parseQty(prev.receivedNetQtyBase)) : new MoneyDecimal(0);

    if (resolved.orderedQtyBase.lt(prevReceivedNet)) {
      throw new BusinessRuleError(
        `Kuantitas revisi (${toDbQty(resolved.orderedQtyBase)}) untuk ${resolved.product.name} tidak boleh lebih kecil dari kuantitas yang sudah diterima (${toDbQty(prevReceivedNet)}).`,
      );
    }

    const lineSub = roundRupiah(resolved.orderedQtyBase.mul(unitPrice));
    subtotal = subtotal.plus(lineSub);
    if (resolved.product.taxCode === "PPN_11") {
      taxTotal = taxTotal.plus(roundRupiah(lineSub.mul("0.11")));
    }

    if (prev) {
      const [upd] = await tx
        .update(purchaseOrderLines)
        .set({
          lineNo: i + 1,
          expectedGradeCode: (l.expectedGradeCode ?? prev.expectedGradeCode).toUpperCase(),
          orderedUomCode: resolved.uomCode,
          orderedQty: toDbQty(resolved.orderedQty),
          orderedQtyBase: toDbQty(resolved.orderedQtyBase),
          unitPriceBase: toDbUnitPrice(unitPrice),
          lineSubtotal: toDbAmount(lineSub),
          notes: l.notes ?? prev.notes,
        })
        .where(eq(purchaseOrderLines.id, prev.id))
        .returning();
      updatedLines.push(upd!);
    } else {
      const [created] = await tx
        .insert(purchaseOrderLines)
        .values({
          id: `pol_${crypto.randomUUID()}`,
          purchaseOrderId: po.id,
          lineNo: i + 1,
          productId: resolved.product.id,
          expectedGradeCode: (l.expectedGradeCode ?? "A").toUpperCase(),
          orderedUomCode: resolved.uomCode,
          orderedQty: toDbQty(resolved.orderedQty),
          orderedQtyBase: toDbQty(resolved.orderedQtyBase),
          receivedNetQtyBase: "0.000",
          acceptedQtyBase: "0.000",
          rejectedQtyBase: "0.000",
          unitPriceBase: toDbUnitPrice(unitPrice),
          lineSubtotal: toDbAmount(lineSub),
          notes: l.notes ?? null,
        })
        .returning();
      updatedLines.push(created!);
    }
  }

  const totalAmount = roundRupiah(subtotal.plus(taxTotal));
  const newRevisionNo = po.revisionNo + 1;

  const [updatedHeader] = await tx
    .update(purchaseOrders)
    .set({
      subtotalAmount: toDbAmount(subtotal),
      taxAmount: toDbAmount(taxTotal),
      totalAmount: toDbAmount(totalAmount),
      qtyTolerancePct:
        input.qtyTolerancePct !== undefined
          ? new MoneyDecimal(input.qtyTolerancePct.toString()).toFixed(2)
          : po.qtyTolerancePct,
      notes: input.notes ?? po.notes,
      revisionNo: newRevisionNo,
      version: po.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.version, po.version)))
    .returning();

  const [revision] = await tx
    .insert(purchaseOrderRevisions)
    .values({
      id: `porev_${crypto.randomUUID()}`,
      purchaseOrderId: po.id,
      revisionNo: newRevisionNo,
      snapshot: {
        header: updatedHeader,
        lines: updatedLines,
      },
      reason: input.reason.trim(),
      revisedBy: ctx.user.id,
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "procurement.po_revise",
    entityType: "purchase_order",
    entityId: po.id,
    warehouseId: po.warehouseId,
    beforeData: { header: po, lines: existingLines },
    afterData: { header: updatedHeader, lines: updatedLines, revision },
    reason: input.reason.trim(),
  });

  return { header: updatedHeader!, lines: updatedLines, revision: revision! };
}

export async function cancelPurchaseOrder(
  tx: DbExecutor,
  ctx: ActorContext,
  input: { purchaseOrderId: string; reason: string; expectedVersion?: number },
) {
  if (!input.reason?.trim()) {
    throw new BusinessRuleError("Alasan pembatalan Purchase Order wajib diisi.");
  }

  const [po] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, input.purchaseOrderId))
    .limit(1);
  if (!po) throw new NotFoundError("Purchase Order tidak ditemukan.");

  authorize(ctx, "procurement.write", { warehouseId: po.warehouseId });

  if (po.status !== "draft" && po.status !== "submitted" && po.status !== "approved") {
    throw new BusinessRuleError(
      `PO berstatus '${po.status}' tidak dapat dibatalkan karena sudah memiliki penerimaan barang atau sudah selesai.`,
    );
  }
  if (input.expectedVersion !== undefined && po.version !== input.expectedVersion) {
    throw new ConflictError("Purchase Order telah diubah oleh pengguna lain.");
  }

  const lines = await tx
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id));

  for (const l of lines) {
    if (parseQty(l.receivedNetQtyBase).gt(0)) {
      throw new BusinessRuleError(
        "PO yang sudah memiliki penerimaan barang sebagian tidak dapat dibatalkan.",
      );
    }
  }

  const [updated] = await tx
    .update(purchaseOrders)
    .set({
      status: "cancelled",
      cancelledBy: ctx.user.id,
      cancelledAt: new Date(),
      cancelReason: input.reason.trim(),
      version: po.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.version, po.version)))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "procurement.po_cancel",
    entityType: "purchase_order",
    entityId: po.id,
    warehouseId: po.warehouseId,
    beforeData: po,
    afterData: updated,
    reason: input.reason.trim(),
  });

  return updated!;
}

export async function getPurchaseOrderWithDetails(
  db: DbExecutor,
  ctx: ActorContext,
  purchaseOrderId: string,
) {
  const [po] = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, purchaseOrderId))
    .limit(1);
  if (!po) throw new NotFoundError("Purchase Order tidak ditemukan.");

  authorize(ctx, "procurement.read", { warehouseId: po.warehouseId });

  const lines = await db
    .select({
      line: purchaseOrderLines,
      product: products,
    })
    .from(purchaseOrderLines)
    .innerJoin(products, eq(products.id, purchaseOrderLines.productId))
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
    .orderBy(asc(purchaseOrderLines.lineNo));

  const revisions = await db
    .select()
    .from(purchaseOrderRevisions)
    .where(eq(purchaseOrderRevisions.purchaseOrderId, po.id))
    .orderBy(asc(purchaseOrderRevisions.revisionNo));

  return { header: po, lines, revisions };
}

export async function listPurchaseOrders(
  db: DbExecutor,
  ctx: ActorContext,
  options?: { warehouseId?: string },
) {
  authorize(ctx, "procurement.read", { warehouseId: options?.warehouseId });
  return db
    .select({
      po: purchaseOrders,
      supplier: suppliers,
      warehouse: warehouses,
    })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .innerJoin(warehouses, eq(warehouses.id, purchaseOrders.warehouseId))
    .where(options?.warehouseId ? eq(purchaseOrders.warehouseId, options.warehouseId) : undefined)
    .orderBy(desc(purchaseOrders.createdAt))
    .limit(50);
}
