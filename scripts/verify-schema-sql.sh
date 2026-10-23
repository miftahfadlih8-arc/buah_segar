#!/usr/bin/env bash
# Verifies docs/database/schema.sql against the real Drizzle migrator on two brand-new,
# throwaway databases. It NEVER touches any existing database:
#   * refuses to start if either scratch database already exists;
#   * scratch names are fixed and end with `_test`;
#   * drops ONLY the two scratch databases it created itself (on exit).
#
# Usage: scripts/verify-schema-sql.sh [server_url_without_db]
#   default server: postgres://127.0.0.1:5432
# Requires: psql, createdb, dropdb, pg_dump (same major as the server), node + tsx.
set -euo pipefail

SERVER="${1:-postgres://127.0.0.1:5432}"
DB_SQL="buah_schemaverify_sql_test"
DB_MIG="buah_schemaverify_mig_test"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
CREATED=()
# Hide expected NOTICEs (PostgreSQL truncates a few >63-char FK names identically on both paths).
export PGOPTIONS="${PGOPTIONS:-} --client-min-messages=warning"

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; exit 1; }

cleanup() {
  for db in "${CREATED[@]:-}"; do
    [ -n "$db" ] && dropdb --if-exists --maintenance-db="$SERVER/postgres" "$db" >/dev/null 2>&1 || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

q() { psql "$SERVER/$1" -X -At -v ON_ERROR_STOP=1 -c "$2"; }

for db in "$DB_SQL" "$DB_MIG"; do
  case "$db" in *_test) ;; *) fail "scratch db name must end with _test: $db" ;; esac
  exists="$(q postgres "select 1 from pg_database where datname='$db'")"
  [ -z "$exists" ] || fail "scratch database $db already exists — refusing to touch it"
done

createdb --maintenance-db="$SERVER/postgres" "$DB_SQL"; CREATED+=("$DB_SQL")
createdb --maintenance-db="$SERVER/postgres" "$DB_MIG"; CREATED+=("$DB_MIG")
pass "created empty scratch databases $DB_SQL and $DB_MIG"

# 1. schema.sql must be current with drizzle/ migrations.
(cd "$ROOT" && node --import tsx scripts/generate-schema-sql.ts --check >/dev/null) \
  && pass "schema.sql is in sync with drizzle/ journal" || fail "schema.sql is stale"

# 2. Apply schema.sql to an empty database.
psql "$SERVER/$DB_SQL" -X -q -v ON_ERROR_STOP=1 -f "$ROOT/docs/database/schema.sql" >/dev/null \
  && pass "schema.sql applied cleanly to empty database" || fail "schema.sql failed on empty database"

# 3. Apply migrations with the real Drizzle migrator to the other empty database.
(cd "$ROOT" && DATABASE_URL="$SERVER/$DB_MIG" node --import tsx scripts/migrate.ts >/dev/null) \
  && pass "drizzle migrator applied all migrations to empty database" || fail "drizzle migrator failed"

# 4. Structural equality (tables, columns, constraints, indexes, FKs, functions,
#    triggers, RLS flags, grants). pg_dump >= 14.19 emits random \restrict keys: strip them.
dump() {
  pg_dump --schema-only --no-owner "$SERVER/$1" | grep -vE '^\\(un)?restrict ' | grep -vE '^-- Dumped (from|by)'
}
dump "$DB_SQL" > "$WORK/sql.dump"
dump "$DB_MIG" > "$WORK/mig.dump"
if diff -u "$WORK/mig.dump" "$WORK/sql.dump" > "$WORK/diff.txt"; then
  pass "pg_dump --schema-only identical (schema.sql == drizzle migrator)"
else
  head -60 "$WORK/diff.txt"; fail "schema dumps differ"
fi

# 5. Migration bookkeeping identical.
b1="$(q "$DB_SQL" "select id||':'||hash||':'||created_at from drizzle.__drizzle_migrations order by id")"
b2="$(q "$DB_MIG" "select id||':'||hash||':'||created_at from drizzle.__drizzle_migrations order by id")"
[ "$b1" = "$b2" ] && pass "drizzle.__drizzle_migrations identical ($(echo "$b1" | wc -l | tr -d ' ') rows)" \
  || fail "migration bookkeeping differs"

# 6. Running the migrator on the schema.sql database must be a no-op.
(cd "$ROOT" && DATABASE_URL="$SERVER/$DB_SQL" node --import tsx scripts/migrate.ts >/dev/null)
b3="$(q "$DB_SQL" "select count(*) from drizzle.__drizzle_migrations")"
[ "$b3" = "$(echo "$b1" | wc -l | tr -d ' ')" ] && pass "db:migrate after schema.sql is a no-op" \
  || fail "db:migrate re-applied migrations after schema.sql"

# 7. Re-applying schema.sql must be refused by the guard and change nothing.
if psql "$SERVER/$DB_SQL" -X -q -v ON_ERROR_STOP=1 -f "$ROOT/docs/database/schema.sql" >/dev/null 2>&1; then
  fail "schema.sql re-applied on a non-empty database (guard missing)"
else
  pass "schema.sql guard refuses non-empty database"
fi

# 8. No data at all in application tables (no demo users/customers/stock/finance/settings).
tables="$(q "$DB_SQL" "select count(*) from pg_tables where schemaname='public'")"
rows="$(q "$DB_SQL" "select coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', tablename), false, true, '')))[1]::text::bigint),0) from pg_tables where schemaname='public'")"
[ "$rows" = "0" ] && pass "$tables public tables, total rows = 0 (no demo/seed data)" || fail "found $rows rows in public tables"

# 9. RLS enabled (not forced) on every public table; no policies.
no_rls="$(q "$DB_SQL" "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity")"
forced="$(q "$DB_SQL" "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relforcerowsecurity")"
pols="$(q "$DB_SQL" "select count(*) from pg_policies where schemaname='public'")"
[ "$no_rls" = "0" ] && [ "$forced" = "0" ] && [ "$pols" = "0" ] \
  && pass "RLS enabled on all $tables tables, not forced, 0 policies (deny-by-default for non-owner roles)" \
  || fail "RLS check: tables_without_rls=$no_rls forced=$forced policies=$pols"

# 10. Non-owner role probe: even with explicit SELECT/INSERT grants, RLS hides and blocks rows.
probe="$(psql "$SERVER/$DB_SQL" -X -At -v ON_ERROR_STOP=1 2>&1 <<'SQL'
BEGIN;
CREATE ROLE buah_rls_probe_verify NOLOGIN;
GRANT USAGE ON SCHEMA public TO buah_rls_probe_verify;
GRANT SELECT, INSERT ON public.branches TO buah_rls_probe_verify;
INSERT INTO public.branches (id, code, name, city) VALUES ('br_probe', 'PRB', 'Probe', 'Bekasi');
SET LOCAL ROLE buah_rls_probe_verify;
SELECT 'visible=' || count(*) FROM public.branches;
SAVEPOINT s;
DO $$ BEGIN
  INSERT INTO public.branches (id, code, name, city) VALUES ('br_probe2', 'PR2', 'Probe2', 'Bekasi');
  RAISE WARNING 'insert_allowed';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'insert_denied';
END $$;
ROLLBACK;
SQL
)"
echo "$probe" | grep -q "visible=0" && pass "non-owner role sees 0 rows despite SELECT grant" || fail "non-owner role could read rows: $probe"
echo "$probe" | grep -q "insert_denied" && pass "non-owner role INSERT rejected by RLS despite INSERT grant" || fail "non-owner role could insert: $probe"

echo "ALL SCHEMA CHECKS PASSED"
