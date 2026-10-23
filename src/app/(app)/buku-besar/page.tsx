import { redirect } from "next/navigation";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  KpiCard,
  PageHeader,
} from "@/components/ui/primitives";
import { TableSearchFilterBar } from "@/components/ui/table-toolbar";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { formatRupiah } from "@/lib/money";
import { formatQty } from "@/lib/quantity";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import {
  getGlAccountBalance,
  listChartOfAccounts,
  listJournalEntriesWithLines,
  seedDefaultCoaAndFiscalPeriod,
} from "@/server/modules/gl";
import { evaluateCostingPolicyGate } from "@/server/modules/inventory/costing";
import { reconcileInventoryAndGl } from "@/server/modules/inventory/ledger";

export const dynamic = "force-dynamic";

export default async function BukuBesarPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "gl.read")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const statusFilter = (params.status ?? "").trim().toLowerCase();

  await seedDefaultCoaAndFiscalPeriod(db);
  const gate = await evaluateCostingPolicyGate(db);

  const canReadGl = hasPermission(actor, "gl.read");
  const canReadInventory = hasPermission(actor, "inventory.read");

  const coa = canReadGl ? await listChartOfAccounts(db, actor) : [];
  const coaWithBalances = [];
  for (const acc of coa) {
    const bal = await getGlAccountBalance(db, acc.code);
    coaWithBalances.push({ account: acc, balance: bal });
  }

  const journals = canReadGl ? await listJournalEntriesWithLines(db, actor, { limit: 30 }) : [];
  const recon = canReadInventory ? await reconcileInventoryAndGl(db, actor) : null;

  const filteredCoa = coaWithBalances.filter(({ account }) => {
    const matchesQ =
      !q || account.code.toLowerCase().includes(q) || account.name.toLowerCase().includes(q);
    const matchesStatus = !statusFilter || account.accountType === statusFilter;
    return matchesQ && matchesStatus;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Buku Besar (General Ledger), Bagan Akun (COA) & Rekonsiliasi"
        description="Jurnal berpasangan (double-entry) wajib seimbang (Total Debit = Total Kredit) dan bersifat append-only; koreksi hanya melalui jurnal pembalik (reversal)."
        actions={
          recon ? (
            <Badge tone={recon.isReconciled ? "success" : "danger"} dot>
              {recon.isReconciled
                ? "REKONSILIASI LEDGER ↔ GL 100% COCOK"
                : "DITEMUKAN SELISIH REKONSILIASI"}
            </Badge>
          ) : null
        }
      />

      {/* Production Costing Policy Gate Banner */}
      <section
        className={`rounded-xl border p-4 ${
          gate.productionValuationBlocked
            ? "border-amber-300 bg-amber-50/90 text-amber-950"
            : "border-emerald-300 bg-emerald-50/90 text-emerald-950"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge tone={gate.productionValuationBlocked ? "warning" : "success"} dot>
              {gate.productionValuationBlocked ? "PRODUCTION GATE: BLOCKED" : "APPROVED"}
            </Badge>
            <h2 className="text-sm font-bold">
              Status Costing Policy Gate:{" "}
              {gate.productionValuationBlocked
                ? "Mode Data Sintetis Dev/Test Aktif (Valuasi Produksi Diblokir)"
                : "Disetujui Pemilik & Akuntan"}
            </h2>
          </div>
          <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-slate-800 ring-1 ring-slate-200">
            Kebijakan: Lot Actual Cost + Relative Sales Value (Grade A/B/C) + Spoilage ke Beban 5210
          </span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed">
          Persetujuan Pemilik: <strong>{gate.approvedByOwner ? "SUDAH" : "BELUM"}</strong> •
          Persetujuan Akuntan: <strong>{gate.approvedByAccountant ? "SUDAH" : "BELUM"}</strong>.{" "}
          {gate.productionValuationBlocked
            ? "Posting valuasi pada lingkungan produksi diblokir hingga pengaturan 'costing.policy_approval' disetujui oleh Pemilik dan Akuntan."
            : "Seluruh komponen biaya lot dan alokasi grade telah disetujui untuk produksi."}
        </p>
      </section>

      {/* Automated Reconciliation KPI Strip */}
      {recon ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="KUANTITAS LEDGER VS SALDO"
            value={`${formatQty(recon.totalLedgerQtyBase, "KG")} / ${formatQty(recon.totalBalanceQtyBase, "KG")}`}
            icon="inventory"
            iconTone="navy"
            badgeText={`Selisih: ${formatQty(recon.qtyVarianceBase, "KG")}`}
            badgeTone={recon.isReconciled ? "success" : "danger"}
            caption="Mutasi ledger vs akumulasi stock_balances"
          />
          <KpiCard
            label="NILAI LEDGER MUTASI STOK"
            value={formatRupiah(recon.totalLedgerValue)}
            icon="ledger"
            iconTone="info"
            badgeText="Immutable Ledger"
            badgeTone="info"
            caption="SUM(inventory_movements.cost_delta)"
          />
          <KpiCard
            label="NILAI SALDO BATCH (STOCK_BALANCES)"
            value={formatRupiah(recon.totalBalanceValue)}
            icon="warehouse"
            iconTone="fresh"
            badgeText={`Selisih: ${formatRupiah(recon.ledgerVsBalanceValueVariance)}`}
            badgeTone={recon.isReconciled ? "success" : "danger"}
            caption="SUM(stock_balances.total_cost)"
          />
          <KpiCard
            label="SALDO AKUN PERSEDIAAN GL (1140)"
            value={formatRupiah(recon.glInventoryAccountBalance)}
            icon="check"
            iconTone={recon.isReconciled ? "fresh" : "danger"}
            badgeText={recon.isReconciled ? "COCOK 100%" : "SELISIH GL"}
            badgeTone={recon.isReconciled ? "success" : "danger"}
            caption={`Selisih Stok vs GL: ${formatRupiah(recon.inventoryVsGlVariance)}`}
          />
        </div>
      ) : null}

      {canReadGl ? (
        <>
          {/* Chart of Accounts Table */}
          <Card noPadding>
            <CardHeader
              id="coa-heading"
              title="Bagan Akun Standar (Chart of Accounts) & Saldo Berjalan"
              subtitle="Saldo berjalan dihitung langsung dari seluruh baris jurnal berpasangan yang telah diposting"
              meta={<Badge tone="neutral">{filteredCoa.length} Akun</Badge>}
            />

            <TableSearchFilterBar
              placeholder="Cari kode akun (mis. 1140, 2115, 5210) atau nama akun..."
              statusLabel="Semua Tipe Akun"
              statusOptions={[
                { value: "asset", label: "Asset (Aset)" },
                { value: "liability", label: "Liability (Kewajiban)" },
                { value: "equity", label: "Equity (Ekuitas)" },
                { value: "revenue", label: "Revenue (Pendapatan)" },
                { value: "expense", label: "Expense (Beban & HPP)" },
              ]}
              totalCount={coaWithBalances.length}
              filteredCount={filteredCoa.length}
            />

            <div tabIndex={0} role="region" aria-labelledby="coa-heading" className="table-region">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
                  <tr>
                    <th className="px-5 py-3">Kode Akun</th>
                    <th className="px-4 py-3">Nama Akun</th>
                    <th className="px-4 py-3">Tipe &amp; Saldo Normal</th>
                    <th className="px-4 py-3 text-right">Total Debit</th>
                    <th className="px-4 py-3 text-right">Total Kredit</th>
                    <th className="px-5 py-3 text-right">Saldo Bersih</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {filteredCoa.map(({ account, balance }) => (
                    <tr key={account.id} className="hover:bg-slate-50/80">
                      <th
                        scope="row"
                        className="px-5 py-3.5 font-mono text-xs font-bold text-blue-600"
                      >
                        {account.code}
                      </th>
                      <td className="px-4 py-3.5 font-semibold text-slate-900">{account.name}</td>
                      <td className="px-4 py-3.5">
                        <Badge tone="neutral">{account.accountType.toUpperCase()}</Badge>
                        <span className="ml-2 text-[11px] text-slate-500">
                          Normal: {account.normalBalance.toUpperCase()}
                        </span>
                      </td>
                      <td className="tabular-nums px-4 py-3.5 text-right text-slate-700">
                        {formatRupiah(balance.totalDebit)}
                      </td>
                      <td className="tabular-nums px-4 py-3.5 text-right text-slate-700">
                        {formatRupiah(balance.totalCredit)}
                      </td>
                      <td className="tabular-nums px-5 py-3.5 text-right font-bold text-slate-900">
                        {formatRupiah(balance.netBalance)}
                      </td>
                    </tr>
                  ))}
                  {filteredCoa.length === 0 ? (
                    <tr>
                      <td colSpan={6}>
                        <EmptyState
                          icon="ledger"
                          title="Akun Tidak Ditemukan"
                          description="Tidak ada akun yang cocok dengan kata kunci atau filter tipe akun."
                        />
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>

          {/* General Ledger Journals */}
          <Card noPadding>
            <CardHeader
              id="jurnal-umum-heading"
              title="Jurnal Umum Berpasangan (Double-Entry General Ledger)"
              subtitle="Setiap jurnal divalidasi seimbang (Debit = Kredit) sebelum komit transaksi database"
              meta={<Badge tone="info">{journals.length} Jurnal</Badge>}
            />

            <div className="divide-y divide-slate-200">
              {journals.map(({ entry, lines }) => (
                <div key={entry.id} className="p-5 hover:bg-slate-50/40">
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono font-bold text-blue-600">{entry.entryNo}</span>
                      <span className="text-slate-300">•</span>
                      <span className="tabular-nums font-medium text-slate-600">
                        {formatDate(entry.entryDate)}
                      </span>
                      <span className="text-slate-300">•</span>
                      <span className="font-semibold text-slate-900">{entry.memo}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone="info">
                        {entry.sourceDocType}:{entry.purpose}
                      </Badge>
                      <span className="tabular-nums text-[11px] text-slate-500">
                        {formatDateTime(entry.postedAt)}
                      </span>
                    </div>
                  </div>

                  <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead className="border-b border-slate-100 bg-slate-50/80 text-[10px] font-bold tracking-wider text-slate-500 uppercase">
                        <tr>
                          <th className="px-3.5 py-2">Kode Akun</th>
                          <th className="px-3.5 py-2">Keterangan Baris Jurnal</th>
                          <th className="px-3.5 py-2 text-right">Debit</th>
                          <th className="px-3.5 py-2 text-right">Kredit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {lines.map((l) => (
                          <tr key={l.id}>
                            <td className="px-3.5 py-2 font-mono font-bold text-slate-900">
                              {l.accountCode}
                            </td>
                            <td className="px-3.5 py-2 text-slate-700">{l.description ?? "-"}</td>
                            <td className="tabular-nums px-3.5 py-2 text-right font-semibold text-slate-900">
                              {formatRupiah(l.debit)}
                            </td>
                            <td className="tabular-nums px-3.5 py-2 text-right font-semibold text-slate-900">
                              {formatRupiah(l.credit)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
              {journals.length === 0 ? (
                <EmptyState
                  icon="ledger"
                  title="Belum Ada Jurnal Umum"
                  description="Jurnal umum otomatis terbentuk saat penerimaan GRN atau penyesuaian stok diposting."
                />
              ) : null}
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
