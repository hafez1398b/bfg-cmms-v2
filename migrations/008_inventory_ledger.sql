-- Immutable inventory ledger, warehouses, work-order costs and file metadata.
-- File bytes are not stored in PostgreSQL or the browser. No historical row is deleted.

BEGIN;

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  factory_asset_id TEXT REFERENCES assets(id),
  active BOOLEAN NOT NULL DEFAULT true,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT REFERENCES users(id),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS storage_locations (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT REFERENCES users(id),
  deleted_at TIMESTAMPTZ,
  UNIQUE(warehouse_id, code)
);

CREATE TABLE IF NOT EXISTS item_balances (
  item_id TEXT NOT NULL REFERENCES items(id),
  location_id TEXT NOT NULL REFERENCES storage_locations(id),
  on_hand NUMERIC NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved NUMERIC NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  row_version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(item_id, location_id),
  CHECK (reserved <= on_hand)
);

CREATE TABLE IF NOT EXISTS inventory_ledger (
  id UUID PRIMARY KEY,
  entry_no TEXT NOT NULL UNIQUE,
  movement TEXT NOT NULL CHECK (movement IN ('receipt','issue','reserve','release','consume','return')),
  item_id TEXT NOT NULL REFERENCES items(id),
  location_id TEXT NOT NULL REFERENCES storage_locations(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  qty NUMERIC NOT NULL CHECK (qty > 0),
  unit_cost NUMERIC NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  work_order_id TEXT REFERENCES work_orders(id),
  equipment_id TEXT REFERENCES assets(id),
  reservation_id UUID,
  reverses_entry_id UUID REFERENCES inventory_ledger(id),
  note TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id UUID PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  location_id TEXT NOT NULL REFERENCES storage_locations(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  work_order_id TEXT NOT NULL REFERENCES work_orders(id),
  equipment_id TEXT REFERENCES assets(id),
  qty NUMERIC NOT NULL CHECK (qty > 0),
  remaining NUMERIC NOT NULL CHECK (remaining >= 0),
  status TEXT NOT NULL CHECK (status IN ('open','consumed','released')),
  row_version BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS work_order_parts (
  id UUID PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  equipment_id TEXT NOT NULL REFERENCES assets(id),
  location_id TEXT NOT NULL REFERENCES storage_locations(id),
  ledger_entry_id UUID NOT NULL REFERENCES inventory_ledger(id),
  qty NUMERIC NOT NULL CHECK (qty > 0),
  unit_cost NUMERIC NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_order_costs (
  id UUID PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id),
  equipment_id TEXT REFERENCES assets(id),
  kind TEXT NOT NULL CHECK (kind IN ('labor','part','external_service')),
  direction TEXT NOT NULL DEFAULT 'debit' CHECK (direction IN ('debit','credit')),
  description TEXT,
  hours NUMERIC,
  rate NUMERIC,
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  ledger_entry_id UUID REFERENCES inventory_ledger(id),
  source TEXT NOT NULL CHECK (source IN ('server','labor','external_service','return')),
  voided_at TIMESTAMPTZ,
  row_version BIGINT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_order_files (
  id UUID PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL,
  phase TEXT CHECK (phase IN ('before','during','after')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS requester_confirmed_at TIMESTAMPTZ;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS requester_confirmed_by TEXT REFERENCES users(id);
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS requester_confirmed_name TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS requester_confirmation_note TEXT;

CREATE INDEX IF NOT EXISTS idx_item_balances_location ON item_balances(location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_ledger_item ON inventory_ledger(item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_ledger_wo ON inventory_ledger(work_order_id) WHERE work_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_order_parts_wo ON work_order_parts(work_order_id);
CREATE INDEX IF NOT EXISTS idx_work_order_costs_wo ON work_order_costs(work_order_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_work_order_files_wo ON work_order_files(work_order_id) WHERE deleted_at IS NULL;

INSERT INTO warehouses(id, code, name) VALUES ('wh-main','MAIN','انبار مرکزی')
ON CONFLICT(id) DO NOTHING;
INSERT INTO storage_locations(id, warehouse_id, code, name) VALUES ('loc-main','wh-main','A-01','قفسه اصلی')
ON CONFLICT(id) DO NOTHING;

INSERT INTO role_permissions(role, permission) VALUES
  ('mgr','inventory.view'),('mgr','inventory.edit'),('mgr','inventory.receive'),('mgr','inventory.issue'),
  ('mgr','inventory.reserve'),('mgr','inventory.consume'),('mgr','inventory.return'),('mgr','inventory.archive'),
  ('mgr','cost.view'),('mgr','cost.create'),('mgr','work_order.attach'),('mgr','work_order.confirm'),
  ('planner','inventory.view'),('planner','cost.view'),('planner','cost.create'),('planner','work_order.attach'),('planner','work_order.confirm'),
  ('store','inventory.receive'),('store','inventory.issue'),('store','inventory.reserve'),('store','inventory.consume'),
  ('store','inventory.return'),('store','inventory.archive'),('store','cost.view'),('store','work_order.attach'),
  ('tech','inventory.view'),('tech','inventory.reserve'),('tech','inventory.consume'),('tech','work_order.attach'),
  ('op','inventory.view'),('op','work_order.confirm'),
  ('hse','inventory.view'),('cal','inventory.view')
ON CONFLICT(role, permission) DO NOTHING;

CREATE OR REPLACE FUNCTION reject_inventory_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_IMMUTABLE' USING ERRCODE = '55000';
END $$;

DROP TRIGGER IF EXISTS inventory_ledger_immutable ON inventory_ledger;
CREATE TRIGGER inventory_ledger_immutable
BEFORE UPDATE OR DELETE ON inventory_ledger
FOR EACH ROW EXECUTE FUNCTION reject_inventory_ledger_mutation();

COMMIT;
