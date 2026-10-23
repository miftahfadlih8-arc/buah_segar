# Buku Panduan Operasional Produksi (Production Runbook)
## Fresh Distribution Business OS Bekasi

- **Dokumen**: `docs/production-runbook.md`
- **Klasifikasi**: Standard Operating Procedure (SOP) & Incident Response
- **Tanggal Efektif**: 21 Oktober 2026
- **Target Pembaca**: DevOps Engineer, Site Reliability Engineer (SRE), Warehouse Operations Lead, Finance Lead

---

## 1. Prosedur Penerapan Produksi (Deployment Order)

Setiap rilis versi baru ke lingkungan produksi harus mengikuti tahapan berurutan tanpa melompati langkah:

### Langkah 1: Pra-Penerapan (Pre-Deployment Checklist)
1. Buat cadangan penuh database produksi menggunakan `pg_dump -Fc`.
2. Verifikasi bahwa tidak ada pengguna aktif yang sedang memproses transaksi penerimaan (GRN) atau posting faktur (Invoicing).
3. Pastikan seluruh variabel lingkungan di `.env.production` terisi valid.

### Langkah 2: Migrasi Skema Database
Jalankan migrasi skema menggunakan runner migrasi Drizzle:
```bash
# Menjalankan migrasi Drizzle secara non-destruktif
npm run db:migrate
```
*Catatan: Drizzle ORM melacak migrasi di tabel `drizzle.__drizzle_migrations`. Jangan pernah mengubah skema secara manual via kueri DDL mentah.*

### Langkah 3: Seeding Master Data Awal (Jika Deployment Baru)
Jika inisialisasi lingkungan baru, jalankan seeding organisasi, bagan akun standar (COA), cabang Bekasi, dan user owner awal:
```bash
npm run db:seed
```

### Langkah 4: Build & Deployment Aplikasi Next.js
```bash
npm run build
npm run start
```

### Langkah 5: Pasca-Penerapan & Uji Verifikasi Operasional (Sanity Check)
1. Akses endpoint login `/masuk` dan verifikasi sesi autentikasi.
2. Periksa halaman dashboard inventaris `/stok` untuk memastikan data gudang terbaca normal.
3. Periksa audit log `/audit` untuk memastikan rekaman sistem berjalan aktif.

---

## 2. Prosedur Rollback Darurat (Emergency Rollback)

Jika terjadi anomali kritis pasca-deployment (misalnya kegagalan transaksi berantai atau crash aplikasi):

### 2.1 Rollback Kode Aplikasi
Segera arahkan trafik load balancer / container orchestrator kembali ke image atau commit stabil sebelumnya:
```bash
git checkout <previous-stable-tag>
npm run build
pm2 restart buah-bekasi-os
```

### 2.2 Rollback Database dari Backup Snapshot
Jika skema atau data mengalami korupsi yang tidak dapat diperbaiki:
```bash
# 1. Hentikan trafik aplikasi
pm2 stop buah-bekasi-os

# 2. Putuskan seluruh koneksi aktif ke database produksi
psql -U postgres -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'buah_prod' AND pid <> pg_backend_pid();"

# 3. Pulihkan dari dump snapshot cadangan pra-deployment
pg_restore -U postgres -d buah_prod --clean --if-exists /backups/pre_deploy_backup.dump

# 4. Verifikasi koneksi dan jalankan kembali aplikasi
pm2 start buah-bekasi-os
```

---

## 3. Panduan Penanganan Insiden Operasional (Incident Playbooks)

### 3.1 Insiden Selisih Timbang / Penolakan Barang Saat POD
- **Gejala**: Driver melaporkan pelanggan menolak sebagian buah karena bonyok, busuk, atau selisih timbangan saat penyerahan barang di lokasi pelanggan.
- **Prosedur**:
  1. Driver mencatat kuantitas fisik diterima (`deliveredQtyBase`) dan kuantitas ditolak (`rejectedQtyBase`) langsung pada form Proof of Delivery (POD) mobile.
  2. Sistem otomatis memperbarui status Surat Jalan (DO) menjadi `partially_delivered`.
  3. Staf penagihan **dilarang menerbitkan faktur untuk barang yang ditolak**. Faktur penjualan (Sales Invoice) hanya dibuat sebesar kuantitas yang benar-benar diterima pelanggan.
  4. Driver membawa kembali fisik buah yang ditolak ke gudang untuk proses QC Returns.

### 3.2 Insiden Klaim Retur Fisik vs Klaim Biaya Non-Fisik
- **Klaim Retur Fisik (Barang Kembali ke Gudang)**:
  - Wajib melewati inspeksi QC oleh petugas gudang.
  - Jika dinyatakan layak (`restock_available`): sistem mengeksekusi mutasi `reversal_in` ke batch asal dan membalik jurnal HPP (Dr 1140 / Cr 5100).
  - Jika dinyatakan rusak total (`write_off_loss`): fisik barang dibuang/dimusnahkan; sistem mengakui beban kerusakan (Dr 5200 / Cr 5100) tanpa menambah stok layak jual.
- **Klaim Non-Fisik (Diskon Kualitas / Koreksi Faktur)**:
  - Sistem melarang pembuatan mutasi kartu stok fiktif.
  - Penyelesaian dilakukan murni melalui penerbitan Credit Note (Dr 4100 / Cr 1130) yang disetujui Finance Manager.

### 3.3 Insiden Pelanggaran Pemisahan Tugas (SoD Violation Alert)
- **Gejala**: Sistem melempar kesalahan `ForbiddenError: Separation of duties violation` saat pengguna mencoba menyetujui klaim yang diajukannya sendiri.
- **Prosedur**:
  - Edukasi pengguna bahwa staf penginput klaim dilarang merangkap sebagai penilai/penyetuju.
  - Tugaskan staf supervisor atau manajer divisi operasional lain untuk meninjau bukti klaim di menu `/pengiriman`.

### 3.4 Insiden Lock Timeout atau Deadlock Transaksi Stok Paralel
- **Gejala**: Beberapa kasir/operator gudang melakukan picking dan reservasi batch yang sama pada milidetik yang bersamaan, menghasilkan error `55P03 lock_not_available` atau timeout.
- **Prosedur**:
  - Algoritma alokasi FEFO telah dilengkapi logika retry dengan *exponential backoff* dan kueri `SELECT ... FOR UPDATE SKIP LOCKED` pada antrean picking.
  - Jika deadlock tetap terjadi: identifikasi transaksi yang menggantung dengan kueri `pg_stat_activity` dan terminasi sesi blocking yang bermasalah.

### 3.5 Insiden Kegagalan Job Backup Otomatis
- **Gejala**: Notifikasi gagal backup harian dari cron job database.
- **Prosedur**:
  1. Periksa sisa ruang penyimpanan pada disk lokal dan cloud bucket (`df -h`).
  2. Jalankan perintah backup manual segera:
     ```bash
     pg_dump -U postgres -d buah_prod -Fc -f /backups/manual_emergency_$(date +%Y%m%d_%H%M%S).dump
     ```
  3. Verifikasi integritas berkas dump dengan `pg_restore -l <dump_file> | head -n 20`.

---

## 4. Matriks Eskalasi & Kontak Darurat (Escalation Matrix)

| Tingkat Urgensi | Jenis Insiden | Kontak Pertama | SLA Respon |
|---|---|---|:---:|
| **P1 - Kritis** | Seluruh sistem tidak dapat diakses / database down / korupsi data GL | SRE On-call / Lead Architect | < 15 Menit |
| **P2 - Mayor** | Gudang tidak dapat memproses picking/dispatch barang fresh | Operations Manager & Lead Dev | < 30 Menit |
| **P3 - Minor** | Kesalahan input harga / kendala cetak format surat jalan | Application Support Specialist | < 2 Jam |
| **P4 - Saran** | Penyesuaian layout laporan atau penambahan filter tabel | Product Owner | < 24 Jam |
