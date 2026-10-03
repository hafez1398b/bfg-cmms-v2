'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function createAdmin() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    const username = process.env.ADMIN_USERNAME || 'admin';
    const rawPassword = process.env.ADMIN_INITIAL_PASSWORD;
    if (!rawPassword || rawPassword.length < 12) throw new Error('ADMIN_INITIAL_PASSWORD with at least 12 characters is required');
    const passwordHash = await bcrypt.hash(rawPassword, 12);
    const result = await pool.query(
        `INSERT INTO users (id, username, pass_hash, name, role, unit, active)
         VALUES ($1, $2, $3, $4, 'admin', $5, true)
         ON CONFLICT (username) DO UPDATE SET
           pass_hash=EXCLUDED.pass_hash,
           name=EXCLUDED.name,
           role='admin',
           unit=EXCLUDED.unit,
           active=true
         RETURNING id,username,name,role,unit,active`,
        ['u1', username, passwordHash, 'حافظ بایرامیان', 'مدیریت سیستم']
    );
    console.log('System administrator configured:', result.rows[0].username, '-', result.rows[0].name);
}

createAdmin()
  .then(() => pool.end())
  .catch(async error => { console.error('Admin provisioning failed:', error.message); await pool.end().catch(()=>{}); process.exitCode=1; });
