"use client";

import React, { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getOrderStatusAction } from "@/server/modules/customer-orders/actions";

interface OrderStatusData {
  id: string;
  orderNumber: string;
  storeCode: string;
  storeName: string;
  totalItems: number;
  totalAmount: string;
  orderStatus: string;
  paymentStatus: string;
  createdAt: Date | string;
  rejectionReason: string | null;
  salesOrderId: string | null;
  paymentMethod: string;
  lines: Array<{
    lineNo: number;
    productName: string;
    gradeCode: string;
    uomCode: string;
    quantity: string;
    unitPrice: string;
    subtotal: string;
  }>;
}

export function OrderStatusClient() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [order, setOrder] = useState<OrderStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const fetchStatus = useCallback(() => {
    if (!token) {
      setErrorMsg("Token status pesanan tidak ditemukan.");
      setLoading(false);
      return;
    }

    startTransition(async () => {
      try {
        const data = await getOrderStatusAction(token);
        if (!data) {
          setErrorMsg("Pesanan tidak ditemukan atau tautan status telah kedaluwarsa.");
        } else {
          setOrder(data as OrderStatusData);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Gagal memuat status pesanan.";
        setErrorMsg(msg);
      } finally {
        setLoading(false);
      }
    });
  }, [token]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchStatus();
    }, 0);
    const interval = setInterval(fetchStatus, 15000); // Polling every 15s for live updates
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [fetchStatus]);

  if (loading) {
    return (
      <main className="min-h-screen bg-neutral-100 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white p-8 rounded-2xl shadow-xl text-center">
          <div className="w-10 h-10 border-4 border-emerald-800 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-sm font-semibold text-neutral-800">Memeriksa status pesanan...</p>
        </div>
      </main>
    );
  }

  if (errorMsg || !order) {
    return (
      <main className="min-h-screen bg-neutral-100 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white p-8 rounded-2xl shadow-xl text-center">
          <div className="text-4xl mb-3">⚠️</div>
          <h2 className="text-base font-bold text-neutral-900 mb-2">Status Tidak Ditemukan</h2>
          <p className="text-xs text-neutral-600 mb-6">{errorMsg || "Pesanan tidak dapat ditampilkan."}</p>
          <Link
            href="/order"
            className="inline-block px-5 py-2.5 rounded-xl bg-emerald-800 text-white font-semibold text-xs shadow-md"
          >
            Kembali ke Portal Order
          </Link>
        </div>
      </main>
    );
  }

  const isConfirmed = order.orderStatus === "confirmed";
  const isRejected = order.orderStatus === "rejected";
  const isPaymentVerified = order.paymentStatus === "verified";

  const orderDate = new Date(order.createdAt).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="min-h-screen bg-neutral-100 flex justify-center py-6 px-4">
      <main className="w-full max-w-md bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col justify-between border border-neutral-200">
        <div className="p-6">
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-neutral-100">
            <h2 className="text-sm font-bold text-neutral-900">Pesanan Saya</h2>
            <button
              onClick={fetchStatus}
              disabled={isPending}
              className="text-xs font-semibold text-emerald-800 hover:text-emerald-950 flex items-center gap-1 active:scale-95"
            >
              <span>{isPending ? "Memperbarui..." : "Perbarui Status ↻"}</span>
            </button>
          </div>

          {/* Success Banner */}
          <div className="text-center my-6">
            <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center text-3xl mx-auto mb-3 shadow-xs">
              {isRejected ? "❌" : "✓"}
            </div>
            <h1 className="text-lg font-black text-neutral-900">
              {isRejected ? "Pesanan Ditolak" : isConfirmed ? "Pesanan Dikonfirmasi & Diproses" : "Pesanan Berhasil Dikirim"}
            </h1>
            <p className="text-xs font-bold text-emerald-800 mt-1 font-mono tracking-wide">
              {order.orderNumber}
            </p>
            <p className="text-[11px] text-neutral-500 mt-0.5">{orderDate}</p>

            <div className="mt-2.5">
              <span
                className={`inline-block px-2.5 py-1 rounded-full text-[10px] font-bold ${
                  isPaymentVerified
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-blue-100 text-blue-800"
                }`}
              >
                {isPaymentVerified ? "💳 Pembayaran Terverifikasi" : "⏳ Pembayaran Menunggu Verifikasi"}
              </span>
            </div>
          </div>

          {/* Rejection Alert if rejected */}
          {isRejected && order.rejectionReason && (
            <div className="mb-6 p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800">
              <p className="font-bold">Alasan Penolakan:</p>
              <p className="mt-1">{order.rejectionReason}</p>
            </div>
          )}

          {/* Status Timeline Progress */}
          <div className="bg-neutral-50 border border-neutral-200/80 rounded-2xl p-4 mb-6 space-y-4">
            <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-600 mb-2">
              Lacak Proses
            </h4>

            {/* Step 1: Pesanan Dikirim */}
            <div className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-full bg-emerald-800 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                ✓
              </span>
              <div>
                <p className="text-xs font-bold text-neutral-900">Pesanan Dikirim</p>
                <p className="text-[11px] text-neutral-500">{orderDate}</p>
              </div>
            </div>

            {/* Step 2: Menunggu Konfirmasi Admin */}
            <div className="flex items-start gap-3">
              <span
                className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                  isConfirmed
                    ? "bg-emerald-800 text-white"
                    : isRejected
                    ? "bg-rose-600 text-white"
                    : "bg-amber-500 text-white animate-pulse"
                }`}
              >
                {isConfirmed ? "✓" : isRejected ? "✕" : "⏳"}
              </span>
              <div>
                <p className="text-xs font-bold text-neutral-900">
                  {isConfirmed
                    ? "Telah Ditinjau Admin"
                    : isRejected
                    ? "Ditolak Admin"
                    : "Menunggu Konfirmasi Admin"}
                </p>
                <p className="text-[11px] text-neutral-500">
                  {isConfirmed
                    ? "Pesanan telah disetujui untuk penyiapan barang gudang."
                    : isRejected
                    ? "Admin tidak dapat memproses pesanan ini."
                    : "Admin toko sedang memverifikasi rincian pesanan dan bukti pembayaran Anda."}
                </p>
              </div>
            </div>

            {/* Step 3: Dikonfirmasi */}
            <div className="flex items-start gap-3">
              <span
                className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                  isConfirmed
                    ? "bg-emerald-800 text-white"
                    : "bg-neutral-200 text-neutral-400"
                }`}
              >
                {isConfirmed ? "✓" : "3"}
              </span>
              <div>
                <p className={`text-xs font-bold ${isConfirmed ? "text-neutral-900" : "text-neutral-400"}`}>
                  Dikonfirmasi & Pengiriman
                </p>
                <p className="text-[11px] text-neutral-500">
                  {isConfirmed
                    ? "Barang sedang disiapkan untuk pengiriman (Fulfillment)."
                    : "Setelah admin menyetujui pesanan."}
                </p>
              </div>
            </div>
          </div>

          {/* Items Summary */}
          <div className="border border-neutral-200 rounded-2xl p-4 space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-700">
              Rincian Barang ({order.lines.length})
            </h4>

            {order.lines.map((l) => (
              <div key={l.lineNo} className="flex justify-between items-center text-xs">
                <div>
                  <p className="font-bold text-neutral-800">{l.productName}</p>
                  <p className="text-[11px] text-neutral-500">
                    {l.quantity} {l.uomCode} × Rp {parseInt(l.unitPrice, 10).toLocaleString("id-ID")}
                  </p>
                </div>
                <span className="font-bold text-neutral-900">
                  Rp {parseFloat(l.subtotal).toLocaleString("id-ID")}
                </span>
              </div>
            ))}

            <div className="pt-3 border-t border-neutral-100 flex justify-between items-center text-sm font-black text-neutral-900">
              <span>Total Pembayaran</span>
              <span className="text-emerald-800">
                Rp {parseFloat(order.totalAmount).toLocaleString("id-ID")}
              </span>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-6 pt-0">
          <Link
            href="/order"
            className="w-full py-3.5 px-4 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-white font-semibold text-xs text-center block shadow-md active:scale-[0.98] transition-all"
          >
            Kembali ke Beranda
          </Link>
        </div>
      </main>
    </div>
  );
}
