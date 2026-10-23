"use client";

import React, { useState } from "react";
import Image from "next/image";
import {
  confirmCustomerOrderAction,
  rejectCustomerOrderAction,
  verifyCustomerPaymentAction,
} from "@/server/modules/customer-orders/actions";

export interface OrderQrListItem {
  id: string;
  orderNumber: string;
  customerId: string;
  storeCode: string;
  storeName: string;
  shippingAddress: string;
  totalItems: number;
  subtotalAmount: string;
  totalAmount: string;
  orderStatus: "pending_review" | "confirmed" | "rejected" | "cancelled";
  paymentStatus: "pending_verification" | "verified" | "rejected";
  paymentProofRef: string;
  paymentProofOriginalName: string | null;
  paymentProofMime: string;
  paymentProofSize: number;
  paymentProofUploadedAt: Date | string;
  rejectionReason: string | null;
  salesOrderId: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | string | null;
  paymentVerifiedBy: string | null;
  paymentVerifiedAt: Date | string | null;
  customerNotes: string | null;
  createdAt: Date | string;
}

export interface OrderQrClientProps {
  orders: OrderQrListItem[];
}

export function OrderQrClient({ orders: initialOrders }: OrderQrClientProps) {
  const [orders, setOrders] = useState<OrderQrListItem[]>(initialOrders);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<OrderQrListItem | null>(null);

  // Action states
  const [loadingAction, setLoadingAction] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectType, setRejectType] = useState<"order" | "payment">("order");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const filteredOrders = orders.filter((o) => {
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "pending" && o.orderStatus === "pending_review") ||
      (statusFilter === "confirmed" && o.orderStatus === "confirmed") ||
      (statusFilter === "rejected" && o.orderStatus === "rejected") ||
      (statusFilter === "unverified_payment" && o.paymentStatus === "pending_verification");

    const matchesSearch =
      !search ||
      o.orderNumber.toLowerCase().includes(search.toLowerCase()) ||
      o.storeName.toLowerCase().includes(search.toLowerCase()) ||
      o.storeCode.toLowerCase().includes(search.toLowerCase());

    return matchesStatus && matchesSearch;
  });

  const pendingCount = orders.filter((o) => o.orderStatus === "pending_review").length;
  const unverifiedPaymentCount = orders.filter((o) => o.paymentStatus === "pending_verification").length;

  const handleConfirmOrder = async (orderId: string) => {
    if (!window.confirm("Konfirmasi pesanan ini dan buat Sales Order resmi?")) return;

    setLoadingAction(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await confirmCustomerOrderAction(orderId);
      setSuccessMsg(`Pesanan ${res.orderNumber} berhasil dikonfirmasi ke Sales Order #${res.soNumber || res.salesOrderId}.`);

      // Update local state
      setOrders((prev) =>
        prev.map((o) => (o.id === orderId ? { ...o, orderStatus: "confirmed", salesOrderId: res.salesOrderId } : o)),
      );
      if (selectedOrder?.id === orderId) {
        setSelectedOrder((prev) => (prev ? { ...prev, orderStatus: "confirmed", salesOrderId: res.salesOrderId } : null));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal mengonfirmasi pesanan.";
      setErrorMsg(msg);
    } finally {
      setLoadingAction(false);
    }
  };

  const handleVerifyPayment = async (orderId: string) => {
    if (!window.confirm("Tandai bukti pembayaran ini sebagai VALID / TERVERIFIKASI?")) return;

    setLoadingAction(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      await verifyCustomerPaymentAction(orderId, "verify");
      setSuccessMsg("Bukti pembayaran berhasil diverifikasi.");

      setOrders((prev) =>
        prev.map((o) => (o.id === orderId ? { ...o, paymentStatus: "verified" } : o)),
      );
      if (selectedOrder?.id === orderId) {
        setSelectedOrder((prev) => (prev ? { ...prev, paymentStatus: "verified" } : null));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal memverifikasi pembayaran.";
      setErrorMsg(msg);
    } finally {
      setLoadingAction(false);
    }
  };

  const handleOpenRejectModal = (type: "order" | "payment") => {
    setRejectType(type);
    setRejectReason("");
    setShowRejectModal(true);
  };

  const handleExecuteReject = async () => {
    if (!selectedOrder) return;
    if (rejectReason.trim().length < 3) {
      setErrorMsg("Alasan penolakan wajib diisi minimal 3 karakter.");
      return;
    }

    setLoadingAction(true);
    setErrorMsg(null);
    setShowRejectModal(false);

    try {
      if (rejectType === "order") {
        await rejectCustomerOrderAction(selectedOrder.id, rejectReason);
        setSuccessMsg(`Pesanan ${selectedOrder.orderNumber} berhasil ditolak.`);
        setOrders((prev) =>
          prev.map((o) =>
            o.id === selectedOrder.id ? { ...o, orderStatus: "rejected", rejectionReason: rejectReason } : o,
          ),
        );
        setSelectedOrder((prev) =>
          prev ? { ...prev, orderStatus: "rejected", rejectionReason: rejectReason } : null,
        );
      } else {
        await verifyCustomerPaymentAction(selectedOrder.id, "reject", rejectReason);
        setSuccessMsg(`Bukti pembayaran untuk pesanan ${selectedOrder.orderNumber} ditolak.`);
        setOrders((prev) =>
          prev.map((o) =>
            o.id === selectedOrder.id ? { ...o, paymentStatus: "rejected", rejectionReason: rejectReason } : o,
          ),
        );
        setSelectedOrder((prev) =>
          prev ? { ...prev, paymentStatus: "rejected", rejectionReason: rejectReason } : null,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal menolak pesanan / pembayaran.";
      setErrorMsg(msg);
    } finally {
      setLoadingAction(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-200 pb-4">
        <div>
          <h1 className="text-xl font-bold text-neutral-900 tracking-tight">
            Order QR Pelanggan (Inbox)
          </h1>
          <p className="text-xs text-neutral-500 mt-1">
            Daftar pesanan buah segar yang masuk melalui scan QR Code atau link portal toko.
          </p>
        </div>

        {/* Quick Stats Pill */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold px-3 py-1.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-800">
            ⏳ {pendingCount} Perlu Ditinjau
          </span>
          <span className="text-xs font-semibold px-3 py-1.5 rounded-xl bg-blue-50 border border-blue-200 text-blue-800">
            💳 {unverifiedPaymentCount} Pembayaran Belum Dicek
          </span>
        </div>
      </div>

      {/* Global Alerts */}
      {errorMsg && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 font-medium flex items-center justify-between">
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="text-rose-400 hover:text-rose-700">✕</button>
        </div>
      )}
      {successMsg && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 font-medium flex items-center justify-between">
          <span>{successMsg}</span>
          <button onClick={() => setSuccessMsg(null)} className="text-emerald-500 hover:text-emerald-800">✕</button>
        </div>
      )}

      {/* Filters and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0">
          {[
            { id: "all", label: "Semua" },
            { id: "pending", label: `Menunggu (${pendingCount})` },
            { id: "unverified_payment", label: `Bayar Pending (${unverifiedPaymentCount})` },
            { id: "confirmed", label: "Dikonfirmasi" },
            { id: "rejected", label: "Ditolak" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setStatusFilter(tab.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
                statusFilter === tab.id
                  ? "bg-emerald-800 text-white shadow-xs"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="w-full sm:w-72">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari No. Order, Toko, Kode..."
            className="w-full px-3.5 py-2 text-xs bg-white border border-neutral-200 rounded-xl outline-none focus:ring-2 focus:ring-emerald-600 shadow-xs"
          />
        </div>
      </div>

      {/* Orders Table */}
      <div className="bg-white rounded-2xl border border-neutral-200 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-neutral-50/80 border-b border-neutral-200 text-neutral-500 uppercase tracking-wider font-semibold text-[11px]">
                <th className="py-3 px-4">No. Order</th>
                <th className="py-3 px-4">Toko Pelanggan</th>
                <th className="py-3 px-4">Waktu Masuk</th>
                <th className="py-3 px-4 text-center">Items</th>
                <th className="py-3 px-4 text-right">Total Tagihan</th>
                <th className="py-3 px-4 text-center">Status Order</th>
                <th className="py-3 px-4 text-center">Status Bayar</th>
                <th className="py-3 px-4 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-neutral-400">
                    Tidak ada pesanan QR yang sesuai dengan filter.
                  </td>
                </tr>
              ) : (
                filteredOrders.map((o) => {
                  const dateStr = new Date(o.createdAt).toLocaleDateString("id-ID", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  });

                  return (
                    <tr key={o.id} className="hover:bg-neutral-50/60 transition-colors">
                      <td className="py-3.5 px-4 font-mono font-bold text-neutral-900">
                        {o.orderNumber}
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="font-bold text-neutral-900">{o.storeName}</div>
                        <div className="text-[11px] text-neutral-500 font-mono">Kode: {o.storeCode}</div>
                      </td>
                      <td className="py-3.5 px-4 text-neutral-600 whitespace-nowrap">
                        {dateStr}
                      </td>
                      <td className="py-3.5 px-4 text-center font-bold text-neutral-700">
                        {o.totalItems}
                      </td>
                      <td className="py-3.5 px-4 text-right font-black text-neutral-900">
                        Rp {parseFloat(o.totalAmount).toLocaleString("id-ID")}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            o.orderStatus === "confirmed"
                              ? "bg-emerald-100 text-emerald-800"
                              : o.orderStatus === "rejected"
                              ? "bg-rose-100 text-rose-800"
                              : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {o.orderStatus === "confirmed"
                            ? "Dikonfirmasi"
                            : o.orderStatus === "rejected"
                            ? "Ditolak"
                            : "Menunggu Review"}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            o.paymentStatus === "verified"
                              ? "bg-emerald-100 text-emerald-800"
                              : o.paymentStatus === "rejected"
                              ? "bg-rose-100 text-rose-800"
                              : "bg-blue-100 text-blue-800"
                          }`}
                        >
                          {o.paymentStatus === "verified"
                            ? "Terverifikasi"
                            : o.paymentStatus === "rejected"
                            ? "Bukti Ditolak"
                            : "Belum Verifikasi"}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <button
                          onClick={() => setSelectedOrder(o)}
                          className="px-3 py-1.5 rounded-lg bg-neutral-100 hover:bg-neutral-200 text-neutral-800 font-semibold text-xs active:scale-95 transition-all"
                        >
                          Periksa Detail
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ==================================================================== */}
      {/* ORDER DETAIL MODAL / DRAWER */}
      {/* ==================================================================== */}
      {selectedOrder && (
        <div className="fixed inset-0 z-50 bg-neutral-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto border border-neutral-200 flex flex-col">
            {/* Modal Header */}
            <div className="p-5 border-b border-neutral-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <div>
                <span className="text-[10px] font-mono font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                  {selectedOrder.orderNumber}
                </span>
                <h3 className="text-base font-bold text-neutral-900 mt-1">
                  Detail Order QR: {selectedOrder.storeName}
                </h3>
              </div>
              <button
                onClick={() => setSelectedOrder(null)}
                className="w-8 h-8 rounded-full bg-neutral-100 text-neutral-500 hover:text-neutral-800 flex items-center justify-center font-bold"
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 space-y-5">
              {/* Info Badges */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-neutral-50 p-3.5 rounded-xl border border-neutral-200/80 text-xs">
                <div>
                  <span className="text-neutral-400 block text-[10px] uppercase font-bold">Kode Toko</span>
                  <span className="font-bold text-neutral-900 font-mono">{selectedOrder.storeCode}</span>
                </div>
                <div>
                  <span className="text-neutral-400 block text-[10px] uppercase font-bold">Total Pembayaran</span>
                  <span className="font-extrabold text-emerald-800">
                    Rp {parseFloat(selectedOrder.totalAmount).toLocaleString("id-ID")}
                  </span>
                </div>
                <div>
                  <span className="text-neutral-400 block text-[10px] uppercase font-bold">Status Pesanan</span>
                  <span className="font-bold text-neutral-800 capitalize">
                    {selectedOrder.orderStatus.replace("_", " ")}
                  </span>
                </div>
                <div>
                  <span className="text-neutral-400 block text-[10px] uppercase font-bold">Status Bayar</span>
                  <span className="font-bold text-neutral-800 capitalize">
                    {selectedOrder.paymentStatus.replace("_", " ")}
                  </span>
                </div>
              </div>

              {selectedOrder.customerNotes && (
                <div className="p-3 bg-amber-50/70 border border-amber-200 rounded-xl text-xs text-amber-800">
                  <strong>Catatan Pelanggan:</strong> {selectedOrder.customerNotes}
                </div>
              )}

              {selectedOrder.rejectionReason && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800">
                  <strong>Alasan Penolakan:</strong> {selectedOrder.rejectionReason}
                </div>
              )}

              {/* Private Payment Proof Viewer */}
              <div className="border border-neutral-200 rounded-xl p-4 bg-white">
                <h4 className="text-xs font-bold text-neutral-900 uppercase tracking-wider mb-2">
                  Bukti Pembayaran QRIS Pelanggan
                </h4>
                <div className="flex flex-col sm:flex-row items-center gap-4">
                  <div className="w-48 h-48 bg-neutral-100 rounded-xl border border-neutral-200 overflow-hidden relative shadow-xs flex items-center justify-center shrink-0">
                    {/* Secure authorized image load */}
                    <Image
                      src={`/api/admin/proof/${selectedOrder.id}`}
                      alt="Bukti Transfer Pelanggan"
                      width={192}
                      height={192}
                      unoptimized
                      className="w-full h-full object-contain"
                    />
                  </div>
                  <div className="space-y-2 text-xs text-neutral-600">
                    <p>
                      <strong>Nama File:</strong> {selectedOrder.paymentProofOriginalName || selectedOrder.paymentProofRef}
                    </p>
                    <p>
                      <strong>Ukuran File:</strong> {(selectedOrder.paymentProofSize / 1024).toFixed(1)} KB
                    </p>
                    <p>
                      <strong>Tipe MIME:</strong> {selectedOrder.paymentProofMime}
                    </p>
                    <p>
                      <strong>Diunggah:</strong>{" "}
                      {new Date(selectedOrder.paymentProofUploadedAt).toLocaleString("id-ID")}
                    </p>
                    <a
                      href={`/api/admin/proof/${selectedOrder.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-2 px-3 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-800 rounded-lg text-xs font-semibold"
                    >
                      Buka Gambar Penuh ↗
                    </a>
                  </div>
                </div>
              </div>

              {/* Action Buttons Container */}
              <div className="pt-4 border-t border-neutral-200 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {/* Payment Verification Buttons */}
                  {selectedOrder.paymentStatus !== "verified" && (
                    <button
                      onClick={() => handleVerifyPayment(selectedOrder.id)}
                      disabled={loadingAction}
                      className="px-3.5 py-2 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold active:scale-95 disabled:opacity-50"
                    >
                      ✓ Verifikasi Pembayaran
                    </button>
                  )}
                  {selectedOrder.paymentStatus !== "rejected" && (
                    <button
                      onClick={() => handleOpenRejectModal("payment")}
                      disabled={loadingAction}
                      className="px-3.5 py-2 rounded-xl bg-neutral-100 hover:bg-rose-100 text-rose-700 text-xs font-semibold active:scale-95 disabled:opacity-50"
                    >
                      Tolak Bukti Bayar
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {/* Order Confirmation / Rejection */}
                  {selectedOrder.orderStatus === "pending_review" && (
                    <>
                      <button
                        onClick={() => handleOpenRejectModal("order")}
                        disabled={loadingAction}
                        className="px-4 py-2 rounded-xl bg-neutral-100 hover:bg-rose-50 text-rose-700 text-xs font-semibold active:scale-95 disabled:opacity-50"
                      >
                        Tolak Pesanan
                      </button>
                      <button
                        onClick={() => handleConfirmOrder(selectedOrder.id)}
                        disabled={loadingAction}
                        className="px-5 py-2 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-bold shadow-md shadow-emerald-900/20 active:scale-95 disabled:opacity-50"
                      >
                        ✓ Konfirmasi Pesanan (Buat SO)
                      </button>
                    </>
                  )}
                  {selectedOrder.orderStatus === "confirmed" && (
                    <span className="text-xs font-bold text-emerald-800 bg-emerald-50 px-3 py-1.5 rounded-xl border border-emerald-200">
                      ✓ Telah Dikonversi ke SO
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* REJECT REASON MODAL */}
      {/* ==================================================================== */}
      {showRejectModal && (
        <div className="fixed inset-0 z-60 bg-neutral-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-5 max-w-md w-full shadow-2xl border border-neutral-200">
            <h3 className="text-sm font-bold text-neutral-900 mb-1">
              {rejectType === "order" ? "Tolak Pesanan Pelanggan" : "Tolak Bukti Pembayaran"}
            </h3>
            <p className="text-xs text-neutral-500 mb-4">
              Alasan penolakan wajib dicatat dalam audit trail sistem dan akan ditampilkan kepada pelanggan.
            </p>

            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Contoh: Bukti transfer buram / nominal tidak sesuai / stok tidak mencukupi..."
              rows={3}
              required
              className="w-full p-3 text-xs bg-neutral-50 border border-neutral-200 rounded-xl outline-none focus:ring-2 focus:ring-rose-500 focus:bg-white mb-4"
            />

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowRejectModal(false)}
                className="px-4 py-2 rounded-xl bg-neutral-100 text-neutral-700 text-xs font-semibold hover:bg-neutral-200"
              >
                Batal
              </button>
              <button
                onClick={handleExecuteReject}
                disabled={loadingAction || rejectReason.trim().length < 3}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold disabled:opacity-50"
              >
                {loadingAction ? "Memproses..." : "Konfirmasi Penolakan"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
