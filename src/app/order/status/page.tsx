import { Suspense } from "react";
import { OrderStatusClient } from "./status-client";

export const metadata = {
  title: "Status Pesanan — Suplayer Buah Bekasi",
  description: "Lacak status verifikasi pembayaran dan pengiriman pesanan buah segar Anda secara real-time.",
};

export default function OrderStatusPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-neutral-100 flex items-center justify-center">
          <div className="w-8 h-8 border-4 border-emerald-800 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <OrderStatusClient />
    </Suspense>
  );
}
