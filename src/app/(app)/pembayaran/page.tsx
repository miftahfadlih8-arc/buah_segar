import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import {
  createBankAccountAction,
  reconcileBankTransactionAction,
  recordBankTransactionAction,
  recordCustomerPaymentAction,
  reverseCustomerPaymentAction,
} from "@/app/(app)/actions";
import { ActionForm } from "@/components/action-form";
import { ModalDialogTrigger } from "@/components/ui/dialog-drawer";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  KpiCard,
  PageHeader,
  Select,
  statusToBadgeTone,
} from "@/components/ui/primitives";
import { TableSearchFilterBar } from "@/components/ui/table-toolbar";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import { bankAccounts, bankTransactions } from "@/server/db/schema";
import {
  listBankAccounts,
  listCustomerPayments,
  listSalesInvoices,
} from "@/server/modules/finance";
import { listCustomers } from "@/server/modules/master/customers";
import { listWarehouses } from "@/server/modules/master/warehouses";

export const dynamic = "force-dynamic";

export default async function PembayaranPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string; tab?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "ar.collect")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const statusFilter = (params.status ?? "").trim().toLowerCase();
  const activeTab = (params.tab ?? "payments").trim();

  const [payments, accounts, invoices, customers, warehouses, rawBankTrxs] =
    await Promise.all([
      listCustomerPayments(db, {}),
      listBankAccounts(db),
      listSalesInvoices(db, {}),
      listCustomers(db, actor),
      listWarehouses(db, actor),
      db
        .select({
          id: bankTransactions.id,
          bankAccountId: bankTransactions.bankAccountId,
          bankName: bankAccounts.bankName,
          bankCode: bankAccounts.code,
          accountNumber: bankAccounts.accountNumber,
          transactionDate: bankTransactions.transactionDate,
          referenceNo: bankTransactions.referenceNo,
          description: bankTransactions.description,
          amount: bankTransactions.amount,
          direction: bankTransactions.direction,
          matchStatus: bankTransactions.matchStatus,
          matchedPaymentId: bankTransactions.matchedPaymentId,
        })
        .from(bankTransactions)
        .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
        .orderBy(desc(bankTransactions.transactionDate))
        .limit(50),
    ]);

  const canCollect = hasPermission(actor, "ar.collect");
  const canManageBank = hasPermission(actor, "settings.manage") || hasPermission(actor, "ar.collect");

  // Invoices eligible for allocation (status posted or partially_paid with balance > 0)
  const openInvoices = invoices.filter(
    (inv) =>
      (inv.status === "posted" || inv.status === "partially_paid" || inv.status === "overdue") &&
      Number(inv.outstandingAmount) > 0,
  );

  const filteredPayments = payments.filter((p) => {
    const matchesQ =
      !q ||
      p.paymentNo.toLowerCase().includes(q) ||
      p.customerName.toLowerCase().includes(q) ||
      (p.referenceNo ?? "").toLowerCase().includes(q);
    const matchesStatus = !statusFilter || p.status === statusFilter;
    return matchesQ && matchesStatus;
  });

  const totalCollectedNominal = payments
    .filter((p) => p.status === "posted")
    .reduce((acc, curr) => acc + Number(curr.amount || 0), 0);

  const totalUnappliedNominal = payments
    .filter((p) => p.status === "posted")
    .reduce((acc, curr) => acc + Number(curr.unappliedAmount || 0), 0);

  const postedCount = payments.filter((p) => p.status === "posted").length;
  const unmatchedTrxCount = rawBankTrxs.filter((t) => t.matchStatus === "unmatched").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Penerimaan Kas, Pelunasan & Rekonsiliasi Bank"
        description="Pencatatan Pembayaran Pelanggan, Alokasi Multi-Faktur, Deposit Uang Muka & Kliring Mutasi Bank"
        eyebrow={
          <Badge tone={canCollect ? "success" : "neutral"}>
            {canCollect ? "Otoritas Kasir / Finance Aktif" : "Mode Pratinjau (Read-Only)"}
          </Badge>
        }
        actions={
          canCollect ? (
            <div className="flex flex-wrap items-center gap-2">
              <ModalDialogTrigger
                title="Catat Pembayaran Pelanggan Baru"
                subtitle="Input penerimaan transfer bank, kas tunai, giro, atau QRIS dari pelanggan."
                triggerLabel="+ Catat Pembayaran"
                triggerVariant="primary"
              >
                <ActionForm action={recordCustomerPaymentAction} submitLabel="Simpan & Posting Penerimaan">
                  <div className="space-y-4">
                    <Field label="Pelanggan Pembayar" required>
                      <Select name="customerId" required defaultValue="">
                        <option value="" disabled>
                          -- Pilih Pelanggan --
                        </option>
                        {customers.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.code} - {c.name}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field label="Gudang Operasional" required>
                      <Select name="warehouseId" required defaultValue={warehouses[0]?.id}>
                        {warehouses.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.code} - {w.name}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field label="Alokasikan Langsung ke Faktur (Opsional)">
                      <Select name="invoiceId" defaultValue="">
                        <option value="">-- Pembayaran Uang Muka / Alokasi Nanti --</option>
                        {openInvoices.map((inv) => (
                          <option key={inv.id} value={inv.id}>
                            {inv.invoiceNo} ({inv.customerName} - Sisa: Rp {Number(inv.outstandingAmount).toLocaleString("id-ID")})
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Metode Pembayaran" required>
                        <Select name="paymentMethod" defaultValue="bank_transfer">
                          <option value="bank_transfer">Transfer Bank (BCA/Mandiri/BRI)</option>
                          <option value="cash">Kas Tunai (Cash on Delivery)</option>
                          <option value="giro">Bilyet Giro / Cek</option>
                          <option value="qris">QRIS Statis/Dinamis</option>
                        </Select>
                      </Field>

                      <Field label="Rekening Kas / Bank Penerima">
                        <Select name="bankAccountId" defaultValue="">
                          <option value="">-- Rekening Standar --</option>
                          {accounts.map((acc) => (
                            <option key={acc.id} value={acc.id}>
                              {acc.name} ({acc.bankName ?? "Kas"} {acc.accountNumber ?? ""})
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Nominal Diterima (Rp)" required>
                        <Input
                          type="number"
                          name="amount"
                          step="100"
                          min="1"
                          placeholder="Contoh: 1500000"
                          required
                        />
                      </Field>

                      <Field label="Tanggal Pembayaran">
                        <Input type="date" name="paymentDate" />
                      </Field>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <Field label="No. Referensi / Bukti Transfer">
                        <Input name="referenceNo" placeholder="No. referensi mutasi bank / resi" />
                      </Field>

                      <Field label="Status Pembayaran">
                        <Select name="status" defaultValue="posted">
                          <option value="posted">Langsung Posting (Post to GL)</option>
                          <option value="draft">Simpan Sebagai Draft</option>
                        </Select>
                      </Field>
                    </div>

                    <Field label="Catatan Tambahan">
                      <Input name="notes" placeholder="Keterangan pengirim atau setoran" />
                    </Field>
                  </div>
                </ActionForm>
              </ModalDialogTrigger>

              {canManageBank && (
                <>
                  <ModalDialogTrigger
                    title="Tambah Rekening Kas / Bank"
                    subtitle="Daftarkan rekening operasional baru untuk penampungan transfer pelanggan."
                    triggerLabel="+ Rekening Bank"
                    triggerVariant="secondary"
                  >
                    <ActionForm action={createBankAccountAction} submitLabel="Daftarkan Rekening">
                      <div className="space-y-4">
                        <Field label="Kode Unik Rekening" required>
                          <Input name="code" placeholder="Contoh: BANK-BCA-01" required />
                        </Field>
                        <Field label="Nama Bank / Kas" required>
                          <Input name="bankName" placeholder="Contoh: BCA / Mandiri / Kasir" required />
                        </Field>
                        <Field label="Nomor Rekening" required>
                          <Input name="accountNumber" placeholder="Contoh: 7001234567" required />
                        </Field>
                        <Field label="Atas Nama (Pemilik Rekening)" required>
                          <Input name="holderName" placeholder="PT Fresh Buah Bekasi" required />
                        </Field>
                        <Field label="Tipe Akun" required>
                          <Select name="accountType" defaultValue="bank">
                            <option value="bank">Rekening Bank</option>
                            <option value="cash">Kas Fisik Tunai</option>
                            <option value="ewallet">E-Wallet / QRIS Merchant</option>
                          </Select>
                        </Field>
                      </div>
                    </ActionForm>
                  </ModalDialogTrigger>

                  <ModalDialogTrigger
                    title="Catat Mutasi Rekening Bank"
                    subtitle="Input riwayat mutasi rekening koran bank untuk dicocokkan dengan pembayaran pelanggan."
                    triggerLabel="+ Catat Mutasi"
                    triggerVariant="secondary"
                  >
                    <ActionForm action={recordBankTransactionAction} submitLabel="Simpan Mutasi">
                      <div className="space-y-4">
                        <Field label="Pilih Rekening Bank" required>
                          <Select name="bankAccountId" required defaultValue={accounts[0]?.id}>
                            {accounts.map((acc) => (
                              <option key={acc.id} value={acc.id}>
                                {acc.name} - {acc.accountNumber}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Tanggal Mutasi" required>
                          <Input type="date" name="transactionDate" required />
                        </Field>
                        <Field label="Arah Transaksi" required>
                          <Select name="direction" defaultValue="in">
                            <option value="in">Uang Masuk / Credit (Penerimaan)</option>
                            <option value="out">Uang Keluar / Debit (Biaya/Pengeluaran)</option>
                          </Select>
                        </Field>
                        <Field label="Nominal Transaksi (Rp)" required>
                          <Input
                            type="number"
                            name="amount"
                            step="100"
                            min="1"
                            placeholder="Contoh: 500000"
                            required
                          />
                        </Field>
                        <Field label="No. Referensi Bank">
                          <Input name="referenceNo" placeholder="No. ref mutasi bank" />
                        </Field>
                        <Field label="Deskripsi Rekening Koran" required>
                          <Input
                            name="description"
                            placeholder="Contoh: TRSF CR DARI TOKO BUAH SEGAR"
                            required
                          />
                        </Field>
                      </div>
                    </ActionForm>
                  </ModalDialogTrigger>
                </>
              )}
            </div>
          ) : undefined
        }
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Total Pembayaran Masuk"
          value={`Rp ${totalCollectedNominal.toLocaleString("id-ID")}`}
          caption={`${postedCount} transaksi penerimaan tervalidasi`}
          icon="wallet"
          iconTone="fresh"
        />
        <KpiCard
          label="Uang Muka / Unapplied Cash"
          value={`Rp ${totalUnappliedNominal.toLocaleString("id-ID")}`}
          caption="Kelebihan bayar pelanggan (GL 2130)"
          icon="ledger"
          iconTone={totalUnappliedNominal > 0 ? "warning" : "info"}
        />
        <KpiCard
          label="Rekening Bank Aktif"
          value={String(accounts.length)}
          caption="Rekening kas & bank terdaftar"
          icon="building"
          iconTone="navy"
        />
        <KpiCard
          label="Mutasi Belum Cocok"
          value={String(unmatchedTrxCount)}
          caption="Menunggu kliring rekonsiliasi"
          icon="alert"
          iconTone={unmatchedTrxCount > 0 ? "warning" : "fresh"}
        />
      </div>

      {/* Sub-navigation Tabs */}
      <div className="flex border-b border-neutral-200 gap-4 text-sm font-medium">
        <a
          href="/pembayaran?tab=payments"
          className={`pb-2 border-b-2 transition-colors ${
            activeTab === "payments"
              ? "border-emerald-600 text-emerald-700 font-semibold"
              : "border-transparent text-neutral-500 hover:text-neutral-700"
          }`}
        >
          Riwayat Pembayaran Pelanggan ({payments.length})
        </a>
        <a
          href="/pembayaran?tab=bank_settlement"
          className={`pb-2 border-b-2 transition-colors ${
            activeTab === "bank_settlement"
              ? "border-emerald-600 text-emerald-700 font-semibold"
              : "border-transparent text-neutral-500 hover:text-neutral-700"
          }`}
        >
          Rekening Bank &amp; Kliring Mutasi ({rawBankTrxs.length})
        </a>
      </div>

      {activeTab === "payments" ? (
        <Card>
          <CardHeader
            title="Daftar Penerimaan Pembayaran Pelanggan"
            subtitle="Pantau mutasi masuk, alokasi faktur, dan kelebihan bayar yang dicatat otomatis ke GL 2130."
          />

          <div className="p-4 border-b border-neutral-100">
            <TableSearchFilterBar
              placeholder="Cari nomor pembayaran, pelanggan, atau nomor referensi..."
              statusOptions={[
                { label: "Semua Status", value: "" },
                { label: "Posted", value: "posted" },
                { label: "Draft", value: "draft" },
                { label: "Reversed (Batal)", value: "reversed" },
              ]}
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50/70 text-neutral-600 font-medium">
                  <th className="py-3 px-4">No. Pembayaran</th>
                  <th className="py-3 px-4">Tanggal</th>
                  <th className="py-3 px-4">Pelanggan</th>
                  <th className="py-3 px-4">Metode</th>
                  <th className="py-3 px-4 text-right font-semibold">Nominal Masuk</th>
                  <th className="py-3 px-4 text-right text-emerald-700">Dialokasikan</th>
                  <th className="py-3 px-4 text-right text-amber-700">Uang Muka (Deposit)</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filteredPayments.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8">
                      <EmptyState
                        title="Tidak ada riwayat pembayaran"
                        description="Belum ada transaksi pembayaran yang tercatat dalam sistem."
                      />
                    </td>
                  </tr>
                ) : (
                  filteredPayments.map((p) => (
                    <tr key={p.id} className="hover:bg-neutral-50/80 transition-colors">
                      <td className="py-3 px-4 font-semibold text-neutral-900 font-mono">
                        {p.paymentNo}
                        {p.referenceNo ? (
                          <div className="text-[10px] text-neutral-500 font-sans">
                            Ref: {p.referenceNo}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-3 px-4 text-neutral-600">{p.paymentDate}</td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-neutral-900">{p.customerName}</div>
                        <div className="text-[10px] text-neutral-500 font-mono">{p.customerCode}</div>
                      </td>
                      <td className="py-3 px-4">
                        <Badge tone="neutral">{p.paymentMethod.replace("_", " ").toUpperCase()}</Badge>
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-neutral-900">
                        Rp {Number(p.amount).toLocaleString("id-ID")}
                      </td>
                      <td className="py-3 px-4 text-right text-emerald-700 font-medium">
                        Rp {Number(p.appliedAmount).toLocaleString("id-ID")}
                      </td>
                      <td className="py-3 px-4 text-right text-amber-700 font-medium">
                        Rp {Number(p.unappliedAmount).toLocaleString("id-ID")}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <Badge tone={statusToBadgeTone(p.status)}>{p.status.toUpperCase()}</Badge>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {p.status === "posted" && canCollect && (
                          <ModalDialogTrigger
                            title={`Batalkan (Reverse) Pembayaran #${p.paymentNo}`}
                            subtitle="Pembatalan akan membalik seluruh alokasi piutang faktur dan membalik jurnal GL terkait."
                            triggerLabel="Reverse"
                            triggerVariant="danger"
                          >
                            <ActionForm
                              action={reverseCustomerPaymentAction}
                              submitLabel="Konfirmasi Pembatalan Pembayaran"
                            >
                              <input type="hidden" name="paymentId" value={p.id} />
                              <Field label="Alasan Pembatalan (Wajib)" required>
                                <Input
                                  name="reason"
                                  placeholder="Contoh: Cek/giro bilyet ditolak atau transfer dobel"
                                  required
                                />
                              </Field>
                            </ActionForm>
                          </ModalDialogTrigger>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Bank Accounts Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {accounts.map((acc) => (
              <div
                key={acc.id}
                className="p-4 rounded-xl border border-neutral-200 bg-white shadow-sm space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-neutral-900 font-mono">{acc.code}</span>
                  <Badge tone={acc.isActive ? "success" : "neutral"}>
                    {acc.isActive ? "AKTIF" : "NONAKTIF"}
                  </Badge>
                </div>
                <div className="font-semibold text-neutral-900">{acc.name}</div>
                <div className="text-xs text-neutral-500">
                  {acc.bankName ?? "Bank"} • No. {acc.accountNumber ?? "-"}
                </div>
                <div className="pt-2 border-t border-neutral-100 flex items-center justify-between">
                  <span className="text-[11px] text-neutral-500">Saldo Buku:</span>
                  <span className="font-bold text-neutral-900">
                    Rp {Number(acc.currentBalance || 0).toLocaleString("id-ID")}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Bank Statement Transactions Table */}
          <Card>
            <CardHeader
              title="Kliring Mutasi Rekening Koran Bank"
              subtitle="Pencocokan transaksi mutasi bank rekening operasional dengan bukti penerimaan pembayaran pelanggan."
            />

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50/70 text-neutral-600 font-medium">
                    <th className="py-3 px-4">Tanggal</th>
                    <th className="py-3 px-4">Rekening</th>
                    <th className="py-3 px-4">Deskripsi Mutasi</th>
                    <th className="py-3 px-4">Arah</th>
                    <th className="py-3 px-4 text-right font-semibold">Nominal</th>
                    <th className="py-3 px-4 text-center">Status Kliring</th>
                    <th className="py-3 px-4 text-right">Aksi Rekonsiliasi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {rawBankTrxs.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8">
                        <EmptyState
                          title="Tidak ada transaksi mutasi"
                          description="Belum ada riwayat mutasi bank yang tercatat."
                        />
                      </td>
                    </tr>
                  ) : (
                    rawBankTrxs.map((trx) => (
                      <tr key={trx.id} className="hover:bg-neutral-50/80 transition-colors">
                        <td className="py-3 px-4 text-neutral-600">{trx.transactionDate}</td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-neutral-900">{trx.bankName ?? trx.bankCode}</div>
                          <div className="text-[10px] text-neutral-500 font-mono">
                            {trx.accountNumber}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-neutral-900">{trx.description}</div>
                          {trx.referenceNo ? (
                            <div className="text-[10px] text-neutral-500 font-mono">
                              Ref: {trx.referenceNo}
                            </div>
                          ) : null}
                        </td>
                        <td className="py-3 px-4">
                          <Badge tone={trx.direction === "in" ? "success" : "neutral"}>
                            {trx.direction === "in" ? "MASUK (CR)" : "KELUAR (DB)"}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 text-right font-bold text-neutral-900">
                          Rp {Number(trx.amount).toLocaleString("id-ID")}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <Badge
                            tone={
                              trx.matchStatus === "matched"
                                ? "success"
                                : trx.matchStatus === "discrepancy"
                                ? "warning"
                                : "neutral"
                            }
                          >
                            {trx.matchStatus.toUpperCase()}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 text-right">
                          {trx.matchStatus === "unmatched" && canCollect && (
                            <ModalDialogTrigger
                              title="Rekonsiliasi Mutasi dengan Pembayaran"
                              subtitle={`Cocokkan mutasi senilai Rp ${Number(trx.amount).toLocaleString("id-ID")} dengan bukti pembayaran pelanggan.`}
                              triggerLabel="Cocokkan"
                              triggerVariant="secondary"
                            >
                              <ActionForm
                                action={reconcileBankTransactionAction}
                                submitLabel="Simpan Rekonsiliasi"
                              >
                                <input type="hidden" name="bankTransactionId" value={trx.id} />
                                <div className="space-y-4">
                                  <Field label="Pilih Pembayaran Pelanggan" required>
                                    <Select name="paymentId" required defaultValue="">
                                      <option value="" disabled>
                                        -- Pilih Pembayaran Masuk --
                                      </option>
                                      {payments
                                        .filter((p) => p.status === "posted")
                                        .map((p) => (
                                          <option key={p.id} value={p.id}>
                                            {p.paymentNo} ({p.customerName} - Rp {Number(p.amount).toLocaleString("id-ID")})
                                          </option>
                                        ))}
                                    </Select>
                                  </Field>
                                  <Field label="Catatan Rekonsiliasi">
                                    <Input
                                      name="notes"
                                      placeholder="Keterangan pencocokan mutasi rekening koran"
                                    />
                                  </Field>
                                </div>
                              </ActionForm>
                            </ModalDialogTrigger>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
