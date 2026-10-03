BEGIN;

-- Second Correction: shared-data, authorization, concurrency, notification,
-- failure/RCA, AI provenance and offline synchronization foundation.
-- Additive only: no historical record is deleted or rewritten.

UPDATE users SET name='حافظ بایرامیان',unit='مدیریت سیستم'
WHERE username='admin' AND (name IS DISTINCT FROM 'حافظ بایرامیان' OR unit IS DISTINCT FROM 'مدیریت سیستم');

CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  granted BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(role,permission)
);
INSERT INTO role_permissions(role,permission) VALUES
 ('admin','*'),('mgr','equipment.view'),('mgr','request.view'),('mgr','request.create'),('mgr','request.triage'),
 ('mgr','work_order.view'),('mgr','work_order.create'),('mgr','work_order.edit'),('mgr','failure.view'),('mgr','failure.create'),('mgr','failure.review'),
 ('planner','equipment.view'),('planner','request.view'),('planner','request.create'),('planner','request.triage'),('planner','work_order.view'),('planner','work_order.create'),('planner','work_order.edit'),('planner','failure.view'),('planner','failure.create'),
 ('tech','equipment.view'),('tech','request.view'),('tech','request.create'),('tech','work_order.view'),('tech','work_order.execute'),('tech','failure.view'),('tech','failure.create'),
 ('op','equipment.view'),('op','request.view'),('op','request.create'),('op','failure.view'),('op','failure.create'),
 ('store','equipment.view'),('store','inventory.view'),('store','inventory.edit'),('store','work_order.view'),
 ('hse','equipment.view'),('hse','request.view'),('hse','work_order.view'),('hse','failure.view'),
 ('cal','equipment.view'),('cal','work_order.view'),
 ('mgr','notification.view'),('mgr','notification.create'),('planner','notification.view'),('planner','notification.create'),
 ('tech','notification.view'),('op','notification.view'),('store','notification.view'),('hse','notification.view'),('cal','notification.view')
ON CONFLICT(role,permission) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_scopes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('company','factory','equipment')),
  scope_id TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,scope_type,scope_id)
);

ALTER TABLE requests ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE requests ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS provenance_status TEXT NOT NULL DEFAULT 'verified';

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS provenance_status TEXT NOT NULL DEFAULT 'verified';

ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS provenance_status TEXT NOT NULL DEFAULT 'verified';

ALTER TABLE items ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','critical')),
  entity_type TEXT,
  entity_id TEXT,
  factory_id TEXT,
  equipment_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS notification_recipients (
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  delivery_channels JSONB NOT NULL DEFAULT '["in_app"]'::jsonb,
  delivery_status JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(notification_id,user_id)
);

CREATE TABLE IF NOT EXISTS event_outbox (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  recipient_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS failures (
  id UUID PRIMARY KEY,
  failure_no TEXT UNIQUE NOT NULL,
  equipment_id TEXT NOT NULL REFERENCES assets(id),
  sub_equipment_id TEXT REFERENCES assets(id),
  component_id TEXT REFERENCES assets(id),
  occurred_at TIMESTAMPTZ NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  condition TEXT,
  symptoms JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT,
  failure_type TEXT,
  failure_mode TEXT,
  failure_code TEXT,
  cause TEXT,
  effect TEXT,
  severity SMALLINT CHECK(severity BETWEEN 1 AND 10),
  frequency SMALLINT CHECK(frequency BETWEEN 1 AND 10),
  detectability SMALLINT CHECK(detectability BETWEEN 1 AND 10),
  risk_score INTEGER GENERATED ALWAYS AS (COALESCE(severity,0)*COALESCE(frequency,0)*COALESCE(detectability,0)) STORED,
  downtime_minutes INTEGER CHECK(downtime_minutes IS NULL OR downtime_minutes >= 0),
  technician_report TEXT,
  status TEXT NOT NULL DEFAULT 'reported' CHECK(status IN ('reported','under_review','diagnosed','action_planned','resolved','verified','cancelled')),
  provenance_status TEXT NOT NULL DEFAULT 'verified' CHECK(provenance_status IN ('verified','ai_detected','ai_predicted','ai_suggested','inferred','pending_verification')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version BIGINT NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS failure_measurements (
  id UUID PRIMARY KEY,
  failure_id UUID NOT NULL REFERENCES failures(id) ON DELETE CASCADE,
  measurement_type TEXT NOT NULL,
  value NUMERIC,
  unit TEXT,
  measured_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  provenance_status TEXT NOT NULL DEFAULT 'verified',
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS failure_attachments (
  id UUID PRIMARY KEY,
  failure_id UUID NOT NULL REFERENCES failures(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  checksum TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rca_cases (
  id UUID PRIMARY KEY,
  failure_id UUID NOT NULL REFERENCES failures(id),
  method TEXT NOT NULL CHECK(method IN ('5_why','fishbone','fault_tree','pareto','trend','repeated_failure','fmea','other')),
  title TEXT NOT NULL,
  analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
  root_cause TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','under_review','approved','rejected','verified')),
  approved_by TEXT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id UUID PRIMARY KEY,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  factory_id TEXT,
  equipment_id TEXT REFERENCES assets(id),
  failure_id UUID REFERENCES failures(id),
  context_manifest JSONB NOT NULL,
  prompt_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','timed_out')),
  response_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS ai_recommendations (
  id UUID PRIMARY KEY,
  ai_run_id UUID NOT NULL REFERENCES ai_runs(id),
  recommendation_type TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC(5,4) CHECK(confidence BETWEEN 0 AND 1),
  source_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK(status IN ('ai_suggested','pending_approval','approved','rejected','applied','verified')),
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(user_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS sync_commands (
  id UUID PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  command_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  base_version BIGINT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','conflict','rejected')),
  conflict JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  UNIQUE(client_id,id)
);

CREATE INDEX IF NOT EXISTS idx_user_scopes_lookup ON user_scopes(user_id,scope_type,scope_id);
CREATE INDEX IF NOT EXISTS idx_notification_recipient_unread ON notification_recipients(user_id,read_at) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON event_outbox(occurred_at) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_failures_equipment_time ON failures(equipment_id,occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_failures_critical ON failures(risk_score DESC) WHERE deleted_at IS NULL AND status NOT IN ('verified','cancelled');
CREATE INDEX IF NOT EXISTS idx_ai_recommendation_status ON ai_recommendations(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_user_status ON sync_commands(user_id,status,created_at);

COMMIT;
