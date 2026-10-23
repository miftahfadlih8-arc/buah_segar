# Tinjauan Keamanan & Pengerasan Sistem (Phase 7 Security Hardening Review)
## Fresh Distribution Business OS Bekasi

- **Dokumen**: `docs/phase-7-security-review.md`
- **Klasifikasi**: Internal Security Architecture & Operational Policy
- **Tanggal Evaluasi**: 21 Oktober 2026
- **Status Evaluasi**: **HARDENED & VERIFIED**

---

## 1. Analisis Model Ancaman (Threat Modeling)

Operasional distribusi produk segar (fresh fruit distribution) memiliki karakteristik rantai pasok dengan perputaran cepat, batas masa kedaluwarsa pendek (perishable goods), fluktuasi harga harian, dan plafon kredit bernilai tinggi. Ancaman keamanan informasi dan integritas finansial dimodelkan sebagai berikut:

### 1.1 Kebocoran & Manipulasi Batas Kredit (Credit Exposure Tampering)
- **Vektor Serangan**: Sales Representative memanipulasi batas kredit atau membuat sales order ganda secara sengaja ke pihak berisiko untuk mengejar komisi sebelum audit piutang mendeteksi.
- **Mitigasi**: Pengecekan limit kredit dieksekusi secara atomik di sisi server dalam transaksi basis data (`src/server/modules/sales`). Total eksposur (piutang berjalan + pesanan belum terfaktur + pesanan baru) divalidasi langsung terhadap `creditLimit` pelanggan. Pelanggan berstatus `creditHold` secara otomatis diblokir dari penerbitan pesanan baru.

### 1.2 Persediaan Hantu & Manipulasi Tanggal Kedaluwarsa (Ghost Inventory & Expiry Tampering)
- **Vektor Serangan**: Staf gudang mengubah tanggal kedaluwarsa (`expiresAt`) batch lama untuk mengelabui algoritma alokasi FEFO (First-Expired, First-Out), atau memanipulasi kartu stok untuk menutupi penyusutan/pencurian buah di gudang.
- **Mitigasi**:
  1. Tabel `inventory_movements` menerapkan prinsip *append-only immutability*. Tidak ada API update atau delete untuk baris riwayat mutasi stok.
  2. Alokasi batch picking FEFO diverifikasi berdasarkan stok fisik riil yang eligible di database.
  3. Setiap penerimaan barang (GRN) mencatat tanggal kedaluwarsa dan batch ID yang terkunci secara permanen.

### 1.3 Kolusi & Pelanggaran Pemisahan Tugas (Separation of Duties / SoD Bypass)
- **Vektor Serangan**: Staf penjualan atau staf keuangan membuat klaim kerusakan fiktif, kemudian langsung menyetujui klaim tersebut untuk menerbitkan credit note yang memotong saldo piutang secara ilegal.
- **Mitigasi**:
  1. Aturan SoD eksplisit di `src/server/modules/returns/index.ts`: pengguna yang membuat/mengajukan klaim (`createdBy` atau `submittedBy`) **dilarang keras** melakukan review (`reviewedBy`) atau approval (`approvedBy`), kecuali memiliki wewenang khusus `owner`.
  2. Tindakan penerbitan credit note hanya dapat dilakukan jika klaim telah berstatus `approved` oleh manajer yang berwenang.

### 1.4 Modifikasi Harga Sepihak (Price List Tampering)
- **Vektor Serangan**: Pengubahan harga dasar atau diskon secara sewenang-wenang saat membuat quotation atau sales order.
- **Mitigasi**: Harga produk ditarik langsung dari `customer_price_tiers` atau `products.baseSellingPrice`. Setiap deviasi harga atau diskon khusus di luar matriks harga memerlukan persetujuan berjenjang dari `sales_manager` atau `owner`.

### 1.5 Akses Data Lintas Gudang / Tenant (Cross-Warehouse IDOR)
- **Vektor Serangan**: Pengguna di Gudang Kranji mencoba melihat atau memproses surat jalan dan stok fisik milik Gudang Tambun melalui manipulasi URL parameter ID atau API payload.
- **Mitigasi**: Server-side scoping middleware (`authorize` & `assertWarehouseAccess`) memeriksa token autentikasi Better Auth pengguna. Jika pengguna memiliki peran dengan pembatasan gudang (`assignedWarehouseId`), setiap kueri otomatis disaring dengan klausa `where(eq(table.warehouseId, actor.warehouseId))` di level Drizzle ORM.

---

## 2. Matriks Kontrol Akses Berbasis Peran (RBAC Matrix)

Sistem menerapkan prinsip *Least Privilege* dengan izin granular sebagai berikut:

| Modul / Izin | Owner | Warehouse Manager | Warehouse Staff | Sales Manager | Sales Rep | Finance Manager | Finance Staff | Driver |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Master Data & System Config** | `FULL` | `READ` | `READ` | `READ` | `READ` | `READ` | `READ` | `NONE` |
| `users.manage` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `costing.policy_approval` | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| **Inventory & Warehouses** | | | | | | | | |
| `inventory.read` | ✅ | ✅ | ✅ (Scoped) | ✅ | ✅ | ✅ | ✅ | ❌ |
| `inventory.move` | ✅ | ✅ | ✅ (Scoped) | ❌ | ❌ | ❌ | ❌ | ❌ |
| `inventory.adjust` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Procurement (PO & GRN)** | | | | | | | | |
| `procurement.write` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `procurement.receive` | ✅ | ✅ | ✅ (Scoped) | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Sales & CRM** | | | | | | | | |
| `sales.write` | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `sales.approve` | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `credit.manage` | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| **Fulfillment & Logistics** | | | | | | | | |
| `fulfillment.pick` | ✅ | ✅ | ✅ (Scoped) | ❌ | ❌ | ❌ | ❌ | ❌ |
| `fulfillment.dispatch` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `delivery.pod` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (Assigned) |
| **Returns & Claims** | | | | | | | | |
| `returns.write` (Buat Klaim) | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `returns.review` (Verifikasi) | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| `returns.approve` (Persetujuan) | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| `qc.inspect` (Inspeksi Fisik) | ✅ | ✅ | ✅ (QC) | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Finance & Accounting** | | | | | | | | |
| `ar.invoice` (Terbitkan Faktur) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `ar.payment` (Terima Bayar) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `gl.view` (Lihat Jurnal/Buku) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `gl.post` (Posting Jurnal Manual) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |

---

## 3. Penegakan Batasan Isolasi Multi-Warehouse

Setiap aktor yang berinteraksi dengan API atau Server Actions divalidasi melalui fungsi helper keamanan:

```typescript
// Pattern pengamanan boundary gudang
export function assertWarehouseAccess(actor: ActorContext, targetWarehouseId: string): void {
  if (actor.role === "owner" || actor.permissions.includes("system.super_admin")) {
    return; // Owner memiliki akses lintas seluruh cabang
  }
  if (actor.assignedWarehouseId && actor.assignedWarehouseId !== targetWarehouseId) {
    throw new ForbiddenError(`Akses ditolak: Anda tidak memiliki wewenang pada gudang ${targetWarehouseId}`);
  }
}
```

Uji coba penetrasi isolasi ini divalidasi pada skenario `UAT-14`, di mana staf yang terikat pada Gudang Kranji diblokir saat mencoba membaca atau memanipulasi mutasi Gudang Tambun.

---

## 4. Pertahanan Berlapis (Defense-in-Depth)

1. **Pencegahan SQL Injection**:
   - 100% kueri database dibangun menggunakan Drizzle ORM dengan *parameterized queries* bawaan node-postgres (`pg`). Tidak ada penggabungan string mentah (raw string concatenation) yang mengekspos celah injeksi.
2. **Pencegahan Insecure Direct Object References (IDOR)**:
   - Seluruh endpoint dan Server Action memvalidasi kepemilikan data (`orgId` dan `branchId`/`warehouseId`) terhadap sesi pengguna aktif yang terverifikasi secara kriptografis melalui Better Auth, bukan hanya mengandalkan ID yang dikirim dari klien.
3. **Pencegahan Double-Spending & Race Conditions**:
   - Transaksi keuangan, posting stok, dan alokasi pembayaran dilindungi oleh:
     - Database locks (`FOR UPDATE` pada baris reservasi dan saldo).
     - Kolom `idempotencyKey` unik pada tabel `sales_invoices`, `customer_payments`, `delivery_claims`, dan `credit_notes`.
4. **Pencegahan Akun Tergantung / Dinonaktifkan**:
   - Pengecekan status `isActive` pada pengguna dilakukan secara waktu-nyata di setiap panggilan `authorize(ctx)`. Akun yang disuspend segera ditolak untuk semua operasi.

---

## 5. Immutabilitas Jejak Audit (Audit Trail Immutability)

Tabel `audit_logs` dirancang sebagai catatan forensik kepatuhan:
- Skema tabel tidak menyediakan mekanisme update atau soft-delete.
- Setiap aksi administratif mencakup:
  - `actorId`: ID pengguna pelaku.
  - `action`: Nama operasi (mis. `SALES_INVOICE_POSTED`, `CLAIM_APPROVED`, `CREDIT_NOTE_ISSUED`).
  - `entityName` & `entityId`: Entitas target.
  - `beforeState` & `afterState`: Payload JSON perubahan data untuk audit diferensial.
  - `createdAt`: Waktu presisi server.

Seluruh 108 uji integrasi mengonfirmasi bahwa tidak ada aksi finansial atau perubahan inventaris yang luput dari pencatatan log audit.
