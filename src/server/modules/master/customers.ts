import crypto from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { parseMoney, toDbAmount } from "@/lib/money";
import { recordAudit } from "@/server/audit";
import { authorize, hasPermission, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import {
  auditLogs,
  customerContacts,
  customerCreditNotes,
  customerInvoices,
  customerPayments,
  customers,
  deliveryZones,
  salesOrders,
  salesQuotations,
} from "@/server/db/schema";
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/server/errors";
import { calculateCustomerCreditExposure } from "@/server/modules/finance/credit";
import { getSetting } from "@/server/settings";

export const DEFAULT_BEKASI_ZONES = [
  {
    id: "zone_bks_timur",
    code: "BKS-TIMUR",
    name: "Bekasi Timur & Rawalumbu",
    city: "Kota Bekasi",
    minOrderAmount: "300000.00",
    defaultDeliveryFee: "25000.00",
  },
  {
    id: "zone_bks_barat",
    code: "BKS-BARAT",
    name: "Bekasi Barat, Kranji & Medan Satria",
    city: "Kota Bekasi",
    minOrderAmount: "400000.00",
    defaultDeliveryFee: "35000.00",
  },
  {
    id: "zone_bks_selatan",
    code: "BKS-SELATAN",
    name: "Bekasi Selatan, Galaxy & Jatiasih",
    city: "Kota Bekasi",
    minOrderAmount: "350000.00",
    defaultDeliveryFee: "30000.00",
  },
  {
    id: "zone_bks_utara",
    code: "BKS-UTARA",
    name: "Bekasi Utara & Summarecon",
    city: "Kota Bekasi",
    minOrderAmount: "350000.00",
    defaultDeliveryFee: "30000.00",
  },
  {
    id: "zone_tambun_cibitung",
    code: "KAB-TAMBUN-CBT",
    name: "Tambun, Cibitung & Pasar Induk Cibitung",
    city: "Kab. Bekasi",
    minOrderAmount: "500000.00",
    defaultDeliveryFee: "40000.00",
  },
  {
    id: "zone_cikarang",
    code: "KAB-CIKARANG",
    name: "Cikarang, Jababeka & Lippo Cikarang",
    city: "Kab. Bekasi",
    minOrderAmount: "750000.00",
    defaultDeliveryFee: "60000.00",
  },
] as const;

export async function seedDefaultBekasiZones(tx: DbExecutor): Promise<void> {
  for (const z of DEFAULT_BEKASI_ZONES) {
    await tx.insert(deliveryZones).values(z).onConflictDoNothing({ target: deliveryZones.code });
  }
}

export const createCustomerSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{3,20}$/, "Kode pelanggan harus 3–20 karakter."),
  name: z.string().trim().min(2, "Nama pelanggan/usaha minimal 2 karakter."),
  segment: z.enum([
    "toko_buah",
    "pedagang_pasar",
    "ritel_reseller",
    "horeca",
    "kedai_jus",
    "korporat",
    "konsumen_langsung",
  ]),
  priceTier: z.enum(["grosir", "semi_grosir", "ritel", "horeca"]).default("grosir"),
  contactPerson: z.string().trim().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  whatsapp: z.string().trim().optional().nullable(),
  email: z.string().trim().email("Format email tidak valid.").optional().nullable().or(z.literal("")),
  shippingAddress: z.string().trim().min(5, "Alamat kirim minimal 5 karakter."),
  billingAddress: z.string().trim().optional().nullable(),
  deliveryZoneId: z.string().optional().nullable(),
  assignedWarehouseId: z.string().optional().nullable(),
  paymentTermsDays: z.number().int().min(0).default(0),
  creditLimit: z.string().default("0"),
  npwp: z.string().trim().optional().nullable(),
  marketingConsent: z.boolean().default(false),
  operationalConsent: z.boolean().default(true),
});

export const updateCustomerSchema = createCustomerSchema
  .omit({ creditLimit: true })
  .extend({
    id: z.string().min(1),
    isActive: z.boolean(),
    expectedVersion: z.number().int().positive(),
  });

export const updateCreditPolicySchema = z.object({
  customerId: z.string().min(1),
  creditLimit: z.string().min(1),
  paymentTermsDays: z.number().int().min(0),
  creditHold: z.boolean(),
  reason: z.string().trim().min(3, "Alasan perubahan batas kredit wajib diisi."),
  expectedVersion: z.number().int().positive(),
});

export const addCustomerContactSchema = z.object({
  customerId: z.string().min(1),
  name: z.string().trim().min(2, "Nama kontak minimal 2 karakter."),
  roleTitle: z.string().trim().min(2, "Jabatan/peran kontak minimal 2 karakter."),
  phone: z.string().trim().optional().nullable(),
  whatsapp: z.string().trim().optional().nullable(),
  email: z.string().trim().email("Format email tidak valid.").optional().nullable().or(z.literal("")),
  isPrimary: z.boolean().default(false),
});

function maskPhoneOrEmail(val: string | null): string | null {
  if (!val) return null;
  if (val.length <= 4) return "****";
  return `${val.slice(0, 2)}****${val.slice(-2)}`;
}

export async function createCustomer(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createCustomerSchema>,
) {
  const parsed = createCustomerSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  authorize(
    ctx,
    "customer.write",
    data.assignedWarehouseId ? { warehouseId: data.assignedWarehouseId } : undefined,
  );

  if (data.segment === "konsumen_langsung") {
    const directFlag = await getSetting<{ enabled: boolean }>(tx, "sales.enable_direct_consumer");
    if (!directFlag?.value?.enabled) {
      throw new BusinessRuleError(
        "Segmen Konsumen Langsung (B2C) sedang dinonaktifkan pada pengaturan bisnis.",
      );
    }
  }

  const creditLimit = parseMoney(data.creditLimit);
  if (creditLimit.lt(0)) {
    throw new BusinessRuleError("Batas kredit tidak boleh negatif.");
  }
  if (creditLimit.gt(0) || data.paymentTermsDays > 0) {
    if (!hasPermission(ctx, "customer.credit_manage")) {
      throw new ForbiddenError(
        "customer.credit_manage",
        "Penetapan batas kredit (credit limit > Rp 0) atau termin kredit memerlukan izin Keuangan / Pemilik.",
      );
    }
  }

  const [dup] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.code, data.code))
    .limit(1);
  if (dup) {
    throw new ConflictError(`Kode pelanggan '${data.code}' sudah digunakan.`);
  }

  const id = `cus_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(customers)
    .values({
      id,
      code: data.code,
      name: data.name,
      segment: data.segment,
      priceTier: data.priceTier,
      contactPerson: data.contactPerson ?? null,
      phone: data.phone ?? null,
      whatsapp: data.whatsapp ?? null,
      email: data.email ? data.email : null,
      shippingAddress: data.shippingAddress,
      billingAddress: data.billingAddress ?? null,
      deliveryZoneId: data.deliveryZoneId || null,
      assignedWarehouseId: data.assignedWarehouseId || null,
      paymentTermsDays: data.paymentTermsDays,
      creditLimit: toDbAmount(creditLimit),
      creditHold: false,
      npwp: data.npwp ?? null,
      marketingConsent: data.marketingConsent,
      operationalConsent: data.operationalConsent,
      isActive: true,
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "customer.create",
    entityType: "customer",
    entityId: id,
    afterData: created,
  });

  return created!;
}

export async function updateCustomer(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof updateCustomerSchema>,
) {
  const parsed = updateCustomerSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [existing] = await tx.select().from(customers).where(eq(customers.id, data.id)).limit(1);
  if (!existing) {
    throw new NotFoundError("Pelanggan tidak ditemukan.");
  }

  const targetWh = data.assignedWarehouseId ?? existing.assignedWarehouseId;
  authorize(ctx, "customer.write", targetWh ? { warehouseId: targetWh } : undefined);

  if (data.segment === "konsumen_langsung") {
    const directFlag = await getSetting<{ enabled: boolean }>(tx, "sales.enable_direct_consumer");
    if (!directFlag?.value?.enabled) {
      throw new BusinessRuleError(
        "Segmen Konsumen Langsung (B2C) sedang dinonaktifkan pada pengaturan bisnis.",
      );
    }
  }

  const [updated] = await tx
    .update(customers)
    .set({
      code: data.code,
      name: data.name,
      segment: data.segment,
      priceTier: data.priceTier,
      contactPerson: data.contactPerson ?? null,
      phone: data.phone ?? null,
      whatsapp: data.whatsapp ?? null,
      email: data.email ? data.email : null,
      shippingAddress: data.shippingAddress,
      billingAddress: data.billingAddress ?? null,
      deliveryZoneId: data.deliveryZoneId || null,
      assignedWarehouseId:
        data.assignedWarehouseId !== undefined
          ? data.assignedWarehouseId || null
          : existing.assignedWarehouseId,
      npwp: data.npwp ?? null,
      marketingConsent: data.marketingConsent,
      operationalConsent: data.operationalConsent,
      isActive: data.isActive,
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(customers.id, data.id), eq(customers.version, data.expectedVersion)))
    .returning();

  if (!updated) {
    throw new ConflictError("Data pelanggan telah diubah oleh pengguna lain.");
  }

  await recordAudit(tx, {
    ctx,
    action: "customer.update",
    entityType: "customer",
    entityId: updated.id,
    beforeData: existing,
    afterData: updated,
  });

  return updated;
}

export async function updateCustomerCreditPolicy(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof updateCreditPolicySchema>,
) {
  authorize(ctx, "customer.credit_manage");
  const parsed = updateCreditPolicySchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const creditLimit = parseMoney(data.creditLimit);
  if (creditLimit.lt(0)) {
    throw new BusinessRuleError("Batas kredit tidak boleh negatif.");
  }

  const [existing] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, data.customerId))
    .limit(1);
  if (!existing) {
    throw new NotFoundError("Pelanggan tidak ditemukan.");
  }

  const [updated] = await tx
    .update(customers)
    .set({
      creditLimit: toDbAmount(creditLimit),
      paymentTermsDays: data.paymentTermsDays,
      creditHold: data.creditHold,
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(customers.id, data.customerId), eq(customers.version, data.expectedVersion)))
    .returning();

  if (!updated) {
    throw new ConflictError("Data kredit pelanggan telah diubah oleh pengguna lain.");
  }

  await recordAudit(tx, {
    ctx,
    action: "customer.credit_change",
    entityType: "customer",
    entityId: updated.id,
    beforeData: {
      creditLimit: existing.creditLimit,
      paymentTermsDays: existing.paymentTermsDays,
      creditHold: existing.creditHold,
    },
    afterData: {
      creditLimit: updated.creditLimit,
      paymentTermsDays: updated.paymentTermsDays,
      creditHold: updated.creditHold,
    },
    reason: data.reason,
  });

  return updated;
}

export async function addCustomerContact(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof addCustomerContactSchema>,
) {
  const parsed = addCustomerContactSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [customer] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, data.customerId))
    .limit(1);
  if (!customer) {
    throw new NotFoundError("Pelanggan tidak ditemukan.");
  }

  authorize(
    ctx,
    "customer.write",
    customer.assignedWarehouseId ? { warehouseId: customer.assignedWarehouseId } : undefined,
  );

  if (data.isPrimary) {
    await tx
      .update(customerContacts)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(eq(customerContacts.customerId, customer.id));
  }

  const id = `ccon_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(customerContacts)
    .values({
      id,
      customerId: customer.id,
      name: data.name,
      roleTitle: data.roleTitle,
      phone: data.phone ?? null,
      whatsapp: data.whatsapp ?? null,
      email: data.email ? data.email : null,
      isPrimary: data.isPrimary,
      isActive: true,
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "customer_contact.create",
    entityType: "customer_contact",
    entityId: id,
    afterData: created,
  });

  return created!;
}

export async function getCustomerCrmProfile(
  db: DbExecutor,
  ctx: ActorContext,
  customerId: string,
) {
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!customer) {
    throw new NotFoundError("Pelanggan tidak ditemukan.");
  }

  authorize(
    ctx,
    "customer.read",
    customer.assignedWarehouseId ? { warehouseId: customer.assignedWarehouseId } : undefined,
  );

  const canReadPii = hasPermission(ctx, "customer.read_pii");
  const contacts = await db
    .select()
    .from(customerContacts)
    .where(eq(customerContacts.customerId, customerId))
    .orderBy(desc(customerContacts.isPrimary), asc(customerContacts.name));

  const quotations = await db
    .select()
    .from(salesQuotations)
    .where(eq(salesQuotations.customerId, customerId))
    .orderBy(desc(salesQuotations.createdAt));

  const orders = await db
    .select()
    .from(salesOrders)
    .where(eq(salesOrders.customerId, customerId))
    .orderBy(desc(salesOrders.createdAt));

  const invoices = await db
    .select()
    .from(customerInvoices)
    .where(eq(customerInvoices.customerId, customerId))
    .orderBy(desc(customerInvoices.createdAt));

  const payments = await db
    .select()
    .from(customerPayments)
    .where(eq(customerPayments.customerId, customerId))
    .orderBy(desc(customerPayments.createdAt));

  const creditNotes = await db
    .select()
    .from(customerCreditNotes)
    .where(eq(customerCreditNotes.customerId, customerId))
    .orderBy(desc(customerCreditNotes.createdAt));

  const creditExposure = await calculateCustomerCreditExposure(db, customerId);

  const historyAuditLogs = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, "customer"), eq(auditLogs.entityId, customerId)))
    .orderBy(desc(auditLogs.occurredAt));

  const maskedCustomer = canReadPii
    ? customer
    : {
        ...customer,
        phone: maskPhoneOrEmail(customer.phone),
        whatsapp: maskPhoneOrEmail(customer.whatsapp),
        email: maskPhoneOrEmail(customer.email),
        npwp: maskPhoneOrEmail(customer.npwp),
      };

  const maskedContacts = canReadPii
    ? contacts
    : contacts.map((c) => ({
        ...c,
        phone: maskPhoneOrEmail(c.phone),
        whatsapp: maskPhoneOrEmail(c.whatsapp),
        email: maskPhoneOrEmail(c.email),
      }));

  return {
    customer: maskedCustomer,
    contacts: maskedContacts,
    quotations,
    orders,
    invoices,
    payments,
    creditNotes,
    creditExposure,
    auditHistory: historyAuditLogs,
  };
}

export async function listDeliveryZones(db: DbExecutor, ctx: ActorContext) {
  authorize(ctx, "customer.read");
  return db.select().from(deliveryZones).orderBy(asc(deliveryZones.code));
}

export async function listCustomers(
  db: DbExecutor,
  ctx: ActorContext,
  options?: { warehouseId?: string },
) {
  authorize(
    ctx,
    "customer.read",
    options?.warehouseId ? { warehouseId: options.warehouseId } : undefined,
  );
  const canReadPii = hasPermission(ctx, "customer.read_pii");
  const rows = options?.warehouseId
    ? await db
        .select()
        .from(customers)
        .where(eq(customers.assignedWarehouseId, options.warehouseId))
        .orderBy(asc(customers.code))
    : await db.select().from(customers).orderBy(asc(customers.code));

  if (canReadPii) return rows;
  return rows.map((r) => ({
    ...r,
    phone: maskPhoneOrEmail(r.phone),
    whatsapp: maskPhoneOrEmail(r.whatsapp),
    email: maskPhoneOrEmail(r.email),
    npwp: maskPhoneOrEmail(r.npwp),
  }));
}
