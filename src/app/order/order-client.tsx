"use client";

import React, { useEffect, useState, useTransition } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import {
  getCatalogAction,
  getOrCreateSessionAction,
  getQrisConfigAction,
  saveCartSessionAction,
  submitCustomerOrderAction,
  validateStoreCodeAction,
} from "@/server/modules/customer-orders/actions";
import type {
  MerchantQrisConfig,
  PublicCatalogItem,
  StoredCartItem,
} from "@/server/modules/customer-orders";

// ============================================================================
// TYPES & STORAGE KEYS
// ============================================================================

type WizardStep =
  | "store_code"
  | "catalog"
  | "cart"
  | "payment_instructions"
  | "upload_proof"
  | "review_confirm";

const STORAGE_KEY_SESSION = "buah_bekasi_qr_session";
const STORAGE_KEY_STORE = "buah_bekasi_qr_store";
const STORAGE_KEY_CART = "buah_bekasi_qr_cart";
const STORAGE_KEY_PROOF = "buah_bekasi_qr_proof";

export interface OrderClientProps {
  initialStoreCode?: string;
}

export function OrderClient({ initialStoreCode = "" }: OrderClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlStore = searchParams.get("store") || initialStoreCode;

  // Lazy initializers from localStorage
  const [store, setStore] = useState<{ id: string; code: string; name: string } | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const saved = localStorage.getItem(STORAGE_KEY_STORE);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [sessionToken, setSessionToken] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try {
      return localStorage.getItem(STORAGE_KEY_SESSION) || "";
    } catch {
      return "";
    }
  });

  const [cart, setCart] = useState<StoredCartItem[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = localStorage.getItem(STORAGE_KEY_CART);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [uploadedProofRef, setUploadedProofRef] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return localStorage.getItem(STORAGE_KEY_PROOF) || null;
    } catch {
      return null;
    }
  });

  // Wizard state
  const [step, setStep] = useState<WizardStep>(() => {
    if (typeof window === "undefined") return "store_code";
    try {
      const savedStore = localStorage.getItem(STORAGE_KEY_STORE);
      const savedSession = localStorage.getItem(STORAGE_KEY_SESSION);
      if (savedStore && savedSession) return "catalog";
    } catch {
      // ignore
    }
    return "store_code";
  });

  const [storeCodeInput, setStoreCodeInput] = useState(() => {
    if (urlStore) return urlStore.toUpperCase();
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(STORAGE_KEY_STORE);
        if (saved) {
          const parsed = JSON.parse(saved);
          return parsed.code || "";
        }
      } catch {
        // ignore
      }
    }
    return "";
  });

  const [catalog, setCatalog] = useState<PublicCatalogItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("Semua");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [customerNotes, setCustomerNotes] = useState<string>("");

  // Payment & QRIS
  const [qrisConfig, setQrisConfig] = useState<MerchantQrisConfig | null>(null);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofPreviewUrl, setProofPreviewUrl] = useState<string | null>(null);

  // Status & Feedback
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Pre-fill / validate store from URL query
  useEffect(() => {
    if (urlStore && (!store || store.code !== urlStore.toUpperCase())) {
      let isMounted = true;
      validateStoreCodeAction(urlStore.toUpperCase())
        .then((res) => {
          if (isMounted && res.valid && res.store) {
            setStore(res.store);
            setStoreCodeInput(res.store.code);
            setStep("catalog");
          }
        })
        .catch(() => {
          // ignore background validation failure
        });
      return () => {
        isMounted = false;
      };
    }
  }, [urlStore, store]);

  // Load catalog & QRIS config whenever store changes
  useEffect(() => {
    if (!store?.code) return;

    startTransition(async () => {
      try {
        const [catRes, qrisRes] = await Promise.all([
          getCatalogAction(store.code),
          getQrisConfigAction(),
        ]);
        setCatalog(catRes.products);
        setQrisConfig(qrisRes);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Gagal memuat katalog buah.";
        setErrorMsg(msg);
      }
    });
  }, [store?.code]);

  // Sync cart to server draft on change
  useEffect(() => {
    if (!sessionToken || cart.length === 0) return;

    const timer = setTimeout(() => {
      saveCartSessionAction({
        sessionToken,
        cartItems: cart.map((c) => ({
          productId: c.productId,
          gradeId: c.gradeId,
          uomCode: c.uomCode,
          quantity: c.quantity,
        })),
        customerNotes,
      }).catch(() => {
        // Silent fail on background autosave
      });
    }, 500);

    return () => clearTimeout(timer);
  }, [cart, sessionToken, customerNotes]);

  // ==========================================================================
  // HANDLERS
  // ==========================================================================

  const handleValidateStore = async (codeToValidate: string) => {
    setErrorMsg(null);
    setIsSubmitting(true);

    try {
      const res = await validateStoreCodeAction(codeToValidate);
      if (!res.valid || !res.store) {
        setErrorMsg(res.error || "Kode toko tidak valid.");
        setIsSubmitting(false);
        return;
      }

      const validatedStore = res.store;
      setStore(validatedStore);
      localStorage.setItem(STORAGE_KEY_STORE, JSON.stringify(validatedStore));

      // Get or create session
      const sess = await getOrCreateSessionAction({
        storeCode: validatedStore.code,
        sessionToken: sessionToken || null,
      });

      setSessionToken(sess.sessionToken);
      localStorage.setItem(STORAGE_KEY_SESSION, sess.sessionToken);

      if (sess.cartItems && sess.cartItems.length > 0) {
        setCart(sess.cartItems);
        localStorage.setItem(STORAGE_KEY_CART, JSON.stringify(sess.cartItems));
      }

      if (sess.paymentProofRef) {
        setUploadedProofRef(sess.paymentProofRef);
        localStorage.setItem(STORAGE_KEY_PROOF, sess.paymentProofRef);
      }

      setStep("catalog");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Terjadi kesalahan saat memeriksa kode toko.";
      setErrorMsg(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddToCart = (product: PublicCatalogItem) => {
    setCart((prev) => {
      const existing = prev.find((item) => item.productId === product.id);
      let nextCart: StoredCartItem[];

      if (existing) {
        const newQty = (parseFloat(existing.quantity) + 1).toString();
        const subtotal = (parseFloat(newQty) * parseFloat(existing.unitPrice)).toFixed(2);
        nextCart = prev.map((item) =>
          item.productId === product.id ? { ...item, quantity: newQty, subtotal } : item,
        );
      } else {
        const newItem: StoredCartItem = {
          productId: product.id,
          productName: product.name,
          gradeId: product.grade.id,
          gradeCode: product.grade.code,
          uomCode: product.baseUomCode,
          quantity: "1",
          unitPrice: product.unitPrice,
          subtotal: product.unitPrice,
        };
        nextCart = [...prev, newItem];
      }

      localStorage.setItem(STORAGE_KEY_CART, JSON.stringify(nextCart));
      return nextCart;
    });
  };

  const handleUpdateCartQty = (productId: string, delta: number) => {
    setCart((prev) => {
      const existing = prev.find((item) => item.productId === productId);
      if (!existing) return prev;

      const currentQty = parseFloat(existing.quantity);
      const newQty = currentQty + delta;

      let nextCart: StoredCartItem[];
      if (newQty <= 0) {
        nextCart = prev.filter((item) => item.productId !== productId);
      } else {
        const subtotal = (newQty * parseFloat(existing.unitPrice)).toFixed(2);
        nextCart = prev.map((item) =>
          item.productId === productId
            ? { ...item, quantity: newQty.toString(), subtotal }
            : item,
        );
      }

      localStorage.setItem(STORAGE_KEY_CART, JSON.stringify(nextCart));
      return nextCart;
    });
  };

  const handleClearCart = () => {
    if (window.confirm("Kosongkan keranjang belanja?")) {
      setCart([]);
      localStorage.removeItem(STORAGE_KEY_CART);
    }
  };

  const calculateTotal = () => {
    return cart.reduce((sum, item) => sum + parseFloat(item.subtotal || "0"), 0);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setErrorMsg(null);
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      setErrorMsg("Ukuran file maksimal 5 MB.");
      return;
    }

    setProofFile(file);
    const preview = URL.createObjectURL(file);
    setProofPreviewUrl(preview);
  };

  const handleUploadProof = async () => {
    if (!proofFile && uploadedProofRef) {
      // Already has proof uploaded, continue
      setStep("review_confirm");
      return;
    }

    if (!proofFile) {
      setErrorMsg("Silakan pilih file bukti pembayaran terlebih dahulu.");
      return;
    }

    setIsUploading(true);
    setErrorMsg(null);

    try {
      const formData = new FormData();
      formData.append("sessionToken", sessionToken);
      formData.append("file", proofFile);

      const res = await fetch("/api/order/upload-proof", {
        method: "POST",
        body: formData,
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Gagal mengunggah bukti pembayaran.");
      }

      setUploadedProofRef(json.data.fileName);
      localStorage.setItem(STORAGE_KEY_PROOF, json.data.fileName);
      setStep("review_confirm");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal mengunggah bukti pembayaran.";
      setErrorMsg(msg);
    } finally {
      setIsUploading(false);
    }
  };

  const handleSubmitOrder = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const idempotencyKey = `req_client_${sessionToken}_${Date.now()}`;
      const result = await submitCustomerOrderAction({
        sessionToken,
        idempotencyKey,
        customerNotes,
      });

      // Clear local cart
      localStorage.removeItem(STORAGE_KEY_CART);
      localStorage.removeItem(STORAGE_KEY_PROOF);
      localStorage.removeItem(STORAGE_KEY_SESSION);

      // Redirect to status page
      router.push(`/order/status?token=${encodeURIComponent(result.statusToken)}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal mengirim pesanan. Silakan coba lagi.";
      setErrorMsg(msg);
      setIsSubmitting(false);
    }
  };

  // Categories list
  const categories = ["Semua", ...Array.from(new Set(catalog.map((p) => p.category)))];
  const filteredCatalog = catalog.filter((p) => {
    const matchesCategory = selectedCategory === "Semua" || p.category === selectedCategory;
    const matchesSearch =
      !searchQuery ||
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.category.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const totalAmount = calculateTotal();
  const totalItemCount = cart.reduce((sum, item) => sum + parseFloat(item.quantity || "0"), 0);

  // ==========================================================================
  // RENDER: SCREEN 1 — MASUKKAN KODE TOKO
  // ==========================================================================
  if (step === "store_code") {
    return (
      <main className="min-h-screen bg-neutral-50 flex flex-col justify-between max-w-md mx-auto shadow-xl relative overflow-hidden">
        {/* Background Decorative Gradient */}
        <div className="absolute top-0 left-0 right-0 h-48 bg-gradient-to-b from-emerald-800 to-emerald-700 -z-0" />

        <div className="relative z-10 px-6 pt-10 pb-6 flex-1 flex flex-col justify-center">
          {/* Brand Header */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-white shadow-md text-emerald-800 mb-3 font-bold text-2xl">
              🍏
            </div>
            <h2 className="text-sm font-semibold tracking-wider text-emerald-100 uppercase">
              Fresh Distribution Business OS Bekasi
            </h2>
            <h1 className="text-2xl font-bold text-neutral-900 mt-6 tracking-tight">
              Selamat Datang di Toko Kami!
            </h1>
            <p className="text-sm text-neutral-600 mt-2 max-w-xs mx-auto">
              Masukkan kode toko yang diberikan oleh admin toko Anda untuk melanjutkan pesanan buah segar.
            </p>
          </div>

          {/* Form Card */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-neutral-200/80">
            {errorMsg && (
              <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium">
                {errorMsg}
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleValidateStore(storeCodeInput);
              }}
              className="space-y-4"
            >
              <div>
                <label htmlFor="store-code" className="block text-xs font-semibold text-neutral-700 uppercase tracking-wide mb-1.5">
                  Kode Toko
                </label>
                <input
                  id="store-code"
                  type="text"
                  value={storeCodeInput}
                  onChange={(e) => setStoreCodeInput(e.target.value.toUpperCase())}
                  placeholder="Contoh: TKB001"
                  required
                  className="w-full px-4 py-3 text-base font-semibold text-neutral-900 bg-neutral-50 border border-neutral-300 rounded-xl focus:ring-2 focus:ring-emerald-600 focus:border-emerald-600 outline-none tracking-widest placeholder:tracking-normal placeholder:font-normal placeholder:text-neutral-400 uppercase"
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting || !storeCodeInput.trim()}
                className="w-full py-3.5 px-4 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white font-semibold text-sm shadow-md shadow-emerald-900/20 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none flex items-center justify-center gap-2"
              >
                {isSubmitting ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Memverifikasi...</span>
                  </>
                ) : (
                  <span>Masuk</span>
                )}
              </button>
            </form>
          </div>

          <div className="mt-8 text-center text-xs text-neutral-500">
            Butuh bantuan? Hubungi admin toko Anda.
          </div>
        </div>

        {/* Fresh Fruit Visual Strip */}
        <div className="relative z-10 w-full px-4 pb-6 flex justify-center gap-2 opacity-80">
          <span className="text-3xl">🍊</span>
          <span className="text-3xl">🍎</span>
          <span className="text-3xl">🍌</span>
          <span className="text-3xl">🍇</span>
          <span className="text-3xl">🥭</span>
          <span className="text-3xl">🍉</span>
        </div>
      </main>
    );
  }

  // ==========================================================================
  // SHARED HEADER FOR SCREENS 2-6
  // ==========================================================================
  return (
    <div className="min-h-screen bg-neutral-100 flex justify-center">
      <main className="w-full max-w-md bg-white min-h-screen flex flex-col shadow-xl relative pb-24">
        {/* Top Header */}
        <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-neutral-200 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {step !== "catalog" ? (
              <button
                onClick={() => {
                  setErrorMsg(null);
                  if (step === "cart") setStep("catalog");
                  else if (step === "payment_instructions") setStep("cart");
                  else if (step === "upload_proof") setStep("payment_instructions");
                  else if (step === "review_confirm") setStep("upload_proof");
                }}
                className="p-1.5 -ml-1 text-neutral-700 hover:text-neutral-900 rounded-lg hover:bg-neutral-100 active:scale-95"
                title="Kembali"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            ) : (
              <button
                onClick={() => setStep("store_code")}
                className="p-1.5 -ml-1 text-neutral-500 hover:text-neutral-800 rounded-lg text-xs font-medium"
                title="Ganti Toko"
              >
                ← Ganti
              </button>
            )}

            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-bold text-neutral-900 line-clamp-1">{store?.name}</span>
                <span className="text-[10px] bg-emerald-100 text-emerald-800 font-semibold px-1.5 py-0.5 rounded">
                  Toko
                </span>
              </div>
              <p className="text-[11px] text-neutral-500 font-mono">Kode: {store?.code}</p>
            </div>
          </div>

          {step === "cart" && cart.length > 0 && (
            <button
              onClick={handleClearCart}
              className="p-1.5 text-neutral-400 hover:text-rose-600 rounded-lg transition-colors"
              title="Kosongkan Keranjang"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </header>

        {/* Global Error Banner */}
        {errorMsg && (
          <div className="mx-4 mt-3 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-start justify-between gap-2">
            <span>{errorMsg}</span>
            <button onClick={() => setErrorMsg(null)} className="text-rose-400 hover:text-rose-700">✕</button>
          </div>
        )}

        {/* ==================================================================== */}
        {/* SCREEN 2 — PILIH BUAH (KATALOG) */}
        {/* ==================================================================== */}
        {step === "catalog" && (
          <div className="flex-1 flex flex-col">
            {/* Search Bar */}
            <div className="p-4 pb-2">
              <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Cari buah segar..."
                  className="w-full pl-10 pr-4 py-2.5 text-sm bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                />
                <svg className="w-4 h-4 text-neutral-400 absolute left-3.5 top-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
            </div>

            {/* Promo Banner */}
            <div className="px-4 py-2">
              <div className="rounded-2xl bg-gradient-to-r from-emerald-800 to-teal-700 p-4 text-white shadow-sm flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold">Buah Segar Setiap Hari</h3>
                  <p className="text-xs text-emerald-100 mt-0.5">Langsung dari petani & kebun terbaik Bekasi</p>
                </div>
                <div className="text-3xl">🥭🍊</div>
              </div>
            </div>

            {/* Categories Carousel */}
            <div className="px-4 py-2">
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-3.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                      selectedCategory === cat
                        ? "bg-emerald-800 text-white shadow-sm"
                        : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Product Grid */}
            <div className="px-4 py-2 flex-1">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-700">
                  Daftar Produk ({filteredCatalog.length})
                </h4>
              </div>

              {isPending && catalog.length === 0 ? (
                <div className="py-12 text-center text-sm text-neutral-400">
                  Memuat katalog buah segar...
                </div>
              ) : filteredCatalog.length === 0 ? (
                <div className="py-12 text-center text-sm text-neutral-400">
                  Tidak ada buah yang sesuai dengan pencarian.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {filteredCatalog.map((prod) => {
                    const inCartItem = cart.find((c) => c.productId === prod.id);
                    const qtyInCart = inCartItem ? parseFloat(inCartItem.quantity) : 0;

                    return (
                      <div
                        key={prod.id}
                        className="bg-white rounded-2xl p-3 border border-neutral-200/90 shadow-sm flex flex-col justify-between hover:border-emerald-300 transition-all"
                      >
                        <div>
                          {/* Fruit Emoji / Photo Representation */}
                          <div className="w-full h-24 bg-emerald-50/60 rounded-xl flex items-center justify-center text-4xl mb-2.5 relative">
                            {prod.category.toLowerCase().includes("jeruk") ? "🍊" :
                             prod.category.toLowerCase().includes("apel") ? "🍎" :
                             prod.category.toLowerCase().includes("pisang") ? "🍌" :
                             prod.category.toLowerCase().includes("mangga") ? "🥭" :
                             prod.category.toLowerCase().includes("semangka") ? "🍉" :
                             prod.category.toLowerCase().includes("anggur") ? "🍇" : "🍏"}
                            <span className="absolute top-1.5 right-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-white/90 text-emerald-800 shadow-xs">
                              {prod.grade.code}
                            </span>
                          </div>

                          <h5 className="text-xs font-bold text-neutral-900 line-clamp-1">{prod.name}</h5>
                          <p className="text-[11px] text-neutral-500 font-medium">
                            {prod.grade.name} • {prod.baseUomCode}
                          </p>
                          <div className="mt-1 flex items-baseline gap-1">
                            <span className="text-xs font-extrabold text-emerald-800">
                              Rp {parseInt(prod.unitPrice, 10).toLocaleString("id-ID")}
                            </span>
                            <span className="text-[10px] text-neutral-400 font-normal">/{prod.baseUomCode}</span>
                          </div>
                        </div>

                        {/* Cart Stepper / Add Button */}
                        <div className="mt-3 pt-2 border-t border-neutral-100 flex items-center justify-between">
                          {qtyInCart > 0 ? (
                            <div className="w-full flex items-center justify-between bg-neutral-100 rounded-lg p-1">
                              <button
                                onClick={() => handleUpdateCartQty(prod.id, -1)}
                                className="w-6 h-6 rounded-md bg-white text-neutral-800 font-bold flex items-center justify-center shadow-xs active:scale-95"
                              >
                                -
                              </button>
                              <span className="text-xs font-bold text-neutral-900">{qtyInCart}</span>
                              <button
                                onClick={() => handleUpdateCartQty(prod.id, 1)}
                                className="w-6 h-6 rounded-md bg-emerald-800 text-white font-bold flex items-center justify-center shadow-xs active:scale-95"
                              >
                                +
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleAddToCart(prod)}
                              className="w-full py-1.5 px-3 rounded-lg bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-semibold flex items-center justify-center gap-1.5 active:scale-95 transition-all shadow-xs"
                            >
                              <span>+</span>
                              <span>Pesan</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Bottom Floating Cart Bar */}
            {cart.length > 0 && (
              <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto p-3 bg-white/95 backdrop-blur-md border-t border-neutral-200 z-40">
                <button
                  onClick={() => setStep("cart")}
                  className="w-full py-3.5 px-4 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white font-semibold text-sm shadow-md shadow-emerald-900/20 flex items-center justify-between active:scale-[0.99] transition-all"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-emerald-700 text-white text-xs font-bold flex items-center justify-center">
                      {totalItemCount}
                    </span>
                    <span>Keranjang</span>
                  </div>
                  <div className="flex items-center gap-1 font-bold">
                    <span>Rp {totalAmount.toLocaleString("id-ID")}</span>
                    <span>→</span>
                  </div>
                </button>
              </div>
            )}
          </div>
        )}

        {/* ==================================================================== */}
        {/* SCREEN 3 — KERANJANG */}
        {/* ==================================================================== */}
        {step === "cart" && (
          <div className="p-4 flex-1 flex flex-col justify-between">
            <div>
              <h3 className="text-base font-bold text-neutral-900 mb-4">Keranjang Belanja</h3>

              {cart.length === 0 ? (
                <div className="py-16 text-center">
                  <div className="text-4xl mb-3">🛒</div>
                  <p className="text-sm font-semibold text-neutral-800">Keranjang masih kosong</p>
                  <p className="text-xs text-neutral-500 mt-1">Pilih buah segar dari katalog toko.</p>
                  <button
                    onClick={() => setStep("catalog")}
                    className="mt-4 px-4 py-2 bg-emerald-800 text-white rounded-xl text-xs font-semibold"
                  >
                    Buka Katalog
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {cart.map((item) => (
                    <div
                      key={item.productId}
                      className="bg-white p-3.5 rounded-2xl border border-neutral-200/90 shadow-xs flex items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 bg-emerald-50 rounded-xl flex items-center justify-center text-2xl">
                          🍏
                        </div>
                        <div>
                          <h4 className="text-xs font-bold text-neutral-900">{item.productName}</h4>
                          <p className="text-[11px] text-neutral-500 font-medium">
                            {item.gradeCode} • {item.uomCode} • Rp {parseInt(item.unitPrice, 10).toLocaleString("id-ID")}
                          </p>
                          <p className="text-xs font-bold text-emerald-800 mt-0.5">
                            Rp {parseFloat(item.subtotal).toLocaleString("id-ID")}
                          </p>
                        </div>
                      </div>

                      {/* Quantity Stepper */}
                      <div className="flex items-center gap-2 bg-neutral-100 rounded-lg p-1">
                        <button
                          onClick={() => handleUpdateCartQty(item.productId, -1)}
                          className="w-7 h-7 rounded-md bg-white text-neutral-800 font-bold flex items-center justify-center shadow-xs active:scale-95"
                        >
                          -
                        </button>
                        <span className="w-6 text-center text-xs font-bold text-neutral-900">
                          {item.quantity}
                        </span>
                        <button
                          onClick={() => handleUpdateCartQty(item.productId, 1)}
                          className="w-7 h-7 rounded-md bg-emerald-800 text-white font-bold flex items-center justify-center shadow-xs active:scale-95"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  ))}

                  {/* Customer Notes */}
                  <div className="mt-4">
                    <label htmlFor="notes" className="block text-xs font-semibold text-neutral-700 mb-1">
                      Catatan Pesanan (Opsional)
                    </label>
                    <textarea
                      id="notes"
                      value={customerNotes}
                      onChange={(e) => setCustomerNotes(e.target.value)}
                      placeholder="Contoh: Pilih buah yang matang sedang untuk kedai jus..."
                      rows={2}
                      className="w-full p-3 text-xs bg-neutral-50 border border-neutral-200 rounded-xl outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white"
                    />
                  </div>
                </div>
              )}
            </div>

            {cart.length > 0 && (
              <div className="mt-6 pt-4 border-t border-neutral-200">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-xs font-medium text-neutral-500">Total (Estimasi)</span>
                  <span className="text-lg font-bold text-neutral-900">
                    Rp {totalAmount.toLocaleString("id-ID")}
                  </span>
                </div>

                <button
                  onClick={() => setStep("payment_instructions")}
                  className="w-full py-3.5 px-4 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white font-semibold text-sm shadow-md shadow-emerald-900/20 active:scale-[0.98] transition-all"
                >
                  Lanjut ke Pembayaran
                </button>
              </div>
            )}
          </div>
        )}

        {/* ==================================================================== */}
        {/* SCREEN 4 — INSTRUKSI PEMBAYARAN (QRIS RESMI) */}
        {/* ==================================================================== */}
        {step === "payment_instructions" && (
          <div className="p-4 flex-1 flex flex-col justify-between">
            <div>
              {/* Stepper Wizard Indicator */}
              <div className="flex items-center justify-between mb-6 px-2">
                <div className="flex flex-col items-center">
                  <span className="w-6 h-6 rounded-full bg-emerald-800 text-white text-xs font-bold flex items-center justify-center">1</span>
                  <span className="text-[10px] text-emerald-800 font-semibold mt-1">Keranjang</span>
                </div>
                <div className="flex-1 h-0.5 bg-emerald-800 mx-1 mb-3" />
                <div className="flex flex-col items-center">
                  <span className="w-6 h-6 rounded-full bg-emerald-800 text-white text-xs font-bold flex items-center justify-center">2</span>
                  <span className="text-[10px] text-emerald-800 font-bold mt-1">Pembayaran</span>
                </div>
                <div className="flex-1 h-0.5 bg-neutral-200 mx-1 mb-3" />
                <div className="flex flex-col items-center">
                  <span className="w-6 h-6 rounded-full bg-neutral-200 text-neutral-500 text-xs font-bold flex items-center justify-center">3</span>
                  <span className="text-[10px] text-neutral-400 font-medium mt-1">Upload</span>
                </div>
                <div className="flex-1 h-0.5 bg-neutral-200 mx-1 mb-3" />
                <div className="flex flex-col items-center">
                  <span className="w-6 h-6 rounded-full bg-neutral-200 text-neutral-500 text-xs font-bold flex items-center justify-center">4</span>
                  <span className="text-[10px] text-neutral-400 font-medium mt-1">Konfirmasi</span>
                </div>
              </div>

              {/* Total Card */}
              <div className="bg-emerald-50/60 border border-emerald-200/80 rounded-2xl p-4 text-center mb-4">
                <span className="text-xs font-medium text-emerald-800">Total Pembayaran</span>
                <h3 className="text-2xl font-black text-neutral-900 mt-1">
                  Rp {totalAmount.toLocaleString("id-ID")}
                </h3>
              </div>

              {/* QRIS Container */}
              <div className="bg-white border border-neutral-200 rounded-2xl p-5 shadow-sm text-center">
                <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-800 mb-1">
                  Scan QRIS Pembayaran
                </h4>
                <p className="text-xs text-neutral-500 mb-4">
                  Gunakan aplikasi e-wallet atau m-banking apa saja (GoPay, OVO, Dana, BCA, Mandiri, dll).
                </p>

                {qrisConfig?.isEnabled && qrisConfig.qrisImageUrl ? (
                  <div className="space-y-3">
                    <div className="inline-block p-3 bg-white border border-neutral-200 rounded-xl shadow-xs">
                      <Image
                        src={qrisConfig.qrisImageUrl}
                        alt="QRIS Pembayaran Resmi"
                        width={220}
                        height={220}
                        unoptimized
                        className="w-52 h-52 object-contain mx-auto"
                      />
                    </div>
                    <div className="text-xs font-bold text-neutral-800">
                      {qrisConfig.merchantName}
                    </div>
                    {qrisConfig.nmid && (
                      <div className="text-[11px] font-mono text-neutral-500">
                        NMID: {qrisConfig.nmid}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="p-6 bg-amber-50 rounded-xl border border-amber-200 text-amber-800 text-xs">
                    <div className="text-2xl mb-2">⚠️</div>
                    <p className="font-bold">QRIS Pembayaran Sedang Disiapkan</p>
                    <p className="mt-1 text-amber-700">
                      Merchant QRIS resmi sedang dalam konfigurasi oleh Admin. Anda tetap dapat melanjutkan pesanan dan melakukan transfer atau verifikasi manual dengan admin toko.
                    </p>
                  </div>
                )}

                <div className="mt-4 p-3 rounded-xl bg-neutral-50 border border-neutral-100 text-[11px] text-neutral-600 text-left space-y-1">
                  <p className="font-semibold text-neutral-800">Petunjuk Pembayaran:</p>
                  <p>1. Masukkan nominal tepat: <strong>Rp {totalAmount.toLocaleString("id-ID")}</strong>.</p>
                  <p>2. Simpan bukti transfer / tangkapan layar transaksi berhasil.</p>
                  <p>3. Unggah bukti pembayaran pada langkah berikutnya.</p>
                </div>
              </div>
            </div>

            <button
              onClick={() => setStep("upload_proof")}
              className="mt-6 w-full py-3.5 px-4 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white font-semibold text-sm shadow-md shadow-emerald-900/20 active:scale-[0.98] transition-all"
            >
              Lanjut ke Upload Bukti
            </button>
          </div>
        )}

        {/* ==================================================================== */}
        {/* SCREEN 5 — UPLOAD BUKTI PEMBAYARAN */}
        {/* ==================================================================== */}
        {step === "upload_proof" && (
          <div className="p-4 flex-1 flex flex-col justify-between">
            <div>
              {/* Stepper Wizard Indicator */}
              <div className="flex items-center justify-between mb-6 px-2">
                <div className="flex flex-col items-center">
                  <span className="w-6 h-6 rounded-full bg-emerald-800 text-white text-xs font-bold flex items-center justify-center">✓</span>
                  <span className="text-[10px] text-emerald-800 font-semibold mt-1">Keranjang</span>
                </div>
                <div className="flex-1 h-0.5 bg-emerald-800 mx-1 mb-3" />
                <div className="flex flex-col items-center">
                  <span className="w-6 h-6 rounded-full bg-emerald-800 text-white text-xs font-bold flex items-center justify-center">✓</span>
                  <span className="text-[10px] text-emerald-800 font-semibold mt-1">Pembayaran</span>
                </div>
                <div className="flex-1 h-0.5 bg-emerald-800 mx-1 mb-3" />
                <div className="flex flex-col items-center">
                  <span className="w-6 h-6 rounded-full bg-emerald-800 text-white text-xs font-bold flex items-center justify-center">3</span>
                  <span className="text-[10px] text-emerald-800 font-bold mt-1">Upload</span>
                </div>
                <div className="flex-1 h-0.5 bg-neutral-200 mx-1 mb-3" />
                <div className="flex flex-col items-center">
                  <span className="w-6 h-6 rounded-full bg-neutral-200 text-neutral-500 text-xs font-bold flex items-center justify-center">4</span>
                  <span className="text-[10px] text-neutral-400 font-medium mt-1">Konfirmasi</span>
                </div>
              </div>

              <div className="p-3 bg-emerald-50/70 border border-emerald-200/80 rounded-xl text-xs text-emerald-800 font-medium mb-4 flex items-center gap-2">
                <span>ℹ️</span>
                <span>Pastikan bukti pembayaran jelas (mencantumkan nominal dan waktu transaksi).</span>
              </div>

              {/* Upload Dropzone */}
              <div className="bg-white border-2 border-dashed border-neutral-300 rounded-2xl p-6 text-center hover:border-emerald-600 transition-colors">
                <input
                  type="file"
                  id="proof-upload"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleFileChange}
                  className="hidden"
                />

                {proofPreviewUrl ? (
                  <div className="space-y-3">
                    <div className="w-40 h-40 mx-auto rounded-xl overflow-hidden border border-neutral-200 relative shadow-sm">
                      <Image
                        src={proofPreviewUrl}
                        alt="Preview Bukti Pembayaran"
                        fill
                        unoptimized
                        className="object-cover"
                      />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-neutral-800">{proofFile?.name}</p>
                      <p className="text-[11px] text-neutral-500">
                        {((proofFile?.size || 0) / 1024 / 1024).toFixed(2)} MB
                      </p>
                    </div>
                    <label
                      htmlFor="proof-upload"
                      className="inline-block px-3 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 rounded-lg text-xs font-semibold cursor-pointer active:scale-95"
                    >
                      Ganti Foto Bukti
                    </label>
                  </div>
                ) : uploadedProofRef ? (
                  <div className="space-y-3 py-4">
                    <div className="text-4xl text-emerald-600">✓</div>
                    <p className="text-xs font-bold text-neutral-800">Bukti Pembayaran Sudah Diunggah</p>
                    <p className="text-[11px] text-neutral-500">File tersimpan aman di server.</p>
                    <label
                      htmlFor="proof-upload"
                      className="inline-block px-3 py-1.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 rounded-lg text-xs font-semibold cursor-pointer"
                    >
                      Unggah File Baru
                    </label>
                  </div>
                ) : (
                  <label htmlFor="proof-upload" className="cursor-pointer block py-6">
                    <div className="w-12 h-12 rounded-full bg-emerald-50 text-emerald-800 flex items-center justify-center text-2xl mx-auto mb-3">
                      📤
                    </div>
                    <h4 className="text-xs font-bold text-neutral-900 mb-1">
                      Klik untuk Memilih File atau Foto
                    </h4>
                    <p className="text-[11px] text-neutral-500">
                      Format: JPG, PNG, WEBP (Maksimal 5 MB)
                    </p>
                  </label>
                )}
              </div>
            </div>

            <button
              onClick={handleUploadProof}
              disabled={isUploading || (!proofFile && !uploadedProofRef)}
              className="mt-6 w-full py-3.5 px-4 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white font-semibold text-sm shadow-md shadow-emerald-900/20 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none flex items-center justify-center gap-2"
            >
              {isUploading ? (
                <>
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Mengunggah Bukti...</span>
                </>
              ) : (
                <span>Lanjut ke Review Pesanan</span>
              )}
            </button>
          </div>
        )}

        {/* ==================================================================== */}
        {/* SCREEN 6 — REVIEW DAN KONFIRMASI */}
        {/* ==================================================================== */}
        {step === "review_confirm" && (
          <div className="p-4 flex-1 flex flex-col justify-between">
            <div>
              {/* Stepper Wizard Indicator */}
              <div className="flex items-center justify-between mb-6 px-2">
                <div className="flex flex-col items-center">
                  <span className="w-6 h-6 rounded-full bg-emerald-800 text-white text-xs font-bold flex items-center justify-center">✓</span>
                  <span className="text-[10px] text-emerald-800 font-semibold mt-1">Keranjang</span>
                </div>
                <div className="flex-1 h-0.5 bg-emerald-800 mx-1 mb-3" />
                <div className="flex flex-col items-center">
                  <span className="w-6 h-6 rounded-full bg-emerald-800 text-white text-xs font-bold flex items-center justify-center">✓</span>
                  <span className="text-[10px] text-emerald-800 font-semibold mt-1">Pembayaran</span>
                </div>
                <div className="flex-1 h-0.5 bg-emerald-800 mx-1 mb-3" />
                <div className="flex flex-col items-center">
                  <span className="w-6 h-6 rounded-full bg-emerald-800 text-white text-xs font-bold flex items-center justify-center">✓</span>
                  <span className="text-[10px] text-emerald-800 font-semibold mt-1">Upload</span>
                </div>
                <div className="flex-1 h-0.5 bg-emerald-800 mx-1 mb-3" />
                <div className="flex flex-col items-center">
                  <span className="w-6 h-6 rounded-full bg-emerald-800 text-white text-xs font-bold flex items-center justify-center">4</span>
                  <span className="text-[10px] text-emerald-800 font-bold mt-1">Konfirmasi</span>
                </div>
              </div>

              <h3 className="text-sm font-bold text-neutral-900 mb-3">Ringkasan Pesanan</h3>

              {/* Items Card */}
              <div className="bg-white border border-neutral-200 rounded-2xl p-4 shadow-xs space-y-3 mb-4">
                {cart.map((item) => (
                  <div key={item.productId} className="flex items-center justify-between text-xs">
                    <div>
                      <p className="font-bold text-neutral-900">{item.productName}</p>
                      <p className="text-[11px] text-neutral-500">
                        {item.quantity} {item.uomCode} × Rp {parseInt(item.unitPrice, 10).toLocaleString("id-ID")}
                      </p>
                    </div>
                    <span className="font-bold text-neutral-900">
                      Rp {parseFloat(item.subtotal).toLocaleString("id-ID")}
                    </span>
                  </div>
                ))}

                <div className="pt-3 border-t border-neutral-100 flex items-center justify-between">
                  <span className="text-xs font-bold text-neutral-800">Total Pembayaran</span>
                  <span className="text-base font-black text-emerald-800">
                    Rp {totalAmount.toLocaleString("id-ID")}
                  </span>
                </div>
              </div>

              {/* Details Card */}
              <div className="bg-neutral-50 border border-neutral-200/80 rounded-2xl p-4 text-xs space-y-2 mb-4">
                <div className="flex justify-between">
                  <span className="text-neutral-500">Toko Tujuan</span>
                  <span className="font-bold text-neutral-900">{store?.name} ({store?.code})</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Metode Bayar</span>
                  <span className="font-bold text-neutral-900">QRIS Statis Resmi</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-neutral-500">Bukti Transfer</span>
                  <span className="text-emerald-700 font-bold flex items-center gap-1">
                    <span>✓</span> Terunggah
                  </span>
                </div>
                {customerNotes && (
                  <div className="pt-2 border-t border-neutral-200">
                    <span className="text-neutral-500 block mb-0.5">Catatan:</span>
                    <span className="font-medium text-neutral-800">{customerNotes}</span>
                  </div>
                )}
              </div>

              <div className="p-3 bg-emerald-50/70 border border-emerald-200/80 rounded-xl text-xs text-emerald-800">
                Pesanan Anda akan langsung diproses dan dikirim setelah pembayaran diverifikasi oleh admin toko.
              </div>
            </div>

            <button
              onClick={handleSubmitOrder}
              disabled={isSubmitting}
              className="mt-6 w-full py-4 px-4 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white font-bold text-sm shadow-md shadow-emerald-900/20 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none flex items-center justify-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Memproses Pesanan...</span>
                </>
              ) : (
                <span>Konfirmasi Pesanan</span>
              )}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
