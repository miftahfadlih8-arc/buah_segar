import { eq, inArray, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { AppShell, type NavGroupConfig } from "@/components/shell/app-shell";
import { getSessionActor } from "@/server/auth/session";
import { hasPermission, isSuperAdmin } from "@/server/authz/authorize";
import { getDb } from "@/server/db";
import {
  approvals,
  customerInvoices,
  customerOrderRequests,
  deliveryOrders,
  purchaseOrders,
  salesFulfillments,
  salesOrders,
} from "@/server/db/schema";

export default async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const actor = await getSessionActor();
  if (!actor) {
    redirect("/masuk");
  }

  const db = getDb();
  const [
    [pendingApprovals],
    [openPoCount],
    [pendingSoCount],
    [activeFulCount],
    [activeDoCount],
    [unpaidInvCount],
    [pendingQrOrderCount],
  ] = await Promise.all([
    db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(approvals)
      .where(eq(approvals.status, "pending")),
    db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(purchaseOrders)
      .where(
        inArray(purchaseOrders.status, ["draft", "submitted", "approved", "partially_received"]),
      ),
    db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(salesOrders)
      .where(
        inArray(salesOrders.status, ["draft", "submitted", "pending_approval", "confirmed"]),
      ),
    db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(salesFulfillments)
      .where(inArray(salesFulfillments.status, ["draft", "picking", "exception_hold"])),
    db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(deliveryOrders)
      .where(inArray(deliveryOrders.status, ["ready", "dispatched", "in_transit"])),
    db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(customerInvoices)
      .where(inArray(customerInvoices.status, ["posted", "partially_paid"])),
    db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(customerOrderRequests)
      .where(eq(customerOrderRequests.orderStatus, "pending_review")),
  ]);

  const allNavGroups: NavGroupConfig[] = [
    {
      id: "ringkasan",
      groupTitle: "1. Ringkasan",
      items: [
        {
          href: "/",
          label: "Dashboard Eksekutif",
          icon: "dashboard",
        },
      ],
    },
    {
      id: "pembelian",
      groupTitle: "2. Pembelian",
      items: hasPermission(actor, "procurement.read")
        ? [
            {
              href: "/pembelian",
              label: "Purchase Order (PO)",
              icon: "procurement",
              badgeCount: openPoCount?.cnt ?? 0,
              badgeTone: "neutral",
            },
          ]
        : [],
    },
    {
      id: "penerimaan",
      groupTitle: "3. Penerimaan & Quality Control",
      items: hasPermission(actor, "receiving.read")
        ? [
            {
              href: "/penerimaan",
              label: "Penerimaan (GRN), QC & Grading",
              icon: "receiving",
            },
          ]
        : [],
    },
    {
      id: "persediaan",
      groupTitle: "4. Persediaan",
      items: [
        ...(hasPermission(actor, "inventory.read")
          ? [
              {
                href: "/stok",
                label: "Stok Batch (FEFO) & Susut",
                icon: "inventory" as const,
              },
            ]
          : []),
        ...(hasPermission(actor, "warehouse.write") || isSuperAdmin(actor)
          ? [
              {
                href: "/gudang",
                label: "Gudang & Zona Simpan",
                icon: "warehouse" as const,
              },
            ]
          : []),
      ],
    },
    {
      id: "katalog_harga",
      groupTitle: "5. Katalog & Harga",
      items: [
        ...(hasPermission(actor, "catalog.read")
          ? [
              {
                href: "/katalog",
                label: "Katalog Buah, Grade & UoM",
                icon: "catalog" as const,
              },
            ]
          : []),
        ...(hasPermission(actor, "pricing.read")
          ? [
              {
                href: "/harga",
                label: "Daftar Harga & Margin",
                icon: "pricing" as const,
              },
            ]
          : []),
      ],
    },
    {
      id: "supplier",
      groupTitle: "6. Supplier",
      items:
        hasPermission(actor, "supplier.write") ||
        hasPermission(actor, "procurement.read") ||
        isSuperAdmin(actor)
          ? [
              {
                href: "/supplier",
                label: "Petani, Kebun & Pemasok",
                icon: "supplier",
              },
            ]
          : [],
    },
    {
      id: "pelanggan",
      groupTitle: "7. Pelanggan & Kredit",
      items: hasPermission(actor, "customer.read")
        ? [
            {
              href: "/pelanggan",
              label: "CRM Pelanggan & Limit Kredit",
              icon: "customer",
            },
            ...(hasPermission(actor, "sales.write") || isSuperAdmin(actor)
              ? [
                  {
                    href: "/qr-toko",
                    label: "QR Generator Toko & QRIS",
                    icon: "customer" as const,
                  },
                ]
              : []),
          ]
        : [],
    },
    {
      id: "penjualan",
      groupTitle: "8. Penjualan dan Pesanan",
      items: hasPermission(actor, "sales.read")
        ? [
            {
              href: "/order-qr",
              label: "Order QR Pelanggan (Inbox)",
              icon: "sales",
              badgeCount: pendingQrOrderCount?.cnt ?? 0,
              badgeTone: "warning",
            },
            {
              href: "/penjualan",
              label: "Quotation & Sales Order (SO)",
              icon: "sales",
              badgeCount: pendingSoCount?.cnt ?? 0,
              badgeTone: "emerald",
            },
          ]
        : [],
    },
    {
      id: "pemenuhan",
      groupTitle: "9. Pemenuhan & Gudang",
      items: hasPermission(actor, "fulfillment.pick_pack")
        ? [
            {
              href: "/pemenuhan",
              label: "Picking, Timbang & Packing",
              icon: "scale",
              badgeCount: activeFulCount?.cnt ?? 0,
              badgeTone: "warning",
            },
          ]
        : [],
    },
    {
      id: "pengiriman",
      groupTitle: "10. Pengiriman & Surat Jalan",
      items: hasPermission(actor, "delivery.execute")
        ? [
            {
              href: "/pengiriman",
              label: "Surat Jalan, Driver & POD",
              icon: "truck",
              badgeCount: activeDoCount?.cnt ?? 0,
              badgeTone: "neutral",
            },
          ]
        : [],
    },
    {
      id: "keuangan_piutang",
      groupTitle: "11. Faktur & Piutang (AR)",
      items: [
        ...(hasPermission(actor, "ar.invoice") || hasPermission(actor, "ar.read")
          ? [
              {
                href: "/faktur",
                label: "Faktur Penjualan & Nota Kredit",
                icon: "pricing" as const,
                badgeCount: unpaidInvCount?.cnt ?? 0,
                badgeTone: "warning" as const,
              },
              {
                href: "/piutang",
                label: "Buku Bantu Piutang & Aging AR",
                icon: "wallet" as const,
              },
            ]
          : []),
        ...(hasPermission(actor, "ar.collect")
          ? [
              {
                href: "/pembayaran",
                label: "Penerimaan Kas & Rekonsiliasi Bank",
                icon: "ledger" as const,
              },
            ]
          : []),
      ],
    },
    {
      id: "buku_besar",
      groupTitle: "12. Buku Besar",
      items: hasPermission(actor, "gl.read")
        ? [
            {
              href: "/buku-besar",
              label: "Jurnal Umum, COA & Rekonsiliasi",
              icon: "ledger",
            },
          ]
        : [],
    },
    {
      id: "pengguna",
      groupTitle: "13. Pengguna & Peran",
      items: hasPermission(actor, "users.read")
        ? [
              {
                href: "/pengguna",
                label: "Akun Pengguna & RBAC",
                icon: "users",
              },
            ]
          : [],
    },
    {
      id: "audit",
      groupTitle: "14. Audit & Pengaturan",
      items:
        hasPermission(actor, "audit.read") || hasPermission(actor, "settings.read")
          ? [
              {
                href: "/audit",
                label: "Jejak Audit & Kebijakan",
                icon: "audit",
              },
            ]
          : [],
    },
  ];
  const rawGroups = allNavGroups.filter((g) => g.items.length > 0);

  return (
    <AppShell
      actor={{
        id: actor.user.id,
        name: actor.user.name,
        username: actor.user.username,
        email: actor.user.email,
        roles: actor.roles.map((r) => ({
          roleCode: r.roleCode,
          roleName: r.roleName,
          warehouseId: r.warehouseId,
        })),
      }}
      navGroups={rawGroups}
      pendingApprovalsCount={pendingApprovals?.cnt ?? 0}
    >
      {children}
    </AppShell>
  );
}
