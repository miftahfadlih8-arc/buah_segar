import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import {
  approvePurchaseOrderAction,
  cancelPurchaseOrderAction,
  createPurchaseOrderAction,
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
import { formatDate } from "@/lib/datetime";
import { formatRupiah, MoneyDecimal, toDbAmount } from "@/lib/money";
import { formatQty } from "@/lib/quantity";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import { products, purchaseOrderLines, suppliers, uoms, warehouses } from "@/server/db/schema";
import { listPurchaseOrders } from "@/server/modules/procurement";

export const dynamic = "force-dynamic";

export default async function PembelianPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "procurement.read")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const statusFilter = (params.status ?? "").trim().toLowerCase();

  const [poList, allSuppliers, allWarehouses, allProducts, allUoms] = await Promise.all([
    listPurchaseOrders(db, actor),
    db.select().from(suppliers).where(eq(suppliers.isActive, true)).orderBy(asc(suppliers.name)),
    db
      .select()
      .from(warehouses)
      .where(eq(warehouses.isActive, true))
      .orderBy(asc(warehouses.name)),
    db.select().from(products).where(eq(products.isActive, true)).orderBy(asc(products.name)),
    db.select().from(uoms).orderBy(asc(uoms.code)),
  ]);

  const linesByPo = new Map<
    string,
    Array<{
      line: typeof purchaseOrderLines.$inferSelect;
      productName: string;
      baseUom: string;
    }>
  >();

  for (const row of poList) {
    const lines = await db
      .select({
        line: purchaseOrderLines,
        productName: products.name,
        baseUom: products.baseUomCode,
      })
      .from(purchaseOrderLines)
      .innerJoin(products, eq(products.id, purchaseOrderLines.productId))
      .where(eq(purchaseOrderLines.purchaseOrderId, row.po.id))
      .orderBy(asc(purchaseOrderLines.lineNo));
    linesByPo.set(row.po.id, lines);
  }

  const canWrite = hasPermission(actor, "procurement.write");
  const canApprove = hasPermission(actor, "procurement.approve");

  const filteredPos = poList.filter(({ po, supplier, warehouse }) => {
    const lines = linesByPo.get(po.id) ?? [];
    const matchesQ =
      !q ||
      po.poNumber.toLowerCase().includes(q) ||
      supplier.name.toLowerCase().includes(q) ||
      po.originRegion.toLowerCase().includes(q) ||
      warehouse.code.toLowerCase().includes(q) ||
      lines.some((l) => l.productName.toLowerCase().includes(q));
    const matchesStatus = !statusFilter || po.status === statusFilter;
    return matchesQ && matchesStatus;
  });

  const openPoCount = poList.filter((r) =>
    ["draft", "submitted", "approved", "partially_received"].includes(r.po.status),
  ).length;
  const approvedOrReceivingCount = poList.filter((r) =>
    ["approved", "partially_received"].includes(r.po.status),
  ).length;
  const totalPoAmount = poList
    .filter((r) => r.po.status !== "cancelled")
    .reduce((acc, r) => acc.plus(new MoneyDecimal(r.po.totalAmount)), new MoneyDecimal(0));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pengadaan & Purchase Order (PO) Petani / Supplier"
        description="Kelola siklus pesanan pembelian buah segar (Draft → Diajukan → Disetujui → Diterima Sebagian / Penuh) beserta batas toleransi penerimaan."
        actions={
          canWrite ? (
            <ModalDialogTrigger
              triggerLabel="Buat Purchase Order"
              triggerVariant="primary"
              triggerIcon="plus"
              title="Buat Purchase Order (PO) Baru"
              subtitle="Tentukan petani/supplier, gudang tujuan, toleransi lebih kirim, dan harga beli per satuan dasar."
              maxWidthClass="max-w-3xl"
            >
              <ActionForm action={createPurchaseOrderAction} submitLabel="Simpan Purchase Order">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Supplier / Petani" htmlFor="po-sup" required>
                    <Select id="po-sup" name="supplierId" required>
                      {allSuppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.code} — {s.name} ({s.originRegion})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Gudang Tujuan" htmlFor="po-wh" required>
                    <Select id="po-wh" name="warehouseId" required>
                      {allWarehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.code} — {w.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Toleransi Lebih Kirim (%)" htmlFor="po-tol" required>
                    <Input id="po-tol" name="qtyTolerancePct" defaultValue="5.00" required />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-4">
                  <Field label="Produk Buah" htmlFor="po-prod" required>
                    <Select id="po-prod" name="productId" required>
                      {allProducts.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku} — {p.name} ({p.baseUomCode})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Satuan Pesanan" htmlFor="po-uom">
                    <Select id="po-uom" name="orderedUomCode" defaultValue="kg">
                      {allUoms.map((u) => (
                        <option key={u.code} value={u.code}>
                          {u.code} — {u.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Kuantitas Pesanan" htmlFor="po-qty" required>
                    <Input
                      id="po-qty"
                      name="orderedQty"
                      placeholder="Contoh: 500"
                      required
                      inputMode="decimal"
                    />
                  </Field>
                  <Field label="Harga Beli / Base (Rp)" htmlFor="po-price" required>
                    <Input
                      id="po-price"
                      name="unitPriceBase"
                      placeholder="Contoh: 18000"
                      required
                      inputMode="numeric"
                    />
                  </Field>
                </div>

                <div className="flex flex-wrap items-center gap-6">
                  <div className="flex-1">
                    <Field label="Catatan Spesifikasi Panen / Pengiriman" htmlFor="po-notes">
                      <Input
                        id="po-notes"
                        name="notes"
                        placeholder="Catatan spesifikasi panen / jadwal tiba..."
                      />
                    </Field>
                  </div>
                  {canApprove ? (
                    <label className="mt-5 inline-flex items-center gap-2 text-xs font-semibold text-slate-800">
                      <input
                        type="checkbox"
                        name="autoApprove"
                        defaultChecked
                        className="h-4 w-4"
                      />
                      Langsung Ajukan &amp; Setujui PO
                    </label>
                  ) : null}
                </div>
              </ActionForm>
            </ModalDialogTrigger>
          ) : null
        }
      />

      {/* KPI Strip */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="TOTAL PURCHASE ORDER"
          value={`${poList.length} Dokumen`}
          icon="procurement"
          iconTone="navy"
          badgeText={`${openPoCount} Terbuka`}
          badgeTone={openPoCount > 0 ? "info" : "neutral"}
          caption="Seluruh dokumen PO terdaftar"
        />
        <KpiCard
          label="SIAP DITERIMA GUDANG"
          value={`${approvedOrReceivingCount} PO`}
          icon="receiving"
          iconTone="fresh"
          badgeText="Approved / Partial"
          badgeTone="success"
          caption="Dapat diproses pada modul GRN & QC"
        />
        <KpiCard
          label="TOTAL NILAI KOMITMEN PO"
          value={formatRupiah(toDbAmount(totalPoAmount))}
          icon="wallet"
          iconTone="info"
          badgeText="Non-Batal"
          badgeTone="info"
          caption="Akumulasi nilai pembelian petani/supplier"
        />
        <KpiCard
          label="KONTROL TOLERANSI KIRIM"
          value="Aktif"
          icon="shield"
          iconTone="warning"
          badgeText="Server-Side Gate"
          badgeTone="warning"
          caption="Kelebihan kirim di atas toleransi wajib approval"
        />
      </div>

      {/* Purchase Orders Table */}
      <Card noPadding>
        <CardHeader
          id="daftar-po-heading"
          title="Daftar Purchase Order (PO)"
          subtitle="Memantau progres kuantitas dipesan vs diterima timbangan neto vs lolos QC"
          meta={<Badge tone="neutral">{filteredPos.length} PO</Badge>}
        />

        <TableSearchFilterBar
          placeholder="Cari nomor PO, nama supplier, asal daerah, atau nama buah..."
          statusLabel="Semua Status PO"
          statusOptions={[
            { value: "draft", label: "Draft" },
            { value: "submitted", label: "Submitted" },
            { value: "approved", label: "Approved" },
            { value: "partially_received", label: "Partially Received" },
            { value: "received", label: "Received (Selesai)" },
            { value: "cancelled", label: "Cancelled (Batal)" },
          ]}
          totalCount={poList.length}
          filteredCount={filteredPos.length}
        />

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="daftar-po-heading"
          className="table-region"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3">No. PO / Revisi</th>
                <th className="px-4 py-3">Tanggal</th>
                <th className="px-4 py-3">Supplier &amp; Asal</th>
                <th className="px-4 py-3">Rincian Item (Dipesan vs Neto Masuk vs Lolos QC)</th>
                <th className="px-4 py-3 text-right">Total Nilai PO</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-5 py-3 text-right">Tindakan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {filteredPos.map(({ po, supplier, warehouse }) => {
                const lines = linesByPo.get(po.id) ?? [];
                return (
                  <tr key={po.id} className="align-top hover:bg-slate-50/80">
                    <th scope="row" className="px-5 py-3.5 font-semibold text-slate-900">
                      <div className="font-mono text-xs font-bold text-blue-600">{po.poNumber}</div>
                      <div className="mt-0.5 text-[11px] font-normal text-slate-500">
                        Gudang: {warehouse.code} • Rev #{po.revisionNo} • Tol: {po.qtyTolerancePct}%
                      </div>
                    </th>
                    <td className="tabular-nums px-4 py-3.5 text-slate-700">
                      {formatDate(po.orderDate)}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">{supplier.name}</div>
                      <div className="text-[11px] text-slate-500">{po.originRegion}</div>
                    </td>
                    <td className="px-4 py-3.5">
                      <ul className="space-y-1.5">
                        {lines.map(({ line, productName, baseUom }) => (
                          <li key={line.id} className="tabular-nums text-slate-700">
                            <span className="font-bold text-slate-900">{productName}:</span> Dipesan{" "}
                            {formatQty(line.orderedQtyBase, baseUom)} @{" "}
                            {formatRupiah(line.unitPriceBase)}
                            <div className="mt-0.5 flex flex-wrap gap-2 text-[11px]">
                              <span className="text-blue-700">
                                Neto Masuk:{" "}
                                <strong>{formatQty(line.receivedNetQtyBase, baseUom)}</strong>
                              </span>
                              <span>•</span>
                              <span className="text-emerald-700">
                                Lolos QC:{" "}
                                <strong>{formatQty(line.acceptedQtyBase, baseUom)}</strong>
                              </span>
                              <span>•</span>
                              <span className="text-red-700">
                                Reject: <strong>{formatQty(line.rejectedQtyBase, baseUom)}</strong>
                              </span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="tabular-nums px-4 py-3.5 text-right font-bold text-slate-900">
                      {formatRupiah(po.totalAmount)}
                    </td>
                    <td className="px-4 py-3.5">
                      <Badge tone={statusToBadgeTone(po.status)} dot>
                        {po.status.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {canApprove && (po.status === "draft" || po.status === "submitted") ? (
                          <ConfirmActionButton
                            action={approvePurchaseOrderAction}
                            hiddenFields={{ purchaseOrderId: po.id }}
                            buttonLabel="Setujui PO"
                            buttonVariant="fresh"
                            confirmTitle={`Setujui Purchase Order ${po.poNumber}?`}
                            confirmDescription="PO yang telah disetujui dapat langsung diterima oleh bagian Gudang & QC."
                            confirmButtonLabel="Ya, Setujui PO"
                          />
                        ) : null}
                        {canWrite &&
                        (po.status === "draft" ||
                          po.status === "submitted" ||
                          po.status === "approved") ? (
                          <ConfirmActionButton
                            action={cancelPurchaseOrderAction}
                            hiddenFields={{ purchaseOrderId: po.id }}
                            buttonLabel="Batalkan"
                            buttonVariant="danger"
                            confirmTitle={`Batalkan Purchase Order ${po.poNumber}?`}
                            confirmDescription="PO yang dibatalkan tidak dapat digunakan untuk penerimaan barang."
                            confirmButtonLabel="Ya, Batalkan PO"
                            reasonFieldName="reason"
                            reasonDefaultValue="Dibatalkan oleh staf pengadaan"
                            requireReason
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredPos.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      icon="procurement"
                      title="Belum Ada Purchase Order"
                      description="Tidak ada dokumen Purchase Order yang sesuai dengan pencarian atau filter status."
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
