import { asc, eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { receiveAndPostGrnAction } from "@/app/(app)/actions";
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
import { formatDateTime } from "@/lib/datetime";
import { formatRupiah, MoneyDecimal } from "@/lib/money";
import { formatQty, parseQty } from "@/lib/quantity";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import {
  goodsReceiptLines,
  gradingResults,
  products,
  purchaseOrderLines,
  purchaseOrders,
  qualityInspections,
  warehouseLocations,
} from "@/server/db/schema";
import { listGoodsReceipts } from "@/server/modules/receiving";

export const dynamic = "force-dynamic";

export default async function PenerimaanPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "receiving.read")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const statusFilter = (params.status ?? "").trim().toLowerCase();

  const [grnList, eligiblePos, allPoLines, locations] = await Promise.all([
    listGoodsReceipts(db, actor),
    db
      .select()
      .from(purchaseOrders)
      .where(inArray(purchaseOrders.status, ["approved", "partially_received"]))
      .orderBy(asc(purchaseOrders.poNumber)),
    db
      .select({
        poLine: purchaseOrderLines,
        product: products,
      })
      .from(purchaseOrderLines)
      .innerJoin(products, eq(products.id, purchaseOrderLines.productId)),
    db
      .select()
      .from(warehouseLocations)
      .where(eq(warehouseLocations.isActive, true))
      .orderBy(asc(warehouseLocations.code)),
  ]);

  const receivingLocations = locations.filter((l) => l.zoneType === "receiving");
  const putawayLocations = locations.filter(
    (l) => l.zoneType === "cold_room" || l.zoneType === "ambient",
  );

  let totalNetReceivedKg = new MoneyDecimal(0);
  let totalAcceptedKg = new MoneyDecimal(0);
  let totalRejectedKg = new MoneyDecimal(0);

  const detailsByGrn = new Map<
    string,
    Array<{
      line: typeof goodsReceiptLines.$inferSelect;
      productName: string;
      baseUom: string;
      qcOutcome: string;
      gradesText: string;
    }>
  >();

  for (const { grn } of grnList) {
    const lines = await db
      .select({
        line: goodsReceiptLines,
        productName: products.name,
        baseUom: products.baseUomCode,
      })
      .from(goodsReceiptLines)
      .innerJoin(products, eq(products.id, goodsReceiptLines.productId))
      .where(eq(goodsReceiptLines.goodsReceiptId, grn.id))
      .orderBy(asc(goodsReceiptLines.lineNo));

    const enriched = [];
    for (const l of lines) {
      totalNetReceivedKg = totalNetReceivedKg.plus(parseQty(l.line.netWeightKg));
      totalAcceptedKg = totalAcceptedKg.plus(parseQty(l.line.acceptedQtyBase));
      totalRejectedKg = totalRejectedKg.plus(parseQty(l.line.rejectedQtyBase));

      const [qc] = await db
        .select()
        .from(qualityInspections)
        .where(eq(qualityInspections.goodsReceiptLineId, l.line.id))
        .limit(1);
      const grds = await db
        .select()
        .from(gradingResults)
        .where(eq(gradingResults.goodsReceiptLineId, l.line.id));
      const gradesText = grds
        .filter((g) => g.lineType === "accepted_grade")
        .map(
          (g) =>
            `Grade ${g.gradeCode}: ${formatQty(g.qtyBase, l.baseUom)} @ ${formatRupiah(g.allocatedUnitCost)}`,
        )
        .join(" • ");

      enriched.push({
        ...l,
        qcOutcome: qc?.outcome ?? "-",
        gradesText: gradesText || "-",
      });
    }
    detailsByGrn.set(grn.id, enriched);
  }

  const canReceive =
    hasPermission(actor, "receiving.write") && hasPermission(actor, "qc.inspect");

  const defaultPo = eligiblePos[0];
  const defaultPoLine = defaultPo
    ? allPoLines.find((pl) => pl.poLine.purchaseOrderId === defaultPo.id)
    : allPoLines[0];

  const filteredGrns = grnList.filter(({ grn, po, supplier }) => {
    const lines = detailsByGrn.get(grn.id) ?? [];
    const matchesQ =
      !q ||
      grn.grnNumber.toLowerCase().includes(q) ||
      po.poNumber.toLowerCase().includes(q) ||
      supplier.name.toLowerCase().includes(q) ||
      (grn.supplierDeliveryNoteNo ?? "").toLowerCase().includes(q) ||
      lines.some((l) => l.productName.toLowerCase().includes(q));
    const matchesStatus = !statusFilter || grn.status === statusFilter;
    return matchesQ && matchesStatus;
  });

  const yieldPct = totalNetReceivedKg.gt(0)
    ? totalAcceptedKg.div(totalNetReceivedKg).mul(100).toFixed(1)
    : "0.0";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Penerimaan Barang (GRN), Penimbangan, QC & Grading (A/B/C)"
        description="Catat berat bruto, tara kemasan, berat neto, inspeksi kualitas (QC), pemisahan Grade A/B/C, susut sortir, barang reject, serta alokasi HPP Relative Sales Value."
        actions={
          canReceive && eligiblePos.length > 0 && defaultPoLine ? (
            <ModalDialogTrigger
              triggerLabel="Catat & Posting GRN"
              triggerVariant="primary"
              triggerIcon="plus"
              title="Catat & Posting Penerimaan Barang (GRN + Timbang + QC + Grading)"
              subtitle="Jumlah Grade A + Grade B + Grade C + Susut Sortir + Reject wajib sama persis dengan Berat Neto (Bruto − Tara)."
              maxWidthClass="max-w-4xl"
            >
              <ActionForm
                action={receiveAndPostGrnAction}
                submitLabel="Proses Timbang, QC, Grading & Posting GRN"
              >
                <div className="grid gap-4 sm:grid-cols-4">
                  <Field label="Referensi PO Disetujui" htmlFor="grn-po" required>
                    <Select id="grn-po" name="purchaseOrderId" defaultValue={defaultPo?.id} required>
                      {eligiblePos.map((po) => (
                        <option key={po.id} value={po.id}>
                          {po.poNumber} ({po.status})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Baris PO & Produk" htmlFor="grn-poline" required>
                    <Select
                      id="grn-poline"
                      name="purchaseOrderLineId"
                      defaultValue={defaultPoLine.poLine.id}
                      required
                    >
                      {allPoLines.map(({ poLine, product }) => (
                        <option key={poLine.id} value={poLine.id}>
                          {product.name} — Pesanan{" "}
                          {formatQty(poLine.orderedQtyBase, product.baseUomCode)}
                        </option>
                      ))}
                    </Select>
                    <input type="hidden" name="productId" value={defaultPoLine.product.id} />
                  </Field>
                  <Field label="No. Surat Jalan Supplier" htmlFor="grn-sj" required>
                    <Input
                      id="grn-sj"
                      name="supplierDeliveryNoteNo"
                      placeholder="Contoh: SJ-PTN-0092"
                      required
                    />
                  </Field>
                  <Field label="Harga Beli Aktual / Kg (Rp)" htmlFor="grn-cost" required>
                    <Input
                      id="grn-cost"
                      name="actualUnitCostBase"
                      defaultValue={defaultPoLine.poLine.unitPriceBase}
                      required
                    />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-4">
                  <Field label="Zona Dermaga Terima" htmlFor="grn-rcvloc" required>
                    <Select id="grn-rcvloc" name="receivingLocationId" required>
                      {(receivingLocations.length > 0 ? receivingLocations : locations).map(
                        (loc) => (
                          <option key={loc.id} value={loc.id}>
                            {loc.code} — {loc.name}
                          </option>
                        ),
                      )}
                    </Select>
                  </Field>
                  <Field label="Lokasi Simpan (Putaway)" htmlFor="grn-putloc" required>
                    <Select id="grn-putloc" name="putawayLocationId" required>
                      {(putawayLocations.length > 0 ? putawayLocations : locations).map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.code} — {loc.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Berat Bruto Timbang (Kg)" htmlFor="grn-gross" required>
                    <Input id="grn-gross" name="grossWeightKg" defaultValue="105.000" required />
                  </Field>
                  <Field label="Berat Tara Kemasan (Kg)" htmlFor="grn-tare" required>
                    <Input
                      id="grn-tare"
                      name="measuredTareWeightKg"
                      defaultValue="5.000"
                      required
                    />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-6">
                  <Field label="Hasil Grade A (Kg)" htmlFor="grn-ga" required>
                    <Input id="grn-ga" name="gradeAQty" defaultValue="60.000" required />
                  </Field>
                  <Field label="Hasil Grade B (Kg)" htmlFor="grn-gb" required>
                    <Input id="grn-gb" name="gradeBQty" defaultValue="25.000" required />
                  </Field>
                  <Field label="Hasil Grade C (Kg)" htmlFor="grn-gc" required>
                    <Input id="grn-gc" name="gradeCQty" defaultValue="10.000" required />
                  </Field>
                  <Field label="Susut Sortir (Kg)" htmlFor="grn-trim" required>
                    <Input id="grn-trim" name="trimLossQty" defaultValue="2.000" required />
                  </Field>
                  <Field label="Reject Supplier (Kg)" htmlFor="grn-rej" required>
                    <Input id="grn-rej" name="rejectQty" defaultValue="3.000" required />
                  </Field>
                  <Field label="Biaya Angkut (Rp)" htmlFor="grn-freight" required>
                    <Input id="grn-freight" name="freightCost" defaultValue="0" required />
                  </Field>
                </div>
              </ActionForm>
            </ModalDialogTrigger>
          ) : null
        }
      />

      {/* KPI Strip */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="DOKUMEN GRN TERPOSTING"
          value={`${grnList.length} GRN`}
          icon="receiving"
          iconTone="fresh"
          badgeText={`${eligiblePos.length} PO Siap Terima`}
          badgeTone="info"
          caption="Penerimaan fisik tercatat di gudang"
        />
        <KpiCard
          label="TOTAL BERAT NETO MASUK"
          value={formatQty(totalNetReceivedKg.toFixed(3), "kg")}
          icon="scale"
          iconTone="info"
          badgeText="Bruto − Tara"
          badgeTone="neutral"
          caption="Berat bersih hasil timbangan aktual"
        />
        <KpiCard
          label="RENDEMEN LOLOS QC (YIELD)"
          value={`${yieldPct}%`}
          icon="check"
          iconTone="fresh"
          badgeText={formatQty(totalAcceptedKg.toFixed(3), "kg")}
          badgeTone="success"
          caption="Total Grade A + Grade B + Grade C masuk stok"
        />
        <KpiCard
          label="BARANG REJECT SUPPLIER"
          value={formatQty(totalRejectedKg.toFixed(3), "kg")}
          icon="alert"
          iconTone={totalRejectedKg.gt(0) ? "warning" : "navy"}
          badgeText="Tidak Masuk HPP"
          badgeTone="warning"
          caption="Dikeluarkan dari tagihan/stok layak jual"
        />
      </div>

      {/* GRN History Table */}
      <Card noPadding>
        <CardHeader
          id="daftar-grn-heading"
          title="Riwayat Penerimaan Barang (GRN), QC & Hasil Grading"
          subtitle="Setiap GRN terposting membentuk batch stok FEFO per Grade dan jurnal persediaan (Akun 1140 vs 2115)"
          meta={<Badge tone="neutral">{filteredGrns.length} GRN</Badge>}
        />

        <TableSearchFilterBar
          placeholder="Cari nomor GRN, nomor PO, surat jalan, supplier, atau buah..."
          statusLabel="Semua Status GRN"
          statusOptions={[
            { value: "posted", label: "Posted (Terposting)" },
            { value: "pending_approval", label: "Pending Approval" },
            { value: "draft", label: "Draft" },
          ]}
          totalCount={grnList.length}
          filteredCount={filteredGrns.length}
        />

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="daftar-grn-heading"
          className="table-region"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3">No. GRN &amp; Waktu Terima</th>
                <th className="px-4 py-3">Referensi PO &amp; Supplier</th>
                <th className="px-4 py-3">Timbangan (Bruto / Tara / Neto)</th>
                <th className="px-4 py-3">Hasil Grading &amp; Alokasi Biaya (RSV)</th>
                <th className="px-5 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {filteredGrns.map(({ grn, po, supplier }) => {
                const lines = detailsByGrn.get(grn.id) ?? [];
                return (
                  <tr key={grn.id} className="align-top hover:bg-slate-50/80">
                    <th scope="row" className="px-5 py-3.5 font-semibold text-slate-900">
                      <div className="font-mono text-xs font-bold text-blue-600">
                        {grn.grnNumber}
                      </div>
                      <div className="mt-0.5 text-[11px] font-normal text-slate-500">
                        SJ: {grn.supplierDeliveryNoteNo} • {formatDateTime(grn.receivedAt)}
                      </div>
                    </th>
                    <td className="px-4 py-3.5">
                      <div className="font-mono font-bold text-emerald-700">{po.poNumber}</div>
                      <div className="mt-0.5 font-semibold text-slate-900">{supplier.name}</div>
                    </td>
                    <td className="tabular-nums px-4 py-3.5">
                      {lines.map((l) => (
                        <div key={l.line.id} className="text-slate-700">
                          <span className="font-bold text-slate-900">{l.productName}:</span> Bruto{" "}
                          {formatQty(l.line.grossWeightKg, l.baseUom)} − Tara{" "}
                          {formatQty(l.line.tareWeightKg, l.baseUom)} ={" "}
                          <span className="font-bold text-blue-700">
                            Neto {formatQty(l.line.netWeightKg, l.baseUom)}
                          </span>
                        </div>
                      ))}
                    </td>
                    <td className="tabular-nums px-4 py-3.5">
                      {lines.map((l) => (
                        <div key={l.line.id} className="space-y-1 text-slate-700">
                          <div>
                            Lolos QC:{" "}
                            <span className="font-bold text-emerald-700">
                              {formatQty(l.line.acceptedQtyBase, l.baseUom)}
                            </span>{" "}
                            • Trim: {formatQty(l.line.trimLossQtyBase, l.baseUom)} • Reject:{" "}
                            <span className="font-bold text-red-700">
                              {formatQty(l.line.rejectedQtyBase, l.baseUom)}
                            </span>{" "}
                            • Nilai Lot:{" "}
                            <span className="font-bold text-slate-900">
                              {formatRupiah(l.line.totalLineCost)}
                            </span>
                          </div>
                          <div className="font-mono text-[11px] text-slate-500">{l.gradesText}</div>
                        </div>
                      ))}
                    </td>
                    <td className="px-5 py-3.5">
                      <Badge tone={statusToBadgeTone(grn.status)} dot>
                        {grn.status.toUpperCase()}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
              {filteredGrns.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      icon="receiving"
                      title="Belum Ada Penerimaan Barang (GRN)"
                      description="Tidak ada dokumen GRN yang sesuai dengan pencarian atau filter status."
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
