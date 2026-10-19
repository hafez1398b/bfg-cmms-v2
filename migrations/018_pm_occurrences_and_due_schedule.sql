-- Phase 3-A: PM schedule integrity, occurrence ledger and idempotent PM work orders.
-- Additive and rerunnable. Apply only through the existing backup-gated update service.
BEGIN;

ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS schedule_basis TEXT;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS first_due_at TIMESTAMPTZ;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS next_due_at TIMESTAMPTZ;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS tolerance_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS estimated_duration_minutes INTEGER;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS required_skill TEXT;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS required_personnel INTEGER;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS required_tools JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS required_parts JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS safety_requirements JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS loto_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS ptw_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS instructions TEXT;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS last_completed_at TIMESTAMPTZ;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS archived_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS archive_reason TEXT;
ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS provenance_status TEXT NOT NULL DEFAULT 'legacy_unverified';

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS occurrence_id TEXT;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source_ref TEXT;

CREATE TABLE IF NOT EXISTS pm_occurrences (
  id TEXT PRIMARY KEY,
  pm_plan_id TEXT NOT NULL,
  equipment_id TEXT NOT NULL,
  period_key TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  due_meter_value NUMERIC,
  status TEXT NOT NULL DEFAULT 'scheduled',
  generated_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  completion_source TEXT,
  provenance_status TEXT NOT NULL DEFAULT 'verified',
  row_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_by TEXT,
  CONSTRAINT pm_occurrences_pm_plan_fk FOREIGN KEY (pm_plan_id) REFERENCES pm_plans(id),
  CONSTRAINT pm_occurrences_equipment_fk FOREIGN KEY (equipment_id) REFERENCES assets(id),
  CONSTRAINT pm_occurrences_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT pm_occurrences_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT pm_occurrences_status_check CHECK (status IN (
    'scheduled','due','overdue','work_order_generated','in_progress','completed','cancelled','skipped'
  )),
  CONSTRAINT pm_occurrences_row_version_check CHECK (row_version >= 1)
);

-- Additive completion of an earlier partial rollout. Fresh installs already have these columns.
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS id TEXT;
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS pm_plan_id TEXT;
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS equipment_id TEXT;
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS period_key TEXT;
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS due_meter_value NUMERIC;
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'scheduled';
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ;
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS completion_source TEXT;
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS provenance_status TEXT NOT NULL DEFAULT 'verified';
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE pm_occurrences ADD COLUMN IF NOT EXISTS updated_by TEXT;

DO $migration_018_occurrence_integrity$
BEGIN
  IF EXISTS (SELECT 1 FROM pm_occurrences WHERE id IS NULL OR pm_plan_id IS NULL OR equipment_id IS NULL OR period_key IS NULL OR due_at IS NULL) THEN
    RAISE EXCEPTION 'Migration 018 found incomplete PM occurrence rows; inspect them read-only before retrying'
      USING ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pm_occurrences GROUP BY id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Migration 018 found duplicate PM occurrence ids; inspect them read-only before retrying'
      USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='pm_occurrences'::regclass AND contype='p'
  ) THEN
    ALTER TABLE pm_occurrences ADD CONSTRAINT pm_occurrences_pkey PRIMARY KEY(id);
  END IF;
  ALTER TABLE pm_occurrences ALTER COLUMN id SET NOT NULL;
  ALTER TABLE pm_occurrences ALTER COLUMN pm_plan_id SET NOT NULL;
  ALTER TABLE pm_occurrences ALTER COLUMN equipment_id SET NOT NULL;
  ALTER TABLE pm_occurrences ALTER COLUMN period_key SET NOT NULL;
  ALTER TABLE pm_occurrences ALTER COLUMN due_at SET NOT NULL;

  IF EXISTS (SELECT 1 FROM pm_occurrences WHERE status NOT IN (
    'scheduled','due','overdue','work_order_generated','in_progress','completed','cancelled','skipped'
  )) THEN
    RAISE EXCEPTION 'Migration 018 found an unknown PM occurrence status; inspect it read-only before retrying'
      USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='pm_occurrences'::regclass AND conname='pm_occurrences_status_check') THEN
    ALTER TABLE pm_occurrences ADD CONSTRAINT pm_occurrences_status_check CHECK (status IN (
      'scheduled','due','overdue','work_order_generated','in_progress','completed','cancelled','skipped'
    ));
  END IF;
  IF EXISTS (SELECT 1 FROM pm_occurrences WHERE row_version < 1) THEN
    RAISE EXCEPTION 'Migration 018 found an invalid PM occurrence row_version; inspect it read-only before retrying'
      USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='pm_occurrences'::regclass AND conname='pm_occurrences_row_version_check') THEN
    ALTER TABLE pm_occurrences ADD CONSTRAINT pm_occurrences_row_version_check CHECK (row_version >= 1);
  END IF;
  IF EXISTS (SELECT 1 FROM pm_occurrences GROUP BY pm_plan_id,period_key HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Migration 018 found duplicate PM plan/period occurrences; inspect them read-only before retrying'
      USING ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM work_orders w LEFT JOIN pm_occurrences o ON o.id=w.occurrence_id
             WHERE w.occurrence_id IS NOT NULL AND o.id IS NULL) THEN
    RAISE EXCEPTION 'Migration 018 found work_orders.occurrence_id values without an occurrence; inspect them read-only before retrying'
      USING ERRCODE='P0001';
  END IF;
END
$migration_018_occurrence_integrity$;

DO $migration_018_occurrence_foreign_keys$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='pm_occurrences'::regclass AND conname='pm_occurrences_pm_plan_fk') THEN
    ALTER TABLE pm_occurrences ADD CONSTRAINT pm_occurrences_pm_plan_fk FOREIGN KEY (pm_plan_id) REFERENCES pm_plans(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='pm_occurrences'::regclass AND conname='pm_occurrences_equipment_fk') THEN
    ALTER TABLE pm_occurrences ADD CONSTRAINT pm_occurrences_equipment_fk FOREIGN KEY (equipment_id) REFERENCES assets(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='pm_occurrences'::regclass AND conname='pm_occurrences_created_by_fk') THEN
    ALTER TABLE pm_occurrences ADD CONSTRAINT pm_occurrences_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='pm_occurrences'::regclass AND conname='pm_occurrences_updated_by_fk') THEN
    ALTER TABLE pm_occurrences ADD CONSTRAINT pm_occurrences_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='work_orders'::regclass AND conname='work_orders_occurrence_fk') THEN
    ALTER TABLE work_orders ADD CONSTRAINT work_orders_occurrence_fk FOREIGN KEY (occurrence_id) REFERENCES pm_occurrences(id);
  END IF;
END
$migration_018_occurrence_foreign_keys$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_occurrences_plan_period_unique
  ON pm_occurrences(pm_plan_id,period_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_orders_occurrence_unique
  ON work_orders(occurrence_id) WHERE occurrence_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_plans_active_asset_code_unique
  ON pm_plans(asset_id,code)
  WHERE code IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pm_occurrences_plan ON pm_occurrences(pm_plan_id);
CREATE INDEX IF NOT EXISTS idx_pm_occurrences_equipment ON pm_occurrences(equipment_id);
CREATE INDEX IF NOT EXISTS idx_pm_occurrences_due_at ON pm_occurrences(due_at);
CREATE INDEX IF NOT EXISTS idx_pm_occurrences_status ON pm_occurrences(status);
CREATE INDEX IF NOT EXISTS idx_pm_plans_archived ON pm_plans(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pm_plans_next_due ON pm_plans(next_due_at) WHERE archived_at IS NULL AND deleted_at IS NULL;

-- Legacy interval_days is explicitly a calendar interval. A historical last_run is not evidence.
UPDATE pm_plans
SET schedule_basis='calendar'
WHERE schedule_basis IS NULL AND (interval_days > 0 OR first_due_at IS NOT NULL);

-- A soft archive written by the prior API remains restorable; its unknown reason remains NULL.
UPDATE pm_plans
SET archived_at=deleted_at,
    archived_by=COALESCE(archived_by,updated_by)
WHERE deleted_at IS NOT NULL AND archived_at IS NULL;

-- Only a completed/closed PM work order with a valid end timestamp and report is trusted.
WITH parsed_completion AS (
  SELECT w.pm_id,
    CASE
      WHEN (w.times->>'end') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
       AND NULLIF(btrim(w.report->>'text'),'') IS NOT NULL
      THEN (w.times->>'end')::timestamptz
      ELSE NULL
    END AS completed_at
  FROM work_orders w
  JOIN pm_plans p ON p.id=w.pm_id
  WHERE w.pm_id IS NOT NULL
    AND w.status IN ('done','closed','completed')
), verified_completion AS (
  SELECT DISTINCT ON (pm_id) pm_id,completed_at
  FROM parsed_completion
  WHERE completed_at IS NOT NULL AND completed_at <= now()
  ORDER BY pm_id,completed_at DESC
)
UPDATE pm_plans p
SET last_completed_at=verified_completion.completed_at,
    last_run=verified_completion.completed_at,
    next_due_at=CASE
      WHEN p.schedule_basis='calendar' AND p.interval_days > 0
        THEN verified_completion.completed_at+(p.interval_days||' days')::interval
      ELSE NULL
    END,
    provenance_status='verified',
    updated_at=now(),
    row_version=p.row_version+1
FROM verified_completion
WHERE p.id=verified_completion.pm_id
  AND p.last_completed_at IS NULL
  AND (
    p.last_run IS DISTINCT FROM verified_completion.completed_at
    OR p.next_due_at IS DISTINCT FROM CASE
      WHEN p.schedule_basis='calendar' AND p.interval_days > 0
        THEN verified_completion.completed_at+(p.interval_days||' days')::interval
      ELSE NULL
    END
    OR p.provenance_status IS DISTINCT FROM 'verified'
  );

-- Do not infer a completion from legacy last_run. Keep the raw value for audit context,
-- mark it unverified, and leave next_due_at at an explicit first_due_at only when supplied.
UPDATE pm_plans p
SET last_completed_at=NULL,
    next_due_at=p.first_due_at,
    provenance_status='legacy_unverified',
    updated_at=now(),
    row_version=p.row_version+1
WHERE p.last_completed_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM work_orders w
    WHERE w.pm_id=p.id AND w.status IN ('done','closed','completed')
      AND NULLIF(btrim(w.report->>'text'),'') IS NOT NULL
      AND (w.times->>'end') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
  )
  AND (
    p.next_due_at IS DISTINCT FROM p.first_due_at
    OR p.provenance_status IS DISTINCT FROM 'legacy_unverified'
  );

DO $migration_018_pm_code_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pm_plans
    WHERE asset_id IS NOT NULL
      AND code IS NOT NULL
      AND archived_at IS NULL
      AND deleted_at IS NULL
    GROUP BY asset_id,code
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migration 018 found duplicate active PM codes for an asset; inspect pm_plans read-only before retrying'
      USING ERRCODE='P0001';
  END IF;
END
$migration_018_pm_code_guard$;

INSERT INTO role_permissions(role,permission) VALUES
  ('mgr','pm.restore'),('mgr','pm.schedule'),
  ('planner','pm.restore'),('planner','pm.schedule')
ON CONFLICT(role,permission) DO NOTHING;

COMMIT;
