import crypto from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/server/audit";
import { authorize, hasPermission, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import { suppliers } from "@/server/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";

export const createSupplierSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{3,20}$/, "Kode supplier harus 3–20 karakter."),
  name: z.string().trim().min(2, "Nama supplier/petani minimal 2 karakter."),
  supplierType: z.enum(["petani", "kebun", "grosir", "importir", "koperasi"]),
  originRegion: z.string().trim().min(2, "Daerah asal pasokan wajib diisi."),
  contactPerson: z.string().trim().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  paymentTermsDays: z.number().int().min(0, "Termin pembayaran tidak boleh negatif.").default(0),
  bankName: z.string().trim().optional().nullable(),
  bankAccountNo: z.string().trim().optional().nullable(),
  bankAccountHolder: z.string().trim().optional().nullable(),
  npwp: z.string().trim().optional().nullable(),
  leadTimeDays: z.number().int().min(0).default(1),
});

export const updateSupplierSchema = createSupplierSchema.extend({
  id: z.string().min(1),
  isActive: z.boolean(),
  expectedVersion: z.number().int().positive(),
});

function maskSensitiveField(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

export async function createSupplier(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createSupplierSchema>,
) {
  authorize(ctx, "supplier.write");
  const parsed = createSupplierSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [dup] = await tx
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(eq(suppliers.code, data.code))
    .limit(1);
  if (dup) {
    throw new ConflictError(`Kode supplier '${data.code}' sudah digunakan.`);
  }

  const id = `sup_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(suppliers)
    .values({
      id,
      code: data.code,
      name: data.name,
      supplierType: data.supplierType,
      originRegion: data.originRegion,
      contactPerson: data.contactPerson ?? null,
      phone: data.phone ?? null,
      address: data.address ?? null,
      paymentTermsDays: data.paymentTermsDays,
      bankName: data.bankName ?? null,
      bankAccountNo: data.bankAccountNo ?? null,
      bankAccountHolder: data.bankAccountHolder ?? null,
      npwp: data.npwp ?? null,
      leadTimeDays: data.leadTimeDays,
      isActive: true,
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "supplier.create",
    entityType: "supplier",
    entityId: id,
    afterData: created,
  });

  return created!;
}

export async function updateSupplier(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof updateSupplierSchema>,
) {
  authorize(ctx, "supplier.write");
  const parsed = updateSupplierSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [existing] = await tx.select().from(suppliers).where(eq(suppliers.id, data.id)).limit(1);
  if (!existing) {
    throw new NotFoundError("Supplier tidak ditemukan.");
  }

  const [updated] = await tx
    .update(suppliers)
    .set({
      code: data.code,
      name: data.name,
      supplierType: data.supplierType,
      originRegion: data.originRegion,
      contactPerson: data.contactPerson ?? null,
      phone: data.phone ?? null,
      address: data.address ?? null,
      paymentTermsDays: data.paymentTermsDays,
      bankName: data.bankName ?? null,
      bankAccountNo: data.bankAccountNo ?? null,
      bankAccountHolder: data.bankAccountHolder ?? null,
      npwp: data.npwp ?? null,
      leadTimeDays: data.leadTimeDays,
      isActive: data.isActive,
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(suppliers.id, data.id), eq(suppliers.version, data.expectedVersion)))
    .returning();

  if (!updated) {
    throw new ConflictError("Data supplier telah diubah oleh pengguna lain.");
  }

  await recordAudit(tx, {
    ctx,
    action: "supplier.update",
    entityType: "supplier",
    entityId: updated.id,
    beforeData: existing,
    afterData: updated,
  });

  return updated;
}

export async function listSuppliers(db: DbExecutor, ctx: ActorContext) {
  authorize(ctx, "supplier.read");
  const canReadBank = hasPermission(ctx, "supplier.read_bank");
  const rows = await db.select().from(suppliers).orderBy(asc(suppliers.code));
  if (canReadBank) return rows;
  return rows.map((r) => ({
    ...r,
    bankAccountNo: maskSensitiveField(r.bankAccountNo),
    npwp: maskSensitiveField(r.npwp),
  }));
}
