# KPI Definitions & Calculation Reference

Every metric displayed on the Executive Dashboard and BI reports is computed strictly from posted database records. When no source transactions exist for a period, the UI displays **"Belum ada data"** — never invented or placeholder numbers.

| KPI Code | Label (Bahasa Indonesia) | Formula | Source Tables |
|---|---|---|---|
| `sales_net` | Penjualan Bersih | `SUM(invoice_lines.line_total) - SUM(credit_note_lines.line_total)` for issued documents in Jakarta business date range | `invoices`, `invoice_lines`, `credit_notes`, `credit_note_lines` |
| `gross_profit` | Laba Kotor | `sales_net - SUM(ABS(inventory_movements.total_cost))` where `movement_type = 'sale_issue'` | `invoices`, `inventory_movements` |
| `gross_margin_pct` | Margin Kotor (%) | `(gross_profit / sales_net) * 100` (NULL if `sales_net = 0`) | Derived |
| `stock_value` | Nilai Persediaan | `SUM(stock_balances.total_cost)` where `stock_status IN ('available', 'hold')` | `stock_balances` |
| `spoilage_rate_kg` | Tingkat Susut & Rusak (kg) | `SUM(ABS(qty_base))` for `spoilage`, `damage`, `weight_loss` divided by `opening_qty + received_accepted_qty` | `inventory_movements` |
| `supplier_accept_rate` | Tingkat Penerimaan Supplier (%) | `SUM(grading_results.qty_base WHERE outcome = 'graded') / SUM(goods_receipt_lines.net_kg)` | `goods_receipt_lines`, `grading_results` |
| `order_fill_rate` | Tingkat Pemenuhan Pesanan (%) | `SUM(delivered_accepted_qty_base) / SUM(ordered_est_qty_base)` for confirmed orders | `sales_order_lines`, `delivery_stops` |
| `ontime_delivery_rate` | Ketepatan Waktu Pengiriman (%) | `COUNT(stops delivered within window) / COUNT(delivered stops)` | `delivery_stops` |
| `ar_outstanding` | Piutang Usaha Belum Lunas | `SUM(invoices.total_amount - invoices.paid_amount - invoices.credited_amount)` for open invoices | `invoices` |
| `ap_outstanding` | Hutang Usaha ke Supplier | `SUM(supplier_invoices.total_amount - supplier_invoices.paid_amount - supplier_invoices.debited_amount)` | `supplier_invoices` |
| `repeat_customer_rate` | Pelanggan Berulang (%) | `COUNT(DISTINCT customer_id with >= 2 confirmed orders in period) / COUNT(DISTINCT customer_id with >= 1 confirmed order)` | `sales_orders` |
