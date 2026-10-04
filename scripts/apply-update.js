'use strict';

const path = require('path');
require('dotenv').config();
const { Pool } = require('pg');
const { assertBackup, applyPending } = require('../server/update-service');

const backupPath = process.argv[2] || process.env.BACKUP_PATH;

async function main() {
  assertBackup(backupPath);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await applyPending({
      pool,
      migrationsDir: path.join(__dirname, '..', 'migrations'),
      backupPath,
      user: { id: null, name: 'system', username: 'system', role: 'admin' }
    });
    console.log(JSON.stringify({ applied: result.applied, skipped: result.skipped }));
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(error && error.code ? error.code : 'UPDATE_FAILED');
  process.exitCode = 1;
});
