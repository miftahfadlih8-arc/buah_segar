import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { businessDate, businessDateOffsetDays } from "@/lib/datetime";
import {
  MoneyDecimal,
  parseMoney,
  roundRupiah,
  toDbAmount,
  toDbUnitPrice,
  type Money,
} from "@/lib/money";
import { parseQty, toDbQty } from "@/lib/quantity";
import { recordAudit } from "@/server/audit";
import { authorize, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import {
  bankAccounts,
  bankTransactions,
  customerCreditNoteLines,
  customerCreditNotes,
  customerInvoiceLines,
  customerInvoices,
  customerPayments,
  customers,
  deliveryOrderLines,
  deliveryOrders,
  glAccounts,
  journalEntries,
  journalLines,
  paymentAllocations,
  productGrades,
  products,
  salesOrderLines,
  salesOrders,
  warehouses,
} from "@/server/db/schema";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/server/errors";
import {
  GL_ACCOUNT_CODES,
  postJournalEntry,
  reverseJournalEntry,
  seedDefaultCoaAndFiscalPeriod,
  type JournalLineInput,
} from "@/server/modules/gl";
import { nextDocumentNumber } from "@/server/sequences";
import {
  calculateCustomerCreditExposure,
  CREDIT_EXPOSURE_FORMULA,
  lockCustomerForCreditCheck,
} from "./credit";

export {
  calculateCustomerCreditExposure,
  CREDIT_EXPOSURE_FORMULA,
  lockCustomerForCreditCheck,
};

// ---------------------------------------------------------------------------
// 1. INVOICE CREATION, POSTING, VOIDING & QUERYING
// ---------------------------------------------------------------------------

export const createSalesInvoiceLineSchema = z.object({
  salesOrderLineId: z.string().optional().nullable(),
  deliveryOrderLineId: z.string().optional().nullable(),
  productId: z.string().min(1),
  gradeId: z.string().min(1),
  uomCode: z.string().min(1),
  invoicedQty: z.union([z.string(), z.number()]),
  invoicedQtyBase: z.union([z.string(), z.number()]).optional(),
  unitPrice: z.union([z.string(), z.number()]),
  discountAmount: z.union([z.string(), z.number()]).optional().default(0),
  taxRatePct: z.union([z.string(), z.number()]).optional().default(0),
  notes: z.string().optional().nullable(),
});

export const createSalesInvoiceSchema = z.object({
  customerId: z.string().min(1),
  warehouseId: z.string().min(1),
  salesOrderId: z.string().optional().nullable(),
  deliveryOrderId: z.string().optional().nullable(),
  invoiceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  status: z.enum(["draft", "posted"]).default("posted"),
  notes: z.string().optional().nullable(),
  lines: z.array(createSalesInvoiceLineSchema).min(1, "Invoice wajib memiliki minimal 1 baris item."),
});

export async function createSalesInvoice(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createSalesInvoiceSchema>,
) {
  authorize(ctx, "ar.invoice", { warehouseId: rawInput.warehouseId });
  const parsed = createSalesInvoiceSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  // Verify warehouse exists
  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, data.warehouseId))
    .limit(1);
  if (!wh) {
    throw new NotFoundError("Gudang tidak ditemukan.");
  }

  // Lock customer record for consistency
  const cust = await lockCustomerForCreditCheck(tx, data.customerId);

  // Validate Delivery Order reference if provided
  let doRecord: typeof deliveryOrders.$inferSelect | null = null;
  if (data.deliveryOrderId) {
    const [d] = await tx
      .select()
      .from(deliveryOrders)
      .where(eq(deliveryOrders.id, data.deliveryOrderId))
      .limit(1);
    if (!d) {
      throw new NotFoundError("Surat Jalan (Delivery Order) tidak ditemukan.");
    }
    if (d.customerId !== data.customerId) {
      throw new BusinessRuleError("Surat Jalan tidak sesuai dengan pelanggan invoice.");
    }
    if (d.warehouseId !== data.warehouseId) {
      throw new BusinessRuleError("Surat Jalan tidak sesuai dengan gudang invoice.");
    }
    if (d.status !== "delivered") {
      throw new BusinessRuleError(
        `Surat Jalan ${d.doNumber} berstatus '${d.status}'. Faktur hanya dapat dibuat dari Surat Jalan yang sudah terkirim ('delivered').`,
      );
    }
    doRecord = d;
  }

  // Validate Sales Order reference if provided
  let soRecord: typeof salesOrders.$inferSelect | null = null;
  const soIdToUse = data.salesOrderId ?? doRecord?.salesOrderId ?? null;
  if (soIdToUse) {
    const [so] = await tx
      .select()
      .from(salesOrders)
      .where(eq(salesOrders.id, soIdToUse))
      .limit(1);
    if (!so) {
      throw new NotFoundError("Sales order tidak ditemukan.");
    }
    if (so.customerId !== data.customerId) {
      throw new BusinessRuleError("Sales order tidak sesuai dengan pelanggan invoice.");
    }
    if (so.status === "draft" || so.status === "cancelled") {
      throw new BusinessRuleError(
        `Sales order ${so.soNumber} berstatus '${so.status}' dan tidak memenuhi syarat untuk ditagihkan.`,
      );
    }
    soRecord = so;
  }

  // Check previous invoices to prevent double-invoicing on lines
  const existingActiveLines = await tx
    .select({
      salesOrderLineId: customerInvoiceLines.salesOrderLineId,
      deliveryOrderLineId: customerInvoiceLines.deliveryOrderLineId,
      invoicedQtyBase: customerInvoiceLines.invoicedQtyBase,
    })
    .from(customerInvoiceLines)
    .innerJoin(customerInvoices, eq(customerInvoices.id, customerInvoiceLines.invoiceId))
    .where(
      and(
        ne(customerInvoices.status, "cancelled"),
        soRecord ? eq(customerInvoices.salesOrderId, soRecord.id) : undefined,
      ),
    );

  const billedByDoLine: Record<string, Money> = {};
  const billedBySoLine: Record<string, Money> = {};
  for (const l of existingActiveLines) {
    if (l.deliveryOrderLineId) {
      billedByDoLine[l.deliveryOrderLineId] = (
        billedByDoLine[l.deliveryOrderLineId] ?? new MoneyDecimal(0)
      ).plus(new MoneyDecimal(l.invoicedQtyBase));
    }
    if (l.salesOrderLineId) {
      billedBySoLine[l.salesOrderLineId] = (
        billedBySoLine[l.salesOrderLineId] ?? new MoneyDecimal(0)
      ).plus(new MoneyDecimal(l.invoicedQtyBase));
    }
  }

  // Calculate lines with server validation & snapshots
  let subtotalAccum = new MoneyDecimal(0);
  let discountAccum = new MoneyDecimal(0);
  let taxAccum = new MoneyDecimal(0);

  const preparedLines = [];
  let lineNo = 1;

  for (const lineInput of data.lines) {
    const [prod] = await tx
      .select()
      .from(products)
      .where(eq(products.id, lineInput.productId))
      .limit(1);
    if (!prod) {
      throw new NotFoundError(`Produk id '${lineInput.productId}' tidak ditemukan.`);
    }

    const [grd] = await tx
      .select()
      .from(productGrades)
      .where(eq(productGrades.id, lineInput.gradeId))
      .limit(1);
    if (!grd) {
      throw new NotFoundError(`Grade id '${lineInput.gradeId}' tidak ditemukan.`);
    }

    const qtyDec = parseQty(lineInput.invoicedQty);
    if (qtyDec.lte(0)) {
      throw new BusinessRuleError(`Kuantitas baris ke-${lineNo} harus lebih besar dari 0.`);
    }

    const qtyBaseDec = lineInput.invoicedQtyBase
      ? parseQty(lineInput.invoicedQtyBase)
      : qtyDec;

    // Check delivery line limits
    if (lineInput.deliveryOrderLineId) {
      const [doLine] = await tx
        .select()
        .from(deliveryOrderLines)
        .where(eq(deliveryOrderLines.id, lineInput.deliveryOrderLineId))
        .limit(1);
      if (!doLine) {
        throw new NotFoundError(`Baris Surat Jalan id '${lineInput.deliveryOrderLineId}' tidak ditemukan.`);
      }
      const deliveredBase = parseQty(doLine.deliveredQtyBase);
      const alreadyBilled = billedByDoLine[lineInput.deliveryOrderLineId] ?? new MoneyDecimal(0);
      const remainingUnbilled = deliveredBase.minus(alreadyBilled);

      if (remainingUnbilled.lte(0)) {
        throw new BusinessRuleError(
          `Baris Surat Jalan untuk produk '${prod.name}' sudah sepenuhnya ditagihkan sebelumnya.`,
        );
      }
      if (qtyBaseDec.gt(remainingUnbilled)) {
        throw new BusinessRuleError(
          `Kuantitas ditagih (${qtyBaseDec.toFixed(3)} kg) melebihi sisa yang belum ditagihkan (${remainingUnbilled.toFixed(3)} kg) pada Surat Jalan.`,
        );
      }
      billedByDoLine[lineInput.deliveryOrderLineId] = alreadyBilled.plus(qtyBaseDec);
    }

    // Check SO line limits
    if (lineInput.salesOrderLineId) {
      const [soLine] = await tx
        .select()
        .from(salesOrderLines)
        .where(eq(salesOrderLines.id, lineInput.salesOrderLineId))
        .limit(1);
      if (!soLine) {
        throw new NotFoundError(`Baris Sales Order id '${lineInput.salesOrderLineId}' tidak ditemukan.`);
      }
      const orderedBase = parseQty(soLine.orderedQtyBase);
      const alreadyBilled = billedBySoLine[lineInput.salesOrderLineId] ?? new MoneyDecimal(0);
      const remainingUnbilled = orderedBase.minus(alreadyBilled);

      if (remainingUnbilled.lte(0)) {
        throw new BusinessRuleError(
          `Baris Sales Order untuk produk '${prod.name}' sudah sepenuhnya ditagihkan sebelumnya.`,
        );
      }
      if (qtyBaseDec.gt(remainingUnbilled)) {
        throw new BusinessRuleError(
          `Kuantitas ditagih (${qtyBaseDec.toFixed(3)} kg) melebihi sisa yang belum ditagihkan (${remainingUnbilled.toFixed(3)} kg) pada Sales Order.`,
        );
      }
      billedBySoLine[lineInput.salesOrderLineId] = alreadyBilled.plus(qtyBaseDec);
    }

    const unitPriceDec = parseMoney(lineInput.unitPrice);
    if (unitPriceDec.lt(0)) {
      throw new BusinessRuleError(`Harga satuan baris ke-${lineNo} tidak boleh negatif.`);
    }

    const discountDec = roundRupiah(parseMoney(lineInput.discountAmount ?? 0));
    const grossDec = roundRupiah(qtyDec.times(unitPriceDec));
    const netDec = roundRupiah(MoneyDecimal.max(new MoneyDecimal(0), grossDec.minus(discountDec)));

    const taxRatePctDec = new MoneyDecimal(lineInput.taxRatePct ?? 0);
    const taxDec = taxRatePctDec.gt(0)
      ? roundRupiah(netDec.times(taxRatePctDec).dividedBy(100))
      : new MoneyDecimal(0);

    const totalDec = roundRupiah(netDec.plus(taxDec));

    subtotalAccum = subtotalAccum.plus(netDec);
    discountAccum = discountAccum.plus(discountDec);
    taxAccum = taxAccum.plus(taxDec);

    preparedLines.push({
      lineNo,
      salesOrderLineId: lineInput.salesOrderLineId ?? null,
      deliveryOrderLineId: lineInput.deliveryOrderLineId ?? null,
      productId: prod.id,
      productNameSnapshot: prod.name,
      gradeId: grd.id,
      gradeCodeSnapshot: grd.code,
      uomCode: lineInput.uomCode,
      invoicedQty: toDbQty(qtyDec),
      invoicedQtyBase: toDbQty(qtyBaseDec),
      unitPrice: toDbUnitPrice(unitPriceDec),
      discountAmount: toDbAmount(discountDec),
      taxRatePct: taxRatePctDec.toFixed(2),
      taxAmount: toDbAmount(taxDec),
      lineNetAmount: toDbAmount(netDec),
      lineTotalAmount: toDbAmount(totalDec),
      notes: lineInput.notes ?? null,
    });
    lineNo++;
  }

  const grandTotal = roundRupiah(subtotalAccum.plus(taxAccum));
  const invDate = data.invoiceDate ?? businessDate();
  const dueDate = data.dueDate ?? businessDateOffsetDays(cust.paymentTermsDays || 0, new Date(invDate));

  const isPosting = data.status === "posted";

  // Document number
  const invoiceNo = await nextDocumentNumber(tx, {
    docType: "INV",
    warehouseCode: wh.code,
  });

  const invoiceId = `cinv_${crypto.randomUUID().slice(0, 8)}`;

  const [createdInvoice] = await tx
    .insert(customerInvoices)
    .values({
      id: invoiceId,
      invoiceNo,
      salesOrderId: soIdToUse,
      deliveryOrderId: data.deliveryOrderId ?? null,
      customerId: data.customerId,
      warehouseId: data.warehouseId,
      invoiceDate: invDate,
      dueDate,
      status: isPosting ? "posted" : "draft",
      subtotalAmount: toDbAmount(subtotalAccum),
      discountAmount: toDbAmount(discountAccum),
      taxAmount: toDbAmount(taxAccum),
      totalAmount: toDbAmount(grandTotal),
      paidAmount: "0.00",
      creditNoteAppliedAmount: "0.00",
      outstandingAmount: toDbAmount(grandTotal),
      postedAt: isPosting ? new Date() : null,
      postedBy: isPosting ? ctx.user.id : null,
      notes: data.notes ?? null,
      createdBy: ctx.user.id,
    })
    .returning();

  for (const line of preparedLines) {
    await tx.insert(customerInvoiceLines).values({
      id: `cinvl_${crypto.randomUUID().slice(0, 8)}`,
      invoiceId,
      ...line,
    });
  }

  let glJournalId: string | null = null;
  if (isPosting) {
    // Balanced GL Entry:
    // Debit 1120 Piutang Usaha Pelanggan (grandTotal)
    // Credit 4100 Pendapatan Penjualan Buah (subtotalAccum)
    // Credit 2120 Hutang PPN Keluaran (taxAccum, if taxAccum > 0)
    const journalLinesInput: JournalLineInput[] = [
      {
        accountCode: GL_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
        debit: toDbAmount(grandTotal),
        description: `Piutang Penjualan Faktur ${invoiceNo} - ${cust.name}`,
        warehouseId: data.warehouseId,
      },
      {
        accountCode: GL_ACCOUNT_CODES.SALES_REVENUE,
        credit: toDbAmount(subtotalAccum),
        description: `Pendapatan Penjualan Faktur ${invoiceNo}`,
        warehouseId: data.warehouseId,
      },
    ];

    if (taxAccum.gt(0)) {
      journalLinesInput.push({
        accountCode: GL_ACCOUNT_CODES.VAT_OUT_LIABILITY,
        credit: toDbAmount(taxAccum),
        description: `PPN Keluaran Faktur ${invoiceNo}`,
        warehouseId: data.warehouseId,
      });
    }

    const { entry } = await postJournalEntry(tx, ctx, {
      warehouseId: data.warehouseId,
      sourceDocType: "INV",
      sourceDocId: invoiceId,
      purpose: "sales_invoice_post",
      entryDate: invDate,
      memo: `Faktur Penjualan ${invoiceNo} kepada ${cust.name}`,
      lines: journalLinesInput,
      skipDirectPermissionCheck: true,
    });
    glJournalId = entry.id;

    await tx
      .update(customerInvoices)
      .set({ glJournalId })
      .where(eq(customerInvoices.id, invoiceId));

    if (soRecord) {
      await tx
        .update(salesOrders)
        .set({
          isInvoiced: true,
          status: "invoiced",
          version: soRecord.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(salesOrders.id, soRecord.id));
    }
  }

  await recordAudit(tx, {
    ctx,
    action: isPosting ? "sales_invoice.post" : "sales_invoice.create",
    entityType: "sales_invoice",
    entityId: invoiceId,
    warehouseId: data.warehouseId,
    afterData: { ...createdInvoice!, glJournalId },
  });

  return {
    ...createdInvoice!,
    glJournalId,
  } as typeof customerInvoices.$inferSelect & { glJournalId: string | null };
}

export async function postSalesInvoice(
  tx: DbExecutor,
  ctx: ActorContext,
  invoiceId: string,
) {
  const [inv] = await tx
    .select()
    .from(customerInvoices)
    .where(eq(customerInvoices.id, invoiceId))
    .limit(1);
  if (!inv) {
    throw new NotFoundError("Faktur penjualan tidak ditemukan.");
  }
  authorize(ctx, "ar.invoice", { warehouseId: inv.warehouseId });

  if (inv.status !== "draft") {
    throw new BusinessRuleError(
      `Faktur ${inv.invoiceNo} berstatus '${inv.status}' dan tidak dapat di-posting ulang.`,
    );
  }

  const [cust] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, inv.customerId))
    .limit(1);
  if (!cust) {
    throw new NotFoundError("Pelanggan tidak ditemukan.");
  }

  const lines = await tx
    .select()
    .from(customerInvoiceLines)
    .where(eq(customerInvoiceLines.invoiceId, inv.id));

  if (lines.length === 0) {
    throw new BusinessRuleError("Faktur tidak memiliki baris item untuk di-posting.");
  }

  const grandTotal = new MoneyDecimal(inv.totalAmount);
  const subtotalAccum = new MoneyDecimal(inv.subtotalAmount);
  const taxAccum = new MoneyDecimal(inv.taxAmount);

  const journalLinesInput: JournalLineInput[] = [
    {
      accountCode: GL_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
      debit: toDbAmount(grandTotal),
      description: `Piutang Penjualan Faktur ${inv.invoiceNo} - ${cust.name}`,
      warehouseId: inv.warehouseId,
    },
    {
      accountCode: GL_ACCOUNT_CODES.SALES_REVENUE,
      credit: toDbAmount(subtotalAccum),
      description: `Pendapatan Penjualan Faktur ${inv.invoiceNo}`,
      warehouseId: inv.warehouseId,
    },
  ];

  if (taxAccum.gt(0)) {
    journalLinesInput.push({
      accountCode: GL_ACCOUNT_CODES.VAT_OUT_LIABILITY,
      credit: toDbAmount(taxAccum),
      description: `PPN Keluaran Faktur ${inv.invoiceNo}`,
      warehouseId: inv.warehouseId,
    });
  }

  const { entry } = await postJournalEntry(tx, ctx, {
    warehouseId: inv.warehouseId,
    sourceDocType: "INV",
    sourceDocId: inv.id,
    purpose: "sales_invoice_post",
    entryDate: inv.invoiceDate,
    memo: `Posting Faktur Penjualan ${inv.invoiceNo} kepada ${cust.name}`,
    lines: journalLinesInput,
    skipDirectPermissionCheck: true,
  });

  const [updated] = await tx
    .update(customerInvoices)
    .set({
      status: "posted",
      postedAt: new Date(),
      postedBy: ctx.user.id,
      glJournalId: entry.id,
      updatedAt: new Date(),
    })
    .where(eq(customerInvoices.id, inv.id))
    .returning();

  if (inv.salesOrderId) {
    await tx
      .update(salesOrders)
      .set({
        isInvoiced: true,
        status: "invoiced",
        updatedAt: new Date(),
      })
      .where(eq(salesOrders.id, inv.salesOrderId));
  }

  await recordAudit(tx, {
    ctx,
    action: "sales_invoice.post",
    entityType: "sales_invoice",
    entityId: inv.id,
    warehouseId: inv.warehouseId,
    beforeData: inv,
    afterData: updated,
  });

  return updated! as typeof customerInvoices.$inferSelect;
}

export async function voidSalesInvoice(
  tx: DbExecutor,
  ctx: ActorContext,
  input: { invoiceId: string; reason: string },
) {
  const [inv] = await tx
    .select()
    .from(customerInvoices)
    .where(eq(customerInvoices.id, input.invoiceId))
    .limit(1);
  if (!inv) {
    throw new NotFoundError("Faktur penjualan tidak ditemukan.");
  }
  authorize(ctx, "ar.invoice", { warehouseId: inv.warehouseId });

  if (inv.status === "cancelled") {
    throw new BusinessRuleError(`Faktur ${inv.invoiceNo} sudah dibatalkan sebelumnya.`);
  }

  const paidDec = new MoneyDecimal(inv.paidAmount);
  const cnAppliedDec = new MoneyDecimal(inv.creditNoteAppliedAmount);
  if (paidDec.gt(0) || cnAppliedDec.gt(0)) {
    throw new BusinessRuleError(
      `Faktur ${inv.invoiceNo} sudah memiliki pembayaran (Rp ${inv.paidAmount}) atau nota kredit (Rp ${inv.creditNoteAppliedAmount}). Batalkan atau balikkan pembayaran/nota kredit terlebih dahulu.`,
    );
  }

  if (inv.status === "posted" && inv.glJournalId) {
    // Reverse the GL journal with contra-entry
    await reverseJournalEntry(tx, ctx, {
      journalEntryId: inv.glJournalId,
      reason: `Pembatalan faktur penjualan ${inv.invoiceNo}: ${input.reason}`,
    });
  }

  const [updated] = await tx
    .update(customerInvoices)
    .set({
      status: "cancelled",
      outstandingAmount: "0.00",
      voidedAt: new Date(),
      voidedBy: ctx.user.id,
      voidReason: input.reason,
      updatedAt: new Date(),
    })
    .where(eq(customerInvoices.id, inv.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "sales_invoice.void",
    entityType: "sales_invoice",
    entityId: inv.id,
    warehouseId: inv.warehouseId,
    beforeData: inv,
    afterData: updated,
    reason: input.reason,
  });

  return updated! as typeof customerInvoices.$inferSelect;
}

export async function getSalesInvoiceById(
  db: DbExecutor,
  invoiceId: string,
  ctx?: ActorContext,
) {
  const [inv] = await db
    .select({
      id: customerInvoices.id,
      invoiceNo: customerInvoices.invoiceNo,
      salesOrderId: customerInvoices.salesOrderId,
      deliveryOrderId: customerInvoices.deliveryOrderId,
      customerId: customerInvoices.customerId,
      customerName: customers.name,
      customerCode: customers.code,
      warehouseId: customerInvoices.warehouseId,
      warehouseCode: warehouses.code,
      warehouseName: warehouses.name,
      invoiceDate: customerInvoices.invoiceDate,
      dueDate: customerInvoices.dueDate,
      status: customerInvoices.status,
      subtotalAmount: customerInvoices.subtotalAmount,
      discountAmount: customerInvoices.discountAmount,
      taxAmount: customerInvoices.taxAmount,
      totalAmount: customerInvoices.totalAmount,
      paidAmount: customerInvoices.paidAmount,
      creditNoteAppliedAmount: customerInvoices.creditNoteAppliedAmount,
      outstandingAmount: customerInvoices.outstandingAmount,
      glJournalId: customerInvoices.glJournalId,
      postedAt: customerInvoices.postedAt,
      voidedAt: customerInvoices.voidedAt,
      voidReason: customerInvoices.voidReason,
      notes: customerInvoices.notes,
      createdAt: customerInvoices.createdAt,
    })
    .from(customerInvoices)
    .innerJoin(customers, eq(customers.id, customerInvoices.customerId))
    .innerJoin(warehouses, eq(warehouses.id, customerInvoices.warehouseId))
    .where(eq(customerInvoices.id, invoiceId))
    .limit(1);

  if (!inv) return null;
  if (ctx) {
    authorize(ctx, "ar.read", { warehouseId: inv.warehouseId });
  }

  const lines = await db
    .select({
      id: customerInvoiceLines.id,
      lineNo: customerInvoiceLines.lineNo,
      salesOrderLineId: customerInvoiceLines.salesOrderLineId,
      deliveryOrderLineId: customerInvoiceLines.deliveryOrderLineId,
      productId: customerInvoiceLines.productId,
      productName: customerInvoiceLines.productNameSnapshot,
      gradeId: customerInvoiceLines.gradeId,
      gradeCode: customerInvoiceLines.gradeCodeSnapshot,
      uomCode: customerInvoiceLines.uomCode,
      invoicedQty: customerInvoiceLines.invoicedQty,
      invoicedQtyBase: customerInvoiceLines.invoicedQtyBase,
      unitPrice: customerInvoiceLines.unitPrice,
      discountAmount: customerInvoiceLines.discountAmount,
      taxRatePct: customerInvoiceLines.taxRatePct,
      taxAmount: customerInvoiceLines.taxAmount,
      lineNetAmount: customerInvoiceLines.lineNetAmount,
      lineTotalAmount: customerInvoiceLines.lineTotalAmount,
      notes: customerInvoiceLines.notes,
    })
    .from(customerInvoiceLines)
    .where(eq(customerInvoiceLines.invoiceId, inv.id))
    .orderBy(asc(customerInvoiceLines.lineNo));

  const allocations = await db
    .select({
      id: paymentAllocations.id,
      paymentId: paymentAllocations.paymentId,
      paymentNo: customerPayments.paymentNo,
      allocatedAmount: paymentAllocations.allocatedAmount,
      status: paymentAllocations.status,
      allocatedAt: paymentAllocations.allocatedAt,
    })
    .from(paymentAllocations)
    .innerJoin(customerPayments, eq(customerPayments.id, paymentAllocations.paymentId))
    .where(eq(paymentAllocations.invoiceId, inv.id))
    .orderBy(desc(paymentAllocations.allocatedAt));

  return {
    ...inv,
    lines,
    allocations,
  };
}

export async function listSalesInvoices(
  db: DbExecutor,
  filters: {
    customerId?: string;
    warehouseId?: string;
    status?: string;
    limit?: number;
  } = {},
  ctx?: ActorContext,
) {
  if (ctx) {
    authorize(ctx, "ar.read", filters.warehouseId ? { warehouseId: filters.warehouseId } : undefined);
  }
  const conditions = [];
  if (filters.customerId) conditions.push(eq(customerInvoices.customerId, filters.customerId));
  if (filters.warehouseId) conditions.push(eq(customerInvoices.warehouseId, filters.warehouseId));
  if (filters.status) {
    conditions.push(
      eq(
        customerInvoices.status,
        filters.status as
          | "draft"
          | "posted"
          | "partially_paid"
          | "paid"
          | "overdue"
          | "cancelled",
      ),
    );
  }

  return db
    .select({
      id: customerInvoices.id,
      invoiceNo: customerInvoices.invoiceNo,
      salesOrderId: customerInvoices.salesOrderId,
      deliveryOrderId: customerInvoices.deliveryOrderId,
      customerId: customerInvoices.customerId,
      customerName: customers.name,
      customerCode: customers.code,
      warehouseId: customerInvoices.warehouseId,
      warehouseCode: warehouses.code,
      invoiceDate: customerInvoices.invoiceDate,
      dueDate: customerInvoices.dueDate,
      status: customerInvoices.status,
      totalAmount: customerInvoices.totalAmount,
      paidAmount: customerInvoices.paidAmount,
      outstandingAmount: customerInvoices.outstandingAmount,
      postedAt: customerInvoices.postedAt,
      createdAt: customerInvoices.createdAt,
    })
    .from(customerInvoices)
    .innerJoin(customers, eq(customers.id, customerInvoices.customerId))
    .innerJoin(warehouses, eq(warehouses.id, customerInvoices.warehouseId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(customerInvoices.createdAt))
    .limit(filters.limit ?? 100);
}

// ---------------------------------------------------------------------------
// 2. ACCOUNTS RECEIVABLE (AR) & AGING
// ---------------------------------------------------------------------------

export interface ArAgingBucket {
  current: string;
  days1To30: string;
  days31To60: string;
  days61To90: string;
  over90: string;
  totalOutstanding: string;
}

export interface CustomerArAgingSummary {
  customerId: string;
  customerCode: string;
  customerName: string;
  phone: string | null;
  assignedWarehouseCode: string | null;
  buckets: ArAgingBucket;
  unappliedPayments: string;
  unappliedCreditNotes: string;
  netReceivable: string;
}

export async function getArAgingReport(
  db: DbExecutor,
  options: {
    warehouseId?: string;
    asOfDate?: string;
  } = {},
  ctx?: ActorContext,
): Promise<{
  asOfDate: string;
  customers: CustomerArAgingSummary[];
  grandTotal: ArAgingBucket;
}> {
  if (ctx) {
    authorize(ctx, "ar.read", options.warehouseId ? { warehouseId: options.warehouseId } : undefined);
  }
  const asOf = options.asOfDate ?? businessDate();
  const asOfTime = new Date(asOf).getTime();

  const conditions = [inArray(customerInvoices.status, ["posted", "partially_paid"])];
  if (options.warehouseId) {
    conditions.push(eq(customerInvoices.warehouseId, options.warehouseId));
  }

  const invoices = await db
    .select({
      id: customerInvoices.id,
      customerId: customerInvoices.customerId,
      customerCode: customers.code,
      customerName: customers.name,
      customerPhone: customers.phone,
      warehouseCode: warehouses.code,
      dueDate: customerInvoices.dueDate,
      outstandingAmount: customerInvoices.outstandingAmount,
    })
    .from(customerInvoices)
    .innerJoin(customers, eq(customers.id, customerInvoices.customerId))
    .innerJoin(warehouses, eq(warehouses.id, customerInvoices.warehouseId))
    .where(and(...conditions));

  const custMap = new Map<
    string,
    {
      code: string;
      name: string;
      phone: string | null;
      whCode: string | null;
      current: Money;
      d1_30: Money;
      d31_60: Money;
      d61_90: Money;
      over90: Money;
    }
  >();

  let grandCurrent = new MoneyDecimal(0);
  let grand1_30 = new MoneyDecimal(0);
  let grand31_60 = new MoneyDecimal(0);
  let grand61_90 = new MoneyDecimal(0);
  let grandOver90 = new MoneyDecimal(0);

  for (const inv of invoices) {
    const outstandingDec = new MoneyDecimal(inv.outstandingAmount);
    if (outstandingDec.lte(0)) continue;

    if (!custMap.has(inv.customerId)) {
      custMap.set(inv.customerId, {
        code: inv.customerCode,
        name: inv.customerName,
        phone: inv.customerPhone,
        whCode: inv.warehouseCode,
        current: new MoneyDecimal(0),
        d1_30: new MoneyDecimal(0),
        d31_60: new MoneyDecimal(0),
        d61_90: new MoneyDecimal(0),
        over90: new MoneyDecimal(0),
      });
    }

    const c = custMap.get(inv.customerId)!;
    const dueTime = new Date(inv.dueDate).getTime();
    const daysOverdue = Math.floor((asOfTime - dueTime) / (1000 * 60 * 60 * 24));

    if (daysOverdue <= 0) {
      c.current = c.current.plus(outstandingDec);
      grandCurrent = grandCurrent.plus(outstandingDec);
    } else if (daysOverdue <= 30) {
      c.d1_30 = c.d1_30.plus(outstandingDec);
      grand1_30 = grand1_30.plus(outstandingDec);
    } else if (daysOverdue <= 60) {
      c.d31_60 = c.d31_60.plus(outstandingDec);
      grand31_60 = grand31_60.plus(outstandingDec);
    } else if (daysOverdue <= 90) {
      c.d61_90 = c.d61_90.plus(outstandingDec);
      grand61_90 = grand61_90.plus(outstandingDec);
    } else {
      c.over90 = c.over90.plus(outstandingDec);
      grandOver90 = grandOver90.plus(outstandingDec);
    }
  }

  // Also query unapplied payments & unapplied credit notes per customer
  const unappliedPayments = await db
    .select({
      customerId: customerPayments.customerId,
      unappliedAmount: customerPayments.unappliedAmount,
    })
    .from(customerPayments)
    .where(
      and(
        eq(customerPayments.status, "posted"),
        sql`CAST(${customerPayments.unappliedAmount} AS NUMERIC) > 0`,
      ),
    );

  const unappliedByCust: Record<string, Money> = {};
  for (const p of unappliedPayments) {
    unappliedByCust[p.customerId] = (
      unappliedByCust[p.customerId] ?? new MoneyDecimal(0)
    ).plus(new MoneyDecimal(p.unappliedAmount));
  }

  const unappliedCreditNotes = await db
    .select({
      customerId: customerCreditNotes.customerId,
      unappliedAmount: customerCreditNotes.unappliedAmount,
    })
    .from(customerCreditNotes)
    .where(
      and(
        inArray(customerCreditNotes.status, ["approved", "applied"]),
        sql`CAST(${customerCreditNotes.unappliedAmount} AS NUMERIC) > 0`,
      ),
    );

  const unappliedCnByCust: Record<string, Money> = {};
  for (const cn of unappliedCreditNotes) {
    unappliedCnByCust[cn.customerId] = (
      unappliedCnByCust[cn.customerId] ?? new MoneyDecimal(0)
    ).plus(new MoneyDecimal(cn.unappliedAmount));
  }

  const customerResults: CustomerArAgingSummary[] = [];
  for (const [cId, d] of custMap.entries()) {
    const totalOut = d.current
      .plus(d.d1_30)
      .plus(d.d31_60)
      .plus(d.d61_90)
      .plus(d.over90);

    const unappPay = unappliedByCust[cId] ?? new MoneyDecimal(0);
    const unappCn = unappliedCnByCust[cId] ?? new MoneyDecimal(0);
    const netRec = totalOut.minus(unappPay).minus(unappCn);

    customerResults.push({
      customerId: cId,
      customerCode: d.code,
      customerName: d.name,
      phone: d.phone,
      assignedWarehouseCode: d.whCode,
      buckets: {
        current: toDbAmount(d.current),
        days1To30: toDbAmount(d.d1_30),
        days31To60: toDbAmount(d.d31_60),
        days61To90: toDbAmount(d.d61_90),
        over90: toDbAmount(d.over90),
        totalOutstanding: toDbAmount(totalOut),
      },
      unappliedPayments: toDbAmount(unappPay),
      unappliedCreditNotes: toDbAmount(unappCn),
      netReceivable: toDbAmount(netRec),
    });
  }

  const grandTotalOut = grandCurrent
    .plus(grand1_30)
    .plus(grand31_60)
    .plus(grand61_90)
    .plus(grandOver90);

  return {
    asOfDate: asOf,
    customers: customerResults,
    grandTotal: {
      current: toDbAmount(grandCurrent),
      days1To30: toDbAmount(grand1_30),
      days31To60: toDbAmount(grand31_60),
      days61To90: toDbAmount(grand61_90),
      over90: toDbAmount(grandOver90),
      totalOutstanding: toDbAmount(grandTotalOut),
    },
  };
}

export async function getCustomerArSummary(
  db: DbExecutor,
  customerId: string,
  ctx?: ActorContext,
) {
  if (ctx) {
    authorize(ctx, "ar.read");
  }
  const report = await getArAgingReport(db, {}, ctx);
  const found = report.customers.find((c) => c.customerId === customerId);
  return found ?? null;
}

export async function getCustomerStatement(
  db: DbExecutor,
  options: {
    customerId: string;
    startDate?: string;
    endDate?: string;
  },
  ctx?: ActorContext,
) {
  if (ctx) {
    authorize(ctx, "ar.read");
  }
  const [cust] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, options.customerId))
    .limit(1);
  if (!cust) {
    throw new NotFoundError("Pelanggan tidak ditemukan.");
  }

  const invoiceConditions = [
    eq(customerInvoices.customerId, options.customerId),
    ne(customerInvoices.status, "cancelled"),
    ne(customerInvoices.status, "draft"),
  ];
  if (options.startDate) {
    invoiceConditions.push(sql`${customerInvoices.invoiceDate} >= ${options.startDate}`);
  }
  if (options.endDate) {
    invoiceConditions.push(sql`${customerInvoices.invoiceDate} <= ${options.endDate}`);
  }

  const invRows = await db
    .select({
      id: customerInvoices.id,
      date: customerInvoices.invoiceDate,
      docNo: customerInvoices.invoiceNo,
      type: sql<string>`'INVOICE'`,
      description: sql<string>`'Faktur Penjualan'`,
      debit: customerInvoices.totalAmount,
      credit: sql<string>`'0.00'`,
      status: customerInvoices.status,
    })
    .from(customerInvoices)
    .where(and(...invoiceConditions));

  const paymentConditions = [
    eq(customerPayments.customerId, options.customerId),
    eq(customerPayments.status, "posted"),
  ];
  if (options.startDate) {
    paymentConditions.push(sql`${customerPayments.paymentDate} >= ${options.startDate}`);
  }
  if (options.endDate) {
    paymentConditions.push(sql`${customerPayments.paymentDate} <= ${options.endDate}`);
  }

  const payRows = await db
    .select({
      id: customerPayments.id,
      date: customerPayments.paymentDate,
      docNo: customerPayments.paymentNo,
      type: sql<string>`'PAYMENT'`,
      description: sql<string>`'Pembayaran Pelanggan (' || ${customerPayments.paymentMethod} || ')'`,
      debit: sql<string>`'0.00'`,
      credit: customerPayments.amount,
      status: customerPayments.status,
    })
    .from(customerPayments)
    .where(and(...paymentConditions));

  const cnConditions = [
    eq(customerCreditNotes.customerId, options.customerId),
    inArray(customerCreditNotes.status, ["approved", "applied"]),
  ];
  if (options.startDate) {
    cnConditions.push(sql`${customerCreditNotes.issueDate} >= ${options.startDate}`);
  }
  if (options.endDate) {
    cnConditions.push(sql`${customerCreditNotes.issueDate} <= ${options.endDate}`);
  }

  const cnRows = await db
    .select({
      id: customerCreditNotes.id,
      date: customerCreditNotes.issueDate,
      docNo: customerCreditNotes.creditNoteNo,
      type: sql<string>`'CREDIT_NOTE'`,
      description: sql<string>`'Nota Kredit: ' || ${customerCreditNotes.reason}`,
      debit: sql<string>`'0.00'`,
      credit: customerCreditNotes.totalAmount,
      status: customerCreditNotes.status,
    })
    .from(customerCreditNotes)
    .where(and(...cnConditions));

  const allEntries = [...invRows, ...payRows, ...cnRows].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  let runningBalance = new MoneyDecimal(0);
  const ledger = allEntries.map((e) => {
    const debitDec = new MoneyDecimal(e.debit);
    const creditDec = new MoneyDecimal(e.credit);
    runningBalance = runningBalance.plus(debitDec).minus(creditDec);

    return {
      ...e,
      runningBalance: toDbAmount(runningBalance),
    };
  });

  return {
    customer: cust,
    asOfDate: businessDate(),
    startDate: options.startDate ?? null,
    endDate: options.endDate ?? null,
    ledger,
    closingBalance: toDbAmount(runningBalance),
  };
}

export async function reconcileArSubledgerWithGl(
  db: DbExecutor,
  options: {
    warehouseId?: string;
    asOfDate?: string;
  } = {},
  ctx?: ActorContext,
) {
  if (ctx) {
    authorize(ctx, "gl.read", options.warehouseId ? { warehouseId: options.warehouseId } : undefined);
  }
  const asOf = options.asOfDate ?? businessDate();

  // 1. AR Subledger: Sum of customer_invoices.outstandingAmount
  const invConditions = [
    inArray(customerInvoices.status, ["posted", "partially_paid"]),
    sql`${customerInvoices.invoiceDate} <= ${asOf}`,
  ];
  if (options.warehouseId) {
    invConditions.push(eq(customerInvoices.warehouseId, options.warehouseId));
  }

  const [subledgerRes] = await db
    .select({
      totalOutstanding: sql<string>`COALESCE(SUM(CAST(${customerInvoices.outstandingAmount} AS NUMERIC)), 0.00)`,
    })
    .from(customerInvoices)
    .where(and(...invConditions));

  const subledgerTotal = new MoneyDecimal(subledgerRes?.totalOutstanding ?? "0.00");

  // 2. GL Balance: Account 1120 (Debit - Credit)
  const glConditions = [
    eq(journalLines.accountCode, GL_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE),
    sql`${journalEntries.entryDate} <= ${asOf}`,
  ];
  if (options.warehouseId) {
    glConditions.push(eq(journalEntries.warehouseId, options.warehouseId));
  }

  const [glRes] = await db
    .select({
      totalDebit: sql<string>`COALESCE(SUM(CAST(${journalLines.debit} AS NUMERIC)), 0.00)`,
      totalCredit: sql<string>`COALESCE(SUM(CAST(${journalLines.credit} AS NUMERIC)), 0.00)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .where(and(...glConditions));

  const glDebit = new MoneyDecimal(glRes?.totalDebit ?? "0.00");
  const glCredit = new MoneyDecimal(glRes?.totalCredit ?? "0.00");
  const glEndingBalance = glDebit.minus(glCredit);

  const variance = subledgerTotal.minus(glEndingBalance);

  return {
    asOfDate: asOf,
    warehouseId: options.warehouseId ?? null,
    arSubledgerTotal: toDbAmount(subledgerTotal),
    glAccountCode: GL_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
    glDebit: toDbAmount(glDebit),
    glCredit: toDbAmount(glCredit),
    glEndingBalance: toDbAmount(glEndingBalance),
    variance: toDbAmount(variance),
    isReconciled: variance.eq(0),
  };
}

// ---------------------------------------------------------------------------
// 3. PAYMENT RECORDING, ALLOCATIONS & REVERSALS
// ---------------------------------------------------------------------------

export const recordCustomerPaymentSchema = z.object({
  customerId: z.string().min(1),
  warehouseId: z.string().min(1),
  invoiceId: z.string().optional().nullable(),
  bankAccountId: z.string().optional().nullable(),
  paymentType: z.enum(["invoice_payment", "deposit"]).default("invoice_payment"),
  paymentMethod: z.enum(["bank_transfer", "cash", "giro", "qris"]).default("bank_transfer"),
  paymentDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  amount: z.union([z.string(), z.number()]),
  status: z.enum(["draft", "posted"]).default("posted"),
  allocations: z
    .array(
      z.object({
        invoiceId: z.string().min(1),
        amount: z.union([z.string(), z.number()]),
      }),
    )
    .optional(),
  referenceNo: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  autoVerify: z.boolean().default(false),
});

export async function recordCustomerPayment(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof recordCustomerPaymentSchema>,
) {
  authorize(ctx, "ar.collect", { warehouseId: rawInput.warehouseId });
  const parsed = recordCustomerPaymentSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  // Lock customer row for concurrency
  const cust = await lockCustomerForCreditCheck(tx, data.customerId);

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, data.warehouseId))
    .limit(1);
  if (!wh) {
    throw new NotFoundError("Gudang tidak ditemukan.");
  }

  const paymentAmount = roundRupiah(parseMoney(data.amount));
  if (paymentAmount.lte(0)) {
    throw new BusinessRuleError("Nominal pembayaran harus lebih besar dari Rp 0.");
  }

  const paymentNo = await nextDocumentNumber(tx, {
    docType: "PAY",
    warehouseCode: wh.code,
  });

  const paymentDate = data.paymentDate ?? businessDate();
  const isPosting = data.status === "posted";
  const paymentId = `cpay_${crypto.randomUUID().slice(0, 8)}`;

  // Prepare allocations if any
  const isAutoSingleAlloc = Boolean(data.invoiceId && (!data.allocations || data.allocations.length === 0));
  const rawAllocs = [...(data.allocations ?? [])];
  if (isAutoSingleAlloc) {
    rawAllocs.push({ invoiceId: data.invoiceId!, amount: toDbAmount(paymentAmount) });
  }

  let totalAllocated = new MoneyDecimal(0);
  const validatedAllocations: Array<{
    invoiceId: string;
    allocDec: Money;
    invoice: typeof customerInvoices.$inferSelect;
  }> = [];

  if (isPosting && rawAllocs.length > 0) {
    for (const allocInput of rawAllocs) {
      // Row lock the invoice FOR UPDATE
      await tx.execute(sql`SELECT id FROM customer_invoices WHERE id = ${allocInput.invoiceId} FOR UPDATE`);
      const [inv] = await tx
        .select()
        .from(customerInvoices)
        .where(eq(customerInvoices.id, allocInput.invoiceId))
        .limit(1);

      if (!inv) {
        throw new NotFoundError(`Invoice id '${allocInput.invoiceId}' tidak ditemukan.`);
      }
      if (inv.customerId !== data.customerId) {
        throw new BusinessRuleError("Invoice target harus milik pelanggan yang sama.");
      }
      if (inv.status === "cancelled" || inv.status === "draft") {
        throw new BusinessRuleError(
          `Invoice ${inv.invoiceNo} berstatus '${inv.status}' dan tidak dapat menerima alokasi pembayaran.`,
        );
      }

      const outstandingDec = new MoneyDecimal(inv.outstandingAmount);
      if (outstandingDec.lte(0)) {
        throw new BusinessRuleError(`Invoice ${inv.invoiceNo} sudah lunas.`);
      }

      const inputAllocDec = roundRupiah(parseMoney(allocInput.amount));
      if (inputAllocDec.lte(0)) {
        throw new BusinessRuleError("Nominal alokasi harus lebih besar dari Rp 0.");
      }

      const allocDec = MoneyDecimal.min(inputAllocDec, outstandingDec);
      if (!isAutoSingleAlloc && inputAllocDec.gt(outstandingDec)) {
        throw new BusinessRuleError(
          `Alokasi untuk invoice ${inv.invoiceNo} (Rp ${inputAllocDec.toFixed(2)}) melebihi sisa tagihan (Rp ${outstandingDec.toFixed(2)}).`,
        );
      }

      totalAllocated = totalAllocated.plus(allocDec);
      validatedAllocations.push({
        invoiceId: inv.id,
        allocDec,
        invoice: inv,
      });
    }

    if (totalAllocated.gt(paymentAmount)) {
      throw new BusinessRuleError(
        `Total alokasi (Rp ${totalAllocated.toFixed(2)}) melebihi nominal pembayaran (Rp ${paymentAmount.toFixed(2)}).`,
      );
    }
  }

  const unappliedDec = isPosting
    ? roundRupiah(paymentAmount.minus(totalAllocated))
    : paymentAmount;

  const [createdPayment] = await tx
    .insert(customerPayments)
    .values({
      id: paymentId,
      paymentNo,
      customerId: data.customerId,
      warehouseId: data.warehouseId,
      invoiceId: data.invoiceId ?? null,
      bankAccountId: data.bankAccountId ?? null,
      paymentType: data.paymentType,
      paymentMethod: data.paymentMethod,
      paymentDate,
      status: isPosting ? "posted" : "draft",
      amount: toDbAmount(paymentAmount),
      appliedAmount: toDbAmount(totalAllocated),
      unappliedAmount: toDbAmount(unappliedDec),
      verificationStatus: isPosting ? "verified" : "pending_verification",
      verifiedBy: isPosting ? ctx.user.id : null,
      verifiedAt: isPosting ? new Date() : null,
      referenceNo: data.referenceNo ?? null,
      notes: data.notes ?? null,
      createdBy: ctx.user.id,
    })
    .returning();

  let glJournalId: string | null = null;

  if (isPosting) {
    // Apply allocations to invoices
    for (const alloc of validatedAllocations) {
      const currentPaid = new MoneyDecimal(alloc.invoice.paidAmount);
      const currentOutstanding = new MoneyDecimal(alloc.invoice.outstandingAmount);

      const newPaid = currentPaid.plus(alloc.allocDec);
      const newOutstanding = currentOutstanding.minus(alloc.allocDec);
      const newStatus = newOutstanding.eq(0) ? "paid" : "partially_paid";

      await tx
        .update(customerInvoices)
        .set({
          paidAmount: toDbAmount(newPaid),
          outstandingAmount: toDbAmount(newOutstanding),
          status: newStatus,
          updatedAt: new Date(),
        })
        .where(eq(customerInvoices.id, alloc.invoice.id));

      await tx.insert(paymentAllocations).values({
        id: `palloc_${crypto.randomUUID().slice(0, 8)}`,
        paymentId,
        invoiceId: alloc.invoice.id,
        allocatedAmount: toDbAmount(alloc.allocDec),
        status: "active",
        allocatedBy: ctx.user.id,
        notes: `Alokasi pembayaran ${paymentNo} ke faktur ${alloc.invoice.invoiceNo}`,
      });
    }

    // Post balanced GL Journal:
    // Debit 1110 Kas & Bank Operasional (paymentAmount)
    // Credit 1120 Piutang Usaha (totalAllocated, if > 0)
    // Credit 2130 Uang Muka / Kelebihan Pembayaran Pelanggan (unappliedDec, if > 0)
    const journalLinesInput: JournalLineInput[] = [
      {
        accountCode: GL_ACCOUNT_CODES.CASH_BANK,
        debit: toDbAmount(paymentAmount),
        description: `Penerimaan Pembayaran ${paymentNo} (${data.paymentMethod}) - ${cust.name}`,
        warehouseId: data.warehouseId,
      },
    ];

    if (totalAllocated.gt(0)) {
      journalLinesInput.push({
        accountCode: GL_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
        credit: toDbAmount(totalAllocated),
        description: `Pelunasan Piutang via Pembayaran ${paymentNo}`,
        warehouseId: data.warehouseId,
      });
    }

    if (unappliedDec.gt(0)) {
      journalLinesInput.push({
        accountCode: GL_ACCOUNT_CODES.UNAPPLIED_CUSTOMER_CASH,
        credit: toDbAmount(unappliedDec),
        description: `Kelebihan Pembayaran / Uang Muka ${paymentNo}`,
        warehouseId: data.warehouseId,
      });
    }

    const { entry } = await postJournalEntry(tx, ctx, {
      warehouseId: data.warehouseId,
      sourceDocType: "PAY",
      sourceDocId: paymentId,
      purpose: "customer_payment_post",
      entryDate: paymentDate,
      memo: `Penerimaan Pembayaran ${paymentNo} dari ${cust.name}`,
      lines: journalLinesInput,
      skipDirectPermissionCheck: true,
    });
    glJournalId = entry.id;

    await tx
      .update(customerPayments)
      .set({ glJournalId })
      .where(eq(customerPayments.id, paymentId));
  }

  await recordAudit(tx, {
    ctx,
    action: isPosting ? "customer_payment.post" : "customer_payment.record",
    entityType: "customer_payment",
    entityId: paymentId,
    warehouseId: data.warehouseId,
    afterData: { ...createdPayment!, glJournalId },
  });

  return {
    ...createdPayment!,
    glJournalId,
  } as typeof customerPayments.$inferSelect & { glJournalId: string | null };
}

export async function postCustomerPayment(
  tx: DbExecutor,
  ctx: ActorContext,
  input: {
    paymentId: string;
    allocations?: Array<{ invoiceId: string; amount: string | number }>;
  },
) {
  await tx.execute(sql`SELECT id FROM customer_payments WHERE id = ${input.paymentId} FOR UPDATE`);
  const [payment] = await tx
    .select()
    .from(customerPayments)
    .where(eq(customerPayments.id, input.paymentId))
    .limit(1);

  if (!payment) {
    throw new NotFoundError("Data pembayaran tidak ditemukan.");
  }
  authorize(ctx, "ar.collect", { warehouseId: payment.warehouseId });

  if (payment.status !== "draft") {
    throw new BusinessRuleError(
      `Pembayaran ${payment.paymentNo} berstatus '${payment.status}' dan tidak dapat di-posting ulang.`,
    );
  }

  const [cust] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, payment.customerId))
    .limit(1);
  if (!cust) {
    throw new NotFoundError("Pelanggan tidak ditemukan.");
  }

  const paymentAmount = new MoneyDecimal(payment.amount);
  const rawAllocs = [...(input.allocations ?? [])];
  if (payment.invoiceId && rawAllocs.length === 0) {
    rawAllocs.push({ invoiceId: payment.invoiceId, amount: toDbAmount(paymentAmount) });
  }

  let totalAllocated = new MoneyDecimal(0);
  const validatedAllocations: Array<{
    invoiceId: string;
    allocDec: Money;
    invoice: typeof customerInvoices.$inferSelect;
  }> = [];

  for (const allocInput of rawAllocs) {
    await tx.execute(sql`SELECT id FROM customer_invoices WHERE id = ${allocInput.invoiceId} FOR UPDATE`);
    const [inv] = await tx
      .select()
      .from(customerInvoices)
      .where(eq(customerInvoices.id, allocInput.invoiceId))
      .limit(1);

    if (!inv) {
      throw new NotFoundError(`Invoice id '${allocInput.invoiceId}' tidak ditemukan.`);
    }
    if (inv.customerId !== payment.customerId) {
      throw new BusinessRuleError("Invoice target harus milik pelanggan yang sama.");
    }
    const outstandingDec = new MoneyDecimal(inv.outstandingAmount);
    const inputAllocDec = roundRupiah(parseMoney(allocInput.amount));

    if (inputAllocDec.gt(outstandingDec)) {
      throw new BusinessRuleError(
        `Alokasi untuk invoice ${inv.invoiceNo} melebihi sisa tagihan (Rp ${outstandingDec.toFixed(2)}).`,
      );
    }

    const allocDec = MoneyDecimal.min(inputAllocDec, outstandingDec);
    totalAllocated = totalAllocated.plus(allocDec);
    validatedAllocations.push({
      invoiceId: inv.id,
      allocDec,
      invoice: inv,
    });
  }

  if (totalAllocated.gt(paymentAmount)) {
    throw new BusinessRuleError(
      `Total alokasi melebihi nominal pembayaran (Rp ${paymentAmount.toFixed(2)}).`,
    );
  }

  const unappliedDec = roundRupiah(paymentAmount.minus(totalAllocated));

  for (const alloc of validatedAllocations) {
    const currentPaid = new MoneyDecimal(alloc.invoice.paidAmount);
    const currentOutstanding = new MoneyDecimal(alloc.invoice.outstandingAmount);

    const newPaid = currentPaid.plus(alloc.allocDec);
    const newOutstanding = currentOutstanding.minus(alloc.allocDec);
    const newStatus = newOutstanding.eq(0) ? "paid" : "partially_paid";

    await tx
      .update(customerInvoices)
      .set({
        paidAmount: toDbAmount(newPaid),
        outstandingAmount: toDbAmount(newOutstanding),
        status: newStatus,
        updatedAt: new Date(),
      })
      .where(eq(customerInvoices.id, alloc.invoice.id));

    await tx.insert(paymentAllocations).values({
      id: `palloc_${crypto.randomUUID().slice(0, 8)}`,
      paymentId: payment.id,
      invoiceId: alloc.invoice.id,
      allocatedAmount: toDbAmount(alloc.allocDec),
      status: "active",
      allocatedBy: ctx.user.id,
      notes: `Posting alokasi pembayaran ${payment.paymentNo} ke faktur ${alloc.invoice.invoiceNo}`,
    });
  }

  const journalLinesInput: JournalLineInput[] = [
    {
      accountCode: GL_ACCOUNT_CODES.CASH_BANK,
      debit: toDbAmount(paymentAmount),
      description: `Penerimaan Pembayaran ${payment.paymentNo} - ${cust.name}`,
      warehouseId: payment.warehouseId,
    },
  ];

  if (totalAllocated.gt(0)) {
    journalLinesInput.push({
      accountCode: GL_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
      credit: toDbAmount(totalAllocated),
      description: `Pelunasan Piutang via Pembayaran ${payment.paymentNo}`,
      warehouseId: payment.warehouseId,
    });
  }

  if (unappliedDec.gt(0)) {
    journalLinesInput.push({
      accountCode: GL_ACCOUNT_CODES.UNAPPLIED_CUSTOMER_CASH,
      credit: toDbAmount(unappliedDec),
      description: `Kelebihan Pembayaran / Uang Muka ${payment.paymentNo}`,
      warehouseId: payment.warehouseId,
    });
  }

  const { entry } = await postJournalEntry(tx, ctx, {
    warehouseId: payment.warehouseId,
    sourceDocType: "PAY",
    sourceDocId: payment.id,
    purpose: "customer_payment_post",
    entryDate: payment.paymentDate,
    memo: `Posting Pembayaran ${payment.paymentNo} dari ${cust.name}`,
    lines: journalLinesInput,
    skipDirectPermissionCheck: true,
  });

  const [updatedPayment] = await tx
    .update(customerPayments)
    .set({
      status: "posted",
      appliedAmount: toDbAmount(totalAllocated),
      unappliedAmount: toDbAmount(unappliedDec),
      verificationStatus: "verified",
      verifiedBy: ctx.user.id,
      verifiedAt: new Date(),
      glJournalId: entry.id,
      updatedAt: new Date(),
    })
    .where(eq(customerPayments.id, payment.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "customer_payment.post",
    entityType: "customer_payment",
    entityId: payment.id,
    warehouseId: payment.warehouseId,
    beforeData: payment,
    afterData: updatedPayment,
  });

  return updatedPayment;
}

export async function reverseCustomerPayment(
  tx: DbExecutor,
  ctx: ActorContext,
  input: {
    paymentId: string;
    reason: string;
  },
) {
  await tx.execute(sql`SELECT id FROM customer_payments WHERE id = ${input.paymentId} FOR UPDATE`);
  const [payment] = await tx
    .select()
    .from(customerPayments)
    .where(eq(customerPayments.id, input.paymentId))
    .limit(1);

  if (!payment) {
    throw new NotFoundError("Data pembayaran tidak ditemukan.");
  }
  authorize(ctx, "ar.collect", { warehouseId: payment.warehouseId });

  if (payment.status !== "posted") {
    throw new BusinessRuleError(
      `Pembayaran ${payment.paymentNo} berstatus '${payment.status}' dan tidak dapat dibalikkan.`,
    );
  }

  // Row lock customer for credit check consistency
  await lockCustomerForCreditCheck(tx, payment.customerId);

  // Restore allocated invoices
  const allocations = await tx
    .select()
    .from(paymentAllocations)
    .where(
      and(
        eq(paymentAllocations.paymentId, payment.id),
        eq(paymentAllocations.status, "active"),
      ),
    );

  for (const alloc of allocations) {
    await tx.execute(sql`SELECT id FROM customer_invoices WHERE id = ${alloc.invoiceId} FOR UPDATE`);
    const [inv] = await tx
      .select()
      .from(customerInvoices)
      .where(eq(customerInvoices.id, alloc.invoiceId))
      .limit(1);

    if (inv) {
      const currentPaid = new MoneyDecimal(inv.paidAmount);
      const currentOutstanding = new MoneyDecimal(inv.outstandingAmount);
      const allocDec = new MoneyDecimal(alloc.allocatedAmount);

      const restoredPaid = currentPaid.minus(allocDec);
      const restoredOutstanding = currentOutstanding.plus(allocDec);
      const restoredStatus = restoredOutstanding.eq(new MoneyDecimal(inv.totalAmount))
        ? "posted"
        : "partially_paid";

      await tx
        .update(customerInvoices)
        .set({
          paidAmount: toDbAmount(restoredPaid),
          outstandingAmount: toDbAmount(restoredOutstanding),
          status: restoredStatus,
          updatedAt: new Date(),
        })
        .where(eq(customerInvoices.id, inv.id));
    }

    await tx
      .update(paymentAllocations)
      .set({
        status: "reversed",
        reversalReason: input.reason,
        reversedAt: new Date(),
        reversedBy: ctx.user.id,
      })
      .where(eq(paymentAllocations.id, alloc.id));
  }

  // Reverse GL journal entry if posted
  let reversalGlJournalId: string | null = null;
  if (payment.glJournalId) {
    const { entry: reversalEntry } = await reverseJournalEntry(tx, ctx, {
      journalEntryId: payment.glJournalId,
      reason: `Reversal pembayaran ${payment.paymentNo}: ${input.reason}`,
    });
    reversalGlJournalId = reversalEntry.id;
  }

  const [updated] = await tx
    .update(customerPayments)
    .set({
      status: "reversed",
      appliedAmount: "0.00",
      unappliedAmount: "0.00",
      reversedAt: new Date(),
      reversedBy: ctx.user.id,
      reversalReason: input.reason,
      reversalGlJournalId,
      updatedAt: new Date(),
    })
    .where(eq(customerPayments.id, payment.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "customer_payment.reverse",
    entityType: "customer_payment",
    entityId: payment.id,
    warehouseId: payment.warehouseId,
    beforeData: payment,
    afterData: updated,
    reason: input.reason,
  });

  return updated! as typeof customerPayments.$inferSelect;
}

export async function allocatePaymentToInvoices(
  tx: DbExecutor,
  ctx: ActorContext,
  input: {
    paymentId: string;
    allocations: Array<{ invoiceId: string; amount: string | number }>;
  },
) {
  await tx.execute(sql`SELECT id FROM customer_payments WHERE id = ${input.paymentId} FOR UPDATE`);
  const [payment] = await tx
    .select()
    .from(customerPayments)
    .where(eq(customerPayments.id, input.paymentId))
    .limit(1);

  if (!payment) {
    throw new NotFoundError("Data pembayaran tidak ditemukan.");
  }
  authorize(ctx, "ar.collect", { warehouseId: payment.warehouseId });

  if (payment.status !== "posted") {
    throw new BusinessRuleError(
      `Hanya pembayaran berstatus 'posted' yang dapat dialokasikan. Status saat ini: '${payment.status}'`,
    );
  }

  const availableUnapplied = new MoneyDecimal(payment.unappliedAmount);
  if (availableUnapplied.lte(0)) {
    throw new BusinessRuleError("Pembayaran ini tidak memiliki saldo belum teralokasi (unapplied amount = 0).");
  }

  let totalAllocating = new MoneyDecimal(0);
  const validatedAllocations = [];

  for (const allocInput of input.allocations) {
    await tx.execute(sql`SELECT id FROM customer_invoices WHERE id = ${allocInput.invoiceId} FOR UPDATE`);
    const [inv] = await tx
      .select()
      .from(customerInvoices)
      .where(eq(customerInvoices.id, allocInput.invoiceId))
      .limit(1);

    if (!inv) {
      throw new NotFoundError(`Invoice id '${allocInput.invoiceId}' tidak ditemukan.`);
    }
    if (inv.customerId !== payment.customerId) {
      throw new BusinessRuleError("Invoice target harus milik pelanggan yang sama.");
    }
    const outstandingDec = new MoneyDecimal(inv.outstandingAmount);
    if (outstandingDec.lte(0)) {
      throw new BusinessRuleError(`Invoice ${inv.invoiceNo} sudah lunas.`);
    }

    const requestedAlloc = roundRupiah(parseMoney(allocInput.amount));
    if (requestedAlloc.gt(outstandingDec)) {
      throw new BusinessRuleError(
        `Alokasi untuk invoice ${inv.invoiceNo} (Rp ${requestedAlloc.toFixed(2)}) melebihi sisa tagihan (Rp ${outstandingDec.toFixed(2)}).`,
      );
    }

    totalAllocating = totalAllocating.plus(requestedAlloc);
    validatedAllocations.push({
      inv,
      allocDec: requestedAlloc,
    });
  }

  if (totalAllocating.gt(availableUnapplied)) {
    throw new BusinessRuleError(
      `Total alokasi (Rp ${totalAllocating.toFixed(2)}) melebihi saldo pembayaran yang tersedia (Rp ${availableUnapplied.toFixed(2)}).`,
    );
  }

  // Update invoices & insert payment allocations
  for (const alloc of validatedAllocations) {
    const newPaid = new MoneyDecimal(alloc.inv.paidAmount).plus(alloc.allocDec);
    const newOutstanding = new MoneyDecimal(alloc.inv.outstandingAmount).minus(alloc.allocDec);
    const newStatus = newOutstanding.eq(0) ? "paid" : "partially_paid";

    await tx
      .update(customerInvoices)
      .set({
        paidAmount: toDbAmount(newPaid),
        outstandingAmount: toDbAmount(newOutstanding),
        status: newStatus,
        updatedAt: new Date(),
      })
      .where(eq(customerInvoices.id, alloc.inv.id));

    await tx.insert(paymentAllocations).values({
      id: `palloc_${crypto.randomUUID().slice(0, 8)}`,
      paymentId: payment.id,
      invoiceId: alloc.inv.id,
      allocatedAmount: toDbAmount(alloc.allocDec),
      status: "active",
      allocatedBy: ctx.user.id,
      notes: `Alokasi saldo uang muka ${payment.paymentNo} ke faktur ${alloc.inv.invoiceNo}`,
    });
  }

  const newAppliedAmount = new MoneyDecimal(payment.appliedAmount).plus(totalAllocating);
  const newUnappliedAmount = availableUnapplied.minus(totalAllocating);

  // Balanced reclassification GL Journal:
  // Debit 2130 Uang Muka / Kelebihan Pembayaran Pelanggan (totalAllocating)
  // Credit 1120 Piutang Usaha Pelanggan (totalAllocating)
  await postJournalEntry(tx, ctx, {
    warehouseId: payment.warehouseId,
    sourceDocType: "PAY_ALLOC",
    sourceDocId: `${payment.id}_${Date.now()}`,
    purpose: "unapplied_cash_allocation",
    entryDate: businessDate(),
    memo: `Alokasi uang muka ${payment.paymentNo} ke piutang faktur`,
    lines: [
      {
        accountCode: GL_ACCOUNT_CODES.UNAPPLIED_CUSTOMER_CASH,
        debit: toDbAmount(totalAllocating),
        description: `Reklasifikasi Uang Muka ${payment.paymentNo}`,
        warehouseId: payment.warehouseId,
      },
      {
        accountCode: GL_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
        credit: toDbAmount(totalAllocating),
        description: `Pelunasan Piutang via Alokasi Uang Muka ${payment.paymentNo}`,
        warehouseId: payment.warehouseId,
      },
    ],
    skipDirectPermissionCheck: true,
  });

  const [updatedPayment] = await tx
    .update(customerPayments)
    .set({
      appliedAmount: toDbAmount(newAppliedAmount),
      unappliedAmount: toDbAmount(newUnappliedAmount),
      updatedAt: new Date(),
    })
    .where(eq(customerPayments.id, payment.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "payment_allocation.create",
    entityType: "customer_payment",
    entityId: payment.id,
    warehouseId: payment.warehouseId,
    afterData: updatedPayment,
  });

  return updatedPayment;
}

export async function listCustomerPayments(
  db: DbExecutor,
  filters: {
    customerId?: string;
    warehouseId?: string;
    status?: string;
    limit?: number;
  } = {},
  ctx?: ActorContext,
) {
  if (ctx) {
    authorize(ctx, "ar.read", filters.warehouseId ? { warehouseId: filters.warehouseId } : undefined);
  }
  const conditions = [];
  if (filters.customerId) conditions.push(eq(customerPayments.customerId, filters.customerId));
  if (filters.warehouseId) conditions.push(eq(customerPayments.warehouseId, filters.warehouseId));
  if (filters.status) {
    conditions.push(
      eq(
        customerPayments.status,
        filters.status as "draft" | "posted" | "reversed",
      ),
    );
  }

  return db
    .select({
      id: customerPayments.id,
      paymentNo: customerPayments.paymentNo,
      customerId: customerPayments.customerId,
      customerName: customers.name,
      customerCode: customers.code,
      warehouseId: customerPayments.warehouseId,
      warehouseCode: warehouses.code,
      paymentDate: customerPayments.paymentDate,
      paymentMethod: customerPayments.paymentMethod,
      amount: customerPayments.amount,
      appliedAmount: customerPayments.appliedAmount,
      unappliedAmount: customerPayments.unappliedAmount,
      status: customerPayments.status,
      verificationStatus: customerPayments.verificationStatus,
      referenceNo: customerPayments.referenceNo,
      createdAt: customerPayments.createdAt,
    })
    .from(customerPayments)
    .innerJoin(customers, eq(customers.id, customerPayments.customerId))
    .innerJoin(warehouses, eq(warehouses.id, customerPayments.warehouseId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(customerPayments.createdAt))
    .limit(filters.limit ?? 100);
}

// ---------------------------------------------------------------------------
// 4. BANK ACCOUNTS & SETTLEMENT RECONCILIATION
// ---------------------------------------------------------------------------

export const createBankAccountSchema = z.object({
  code: z.string().trim().min(2).toUpperCase(),
  name: z.string().trim().min(3),
  accountType: z.enum(["bank", "cash", "ewallet"]),
  bankName: z.string().trim().optional().nullable(),
  accountNumber: z.string().trim().optional().nullable(),
  holderName: z.string().trim().optional().nullable(),
  warehouseId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function createBankAccount(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createBankAccountSchema>,
) {
  authorize(ctx, "settings.manage");
  const parsed = createBankAccountSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  // Make sure default COA account 1110 exists
  await seedDefaultCoaAndFiscalPeriod(tx, businessDate());
  const [glAcc] = await tx
    .select()
    .from(glAccounts)
    .where(eq(glAccounts.code, GL_ACCOUNT_CODES.CASH_BANK))
    .limit(1);
  if (!glAcc) {
    throw new NotFoundError("Akun COA 1110 Kas & Bank tidak ditemukan.");
  }

  const id = `bank_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(bankAccounts)
    .values({
      id,
      code: data.code,
      name: data.name,
      accountType: data.accountType,
      bankName: data.bankName ?? null,
      accountNumber: data.accountNumber ?? null,
      holderName: data.holderName ?? null,
      glAccountId: glAcc.id,
      warehouseId: data.warehouseId ?? null,
      currency: "IDR",
      currentBalance: "0.00",
      isActive: true,
      notes: data.notes ?? null,
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "bank_account.create",
    entityType: "bank_account",
    entityId: id,
    afterData: created,
  });

  return created!;
}

export async function listBankAccounts(db: DbExecutor, ctx?: ActorContext) {
  if (ctx) {
    authorize(ctx, "ar.read");
  }
  return db
    .select({
      id: bankAccounts.id,
      code: bankAccounts.code,
      name: bankAccounts.name,
      accountType: bankAccounts.accountType,
      bankName: bankAccounts.bankName,
      accountNumber: bankAccounts.accountNumber,
      holderName: bankAccounts.holderName,
      warehouseId: bankAccounts.warehouseId,
      currentBalance: bankAccounts.currentBalance,
      isActive: bankAccounts.isActive,
      notes: bankAccounts.notes,
    })
    .from(bankAccounts)
    .orderBy(asc(bankAccounts.code));
}

export const recordBankTransactionSchema = z.object({
  bankAccountId: z.string().min(1),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  referenceNo: z.string().trim().optional().nullable(),
  description: z.string().trim().min(3),
  amount: z.union([z.string(), z.number()]),
  direction: z.enum(["in", "out"]),
  notes: z.string().optional().nullable(),
});

export async function recordBankTransaction(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof recordBankTransactionSchema>,
) {
  authorize(ctx, "ar.collect");
  const parsed = recordBankTransactionSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [bank] = await tx
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.id, data.bankAccountId))
    .limit(1);
  if (!bank) {
    throw new NotFoundError("Rekening kas/bank tidak ditemukan.");
  }

  const amountDec = roundRupiah(parseMoney(data.amount));
  if (amountDec.lte(0)) {
    throw new BusinessRuleError("Nominal transaksi mutasi bank harus lebih besar dari Rp 0.");
  }

  const id = `btx_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(bankTransactions)
    .values({
      id,
      bankAccountId: data.bankAccountId,
      transactionDate: data.transactionDate,
      valueDate: data.valueDate ?? null,
      referenceNo: data.referenceNo ?? null,
      description: data.description,
      amount: toDbAmount(amountDec),
      direction: data.direction,
      matchStatus: "unmatched",
      notes: data.notes ?? null,
    })
    .returning();

  return created!;
}

export async function reconcileBankTransactionWithPayment(
  tx: DbExecutor,
  ctx: ActorContext,
  input: {
    bankTransactionId: string;
    paymentId: string;
    notes?: string;
  },
) {
  authorize(ctx, "ar.collect");

  // Lock bank transaction row
  await tx.execute(sql`SELECT id FROM bank_transactions WHERE id = ${input.bankTransactionId} FOR UPDATE`);
  const [btx] = await tx
    .select()
    .from(bankTransactions)
    .where(eq(bankTransactions.id, input.bankTransactionId))
    .limit(1);

  if (!btx) {
    throw new NotFoundError("Transaksi mutasi bank tidak ditemukan.");
  }

  if (btx.matchStatus === "matched") {
    throw new BusinessRuleError("Transaksi mutasi bank ini sudah direkonsiliasi sebelumnya.");
  }

  // Lock payment row
  await tx.execute(sql`SELECT id FROM customer_payments WHERE id = ${input.paymentId} FOR UPDATE`);
  const [payment] = await tx
    .select()
    .from(customerPayments)
    .where(eq(customerPayments.id, input.paymentId))
    .limit(1);

  if (!payment) {
    throw new NotFoundError("Data pembayaran tidak ditemukan.");
  }

  if (payment.status !== "posted") {
    throw new BusinessRuleError(
      `Pembayaran ${payment.paymentNo} berstatus '${payment.status}' dan tidak dapat direkonsiliasi.`,
    );
  }

  // Check if payment is already matched to another bank transaction
  const [alreadyMatched] = await tx
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.matchedPaymentId, payment.id),
        ne(bankTransactions.id, btx.id),
      ),
    )
    .limit(1);

  if (alreadyMatched) {
    throw new ConflictError(
      `Pembayaran ${payment.paymentNo} sudah dicocokkan dengan mutasi bank ${alreadyMatched.id}.`,
    );
  }

  const btxAmount = new MoneyDecimal(btx.amount);
  const payAmount = new MoneyDecimal(payment.amount);

  const isExactMatch = btxAmount.eq(payAmount);
  const matchStatus = isExactMatch ? "matched" : "discrepancy";
  const discrepancyReason = isExactMatch
    ? null
    : `Selisih nominal: mutasi bank Rp ${btxAmount.toFixed(2)} vs bukti pembayaran Rp ${payAmount.toFixed(2)}`;

  const [updated] = await tx
    .update(bankTransactions)
    .set({
      matchedPaymentId: isExactMatch ? payment.id : null,
      matchStatus,
      matchedAt: new Date(),
      matchedBy: ctx.user.id,
      discrepancyReason,
      notes: input.notes ?? btx.notes,
      updatedAt: new Date(),
    })
    .where(eq(bankTransactions.id, btx.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "bank_settlement.reconcile",
    entityType: "bank_transaction",
    entityId: btx.id,
    afterData: updated,
    reason: isExactMatch
      ? `Rekonsiliasi cocok dengan pembayaran ${payment.paymentNo}`
      : discrepancyReason!,
  });

  return updated! as typeof bankTransactions.$inferSelect;
}

// ---------------------------------------------------------------------------
// 5. CREDIT NOTES & SETTLEMENT
// ---------------------------------------------------------------------------

export const createCreditNoteLineSchema = z.object({
  productId: z.string().min(1),
  gradeId: z.string().min(1),
  uomCode: z.string().min(1),
  qty: z.union([z.string(), z.number()]),
  unitPrice: z.union([z.string(), z.number()]),
  notes: z.string().optional().nullable(),
});

export const createCreditNoteSchema = z.object({
  customerId: z.string().min(1),
  warehouseId: z.string().min(1),
  invoiceId: z.string().optional().nullable(),
  deliveryClaimId: z.string().optional().nullable(),
  sourceType: z.enum(["sales_return", "quality_claim", "price_adjustment"]),
  reason: z.string().trim().min(3),
  issueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  lines: z.array(createCreditNoteLineSchema).min(1, "Nota kredit wajib memiliki minimal 1 baris item."),
});

export async function createCreditNote(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createCreditNoteSchema>,
) {
  authorize(ctx, "ar.invoice", { warehouseId: rawInput.warehouseId });
  const parsed = createCreditNoteSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, data.warehouseId))
    .limit(1);
  if (!wh) {
    throw new NotFoundError("Gudang tidak ditemukan.");
  }

  await lockCustomerForCreditCheck(tx, data.customerId);

  const creditNoteNo = await nextDocumentNumber(tx, {
    docType: "CN",
    warehouseCode: wh.code,
  });

  let totalAmount = new MoneyDecimal(0);
  const preparedLines = [];
  let lineNo = 1;

  for (const line of data.lines) {
    const [prod] = await tx
      .select()
      .from(products)
      .where(eq(products.id, line.productId))
      .limit(1);
    if (!prod) throw new NotFoundError(`Produk id '${line.productId}' tidak ditemukan.`);

    const [grd] = await tx
      .select()
      .from(productGrades)
      .where(eq(productGrades.id, line.gradeId))
      .limit(1);
    if (!grd) throw new NotFoundError(`Grade id '${line.gradeId}' tidak ditemukan.`);

    const qtyDec = parseQty(line.qty);
    const priceDec = parseMoney(line.unitPrice);
    const lineTotal = roundRupiah(qtyDec.times(priceDec));

    totalAmount = totalAmount.plus(lineTotal);
    preparedLines.push({
      lineNo,
      productId: prod.id,
      productNameSnapshot: prod.name,
      gradeId: grd.id,
      gradeCodeSnapshot: grd.code,
      uomCode: line.uomCode,
      qty: toDbQty(qtyDec),
      unitPrice: toDbUnitPrice(priceDec),
      lineTotalAmount: toDbAmount(lineTotal),
      notes: line.notes ?? null,
    });
    lineNo++;
  }

  const cnId = `ccn_${crypto.randomUUID().slice(0, 8)}`;
  const [createdCn] = await tx
    .insert(customerCreditNotes)
    .values({
      id: cnId,
      creditNoteNo,
      customerId: data.customerId,
      warehouseId: data.warehouseId,
      invoiceId: data.invoiceId ?? null,
      deliveryClaimId: data.deliveryClaimId ?? null,
      sourceType: data.sourceType,
      issueDate: data.issueDate ?? businessDate(),
      status: "draft",
      totalAmount: toDbAmount(totalAmount),
      appliedAmount: "0.00",
      unappliedAmount: toDbAmount(totalAmount),
      reason: data.reason,
      createdBy: ctx.user.id,
    })
    .returning();

  for (const l of preparedLines) {
    await tx.insert(customerCreditNoteLines).values({
      id: `ccnl_${crypto.randomUUID().slice(0, 8)}`,
      creditNoteId: cnId,
      ...l,
    });
  }

  await recordAudit(tx, {
    ctx,
    action: "customer_credit_note.create",
    entityType: "customer_credit_note",
    entityId: cnId,
    warehouseId: data.warehouseId,
    afterData: createdCn,
  });

  return createdCn!;
}

export async function approveCreditNote(
  tx: DbExecutor,
  ctx: ActorContext,
  input: {
    creditNoteId: string;
    invoiceId?: string;
    reason: string;
  },
) {
  await tx.execute(sql`SELECT id FROM customer_credit_notes WHERE id = ${input.creditNoteId} FOR UPDATE`);
  const [cn] = await tx
    .select()
    .from(customerCreditNotes)
    .where(eq(customerCreditNotes.id, input.creditNoteId))
    .limit(1);

  if (!cn) {
    throw new NotFoundError("Nota kredit tidak ditemukan.");
  }
  authorize(ctx, "ar.invoice", { warehouseId: cn.warehouseId });

  if (cn.status !== "draft") {
    throw new BusinessRuleError(
      `Nota kredit ${cn.creditNoteNo} berstatus '${cn.status}' dan tidak dapat disetujui ulang.`,
    );
  }

  const [cust] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, cn.customerId))
    .limit(1);
  if (!cust) throw new NotFoundError("Pelanggan tidak ditemukan.");

  const cnAmount = new MoneyDecimal(cn.totalAmount);
  let appliedDec = new MoneyDecimal(0);
  let unappliedDec = cnAmount;
  const targetInvoiceId = input.invoiceId ?? cn.invoiceId ?? null;

  if (targetInvoiceId) {
    await tx.execute(sql`SELECT id FROM customer_invoices WHERE id = ${targetInvoiceId} FOR UPDATE`);
    const [inv] = await tx
      .select()
      .from(customerInvoices)
      .where(eq(customerInvoices.id, targetInvoiceId))
      .limit(1);

    if (!inv) throw new NotFoundError("Invoice target nota kredit tidak ditemukan.");
    if (inv.customerId !== cn.customerId) {
      throw new BusinessRuleError("Invoice target harus milik pelanggan yang sama.");
    }
    if (inv.status === "draft" || inv.status === "cancelled") {
      throw new BusinessRuleError(
        `Faktur target ${inv.invoiceNo} berstatus '${inv.status}' dan tidak dapat menerima alokasi nota kredit.`,
      );
    }
    const outstandingDec = new MoneyDecimal(inv.outstandingAmount);
    appliedDec = MoneyDecimal.min(cnAmount, outstandingDec);
    unappliedDec = roundRupiah(cnAmount.minus(appliedDec));

    const newApplied = new MoneyDecimal(inv.creditNoteAppliedAmount).plus(appliedDec);
    const newOutstanding = outstandingDec.minus(appliedDec);
    const newStatus = newOutstanding.eq(0) ? "paid" : "partially_paid";

    await tx
      .update(customerInvoices)
      .set({
        creditNoteAppliedAmount: toDbAmount(newApplied),
        outstandingAmount: toDbAmount(newOutstanding),
        status: newStatus,
        updatedAt: new Date(),
      })
      .where(eq(customerInvoices.id, inv.id));
  }

  // Balanced GL entry for Credit Note:
  // Debit 4200 Potongan & Penyesuaian Penjualan / Klaim (cnAmount)
  // Credit 1120 Piutang Usaha Pelanggan (appliedDec, if > 0)
  // Credit 2130 Uang Muka / Kelebihan Pembayaran (unappliedDec, if > 0)
  const journalLinesInput: JournalLineInput[] = [
    {
      accountCode: GL_ACCOUNT_CODES.SALES_DISCOUNT_EXPENSE,
      debit: toDbAmount(cnAmount),
      description: `Beban Klaim / Penyesuaian Nota Kredit ${cn.creditNoteNo} - ${cn.reason}`,
      warehouseId: cn.warehouseId,
    },
  ];

  if (appliedDec.gt(0)) {
    journalLinesInput.push({
      accountCode: GL_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
      credit: toDbAmount(appliedDec),
      description: `Pengurangan Piutang via Nota Kredit ${cn.creditNoteNo}`,
      warehouseId: cn.warehouseId,
    });
  }

  if (unappliedDec.gt(0)) {
    journalLinesInput.push({
      accountCode: GL_ACCOUNT_CODES.UNAPPLIED_CUSTOMER_CASH,
      credit: toDbAmount(unappliedDec),
      description: `Kredit Belum Teralokasi Nota Kredit ${cn.creditNoteNo}`,
      warehouseId: cn.warehouseId,
    });
  }

  const { entry } = await postJournalEntry(tx, ctx, {
    warehouseId: cn.warehouseId,
    sourceDocType: "CN",
    sourceDocId: cn.id,
    purpose: "credit_note_post",
    entryDate: cn.issueDate,
    memo: `Persetujuan Nota Kredit ${cn.creditNoteNo} kepada ${cust.name}`,
    lines: journalLinesInput,
    skipDirectPermissionCheck: true,
  });

  const [updatedCn] = await tx
    .update(customerCreditNotes)
    .set({
      status: appliedDec.gt(0) && unappliedDec.eq(0) ? "applied" : "approved",
      appliedAmount: toDbAmount(appliedDec),
      unappliedAmount: toDbAmount(unappliedDec),
      appliedToInvoiceId: targetInvoiceId,
      glJournalId: entry.id,
      approvedBy: ctx.user.id,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(customerCreditNotes.id, cn.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "customer_credit_note.approve",
    entityType: "customer_credit_note",
    entityId: cn.id,
    warehouseId: cn.warehouseId,
    beforeData: cn,
    afterData: updatedCn,
    reason: input.reason,
  });

  return updatedCn! as typeof customerCreditNotes.$inferSelect;
}

export async function listCreditNotes(
  db: DbExecutor,
  filters: {
    customerId?: string;
    warehouseId?: string;
    status?: string;
    limit?: number;
  } = {},
  ctx?: ActorContext,
) {
  if (ctx) {
    authorize(ctx, "ar.read", filters.warehouseId ? { warehouseId: filters.warehouseId } : undefined);
  }
  const conditions = [];
  if (filters.customerId) conditions.push(eq(customerCreditNotes.customerId, filters.customerId));
  if (filters.warehouseId) conditions.push(eq(customerCreditNotes.warehouseId, filters.warehouseId));
  if (filters.status) {
    conditions.push(
      eq(
        customerCreditNotes.status,
        filters.status as "draft" | "approved" | "applied" | "cancelled",
      ),
    );
  }

  return db
    .select({
      id: customerCreditNotes.id,
      creditNoteNo: customerCreditNotes.creditNoteNo,
      customerId: customerCreditNotes.customerId,
      customerName: customers.name,
      customerCode: customers.code,
      warehouseId: customerCreditNotes.warehouseId,
      sourceType: customerCreditNotes.sourceType,
      issueDate: customerCreditNotes.issueDate,
      status: customerCreditNotes.status,
      totalAmount: customerCreditNotes.totalAmount,
      appliedAmount: customerCreditNotes.appliedAmount,
      unappliedAmount: customerCreditNotes.unappliedAmount,
      reason: customerCreditNotes.reason,
      createdAt: customerCreditNotes.createdAt,
    })
    .from(customerCreditNotes)
    .innerJoin(customers, eq(customers.id, customerCreditNotes.customerId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(customerCreditNotes.createdAt))
    .limit(filters.limit ?? 100);
}
