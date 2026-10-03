-- BFG CMMS/EAM - PostgreSQL schema
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  unit TEXT,
  phone TEXT,
  active BOOLEAN DEFAULT TRUE,
  hr JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS assets(
  id TEXT PRIMARY KEY,
  parent TEXT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  cls TEXT,
  status TEXT,
  crit TEXT,
  maker TEXT,
  model TEXT,
  serial TEXT,
  year TEXT,
  install TEXT,
  power TEXT,
  hours NUMERIC DEFAULT 0,
  history JSONB DEFAULT '[]'::jsonb,
  ext JSONB DEFAULT '{}'::jsonb,
  propCode TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS requests(
  id TEXT PRIMARY KEY,
  no TEXT UNIQUE,
  type TEXT,
  unit TEXT,
  requester TEXT,
  asset_id TEXT REFERENCES assets(id),
  descr TEXT,
  urgency TEXT,
  impact BOOLEAN DEFAULT FALSE,
  status TEXT,
  form JSONB DEFAULT '{}'::jsonb,
  history JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS work_orders(
  id TEXT PRIMARY KEY,
  no TEXT UNIQUE,
  type TEXT,
  asset_id TEXT REFERENCES assets(id),
  descr TEXT,
  priority TEXT,
  assignee TEXT REFERENCES users(id),
  status TEXT,
  req_id TEXT REFERENCES requests(id),
  ptw BOOLEAN DEFAULT FALSE,
  ptw_id TEXT,
  times JSONB DEFAULT '{}'::jsonb,
  parts JSONB DEFAULT '[]'::jsonb,
  media JSONB DEFAULT '{}'::jsonb,
  report JSONB DEFAULT '{}'::jsonb,
  est NUMERIC,
  costs JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pm_plans(
  id TEXT PRIMARY KEY,
  asset_id TEXT REFERENCES assets(id),
  title TEXT,
  interval_days INT,
  last_run TIMESTAMPTZ,
  spec TEXT,
  owner TEXT REFERENCES users(id),
  sup TEXT REFERENCES users(id),
  kind TEXT,
  checklist JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS items(
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE,
  name TEXT,
  unit TEXT,
  stock NUMERIC,
  min_stock NUMERIC,
  price NUMERIC,
  loc TEXT,
  cat TEXT,
  max_stock NUMERIC,
  part_type TEXT,
  key_for JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stock_docs(
  id TEXT PRIMARY KEY,
  no TEXT UNIQUE,
  kind TEXT,
  item_id TEXT REFERENCES items(id),
  qty NUMERIC,
  at TIMESTAMPTZ,
  by_name TEXT,
  wo TEXT
);
CREATE TABLE IF NOT EXISTS permits(
  id TEXT PRIMARY KEY,
  no TEXT UNIQUE,
  type TEXT,
  wo_id TEXT,
  from_at TIMESTAMPTZ,
  to_at TIMESTAMPTZ,
  status TEXT,
  issuer TEXT,
  holder TEXT,
  conditions TEXT,
  checks JSONB,
  approved_at TIMESTAMPTZ,
  signature TEXT
);
CREATE TABLE IF NOT EXISTS instruments(
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE,
  name TEXT,
  asset_id TEXT,
  period_days INT,
  last_cal TIMESTAMPTZ,
  type TEXT,
  cls TEXT
);
CREATE TABLE IF NOT EXISTS contractors(
  id TEXT PRIMARY KEY,
  name TEXT,
  field TEXT,
  reg TEXT,
  score NUMERIC,
  docs_exp TIMESTAMPTZ,
  people INT
);
CREATE TABLE IF NOT EXISTS contracts(
  id TEXT PRIMARY KEY,
  no TEXT UNIQUE,
  title TEXT,
  party TEXT,
  type TEXT,
  amount NUMERIC,
  used NUMERIC,
  from_at TIMESTAMPTZ,
  to_at TIMESTAMPTZ,
  status TEXT
);
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY,
  code TEXT,
  title TEXT,
  mgr TEXT,
  budget NUMERIC,
  spent NUMERIC,
  from_at TIMESTAMPTZ,
  to_at TIMESTAMPTZ,
  status TEXT,
  wbs JSONB,
  assets JSONB,
  contractor TEXT,
  team JSONB,
  descr TEXT
);
CREATE TABLE IF NOT EXISTS tools(
  id TEXT PRIMARY KEY,
  code TEXT,
  name TEXT,
  health TEXT,
  holder TEXT,
  due TIMESTAMPTZ,
  loan_at TIMESTAMPTZ,
  grp TEXT,
  brand TEXT,
  model TEXT,
  serial TEXT,
  status TEXT,
  price NUMERIC,
  prop TEXT,
  loc TEXT,
  store TEXT,
  factory TEXT,
  unit TEXT,
  buy_date TEXT,
  life TEXT,
  last_srv TEXT,
  next_srv TEXT,
  img TEXT,
  files JSONB,
  note TEXT
);
CREATE TABLE IF NOT EXISTS tool_loans(
  id TEXT PRIMARY KEY,
  no TEXT,
  tool_id TEXT REFERENCES tools(id),
  giver TEXT,
  giver_id TEXT,
  holder TEXT,
  holder_name TEXT,
  post TEXT,
  unit TEXT,
  factory TEXT,
  project_id TEXT,
  wo_id TEXT,
  asset_id TEXT,
  place TEXT,
  purpose TEXT,
  days NUMERIC,
  out TIMESTAMPTZ,
  due TIMESTAMPTZ,
  cond_out TEXT,
  img_out TEXT,
  sig_giver TEXT,
  sig_holder TEXT,
  note TEXT,
  returned_at TIMESTAMPTZ,
  cond_in TEXT,
  health TEXT,
  damage TEXT,
  missing TEXT,
  img_in TEXT,
  sig_in TEXT,
  approved_by TEXT,
  return_note TEXT,
  was_late BOOLEAN
);
CREATE TABLE IF NOT EXISTS docs(
  id TEXT PRIMARY KEY,
  code TEXT,
  title TEXT,
  cat TEXT,
  ver INT,
  status TEXT,
  size TEXT,
  fmt TEXT,
  at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS leaves(
  id TEXT PRIMARY KEY,
  no TEXT,
  kind TEXT,
  type TEXT,
  user TEXT REFERENCES users(id),
  from_at TIMESTAMPTZ,
  to_at TIMESTAMPTZ,
  date TIMESTAMPTZ,
  h1 TEXT,
  h2 TEXT,
  days NUMERIC,
  hours NUMERIC,
  reason TEXT,
  note TEXT,
  status TEXT,
  reject_reason TEXT,
  files JSONB,
  trail JSONB
);
CREATE TABLE IF NOT EXISTS plan_events(
  id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT,
  prio TEXT,
  status TEXT,
  date TIMESTAMPTZ,
  h1 TEXT,
  h2 TEXT,
  dur NUMERIC,
  descr TEXT,
  goals TEXT,
  note TEXT,
  files JSONB,
  imgs JSONB,
  links JSONB,
  who TEXT REFERENCES users(id),
  team JSONB,
  unit TEXT,
  factory TEXT,
  project_id TEXT,
  wo_id TEXT,
  asset_id TEXT,
  sub_asset_id TEXT,
  req_id TEXT,
  pm_id TEXT,
  hse_id TEXT,
  progress NUMERIC,
  tasks JSONB,
  reports JSONB,
  trail JSONB
);
CREATE TABLE IF NOT EXISTS comments(
  id TEXT PRIMARY KEY,
  ent TEXT,
  rec_id TEXT,
  parent TEXT,
  t TIMESTAMPTZ,
  by_user TEXT,
  by_id TEXT,
  text TEXT,
  atts JSONB,
  mentions JSONB
);
CREATE TABLE IF NOT EXISTS audit_x(
  id TEXT PRIMARY KEY,
  t TIMESTAMPTZ,
  u TEXT,
  uid TEXT,
  role TEXT,
  action TEXT,
  mod TEXT,
  entity TEXT,
  note TEXT,
  before JSONB,
  after JSONB
);
CREATE TABLE IF NOT EXISTS msg_groups(
  id TEXT PRIMARY KEY,
  name TEXT,
  owner TEXT,
  members JSONB,
  access TEXT
);
CREATE TABLE IF NOT EXISTS messages(
  id BIGSERIAL PRIMARY KEY,
  chat_key TEXT NOT NULL,
  by_user TEXT REFERENCES users(id),
  at TIMESTAMPTZ DEFAULT now(),
  body TEXT,
  img TEXT,
  file JSONB,
  voice TEXT,
  reply_to BIGINT,
  seen_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wo_asset ON work_orders(asset_id);
CREATE INDEX IF NOT EXISTS idx_wo_status ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_key);
CREATE INDEX IF NOT EXISTS idx_audit_t ON audit_x(t DESC);


-- Bespar 1 organizational categories and data-quality extensions

-- Organizational category is intentionally separate from functional location.
-- A factory has many categories; each asset belongs to one category.
CREATE TABLE IF NOT EXISTS asset_categories (
  id TEXT PRIMARY KEY,
  factory_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(factory_asset_id, code),
  UNIQUE(factory_asset_id, name)
);

ALTER TABLE assets ADD COLUMN IF NOT EXISTS category_id TEXT REFERENCES asset_categories(id) ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS requires_coding BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE items ADD COLUMN IF NOT EXISTS ext JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS recurring BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS ext JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Data-quality fields make provisional 1405 values explicit and queryable.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS confirmation_status TEXT NOT NULL DEFAULT 'confirmed';
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS provisional_fields JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS period_label TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS asset_spare_parts (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'key-spare',
  quantity_required NUMERIC,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(asset_id, item_id)
);

-- A WO can have one primary asset and additional related/candidate assets.
CREATE TABLE IF NOT EXISTS work_order_assets (
  work_order_id TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('primary','related','candidate')),
  is_confirmed BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(work_order_id, asset_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_asset_categories_factory ON asset_categories(factory_asset_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_assets_category ON assets(category_id);
CREATE INDEX IF NOT EXISTS idx_wo_confirmation ON work_orders(confirmation_status) WHERE confirmation_status <> 'confirmed';
CREATE INDEX IF NOT EXISTS idx_wo_period_label ON work_orders(period_label);
CREATE INDEX IF NOT EXISTS idx_wo_assets_asset ON work_order_assets(asset_id);


-- Equipment V2 Phase 1 foundation

-- Phase 1 is additive. Existing columns and records remain untouched.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS delete_reason TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS health_score NUMERIC(5,2) CHECK (health_score IS NULL OR (health_score >= 0 AND health_score <= 100));
ALTER TABLE assets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  rollout_percent SMALLINT NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  allowed_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO feature_flags(key,enabled,rollout_percent,allowed_roles,metadata)
VALUES('equipment_v2',TRUE,100,'["admin","mgr","planner","tech","op","store","hse","cal"]'::jsonb,
       '{"phase":1,"fallback":"classic-equipment"}'::jsonb)
ON CONFLICT(key) DO NOTHING;

CREATE TABLE IF NOT EXISTS system_restore_points (
  id UUID PRIMARY KEY,
  scope TEXT NOT NULL,
  label TEXT NOT NULL,
  storage_path TEXT,
  checksum TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('creating','created','verified','failed','restored')),
  table_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_assets_parent_active_order ON assets(parent, is_active, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_equipment_list ON assets(type, category_id, status, crit) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_search_lower_name ON assets(lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_updated_at ON assets(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pm_asset_last ON pm_plans(asset_id,last_run DESC);
CREATE INDEX IF NOT EXISTS idx_restore_points_scope_time ON system_restore_points(scope,created_at DESC);


-- Second Correction foundation
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


-- AI orchestration foundation
BEGIN;

-- Provider-neutral backend AI orchestration and deterministic health foundations.
INSERT INTO role_permissions(role,permission) VALUES
 ('admin','ai.use'),('admin','ai.review'),('admin','ai.configure'),('mgr','ai.use'),('mgr','ai.review'),
 ('planner','ai.use'),('planner','ai.review'),('tech','ai.use'),('hse','ai.use')
ON CONFLICT(role,permission) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_provider_policies (
  provider TEXT PRIMARY KEY CHECK(provider IN ('local','deepseek','gemini')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  allowed_purposes JSONB NOT NULL DEFAULT '[]'::jsonb,
  allow_sensitive_context BOOLEAN NOT NULL DEFAULT false,
  allow_search BOOLEAN NOT NULL DEFAULT false,
  data_region_note TEXT,
  updated_by TEXT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version BIGINT NOT NULL DEFAULT 1
);
INSERT INTO ai_provider_policies(provider,enabled,allowed_purposes,allow_sensitive_context,allow_search,data_region_note) VALUES
 ('local',true,'["failure_diagnosis","rca","repair_recommendation","wizard_suggestion","pm_review","checklist_review","trend_analysis"]',true,false,'On-premise preferred'),
 ('deepseek',false,'["failure_diagnosis","rca","repair_recommendation","trend_analysis"]',false,false,'Enable only after data-processing approval'),
 ('gemini',false,'["failure_diagnosis","repair_recommendation","wizard_suggestion","pm_review","checklist_review"]',false,false,'Enable only in an officially supported deployment region')
ON CONFLICT(provider) DO NOTHING;

CREATE TABLE IF NOT EXISTS checklist_templates (
  id UUID PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  equipment_class TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  items JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','inactive')),
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_version BIGINT NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS checklist_executions (
  id UUID PRIMARY KEY,
  template_id UUID NOT NULL REFERENCES checklist_templates(id),
  equipment_id TEXT NOT NULL REFERENCES assets(id),
  work_order_id TEXT REFERENCES work_orders(id),
  started_by TEXT NOT NULL REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed','cancelled','pending_sync')),
  overall_status TEXT CHECK(overall_status IN ('passed','acceptable','failed','incomplete')),
  provenance_status TEXT NOT NULL DEFAULT 'verified',
  row_version BIGINT NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS checklist_results (
  execution_id UUID NOT NULL REFERENCES checklist_executions(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('ok','nok','na')),
  value_numeric NUMERIC,
  value_text TEXT,
  unit TEXT,
  note TEXT,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  recorded_by TEXT NOT NULL REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(execution_id,item_key)
);

CREATE TABLE IF NOT EXISTS equipment_health_snapshots (
  id UUID PRIMARY KEY,
  equipment_id TEXT NOT NULL REFERENCES assets(id),
  score NUMERIC(5,2) CHECK(score BETWEEN 0 AND 100),
  status TEXT NOT NULL CHECK(status IN ('calculated','insufficient_data')),
  factors JSONB NOT NULL,
  model_version TEXT NOT NULL,
  evidence_cutoff TIMESTAMPTZ NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(equipment_id,evidence_cutoff,model_version)
);
CREATE TABLE IF NOT EXISTS ai_feedback (
  id UUID PRIMARY KEY,
  recommendation_id UUID NOT NULL REFERENCES ai_recommendations(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('helpful','not_helpful','partially_helpful','incorrect','unsafe')),
  note TEXT,
  verified_result JSONB,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checklist_execution_equipment ON checklist_executions(equipment_id,started_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_equipment_time ON equipment_health_snapshots(equipment_id,calculated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_run_equipment_time ON ai_runs(equipment_id,created_at DESC);

COMMIT;
