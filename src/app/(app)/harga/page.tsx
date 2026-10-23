import { redirect } from "next/navigation";
import {
  createPriceListAction,
  upsertPriceListItemAction,
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
import { businessDate } from "@/lib/datetime";
import { formatRupiah } from "@/lib/money";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import { listProductsWithDetails, listUoms } from "@/server/modules/master/catalog";
import { listWarehouses } from "@/server/modules/master/warehouses";
import { listPriceLists, MARGIN_FORMULA_DESCRIPTION } from "@/server/modules/pricing";

export const dynamic = "force-dynamic";

export default async function HargaPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string; status?: string }>;
}) {
  const actor = await requireSessionActor();
  if (!hasPermission(actor, "pricing.read")) {
    redirect("/");
  }
  const db = getDb();
  const params = (await searchParams) ?? {};
  const q = (params.q ?? "").trim().toLowerCase();
  const tierFilter = (params.status ?? "").trim().toLowerCase();

  const [pricingData, productsWithDetails, uomsList, warehouseList] = await Promise.all([
    listPriceLists(db, actor),
    listProductsWithDetails(db, actor),
    listUoms(db, actor),
    listWarehouses(db, actor),
  ]);

  const canWrite = hasPermission(actor, "pricing.write");
  const productMap = new Map(productsWithDetails.map((p) => [p.id, p]));
  const allGrades = productsWithDetails.flatMap((p) => p.grades);
  const plMap = new Map(pricingData.priceLists.map((pl) => [pl.id, pl]));
  const today = businessDate();

  const filteredItems = pricingData.items.filter((item) => {
    const pl = plMap.get(item.priceListId);
    const prod = productMap.get(item.productId);
    const matchesQ =
      !q ||
      (pl?.code ?? "").toLowerCase().includes(q) ||
      (pl?.name ?? "").toLowerCase().includes(q) ||
      (prod?.name ?? "").toLowerCase().includes(q) ||
      (prod?.sku ?? "").toLowerCase().includes(q) ||
      item.gradeCode.toLowerCase().includes(q) ||
      item.uomCode.toLowerCase().includes(q);
    const matchesTier = !tierFilter || pl?.priceTier === tierFilter;
    return matchesQ && matchesTier;
  });

  const activePlCount = pricingData.priceLists.filter((pl) => pl.isActive).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Daftar Harga Grosir, HORECA, Ritel & Kontrol Margin"
        description="Mengelola daftar harga berdasarkan produk, grade (A/B/C), satuan (UoM), tingkatan kuantitas (minQty), segmen pelanggan, serta kontrol margin dan riwayat perubahan harga permanen."
        actions={
          canWrite ? (
            <>
              <ModalDialogTrigger
                triggerLabel="Buat Price List Baru"
                triggerVariant="secondary"
                triggerIcon="pricing"
                title="Buat Daftar Harga (Price List) Baru"
                subtitle="Tetapkan kelompok harga (Grosir / Semi-Grosir / HORECA / Ritel), masa berlaku, dan alasan kebijakan harga."
                maxWidthClass="max-w-xl"
              >
                <ActionForm action={createPriceListAction} submitLabel="Simpan Price List">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Kode Price List" htmlFor="pl-code" required>
                      <Input
                        id="pl-code"
                        name="code"
                        required
                        placeholder="PL-GROSIR-BKS-2026"
                      />
                    </Field>
                    <Field label="Nama Daftar Harga" htmlFor="pl-name" required>
                      <Input
                        id="pl-name"
                        name="name"
                        required
                        placeholder="Harga Grosir Pasar Bekasi"
                      />
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Kelompok Harga (Price Tier)" htmlFor="pl-tier" required>
                      <Select id="pl-tier" name="priceTier" defaultValue="grosir">
                        <option value="grosir">Grosir</option>
                        <option value="semi_grosir">Semi-Grosir</option>
                        <option value="horeca">HORECA</option>
                        <option value="ritel">Ritel</option>
                      </Select>
                    </Field>
                    <Field label="Gudang Berlaku (Opsional)" htmlFor="pl-wh">
                      <Select id="pl-wh" name="warehouseId" defaultValue="">
                        <option value="">-- Berlaku Semua Gudang --</option>
                        {warehouseList.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.code} — {w.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Berlaku Mulai" htmlFor="pl-from" required>
                      <Input
                        id="pl-from"
                        name="effectiveFrom"
                        type="date"
                        defaultValue={today}
                        required
                      />
                    </Field>
                    <Field label="Berlaku Sampai (Opsional)" htmlFor="pl-to">
                      <Input id="pl-to" name="effectiveTo" type="date" />
                    </Field>
                  </div>

                  <Field label="Alasan Pembuatan / Kebijakan Harga" htmlFor="pl-reason" required>
                    <Input
                      id="pl-reason"
                      name="reason"
                      required
                      defaultValue="Penetapan harga berkala distribusi Bekasi"
                    />
                  </Field>
                </ActionForm>
              </ModalDialogTrigger>

              {pricingData.priceLists.length > 0 ? (
                <ModalDialogTrigger
                  triggerLabel="Atur Harga Produk"
                  triggerVariant="primary"
                  triggerIcon="plus"
                  title="Tambah / Perbarui Item Harga Produk"
                  subtitle="Konversi harga ke satuan dasar (Base UoM) dihitung otomatis di server berdasarkan tabel konversi katalog."
                  maxWidthClass="max-w-xl"
                >
                  <ActionForm action={upsertPriceListItemAction} submitLabel="Simpan Harga Produk">
                    <Field label="Pilih Price List" htmlFor="pli-list" required>
                      <Select id="pli-list" name="priceListId" required>
                        {pricingData.priceLists.map((pl) => (
                          <option key={pl.id} value={pl.id}>
                            {pl.code} — {pl.name} ({pl.priceTier})
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Pilih Produk" htmlFor="pli-prod" required>
                        <Select id="pli-prod" name="productId" required>
                          {productsWithDetails.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.sku} — {p.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Pilih Grade" htmlFor="pli-grade" required>
                        <Select id="pli-grade" name="gradeId" required>
                          {allGrades.map((g) => {
                            const p = productMap.get(g.productId);
                            return (
                              <option key={g.id} value={g.id}>
                                {p?.sku ?? g.productId} • Grade {g.code} ({g.name})
                              </option>
                            );
                          })}
                        </Select>
                      </Field>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-3">
                      <Field label="Satuan (UoM)" htmlFor="pli-uom" required>
                        <Select id="pli-uom" name="uomCode" defaultValue="kg">
                          {uomsList.map((u) => (
                            <option key={u.code} value={u.code}>
                              {u.code} — {u.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Min. Kuantitas" htmlFor="pli-minqty" required>
                        <Input id="pli-minqty" name="minQty" defaultValue="1.000" required />
                      </Field>
                      <Field label="Diskon Maks (%)" htmlFor="pli-disc" required>
                        <Input id="pli-disc" name="maxDiscountPct" defaultValue="5.00" required />
                      </Field>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Harga Jual per Satuan (Rp)" htmlFor="pli-price" required>
                        <Input
                          id="pli-price"
                          name="unitPrice"
                          type="text"
                          inputMode="numeric"
                          required
                          placeholder="25000"
                        />
                      </Field>
                      <Field label="Alasan Penetapan Harga" htmlFor="pli-reason" required>
                        <Input
                          id="pli-reason"
                          name="reason"
                          required
                          defaultValue="Update harga pasar harian"
                        />
                      </Field>
                    </div>
                  </ActionForm>
                </ModalDialogTrigger>
              ) : null}
            </>
          ) : null
        }
      />

      {/* Explicit Margin Formula Callout */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-xs text-emerald-950">
        <div>
          <span className="font-bold">Rumus Eksplisit Kontrol Margin:</span>{" "}
          <code className="rounded bg-white px-2 py-0.5 font-mono text-[11px] font-semibold text-emerald-900 ring-1 ring-emerald-200">
            {MARGIN_FORMULA_DESCRIPTION}
          </code>{" "}
          — harga di bawah batas minimum wajib persetujuan <code>price_override</code>.
        </div>
        <Badge tone="success">Margin Gate Active</Badge>
      </div>

      {/* KPI Strip */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="DAFTAR HARGA (PRICE LIST)"
          value={`${pricingData.priceLists.length} Dokumen`}
          icon="pricing"
          iconTone="navy"
          badgeText={`${activePlCount} Aktif`}
          badgeTone="success"
          caption="Buku harga berdasarkan segmen & periode"
        />
        <KpiCard
          label="ITEM HARGA TERDAFTAR"
          value={`${pricingData.items.length} Baris`}
          icon="catalog"
          iconTone="fresh"
          badgeText="SKU × Grade × UoM"
          badgeTone="info"
          caption="Mendukung konversi satuan otomatis ke Base UoM"
        />
        <KpiCard
          label="STRUKTUR TIER HARGA"
          value="4 Kelompok"
          icon="customers"
          iconTone="info"
          badgeText="B2B & B2C"
          badgeTone="info"
          caption="Grosir, Semi-Grosir, Kontrak HORECA, dan Ritel"
        />
        <KpiCard
          label="PROTEKSI MARGIN KOTOR"
          value="Wajib Approval"
          icon="shield"
          iconTone="warning"
          badgeText="Server-Side Gate"
          badgeTone="warning"
          caption="Mencegah penjualan di bawah HPP atau minMarginPct"
        />
      </div>

      {/* Active Price Lists Table */}
      <Card noPadding>
        <CardHeader
          id="daftar-pl-heading"
          title="Daftar Buku Harga (Price Lists)"
          subtitle="Master daftar harga berdasarkan tier pelanggan, gudang, dan masa berlaku"
          meta={<Badge tone="neutral">{pricingData.priceLists.length} Price List</Badge>}
        />

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="daftar-pl-heading"
          className="table-region"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3">Kode &amp; Nama Price List</th>
                <th className="px-4 py-3">Tier &amp; Segmen</th>
                <th className="px-4 py-3">Periode Berlaku</th>
                <th className="px-5 py-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {pricingData.priceLists.map((pl) => (
                <tr key={pl.id} className="hover:bg-slate-50/80">
                  <th scope="row" className="px-5 py-3.5 font-semibold text-slate-900">
                    <div className="font-mono text-xs font-bold text-blue-600">{pl.code}</div>
                    <div className="mt-0.5 text-slate-900">{pl.name}</div>
                  </th>
                  <td className="px-4 py-3.5">
                    <Badge tone="info">{pl.priceTier.toUpperCase()}</Badge>
                    <div className="mt-1 text-[11px] text-slate-500">
                      Segmen: {pl.customerSegment ?? "Semua Segmen"}
                    </div>
                  </td>
                  <td className="tabular-nums px-4 py-3.5 font-mono text-slate-700">
                    {pl.effectiveFrom} s/d {pl.effectiveTo ?? "Berlaku Terus"}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <Badge tone={pl.isActive ? "success" : "neutral"} dot>
                      {pl.isActive ? "AKTIF" : "NONAKTIF"}
                    </Badge>
                  </td>
                </tr>
              ))}
              {pricingData.priceLists.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <EmptyState
                      icon="pricing"
                      title="Belum Ada Price List"
                      description="Silakan buat daftar harga baru untuk memulai penetapan harga jual."
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Price List Items Table */}
      <Card noPadding>
        <CardHeader
          id="item-pl-heading"
          title="Rincian Harga per Produk, Grade & Satuan"
          subtitle="Harga satuan transaksi beserta ekuivalen harga per Base UoM dan batas diskon maksimum"
          meta={<Badge tone="info">{filteredItems.length} Item Harga</Badge>}
        />

        <TableSearchFilterBar
          placeholder="Cari kode price list, nama buah, SKU, grade (A/B/C), atau satuan..."
          statusLabel="Semua Kelompok Harga"
          statusOptions={[
            { value: "grosir", label: "Grosir" },
            { value: "semi_grosir", label: "Semi-Grosir" },
            { value: "horeca", label: "HORECA" },
            { value: "ritel", label: "Ritel" },
          ]}
          totalCount={pricingData.items.length}
          filteredCount={filteredItems.length}
        />

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="item-pl-heading"
          className="table-region"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3">Price List</th>
                <th className="px-4 py-3">Produk &amp; Grade</th>
                <th className="px-4 py-3">Satuan &amp; Min. Qty</th>
                <th className="px-4 py-3 text-right">Harga Satuan</th>
                <th className="px-4 py-3 text-right">Ekuivalen Base UoM</th>
                <th className="px-5 py-3 text-right">Diskon Maks (%)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {filteredItems.map((item) => {
                const pl = plMap.get(item.priceListId);
                const prod = productMap.get(item.productId);
                return (
                  <tr key={item.id} className="hover:bg-slate-50/80">
                    <td className="px-5 py-3.5">
                      <div className="font-mono text-xs font-bold text-blue-600">
                        {pl?.code ?? item.priceListId}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        Tier: {pl?.priceTier.toUpperCase() ?? "-"}
                      </div>
                    </td>
                    <th scope="row" className="px-4 py-3.5 font-semibold text-slate-900">
                      <div>{prod?.name ?? item.productId}</div>
                      <div className="mt-0.5 text-[11px] font-normal text-slate-500">
                        SKU: {prod?.sku ?? "-"} •{" "}
                        <span className="font-semibold text-emerald-700">
                          Grade {item.gradeCode}
                        </span>
                      </div>
                    </th>
                    <td className="tabular-nums px-4 py-3.5 font-mono text-slate-700">
                      Min {item.minQty} {item.uomCode}
                    </td>
                    <td className="tabular-nums px-4 py-3.5 text-right font-bold text-slate-900">
                      {formatRupiah(item.unitPrice)}{" "}
                      <span className="font-normal text-slate-500">/ {item.uomCode}</span>
                    </td>
                    <td className="tabular-nums px-4 py-3.5 text-right font-semibold text-emerald-800">
                      {formatRupiah(item.unitPriceBase)}{" "}
                      <span className="font-normal text-slate-500">
                        / {prod?.baseUomCode ?? "kg"}
                      </span>
                    </td>
                    <td className="tabular-nums px-5 py-3.5 text-right font-mono font-semibold text-slate-700">
                      {item.maxDiscountPct}%
                    </td>
                  </tr>
                );
              })}
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState
                      icon="catalog"
                      title="Belum Ada Rincian Harga"
                      description="Tidak ditemukan item harga yang cocok dengan pencarian atau filter kelompok harga."
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
