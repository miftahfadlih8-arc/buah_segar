import crypto from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { businessDate } from "@/lib/datetime";
import { MoneyDecimal, parseMoney, roundRupiah, toDbAmount, type Money } from "@/lib/money";
import { recordAudit } from "@/server/audit";
import { authorize, hasPermission, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import {
  customerCreditNotes,
  customerInvoices,
  customerPayments,
  customers,
  salesOrders,
  warehouses,
} from "@/server/db/schema";
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/server/errors";
import { nextDocumentNumber } from "@/server/sequences";

export const CREDIT_EXPOSURE_FORMULA =
  "NetCreditExposure = OutstandingInvoices + OpenUninvoicedCreditOrders - VerifiedUnappliedPayments - ApprovedUnappliedCreditNotes; AvailableCredit = CreditLimit - NetCreditExposure";

export const OPEN_CREDIT_ORDER_STATUSES = [
  "submitted",
  "confirmed",
  "picking",
  "packed",
  "shipped",
  "delivered",
] as const;

export interface CustomerCreditExposure {
  customerId: string;
  customerCode: string;
  customerName: string;
  creditLimit: string;
  creditHold: boolean;
  paymentTermsDays: number;
  outstandingInvoicesAmount: string;
  openUninvoicedCreditOrdersAmount: string;
  verifiedUnappliedPaymentsAmount: string;
  approvedUnappliedCreditNotesAmount: string;
  unverifiedPaymentsAmount: string;
  unapprovedCreditNotesAmount: string;
  netCreditExposure: string;
  availableCredit: string;
  formula: string;
}

export interface LockedCustomerCreditRow {
  id: string;
  code: string;
  name: string;
  segment: string;
  priceTier: string;
  creditLimit: string;
  creditHold: boolean;
  paymentTermsDays: number;
  assignedWarehouseId: string | null;
  isActive: boolean;
}

/**
 * Acquires a PostgreSQL row-level `FOR UPDATE` lock on the customer record.
 * Used during credit order creation/submission/confirmation to serialize concurrent
 * credit checks for the same customer.
 */
export async function lockCustomerForCreditCheck(
  tx: DbExecutor,
  customerId: string,
): Promise<LockedCustomerCreditRow> {
  const res = await tx.execute<{
    id: string;
    code: string;
    name: string;
    segment: string;
    price_tier: string;
    credit_limit: string;
    credit_hold: boolean;
    payment_terms_days: number;
    assigned_warehouse_id: string | null;
    is_active: boolean;
  }>(sql`
    SELECT
      id,
      code,
      name,
      segment,
      price_tier,
      credit_limit,
      credit_hold,
      payment_terms_days,
      assigned_warehouse_id,
      is_active
    FROM customers
    WHERE id = ${customerId}
    FOR UPDATE
  `);

  const row = res.rows[0];
  if (!row) {
    throw new NotFoundError(`Pelanggan '${customerId}' tidak ditemukan.`);
  }

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    segment: row.segment,
    priceTier: row.price_tier,
    creditLimit: row.credit_limit,
    creditHold: Boolean(row.credit_hold),
    paymentTermsDays: Number(row.payment_terms_days),
    assignedWarehouseId: row.assigned_warehouse_id,
    isActive: Boolean(row.is_active),
  };
}

/**
 * Calculates the exact net credit exposure and available credit for a customer.
 *
 * Explicit Formula:
 *   NetCreditExposure = OutstandingInvoices
 *                     + OpenUninvoicedCreditOrders
 *                     - VerifiedUnappliedPayments
 *                     - ApprovedUnappliedCreditNotes
 *   AvailableCredit   = CreditLimit - NetCreditExposure
 *
 * Rules:
 * - Unverified payments (`verification_status = 'pending_verification'`) DO NOT reduce exposure.
 * - Unapproved/draft returns or credit notes (`status = 'draft'`) DO NOT reduce exposure.
 */
export async function calculateCustomerCreditExposure(
  tx: DbExecutor,
  customerId: string,
  options?: { excludeSalesOrderId?: string },
): Promise<CustomerCreditExposure> {
  const [customer] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  if (!customer) {
    throw new NotFoundError(`Pelanggan '${customerId}' tidak ditemukan.`);
  }

  const openInvoices = await tx
    .select({
      outstandingAmount: customerInvoices.outstandingAmount,
    })
    .from(customerInvoices)
    .where(
      and(
        eq(customerInvoices.customerId, customerId),
        inArray(customerInvoices.status, ["posted", "partially_paid"]),
      ),
    );

  const outstandingInvoicesDec = openInvoices.reduce(
    (acc, inv) => acc.plus(new MoneyDecimal(inv.outstandingAmount)),
    new MoneyDecimal(0),
  );

  const orderConditions = [
    eq(salesOrders.customerId, customerId),
    eq(salesOrders.isCreditOrder, true),
    eq(salesOrders.isInvoiced, false),
    inArray(salesOrders.status, [...OPEN_CREDIT_ORDER_STATUSES]),
  ];
  if (options?.excludeSalesOrderId) {
    orderConditions.push(ne(salesOrders.id, options.excludeSalesOrderId));
  }

  const openOrders = await tx
    .select({
      grandTotalAmount: salesOrders.grandTotalAmount,
    })
    .from(salesOrders)
    .where(and(...orderConditions));

  const openOrdersDec = openOrders.reduce(
    (acc, ord) => acc.plus(new MoneyDecimal(ord.grandTotalAmount)),
    new MoneyDecimal(0),
  );

  const payments = await tx
    .select({
      unappliedAmount: customerPayments.unappliedAmount,
      amount: customerPayments.amount,
      verificationStatus: customerPayments.verificationStatus,
    })
    .from(customerPayments)
    .where(eq(customerPayments.customerId, customerId));

  let verifiedUnappliedPaymentsDec = new MoneyDecimal(0);
  let unverifiedPaymentsDec = new MoneyDecimal(0);
  for (const p of payments) {
    if (p.verificationStatus === "verified") {
      verifiedUnappliedPaymentsDec = verifiedUnappliedPaymentsDec.plus(
        new MoneyDecimal(p.unappliedAmount),
      );
    } else if (p.verificationStatus === "pending_verification") {
      unverifiedPaymentsDec = unverifiedPaymentsDec.plus(new MoneyDecimal(p.amount));
    }
  }

  const creditNotes = await tx
    .select({
      unappliedAmount: customerCreditNotes.unappliedAmount,
      totalAmount: customerCreditNotes.totalAmount,
      status: customerCreditNotes.status,
    })
    .from(customerCreditNotes)
    .where(eq(customerCreditNotes.customerId, customerId));

  let approvedUnappliedCreditNotesDec = new MoneyDecimal(0);
  let unapprovedCreditNotesDec = new MoneyDecimal(0);
  for (const cn of creditNotes) {
    if (cn.status === "approved") {
      approvedUnappliedCreditNotesDec = approvedUnappliedCreditNotesDec.plus(
        new MoneyDecimal(cn.unappliedAmount),
      );
    } else if (cn.status === "draft") {
      unapprovedCreditNotesDec = unapprovedCreditNotesDec.plus(new MoneyDecimal(cn.totalAmount));
    }
  }

  const creditLimitDec = roundRupiah(new MoneyDecimal(customer.creditLimit));
  const netCreditExposureDec = roundRupiah(
    outstandingInvoicesDec
      .plus(openOrdersDec)
      .minus(verifiedUnappliedPaymentsDec)
      .minus(approvedUnappliedCreditNotesDec),
  );
  const availableCreditDec = roundRupiah(creditLimitDec.minus(netCreditExposureDec));

  return {
    customerId: customer.id,
    customerCode: customer.code,
    customerName: customer.name,
    creditLimit: toDbAmount(creditLimitDec),
    creditHold: customer.creditHold,
    paymentTermsDays: customer.paymentTermsDays,
    outstandingInvoicesAmount: toDbAmount(outstandingInvoicesDec),
    openUninvoicedCreditOrdersAmount: toDbAmount(openOrdersDec),
    verifiedUnappliedPaymentsAmount: toDbAmount(verifiedUnappliedPaymentsDec),
    approvedUnappliedCreditNotesAmount: toDbAmount(approvedUnappliedCreditNotesDec),
    unverifiedPaymentsAmount: toDbAmount(unverifiedPaymentsDec),
    unapprovedCreditNotesAmount: toDbAmount(unapprovedCreditNotesDec),
    netCreditExposure: toDbAmount(netCreditExposureDec),
    availableCredit: toDbAmount(availableCreditDec),
    formula: CREDIT_EXPOSURE_FORMULA,
  };
}

export interface CreditCheckEvaluationResult {
  allowedWithoutOverride: boolean;
  requiresCreditApproval: boolean;
  violationReasons: string[];
  exposureBeforeOrder: CustomerCreditExposure;
  projectedNetExposure: string;
  projectedAvailableCredit: string;
}

export async function evaluateOrderCreditCheck(
  tx: DbExecutor,
  input: {
    customerId: string;
    orderGrandTotal: Money;
    isCreditOrder: boolean;
    excludeSalesOrderId?: string;
    lockCustomerRow?: boolean;
  },
): Promise<CreditCheckEvaluationResult> {
  if (input.lockCustomerRow !== false) {
    await lockCustomerForCreditCheck(tx, input.customerId);
  }

  const exposure = await calculateCustomerCreditExposure(tx, input.customerId, {
    excludeSalesOrderId: input.excludeSalesOrderId,
  });

  const orderTotal = roundRupiah(input.orderGrandTotal);
  if (!input.isCreditOrder) {
    return {
      allowedWithoutOverride: true,
      requiresCreditApproval: false,
      violationReasons: [],
      exposureBeforeOrder: exposure,
      projectedNetExposure: exposure.netCreditExposure,
      projectedAvailableCredit: exposure.availableCredit,
    };
  }

  const currentExposureDec = new MoneyDecimal(exposure.netCreditExposure);
  const creditLimitDec = new MoneyDecimal(exposure.creditLimit);
  const projectedExposureDec = roundRupiah(currentExposureDec.plus(orderTotal));
  const projectedAvailableDec = roundRupiah(creditLimitDec.minus(projectedExposureDec));

  const violationReasons: string[] = [];
  if (exposure.creditHold) {
    violationReasons.push(
      `Pelanggan '${exposure.customerCode}' sedang dalam status Credit Hold.`,
    );
  }
  if (creditLimitDec.lte(0)) {
    violationReasons.push(
      `Pelanggan '${exposure.customerCode}' tidak memiliki fasilitas batas kredit aktif (Credit Limit = Rp ${toDbAmount(creditLimitDec)}).`,
    );
  } else if (projectedExposureDec.gt(creditLimitDec)) {
    violationReasons.push(
      `Eksposur kredit proyeksi Rp ${toDbAmount(projectedExposureDec)} melebihi batas kredit Rp ${toDbAmount(creditLimitDec)} (Available Credit sebelum order: Rp ${exposure.availableCredit}).`,
    );
  }

  return {
    allowedWithoutOverride: violationReasons.length === 0,
    requiresCreditApproval: violationReasons.length > 0,
    violationReasons,
    exposureBeforeOrder: exposure,
    projectedNetExposure: toDbAmount(projectedExposureDec),
    projectedAvailableCredit: toDbAmount(projectedAvailableDec),
  };
}

export const createCustomerInvoiceSchema = z.object({
  customerId: z.string().min(1),
  warehouseId: z.string().min(1),
  salesOrderId: z.string().optional().nullable(),
  invoiceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalAmount: z.string().min(1),
  notes: z.string().trim().optional().nullable(),
});

export async function createCustomerInvoice(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createCustomerInvoiceSchema>,
) {
  authorize(ctx, "ar.collect", { warehouseId: rawInput.warehouseId });
  const parsed = createCustomerInvoiceSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  await lockCustomerForCreditCheck(tx, data.customerId);

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, data.warehouseId))
    .limit(1);
  if (!wh) {
    throw new NotFoundError("Gudang tidak ditemukan.");
  }

  const totalAmount = roundRupiah(parseMoney(data.totalAmount));
  if (totalAmount.lte(0)) {
    throw new BusinessRuleError("Total nominal invoice harus lebih besar dari Rp 0.");
  }

  if (data.salesOrderId) {
    const [so] = await tx
      .select()
      .from(salesOrders)
      .where(eq(salesOrders.id, data.salesOrderId))
      .limit(1);
    if (!so) {
      throw new NotFoundError("Sales order referensi invoice tidak ditemukan.");
    }
    if (so.customerId !== data.customerId) {
      throw new BusinessRuleError("Pelanggan pada invoice harus sama dengan pelanggan pada sales order.");
    }
    if (so.isInvoiced) {
      throw new BusinessRuleError(`Sales order '${so.soNumber}' sudah ditagihkan sebelumnya.`);
    }
    await tx
      .update(salesOrders)
      .set({
        isInvoiced: true,
        status: "invoiced",
        version: so.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(salesOrders.id, so.id));
  }

  const invoiceNo = await nextDocumentNumber(tx, {
    docType: "INV",
    warehouseCode: wh.code,
  });

  const id = `cinv_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(customerInvoices)
    .values({
      id,
      invoiceNo,
      salesOrderId: data.salesOrderId ?? null,
      customerId: data.customerId,
      warehouseId: data.warehouseId,
      invoiceDate: data.invoiceDate ?? businessDate(),
      dueDate: data.dueDate,
      status: "posted",
      totalAmount: toDbAmount(totalAmount),
      paidAmount: "0.00",
      creditNoteAppliedAmount: "0.00",
      outstandingAmount: toDbAmount(totalAmount),
      notes: data.notes ?? null,
      createdBy: ctx.user.id,
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "customer_invoice.create",
    entityType: "customer_invoice",
    entityId: id,
    afterData: created,
  });

  return created!;
}

export const recordCustomerPaymentSchema = z.object({
  customerId: z.string().min(1),
  warehouseId: z.string().min(1),
  invoiceId: z.string().optional().nullable(),
  paymentType: z.enum(["invoice_payment", "deposit"]).default("invoice_payment"),
  paymentMethod: z.enum(["bank_transfer", "cash", "giro", "qris"]).default("bank_transfer"),
  paymentDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  amount: z.string().min(1),
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

  await lockCustomerForCreditCheck(tx, data.customerId);

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, data.warehouseId))
    .limit(1);
  if (!wh) {
    throw new NotFoundError("Gudang tidak ditemukan.");
  }

  const amount = roundRupiah(parseMoney(data.amount));
  if (amount.lte(0)) {
    throw new BusinessRuleError("Nominal pembayaran/deposit harus lebih besar dari Rp 0.");
  }

  const paymentNo = await nextDocumentNumber(tx, {
    docType: "PAY",
    warehouseCode: wh.code,
  });

  const id = `cpay_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(customerPayments)
    .values({
      id,
      paymentNo,
      customerId: data.customerId,
      warehouseId: data.warehouseId,
      invoiceId: data.invoiceId ?? null,
      paymentType: data.paymentType,
      paymentMethod: data.paymentMethod,
      paymentDate: data.paymentDate ?? businessDate(),
      amount: toDbAmount(amount),
      appliedAmount: "0.00",
      unappliedAmount: toDbAmount(amount),
      verificationStatus: "pending_verification",
      referenceNo: data.referenceNo ?? null,
      notes: data.notes ?? null,
      createdBy: ctx.user.id,
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "customer_payment.record",
    entityType: "customer_payment",
    entityId: id,
    afterData: created,
  });

  if (data.autoVerify) {
    return verifyCustomerPayment(tx, ctx, {
      paymentId: id,
      reason: "Verifikasi langsung saat pencatatan pembayaran oleh Keuangan.",
    });
  }

  return created!;
}

export const verifyCustomerPaymentSchema = z.object({
  paymentId: z.string().min(1),
  reason: z.string().trim().min(3, "Catatan verifikasi pembayaran minimal 3 karakter."),
});

export async function verifyCustomerPayment(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof verifyCustomerPaymentSchema>,
) {
  if (!hasPermission(ctx, "customer.credit_manage") && !hasPermission(ctx, "ar.collect")) {
    throw new ForbiddenError(
      "customer.credit_manage",
      "Verifikasi pembayaran pelanggan memerlukan otorisasi Keuangan atau Pemilik.",
    );
  }
  const parsed = verifyCustomerPaymentSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [payment] = await tx
    .select()
    .from(customerPayments)
    .where(eq(customerPayments.id, data.paymentId))
    .limit(1);
  if (!payment) {
    throw new NotFoundError("Data pembayaran pelanggan tidak ditemukan.");
  }
  if (payment.verificationStatus === "verified") {
    throw new BusinessRuleError(`Pembayaran '${payment.paymentNo}' sudah diverifikasi sebelumnya.`);
  }
  if (payment.verificationStatus === "rejected") {
    throw new BusinessRuleError(`Pembayaran '${payment.paymentNo}' sudah ditolak.`);
  }

  await lockCustomerForCreditCheck(tx, payment.customerId);

  const amountDec = new MoneyDecimal(payment.amount);
  let appliedDec = new MoneyDecimal(0);
  let unappliedDec = amountDec;

  if (payment.invoiceId) {
    const [inv] = await tx
      .select()
      .from(customerInvoices)
      .where(eq(customerInvoices.id, payment.invoiceId))
      .limit(1);
    if (!inv) {
      throw new NotFoundError("Invoice target pembayaran tidak ditemukan.");
    }
    if (inv.customerId !== payment.customerId) {
      throw new BusinessRuleError("Invoice target harus milik pelanggan yang sama.");
    }

    const outstandingDec = new MoneyDecimal(inv.outstandingAmount);
    appliedDec = MoneyDecimal.min(amountDec, outstandingDec);
    unappliedDec = roundRupiah(amountDec.minus(appliedDec));

    const newPaidDec = roundRupiah(new MoneyDecimal(inv.paidAmount).plus(appliedDec));
    const newOutstandingDec = roundRupiah(outstandingDec.minus(appliedDec));
    const newStatus = newOutstandingDec.eq(0) ? "paid" : "partially_paid";

    await tx
      .update(customerInvoices)
      .set({
        paidAmount: toDbAmount(newPaidDec),
        outstandingAmount: toDbAmount(newOutstandingDec),
        status: newStatus,
        updatedAt: new Date(),
      })
      .where(eq(customerInvoices.id, inv.id));
  }

  const [updated] = await tx
    .update(customerPayments)
    .set({
      appliedAmount: toDbAmount(appliedDec),
      unappliedAmount: toDbAmount(unappliedDec),
      verificationStatus: "verified",
      verifiedBy: ctx.user.id,
      verifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(customerPayments.id, payment.id))
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "customer_payment.verify",
    entityType: "customer_payment",
    entityId: payment.id,
    beforeData: payment,
    afterData: updated,
    reason: data.reason,
  });

  return updated!;
}

export const createCustomerCreditNoteSchema = z.object({
  customerId: z.string().min(1),
  warehouseId: z.string().min(1),
  invoiceId: z.string().optional().nullable(),
  sourceType: z.enum(["sales_return", "quality_claim", "price_adjustment"]).default("sales_return"),
  issueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  totalAmount: z.string().min(1),
  reason: z.string().trim().min(3, "Alasan retur / credit note wajib diisi."),
  autoApprove: z.boolean().default(false),
});

export async function createCustomerCreditNote(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createCustomerCreditNoteSchema>,
) {
  authorize(ctx, "returns.write", { warehouseId: rawInput.warehouseId });
  const parsed = createCustomerCreditNoteSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  await lockCustomerForCreditCheck(tx, data.customerId);

  const [wh] = await tx
    .select()
    .from(warehouses)
    .where(eq(warehouses.id, data.warehouseId))
    .limit(1);
  if (!wh) {
    throw new NotFoundError("Gudang tidak ditemukan.");
  }

  const totalAmount = roundRupiah(parseMoney(data.totalAmount));
  if (totalAmount.lte(0)) {
    throw new BusinessRuleError("Nominal credit note / retur harus lebih besar dari Rp 0.");
  }

  const creditNoteNo = await nextDocumentNumber(tx, {
    docType: "CN",
    warehouseCode: wh.code,
  });

  const id = `ccn_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(customerCreditNotes)
    .values({
      id,
      creditNoteNo,
      customerId: data.customerId,
      warehouseId: data.warehouseId,
      invoiceId: data.invoiceId ?? null,
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

  await recordAudit(tx, {
    ctx,
    action: "customer_credit_note.create",
    entityType: "customer_credit_note",
    entityId: id,
    afterData: created,
    reason: data.reason,
  });

  if (data.autoApprove) {
    return approveCustomerCreditNote(tx, ctx, {
      creditNoteId: id,
      reason: "Persetujuan langsung credit note oleh Keuangan/Pemilik.",
    });
  }

  return created!;
}

export const approveCustomerCreditNoteSchema = z.object({
  creditNoteId: z.string().min(1),
  reason: z.string().trim().min(3, "Catatan persetujuan credit note minimal 3 karakter."),
});

export async function approveCustomerCreditNote(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof approveCustomerCreditNoteSchema>,
) {
  if (!hasPermission(ctx, "customer.credit_manage") && !hasPermission(ctx, "approvals.decide")) {
    throw new ForbiddenError(
      "customer.credit_manage",
      "Persetujuan retur / credit note memerlukan otorisasi Keuangan atau Pemilik.",
    );
  }
  const parsed = approveCustomerCreditNoteSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [cn] = await tx
    .select()
    .from(customerCreditNotes)
    .where(eq(customerCreditNotes.id, data.creditNoteId))
    .limit(1);
  if (!cn) {
    throw new NotFoundError("Data credit note tidak ditemukan.");
  }
  if (cn.status !== "draft") {
    throw new BusinessRuleError(`Credit note '${cn.creditNoteNo}' sudah berstatus '${cn.status}'.`);
  }

  await lockCustomerForCreditCheck(tx, cn.customerId);

  const totalDec = new MoneyDecimal(cn.totalAmount);
  let appliedDec = new MoneyDecimal(0);
  let unappliedDec = totalDec;

  if (cn.invoiceId) {
    const [inv] = await tx
      .select()
      .from(customerInvoices)
      .where(eq(customerInvoices.id, cn.invoiceId))
      .limit(1);
    if (!inv) {
      throw new NotFoundError("Invoice referensi credit note tidak ditemukan.");
    }
    if (inv.customerId !== cn.customerId) {
      throw new BusinessRuleError("Invoice referensi harus milik pelanggan yang sama.");
    }

    const outstandingDec = new MoneyDecimal(inv.outstandingAmount);
    appliedDec = MoneyDecimal.min(totalDec, outstandingDec);
    unappliedDec = roundRupiah(totalDec.minus(appliedDec));

    const newCnAppliedDec = roundRupiah(
      new MoneyDecimal(inv.creditNoteAppliedAmount).plus(appliedDec),
    );
    const newOutstandingDec = roundRupiah(outstandingDec.minus(appliedDec));
    const newStatus = newOutstandingDec.eq(0) ? "paid" : "partially_paid";

    await tx
      .update(customerInvoices)
      .set({
        creditNoteAppliedAmount: toDbAmount(newCnAppliedDec),
        outstandingAmount: toDbAmount(newOutstandingDec),
        status: newStatus,
        updatedAt: new Date(),
      })
      .where(eq(customerInvoices.id, inv.id));
  }

  const [updated] = await tx
    .update(customerCreditNotes)
    .set({
      appliedAmount: toDbAmount(appliedDec),
      unappliedAmount: toDbAmount(unappliedDec),
      status: "approved",
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
    beforeData: cn,
    afterData: updated,
    reason: data.reason,
  });

  return updated!;
}
