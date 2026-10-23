CREATE TABLE "bank_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"account_type" text NOT NULL,
	"bank_name" text,
	"account_number" text,
	"holder_name" text,
	"gl_account_id" text NOT NULL,
	"warehouse_id" text,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"current_balance" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounts_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"bank_account_id" text NOT NULL,
	"transaction_date" text NOT NULL,
	"value_date" text,
	"reference_no" text,
	"description" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"direction" text NOT NULL,
	"matched_payment_id" text,
	"match_status" text DEFAULT 'unmatched' NOT NULL,
	"matched_at" timestamp with time zone,
	"matched_by" text,
	"discrepancy_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transactions_matched_payment_id_unique" UNIQUE("matched_payment_id")
);
--> statement-breakpoint
CREATE TABLE "customer_credit_note_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"credit_note_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" text NOT NULL,
	"product_name_snapshot" text NOT NULL,
	"grade_id" text NOT NULL,
	"grade_code_snapshot" text NOT NULL,
	"uom_code" text NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"line_total_amount" numeric(18, 2) NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "customer_invoice_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"sales_order_line_id" text,
	"delivery_order_line_id" text,
	"product_id" text NOT NULL,
	"product_name_snapshot" text NOT NULL,
	"grade_id" text NOT NULL,
	"grade_code_snapshot" text NOT NULL,
	"uom_code" text NOT NULL,
	"invoiced_qty" numeric(14, 3) NOT NULL,
	"invoiced_qty_base" numeric(14, 3) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"discount_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"tax_rate_pct" numeric(5, 2) DEFAULT '0.00' NOT NULL,
	"tax_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"line_net_amount" numeric(18, 2) NOT NULL,
	"line_total_amount" numeric(18, 2) NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"allocated_amount" numeric(18, 2) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reversal_reason" text,
	"reversed_at" timestamp with time zone,
	"reversed_by" text,
	"reversal_gl_journal_id" text,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"allocated_by" text NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "customer_credit_notes" ADD COLUMN "delivery_claim_id" text;--> statement-breakpoint
ALTER TABLE "customer_credit_notes" ADD COLUMN "applied_to_invoice_id" text;--> statement-breakpoint
ALTER TABLE "customer_credit_notes" ADD COLUMN "gl_journal_id" text;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD COLUMN "delivery_order_id" text;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD COLUMN "subtotal_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD COLUMN "discount_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD COLUMN "tax_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD COLUMN "gl_journal_id" text;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD COLUMN "posted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD COLUMN "posted_by" text;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD COLUMN "voided_by" text;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "bank_account_id" text;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "status" text DEFAULT 'posted' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "gl_journal_id" text;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "reversed_by" text;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "reversal_reason" text;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "reversal_gl_journal_id" text;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_gl_account_id_gl_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_matched_payment_id_customer_payments_id_fk" FOREIGN KEY ("matched_payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_matched_by_users_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_note_lines" ADD CONSTRAINT "customer_credit_note_lines_credit_note_id_customer_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."customer_credit_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_note_lines" ADD CONSTRAINT "customer_credit_note_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_note_lines" ADD CONSTRAINT "customer_credit_note_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_sales_order_line_id_sales_order_lines_id_fk" FOREIGN KEY ("sales_order_line_id") REFERENCES "public"."sales_order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_customer_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_allocated_by_users_id_fk" FOREIGN KEY ("allocated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_accounts_type_idx" ON "bank_accounts" USING btree ("account_type");--> statement-breakpoint
CREATE INDEX "bank_transactions_bank_date_idx" ON "bank_transactions" USING btree ("bank_account_id","transaction_date");--> statement-breakpoint
CREATE INDEX "bank_transactions_status_idx" ON "bank_transactions" USING btree ("match_status");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credit_note_lines_cn_lineno_uidx" ON "customer_credit_note_lines" USING btree ("credit_note_id","line_no");--> statement-breakpoint
CREATE INDEX "customer_credit_note_lines_cn_idx" ON "customer_credit_note_lines" USING btree ("credit_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_invoice_lines_inv_lineno_uidx" ON "customer_invoice_lines" USING btree ("invoice_id","line_no");--> statement-breakpoint
CREATE INDEX "customer_invoice_lines_invoice_idx" ON "customer_invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "customer_invoice_lines_product_idx" ON "customer_invoice_lines" USING btree ("product_id","grade_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_invoice_idx" ON "payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;