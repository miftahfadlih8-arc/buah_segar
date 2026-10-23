import { redirect } from "next/navigation";
import {
  createDeliveryOrderAction,
  dispatchDeliveryOrderAction,
  markDeliveryOrderReadyAction,
  recordProofOfDeliveryAction,
  updateDeliveryOrderStatusAction,
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
  listDeliveryClaims,
  listDeliveryOrders,
  listEligibleDrivers,
  listSalesFulfillments,
} from "@/server/modules/fulfillment";

export const dynamic = "force-dynamic";

export default async function PengirimanPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "delivery.execute")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const statusFilter = (params.status ?? "").trim().toLowerCase();

  const [deliveryOrders, deliveryClaims, fulfillments, drivers] = await Promise.all([
    listDeliveryOrders(db, actor),
    listDeliveryClaims(db, actor),
    listSalesFulfillments(db, actor),
    listEligibleDrivers(db, actor),
  ]);

  const canExecuteDelivery = hasPermission(actor, "delivery.execute");

  // Fulfillments that are packed and ready for delivery order
  const packedFulfillments = fulfillments.filter((f) => f.status === "packed");

  const filteredOrders = deliveryOrders.filter((d) => {
    const matchesQ =
      !q ||
      d.doNumber.toLowerCase().includes(q) ||
      d.soNumber.toLowerCase().includes(q) ||
      d.customerName.toLowerCase().includes(q) ||
      (d.driverName ?? "").toLowerCase().includes(q) ||
      (d.vehiclePlateNo ?? "").toLowerCase().includes(q);
    const matchesStatus = !statusFilter || d.status === statusFilter;
    return matchesQ && matchesStatus;
  });

  const readyCount = deliveryOrders.filter((d) => d.status === "ready").length;
  const transitCount = deliveryOrders.filter(
    (d) => d.status === "dispatched" || d.status === "in_transit",
  ).length;
  const deliveredCount = deliveryOrders.filter(
    (d) => d.status === "delivered" || d.status === "partially_delivered",
  ).length;
  const openClaimsCount = deliveryClaims.filter((c) => c.status === "open").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pengiriman, Surat Jalan & Bukti Serah Terima (POD)"
        description="Manajemen Surat Jalan Resmi Bekasi, Penugasan Armada, Dispatch Sopir, Validasi POD & Klaim Pengiriman"
        eyebrow={
          <Badge tone={canExecuteDelivery ? "success" : "neutral"}>
            {canExecuteDelivery ? "Akses Operasional Armada / Sopir" : "Mode Pratinjau (Read-Only)"}
          </Badge>
        }
      />

      {/* Honest Capability Notice */}
      <div className="p-4 rounded-xl border border-sky-200 bg-sky-50/70 text-xs text-sky-900 space-y-1">
        <div className="font-semibold text-sky-950 flex items-center gap-2">
          <span>Informasi Kapabilitas Operasional Pengiriman</span>
        </div>
        <p>
          Sistem mencatat Surat Jalan (DO), penugasan kendaraan/sopir, mutasi status pengiriman (draft → ready → dispatched → in_transit → delivered), serta Bukti Serah Terima (POD) dengan audit penerima dan klaim selisih secara akurat. Pelacakan GPS real-time satelit dan unggah foto fisik belum terpasang; data penerimaan dicatat berdasarkan berita acara fisik serah terima.
        </p>
      </div>

      {/* KPI Section */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Siap Dispatch"
          value={String(readyCount)}
          icon="truck"
          caption="Surat Jalan siap diberangkatkan"
          iconTone={readyCount > 0 ? "fresh" : "info"}
        />
        <KpiCard
          label="Dalam Perjalanan"
          value={String(transitCount)}
          icon="truck"
          caption="Armada sedang menuju lokasi pelanggan"
          iconTone={transitCount > 0 ? "warning" : "info"}
        />
        <KpiCard
          label="Selesai Dikirim"
          value={String(deliveredCount)}
          icon="check"
          caption="POD tercatat lengkap"
          iconTone="fresh"
        />
        <KpiCard
          label="Klaim Selisih Terbuka"
          value={String(openClaimsCount)}
          icon="alert"
          caption="Membutuhkan investigasi finance/ops"
          iconTone={openClaimsCount > 0 ? "danger" : "info"}
        />
      </div>

      {/* Packed Fulfillments Ready for Delivery Order */}
      {packedFulfillments.length > 0 && canExecuteDelivery && (
        <Card noPadding>
          <CardHeader
            title="Hasil Pengepakan Siap Dibuatkan Surat Jalan"
            subtitle="Pesanan telah selesai ditimbang dan dipak rapi di meja QC gudang. Buat Surat Jalan untuk menugaskan armada dan sopir."
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-surface-border bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">No. Fulfillment</th>
                  <th className="px-4 py-3">Pelanggan & Tujuan</th>
                  <th className="px-4 py-3">No. SO</th>
                  <th className="px-4 py-3 text-right">Total Berat Dipak</th>
                  <th className="px-4 py-3 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {packedFulfillments.map((ful) => (
                  <tr key={ful.id} className="hover:bg-slate-50/50">
                    <td className="px-4 py-3 font-semibold text-slate-900">{ful.fulfillmentNo}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{ful.customerName}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{ful.soNumber}</td>
                    <td className="px-4 py-3 text-right font-bold text-emerald-700">
                      {ful.totalPackedQtyBase} kg
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ModalDialogTrigger
                        triggerLabel="Terbitkan Surat Jalan"
                        title={`Terbitkan Surat Jalan untuk ${ful.fulfillmentNo}`}
                        subtitle="Tentukan sopir, plat nomor armada, dan catatan pengiriman untuk cetak dokumen resmi."
                        triggerVariant="primary"
                      >
                        <ActionForm action={createDeliveryOrderAction} submitLabel="Terbitkan Surat Jalan (DO)">
                          <input type="hidden" name="fulfillmentId" value={ful.id} />
                          <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-3">
                              <Field label="Pilih Sopir Armada" htmlFor={`drv_${ful.id}`}>
                                <Select id={`drv_${ful.id}`} name="driverUserId">
                                  <option value="">Pilih Sopir (Opsional saat draft)</option>
                                  {drivers.map((drv) => (
                                    <option key={drv.id} value={drv.id}>
                                      {drv.name} ({drv.email})
                                    </option>
                                  ))}
                                </Select>
                              </Field>
                              <Field label="Nomor Polisi Kendaraan" htmlFor={`plate_${ful.id}`}>
                                <Input id={`plate_${ful.id}`} name="vehiclePlateNo" placeholder="cth: B 9123 KAA" />
                              </Field>
                            </div>
                            <Field label="Tipe Kendaraan" htmlFor={`vType_${ful.id}`}>
                              <Input id={`vType_${ful.id}`} name="vehicleType" placeholder="cth: Blind Van Pendingin / Pickup Terpal" />
                            </Field>
                            <Field label="Instruksi Pengiriman" htmlFor={`doNote_${ful.id}`}>
                              <Input id={`doNote_${ful.id}`} name="notes" placeholder="cth: Masuk lewat pintu loading dock selatan" />
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

      {/* Main Delivery Orders Table */}
      <Card noPadding>
        <CardHeader
          title="Daftar Surat Jalan (Delivery Orders)"
          subtitle="Pantau siklus keberangkatan armada, pembaruan status pengiriman, dan pencatatan serah terima fisik di lokasi pelanggan."
        />
        <div className="p-4 border-b border-slate-100">
          <TableSearchFilterBar
            placeholder="Cari no surat jalan, SO, sopir, plat kendaraan..."
            statusOptions={[
              { label: "Semua Status", value: "" },
              { label: "Draft", value: "draft" },
              { label: "Ready", value: "ready" },
              { label: "Dispatched", value: "dispatched" },
              { label: "In Transit", value: "in_transit" },
              { label: "Delivered", value: "delivered" },
              { label: "Partially Delivered", value: "partially_delivered" },
              { label: "Failed / Returned", value: "failed" },
            ]}
          />
        </div>

        {filteredOrders.length === 0 ? (
          <EmptyState
            title="Tidak ada Surat Jalan"
            description="Belum ada Surat Jalan yang sesuai dengan filter atau pencarian Anda."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-surface-border bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">No. Surat Jalan</th>
                  <th className="px-4 py-3">Pelanggan & Tujuan</th>
                  <th className="px-4 py-3">Sopir & Armada</th>
                  <th className="px-4 py-3 text-right">Total Berat</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredOrders.map((doDoc) => {
                  const totalWeightKg = doDoc.lines.reduce(
                    (acc, l) => acc + Number(l.shippedQtyBase),
                    0,
                  );
                  return (
                    <tr key={doDoc.id} className="hover:bg-slate-50/50">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-900">{doDoc.doNumber}</div>
                        <div className="text-xs text-slate-500">SO: {doDoc.soNumber}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900">{doDoc.customerName}</div>
                        <div className="text-xs text-slate-500 truncate max-w-xs">
                          {doDoc.shippingAddressSnapshot}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900">
                          {doDoc.driverName ?? "Belum ditugaskan"}
                        </div>
                        <div className="text-xs text-slate-500">
                          {doDoc.vehiclePlateNo
                            ? `${doDoc.vehiclePlateNo} • ${doDoc.vehicleType ?? ""}`
                            : "-"}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-slate-900">
                        {totalWeightKg.toFixed(3)} kg
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Badge tone={statusToBadgeTone(doDoc.status)}>{doDoc.status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-right space-x-2">
                        {/* Action: Mark Ready */}
                        {canExecuteDelivery && doDoc.status === "draft" && (
                          <ModalDialogTrigger
                            triggerLabel="Siapkan Armada"
                            title={`Siapkan Armada untuk ${doDoc.doNumber}`}
                            subtitle="Verifikasi sopir dan plat kendaraan sebelum Surat Jalan ditandai SIAP (Ready)."
                            triggerVariant="secondary"
                          >
                            <form action={markDeliveryOrderReadyAction} className="space-y-4">
                              <input type="hidden" name="deliveryOrderId" value={doDoc.id} />
                              <Field label="Pilih Sopir" htmlFor={`rDrv_${doDoc.id}`}>
                                <Select
                                  id={`rDrv_${doDoc.id}`}
                                  name="driverUserId"
                                  defaultValue={doDoc.driverUserId ?? ""}
                                  required
                                >
                                  <option value="">Pilih Sopir</option>
                                  {drivers.map((drv) => (
                                    <option key={drv.id} value={drv.id}>
                                      {drv.name}
                                    </option>
                                  ))}
                                </Select>
                              </Field>
                              <Field label="Nomor Polisi Armada" htmlFor={`rPlate_${doDoc.id}`}>
                                <Input
                                  id={`rPlate_${doDoc.id}`}
                                  name="vehiclePlateNo"
                                  defaultValue={doDoc.vehiclePlateNo ?? ""}
                                  placeholder="cth: B 9123 KAA"
                                  required
                                />
                              </Field>
                              <Field label="Tipe Kendaraan" htmlFor={`rVType_${doDoc.id}`}>
                                <Input
                                  id={`rVType_${doDoc.id}`}
                                  name="vehicleType"
                                  defaultValue={doDoc.vehicleType ?? ""}
                                  placeholder="cth: Blind Van Pendingin"
                                />
                              </Field>
                              <button
                                type="submit"
                                className="w-full py-2.5 px-4 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700 transition"
                              >
                                Tandai Siap Berangkat (Ready)
                              </button>
                            </form>
                          </ModalDialogTrigger>
                        )}

                        {/* Action: Dispatch */}
                        {canExecuteDelivery && doDoc.status === "ready" && (
                          <ConfirmActionButton
                            action={dispatchDeliveryOrderAction}
                            buttonLabel="Berangkatkan (Dispatch)"
                            confirmTitle="Konfirmasi Keberangkatan"
                            confirmDescription={`Konfirmasi keberangkatan armada ${
                              doDoc.vehiclePlateNo ?? ""
                            } untuk Surat Jalan ${doDoc.doNumber}?`}
                            buttonVariant="primary"
                            hiddenFields={{ deliveryOrderId: doDoc.id }}
                          />
                        )}

                        {/* Action: In-Transit update */}
                        {canExecuteDelivery && doDoc.status === "dispatched" && (
                          <ConfirmActionButton
                            action={updateDeliveryOrderStatusAction}
                            buttonLabel="Tandai In-Transit"
                            confirmTitle="Update In-Transit"
                            confirmDescription={`Update status ${doDoc.doNumber} menjadi Dalam Perjalanan (in_transit)?`}
                            buttonVariant="secondary"
                            hiddenFields={{ deliveryOrderId: doDoc.id, targetStatus: "in_transit" }}
                          />
                        )}

                        {/* Action: Record POD */}
                        {canExecuteDelivery &&
                          (doDoc.status === "dispatched" || doDoc.status === "in_transit") && (
                            <ModalDialogTrigger
                              triggerLabel="Catat Bukti Terima (POD)"
                              title={`Bukti Serah Terima (POD) — ${doDoc.doNumber}`}
                              subtitle="Catat nama dan kontak penerima serta konfirmasi kuantitas buah yang diterima dalam kondisi baik."
                              triggerVariant="primary"
                            >
                              <ActionForm
                                action={recordProofOfDeliveryAction}
                                submitLabel="Simpan Bukti Serah Terima (POD)"
                              >
                                <input type="hidden" name="deliveryOrderId" value={doDoc.id} />
                                {doDoc.lines[0] && (
                                  <input
                                    type="hidden"
                                    name="deliveryOrderLineId"
                                    value={doDoc.lines[0].id}
                                  />
                                )}
                                <div className="space-y-4">
                                  <Field
                                    label="Nama Penerima di Lokasi"
                                    htmlFor={`recName_${doDoc.id}`}
                                    hint="Nama PIC toko, koki hotel, atau manajer pembelian"
                                  >
                                    <Input
                                      id={`recName_${doDoc.id}`}
                                      name="recipientName"
                                      placeholder="cth: H. Rahmat / Pak Budi"
                                      required
                                    />
                                  </Field>
                                  <div className="grid grid-cols-2 gap-3">
                                    <Field
                                      label="Jabatan / Peran Penerima"
                                      htmlFor={`recRole_${doDoc.id}`}
                                    >
                                      <Input
                                        id={`recRole_${doDoc.id}`}
                                        name="recipientRoleOrId"
                                        placeholder="cth: Pemilik Toko / QC Buah"
                                      />
                                    </Field>
                                    <Field
                                      label="No. Telepon / WA Penerima"
                                      htmlFor={`recPhone_${doDoc.id}`}
                                    >
                                      <Input
                                        id={`recPhone_${doDoc.id}`}
                                        name="recipientPhone"
                                        placeholder="cth: 081299887766"
                                      />
                                    </Field>
                                  </div>

                                  <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 space-y-3">
                                    <div className="text-xs font-semibold text-slate-900">
                                      Kuantitas Timbang Terima Fisik
                                    </div>
                                    <Field
                                      label="Jumlah Diterima Baik (kg)"
                                      htmlFor={`delQty_${doDoc.id}`}
                                      hint={`Total kirim: ${totalWeightKg.toFixed(3)} kg`}
                                    >
                                      <Input
                                        id={`delQty_${doDoc.id}`}
                                        name="deliveredQtyBase"
                                        type="number"
                                        step="0.001"
                                        defaultValue={totalWeightKg.toFixed(3)}
                                        required
                                      />
                                    </Field>

                                    <div className="grid grid-cols-3 gap-2">
                                      <Field label="Susut (kg)" htmlFor={`short_${doDoc.id}`}>
                                        <Input
                                          id={`short_${doDoc.id}`}
                                          name="shortageQtyBase"
                                          type="number"
                                          step="0.001"
                                          defaultValue="0"
                                        />
                                      </Field>
                                      <Field label="Rusak (kg)" htmlFor={`dam_${doDoc.id}`}>
                                        <Input
                                          id={`dam_${doDoc.id}`}
                                          name="damagedQtyBase"
                                          type="number"
                                          step="0.001"
                                          defaultValue="0"
                                        />
                                      </Field>
                                      <Field label="Ditolak (kg)" htmlFor={`ref_${doDoc.id}`}>
                                        <Input
                                          id={`ref_${doDoc.id}`}
                                          name="refusedQtyBase"
                                          type="number"
                                          step="0.001"
                                          defaultValue="0"
                                        />
                                      </Field>
                                    </div>
                                    <Field
                                      label="Kode Alasan Selisih (Bila Ada)"
                                      htmlFor={`discReason_${doDoc.id}`}
                                    >
                                      <Input
                                        id={`discReason_${doDoc.id}`}
                                        name="discrepancyReasonCode"
                                        placeholder="cth: MEMAR_PERJALANAN / KURANG_TIMBANGAN"
                                      />
                                    </Field>
                                  </div>

                                  <Field
                                    label="Catatan Tambahan Serah Terima"
                                    htmlFor={`podNotes_${doDoc.id}`}
                                  >
                                    <Input
                                      id={`podNotes_${doDoc.id}`}
                                      name="deliveryNotes"
                                      placeholder="cth: Diterima langsung di gudang dingin toko"
                                    />
                                  </Field>
                                </div>
                              </ActionForm>
                            </ModalDialogTrigger>
                          )}

                        {/* Display POD Summary if delivered */}
                        {doDoc.pod && (
                          <span className="text-xs text-slate-500">
                            POD:{" "}
                            <span className="font-semibold text-emerald-700">
                              {doDoc.pod.podNumber}
                            </span>{" "}
                            ({doDoc.pod.recipientName})
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Delivery Claims Section */}
      {deliveryClaims.length > 0 && (
        <Card noPadding>
          <CardHeader
            title="Daftar Klaim & Selisih Pengiriman (Delivery Claims)"
            subtitle="Klaim tercatat otomatis bila penerimaan di lokasi pelanggan mengalami susut, kerusakan buah, atau penolakan."
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-surface-border bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">No. Klaim</th>
                  <th className="px-4 py-3">No. Surat Jalan</th>
                  <th className="px-4 py-3">Jenis Selisih</th>
                  <th className="px-4 py-3 text-right">Kuantitas Selisih</th>
                  <th className="px-4 py-3 text-right">Estimasi Nilai Klaim</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3">Keterangan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {deliveryClaims.map((claim) => (
                  <tr key={claim.id} className="hover:bg-slate-50/50">
                    <td className="px-4 py-3 font-semibold text-slate-900">{claim.claimNo}</td>
                    <td className="px-4 py-3 text-slate-500">{claim.doNumber}</td>
                    <td className="px-4 py-3">
                      <Badge tone={claim.claimType === "damaged_in_transit" ? "danger" : "warning"}>{claim.claimType}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-red-600">
                      {claim.discrepancyQtyBase} kg
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-900">
                      Rp {Number(claim.estimatedClaimValue).toLocaleString("id-ID")}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge tone={statusToBadgeTone(claim.status)}>{claim.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 max-w-xs truncate">
                      {claim.notes ?? claim.reasonCode ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
