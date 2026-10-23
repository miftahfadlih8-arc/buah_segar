import { redirect } from "next/navigation";
import { Icon } from "@/components/ui/icons";
import { getSessionActor } from "@/server/auth/session";
import { LoginForm } from "./login-form";

export default async function MasukPage() {
  const actor = await getSessionActor();
  if (actor) {
    redirect("/");
  }

  const isDevMode =
    process.env.NODE_ENV !== "production" && process.env.APP_ENV !== "production";
  const devSeedPassword = isDevMode ? process.env.DEV_SEED_PASSWORD?.trim() : undefined;
  const devQuickFill =
    isDevMode && devSeedPassword && devSeedPassword.length >= 8
      ? {
          password: devSeedPassword,
          accounts: [
            { u: "admin_demo", label: "Admin" },
            { u: "owner_demo", label: "Owner" },
            { u: "pembelian_demo", label: "Pengadaan" },
            { u: "gudang_bks1", label: "Gudang BKS1" },
            { u: "qc_bks1", label: "QC BKS1" },
            { u: "sales_demo", label: "Sales" },
            { u: "keuangan_demo", label: "Keuangan" },
          ],
        }
      : null;

  return (
    <main className="grid min-h-screen bg-[#f6f8fb] lg:grid-cols-12">
      {/* Left Enterprise Brand Panel */}
      <section className="hidden flex-col justify-between bg-[#0b1324] p-10 text-slate-100 lg:col-span-5 lg:flex xl:p-12">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30">
              <Icon name="leaf" size={20} />
            </div>
            <div>
              <div className="text-base font-bold tracking-tight text-white">Nusantara Segar</div>
              <div className="text-[11px] font-semibold tracking-[0.14em] text-slate-400 uppercase">
                ERP Distribusi Buah • Bekasi
              </div>
            </div>
          </div>

          <h1 className="mt-12 text-3xl font-bold tracking-tight text-white xl:text-4xl">
            Sistem Operasi Terpadu Distribusi Buah Segar Bekasi
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-300">
            Platform operasional dari hulu ke hilir: pembelian petani, timbang aktual &amp; QC,
            grading A/B/C, kontrol batch FEFO, daftar harga &amp; margin, hingga eksposur kredit
            dan buku besar berpasangan.
          </p>
        </div>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-[#1e2f4f] bg-[#111d35] p-3.5">
              <div className="text-xs font-bold text-emerald-400">Kontrol Mutu &amp; FEFO</div>
              <p className="mt-1 text-xs text-slate-300">
                Prioritas batch otomatis berdasarkan tanggal batas mutu dan alokasi biaya RSV.
              </p>
            </div>
            <div className="rounded-xl border border-[#1e2f4f] bg-[#111d35] p-3.5">
              <div className="text-xs font-bold text-blue-400">Audit &amp; Akuntansi</div>
              <p className="mt-1 text-xs text-slate-300">
                Ledger stok dan jurnal umum bersifat append-only dengan rekonsiliasi otomatis.
              </p>
            </div>
          </div>
          <p className="text-xs text-slate-400">
            Zona Waktu Operasional: Asia/Jakarta (WIB) • Mata Uang: Rupiah (IDR)
          </p>
        </div>
      </section>

      {/* Right Authentication Form Panel */}
      <section className="flex flex-col justify-center px-4 py-10 sm:px-8 lg:col-span-7">
        <div className="mx-auto w-full max-w-md rounded-2xl border border-slate-200/90 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6 border-b border-slate-100 pb-5">
            <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200/80">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
              Otentikasi Sesi Berbasis Peran (RBAC)
            </div>
            <h2 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">
              Masuk ke Ruang Kerja
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Gunakan akun resmi sesuai penugasan gudang dan fungsi operasional Anda.
            </p>
          </div>

          <LoginForm isDevMode={isDevMode} devQuickFill={devQuickFill} />
        </div>
      </section>
    </main>
  );
}
