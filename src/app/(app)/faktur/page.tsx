import { redirect } from "next/navigation";
import {
  approveCreditNoteDirectAction,
  createCreditNoteAction,
  createSalesInvoiceAction,
  postSalesInvoiceDirectAction,
  voidSalesInvoiceAction,
} from "@/app/(app)/actions";
import { ActionForm } from "@/components/action-form";
import { ConfirmActionButton, ModalDialogTrigger } from "@/components/ui/dialog-drawer";
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
import {
  listCreditNotes,
  listSalesInvoices,
} from "@/server/modules/finance";
import { listDeliveryOrders } from "@/server/modules/fulfillment";
import { listCustomers } from "@/server/modules/master/customers";
import { listWarehouses } from "@/server/modules/master/warehouses";
import { listProductsWithDetails } from "@/server/modules/master/catalog";

export const dynamic = "force-dynamic";

export default async function FakturPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string; tab?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "ar.read") && !hasPermission(actor, "ar.invoice")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const statusFilter = (params.status ?? "").trim().toLowerCase();
  const activeTab = (params.tab ?? "invoices").trim();

  const [invoices, creditNotes, customers, warehouses, deliveryOrders, products] =
    await Promise.all([
      listSalesInvoices(db, {}),
      listCreditNotes(db, {}),
      listCustomers(db, actor),
      listWarehouses(db, actor),
      listDeliveryOrders(db, actor),
      listProductsWithDetails(db, actor),
    ]);

  const canInvoice = hasPermission(actor, "ar.invoice");
  const canApprove = hasPermission(actor, "ar.invoice");

  // Delivered DOs that can be invoiced
  const eligibleDos = deliveryOrders.filter((d) => d.status === "delivered");

  const filteredInvoices = invoices.filter((inv) => {
    const matchesQ =
      !q ||
      inv.invoiceNo.toLowerCase().includes(q) ||
      inv.customerName.toLowerCase().includes(q) ||
      inv.customerCode.toLowerCase().includes(q);
    const matchesStatus = !statusFilter || inv.status === statusFilter;
    return matchesQ && matchesStatus;
  });

  const filteredCreditNotes = creditNotes.filter((cn) => {
    const matchesQ =
      !q ||
      cn.creditNoteNo.toLowerCase().includes(q) ||
      cn.customerName.toLowerCase().includes(q) ||
      cn.reason.toLowerCase().includes(q);
    return matchesQ;
  });

  const totalInvoicedNominal = invoices.reduce(
    (acc, curr) => acc + Number(curr.totalAmount || 0),
    0,
  );
  const totalOutstandingNominal = invoices
    .filter((inv) => inv.status === "posted" || inv.status === "partially_paid" || inv.status === "overdue")
    .reduce((acc, curr) => acc + Number(curr.outstandingAmount || 0), 0);
  const paidCount = invoices.filter((inv) => inv.status === "paid").length;
  const approvedCnCount = creditNotes.filter(
    (cn) => cn.status === "approved" || cn.status === "applied",
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Faktur Penjualan & Nota Kredit"
        description="Penerbitan Faktur Komersial Resmi, PPN 11% Otomatis, Termin Jatuh Tempo & Nota Kredit Pelanggan"
        eyebrow={
          <Badge tone={canInvoice ? "success" : "neutral"}>
            {canInvoice ? "Otoritas Finance / AR Aktif" : "Mode Pratinjau (Read-Only)"}
          </Badge>
        }
        actions={
          canInvoice ? (
            <div className="flex flex-wrap items-center gap-2">
              <ModalDialogTrigger
                title="Terbitkan Faktur Penjualan Baru"
                subtitle="Buat faktur penagihan pelanggan dari Surat Jalan (DO) yang telah terkirim atau pesanan terkonfirmasi."
                triggerLabel="+ Faktur Baru"
                triggerVariant="primary"
              >
                <ActionForm action={createSalesInvoiceAction} submitLabel="Simpan & Terbitkan Faktur">
                  <div className="space-y-4">
                    <Field label="Pelanggan Tujuan" required>
                      <Select name="customerId" required defaultValue="">
                        <option value="" disabled>
                          -- Pilih Pelanggan --
                        </option>
                        {customers.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.code} - {c.name} ({c.segment.toUpperCase()})
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field label="Gudang Asal" required>
                      <Select name="warehouseId" required defaultValue={warehouses[0]?.id}>
                        {warehouses.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.code} - {w.name}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field label="Surat Jalan Terkait (Opsional / Recommended)">
                      <Select name="deliveryOrderId" defaultValue="">
                        <option value="">-- Tanpa Surat Jalan Langsung --</option>
                        {eligibleDos.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.doNumber} (Kpd: {d.customerName} - {d.deliveryDate})
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field label="Tanggal Jatuh Tempo (Kosongkan untuk auto-terms)">
                      <Input type="date" name="dueDate" />
                    </Field>

                    <div className="p-3 bg-neutral-50 rounded-lg border border-neutral-200 space-y-3">
                      <div className="text-xs font-semibold text-neutral-800">
                        Entri Baris Produk (Faktur Manual / Tambahan)
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Pilih Buah" required>
                          <Select name="productId" required defaultValue="">
                            <option value="" disabled>
                              -- Pilih Komoditas --
                            </option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.sku} - {p.name}
                              </option>
                            ))}
                          </Select>
                        </Field>

                        <Field label="Grade" required>
                          <Select name="gradeId" required defaultValue="">
                            <option value="" disabled>
                              -- Pilih Grade --
                            </option>
                            {products[0]?.grades.map((g) => (
                              <option key={g.id} value={g.id}>
                                Grade {g.code} - {g.name}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      </div>

                      <div className="grid grid-cols-3 gap-3">
                        <Field label="Jumlah Tagih" required>
                          <Input
                            type="number"
                            name="invoicedQty"
                            step="0.001"
                            min="0.001"
                            placeholder="Contoh: 50"
                            required
                          />
                        </Field>
                        <Field label="Satuan" required>
                          <Select name="uomCode" defaultValue="kg">
                            <option value="kg">kg (Kilogram)</option>
                            <option value="gram">gram</option>
                          </Select>
                        </Field>
                        <Field label="Harga Satuan (Rp)" required>
                          <Input
                            type="number"
                            name="unitPrice"
                            step="100"
                            min="1"
                            placeholder="Contoh: 28000"
                            required
                          />
                        </Field>
                      </div>
                    </div>

                    <Field label="Catatan Faktur">
                      <Input name="notes" placeholder="Nomor PO pelanggan / instruksi penagihan" />
                    </Field>
                  </div>
                </ActionForm>
              </ModalDialogTrigger>

              <ModalDialogTrigger
                title="Buat Nota Kredit Pelanggan"
                subtitle="Terbitkan Nota Kredit resmi untuk klaim susut/rusak, retur fisik, atau koreksi harga."
                triggerLabel="+ Nota Kredit"
                triggerVariant="secondary"
              >
                <ActionForm action={createCreditNoteAction} submitLabel="Buat Nota Kredit">
                  <div className="space-y-4">
                    <Field label="Pelanggan" required>
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

                    <Field label="Gudang Acuan" required>
                      <Select name="warehouseId" required defaultValue={warehouses[0]?.id}>
                        {warehouses.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.code} - {w.name}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field label="Jenis Sumber Nota Kredit" required>
                      <Select name="sourceType" defaultValue="quality_claim">
                        <option value="quality_claim">Klaim Mutu / Susut Buah (Quality Claim)</option>
                        <option value="sales_return">Retur Fisik Barang (Sales Return)</option>
                        <option value="price_adjustment">Koreksi / Penyesuaian Harga (Price Adjustment)</option>
                      </Select>
                    </Field>

                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Komoditas Buah" required>
                        <Select name="productId" required defaultValue="">
                          <option value="" disabled>-- Pilih Buah --</option>
                          {products.map((p) => (
                            <option key={p.id} value={p.id}>{p.sku} - {p.name}</option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Grade" required>
                        <Select name="gradeId" required defaultValue="">
                          <option value="" disabled>-- Pilih Grade --</option>
                          {products[0]?.grades.map((g) => (
                            <option key={g.id} value={g.id}>Grade {g.code}</option>
                          ))}
                        </Select>
                      </Field>
                    </div>

                    <Field label="Nominal Nota Kredit (Rp)" required>
                      <Input
                        type="number"
                        name="totalAmount"
                        step="100"
                        min="1"
                        placeholder="Contoh: 150000"
                        required
                      />
                    </Field>

                    <Field label="Alasan / Bukti Masalah" required>
                      <Input
                        name="reason"
                        placeholder="Contoh: Klaim buah memar 5kg saat serah terima POD"
                        required
                      />
                    </Field>

                    {canApprove && (
                      <div className="flex items-center gap-2 pt-2">
                        <input
                          type="checkbox"
                          id="autoApprove"
                          name="autoApprove"
                          value="true"
                          className="h-4 w-4 rounded border-neutral-300 text-emerald-600 focus:ring-emerald-500"
                        />
                        <label htmlFor="autoApprove" className="text-xs font-medium text-neutral-800">
                          Langsung setujui dan posting jurnal GL Nota Kredit sekarang
                        </label>
                      </div>
                    )}
                  </div>
                </ActionForm>
              </ModalDialogTrigger>
            </div>
          ) : undefined
        }
      />

      {/* Operational Principles Note */}
      <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/70 text-xs text-emerald-950 space-y-1">
        <div className="font-semibold flex items-center gap-2">
          <span>Prinsip Integritas Keuangan & Anti Double-HPP Faktur</span>
        </div>
        <p>
          Faktur Penjualan hanya memposting piutang pelanggan (Dr 1120 Piutang Usaha) dan pendapatan (Cr 4110 Pendapatan Penjualan &amp; Cr 2120 PPN Keluaran). Biaya Pokok Penjualan (HPP) telah diposting saat barang dikeluarkan dari gudang pada fase pemenuhan/pengiriman (Phase 5), sehingga faktur tidak pernah menggandakan beban HPP.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Total Nilai Faktur"
          value={`Rp ${totalInvoicedNominal.toLocaleString("id-ID")}`}
          caption={`${invoices.length} faktur komersial tercatat`}
          icon="pricing"
          iconTone="navy"
        />
        <KpiCard
          label="Total Piutang Aktif"
          value={`Rp ${totalOutstandingNominal.toLocaleString("id-ID")}`}
          caption="Belum terbayar / dalam penagihan"
          icon="wallet"
          iconTone={totalOutstandingNominal > 0 ? "warning" : "fresh"}
        />
        <KpiCard
          label="Faktur Lunas"
          value={String(paidCount)}
          caption="Pelunasan lengkap 100%"
          icon="check"
          iconTone="fresh"
        />
        <KpiCard
          label="Nota Kredit Disetujui"
          value={String(approvedCnCount)}
          caption={`${creditNotes.length} total pengajuan klaim`}
          icon="alert"
          iconTone="info"
        />
      </div>

      {/* Sub-navigation Tabs */}
      <div className="flex border-b border-neutral-200 gap-4 text-sm font-medium">
        <a
          href="/faktur?tab=invoices"
          className={`pb-2 border-b-2 transition-colors ${
            activeTab === "invoices"
              ? "border-emerald-600 text-emerald-700 font-semibold"
              : "border-transparent text-neutral-500 hover:text-neutral-700"
          }`}
        >
          Daftar Faktur Penjualan ({invoices.length})
        </a>
        <a
          href="/faktur?tab=credit_notes"
          className={`pb-2 border-b-2 transition-colors ${
            activeTab === "credit_notes"
              ? "border-emerald-600 text-emerald-700 font-semibold"
              : "border-transparent text-neutral-500 hover:text-neutral-700"
          }`}
        >
          Nota Kredit &amp; Retur ({creditNotes.length})
        </a>
      </div>

      {activeTab === "invoices" ? (
        <Card>
          <CardHeader
            title="Daftar Faktur Komersial Pelanggan"
            subtitle="Pantau status penagihan, nominal PPN, nilai terbayar, dan sisa saldo piutang per faktur."
          />
          <div className="p-4 border-b border-neutral-100">
            <TableSearchFilterBar
              placeholder="Cari nomor faktur atau nama pelanggan..."
              statusOptions={[
                { label: "Semua Status", value: "" },
                { label: "Draft", value: "draft" },
                { label: "Posted (Menunggu Pelunasan)", value: "posted" },
                { label: "Partially Paid", value: "partially_paid" },
                { label: "Paid (Lunas)", value: "paid" },
                { label: "Overdue (Lewat Jatuh Tempo)", value: "overdue" },
                { label: "Cancelled / Void", value: "cancelled" },
              ]}
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50/70 text-neutral-600 font-medium">
                  <th className="py-3 px-4">No. Faktur</th>
                  <th className="py-3 px-4">Tanggal</th>
                  <th className="py-3 px-4">Jatuh Tempo</th>
                  <th className="py-3 px-4">Pelanggan</th>
                  <th className="py-3 px-4">Gudang</th>
                  <th className="py-3 px-4 text-right">Total Tagihan</th>
                  <th className="py-3 px-4 text-right">Terbayar</th>
                  <th className="py-3 px-4 text-right font-semibold">Sisa Piutang</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filteredInvoices.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-8">
                      <EmptyState
                        title="Tidak ada faktur ditemukan"
                        description="Belum ada faktur yang sesuai dengan kriteria filter atau pencarian Anda."
                      />
                    </td>
                  </tr>
                ) : (
                  filteredInvoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-neutral-50/80 transition-colors">
                      <td className="py-3 px-4 font-semibold text-neutral-900 font-mono">
                        {inv.invoiceNo}
                      </td>
                      <td className="py-3 px-4 text-neutral-600">{inv.invoiceDate}</td>
                      <td className="py-3 px-4 text-neutral-600">{inv.dueDate}</td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-neutral-900">{inv.customerName}</div>
                        <div className="text-[10px] text-neutral-500 font-mono">{inv.customerCode}</div>
                      </td>
                      <td className="py-3 px-4 text-neutral-600 font-mono">{inv.warehouseCode}</td>
                      <td className="py-3 px-4 text-right text-neutral-900">
                        Rp {Number(inv.totalAmount).toLocaleString("id-ID")}
                      </td>
                      <td className="py-3 px-4 text-right text-emerald-700">
                        Rp {Number(inv.paidAmount).toLocaleString("id-ID")}
                      </td>
                      <td className="py-3 px-4 text-right font-semibold text-neutral-900">
                        Rp {Number(inv.outstandingAmount).toLocaleString("id-ID")}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <Badge tone={statusToBadgeTone(inv.status)}>
                          {inv.status.replace("_", " ").toUpperCase()}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {inv.status === "draft" && canInvoice && (
                            <ConfirmActionButton
                              action={postSalesInvoiceDirectAction}
                              hiddenFields={{ invoiceId: inv.id }}
                              buttonLabel="Post"
                              buttonVariant="primary"
                              confirmTitle="Posting Faktur ke Buku Besar?"
                              confirmDescription={`Posting faktur #${inv.invoiceNo} akan mengunci dokumen dan mencatat piutang di Buku Besar.`}
                            />
                          )}
                          {(inv.status === "posted" || inv.status === "draft") && canInvoice && (
                            <ModalDialogTrigger
                              title={`Batalkan Faktur ${inv.invoiceNo}`}
                              subtitle="Faktur yang dibatalkan akan memulihkan status order dan membalik pengakuan piutang."
                              triggerLabel="Void"
                              triggerVariant="danger"
                            >
                              <ActionForm action={voidSalesInvoiceAction} submitLabel="Batalkan Faktur">
                                <input type="hidden" name="invoiceId" value={inv.id} />
                                <Field label="Alasan Pembatalan (Wajib)" required>
                                  <Input
                                    name="reason"
                                    placeholder="Contoh: Salah entri pelanggan atau revisi kesepakatan harga"
                                    required
                                  />
                                </Field>
                              </ActionForm>
                            </ModalDialogTrigger>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Daftar Nota Kredit (Credit Notes) & Retur"
            subtitle="Pengurangan saldo tagihan pelanggan atas klaim mutu, pengembalian buah fisik, atau diskon khusus."
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50/70 text-neutral-600 font-medium">
                  <th className="py-3 px-4">No. Nota Kredit</th>
                  <th className="py-3 px-4">Tanggal</th>
                  <th className="py-3 px-4">Pelanggan</th>
                  <th className="py-3 px-4">Sumber / Alasan</th>
                  <th className="py-3 px-4 text-right">Total Kredit</th>
                  <th className="py-3 px-4 text-right">Terpakai</th>
                  <th className="py-3 px-4 text-right font-semibold">Sisa Kredit</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filteredCreditNotes.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8">
                      <EmptyState
                        title="Tidak ada Nota Kredit"
                        description="Belum ada Nota Kredit yang diterbitkan untuk pelanggan."
                      />
                    </td>
                  </tr>
                ) : (
                  filteredCreditNotes.map((cn) => (
                    <tr key={cn.id} className="hover:bg-neutral-50/80 transition-colors">
                      <td className="py-3 px-4 font-semibold text-neutral-900 font-mono">
                        {cn.creditNoteNo}
                      </td>
                      <td className="py-3 px-4 text-neutral-600">{cn.issueDate}</td>
                      <td className="py-3 px-4 font-medium text-neutral-900">{cn.customerName}</td>
                      <td className="py-3 px-4">
                        <div className="text-neutral-900 font-medium">{cn.sourceType}</div>
                        <div className="text-[11px] text-neutral-500">{cn.reason}</div>
                      </td>
                      <td className="py-3 px-4 text-right text-neutral-900">
                        Rp {Number(cn.totalAmount).toLocaleString("id-ID")}
                      </td>
                      <td className="py-3 px-4 text-right text-emerald-700">
                        Rp {Number(cn.appliedAmount).toLocaleString("id-ID")}
                      </td>
                      <td className="py-3 px-4 text-right font-semibold text-neutral-900">
                        Rp {Number(cn.unappliedAmount).toLocaleString("id-ID")}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <Badge tone={statusToBadgeTone(cn.status)}>
                          {cn.status.toUpperCase()}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {cn.status === "draft" && canApprove && (
                          <ConfirmActionButton
                            action={approveCreditNoteDirectAction}
                            hiddenFields={{
                              creditNoteId: cn.id,
                              reason: "Persetujuan Nota Kredit oleh Keuangan",
                            }}
                            buttonLabel="Setujui (Approve)"
                            buttonVariant="primary"
                            confirmTitle="Setujui Nota Kredit?"
                            confirmDescription={`Menyetujui #${cn.creditNoteNo} akan memotong piutang atau mencatat uang muka kredit di Buku Besar.`}
                          />
                        )}
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
