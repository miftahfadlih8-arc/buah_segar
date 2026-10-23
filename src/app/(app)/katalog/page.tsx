import { redirect } from "next/navigation";
import {
  createPackagingTypeAction,
  createProductAction,
  upsertUomConversionAction,
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
} from "@/components/ui/primitives";
import { TableSearchFilterBar } from "@/components/ui/table-toolbar";
import { formatRupiah } from "@/lib/money";
import { formatQty } from "@/lib/quantity";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import {
  listPackagingTypes,
  listProductsWithDetails,
  listUoms,
} from "@/server/modules/master/catalog";

export default async function KatalogPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "catalog.read")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const storageFilter = (params.status ?? "").trim().toLowerCase();

  const [productsList, uomList, packagingList] = await Promise.all([
    listProductsWithDetails(db, actor),
    listUoms(db, actor),
    listPackagingTypes(db, actor),
  ]);

  const canWrite = hasPermission(actor, "catalog.write");

  const filteredProducts = productsList.filter((p) => {
    const matchesQuery =
      !q ||
      p.sku.toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q);
    const matchesStorage = !storageFilter || p.storageCondition === storageFilter;
    return matchesQuery && matchesStorage;
  });

  const coldCount = productsList.filter((p) => p.storageCondition === "cold").length;
  const catchWeightCount = productsList.filter((p) => p.isCatchWeight).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Katalog Buah, Grade Kualitas & Konversi UoM"
        description="Kelola master SKU buah segar, satuan dasar stok (kg/pcs), timbang aktual (catch-weight), grade A/B/C, serta tara kemasan."
        actions={
          canWrite ? (
            <>
              <ModalDialogTrigger
                triggerLabel="Atur Konversi UoM"
                triggerVariant="secondary"
                triggerIcon="scale"
                title="Atur Konversi Kemasan / Satuan (UoM) Produk"
                subtitle="Konversi nominal dipakai untuk perencanaan order, sedangkan penagihan memakai berat timbang aktual."
              >
                <ActionForm action={upsertUomConversionAction} submitLabel="Simpan Konversi Satuan">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Produk Buah" htmlFor="conv-productId" required>
                      <Select id="conv-productId" name="productId" required>
                        {productsList.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.sku} — {p.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Satuan Kemasan" htmlFor="conv-uomCode" required>
                      <Select id="conv-uomCode" name="uomCode" defaultValue="krat">
                        {uomList
                          .filter((u) => u.code !== "kg")
                          .map((u) => (
                            <option key={u.code} value={u.code}>
                              {u.code} — {u.name}
                            </option>
                          ))}
                      </Select>
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label="Perkiraan Berat/Isi ke Satuan Dasar"
                      htmlFor="conv-factorToBase"
                      required
                    >
                      <Input
                        id="conv-factorToBase"
                        name="factorToBase"
                        type="text"
                        inputMode="decimal"
                        required
                        placeholder="misal: 20 (kg per krat)"
                      />
                    </Field>
                    <Field label="Kemasan Standar (Tara)" htmlFor="conv-packaging">
                      <Select id="conv-packaging" name="defaultPackagingTypeId">
                        <option value="">-- Tanpa Kemasan Default --</option>
                        {packagingList.map((pkg) => (
                          <option key={pkg.id} value={pkg.id}>
                            {pkg.name} (Tara: {pkg.defaultTareKg} kg)
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>

                  <div className="flex flex-wrap gap-6 pt-1 text-xs">
                    <label className="inline-flex items-center gap-2 font-medium text-slate-800">
                      <input type="checkbox" name="isNominal" defaultChecked className="h-4 w-4" />
                      Konversi Perkiraan (Nominal)
                    </label>
                    <label className="inline-flex items-center gap-2 font-medium text-slate-800">
                      <input
                        type="checkbox"
                        name="requiresActualWeight"
                        defaultChecked
                        className="h-4 w-4"
                      />
                      Wajib Timbang Aktual Saat Terima &amp; Kirim
                    </label>
                  </div>
                </ActionForm>
              </ModalDialogTrigger>

              <ModalDialogTrigger
                triggerLabel="Tambah Kemasan"
                triggerVariant="secondary"
                triggerIcon="inventory"
                title="Tambah Jenis Kemasan & Berat Tara"
                subtitle="Digunakan untuk pengurangan otomatis berat tara saat penimbangan bruto penerimaan barang."
              >
                <ActionForm action={createPackagingTypeAction} submitLabel="Simpan Kemasan">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Kode Kemasan" htmlFor="pkg-code" required>
                      <Input
                        id="pkg-code"
                        name="code"
                        type="text"
                        required
                        placeholder="PETI-APEL-18"
                      />
                    </Field>
                    <Field label="Nama Kemasan" htmlFor="pkg-name" required>
                      <Input
                        id="pkg-name"
                        name="name"
                        type="text"
                        required
                        placeholder="Karton Apel 18 Kg"
                      />
                    </Field>
                    <Field label="Tara Standar (kg)" htmlFor="pkg-tare" required>
                      <Input
                        id="pkg-tare"
                        name="defaultTareKg"
                        type="text"
                        inputMode="decimal"
                        required
                        defaultValue="0.850"
                      />
                    </Field>
                  </div>
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-800">
                    <input type="checkbox" name="isReusable" className="h-4 w-4" />
                    Kemasan Dapat Dipakai Ulang (Krat Sirkulasi)
                  </label>
                </ActionForm>
              </ModalDialogTrigger>

              <ModalDialogTrigger
                triggerLabel="Tambah Produk Buah"
                triggerVariant="primary"
                triggerIcon="plus"
                title="Tambah Produk Buah Baru"
                subtitle="Otomatis membuat Grade A (Super/HORECA), Grade B (Pasar/Ritel), dan Grade C (Jus/Olahan)."
              >
                <ActionForm action={createProductAction} submitLabel="Simpan Produk Buah">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Kode SKU" htmlFor="sku" required>
                      <Input
                        id="sku"
                        name="sku"
                        type="text"
                        required
                        autoCorrect="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        placeholder="misal: SEM-MRH-LP"
                      />
                    </Field>
                    <Field label="Barcode EAN/Internal" htmlFor="barcode">
                      <Input
                        id="barcode"
                        name="barcode"
                        type="text"
                        autoCorrect="off"
                        spellCheck={false}
                        placeholder="899..."
                      />
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Nama Buah" htmlFor="name" required>
                      <Input
                        id="name"
                        name="name"
                        type="text"
                        required
                        placeholder="Semangka Merah Non-Biji"
                      />
                    </Field>
                    <Field label="Kategori" htmlFor="category" required>
                      <Input
                        id="category"
                        name="category"
                        type="text"
                        required
                        defaultValue="Buah Lokal Harian"
                      />
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Satuan Dasar Stok" htmlFor="baseUomCode">
                      <Select id="baseUomCode" name="baseUomCode" defaultValue="kg">
                        <option value="kg">Kilogram (kg)</option>
                        <option value="pcs">Buah / Butir (pcs)</option>
                      </Select>
                    </Field>
                    <Field label="Umur Simpan (Hari)" htmlFor="defaultShelfLifeDays" required>
                      <Input
                        id="defaultShelfLifeDays"
                        name="defaultShelfLifeDays"
                        type="number"
                        min={1}
                        defaultValue={7}
                        required
                      />
                    </Field>
                    <Field label="Suhu Simpan" htmlFor="storageCondition">
                      <Select id="storageCondition" name="storageCondition" defaultValue="cold">
                        <option value="cold">Cold Room (2–6°C)</option>
                        <option value="ambient">Ruang Sejuk</option>
                      </Select>
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Margin Kotor Minimum (%)" htmlFor="minMarginPct">
                      <Input
                        id="minMarginPct"
                        name="minMarginPct"
                        type="text"
                        inputMode="decimal"
                        defaultValue="10.00"
                      />
                    </Field>
                    <Field
                      label="Harga Jual Minimum per Satuan Dasar (Rp)"
                      htmlFor="minSellingPrice"
                    >
                      <Input
                        id="minSellingPrice"
                        name="minSellingPrice"
                        type="text"
                        inputMode="numeric"
                        defaultValue="12000"
                      />
                    </Field>
                  </div>

                  <div className="flex flex-wrap gap-6 pt-1 text-xs">
                    <label className="inline-flex items-center gap-2 font-medium text-slate-800">
                      <input
                        type="checkbox"
                        name="isCatchWeight"
                        defaultChecked
                        className="h-4 w-4"
                      />
                      Wajib Timbang Aktual (Catch-Weight)
                    </label>
                    <label className="inline-flex items-center gap-2 font-medium text-slate-800">
                      <input
                        type="checkbox"
                        name="ripenessTracking"
                        defaultChecked
                        className="h-4 w-4"
                      />
                      Pantau Tingkat Kematangan
                    </label>
                  </div>
                </ActionForm>
              </ModalDialogTrigger>
            </>
          ) : null
        }
      />

      {/* Summary KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="TOTAL KATALOG BUAH"
          value={`${productsList.length} SKU`}
          icon="catalog"
          iconTone="fresh"
          badgeText={`${coldCount} Cold Storage`}
          badgeTone="info"
          caption={`${productsList.length - coldCount} produk suhu ruang sejuk`}
        />
        <KpiCard
          label="PRODUK CATCH-WEIGHT"
          value={`${catchWeightCount} SKU`}
          icon="scale"
          iconTone="info"
          badgeText="Wajib Timbang"
          badgeTone="success"
          caption="Penagihan berdasarkan berat neto aktual"
        />
        <KpiCard
          label="SATUAN UKUR (UOM)"
          value={`${uomList.length} Satuan`}
          icon="inventory"
          iconTone="navy"
          badgeText="Standar Stok"
          badgeTone="neutral"
          caption={uomList.map((u) => u.code).join(", ")}
        />
        <KpiCard
          label="JENIS KEMASAN & TARA"
          value={`${packagingList.length} Kemasan`}
          icon="receiving"
          iconTone="warning"
          badgeText="Potong Tara Otomatis"
          badgeTone="warning"
          caption="Peti kayu, krat plastik, karton, keranjang"
        />
      </div>

      {/* Main Catalog Table */}
      <Card noPadding>
        <CardHeader
          id="daftar-produk-heading"
          title="Daftar Produk Buah, Grade & Konversi Kemasan"
          subtitle="Setiap produk memiliki batas margin minimum dan pengali harga per Grade A/B/C"
          meta={<Badge tone="neutral">{filteredProducts.length} SKU</Badge>}
        />

        <TableSearchFilterBar
          placeholder="Cari kode SKU, nama buah, atau kategori..."
          statusLabel="Semua Suhu Simpan"
          statusOptions={[
            { value: "cold", label: "Cold Storage (2–6°C)" },
            { value: "ambient", label: "Suhu Ruang Sejuk" },
          ]}
          totalCount={productsList.length}
          filteredCount={filteredProducts.length}
        />

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="daftar-produk-heading"
          className="table-region"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3">SKU &amp; Nama Buah</th>
                <th className="px-4 py-3">Kategori &amp; Penyimpanan</th>
                <th className="px-4 py-3">Satuan Dasar</th>
                <th className="px-4 py-3 text-right">Umur Simpan</th>
                <th className="px-4 py-3 text-right">Batas Margin &amp; Harga Min</th>
                <th className="px-5 py-3">Grade Kualitas &amp; Konversi UoM</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {filteredProducts.map((p) => (
                <tr key={p.id} className="align-top hover:bg-slate-50/80">
                  <th scope="row" className="px-5 py-3.5 font-semibold text-slate-900">
                    <div className="font-mono text-xs font-bold text-blue-600">{p.sku}</div>
                    <div className="mt-0.5 text-sm font-bold text-slate-900">{p.name}</div>
                    {p.variety && (
                      <div className="text-[11px] font-normal text-slate-500">{p.variety}</div>
                    )}
                  </th>
                  <td className="px-4 py-3.5">
                    <div className="font-semibold text-slate-800">{p.category}</div>
                    <div className="mt-1">
                      <Badge tone={p.storageCondition === "cold" ? "info" : "neutral"} dot>
                        {p.storageCondition === "cold"
                          ? "Cold Storage (2–6°C)"
                          : "Suhu Ruang Sejuk"}
                      </Badge>
                    </div>
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs font-bold uppercase text-slate-800">
                      {p.baseUomCode}
                    </span>
                    <div className="mt-1 text-[11px] text-slate-500">
                      {p.isCatchWeight ? "Wajib Timbang Aktual" : "Satuan Pasti"}
                    </div>
                  </td>
                  <td className="tabular-nums px-4 py-3.5 text-right font-semibold text-slate-800">
                    {p.defaultShelfLifeDays} hari
                  </td>
                  <td className="tabular-nums px-4 py-3.5 text-right">
                    <div className="font-bold text-emerald-700">Min Margin: {p.minMarginPct}%</div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      Lantai: {formatRupiah(p.minSellingPrice)}/{p.baseUomCode}
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex flex-wrap gap-1.5">
                      {p.grades.map((g) => (
                        <Badge key={g.id} tone="success">
                          Grade {g.code} ({g.priceMultiplierPct}%)
                        </Badge>
                      ))}
                    </div>
                    {p.uomConversions.length > 0 && (
                      <ul className="mt-2 space-y-1 text-[11px] text-slate-600">
                        {p.uomConversions.map((c) => (
                          <li key={c.id} className="tabular-nums">
                            1 <strong className="font-mono text-slate-800">{c.uomCode}</strong> ≈{" "}
                            {formatQty(c.factorToBase, p.baseUomCode)} (
                            {c.requiresActualWeight ? "timbang aktual" : "tetap"})
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
              {filteredProducts.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <EmptyState
                      icon="catalog"
                      title="Produk Tidak Ditemukan"
                      description="Tidak ada produk buah yang cocok dengan pencarian atau filter suhu penyimpanan."
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
