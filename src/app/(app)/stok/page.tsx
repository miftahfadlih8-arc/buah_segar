import { redirect } from "next/navigation";
import {
  createSpoilageOrAdjustmentAction,
  postStockAdjustmentAction,
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
import { formatDate, formatDateTime } from "@/lib/datetime";
import { formatRupiah, MoneyDecimal, toDbAmount } from "@/lib/money";
import { formatQty, parseQty, toDbQty } from "@/lib/quantity";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import {
  listBatchesWithBalances,
  listInventoryMovements,
  listStockAdjustments,
} from "@/server/modules/inventory/ledger";

export const dynamic = "force-dynamic";

export default async function StokPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "inventory.read")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const statusFilter = (params.status ?? "").trim().toLowerCase();

  const [balances, movements, adjustments] = await Promise.all([
    listBatchesWithBalances(db, actor),
    listInventoryMovements(db, actor, { limit: 40 }),
    listStockAdjustments(db, actor),
  ]);

  const canAdjust = hasPermission(actor, "inventory.adjust");
  const canApprove = hasPermission(actor, "inventory.approve");

  const activeBalances = balances.filter(
    (b) => parseQty(b.balance.qtyBase).gt(0) && b.balance.stockStatus === "available",
  );
  const defaultBalance =
    activeBalances[0] ?? balances.find((b) => parseQty(b.balance.qtyBase).gt(0));

  const uniqueLocations = Array.from(
    new Map(balances.map((b) => [b.location.id, b.location])).values(),
  );

  const filteredBalances = balances.filter(({ balance, batch, product, grade, location }) => {
    const matchesQ =
      !q ||
      batch.batchCode.toLowerCase().includes(q) ||
      product.name.toLowerCase().includes(q) ||
      product.sku.toLowerCase().includes(q) ||
      grade.code.toLowerCase().includes(q) ||
      location.code.toLowerCase().includes(q) ||
      batch.originRegion.toLowerCase().includes(q);
    const matchesStatus = !statusFilter || balance.stockStatus === statusFilter;
    return matchesQ && matchesStatus;
  });

  const availableQty = balances
    .filter((b) => b.balance.stockStatus === "available")
    .reduce((acc, b) => acc.plus(parseQty(b.balance.qtyBase)), new MoneyDecimal(0));
  const reservedQty = balances
    .filter((b) => b.balance.stockStatus === "reserved")
    .reduce((acc, b) => acc.plus(parseQty(b.balance.qtyBase)), new MoneyDecimal(0));
  const totalInventoryCost = balances.reduce(
    (acc, b) => acc.plus(new MoneyDecimal(b.balance.totalCost)),
    new MoneyDecimal(0),
  );
  const pendingAdjustmentsCount = adjustments.filter(
    (a) => a.status === "pending_approval",
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Persediaan Batch (FEFO), Ledger Mutasi Stok & Susut"
        description="Urutan batch diprioritaskan berdasarkan FEFO (First Expired, First Out). Seluruh mutasi persediaan bersifat append-only (immutable) setelah diposting."
        actions={
          canAdjust && defaultBalance ? (
            <ModalDialogTrigger
              triggerLabel="Catat Susut / Penyesuaian"
              triggerVariant="primary"
              triggerIcon="plus"
              title="Catat Susut (Spoilage), Kerusakan, atau Penyesuaian Stok"
              subtitle="Setiap pengurangan atau koreksi stok wajib mencantumkan kode alasan (reason code) untuk audit trail dan jurnal GL."
              maxWidthClass="max-w-2xl"
            >
              <ActionForm
                action={createSpoilageOrAdjustmentAction}
                submitLabel="Simpan Dokumen Susut / Penyesuaian"
              >
                <input
                  type="hidden"
                  name="warehouseId"
                  value={defaultBalance.balance.warehouseId}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Pilih Batch Persediaan" htmlFor="adj-batch" required>
                    <Select
                      id="adj-batch"
                      name="batchId"
                      defaultValue={defaultBalance.batch.id}
                      required
                    >
                      {(activeBalances.length > 0 ? activeBalances : balances).map((b) => (
                        <option key={b.balance.id} value={b.batch.id}>
                          {b.batch.batchCode} ({b.product.name} Grade {b.grade.code}) — Saldo:{" "}
                          {formatQty(b.balance.qtyBase, b.product.baseUomCode)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Lokasi Penyimpanan" htmlFor="adj-loc" required>
                    <Select
                      id="adj-loc"
                      name="locationId"
                      defaultValue={defaultBalance.location.id}
                      required
                    >
                      {uniqueLocations.map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.code} — {loc.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Kategori Penyesuaian" htmlFor="adj-cat" required>
                    <Select id="adj-cat" name="adjustmentCategory" defaultValue="spoilage">
                      <option value="spoilage">Spoilage (Buah Busuk / Lewat Umur)</option>
                      <option value="shrinkage">Shrinkage (Susut Berat Alami)</option>
                      <option value="damage">Damage (Rusak Penanganan Gudang)</option>
                      <option value="manual_adjustment">Koreksi Penyesuaian Stok</option>
                    </Select>
                  </Field>
                  <Field label="Kode Alasan (Reason Code)" htmlFor="adj-reason" required>
                    <Input id="adj-reason" name="reasonCode" defaultValue="BUSUK_SIMPAN" required />
                  </Field>
                  <Field
                    label="Delta Kuantitas (Negatif = Keluar)"
                    htmlFor="adj-qty"
                    required
                  >
                    <Input
                      id="adj-qty"
                      name="qtyDeltaBase"
                      defaultValue="-2.000"
                      required
                      inputMode="decimal"
                    />
                  </Field>
                </div>

                <Field label="Penjelasan & Bukti Pemeriksaan" htmlFor="adj-notes" required>
                  <Input
                    id="adj-notes"
                    name="notes"
                    placeholder="Contoh: Ditemukan 2 kg mangga busuk saat inspeksi pagi di Cold Room..."
                    required
                  />
                </Field>

                {canApprove ? (
                  <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-800">
                    <input type="checkbox" name="autoPost" defaultChecked className="h-4 w-4" />
                    Langsung Setujui &amp; Posting ke Ledger Persediaan + Jurnal Umum (GL)
                  </label>
                ) : null}
              </ActionForm>
            </ModalDialogTrigger>
          ) : null
        }
      />

      {/* KPI Strip */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="BATCH AKTIF (FEFO)"
          value={`${activeBalances.length} Batch`}
          icon="inventory"
          iconTone="navy"
          badgeText={`${balances.length} Baris Saldo`}
          badgeTone="info"
          caption="Diurutkan otomatis berdasarkan Best Before Date"
        />
        <KpiCard
          label="STOK TERSEDIA (AVAILABLE)"
          value={`${formatQty(toDbQty(availableQty), "kg")}`}
          icon="check"
          iconTone="fresh"
          badgeText={`Reserved: ${formatQty(toDbQty(reservedQty), "kg")}`}
          badgeTone={reservedQty.gt(0) ? "info" : "success"}
          caption="Siap dialokasikan untuk Sales Order baru"
        />
        <KpiCard
          label="TOTAL VALUASI PERSEDIAAN"
          value={formatRupiah(toDbAmount(totalInventoryCost))}
          icon="ledger"
          iconTone="info"
          badgeText="Lot Actual Cost"
          badgeTone="neutral"
          caption="Sinkron dengan akun Persediaan Buah Segar (1140)"
        />
        <KpiCard
          label="DOKUMEN SUSUT & KOREKSI"
          value={`${adjustments.length} Dokumen`}
          icon="alert"
          iconTone={pendingAdjustmentsCount > 0 ? "warning" : "fresh"}
          badgeText={
            pendingAdjustmentsCount > 0
              ? `${pendingAdjustmentsCount} Menunggu Approval`
              : "Terkendali"
          }
          badgeTone={pendingAdjustmentsCount > 0 ? "warning" : "success"}
          caption="Spoilage, shrinkage, dan koreksi stok fisik"
        />
      </div>

      {/* FEFO Batch Balances Table */}
      <Card noPadding>
        <CardHeader
          id="saldo-batch-heading"
          title="Saldo Stok per Batch & Lokasi — Urutan Prioritas FEFO"
          subtitle="Batch dengan umur simpan terdekat ditempatkan pada urutan teratas untuk alokasi penjualan"
          meta={<Badge tone="neutral">{filteredBalances.length} Saldo Batch</Badge>}
        />

        <TableSearchFilterBar
          placeholder="Cari kode batch, nama buah, SKU, grade, kode lokasi, atau daerah asal..."
          statusLabel="Semua Status Stok"
          statusOptions={[
            { value: "available", label: "Available (Tersedia)" },
            { value: "reserved", label: "Reserved (Ter-reservasi SO)" },
            { value: "quarantine", label: "Quarantine (Karantina)" },
          ]}
          totalCount={balances.length}
          filteredCount={filteredBalances.length}
        />

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="saldo-batch-heading"
          className="table-region"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3">Prioritas FEFO / Batch</th>
                <th className="px-4 py-3">Produk &amp; Grade</th>
                <th className="px-4 py-3">Lokasi &amp; Status</th>
                <th className="px-4 py-3">Batas Baik Sebelum (FEFO)</th>
                <th className="px-4 py-3 text-right">Saldo Kuantitas</th>
                <th className="px-4 py-3 text-right">HPP / Satuan</th>
                <th className="px-5 py-3 text-right">Total Nilai Persediaan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {filteredBalances.map(({ balance, batch, product, grade, location }, idx) => (
                <tr key={balance.id} className="hover:bg-slate-50/80">
                  <th scope="row" className="px-5 py-3.5 font-semibold text-slate-900">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-900 text-[10px] font-bold text-white">
                        {idx + 1}
                      </span>
                      <span className="font-mono text-xs font-bold text-blue-600">
                        {batch.batchCode}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] font-normal text-slate-500">
                      Asal: {batch.originRegion} • Batch: {batch.status}
                    </div>
                  </th>
                  <td className="px-4 py-3.5">
                    <div className="font-semibold text-slate-900">{product.name}</div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      Grade {grade.code} ({grade.name})
                    </div>
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="font-mono font-semibold text-slate-800">{location.code}</div>
                    <div className="mt-1">
                      <Badge tone={statusToBadgeTone(balance.stockStatus)} dot>
                        {balance.stockStatus.toUpperCase()}
                      </Badge>
                    </div>
                  </td>
                  <td className="tabular-nums px-4 py-3.5 font-semibold text-amber-800">
                    {formatDate(batch.bestBeforeDate)}
                  </td>
                  <td className="tabular-nums px-4 py-3.5 text-right font-bold text-emerald-700">
                    {formatQty(balance.qtyBase, product.baseUomCode)}
                  </td>
                  <td className="tabular-nums px-4 py-3.5 text-right text-slate-700">
                    {formatRupiah(balance.unitCostBase)}
                  </td>
                  <td className="tabular-nums px-5 py-3.5 text-right font-bold text-slate-900">
                    {formatRupiah(balance.totalCost)}
                  </td>
                </tr>
              ))}
              {filteredBalances.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      icon="inventory"
                      title="Tidak Ada Saldo Batch"
                      description="Tidak ditemukan saldo batch persediaan yang cocok dengan filter pencarian."
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Spoilage & Adjustments Table */}
      <Card noPadding>
        <CardHeader
          id="dokumen-susut-heading"
          title="Dokumen Susut (Spoilage) & Penyesuaian Stok"
          subtitle="Riwayat pencatatan susut alami, buah busuk, kerusakan penanganan, dan koreksi opname"
          meta={<Badge tone="neutral">{adjustments.length} Dokumen</Badge>}
        />

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="dokumen-susut-heading"
          className="table-region"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3">No. Dokumen</th>
                <th className="px-4 py-3">Kategori &amp; Kode Alasan</th>
                <th className="px-4 py-3">Catatan Pemeriksaan</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-5 py-3 text-right">Tindakan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {adjustments.map((adj) => (
                <tr key={adj.id} className="hover:bg-slate-50/80">
                  <th
                    scope="row"
                    className="px-5 py-3.5 font-mono text-xs font-bold text-blue-600"
                  >
                    {adj.adjustmentNo}
                  </th>
                  <td className="px-4 py-3.5">
                    <span className="font-semibold text-slate-900">
                      {adj.adjustmentCategory.toUpperCase()}
                    </span>{" "}
                    •{" "}
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
                      {adj.reasonCode}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-slate-700">{adj.notes}</td>
                  <td className="px-4 py-3.5">
                    <Badge tone={statusToBadgeTone(adj.status)} dot>
                      {adj.status.toUpperCase()}
                    </Badge>
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    {canApprove && adj.status === "pending_approval" ? (
                      <ConfirmActionButton
                        action={postStockAdjustmentAction}
                        hiddenFields={{ stockAdjustmentId: adj.id }}
                        buttonLabel="Setujui & Posting"
                        buttonVariant="fresh"
                        confirmTitle={`Setujui & Posting Dokumen ${adj.adjustmentNo}?`}
                        confirmDescription="Persetujuan ini akan memotong/menyesuaikan saldo batch secara permanen dan memposting jurnal beban susut ke Buku Besar (GL)."
                        confirmButtonLabel="Ya, Setujui & Posting"
                      />
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {adjustments.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      icon="check"
                      title="Belum Ada Dokumen Susut"
                      description="Belum ada dokumen spoilage atau penyesuaian stok yang dicatat."
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Immutable Inventory Movements Ledger */}
      <Card noPadding>
        <CardHeader
          id="ledger-mutasi-heading"
          title="Buku Besar Mutasi Stok Append-Only (Immutable Inventory Ledger)"
          subtitle="40 mutasi persediaan terbaru dari penerimaan GRN, reservasi SO, dan penyesuaian stok"
          meta={<Badge tone="info">{movements.length} Mutasi</Badge>}
        />

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="ledger-mutasi-heading"
          className="table-region"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3">No. Mutasi &amp; Waktu</th>
                <th className="px-4 py-3">Jenis Mutasi &amp; Dokumen Sumber</th>
                <th className="px-4 py-3">Produk, Grade &amp; Batch</th>
                <th className="px-4 py-3">Lokasi &amp; Status</th>
                <th className="px-4 py-3 text-right">Delta Kuantitas</th>
                <th className="px-5 py-3 text-right">Delta Nilai Biaya</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {movements.map(({ movement, product, grade, batch, location }) => {
                const isPositive = parseQty(movement.qtyDeltaBase).gte(0);
                return (
                  <tr key={movement.id} className="hover:bg-slate-50/80">
                    <th scope="row" className="px-5 py-3.5 font-semibold text-slate-900">
                      <div className="font-mono text-xs font-bold text-slate-900">
                        {movement.movementNo}
                      </div>
                      <div className="mt-0.5 text-[11px] font-normal text-slate-500">
                        {formatDateTime(movement.createdAt)}
                      </div>
                    </th>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">{movement.movementType}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                        {movement.sourceDocType}: {movement.sourceDocId.slice(0, 14)}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">
                        {product.name} (Grade {grade.code})
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-blue-600">
                        {batch.batchCode}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="font-mono font-semibold text-slate-800">
                        {location.code}
                      </span>{" "}
                      <span className="text-[11px] text-slate-500">({movement.stockStatus})</span>
                    </td>
                    <td
                      className={`tabular-nums px-4 py-3.5 text-right font-bold ${
                        isPositive ? "text-emerald-700" : "text-red-700"
                      }`}
                    >
                      {isPositive ? "+" : ""}
                      {formatQty(movement.qtyDeltaBase, product.baseUomCode)}
                    </td>
                    <td className="tabular-nums px-5 py-3.5 text-right font-semibold text-slate-900">
                      {formatRupiah(movement.costDelta)}
                    </td>
                  </tr>
                );
              })}
              {movements.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState
                      icon="ledger"
                      title="Belum Ada Mutasi Stok"
                      description="Mutasi stok akan tercatat otomatis saat GRN diposting atau penyesuaian disetujui."
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
