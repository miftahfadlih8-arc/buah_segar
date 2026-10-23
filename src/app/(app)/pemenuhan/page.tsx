import { redirect } from "next/navigation";
import {
  createSalesFulfillmentAction,
  finalizeFulfillmentPackingAction,
  recordFulfillmentPickingAction,
  reportFulfillmentExceptionAction,
  resolveFulfillmentExceptionAction,
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
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import {
  listReadySalesOrdersForFulfillment,
  listSalesFulfillments,
} from "@/server/modules/fulfillment";

export const dynamic = "force-dynamic";

export default async function PemenuhanPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "fulfillment.pick_pack")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const statusFilter = (params.status ?? "").trim().toLowerCase();

  const [fulfillments, readyOrders] = await Promise.all([
    listSalesFulfillments(db, actor),
    listReadySalesOrdersForFulfillment(db, actor),
  ]);

  const canPickPack = hasPermission(actor, "fulfillment.pick_pack");
  const canDecideApproval = hasPermission(actor, "approvals.decide");
  const today = businessDate();

  const filteredFulfillments = fulfillments.filter((f) => {
    const matchesQ =
      !q ||
      f.fulfillmentNo.toLowerCase().includes(q) ||
      f.soNumber.toLowerCase().includes(q) ||
      f.customerName.toLowerCase().includes(q) ||
      f.lines.some((l) => l.orderedProductName.toLowerCase().includes(q));
    const matchesStatus = !statusFilter || f.status === statusFilter;
    return matchesQ && matchesStatus;
  });

  const readyOrderCount = readyOrders.length;
  const activeFulfillmentCount = fulfillments.filter(
    (f) => f.status === "draft" || f.status === "picking",
  ).length;
  const holdCount = fulfillments.filter((f) => f.status === "exception_hold").length;
  const packedCount = fulfillments.filter((f) => f.status === "packed").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pemenuhan Gudang & Pengepakan"
        description="Alur Picking FEFO, Penimbangan Bruto/Tara/Neto, Kontrol Toleransi & Pengepakan Buah Segar Bekasi"
        eyebrow={
          <Badge tone={canPickPack ? "success" : "neutral"}>
            {canPickPack ? "Petugas Gudang (Pick & Pack Aktif)" : "Mode Pratinjau (Read-Only)"}
          </Badge>
        }
      />

      {/* KPI Section */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="SO Siap Dipenuhi"
          value={String(readyOrderCount)}
          icon="sales"
          caption="Pesanan confirmed menunggu picking"
          iconTone="fresh"
        />
        <KpiCard
          label="Fulfillment Berjalan"
          value={String(activeFulfillmentCount)}
          icon="scale"
          caption="Dokumen picking aktif di gudang"
          iconTone="info"
        />
        <KpiCard
          label="Exception / Hold"
          value={String(holdCount)}
          icon="alert"
          caption="Membutuhkan approval toleransi/substitusi"
          iconTone={holdCount > 0 ? "warning" : "info"}
        />
        <KpiCard
          label="Selesai Packing"
          value={String(packedCount)}
          icon="inventory"
          caption="Siap dibuatkan Surat Jalan"
          iconTone="fresh"
        />
      </div>

      {/* SO Siap Dipenuhi Section */}
      {readyOrders.length > 0 && canPickPack && (
        <Card noPadding>
          <CardHeader
            title="Sales Order Terkonfirmasi Siap Dipenuhi"
            subtitle="Pilih pesanan yang telah dikonfirmasi pelanggan untuk memulai alur picking dan penimbangan."
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-surface-border bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">No. SO</th>
                  <th className="px-4 py-3">Pelanggan</th>
                  <th className="px-4 py-3">Gudang</th>
                  <th className="px-4 py-3">Tgl Order</th>
                  <th className="px-4 py-3 text-right">Total Order</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {readyOrders.map((so) => (
                  <tr key={so.id} className="hover:bg-slate-50/50">
                    <td className="px-4 py-3 font-semibold text-slate-900">{so.soNumber}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{so.customerName}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{so.warehouseCode}</td>
                    <td className="px-4 py-3 text-slate-500">{so.orderDate}</td>
                    <td className="px-4 py-3 text-right font-medium text-slate-900">
                      Rp {Number(so.grandTotal).toLocaleString("id-ID")}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge tone={statusToBadgeTone(so.status)}>{so.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ModalDialogTrigger
                        triggerLabel="Mulai Pemenuhan"
                        title={`Buat Dokumen Fulfillment untuk ${so.soNumber}`}
                        subtitle="Sistem akan mengunci reservasi stok FEFO untuk pesanan ini dan menyiapkan lembar picking."
                        triggerVariant="primary"
                      >
                        <ActionForm action={createSalesFulfillmentAction} submitLabel="Buat Dokumen Fulfillment">
                          <input type="hidden" name="salesOrderId" value={so.id} />
                          <div className="space-y-4">
                            <Field label="Pelanggan" htmlFor={`cust_${so.id}`}>
                              <Input id={`cust_${so.id}`} value={so.customerName} readOnly />
                            </Field>
                            <Field label="Tanggal Pemenuhan" htmlFor={`fulDate_${so.id}`}>
                              <Input id={`fulDate_${so.id}`} name="fulfillmentDate" type="date" defaultValue={today} required />
                            </Field>
                            <Field label="Toleransi Berat Timbangan (%)" htmlFor={`tol_${so.id}`} hint="Default 5.00%. Di luar batas ini membutuhkan persetujuan Owner.">
                              <Input id={`tol_${so.id}`} name="qtyTolerancePct" type="number" step="0.01" defaultValue="5.00" />
                            </Field>
                            <Field label="Catatan Pemenuhan" htmlFor={`notes_${so.id}`}>
                              <Input id={`notes_${so.id}`} name="notes" placeholder="Contoh: Pilih buah mangga siap makan untuk katering" />
                            </Field>
                          </div>
                        </ActionForm>
                      </ModalDialogTrigger>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Filter and Main Table */}
      <Card noPadding>
        <CardHeader
          title="Daftar Dokumen Pemenuhan (Fulfillment)"
          subtitle="Pantau alokasi batch, verifikasi timbangan bruto/tara/neto, dan verifikasi checklist packing sebelum pengiriman."
        />
        <div className="p-4 border-b border-slate-100">
          <TableSearchFilterBar
            placeholder="Cari no fulfillment, SO, pelanggan, buah..."
            statusOptions={[
              { label: "Semua Status", value: "" },
              { label: "Draft", value: "draft" },
              { label: "Picking", value: "picking" },
              { label: "Exception Hold", value: "exception_hold" },
              { label: "Picked", value: "picked" },
              { label: "Packed", value: "packed" },
            ]}
          />
        </div>

        {filteredFulfillments.length === 0 ? (
          <EmptyState
            title="Tidak ada dokumen pemenuhan"
            description="Belum ada proses pemenuhan yang cocok dengan pencarian atau filter Anda."
          />
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredFulfillments.map((ful) => (
              <div key={ful.id} className="p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-base text-slate-900">{ful.fulfillmentNo}</span>
                      <Badge tone={statusToBadgeTone(ful.status)}>{ful.status}</Badge>
                      {ful.isPartialFulfillment && (
                        <Badge tone="warning">Parsial (Sisa {ful.totalRemainingQtyBase} kg)</Badge>
                      )}
                    </div>
                    <div className="text-xs text-slate-500">
                      SO: <span className="font-semibold text-slate-800">{ful.soNumber}</span> • Pelanggan:{" "}
                      <span className="font-semibold text-slate-800">{ful.customerName}</span> • Tgl:{" "}
                      {ful.fulfillmentDate} • Toleransi: {ful.qtyTolerancePct}%
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Action: Pick & Weigh Modal */}
                    {canPickPack && (ful.status === "draft" || ful.status === "picking" || ful.status === "exception_hold") && (
                      <ModalDialogTrigger
                        triggerLabel="Timbang & Catat Picking"
                        title={`Input Timbangan untuk ${ful.fulfillmentNo}`}
                        subtitle="Masukkan berat bruto dan tara dari timbangan kalibrasi. Sistem menghitung neto secara otomatis dan mencatat mutasi stok FEFO serta jurnal HPP."
                        triggerVariant="primary"
                      >
                        <ActionForm action={recordFulfillmentPickingAction} submitLabel="Simpan & Potong Stok">
                          <input type="hidden" name="fulfillmentId" value={ful.id} />
                          <div className="space-y-4">
                            <Field label="Pilih Baris Item Pesanan" htmlFor={`line_${ful.id}`}>
                              <Select id={`line_${ful.id}`} name="fulfillmentLineId" required>
                                {ful.lines.map((l) => (
                                  <option key={l.id} value={l.id}>
                                    #{l.lineNo}: {l.orderedProductName} (Grade {l.orderedGradeCode}) — Target: {l.targetPickQtyBase} kg
                                  </option>
                                ))}
                              </Select>
                            </Field>

                            <div className="grid grid-cols-2 gap-3">
                              <Field label="Berat Bruto (kg)" htmlFor={`gross_${ful.id}`} hint="Berat buah + wadah">
                                <Input id={`gross_${ful.id}`} name="grossWeightKg" type="number" step="0.001" placeholder="cth: 21.200" required />
                              </Field>
                              <Field label="Berat Tara Wadah (kg)" htmlFor={`tare_${ful.id}`} hint="Berat keranjang kosong">
                                <Input id={`tare_${ful.id}`} name="tareWeightKg" type="number" step="0.001" placeholder="cth: 1.200" required />
                              </Field>
                            </div>

                            <Field label="Scan Barcode / Kode Batch (Opsional)" htmlFor={`bc_${ful.id}`}>
                              <Input id={`bc_${ful.id}`} name="scannedBarcode" placeholder="Scan barcode SKU produk atau kode LOT" />
                            </Field>

                            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 space-y-2">
                              <div className="text-xs font-semibold text-slate-900">Pengecualian / Override (Opsional)</div>
                              <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                                <input type="checkbox" name="requestOverrideApproval" className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" />
                                <span>Ajukan persetujuan bila timbangan melebihi toleransi atau ada pergantian grade buah</span>
                              </label>
                              <Input name="overrideReason" placeholder="Alasan jika ada selisih timbangan / substitusi grade" />
                            </div>
                          </div>
                        </ActionForm>
                      </ModalDialogTrigger>
                    )}

                    {/* Action: Lapor Kendala / Exception */}
                    {canPickPack && ful.status !== "packed" && (
                      <ModalDialogTrigger
                        triggerLabel="Lapor Kendala"
                        title={`Lapor Exception untuk ${ful.fulfillmentNo}`}
                        subtitle="Catat kendala buah rusak, susut tidak wajar, atau masalah kemasan untuk ditinjau supervisor gudang."
                        triggerVariant="secondary"
                      >
                        <ActionForm action={reportFulfillmentExceptionAction} submitLabel="Laporkan Exception">
                          <input type="hidden" name="fulfillmentId" value={ful.id} />
                          <div className="space-y-4">
                            <Field label="Baris Item" htmlFor={`excLine_${ful.id}`}>
                              <Select id={`excLine_${ful.id}`} name="fulfillmentLineId">
                                <option value="">Semua Baris Dokumen</option>
                                {ful.lines.map((l) => (
                                  <option key={l.id} value={l.id}>
                                    #{l.lineNo}: {l.orderedProductName} (Grade {l.orderedGradeCode})
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <Field label="Jenis Kendala" htmlFor={`excType_${ful.id}`}>
                              <Select id={`excType_${ful.id}`} name="exceptionType" required>
                                <option value="damaged_goods">Buah Rusak / Memar (damaged_goods)</option>
                                <option value="weight_variance">Selisih Timbangan Melebihi Toleransi (weight_variance)</option>
                                <option value="substitution">Perlu Substitusi Produk / Grade Buah (substitution)</option>
                                <option value="batch_unavailable">Batch Tidak Tersedia / Kurang (batch_unavailable)</option>
                                <option value="price_variance">Variasi Harga / Biaya (price_variance)</option>
                              </Select>
                            </Field>
                            <Field label="Tingkat Keparahan" htmlFor={`sev_${ful.id}`}>
                              <Select id={`sev_${ful.id}`} name="severity" required>
                                <option value="warning">Peringatan (Non-blocking)</option>
                                <option value="blocking">Kritis / Blokir Packing (Blocking)</option>
                              </Select>
                            </Field>
                            <Field label="Kode Alasan" htmlFor={`rc_${ful.id}`}>
                              <Input id={`rc_${ful.id}`} name="reasonCode" placeholder="Contoh: FRUIT_BRUISED_TRANSIT" required />
                            </Field>
                            <Field label="Deskripsi Kendala" htmlFor={`desc_${ful.id}`}>
                              <Input id={`desc_${ful.id}`} name="description" placeholder="Jelaskan kondisi fisik buah atau kendala timbangan..." required />
                            </Field>
                          </div>
                        </ActionForm>
                      </ModalDialogTrigger>
                    )}

                    {/* Action: Pengepakan / Finalize Packing */}
                    {canPickPack && ful.status === "picked" && (
                      <ModalDialogTrigger
                        triggerLabel="Finalisasi Packing"
                        title={`Checklist Pengepakan untuk ${ful.fulfillmentNo}`}
                        subtitle="Pastikan buah lolos QC akhir, peti bersih berlabel, dan segel kemasan terpasang sebelum dibuatkan Surat Jalan."
                        triggerVariant="primary"
                      >
                        <form action={finalizeFulfillmentPackingAction} className="space-y-4">
                          <input type="hidden" name="fulfillmentId" value={ful.id} />
                          <div className="space-y-3 p-4 rounded-lg border border-slate-200 bg-slate-50/50">
                            <label className="flex items-center gap-3 text-sm text-slate-800 cursor-pointer">
                              <input type="checkbox" name="qualityChecked" defaultChecked required className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" />
                              <span>1. Kualitas buah segar terverifikasi (bebas busuk, tingkat kematangan seragam)</span>
                            </label>
                            <label className="flex items-center gap-3 text-sm text-slate-800 cursor-pointer">
                              <input type="checkbox" name="packagingVerified" defaultChecked required className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" />
                              <span>2. Wadah/kemasan bersih dan kokoh (peti kayu/plastik/box)</span>
                            </label>
                            <label className="flex items-center gap-3 text-sm text-slate-800 cursor-pointer">
                              <input type="checkbox" name="labelAttached" defaultChecked required className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" />
                              <span>3. Label alamat pelanggan dan kode lot ditempel rapi</span>
                            </label>
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <Field label="Jumlah Koli / Peti" htmlFor={`koli_${ful.id}`}>
                              <Input id={`koli_${ful.id}`} name="packageCount" type="number" defaultValue="1" min="1" required />
                            </Field>
                            <Field label="Catatan Pengepakan" htmlFor={`packNote_${ful.id}`}>
                              <Input id={`packNote_${ful.id}`} name="notes" placeholder="cth: Disertai es pendingin" />
                            </Field>
                          </div>

                          <button type="submit" className="w-full py-2.5 px-4 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700 transition">
                            Selesaikan Pengepakan (Mark as Packed)
                          </button>
                        </form>
                      </ModalDialogTrigger>
                    )}
                  </div>
                </div>

                {/* Lines breakdown table */}
                <div className="rounded-lg border border-slate-200 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold">
                      <tr>
                        <th className="px-3 py-2">Item</th>
                        <th className="px-3 py-2">Grade Target</th>
                        <th className="px-3 py-2 text-right">Target (kg)</th>
                        <th className="px-3 py-2 text-right">Bruto (kg)</th>
                        <th className="px-3 py-2 text-right">Tara (kg)</th>
                        <th className="px-3 py-2 text-right">Neto / Picked (kg)</th>
                        <th className="px-3 py-2 text-right">Sisa Backorder</th>
                        <th className="px-3 py-2 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {ful.lines.map((l) => (
                        <tr key={l.id}>
                          <td className="px-3 py-2 font-medium text-slate-900">
                            {l.orderedProductName}
                            {l.isSubstitution && (
                              <span className="ml-2 text-amber-600 font-semibold">[Substitusi: Grade {l.actualGradeCode}]</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-slate-500">Grade {l.orderedGradeCode}</td>
                          <td className="px-3 py-2 text-right font-medium">{l.targetPickQtyBase}</td>
                          <td className="px-3 py-2 text-right text-slate-500">{l.grossWeightKg ?? "-"}</td>
                          <td className="px-3 py-2 text-right text-slate-500">{l.tareWeightKg ?? "-"}</td>
                          <td className="px-3 py-2 text-right font-semibold text-emerald-700">{l.pickedQtyBase}</td>
                          <td className="px-3 py-2 text-right text-slate-500">
                            {Number(l.remainingBackorderQtyBase) > 0 ? `${l.remainingBackorderQtyBase} kg` : "-"}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <Badge tone={statusToBadgeTone(l.backorderStatus)}>{l.backorderStatus}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Exceptions if any */}
                {ful.exceptions.length > 0 && (
                  <div className="p-3 rounded-lg border border-amber-200 bg-amber-50/50 space-y-2">
                    <div className="text-xs font-semibold text-amber-900 flex items-center justify-between">
                      <span>Kendala / Exceptions Terbuka ({ful.exceptions.length})</span>
                      <span className="text-[11px] text-amber-700">Periksa resolusi sebelum proses packing</span>
                    </div>
                    <div className="space-y-1">
                      {ful.exceptions.map((exc) => (
                        <div key={exc.id} className="flex flex-wrap items-center justify-between gap-2 text-xs py-1 border-b border-amber-100 last:border-0">
                          <div>
                            <span className="font-semibold text-amber-950">[{exc.exceptionType}]</span>{" "}
                            <span className="text-amber-900">{exc.description}</span>
                            <span className="ml-2 text-amber-700">({exc.reasonCode} • {exc.severity})</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge tone={statusToBadgeTone(exc.status)}>{exc.status}</Badge>
                            {canDecideApproval && exc.status === "open" && (
                              <ConfirmActionButton
                                action={resolveFulfillmentExceptionAction}
                                buttonLabel="Selesaikan"
                                confirmTitle="Selesaikan Exception"
                                confirmDescription={`Tandai exception '${exc.reasonCode}' sebagai selesai?`}
                                buttonVariant="secondary"
                                hiddenFields={{ exceptionId: exc.id, resolutionStatus: "resolved", resolutionNotes: "Diselesaikan oleh supervisor" }}
                              />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
