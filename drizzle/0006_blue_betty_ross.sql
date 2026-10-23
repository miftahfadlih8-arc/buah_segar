CREATE TABLE "customer_order_request_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_request_id" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_id" text,
	"actor_role" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_order_request_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"order_request_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" text NOT NULL,
	"product_name_snapshot" text NOT NULL,
	"grade_id" text NOT NULL,
	"grade_code_snapshot" text NOT NULL,
	"uom_code" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"subtotal" numeric(18, 2) NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_order_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"order_session_id" text,
	"customer_id" text NOT NULL,
	"warehouse_id" text NOT NULL,
	"customer_store_code_snapshot" text NOT NULL,
	"customer_store_name_snapshot" text NOT NULL,
	"shipping_address_snapshot" text NOT NULL,
	"total_items" integer NOT NULL,
	"subtotal_amount" numeric(18, 2) NOT NULL,
	"tax_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"total_amount" numeric(18, 2) NOT NULL,
	"payment_method" text DEFAULT 'qris_statis' NOT NULL,
	"payment_proof_ref" text NOT NULL,
	"payment_proof_original_name" text,
	"payment_proof_mime" text NOT NULL,
	"payment_proof_size" integer NOT NULL,
	"payment_proof_uploaded_at" timestamp with time zone NOT NULL,
	"order_status" text DEFAULT 'pending_review' NOT NULL,
	"payment_status" text DEFAULT 'pending_verification' NOT NULL,
	"status_token" text NOT NULL,
	"rejection_reason" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"sales_order_id" text,
	"payment_verified_by" text,
	"payment_verified_at" timestamp with time zone,
	"payment_receipt_id" text,
	"customer_notes" text,
	"idempotency_key" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_order_requests_order_number_unique" UNIQUE("order_number"),
	CONSTRAINT "customer_order_requests_status_token_unique" UNIQUE("status_token"),
	CONSTRAINT "customer_order_requests_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "customer_order_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"session_token" text NOT NULL,
	"cart_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"payment_proof_ref" text,
	"payment_proof_original_name" text,
	"payment_proof_mime" text,
	"payment_proof_size" integer,
	"payment_proof_uploaded_at" timestamp with time zone,
	"customer_notes" text,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_order_sessions_session_token_unique" UNIQUE("session_token")
);
--> statement-breakpoint
ALTER TABLE "customer_order_request_events" ADD CONSTRAINT "customer_order_request_events_order_request_id_customer_order_requests_id_fk" FOREIGN KEY ("order_request_id") REFERENCES "public"."customer_order_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_request_lines" ADD CONSTRAINT "customer_order_request_lines_order_request_id_customer_order_requests_id_fk" FOREIGN KEY ("order_request_id") REFERENCES "public"."customer_order_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_request_lines" ADD CONSTRAINT "customer_order_request_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_request_lines" ADD CONSTRAINT "customer_order_request_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_request_lines" ADD CONSTRAINT "customer_order_request_lines_uom_code_uoms_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_requests" ADD CONSTRAINT "customer_order_requests_order_session_id_customer_order_sessions_id_fk" FOREIGN KEY ("order_session_id") REFERENCES "public"."customer_order_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_requests" ADD CONSTRAINT "customer_order_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_requests" ADD CONSTRAINT "customer_order_requests_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_requests" ADD CONSTRAINT "customer_order_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_requests" ADD CONSTRAINT "customer_order_requests_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_requests" ADD CONSTRAINT "customer_order_requests_payment_verified_by_users_id_fk" FOREIGN KEY ("payment_verified_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_sessions" ADD CONSTRAINT "customer_order_sessions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cust_order_req_events_order_idx" ON "customer_order_request_events" USING btree ("order_request_id");--> statement-breakpoint
CREATE INDEX "cust_order_req_events_type_idx" ON "customer_order_request_events" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "cust_order_req_lines_order_lineno_uidx" ON "customer_order_request_lines" USING btree ("order_request_id","line_no");--> statement-breakpoint
CREATE INDEX "cust_order_req_lines_product_idx" ON "customer_order_request_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "cust_order_req_customer_idx" ON "customer_order_requests" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "cust_order_req_status_idx" ON "customer_order_requests" USING btree ("order_status","payment_status");--> statement-breakpoint
CREATE INDEX "cust_order_req_order_no_idx" ON "customer_order_requests" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "cust_order_req_status_token_idx" ON "customer_order_requests" USING btree ("status_token");--> statement-breakpoint
CREATE INDEX "cust_order_req_created_idx" ON "customer_order_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "cust_order_sessions_customer_idx" ON "customer_order_sessions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "cust_order_sessions_token_idx" ON "customer_order_sessions" USING btree ("session_token");--> statement-breakpoint
CREATE INDEX "cust_order_sessions_status_exp_idx" ON "customer_order_sessions" USING btree ("status","expires_at");