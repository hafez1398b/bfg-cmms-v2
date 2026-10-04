'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIGRATION_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/i;
const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BOOKKEEPING_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  backup_checksum TEXT NOT NULL,
  backup_path TEXT NOT NULL
)`;

function coded(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function hasRemoteReference(source) {
  const text = String(source || '');
  if (text.includes('eval(')) return true;
  if (text.includes('new Function')) return true;
  if (text.includes('importScripts')) return true;
  if (/COPY\s+FROM\s+PROGRAM/i.test(text)) return true;
  if (text.includes('://')) return true;
  return false;
}

function assertBackup(backupPath, { now = Date.now(), maxAgeMs = BACKUP_MAX_AGE_MS, minBytes = 32 } = {}) {
  const raw = String(backupPath || '').trim();
  if (!raw) throw coded(422, 'BACKUP_REQUIRED');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw coded(422, 'BACKUP_MUST_BE_LOCAL_FILE');
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved)) throw coded(422, 'BACKUP_REQUIRED');
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size < minBytes) throw coded(422, 'BACKUP_INVALID');
  if (now - stat.mtimeMs > maxAgeMs) throw coded(422, 'BACKUP_STALE');
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
  const relative = path.relative(process.cwd(), resolved);
  return {
    path: resolved,
    storagePath: relative.startsWith('..') ? resolved : relative,
    checksum,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function listMigrationFiles(dir) {
  if (!dir || !fs.existsSync(dir)) throw coded(422, 'MIGRATIONS_DIR_MISSING');
  const names = fs.readdirSync(dir).filter(name => name.endsWith('.sql'));
  const invalid = names.filter(name => !MIGRATION_NAME.test(name));
  if (invalid.length) throw coded(422, 'MIGRATION_NAME_INVALID');
  const files = names.map(name => {
    const match = name.match(MIGRATION_NAME);
    const full = path.join(dir, name);
    const sql = fs.readFileSync(full, 'utf8');
    return {
      version: match[1],
      filename: name,
      path: full,
      checksum: crypto.createHash('sha256').update(sql).digest('hex'),
      sql
    };
  }).sort((left, right) => Number(left.version) - Number(right.version));
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.version)) throw coded(422, 'MIGRATION_VERSION_DUPLICATE');
    seen.add(file.version);
  }
  return files;
}

async function writeAudit(pool, user, action, entity, note, before, after) {
  await pool.query(
    'INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after) VALUES($1,now(),$2,$3,$4,$5,\'system\',$6,$7,$8,$9)',
    [
      crypto.randomUUID(),
      user.name || user.username || 'system',
      user.id || 'system',
      user.role || 'admin',
      action,
      entity,
      note,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null
    ]
  );
}

async function recordRestorePoint(pool, backup) {
  await pool.query(
    'INSERT INTO system_restore_points(id, scope, label, storage_path, checksum, status, metadata, verified_at) VALUES($1,\'application-update\',$2,$3,$4,\'verified\',$5,now())',
    [
      crypto.randomUUID(),
      'Before application update',
      backup.storagePath,
      backup.checksum,
      JSON.stringify({ bytes: backup.bytes, format: 'file', verifiedBeforeMigration: true })
    ]
  );
}

async function applyPending({ pool, migrationsDir, backupPath, user, now, maxAgeMs } = {}) {
  const actor = user || { id: 'system', name: 'system', username: 'system', role: 'admin' };
  const backup = assertBackup(backupPath, { now, maxAgeMs });
  await pool.query(BOOKKEEPING_SQL);
  const readiness = await pool.query("SELECT to_regclass('public.audit_x') AS audit_x, to_regclass('public.system_restore_points') AS restore_points");
  if (!readiness.rows[0] || !readiness.rows[0].audit_x) throw coded(503, 'AUDIT_UNAVAILABLE');
  if (readiness.rows[0].restore_points) await recordRestorePoint(pool, backup);
  const files = listMigrationFiles(migrationsDir);
  const applied = [];
  const skipped = [];
  await writeAudit(pool, actor, 'update_started', 'release', 'بررسی پشتیبان قبل از مهاجرت', null, {
    backupChecksum: backup.checksum,
    backupBytes: backup.bytes,
    migrations: files.map(file => file.version)
  });
  for (const file of files) {
    if (hasRemoteReference(file.sql)) {
      await writeAudit(pool, actor, 'migration_failed', file.version, 'REMOTE_CODE_REJECTED', null, { filename: file.filename });
      throw coded(422, 'REMOTE_CODE_REJECTED');
    }
    const existing = await pool.query('SELECT checksum FROM schema_migrations WHERE version=$1', [file.version]);
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== file.checksum) {
        await writeAudit(pool, actor, 'migration_failed', file.version, 'MIGRATION_CHECKSUM_MISMATCH', null, { filename: file.filename });
        throw coded(409, 'MIGRATION_CHECKSUM_MISMATCH');
      }
      skipped.push(file.version);
      await writeAudit(pool, actor, 'migration_skipped', file.version, 'already applied', null, { filename: file.filename, checksum: file.checksum });
      continue;
    }
    try {
      await pool.query(file.sql);
      await pool.query(
        'INSERT INTO schema_migrations(version, filename, checksum, backup_checksum, backup_path) VALUES($1,$2,$3,$4,$5)',
        [file.version, file.filename, file.checksum, backup.checksum, backup.storagePath]
      );
      await writeAudit(pool, actor, 'migration_applied', file.version, file.filename, null, { checksum: file.checksum, backupChecksum: backup.checksum });
      applied.push(file.version);
    } catch (error) {
      await pool.query('ROLLBACK').catch(() => {});
      await writeAudit(pool, actor, 'migration_failed', file.version, error.code || 'MIGRATION_FAILED', null, { filename: file.filename }).catch(() => {});
      throw coded(500, 'MIGRATION_FAILED');
    }
  }
  await writeAudit(pool, actor, 'update_finished', 'release', 'مهاجرت تمام شد', null, { applied, skipped, backupChecksum: backup.checksum });
  return { applied, skipped, backup };
}

module.exports = {
  assertBackup,
  listMigrationFiles,
  applyPending,
  hasRemoteReference,
  BACKUP_MAX_AGE_MS
};
