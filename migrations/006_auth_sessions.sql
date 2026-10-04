-- Additive auth sessions. Refresh material is stored only as an HMAC-SHA256 hash.
-- Fresh installs also receive these tables from schema.sql via company bootstrap.

BEGIN;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  previous_refresh_token_hash TEXT,
  csrf_token_hash TEXT NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  rotated_at TIMESTAMPTZ,
  user_agent TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_refresh_hash
  ON auth_sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_previous_refresh
  ON auth_sessions(previous_refresh_token_hash)
  WHERE previous_refresh_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
  ON auth_sessions(user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS login_attempts (
  id UUID PRIMARY KEY,
  subject_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  succeeded BOOLEAN NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_window
  ON login_attempts(subject_hash, ip_hash, attempted_at DESC);

COMMIT;
