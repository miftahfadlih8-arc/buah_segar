import { redirect } from "next/navigation";
import {
  cancelSalesOrderAction,
  confirmSalesOrderAction,
  createSalesOrderAction,
  createSalesQuotationAction,
  decideSalesOrderApprovalAction,
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
import { businessDate } from "@/lib/datetime";
import { formatRupiah, MoneyDecimal, toDbAmount } from "@/lib/money";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import { listProductsWithDetails, listUoms } from "@/server/modules/master/catalog";
import { listCustomers } from "@/server/modules/master/customers";
import { listWarehouses } from "@/server/modules/master/warehouses";
import {
  listSalesQuotationsAndOrders,
  NON_CANCELLABLE_SO_STATUSES,
} from "@/server/modules/sales";

export const dynamic = "force-dynamic";

export default async function PenjualanPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "sales.read")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const statusFilter = (params.status ?? "").trim().toLowerCase();

  const [salesData, customerList, productsWithDetails, uomsList, warehouseList] =
    await Promise.all([
      listSalesQuotationsAndOrders(db, actor),
      listCustomers(db, actor),
      listProductsWithDetails(db, actor),
      listUoms(db, actor),
      listWarehouses(db, actor),
    ]);

  const canWrite = hasPermission(actor, "sales.write");
  const canDecideApproval = hasPermission(actor, "approvals.decide");

  const customerMap = new Map(customerList.map((c) => [c.id, c]));
  const productMap = new Map(productsWithDetails.map((p) => [p.id, p]));
  const allGrades = productsWithDetails.flatMap((p) => p.grades);
  const warehouseMap = new Map(warehouseList.map((w) => [w.id, w]));

  const linesByOrder = new Map<string, typeof salesData.orderLines>();
  for (const line of salesData.orderLines) {
    const arr = linesByOrder.get(line.salesOrderId) ?? [];
    arr.push(line);
    linesByOrder.set(line.salesOrderId, arr);
  }

  const today = businessDate();

  const filteredOrders = salesData.orders.filter((so) => {
    const cust = customerMap.get(so.customerId);
    const wh = warehouseMap.get(so.warehouseId);
    const lines = linesByOrder.get(so.id) ?? [];
    const matchesQ =
      !q ||
      so.soNumber.toLowerCase().includes(q) ||
      (cust?.name ?? "").toLowerCase().includes(q) ||
      (cust?.code ?? "").toLowerCase().includes(q) ||
      (wh?.code ?? "").toLowerCase().includes(q) ||
      lines.some((l) => (productMap.get(l.productId)?.name ?? "").toLowerCase().includes(q));
    const matchesStatus = !statusFilter || so.status === statusFilter;
    return matchesQ && matchesStatus;
  });

  const activeSalesTotal = salesData.orders
    .filter((o) => o.status !== "cancelled" && o.status !== "rejected")
    .reduce((acc, o) => acc.plus(new MoneyDecimal(o.grandTotalAmount)), new MoneyDecimal(0));
  const pendingApprovalCount = salesData.orders.filter(
    (o) => o.status === "pending_approval",
  ).length;
  const reservedOrdersCount = salesData.orders.filter((o) => o.isStockReserved).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quotation Penjualan, Sales Order (SO) & Reservasi Stok FEFO"
        description="Pembuatan penawaran harga (Quotation), konversi ke Sales Order, validasi margin & batas kredit di server, serta reservasi stok FEFO otomatis saat order dikonfirmasi tanpa mengurangi stok fisik sebelum picking/dispatch."
        actions={
          canWrite ? (
            <>
              <ModalDialogTrigger
                triggerLabel="Buat Quotation"
                triggerVariant="secondary"
                triggerIcon="plus"
                title="Buat Quotation Penawaran Harga"
                subtitle="Susun penawaran harga resmi untuk pelanggan dengan validasi margin otomatis."
                maxWidthClass="max-w-2xl"
              >
                <ActionForm action={createSalesQuotationAction} submitLabel="Simpan Quotation">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Pelanggan" htmlFor="sq-customer" required>
                      <Select id="sq-customer" name="customerId" required>
                        {customerList.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.code} — {c.name} ({c.priceTier})
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Gudang Pemenuhan" htmlFor="sq-warehouse" required>
                      <Select id="sq-warehouse" name="warehouseId" required>
                        {warehouseList.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.code} — {w.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Berlaku Sampai" htmlFor="sq-valid" required>
                      <Input
                        id="sq-valid"
                        name="validUntil"
                        type="date"
                        defaultValue={today}
                        required
                      />
                    </Field>
                    <Field label="Biaya Pengiriman (Rp)" htmlFor="sq-ship">
                      <Input id="sq-ship" name="shippingFeeAmount" defaultValue="0" />
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Produk Buah" htmlFor="sq-prod" required>
                      <Select id="sq-prod" name="productId" required>
                        {productsWithDetails.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.sku} — {p.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Grade" htmlFor="sq-grade" required>
                      <Select id="sq-grade" name="gradeId" required>
                        {allGrades.map((g) => {
                          const p = productMap.get(g.productId);
                          return (
                            <option key={g.id} value={g.id}>
                              {p?.sku ?? g.productId} • Grade {g.code}
                            </option>
                          );
                        })}
                      </Select>
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Satuan (UoM)" htmlFor="sq-uom">
                      <Select id="sq-uom" name="orderedUomCode" defaultValue="kg">
                        {uomsList.map((u) => (
                          <option key={u.code} value={u.code}>
                            {u.code}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Kuantitas" htmlFor="sq-qty" required>
                      <Input id="sq-qty" name="orderedQty" defaultValue="10" required />
                    </Field>
                    <Field label="Diskon (%)" htmlFor="sq-disc">
                      <Input id="sq-disc" name="discountPct" defaultValue="0" />
                    </Field>
                  </div>
                </ActionForm>
              </ModalDialogTrigger>

              <ModalDialogTrigger
                triggerLabel="Buat Sales Order (SO)"
                triggerVariant="primary"
                triggerIcon="sales"
                title="Buat Sales Order (SO) Baru"
                subtitle="Validasi harga, margin minimum, plafon kredit, dan alokasi reservasi batch FEFO dilakukan sepenuhnya di server."
                maxWidthClass="max-w-2xl"
              >
                <ActionForm action={createSalesOrderAction} submitLabel="Simpan Sales Order">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Pelanggan" htmlFor="so-customer" required>
                      <Select id="so-customer" name="customerId" required>
                        {customerList.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.code} — {c.name} (Limit: {formatRupiah(c.creditLimit)})
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Gudang Pemenuhan" htmlFor="so-warehouse" required>
                      <Select id="so-warehouse" name="warehouseId" required>
                        {warehouseList.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.code} — {w.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Produk Buah" htmlFor="so-prod" required>
                      <Select id="so-prod" name="productId" required>
                        {productsWithDetails.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.sku} — {p.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Grade" htmlFor="so-grade" required>
                      <Select id="so-grade" name="gradeId" required>
                        {allGrades.map((g) => {
                          const p = productMap.get(g.productId);
                          return (
                            <option key={g.id} value={g.id}>
                              {p?.sku ?? g.productId} • Grade {g.code}
                            </option>
                          );
                        })}
                      </Select>
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Satuan (UoM)" htmlFor="so-uom">
                      <Select id="so-uom" name="orderedUomCode" defaultValue="kg">
                        {uomsList.map((u) => (
                          <option key={u.code} value={u.code}>
                            {u.code}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Kuantitas" htmlFor="so-qty" required>
                      <Input id="so-qty" name="orderedQty" defaultValue="10" required />
                    </Field>
                    <Field label="Diskon (%)" htmlFor="so-disc">
                      <Input id="so-disc" name="discountPct" defaultValue="0" />
                    </Field>
                  </div>

                  <div className="grid gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3.5 sm:grid-cols-2">
                    <Field
                      label="Harga Khusus / Custom (Opsional, Rp)"
                      htmlFor="so-custom-price"
                      hint="Kosongkan untuk memakai daftar harga resmi"
                    >
                      <Input
                        id="so-custom-price"
                        name="customUnitPrice"
                        placeholder="Kosongkan = Harga Price List"
                        inputMode="numeric"
                      />
                    </Field>
                    <Field label="Biaya Pengiriman (Rp)" htmlFor="so-ship">
                      <Input id="so-ship" name="shippingFeeAmount" defaultValue="0" />
                    </Field>
                  </div>

                  <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3.5 text-xs">
                    <div className="font-bold text-amber-950">
                      Opsi Pengajuan Persetujuan (Jika Melampaui Kebijakan):
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="inline-flex items-center gap-2 font-semibold text-amber-900">
                          <input type="checkbox" name="requestMarginOverride" className="h-4 w-4" />
                          Ajukan Override Margin Minimum
                        </label>
                        <Input
                          name="marginOverrideReason"
                          placeholder="Alasan override margin (jika diajukan)..."
                          className="mt-1.5"
                        />
                      </div>
                      <div>
                        <label className="inline-flex items-center gap-2 font-semibold text-amber-900">
                          <input type="checkbox" name="requestCreditOverride" className="h-4 w-4" />
                          Ajukan Override Plafon Kredit
                        </label>
                        <Input
                          name="creditOverrideReason"
                          placeholder="Alasan override kredit (jika diajukan)..."
                          className="mt-1.5"
                        />
                      </div>
                    </div>
                  </div>

                  <label className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-900">
                    <input type="checkbox" name="autoConfirm" defaultChecked className="h-4 w-4" />
                    Konfirmasi langsung &amp; reservasi stok FEFO jika lulus kontrol margin &amp;
                    kredit
                  </label>
                </ActionForm>
              </ModalDialogTrigger>
            </>
          ) : null
        }
      />

      {/* KPI Strip */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="TOTAL SALES ORDER (SO)"
          value={formatRupiah(toDbAmount(activeSalesTotal))}
          icon="sales"
          iconTone="navy"
          badgeText={`${salesData.orders.length} Pesanan`}
          badgeTone="info"
          caption="Akumulasi nilai pesanan penjualan aktif"
        />
        <KpiCard
          label="MENUNGGU APPROVAL OVERRIDE"
          value={`${pendingApprovalCount} SO`}
          icon="shield"
          iconTone={pendingApprovalCount > 0 ? "warning" : "fresh"}
          badgeText={pendingApprovalCount > 0 ? "Butuh Keputusan" : "0 Antrean"}
          badgeTone={pendingApprovalCount > 0 ? "warning" : "success"}
          caption="Override margin minimum atau plafon kredit"
        />
        <KpiCard
          label="RESERVASI STOK FEFO AKTIF"
          value={`${reservedOrdersCount} SO`}
          icon="inventory"
          iconTone="fresh"
          badgeText="Locked FEFO"
          badgeTone="success"
          caption="Stok terkunci tanpa memotong saldo fisik sebelum dispatch"
        />
        <KpiCard
          label="QUOTATION PENAWARAN"
          value={`${salesData.quotations.length} Dokumen`}
          icon="catalog"
          iconTone="info"
          badgeText="Siap Konversi"
          badgeTone="info"
          caption="Penawaran harga resmi kepada pelanggan B2B/HORECA"
        />
      </div>

      {/* Sales Orders Table */}
      <Card noPadding>
        <CardHeader
          id="daftar-so-heading"
          title="Daftar Sales Order (SO)"
          subtitle="Memantau status konfirmasi pesanan, persentase margin per baris, dan alokasi reservasi FEFO"
          meta={<Badge tone="neutral">{filteredOrders.length} Pesanan</Badge>}
        />

        <TableSearchFilterBar
          placeholder="Cari nomor SO, nama pelanggan, kode pelanggan, atau nama buah..."
          statusLabel="Semua Status SO"
          statusOptions={[
            { value: "draft", label: "Draft" },
            { value: "submitted", label: "Submitted" },
            { value: "pending_approval", label: "Pending Approval (Override)" },
            { value: "confirmed", label: "Confirmed (Reserved FEFO)" },
            { value: "rejected", label: "Rejected (Ditolak)" },
            { value: "cancelled", label: "Cancelled (Dibatalkan)" },
          ]}
          totalCount={salesData.orders.length}
          filteredCount={filteredOrders.length}
        />

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="daftar-so-heading"
          className="table-region"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3">Nomor SO &amp; Tanggal</th>
                <th className="px-4 py-3">Pelanggan &amp; Termin</th>
                <th className="px-4 py-3">Rincian Item, Harga &amp; Margin</th>
                <th className="px-4 py-3 text-right">Total &amp; Reservasi FEFO</th>
                <th className="px-5 py-3 text-right">Status &amp; Tindakan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {filteredOrders.map((so) => {
                const cust = customerMap.get(so.customerId);
                const wh = warehouseMap.get(so.warehouseId);
                const lines = linesByOrder.get(so.id) ?? [];
                const isCancellable =
                  so.status !== "cancelled" &&
                  !(NON_CANCELLABLE_SO_STATUSES as readonly string[]).includes(so.status) &&
                  !so.isInvoiced;

                return (
                  <tr key={so.id} className="align-top hover:bg-slate-50/80">
                    <th scope="row" className="px-5 py-3.5 font-semibold text-slate-900">
                      <div className="font-mono text-xs font-bold text-blue-600">{so.soNumber}</div>
                      <div className="tabular-nums mt-0.5 text-[11px] text-slate-600">
                        {so.orderDate}
                      </div>
                      <div className="mt-0.5 text-[11px] font-normal text-slate-500">
                        Gudang: {wh?.code ?? so.warehouseId}
                      </div>
                    </th>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">
                        {cust?.name ?? so.customerId}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        Tier: {so.priceTierSnapshot.toUpperCase()} • Termin: {so.paymentTermsDays}{" "}
                        hari
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {so.requiresMarginApproval ? (
                          <Badge tone="warning">Override Margin</Badge>
                        ) : null}
                        {so.requiresCreditApproval ? (
                          <Badge tone="warning">Override Kredit</Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <ul className="space-y-1.5">
                        {lines.map((l) => {
                          const prod = productMap.get(l.productId);
                          return (
                            <li key={l.id} className="tabular-nums text-slate-700">
                              <span className="font-bold text-slate-900">
                                {prod?.name ?? l.productId} (Grade {l.gradeCode})
                              </span>
                              : {l.orderedQty} {l.orderedUomCode} ({l.orderedQtyBase} base) ×{" "}
                              {formatRupiah(l.netUnitPrice)} • Margin:{" "}
                              <span
                                className={
                                  l.isBelowMinMargin
                                    ? "font-bold text-red-700"
                                    : "font-bold text-emerald-700"
                                }
                              >
                                {l.marginPct}%
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </td>
                    <td className="tabular-nums px-4 py-3.5 text-right">
                      <div className="text-sm font-bold text-slate-900">
                        {formatRupiah(so.grandTotalAmount)}
                      </div>
                      <div className="mt-1">
                        <Badge tone={so.isStockReserved ? "success" : "neutral"} dot>
                          {so.isStockReserved ? "FEFO RESERVED" : "BELUM DIRESERVASI"}
                        </Badge>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div>
                        <Badge tone={statusToBadgeTone(so.status)} dot>
                          {so.status.toUpperCase()}
                        </Badge>
                      </div>

                      <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                        {canDecideApproval && so.status === "pending_approval" ? (
                          <>
                            <ConfirmActionButton
                              action={decideSalesOrderApprovalAction}
                              hiddenFields={{
                                salesOrderId: so.id,
                                decision: "approved",
                              }}
                              buttonLabel="Setujui Override"
                              buttonVariant="fresh"
                              confirmTitle={`Setujui Override pada ${so.soNumber}?`}
                              confirmDescription="Setelah disetujui, Sales Order dapat dikonfirmasi dan mengalokasikan batch stok FEFO."
                              confirmButtonLabel="Ya, Setujui Override"
                              reasonFieldName="decisionNote"
                              reasonDefaultValue="Override margin/kredit disetujui oleh pejabat berwenang."
                              requireReason
                            />
                            <ConfirmActionButton
                              action={decideSalesOrderApprovalAction}
                              hiddenFields={{
                                salesOrderId: so.id,
                                decision: "rejected",
                              }}
                              buttonLabel="Tolak"
                              buttonVariant="danger"
                              confirmTitle={`Tolak Pengajuan Override ${so.soNumber}?`}
                              confirmDescription="Status Sales Order akan berubah menjadi REJECTED dan tidak mengalokasikan stok."
                              confirmButtonLabel="Ya, Tolak Override"
                              reasonFieldName="decisionNote"
                              reasonDefaultValue="Margin atau risiko kredit tidak memenuhi kebijakan."
                              requireReason
                            />
                          </>
                        ) : null}

                        {canWrite && (so.status === "submitted" || so.status === "draft") ? (
                          <ConfirmActionButton
                            action={confirmSalesOrderAction}
                            hiddenFields={{ salesOrderId: so.id }}
                            buttonLabel="Konfirmasi & Reservasi FEFO"
                            buttonVariant="fresh"
                            confirmTitle={`Konfirmasi & Reservasi Stok FEFO untuk ${so.soNumber}?`}
                            confirmDescription="Sistem akan memeriksa eksposur kredit terbaru dan mengunci batch FEFO sesuai kuantitas pesanan."
                            confirmButtonLabel="Ya, Konfirmasi & Reservasi"
                          />
                        ) : null}

                        {canWrite && isCancellable ? (
                          <ConfirmActionButton
                            action={cancelSalesOrderAction}
                            hiddenFields={{ salesOrderId: so.id }}
                            buttonLabel="Batalkan Order"
                            buttonVariant="danger"
                            confirmTitle={`Batalkan Sales Order ${so.soNumber}?`}
                            confirmDescription="Seluruh reservasi stok FEFO yang aktif pada pesanan ini akan otomatis dilepaskan kembali ke saldo Available."
                            confirmButtonLabel="Ya, Batalkan Order"
                            reasonFieldName="cancelReason"
                            reasonDefaultValue="Pembatalan pesanan sebelum proses picking gudang."
                            requireReason
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      icon="sales"
                      title="Tidak Ada Sales Order"
                      description="Tidak ditemukan Sales Order yang sesuai dengan pencarian atau filter status."
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Sales Quotations Table */}
      <Card noPadding>
        <CardHeader
          id="daftar-sq-heading"
          title="Daftar Quotation Penjualan"
          subtitle="Riwayat penawaran harga kepada pelanggan sebelum dikonversi menjadi Sales Order"
          meta={<Badge tone="info">{salesData.quotations.length} Quotation</Badge>}
        />

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="daftar-sq-heading"
          className="table-region"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3">No. Quotation</th>
                <th className="px-4 py-3">Pelanggan</th>
                <th className="px-4 py-3">Masa Berlaku</th>
                <th className="px-4 py-3 text-right">Grand Total</th>
                <th className="px-5 py-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {salesData.quotations.map((sq) => {
                const cust = customerMap.get(sq.customerId);
                return (
                  <tr key={sq.id} className="hover:bg-slate-50/80">
                    <th
                      scope="row"
                      className="px-5 py-3.5 font-mono text-xs font-bold text-blue-600"
                    >
                      {sq.quotationNo}
                    </th>
                    <td className="px-4 py-3.5 font-semibold text-slate-900">
                      {cust?.name ?? sq.customerId}
                    </td>
                    <td className="tabular-nums px-4 py-3.5 font-mono text-slate-700">
                      {sq.quoteDate} s/d {sq.validUntil}
                    </td>
                    <td className="tabular-nums px-4 py-3.5 text-right font-bold text-slate-900">
                      {formatRupiah(sq.grandTotalAmount)}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <Badge tone={statusToBadgeTone(sq.status)} dot>
                        {sq.status.toUpperCase()}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
              {salesData.quotations.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      icon="catalog"
                      title="Belum Ada Quotation"
                      description="Buat Quotation baru untuk mengirimkan penawaran harga resmi ke pelanggan."
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
