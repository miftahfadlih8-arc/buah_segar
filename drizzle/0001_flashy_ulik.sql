CREATE TABLE "fiscal_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gl_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"account_type" text NOT NULL,
	"normal_balance" text NOT NULL,
	"parent_code" text,
	"is_posting" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gl_accounts_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_no" text NOT NULL,
	"entry_date" text NOT NULL,
	"fiscal_period_id" text NOT NULL,
	"warehouse_id" text,
	"source_doc_type" text NOT NULL,
	"source_doc_id" text NOT NULL,
	"purpose" text NOT NULL,
	"memo" text NOT NULL,
	"is_reversal" boolean DEFAULT false NOT NULL,
	"reversal_of_entry_id" text,
	"costing_policy_status" text DEFAULT 'synthetic_dev_blocked_prod' NOT NULL,
	"total_debit" numeric(18, 2) NOT NULL,
	"total_credit" numeric(18, 2) NOT NULL,
	"posted_by" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_entry_no_unique" UNIQUE("entry_no")
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"journal_entry_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"account_code" text NOT NULL,
	"debit" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"credit" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"warehouse_id" text,
	"product_id" text,
	"batch_id" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"goods_receipt_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"purchase_order_line_id" text,
	"product_id" text NOT NULL,
	"is_substitution" boolean DEFAULT false NOT NULL,
	"substitution_approval_id" text,
	"over_tolerance_approval_id" text,
	"price_variance_approval_id" text,
	"received_uom_code" text NOT NULL,
	"package_count" integer DEFAULT 0 NOT NULL,
	"packaging_type_id" text,
	"gross_weight_kg" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"tare_weight_kg" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"net_weight_kg" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"accepted_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"trim_loss_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"rejected_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"actual_unit_cost_base" numeric(18, 4) NOT NULL,
	"billable_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"line_goods_cost" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"allocated_landed_cost" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"total_line_cost" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"grn_number" text NOT NULL,
	"purchase_order_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"receiving_location_id" text NOT NULL,
	"putaway_location_id" text NOT NULL,
	"quarantine_location_id" text,
	"supplier_delivery_note_no" text NOT NULL,
	"supplier_lot_ref" text,
	"vehicle_plate_no" text,
	"driver_name" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"harvested_at" timestamp with time zone,
	"arrival_temp_c" numeric(5, 1),
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"received_by" text NOT NULL,
	"posted_by" text,
	"posted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipts_grn_number_unique" UNIQUE("grn_number")
);
--> statement-breakpoint
CREATE TABLE "grading_results" (
	"id" text PRIMARY KEY NOT NULL,
	"goods_receipt_line_id" text NOT NULL,
	"line_type" text NOT NULL,
	"grade_id" text,
	"grade_code" text,
	"qty_base" numeric(14, 3) NOT NULL,
	"package_count" integer DEFAULT 0 NOT NULL,
	"reject_disposition" text,
	"reject_reason_code" text,
	"relative_value_multiplier_pct" numeric(6, 2),
	"allocated_cost_total" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"allocated_unit_cost" numeric(18, 4) DEFAULT '0.0000' NOT NULL,
	"graded_by" text NOT NULL,
	"graded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "landed_costs" (
	"id" text PRIMARY KEY NOT NULL,
	"goods_receipt_id" text NOT NULL,
	"cost_type" text NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_order_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" text NOT NULL,
	"expected_grade_code" text DEFAULT 'A' NOT NULL,
	"ordered_uom_code" text NOT NULL,
	"ordered_qty" numeric(14, 3) NOT NULL,
	"ordered_qty_base" numeric(14, 3) NOT NULL,
	"received_net_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"accepted_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"rejected_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"unit_price_base" numeric(18, 4) NOT NULL,
	"line_subtotal" numeric(18, 2) NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "purchase_order_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_order_id" text NOT NULL,
	"revision_no" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" text NOT NULL,
	"revised_by" text NOT NULL,
	"revised_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"po_number" text NOT NULL,
	"supplier_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"order_date" text NOT NULL,
	"expected_delivery_at" timestamp with time zone,
	"origin_region" text NOT NULL,
	"payment_terms_days" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"subtotal_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"tax_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"total_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"qty_tolerance_pct" numeric(6, 2) DEFAULT '5.00' NOT NULL,
	"price_variance_tolerance_pct" numeric(6, 2) DEFAULT '0.00' NOT NULL,
	"notes" text,
	"revision_no" integer DEFAULT 0 NOT NULL,
	"submitted_by" text,
	"submitted_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_po_number_unique" UNIQUE("po_number")
);
--> statement-breakpoint
CREATE TABLE "quality_inspections" (
	"id" text PRIMARY KEY NOT NULL,
	"goods_receipt_line_id" text NOT NULL,
	"brix_pct" numeric(5, 2),
	"firmness_score" integer,
	"ripeness_stage" text DEFAULT 'mengkal' NOT NULL,
	"temperature_c" numeric(5, 1),
	"pest_or_disease_found" boolean DEFAULT false NOT NULL,
	"bruising_pct" numeric(5, 2) DEFAULT '0.00' NOT NULL,
	"rot_pct" numeric(5, 2) DEFAULT '0.00' NOT NULL,
	"outcome" text NOT NULL,
	"rejection_reason_code" text,
	"rejection_notes" text,
	"evidence_urls" jsonb,
	"inspected_by" text NOT NULL,
	"inspected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weighings" (
	"id" text PRIMARY KEY NOT NULL,
	"goods_receipt_line_id" text NOT NULL,
	"sequence_no" integer DEFAULT 1 NOT NULL,
	"gross_weight_kg" numeric(14, 3) NOT NULL,
	"packaging_type_id" text,
	"package_count" integer DEFAULT 0 NOT NULL,
	"tare_source" text DEFAULT 'packaging_rule' NOT NULL,
	"tare_weight_kg" numeric(14, 3) NOT NULL,
	"net_weight_kg" numeric(14, 3) NOT NULL,
	"scale_ticket_ref" text,
	"weighed_by" text NOT NULL,
	"weighed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_code" text NOT NULL,
	"product_id" text NOT NULL,
	"grade_id" text NOT NULL,
	"grade_code" text NOT NULL,
	"supplier_id" text,
	"warehouse_id" text NOT NULL,
	"goods_receipt_id" text,
	"goods_receipt_line_id" text,
	"origin_region" text NOT NULL,
	"harvested_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"ripeness_stage" text DEFAULT 'mengkal' NOT NULL,
	"best_before_date" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"initial_qty_base" numeric(14, 3) NOT NULL,
	"unit_cost_base" numeric(18, 4) NOT NULL,
	"total_initial_cost" numeric(18, 2) NOT NULL,
	"costing_method" text DEFAULT 'lot_actual_rsv' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batches_batch_code_unique" UNIQUE("batch_code")
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"movement_no" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"location_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"product_id" text NOT NULL,
	"grade_id" text NOT NULL,
	"stock_status" text NOT NULL,
	"movement_type" text NOT NULL,
	"qty_delta_base" numeric(14, 3) NOT NULL,
	"unit_cost_base" numeric(18, 4) NOT NULL,
	"cost_delta" numeric(18, 2) NOT NULL,
	"source_doc_type" text NOT NULL,
	"source_doc_id" text NOT NULL,
	"source_line_id" text,
	"reason_code" text,
	"notes" text,
	"reversal_of_movement_id" text,
	"journal_entry_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_movement_no_unique" UNIQUE("movement_no")
);
--> statement-breakpoint
CREATE TABLE "stock_adjustment_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"stock_adjustment_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"location_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"product_id" text NOT NULL,
	"grade_id" text NOT NULL,
	"stock_status" text DEFAULT 'available' NOT NULL,
	"qty_delta_base" numeric(14, 3) NOT NULL,
	"unit_cost_base" numeric(18, 4) NOT NULL,
	"total_cost_delta" numeric(18, 2) NOT NULL,
	"reason_note" text
);
--> statement-breakpoint
CREATE TABLE "stock_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"adjustment_no" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"adjustment_category" text NOT NULL,
	"reason_code" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"approval_id" text,
	"journal_entry_id" text,
	"notes" text NOT NULL,
	"evidence_urls" jsonb,
	"requested_by" text NOT NULL,
	"posted_by" text,
	"posted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_adjustments_adjustment_no_unique" UNIQUE("adjustment_no")
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"id" text PRIMARY KEY NOT NULL,
	"warehouse_id" text NOT NULL,
	"location_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"product_id" text NOT NULL,
	"grade_id" text NOT NULL,
	"stock_status" text NOT NULL,
	"qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"unit_cost_base" numeric(18, 4) DEFAULT '0.0000' NOT NULL,
	"total_cost" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"stock_count_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"location_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"product_id" text NOT NULL,
	"grade_id" text NOT NULL,
	"stock_status" text DEFAULT 'available' NOT NULL,
	"system_qty_base" numeric(14, 3) NOT NULL,
	"counted_qty_base" numeric(14, 3) NOT NULL,
	"variance_qty_base" numeric(14, 3) NOT NULL,
	"unit_cost_base" numeric(18, 4) NOT NULL,
	"variance_cost" numeric(18, 2) NOT NULL,
	"reason_code" text
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" text PRIMARY KEY NOT NULL,
	"count_no" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"location_id" text,
	"count_date" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approval_id" text,
	"journal_entry_id" text,
	"notes" text,
	"counted_by" text NOT NULL,
	"posted_by" text,
	"posted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_counts_count_no_unique" UNIQUE("count_no")
);
--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"warehouse_id" text NOT NULL,
	"location_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"product_id" text NOT NULL,
	"grade_id" text NOT NULL,
	"source_doc_type" text NOT NULL,
	"source_doc_id" text NOT NULL,
	"reserved_qty_base" numeric(14, 3) NOT NULL,
	"fulfilled_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_fiscal_period_id_fiscal_periods_id_fk" FOREIGN KEY ("fiscal_period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_of_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_code_gl_accounts_code_fk" FOREIGN KEY ("account_code") REFERENCES "public"."gl_accounts"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_substitution_approval_id_approvals_id_fk" FOREIGN KEY ("substitution_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_over_tolerance_approval_id_approvals_id_fk" FOREIGN KEY ("over_tolerance_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_price_variance_approval_id_approvals_id_fk" FOREIGN KEY ("price_variance_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_received_uom_code_uoms_code_fk" FOREIGN KEY ("received_uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_packaging_type_id_packaging_types_id_fk" FOREIGN KEY ("packaging_type_id") REFERENCES "public"."packaging_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_receiving_location_id_warehouse_locations_id_fk" FOREIGN KEY ("receiving_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_putaway_location_id_warehouse_locations_id_fk" FOREIGN KEY ("putaway_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_quarantine_location_id_warehouse_locations_id_fk" FOREIGN KEY ("quarantine_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_results" ADD CONSTRAINT "grading_results_goods_receipt_line_id_goods_receipt_lines_id_fk" FOREIGN KEY ("goods_receipt_line_id") REFERENCES "public"."goods_receipt_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_results" ADD CONSTRAINT "grading_results_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_results" ADD CONSTRAINT "grading_results_graded_by_users_id_fk" FOREIGN KEY ("graded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_ordered_uom_code_uoms_code_fk" FOREIGN KEY ("ordered_uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_revisions" ADD CONSTRAINT "purchase_order_revisions_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_revisions" ADD CONSTRAINT "purchase_order_revisions_revised_by_users_id_fk" FOREIGN KEY ("revised_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_goods_receipt_line_id_goods_receipt_lines_id_fk" FOREIGN KEY ("goods_receipt_line_id") REFERENCES "public"."goods_receipt_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_inspected_by_users_id_fk" FOREIGN KEY ("inspected_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighings" ADD CONSTRAINT "weighings_goods_receipt_line_id_goods_receipt_lines_id_fk" FOREIGN KEY ("goods_receipt_line_id") REFERENCES "public"."goods_receipt_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighings" ADD CONSTRAINT "weighings_packaging_type_id_packaging_types_id_fk" FOREIGN KEY ("packaging_type_id") REFERENCES "public"."packaging_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighings" ADD CONSTRAINT "weighings_weighed_by_users_id_fk" FOREIGN KEY ("weighed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_goods_receipt_line_id_goods_receipt_lines_id_fk" FOREIGN KEY ("goods_receipt_line_id") REFERENCES "public"."goods_receipt_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_reversal_of_movement_id_inventory_movements_id_fk" FOREIGN KEY ("reversal_of_movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_stock_adjustment_id_stock_adjustments_id_fk" FOREIGN KEY ("stock_adjustment_id") REFERENCES "public"."stock_adjustments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_stock_count_id_stock_counts_id_fk" FOREIGN KEY ("stock_count_id") REFERENCES "public"."stock_counts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_counted_by_users_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_periods_year_month_uidx" ON "fiscal_periods" USING btree ("year","month");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_source_purpose_uidx" ON "journal_entries" USING btree ("source_doc_type","source_doc_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_reversal_of_uidx" ON "journal_entries" USING btree ("reversal_of_entry_id");--> statement-breakpoint
CREATE INDEX "journal_entries_date_idx" ON "journal_entries" USING btree ("entry_date");--> statement-breakpoint
CREATE INDEX "journal_entries_warehouse_idx" ON "journal_entries" USING btree ("warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_entry_lineno_uidx" ON "journal_lines" USING btree ("journal_entry_id","line_no");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("account_code");--> statement-breakpoint
CREATE INDEX "journal_lines_batch_idx" ON "journal_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_lines_grn_lineno_uidx" ON "goods_receipt_lines" USING btree ("goods_receipt_id","line_no");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_product_idx" ON "goods_receipt_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_po_idx" ON "goods_receipts" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_warehouse_status_idx" ON "goods_receipts" USING btree ("warehouse_id","status");--> statement-breakpoint
CREATE INDEX "grading_results_grn_line_idx" ON "grading_results" USING btree ("goods_receipt_line_id");--> statement-breakpoint
CREATE INDEX "landed_costs_grn_idx" ON "landed_costs" USING btree ("goods_receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_po_lineno_uidx" ON "purchase_order_lines" USING btree ("purchase_order_id","line_no");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_product_idx" ON "purchase_order_lines" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_revisions_po_rev_uidx" ON "purchase_order_revisions" USING btree ("purchase_order_id","revision_no");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_warehouse_status_idx" ON "purchase_orders" USING btree ("warehouse_id","status");--> statement-breakpoint
CREATE INDEX "quality_inspections_grn_line_idx" ON "quality_inspections" USING btree ("goods_receipt_line_id");--> statement-breakpoint
CREATE INDEX "weighings_grn_line_idx" ON "weighings" USING btree ("goods_receipt_line_id");--> statement-breakpoint
CREATE INDEX "batches_fefo_idx" ON "batches" USING btree ("product_id","warehouse_id","status","best_before_date","received_at");--> statement-breakpoint
CREATE INDEX "batches_grn_idx" ON "batches" USING btree ("goods_receipt_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_balance_key_idx" ON "inventory_movements" USING btree ("location_id","batch_id","stock_status");--> statement-breakpoint
CREATE INDEX "inventory_movements_source_idx" ON "inventory_movements" USING btree ("source_doc_type","source_doc_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_warehouse_created_idx" ON "inventory_movements" USING btree ("warehouse_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_adjustment_lines_adj_lineno_uidx" ON "stock_adjustment_lines" USING btree ("stock_adjustment_id","line_no");--> statement-breakpoint
CREATE INDEX "stock_adjustments_warehouse_status_idx" ON "stock_adjustments" USING btree ("warehouse_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_balances_loc_batch_status_uidx" ON "stock_balances" USING btree ("location_id","batch_id","stock_status");--> statement-breakpoint
CREATE INDEX "stock_balances_warehouse_product_idx" ON "stock_balances" USING btree ("warehouse_id","product_id","stock_status");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_count_lines_count_lineno_uidx" ON "stock_count_lines" USING btree ("stock_count_id","line_no");--> statement-breakpoint
CREATE INDEX "stock_counts_warehouse_status_idx" ON "stock_counts" USING btree ("warehouse_id","status");--> statement-breakpoint
CREATE INDEX "stock_reservations_source_idx" ON "stock_reservations" USING btree ("source_doc_type","source_doc_id");--> statement-breakpoint
CREATE INDEX "stock_reservations_batch_idx" ON "stock_reservations" USING btree ("batch_id","status");--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_nonneg_chk" CHECK ("qty_base" >= 0 AND "total_cost" >= 0 AND "unit_cost_base" >= 0);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "po_lines_qty_price_pos_chk" CHECK ("ordered_qty" > 0 AND "ordered_qty_base" > 0 AND "unit_price_base" >= 0 AND "received_net_qty_base" >= 0 AND "accepted_qty_base" >= 0 AND "rejected_qty_base" >= 0);--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "grn_lines_weights_nonneg_chk" CHECK ("gross_weight_kg" >= 0 AND "tare_weight_kg" >= 0 AND "net_weight_kg" >= 0 AND "accepted_qty_base" >= 0 AND "trim_loss_qty_base" >= 0 AND "rejected_qty_base" >= 0 AND "actual_unit_cost_base" >= 0);--> statement-breakpoint
ALTER TABLE "weighings" ADD CONSTRAINT "weighings_weights_chk" CHECK ("gross_weight_kg" > 0 AND "tare_weight_kg" >= 0 AND "net_weight_kg" > 0);--> statement-breakpoint
ALTER TABLE "grading_results" ADD CONSTRAINT "grading_results_qty_chk" CHECK ("qty_base" >= 0 AND "allocated_cost_total" >= 0 AND "allocated_unit_cost" >= 0);--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_qty_cost_chk" CHECK ("initial_qty_base" > 0 AND "unit_cost_base" >= 0 AND "total_initial_cost" >= 0);--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_nonzero_chk" CHECK ("qty_delta_base" <> 0 AND "unit_cost_base" >= 0);--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_totals_chk" CHECK ("total_debit" > 0 AND "total_credit" > 0 AND "total_debit" = "total_credit");--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_one_sided_chk" CHECK (("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0));--> statement-breakpoint
CREATE TRIGGER trg_inventory_movements_immutable
BEFORE UPDATE OR DELETE ON "inventory_movements"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();--> statement-breakpoint
CREATE TRIGGER trg_journal_entries_immutable
BEFORE UPDATE OR DELETE ON "journal_entries"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();--> statement-breakpoint
CREATE TRIGGER trg_journal_lines_immutable
BEFORE UPDATE OR DELETE ON "journal_lines"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();--> statement-breakpoint
CREATE TRIGGER trg_po_revisions_immutable
BEFORE UPDATE OR DELETE ON "purchase_order_revisions"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION verify_journal_entry_balance() RETURNS trigger AS $$
DECLARE
  v_debit numeric(18, 2);
  v_credit numeric(18, 2);
  v_count integer;
BEGIN
  SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0), COUNT(*)
    INTO v_debit, v_credit, v_count
    FROM "journal_lines"
   WHERE "journal_entry_id" = NEW."id";

  IF v_count < 2 THEN
    RAISE EXCEPTION 'Jurnal % wajib memiliki minimal 2 baris (ditemukan: %)', NEW."entry_no", v_count
      USING ERRCODE = '23514';
  END IF;

  IF v_debit <= 0 OR v_debit <> v_credit OR v_debit <> NEW."total_debit" OR v_credit <> NEW."total_credit" THEN
    RAISE EXCEPTION 'Jurnal % tidak seimbang (debit=%, credit=%, header_debit=%, header_credit=%)',
      NEW."entry_no", v_debit, v_credit, NEW."total_debit", NEW."total_credit"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_journal_entry_balanced
AFTER INSERT ON "journal_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_journal_entry_balance();
