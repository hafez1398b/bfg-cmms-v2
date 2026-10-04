-- Additive workflow store for requests, work orders and PM plans.
-- No historical row is deleted. Fresh installs also receive this from schema.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS maintenance_counters (
  name TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS maintenance_corrections (
  id UUID PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('request','work_order','pm_plan')),
  entity_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  patch JSONB NOT NULL,
  previous_row_version BIGINT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE requests ADD COLUMN IF NOT EXISTS requester_id TEXT REFERENCES users(id);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS work_order_id TEXT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS pm_id TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS hold_reason TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT REFERENCES users(id);

ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

DO $$ BEGIN
  ALTER TABLE requests
    ADD CONSTRAINT requests_work_order_fk FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE work_orders
    ADD CONSTRAINT work_orders_pm_fk FOREIGN KEY (pm_id) REFERENCES pm_plans(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_requests_asset_active ON requests(asset_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_requests_work_order ON requests(work_order_id);
CREATE INDEX IF NOT EXISTS idx_pm_asset_active ON pm_plans(asset_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wo_pm ON work_orders(pm_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_corrections_entity
  ON maintenance_corrections(entity_type, entity_id, created_at DESC);

INSERT INTO role_permissions(role, permission) VALUES
  ('mgr','pm.view'),('mgr','pm.create'),('mgr','pm.edit'),('mgr','pm.generate'),('mgr','pm.archive'),('mgr','pm.cancel'),('mgr','pm.correct'),
  ('mgr','request.edit'),('mgr','request.archive'),('mgr','request.cancel'),('mgr','request.correct'),
  ('mgr','work_order.close'),('mgr','work_order.archive'),('mgr','work_order.cancel'),('mgr','work_order.correct'),
  ('planner','pm.view'),('planner','pm.create'),('planner','pm.edit'),('planner','pm.generate'),('planner','pm.archive'),('planner','pm.cancel'),
  ('planner','request.edit'),('planner','request.archive'),('planner','request.cancel'),
  ('planner','work_order.close'),('planner','work_order.archive'),('planner','work_order.cancel'),
  ('tech','pm.view'),('tech','work_order.cancel'),
  ('op','pm.view'),('hse','pm.view'),('cal','pm.view'),('store','pm.view')
ON CONFLICT(role, permission) DO NOTHING;

COMMIT;
