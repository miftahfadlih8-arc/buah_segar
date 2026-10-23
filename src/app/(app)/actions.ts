"use server";

import { revalidatePath } from "next/cache";
import { requireSessionActor } from "@/server/auth/session";
import { getDb, withTransaction } from "@/server/db";
import { AppError, ValidationError } from "@/server/errors";
import {
  createPackagingType,
  createProduct,
  upsertProductUomConversion,
} from "@/server/modules/master/catalog";
import {
  addCustomerContact,
  createCustomer,
  updateCustomerCreditPolicy,
} from "@/server/modules/master/customers";
import { createPriceList, upsertPriceListItem } from "@/server/modules/pricing";
import {
  cancelSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
  createSalesQuotation,
  decideSalesOrderApproval,
} from "@/server/modules/sales";
import { createSupplier } from "@/server/modules/master/suppliers";
import {
  createWarehouse,
  createWarehouseLocation,
} from "@/server/modules/master/warehouses";
import {
  createStockAdjustment,
  postStockAdjustment,
} from "@/server/modules/inventory/ledger";
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  createPurchaseOrder,
  submitPurchaseOrder,
} from "@/server/modules/procurement";
import {
  createGoodsReceipt,
  postGoodsReceipt,
  recordGradingAndYield,
  recordQualityInspection,
  recordWeighing,
} from "@/server/modules/receiving";
import {
  createDeliveryOrder,
  createSalesFulfillment,
  dispatchDeliveryOrder,
  finalizeFulfillmentPacking,
  markDeliveryOrderReady,
  recordFulfillmentPicking,
  recordProofOfDelivery,
  reportFulfillmentException,
  resolveFulfillmentException,
  updateDeliveryOrderStatus,
} from "@/server/modules/fulfillment";
import {
  allocatePaymentToInvoices,
  approveCreditNote,
  createBankAccount,
  createCreditNote,
  createSalesInvoice,
  postSalesInvoice,
  reconcileBankTransactionWithPayment,
  recordBankTransaction,
  recordCustomerPayment,
  reverseCustomerPayment,
  voidSalesInvoice,
} from "@/server/modules/finance";
import {
  createCustomerClaim,
  decideCustomerClaim,
  inspectReturnedGoodsQc,
  issueCreditNoteFromClaim,
  resolveOrCloseClaim,
  reviewCustomerClaim,
  submitCustomerClaim,
} from "@/server/modules/returns";
import { createUserAccount, setUserStatus } from "@/server/modules/users";
import { setSetting } from "@/server/settings";

export interface ActionState {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string[]>;
}

function handleActionError(err: unknown): ActionState {
  if (err instanceof ValidationError) {
    return {
      ok: false,
      message: err.message,
      fieldErrors: err.fieldErrors,
    };
  }
  if (err instanceof AppError) {
    return {
      ok: false,
      message: err.message,
    };
  }
  if (err instanceof Error) {
    return {
      ok: false,
      message: err.message,
    };
  }
  return {
    ok: false,
    message: "Terjadi kesalahan pada server.",
  };
}

export async function createProductAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction((tx) =>
      createProduct(tx, actor, {
        sku: String(formData.get("sku") ?? ""),
        barcode: String(formData.get("barcode") ?? "") || null,
        name: String(formData.get("name") ?? ""),
        category: String(formData.get("category") ?? ""),
        variety: String(formData.get("variety") ?? "") || null,
        baseUomCode: (formData.get("baseUomCode") as "kg" | "pcs") ?? "kg",
        isCatchWeight: formData.get("isCatchWeight") === "on",
        defaultShelfLifeDays: Number(formData.get("defaultShelfLifeDays") ?? 0),
        ripenessTracking: formData.get("ripenessTracking") === "on",
        storageCondition: (formData.get("storageCondition") as "cold" | "ambient") ?? "cold",
        taxCode: (formData.get("taxCode") as "PPN_EXEMPT" | "PPN_11") ?? "PPN_EXEMPT",
        minMarginPct: String(formData.get("minMarginPct") ?? "10.00"),
        minSellingPrice: String(formData.get("minSellingPrice") ?? "0"),
        createDefaultGrades: true,
      }),
    );
    revalidatePath("/katalog");
    revalidatePath("/");
    return { ok: true, message: "Produk buah dan grade A/B/C berhasil ditambahkan." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function upsertUomConversionAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction((tx) =>
      upsertProductUomConversion(tx, actor, {
        productId: String(formData.get("productId") ?? ""),
        uomCode: String(formData.get("uomCode") ?? ""),
        factorToBase: String(formData.get("factorToBase") ?? ""),
        isNominal: formData.get("isNominal") === "on",
        requiresActualWeight: formData.get("requiresActualWeight") === "on",
        defaultPackagingTypeId: String(formData.get("defaultPackagingTypeId") ?? "") || null,
      }),
    );
    revalidatePath("/katalog");
    return { ok: true, message: "Aturan konversi satuan (UoM) berhasil disimpan." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function createPackagingTypeAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction((tx) =>
      createPackagingType(tx, actor, {
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        defaultTareKg: String(formData.get("defaultTareKg") ?? "0"),
        isReusable: formData.get("isReusable") === "on",
      }),
    );
    revalidatePath("/katalog");
    return { ok: true, message: "Jenis kemasan & berat tara berhasil ditambahkan." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function createWarehouseAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction((tx) =>
      createWarehouse(tx, actor, {
        branchId: String(formData.get("branchId") ?? ""),
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        address: String(formData.get("address") ?? ""),
        isDefault: false,
      }),
    );
    revalidatePath("/gudang");
    revalidatePath("/");
    return { ok: true, message: "Gudang baru berhasil didaftarkan." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function createWarehouseLocationAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction((tx) =>
      createWarehouseLocation(tx, actor, {
        warehouseId: String(formData.get("warehouseId") ?? ""),
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        zoneType:
          (formData.get("zoneType") as
            | "receiving"
            | "cold_room"
            | "ambient"
            | "quarantine"
            | "dispatch"
            | "reject") ?? "ambient",
        temperatureMinC: String(formData.get("temperatureMinC") ?? "") || null,
        temperatureMaxC: String(formData.get("temperatureMaxC") ?? "") || null,
      }),
    );
    revalidatePath("/gudang");
    return { ok: true, message: "Lokasi / zona gudang berhasil ditambahkan." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function createSupplierAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction((tx) =>
      createSupplier(tx, actor, {
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        supplierType:
          (formData.get("supplierType") as
            | "petani"
            | "kebun"
            | "grosir"
            | "importir"
            | "koperasi") ?? "petani",
        originRegion: String(formData.get("originRegion") ?? ""),
        contactPerson: String(formData.get("contactPerson") ?? "") || null,
        phone: String(formData.get("phone") ?? "") || null,
        address: String(formData.get("address") ?? "") || null,
        paymentTermsDays: Number(formData.get("paymentTermsDays") ?? 0),
        bankName: String(formData.get("bankName") ?? "") || null,
        bankAccountNo: String(formData.get("bankAccountNo") ?? "") || null,
        bankAccountHolder: String(formData.get("bankAccountHolder") ?? "") || null,
        npwp: String(formData.get("npwp") ?? "") || null,
        leadTimeDays: Number(formData.get("leadTimeDays") ?? 1),
      }),
    );
    revalidatePath("/supplier");
    revalidatePath("/");
    return { ok: true, message: "Supplier / petani berhasil didaftarkan." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function createCustomerAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction((tx) =>
      createCustomer(tx, actor, {
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        segment:
          (formData.get("segment") as
            | "toko_buah"
            | "pedagang_pasar"
            | "ritel_reseller"
            | "horeca"
            | "kedai_jus"
            | "korporat"
            | "konsumen_langsung") ?? "toko_buah",
        priceTier:
          (formData.get("priceTier") as "grosir" | "semi_grosir" | "ritel" | "horeca") ?? "grosir",
        contactPerson: String(formData.get("contactPerson") ?? "") || null,
        phone: String(formData.get("phone") ?? "") || null,
        whatsapp: String(formData.get("whatsapp") ?? "") || null,
        email: String(formData.get("email") ?? "") || null,
        shippingAddress: String(formData.get("shippingAddress") ?? ""),
        deliveryZoneId: String(formData.get("deliveryZoneId") ?? "") || null,
        paymentTermsDays: Number(formData.get("paymentTermsDays") ?? 0),
        creditLimit: String(formData.get("creditLimit") ?? "0"),
        marketingConsent: formData.get("marketingConsent") === "on",
        operationalConsent: true,
      }),
    );
    revalidatePath("/pelanggan");
    revalidatePath("/");
    return { ok: true, message: "Pelanggan berhasil didaftarkan." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function updateCustomerCreditAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction((tx) =>
      updateCustomerCreditPolicy(tx, actor, {
        customerId: String(formData.get("customerId") ?? ""),
        creditLimit: String(formData.get("creditLimit") ?? "0"),
        paymentTermsDays: Number(formData.get("paymentTermsDays") ?? 0),
        creditHold: formData.get("creditHold") === "on",
        reason: String(formData.get("reason") ?? ""),
        expectedVersion: Number(formData.get("expectedVersion") ?? 1),
      }),
    );
    revalidatePath("/pelanggan");
    revalidatePath("/audit");
    return { ok: true, message: "Kebijakan batas kredit pelanggan berhasil diperbarui." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function createUserAccountAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const db = getDb();
    await createUserAccount(db, actor, {
      name: String(formData.get("name") ?? ""),
      username: String(formData.get("username") ?? ""),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? "") || null,
      password: String(formData.get("password") ?? ""),
      roleCode: String(formData.get("roleCode") ?? ""),
      warehouseId: String(formData.get("warehouseId") ?? "") || null,
    });
    revalidatePath("/pengguna");
    revalidatePath("/audit");
    return { ok: true, message: "Akun pengguna baru dan penugasan peran berhasil dibuat." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function toggleUserStatusAction(formData: FormData): Promise<void> {
  const actor = await requireSessionActor();
  await withTransaction((tx) =>
    setUserStatus(tx, actor, {
      userId: String(formData.get("userId") ?? ""),
      status: (formData.get("status") as "active" | "suspended") ?? "active",
      reason: String(formData.get("reason") ?? "Perubahan status oleh administrator"),
      expectedVersion: Number(formData.get("expectedVersion") ?? 1),
    }),
  );
  revalidatePath("/pengguna");
  revalidatePath("/audit");
}

export async function updateSystemSettingAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const key = String(formData.get("key") ?? "");
    const rawValue = String(formData.get("valueJson") ?? "{}");
    const reason = String(formData.get("reason") ?? "");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawValue);
    } catch {
      return { ok: false, message: "Format JSON nilai pengaturan tidak valid." };
    }
    await withTransaction((tx) =>
      setSetting(tx, actor, {
        key,
        value: parsedJson,
        reason,
      }),
    );
    revalidatePath("/audit");
    return { ok: true, message: `Pengaturan '${key}' berhasil disimpan sebagai versi baru.` };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function createPurchaseOrderAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction(async (tx) => {
      const created = await createPurchaseOrder(tx, actor, {
        supplierId: String(formData.get("supplierId") ?? ""),
        warehouseId: String(formData.get("warehouseId") ?? ""),
        qtyTolerancePct: String(formData.get("qtyTolerancePct") ?? "5.00"),
        notes: String(formData.get("notes") ?? "") || undefined,
        lines: [
          {
            productId: String(formData.get("productId") ?? ""),
            expectedGradeCode: String(formData.get("expectedGradeCode") ?? "A"),
            orderedUomCode: String(formData.get("orderedUomCode") ?? "kg"),
            orderedQty: String(formData.get("orderedQty") ?? "0"),
            unitPriceBase: String(formData.get("unitPriceBase") ?? "0"),
          },
        ],
      });
      if (formData.get("autoApprove") === "on") {
        await submitPurchaseOrder(tx, actor, { purchaseOrderId: created.header.id });
        await approvePurchaseOrder(tx, actor, { purchaseOrderId: created.header.id });
      }
    });
    revalidatePath("/pembelian");
    revalidatePath("/penerimaan");
    revalidatePath("/");
    return { ok: true, message: "Purchase Order (PO) berhasil dibuat." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function approvePurchaseOrderAction(formData: FormData): Promise<void> {
  const actor = await requireSessionActor();
  const poId = String(formData.get("purchaseOrderId") ?? "");
  await withTransaction(async (tx) => {
    await approvePurchaseOrder(tx, actor, { purchaseOrderId: poId });
  });
  revalidatePath("/pembelian");
  revalidatePath("/penerimaan");
}

export async function cancelPurchaseOrderAction(formData: FormData): Promise<void> {
  const actor = await requireSessionActor();
  const poId = String(formData.get("purchaseOrderId") ?? "");
  const reason = String(formData.get("reason") ?? "Dibatalkan melalui portal operasional");
  await withTransaction(async (tx) => {
    await cancelPurchaseOrder(tx, actor, { purchaseOrderId: poId, reason });
  });
  revalidatePath("/pembelian");
}

export async function receiveAndPostGrnAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction(async (tx) => {
      const poId = String(formData.get("purchaseOrderId") ?? "");
      const poLineId = String(formData.get("purchaseOrderLineId") ?? "");
      const productId = String(formData.get("productId") ?? "");
      const receivingLocationId = String(formData.get("receivingLocationId") ?? "");
      const putawayLocationId = String(formData.get("putawayLocationId") ?? "");
      const supplierDeliveryNoteNo = String(formData.get("supplierDeliveryNoteNo") ?? "");
      const actualUnitCostBase = String(formData.get("actualUnitCostBase") ?? "0");
      const grossWeightKg = String(formData.get("grossWeightKg") ?? "0");
      const measuredTareWeightKg = String(formData.get("measuredTareWeightKg") ?? "0");
      const gradeAQty = String(formData.get("gradeAQty") ?? "0");
      const gradeBQty = String(formData.get("gradeBQty") ?? "0");
      const gradeCQty = String(formData.get("gradeCQty") ?? "0");
      const trimLossQty = String(formData.get("trimLossQty") ?? "0");
      const rejectQty = String(formData.get("rejectQty") ?? "0");
      const rejectReasonCode = String(formData.get("rejectReasonCode") ?? "SORTIR_QC");
      const freightCost = String(formData.get("freightCost") ?? "0");

      const landed =
        Number(freightCost) > 0
          ? [
              {
                costType: "freight" as const,
                description: "Biaya angkut & bongkar muat penerimaan",
                amount: freightCost,
              },
            ]
          : [];

      const created = await createGoodsReceipt(tx, actor, {
        purchaseOrderId: poId,
        receivingLocationId,
        putawayLocationId,
        supplierDeliveryNoteNo,
        lines: [
          {
            purchaseOrderLineId: poLineId || undefined,
            productId,
            actualUnitCostBase,
          },
        ],
        landedCosts: landed,
      });

      const grnLine = created.lines[0]!;
      await recordWeighing(tx, actor, {
        goodsReceiptLineId: grnLine.id,
        grossWeightKg,
        tareSource: "measured_actual",
        measuredTareWeightKg,
      });

      await recordQualityInspection(tx, actor, {
        goodsReceiptLineId: grnLine.id,
        ripenessStage: "matang_siap_jual",
        outcome: Number(rejectQty) > 0 ? "partially_accepted" : "accepted",
        rejectionReasonCode: Number(rejectQty) > 0 ? rejectReasonCode : undefined,
      });

      await recordGradingAndYield(tx, actor, {
        goodsReceiptLineId: grnLine.id,
        grades: [
          { gradeCode: "A", qtyBase: gradeAQty },
          { gradeCode: "B", qtyBase: gradeBQty },
          { gradeCode: "C", qtyBase: gradeCQty },
        ],
        trimLossQtyBase: trimLossQty,
        rejects:
          Number(rejectQty) > 0
            ? [
                {
                  qtyBase: rejectQty,
                  disposition: "return_to_supplier",
                  reasonCode: rejectReasonCode,
                },
              ]
            : [],
      });

      await postGoodsReceipt(tx, actor, {
        goodsReceiptId: created.header.id,
      });
    });

    revalidatePath("/penerimaan");
    revalidatePath("/pembelian");
    revalidatePath("/stok");
    revalidatePath("/buku-besar");
    revalidatePath("/");
    return {
      ok: true,
      message:
        "Penerimaan barang (GRN), penimbangan, QC, grading A/B/C, batch stok, dan jurnal GL berhasil diposting.",
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function createSpoilageOrAdjustmentAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction(async (tx) => {
      await createStockAdjustment(tx, actor, {
        warehouseId: String(formData.get("warehouseId") ?? ""),
        adjustmentCategory:
          (formData.get("adjustmentCategory") as
            | "spoilage"
            | "shrinkage"
            | "damage"
            | "quality_downgrade"
            | "manual_adjustment") ?? "spoilage",
        reasonCode: String(formData.get("reasonCode") ?? ""),
        notes: String(formData.get("notes") ?? ""),
        lines: [
          {
            locationId: String(formData.get("locationId") ?? ""),
            batchId: String(formData.get("batchId") ?? ""),
            qtyDeltaBase: String(formData.get("qtyDeltaBase") ?? "0"),
          },
        ],
        autoPostIfPermitted: formData.get("autoPost") === "on",
      });
    });

    revalidatePath("/stok");
    revalidatePath("/buku-besar");
    revalidatePath("/audit");
    revalidatePath("/");
    return { ok: true, message: "Dokumen susut / penyesuaian stok berhasil disimpan." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function postStockAdjustmentAction(formData: FormData): Promise<void> {
  const actor = await requireSessionActor();
  const stockAdjustmentId = String(formData.get("stockAdjustmentId") ?? "");
  await withTransaction(async (tx) => {
    await postStockAdjustment(tx, actor, { stockAdjustmentId });
  });
  revalidatePath("/stok");
  revalidatePath("/buku-besar");
  revalidatePath("/audit");
}

// ============================================================================
// PHASE 4 ACTIONS — CRM, PRICING, QUOTATIONS & SALES ORDERS
// ============================================================================

export async function addCustomerContactAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction(async (tx) => {
      await addCustomerContact(tx, actor, {
        customerId: String(formData.get("customerId") ?? ""),
        name: String(formData.get("name") ?? ""),
        roleTitle: String(formData.get("roleTitle") ?? ""),
        phone: String(formData.get("phone") ?? "") || null,
        whatsapp: String(formData.get("whatsapp") ?? "") || null,
        email: String(formData.get("email") ?? "") || null,
        isPrimary: formData.get("isPrimary") === "on",
      });
    });
    revalidatePath("/pelanggan");
    return { ok: true, message: "Kontak pelanggan berhasil ditambahkan." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function createPriceListAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction(async (tx) => {
      await createPriceList(tx, actor, {
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        priceTier:
          (formData.get("priceTier") as "grosir" | "semi_grosir" | "ritel" | "horeca") ?? "grosir",
        customerSegment:
          (String(formData.get("customerSegment") ?? "") as
            | "toko_buah"
            | "pedagang_pasar"
            | "ritel_reseller"
            | "horeca"
            | "kedai_jus"
            | "korporat"
            | "konsumen_langsung"
            | "") || null,
        warehouseId: String(formData.get("warehouseId") ?? "") || null,
        effectiveFrom: String(formData.get("effectiveFrom") ?? ""),
        effectiveTo: String(formData.get("effectiveTo") ?? "") || null,
        reason: String(formData.get("reason") ?? "Pembuatan daftar harga baru."),
      });
    });
    revalidatePath("/harga");
    revalidatePath("/audit");
    return { ok: true, message: "Daftar harga (Price List) berhasil dibuat." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function upsertPriceListItemAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction(async (tx) => {
      await upsertPriceListItem(tx, actor, {
        priceListId: String(formData.get("priceListId") ?? ""),
        productId: String(formData.get("productId") ?? ""),
        gradeId: String(formData.get("gradeId") ?? ""),
        uomCode: String(formData.get("uomCode") ?? "kg"),
        minQty: String(formData.get("minQty") ?? "1.000"),
        unitPrice: String(formData.get("unitPrice") ?? "0"),
        maxDiscountPct: String(formData.get("maxDiscountPct") ?? "0.00"),
        reason: String(formData.get("reason") ?? "Pembaruan harga item."),
      });
    });
    revalidatePath("/harga");
    revalidatePath("/audit");
    return { ok: true, message: "Harga produk pada daftar harga berhasil disimpan." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function createSalesQuotationAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction(async (tx) => {
      await createSalesQuotation(tx, actor, {
        customerId: String(formData.get("customerId") ?? ""),
        warehouseId: String(formData.get("warehouseId") ?? ""),
        validUntil: String(formData.get("validUntil") ?? ""),
        shippingFeeAmount: String(formData.get("shippingFeeAmount") ?? "0"),
        requestMarginOverride: formData.get("requestMarginOverride") === "on",
        marginOverrideReason: String(formData.get("marginOverrideReason") ?? "") || null,
        notes: String(formData.get("notes") ?? "") || null,
        lines: [
          {
            productId: String(formData.get("productId") ?? ""),
            gradeId: String(formData.get("gradeId") ?? ""),
            orderedUomCode: String(formData.get("orderedUomCode") ?? "kg"),
            orderedQty: String(formData.get("orderedQty") ?? "1"),
            customUnitPrice: String(formData.get("customUnitPrice") ?? "") || null,
            discountPct: String(formData.get("discountPct") ?? "0"),
          },
        ],
      });
    });
    revalidatePath("/penjualan");
    revalidatePath("/pelanggan");
    revalidatePath("/audit");
    return { ok: true, message: "Quotation penjualan berhasil dibuat." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function createSalesOrderAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    await withTransaction(async (tx) => {
      const quotationId = String(formData.get("quotationId") ?? "") || null;
      await createSalesOrder(tx, actor, {
        quotationId,
        customerId: String(formData.get("customerId") ?? ""),
        warehouseId: String(formData.get("warehouseId") ?? ""),
        paymentTermsDays: formData.get("paymentTermsDays")
          ? Number(formData.get("paymentTermsDays"))
          : undefined,
        shippingFeeAmount: String(formData.get("shippingFeeAmount") ?? "0"),
        reserveStockOnConfirm: formData.get("reserveStockOnConfirm") !== "off",
        autoConfirm: formData.get("autoConfirm") === "on",
        requestMarginOverride: formData.get("requestMarginOverride") === "on",
        marginOverrideReason: String(formData.get("marginOverrideReason") ?? "") || null,
        requestCreditOverride: formData.get("requestCreditOverride") === "on",
        creditOverrideReason: String(formData.get("creditOverrideReason") ?? "") || null,
        notes: String(formData.get("notes") ?? "") || null,
        lines: quotationId
          ? undefined
          : [
              {
                productId: String(formData.get("productId") ?? ""),
                gradeId: String(formData.get("gradeId") ?? ""),
                orderedUomCode: String(formData.get("orderedUomCode") ?? "kg"),
                orderedQty: String(formData.get("orderedQty") ?? "1"),
                customUnitPrice: String(formData.get("customUnitPrice") ?? "") || null,
                discountPct: String(formData.get("discountPct") ?? "0"),
              },
            ],
      });
    });
    revalidatePath("/penjualan");
    revalidatePath("/pelanggan");
    revalidatePath("/stok");
    revalidatePath("/audit");
    return { ok: true, message: "Sales Order berhasil dibuat." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function confirmSalesOrderAction(formData: FormData): Promise<void> {
  const actor = await requireSessionActor();
  const salesOrderId = String(formData.get("salesOrderId") ?? "");
  await withTransaction(async (tx) => {
    await confirmSalesOrder(tx, actor, { salesOrderId });
  });
  revalidatePath("/penjualan");
  revalidatePath("/pelanggan");
  revalidatePath("/stok");
  revalidatePath("/audit");
}

export async function cancelSalesOrderAction(formData: FormData): Promise<void> {
  const actor = await requireSessionActor();
  const salesOrderId = String(formData.get("salesOrderId") ?? "");
  const cancelReason =
    String(formData.get("cancelReason") ?? "").trim() ||
    "Dibatalkan oleh pengguna dari halaman Penjualan.";
  await withTransaction(async (tx) => {
    await cancelSalesOrder(tx, actor, { salesOrderId, cancelReason });
  });
  revalidatePath("/penjualan");
  revalidatePath("/pelanggan");
  revalidatePath("/stok");
  revalidatePath("/audit");
}

export async function decideSalesOrderApprovalAction(formData: FormData): Promise<void> {
  const actor = await requireSessionActor();
  const salesOrderId = String(formData.get("salesOrderId") ?? "");
  const decision = (formData.get("decision") as "approved" | "rejected") ?? "approved";
  const decisionNote =
    String(formData.get("decisionNote") ?? "").trim() ||
    `Keputusan ${decision} oleh pejabat berwenang.`;
  await withTransaction(async (tx) => {
    await decideSalesOrderApproval(tx, actor, {
      salesOrderId,
      decision,
      decisionNote,
    });
  });
  revalidatePath("/penjualan");
  revalidatePath("/pelanggan");
  revalidatePath("/audit");
}

export async function createSalesFulfillmentAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const salesOrderId = String(formData.get("salesOrderId") ?? "").trim();
    const fulfillmentDate = String(formData.get("fulfillmentDate") ?? "").trim() || undefined;
    const notes = String(formData.get("notes") ?? "").trim() || undefined;
    const qtyTolerancePct = String(formData.get("qtyTolerancePct") ?? "").trim() || undefined;

    await withTransaction(async (tx) => {
      await createSalesFulfillment(tx, actor, {
        salesOrderId,
        fulfillmentDate,
        notes,
        qtyTolerancePct,
      });
    });

    revalidatePath("/pemenuhan");
    revalidatePath("/penjualan");
    revalidatePath("/stok");
    revalidatePath("/audit");
    return { ok: true, message: "Dokumen Fulfillment berhasil dibuat dan siap untuk proses picking." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function recordFulfillmentPickingAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const fulfillmentId = String(formData.get("fulfillmentId") ?? "").trim();
    const fulfillmentLineId = String(formData.get("fulfillmentLineId") ?? "").trim();
    const grossWeightKg = String(formData.get("grossWeightKg") ?? "").trim();
    const tareWeightKg = String(formData.get("tareWeightKg") ?? "").trim();
    const actualProductId = String(formData.get("actualProductId") ?? "").trim() || undefined;
    const actualGradeId = String(formData.get("actualGradeId") ?? "").trim() || undefined;
    const pickedUomCode = String(formData.get("pickedUomCode") ?? "").trim() || undefined;
    const pickedQty = String(formData.get("pickedQty") ?? "").trim() || undefined;
    const scannedBarcode = String(formData.get("scannedBarcode") ?? "").trim() || undefined;
    const requestOverrideApproval = formData.get("requestOverrideApproval") === "on";
    const overrideReason = String(formData.get("overrideReason") ?? "").trim() || undefined;

    const res = await withTransaction(async (tx) => {
      return recordFulfillmentPicking(tx, actor, {
        fulfillmentId,
        picks: [
          {
            fulfillmentLineId,
            actualProductId,
            actualGradeId,
            pickedUomCode,
            pickedQty,
            grossWeightKg,
            tareWeightKg,
            scannedBarcode,
            requestOverrideApproval,
            overrideReason,
          },
        ],
      });
    });

    revalidatePath("/pemenuhan");
    revalidatePath("/stok");
    revalidatePath("/buku-besar");
    revalidatePath("/audit");

    if (res.fulfillment.status === "exception_hold") {
      return {
        ok: true,
        message: "Hasil timbang/substitusi membutuhkan persetujuan (exception_hold). Permintaan persetujuan telah diajukan ke Owner/Kepala Gudang.",
      };
    }

    return {
      ok: true,
      message: `Picking berhasil dicatat. Status pemenuhan: ${res.fulfillment.status}.`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function reportFulfillmentExceptionAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const fulfillmentId = String(formData.get("fulfillmentId") ?? "").trim();
    const fulfillmentLineId = String(formData.get("fulfillmentLineId") ?? "").trim() || undefined;
    const exceptionType = (formData.get("exceptionType") as
      | "weight_variance"
      | "damaged_goods"
      | "batch_unavailable"
      | "substitution"
      | "price_variance") ?? "damaged_goods";
    const severity = (formData.get("severity") as "warning" | "blocking") ?? "warning";
    const reasonCode = String(formData.get("reasonCode") ?? "").trim();
    const description = String(formData.get("description") ?? "").trim();

    await withTransaction(async (tx) => {
      await reportFulfillmentException(tx, actor, {
        fulfillmentId,
        fulfillmentLineId,
        exceptionType,
        severity,
        reasonCode,
        description,
      });
    });

    revalidatePath("/pemenuhan");
    revalidatePath("/audit");
    return { ok: true, message: "Exception pemenuhan berhasil dicatat." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function resolveFulfillmentExceptionAction(formData: FormData): Promise<void> {
  const actor = await requireSessionActor();
  const exceptionId = String(formData.get("exceptionId") ?? "").trim();
  const resolutionStatus = (formData.get("resolutionStatus") as "resolved" | "approved" | "rejected") ?? "resolved";
  const resolutionNotes = String(formData.get("resolutionNotes") ?? "").trim() || "Diselesaikan oleh pengguna.";

  await withTransaction(async (tx) => {
    await resolveFulfillmentException(tx, actor, {
      exceptionId,
      resolutionStatus,
      resolutionNotes,
    });
  });

  revalidatePath("/pemenuhan");
  revalidatePath("/audit");
}

export async function finalizeFulfillmentPackingAction(formData: FormData): Promise<void> {
  const actor = await requireSessionActor();
  const fulfillmentId = String(formData.get("fulfillmentId") ?? "").trim();
  const qualityChecked = formData.get("qualityChecked") === "on";
  const packagingVerified = formData.get("packagingVerified") === "on";
  const labelAttached = formData.get("labelAttached") === "on";
  const packageCount = Number(formData.get("packageCount") ?? 1);
  const notes = String(formData.get("notes") ?? "").trim() || undefined;

  await withTransaction(async (tx) => {
    await finalizeFulfillmentPacking(tx, actor, {
      fulfillmentId,
      checklist: {
        qualityChecked,
        packagingVerified,
        labelAttached,
        packageCount,
        notes,
      },
    });
  });

  revalidatePath("/pemenuhan");
  revalidatePath("/pengiriman");
  revalidatePath("/stok");
  revalidatePath("/audit");
}

export async function createDeliveryOrderAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const fulfillmentId = String(formData.get("fulfillmentId") ?? "").trim();
    const driverUserId = String(formData.get("driverUserId") ?? "").trim() || undefined;
    const vehiclePlateNo = String(formData.get("vehiclePlateNo") ?? "").trim() || undefined;
    const vehicleType = String(formData.get("vehicleType") ?? "").trim() || undefined;
    const deliveryZoneId = String(formData.get("deliveryZoneId") ?? "").trim() || undefined;
    const notes = String(formData.get("notes") ?? "").trim() || undefined;

    await withTransaction(async (tx) => {
      await createDeliveryOrder(tx, actor, {
        fulfillmentId,
        driverUserId,
        vehiclePlateNo,
        vehicleType,
        deliveryZoneId,
        notes,
      });
    });

    revalidatePath("/pengiriman");
    revalidatePath("/pemenuhan");
    revalidatePath("/audit");
    return { ok: true, message: "Surat Jalan (Delivery Order) berhasil dibuat." };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function markDeliveryOrderReadyAction(formData: FormData): Promise<void> {
  const actor = await requireSessionActor();
  const deliveryOrderId = String(formData.get("deliveryOrderId") ?? "").trim();
  const driverUserId = String(formData.get("driverUserId") ?? "").trim() || undefined;
  const vehiclePlateNo = String(formData.get("vehiclePlateNo") ?? "").trim() || undefined;
  const vehicleType = String(formData.get("vehicleType") ?? "").trim() || undefined;

  await withTransaction(async (tx) => {
    await markDeliveryOrderReady(tx, actor, {
      deliveryOrderId,
      driverUserId,
      vehiclePlateNo,
      vehicleType,
    });
  });

  revalidatePath("/pengiriman");
  revalidatePath("/audit");
}

export async function dispatchDeliveryOrderAction(formData: FormData): Promise<void> {
  const actor = await requireSessionActor();
  const deliveryOrderId = String(formData.get("deliveryOrderId") ?? "").trim();

  await withTransaction(async (tx) => {
    await dispatchDeliveryOrder(tx, actor, {
      deliveryOrderId,
    });
  });

  revalidatePath("/pengiriman");
  revalidatePath("/penjualan");
  revalidatePath("/audit");
}

export async function updateDeliveryOrderStatusAction(formData: FormData): Promise<void> {
  const actor = await requireSessionActor();
  const deliveryOrderId = String(formData.get("deliveryOrderId") ?? "").trim();
  const targetStatus = (formData.get("targetStatus") as
    | "in_transit"
    | "failed"
    | "returned"
    | "cancelled") ?? "in_transit";
  const reason = String(formData.get("reasonNote") ?? "").trim() || undefined;

  await withTransaction(async (tx) => {
    await updateDeliveryOrderStatus(tx, actor, {
      deliveryOrderId,
      targetStatus,
      reason,
    });
  });

  revalidatePath("/pengiriman");
  revalidatePath("/penjualan");
  revalidatePath("/audit");
}

export async function recordProofOfDeliveryAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const deliveryOrderId = String(formData.get("deliveryOrderId") ?? "").trim();
    const recipientName = String(formData.get("recipientName") ?? "").trim();
    const recipientRoleOrId =
      String(formData.get("recipientRoleOrId") ?? "").trim() || "Penerima";
    const recipientPhone = String(formData.get("recipientPhone") ?? "").trim() || undefined;
    const deliveryNotes = String(formData.get("deliveryNotes") ?? "").trim() || undefined;

    // Optional line discrepancies passed from form
    const deliveryOrderLineId = String(formData.get("deliveryOrderLineId") ?? "").trim();
    const deliveredQtyBase = String(formData.get("deliveredQtyBase") ?? "").trim();
    const shortageQtyBase = String(formData.get("shortageQtyBase") ?? "").trim() || undefined;
    const damagedQtyBase = String(formData.get("damagedQtyBase") ?? "").trim() || undefined;
    const refusedQtyBase = String(formData.get("refusedQtyBase") ?? "").trim() || undefined;
    const discrepancyReasonCode = String(formData.get("discrepancyReasonCode") ?? "").trim() || undefined;

    const lines =
      deliveryOrderLineId && deliveredQtyBase
        ? [
            {
              deliveryOrderLineId,
              deliveredQtyBase,
              shortageQtyBase,
              damagedQtyBase,
              refusedQtyBase,
              discrepancyReasonCode,
            },
          ]
        : undefined;

    const podRes = await withTransaction(async (tx) => {
      return recordProofOfDelivery(tx, actor, {
        deliveryOrderId,
        recipientName,
        recipientRoleOrId,
        recipientPhone,
        deliveryNotes,
        lines,
      });
    });

    revalidatePath("/pengiriman");
    revalidatePath("/penjualan");
    revalidatePath("/stok");
    revalidatePath("/audit");

    if (podRes.claim) {
      return {
        ok: true,
        message: `POD berhasil dicatat dengan selisih/klaim #${podRes.claim.claimNo} (Status: ${podRes.pod.outcomeStatus}). Klaim pengiriman telah dibuka untuk peninjauan finance/ops.`,
      };
    }

    return {
      ok: true,
      message: `Bukti Pengiriman (POD #${podRes.pod.podNumber}) berhasil dicatat lengkap.`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

// ---------------------------------------------------------------------------
// PHASE 6: INVOICING, AR, PAYMENTS & RECONCILIATION ACTIONS
// ---------------------------------------------------------------------------

export async function createSalesInvoiceAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const customerId = String(formData.get("customerId") ?? "").trim();
    const warehouseId = String(formData.get("warehouseId") ?? "").trim();
    const salesOrderId = String(formData.get("salesOrderId") ?? "").trim() || undefined;
    const deliveryOrderId = String(formData.get("deliveryOrderId") ?? "").trim() || undefined;
    const dueDate = String(formData.get("dueDate") ?? "").trim() || undefined;
    const notes = String(formData.get("notes") ?? "").trim() || undefined;
    const linesJson = String(formData.get("linesJson") ?? "").trim();

    let lines: Array<{
      productId: string;
      gradeId: string;
      uomCode: string;
      invoicedQty: string | number;
      unitPrice: string | number;
      discountAmount?: string | number;
      notes?: string;
      salesOrderLineId?: string;
      deliveryOrderLineId?: string;
    }> = [];

    if (linesJson) {
      lines = JSON.parse(linesJson);
    } else {
      const productId = String(formData.get("productId") ?? "").trim();
      const gradeId = String(formData.get("gradeId") ?? "").trim();
      const uomCode = String(formData.get("uomCode") ?? "").trim() || "kg";
      const invoicedQty = String(formData.get("invoicedQty") ?? "").trim();
      const unitPrice = String(formData.get("unitPrice") ?? "").trim();
      if (productId && gradeId && invoicedQty && unitPrice) {
        lines.push({
          productId,
          gradeId,
          uomCode,
          invoicedQty,
          unitPrice,
        });
      }
    }

    if (lines.length === 0) {
      return {
        ok: false,
        message: "Item faktur penjualan harus diisi minimal 1 baris.",
      };
    }

    const inv = await withTransaction((tx) =>
      createSalesInvoice(tx, actor, {
        customerId,
        warehouseId,
        salesOrderId,
        deliveryOrderId,
        dueDate,
        notes,
        lines,
      }),
    );

    revalidatePath("/faktur");
    revalidatePath("/piutang");
    revalidatePath("/penjualan");
    revalidatePath("/pengiriman");
    revalidatePath("/buku-besar");

    return {
      ok: true,
      message: `Faktur Penjualan #${inv.invoiceNo} berhasil diterbitkan dengan total Rp ${Number(inv.totalAmount).toLocaleString("id-ID")}.`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function postSalesInvoiceAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const invoiceId = String(formData.get("invoiceId") ?? "").trim();

    const inv = await withTransaction((tx) =>
      postSalesInvoice(tx, actor, invoiceId),
    );

    revalidatePath("/faktur");
    revalidatePath("/piutang");
    revalidatePath("/buku-besar");

    return {
      ok: true,
      message: `Faktur Penjualan #${inv.invoiceNo} berhasil diposting ke Buku Besar.`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function postSalesInvoiceDirectAction(formData: FormData): Promise<void> {
  const actor = await requireSessionActor();
  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  await withTransaction((tx) => postSalesInvoice(tx, actor, invoiceId));
  revalidatePath("/faktur");
  revalidatePath("/piutang");
  revalidatePath("/buku-besar");
}

export async function voidSalesInvoiceAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const invoiceId = String(formData.get("invoiceId") ?? "").trim();
    const reason = String(formData.get("reason") ?? "").trim();

    const inv = await withTransaction((tx) =>
      voidSalesInvoice(tx, actor, { invoiceId, reason }),
    );

    revalidatePath("/faktur");
    revalidatePath("/piutang");
    revalidatePath("/buku-besar");

    return {
      ok: true,
      message: `Faktur Penjualan #${inv.invoiceNo} berhasil dibatalkan (void).`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function recordCustomerPaymentAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const customerId = String(formData.get("customerId") ?? "").trim();
    const warehouseId = String(formData.get("warehouseId") ?? "").trim();
    const invoiceId = String(formData.get("invoiceId") ?? "").trim() || undefined;
    const bankAccountId = String(formData.get("bankAccountId") ?? "").trim() || undefined;
    const paymentType = (String(formData.get("paymentType") ?? "invoice_payment").trim()) as
      | "invoice_payment"
      | "deposit";
    const paymentMethod = (String(formData.get("paymentMethod") ?? "bank_transfer").trim()) as
      | "bank_transfer"
      | "cash"
      | "giro"
      | "qris";
    const paymentDate = String(formData.get("paymentDate") ?? "").trim() || undefined;
    const amount = String(formData.get("amount") ?? "").trim();
    const status = (String(formData.get("status") ?? "posted").trim()) as "draft" | "posted";
    const referenceNo = String(formData.get("referenceNo") ?? "").trim() || undefined;
    const notes = String(formData.get("notes") ?? "").trim() || undefined;
    const allocationsJson = String(formData.get("allocationsJson") ?? "").trim();

    let allocations: Array<{ invoiceId: string; amount: string | number }> | undefined = undefined;
    if (allocationsJson) {
      allocations = JSON.parse(allocationsJson);
    }

    const pay = await withTransaction((tx) =>
      recordCustomerPayment(tx, actor, {
        customerId,
        warehouseId,
        invoiceId,
        bankAccountId,
        paymentType,
        paymentMethod,
        paymentDate,
        amount,
        status,
        allocations,
        referenceNo,
        notes,
      }),
    );

    revalidatePath("/pembayaran");
    revalidatePath("/faktur");
    revalidatePath("/piutang");
    revalidatePath("/buku-besar");

    return {
      ok: true,
      message: `Pembayaran Pelanggan #${pay.paymentNo} sebesar Rp ${Number(pay.amount).toLocaleString("id-ID")} berhasil dicatat (${pay.status}).`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function reverseCustomerPaymentAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const paymentId = String(formData.get("paymentId") ?? "").trim();
    const reason = String(formData.get("reason") ?? "").trim();

    const pay = await withTransaction((tx) =>
      reverseCustomerPayment(tx, actor, { paymentId, reason }),
    );

    revalidatePath("/pembayaran");
    revalidatePath("/faktur");
    revalidatePath("/piutang");
    revalidatePath("/buku-besar");

    return {
      ok: true,
      message: `Pembayaran Pelanggan #${pay.paymentNo} berhasil dibatalkan / di-reverse.`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function allocatePaymentToInvoicesAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const paymentId = String(formData.get("paymentId") ?? "").trim();
    const allocationsJson = String(formData.get("allocationsJson") ?? "").trim();

    if (!allocationsJson) {
      return { ok: false, message: "Data alokasi faktur tidak boleh kosong." };
    }

    const allocations = JSON.parse(allocationsJson);

    const payment = await withTransaction(async (tx) => {
      return allocatePaymentToInvoices(tx, actor, {
        paymentId,
        allocations,
      });
    });

    revalidatePath("/pembayaran");
    revalidatePath("/faktur");
    revalidatePath("/piutang");
    revalidatePath("/buku-besar");

    return {
      ok: true,
      message: `Alokasi pembayaran #${payment?.paymentNo ?? paymentId} berhasil diterapkan.`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function createCreditNoteAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const customerId = String(formData.get("customerId") ?? "").trim();
    const warehouseId = String(formData.get("warehouseId") ?? "").trim();
    const invoiceId = String(formData.get("invoiceId") ?? "").trim() || undefined;
    const deliveryClaimId = String(formData.get("deliveryClaimId") ?? "").trim() || undefined;
    const sourceType = (String(formData.get("sourceType") ?? "quality_claim").trim()) as
      | "sales_return"
      | "quality_claim"
      | "price_adjustment";
    const issueDate = String(formData.get("issueDate") ?? "").trim() || undefined;
    const reason = String(formData.get("reason") ?? "").trim();
    const autoApprove = formData.get("autoApprove") === "true";
    const productId = String(formData.get("productId") ?? "").trim();
    const gradeId = String(formData.get("gradeId") ?? "").trim();
    const uomCode = String(formData.get("uomCode") ?? "kg").trim();
    const qty = String(formData.get("qty") ?? "1.000").trim();
    const unitPrice = String(formData.get("unitPrice") ?? formData.get("totalAmount") ?? "0").trim();
    const linesJson = String(formData.get("linesJson") ?? "").trim();

    let lines: Array<{
      productId: string;
      gradeId: string;
      uomCode: string;
      qty: string | number;
      unitPrice: string | number;
      notes?: string;
    }> = [];

    if (linesJson) {
      lines = JSON.parse(linesJson);
    } else if (productId && gradeId) {
      lines.push({
        productId,
        gradeId,
        uomCode,
        qty,
        unitPrice,
        notes: reason,
      });
    }

    if (lines.length === 0) {
      return { ok: false, message: "Pilih komoditas buah dan grade untuk baris nota kredit." };
    }

    const cn = await withTransaction(async (tx) => {
      const created = await createCreditNote(tx, actor, {
        customerId,
        warehouseId,
        invoiceId,
        deliveryClaimId,
        sourceType,
        issueDate,
        reason,
        lines,
      });

      if (autoApprove) {
        return approveCreditNote(tx, actor, {
          creditNoteId: created.id,
          invoiceId,
          reason: `Auto-approve saat pembuatan: ${reason}`,
        });
      }

      return created;
    });

    revalidatePath("/faktur");
    revalidatePath("/piutang");
    revalidatePath("/buku-besar");

    return {
      ok: true,
      message: `Nota Kredit #${cn.creditNoteNo} sebesar Rp ${Number(cn.totalAmount).toLocaleString("id-ID")} berhasil dibuat (${cn.status}).`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function approveCreditNoteAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const creditNoteId = String(formData.get("creditNoteId") ?? "").trim();
    const invoiceId = String(formData.get("invoiceId") ?? "").trim() || undefined;
    const reason = String(
      formData.get("reason") ?? "Persetujuan Nota Kredit oleh Keuangan",
    ).trim();

    const cn = await withTransaction((tx) =>
      approveCreditNote(tx, actor, { creditNoteId, invoiceId, reason }),
    );

    revalidatePath("/faktur");
    revalidatePath("/piutang");
    revalidatePath("/buku-besar");

    return {
      ok: true,
      message: `Nota Kredit #${cn.creditNoteNo} berhasil disetujui & diposting ke Buku Besar.`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function approveCreditNoteDirectAction(formData: FormData): Promise<void> {
  const actor = await requireSessionActor();
  const creditNoteId = String(formData.get("creditNoteId") ?? "").trim();
  const invoiceId = String(formData.get("invoiceId") ?? "").trim() || undefined;
  const reason = String(formData.get("reason") ?? "Persetujuan Nota Kredit oleh Keuangan").trim();

  await withTransaction((tx) =>
    approveCreditNote(tx, actor, { creditNoteId, invoiceId, reason }),
  );

  revalidatePath("/faktur");
  revalidatePath("/piutang");
  revalidatePath("/buku-besar");
}

export async function createBankAccountAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const bankName = String(formData.get("bankName") ?? "").trim();
    const accountNumber = String(formData.get("accountNumber") ?? "").trim();
    const holderName = String(formData.get("holderName") ?? formData.get("accountHolder") ?? "").trim();
    const code =
      String(formData.get("code") ?? "").trim() ||
      `BANK-${Math.floor(1000 + Math.random() * 9000)}`;
    const name =
      String(formData.get("name") ?? "").trim() ||
      `${bankName || "Kas Bank"} - ${accountNumber || "Operasional"}`;
    const accountType = (String(formData.get("accountType") ?? "bank").trim()) as
      | "bank"
      | "cash"
      | "ewallet";
    const warehouseId = String(formData.get("warehouseId") ?? "").trim() || undefined;

    const acc = await withTransaction((tx) =>
      createBankAccount(tx, actor, {
        code,
        name,
        accountType,
        bankName: bankName || undefined,
        accountNumber: accountNumber || undefined,
        holderName: holderName || undefined,
        warehouseId,
      }),
    );

    revalidatePath("/pembayaran");

    return {
      ok: true,
      message: `Rekening Bank ${acc.name} (${acc.code}) berhasil didaftarkan.`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function recordBankTransactionAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const bankAccountId = String(formData.get("bankAccountId") ?? "").trim();
    const transactionDate = String(formData.get("transactionDate") ?? "").trim();
    const direction = (String(
      formData.get("direction") ??
        (formData.get("transactionType") === "debit" ? "out" : "in"),
    ).trim()) as "in" | "out";
    const amount = String(formData.get("amount") ?? "").trim();
    const referenceNo = String(formData.get("referenceNo") ?? "").trim() || undefined;
    const description =
      String(formData.get("description") ?? "Setoran Bank / Kliring Pembayaran").trim();

    const trx = await withTransaction((tx) =>
      recordBankTransaction(tx, actor, {
        bankAccountId,
        transactionDate,
        direction,
        amount,
        referenceNo,
        description,
      }),
    );

    revalidatePath("/pembayaran");

    return {
      ok: true,
      message: `Mutasi Bank #${trx.referenceNo ?? trx.id} berhasil dicatat.`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function reconcileBankTransactionAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const bankTransactionId = String(formData.get("bankTransactionId") ?? "").trim();
    const paymentId = String(formData.get("paymentId") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim() || undefined;

    const res = await withTransaction((tx) =>
      reconcileBankTransactionWithPayment(tx, actor, {
        bankTransactionId,
        paymentId,
        notes,
      }),
    );

    revalidatePath("/pembayaran");
    revalidatePath("/buku-besar");

    return {
      ok: true,
      message: `Rekonsiliasi Bank berhasil diselesaikan (${res.matchStatus.toUpperCase()}).`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

// ============================================================================
// PHASE 7: RETURNS, CLAIMS, QC INSPECTION & SETTLEMENT ACTIONS
// ============================================================================

export async function createCustomerClaimAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const customerId = String(formData.get("customerId") ?? "").trim();
    const warehouseId = String(formData.get("warehouseId") ?? "").trim();
    const salesOrderId = String(formData.get("salesOrderId") ?? "").trim();
    const deliveryOrderId = String(formData.get("deliveryOrderId") ?? "").trim() || undefined;
    const podId = String(formData.get("podId") ?? "").trim() || undefined;
    const invoiceId = String(formData.get("invoiceId") ?? "").trim() || undefined;
    const productId = String(formData.get("productId") ?? "").trim() || undefined;
    const gradeId = String(formData.get("gradeId") ?? "").trim() || undefined;
    const batchId = String(formData.get("batchId") ?? "").trim() || undefined;
    const locationId = String(formData.get("locationId") ?? "").trim() || undefined;
    const claimType = String(formData.get("claimType") ?? "quality_claim") as
      | "shortage"
      | "damaged_in_transit"
      | "refused_by_customer"
      | "failed_delivery"
      | "mixed_discrepancy"
      | "quality_claim"
      | "sales_return"
      | "price_adjustment";
    const reasonCode = String(formData.get("reasonCode") ?? "CUSTOMER_CLAIM").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    const evidenceRef = String(formData.get("evidenceRef") ?? "").trim() || undefined;
    const requiresPhysicalReturn = formData.get("requiresPhysicalReturn") === "true";
    const discrepancyQtyBase = String(formData.get("discrepancyQtyBase") ?? "0").trim();
    const estimatedClaimValue = String(formData.get("estimatedClaimValue") ?? "0").trim();
    const submitImmediately = formData.get("submitImmediately") === "true";
    const idempotencyKey = String(formData.get("idempotencyKey") ?? "").trim() || undefined;

    const claim = await withTransaction((tx) =>
      createCustomerClaim(tx, actor, {
        customerId,
        warehouseId,
        salesOrderId,
        deliveryOrderId,
        podId,
        invoiceId,
        productId,
        gradeId,
        batchId,
        locationId,
        claimType,
        reasonCode,
        notes,
        evidenceRef,
        requiresPhysicalReturn,
        discrepancyQtyBase,
        estimatedClaimValue,
        submitImmediately,
        idempotencyKey,
      }),
    );

    revalidatePath("/pengiriman");
    revalidatePath("/faktur");

    return {
      ok: true,
      message: `Klaim #${claim.claimNo} berhasil dicatat dengan status '${claim.status.toUpperCase()}'.`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function submitCustomerClaimAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const claimId = String(formData.get("claimId") ?? "").trim();

    const claim = await withTransaction((tx) =>
      submitCustomerClaim(tx, actor, { claimId }),
    );

    revalidatePath("/pengiriman");

    return {
      ok: true,
      message: `Klaim #${claim.claimNo} berhasil diajukan (status: SUBMITTED).`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function reviewCustomerClaimAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const claimId = String(formData.get("claimId") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim() || undefined;

    const claim = await withTransaction((tx) =>
      reviewCustomerClaim(tx, actor, { claimId, notes }),
    );

    revalidatePath("/pengiriman");

    return {
      ok: true,
      message: `Klaim #${claim.claimNo} sedang dalam peninjauan (status: UNDER_REVIEW).`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function decideCustomerClaimAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const claimId = String(formData.get("claimId") ?? "").trim();
    const decision = String(formData.get("decision") ?? "approved") as "approved" | "rejected";
    const approvedQtyBase = String(formData.get("approvedQtyBase") ?? "").trim() || undefined;
    const approvedClaimValue = String(formData.get("approvedClaimValue") ?? "").trim() || undefined;
    const rejectionReason = String(formData.get("rejectionReason") ?? "").trim() || undefined;
    const notes = String(formData.get("notes") ?? "").trim() || undefined;

    const claim = await withTransaction((tx) =>
      decideCustomerClaim(tx, actor, {
        claimId,
        decision,
        approvedQtyBase,
        approvedClaimValue,
        rejectionReason,
        notes,
      }),
    );

    revalidatePath("/pengiriman");
    revalidatePath("/faktur");

    return {
      ok: true,
      message: `Keputusan klaim #${claim.claimNo} berhasil diproses: ${claim.status.toUpperCase()}.`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function inspectReturnedGoodsQcAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const claimId = String(formData.get("claimId") ?? "").trim();
    const qcOutcome = String(
      formData.get("qcOutcome") ?? "restock_available",
    ) as "restock_available" | "reject_dispose" | "damaged_writeoff";
    const batchId = String(formData.get("batchId") ?? "").trim() || undefined;
    const locationId = String(formData.get("locationId") ?? "").trim() || undefined;
    const notes = String(formData.get("notes") ?? "").trim();

    const res = await withTransaction((tx) =>
      inspectReturnedGoodsQc(tx, actor, {
        claimId,
        qcOutcome,
        batchId,
        locationId,
        notes,
      }),
    );

    revalidatePath("/pengiriman");
    revalidatePath("/stok");
    revalidatePath("/buku-besar");

    return {
      ok: true,
      message: `Inspeksi QC retur fisik klaim #${res.claim.claimNo} berhasil: ${res.claim.qcStatus.toUpperCase()}.`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function issueCreditNoteFromClaimAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const claimId = String(formData.get("claimId") ?? "").trim();
    const invoiceId = String(formData.get("invoiceId") ?? "").trim() || undefined;
    const reason = String(formData.get("reason") ?? "").trim() || undefined;

    const res = await withTransaction((tx) =>
      issueCreditNoteFromClaim(tx, actor, {
        claimId,
        invoiceId,
        reason,
      }),
    );

    revalidatePath("/pengiriman");
    revalidatePath("/faktur");
    revalidatePath("/piutang");
    revalidatePath("/buku-besar");

    return {
      ok: true,
      message: `Nota Kredit #${res.creditNote.creditNoteNo} berhasil diterbitkan untuk klaim #${res.claim.claimNo}.`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}

export async function resolveOrCloseClaimAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await requireSessionActor();
    const claimId = String(formData.get("claimId") ?? "").trim();
    const action = String(formData.get("action") ?? "close") as "resolve" | "close";
    const notes = String(formData.get("notes") ?? "").trim() || undefined;

    const claim = await withTransaction((tx) =>
      resolveOrCloseClaim(tx, actor, {
        claimId,
        action,
        notes,
      }),
    );

    revalidatePath("/pengiriman");

    return {
      ok: true,
      message: `Klaim #${claim.claimNo} berhasil di-${action} (status: ${claim.status.toUpperCase()}).`,
    };
  } catch (err) {
    return handleActionError(err);
  }
}




