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
$$;--> statement-breakpoint
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
$$;--> statement-breakpoint
ALTER FUNCTION public.prevent_immutable_row_mutation() SET search_path = public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.verify_journal_entry_balance() SET search_path = public, pg_temp;
