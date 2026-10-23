/**
 * Canonical permission catalogue and default role mappings for the Bekasi Fresh Fruit BOS.
 */
export const PERMISSIONS = [
  // Catalog & UoM (#7)
  { code: "catalog.read", module: "catalog", description: "Lihat katalog buah, grade, kemasan, dan satuan (UoM)" },
  { code: "catalog.write", module: "catalog", description: "Tambah dan ubah produk, grade, kemasan, dan konversi satuan" },

  // Warehouses (#6 / Master)
  { code: "warehouse.read", module: "warehouse", description: "Lihat cabang, gudang, dan lokasi/zona penyimpanan" },
  { code: "warehouse.write", module: "warehouse", description: "Tambah dan ubah cabang, gudang, dan lokasi penyimpanan" },

  // Suppliers (#2)
  { code: "supplier.read", module: "supplier", description: "Lihat daftar petani, kebun, dan supplier" },
  { code: "supplier.read_bank", module: "supplier", description: "Lihat nomor rekening bank dan NPWP supplier" },
  { code: "supplier.write", module: "supplier", description: "Tambah dan ubah data supplier" },

  // Customers & CRM (#8)
  { code: "customer.read", module: "customer", description: "Lihat daftar pelanggan dan zona pengiriman" },
  { code: "customer.read_pii", module: "customer", description: "Lihat kontak lengkap dan alamat detail pelanggan" },
  { code: "customer.write", module: "customer", description: "Tambah dan ubah data pelanggan serta zona pengiriman" },
  { code: "customer.credit_manage", module: "customer", description: "Atur batas kredit (credit limit) dan status tahan kredit pelanggan" },

  // Procurement & Receiving (#3, #4, #5)
  { code: "procurement.read", module: "procurement", description: "Lihat Purchase Order (PO)" },
  { code: "procurement.write", module: "procurement", description: "Buat dan ubah Purchase Order" },
  { code: "procurement.approve", module: "procurement", description: "Setujui PO, substitusi barang, dan selisih harga beli" },
  { code: "receiving.read", module: "receiving", description: "Lihat penerimaan barang, penimbangan, QC, dan grading" },
  { code: "receiving.write", module: "receiving", description: "Catat penerimaan barang dan penimbangan" },
  { code: "qc.inspect", module: "receiving", description: "Lakukan inspeksi kualitas (QC) dan hasil grading buah" },

  // Inventory (#6)
  { code: "inventory.read", module: "inventory", description: "Lihat stok, batch, umur simpan, dan mutasi stok" },
  { code: "inventory.adjust", module: "inventory", description: "Ajukan penyesuaian stok, susut, rusak, dan stok opname" },
  { code: "inventory.approve", module: "inventory", description: "Setujui penyesuaian stok dan penghapusan barang rusak" },

  // Pricing & Sales (#9, #10)
  { code: "pricing.read", module: "pricing", description: "Lihat daftar harga dan aturan margin" },
  { code: "pricing.write", module: "pricing", description: "Ubah daftar harga grosir/ritel dan kuotasi pelanggan" },
  { code: "sales.read", module: "sales", description: "Lihat pesanan penjualan (Sales Order)" },
  { code: "sales.write", module: "sales", description: "Buat dan konfirmasi pesanan penjualan" },

  // Fulfillment & Delivery (#11, #12)
  { code: "fulfillment.pick_pack", module: "fulfillment", description: "Lakukan picking, timbang aktual, packing, dan dispatch" },
  { code: "delivery.execute", module: "delivery", description: "Jalankan rute pengiriman dan catat bukti terima (POD)" },

  // Finance, AR, AP, GL (#13, #14, #15)
  { code: "ar.read", module: "finance", description: "Lihat faktur pelanggan dan piutang usaha" },
  { code: "ar.invoice", module: "finance", description: "Buat, ubah, dan posting faktur penjualan serta nota kredit" },
  { code: "ar.collect", module: "finance", description: "Catat penerimaan pembayaran pelanggan dan setoran kasir" },
  { code: "ap.read", module: "finance", description: "Lihat tagihan supplier dan hutang usaha" },
  { code: "ap.pay", module: "finance", description: "Catat tagihan dan pembayaran ke supplier" },
  { code: "gl.read", module: "finance", description: "Lihat buku besar, jurnal, laba rugi, dan neraca" },
  { code: "gl.post", module: "finance", description: "Posting jurnal, jurnal pembalik (reversal), dan tutup periode" },

  // Returns & Claims (#16)
  { code: "returns.read", module: "returns", description: "Lihat keluhan pelanggan, retur, dan klaim supplier" },
  { code: "returns.write", module: "returns", description: "Catat keluhan, retur barang, dan klaim kualitas" },

  // Approvals, Users, Roles, Audit, Settings (#19, #20)
  { code: "approvals.read", module: "platform", description: "Lihat daftar permintaan persetujuan (approval)" },
  { code: "approvals.decide", module: "platform", description: "Setujui atau tolak permintaan pengecualian harga/kredit/stok" },
  { code: "users.read", module: "platform", description: "Lihat daftar pengguna dan penugasan peran" },
  { code: "users.manage", module: "platform", description: "Tambah pengguna, atur peran, dan nonaktifkan akun" },
  { code: "audit.read", module: "platform", description: "Lihat jejak audit (audit log) sistem" },
  { code: "settings.read", module: "platform", description: "Lihat pengaturan operasional sistem" },
  { code: "settings.manage", module: "platform", description: "Ubah pengaturan sistem dan kebijakan operasional" },
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number]["code"];

export interface RoleDefinition {
  code: string;
  name: string;
  description: string;
  permissions: readonly PermissionCode[];
}

const ALL_PERMISSIONS: readonly PermissionCode[] = PERMISSIONS.map((p) => p.code);

const READ_ONLY_PERMISSIONS: readonly PermissionCode[] = PERMISSIONS.filter((p) =>
  p.code.endsWith(".read"),
).map((p) => p.code);

export const SYSTEM_ROLES: readonly RoleDefinition[] = [
  {
    code: "owner",
    name: "Pemilik Bisnis",
    description: "Akses super-admin penuh tanpa batas ke seluruh modul, gudang, persetujuan, dan pengaturan sistem.",
    permissions: ALL_PERMISSIONS,
  },
  {
    code: "admin",
    name: "Administrator Sistem",
    description: "Akses super-admin penuh tanpa dibatasi role ke seluruh modul, gudang, persetujuan, dan pengaturan sistem.",
    permissions: ALL_PERMISSIONS,
  },
  {
    code: "procurement",
    name: "Staf Pembelian / Pengadaan",
    description: "Mengelola supplier, katalog buah, dan pembuatan Purchase Order.",
    permissions: [
      "catalog.read",
      "catalog.write",
      "supplier.read",
      "supplier.read_bank",
      "supplier.write",
      "procurement.read",
      "procurement.write",
      "receiving.read",
      "inventory.read",
      "returns.read",
      "returns.write",
    ],
  },
  {
    code: "warehouse",
    name: "Operator Gudang",
    description: "Menerima barang datang, menimbang, mengelola stok gudang, picking, packing, dan dispatch.",
    permissions: [
      "catalog.read",
      "supplier.read",
      "warehouse.read",
      "warehouse.write",
      "receiving.read",
      "receiving.write",
      "inventory.read",
      "inventory.adjust",
      "fulfillment.pick_pack",
      "delivery.execute",
      "returns.read",
      "returns.write",
    ],
  },
  {
    code: "qc",
    name: "Staf Kontrol Kualitas (QC)",
    description: "Melakukan inspeksi kualitas buah saat penerimaan, grading A/B/C, dan pemeriksaan barang retur/rusak.",
    permissions: [
      "catalog.read",
      "receiving.read",
      "qc.inspect",
      "inventory.read",
      "inventory.adjust",
      "returns.read",
      "returns.write",
    ],
  },
  {
    code: "sales",
    name: "Staf Penjualan",
    description: "Mengelola pelanggan, kuotasi harga, dan pesanan penjualan (Sales Order).",
    permissions: [
      "catalog.read",
      "customer.read",
      "customer.read_pii",
      "customer.write",
      "inventory.read",
      "pricing.read",
      "sales.read",
      "sales.write",
      "returns.read",
      "returns.write",
    ],
  },
  {
    code: "driver",
    name: "Kurir / Pengiriman",
    description: "Menjalankan pengiriman pesanan, mencatat bukti terima (POD), dan menerima pembayaran tunai saat kirim.",
    permissions: [
      "catalog.read",
      "customer.read",
      "customer.read_pii",
      "delivery.execute",
      "ar.collect",
      "returns.write",
    ],
  },
  {
    code: "cashier",
    name: "Kasir / Penagihan",
    description: "Mencatat pembayaran pelanggan, alokasi faktur, dan setoran tunai dari kurir.",
    permissions: [
      "catalog.read",
      "customer.read",
      "customer.read_pii",
      "ar.read",
      "ar.collect",
    ],
  },
  {
    code: "finance",
    name: "Staf Keuangan & Akuntansi",
    description: "Mengelola piutang, hutang supplier, daftar harga, batas kredit, buku besar, dan rekonsiliasi.",
    permissions: [
      "catalog.read",
      "supplier.read",
      "supplier.read_bank",
      "customer.read",
      "customer.read_pii",
      "customer.credit_manage",
      "procurement.read",
      "inventory.read",
      "pricing.read",
      "pricing.write",
      "sales.read",
      "ar.read",
      "ar.invoice",
      "ar.collect",
      "ap.read",
      "ap.pay",
      "gl.read",
      "gl.post",
      "returns.read",
      "approvals.read",
      "audit.read",
    ],
  },
  {
    code: "auditor",
    name: "Auditor / Manajer Baca-Saja",
    description: "Akses baca-saja ke seluruh data operasional, keuangan, dan log audit tanpa izin mengubah data.",
    permissions: [...READ_ONLY_PERMISSIONS, "supplier.read_bank", "customer.read_pii"],
  },
] as const;
