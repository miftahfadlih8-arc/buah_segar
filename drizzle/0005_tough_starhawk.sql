ALTER TABLE "delivery_claims" ALTER COLUMN "pod_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_claims" ALTER COLUMN "delivery_order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "invoice_id" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "batch_id" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "location_id" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "product_id" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "grade_id" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "claimed_qty_base" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "approved_qty_base" numeric(14, 3) DEFAULT '0.000' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "approved_claim_value" numeric(18, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "evidence_ref" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "submitted_by" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "requires_physical_return" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "qc_status" text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "qc_inspected_by" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "qc_inspected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "qc_notes" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "restock_movement_id" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "cogs_reversal_journal_id" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "credit_note_id" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_grade_id_product_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."product_grades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_qc_inspected_by_users_id_fk" FOREIGN KEY ("qc_inspected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_restock_movement_id_inventory_movements_id_fk" FOREIGN KEY ("restock_movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_cogs_reversal_journal_id_journal_entries_id_fk" FOREIGN KEY ("cogs_reversal_journal_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_credit_note_id_customer_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."customer_credit_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_claims_invoice_idx" ON "delivery_claims" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_claims_idempotency_uidx" ON "delivery_claims" USING btree ("idempotency_key");--> statement-breakpoint
ALTER TABLE "delivery_claims" ADD CONSTRAINT "delivery_claims_approved_non_negative_chk" CHECK ("approved_qty_base" >= 0 AND "approved_claim_value" >= 0);
