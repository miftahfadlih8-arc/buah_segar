import { redirect } from "next/navigation";
import {
  createWarehouseAction,
  createWarehouseLocationAction,
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
  Textarea,
   type BadgeTone,
} from "@/components/ui/primitives";
import { TableSearchFilterBar } from "@/components/ui/table-toolbar";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission, isSuperAdmin } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import {
  listBranches,
  listWarehouseLocations,
  listWarehouses,
} from "@/server/modules/master/warehouses";

const ZONE_LABELS: Record<string, { label: string; tone: BadgeTone }> = {
  receiving: { label: "Penerimaan & Timbang", tone: "info" },
  quarantine: { label: "Karantina & QC", tone: "warning" },
  cold_room: { label: "Cold Storage (Pendingin)", tone: "info" },
  ambient: { label: "Ruang Sejuk / Tropis", tone: "success" },
  dispatch: { label: "Picking, Packing & Muat", tone: "navy" },
  reject: { label: "Barang Reject / Klaim", tone: "danger" },
};

export default async function GudangPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "warehouse.write") && !isSuperAdmin(actor)) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const zoneFilter = (params.status ?? "").trim().toLowerCase();

  const [branchList, warehouseList, locationList] = await Promise.all([
    listBranches(db, actor),
    listWarehouses(db, actor),
    listWarehouseLocations(db, actor),
  ]);

  const canWrite = hasPermission(actor, "warehouse.write");

  const filteredLocations = locationList.filter((l) => {
    const matchesQ =
      !q ||
      l.code.toLowerCase().includes(q) ||
      l.name.toLowerCase().includes(q) ||
      l.zoneType.toLowerCase().includes(q);
    const matchesZone = !zoneFilter || l.zoneType === zoneFilter;
    return matchesQ && matchesZone;
  });

  const coldRoomsCount = locationList.filter((l) => l.zoneType === "cold_room").length;
  const quarantineCount = locationList.filter((l) => l.zoneType === "quarantine").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cabang, Gudang Distribusi & Zona Penyimpanan"
        description="Pemisahan fisik area Penerimaan, Karantina QC, Cold Storage, Ruang Sejuk Tropis, Dispatch, dan Barang Reject."
        actions={
          canWrite ? (
            <>
              <ModalDialogTrigger
                triggerLabel="Tambah Lokasi / Zona"
                triggerVariant="secondary"
                triggerIcon="warehouse"
                title="Tambah Lokasi / Zona Penyimpanan Gudang"
                subtitle="Tentukan jenis zona dan rentang suhu target untuk pemantauan rantai dingin."
              >
                <ActionForm
                  action={createWarehouseLocationAction}
                  submitLabel="Simpan Lokasi Gudang"
                >
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Gudang" htmlFor="loc-wh" required>
                      <Select id="loc-wh" name="warehouseId">
                        {warehouseList.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.code} — {w.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Jenis Zona" htmlFor="loc-zone" required>
                      <Select id="loc-zone" name="zoneType" defaultValue="cold_room">
                        <option value="receiving">Penerimaan &amp; Timbang</option>
                        <option value="quarantine">Karantina &amp; Inspeksi QC</option>
                        <option value="cold_room">Cold Storage (Pendingin)</option>
                        <option value="ambient">Ruang Sejuk / Tropis</option>
                        <option value="dispatch">Picking, Packing &amp; Muat</option>
                        <option value="reject">Barang Reject / Klaim</option>
                      </Select>
                    </Field>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Kode Lokasi" htmlFor="loc-code" required>
                      <Input
                        id="loc-code"
                        name="code"
                        type="text"
                        required
                        placeholder="COLD-02"
                      />
                    </Field>
                    <Field label="Nama Lokasi" htmlFor="loc-name" required>
                      <Input
                        id="loc-name"
                        name="name"
                        type="text"
                        required
                        placeholder="Cold Room Berry & Anggur"
                      />
                    </Field>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Suhu Minimum (°C)" htmlFor="loc-tmin">
                      <Input
                        id="loc-tmin"
                        name="temperatureMinC"
                        type="text"
                        inputMode="decimal"
                        placeholder="1.0"
                      />
                    </Field>
                    <Field label="Suhu Maksimum (°C)" htmlFor="loc-tmax">
                      <Input
                        id="loc-tmax"
                        name="temperatureMaxC"
                        type="text"
                        inputMode="decimal"
                        placeholder="4.0"
                      />
                    </Field>
                  </div>
                </ActionForm>
              </ModalDialogTrigger>

              <ModalDialogTrigger
                triggerLabel="Tambah Gudang Baru"
                triggerVariant="primary"
                triggerIcon="plus"
                title="Tambah Gudang Distribusi Baru"
                subtitle="Mendukung ekspansi multi-gudang di Bekasi, Cikarang, dan wilayah sekitarnya."
              >
                <ActionForm action={createWarehouseAction} submitLabel="Simpan Gudang">
                  <Field label="Cabang" htmlFor="wh-branch" required>
                    <Select id="wh-branch" name="branchId">
                      {branchList.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.code} — {b.name} ({b.city})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Kode Gudang" htmlFor="wh-code" required>
                      <Input id="wh-code" name="code" type="text" required placeholder="BKS-2" />
                    </Field>
                    <Field label="Nama Gudang" htmlFor="wh-name" required>
                      <Input
                        id="wh-name"
                        name="name"
                        type="text"
                        required
                        placeholder="Gudang Cabang Cikarang"
                      />
                    </Field>
                  </div>
                  <Field label="Alamat Lengkap" htmlFor="wh-address" required>
                    <Textarea
                      id="wh-address"
                      name="address"
                      rows={2}
                      required
                      placeholder="Jl. Industri Jababeka, Cikarang, Kab. Bekasi"
                    />
                  </Field>
                </ActionForm>
              </ModalDialogTrigger>
            </>
          ) : null
        }
      />

      {/* KPI Summary */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="CABANG OPERASIONAL"
          value={`${branchList.length} Cabang`}
          icon="building"
          iconTone="navy"
          badgeText="Bekasi Raya"
          badgeTone="neutral"
          caption={branchList.map((b) => b.name).join(", ") || "Cabang Utama"}
        />
        <KpiCard
          label="GUDANG DISTRIBUSI"
          value={`${warehouseList.length} Gudang`}
          icon="warehouse"
          iconTone="fresh"
          badgeText="Aktif"
          badgeTone="success"
          caption={warehouseList.map((w) => w.code).join(", ")}
        />
        <KpiCard
          label="ZONA COLD STORAGE"
          value={`${coldRoomsCount} Zona`}
          icon="spark"
          iconTone="info"
          badgeText="Rantai Dingin"
          badgeTone="info"
          caption="Kontrol suhu berpendingin aktif"
        />
        <KpiCard
          label="ZONA KARANTINA & QC"
          value={`${quarantineCount} Zona`}
          icon="shield"
          iconTone="warning"
          badgeText="Isolasi Mutu"
          badgeTone="warning"
          caption={`Dari total ${locationList.length} lokasi terdaftar`}
        />
      </div>

      {/* Warehouses & Zones Table */}
      <Card noPadding>
        <CardHeader
          id="daftar-gudang-heading"
          title="Daftar Lokasi & Zona Penyimpanan per Gudang"
          subtitle="Setiap pergerakan stok dan saldo batch dicatat hingga ke tingkat lokasi spesifik"
          meta={<Badge tone="neutral">{filteredLocations.length} Lokasi</Badge>}
        />

        <TableSearchFilterBar
          placeholder="Cari kode lokasi, nama zona, atau gudang..."
          statusLabel="Semua Jenis Zona"
          statusOptions={[
            { value: "receiving", label: "Penerimaan & Timbang" },
            { value: "quarantine", label: "Karantina & QC" },
            { value: "cold_room", label: "Cold Storage" },
            { value: "ambient", label: "Ruang Sejuk / Tropis" },
            { value: "dispatch", label: "Picking & Dispatch" },
            { value: "reject", label: "Barang Reject" },
          ]}
          totalCount={locationList.length}
          filteredCount={filteredLocations.length}
        />

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="daftar-gudang-heading"
          className="table-region"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3">Kode Lokasi</th>
                <th className="px-4 py-3">Nama Zona / Area</th>
                <th className="px-4 py-3">Gudang Induk</th>
                <th className="px-4 py-3">Fungsi Zona</th>
                <th className="px-4 py-3 text-right">Target Suhu</th>
                <th className="px-5 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {filteredLocations.map((loc) => {
                const wh = warehouseList.find((w) => w.id === loc.warehouseId);
                const zInfo = ZONE_LABELS[loc.zoneType] ?? {
                  label: loc.zoneType,
                  tone: "neutral" as const,
                };
                return (
                  <tr key={loc.id} className="hover:bg-slate-50/80">
                    <th scope="row" className="px-5 py-3.5 font-mono font-bold text-blue-600">
                      {loc.code}
                    </th>
                    <td className="px-4 py-3.5 font-semibold text-slate-900">{loc.name}</td>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-800">
                        {wh ? `${wh.code} — ${wh.name}` : loc.warehouseId}
                      </div>
                      {wh && <div className="text-[11px] text-slate-500">{wh.address}</div>}
                    </td>
                    <td className="px-4 py-3.5">
                      <Badge tone={zInfo.tone}>{zInfo.label}</Badge>
                    </td>
                    <td className="tabular-nums px-4 py-3.5 text-right font-medium text-slate-700">
                      {loc.temperatureMinC !== null && loc.temperatureMaxC !== null
                        ? `${loc.temperatureMinC}°C s/d ${loc.temperatureMaxC}°C`
                        : "Suhu Ruang"}
                    </td>
                    <td className="px-5 py-3.5">
                      <Badge tone={loc.isActive ? "success" : "danger"} dot>
                        {loc.isActive ? "Aktif" : "Nonaktif"}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
              {filteredLocations.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <EmptyState
                      icon="warehouse"
                      title="Lokasi Tidak Ditemukan"
                      description="Tidak ada zona penyimpanan yang cocok dengan filter yang dipilih."
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
