"use server";

import { revalidatePath } from "next/cache";
import { getSessionActor } from "@/server/auth/session";
import { getDb } from "@/server/db";
import {
  confirmCustomerOrder,
  generateStoreQrCode,
  getMerchantQrisConfig,
  getOrCreateOrderSession,
  getPublicFruitCatalog,
  getCustomerOrderStatus,
  rejectCustomerOrder,
  submitCustomerOrderRequest,
  updateMerchantQrisConfig,
  updateSessionCart,
  validateStoreCode,
  verifyCustomerOrderPayment,
  type CartItemInput,
  type MerchantQrisConfig,
} from "./index";

// ============================================================================
// CUSTOMER PORTAL ACTIONS (PUBLIC / SESSION-GUARDED)
// ============================================================================

export async function validateStoreCodeAction(code: string) {
  const db = getDb();
  return await validateStoreCode(db, code);
}

export async function getOrCreateSessionAction(input: {
  storeCode: string;
  sessionToken?: string | null;
}) {
  const db = getDb();
  return await getOrCreateOrderSession(db, input);
}

export async function getCatalogAction(storeCode: string) {
  const db = getDb();
  return await getPublicFruitCatalog(db, storeCode);
}

export async function saveCartSessionAction(input: {
  sessionToken: string;
  cartItems: CartItemInput[];
  customerNotes?: string | null;
}) {
  const db = getDb();
  return await updateSessionCart(db, input);
}

export async function getQrisConfigAction() {
  const db = getDb();
  return await getMerchantQrisConfig(db);
}

export async function submitCustomerOrderAction(input: {
  sessionToken: string;
  idempotencyKey?: string | null;
  customerNotes?: string | null;
}) {
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    return await submitCustomerOrderRequest(tx, input);
  });
  return result;
}

export async function getOrderStatusAction(statusToken: string) {
  const db = getDb();
  return await getCustomerOrderStatus(db, statusToken);
}

// ============================================================================
// ADMIN ACTIONS (RBAC-PROTECTED)
// ============================================================================

export async function confirmCustomerOrderAction(
  orderRequestId: string,
  warehouseId?: string,
) {
  const actor = await getSessionActor();
  if (!actor) {
    throw new Error("Sesi tidak sah. Silakan login kembali.");
  }

  const db = getDb();
  const result = await db.transaction(async (tx) => {
    return await confirmCustomerOrder(tx, actor, {
      orderRequestId,
      warehouseId,
    });
  });

  revalidatePath("/order-qr");
  revalidatePath("/penjualan");
  return result;
}

export async function rejectCustomerOrderAction(
  orderRequestId: string,
  reason: string,
) {
  const actor = await getSessionActor();
  if (!actor) {
    throw new Error("Sesi tidak sah. Silakan login kembali.");
  }

  const db = getDb();
  const result = await db.transaction(async (tx) => {
    return await rejectCustomerOrder(tx, actor, {
      orderRequestId,
      reason,
    });
  });

  revalidatePath("/order-qr");
  return result;
}

export async function verifyCustomerPaymentAction(
  orderRequestId: string,
  action: "verify" | "reject",
  reason?: string,
) {
  const actor = await getSessionActor();
  if (!actor) {
    throw new Error("Sesi tidak sah. Silakan login kembali.");
  }

  const db = getDb();
  const result = await db.transaction(async (tx) => {
    return await verifyCustomerOrderPayment(tx, actor, {
      orderRequestId,
      action,
      rejectionReason: reason,
    });
  });

  revalidatePath("/order-qr");
  return result;
}

export async function updateMerchantQrisConfigAction(config: MerchantQrisConfig) {
  const actor = await getSessionActor();
  if (!actor) {
    throw new Error("Sesi tidak sah. Silakan login kembali.");
  }

  const db = getDb();
  const result = await updateMerchantQrisConfig(db, actor, config);
  revalidatePath("/qr-toko");
  return result;
}

export async function generateStoreQrAction(
  storeCode: string,
  options?: { baseUrl?: string },
) {
  const db = getDb();
  return await generateStoreQrCode(db, storeCode, options);
}
