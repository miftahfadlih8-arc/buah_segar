"use client";

import React, { useState } from "react";
import Image from "next/image";
import {
  generateStoreQrAction,
  updateMerchantQrisConfigAction,
} from "@/server/modules/customer-orders/actions";
import type { MerchantQrisConfig, StoreQrGenerationResult } from "@/server/modules/customer-orders";

interface StoreItem {
  id: string;
  code: string;
  name: string;
  segment: string;
  isActive: boolean;
  phone: string | null;
  shippingAddress: string;
}

interface QrTokoClientProps {
  stores: StoreItem[];
  initialQrisConfig: MerchantQrisConfig;
  baseUrl: string;
  initialQrResult?: StoreQrGenerationResult | null;
}

export function QrTokoClient({
  stores,
  initialQrisConfig,
  baseUrl,
  initialQrResult = null,
}: QrTokoClientProps) {
  const [selectedStore, setSelectedStore] = useState<StoreItem | null>(stores[0] || null);
  const [qrResult, setQrResult] = useState<StoreQrGenerationResult | null>(initialQrResult);
  const [loadingQr, setLoadingQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"qr_generator" | "qris_settings">("qr_generator");

  // QRIS Config Form State
  const [qrisConfig, setQrisConfig] = useState<MerchantQrisConfig>(initialQrisConfig);
  const [savingQris, setSavingQris] = useState(false);
  const [qrisSuccess, setQrisSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const filteredStores = stores.filter(
    (s) =>
      s.code.toLowerCase().includes(search.toLowerCase()) ||
      s.name.toLowerCase().includes(search.toLowerCase()),
  );

  const handleSelectStore = async (store: StoreItem) => {
    setSelectedStore(store);
    setLoadingQr(true);
    setErrorMsg(null);

    try {
      const res = await generateStoreQrAction(store.code, { baseUrl });
      setQrResult(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal membuat QR Code toko.";
      setErrorMsg(msg);
    } finally {
      setLoadingQr(false);
    }
  };

  const handleCopyLink = () => {
    if (!qrResult) return;
    navigator.clipboard.writeText(qrResult.orderUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadPng = () => {
    if (!qrResult) return;
    const a = document.createElement("a");
    a.href = qrResult.qrPngDataUrl;
    a.download = `QR_ORDER_${qrResult.storeCode}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleDownloadSvg = () => {
    if (!qrResult) return;
    const blob = new Blob([qrResult.qrSvgString], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `QR_ORDER_${qrResult.storeCode}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePrintSheet = () => {
    if (!qrResult || !selectedStore) return;

    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Cetak QR Order Toko — ${selectedStore.name}</title>
          <style>
            @page { size: A4 portrait; margin: 15mm; }
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; color: #1e293b; padding: 20px; }
            .card { border: 2px solid #065f46; border-radius: 20px; padding: 40px; max-width: 500px; margin: 0 auto; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
            .brand { font-size: 14px; text-transform: uppercase; letter-spacing: 2px; color: #065f46; font-weight: bold; margin-bottom: 8px; }
            .title { font-size: 26px; font-weight: 800; color: #0f172a; margin: 0 0 10px 0; }
            .store-name { font-size: 20px; font-weight: 700; color: #047857; margin: 15px 0 5px 0; }
            .store-code { display: inline-block; background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; font-family: monospace; font-size: 16px; font-weight: bold; padding: 6px 16px; rounded: 8px; border-radius: 8px; margin-bottom: 25px; }
            .qr-image { width: 300px; height: 300px; margin: 0 auto; display: block; }
            .instructions { font-size: 13px; color: #475569; margin-top: 25px; line-height: 1.6; }
            .footer { font-size: 11px; color: #94a3b8; margin-top: 30px; border-top: 1px dashed #cbd5e1; pt: 15px; padding-top: 15px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="brand">PT Suplayer Buah Bekasi</div>
            <h1 class="title">Pesan Buah Segar dengan Mudah</h1>
            <div class="store-name">${selectedStore.name}</div>
            <div class="store-code">KODE TOKO: ${selectedStore.code}</div>
            <img class="qr-image" src="${qrResult.qrPngDataUrl}" alt="QR Order" />
            <div class="instructions">
              <strong>Cara Memesan:</strong><br/>
              1. Buka kamera ponsel atau aplikasi pemindai QR.<br/>
              2. Scan kode QR di atas atau buka link: <em>${qrResult.orderUrl}</em><br/>
              3. Masukkan kode toko <strong>${selectedStore.code}</strong> jika diminta.<br/>
              4. Pilih buah segar, lakukan pembayaran QRIS, dan upload bukti.
            </div>
            <div class="footer">
              Fresh Distribution Business OS Bekasi • Dicetak pada ${new Date().toLocaleDateString("id-ID")}
            </div>
          </div>
          <script>
            window.onload = function() { window.print(); window.close(); }
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  const handleSaveQris = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingQris(true);
    setErrorMsg(null);
    setQrisSuccess(false);

    try {
      await updateMerchantQrisConfigAction(qrisConfig);
      setQrisSuccess(true);
      setTimeout(() => setQrisSuccess(false), 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal menyimpan konfigurasi QRIS.";
      setErrorMsg(msg);
    } finally {
      setSavingQris(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Tabs */}
      <div className="flex items-center justify-between border-b border-neutral-200 pb-4">
        <div>
          <h1 className="text-xl font-bold text-neutral-900 tracking-tight">
            QR Generator & Konfigurasi Pembayaran
          </h1>
          <p className="text-xs text-neutral-500 mt-1">
            Kelola lembar QR order resmi per toko dan pengaturan merchant QRIS terpusat.
          </p>
        </div>

        <div className="flex items-center gap-2 bg-neutral-100 p-1 rounded-xl">
          <button
            onClick={() => setActiveTab("qr_generator")}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
              activeTab === "qr_generator"
                ? "bg-white text-emerald-900 shadow-xs"
                : "text-neutral-600 hover:text-neutral-900"
            }`}
          >
            QR Order Per Toko
          </button>
          <button
            onClick={() => setActiveTab("qris_settings")}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
              activeTab === "qris_settings"
                ? "bg-white text-emerald-900 shadow-xs"
                : "text-neutral-600 hover:text-neutral-900"
            }`}
          >
            Pengaturan Merchant QRIS
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 font-medium">
          {errorMsg}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 1: QR GENERATOR PER TOKO */}
      {/* ==================================================================== */}
      {activeTab === "qr_generator" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Store Selector List (4 cols) */}
          <div className="lg:col-span-4 bg-white rounded-2xl border border-neutral-200 p-4 shadow-xs flex flex-col h-[650px]">
            <div className="mb-3">
              <label htmlFor="search-store" className="block text-xs font-bold text-neutral-700 mb-1">
                Pilih Toko / Pelanggan ({stores.length})
              </label>
              <input
                id="search-store"
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari kode atau nama toko..."
                className="w-full px-3 py-2 text-xs bg-neutral-50 border border-neutral-200 rounded-xl outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white"
              />
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {filteredStores.map((s) => {
                const isSelected = selectedStore?.id === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => handleSelectStore(s)}
                    className={`w-full text-left p-3 rounded-xl border transition-all ${
                      isSelected
                        ? "bg-emerald-50/80 border-emerald-500 shadow-xs"
                        : "bg-white border-neutral-200 hover:border-neutral-300"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold text-emerald-800">
                        {s.code}
                      </span>
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                          s.isActive ? "bg-emerald-100 text-emerald-800" : "bg-neutral-100 text-neutral-500"
                        }`}
                      >
                        {s.isActive ? "Aktif" : "Nonaktif"}
                      </span>
                    </div>
                    <div className="text-xs font-bold text-neutral-900 mt-1 line-clamp-1">
                      {s.name}
                    </div>
                    <div className="text-[11px] text-neutral-500 line-clamp-1 mt-0.5">
                      {s.shippingAddress}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* QR Display & Action Panel (8 cols) */}
          <div className="lg:col-span-8 bg-white rounded-2xl border border-neutral-200 p-6 shadow-xs flex flex-col justify-between">
            {selectedStore && qrResult ? (
              <div className="space-y-6">
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-[11px] font-mono font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                      KODE: {selectedStore.code}
                    </span>
                    <h2 className="text-lg font-bold text-neutral-900 mt-2">{selectedStore.name}</h2>
                    <p className="text-xs text-neutral-500">{selectedStore.shippingAddress}</p>
                  </div>
                  <span
                    className={`text-xs font-semibold px-2 py-1 rounded-lg ${
                      selectedStore.isActive ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
                    }`}
                  >
                    {selectedStore.isActive ? "Toko Aktif" : "Toko Nonaktif"}
                  </span>
                </div>

                {/* Printable Frame Preview */}
                <div className="p-6 bg-neutral-50 border border-neutral-200 rounded-2xl flex flex-col md:flex-row items-center justify-center gap-8">
                  {/* Scannable QR Frame */}
                  <div className="p-4 bg-white rounded-2xl border border-neutral-200 shadow-sm text-center">
                    {loadingQr ? (
                      <div className="w-56 h-56 flex items-center justify-center">
                        <div className="w-8 h-8 border-4 border-emerald-800 border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : (
                      <>
                        <Image
                          src={qrResult.qrPngDataUrl}
                          alt="QR Code Toko"
                          width={240}
                          height={240}
                          unoptimized
                          className="w-60 h-60 object-contain mx-auto rounded-lg"
                        />
                        <p className="text-[11px] font-bold text-emerald-800 mt-2">
                          Scan untuk Pesan di Toko Ini
                        </p>
                      </>
                    )}
                  </div>

                  {/* QR Details & Direct URL */}
                  <div className="space-y-3 max-w-sm text-left">
                    <div>
                      <span className="text-[11px] text-neutral-500 font-semibold uppercase">URL Order Toko:</span>
                      <div className="p-2.5 bg-white border border-neutral-200 rounded-xl font-mono text-[11px] text-neutral-800 break-all select-all mt-1">
                        {qrResult.orderUrl}
                      </div>
                    </div>

                    <div className="text-xs text-neutral-600 space-y-1">
                      <p>✓ QR Code mengkodekan domain resmi aplikasi.</p>
                      <p>✓ Pelanggan langsung diarahkan ke katalog toko <strong>{selectedStore.name}</strong>.</p>
                      <p>✓ Mendukung cetak poster meja dan kartu barcode.</p>
                    </div>

                    <div className="pt-2">
                      <button
                        onClick={handleCopyLink}
                        className="px-3.5 py-2 rounded-xl bg-neutral-100 hover:bg-neutral-200 text-neutral-800 text-xs font-semibold flex items-center gap-2 active:scale-95 transition-all"
                      >
                        <span>{copied ? "✓ Tersalin!" : "📋 Salin Link Order"}</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Download and Print Actions */}
                <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-neutral-200">
                  <button
                    onClick={handleDownloadPng}
                    className="px-4 py-2.5 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-semibold shadow-xs flex items-center gap-2 active:scale-95 transition-all"
                  >
                    <span>📥 Unduh QR (PNG Resolusi Tinggi)</span>
                  </button>

                  <button
                    onClick={handleDownloadSvg}
                    className="px-4 py-2.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold shadow-xs flex items-center gap-2 active:scale-95 transition-all"
                  >
                    <span>📥 Unduh Vektor (SVG)</span>
                  </button>

                  <button
                    onClick={handlePrintSheet}
                    className="px-4 py-2.5 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-white text-xs font-semibold shadow-xs flex items-center gap-2 active:scale-95 transition-all"
                  >
                    <span>🖨️ Cetak Lembar QR Resmi</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="py-24 text-center text-neutral-400 text-sm">
                Pilih toko dari daftar di sebelah kiri untuk melihat dan mengunduh QR Code.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 2: PENGATURAN MERCHANT QRIS */}
      {/* ==================================================================== */}
      {activeTab === "qris_settings" && (
        <div className="max-w-2xl bg-white rounded-2xl border border-neutral-200 p-6 shadow-xs">
          <div className="mb-6 pb-4 border-b border-neutral-200">
            <h2 className="text-base font-bold text-neutral-900">
              Konfigurasi QRIS Pembayaran Statis Merchant
            </h2>
            <p className="text-xs text-neutral-500 mt-1">
              QRIS ini ditampilkan kepada seluruh pelanggan pada tahap checkout portal order.
            </p>
          </div>

          {qrisSuccess && (
            <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 font-semibold">
              ✓ Konfigurasi QRIS merchant berhasil diperbarui dan disimpan.
            </div>
          )}

          <form onSubmit={handleSaveQris} className="space-y-4">
            <div className="flex items-center gap-3 p-3 bg-neutral-50 rounded-xl border border-neutral-200">
              <input
                type="checkbox"
                id="enable-qris"
                checked={qrisConfig.isEnabled}
                onChange={(e) => setQrisConfig({ ...qrisConfig, isEnabled: e.target.checked })}
                className="w-4 h-4 text-emerald-800 rounded border-neutral-300 focus:ring-emerald-600"
              />
              <label htmlFor="enable-qris" className="text-xs font-bold text-neutral-800">
                Aktifkan Pembayaran QRIS di Portal Pelanggan
              </label>
            </div>

            <div>
              <label className="block text-xs font-bold text-neutral-700 mb-1">
                Nama Merchant Resmi
              </label>
              <input
                type="text"
                value={qrisConfig.merchantName}
                onChange={(e) => setQrisConfig({ ...qrisConfig, merchantName: e.target.value })}
                placeholder="Contoh: PT Suplayer Buah Bekasi"
                required
                className="w-full px-3.5 py-2.5 text-xs bg-white border border-neutral-200 rounded-xl outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-neutral-700 mb-1">
                NMID (National Merchant ID)
              </label>
              <input
                type="text"
                value={qrisConfig.nmid}
                onChange={(e) => setQrisConfig({ ...qrisConfig, nmid: e.target.value })}
                placeholder="Contoh: ID102000000000"
                className="w-full px-3.5 py-2.5 text-xs bg-white border border-neutral-200 rounded-xl outline-none focus:ring-2 focus:ring-emerald-600 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-neutral-700 mb-1">
                URL Gambar QRIS Resmi
              </label>
              <input
                type="url"
                value={qrisConfig.qrisImageUrl || ""}
                onChange={(e) => setQrisConfig({ ...qrisConfig, qrisImageUrl: e.target.value })}
                placeholder="https://.../qris-merchant-bekasi.png"
                className="w-full px-3.5 py-2.5 text-xs bg-white border border-neutral-200 rounded-xl outline-none focus:ring-2 focus:ring-emerald-600 font-mono"
              />
              <p className="text-[11px] text-neutral-400 mt-1">
                Masukkan tautan gambar QRIS resmi milik merchant bank/PPOB. Jika belum ada URL, pelanggan akan melihat petunjuk transfer manual.
              </p>
            </div>

            <div>
              <label className="block text-xs font-bold text-neutral-700 mb-1">
                Instruksi Tambahan untuk Pelanggan
              </label>
              <textarea
                value={qrisConfig.instructions || ""}
                onChange={(e) => setQrisConfig({ ...qrisConfig, instructions: e.target.value })}
                placeholder="Masukkan nominal sesuai rincian checkout. Setelah sukses, simpan resi dan unggah pada halaman berikutnya."
                rows={3}
                className="w-full px-3.5 py-2.5 text-xs bg-white border border-neutral-200 rounded-xl outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>

            <div className="pt-4 border-t border-neutral-200">
              <button
                type="submit"
                disabled={savingQris}
                className="px-5 py-2.5 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-semibold shadow-xs active:scale-95 transition-all disabled:opacity-50"
              >
                {savingQris ? "Menyimpan Konfigurasi..." : "Simpan Konfigurasi QRIS"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
