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
