#!/bin/sh
# Nightly reset of the demo install — wipes DB rows and per-episode
# storage, then re-runs the seed script. Run by the ``reset`` compose
# service via dcron at DEMO_RESET_CRON (default 04:00 UTC).

set -eu

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

echo "[$(ts)] demo reset starting"

# ── 1. Truncate the public schema. Wrapped in a single transaction so a
#    failure mid-run doesn't leave the DB half-cleared.
PGPASSWORD=drevalis psql -h postgres -U drevalis -d drevalis <<'SQL'
BEGIN;
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> 'alembic_version'
  LOOP
    EXECUTE format('TRUNCATE TABLE %I RESTART IDENTITY CASCADE', r.tablename);
  END LOOP;
END $$;
COMMIT;
SQL
echo "[$(ts)] db truncated"

# ── 2. Wipe per-episode and per-audiobook storage (keep model files etc.).
rm -rf /app/storage/episodes/* /app/storage/audiobooks/* 2>/dev/null || true
echo "[$(ts)] storage cleared"

# ── 3. Re-seed.
PYTHONPATH=/app/src python /app/seed_demo.py
echo "[$(ts)] reseed complete"

echo "[$(ts)] demo reset done"
