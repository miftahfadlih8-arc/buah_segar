import { redirect } from "next/navigation";
import { getSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import { listCustomerOrderRequests } from "@/server/modules/customer-orders";
import { OrderQrClient, type OrderQrListItem } from "./order-qr-client";

export const metadata = {
  title: "Order QR Pelanggan — Suplayer Buah Bekasi",
  description: "Daftar pesanan buah segar yang masuk melalui scan QR Code atau link portal toko.",
};

export default async function OrderQrPage() {
  const actor = await getSessionActor();
  if (!actor) {
    throw new Error("Sesi tidak sah.");
  }

  if (!hasPermission(actor, "sales.read")) {
    redirect("/");
  }

  const db = getDb();
  const rawOrders = await listCustomerOrderRequests(db, actor, { limit: 100 });

  const orders: OrderQrListItem[] = rawOrders.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    customerId: o.customerId,
    storeCode: o.storeCode,
    storeName: o.storeName,
    shippingAddress: o.shippingAddress,
    totalItems: o.totalItems,
    subtotalAmount: o.subtotalAmount,
    totalAmount: o.totalAmount,
    orderStatus: o.orderStatus as "pending_review" | "confirmed" | "rejected" | "cancelled",
    paymentStatus: o.paymentStatus as "pending_verification" | "verified" | "rejected",
    paymentProofRef: o.paymentProofRef,
    paymentProofOriginalName: o.paymentProofOriginalName,
    paymentProofMime: o.paymentProofMime,
    paymentProofSize: o.paymentProofSize,
    paymentProofUploadedAt: o.paymentProofUploadedAt,
    rejectionReason: o.rejectionReason,
    salesOrderId: o.salesOrderId,
    reviewedBy: o.reviewedBy,
    reviewedAt: o.reviewedAt,
    paymentVerifiedBy: o.paymentVerifiedBy,
    paymentVerifiedAt: o.paymentVerifiedAt,
    customerNotes: o.customerNotes,
    createdAt: o.createdAt,
  }));

  return (
    <div className="p-6">
      <OrderQrClient orders={orders} />
    </div>
  );
}
