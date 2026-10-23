import { redirect } from "next/navigation";
import { createSupplierAction } from "@/app/(app)/actions";
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
  type BadgeTone,
} from "@/components/ui/primitives";
import { TableSearchFilterBar } from "@/components/ui/table-toolbar";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission, isSuperAdmin } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import { listSuppliers } from "@/server/modules/master/suppliers";

const SUPPLIER_TYPE_LABELS: Record<string, { label: string; tone: BadgeTone }> = {
  petani: { label: "Petani Langsung", tone: "success" },
  kebun: { label: "Kebun / Perkebunan", tone: "fresh" === "fresh" ? "success" : "info" },
  koperasi: { label: "Kelompok Tani / Koperasi", tone: "info" },
  grosir: { label: "Pedagang Besar / Pasar Induk", tone: "warning" },
  importir: { label: "Importir Resmi", tone: "navy" },
};

export default async function SupplierPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireSessionActor();
  if (
    !hasPermission(actor, "supplier.write") &&
    !hasPermission(actor, "procurement.read") &&
    !isSuperAdmin(actor)
  ) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const typeFilter = (params.status ?? "").trim().toLowerCase();

  const supplierList = await listSuppliers(db, actor);
  const canWrite = hasPermission(actor, "supplier.write");
  const canReadBank = hasPermission(actor, "supplier.read_bank");

  const filteredSuppliers = supplierList.filter((s) => {
    const matchesQ =
      !q ||
      s.code.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.originRegion.toLowerCase().includes(q) ||
      (s.contactPerson ?? "").toLowerCase().includes(q);
    const matchesType = !typeFilter || s.supplierType === typeFilter;
    return matchesQ && matchesType;
  });

  const petaniCount = supplierList.filter(
    (s) => s.supplierType === "petani" || s.supplierType === "kebun" || s.supplierType === "koperasi",
  ).length;
  const avgLeadTime =
    supplierList.length > 0
      ? (
          supplierList.reduce((acc, s) => acc + s.leadTimeDays, 0) / supplierList.length
        ).toFixed(1)
      : "0";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Manajemen Petani, Kebun & Supplier Buah"
        description={
          canReadBank
            ? "Kelola mitra pemasok hulu, daerah asal panen, lead time pengiriman, termin pembayaran, dan rekening pencairan AP."
            : "Kelola mitra pemasok hulu, daerah asal panen, dan lead time pengiriman (Nomor rekening & NPWP disamarkan untuk peran Anda)."
        }
        actions={
          canWrite ? (
            <ModalDialogTrigger
              triggerLabel="Daftarkan Supplier Baru"
              triggerVariant="primary"
              triggerIcon="plus"
              title="Daftarkan Petani / Kebun / Supplier Baru"
              subtitle="Pastikan kode pemasok, daerah asal, dan termin pembayaran sesuai perjanjian pasokan."
              maxWidthClass="max-w-3xl"
            >
              <ActionForm action={createSupplierAction} submitLabel="Simpan Data Supplier">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Kode Supplier" htmlFor="sup-code" required>
                    <Input
                      id="sup-code"
                      name="code"
                      type="text"
                      required
                      placeholder="SUP-BWI-03"
                    />
                  </Field>
                  <Field label="Nama Petani / Kebun / Perusahaan" htmlFor="sup-name" required>
                    <Input
                      id="sup-name"
                      name="name"
                      type="text"
                      required
                      placeholder="Kebun Buah Naga Banyuwangi"
                    />
                  </Field>
                  <Field label="Jenis Pemasok" htmlFor="sup-type" required>
                    <Select id="sup-type" name="supplierType" defaultValue="petani">
                      <option value="petani">Petani Langsung</option>
                      <option value="kebun">Kebun / Perkebunan</option>
                      <option value="koperasi">Kelompok Tani / Koperasi</option>
                      <option value="grosir">Pedagang Besar / Pasar Induk</option>
                      <option value="importir">Importir Resmi</option>
                    </Select>
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Daerah Asal Pasokan" htmlFor="sup-origin" required>
                    <Input
                      id="sup-origin"
                      name="originRegion"
                      type="text"
                      required
                      placeholder="Banyuwangi, Jawa Timur"
                    />
                  </Field>
                  <Field label="Nama Narahubung" htmlFor="sup-contact">
                    <Input
                      id="sup-contact"
                      name="contactPerson"
                      type="text"
                      placeholder="Pak Wahyu"
                    />
                  </Field>
                  <Field label="Telepon / WhatsApp" htmlFor="sup-phone">
                    <Input id="sup-phone" name="phone" type="tel" placeholder="0812..." />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-5">
                  <Field label="Termin (Hari)" htmlFor="sup-terms">
                    <Input
                      id="sup-terms"
                      name="paymentTermsDays"
                      type="number"
                      min={0}
                      defaultValue={7}
                    />
                  </Field>
                  <Field label="Lead Time (Hari)" htmlFor="sup-lead">
                    <Input
                      id="sup-lead"
                      name="leadTimeDays"
                      type="number"
                      min={0}
                      defaultValue={2}
                    />
                  </Field>
                  <Field label="Nama Bank" htmlFor="sup-bank">
                    <Input id="sup-bank" name="bankName" type="text" placeholder="BRI / BCA" />
                  </Field>
                  <Field label="No. Rekening" htmlFor="sup-accno">
                    <Input id="sup-accno" name="bankAccountNo" type="text" inputMode="numeric" />
                  </Field>
                  <Field label="Atas Nama" htmlFor="sup-accholder">
                    <Input id="sup-accholder" name="bankAccountHolder" type="text" />
                  </Field>
                </div>
              </ActionForm>
            </ModalDialogTrigger>
          ) : null
        }
      />

      {/* KPI Summary */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="TOTAL MITRA PEMASOK"
          value={`${supplierList.length} Supplier`}
          icon="supplier"
          iconTone="fresh"
          badgeText="Aktif"
          badgeTone="success"
          caption="Pemasok buah terdaftar di sistem"
        />
        <KpiCard
          label="SUMBER HULU LANGSUNG"
          value={`${petaniCount} Mitra`}
          icon="leaf"
          iconTone="info"
          badgeText="Petani / Kebun"
          badgeTone="info"
          caption="Petani langsung, kebun, & koperasi"
        />
        <KpiCard
          label="RATA-RATA LEAD TIME"
          value={`${avgLeadTime} Hari`}
          icon="truck"
          iconTone="navy"
          badgeText="Estimasi Tiba"
          badgeTone="neutral"
          caption="Waktu tempuh pasokan ke Gudang Bekasi"
        />
        <KpiCard
          label="PERLINDUNGAN DATA BANK"
          value={canReadBank ? "Terbuka" : "Disamarkan"}
          icon="shield"
          iconTone={canReadBank ? "fresh" : "warning"}
          badgeText={canReadBank ? "Izin Finance/Owner" : "RBAC Aktif"}
          badgeTone={canReadBank ? "success" : "warning"}
          caption="Kontrol akses nomor rekening & NPWP"
        />
      </div>

      {/* Suppliers Table */}
      <Card noPadding>
        <CardHeader
          id="daftar-supplier-heading"
          title="Daftar Pemasok & Petani Terdaftar"
          subtitle="Sumber pasokan buah untuk Purchase Order dan ketertelusuran batch (lot origin)"
          meta={<Badge tone="neutral">{filteredSuppliers.length} Supplier</Badge>}
        />

        <TableSearchFilterBar
          placeholder="Cari kode supplier, nama petani, atau daerah asal..."
          statusLabel="Semua Jenis Pemasok"
          statusOptions={[
            { value: "petani", label: "Petani Langsung" },
            { value: "kebun", label: "Kebun / Perkebunan" },
            { value: "koperasi", label: "Kelompok Tani / Koperasi" },
            { value: "grosir", label: "Pedagang Besar / Pasar Induk" },
            { value: "importir", label: "Importir Resmi" },
          ]}
          totalCount={supplierList.length}
          filteredCount={filteredSuppliers.length}
        />

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="daftar-supplier-heading"
          className="table-region"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3">Kode &amp; Nama Pemasok</th>
                <th className="px-4 py-3">Jenis &amp; Daerah Asal</th>
                <th className="px-4 py-3">Narahubung</th>
                <th className="px-4 py-3 text-right">Termin &amp; Lead Time</th>
                <th className="px-5 py-3">Rekening Pencairan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {filteredSuppliers.map((s) => {
                const tInfo = SUPPLIER_TYPE_LABELS[s.supplierType] ?? {
                  label: s.supplierType,
                  tone: "neutral" as const,
                };
                return (
                  <tr key={s.id} className="hover:bg-slate-50/80">
                    <th scope="row" className="px-5 py-3.5 font-semibold text-slate-900">
                      <div className="font-mono text-xs font-bold text-blue-600">{s.code}</div>
                      <div className="mt-0.5 text-sm font-bold text-slate-900">{s.name}</div>
                    </th>
                    <td className="px-4 py-3.5">
                      <Badge tone={tInfo.tone}>{tInfo.label}</Badge>
                      <div className="mt-1 text-[11px] font-medium text-slate-600">
                        Asal: {s.originRegion}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-800">{s.contactPerson ?? "—"}</div>
                      <div className="font-mono text-[11px] text-slate-500">{s.phone ?? "—"}</div>
                    </td>
                    <td className="tabular-nums px-4 py-3.5 text-right">
                      <div className="font-bold text-slate-900">Termin: {s.paymentTermsDays} hari</div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        Lead Time: {s.leadTimeDays} hari
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="font-semibold text-slate-800">
                        {s.bankName ?? "—"} •{" "}
                        <span className="font-mono text-slate-700">{s.bankAccountNo ?? "—"}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        a.n. {s.bankAccountHolder ?? "—"}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredSuppliers.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      icon="supplier"
                      title="Pemasok Tidak Ditemukan"
                      description="Tidak ada data petani atau supplier yang sesuai dengan pencarian Anda."
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
