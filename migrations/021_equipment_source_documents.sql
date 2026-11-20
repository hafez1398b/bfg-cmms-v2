-- Dossier-linked source documents. Uploads are private, content-addressed files; this migration
-- stores only metadata and approval state. No asset rows or existing documents are backfilled.
BEGIN;

CREATE TABLE IF NOT EXISTS equipment_source_documents (
  id UUID PRIMARY KEY,
  equipment_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  extension TEXT NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN ('markdown','excel','image','manual','bom','engineering_model')),
  mime_type TEXT NOT NULL,
  revision TEXT,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  approval_status TEXT NOT NULL DEFAULT 'pending_review' CHECK (approval_status IN ('pending_review','approved','rejected')),
  row_version BIGINT NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  uploader_id TEXT NOT NULL REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  approved_by TEXT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  review_note TEXT,
  UNIQUE(equipment_id, sha256),
  CHECK ((approval_status='approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
      OR approval_status<>'approved')
);

CREATE INDEX IF NOT EXISTS idx_equipment_source_documents_equipment
  ON equipment_source_documents(equipment_id, uploaded_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_equipment_source_documents_approved
  ON equipment_source_documents(equipment_id, approval_status, document_type, uploaded_at DESC);

COMMIT;
