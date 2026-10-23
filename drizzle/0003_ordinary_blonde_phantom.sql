CREATE TABLE "delivery_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_no" text NOT NULL,
	"pod_id" text NOT NULL,
	"delivery_order_id" text NOT NULL,
	"sales_order_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"claim_type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"discrepancy_qty_base" numeric(14, 3) NOT NULL,
	"estimated_claim_value" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"reason_code" text NOT NULL,
	"notes" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_claims_claim_no_unique" UNIQUE("claim_no")
);
--> statement-breakpoint
CREATE TABLE "delivery_order_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_order_id" text NOT NULL,
	"fulfillment_line_id" text NOT NULL,
	"sales_order_line_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" text NOT NULL,
	"grade_id" text NOT NULL,
	"grade_code" text NOT NULL,
	"uom_code" text NOT NULL,
	"shipped_qty" numeric(14, 3) NOT NULL,
	"shipped_qty_base" numeric(14, 3) NOT NULL,
	"delivered_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"shortage_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"damaged_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"refused_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"net_unit_price_base_snapshot" numeric(18, 4) NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "delivery_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"do_number" text NOT NULL,
	"fulfillment_id" text NOT NULL,
	"sales_order_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"delivery_zone_id" text,
	"driver_user_id" text,
	"driver_name" text,
	"vehicle_plate_no" text,
	"vehicle_type" text,
	"shipping_address_snapshot" text NOT NULL,
	"delivery_date" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"dispatched_by" text,
	"dispatched_at" timestamp with time zone,
	"in_transit_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_reason" text,
	"notes" text,
	"created_by" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_orders_do_number_unique" UNIQUE("do_number")
);
--> statement-breakpoint
CREATE TABLE "fulfillment_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"fulfillment_id" text NOT NULL,
	"fulfillment_line_id" text,
	"exception_type" text NOT NULL,
	"severity" text DEFAULT 'blocking' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"approval_id" text,
	"reason_code" text NOT NULL,
	"description" text NOT NULL,
	"resolution_notes" text,
	"reported_by" text NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfillment_pick_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"fulfillment_id" text NOT NULL,
	"fulfillment_line_id" text NOT NULL,
	"reservation_id" text,
	"warehouse_id" text NOT NULL,
	"location_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"product_id" text NOT NULL,
	"grade_id" text NOT NULL,
	"source_stock_status" text NOT NULL,
	"picked_qty_base" numeric(14, 3) NOT NULL,
	"unit_cost_base" numeric(18, 4) NOT NULL,
	"cost_outflow" numeric(18, 2) NOT NULL,
	"movement_id" text NOT NULL,
	"scanned_barcode" text,
	"picked_by" text NOT NULL,
	"picked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proof_of_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"pod_number" text NOT NULL,
	"delivery_order_id" text NOT NULL,
	"sales_order_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_role_or_id" text NOT NULL,
	"recipient_phone" text,
	"handover_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome_status" text NOT NULL,
	"total_shipped_qty_base" numeric(14, 3) NOT NULL,
	"total_delivered_qty_base" numeric(14, 3) NOT NULL,
	"total_discrepancy_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"delivery_notes" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proof_of_deliveries_pod_number_unique" UNIQUE("pod_number"),
	CONSTRAINT "proof_of_deliveries_delivery_order_id_unique" UNIQUE("delivery_order_id")
);
--> statement-breakpoint
CREATE TABLE "proof_of_delivery_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"pod_id" text NOT NULL,
	"delivery_order_line_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" text NOT NULL,
	"grade_id" text NOT NULL,
	"shipped_qty_base" numeric(14, 3) NOT NULL,
	"delivered_qty_base" numeric(14, 3) NOT NULL,
	"shortage_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"damaged_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"refused_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"discrepancy_reason_code" text,
	"discrepancy_notes" text
);
--> statement-breakpoint
CREATE TABLE "sales_fulfillment_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"fulfillment_id" text NOT NULL,
	"sales_order_line_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"ordered_product_id" text NOT NULL,
	"ordered_grade_id" text NOT NULL,
	"ordered_grade_code" text NOT NULL,
	"actual_product_id" text NOT NULL,
	"actual_grade_id" text NOT NULL,
	"actual_grade_code" text NOT NULL,
	"is_substitution" boolean DEFAULT false NOT NULL,
	"substitution_approval_id" text,
	"variance_approval_id" text,
	"ordered_uom_code" text NOT NULL,
	"ordered_qty" numeric(14, 3) NOT NULL,
	"uom_factor_to_base_snapshot" numeric(14, 4) DEFAULT '1.0000' NOT NULL,
	"ordered_qty_base" numeric(14, 3) NOT NULL,
	"previously_fulfilled_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"target_pick_qty_base" numeric(14, 3) NOT NULL,
	"picked_uom_code" text NOT NULL,
	"picked_qty" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"gross_weight_kg" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"tare_weight_kg" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"net_weight_kg" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"picked_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"packed_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"remaining_backorder_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"variance_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"variance_pct" numeric(7, 2) DEFAULT '0.00' NOT NULL,
	"net_unit_price_snapshot" numeric(18, 4) NOT NULL,
	"net_unit_price_base_snapshot" numeric(18, 4) NOT NULL,
	"line_cogs_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"backorder_status" text DEFAULT 'none' NOT NULL,
	"is_stock_issued" boolean DEFAULT false NOT NULL,
	"scanned_barcode" text,
	"picked_by" text,
	"picked_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "sales_fulfillments" (
	"id" text PRIMARY KEY NOT NULL,
	"fulfillment_no" text NOT NULL,
	"sales_order_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"fulfillment_date" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"is_partial_fulfillment" boolean DEFAULT false NOT NULL,
	"qty_tolerance_pct" numeric(6, 2) DEFAULT '5.00' NOT NULL,
	"packing_checklist" jsonb,
	"total_ordered_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"total_picked_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"total_packed_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"total_remaining_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL,
	"total_cogs_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"journal_entry_id" text,
	"picked_by" text,
	"picked_at" timestamp with time zone,
	"packed_by" text,
	"packed_at" timestamp with time zone,
	"notes" text,
	"created_by" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_fulfillments_fulfillment_no_unique" UNIQUE("fulfillment_no")
);
--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_pod_id_proof_of_deliveries_id_fk" FOREIGN KEY ("pod_id") REFERENCES "public"."proof_of_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_delivery_order_id_delivery_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."delivery_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_order_lines" ADD CONSTRAINT "delivery_order_lines_delivery_order_id_delivery_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."delivery_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_order_lines" ADD CONSTRAINT "delivery_order_lines_fulfillment_line_id_sales_fulfillment_lines_id_fk" FOREIGN KEY ("fulfillment_line_id") REFERENCES "public"."sales_fulfillment_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_order_lines" ADD CONSTRAINT "delivery_order_lines_sales_order_line_id_sales_order_lines_id_fk" FOREIGN KEY ("sales_order_line_id") REFERENCES "public"."sales_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_order_lines" ADD CONSTRAINT "delivery_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_order_lines" ADD CONSTRAINT "delivery_order_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_order_lines" ADD CONSTRAINT "delivery_order_lines_uom_code_uoms_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_fulfillment_id_sales_fulfillments_id_fk" FOREIGN KEY ("fulfillment_id") REFERENCES "public"."sales_fulfillments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_delivery_zone_id_delivery_zones_id_fk" FOREIGN KEY ("delivery_zone_id") REFERENCES "public"."delivery_zones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_dispatched_by_users_id_fk" FOREIGN KEY ("dispatched_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_exceptions" ADD CONSTRAINT "fulfillment_exceptions_fulfillment_id_sales_fulfillments_id_fk" FOREIGN KEY ("fulfillment_id") REFERENCES "public"."sales_fulfillments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_exceptions" ADD CONSTRAINT "fulfillment_exceptions_fulfillment_line_id_sales_fulfillment_lines_id_fk" FOREIGN KEY ("fulfillment_line_id") REFERENCES "public"."sales_fulfillment_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_exceptions" ADD CONSTRAINT "fulfillment_exceptions_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_exceptions" ADD CONSTRAINT "fulfillment_exceptions_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_exceptions" ADD CONSTRAINT "fulfillment_exceptions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_fulfillment_id_sales_fulfillments_id_fk" FOREIGN KEY ("fulfillment_id") REFERENCES "public"."sales_fulfillments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_fulfillment_line_id_sales_fulfillment_lines_id_fk" FOREIGN KEY ("fulfillment_line_id") REFERENCES "public"."sales_fulfillment_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_reservation_id_stock_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."stock_reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_movement_id_inventory_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_picked_by_users_id_fk" FOREIGN KEY ("picked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_of_deliveries" ADD CONSTRAINT "proof_of_deliveries_delivery_order_id_delivery_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."delivery_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_of_deliveries" ADD CONSTRAINT "proof_of_deliveries_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_of_deliveries" ADD CONSTRAINT "proof_of_deliveries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_of_deliveries" ADD CONSTRAINT "proof_of_deliveries_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_of_deliveries" ADD CONSTRAINT "proof_of_deliveries_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_of_delivery_lines" ADD CONSTRAINT "proof_of_delivery_lines_pod_id_proof_of_deliveries_id_fk" FOREIGN KEY ("pod_id") REFERENCES "public"."proof_of_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_of_delivery_lines" ADD CONSTRAINT "proof_of_delivery_lines_delivery_order_line_id_delivery_order_lines_id_fk" FOREIGN KEY ("delivery_order_line_id") REFERENCES "public"."delivery_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_of_delivery_lines" ADD CONSTRAINT "proof_of_delivery_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_of_delivery_lines" ADD CONSTRAINT "proof_of_delivery_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_fulfillment_id_sales_fulfillments_id_fk" FOREIGN KEY ("fulfillment_id") REFERENCES "public"."sales_fulfillments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_sales_order_line_id_sales_order_lines_id_fk" FOREIGN KEY ("sales_order_line_id") REFERENCES "public"."sales_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_ordered_product_id_products_id_fk" FOREIGN KEY ("ordered_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_ordered_grade_id_product_grades_id_fk" FOREIGN KEY ("ordered_grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_actual_product_id_products_id_fk" FOREIGN KEY ("actual_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_actual_grade_id_product_grades_id_fk" FOREIGN KEY ("actual_grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_substitution_approval_id_approvals_id_fk" FOREIGN KEY ("substitution_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_variance_approval_id_approvals_id_fk" FOREIGN KEY ("variance_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_ordered_uom_code_uoms_code_fk" FOREIGN KEY ("ordered_uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_picked_uom_code_uoms_code_fk" FOREIGN KEY ("picked_uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_picked_by_users_id_fk" FOREIGN KEY ("picked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_picked_by_users_id_fk" FOREIGN KEY ("picked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_packed_by_users_id_fk" FOREIGN KEY ("packed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_claims_so_idx" ON "delivery_claims" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "delivery_claims_warehouse_status_idx" ON "delivery_claims" USING btree ("warehouse_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_order_lines_do_lineno_uidx" ON "delivery_order_lines" USING btree ("delivery_order_id","line_no");--> statement-breakpoint
CREATE INDEX "delivery_orders_so_idx" ON "delivery_orders" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "delivery_orders_fulfillment_idx" ON "delivery_orders" USING btree ("fulfillment_id");--> statement-breakpoint
CREATE INDEX "delivery_orders_warehouse_status_idx" ON "delivery_orders" USING btree ("warehouse_id","status");--> statement-breakpoint
CREATE INDEX "fulfillment_exceptions_ful_status_idx" ON "fulfillment_exceptions" USING btree ("fulfillment_id","status");--> statement-breakpoint
CREATE INDEX "fulfillment_pick_allocations_line_idx" ON "fulfillment_pick_allocations" USING btree ("fulfillment_line_id");--> statement-breakpoint
CREATE INDEX "fulfillment_pick_allocations_batch_idx" ON "fulfillment_pick_allocations" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "proof_of_deliveries_so_idx" ON "proof_of_deliveries" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "proof_of_deliveries_warehouse_idx" ON "proof_of_deliveries" USING btree ("warehouse_id","outcome_status");--> statement-breakpoint
CREATE UNIQUE INDEX "proof_of_delivery_lines_pod_lineno_uidx" ON "proof_of_delivery_lines" USING btree ("pod_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_fulfillment_lines_ful_lineno_uidx" ON "sales_fulfillment_lines" USING btree ("fulfillment_id","line_no");--> statement-breakpoint
CREATE INDEX "sales_fulfillment_lines_sol_idx" ON "sales_fulfillment_lines" USING btree ("sales_order_line_id");--> statement-breakpoint
CREATE INDEX "sales_fulfillments_so_idx" ON "sales_fulfillments" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "sales_fulfillments_warehouse_status_idx" ON "sales_fulfillments" USING btree ("warehouse_id","status");--> statement-breakpoint
ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_non_negative_totals_chk" CHECK ("total_ordered_qty_base" >= 0 AND "total_picked_qty_base" >= 0 AND "total_packed_qty_base" >= 0 AND "total_remaining_qty_base" >= 0 AND "total_cogs_amount" >= 0 AND "qty_tolerance_pct" >= 0);--> statement-breakpoint
ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_non_negative_qty_chk" CHECK ("target_pick_qty_base" >= 0 AND "picked_qty_base" >= 0 AND "packed_qty_base" >= 0 AND "remaining_backorder_qty_base" >= 0 AND "gross_weight_kg" >= 0 AND "tare_weight_kg" >= 0 AND "net_weight_kg" >= 0);--> statement-breakpoint
ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_positive_qty_chk" CHECK ("picked_qty_base" > 0 AND "unit_cost_base" >= 0 AND "cost_outflow" >= 0);--> statement-breakpoint
ALTER TABLE "delivery_order_lines" ADD CONSTRAINT "delivery_order_lines_non_negative_qty_chk" CHECK ("shipped_qty_base" > 0 AND "delivered_qty_base" >= 0 AND "shortage_qty_base" >= 0 AND "damaged_qty_base" >= 0 AND "refused_qty_base" >= 0);--> statement-breakpoint
ALTER TABLE "proof_of_delivery_lines" ADD CONSTRAINT "proof_of_delivery_lines_non_negative_qty_chk" CHECK ("shipped_qty_base" > 0 AND "delivered_qty_base" >= 0 AND "shortage_qty_base" >= 0 AND "damaged_qty_base" >= 0 AND "refused_qty_base" >= 0);--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_non_negative_chk" CHECK ("discrepancy_qty_base" >= 0 AND "estimated_claim_value" >= 0);
