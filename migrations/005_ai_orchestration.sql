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
