import crypto from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/server/audit";
import { authorize, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import { branches, warehouseLocations, warehouses } from "@/server/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";

export const createWarehouseSchema = z.object({
  branchId: z.string().min(1, "Cabang wajib dipilih."),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,12}$/, "Kode gudang harus 2–12 karakter huruf/angka."),
  name: z.string().trim().min(3, "Nama gudang minimal 3 karakter."),
  address: z.string().trim().min(5, "Alamat gudang minimal 5 karakter."),
  isDefault: z.boolean().optional().default(false),
});

export const updateWarehouseSchema = createWarehouseSchema.extend({
  id: z.string().min(1),
  isActive: z.boolean(),
  expectedVersion: z.number().int().positive(),
});

export const createLocationSchema = z.object({
  warehouseId: z.string().min(1, "Gudang wajib dipilih."),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,16}$/, "Kode lokasi harus 2–16 karakter."),
  name: z.string().trim().min(2, "Nama lokasi minimal 2 karakter."),
  zoneType: z.enum(["receiving", "cold_room", "ambient", "quarantine", "dispatch", "reject"]),
  temperatureMinC: z.string().optional().nullable(),
  temperatureMaxC: z.string().optional().nullable(),
});

export async function seedDefaultBekasiWarehouse(tx: DbExecutor): Promise<{
  branchId: string;
  warehouseId: string;
}> {
  const branchId = "br_bekasi_utama";
  await tx
    .insert(branches)
    .values({
      id: branchId,
      code: "BKS",
      name: "Cabang Utama Bekasi",
      city: "Bekasi",
      address: "Bekasi Timur, Kota Bekasi, Jawa Barat",
      isActive: true,
    })
    .onConflictDoNothing({ target: branches.code });

  const warehouseId = "wh_bks1";
  await tx
    .insert(warehouses)
    .values({
      id: warehouseId,
      branchId,
      code: "BKS1",
      name: "Gudang Distribusi Bekasi 1",
      address: "Jl. Raya Narogong, Kota Bekasi, Jawa Barat",
      isDefault: true,
      isActive: true,
    })
    .onConflictDoNothing({ target: warehouses.code });

  const defaultZones: Array<{
    id: string;
    code: string;
    name: string;
    zoneType: "receiving" | "cold_room" | "ambient" | "quarantine" | "dispatch" | "reject";
    temperatureMinC: string | null;
    temperatureMaxC: string | null;
  }> = [
    {
      id: "loc_bks1_rcv",
      code: "RCV-01",
      name: "Area Penerimaan & Timbang",
      zoneType: "receiving",
      temperatureMinC: null,
      temperatureMaxC: null,
    },
    {
      id: "loc_bks1_qc",
      code: "QC-01",
      name: "Area Inspeksi QC & Sortir",
      zoneType: "quarantine",
      temperatureMinC: "18.0",
      temperatureMaxC: "24.0",
    },
    {
      id: "loc_bks1_cold1",
      code: "COLD-01",
      name: "Cold Storage Utama (Buah Impor & Beri)",
      zoneType: "cold_room",
      temperatureMinC: "2.0",
      temperatureMaxC: "6.0",
    },
    {
      id: "loc_bks1_amb1",
      code: "AMB-01",
      name: "Ruang Sejuk Buah Tropis",
      zoneType: "ambient",
      temperatureMinC: "14.0",
      temperatureMaxC: "22.0",
    },
    {
      id: "loc_bks1_dsp",
      code: "DSP-01",
      name: "Area Picking, Packing & Muat",
      zoneType: "dispatch",
      temperatureMinC: null,
      temperatureMaxC: null,
    },
    {
      id: "loc_bks1_rej",
      code: "REJ-01",
      name: "Area Barang Reject / Klaim Supplier",
      zoneType: "reject",
      temperatureMinC: null,
      temperatureMaxC: null,
    },
  ];

  for (const z of defaultZones) {
    await tx
      .insert(warehouseLocations)
      .values({
        id: z.id,
        warehouseId,
        code: z.code,
        name: z.name,
        zoneType: z.zoneType,
        temperatureMinC: z.temperatureMinC,
        temperatureMaxC: z.temperatureMaxC,
      })
      .onConflictDoNothing();
  }

  return { branchId, warehouseId };
}

export async function listBranches(db: DbExecutor, ctx: ActorContext) {
  authorize(ctx, "warehouse.read");
  return db.select().from(branches).orderBy(asc(branches.code));
}

export async function listWarehouses(db: DbExecutor, ctx: ActorContext) {
  authorize(ctx, "warehouse.read");
  return db.select().from(warehouses).orderBy(asc(warehouses.code));
}

export async function listWarehouseLocations(
  db: DbExecutor,
  ctx: ActorContext,
  warehouseId?: string,
) {
  authorize(ctx, "warehouse.read", { warehouseId });
  if (warehouseId) {
    return db
      .select()
      .from(warehouseLocations)
      .where(eq(warehouseLocations.warehouseId, warehouseId))
      .orderBy(asc(warehouseLocations.code));
  }
  return db.select().from(warehouseLocations).orderBy(asc(warehouseLocations.code));
}

export async function createWarehouse(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createWarehouseSchema>,
) {
  authorize(ctx, "warehouse.write");
  const parsed = createWarehouseSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;
  const id = `wh_${crypto.randomUUID().slice(0, 8)}`;

  const [created] = await tx
    .insert(warehouses)
    .values({
      id,
      branchId: data.branchId,
      code: data.code,
      name: data.name,
      address: data.address,
      isDefault: data.isDefault,
      isActive: true,
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "warehouse.create",
    entityType: "warehouse",
    entityId: id,
    warehouseId: id,
    afterData: created,
  });

  return created!;
}

export async function updateWarehouse(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof updateWarehouseSchema>,
) {
  const parsed = updateWarehouseSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;
  authorize(ctx, "warehouse.write", { warehouseId: data.id });

  const [existing] = await tx.select().from(warehouses).where(eq(warehouses.id, data.id)).limit(1);
  if (!existing) {
    throw new NotFoundError("Gudang tidak ditemukan.");
  }

  const [updated] = await tx
    .update(warehouses)
    .set({
      branchId: data.branchId,
      code: data.code,
      name: data.name,
      address: data.address,
      isDefault: data.isDefault,
      isActive: data.isActive,
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(warehouses.id, data.id), eq(warehouses.version, data.expectedVersion)))
    .returning();

  if (!updated) {
    throw new ConflictError("Data gudang telah diubah oleh pengguna lain.");
  }

  await recordAudit(tx, {
    ctx,
    action: "warehouse.update",
    entityType: "warehouse",
    entityId: updated.id,
    warehouseId: updated.id,
    beforeData: existing,
    afterData: updated,
  });

  return updated;
}

export async function createWarehouseLocation(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createLocationSchema>,
) {
  const parsed = createLocationSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;
  authorize(ctx, "warehouse.write", { warehouseId: data.warehouseId });

  const id = `loc_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(warehouseLocations)
    .values({
      id,
      warehouseId: data.warehouseId,
      code: data.code,
      name: data.name,
      zoneType: data.zoneType,
      temperatureMinC: data.temperatureMinC ?? null,
      temperatureMaxC: data.temperatureMaxC ?? null,
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "warehouse_location.create",
    entityType: "warehouse_location",
    entityId: id,
    warehouseId: data.warehouseId,
    afterData: created,
  });

  return created!;
}
