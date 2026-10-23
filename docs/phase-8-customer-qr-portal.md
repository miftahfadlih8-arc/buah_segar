# Dokumentasi Phase 8: Customer QR Order Portal + QR Generator
**Fresh Distribution Business OS Bekasi**

Dokumen ini mencatat seluruh arsitektur, implementasi teknis, skema basis data, sistem otorisasi, proteksi keamanan, dan hasil pengujian untuk Phase 8: Customer QR Order Portal & Store QR Generator.

---

## 1. Ringkasan Modul & Tujuan Bisnis

Phase 8 menghadirkan portal pemesanan buah mandiri ramah seluler (mobile-first) bagi pelanggan toko buah grosir dan ritel rekanan di wilayah Bekasi dan sekitarnya:
1. **Pemesanan Mandiri Pelanggan (Customer Self-Service):** Pelanggan dapat memindai QR code unik atau membuka tautan portal (`/order?store=KODE_TOKO`), memilih buah segar, mengisi keranjang belanja, melihat instruksi QRIS statis merchant resmi, mengunggah bukti pembayaran, serta mengirimkan pesanan langsung ke sistem.
2. **Nomor Pesanan Stabil & Pelacakan Real-time:** Setiap pesanan yang dikirimkan memperoleh nomor referensi deterministik berformat `#RQYYYYMMDDXXX` dan token status berkekuatan entropi tinggi (`statusToken`) untuk pelacakan live status tanpa celah IDOR (Insecure Direct Object References).
3. **Draft Session Anti-Reset:** Sesi belanja dan keranjang pelanggan tersimpan secara persisten pada server dan localStorage, menjamin draft keranjang tidak pernah hilang saat halaman dimuat ulang (refresh), navigasi bolak-balik antar layar (Screen 1–6), maupun ketika proses upload bukti transfer gagal dan dicoba ulang (retry).
4. **Perlindungan Terhadap Modifikasi Harga & Manipulasi Sisi Klien:** Seluruh harga satuan produk, diskon, margin, dan subtotal dihitung ulang 100% di server berdasarkan master price list aktif dan tier harga pelanggan terkait. Manipulasi parameter harga di sisi klien diabaikan secara mutlak.
5. **Integritas Inventaris Fisik & Keuangan:** Pembuatan order request tidak memotong stok fisik gudang dan tidak membuat jurnal GL/piutang secara prematur. Pemotongan stok dan pembentukan piutang hanya terjadi setelah pesanan diverifikasi dan dikonfirmasi oleh tim Sales & Finance ke dalam Sales Order resmi Phase 4–6.
6. **QR Generator Toko:** Halaman Admin `/qr-toko` menyediakan generator kode QR resmi berformat PNG dan SVG dengan URL basis resmi (`APP_BASE_URL`), tombol salin tautan, download aset gambar, dan lembar cetak standar toko A4.
7. **Pengaturan QRIS Merchant Resmi:** Konfigurasi QRIS statis terpusat dengan validasi audit trail, mencegah tampilan QR code dummy saat QRIS belum diaktifkan oleh manajemen.
8. **Admin / Sales Order Inbox:** Halaman `/order-qr` menyediakan antarmuka inbox bagi tim Sales dan Finance untuk memeriksa pesanan masuk, memverifikasi bukti transfer (disimpan privat), mengonfirmasi pesanan menjadi Sales Order, atau menolak dengan alasan wajib.

---

## 2. Customer Journey (8 Layar Sesuai Mockup UI)

Portal pelanggan dirancang dengan pendekatan mobile-first responsif (maksimal lebar kontainer 480px di desktop/mobile) mengacu persis pada alur mockup:

### Screen 1 — Masukkan Kode Toko
- Judul: "Pesan Buah dengan Mudah".
- Instruksi: "Masukkan kode toko yang diberikan oleh admin toko Anda."
- Validasi kode toko dijalankan di sisi server (`validateStoreCode`).
- Pesan kesalahan aman jika kode toko salah atau nonaktif: `"Kode toko tidak ditemukan atau tidak aktif. Silakan hubungi admin toko Anda."` (mencegah enumerasi toko / data leakage).
- Data sensitif pelanggan (alamat, telepon, piutang) tidak dibocorkan sebelum kode divalidasi.
- Jika URL mengandung parameter `?store=KODE_TOKO`, kode toko otomatis terisi dan divalidasi.

### Screen 2 — Pilih Buah
- Katalog buah aktif dari master data produk Bekasi (`products`, `product_grades`).
- Harga diambil dari *shared price list* tier grosir/ritel aktif yang berlaku untuk toko tersebut (`resolveActivePrice`).
- Ketersediaan stok disajikan secara indikatif: `"Tersedia"`, `"Stok Terbatas"`, atau `"Segera Hadir"`, tanpa membocorkan angka riil tonase/kg inventaris gudang.
- Fitur pencarian instan nama buah dan filter kategori (Jeruk, Apel, Mangga, Buah Tropis, dll.).
- Tombol aksi "+ Tambah" menambahkan item ke keranjang dan memperbarui badge counter keranjang.

### Screen 3 — Keranjang Belanja
- Daftar item pilihan dengan kontrol stepper kuantitas (`-` / `+`) dan input langsung.
- Input catatan spesifik per baris buah (misal: "Pilih yang kulitnya mulus / agak mengkal").
- Input catatan umum untuk pengiriman pesanan.
- Subtotal dan total dihitung ulang secara real-time.
- Tombol "Lanjut ke Pembayaran" mengarahkan ke Screen 4.

### Screen 4 — Pembayaran & QRIS Statis
- Total pembayaran yang harus ditransfer dalam format Rupiah.
- Tampilan QRIS Merchant Resmi Bekasi jika konfigurasi aktif (`getMerchantQrisConfig`).
- Nama Merchant dan NMID resmi.
- Jika QRIS belum diaktifkan oleh admin/finance, portal menampilkan peringatan aman `"QRIS merchant sedang dalam pemeliharaan. Silakan hubungi admin toko."` dan melarang keras tampilan kode QR dummy atau data tiruan.
- Instruksi langkah transfer bagi pelanggan.

### Screen 5 — Upload Bukti Pembayaran
- Area unggah foto bukti transfer (drag & drop / kamera / file picker).
- Validasi sisi server: tipe MIME (`image/jpeg`, `image/png`, `image/webp`), batas ukuran maksimal 5 MB, dan verifikasi magic bytes (tanda tangan biner file) untuk menangkal file eksekusi berbahaya bertopeng ekstensi gambar.
- Penyimpanan file di folder privat terlindung (`storage/private/proofs`), bukan direktori publik `public/`.
- Preview thumbnail gambar bukti pembayaran.
- Jika upload gagal, pesan kesalahan ditampilkan jelas dan keranjang belanja tetap utuh tanpa reset. Pelanggan dapat langsung mencoba ulang (*retry*).

### Screen 6 — Review dan Konfirmasi
- Ringkasan komprehensif pesanan: nama toko, alamat tujuan pengiriman, rincian buah yang dipesan, harga satuan, kuantitas, catatan, dan total nominal transfer.
- Indikator status bukti transfer yang telah terlampir.
- Tombol "Kirim Pesanan" dilengkapi *idempotency key* unik untuk menangkal submit ganda akibat penekanan tombol berulang atau gangguan jaringan.
- Setelah submit sukses, server mengembalikan nomor pesanan resmi `#RQYYYYMMDDXXX` dan token status privat.

### Screen 7 & 8 — Status Pesanan & Timeline Live
- Halaman pelacakan publik terlindung di `/order/status?token=STATUS_TOKEN`.
- Mencegah akses IDOR (tidak dapat diakses hanya dengan menebak nomor urut pesanan).
- Timeline status visual interaktif:
  1. *Pesanan Terkirim* (Menunggu Review Tim Sales & Finance).
  2. *Bukti Pembayaran Terverifikasi* (Dikonfirmasi oleh Finance).
  3. *Pesanan Dikonfirmasi* (Telah diterbitkan Sales Order resmi).
  4. *Diproses di Gudang* (Picking & Packing FEFO).
  5. *Dalam Pengiriman* (Delivery Order & Driver).
  6. *Selesai Diterima* (POD Terverifikasi).
- Jika pesanan ditolak oleh admin, status berubah menjadi "Pesanan Ditolak" disertai alasan penolakan yang transparan.

---

## 3. Database Schema & Migration (0006)

Modul Phase 8 menggunakan 4 tabel terisolasi dengan relasi kuat ke schema Phase 2–6:

```
+-------------------------------------------------------------------+
|                     customer_order_sessions                       |
|-------------------------------------------------------------------|
| id (PK, varchar)                                                  |
| session_token (unique, varchar)                                   |
| customer_id (FK -> customers.id)                                  |
| customer_store_code_snapshot (varchar)                            |
| status (enum: 'active' | 'submitted' | 'expired')                 |
| cart_items (jsonb)                                                |
| payment_proof_ref (varchar)                                       |
| payment_proof_original_name (varchar)                             |
| payment_proof_mime (varchar)                                      |
| payment_proof_size (int)                                          |
| payment_proof_uploaded_at (timestamptz)                           |
| customer_notes (text)                                             |
| last_active_at (timestamptz)                                      |
| expires_at (timestamptz)                                          |
| created_at, updated_at (timestamptz)                              |
+-------------------------------------------------------------------+
                                  | 1:N
                                  v
+-------------------------------------------------------------------+
|                     customer_order_requests                       |
|-------------------------------------------------------------------|
| id (PK, varchar)                                                  |
| order_number (unique, varchar, e.g. '#RQ20261021001')             |
| order_session_id (FK -> customer_order_sessions.id)               |
| customer_id (FK -> customers.id)                                  |
| warehouse_id (FK -> warehouses.id)                                |
| customer_store_code_snapshot (varchar)                            |
| customer_store_name_snapshot (varchar)                            |
| shipping_address_snapshot (text)                                  |
| total_items (int)                                                 |
| subtotal_amount, tax_amount, total_amount (numeric 15,2)          |
| payment_method (varchar, 'qris_statis')                           |
| payment_proof_ref, original_name, mime, size (private storage)    |
| payment_proof_uploaded_at (timestamptz)                           |
| order_status (enum: 'pending_review','confirmed','rejected',...)  |
| payment_status (enum: 'pending_verification','verified',...)      |
| status_token (unique, high-entropy token, varchar)                |
| rejection_reason (text)                                           |
| sales_order_id (FK -> sales_orders.id, nullable)                  |
| reviewed_by, reviewed_at (timestamptz)                            |
| payment_verified_by, payment_verified_at (timestamptz)            |
| customer_notes (text)                                             |
| idempotency_key (unique, varchar, nullable)                       |
| created_at, updated_at (timestamptz)                              |
+-------------------------------------------------------------------+
         | 1:N                                     | 1:N
         v                                         v
+-----------------------------------+   +-------------------------------+
|    customer_order_request_lines   |   | customer_order_request_events |
|-----------------------------------|   |-------------------------------|
| id (PK, varchar)                  |   | id (PK, varchar)              |
| order_request_id (FK)             |   | order_request_id (FK)         |
| line_no (int)                     |   | event_type (varchar)          |
| product_id (FK -> products.id)    |   | actor_id (varchar, nullable)  |
| product_name_snapshot (varchar)   |   | actor_role (varchar)          |
| grade_id (FK -> product_grades.id)|   | payload (jsonb)               |
| grade_code_snapshot (varchar)     |   | created_at (timestamptz)      |
| uom_code (varchar)                |   +-------------------------------+
| quantity, unit_price, subtotal    |
| notes (text)                      |
+-----------------------------------+
```

File migrasi yang diterapkan:
- [`drizzle/0006_blue_betty_ross.sql`](file:///Users/test/Documents/ai%20mode%20/Suplayer%20buah%20bekasi/drizzle/0006_blue_betty_ross.sql): DDL non-destruktif untuk membuat seluruh enum, tabel, foreign keys, dan indeks pendukung. Diterapkan pada `buah_dev` dan `buah_test`.

---

## 4. Keamanan, Otorisasi & Validasi

1. **Pencegahan IDOR (Insecure Direct Object Reference):**
   - Halaman status `/order/status` tidak menggunakan ID pesanan internal atau angka urut sederhana. Pelacakan diwajibkan menggunakan `statusToken` (24 bytes hex random biner dengan entropi tinggi).
2. **Penyimpanan Bukti Pembayaran Privat & Anti Path Traversal:**
   - Bukti transfer disimpan di `storage/private/proofs`.
   - File tidak disajikan lewat folder publik Next.js (`/public`).
   - Endpoint pengunduhan `/api/admin/proof/[orderId]` mewajibkan otentikasi sesi aktif dengan izin `sales.read` atau `ar.read`.
   - Fungsi `readPrivateProofFile` membungkus nama file dengan `path.basename` untuk mencegah serangan direktori traversal (`../`).
3. **Pemeriksaan Magic Bytes & Batas Ukuran File:**
   - File unggahan divalidasi hingga level byte: JPEG (`FF D8 FF`), PNG (`89 50 4E 47 0D 0A 1A 0A`), dan WEBP (`RIFF....WEBP`).
   - File biner yang melebihi 5 MB atau tidak sesuai tanda tangan ditolak seketika (`ValidationError`).
4. **Idempotency Control:**
   - Submit pesanan menggunakan `idempotencyKey` yang mengunci sesi dan mencegah pembuatan pesanan duplikat saat terjadi *double click* atau *retry network*.
5. **RBAC Strict:**
   - Hanya role dengan izin `ar.collect` atau `sales.write` yang dapat memverifikasi atau menolak bukti pembayaran.
   - Hanya role dengan izin `sales.write` yang dapat mengonfirmasi pesanan ke Sales Order resmi.
   - Update konfigurasi QRIS merchant diwajibkan memiliki izin `system.manage` atau `owner`.

---

## 5. Integrasi Ujung ke Ujung (Phase 2–6)

- **Sales Order Creation (Phase 4):**
  Saat staf Sales menekan tombol "Konfirmasi Pesanan" di `/order-qr`:
  - Sistem memanggil service `createSalesOrder` dari Phase 4.
  - Parameter `autoConfirm: true` dan `reserveStockOnConfirm: true` secara otomatis mengaktifkan reservasi stok FEFO (`stock_reservations`) dari gudang distribusi terkait tanpa intervensi manual.
  - Nomor Sales Order resmi (misal `SO/BKS1/...`) ditautkan ke record `customer_order_requests`.
- **Fulfillment & Delivery (Phase 5):**
  Sales Order hasil konfirmasi otomatis masuk ke antrean picking & packing gudang Bekasi (`/fulfillment`), siap diproses menjadi Surat Jalan / Delivery Order (DO) dan Proof of Delivery (POD).
- **Invoicing & Finance (Phase 6):**
  Setelah barang dikirim dan diterima via POD, tim Finance dapat menerbitkan faktur resmi (`/invoices`) dan mengalokasikan pembayaran kas/bank sesuai bukti QRIS yang telah diverifikasi.

---

## 6. Verifikasi Pengujian Otomatis (25 Skenario)

Seluruh skenario pengujian diimplementasikan pada [`tests/integration/phase8-customer-qr-orders.test.ts`](file:///Users/test/Documents/ai%20mode%20/Suplayer%20buah%20bekasi/tests/integration/phase8-customer-qr-orders.test.ts) dan dijalankan terhadap database terisolasi `buah_test`:

1. **Validasi kode toko aktif:** Menerima kode toko aktif dan menolak kode toko tidak valid/nonaktif dengan pesan aman tanpa kebocoran data.
2. **Katalog buah publik:** Mengambil katalog buah publik dengan harga aktif dari shared price list dan ketersediaan indikatif.
3. **Pengelolaan sesi draft:** Menambah/mengubah item dan mempertahankan isi keranjang saat refresh.
4. **Perhitungan ulang server:** Menghitung ulang harga dan subtotal di server dan mengabaikan manipulasi harga dari browser.
5. **Validasi upload bukti:** Memvalidasi upload bukti pembayaran (MIME, magic bytes, batas ukuran 5MB) dan menyimpannya di storage privat.
6. **Retry upload bukti:** Mempertahankan keranjang dan draft pesanan saat upload bukti pembayaran gagal lalu dicoba ulang.
7. **Submit pesanan idempoten:** Mencegah submit berulang dengan idempotency key dan menerbitkan No. Order stabil `#RQ...`.
8. **Pelacakan status aman:** Melacak status pesanan secara aman menggunakan high-entropy `statusToken` dan mencegah akses IDOR.
9. **Integritas stok fisik:** Memastikan stok fisik inventaris TIDAK berkurang saat draft atau order request dibuat.
10. **Integritas GL & Invoicing:** Memastikan order request tidak menciptakan jurnal GL atau faktur secara prematur.
11. **Otorisasi verifikasi pembayaran:** Memverifikasi alur verifikasi bukti pembayaran oleh role berwenang dan menolak role tanpa izin.
12. **Konversi ke Sales Order:** Mengonfirmasi pesanan QR pelanggan dan mengonversinya menjadi Sales Order resmi secara idempoten.
13. **Penolakan pesanan dengan alasan:** Menolak pesanan QR dengan alasan wajib dan mencatat penolakan pada status dan timeline.
14. **QR Generator toko:** Menghasilkan QR Code toko yang dapat dipindai (scannable) dalam format PNG dan SVG dengan base URL resmi.
15. **Manajemen QRIS merchant:** Mengelola konfigurasi QRIS merchant resmi terpusat dan mencegah tampilan QR dummy saat QRIS belum aktif.
16. **Edit kuantitas & catatan baris:** Mengedit kuantitas dan catatan per baris di cart session tanpa mereset draft.
17. **Proteksi path traversal:** Memvalidasi pembacaan file bukti privat dan memastikan pencegahan path traversal.
18. **Deaktivasi customer dinamis:** Menolak pembuatan sesi order baru saat customer dinonaktifkan secara dinamis.
19. **Pengecualian produk nonaktif:** Memastikan produk nonaktif otomatis dikecualikan dari katalog publik.
20. **Proteksi sesi tersubmit:** Mencegah modifikasi keranjang (cart) setelah pesanan berhasil disubmit.
21. **Audit events lifecycle:** Merekam seluruh riwayat audit events pada timeline siklus hidup pesanan.
22. **Penolakan bukti transfer:** Menolak verifikasi pembayaran bukti transfer dengan alasan penolakan yang tercatat.
23. **Reservasi stok FEFO:** Mengalokasikan reservasi stok FEFO secara otomatis saat pesanan dikonfirmasi sales.
24. **RBAC konfigurasi QRIS:** Menolak update konfigurasi QRIS merchant resmi dari pengguna tanpa wewenang.
25. **Filter status inbox admin:** Mendukung filter status pesanan pada inbox admin (`pending_review`, `confirmed`, `rejected`).
