#!/usr/bin/env bash
# Apply the migrations to a throwaway PostgreSQL 16 database (with a Supabase stub)
# and run the RLS tests.  Usage:  DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres ./scripts/test-db.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
: "${DATABASE_URL:?set DATABASE_URL to a superuser connection on a disposable database}"

db="wb_test_$$"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "create database $db"
trap 'psql "$DATABASE_URL" -q -c "drop database if exists $db" >/dev/null' EXIT
url="${DATABASE_URL%/*}/$db"

psql "$url" -v ON_ERROR_STOP=1 -q -f "$here/tests/supabase_stub.sql"
for f in "$here"/migrations/*.sql; do
  echo "applying $(basename "$f")"
  psql "$url" -v ON_ERROR_STOP=1 -q -f "$f"
done
psql "$url" -v ON_ERROR_STOP=1 -f "$here/tests/rls_test.sql"
