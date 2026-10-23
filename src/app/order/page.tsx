import { Suspense } from "react";
import { OrderClient } from "./order-client";

export const metadata = {
  title: "Pesan Buah dengan Mudah — Suplayer Buah Bekasi",
  description: "Portal pemesanan buah segar resmi pelanggan Suplayer Buah Bekasi via QR Code dan link unik.",
};

export default function OrderPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-neutral-100 flex items-center justify-center">
          <div className="w-8 h-8 border-4 border-emerald-800 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <OrderClient />
    </Suspense>
  );
}
