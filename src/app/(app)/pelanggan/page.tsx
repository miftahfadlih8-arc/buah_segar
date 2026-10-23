import { redirect } from "next/navigation";
import {
  addCustomerContactAction,
  createCustomerAction,
  updateCustomerCreditAction,
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
} from "@/components/ui/primitives";
import { TableSearchFilterBar } from "@/components/ui/table-toolbar";
import { formatRupiah, MoneyDecimal, toDbAmount } from "@/lib/money";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import {
  calculateCustomerCreditExposure,
  CREDIT_EXPOSURE_FORMULA,
} from "@/server/modules/finance/credit";
import { listCustomers, listDeliveryZones } from "@/server/modules/master/customers";

export const dynamic = "force-dynamic";

const SEGMENT_LABELS: Record<string, string> = {
  toko_buah: "Toko Buah Tradisional",
  pedagang_pasar: "Pedagang Pasar Induk/Rakyat",
  ritel_reseller: "Ritel Buah & Reseller",
  horeca: "HORECA (Hotel, Resto, Kafe, Katering)",
  kedai_jus: "Kedai Jus & Minuman",
  korporat: "Kantor, Instansi & Korporat",
  konsumen_langsung: "Konsumen Langsung (B2C)",
};

export default async function PelangganPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "customer.read")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const segmentFilter = (params.status ?? "").trim().toLowerCase();

  const [customerList, zoneList] = await Promise.all([
    listCustomers(db, actor),
    listDeliveryZones(db, actor),
  ]);

  const exposures = await Promise.all(
    customerList.map((c) => calculateCustomerCreditExposure(db, c.id)),
  );
  const exposureMap = new Map(exposures.map((e) => [e.customerId, e]));

  const canWrite = hasPermission(actor, "customer.write");
  const canManageCredit = hasPermission(actor, "customer.credit_manage");

  const zoneMap = new Map(zoneList.map((z) => [z.id, z]));

  const filteredCustomers = customerList.filter((c) => {
    const z = c.deliveryZoneId ? zoneMap.get(c.deliveryZoneId) : null;
    const matchesQ =
      !q ||
      c.code.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q) ||
      (c.contactPerson ?? "").toLowerCase().includes(q) ||
      (c.whatsapp ?? c.phone ?? "").toLowerCase().includes(q) ||
      c.shippingAddress.toLowerCase().includes(q) ||
      (z?.name ?? "").toLowerCase().includes(q);
    const matchesSegment = !segmentFilter || c.segment === segmentFilter;
    return matchesQ && matchesSegment;
  });

  const totalCreditLimit = customerList.reduce(
    (acc, c) => acc.plus(new MoneyDecimal(c.creditLimit)),
    new MoneyDecimal(0),
  );
  const totalNetExposure = exposures.reduce(
    (acc, e) => acc.plus(new MoneyDecimal(e.netCreditExposure)),
    new MoneyDecimal(0),
  );
  const creditHoldCount = customerList.filter((c) => c.creditHold).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="CRM Pelanggan, Segmentasi, Zona Bekasi & Batas Kredit"
        description="Mengelola segmen pelanggan, tingkatan harga (Grosir / Semi-Grosir / HORECA / Ritel), persetujuan komunikasi terpisah (operasional vs promosi), dan kontrol limit kredit."
        actions={
          <>
            {canManageCredit && customerList.length > 0 ? (
              <ModalDialogTrigger
                triggerLabel="Evaluasi Limit Kredit"
                triggerVariant="secondary"
                triggerIcon="shield"
                title="Ubah Kebijakan Batas Kredit (Khusus Keuangan & Pemilik)"
                subtitle="Setiap perubahan batas kredit dan status tahan kredit wajib disertai alasan dan dicatat permanen pada log audit."
                maxWidthClass="max-w-xl"
              >
                <ActionForm
                  action={updateCustomerCreditAction}
                  submitLabel="Perbarui Batas Kredit"
                >
                  <Field label="Pilih Pelanggan" htmlFor="cred-customerId" required>
                    <Select id="cred-customerId" name="customerId" required>
                      {customerList.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} — {c.name} (Limit saat ini: {formatRupiah(c.creditLimit)} | v
                          {c.version})
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Batas Kredit Baru (Rp)" htmlFor="cred-limit" required>
                      <Input
                        id="cred-limit"
                        name="creditLimit"
                        type="text"
                        inputMode="numeric"
                        required
                        placeholder="20000000"
                      />
                    </Field>
                    <Field label="Termin (Hari)" htmlFor="cred-terms" required>
                      <Input
                        id="cred-terms"
                        name="paymentTermsDays"
                        type="number"
                        min={0}
                        defaultValue={7}
                        required
                      />
                    </Field>
                    <Field label="Versi Data Saat Ini" htmlFor="cred-version" required>
                      <Input
                        id="cred-version"
                        name="expectedVersion"
                        type="number"
                        min={1}
                        defaultValue={1}
                        required
                      />
                    </Field>
                  </div>

                  <Field label="Alasan Evaluasi Kredit" htmlFor="cred-reason" required>
                    <Input
                      id="cred-reason"
                      name="reason"
                      type="text"
                      required
                      placeholder="Riwayat pelunasan tepat waktu 3 bulan berturut-turut"
                    />
                  </Field>

                  <label className="inline-flex items-center gap-2 text-xs font-semibold text-red-800">
                    <input type="checkbox" name="creditHold" className="h-4 w-4" />
                    Tahan Kredit (Blokir pesanan baru hingga piutang jatuh tempo dilunasi)
                  </label>
                </ActionForm>
              </ModalDialogTrigger>
            ) : null}

            {canWrite && customerList.length > 0 ? (
              <ModalDialogTrigger
                triggerLabel="Tambah Kontak PIC"
                triggerVariant="secondary"
                triggerIcon="users"
                title="Tambah Kontak PIC Pelanggan"
                subtitle="Simpan kontak bagian pembelian, penerima gudang, atau keuangan pelanggan."
                maxWidthClass="max-w-xl"
              >
                <ActionForm action={addCustomerContactAction} submitLabel="Simpan Kontak">
                  <Field label="Pilih Pelanggan" htmlFor="cc-customer" required>
                    <Select id="cc-customer" name="customerId" required>
                      {customerList.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} — {c.name}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Nama Kontak" htmlFor="cc-name" required>
                      <Input
                        id="cc-name"
                        name="name"
                        placeholder="Ibu Rina / Bpk. Hendra"
                        required
                      />
                    </Field>
                    <Field label="Jabatan / Peran" htmlFor="cc-role" required>
                      <Input
                        id="cc-role"
                        name="roleTitle"
                        placeholder="Purchasing / Kepala Dapur"
                        required
                      />
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Nomor WhatsApp" htmlFor="cc-wa">
                      <Input id="cc-wa" name="whatsapp" placeholder="0812..." />
                    </Field>
                    <Field label="Email" htmlFor="cc-email">
                      <Input id="cc-email" name="email" type="email" placeholder="purchasing@..." />
                    </Field>
                  </div>

                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-800">
                    <input type="checkbox" name="isPrimary" defaultChecked className="h-4 w-4" />
                    Jadikan kontak utama pelanggan
                  </label>
                </ActionForm>
              </ModalDialogTrigger>
            ) : null}

            {canWrite ? (
              <ModalDialogTrigger
                triggerLabel="Daftarkan Pelanggan"
                triggerVariant="primary"
                triggerIcon="plus"
                title="Daftarkan Pelanggan Baru"
                subtitle="Tentukan segmen pelanggan, kelompok harga, zona pengiriman Bekasi, dan batas kredit awal."
                maxWidthClass="max-w-2xl"
              >
                <ActionForm action={createCustomerAction} submitLabel="Simpan Pelanggan">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Kode Pelanggan" htmlFor="cus-code" required>
                      <Input id="cus-code" name="code" required placeholder="CUST-BKS-04" />
                    </Field>
                    <Field label="Nama Toko / Usaha / Pelanggan" htmlFor="cus-name" required>
                      <Input
                        id="cus-name"
                        name="name"
                        required
                        placeholder="Toko Buah Berkah Harapan Indah"
                      />
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Segmen Pelanggan" htmlFor="cus-segment" required>
                      <Select id="cus-segment" name="segment" defaultValue="toko_buah">
                        <option value="toko_buah">Toko Buah Tradisional</option>
                        <option value="pedagang_pasar">Pedagang Pasar</option>
                        <option value="ritel_reseller">Ritel &amp; Reseller</option>
                        <option value="horeca">HORECA (Hotel, Resto, Kafe, Katering)</option>
                        <option value="kedai_jus">Kedai Jus &amp; Minuman</option>
                        <option value="korporat">Kantor, Instansi &amp; Korporat</option>
                        <option value="konsumen_langsung">Konsumen Langsung (B2C)</option>
                      </Select>
                    </Field>
                    <Field label="Kelompok Harga" htmlFor="cus-tier">
                      <Select id="cus-tier" name="priceTier" defaultValue="grosir">
                        <option value="grosir">Grosir</option>
                        <option value="semi_grosir">Semi-Grosir</option>
                        <option value="horeca">Kontrak HORECA</option>
                        <option value="ritel">Ritel</option>
                      </Select>
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Nama Penanggung Jawab" htmlFor="cus-contact">
                      <Input id="cus-contact" name="contactPerson" />
                    </Field>
                    <Field label="Nomor WhatsApp / Telepon" htmlFor="cus-wa">
                      <Input id="cus-wa" name="whatsapp" type="tel" placeholder="081..." />
                    </Field>
                  </div>

                  <Field label="Zona Pengiriman Bekasi" htmlFor="cus-zone">
                    <Select id="cus-zone" name="deliveryZoneId">
                      <option value="">-- Pilih Zona Pengiriman --</option>
                      {zoneList.map((z) => (
                        <option key={z.id} value={z.id}>
                          {z.code} — {z.name} (Min Order {formatRupiah(z.minOrderAmount)})
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field label="Alamat Pengiriman Lengkap" htmlFor="cus-addr" required>
                    <Textarea id="cus-addr" name="shippingAddress" rows={2} required />
                  </Field>

                  {canManageCredit ? (
                    <div className="grid gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3.5 sm:grid-cols-2">
                      <Field label="Batas Kredit Awal (Rp)" htmlFor="cus-limit">
                        <Input
                          id="cus-limit"
                          name="creditLimit"
                          type="text"
                          inputMode="numeric"
                          defaultValue="0"
                        />
                      </Field>
                      <Field label="Termin Kredit (Hari)" htmlFor="cus-terms">
                        <Input
                          id="cus-terms"
                          name="paymentTermsDays"
                          type="number"
                          min={0}
                          defaultValue={0}
                        />
                      </Field>
                    </div>
                  ) : null}

                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-800">
                    <input type="checkbox" name="marketingConsent" className="h-4 w-4" />
                    Pelanggan menyetujui pesan penawaran harga &amp; promosi (terpisah dari
                    notifikasi pesanan operasional)
                  </label>
                </ActionForm>
              </ModalDialogTrigger>
            ) : null}
          </>
        }
      />

      {/* Explicit Credit Exposure Formula Callout */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-xs text-emerald-950">
        <div>
          <span className="font-bold">Rumus Eksplisit Eksposur Kredit Server-Side:</span>{" "}
          <code className="rounded bg-white px-2 py-0.5 font-mono text-[11px] font-semibold text-emerald-900 ring-1 ring-emerald-200">
            {CREDIT_EXPOSURE_FORMULA}
          </code>
        </div>
        <Badge tone="success">Credit Gate Active</Badge>
      </div>

      {/* KPI Strip */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="TOTAL PELANGGAN B2B & RITEL"
          value={`${customerList.length} Pelanggan`}
          icon="customers"
          iconTone="navy"
          badgeText={`${zoneList.length} Zona Kirim`}
          badgeTone="info"
          caption="Toko buah, pasar induk, HORECA & korporat Bekasi"
        />
        <KpiCard
          label="TOTAL LIMIT KREDIT AKTIF"
          value={formatRupiah(toDbAmount(totalCreditLimit))}
          icon="wallet"
          iconTone="info"
          badgeText="Plafon Disetujui"
          badgeTone="info"
          caption="Akumulasi plafon kredit seluruh pelanggan"
        />
        <KpiCard
          label="EKSPOSUR KREDIT BERSIH"
          value={formatRupiah(toDbAmount(totalNetExposure))}
          icon="ledger"
          iconTone="fresh"
          badgeText="Piutang + Open SO"
          badgeTone="success"
          caption="Dihitung real-time pada setiap konfirmasi pesanan"
        />
        <KpiCard
          label="STATUS CREDIT HOLD"
          value={`${creditHoldCount} Pelanggan`}
          icon="shield"
          iconTone={creditHoldCount > 0 ? "danger" : "fresh"}
          badgeText={creditHoldCount > 0 ? "Diblokir Sementara" : "Semua Lancar"}
          badgeTone={creditHoldCount > 0 ? "danger" : "success"}
          caption="Pelanggan dengan pembekuan pesanan kredit"
        />
      </div>

      {/* Customers Table */}
      <Card noPadding>
        <CardHeader
          id="daftar-pelanggan-heading"
          title="Daftar Pelanggan & Eksposur Kredit"
          subtitle="Memantau plafon kredit, eksposur berjalan, sisa kredit tersedia, dan persetujuan komunikasi"
          meta={<Badge tone="neutral">{filteredCustomers.length} Pelanggan</Badge>}
        />

        <TableSearchFilterBar
          placeholder="Cari kode pelanggan, nama toko/HORECA, PIC, nomor WA, atau alamat..."
          statusLabel="Semua Segmen Pelanggan"
          statusOptions={[
            { value: "toko_buah", label: "Toko Buah Tradisional" },
            { value: "pedagang_pasar", label: "Pedagang Pasar Induk/Rakyat" },
            { value: "ritel_reseller", label: "Ritel Buah & Reseller" },
            { value: "horeca", label: "HORECA (Hotel, Resto, Kafe, Katering)" },
            { value: "kedai_jus", label: "Kedai Jus & Minuman" },
            { value: "korporat", label: "Kantor, Instansi & Korporat" },
            { value: "konsumen_langsung", label: "Konsumen Langsung (B2C)" },
          ]}
          totalCount={customerList.length}
          filteredCount={filteredCustomers.length}
        />

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="daftar-pelanggan-heading"
          className="table-region"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3">Kode &amp; Nama Pelanggan</th>
                <th className="px-4 py-3">Segmen &amp; Tier Harga</th>
                <th className="px-4 py-3">Zona &amp; Alamat Kirim</th>
                <th className="px-4 py-3">Kontak &amp; Izin Pesan</th>
                <th className="px-5 py-3 text-right">Kebijakan &amp; Sisa Kredit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {filteredCustomers.map((c) => {
                const z = c.deliveryZoneId ? zoneMap.get(c.deliveryZoneId) : null;
                const exp = exposureMap.get(c.id);
                return (
                  <tr key={c.id} className="align-top hover:bg-slate-50/80">
                    <th scope="row" className="px-5 py-3.5 font-semibold text-slate-900">
                      <div className="font-mono text-xs font-bold text-blue-600">{c.code}</div>
                      <div className="mt-0.5 text-sm font-bold text-slate-900">{c.name}</div>
                      <div className="mt-0.5 text-[11px] font-normal text-slate-500">
                        Versi Data: v{c.version}
                      </div>
                    </th>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">
                        {SEGMENT_LABELS[c.segment] ?? c.segment}
                      </div>
                      <div className="mt-1">
                        <Badge tone="info">Harga: {c.priceTier.toUpperCase()}</Badge>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      {z ? (
                        <span className="font-semibold text-emerald-800">
                          [{z.code}] {z.name}
                        </span>
                      ) : (
                        <span className="text-slate-400">Zona belum ditentukan</span>
                      )}
                      <div className="mt-0.5 max-w-xs text-slate-600">{c.shippingAddress}</div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">{c.contactPerson ?? "-"}</div>
                      <div className="tabular-nums text-slate-600">
                        {c.whatsapp ?? c.phone ?? "-"}
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        <Badge tone="success">Notif Order: Aktif</Badge>
                        <Badge tone={c.marketingConsent ? "info" : "neutral"}>
                          Promo: {c.marketingConsent ? "Setuju" : "Tidak"}
                        </Badge>
                      </div>
                    </td>
                    <td className="tabular-nums px-5 py-3.5 text-right">
                      <div className="font-bold text-slate-900">
                        Limit: {formatRupiah(c.creditLimit)}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Termin: {c.paymentTermsDays} hari
                      </div>
                      {exp ? (
                        <div className="mt-1.5 space-y-0.5 border-t border-slate-100 pt-1.5 text-[11px]">
                          <div>
                            Eksposur Bersih:{" "}
                            <span className="font-semibold text-slate-900">
                              {formatRupiah(exp.netCreditExposure)}
                            </span>
                          </div>
                          <div>
                            Sisa Kredit:{" "}
                            <span className="font-bold text-emerald-700">
                              {formatRupiah(exp.availableCredit)}
                            </span>
                          </div>
                        </div>
                      ) : null}
                      {c.creditHold ? (
                        <div className="mt-1.5">
                          <Badge tone="danger" dot>
                            KREDIT DITAHAN (HOLD)
                          </Badge>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {filteredCustomers.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      icon="customers"
                      title="Pelanggan Tidak Ditemukan"
                      description="Tidak ada data pelanggan yang cocok dengan kata kunci atau filter segmen."
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
