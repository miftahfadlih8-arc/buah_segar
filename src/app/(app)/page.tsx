import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import {
  businessDate,
  businessDateOffsetDays,
  formatDate,
  formatDateTime,
} from "@/lib/datetime";
import { formatRupiah, MoneyDecimal, roundRupiah, toDbAmount } from "@/lib/money";
import { formatQty, parseQty } from "@/lib/quantity";
import { Icon } from "@/components/ui/icons";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  KpiCard,
  PageHeader,
  statusToBadgeTone,
} from "@/components/ui/primitives";
import { requireSessionActor } from "@/server/auth/session";
import { hasPermission } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import {
  approvals,
  auditLogs,
  batches,
  customerCreditNotes,
  customerInvoices,
  customerPayments,
  customers,
  goodsReceipts,
  products,
  purchaseOrderLines,
  purchaseOrders,
  salesOrderLines,
  salesOrders,
  stockBalances,
  suppliers,
  warehouseLocations,
  warehouses,
} from "@/server/db/schema";

export const dynamic = "force-dynamic";

type PeriodKey = "7d" | "30d" | "90d" | "all";

function resolveCutoffDateString(period: PeriodKey): string | null {
  if (period === "all") return null;
  const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
  return businessDateOffsetDays(-days);
}

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<{ period?: string }>;
}) {
  const actor = await requireSessionActor();
  const db = getDb();
  const resolvedParams = (await searchParams) ?? {};
  const period: PeriodKey =
    resolvedParams.period === "7d" ||
    resolvedParams.period === "30d" ||
    resolvedParams.period === "90d"
      ? resolvedParams.period
      : "all";
  const cutoffDate = resolveCutoffDateString(period);
  const todayStr = businessDate();

  // Real database queries
  const [
    allProducts,
    allWarehouses,
    allLocations,
    allCustomers,
    allSuppliers,
    allBalances,
    allBatches,
    allPos,
    allPoLines,
    allGrns,
    allSos,
    allSoLines,
    allInvoices,
    allPayments,
    allCreditNotes,
    pendingApprovalRows,
    recentAudits,
  ] = await Promise.all([
    db.select().from(products),
    db.select().from(warehouses),
    db.select().from(warehouseLocations),
    db.select().from(customers),
    db.select().from(suppliers),
    db.select().from(stockBalances),
    db.select().from(batches),
    db.select().from(purchaseOrders).orderBy(desc(purchaseOrders.createdAt)),
    db.select().from(purchaseOrderLines),
    db.select().from(goodsReceipts).orderBy(desc(goodsReceipts.createdAt)),
    db.select().from(salesOrders).orderBy(desc(salesOrders.createdAt)),
    db.select().from(salesOrderLines),
    db.select().from(customerInvoices),
    db.select().from(customerPayments),
    db.select().from(customerCreditNotes),
    db.select().from(approvals).where(eq(approvals.status, "pending")),
    db.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(8),
  ]);

  // Period filtering for Sales & Procurement metrics
  const filteredSos = allSos.filter(
    (so) =>
      so.status !== "cancelled" &&
      so.status !== "rejected" &&
      (!cutoffDate || so.orderDate >= cutoffDate),
  );
  const filteredSoIds = new Set(filteredSos.map((s) => s.id));
  const activeSoLines = allSoLines.filter((l) => filteredSoIds.has(l.salesOrderId));

  let totalRevenue = new MoneyDecimal(0);
  let totalLineSubtotal = new MoneyDecimal(0);
  let totalLineCost = new MoneyDecimal(0);
  for (const so of filteredSos) {
    totalRevenue = totalRevenue.plus(new MoneyDecimal(so.grandTotalAmount));
  }
  for (const l of activeSoLines) {
    totalLineSubtotal = totalLineSubtotal.plus(new MoneyDecimal(l.lineNetAmount));
    const lineCost = new MoneyDecimal(l.unitCostBasisBase).mul(
      new MoneyDecimal(l.orderedQtyBase),
    );
    totalLineCost = totalLineCost.plus(lineCost);
  }

  const avgGrossMarginPct = totalLineSubtotal.gt(0)
    ? totalLineSubtotal
        .minus(totalLineCost)
        .div(totalLineSubtotal)
        .mul(100)
        .toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP)
        .toFixed(2)
    : null;

  // Inventory value & batch health
  const activeBalances = allBalances.filter((b) => parseQty(b.qtyBase).gt(0));
  let totalInventoryValue = new MoneyDecimal(0);
  let totalInventoryQtyKg = new MoneyDecimal(0);
  for (const b of activeBalances) {
    totalInventoryValue = totalInventoryValue.plus(new MoneyDecimal(b.totalCost));
    totalInventoryQtyKg = totalInventoryQtyKg.plus(parseQty(b.qtyBase));
  }

  // Batches nearing expiry (<= 3 days from today) or expired with positive stock
  const threeDaysFromNow = businessDateOffsetDays(3);
  const batchMap = new Map(allBatches.map((b) => [b.id, b]));
  const productMap = new Map(allProducts.map((p) => [p.id, p]));
  const warehouseMap = new Map(allWarehouses.map((w) => [w.id, w]));
  const customerMap = new Map(allCustomers.map((c) => [c.id, c]));
  const supplierMap = new Map(allSuppliers.map((s) => [s.id, s]));
  const locationMap = new Map(allLocations.map((l) => [l.id, l]));

  const atRiskBalances = activeBalances
    .map((bal) => {
      const batch = batchMap.get(bal.batchId);
      const product = productMap.get(bal.productId);
      const location = locationMap.get(bal.locationId);
      return { bal, batch, product, location };
    })
    .filter(
      (item) =>
        item.batch &&
        (item.batch.bestBeforeDate <= threeDaysFromNow || parseQty(item.bal.qtyBase).lte(15)),
    )
    .sort((a, b) =>
      (a.batch?.bestBeforeDate ?? "").localeCompare(b.batch?.bestBeforeDate ?? ""),
    );

  // Open Purchase Orders
  const filteredPos = allPos.filter(
    (po) =>
      po.status !== "cancelled" &&
      (!cutoffDate || formatDate(po.orderDate) >= cutoffDate),
  );
  const openPos = allPos.filter((po) =>
    ["draft", "submitted", "approved", "partially_received"].includes(po.status),
  );
  let committedPoSpend = new MoneyDecimal(0);
  for (const po of openPos) {
    committedPoSpend = committedPoSpend.plus(new MoneyDecimal(po.totalAmount));
  }

  // Accounts Receivable & Net Credit Exposure across all customers
  let totalOutstandingInvoices = new MoneyDecimal(0);
  for (const inv of allInvoices) {
    if (["posted", "partially_paid", "overdue"].includes(inv.status)) {
      const rem = new MoneyDecimal(inv.outstandingAmount);
      if (rem.gt(0)) totalOutstandingInvoices = totalOutstandingInvoices.plus(rem);
    }
  }
  let totalOpenCreditOrders = new MoneyDecimal(0);
  for (const so of allSos) {
    if (
      so.isCreditOrder &&
      so.paymentTermsDays > 0 &&
      !so.isInvoiced &&
      [
        "submitted",
        "pending_approval",
        "confirmed",
        "picking",
        "packed",
        "shipped",
        "delivered",
      ].includes(so.status)
    ) {
      totalOpenCreditOrders = totalOpenCreditOrders.plus(new MoneyDecimal(so.grandTotalAmount));
    }
  }
  let totalVerifiedUnapplied = new MoneyDecimal(0);
  for (const pay of allPayments) {
    if (pay.verificationStatus === "verified") {
      totalVerifiedUnapplied = totalVerifiedUnapplied.plus(
        new MoneyDecimal(pay.unappliedAmount),
      );
    }
  }
  let totalApprovedCnUnapplied = new MoneyDecimal(0);
  for (const cn of allCreditNotes) {
    if (cn.status === "approved") {
      totalApprovedCnUnapplied = totalApprovedCnUnapplied.plus(
        new MoneyDecimal(cn.unappliedAmount),
      );
    }
  }
  const totalNetCreditExposure = roundRupiah(
    totalOutstandingInvoices
      .plus(totalOpenCreditOrders)
      .minus(totalVerifiedUnapplied)
      .minus(totalApprovedCnUnapplied),
  );
  const creditHoldCount = allCustomers.filter((c) => c.creditHold).length;

  // Product comparison data for visual bar chart (Sales vs Procurement per product)
  const filteredPoIds = new Set(filteredPos.map((p) => p.id));
  const productComparison = allProducts.slice(0, 6).map((prod) => {
    const prodSoLines = activeSoLines.filter((l) => l.productId === prod.id);
    const prodPoLines = allPoLines.filter(
      (l) => l.productId === prod.id && filteredPoIds.has(l.purchaseOrderId),
    );
    const salesVal = prodSoLines.reduce(
      (acc, l) => acc.plus(new MoneyDecimal(l.lineNetAmount)),
      new MoneyDecimal(0),
    );
    const poVal = prodPoLines.reduce(
      (acc, l) => acc.plus(new MoneyDecimal(l.lineSubtotal)),
      new MoneyDecimal(0),
    );
    return {
      id: prod.id,
      sku: prod.sku,
      name: prod.name,
      salesVal: Number(salesVal.toFixed(0)),
      poVal: Number(poVal.toFixed(0)),
    };
  });
  const maxChartVal = Math.max(
    1,
    ...productComparison.flatMap((c) => [c.salesVal, c.poVal]),
  );

  // Warehouse utilization / stock distribution by location
  const warehouseUtilization = allWarehouses.map((wh) => {
    const whBalances = activeBalances.filter((b) => b.warehouseId === wh.id);
    const whQty = whBalances.reduce(
      (acc, b) => acc.plus(parseQty(b.qtyBase)),
      new MoneyDecimal(0),
    );
    const whVal = whBalances.reduce(
      (acc, b) => acc.plus(new MoneyDecimal(b.totalCost)),
      new MoneyDecimal(0),
    );
    const pct = totalInventoryQtyKg.gt(0)
      ? Math.min(100, Math.round(whQty.div(totalInventoryQtyKg).mul(100).toNumber()))
      : 0;
    return {
      id: wh.id,
      code: wh.code,
      name: wh.name,
      qtyKg: whQty.toFixed(1),
      valRupiah: formatRupiah(toDbAmount(whVal)),
      pct,
    };
  });

  // Quick actions gated by actor permissions
  const canCreateSo = hasPermission(actor, "sales.write");
  const canCreatePo = hasPermission(actor, "procurement.write");
  const canReceive = hasPermission(actor, "receiving.write");
  const canAdjustStock = hasPermission(actor, "inventory.adjust");

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="Ikhtisar Operasional & Keuangan"
        description={`Kinerja jaringan distribusi Bekasi • Tanggal bisnis ${todayStr} • Seluruh metrik dihitung langsung dari transaksi terposting`}
        actions={
          <>
            {/* Period Selector */}
            <div
              role="group"
              aria-label="Filter Periode Tren"
              className="inline-flex rounded-lg border border-slate-200/90 bg-white p-1 shadow-2xs"
            >
              {(
                [
                  { key: "7d", label: "7 Hari" },
                  { key: "30d", label: "30 Hari" },
                  { key: "90d", label: "90 Hari" },
                  { key: "all", label: "Semua" },
                ] as const
              ).map((item) => (
                <Link
                  key={item.key}
                  href={item.key === "all" ? "/" : `/?period=${item.key}`}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                    period === item.key
                      ? "bg-slate-900 text-white"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </div>

            {canCreateSo ? (
              <Link
                href="/penjualan"
                className="inline-flex min-h-[38px] items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white shadow-2xs transition hover:bg-slate-800"
              >
                <Icon name="plus" size={16} />
                Buat Sales Order
              </Link>
            ) : canCreatePo ? (
              <Link
                href="/pembelian"
                className="inline-flex min-h-[38px] items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white shadow-2xs transition hover:bg-slate-800"
              >
                <Icon name="plus" size={16} />
                Buat Purchase Order
              </Link>
            ) : null}
          </>
        }
      />

      {/* Top 4 Executive KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="OMZET PENJUALAN & MARGIN"
          value={formatRupiah(toDbAmount(totalRevenue))}
          icon="spark"
          iconTone="fresh"
          badgeText={
            avgGrossMarginPct !== null
              ? `Margin ${avgGrossMarginPct}%`
              : "Belum ada order"
          }
          badgeTone={avgGrossMarginPct !== null ? "success" : "neutral"}
          caption={`${filteredSos.length} Sales Order aktif`}
          href={hasPermission(actor, "sales.read") ? "/penjualan" : undefined}
        />

        <KpiCard
          label="NILAI PERSEDIAAN (FEFO)"
          value={formatRupiah(toDbAmount(totalInventoryValue))}
          icon="inventory"
          iconTone="info"
          badgeText={`${formatQty(totalInventoryQtyKg.toFixed(3), "kg")}`}
          badgeTone={activeBalances.length > 0 ? "info" : "neutral"}
          caption={`${activeBalances.length} saldo batch di ${allWarehouses.length} gudang`}
          href={hasPermission(actor, "inventory.read") ? "/stok" : undefined}
        />

        <KpiCard
          label="PURCHASE ORDER TERBUKA"
          value={`${openPos.length} PO`}
          icon="procurement"
          iconTone="navy"
          badgeText={
            openPos.length > 0 ? formatRupiah(toDbAmount(committedPoSpend)) : `${allGrns.length} GRN`
          }
          badgeTone={openPos.length > 0 ? "warning" : "neutral"}
          caption={`${allGrns.length} penerimaan (GRN) terposting`}
          href={hasPermission(actor, "procurement.read") ? "/pembelian" : undefined}
        />

        <KpiCard
          label="EKSPOSUR KREDIT & PIUTANG"
          value={formatRupiah(toDbAmount(totalNetCreditExposure))}
          icon="ledger"
          iconTone={creditHoldCount > 0 ? "danger" : "fresh"}
          badgeText={
            creditHoldCount > 0
              ? `${creditHoldCount} Hold Kredit`
              : `${allCustomers.length} Pelanggan`
          }
          badgeTone={creditHoldCount > 0 ? "danger" : "success"}
          caption={
            pendingApprovalRows.length > 0
              ? `${pendingApprovalRows.length} approval menunggu keputusan`
              : "Faktur + SO Kredit − Deposit"
          }
          href={hasPermission(actor, "customer.read") ? "/pelanggan" : undefined}
        />
      </div>

      {/* Middle Analytics & Warehouse Utilization Row (2-Column Asymmetric Grid) */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Left: Sales vs Procurement Comparison Bar Chart */}
        <Card noPadding className="lg:col-span-7 flex flex-col justify-between">
          <CardHeader
            title="Perbandingan Penjualan (SO) vs. Pembelian (PO) per Produk"
            subtitle="Nilai transaksi riil dari database berdasarkan produk utama"
            actions={
              <div className="flex items-center gap-4 text-xs font-medium text-slate-600">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-xs bg-blue-600" />
                  Penjualan (SO)
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-xs bg-slate-300" />
                  Pembelian (PO)
                </span>
              </div>
            }
          />

          <div className="p-5 sm:p-6">
            {productComparison.length === 0 ? (
              <EmptyState
                icon="catalog"
                title="Belum Ada Katalog Produk"
                description="Tambahkan master produk buah terlebih dahulu untuk melihat grafik perbandingan pembelian dan penjualan."
              />
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3.5 sm:grid-cols-3">
                  <div>
                    <div className="text-[11px] font-semibold text-slate-500 uppercase">
                      Total Pembelian (PO)
                    </div>
                    <div className="tabular-nums mt-0.5 text-sm font-bold text-slate-900">
                      {formatRupiah(
                        toDbAmount(
                          filteredPos.reduce(
                            (acc, p) => acc.plus(new MoneyDecimal(p.totalAmount)),
                            new MoneyDecimal(0),
                          ),
                        ),
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold text-slate-500 uppercase">
                      Total Penjualan (SO)
                    </div>
                    <div className="tabular-nums mt-0.5 text-sm font-bold text-blue-700">
                      {formatRupiah(toDbAmount(totalRevenue))}
                    </div>
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <div className="text-[11px] font-semibold text-slate-500 uppercase">
                      Laba Kotor (Gross Margin)
                    </div>
                    <div className="tabular-nums mt-0.5 text-sm font-bold text-emerald-700">
                      {avgGrossMarginPct !== null
                        ? `${avgGrossMarginPct}% (${formatRupiah(toDbAmount(totalLineSubtotal.minus(totalLineCost)))})`
                        : "Belum tersedia"}
                    </div>
                  </div>
                </div>

                {/* Vertical Bar Chart */}
                <div className="pt-2">
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-6">
                    {productComparison.map((item) => {
                      const salesHeightPct = Math.max(
                        item.salesVal > 0 ? 10 : 3,
                        Math.round((item.salesVal / maxChartVal) * 100),
                      );
                      const poHeightPct = Math.max(
                        item.poVal > 0 ? 10 : 3,
                        Math.round((item.poVal / maxChartVal) * 100),
                      );
                      return (
                        <div
                          key={item.id}
                          className="flex flex-col items-center rounded-lg border border-slate-100 bg-slate-50/50 p-2.5"
                        >
                          <div className="flex h-32 w-full items-end justify-center gap-2 border-b border-slate-200/80 px-2 pb-1">
                            <div
                              title={`Pembelian PO: ${formatRupiah(item.poVal)}`}
                              style={{ height: `${poHeightPct}%` }}
                              className="w-3.5 rounded-t bg-slate-300 transition-all"
                            />
                            <div
                              title={`Penjualan SO: ${formatRupiah(item.salesVal)}`}
                              style={{ height: `${salesHeightPct}%` }}
                              className="w-3.5 rounded-t bg-blue-600 transition-all"
                            />
                          </div>
                          <div className="mt-2 w-full truncate text-center font-mono text-[10px] font-bold text-slate-700">
                            {item.sku}
                          </div>
                          <div className="w-full truncate text-center text-[11px] text-slate-500">
                            {item.name}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* Right: Warehouse Utilization & Expiry Risk (FEFO) */}
        <Card noPadding className="lg:col-span-5 flex flex-col justify-between">
          <CardHeader
            title="Distribusi Gudang & Risiko Batch FEFO"
            subtitle="Proporsi stok aktif per gudang dan peringatan batas mutu"
            actions={<Badge tone="success" dot>Live</Badge>}
          />

          <div className="space-y-5 p-5 sm:p-6">
            {/* Warehouse Horizontal Progress Bars */}
            <div className="space-y-3.5">
              {warehouseUtilization.map((wh) => (
                <div key={wh.id} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-slate-800">
                      {wh.code} • {wh.name}
                    </span>
                    <span className="tabular-nums font-semibold text-slate-500">
                      {wh.qtyKg} kg ({wh.pct}%)
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      style={{ width: `${Math.max(wh.pct, Number(wh.qtyKg) > 0 ? 6 : 0)}%` }}
                      className="h-full rounded-full bg-blue-600 transition-all"
                    />
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Nilai Persediaan</span>
                    <span className="tabular-nums font-medium text-slate-600">{wh.valRupiah}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Near-Expiry / Low Stock Alert List */}
            <div className="border-t border-slate-100 pt-4">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800">
                  Batch Mendekati Batas Mutu / Stok Menipis
                </span>
                <Badge tone={atRiskBalances.length > 0 ? "warning" : "neutral"}>
                  {atRiskBalances.length} Batch
                </Badge>
              </div>

              {atRiskBalances.length === 0 ? (
                <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 px-3.5 py-3 text-xs text-slate-500">
                  Tidak ada batch aktif yang melewati batas risiko umur simpan (≤ 3 hari) atau stok
                  kritis saat ini.
                </div>
              ) : (
                <ul className="space-y-2">
                  {atRiskBalances.slice(0, 4).map(({ bal, batch, product, location }) => {
                    const isExpiring = (batch?.bestBeforeDate ?? "") <= threeDaysFromNow;
                    return (
                      <li
                        key={bal.id}
                        className="flex items-center justify-between gap-2 rounded-xl border border-amber-200/80 bg-amber-50/60 px-3 py-2 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-bold text-slate-900">
                            {product?.name ?? bal.productId} (Grade {batch?.gradeCode})
                          </div>
                          <div className="truncate font-mono text-[11px] text-slate-600">
                            {batch?.batchCode} • {location?.code} • FEFO: {batch?.bestBeforeDate}
                          </div>
                        </div>
                        <Badge tone={isExpiring ? "danger" : "warning"}>
                          {formatQty(bal.qtyBase, product?.baseUomCode ?? "kg")}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* Bottom Row: Recent Orders Table & Audit / Quick Actions */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Recent Operational Orders */}
        <Card noPadding className="lg:col-span-8">
          <CardHeader
            id="recent-orders-heading"
            title="Transaksi Pesanan & Pengadaan Terbaru"
            subtitle="Daftar Sales Order (SO) dan Purchase Order (PO) aktual di sistem"
            meta={
              <Badge tone="neutral">
                {allSos.length} SO • {allPos.length} PO
              </Badge>
            }
          />

          <div
            tabIndex={0}
            role="region"
            aria-labelledby="recent-orders-heading"
            className="table-region"
          >
            <table className="w-full border-collapse text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50/90 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
                <tr>
                  <th className="px-5 py-3">Dokumen</th>
                  <th className="px-4 py-3">Mitra (Pelanggan / Supplier)</th>
                  <th className="px-4 py-3">Gudang</th>
                  <th className="px-4 py-3 text-right">Nilai Total</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-5 py-3 text-right">Tanggal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {allSos.slice(0, 4).map((so) => {
                  const cust = customerMap.get(so.customerId);
                  const wh = warehouseMap.get(so.warehouseId);
                  return (
                    <tr key={`so-${so.id}`} className="hover:bg-slate-50/80">
                      <th scope="row" className="px-5 py-3.5 font-mono font-bold text-blue-600">
                        <Link href="/penjualan" className="hover:underline">
                          {so.soNumber}
                        </Link>
                        <div className="font-sans text-[10px] font-medium text-slate-400">
                          Sales Order
                        </div>
                      </th>
                      <td className="px-4 py-3.5">
                        <div className="font-semibold text-slate-900">
                          {cust?.name ?? so.customerId}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          Tier: {so.priceTierSnapshot.toUpperCase()} • Termin {so.paymentTermsDays}h
                        </div>
                      </td>
                      <td className="px-4 py-3.5 font-mono text-slate-600">
                        {wh?.code ?? so.warehouseId}
                      </td>
                      <td className="tabular-nums px-4 py-3.5 text-right font-bold text-slate-900">
                        {formatRupiah(so.grandTotalAmount)}
                      </td>
                      <td className="px-4 py-3.5">
                        <Badge tone={statusToBadgeTone(so.status)} dot>
                          {so.status.toUpperCase()}
                        </Badge>
                      </td>
                      <td className="tabular-nums px-5 py-3.5 text-right text-slate-500">
                        {so.orderDate}
                      </td>
                    </tr>
                  );
                })}

                {allPos.slice(0, 4).map((po) => {
                  const sup = supplierMap.get(po.supplierId);
                  const wh = warehouseMap.get(po.warehouseId);
                  return (
                    <tr key={`po-${po.id}`} className="hover:bg-slate-50/80">
                      <th scope="row" className="px-5 py-3.5 font-mono font-bold text-emerald-700">
                        <Link href="/pembelian" className="hover:underline">
                          {po.poNumber}
                        </Link>
                        <div className="font-sans text-[10px] font-medium text-slate-400">
                          Purchase Order
                        </div>
                      </th>
                      <td className="px-4 py-3.5">
                        <div className="font-semibold text-slate-900">
                          {sup?.name ?? po.supplierId}
                        </div>
                        <div className="text-[11px] text-slate-500">{po.originRegion}</div>
                      </td>
                      <td className="px-4 py-3.5 font-mono text-slate-600">
                        {wh?.code ?? po.warehouseId}
                      </td>
                      <td className="tabular-nums px-4 py-3.5 text-right font-bold text-slate-900">
                        {formatRupiah(po.totalAmount)}
                      </td>
                      <td className="px-4 py-3.5">
                        <Badge tone={statusToBadgeTone(po.status)} dot>
                          {po.status.toUpperCase()}
                        </Badge>
                      </td>
                      <td className="tabular-nums px-5 py-3.5 text-right text-slate-500">
                        {formatDate(po.orderDate)}
                      </td>
                    </tr>
                  );
                })}

                {allSos.length === 0 && allPos.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <EmptyState
                        icon="sales"
                        title="Belum Ada Transaksi Pesanan"
                        description="Silakan buat Purchase Order pengadaan petani atau Sales Order pelanggan untuk melihat aktivitas operasional."
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Right Column: Quick Actions & Real Audit Stream */}
        <div className="space-y-6 lg:col-span-4">
          {/* Role-Aware Quick Actions */}
          <Card noPadding>
            <CardHeader
              title="Aksi Cepat Sesuai Peran"
              subtitle="Pintasan kerja harian berdasarkan izin akun Anda"
            />
            <div className="grid grid-cols-2 gap-2.5 p-4">
              {canCreatePo && (
                <Link
                  href="/pembelian"
                  className="flex items-center gap-2.5 rounded-xl border border-slate-200/90 bg-slate-50/70 p-3 text-xs font-semibold text-slate-800 transition hover:border-emerald-300 hover:bg-emerald-50/50"
                >
                  <Icon name="procurement" size={16} className="text-emerald-600" />
                  <span>Buat PO Petani</span>
                </Link>
              )}
              {canReceive && (
                <Link
                  href="/penerimaan"
                  className="flex items-center gap-2.5 rounded-xl border border-slate-200/90 bg-slate-50/70 p-3 text-xs font-semibold text-slate-800 transition hover:border-emerald-300 hover:bg-emerald-50/50"
                >
                  <Icon name="receiving" size={16} className="text-blue-600" />
                  <span>Terima &amp; QC Buah</span>
                </Link>
              )}
              {canCreateSo && (
                <Link
                  href="/penjualan"
                  className="flex items-center gap-2.5 rounded-xl border border-slate-200/90 bg-slate-50/70 p-3 text-xs font-semibold text-slate-800 transition hover:border-emerald-300 hover:bg-emerald-50/50"
                >
                  <Icon name="sales" size={16} className="text-emerald-600" />
                  <span>Input Sales Order</span>
                </Link>
              )}
              {canAdjustStock && (
                <Link
                  href="/stok"
                  className="flex items-center gap-2.5 rounded-xl border border-slate-200/90 bg-slate-50/70 p-3 text-xs font-semibold text-slate-800 transition hover:border-emerald-300 hover:bg-emerald-50/50"
                >
                  <Icon name="inventory" size={16} className="text-amber-600" />
                  <span>Catat Susut / Opname</span>
                </Link>
              )}
              <Link
                href="/katalog"
                className="flex items-center gap-2.5 rounded-xl border border-slate-200/90 bg-slate-50/70 p-3 text-xs font-semibold text-slate-800 transition hover:border-slate-300 hover:bg-slate-100/70"
              >
                <Icon name="catalog" size={16} className="text-slate-600" />
                <span>Katalog ({allProducts.length} SKU)</span>
              </Link>
              <Link
                href="/pelanggan"
                className="flex items-center gap-2.5 rounded-xl border border-slate-200/90 bg-slate-50/70 p-3 text-xs font-semibold text-slate-800 transition hover:border-slate-300 hover:bg-slate-100/70"
              >
                <Icon name="customer" size={16} className="text-slate-600" />
                <span>CRM ({allCustomers.length} Mitra)</span>
              </Link>
            </div>
          </Card>

          {/* Real Append-Only Audit Activity Stream */}
          <Card noPadding>
            <CardHeader
              title="Aktivitas Sistem Terbaru"
              subtitle="Log audit append-only dari database"
              actions={
                hasPermission(actor, "audit.read") ? (
                  <Link
                    href="/audit"
                    className="text-xs font-semibold text-blue-600 hover:underline"
                  >
                    Lihat Semua
                  </Link>
                ) : null
              }
            />
            <div className="divide-y divide-slate-100 px-5 py-2">
              {recentAudits.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-500">
                  Belum ada entri audit tercatat.
                </p>
              ) : (
                recentAudits.map((log) => (
                  <div key={log.id} className="py-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-bold text-slate-800">{log.action}</span>
                      <span className="tabular-nums text-[11px] text-slate-400">
                        {formatDateTime(log.occurredAt)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[11px] text-slate-500">
                      <span>Oleh: {log.actorName ?? "SYSTEM"}</span>
                      <span className="font-mono">
                        {log.entityType}:{log.entityId.slice(0, 12)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
