-- =============================================================================
-- Fresh Distribution Business OS Bekasi — authoritative database bootstrap
-- GENERATED FILE — DO NOT EDIT BY HAND.
--   Source : drizzle/*.sql in drizzle/meta/_journal.json order
--   Regen  : npm run db:schema-sql        Check: npm run db:schema-sql:check
--
-- Contains schema only: tables, constraints, indexes, foreign keys, functions,
-- triggers, RLS enablement and Supabase grants hardening. It contains NO rows of
-- business data, NO users/accounts, NO settings (the costing.policy_approval gate
-- stays unapproved) and NO secrets.
--
-- Target: an EMPTY PostgreSQL 14+ database (local) or a NEW Supabase project
-- (SQL editor / psql as the `postgres` role). Runs in a single transaction and
-- aborts without changes if application tables already exist.
--
-- Migrations included:
--   0000_rapid_george_stacy.sql  sha256=ee36ec85b4081d780217cc84f2c956c527eb37795dcdfbd763f7ba583a5eb68e
--   0001_flashy_ulik.sql  sha256=c7b6f8f98444765bd1ba25336c7df1618c5b9c6f79e775c6ed86562a0bd71fd8
--   0002_peaceful_captain_cross.sql  sha256=5861e877eeed48af08cdf9a8361a2ac378400d2175d82b51a61a9e8a1f84cc2b
--   0003_ordinary_blonde_phantom.sql  sha256=65fba70dd3154387e097f2aab57514126e31e23fa3e4076905a3e1f5cf7eaec9
--   0004_hot_peter_parker.sql  sha256=d3bb87d3e3e05455930f50928ca92c8742b3b2c244debddaf685dc6dd8c3840a
--   0005_tough_starhawk.sql  sha256=936701aac631338a55673f56abf807a0f07a6d1d92dadbb92239e3729b63895f
--   0006_blue_betty_ross.sql  sha256=2c5a2553c63792300b535e14930c0397785abe74a6dbb0e83a3b1b95add512f4
--   0007_supabase_rls_hardening.sql  sha256=4811a07c204ea17e00939e8da57f2d4fd09568c3693d29f99e39e516e17b3743
-- =============================================================================

BEGIN;

-- Safety guard: refuse to run against a database that already has the app schema.
DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL
     OR to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    RAISE EXCEPTION 'schema.sql must only be applied to an EMPTY database (application tables or drizzle migration history already present). Use `npm run db:migrate` for existing databases.';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Migration 0000_rapid_george_stacy (74 statements)
-- -----------------------------------------------------------------------------
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"approval_type" text NOT NULL,
	"source_doc_type" text NOT NULL,
	"source_doc_id" text NOT NULL,
	"warehouse_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_reason" text NOT NULL,
	"rule_snapshot" jsonb,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"version" integer DEFAULT 1 NOT NULL
);

CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"actor_name" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"warehouse_id" text,
	"before_data" jsonb,
	"after_data" jsonb,
	"reason" text,
	"request_id" text,
	"ip_address" text
);

CREATE TABLE "document_sequences" (
	"doc_type" text NOT NULL,
	"warehouse_code" text NOT NULL,
	"period" text NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_sequences_doc_type_warehouse_code_period_pk" PRIMARY KEY("doc_type","warehouse_code","period")
);

CREATE TABLE "idempotency_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"idem_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"response_data" jsonb,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);

CREATE TABLE "permissions" (
	"code" text PRIMARY KEY NOT NULL,
	"module" text NOT NULL,
	"description" text NOT NULL
);

CREATE TABLE "role_permissions" (
	"role_id" text NOT NULL,
	"permission_code" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_code_pk" PRIMARY KEY("role_id","permission_code")
);

CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_code_unique" UNIQUE("code")
);

CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);

CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "user_role_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"warehouse_id" text,
	"assigned_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"username" text,
	"display_username" text,
	"phone" text,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);

CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "branches" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"city" text DEFAULT 'Bekasi' NOT NULL,
	"address" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branches_code_unique" UNIQUE("code")
);

CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"segment" text NOT NULL,
	"price_tier" text DEFAULT 'grosir' NOT NULL,
	"contact_person" text,
	"phone" text,
	"whatsapp" text,
	"email" text,
	"shipping_address" text NOT NULL,
	"billing_address" text,
	"delivery_zone_id" text,
	"payment_terms_days" integer DEFAULT 0 NOT NULL,
	"credit_limit" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"credit_hold" boolean DEFAULT false NOT NULL,
	"npwp" text,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"operational_consent" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_code_unique" UNIQUE("code")
);

CREATE TABLE "delivery_zones" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"city" text DEFAULT 'Bekasi' NOT NULL,
	"min_order_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"default_delivery_fee" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_zones_code_unique" UNIQUE("code")
);

CREATE TABLE "packaging_types" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"default_tare_kg" numeric(10, 3) DEFAULT '0.000' NOT NULL,
	"is_reusable" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packaging_types_code_unique" UNIQUE("code")
);

CREATE TABLE "product_grades" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"quality_rank" integer DEFAULT 1 NOT NULL,
	"min_weight_gram" integer,
	"max_defect_pct" numeric(5, 2),
	"price_multiplier_pct" numeric(6, 2) DEFAULT '100.00' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "product_uom_conversions" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"uom_code" text NOT NULL,
	"factor_to_base" numeric(14, 4) NOT NULL,
	"is_nominal" boolean DEFAULT true NOT NULL,
	"requires_actual_weight" boolean DEFAULT true NOT NULL,
	"default_packaging_type_id" text,
	"barcode" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"barcode" text,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"variety" text,
	"base_uom_code" text NOT NULL,
	"is_catch_weight" boolean DEFAULT true NOT NULL,
	"default_shelf_life_days" integer NOT NULL,
	"ripeness_tracking" boolean DEFAULT true NOT NULL,
	"storage_condition" text DEFAULT 'cold' NOT NULL,
	"tax_code" text DEFAULT 'PPN_EXEMPT' NOT NULL,
	"min_margin_pct" numeric(6, 2) DEFAULT '10.00' NOT NULL,
	"min_selling_price" numeric(18, 4) DEFAULT '0.0000' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku"),
	CONSTRAINT "products_barcode_unique" UNIQUE("barcode")
);

CREATE TABLE "suppliers" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"supplier_type" text NOT NULL,
	"origin_region" text NOT NULL,
	"contact_person" text,
	"phone" text,
	"address" text,
	"payment_terms_days" integer DEFAULT 0 NOT NULL,
	"bank_name" text,
	"bank_account_no" text,
	"bank_account_holder" text,
	"npwp" text,
	"lead_time_days" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_code_unique" UNIQUE("code")
);

CREATE TABLE "uoms" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"dimension" text NOT NULL,
	"is_base_allowed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "warehouse_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"warehouse_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"zone_type" text NOT NULL,
	"temperature_min_c" numeric(5, 1),
	"temperature_max_c" numeric(5, 1),
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "warehouses" (
	"id" text PRIMARY KEY NOT NULL,
	"branch_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouses_code_unique" UNIQUE("code")
);

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_code_permissions_code_fk" FOREIGN KEY ("permission_code") REFERENCES "public"."permissions"("code") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "settings" ADD CONSTRAINT "settings_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "customers" ADD CONSTRAINT "customers_delivery_zone_id_delivery_zones_id_fk" FOREIGN KEY ("delivery_zone_id") REFERENCES "public"."delivery_zones"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "product_grades" ADD CONSTRAINT "product_grades_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "product_uom_conversions" ADD CONSTRAINT "product_uom_conversions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "product_uom_conversions" ADD CONSTRAINT "product_uom_conversions_uom_code_uoms_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "product_uom_conversions" ADD CONSTRAINT "product_uom_conversions_default_packaging_type_id_packaging_types_id_fk" FOREIGN KEY ("default_packaging_type_id") REFERENCES "public"."packaging_types"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "products" ADD CONSTRAINT "products_base_uom_code_uoms_code_fk" FOREIGN KEY ("base_uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "warehouse_locations" ADD CONSTRAINT "warehouse_locations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;

CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");

CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status");

CREATE INDEX "approvals_source_idx" ON "approvals" USING btree ("source_doc_type","source_doc_id");

CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");

CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id");

CREATE INDEX "audit_logs_occurred_idx" ON "audit_logs" USING btree ("occurred_at");

CREATE UNIQUE INDEX "idempotency_scope_key_uidx" ON "idempotency_keys" USING btree ("scope","idem_key");

CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");

CREATE INDEX "settings_key_effective_idx" ON "settings" USING btree ("key","effective_from");

CREATE INDEX "user_role_assignments_user_idx" ON "user_role_assignments" USING btree ("user_id");

CREATE UNIQUE INDEX "user_role_unique_idx" ON "user_role_assignments" USING btree ("user_id","role_id","warehouse_id");

CREATE INDEX "users_status_idx" ON "users" USING btree ("status");

CREATE INDEX "customers_segment_idx" ON "customers" USING btree ("segment");

CREATE INDEX "customers_name_idx" ON "customers" USING btree ("name");

CREATE UNIQUE INDEX "product_grades_product_code_uidx" ON "product_grades" USING btree ("product_id","code");

CREATE UNIQUE INDEX "product_uom_conversions_uidx" ON "product_uom_conversions" USING btree ("product_id","uom_code");

CREATE INDEX "products_category_idx" ON "products" USING btree ("category");

CREATE INDEX "products_name_idx" ON "products" USING btree ("name");

CREATE INDEX "suppliers_type_idx" ON "suppliers" USING btree ("supplier_type");

CREATE UNIQUE INDEX "warehouse_locations_wh_code_uidx" ON "warehouse_locations" USING btree ("warehouse_id","code");

CREATE INDEX "warehouses_branch_idx" ON "warehouses" USING btree ("branch_id");

ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "user_role_coalesce_uidx" ON "user_role_assignments" ("user_id", "role_id", COALESCE("warehouse_id", '__GLOBAL__'));

ALTER TABLE "products" ADD CONSTRAINT "products_min_margin_nonneg_chk" CHECK ("min_margin_pct" >= 0);

ALTER TABLE "products" ADD CONSTRAINT "products_min_price_nonneg_chk" CHECK ("min_selling_price" >= 0);

ALTER TABLE "products" ADD CONSTRAINT "products_shelf_life_pos_chk" CHECK ("default_shelf_life_days" > 0);

ALTER TABLE "product_uom_conversions" ADD CONSTRAINT "product_uom_factor_pos_chk" CHECK ("factor_to_base" > 0);

ALTER TABLE "packaging_types" ADD CONSTRAINT "packaging_types_tare_nonneg_chk" CHECK ("default_tare_kg" >= 0);

ALTER TABLE "customers" ADD CONSTRAINT "customers_credit_limit_nonneg_chk" CHECK ("credit_limit" >= 0);

CREATE OR REPLACE FUNCTION prevent_immutable_row_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Tabel % bersifat append-only dan tidak boleh diubah atau dihapus (operasi: %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_logs_immutable
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();

CREATE TRIGGER trg_settings_immutable
BEFORE UPDATE OR DELETE ON "settings"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();

-- -----------------------------------------------------------------------------
-- Migration 0001_flashy_ulik (162 statements)
-- -----------------------------------------------------------------------------
CREATE TABLE "fiscal_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

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

CREATE TABLE "landed_costs" (
	"id" text PRIMARY KEY NOT NULL,
	"goods_receipt_id" text NOT NULL,
	"cost_type" text NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

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

CREATE TABLE "purchase_order_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_order_id" text NOT NULL,
	"revision_no" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" text NOT NULL,
	"revised_by" text NOT NULL,
	"revised_at" timestamp with time zone DEFAULT now() NOT NULL
);

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

ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_fiscal_period_id_fiscal_periods_id_fk" FOREIGN KEY ("fiscal_period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_of_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_code_gl_accounts_code_fk" FOREIGN KEY ("account_code") REFERENCES "public"."gl_accounts"("code") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_substitution_approval_id_approvals_id_fk" FOREIGN KEY ("substitution_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_over_tolerance_approval_id_approvals_id_fk" FOREIGN KEY ("over_tolerance_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_price_variance_approval_id_approvals_id_fk" FOREIGN KEY ("price_variance_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_received_uom_code_uoms_code_fk" FOREIGN KEY ("received_uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_packaging_type_id_packaging_types_id_fk" FOREIGN KEY ("packaging_type_id") REFERENCES "public"."packaging_types"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_receiving_location_id_warehouse_locations_id_fk" FOREIGN KEY ("receiving_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_putaway_location_id_warehouse_locations_id_fk" FOREIGN KEY ("putaway_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_quarantine_location_id_warehouse_locations_id_fk" FOREIGN KEY ("quarantine_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "grading_results" ADD CONSTRAINT "grading_results_goods_receipt_line_id_goods_receipt_lines_id_fk" FOREIGN KEY ("goods_receipt_line_id") REFERENCES "public"."goods_receipt_lines"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "grading_results" ADD CONSTRAINT "grading_results_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "grading_results" ADD CONSTRAINT "grading_results_graded_by_users_id_fk" FOREIGN KEY ("graded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_ordered_uom_code_uoms_code_fk" FOREIGN KEY ("ordered_uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "purchase_order_revisions" ADD CONSTRAINT "purchase_order_revisions_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "purchase_order_revisions" ADD CONSTRAINT "purchase_order_revisions_revised_by_users_id_fk" FOREIGN KEY ("revised_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_goods_receipt_line_id_goods_receipt_lines_id_fk" FOREIGN KEY ("goods_receipt_line_id") REFERENCES "public"."goods_receipt_lines"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_inspected_by_users_id_fk" FOREIGN KEY ("inspected_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "weighings" ADD CONSTRAINT "weighings_goods_receipt_line_id_goods_receipt_lines_id_fk" FOREIGN KEY ("goods_receipt_line_id") REFERENCES "public"."goods_receipt_lines"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "weighings" ADD CONSTRAINT "weighings_packaging_type_id_packaging_types_id_fk" FOREIGN KEY ("packaging_type_id") REFERENCES "public"."packaging_types"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "weighings" ADD CONSTRAINT "weighings_weighed_by_users_id_fk" FOREIGN KEY ("weighed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "batches" ADD CONSTRAINT "batches_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "batches" ADD CONSTRAINT "batches_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "batches" ADD CONSTRAINT "batches_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "batches" ADD CONSTRAINT "batches_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "batches" ADD CONSTRAINT "batches_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "batches" ADD CONSTRAINT "batches_goods_receipt_line_id_goods_receipt_lines_id_fk" FOREIGN KEY ("goods_receipt_line_id") REFERENCES "public"."goods_receipt_lines"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_reversal_of_movement_id_inventory_movements_id_fk" FOREIGN KEY ("reversal_of_movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_stock_adjustment_id_stock_adjustments_id_fk" FOREIGN KEY ("stock_adjustment_id") REFERENCES "public"."stock_adjustments"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_stock_count_id_stock_counts_id_fk" FOREIGN KEY ("stock_count_id") REFERENCES "public"."stock_counts"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_counted_by_users_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

CREATE UNIQUE INDEX "fiscal_periods_year_month_uidx" ON "fiscal_periods" USING btree ("year","month");

CREATE UNIQUE INDEX "journal_entries_source_purpose_uidx" ON "journal_entries" USING btree ("source_doc_type","source_doc_id","purpose");

CREATE UNIQUE INDEX "journal_entries_reversal_of_uidx" ON "journal_entries" USING btree ("reversal_of_entry_id");

CREATE INDEX "journal_entries_date_idx" ON "journal_entries" USING btree ("entry_date");

CREATE INDEX "journal_entries_warehouse_idx" ON "journal_entries" USING btree ("warehouse_id");

CREATE UNIQUE INDEX "journal_lines_entry_lineno_uidx" ON "journal_lines" USING btree ("journal_entry_id","line_no");

CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("account_code");

CREATE INDEX "journal_lines_batch_idx" ON "journal_lines" USING btree ("batch_id");

CREATE UNIQUE INDEX "goods_receipt_lines_grn_lineno_uidx" ON "goods_receipt_lines" USING btree ("goods_receipt_id","line_no");

CREATE INDEX "goods_receipt_lines_product_idx" ON "goods_receipt_lines" USING btree ("product_id");

CREATE INDEX "goods_receipts_po_idx" ON "goods_receipts" USING btree ("purchase_order_id");

CREATE INDEX "goods_receipts_warehouse_status_idx" ON "goods_receipts" USING btree ("warehouse_id","status");

CREATE INDEX "grading_results_grn_line_idx" ON "grading_results" USING btree ("goods_receipt_line_id");

CREATE INDEX "landed_costs_grn_idx" ON "landed_costs" USING btree ("goods_receipt_id");

CREATE UNIQUE INDEX "purchase_order_lines_po_lineno_uidx" ON "purchase_order_lines" USING btree ("purchase_order_id","line_no");

CREATE INDEX "purchase_order_lines_product_idx" ON "purchase_order_lines" USING btree ("product_id");

CREATE UNIQUE INDEX "purchase_order_revisions_po_rev_uidx" ON "purchase_order_revisions" USING btree ("purchase_order_id","revision_no");

CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("supplier_id");

CREATE INDEX "purchase_orders_warehouse_status_idx" ON "purchase_orders" USING btree ("warehouse_id","status");

CREATE INDEX "quality_inspections_grn_line_idx" ON "quality_inspections" USING btree ("goods_receipt_line_id");

CREATE INDEX "weighings_grn_line_idx" ON "weighings" USING btree ("goods_receipt_line_id");

CREATE INDEX "batches_fefo_idx" ON "batches" USING btree ("product_id","warehouse_id","status","best_before_date","received_at");

CREATE INDEX "batches_grn_idx" ON "batches" USING btree ("goods_receipt_id");

CREATE INDEX "inventory_movements_balance_key_idx" ON "inventory_movements" USING btree ("location_id","batch_id","stock_status");

CREATE INDEX "inventory_movements_source_idx" ON "inventory_movements" USING btree ("source_doc_type","source_doc_id");

CREATE INDEX "inventory_movements_warehouse_created_idx" ON "inventory_movements" USING btree ("warehouse_id","created_at");

CREATE UNIQUE INDEX "stock_adjustment_lines_adj_lineno_uidx" ON "stock_adjustment_lines" USING btree ("stock_adjustment_id","line_no");

CREATE INDEX "stock_adjustments_warehouse_status_idx" ON "stock_adjustments" USING btree ("warehouse_id","status");

CREATE UNIQUE INDEX "stock_balances_loc_batch_status_uidx" ON "stock_balances" USING btree ("location_id","batch_id","stock_status");

CREATE INDEX "stock_balances_warehouse_product_idx" ON "stock_balances" USING btree ("warehouse_id","product_id","stock_status");

CREATE UNIQUE INDEX "stock_count_lines_count_lineno_uidx" ON "stock_count_lines" USING btree ("stock_count_id","line_no");

CREATE INDEX "stock_counts_warehouse_status_idx" ON "stock_counts" USING btree ("warehouse_id","status");

CREATE INDEX "stock_reservations_source_idx" ON "stock_reservations" USING btree ("source_doc_type","source_doc_id");

CREATE INDEX "stock_reservations_batch_idx" ON "stock_reservations" USING btree ("batch_id","status");

ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_nonneg_chk" CHECK ("qty_base" >= 0 AND "total_cost" >= 0 AND "unit_cost_base" >= 0);

ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "po_lines_qty_price_pos_chk" CHECK ("ordered_qty" > 0 AND "ordered_qty_base" > 0 AND "unit_price_base" >= 0 AND "received_net_qty_base" >= 0 AND "accepted_qty_base" >= 0 AND "rejected_qty_base" >= 0);

ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "grn_lines_weights_nonneg_chk" CHECK ("gross_weight_kg" >= 0 AND "tare_weight_kg" >= 0 AND "net_weight_kg" >= 0 AND "accepted_qty_base" >= 0 AND "trim_loss_qty_base" >= 0 AND "rejected_qty_base" >= 0 AND "actual_unit_cost_base" >= 0);

ALTER TABLE "weighings" ADD CONSTRAINT "weighings_weights_chk" CHECK ("gross_weight_kg" > 0 AND "tare_weight_kg" >= 0 AND "net_weight_kg" > 0);

ALTER TABLE "grading_results" ADD CONSTRAINT "grading_results_qty_chk" CHECK ("qty_base" >= 0 AND "allocated_cost_total" >= 0 AND "allocated_unit_cost" >= 0);

ALTER TABLE "batches" ADD CONSTRAINT "batches_qty_cost_chk" CHECK ("initial_qty_base" > 0 AND "unit_cost_base" >= 0 AND "total_initial_cost" >= 0);

ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_nonzero_chk" CHECK ("qty_delta_base" <> 0 AND "unit_cost_base" >= 0);

ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_totals_chk" CHECK ("total_debit" > 0 AND "total_credit" > 0 AND "total_debit" = "total_credit");

ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_one_sided_chk" CHECK (("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0));

CREATE TRIGGER trg_inventory_movements_immutable
BEFORE UPDATE OR DELETE ON "inventory_movements"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();

CREATE TRIGGER trg_journal_entries_immutable
BEFORE UPDATE OR DELETE ON "journal_entries"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();

CREATE TRIGGER trg_journal_lines_immutable
BEFORE UPDATE OR DELETE ON "journal_lines"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();

CREATE TRIGGER trg_po_revisions_immutable
BEFORE UPDATE OR DELETE ON "purchase_order_revisions"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();

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
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_journal_entry_balanced
AFTER INSERT ON "journal_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_journal_entry_balance();

-- -----------------------------------------------------------------------------
-- Migration 0002_peaceful_captain_cross (85 statements)
-- -----------------------------------------------------------------------------
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

ALTER TABLE "customers" ADD COLUMN "assigned_warehouse_id" text;

ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "price_list_history" ADD CONSTRAINT "price_list_history_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "price_list_history" ADD CONSTRAINT "price_list_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_uom_code_uoms_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_ordered_uom_code_uoms_code_fk" FOREIGN KEY ("ordered_uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_price_list_item_id_price_list_items_id_fk" FOREIGN KEY ("price_list_item_id") REFERENCES "public"."price_list_items"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quotation_id_sales_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."sales_quotations"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_delivery_zone_id_delivery_zones_id_fk" FOREIGN KEY ("delivery_zone_id") REFERENCES "public"."delivery_zones"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_margin_approval_id_approvals_id_fk" FOREIGN KEY ("margin_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_credit_approval_id_approvals_id_fk" FOREIGN KEY ("credit_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_sales_quotation_id_sales_quotations_id_fk" FOREIGN KEY ("sales_quotation_id") REFERENCES "public"."sales_quotations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_ordered_uom_code_uoms_code_fk" FOREIGN KEY ("ordered_uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_price_list_item_id_price_list_items_id_fk" FOREIGN KEY ("price_list_item_id") REFERENCES "public"."price_list_items"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_quotations" ADD CONSTRAINT "sales_quotations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_quotations" ADD CONSTRAINT "sales_quotations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_quotations" ADD CONSTRAINT "sales_quotations_margin_approval_id_approvals_id_fk" FOREIGN KEY ("margin_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_quotations" ADD CONSTRAINT "sales_quotations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_quotations" ADD CONSTRAINT "sales_quotations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX "customer_contacts_customer_idx" ON "customer_contacts" USING btree ("customer_id");

CREATE INDEX "customer_credit_notes_customer_status_idx" ON "customer_credit_notes" USING btree ("customer_id","status");

CREATE INDEX "customer_invoices_customer_status_idx" ON "customer_invoices" USING btree ("customer_id","status");

CREATE INDEX "customer_payments_customer_verif_idx" ON "customer_payments" USING btree ("customer_id","verification_status");

CREATE INDEX "price_list_history_list_idx" ON "price_list_history" USING btree ("price_list_id","changed_at");

CREATE UNIQUE INDEX "price_list_items_unique_tier_uidx" ON "price_list_items" USING btree ("price_list_id","product_id","grade_id","uom_code","min_qty");

CREATE INDEX "price_list_items_product_grade_idx" ON "price_list_items" USING btree ("product_id","grade_id","uom_code");

CREATE INDEX "price_lists_lookup_idx" ON "price_lists" USING btree ("price_tier","customer_segment","is_active","effective_from");

CREATE UNIQUE INDEX "sales_order_lines_so_lineno_uidx" ON "sales_order_lines" USING btree ("sales_order_id","line_no");

CREATE INDEX "sales_order_lines_product_idx" ON "sales_order_lines" USING btree ("product_id","grade_id");

CREATE INDEX "sales_orders_customer_status_idx" ON "sales_orders" USING btree ("customer_id","status");

CREATE INDEX "sales_orders_warehouse_status_idx" ON "sales_orders" USING btree ("warehouse_id","status");

CREATE UNIQUE INDEX "sales_quotation_lines_sq_lineno_uidx" ON "sales_quotation_lines" USING btree ("sales_quotation_id","line_no");

CREATE INDEX "sales_quotations_customer_idx" ON "sales_quotations" USING btree ("customer_id");

CREATE INDEX "sales_quotations_warehouse_status_idx" ON "sales_quotations" USING btree ("warehouse_id","status");

ALTER TABLE "customers" ADD CONSTRAINT "customers_assigned_warehouse_id_warehouses_id_fk" FOREIGN KEY ("assigned_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_pos_chk" CHECK ("min_qty" > 0 AND "unit_price" > 0 AND "unit_price_base" > 0 AND "max_discount_pct" >= 0 AND "max_discount_pct" <= 100);

ALTER TABLE "sales_quotation_lines" ADD CONSTRAINT "sales_quotation_lines_pos_chk" CHECK ("ordered_qty" > 0 AND "ordered_qty_base" > 0 AND "unit_price" > 0 AND "net_unit_price" >= 0 AND "net_unit_price_base" >= 0 AND "discount_pct" >= 0 AND "discount_pct" <= 100 AND "line_total_amount" >= 0);

ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_pos_chk" CHECK ("ordered_qty" > 0 AND "ordered_qty_base" > 0 AND "reserved_qty_base" >= 0 AND "fulfilled_qty_base" >= 0 AND "unit_price" > 0 AND "net_unit_price" >= 0 AND "net_unit_price_base" >= 0 AND "discount_pct" >= 0 AND "discount_pct" <= 100 AND "line_total_amount" >= 0);

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_totals_nonneg_chk" CHECK ("subtotal_amount" >= 0 AND "discount_total_amount" >= 0 AND "tax_total_amount" >= 0 AND "shipping_fee_amount" >= 0 AND "handling_fee_amount" >= 0 AND "grand_total_amount" >= 0);

ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_amounts_chk" CHECK ("total_amount" >= 0 AND "paid_amount" >= 0 AND "credit_note_applied_amount" >= 0 AND "outstanding_amount" >= 0);

ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_amounts_chk" CHECK ("amount" > 0 AND "applied_amount" >= 0 AND "unapplied_amount" >= 0);

ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_amounts_chk" CHECK ("total_amount" > 0 AND "applied_amount" >= 0 AND "unapplied_amount" >= 0);

CREATE TRIGGER trg_price_list_history_immutable
BEFORE UPDATE OR DELETE ON "price_list_history"
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_row_mutation();

-- -----------------------------------------------------------------------------
-- Migration 0003_ordinary_blonde_phantom (93 statements)
-- -----------------------------------------------------------------------------
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

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_pod_id_proof_of_deliveries_id_fk" FOREIGN KEY ("pod_id") REFERENCES "public"."proof_of_deliveries"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_delivery_order_id_delivery_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."delivery_orders"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_order_lines" ADD CONSTRAINT "delivery_order_lines_delivery_order_id_delivery_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."delivery_orders"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "delivery_order_lines" ADD CONSTRAINT "delivery_order_lines_fulfillment_line_id_sales_fulfillment_lines_id_fk" FOREIGN KEY ("fulfillment_line_id") REFERENCES "public"."sales_fulfillment_lines"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_order_lines" ADD CONSTRAINT "delivery_order_lines_sales_order_line_id_sales_order_lines_id_fk" FOREIGN KEY ("sales_order_line_id") REFERENCES "public"."sales_order_lines"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_order_lines" ADD CONSTRAINT "delivery_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_order_lines" ADD CONSTRAINT "delivery_order_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_order_lines" ADD CONSTRAINT "delivery_order_lines_uom_code_uoms_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_fulfillment_id_sales_fulfillments_id_fk" FOREIGN KEY ("fulfillment_id") REFERENCES "public"."sales_fulfillments"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_delivery_zone_id_delivery_zones_id_fk" FOREIGN KEY ("delivery_zone_id") REFERENCES "public"."delivery_zones"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_dispatched_by_users_id_fk" FOREIGN KEY ("dispatched_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "fulfillment_exceptions" ADD CONSTRAINT "fulfillment_exceptions_fulfillment_id_sales_fulfillments_id_fk" FOREIGN KEY ("fulfillment_id") REFERENCES "public"."sales_fulfillments"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "fulfillment_exceptions" ADD CONSTRAINT "fulfillment_exceptions_fulfillment_line_id_sales_fulfillment_lines_id_fk" FOREIGN KEY ("fulfillment_line_id") REFERENCES "public"."sales_fulfillment_lines"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "fulfillment_exceptions" ADD CONSTRAINT "fulfillment_exceptions_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "fulfillment_exceptions" ADD CONSTRAINT "fulfillment_exceptions_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "fulfillment_exceptions" ADD CONSTRAINT "fulfillment_exceptions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_fulfillment_id_sales_fulfillments_id_fk" FOREIGN KEY ("fulfillment_id") REFERENCES "public"."sales_fulfillments"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_fulfillment_line_id_sales_fulfillment_lines_id_fk" FOREIGN KEY ("fulfillment_line_id") REFERENCES "public"."sales_fulfillment_lines"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_reservation_id_stock_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."stock_reservations"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_movement_id_inventory_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_picked_by_users_id_fk" FOREIGN KEY ("picked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "proof_of_deliveries" ADD CONSTRAINT "proof_of_deliveries_delivery_order_id_delivery_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."delivery_orders"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "proof_of_deliveries" ADD CONSTRAINT "proof_of_deliveries_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "proof_of_deliveries" ADD CONSTRAINT "proof_of_deliveries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "proof_of_deliveries" ADD CONSTRAINT "proof_of_deliveries_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "proof_of_deliveries" ADD CONSTRAINT "proof_of_deliveries_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "proof_of_delivery_lines" ADD CONSTRAINT "proof_of_delivery_lines_pod_id_proof_of_deliveries_id_fk" FOREIGN KEY ("pod_id") REFERENCES "public"."proof_of_deliveries"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "proof_of_delivery_lines" ADD CONSTRAINT "proof_of_delivery_lines_delivery_order_line_id_delivery_order_lines_id_fk" FOREIGN KEY ("delivery_order_line_id") REFERENCES "public"."delivery_order_lines"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "proof_of_delivery_lines" ADD CONSTRAINT "proof_of_delivery_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "proof_of_delivery_lines" ADD CONSTRAINT "proof_of_delivery_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_fulfillment_id_sales_fulfillments_id_fk" FOREIGN KEY ("fulfillment_id") REFERENCES "public"."sales_fulfillments"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_sales_order_line_id_sales_order_lines_id_fk" FOREIGN KEY ("sales_order_line_id") REFERENCES "public"."sales_order_lines"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_ordered_product_id_products_id_fk" FOREIGN KEY ("ordered_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_ordered_grade_id_product_grades_id_fk" FOREIGN KEY ("ordered_grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_actual_product_id_products_id_fk" FOREIGN KEY ("actual_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_actual_grade_id_product_grades_id_fk" FOREIGN KEY ("actual_grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_substitution_approval_id_approvals_id_fk" FOREIGN KEY ("substitution_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_variance_approval_id_approvals_id_fk" FOREIGN KEY ("variance_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_ordered_uom_code_uoms_code_fk" FOREIGN KEY ("ordered_uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_picked_uom_code_uoms_code_fk" FOREIGN KEY ("picked_uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_picked_by_users_id_fk" FOREIGN KEY ("picked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_picked_by_users_id_fk" FOREIGN KEY ("picked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_packed_by_users_id_fk" FOREIGN KEY ("packed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

CREATE INDEX "delivery_claims_so_idx" ON "delivery_claims" USING btree ("sales_order_id");

CREATE INDEX "delivery_claims_warehouse_status_idx" ON "delivery_claims" USING btree ("warehouse_id","status");

CREATE UNIQUE INDEX "delivery_order_lines_do_lineno_uidx" ON "delivery_order_lines" USING btree ("delivery_order_id","line_no");

CREATE INDEX "delivery_orders_so_idx" ON "delivery_orders" USING btree ("sales_order_id");

CREATE INDEX "delivery_orders_fulfillment_idx" ON "delivery_orders" USING btree ("fulfillment_id");

CREATE INDEX "delivery_orders_warehouse_status_idx" ON "delivery_orders" USING btree ("warehouse_id","status");

CREATE INDEX "fulfillment_exceptions_ful_status_idx" ON "fulfillment_exceptions" USING btree ("fulfillment_id","status");

CREATE INDEX "fulfillment_pick_allocations_line_idx" ON "fulfillment_pick_allocations" USING btree ("fulfillment_line_id");

CREATE INDEX "fulfillment_pick_allocations_batch_idx" ON "fulfillment_pick_allocations" USING btree ("batch_id");

CREATE INDEX "proof_of_deliveries_so_idx" ON "proof_of_deliveries" USING btree ("sales_order_id");

CREATE INDEX "proof_of_deliveries_warehouse_idx" ON "proof_of_deliveries" USING btree ("warehouse_id","outcome_status");

CREATE UNIQUE INDEX "proof_of_delivery_lines_pod_lineno_uidx" ON "proof_of_delivery_lines" USING btree ("pod_id","line_no");

CREATE UNIQUE INDEX "sales_fulfillment_lines_ful_lineno_uidx" ON "sales_fulfillment_lines" USING btree ("fulfillment_id","line_no");

CREATE INDEX "sales_fulfillment_lines_sol_idx" ON "sales_fulfillment_lines" USING btree ("sales_order_line_id");

CREATE INDEX "sales_fulfillments_so_idx" ON "sales_fulfillments" USING btree ("sales_order_id");

CREATE INDEX "sales_fulfillments_warehouse_status_idx" ON "sales_fulfillments" USING btree ("warehouse_id","status");

ALTER TABLE "sales_fulfillments" ADD CONSTRAINT "sales_fulfillments_non_negative_totals_chk" CHECK ("total_ordered_qty_base" >= 0 AND "total_picked_qty_base" >= 0 AND "total_packed_qty_base" >= 0 AND "total_remaining_qty_base" >= 0 AND "total_cogs_amount" >= 0 AND "qty_tolerance_pct" >= 0);

ALTER TABLE "sales_fulfillment_lines" ADD CONSTRAINT "sales_fulfillment_lines_non_negative_qty_chk" CHECK ("target_pick_qty_base" >= 0 AND "picked_qty_base" >= 0 AND "packed_qty_base" >= 0 AND "remaining_backorder_qty_base" >= 0 AND "gross_weight_kg" >= 0 AND "tare_weight_kg" >= 0 AND "net_weight_kg" >= 0);

ALTER TABLE "fulfillment_pick_allocations" ADD CONSTRAINT "fulfillment_pick_allocations_positive_qty_chk" CHECK ("picked_qty_base" > 0 AND "unit_cost_base" >= 0 AND "cost_outflow" >= 0);

ALTER TABLE "delivery_order_lines" ADD CONSTRAINT "delivery_order_lines_non_negative_qty_chk" CHECK ("shipped_qty_base" > 0 AND "delivered_qty_base" >= 0 AND "shortage_qty_base" >= 0 AND "damaged_qty_base" >= 0 AND "refused_qty_base" >= 0);

ALTER TABLE "proof_of_delivery_lines" ADD CONSTRAINT "proof_of_delivery_lines_non_negative_qty_chk" CHECK ("shipped_qty_base" > 0 AND "delivered_qty_base" >= 0 AND "shortage_qty_base" >= 0 AND "damaged_qty_base" >= 0 AND "refused_qty_base" >= 0);

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_non_negative_chk" CHECK ("discrepancy_qty_base" >= 0 AND "estimated_claim_value" >= 0);

-- -----------------------------------------------------------------------------
-- Migration 0004_hot_peter_parker (54 statements)
-- -----------------------------------------------------------------------------
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

ALTER TABLE "customer_credit_notes" ADD COLUMN "delivery_claim_id" text;

ALTER TABLE "customer_credit_notes" ADD COLUMN "applied_to_invoice_id" text;

ALTER TABLE "customer_credit_notes" ADD COLUMN "gl_journal_id" text;

ALTER TABLE "customer_invoices" ADD COLUMN "delivery_order_id" text;

ALTER TABLE "customer_invoices" ADD COLUMN "subtotal_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL;

ALTER TABLE "customer_invoices" ADD COLUMN "discount_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL;

ALTER TABLE "customer_invoices" ADD COLUMN "tax_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL;

ALTER TABLE "customer_invoices" ADD COLUMN "gl_journal_id" text;

ALTER TABLE "customer_invoices" ADD COLUMN "posted_at" timestamp with time zone;

ALTER TABLE "customer_invoices" ADD COLUMN "posted_by" text;

ALTER TABLE "customer_invoices" ADD COLUMN "voided_at" timestamp with time zone;

ALTER TABLE "customer_invoices" ADD COLUMN "voided_by" text;

ALTER TABLE "customer_invoices" ADD COLUMN "void_reason" text;

ALTER TABLE "customer_payments" ADD COLUMN "bank_account_id" text;

ALTER TABLE "customer_payments" ADD COLUMN "status" text DEFAULT 'posted' NOT NULL;

ALTER TABLE "customer_payments" ADD COLUMN "gl_journal_id" text;

ALTER TABLE "customer_payments" ADD COLUMN "reversed_at" timestamp with time zone;

ALTER TABLE "customer_payments" ADD COLUMN "reversed_by" text;

ALTER TABLE "customer_payments" ADD COLUMN "reversal_reason" text;

ALTER TABLE "customer_payments" ADD COLUMN "reversal_gl_journal_id" text;

ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_gl_account_id_gl_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_matched_payment_id_customer_payments_id_fk" FOREIGN KEY ("matched_payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_matched_by_users_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "customer_credit_note_lines" ADD CONSTRAINT "customer_credit_note_lines_credit_note_id_customer_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."customer_credit_notes"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "customer_credit_note_lines" ADD CONSTRAINT "customer_credit_note_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_credit_note_lines" ADD CONSTRAINT "customer_credit_note_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_sales_order_line_id_sales_order_lines_id_fk" FOREIGN KEY ("sales_order_line_id") REFERENCES "public"."sales_order_lines"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_customer_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_allocated_by_users_id_fk" FOREIGN KEY ("allocated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

CREATE INDEX "bank_accounts_type_idx" ON "bank_accounts" USING btree ("account_type");

CREATE INDEX "bank_transactions_bank_date_idx" ON "bank_transactions" USING btree ("bank_account_id","transaction_date");

CREATE INDEX "bank_transactions_status_idx" ON "bank_transactions" USING btree ("match_status");

CREATE UNIQUE INDEX "customer_credit_note_lines_cn_lineno_uidx" ON "customer_credit_note_lines" USING btree ("credit_note_id","line_no");

CREATE INDEX "customer_credit_note_lines_cn_idx" ON "customer_credit_note_lines" USING btree ("credit_note_id");

CREATE UNIQUE INDEX "customer_invoice_lines_inv_lineno_uidx" ON "customer_invoice_lines" USING btree ("invoice_id","line_no");

CREATE INDEX "customer_invoice_lines_invoice_idx" ON "customer_invoice_lines" USING btree ("invoice_id");

CREATE INDEX "customer_invoice_lines_product_idx" ON "customer_invoice_lines" USING btree ("product_id","grade_id");

CREATE INDEX "payment_allocations_payment_idx" ON "payment_allocations" USING btree ("payment_id");

CREATE INDEX "payment_allocations_invoice_idx" ON "payment_allocations" USING btree ("invoice_id");

ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

-- -----------------------------------------------------------------------------
-- Migration 0005_tough_starhawk (42 statements)
-- -----------------------------------------------------------------------------
ALTER TABLE "delivery_claims" ALTER COLUMN "pod_id" DROP NOT NULL;

ALTER TABLE "delivery_claims" ALTER COLUMN "delivery_order_id" DROP NOT NULL;

ALTER TABLE "delivery_claims" ADD COLUMN "invoice_id" text;

ALTER TABLE "delivery_claims" ADD COLUMN "batch_id" text;

ALTER TABLE "delivery_claims" ADD COLUMN "location_id" text;

ALTER TABLE "delivery_claims" ADD COLUMN "product_id" text;

ALTER TABLE "delivery_claims" ADD COLUMN "grade_id" text;

ALTER TABLE "delivery_claims" ADD COLUMN "claimed_qty_base" numeric(14, 3);

ALTER TABLE "delivery_claims" ADD COLUMN "approved_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL;

ALTER TABLE "delivery_claims" ADD COLUMN "approved_claim_value" numeric(18, 2) DEFAULT '0.00' NOT NULL;

ALTER TABLE "delivery_claims" ADD COLUMN "evidence_ref" text;

ALTER TABLE "delivery_claims" ADD COLUMN "submitted_by" text;

ALTER TABLE "delivery_claims" ADD COLUMN "submitted_at" timestamp with time zone;

ALTER TABLE "delivery_claims" ADD COLUMN "reviewed_by" text;

ALTER TABLE "delivery_claims" ADD COLUMN "reviewed_at" timestamp with time zone;

ALTER TABLE "delivery_claims" ADD COLUMN "approved_by" text;

ALTER TABLE "delivery_claims" ADD COLUMN "approved_at" timestamp with time zone;

ALTER TABLE "delivery_claims" ADD COLUMN "rejection_reason" text;

ALTER TABLE "delivery_claims" ADD COLUMN "requires_physical_return" boolean DEFAULT false NOT NULL;

ALTER TABLE "delivery_claims" ADD COLUMN "qc_status" text DEFAULT 'not_required' NOT NULL;

ALTER TABLE "delivery_claims" ADD COLUMN "qc_inspected_by" text;

ALTER TABLE "delivery_claims" ADD COLUMN "qc_inspected_at" timestamp with time zone;

ALTER TABLE "delivery_claims" ADD COLUMN "qc_notes" text;

ALTER TABLE "delivery_claims" ADD COLUMN "restock_movement_id" text;

ALTER TABLE "delivery_claims" ADD COLUMN "cogs_reversal_journal_id" text;

ALTER TABLE "delivery_claims" ADD COLUMN "credit_note_id" text;

ALTER TABLE "delivery_claims" ADD COLUMN "idempotency_key" text;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_qc_inspected_by_users_id_fk" FOREIGN KEY ("qc_inspected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_restock_movement_id_inventory_movements_id_fk" FOREIGN KEY ("restock_movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_cogs_reversal_journal_id_journal_entries_id_fk" FOREIGN KEY ("cogs_reversal_journal_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_credit_note_id_customer_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."customer_credit_notes"("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX "delivery_claims_invoice_idx" ON "delivery_claims" USING btree ("invoice_id");

CREATE UNIQUE INDEX "delivery_claims_idempotency_uidx" ON "delivery_claims" USING btree ("idempotency_key");

ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_approved_non_negative_chk" CHECK ("approved_qty_base" >= 0 AND "approved_claim_value" >= 0);

-- -----------------------------------------------------------------------------
-- Migration 0006_blue_betty_ross (28 statements)
-- -----------------------------------------------------------------------------
CREATE TABLE "customer_order_request_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_request_id" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_id" text,
	"actor_role" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

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

ALTER TABLE "customer_order_request_events" ADD CONSTRAINT "customer_order_request_events_order_request_id_customer_order_requests_id_fk" FOREIGN KEY ("order_request_id") REFERENCES "public"."customer_order_requests"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "customer_order_request_lines" ADD CONSTRAINT "customer_order_request_lines_order_request_id_customer_order_requests_id_fk" FOREIGN KEY ("order_request_id") REFERENCES "public"."customer_order_requests"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "customer_order_request_lines" ADD CONSTRAINT "customer_order_request_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_order_request_lines" ADD CONSTRAINT "customer_order_request_lines_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_order_request_lines" ADD CONSTRAINT "customer_order_request_lines_uom_code_uoms_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."uoms"("code") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_order_requests" ADD CONSTRAINT "customer_order_requests_order_session_id_customer_order_sessions_id_fk" FOREIGN KEY ("order_session_id") REFERENCES "public"."customer_order_sessions"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "customer_order_requests" ADD CONSTRAINT "customer_order_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_order_requests" ADD CONSTRAINT "customer_order_requests_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_order_requests" ADD CONSTRAINT "customer_order_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_order_requests" ADD CONSTRAINT "customer_order_requests_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "customer_order_requests" ADD CONSTRAINT "customer_order_requests_payment_verified_by_users_id_fk" FOREIGN KEY ("payment_verified_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "customer_order_sessions" ADD CONSTRAINT "customer_order_sessions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;

CREATE INDEX "cust_order_req_events_order_idx" ON "customer_order_request_events" USING btree ("order_request_id");

CREATE INDEX "cust_order_req_events_type_idx" ON "customer_order_request_events" USING btree ("event_type");

CREATE UNIQUE INDEX "cust_order_req_lines_order_lineno_uidx" ON "customer_order_request_lines" USING btree ("order_request_id","line_no");

CREATE INDEX "cust_order_req_lines_product_idx" ON "customer_order_request_lines" USING btree ("product_id");

CREATE INDEX "cust_order_req_customer_idx" ON "customer_order_requests" USING btree ("customer_id");

CREATE INDEX "cust_order_req_status_idx" ON "customer_order_requests" USING btree ("order_status","payment_status");

CREATE INDEX "cust_order_req_order_no_idx" ON "customer_order_requests" USING btree ("order_number");

CREATE INDEX "cust_order_req_status_token_idx" ON "customer_order_requests" USING btree ("status_token");

CREATE INDEX "cust_order_req_created_idx" ON "customer_order_requests" USING btree ("created_at");

CREATE INDEX "cust_order_sessions_customer_idx" ON "customer_order_sessions" USING btree ("customer_id");

CREATE INDEX "cust_order_sessions_token_idx" ON "customer_order_sessions" USING btree ("session_token");

CREATE INDEX "cust_order_sessions_status_exp_idx" ON "customer_order_sessions" USING btree ("status","expires_at");

-- -----------------------------------------------------------------------------
-- Migration 0007_supabase_rls_hardening (4 statements)
-- -----------------------------------------------------------------------------
-- 0007 — Supabase / PostgREST deny-by-default hardening (additive, non-destructive).
--
-- Why: on Supabase every table in schema "public" is reachable through the Data API
-- (PostgREST) with the public anon key unless Row Level Security blocks it. This
-- application never uses the Data API; it connects server-side through a PostgreSQL
-- connection as the table OWNER. RLS is therefore ENABLED (not FORCED) on every table
-- with NO policies:
--   * the owner role used by the app and by migrations bypasses RLS  -> app unaffected;
--   * any other role (anon, authenticated, any future read-only role) sees zero rows
--     and cannot insert/update/delete                                  -> deny by default.
-- On Supabase the anon/authenticated roles additionally lose all table, sequence and
-- function privileges in "public". On plain PostgreSQL (dev/test) those roles do not
-- exist and the REVOKE block is skipped.
--
-- Every FUTURE table must also run `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`; this is
-- enforced by tests/integration/supabase-rls-hardening.test.ts.
--
-- Rollback (manual, only with owner approval — it re-opens the Data API exposure):
--   see docs/database/README.md, section "Rollback 0007".
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
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
  END LOOP;
END
$$;

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;

ALTER FUNCTION public.prevent_immutable_row_mutation() SET search_path = public, pg_temp;

ALTER FUNCTION public.verify_journal_entry_balance() SET search_path = public, pg_temp;

-- -----------------------------------------------------------------------------
-- Drizzle migration bookkeeping (identical to drizzle-orm node-postgres migrator)
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS drizzle;

CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);

INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES
  ('ee36ec85b4081d780217cc84f2c956c527eb37795dcdfbd763f7ba583a5eb68e', 1792515726847),
  ('c7b6f8f98444765bd1ba25336c7df1618c5b9c6f79e775c6ed86562a0bd71fd8', 1792517908238),
  ('5861e877eeed48af08cdf9a8361a2ac378400d2175d82b51a61a9e8a1f84cc2b', 1792521804904),
  ('65fba70dd3154387e097f2aab57514126e31e23fa3e4076905a3e1f5cf7eaec9', 1792527322814),
  ('d3bb87d3e3e05455930f50928ca92c8742b3b2c244debddaf685dc6dd8c3840a', 1792572392082),
  ('936701aac631338a55673f56abf807a0f07a6d1d92dadbb92239e3729b63895f', 1792577560636),
  ('2c5a2553c63792300b535e14930c0397785abe74a6dbb0e83a3b1b95add512f4', 1792580105841),
  ('4811a07c204ea17e00939e8da57f2d4fd09568c3693d29f99e39e516e17b3743', 1792736394979);

COMMIT;
