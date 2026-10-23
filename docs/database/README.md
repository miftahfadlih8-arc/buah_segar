# Database Architecture, Supabase Schema & Clean Migration Runbook

Dokumen ini adalah panduan resmi untuk menginisialisasi database PostgreSQL kosong (baik lokal maupun proyek **Supabase PostgreSQL** baru) untuk **Fresh Distribution Business OS Bekasi (`buah-bekasi-os`)**.

---

## 1. Sumber Kebenaran Skema (Single Source of Truth)

Urutan otoritatif skema database aplikasi ini adalah:

1. **Definisi ORM Drizzle (`src/server/db/schema/*.ts`)** — 10 modul skema (`platform.ts`, `master.ts`, `procurement.ts`, `inventory.ts`, `gl.ts`, `sales.ts`, `fulfillment.ts`, `finance.ts`, `customer-orders.ts`, `index.ts`).
2. **Migrasi Berurutan (`drizzle/0000_*.sql` s/d `drizzle/0007_*.sql`)** — terdaftar pada `drizzle/meta/_journal.json` beserta trigger kustom PL/pgSQL, `CHECK` constraint, indeks unik ekspresi, dan hardening RLS Supabase.
3. **Berkas Bootstrap Tunggal (`docs/database/schema.sql`)** — dihasilkan secara deterministik dari seluruh berkas migrasi di `drizzle/` melalui:
   ```bash
   npm run db:schema-sql
   ```
   dan diverifikasi kesamaannya di CI/lokal melalui:
   ```bash
   npm run db:schema-sql:check
   ./scripts/verify-schema-sql.sh
   ```

> **PENTING:** Jangan mengedit `docs/database/schema.sql` secara manual. Setiap perubahan skema wajib melalui migrasi baru di `drizzle/` lalu jalankan `npm run db:schema-sql`.

---

## 2. Daftar Migrasi & Ringkasan Objek Database

| Urutan | Berkas Migrasi | SHA-256 (`drizzle.__drizzle_migrations.hash`) | `when` (`created_at`) | Cakupan |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `drizzle/0000_rapid_george_stacy.sql` | `ee36ec85b4081d780217cc84f2c956c527eb37795dcdfbd763f7ba583a5eb68e` | `1792515726847` | Phase 2: Better Auth (`users`, `sessions`, `accounts`, `verifications`), RBAC, `audit_logs`, `settings`, `idempotency_keys`, `document_sequences`, `approvals`, Master Data (`branches`, `warehouses`, `products`, `customers`, `suppliers`, dll.), fungsi `prevent_immutable_row_mutation()`, trigger append-only `audit_logs` & `settings`. |
| `1` | `drizzle/0001_flashy_ulik.sql` | `c7b6f8f98444765bd1ba25336c7df1618c5b9c6f79e775c6ed86562a0bd71fd8` | `1792517908238` | Phase 3: Procurement (`purchase_orders`, `goods_receipts`, `weighings`, `quality_inspections`, `grading_results`, `landed_costs`), Inventory (`batches`, `inventory_movements`, `stock_balances`, `stock_reservations`, `stock_adjustments`, `stock_counts`), GL (`gl_accounts`, `fiscal_periods`, `journal_entries`, `journal_lines`), fungsi & constraint trigger `verify_journal_entry_balance()`. |
| `2` | `drizzle/0002_peaceful_captain_cross.sql` | `5861e877eeed48af08cdf9a8361a2ac378400d2175d82b51a61a9e8a1f84cc2b` | `1792521804904` | Phase 4: CRM (`customer_contacts`), Pricing (`price_lists`, `price_list_items`, `price_list_history`), Sales (`sales_quotations`, `sales_orders`), Invoices/AR awal (`customer_invoices`, `customer_payments`, `customer_credit_notes`), trigger append-only `price_list_history`. |
| `3` | `drizzle/0003_ordinary_blonde_phantom.sql` | `65fba70dd3154387e097f2aab57514126e31e23fa3e4076905a3e1f5cf7eaec9` | `1792527322814` | Phase 5: Fulfillment (`sales_fulfillments`, `sales_fulfillment_lines`, `fulfillment_pick_allocations`, `fulfillment_exceptions`), Dispatch & POD (`delivery_orders`, `proof_of_deliveries`, `delivery_claims`). |
| `4` | `drizzle/0004_hot_peter_parker.sql` | `d3bb87d3e3e05455930f50928ca92c8742b3b2c244debddaf685dc6dd8c3840a` | `1792572392082` | Phase 6: Baris faktur & nota kredit (`customer_invoice_lines`, `customer_credit_note_lines`), alokasi pembayaran (`payment_allocations`), kas/bank & mutasi rekonsiliasi (`bank_accounts`, `bank_transactions`). |
| `5` | `drizzle/0005_tough_starhawk.sql` | `936701aac631338a55673f56abf807a0f07a6d1d92dadbb92239e3729b63895f` | `1792577560636` | Phase 7: Perluasan klaim & retur pasca-faktur pada `delivery_claims` (`pod_id` & `delivery_order_id` menjadi nullable, penambahan kolom `invoice_id`, `qc_status`, `restock_movement_id`, `cogs_reversal_journal_id`, `credit_note_id`, `idempotency_key`). |
| `6` | `drizzle/0006_blue_betty_ross.sql` | `2c5a2553c63792300b535e14930c0397785abe74a6dbb0e83a3b1b95add512f4` | `1792580105841` | Phase 8: Portal Pemesanan QR Pelanggan (`customer_order_sessions`, `customer_order_requests`, `customer_order_request_lines`, `customer_order_request_events`). |
| `7` | `drizzle/0007_supabase_rls_hardening.sql` | `4811a07c204ea17e00939e8da57f2d4fd09568c3693d29f99e39e516e17b3743` | `1792736394979` | Hardening Produksi Supabase: `ENABLE ROW LEVEL SECURITY` pada seluruh 74 tabel `public` (tanpa kebijakan permisif), pencabutan hak akses `anon` & `authenticated` pada skema `public`, serta penguncian `search_path = public, pg_temp` pada fungsi trigger PL/pgSQL. |

### Ringkasan Objek pada Skema Final

* **Tabel di skema `public`:** 74 tabel (0 baris data bisnis saat inisialisasi).
* **Tabel histori migrasi di skema `drizzle`:** `drizzle.__drizzle_migrations` (8 baris histori migrasi).
* **Fungsi PL/pgSQL:**
  1. `public.prevent_immutable_row_mutation()` — menolak `UPDATE` dan `DELETE` pada tabel buku besar/audit append-only (`ERRCODE = '55000'`).
  2. `public.verify_journal_entry_balance()` — memverifikasi setiap `journal_entries` memiliki minimal 2 baris `journal_lines` dan `SUM(debit) = SUM(credit) = total_debit = total_credit > 0` pada saat `COMMIT` (`ERRCODE = '23514'`).
* **Trigger:**
  * 7 trigger `BEFORE UPDATE OR DELETE`: `trg_audit_logs_immutable`, `trg_settings_immutable`, `trg_inventory_movements_immutable`, `trg_journal_entries_immutable`, `trg_journal_lines_immutable`, `trg_po_revisions_immutable`, `trg_price_list_history_immutable`.
  * 1 constraint trigger `AFTER INSERT DEFERRABLE INITIALLY DEFERRED`: `trg_journal_entry_balanced` pada `journal_entries`.
* **Row Level Security (RLS):** Aktif (`relrowsecurity = true`, `relforcerowsecurity = false`) pada seluruh 74 tabel `public`, dengan **0 policy** permisif.

---

## 3. Perbedaan & Ketentuan Khusus Supabase PostgreSQL

1. **Mode Koneksi (Wajib Session Pooler Port `5432` atau Direct Connection):**
   * Aplikasi menggunakan transaksi multi-pernyataan dan constraint trigger `DEFERRABLE INITIALLY DEFERRED` (`trg_journal_entry_balanced`).
   * Gunakan **Supabase Session Pooler (IPv4/IPv6 port `5432`)** atau **Direct Connection (port `5432`)**.
   * **JANGAN** gunakan Transaction Pooler (`port 6543` / `?pgbouncer=true`) untuk menjalankan migrasi ataupun transaksi jurnal akuntansi.
2. **Parameter SSL pada `node-postgres` (`pg@8.23.1`):**
   * Pada `pg-connection-string >= 2.14`, `?sslmode=require` diperlakukan setara `verify-full`.
   * Pada Supabase + Vercel, gunakan salah satu format berikut:
     * Dengan kompatibilitas libpq standar:
       ```text
       postgresql://postgres.<project-ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?uselibpqcompat=true&sslmode=require
       ```
     * Atau `sslmode=verify-full` dengan CA root Supabase terpasang.
3. **Keamanan Data API (PostgREST) & RLS (`0007_supabase_rls_hardening.sql`):**
   * Secara bawaan Supabase mengekspos skema `public` ke PostgREST (`anon` / `authenticated`).
   *Aplikasi ini **tidak** mengakses database dari browser melalui kunci `anon` Supabase; seluruh akses database berjalan di sisi server Next.js menggunakan role pemilik tabel (`postgres`).
   * Dengan `ENABLE ROW LEVEL SECURITY` (tanpa `FORCE`) dan pencabutan `GRANT` dari `anon` & `authenticated`:
     * Koneksi server-side sebagai pemilik tabel (`postgres`) tetap berjalan normal (owner mem-bypass RLS non-forced).
     * Segala akses melalui PostgREST / role non-owner otomatis ditolak (`0` baris terlihat pada `SELECT`, `42501 insufficient_privilege` pada `INSERT/UPDATE/DELETE`).
4. **Otentikasi Aplikasi (Better Auth vs `auth.users`):**
   * Otentikasi aplikasi menggunakan **Better Auth** dengan tabel `public.users`, `public.sessions`, `public.accounts`, dan `public.verifications`. Skema `auth.*` bawaan Supabase tidak digunakan dan tidak terpengaruh.
5. **Ekstensi PostgreSQL:**
   * Skema hanya membutuhkan fitur inti PostgreSQL 14+ (`plpgsql` dan indeks `btree`). Ekstensi bawaan Supabase di skema `extensions` (`pgcrypto`, `uuid-ossp`, `pg_stat_statements`) kompatibel penuh tanpa konflik.
6. **Catatan Pemotongan Nama Constraint (`NOTICE` 63 Karakter):**
   * Saat menjalankan `schema.sql` atau `db:migrate`, PostgreSQL menampilkan 22 pesan `NOTICE: identifier "..._fk" will be truncated to "..."`. Ini adalah perilaku standar PostgreSQL (`NAMEDATALEN = 64` byte) dan identik antara `schema.sql` serta `npm run db:migrate`.

---

## 4. Cara Menginisialisasi Database Kosong

Anda dapat memilih **Opsi A** (`schema.sql` sekali jalan) atau **Opsi B** (`npm run db:migrate`). Keduanya menghasilkan struktur tabel, indeks, constraint, fungsi, trigger, RLS, dan catatan `drizzle.__drizzle_migrations` yang **100% identik**.

### Opsi A — Inisialisasi Satu Langkah via `docs/database/schema.sql` (Direkomendasikan untuk Proyek Supabase Baru)

Via `psql`:
```bash
psql "postgresql://postgres.<project-ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require" \
  -X -v ON_ERROR_STOP=1 \
  -f docs/database/schema.sql
```
Atau tempel isi `docs/database/schema.sql` langsung ke **Supabase SQL Editor** lalu klik **Run**.

> **Pengaman Otomatis:** `docs/database/schema.sql` memiliki blok pemeriksaan di awal transaksi (`BEGIN; DO $$ ... $$`) yang akan membatalkan eksekusi jika tabel `public.users` atau `drizzle.__drizzle_migrations` sudah ada, sehingga tidak akan pernah menimpa database yang sudah berisi skema.

### Opsi B — Inisialisasi Bertahap via Migrator Drizzle (`npm run db:migrate`)

```bash
DATABASE_URL="postgresql://postgres.<project-ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?uselibpqcompat=true&sslmode=require" \
  npm run db:migrate
```

---

## 5. Bootstrap Sistem & Akun Pemilik Pertama (Tanpa Data Demo)

Setelah skema berhasil diterapkan pada database kosong:

### Langkah 1 — Semai Data Referensi Dasar Sistem (`db:seed-system`)
Menyemai matriks peran & izin RBAC (`admin`, `owner`, `procurement`, `warehouse`, `qc`, `sales`, `finance`, `customer_service`, `driver`), satuan ukur (UoM) & jenis kemasan standar, cabang/gudang utama Bekasi (`BKS1`), serta zona pengiriman Bekasi. **Tidak** membuat akun demo, pelanggan demo, produk demo, maupun transaksi.

```bash
DATABASE_URL="<postgresql-url-produksi>" npm run db:seed-system
```

### Langkah 2 — Buat Akun Pemilik Pertama (`setup:owner`)
Gunakan kata sandi kuat (minimal 12+ karakter acak direkomendasikan; sistem mewajibkan minimal 8 karakter):

```bash
DATABASE_URL="<postgresql-url-produksi>" \
BETTER_AUTH_SECRET="<secret-acak-minimal-32-karakter>" \
BETTER_AUTH_URL="https://<domain-produksi-anda>" \
OWNER_USERNAME="owner_utama" \
OWNER_NAME="Nama Pemilik Resmi" \
OWNER_EMAIL="owner@perusahaan-anda.id" \
OWNER_PASSWORD="<kata-sandi-kuat>" \
  npm run setup:owner
```

> **DILARANG di Produksi:** Jangan pernah menjalankan `npm run seed:dev` (`scripts/seed-dev-synthetic.ts`) terhadap database UAT/Produksi. Skrip tersebut memiliki guard yang menolak eksekusi bila `NODE_ENV=production` atau `APP_ENV=production`.

### Langkah 3 — Gate Kebijakan HPP (`costing.policy_approval`)
Secara bawaan pada database baru, pengaturan `costing.policy_approval` **belum ada / belum disetujui**. Sesuai aturan bisnis:
* Selama `approvedByOwner` dan `approvedByAccountant` belum bernilai `true`, setiap percobaan posting valuasi ke Buku Besar (GL) pada `NODE_ENV=production` akan **diblokir** (`BusinessRuleError`).
* Persetujuan dilakukan secara resmi oleh Pemilik dan Akuntan setelah verifikasi operasional.

---

## 6. Kueri Verifikasi Pasca-Migrasi

Jalankan kueri berikut di **Supabase SQL Editor** atau `psql` setelah migrasi:

```sql
-- 1. Pastikan 74 tabel aplikasi terbentuk di skema public
SELECT count(*) AS public_table_count
  FROM pg_tables
 WHERE schemaname = 'public';
-- Ekspektasi: 74

-- 2. Pastikan seluruh 8 migrasi (0000 s/d 0007) tercatat
SELECT id, hash, created_at
  FROM drizzle.__drizzle_migrations
 ORDER BY id;
-- Ekspektasi: 8 baris

-- 3. Pastikan RLS aktif (dan tidak forced) pada seluruh 74 tabel public
SELECT count(*) FILTER (WHERE NOT c.relrowsecurity) AS tables_without_rls,
       count(*) FILTER (WHERE c.relforcerowsecurity) AS tables_with_forced_rls
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind IN ('r', 'p');
-- Ekspektasi: tables_without_rls = 0, tables_with_forced_rls = 0

-- 4. Pastikan trigger immutability & jurnal berimbang terpasang (8 trigger)
SELECT tgname, tgrelid::regclass AS table_name
  FROM pg_trigger
 WHERE NOT tgisinternal
 ORDER BY tgname;
-- Ekspektasi: 8 baris (trg_audit_logs_immutable, trg_inventory_movements_immutable,
-- trg_journal_entries_immutable, trg_journal_entry_balanced, trg_journal_lines_immutable,
-- trg_po_revisions_immutable, trg_price_list_history_immutable, trg_settings_immutable)

-- 5. Pastikan TIDAK ADA akun demo atau transaksi sebelum bootstrap
SELECT (SELECT count(*) FROM public.users WHERE username LIKE '%_demo' OR email LIKE '%.test') AS demo_users,
       (SELECT count(*) FROM public.customers) AS customers_count,
       (SELECT count(*) FROM public.sales_orders) AS sales_orders_count,
       (SELECT count(*) FROM public.inventory_movements) AS movements_count,
       (SELECT count(*) FROM public.journal_entries) AS journals_count,
       (SELECT count(*) FROM public.customer_order_requests) AS qr_orders_count;
-- Ekspektasi: seluruh kolom = 0

-- 6. Pastikan gate costing.policy_approval belum disetujui secara diam-diam
SELECT key, value
  FROM public.settings
 WHERE key = 'costing.policy_approval';
-- Ekspektasi: 0 baris (atau approvedByOwner/approvedByAccountant belum keduanya true)
```

Untuk verifikasi otomatis lokal menggunakan database sementara (`_test`) tanpa menyentuh `buah_dev` atau `buah_test`:
```bash
./scripts/verify-schema-sql.sh
```

---

## 7. Rollback Migrasi `0007_supabase_rls_hardening`

Migrasi `0007` bersifat non-destruktif (tidak mengubah kolom atau data). Apabila atas persetujuan eksplisit Pemilik diperlukan pencabutan RLS pada skema `public`:

```sql
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', r.relname);
  END LOOP;
END
$$;
```
> **Peringatan Keamanan:** Menonaktifkan RLS pada Supabase akan kembali membuka akses tabel `public` ke PostgREST jika hak akses `anon` / `authenticated` diberikan kembali. Jangan jalankan di produksi tanpa pengganti kebijakan RLS per tabel.
