CREATE TABLE "customer_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"name" text NOT NULL,
	"role_title" text NOT NULL,
	"phone" text,
	"whatsapp" text,
	"email" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_credit_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"credit_note_no" text NOT NULL,
	"customer_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"invoice_id" text,
	"source_type" text NOT NULL,
	"issue_date" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_amount" numeric(18, 2) NOT NULL,
	"applied_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"unapplied_amount" numeric(18, 2) NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_credit_notes_credit_note_no_unique" UNIQUE("credit_note_no")
);
--> statement-breakpoint
CREATE TABLE "customer_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_no" text NOT NULL,
	"sales_order_id" text,
	"customer_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"invoice_date" text NOT NULL,
	"due_date" text NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"total_amount" numeric(18, 2) NOT NULL,
	"paid_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"credit_note_applied_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"outstanding_amount" numeric(18, 2) NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_invoices_invoice_no_unique" UNIQUE("invoice_no")
);
--> statement-breakpoint
CREATE TABLE "customer_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_no" text NOT NULL,
	"customer_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"invoice_id" text,
	"payment_type" text NOT NULL,
	"payment_method" text NOT NULL,
	"payment_date" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"applied_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"unapplied_amount" numeric(18, 2) NOT NULL,
	"verification_status" text DEFAULT 'pending_verification' NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"reference_no" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_payments_payment_no_unique" UNIQUE("payment_no")
);
--> statement-breakpoint
CREATE TABLE "price_list_history" (
	"id" text PRIMARY KEY NOT NULL,
	"price_list_id" text NOT NULL,
	"price_list_item_id" text,
	"change_type" text NOT NULL,
	"previous_snapshot" jsonb,
	"new_snapshot" jsonb NOT NULL,
	"reason" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_list_items" (
	"id" text PRIMARY KEY NOT NULL,
	"price_list_id" text NOT NULL,
	"product_id" text NOT NULL,
	"grade_id" text NOT NULL,
	"grade_code" text NOT NULL,
	"uom_code" text NOT NULL,
	"min_qty" numeric(14, 3) DEFAULT '1.000' NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"unit_price_base" numeric(18, 4) NOT NULL,
	"max_discount_pct" numeric(6, 2) DEFAULT '0.00' NOT NULL,
	"effective_from" text,
	"effective_to" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"price_tier" text NOT NULL,
	"customer_segment" text,
	"warehouse_id" text,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"effective_from" text NOT NULL,
	"effective_to" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_lists_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"sales_order_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" text NOT NULL,
	"grade_id" text NOT NULL,
	"grade_code" text NOT NULL,
	"ordered_uom_code" text NOT NULL,
	"ordered_qty" numeric(14, 3) NOT NULL,
	"uom_factor_to_base_snapshot" numeric(14, 4) DEFAULT '1.0000' NOT NULL,
	"ordered_qty_base" numeric(14, 3) NOT NULL,
	"reserved_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"fulfilled_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"price_list_id" text,
	"price_list_item_id" text,
	"list_unit_price" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"discount_pct" numeric(6, 2) DEFAULT '0.00' NOT NULL,
	"discount_amount_per_unit" numeric(18, 4) DEFAULT '0.0000' NOT NULL,
	"net_unit_price" numeric(18, 4) NOT NULL,
	"net_unit_price_base" numeric(18, 4) NOT NULL,
	"unit_cost_basis_base" numeric(18, 4) NOT NULL,
	"margin_pct" numeric(7, 2) NOT NULL,
	"min_margin_pct_snapshot" numeric(6, 2) NOT NULL,
	"is_below_min_margin" boolean DEFAULT false NOT NULL,
	"tax_code_snapshot" text NOT NULL,
	"tax_rate_pct_snapshot" numeric(5, 2) DEFAULT '0.00' NOT NULL,
	"line_gross_amount" numeric(18, 2) NOT NULL,
	"line_discount_amount" numeric(18, 2) NOT NULL,
	"line_net_amount" numeric(18, 2) NOT NULL,
	"line_tax_amount" numeric(18, 2) NOT NULL,
	"line_total_amount" numeric(18, 2) NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"so_number" text NOT NULL,
	"quotation_id" text,
	"customer_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"delivery_zone_id" text,
	"order_date" text NOT NULL,
	"requested_delivery_date" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"payment_terms_days" integer DEFAULT 0 NOT NULL,
	"is_credit_order" boolean DEFAULT false NOT NULL,
	"shipping_address_snapshot" text NOT NULL,
	"customer_segment_snapshot" text NOT NULL,
	"price_tier_snapshot" text NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"subtotal_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"discount_total_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"tax_total_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"shipping_fee_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"handling_fee_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"grand_total_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"requires_margin_approval" boolean DEFAULT false NOT NULL,
	"margin_approval_id" text,
	"requires_credit_approval" boolean DEFAULT false NOT NULL,
	"credit_approval_id" text,
	"reserve_stock_on_confirm" boolean DEFAULT true NOT NULL,
	"is_stock_reserved" boolean DEFAULT false NOT NULL,
	"is_invoiced" boolean DEFAULT false NOT NULL,
	"min_remaining_shelf_life_days" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"cancel_reason" text,
	"created_by" text NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_orders_so_number_unique" UNIQUE("so_number")
);
--> statement-breakpoint
CREATE TABLE "sales_quotation_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"sales_quotation_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" text NOT NULL,
	"grade_id" text NOT NULL,
	"grade_code" text NOT NULL,
	"ordered_uom_code" text NOT NULL,
	"ordered_qty" numeric(14, 3) NOT NULL,
	"uom_factor_to_base_snapshot" numeric(14, 4) DEFAULT '1.0000' NOT NULL,
	"ordered_qty_base" numeric(14, 3) NOT NULL,
	"price_list_id" text,
	"price_list_item_id" text,
	"list_unit_price" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"discount_pct" numeric(6, 2) DEFAULT '0.00' NOT NULL,
	"discount_amount_per_unit" numeric(18, 4) DEFAULT '0.0000' NOT NULL,
	"net_unit_price" numeric(18, 4) NOT NULL,
	"net_unit_price_base" numeric(18, 4) NOT NULL,
	"unit_cost_basis_base" numeric(18, 4) NOT NULL,
	"margin_pct" numeric(7, 2) NOT NULL,
	"min_margin_pct_snapshot" numeric(6, 2) NOT NULL,
	"is_below_min_margin" boolean DEFAULT false NOT NULL,
	"tax_code_snapshot" text NOT NULL,
	"tax_rate_pct_snapshot" numeric(5, 2) DEFAULT '0.00' NOT NULL,
	"line_gross_amount" numeric(18, 2) NOT NULL,
	"line_discount_amount" numeric(18, 2) NOT NULL,
	"line_net_amount" numeric(18, 2) NOT NULL,
	"line_tax_amount" numeric(18, 2) NOT NULL,
	"line_total_amount" numeric(18, 2) NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "sales_quotations" (
	"id" text PRIMARY KEY NOT NULL,
	"quotation_no" text NOT NULL,
	"customer_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"quote_date" text NOT NULL,
	"valid_until" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"payment_terms_days" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"subtotal_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"discount_total_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"tax_total_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"shipping_fee_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"handling_fee_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"grand_total_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"requires_margin_approval" boolean DEFAULT false NOT NULL,
	"margin_approval_id" text,
	"notes" text,
	"revision_no" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_quotations_quotation_no_unique" UNIQUE("quotation_no")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "assigned_warehouse_id" text;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_history" ADD CONSTRAINT "price_list_history_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_history" ADD CONSTRAINT "price_list_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_uom_code_uoms_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_ordered_uom_code_uoms_code_fk" FOREIGN KEY ("ordered_uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_price_list_item_id_price_list_items_id_fk" FOREIGN KEY ("price_list_item_id") REFERENCES "public"."price_list_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quotation_id_sales_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."sales_quotations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_delivery_zone_id_delivery_zones_id_fk" FOREIGN KEY ("delivery_zone_id") REFERENCES "public"."delivery_zones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_margin_approval_id_approvals_id_fk" FOREIGN KEY ("margin_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_credit_approval_id_approvals_id_fk" FOREIGN KEY ("credit_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_sales_quotation_id_sales_quotations_id_fk" FOREIGN KEY ("sales_quotation_id") REFERENCES "public"."sales_quotations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_ordered_uom_code_uoms_code_fk" FOREIGN KEY ("ordered_uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_price_list_item_id_price_list_items_id_fk" FOREIGN KEY ("price_list_item_id") REFERENCES "public"."price_list_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotations" ADD CONSTRAINT "sales_quotations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotations" ADD CONSTRAINT "sales_quotations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotations" ADD CONSTRAINT "sales_quotations_margin_approval_id_approvals_id_fk" FOREIGN KEY ("margin_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotations" ADD CONSTRAINT "sales_quotations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotations" ADD CONSTRAINT "sales_quotations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_contacts_customer_idx" ON "customer_contacts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_credit_notes_customer_status_idx" ON "customer_credit_notes" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "customer_invoices_customer_status_idx" ON "customer_invoices" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "customer_payments_customer_verif_idx" ON "customer_payments" USING btree ("customer_id","verification_status");--> statement-breakpoint
CREATE INDEX "price_list_history_list_idx" ON "price_list_history" USING btree ("price_list_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "price_list_items_unique_tier_uidx" ON "price_list_items" USING btree ("price_list_id","product_id","grade_id","uom_code","min_qty");--> statement-breakpoint
CREATE INDEX "price_list_items_product_grade_idx" ON "price_list_items" USING btree ("product_id","grade_id","uom_code");--> statement-breakpoint
CREATE INDEX "price_lists_lookup_idx" ON "price_lists" USING btree ("price_tier","customer_segment","is_active","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_order_lines_so_lineno_uidx" ON "sales_order_lines" USING btree ("sales_order_id","line_no");--> statement-breakpoint
CREATE INDEX "sales_order_lines_product_idx" ON "sales_order_lines" USING btree ("product_id","grade_id");--> statement-breakpoint
CREATE INDEX "sales_orders_customer_status_idx" ON "sales_orders" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "sales_orders_warehouse_status_idx" ON "sales_orders" USING btree ("warehouse_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_quotation_lines_sq_lineno_uidx" ON "sales_quotation_lines" USING btree ("sales_quotation_id","line_no");--> statement-breakpoint
CREATE INDEX "sales_quotations_customer_idx" ON "sales_quotations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sales_quotations_warehouse_status_idx" ON "sales_quotations" USING btree ("warehouse_id","status");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_assigned_warehouse_id_warehouses_id_fk" FOREIGN KEY ("assigned_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_pos_chk" CHECK ("min_qty" > 0 AND "unit_price" > 0 AND "unit_price_base" > 0 AND "max_discount_pct" >= 0 AND "max_discount_pct" <= 100);--> statement-breakpoint
ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_pos_chk" CHECK ("ordered_qty" > 0 AND "ordered_qty_base" > 0 AND "unit_price" > 0 AND "net_unit_price" >= 0 AND "net_unit_price_base" >= 0 AND "discount_pct" >= 0 AND "discount_pct" <= 100 AND "line_total_amount" >= 0);--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_pos_chk" CHECK ("ordered_qty" > 0 AND "ordered_qty_base" > 0 AND "reserved_qty_base" >= 0 AND "fulfilled_qty_base" >= 0 AND "unit_price" > 0 AND "net_unit_price" >= 0 AND "net_unit_price_base" >= 0 AND "discount_pct" >= 0 AND "discount_pct" <= 100 AND "line_total_amount" >= 0);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_totals_nonneg_chk" CHECK ("subtotal_amount" >= 0 AND "discount_total_amount" >= 0 AND "tax_total_amount" >= 0 AND "shipping_fee_amount" >= 0 AND "handling_fee_amount" >= 0 AND "grand_total_amount" >= 0);--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_amounts_chk" CHECK ("total_amount" >= 0 AND "paid_amount" >= 0 AND "credit_note_applied_amount" >= 0 AND "outstanding_amount" >= 0);--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_amounts_chk" CHECK ("amount" > 0 AND "applied_amount" >= 0 AND "unapplied_amount" >= 0);--> statement-breakpoint
ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_amounts_chk" CHECK ("total_amount" > 0 AND "applied_amount" >= 0 AND "unapplied_amount" >= 0);--> statement-breakpoint
CREATE TRIGGER trg_price_list_history_immutable
BEFORE UPDATE OR DELETE ON "price_list_history"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();
