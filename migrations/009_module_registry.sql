-- Module registry and numbered migration bookkeeping.
-- Additive and idempotent: no historical row is deleted or rewritten.
-- A new module is not inserted here from the network. Enablement of the
-- signed catalog is the only state stored in the database.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  backup_checksum TEXT NOT NULL,
  backup_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_modules (
  id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_modules(id, enabled) VALUES
  ('equipment', true),
  ('requests', true),
  ('work_orders', true),
  ('pm', true),
  ('inventory', true)
ON CONFLICT (id) DO NOTHING;

COMMIT;
