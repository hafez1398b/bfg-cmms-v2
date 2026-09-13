-- BFG CMMS/EAM — Core Refactor Migration (دستور اصلاح دوم)
-- One shared source of truth, optimistic concurrency, realtime, notifications, failures, health, AI, audit
BEGIN;

-- ================================================================
-- 1) Optimistic concurrency: row_version on every mutable entity
-- ================================================================
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE items ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ================================================================
-- 2) Audit log — immutable, complete trail (Requirement #1)
-- ================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  t TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','view','edit','move','delete','soft-delete','restore','approve','reject','status-change','login','logout','export','import')),
  mod TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  note TEXT,
  before JSONB,
  after JSONB,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity, entity_id, t DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id, t DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_mod ON audit_log(mod, t DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_t ON audit_log(t DESC);

-- Backfill audit_x compatibility view (old code reads audit_x)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_views WHERE viewname='audit_log_compat') THEN
    CREATE VIEW audit_log_compat AS SELECT id, t, actor_name AS u, actor_id AS uid, actor_role AS role, action, mod, entity, note, before, after FROM audit_log;
  END IF;
END $$;

-- ================================================================
-- 3) Notifications — end-to-end, persisted, targeted (Requirement #4)
-- ================================================================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL CHECK (kind IN ('critical_failure','equipment_critical','overdue_pm','failed_checklist','new_work_order','assigned_work_order','approval_required','ai_recommendation','inventory_alert','workflow_escalation','system','pm_due','calibration_due','tool_overdue','leave_pending')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  entity TEXT,
  entity_id TEXT,
  target_role TEXT,
  target_factory TEXT,
  target_equipment TEXT REFERENCES assets(id) ON DELETE SET NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS notification_recipients (
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  PRIMARY KEY (notification_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_kind ON notifications(kind, priority);
CREATE INDEX IF NOT EXISTS idx_notif_recipients_user ON notification_recipients(user_id, is_read, notification_id);
CREATE INDEX IF NOT EXISTS idx_notif_recipients_notif ON notification_recipients(notification_id);

-- ================================================================
-- 4) Failures — independent entity (Requirement #10)
-- ================================================================
CREATE TABLE IF NOT EXISTS failures (
  id TEXT PRIMARY KEY,
  failure_no TEXT UNIQUE NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  sub_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  component TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reported_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  condition TEXT,
  symptoms JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT,
  failure_type TEXT,
  failure_mode TEXT,
  failure_code TEXT,
  cause TEXT,
  effect TEXT,
  severity TEXT CHECK (severity IN ('low','medium','high','critical')),
  frequency TEXT,
  detectability TEXT,
  risk_score NUMERIC,
  downtime_hours NUMERIC DEFAULT 0,
  technician_report TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','diagnosing','rca','pending_approval','work_order_created','in_repair','verification','closed','cancelled')),
  provenance TEXT NOT NULL DEFAULT 'verified' CHECK (provenance IN ('verified','ai_detected','ai_predicted','ai_suggested','inferred','pending_verification')),
  row_version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ext JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS failure_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  failure_id TEXT NOT NULL REFERENCES failures(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('photo','file','measurement')),
  url TEXT,
  filename TEXT,
  mime TEXT,
  size_bytes INT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS failure_measurements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  failure_id TEXT NOT NULL REFERENCES failures(id) ON DELETE CASCADE,
  param TEXT NOT NULL,
  value NUMERIC NOT NULL,
  unit TEXT,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  measured_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  provenance TEXT NOT NULL DEFAULT 'verified'
);
CREATE INDEX IF NOT EXISTS idx_failures_asset ON failures(asset_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_failures_severity ON failures(severity, status);
CREATE INDEX IF NOT EXISTS idx_failures_no ON failures(failure_no);

-- ================================================================
-- 5) RCA / Analysis (Requirement #12)
-- ================================================================
CREATE TABLE IF NOT EXISTS failure_rca (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  failure_id TEXT NOT NULL REFERENCES failures(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('5why','fishbone','fault_tree','pareto','trend','rca','fmea')),
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rca_failure ON failure_rca(failure_id, method);

-- ================================================================
-- 6) AI Recommendations & Diagnosis (Requirements #7,8,9,11,13)
-- ================================================================
CREATE TABLE IF NOT EXISTS ai_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL CHECK (kind IN ('diagnosis','repair','pm_change','checklist_change','inspection','spare_part','prediction','general')),
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC CHECK (confidence >= 0 AND confidence <= 100),
  source TEXT,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ai_suggested' CHECK (status IN ('ai_suggested','pending_approval','approved','rejected','applied','verified')),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_ai_rec_entity ON ai_recommendations(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_ai_rec_asset ON ai_recommendations(asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_rec_status ON ai_recommendations(status, kind);

-- ================================================================
-- 7) Health Score history (Requirement #14)
-- ================================================================
CREATE TABLE IF NOT EXISTS equipment_health_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  score NUMERIC(5,2) NOT NULL CHECK (score >= 0 AND score <= 100),
  factors JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  calculated_by TEXT DEFAULT 'system'
);
CREATE INDEX IF NOT EXISTS idx_health_asset_time ON equipment_health_history(asset_id, calculated_at DESC);
-- Add breakdown columns to assets for fast read (computed but persisted)
ALTER TABLE assets ADD COLUMN IF NOT EXISTS health_factors JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS health_trend TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS mtbf_hours NUMERIC;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS mttr_hours NUMERIC;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS availability_pct NUMERIC(5,2);

-- ================================================================
-- 8) Data chain / lineage (Requirement #17,18)
-- ================================================================
CREATE TABLE IF NOT EXISTS data_chain_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_entity TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_entity TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(from_entity, from_id, to_entity, to_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_chain_from ON data_chain_links(from_entity, from_id);
CREATE INDEX IF NOT EXISTS idx_chain_to ON data_chain_links(to_entity, to_id);

-- ================================================================
-- 9) Permission matrix (Requirement #1 - backend enforced)
-- ================================================================
CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT PRIMARY KEY,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO role_permissions(role, permissions) VALUES
('admin',   '{"*": true}'::jsonb),
('mgr',     '{"equipment.view":true,"equipment.create":true,"equipment.edit":true,"equipment.move":true,"equipment.delete":true,"requests.*":true,"wos.*":true,"pm.*":true,"inventory.*":true,"failures.*":true,"ai.*":true,"notifications.*":true,"audit.view":true}'::jsonb),
('planner', '{"equipment.view":true,"equipment.create":true,"equipment.edit":true,"requests.*":true,"wos.*":true,"pm.*":true,"inventory.view":true,"failures.view":true,"failures.create":true,"ai.view":true}'::jsonb),
('tech',    '{"equipment.view":true,"requests.create":true,"requests.view":true,"wos.view":true,"wos.edit_assigned":true,"failures.create":true,"failures.view":true,"ai.view":true}'::jsonb),
('op',      '{"equipment.view":true,"requests.create":true,"requests.view_own":true,"wos.view":true,"failures.create":true}'::jsonb),
('store',   '{"inventory.*":true,"equipment.view":true,"wos.view":true}'::jsonb),
('hse',     '{"equipment.view":true,"permits.*":true,"failures.view":true}'::jsonb),
('cal',     '{"calibration.*":true,"equipment.view":true}'::jsonb)
ON CONFLICT(role) DO NOTHING;

-- ================================================================
-- 10) Offline queue is client-side; server needs idempotency keys
-- ================================================================
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  response JSONB
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);

-- ================================================================
-- 11) Feature flags for gradual rollout + kill switches
-- ================================================================
INSERT INTO feature_flags(key, enabled, rollout_percent, allowed_roles, metadata)
VALUES
  ('notifications_v2', TRUE, 100, '["admin","mgr","planner","tech","op","store","hse","cal"]'::jsonb, '{"phase":2}'::jsonb),
  ('failures_v2',      TRUE, 100, '["admin","mgr","planner","tech","op"]'::jsonb, '{"phase":2}'::jsonb),
  ('ai_v2',            TRUE, 100, '["admin","mgr","planner","tech"]'::jsonb, '{"phase":2}'::jsonb),
  ('health_v2',        TRUE, 100, '["admin","mgr","planner","tech","op"]'::jsonb, '{"phase":2}'::jsonb),
  ('wizard_v2',        TRUE, 100, '["admin","mgr","planner","tech","op"]'::jsonb, '{"phase":2}'::jsonb)
ON CONFLICT(key) DO NOTHING;

-- ================================================================
-- 12) Triggers: updated_at + row_version auto-increment
-- ================================================================
CREATE OR REPLACE FUNCTION bfg_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION bfg_bump_row_version() RETURNS TRIGGER AS $$
BEGIN NEW.row_version = COALESCE(OLD.row_version,0)+1; RETURN NEW; END; $$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_assets_touch') THEN
    CREATE TRIGGER trg_assets_touch BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION bfg_touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_assets_bump') THEN
    CREATE TRIGGER trg_assets_bump BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION bfg_bump_row_version();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_wo_touch') THEN
    CREATE TRIGGER trg_wo_touch BEFORE UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION bfg_touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_wo_bump') THEN
    CREATE TRIGGER trg_wo_bump BEFORE UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION bfg_bump_row_version();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_requests_touch') THEN
    CREATE TRIGGER trg_requests_touch BEFORE UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION bfg_touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_requests_bump') THEN
    CREATE TRIGGER trg_requests_bump BEFORE UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION bfg_bump_row_version();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_items_touch') THEN
    CREATE TRIGGER trg_items_touch BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION bfg_touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_items_bump') THEN
    CREATE TRIGGER trg_items_bump BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION bfg_bump_row_version();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_failures_touch') THEN
    CREATE TRIGGER trg_failures_touch BEFORE UPDATE ON failures FOR EACH ROW EXECUTE FUNCTION bfg_touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_failures_bump') THEN
    CREATE TRIGGER trg_failures_bump BEFORE UPDATE ON failures FOR EACH ROW EXECUTE FUNCTION bfg_bump_row_version();
  END IF;
END $$;

COMMIT;
