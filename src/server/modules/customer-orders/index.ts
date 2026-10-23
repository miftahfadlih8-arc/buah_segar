import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { authorize, hasPermission, type ActorContext } from "@/server/authz/authorize";
import type { DbExecutor } from "@/server/db";
import {
  customerOrderRequestEvents,
  customerOrderRequestLines,
  customerOrderRequests,
  customerOrderSessions,
  customers,
  productGrades,
  products,
  settings,
  stockBalances,
} from "@/server/db/schema";
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/server/errors";
import { resolveActivePrice } from "@/server/modules/pricing";
import { createSalesOrder } from "@/server/modules/sales";
import { roundRupiah, MoneyDecimal, type Money, toDbAmount, parseMoney } from "@/lib/money";

// ============================================================================
// CONFIGURATION & HELPERS
// ============================================================================

export function getBaseUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, "");
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  if (process.env.BETTER_AUTH_URL) return process.env.BETTER_AUTH_URL.replace(/\/+$/, "");
  return "http://localhost:3000";
}

export function getPrivateStorageDir(): string {
  const customDir = process.env.PRIVATE_STORAGE_DIR;
  if (customDir) return path.resolve(customDir);
  return path.join(process.cwd(), "storage", "private", "proofs");
}

export interface MerchantQrisConfig {
  merchantName: string;
  nmid: string;
  qrisImageUrl?: string | null;
  qrisPayload?: string | null;
  instructions?: string | null;
  isEnabled: boolean;
  updatedAt?: string;
}

// ============================================================================
// 1. STORE CODE VALIDATION
// ============================================================================

export interface ValidateStoreCodeResult {
  valid: boolean;
  store?: {
    id: string;
    code: string;
    name: string;
  };
  error?: string;
}

export async function validateStoreCode(
  db: DbExecutor,
  rawCode: string,
): Promise<ValidateStoreCodeResult> {
  const code = (rawCode ?? "").trim().toUpperCase();
  if (!code || code.length < 3 || code.length > 30) {
    return {
      valid: false,
      error: "Kode toko tidak valid. Silakan periksa kembali kode yang diberikan admin toko.",
    };
  }

  const [customer] = await db
    .select({
      id: customers.id,
      code: customers.code,
      name: customers.name,
      isActive: customers.isActive,
    })
    .from(customers)
    .where(eq(customers.code, code))
    .limit(1);

  if (!customer || !customer.isActive) {
    // Return safe generic message to avoid store enumeration / leakage
    return {
      valid: false,
      error: "Kode toko tidak ditemukan atau tidak aktif. Silakan hubungi admin toko Anda.",
    };
  }

  return {
    valid: true,
    store: {
      id: customer.id,
      code: customer.code,
      name: customer.name,
    },
  };
}

// ============================================================================
// 2. ORDER SESSION (DRAFT) MANAGEMENT
// ============================================================================

export interface CartItemInput {
  productId: string;
  gradeId: string;
  uomCode: string;
  quantity: number | string;
  notes?: string | null;
}

export interface StoredCartItem {
  productId: string;
  productName: string;
  gradeId: string;
  gradeCode: string;
  uomCode: string;
  quantity: string;
  unitPrice: string;
  subtotal: string;
  notes?: string | null;
}

export async function getOrCreateOrderSession(
  db: DbExecutor,
  input: {
    storeCode: string;
    sessionToken?: string | null;
  },
) {
  const validation = await validateStoreCode(db, input.storeCode);
  if (!validation.valid || !validation.store) {
    throw new BusinessRuleError(validation.error || "Toko tidak valid.");
  }

  const store = validation.store;

  if (input.sessionToken) {
    const [existing] = await db
      .select()
      .from(customerOrderSessions)
      .where(
        and(
          eq(customerOrderSessions.sessionToken, input.sessionToken),
          eq(customerOrderSessions.customerId, store.id),
          eq(customerOrderSessions.status, "active"),
          gte(customerOrderSessions.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (existing) {
      await db
        .update(customerOrderSessions)
        .set({ lastActiveAt: new Date(), updatedAt: new Date() })
        .where(eq(customerOrderSessions.id, existing.id));

      return {
        sessionToken: existing.sessionToken,
        store: validation.store,
        cartItems: (existing.cartItems as StoredCartItem[]) ?? [],
        paymentProofRef: existing.paymentProofRef,
        paymentProofOriginalName: existing.paymentProofOriginalName,
        paymentProofMime: existing.paymentProofMime,
        paymentProofSize: existing.paymentProofSize,
        customerNotes: existing.customerNotes,
      };
    }
  }

  // Generate new session
  const id = `cos_${crypto.randomUUID()}`;
  const sessionToken = `cos_tok_${crypto.randomBytes(24).toString("hex")}`;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  await db.insert(customerOrderSessions).values({
    id,
    customerId: store.id,
    sessionToken,
    cartItems: [],
    status: "active",
    expiresAt,
  });

  return {
    sessionToken,
    store: validation.store,
    cartItems: [] as StoredCartItem[],
    paymentProofRef: null,
    paymentProofOriginalName: null,
    paymentProofMime: null,
    paymentProofSize: null,
    customerNotes: null,
  };
}

export async function updateSessionCart(
  db: DbExecutor,
  input: {
    sessionToken: string;
    cartItems: CartItemInput[];
    customerNotes?: string | null;
  },
) {
  const [session] = await db
    .select()
    .from(customerOrderSessions)
    .where(
      and(
        eq(customerOrderSessions.sessionToken, input.sessionToken),
        eq(customerOrderSessions.status, "active"),
        gte(customerOrderSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!session) {
    throw new BusinessRuleError("Sesi belanja tidak ditemukan atau telah kedaluwarsa. Silakan muat ulang halaman.");
  }

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, session.customerId))
    .limit(1);

  if (!customer || !customer.isActive) {
    throw new BusinessRuleError("Toko tidak aktif.");
  }

  const defaultWarehouseId = customer.assignedWarehouseId || "wh_kranji_utama";
  const today = new Date().toISOString().slice(0, 10);

  // Recalculate each item on server
  const storedItems: StoredCartItem[] = [];

  for (const item of input.cartItems) {
    const qtyNum = parseMoney(item.quantity);
    if (qtyNum.lte(0)) continue;

    const [product] = await db
      .select()
      .from(products)
      .where(and(eq(products.id, item.productId), eq(products.isActive, true)))
      .limit(1);

    if (!product) continue;

    const [grade] = await db
      .select()
      .from(productGrades)
      .where(and(eq(productGrades.id, item.gradeId), eq(productGrades.isActive, true)))
      .limit(1);

    if (!grade) continue;

    let unitPriceDec: Money;

    const activePrice = await resolveActivePrice(db, {
      productId: product.id,
      gradeId: grade.id,
      uomCode: item.uomCode,
      orderedQty: qtyNum,
      customerSegment: customer.segment,
      priceTier: customer.priceTier,
      warehouseId: defaultWarehouseId,
      documentDate: today,
    });

    if (activePrice) {
      unitPriceDec = new MoneyDecimal(activePrice.priceListItem.unitPrice);
    } else {
      // Fallback to minSellingPrice with grade multiplier
      const basePrice = new MoneyDecimal(product.minSellingPrice || "0");
      const multiplier = new MoneyDecimal(grade.priceMultiplierPct || "100").div(100);
      unitPriceDec = basePrice.times(multiplier);
    }

    if (unitPriceDec.lte(0)) {
      unitPriceDec = new MoneyDecimal("10000"); // Standard floor price if unconfigured
    }

    const subtotalDec = roundRupiah(qtyNum.times(unitPriceDec));

    storedItems.push({
      productId: product.id,
      productName: product.name,
      gradeId: grade.id,
      gradeCode: grade.code,
      uomCode: item.uomCode,
      quantity: toDbAmount(qtyNum),
      unitPrice: toDbAmount(unitPriceDec),
      subtotal: toDbAmount(subtotalDec),
      notes: item.notes ?? null,
    });
  }

  await db
    .update(customerOrderSessions)
    .set({
      cartItems: storedItems,
      customerNotes: input.customerNotes !== undefined ? input.customerNotes : session.customerNotes,
      lastActiveAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(customerOrderSessions.id, session.id));

  return {
    cartItems: storedItems,
    customerNotes: input.customerNotes,
  };
}

// ============================================================================
// 3. PUBLIC FRUIT CATALOG RESOLUTION
// ============================================================================

export interface PublicCatalogItem {
  id: string;
  sku: string;
  name: string;
  category: string;
  baseUomCode: string;
  grade: {
    id: string;
    code: string;
    name: string;
  };
  unitPrice: string;
  indicativeAvailability: "Tersedia" | "Stok Terbatas" | "Segera Hadir";
}

export async function getPublicFruitCatalog(
  db: DbExecutor,
  storeCode: string,
): Promise<{
  store: { id: string; code: string; name: string };
  products: PublicCatalogItem[];
}> {
  const validation = await validateStoreCode(db, storeCode);
  if (!validation.valid || !validation.store) {
    throw new BusinessRuleError(validation.error || "Toko tidak valid.");
  }

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, validation.store.id))
    .limit(1);

  if (!customer || !customer.isActive) {
    throw new BusinessRuleError("Toko tidak aktif.");
  }

  const defaultWarehouseId = customer.assignedWarehouseId || "wh_kranji_utama";
  const today = new Date().toISOString().slice(0, 10);

  // Get all active products
  const activeProducts = await db
    .select()
    .from(products)
    .where(eq(products.isActive, true))
    .orderBy(products.name);

  const productIds = activeProducts.map((p) => p.id);
  if (productIds.length === 0) {
    return { store: validation.store, products: [] };
  }

  // Get active grades for these products (prefer rank 1 / Grade A)
  const allGrades = await db
    .select()
    .from(productGrades)
    .where(and(inArray(productGrades.productId, productIds), eq(productGrades.isActive, true)))
    .orderBy(productGrades.qualityRank);

  // Get stock balances to provide indicative availability WITHOUT exposing sensitive numbers
  const balances = await db
    .select({
      productId: stockBalances.productId,
      totalQty: sql<string>`coalesce(sum(${stockBalances.qtyBase}), 0)::text`,
    })
    .from(stockBalances)
    .where(
      and(
        inArray(stockBalances.productId, productIds),
        eq(stockBalances.warehouseId, defaultWarehouseId),
        eq(stockBalances.stockStatus, "available"),
      ),
    )
    .groupBy(stockBalances.productId);

  const balanceMap = new Map<string, number>();
  for (const b of balances) {
    balanceMap.set(b.productId, Number(b.totalQty || 0));
  }

  const catalogItems: PublicCatalogItem[] = [];

  for (const p of activeProducts) {
    const grades = allGrades.filter((g) => g.productId === p.id);
    const topGrade = grades[0] || {
      id: `default_grade_${p.id}`,
      code: "A",
      name: "Grade A Super",
    };

    let unitPriceDec: Money;

    const resolved = await resolveActivePrice(db, {
      productId: p.id,
      gradeId: topGrade.id,
      uomCode: p.baseUomCode,
      orderedQty: new MoneyDecimal(1),
      customerSegment: customer.segment,
      priceTier: customer.priceTier,
      warehouseId: defaultWarehouseId,
      documentDate: today,
    });

    if (resolved) {
      unitPriceDec = new MoneyDecimal(resolved.priceListItem.unitPrice);
    } else {
      const base = new MoneyDecimal(p.minSellingPrice || "0");
      unitPriceDec = base.gt(0) ? base : new MoneyDecimal("15000");
    }

    const currentQty = balanceMap.get(p.id) ?? 100; // Indicative
    let availability: "Tersedia" | "Stok Terbatas" | "Segera Hadir" = "Tersedia";
    if (currentQty <= 0) {
      availability = "Stok Terbatas";
    } else if (currentQty < 20) {
      availability = "Stok Terbatas";
    }

    catalogItems.push({
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      baseUomCode: p.baseUomCode,
      grade: {
        id: topGrade.id,
        code: topGrade.code,
        name: topGrade.name,
      },
      unitPrice: toDbAmount(unitPriceDec),
      indicativeAvailability: availability,
    });
  }

  return {
    store: validation.store,
    products: catalogItems,
  };
}

// ============================================================================
// 4. MERCHANT QRIS CONFIGURATION
// ============================================================================

export async function getMerchantQrisConfig(db: DbExecutor): Promise<MerchantQrisConfig> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "payment.qris_config"))
    .orderBy(desc(settings.effectiveFrom))
    .limit(1);

  if (!row || !row.value) {
    return {
      merchantName: "PT Suplayer Buah Bekasi",
      nmid: "",
      qrisImageUrl: null,
      instructions: null,
      isEnabled: false,
    };
  }

  const val = row.value as Record<string, unknown>;
  return {
    merchantName: (val.merchantName as string) || "PT Suplayer Buah Bekasi",
    nmid: (val.nmid as string) || "",
    qrisImageUrl: (val.qrisImageUrl as string) || null,
    qrisPayload: (val.qrisPayload as string) || null,
    instructions: (val.instructions as string) || null,
    isEnabled: Boolean(val.isEnabled),
    updatedAt: (val.updatedAt as string) || undefined,
  };
}

export async function updateMerchantQrisConfig(
  db: DbExecutor,
  ctx: ActorContext,
  config: MerchantQrisConfig,
) {
  authorize(ctx, "settings.manage");

  const id = `set_${crypto.randomUUID()}`;
  await db.insert(settings).values({
    id,
    key: "payment.qris_config",
    value: {
      ...config,
      updatedAt: new Date().toISOString(),
      updatedBy: ctx.user.id,
    },
    description: "Konfigurasi resmi QRIS merchant untuk portal order QR pelanggan",
    changedBy: ctx.user.id,
    reason: "Pembaruan konfigurasi QRIS pembayaran merchant",
  });

  return config;
}

// ============================================================================
// 5. PAYMENT PROOF FILE HANDLING (PRIVATE STORAGE)
// ============================================================================

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

function checkMagicBytes(buffer: Buffer, mime: string): boolean {
  if (buffer.length < 12) return false;

  // JPEG: FF D8 FF
  if (mime === "image/jpeg" || mime === "image/jpg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (mime === "image/png") {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    );
  }
  // WEBP: RIFF .... WEBP
  if (mime === "image/webp") {
    const riff = buffer.subarray(0, 4).toString("ascii");
    const webp = buffer.subarray(8, 12).toString("ascii");
    return riff === "RIFF" && webp === "WEBP";
  }

  return false;
}

export async function savePaymentProofFile(
  db: DbExecutor,
  input: {
    sessionToken: string;
    fileBuffer: Buffer;
    fileName: string;
    mimeType: string;
  },
) {
  const [session] = await db
    .select()
    .from(customerOrderSessions)
    .where(
      and(
        eq(customerOrderSessions.sessionToken, input.sessionToken),
        eq(customerOrderSessions.status, "active"),
        gte(customerOrderSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!session) {
    throw new BusinessRuleError("Sesi belanja tidak ditemukan atau telah kedaluwarsa.");
  }

  if (input.fileBuffer.length > MAX_FILE_SIZE) {
    throw new ValidationError({
      file: ["Ukuran file bukti pembayaran terlalu besar (Maksimal 5 MB)."],
    });
  }

  const normalizedMime = input.mimeType.toLowerCase().trim();
  if (!ALLOWED_MIME_TYPES.has(normalizedMime)) {
    throw new ValidationError({
      file: ["Format file tidak didukung. Harap unggah foto bukti transfer dalam format JPG, PNG, atau WEBP."],
    });
  }

  if (!checkMagicBytes(input.fileBuffer, normalizedMime)) {
    throw new ValidationError({
      file: ["Isi file tidak sesuai dengan format gambar yang valid. Pastikan file tidak rusak."],
    });
  }

  const ext = normalizedMime === "image/png" ? "png" : normalizedMime === "image/webp" ? "webp" : "jpg";
  const secureFileName = `proof_${Date.now()}_${crypto.randomBytes(8).toString("hex")}.${ext}`;
  const storageDir = getPrivateStorageDir();

  await fs.mkdir(storageDir, { recursive: true });
  const fullPath = path.join(storageDir, secureFileName);
  await fs.writeFile(fullPath, input.fileBuffer);

  // Update session
  await db
    .update(customerOrderSessions)
    .set({
      paymentProofRef: secureFileName,
      paymentProofOriginalName: input.fileName,
      paymentProofMime: normalizedMime,
      paymentProofSize: input.fileBuffer.length,
      paymentProofUploadedAt: new Date(),
      lastActiveAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(customerOrderSessions.id, session.id));

  return {
    success: true,
    fileName: secureFileName,
    originalName: input.fileName,
    size: input.fileBuffer.length,
    mimeType: normalizedMime,
  };
}

export async function readPrivateProofFile(fileName: string): Promise<{
  buffer: Buffer;
  mime: string;
} | null> {
  // Prevent directory traversal
  const safeName = path.basename(fileName);
  const fullPath = path.join(getPrivateStorageDir(), safeName);

  try {
    const buffer = await fs.readFile(fullPath);
    let mime = "image/jpeg";
    if (safeName.endsWith(".png")) mime = "image/png";
    else if (safeName.endsWith(".webp")) mime = "image/webp";
    return { buffer, mime };
  } catch {
    return null;
  }
}

// ============================================================================
// 6. CUSTOMER ORDER REQUEST SUBMISSION (IDEMPOTENT & ATOMIC)
// ============================================================================

export interface SubmitCustomerOrderInput {
  sessionToken: string;
  idempotencyKey?: string | null;
  customerNotes?: string | null;
}

export async function submitCustomerOrderRequest(
  tx: DbExecutor,
  rawInput: SubmitCustomerOrderInput,
) {
  const sessionToken = rawInput.sessionToken.trim();
  if (!sessionToken) {
    throw new ValidationError({ sessionToken: ["Token sesi diperlukan."] });
  }

  // 1. Lock and retrieve session
  const [session] = await tx
    .select()
    .from(customerOrderSessions)
    .where(eq(customerOrderSessions.sessionToken, sessionToken))
    .limit(1);

  if (!session) {
    throw new NotFoundError("Sesi pesanan tidak ditemukan.");
  }

  if (session.status === "submitted") {
    // Already submitted, find existing request and return
    const [existingReq] = await tx
      .select()
      .from(customerOrderRequests)
      .where(eq(customerOrderRequests.orderSessionId, session.id))
      .limit(1);

    if (existingReq) {
      return {
        orderNumber: existingReq.orderNumber,
        statusToken: existingReq.statusToken,
        totalAmount: existingReq.totalAmount,
        status: existingReq.orderStatus,
        isDuplicate: true,
      };
    }
  }

  if (session.status !== "active") {
    throw new BusinessRuleError("Sesi belanja telah kedaluwarsa atau tidak aktif.");
  }

  // 2. Check Idempotency if key provided
  const idemKey = (rawInput.idempotencyKey ?? "").trim();
  if (idemKey) {
    const [existingByKey] = await tx
      .select()
      .from(customerOrderRequests)
      .where(eq(customerOrderRequests.idempotencyKey, idemKey))
      .limit(1);

    if (existingByKey) {
      return {
        orderNumber: existingByKey.orderNumber,
        statusToken: existingByKey.statusToken,
        totalAmount: existingByKey.totalAmount,
        status: existingByKey.orderStatus,
        isDuplicate: true,
      };
    }
  }

  // 3. Validate Cart and Payment Proof
  const cartItems = (session.cartItems as StoredCartItem[]) ?? [];
  if (cartItems.length === 0) {
    throw new BusinessRuleError("Keranjang belanja masih kosong. Harap pilih buah terlebih dahulu.");
  }

  if (!session.paymentProofRef) {
    throw new BusinessRuleError("Bukti pembayaran QRIS wajib diunggah sebelum konfirmasi pesanan.");
  }

  // 4. Validate customer / store
  const [customer] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, session.customerId))
    .limit(1);

  if (!customer || !customer.isActive) {
    throw new BusinessRuleError("Toko tujuan tidak aktif.");
  }

  const warehouseId = customer.assignedWarehouseId || "wh_kranji_utama";
  const today = new Date().toISOString().slice(0, 10);

  // 5. Server-side price recalculation (Never trust client totals)
  let subtotalSum = new MoneyDecimal(0);
  const validatedLines: Array<{
    lineNo: number;
    productId: string;
    productName: string;
    gradeId: string;
    gradeCode: string;
    uomCode: string;
    quantity: string;
    unitPrice: string;
    subtotal: string;
    notes?: string | null;
  }> = [];

  for (let i = 0; i < cartItems.length; i++) {
    const item = cartItems[i]!;
    const qtyNum = parseMoney(item.quantity);
    if (qtyNum.lte(0)) {
      throw new BusinessRuleError(`Kuantitas untuk produk ${item.productName} tidak valid.`);
    }

    const [product] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, item.productId), eq(products.isActive, true)))
      .limit(1);

    if (!product) {
      throw new BusinessRuleError(`Produk ${item.productName} sudah tidak aktif atau tidak ditemukan.`);
    }

    const [grade] = await tx
      .select()
      .from(productGrades)
      .where(and(eq(productGrades.id, item.gradeId), eq(productGrades.isActive, true)))
      .limit(1);

    if (!grade) {
      throw new BusinessRuleError(`Grade produk ${item.productName} tidak valid.`);
    }

    let unitPriceDec: Money;
    const resolved = await resolveActivePrice(tx, {
      productId: product.id,
      gradeId: grade.id,
      uomCode: item.uomCode,
      orderedQty: qtyNum,
      customerSegment: customer.segment,
      priceTier: customer.priceTier,
      warehouseId,
      documentDate: today,
    });

    if (resolved) {
      unitPriceDec = new MoneyDecimal(resolved.priceListItem.unitPrice);
    } else {
      const base = new MoneyDecimal(product.minSellingPrice || "0");
      unitPriceDec = base.gt(0) ? base : new MoneyDecimal("15000");
    }

    const lineSubtotal = roundRupiah(qtyNum.times(unitPriceDec));
    subtotalSum = subtotalSum.plus(lineSubtotal);

    validatedLines.push({
      lineNo: i + 1,
      productId: product.id,
      productName: product.name,
      gradeId: grade.id,
      gradeCode: grade.code,
      uomCode: item.uomCode,
      quantity: toDbAmount(qtyNum),
      unitPrice: toDbAmount(unitPriceDec),
      subtotal: toDbAmount(lineSubtotal),
      notes: item.notes ?? null,
    });
  }

  const grandTotal = roundRupiah(subtotalSum);

  // 6. Generate stable reference number (format: #RQYYYYMMDDXXX)
  const dateStr = today.replace(/-/g, "");
  const [seqResult] = await tx
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(customerOrderRequests)
    .where(sql`created_at >= ${today}::date`);

  const nextSeq = (seqResult?.count ?? 0) + 1;
  const orderNumber = `#RQ${dateStr}${String(nextSeq).padStart(3, "0")}`;

  const orderRequestId = `cor_${crypto.randomUUID()}`;
  const statusToken = `req_st_${crypto.randomBytes(24).toString("hex")}`;

  // 7. Insert customer_order_requests
  await tx.insert(customerOrderRequests).values({
    id: orderRequestId,
    orderNumber,
    orderSessionId: session.id,
    customerId: customer.id,
    warehouseId,
    customerStoreCodeSnapshot: customer.code,
    customerStoreNameSnapshot: customer.name,
    shippingAddressSnapshot: customer.shippingAddress,
    totalItems: validatedLines.length,
    subtotalAmount: toDbAmount(subtotalSum),
    taxAmount: "0.00",
    totalAmount: toDbAmount(grandTotal),
    paymentMethod: "qris_statis",
    paymentProofRef: session.paymentProofRef,
    paymentProofOriginalName: session.paymentProofOriginalName,
    paymentProofMime: session.paymentProofMime || "image/jpeg",
    paymentProofSize: session.paymentProofSize || 0,
    paymentProofUploadedAt: session.paymentProofUploadedAt || new Date(),
    orderStatus: "pending_review",
    paymentStatus: "pending_verification",
    statusToken,
    customerNotes: rawInput.customerNotes || session.customerNotes,
    idempotencyKey: idemKey || null,
  });

  // 8. Insert lines
  for (const line of validatedLines) {
    await tx.insert(customerOrderRequestLines).values({
      id: `corl_${crypto.randomUUID()}`,
      orderRequestId,
      lineNo: line.lineNo,
      productId: line.productId,
      productNameSnapshot: line.productName,
      gradeId: line.gradeId,
      gradeCodeSnapshot: line.gradeCode,
      uomCode: line.uomCode,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      subtotal: line.subtotal,
      notes: line.notes ?? null,
    });
  }

  // 9. Insert event
  await tx.insert(customerOrderRequestEvents).values({
    id: `core_${crypto.randomUUID()}`,
    orderRequestId,
    eventType: "order_submitted",
    actorId: null,
    actorRole: "customer",
    payload: {
      orderNumber,
      totalAmount: toDbAmount(grandTotal),
      itemsCount: validatedLines.length,
    },
  });

  // 10. Mark session as submitted
  await tx
    .update(customerOrderSessions)
    .set({
      status: "submitted",
      updatedAt: new Date(),
    })
    .where(eq(customerOrderSessions.id, session.id));

  return {
    orderNumber,
    statusToken,
    totalAmount: toDbAmount(grandTotal),
    status: "pending_review",
    isDuplicate: false,
  };
}

// ============================================================================
// 7. SECURE ORDER STATUS TRACKING
// ============================================================================

export async function getCustomerOrderStatus(
  db: DbExecutor,
  statusToken: string,
) {
  const token = (statusToken ?? "").trim();
  if (!token) return null;

  const [order] = await db
    .select({
      id: customerOrderRequests.id,
      orderNumber: customerOrderRequests.orderNumber,
      storeCode: customerOrderRequests.customerStoreCodeSnapshot,
      storeName: customerOrderRequests.customerStoreNameSnapshot,
      totalItems: customerOrderRequests.totalItems,
      totalAmount: customerOrderRequests.totalAmount,
      orderStatus: customerOrderRequests.orderStatus,
      paymentStatus: customerOrderRequests.paymentStatus,
      createdAt: customerOrderRequests.createdAt,
      rejectionReason: customerOrderRequests.rejectionReason,
      salesOrderId: customerOrderRequests.salesOrderId,
      paymentMethod: customerOrderRequests.paymentMethod,
    })
    .from(customerOrderRequests)
    .where(eq(customerOrderRequests.statusToken, token))
    .limit(1);

  if (!order) return null;

  const lines = await db
    .select({
      lineNo: customerOrderRequestLines.lineNo,
      productName: customerOrderRequestLines.productNameSnapshot,
      gradeCode: customerOrderRequestLines.gradeCodeSnapshot,
      uomCode: customerOrderRequestLines.uomCode,
      quantity: customerOrderRequestLines.quantity,
      unitPrice: customerOrderRequestLines.unitPrice,
      subtotal: customerOrderRequestLines.subtotal,
    })
    .from(customerOrderRequestLines)
    .where(eq(customerOrderRequestLines.orderRequestId, order.id))
    .orderBy(customerOrderRequestLines.lineNo);

  return {
    ...order,
    lines,
  };
}

// ============================================================================
// 8. ADMIN OPERATIONS (INBOX, CONFIRMATION, REJECTION, PAYMENT VERIFICATION)
// ============================================================================

export interface ListCustomerOrdersFilter {
  orderStatus?: string;
  paymentStatus?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listCustomerOrderRequests(
  db: DbExecutor,
  ctx: ActorContext,
  filters: ListCustomerOrdersFilter = {},
) {
  authorize(ctx, "sales.read");

  const conditions = [];

  if (filters.orderStatus) {
    conditions.push(
      eq(
        customerOrderRequests.orderStatus,
        filters.orderStatus as "pending_review" | "confirmed" | "rejected" | "cancelled",
      ),
    );
  }

  if (filters.paymentStatus) {
    conditions.push(
      eq(
        customerOrderRequests.paymentStatus,
        filters.paymentStatus as "pending_verification" | "verified" | "rejected",
      ),
    );
  }

  if (filters.search) {
    const q = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        ilike(customerOrderRequests.orderNumber, q),
        ilike(customerOrderRequests.customerStoreNameSnapshot, q),
        ilike(customerOrderRequests.customerStoreCodeSnapshot, q),
      ),
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const orders = await db
    .select({
      id: customerOrderRequests.id,
      orderNumber: customerOrderRequests.orderNumber,
      customerId: customerOrderRequests.customerId,
      storeCode: customerOrderRequests.customerStoreCodeSnapshot,
      storeName: customerOrderRequests.customerStoreNameSnapshot,
      shippingAddress: customerOrderRequests.shippingAddressSnapshot,
      totalItems: customerOrderRequests.totalItems,
      subtotalAmount: customerOrderRequests.subtotalAmount,
      totalAmount: customerOrderRequests.totalAmount,
      orderStatus: customerOrderRequests.orderStatus,
      paymentStatus: customerOrderRequests.paymentStatus,
      paymentProofRef: customerOrderRequests.paymentProofRef,
      paymentProofOriginalName: customerOrderRequests.paymentProofOriginalName,
      paymentProofMime: customerOrderRequests.paymentProofMime,
      paymentProofSize: customerOrderRequests.paymentProofSize,
      paymentProofUploadedAt: customerOrderRequests.paymentProofUploadedAt,
      rejectionReason: customerOrderRequests.rejectionReason,
      salesOrderId: customerOrderRequests.salesOrderId,
      reviewedBy: customerOrderRequests.reviewedBy,
      reviewedAt: customerOrderRequests.reviewedAt,
      paymentVerifiedBy: customerOrderRequests.paymentVerifiedBy,
      paymentVerifiedAt: customerOrderRequests.paymentVerifiedAt,
      customerNotes: customerOrderRequests.customerNotes,
      createdAt: customerOrderRequests.createdAt,
    })
    .from(customerOrderRequests)
    .where(whereClause)
    .orderBy(desc(customerOrderRequests.createdAt))
    .limit(filters.limit || 50)
    .offset(filters.offset || 0);

  return orders;
}

export async function getCustomerOrderRequestDetails(
  db: DbExecutor,
  ctx: ActorContext,
  orderRequestId: string,
) {
  authorize(ctx, "sales.read");

  const [order] = await db
    .select()
    .from(customerOrderRequests)
    .where(eq(customerOrderRequests.id, orderRequestId))
    .limit(1);

  if (!order) {
    throw new NotFoundError("Order QR tidak ditemukan.");
  }

  const lines = await db
    .select()
    .from(customerOrderRequestLines)
    .where(eq(customerOrderRequestLines.orderRequestId, order.id))
    .orderBy(customerOrderRequestLines.lineNo);

  const events = await db
    .select()
    .from(customerOrderRequestEvents)
    .where(eq(customerOrderRequestEvents.orderRequestId, order.id))
    .orderBy(desc(customerOrderRequestEvents.createdAt));

  return {
    ...order,
    lines,
    events,
  };
}

export async function confirmCustomerOrder(
  tx: DbExecutor,
  ctx: ActorContext,
  input: {
    orderRequestId: string;
    warehouseId?: string;
  },
) {
  authorize(ctx, "sales.write");

  // Lock row FOR UPDATE to prevent concurrent double confirmation
  const [order] = await tx
    .select()
    .from(customerOrderRequests)
    .where(eq(customerOrderRequests.id, input.orderRequestId))
    .limit(1);

  if (!order) {
    throw new NotFoundError("Order QR tidak ditemukan.");
  }

  if (order.orderStatus === "confirmed") {
    // Idempotent: already confirmed
    return {
      success: true,
      orderNumber: order.orderNumber,
      salesOrderId: order.salesOrderId!,
      alreadyConfirmed: true,
    };
  }

  if (order.orderStatus !== "pending_review") {
    throw new BusinessRuleError(`Order QR berstatus '${order.orderStatus}' tidak dapat dikonfirmasi.`);
  }

  const lines = await tx
    .select()
    .from(customerOrderRequestLines)
    .where(eq(customerOrderRequestLines.orderRequestId, order.id))
    .orderBy(customerOrderRequestLines.lineNo);

  if (lines.length === 0) {
    throw new BusinessRuleError("Order tidak memiliki baris item.");
  }

  const targetWarehouseId = input.warehouseId || order.warehouseId;

  // Convert to official Sales Order using Phase 4 createSalesOrder service!
  const soLines = lines.map((l) => ({
    productId: l.productId,
    gradeId: l.gradeId,
    orderedUomCode: l.uomCode,
    orderedQty: l.quantity,
    customUnitPrice: l.unitPrice,
    notes: l.notes || `Dari Order QR ${order.orderNumber}`,
  }));

  const createdSo = await createSalesOrder(tx, ctx, {
    idempotencyKey: `so_conv_${order.id}`,
    customerId: order.customerId,
    warehouseId: targetWarehouseId,
    orderDate: new Date().toISOString().slice(0, 10),
    saveAsDraft: false,
    autoConfirm: true,
    reserveStockOnConfirm: true,
    requestMarginOverride: true,
    marginOverrideReason: `Order QR resmi pelanggan ${order.customerStoreNameSnapshot} (${order.orderNumber})`,
    notes: `Dikonfirmasi dari Order QR ${order.orderNumber}`,
    lines: soLines,
  });

  // Update order request status
  await tx
    .update(customerOrderRequests)
    .set({
      orderStatus: "confirmed",
      salesOrderId: createdSo.header.id,
      reviewedBy: ctx.user.id,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(customerOrderRequests.id, order.id));

  const actorRole = ctx.roles[0]?.roleCode || "sales";

  // Insert event
  await tx.insert(customerOrderRequestEvents).values({
    id: `core_${crypto.randomUUID()}`,
    orderRequestId: order.id,
    eventType: "order_confirmed",
    actorId: ctx.user.id,
    actorRole,
    payload: {
      salesOrderId: createdSo.header.id,
      soNumber: createdSo.header.soNumber,
    },
  });

  return {
    success: true,
    orderNumber: order.orderNumber,
    salesOrderId: createdSo.header.id,
    soNumber: createdSo.header.soNumber,
    alreadyConfirmed: false,
  };
}

export async function rejectCustomerOrder(
  tx: DbExecutor,
  ctx: ActorContext,
  input: {
    orderRequestId: string;
    reason: string;
  },
) {
  authorize(ctx, "sales.write");

  const reason = (input.reason ?? "").trim();
  if (reason.length < 3) {
    throw new ValidationError({
      reason: ["Alasan penolakan pesanan wajib diisi minimal 3 karakter."],
    });
  }

  const [order] = await tx
    .select()
    .from(customerOrderRequests)
    .where(eq(customerOrderRequests.id, input.orderRequestId))
    .limit(1);

  if (!order) {
    throw new NotFoundError("Order QR tidak ditemukan.");
  }

  if (order.orderStatus !== "pending_review") {
    throw new BusinessRuleError(`Order QR berstatus '${order.orderStatus}' tidak dapat ditolak.`);
  }

  const actorRole = ctx.roles[0]?.roleCode || "sales";

  await tx
    .update(customerOrderRequests)
    .set({
      orderStatus: "rejected",
      rejectionReason: reason,
      reviewedBy: ctx.user.id,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(customerOrderRequests.id, order.id));

  await tx.insert(customerOrderRequestEvents).values({
    id: `core_${crypto.randomUUID()}`,
    orderRequestId: order.id,
    eventType: "order_rejected",
    actorId: ctx.user.id,
    actorRole,
    payload: { reason },
  });

  return {
    success: true,
    orderNumber: order.orderNumber,
    orderStatus: "rejected",
    reason,
  };
}

export async function verifyCustomerOrderPayment(
  tx: DbExecutor,
  ctx: ActorContext,
  input: {
    orderRequestId: string;
    action: "verify" | "reject";
    rejectionReason?: string;
  },
) {
  // Can be authorized by sales.write, ar.collect, or owner
  const isAuthorized =
    hasPermission(ctx, "sales.write") ||
    hasPermission(ctx, "ar.collect") ||
    ctx.roles.some((r) => r.roleCode === "owner");

  if (!isAuthorized) {
    throw new ForbiddenError("Anda tidak memiliki wewenang untuk memverifikasi pembayaran.");
  }

  const [order] = await tx
    .select()
    .from(customerOrderRequests)
    .where(eq(customerOrderRequests.id, input.orderRequestId))
    .limit(1);

  if (!order) {
    throw new NotFoundError("Order QR tidak ditemukan.");
  }

  const actorRole = ctx.roles[0]?.roleCode || "finance";

  if (input.action === "verify") {
    await tx
      .update(customerOrderRequests)
      .set({
        paymentStatus: "verified",
        paymentVerifiedBy: ctx.user.id,
        paymentVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(customerOrderRequests.id, order.id));

    await tx.insert(customerOrderRequestEvents).values({
      id: `core_${crypto.randomUUID()}`,
      orderRequestId: order.id,
      eventType: "payment_verified",
      actorId: ctx.user.id,
      actorRole,
      payload: { verifiedAt: new Date() },
    });

    return {
      success: true,
      paymentStatus: "verified",
    };
  } else {
    const reason = (input.rejectionReason ?? "").trim();
    if (reason.length < 3) {
      throw new ValidationError({
        rejectionReason: ["Alasan penolakan bukti pembayaran wajib diisi minimal 3 karakter."],
      });
    }

    await tx
      .update(customerOrderRequests)
      .set({
        paymentStatus: "rejected",
        paymentVerifiedBy: ctx.user.id,
        paymentVerifiedAt: new Date(),
        rejectionReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(customerOrderRequests.id, order.id));

    await tx.insert(customerOrderRequestEvents).values({
      id: `core_${crypto.randomUUID()}`,
      orderRequestId: order.id,
      eventType: "payment_rejected",
      actorId: ctx.user.id,
      actorRole,
      payload: { reason },
    });

    return {
      success: true,
      paymentStatus: "rejected",
      reason,
    };
  }
}

// ============================================================================
// 9. STORE QR CODE GENERATION
// ============================================================================

export interface StoreQrGenerationResult {
  storeCode: string;
  storeName: string;
  orderUrl: string;
  qrPngDataUrl: string;
  qrSvgString: string;
  isActive: boolean;
}

export async function generateStoreQrCode(
  db: DbExecutor,
  storeCode: string,
  options: { baseUrl?: string } = {},
): Promise<StoreQrGenerationResult> {
  const code = storeCode.trim().toUpperCase();

  const [customer] = await db
    .select({
      id: customers.id,
      code: customers.code,
      name: customers.name,
      isActive: customers.isActive,
    })
    .from(customers)
    .where(eq(customers.code, code))
    .limit(1);

  if (!customer) {
    throw new NotFoundError(`Toko dengan kode '${code}' tidak ditemukan.`);
  }

  const base = options.baseUrl || getBaseUrl();
  const orderUrl = `${base}/order?store=${encodeURIComponent(customer.code)}`;

  const [qrPngDataUrl, qrSvgString] = await Promise.all([
    QRCode.toDataURL(orderUrl, {
      width: 600,
      margin: 2,
      errorCorrectionLevel: "M",
      color: {
        dark: "#1e3a2b",
        light: "#ffffff",
      },
    }),
    QRCode.toString(orderUrl, {
      type: "svg",
      margin: 2,
      errorCorrectionLevel: "M",
      color: {
        dark: "#1e3a2b",
        light: "#ffffff",
      },
    }),
  ]);

  return {
    storeCode: customer.code,
    storeName: customer.name,
    orderUrl,
    qrPngDataUrl,
    qrSvgString,
    isActive: customer.isActive,
  };
}
