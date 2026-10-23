# Rencana & Laporan UAT Bisnis Akhir (Phase 7 Final Business UAT Plan)
## Fresh Distribution Business OS Bekasi

- **Dokumen**: `docs/phase-7-uat-plan.md`
- **Tanggal Pengujian**: 21 Oktober 2026
- **Lingkungan Uji**: `buah_test` (PostgreSQL 14 terisolasi)
- **Test Runner**: Vitest 5.0.5 (`tests/integration/phase7-uat-returns-security.test.ts`)
- **Status Eksekusi**: **108/108 Tests Passed (100% Lulus)** across 9 Test Files (20 Scenarios Phase 7 Passed)

---

## 1. Pendahuluan & Ruang Lingkup

Pengujian Penerimaan Pengguna Bisnis Akhir (Final Business UAT) bertujuan memvalidasi bahwa sistem operasional distribusi buah segar di Bekasi telah memenuhi seluruh aturan bisnis, alur rantai pasok dari hulu ke hilir, pengendalian mutu (QC), penyelesaian sengketa/klaim retur, kepatuhan akuntansi double-entry, serta kontrol keamanan data dan pemisahan wewenang (Separation of Duties).

Pengujian ini diverifikasi secara otomatis melalui suite integrasi end-to-end tanpa menggunakan data tiruan statis atau memotong logika bisnis yang berlaku.

---

## 2. Prekondisi & Lingkungan Uji

1. **Isolasi Database**: Pengujian dieksekusi eksklusif pada database `buah_test`. Tidak ada operasi destruktif yang menyentuh `buah_dev` atau production database.
2. **Skema & Migrasi**: Seluruh 6 migrasi Drizzle (`0000_massive_thunderbolts.sql` hingga `0005_tough_starhawk.sql`) telah diterapkan secara penuh.
3. **Master Data Awal**:
   - Organisasi: PT Suplayer Buah Bekasi (`org_bekasi_fresh`).
   - Cabang: Bekasi Pusat (`br_bekasi_utama`).
   - Gudang: Gudang Kranji (`wh_kranji_utama`) dan Gudang Tambun (`wh_tambun`).
   - Bagan Akun Standar (COA): Kas/Bank (1110/1120), Piutang Usaha (1130), Persediaan Buah (1140), Utang Dagang (2110), Pendapatan Penjualan (4100), Harga Pokok Penjualan (5100), Beban Kerusakan/Klaim (5200).
   - Pengguna & Peran: Super Owner, Warehouse Staff (`staff_wh`), Warehouse Manager (`mgr_wh`), Sales Rep (`sales_andi`), Finance Staff (`fin_staff`), Driver (`driver_budi`).
4. **Prinsip Immutabilitas**: Seluruh mutasi inventaris bersifat *append-only* melalui tabel `inventory_movements`, dan seluruh transaksi keuangan diposting ke `gl_journals` dan `gl_journal_lines` dengan prinsip debit = kredit seimbang (zero-variance).

---

## 3. Matriks Skenario UAT Bisnis End-to-End

Berikut adalah 20 skenario bisnis yang diuji dalam test suite [`tests/integration/phase7-uat-returns-security.test.ts`](file:///Users/test/Documents/ai%20mode%20/Suplayer%20buah%20bekasi/tests/integration/phase7-uat-returns-security.test.ts):

| No | Kode Skenario | Deskripsi Skenario Bisnis | Modul Terkait | Hasil Diharapkan | Hasil Aktual | Status |
|---|---|---|---|---|---|---|
| 1 | `UAT-01` | Pengadaan Mangga Arumanis Grade A dari Petani, Penerimaan Gudang, Batching FEFO, dan Landed Costing | Procurement, Inventory, Costing, GL | PO diproses, GRN dibuat, batch tercatat dengan masa simpan, inventaris bertambah di `wh_kranji_utama`, jurnal persediaan & akrual seimbang | Batch berhasil dibuat dengan `costPerBaseUnit = Rp 25.000`, status GRN received, GL Dr 1140 / Cr 2120 seimbang | **PASS** |
| 2 | `UAT-02` | Sales Order Multi-Item ke Jaringan Supermarket dengan Termin 30 Hari dan Pengecekan Batas Kredit | CRM, Sales, Credit Control | Validasi limit kredit pelanggan (Rp 50.000.000), SO disetujui, reservasi stok awal dibuat tanpa mengurangi stok fisik | SO disetujui, `reservedQty` tercatat, exposure kredit terhitung akurat | **PASS** |
| 3 | `UAT-03` | Reservasi Stok, Pemenuhan Parsial karena Kelayakan Batch, dan Pencatatan Backorder | Fulfillment, FEFO, Inventory | Batch dengan sisa umur simpan < minimum tolak alokasi; picking hanya mengambil batch eligible; sisa pesanan menjadi backorder | Picking alokasi 80 kg dari pesanan 100 kg, 20 kg tercatat sebagai backorder rapi | **PASS** |
| 4 | `UAT-04` | FEFO Picking, Packing, Dispatch, Surat Jalan (DO), dan Proof of Delivery (POD) Parsial | Warehouse, Logistics, Delivery | DO diterbitkan, status dispatched, driver menyerahkan barang; saat POD customer mencatat penolakan 2 krat (10 kg) bonyok | DO dispatched, POD mencatat `deliveredQtyBase = 70 kg`, `rejectedQtyBase = 10 kg` dengan alasan buah bonyok | **PASS** |
| 5 | `UAT-05` | Invoicing Berdasarkan Barang Diterima Aktual POD, Pajak PPN 11%, dan Pengakuan Piutang | Invoicing, Tax, AR Ledger, GL | Sales Invoice dibuat hanya untuk kuantitas bersih yang diterima (70 kg); jurnal AR diakui seimbang; AR subledger bertambah | Invoice diterbitkan sebesar Rp 2.331.000 (net diterima), GL Dr 1130 / Cr 4100 & Cr 2150 seimbang | **PASS** |
| 6 | `UAT-06` | Pengajuan Klaim Delivery Rejection, Verifikasi Supervisor, Approval Ops Manager, dan QC Pengembalian | Claims, Returns, Quality Control | Siklus klaim: `draft` -> `submitted` -> `under_review` -> `approved`; SoD mencegah submitter menyetujui klaim sendiri; inspeksi QC dilakukan | State machine berjalan ketat; SoD menolak approval oleh submitter; QC mencatat kondisi fisik | **PASS** |
| 7A | `UAT-07A` | Restock Barang Layak ke Inventaris Aktif dengan Jurnal Pembalikan HPP (COGS Reversal) | Returns, Inventory Ledger, GL | Barang lolos QC (`restock_available`) masuk kembali ke stok layak jual (`reversal_in`), jurnal HPP dibalik Dr 1140 / Cr 5100 | Stok bertambah 5 kg di batch asal, HPP dibalik Rp 125.000 secara seimbang | **PASS** |
| 7B | `UAT-07B` | Write-off Barang Rusak / Busuk Tanpa Restock dengan Jurnal Kerugian Operasional | Returns, Waste/Scrap, GL | Barang gagal QC (`write_off_loss`) tidak boleh masuk ke inventaris layak jual; biaya diakui ke akun kerugian Dr 5200 / Cr 5100 | Stok fisik tidak bertambah ke `available`; jurnal kerugian tercatat tanpa merusak saldo gudang | **PASS** |
| 8 | `UAT-08` | Penerbitan Credit Note Berdasarkan Klaim yang Disetujui dan Penyesuaian Saldo Piutang (AR) | Finance, Credit Notes, AR Ledger | Credit note sah diterbitkan terhadap invoice terkait; saldo piutang terpotong secara proporsional | CN berhasil dialokasikan, saldo invoice berkurang, AR subledger sinkron | **PASS** |
| 9 | `UAT-09` | Pelunasan Sisa Piutang via Transfer Bank, Rekonsiliasi Kas/Bank, dan Penutupan Invoice | Payments, Cash/Bank, Reconciliation | Pembayaran sisa tagihan dicatat, dialokasikan ke invoice; status invoice menjadi `paid`; mutasi bank terbit | Payment receipt diposting, invoice lunas, saldo bank bertambah, AR terhapus tuntas | **PASS** |
| 10 | `UAT-10` | Pencegahan Pemesanan Baru yang Melebihi Batas Kredit Pelanggan (Credit Limit Block) | CRM, Sales, Credit Enforcement | Pelanggan dengan piutang aktif + pesanan baru melebihi kredit maksimum wajib ditolak atau ditahan statusnya | `BusinessRuleError: Credit limit exceeded` dilempar dengan benar; SO diblokir | **PASS** |
| 11 | `UAT-11` | Pencegahan Bypass Approval Retur oleh Staf Penginput (Separation of Duties / SoD) | Returns, RBAC, Security Policy | Staf yang membuat klaim dilarang menyetujui klaimnya sendiri kecuali memiliki hak override Owner | Sistem melempar `ForbiddenError: Separation of duties violation`; klaim tetap `under_review` | **PASS** |
| 12 | `UAT-12` | Penegakan Aturan Append-Only: Percobaan Update/Delete Mutasi Stok Historis Ditolak | Inventory Ledger, Immutability | Tabel `inventory_movements` tidak memperkenankan mutasi diubah atau dihapus; penyesuaian harus melalui gerakan baru | Modifikasi langsung ditolak skema/aturan ledger; integritas kartu stok terjaga | **PASS** |
| 13 | `UAT-13` | Perlindungan Hard-Delete Faktur: Invoice Berstatus Posted Tidak Dapat Dihapus | Finance, Invoicing, Data Protection | Faktur penjualan yang telah terbit atau diposting dilarang dihapus dari basis data | Penghapusan faktur posted ditolak dengan `BusinessRuleError: Cannot delete posted invoice` | **PASS** |
| 14 | `UAT-14` | Isolasi Gudang Lintas Cabang: Staf Gudang Kranji Dilarang Mengakses Mutasi Gudang Tambun | Multi-warehouse, Multi-tenant, RBAC | Staf yang dibatasi pada `wh_kranji_utama` dilarang melihat atau memproses inventaris di `wh_tambun` | Akses lintas gudang menghasilkan `ForbiddenError: Warehouse access restricted` | **PASS** |
| 15 | `UAT-15` | Idempotensi Transaksi Finansial dan Logistik: Mencegah Double Posting dengan Idempotency Key | API, Idempotency Engine, Concurrency | Pengiriman ulang request pembuatan invoice, pembayaran, atau pergerakan stok dengan key identik mengembalikan hasil sama tanpa duplikasi | Request kedua mengembalikan rekaman awal, tidak ada jurnal tambahan atau pemotongan dobel | **PASS** |
| 16 | `UAT-16` | Rekonsiliasi Tiga Titik: Fisik Gudang vs Ledger Inventaris vs Buku Besar GL | Reconciliation Engine, GL, Inventory | Nilai total kuantitas dan rupiah pada kartu stok harus sama persis dengan saldo akun 1140 (Persediaan Buah) di GL | Selisih Rp 0,00 (Zero Variance) diverifikasi di seluruh batch dan transaksi | **PASS** |
| 17 | `UAT-17` | Rekonsiliasi Subledger Piutang Usaha (AR Subledger) vs Akun GL 1130 | AR Subledger, Balance Sheet, GL | Akumulasi sisa tagihan per pelanggan di tabel piutang harus cocok 100% dengan saldo akun GL 1130 | Selisih Rp 0,00 (Zero Variance) terbukti pada seluruh invoice aktif | **PASS** |
| 18 | `UAT-18` | Integritas Jejak Audit Immutabel: Verifikasi Seluruh Aksi Kritis Tercatat di Audit Logs | Security, Audit Trail, Compliance | Setiap aksi: approval, posting invoice, mutasi stok, penerbitan credit note, dan login terekam lengkap beserta aktor dan diff | Seluruh aksi UAT memiliki entri di `audit_logs` dengan user ID, action, entity, dan metadata valid | **PASS** |
| 19 | `UAT-19` | Pembatalan dan Pengembalian Alokasi Stok pada Order Batal Sebelum Dispatch | Fulfillment, FEFO Reservation | Sales order yang dibatalkan sebelum pengiriman harus melepaskan reservasi stok tanpa menciptakan mutasi fisik keluar | Reservasi dilepas, stok kembali tersedia penuh untuk order lain | **PASS** |
| 20 | `UAT-20` | Pencegahan Duplikasi Pengajuan Klaim atas Surat Jalan atau Item yang Sama | Claims, Deduplication, Integrity | Upaya mengajukan klaim berulang untuk kombinasi DO dan batch barang yang sudah memiliki klaim aktif/disetujui harus dicegah | Sistem menolak dengan `BusinessRuleError: Active claim already exists for this delivery item` | **PASS** |

---

## 4. Bukti Hasil Eksekusi Pengujian

Pengujian dijalankan langsung pada mesin pengembang dengan hasil aktual sebagai berikut:

```bash
$ npm run test
> buah-bekasi-os@0.1.0 test
> vitest run

 ✓ tests/integration/phase7-uat-returns-security.test.ts (20 tests) 4120ms
 ✓ tests/integration/phase6-invoicing-ar-settlement.test.ts (23 tests) 4785ms
 ✓ tests/integration/phase5-fulfillment-delivery-pod.test.ts (18 tests) 4310ms
 ✓ tests/integration/phase4-crm-pricing-sales-credit.test.ts (14 tests) 2520ms
 ✓ tests/integration/phase3-procurement-inventory-gl.test.ts (12 tests) 2410ms
 ✓ tests/integration/foundation.test.ts (5 tests) 1309ms
 ✓ tests/integration/master-data.test.ts (4 tests) 1271ms
 ✓ tests/unit/lib.test.ts (8 tests) 4ms
 ✓ tests/unit/costing.test.ts (4 tests) 5ms

 Test Files  9 passed (9)
      Tests  108 passed (108)
   Start at  17:42:21
   Duration  26.58s
```

## 5. Kesimpulan UAT

Semua 20 skenario penerimaan bisnis berhasil diselesaikan dengan hasil **100% LULUS (PASS)**.
Tidak ada cacat fungsional, kebocoran data antar-gudang, ketidakseimbangan jurnal umum, atau celah bypass pemisahan tugas yang ditemukan selama pengujian.
