import { redirect } from "next/navigation";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Input,
  KpiCard,
  PageHeader,
} from "@/components/ui/primitives";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import {
  getArAgingReport,
  getCustomerStatement,
  reconcileArSubledgerWithGl,
} from "@/server/modules/finance";

export const dynamic = "force-dynamic";

export default async function PiutangPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; customerId?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "ar.read")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const selectedCustomerId = (params.customerId ?? "").trim();

  const [agingReport, recon] = await Promise.all([
    getArAgingReport(db),
    reconcileArSubledgerWithGl(db),
  ]);

  // If customer is selected for statement view
  let statement = null;
  if (selectedCustomerId) {
    statement = await getCustomerStatement(db, { customerId: selectedCustomerId });
  }

  const filteredCustomers = agingReport.customers.filter((c) => {
    const matchesQ =
      !q ||
      c.customerName.toLowerCase().includes(q) ||
      c.customerCode.toLowerCase().includes(q) ||
      (c.phone ?? "").includes(q);
    return matchesQ;
  });

  const grand = agingReport.grandTotal;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Buku Bantu Piutang & Aging AR (Accounts Receivable)"
        description="Analisis Umur Piutang Pelanggan, Bucket Jatuh Tempo, Saldo Deposit & Rekonsiliasi GL Akun 1120"
        eyebrow={
          <Badge tone={recon.isReconciled ? "success" : "danger"}>
            {recon.isReconciled
              ? "Rekonsiliasi GL 1120: Sinkron (Selisih Rp 0)"
              : `Peringatan: Selisih Rp ${recon.variance}`}
          </Badge>
        }
      />

      {/* Live Reconciliation Integrity Box */}
      <div className="p-4 rounded-xl border border-neutral-200 bg-white shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="text-xs font-semibold text-neutral-900 flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"></span>
            Rekonsiliasi Otomatis Subledger Piutang vs Buku Besar (GL 1120)
          </div>
          <div className="text-xs text-neutral-600">
            Audit integritas real-time antara total saldo terbuka faktur pelanggan dan buku besar akuntansi.
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs font-mono bg-neutral-50 px-3 py-2 rounded-lg border border-neutral-200">
          <div>
            <span className="text-neutral-500 block text-[10px]">SUBLEDGER PIUTANG</span>
            <span className="font-semibold text-neutral-900">
              Rp {Number(recon.arSubledgerTotal).toLocaleString("id-ID")}
            </span>
          </div>
          <div className="text-neutral-400">=</div>
          <div>
            <span className="text-neutral-500 block text-[10px]">GL AKUN 1120</span>
            <span className="font-semibold text-neutral-900">
              Rp {Number(recon.glEndingBalance).toLocaleString("id-ID")}
            </span>
          </div>
          <div className="text-neutral-400">|</div>
          <div>
            <span className="text-neutral-500 block text-[10px]">VARIANCE</span>
            <span className="font-bold text-emerald-700">
              Rp {Number(recon.variance).toLocaleString("id-ID")}
            </span>
          </div>
        </div>
      </div>

      {/* KPI Cards for Aging Buckets */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiCard
          label="Belum Jatuh Tempo"
          value={`Rp ${Number(grand.current).toLocaleString("id-ID")}`}
          caption="Periode berjalan (Current)"
          icon="check"
          iconTone="fresh"
        />
        <KpiCard
          label="1 – 30 Hari"
          value={`Rp ${Number(grand.days1To30).toLocaleString("id-ID")}`}
          caption="Overdue ringan"
          icon="clock"
          iconTone="info"
        />
        <KpiCard
          label="31 – 60 Hari"
          value={`Rp ${Number(grand.days31To60).toLocaleString("id-ID")}`}
          caption="Perlu follow up penagihan"
          icon="alert"
          iconTone="warning"
        />
        <KpiCard
          label="61 – 90 Hari"
          value={`Rp ${Number(grand.days61To90).toLocaleString("id-ID")}`}
          caption="Peringatan batas kredit"
          icon="alert"
          iconTone="warning"
        />
        <KpiCard
          label="> 90 Hari"
          value={`Rp ${Number(grand.over90).toLocaleString("id-ID")}`}
          caption="Risiko kredit macet"
          icon="danger"
          iconTone="danger"
        />
      </div>

      {/* Aging Table */}
      <Card>
        <CardHeader
          title="Tabel Analisis Umur Piutang (AR Aging Schedule)"
          subtitle={`Posisi saldo per ${agingReport.asOfDate}. Diperbarui real-time setiap transaksi faktur, pembayaran, dan nota kredit.`}
        />

        <div className="p-4 border-b border-neutral-100 flex flex-col sm:flex-row items-center justify-between gap-3">
          <form method="get" className="w-full sm:w-80">
            <Input
              name="q"
              defaultValue={q}
              placeholder="Cari kode atau nama pelanggan..."
              className="text-xs"
            />
          </form>

          <div className="text-xs text-neutral-500">
            Menampilkan {filteredCustomers.length} dari {agingReport.customers.length} pelanggan berpiutang
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50/70 text-neutral-600 font-medium">
                <th className="py-3 px-4">Pelanggan</th>
                <th className="py-3 px-4">Gudang</th>
                <th className="py-3 px-4 text-right">Belum Tempo</th>
                <th className="py-3 px-4 text-right">1-30 Hr</th>
                <th className="py-3 px-4 text-right">31-60 Hr</th>
                <th className="py-3 px-4 text-right">61-90 Hr</th>
                <th className="py-3 px-4 text-right">&gt;90 Hr</th>
                <th className="py-3 px-4 text-right font-semibold">Total Tagihan</th>
                <th className="py-3 px-4 text-right text-emerald-700">Uang Muka</th>
                <th className="py-3 px-4 text-right font-bold text-neutral-900">Net Piutang</th>
                <th className="py-3 px-4 text-center">Buku Rekening</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {filteredCustomers.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-8">
                    <EmptyState
                      title="Tidak ada data piutang"
                      description="Seluruh pelanggan saat ini berada pada saldo nihil atau lunas."
                    />
                  </td>
                </tr>
              ) : (
                filteredCustomers.map((c) => (
                  <tr key={c.customerId} className="hover:bg-neutral-50/80 transition-colors">
                    <td className="py-3 px-4">
                      <div className="font-semibold text-neutral-900">{c.customerName}</div>
                      <div className="text-[10px] text-neutral-500 font-mono">
                        {c.customerCode} {c.phone ? `• ${c.phone}` : ""}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-neutral-600">
                      {c.assignedWarehouseCode || "ALL"}
                    </td>
                    <td className="py-3 px-4 text-right text-neutral-700">
                      Rp {Number(c.buckets.current).toLocaleString("id-ID")}
                    </td>
                    <td className="py-3 px-4 text-right text-neutral-700">
                      Rp {Number(c.buckets.days1To30).toLocaleString("id-ID")}
                    </td>
                    <td className="py-3 px-4 text-right text-amber-700">
                      Rp {Number(c.buckets.days31To60).toLocaleString("id-ID")}
                    </td>
                    <td className="py-3 px-4 text-right text-amber-800">
                      Rp {Number(c.buckets.days61To90).toLocaleString("id-ID")}
                    </td>
                    <td className="py-3 px-4 text-right text-rose-700 font-semibold">
                      Rp {Number(c.buckets.over90).toLocaleString("id-ID")}
                    </td>
                    <td className="py-3 px-4 text-right font-semibold text-neutral-900">
                      Rp {Number(c.buckets.totalOutstanding).toLocaleString("id-ID")}
                    </td>
                    <td className="py-3 px-4 text-right text-emerald-700 font-medium">
                      Rp {Number(c.unappliedPayments).toLocaleString("id-ID")}
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-neutral-900">
                      Rp {Number(c.netReceivable).toLocaleString("id-ID")}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <a
                        href={`/piutang?customerId=${c.customerId}`}
                        className="inline-flex items-center text-xs font-semibold text-emerald-700 hover:text-emerald-800 bg-emerald-50 px-2.5 py-1 rounded border border-emerald-200"
                      >
                        Rekening Koran &rarr;
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {filteredCustomers.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-neutral-300 bg-neutral-100 font-semibold text-neutral-900">
                  <td colSpan={2} className="py-3 px-4">
                    TOTAL KESELURUHAN (GRAND TOTAL)
                  </td>
                  <td className="py-3 px-4 text-right">
                    Rp {Number(grand.current).toLocaleString("id-ID")}
                  </td>
                  <td className="py-3 px-4 text-right">
                    Rp {Number(grand.days1To30).toLocaleString("id-ID")}
                  </td>
                  <td className="py-3 px-4 text-right">
                    Rp {Number(grand.days31To60).toLocaleString("id-ID")}
                  </td>
                  <td className="py-3 px-4 text-right">
                    Rp {Number(grand.days61To90).toLocaleString("id-ID")}
                  </td>
                  <td className="py-3 px-4 text-right text-rose-700">
                    Rp {Number(grand.over90).toLocaleString("id-ID")}
                  </td>
                  <td className="py-3 px-4 text-right font-bold">
                    Rp {Number(grand.totalOutstanding).toLocaleString("id-ID")}
                  </td>
                  <td className="py-3 px-4 text-right text-emerald-700">
                    -
                  </td>
                  <td className="py-3 px-4 text-right font-bold">
                    Rp {Number(grand.totalOutstanding).toLocaleString("id-ID")}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      {/* Customer Statement Section (Rekening Koran) */}
      {statement && (
        <Card>
          <div className="p-4 border-b border-neutral-200 bg-neutral-50/70 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <div className="text-xs font-bold text-neutral-900 uppercase tracking-wider">
                Rekening Koran Pelanggan (Customer Statement)
              </div>
              <div className="text-sm font-semibold text-neutral-900">
                {statement.customer.name} ({statement.customer.code})
              </div>
              <div className="text-xs text-neutral-500">
                Limit Kredit: Rp {Number(statement.customer.creditLimit || 0).toLocaleString("id-ID")} • Termin: {statement.customer.paymentTermsDays} Hari
              </div>
            </div>

            <div className="text-right">
              <span className="text-xs text-neutral-500 block">Saldo Akhir Piutang</span>
              <span className="text-lg font-bold text-neutral-900">
                Rp {Number(statement.closingBalance).toLocaleString("id-ID")}
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-100/70 text-neutral-600 font-medium">
                  <th className="py-2.5 px-4">Tanggal</th>
                  <th className="py-2.5 px-4">No. Dokumen</th>
                  <th className="py-2.5 px-4">Tipe</th>
                  <th className="py-2.5 px-4">Keterangan</th>
                  <th className="py-2.5 px-4 text-right">Debit (Tagihan)</th>
                  <th className="py-2.5 px-4 text-right">Kredit (Bayar/Retur)</th>
                  <th className="py-2.5 px-4 text-right font-bold">Saldo Berjalan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 font-mono">
                {statement.ledger.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-neutral-500 font-sans">
                      Belum ada transaksi historis untuk pelanggan ini.
                    </td>
                  </tr>
                ) : (
                  statement.ledger.map((entry) => (
                    <tr key={entry.id} className="hover:bg-neutral-50">
                      <td className="py-2.5 px-4 text-neutral-600 font-sans">{entry.date}</td>
                      <td className="py-2.5 px-4 font-semibold text-neutral-900">{entry.docNo}</td>
                      <td className="py-2.5 px-4 font-sans">
                        <Badge
                          tone={
                            entry.type === "INVOICE"
                              ? "warning"
                              : entry.type === "PAYMENT"
                              ? "success"
                              : "neutral"
                          }
                        >
                          {entry.type}
                        </Badge>
                      </td>
                      <td className="py-2.5 px-4 font-sans text-neutral-700">{entry.description}</td>
                      <td className="py-2.5 px-4 text-right text-neutral-900">
                        {Number(entry.debit) > 0
                          ? `Rp ${Number(entry.debit).toLocaleString("id-ID")}`
                          : "-"}
                      </td>
                      <td className="py-2.5 px-4 text-right text-emerald-700">
                        {Number(entry.credit) > 0
                          ? `Rp ${Number(entry.credit).toLocaleString("id-ID")}`
                          : "-"}
                      </td>
                      <td className="py-2.5 px-4 text-right font-bold text-neutral-900">
                        Rp {Number(entry.runningBalance).toLocaleString("id-ID")}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
