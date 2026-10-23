import crypto from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { parseMoney, toDbUnitPrice } from "@/lib/money";
import { parseQty, toDbQty } from "@/lib/quantity";
import { recordAudit } from "@/server/audit";
import { authorize, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import {
  packagingTypes,
  productGrades,
  productUomConversions,
  products,
  uoms,
} from "@/server/db/schema";
import { BusinessRuleError, ConflictError, NotFoundError, ValidationError } from "@/server/errors";

export const STANDARD_UOMS = [
  { code: "kg", name: "Kilogram (kg)", dimension: "weight", isBaseAllowed: true },
  { code: "g", name: "Gram (g)", dimension: "weight", isBaseAllowed: false },
  { code: "pcs", name: "Buah / Butir (pcs)", dimension: "count", isBaseAllowed: true },
  { code: "ikat", name: "Ikat", dimension: "package", isBaseAllowed: false },
  { code: "sisir", name: "Sisir", dimension: "package", isBaseAllowed: false },
  { code: "tandan", name: "Tandan", dimension: "package", isBaseAllowed: false },
  { code: "box", name: "Box / Karton", dimension: "package", isBaseAllowed: false },
  { code: "peti", name: "Peti Kayu", dimension: "package", isBaseAllowed: false },
  { code: "krat", name: "Krat Plastik", dimension: "package", isBaseAllowed: false },
  { code: "karung", name: "Karung / Jaring", dimension: "package", isBaseAllowed: false },
] as const;

export const STANDARD_PACKAGING = [
  {
    id: "pkg_krat_std",
    code: "KRAT-PLASTIK-STD",
    name: "Krat Plastik Standar Gudang",
    defaultTareKg: "1.800",
    isReusable: true,
  },
  {
    id: "pkg_peti_kayu",
    code: "PETI-KAYU-20",
    name: "Peti Kayu Buah Lokal",
    defaultTareKg: "2.500",
    isReusable: false,
  },
  {
    id: "pkg_box_impor",
    code: "BOX-KARTON-IMPOR",
    name: "Box Karton Buah Impor",
    defaultTareKg: "0.750",
    isReusable: false,
  },
  {
    id: "pkg_karung_jaring",
    code: "KARUNG-JARING",
    name: "Karung / Jaring Buah",
    defaultTareKg: "0.150",
    isReusable: false,
  },
] as const;

export async function seedStandardUomsAndPackaging(tx: DbExecutor): Promise<void> {
  for (const u of STANDARD_UOMS) {
    await tx.insert(uoms).values(u).onConflictDoNothing({ target: uoms.code });
  }
  for (const p of STANDARD_PACKAGING) {
    await tx.insert(packagingTypes).values(p).onConflictDoNothing({ target: packagingTypes.code });
  }
}

export const createProductSchema = z.object({
  sku: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{3,24}$/, "SKU harus 3–24 karakter huruf kapital, angka, atau tanda hubung."),
  barcode: z.string().trim().optional().nullable(),
  name: z.string().trim().min(2, "Nama buah minimal 2 karakter."),
  category: z.string().trim().min(2, "Kategori buah wajib diisi."),
  variety: z.string().trim().optional().nullable(),
  baseUomCode: z.enum(["kg", "pcs"], {
    message: "Satuan dasar persediaan harus 'kg' atau 'pcs'.",
  }),
  isCatchWeight: z.boolean().default(true),
  defaultShelfLifeDays: z.number().int().positive("Umur simpan standar harus lebih dari 0 hari."),
  ripenessTracking: z.boolean().default(true),
  storageCondition: z.enum(["cold", "ambient"]).default("cold"),
  taxCode: z.enum(["PPN_EXEMPT", "PPN_11"]).default("PPN_EXEMPT"),
  minMarginPct: z.string().default("10.00"),
  minSellingPrice: z.string().default("0"),
  createDefaultGrades: z.boolean().optional().default(true),
});

export const updateProductSchema = createProductSchema
  .omit({ createDefaultGrades: true })
  .extend({
    id: z.string().min(1),
    isActive: z.boolean(),
    expectedVersion: z.number().int().positive(),
  });

export const upsertGradeSchema = z.object({
  productId: z.string().min(1),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,6}$/, "Kode grade harus 1–6 karakter (misal: A, B, C, SUPER)."),
  name: z.string().trim().min(2, "Nama grade wajib diisi."),
  description: z.string().trim().optional().nullable(),
  qualityRank: z.number().int().positive().default(1),
  minWeightGram: z.number().int().positive().optional().nullable(),
  maxDefectPct: z.string().optional().nullable(),
  priceMultiplierPct: z.string().default("100.00"),
});

export const upsertUomConversionSchema = z.object({
  productId: z.string().min(1),
  uomCode: z.string().trim().min(1, "Satuan konversi wajib dipilih."),
  factorToBase: z.string().min(1, "Faktor konversi ke satuan dasar wajib diisi."),
  isNominal: z.boolean().default(true),
  requiresActualWeight: z.boolean().default(true),
  defaultPackagingTypeId: z.string().optional().nullable(),
  barcode: z.string().trim().optional().nullable(),
});

export const createPackagingTypeSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{3,24}$/, "Kode kemasan harus 3–24 karakter."),
  name: z.string().trim().min(2, "Nama kemasan wajib diisi."),
  defaultTareKg: z.string().min(1, "Berat tara standar (kg) wajib diisi."),
  isReusable: z.boolean().default(false),
});

export async function createProduct(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createProductSchema>,
) {
  authorize(ctx, "catalog.write");
  const parsed = createProductSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const minMargin = parseMoney(data.minMarginPct);
  if (minMargin.lt(0) || minMargin.gt(100)) {
    throw new BusinessRuleError("Margin minimum harus di antara 0% dan 100%.");
  }
  const minPrice = parseMoney(data.minSellingPrice);
  if (minPrice.lt(0)) {
    throw new BusinessRuleError("Harga jual minimum tidak boleh negatif.");
  }

  const [duplicateSku] = await tx
    .select({ id: products.id })
    .from(products)
    .where(eq(products.sku, data.sku))
    .limit(1);
  if (duplicateSku) {
    throw new ConflictError(`SKU '${data.sku}' sudah terdaftar pada produk lain.`);
  }

  const id = `prd_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(products)
    .values({
      id,
      sku: data.sku,
      barcode: data.barcode ? data.barcode.trim() : null,
      name: data.name,
      category: data.category,
      variety: data.variety ?? null,
      baseUomCode: data.baseUomCode,
      isCatchWeight: data.isCatchWeight,
      defaultShelfLifeDays: data.defaultShelfLifeDays,
      ripenessTracking: data.ripenessTracking,
      storageCondition: data.storageCondition,
      taxCode: data.taxCode,
      minMarginPct: minMargin.toFixed(2),
      minSellingPrice: toDbUnitPrice(minPrice),
      isActive: true,
    })
    .returning();

  if (data.createDefaultGrades) {
    const defaultGrades = [
      {
        id: `grd_${crypto.randomUUID().slice(0, 8)}`,
        productId: id,
        code: "A",
        name: "Grade A (Super / HORECA)",
        description: "Kualitas utama, ukuran seragam, mulus tanpa cacat kulit",
        qualityRank: 1,
        maxDefectPct: "2.00",
        priceMultiplierPct: "100.00",
      },
      {
        id: `grd_${crypto.randomUUID().slice(0, 8)}`,
        productId: id,
        code: "B",
        name: "Grade B (Pasar & Ritel Standar)",
        description: "Kualitas ritel standar, cacat kosmetik ringan pada kulit",
        qualityRank: 2,
        maxDefectPct: "8.00",
        priceMultiplierPct: "85.00",
      },
      {
        id: `grd_${crypto.randomUUID().slice(0, 8)}`,
        productId: id,
        code: "C",
        name: "Grade C (Kedai Jus & Olahan)",
        description: "Matang penuh / ukuran tidak seragam, layak konsumsi untuk jus",
        qualityRank: 3,
        maxDefectPct: "15.00",
        priceMultiplierPct: "65.00",
      },
    ];
    await tx.insert(productGrades).values(defaultGrades);
  }

  await recordAudit(tx, {
    ctx,
    action: "product.create",
    entityType: "product",
    entityId: id,
    afterData: created,
  });

  return created!;
}

export async function updateProduct(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof updateProductSchema>,
) {
  authorize(ctx, "catalog.write");
  const parsed = updateProductSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [existing] = await tx.select().from(products).where(eq(products.id, data.id)).limit(1);
  if (!existing) {
    throw new NotFoundError("Produk tidak ditemukan.");
  }

  const minMargin = parseMoney(data.minMarginPct);
  const minPrice = parseMoney(data.minSellingPrice);
  if (minMargin.lt(0) || minMargin.gt(100)) {
    throw new BusinessRuleError("Margin minimum harus di antara 0% dan 100%.");
  }
  if (minPrice.lt(0)) {
    throw new BusinessRuleError("Harga jual minimum tidak boleh negatif.");
  }

  const [updated] = await tx
    .update(products)
    .set({
      sku: data.sku,
      barcode: data.barcode ? data.barcode.trim() : null,
      name: data.name,
      category: data.category,
      variety: data.variety ?? null,
      baseUomCode: data.baseUomCode,
      isCatchWeight: data.isCatchWeight,
      defaultShelfLifeDays: data.defaultShelfLifeDays,
      ripenessTracking: data.ripenessTracking,
      storageCondition: data.storageCondition,
      taxCode: data.taxCode,
      minMarginPct: minMargin.toFixed(2),
      minSellingPrice: toDbUnitPrice(minPrice),
      isActive: data.isActive,
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(products.id, data.id), eq(products.version, data.expectedVersion)))
    .returning();

  if (!updated) {
    throw new ConflictError("Data produk telah diubah oleh pengguna lain. Muat ulang halaman.");
  }

  await recordAudit(tx, {
    ctx,
    action: "product.update",
    entityType: "product",
    entityId: updated.id,
    beforeData: existing,
    afterData: updated,
  });

  return updated;
}

export async function upsertProductGrade(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof upsertGradeSchema>,
) {
  authorize(ctx, "catalog.write");
  const parsed = upsertGradeSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [existing] = await tx
    .select()
    .from(productGrades)
    .where(and(eq(productGrades.productId, data.productId), eq(productGrades.code, data.code)))
    .limit(1);

  if (existing) {
    const [updated] = await tx
      .update(productGrades)
      .set({
        name: data.name,
        description: data.description ?? null,
        qualityRank: data.qualityRank,
        minWeightGram: data.minWeightGram ?? null,
        maxDefectPct: data.maxDefectPct ?? null,
        priceMultiplierPct: parseMoney(data.priceMultiplierPct).toFixed(2),
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(productGrades.id, existing.id))
      .returning();

    await recordAudit(tx, {
      ctx,
      action: "product_grade.update",
      entityType: "product_grade",
      entityId: existing.id,
      beforeData: existing,
      afterData: updated,
    });
    return updated!;
  }

  const id = `grd_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(productGrades)
    .values({
      id,
      productId: data.productId,
      code: data.code,
      name: data.name,
      description: data.description ?? null,
      qualityRank: data.qualityRank,
      minWeightGram: data.minWeightGram ?? null,
      maxDefectPct: data.maxDefectPct ?? null,
      priceMultiplierPct: parseMoney(data.priceMultiplierPct).toFixed(2),
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "product_grade.create",
    entityType: "product_grade",
    entityId: id,
    afterData: created,
  });
  return created!;
}

export async function upsertProductUomConversion(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof upsertUomConversionSchema>,
) {
  authorize(ctx, "catalog.write");
  const parsed = upsertUomConversionSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;

  const [prod] = await tx.select().from(products).where(eq(products.id, data.productId)).limit(1);
  if (!prod) {
    throw new NotFoundError("Produk tidak ditemukan.");
  }

  const factor = parseQty(data.factorToBase);
  if (factor.lte(0)) {
    throw new BusinessRuleError("Faktor konversi ke satuan dasar harus lebih dari 0.");
  }
  if (data.uomCode === prod.baseUomCode && !factor.eq(1)) {
    throw new BusinessRuleError("Satuan dasar produk harus memiliki faktor konversi 1.");
  }

  const [existing] = await tx
    .select()
    .from(productUomConversions)
    .where(
      and(
        eq(productUomConversions.productId, data.productId),
        eq(productUomConversions.uomCode, data.uomCode),
      ),
    )
    .limit(1);

  if (existing) {
    const [updated] = await tx
      .update(productUomConversions)
      .set({
        factorToBase: factor.toFixed(4),
        isNominal: data.isNominal,
        requiresActualWeight: data.requiresActualWeight,
        defaultPackagingTypeId: data.defaultPackagingTypeId ?? null,
        barcode: data.barcode ?? null,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(productUomConversions.id, existing.id))
      .returning();

    await recordAudit(tx, {
      ctx,
      action: "product_uom.update",
      entityType: "product_uom_conversion",
      entityId: existing.id,
      beforeData: existing,
      afterData: updated,
    });
    return updated!;
  }

  const id = `puc_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(productUomConversions)
    .values({
      id,
      productId: data.productId,
      uomCode: data.uomCode,
      factorToBase: factor.toFixed(4),
      isNominal: data.isNominal,
      requiresActualWeight: data.requiresActualWeight,
      defaultPackagingTypeId: data.defaultPackagingTypeId ?? null,
      barcode: data.barcode ?? null,
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "product_uom.create",
    entityType: "product_uom_conversion",
    entityId: id,
    afterData: created,
  });
  return created!;
}

export async function createPackagingType(
  tx: DbExecutor,
  ctx: ActorContext,
  rawInput: z.input<typeof createPackagingTypeSchema>,
) {
  authorize(ctx, "catalog.write");
  const parsed = createPackagingTypeSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.flatten().fieldErrors);
  }
  const data = parsed.data;
  const tare = parseQty(data.defaultTareKg);
  if (tare.lt(0)) {
    throw new BusinessRuleError("Berat tara kemasan tidak boleh negatif.");
  }

  const id = `pkg_${crypto.randomUUID().slice(0, 8)}`;
  const [created] = await tx
    .insert(packagingTypes)
    .values({
      id,
      code: data.code,
      name: data.name,
      defaultTareKg: toDbQty(tare),
      isReusable: data.isReusable,
    })
    .returning();

  await recordAudit(tx, {
    ctx,
    action: "packaging_type.create",
    entityType: "packaging_type",
    entityId: id,
    afterData: created,
  });
  return created!;
}

export async function listUoms(db: DbExecutor, ctx: ActorContext) {
  authorize(ctx, "catalog.read");
  return db.select().from(uoms).orderBy(asc(uoms.code));
}

export async function listPackagingTypes(db: DbExecutor, ctx: ActorContext) {
  authorize(ctx, "catalog.read");
  return db.select().from(packagingTypes).orderBy(asc(packagingTypes.code));
}

export async function listProductsWithDetails(db: DbExecutor, ctx: ActorContext) {
  authorize(ctx, "catalog.read");
  const allProducts = await db.select().from(products).orderBy(asc(products.sku));
  const allGrades = await db.select().from(productGrades).orderBy(asc(productGrades.qualityRank));
  const allConversions = await db
    .select()
    .from(productUomConversions)
    .orderBy(asc(productUomConversions.uomCode));

  return allProducts.map((p) => ({
    ...p,
    grades: allGrades.filter((g) => g.productId === p.id),
    uomConversions: allConversions.filter((c) => c.productId === p.id),
  }));
}
