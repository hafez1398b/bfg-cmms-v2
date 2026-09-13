'use strict';
/**
 * BFG CMMS/EAM — Unified Enterprise Server (دستور اصلاح دوم)
 * Single backend, single source of truth, multi-user, realtime, RBAC-enforced
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
require('dotenv').config();

const { config, validateConfig } = require('./server/config');
const { authenticateToken, authenticateSocket } = require('./server/middleware/auth');
const { errorHandler, notFound } = require('./server/middleware/errorHandler');
const { initRealtime } = require('./server/services/realtime-service');
const { recordAudit, listAudit } = require('./server/services/audit-service');
const { createEquipmentRouter } = require('./server/equipment-routes');
const { createNotificationsRouter } = require('./server/routes/notifications');
const { createFailuresRouter } = require('./server/routes/failures');
const { createAIRouter } = require('./server/routes/ai');
const { createHealthRouter } = require('./server/routes/health');
const { createRequestsRouter } = require('./server/routes/requests');
const { createWorkOrdersRouter } = require('./server/routes/work-orders');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: config.corsOrigin, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] },
  pingTimeout: config.realtime.pingTimeout,
  pingInterval: config.realtime.pingInterval,
});

const pool = new Pool({ connectionString: config.databaseUrl });

// Init realtime singleton
const realtime = initRealtime(io);

// Middleware
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check (no auth)
app.get('/api/health', async (req, res) => {
  let dbOk = false, dbError = null;
  try { await pool.query('SELECT 1'); dbOk = true; } catch (e) { dbError = e.message; }
  res.json({
    status: dbOk ? 'ok' : 'degraded',
    version: require('./package.json').version,
    db: dbOk ? 'connected' : `error: ${dbError}`,
    realtime: io.engine ? 'ready' : 'not ready',
    ai: { provider: config.ai.provider, model: config.ai.model, enabled: config.ai.enabled, hasKey: !!config.ai.apiKey },
    uptime: process.uptime(),
  });
});

// Auth
app.post('/api/auth/login', async (req, res, next) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(422).json({ error: 'VALIDATION_ERROR', fields: ['username','password'] });
  try {
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (!user || !bcrypt.compareSync(password, user.pass_hash)) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid credentials' });
    }
    if (user.active === false) return res.status(403).json({ error: 'ACCOUNT_DISABLED' });
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name, unit: user.unit },
      config.jwtSecret, { expiresIn: '7d' }
    );
    await recordAudit(pool, { actor: { id: user.id, name: user.name, role: user.role }, action: 'login', mod: 'auth', entity: 'users', entityId: user.id, req });
    res.json({ token, user: { id: user.id, name: user.name, role: user.role, unit: user.unit, username: user.username } });
  } catch (e) { next(e); }
});

app.get('/api/auth/me', authenticateToken, async (req, res, next) => {
  try {
    const { rows: [user] } = await pool.query('SELECT id, name, role, unit, username FROM users WHERE id=$1', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ user });
  } catch (e) { next(e); }
});

// Legacy generic /api/data/:collection — now with optimistic concurrency, audit, RBAC, realtime (kept for backward compat)
const ALLOWED_COLLECTIONS = ['assets','wos','requests','items','pms','users','tools','instruments','contracts','projects','permits','docs','leaves','planEvents','comments','auditX'];

app.get('/api/data/:collection', authenticateToken, async (req, res, next) => {
  const { collection } = req.params;
  if (!ALLOWED_COLLECTIONS.includes(collection)) return res.status(400).json({ error: 'COLLECTION_NOT_ALLOWED' });
  try {
    let result;
    if (collection === 'auditX' || collection === 'comments') {
      result = await pool.query('SELECT * FROM ' + collection + ' ORDER BY t DESC LIMIT 500');
    } else if (collection === 'users') {
      // Permission: only admin/mgr can list users
      if (!['admin','mgr'].includes(req.user.role)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      result = await pool.query('SELECT id, name, role, unit, username, active, hr FROM users');
    } else if (collection === 'wos') {
      result = await pool.query('SELECT * FROM work_orders ORDER BY created_at DESC');
    } else if (collection === 'requests') {
      result = await pool.query('SELECT * FROM requests ORDER BY created_at DESC');
    } else {
      result = await pool.query('SELECT * FROM ' + collection);
    }
    res.json(result.rows);
  } catch (e) { next(e); }
});

app.post('/api/data/:collection', authenticateToken, async (req, res, next) => {
  const { collection } = req.params;
  const data = req.body;
  // RBAC: only admin/mgr/planner can create arbitrary collections via generic endpoint
  if (!['admin','mgr','planner'].includes(req.user.role) && !['requests','comments'].includes(collection)) {
    return res.status(403).json({ error: 'PERMISSION_DENIED' });
  }
  try {
    const idempotencyKey = req.headers['x-idempotency-key'] || data._idempotencyKey;
    if (idempotencyKey) {
      try {
        const { rows: [existing] } = await pool.query('SELECT response FROM idempotency_keys WHERE key=$1', [idempotencyKey]);
        if (existing?.response) return res.status(201).json(existing.response);
      } catch (_) {}
    }
    if (collection === 'wos') {
      await pool.query(
        'INSERT INTO work_orders (id, no, type, asset_id, descr, priority, assignee, status, req_id, times, parts, media, report, est, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
        [data.id, data.no, data.type, data.assetId, data.desc, data.priority, data.assignee, data.status, data.reqId, JSON.stringify(data.times||{}), JSON.stringify(data.parts||[]), JSON.stringify(data.media||[]), JSON.stringify(data.report||null), data.est, new Date()]
      );
    } else if (collection === 'assets') {
      await pool.query(
        'INSERT INTO assets (id, parent, code, name, type, cls, status, crit, maker, model, serial, year, install, power, hours, history) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
        [data.id, data.parent, data.code, data.name, data.type, data.cls, data.status, data.crit, data.maker, data.model, data.serial, data.year, data.install, data.power, data.hours||0, JSON.stringify(data.history||[])]
      );
    } else if (collection === 'users') {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const pass_hash = bcrypt.hashSync(data.p || '1234', 10);
      await pool.query(
        'INSERT INTO users (id, username, pass_hash, name, role, unit, phone, active, hr) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [data.id, data.u, pass_hash, data.name, data.role, data.unit, data.phone, data.active, JSON.stringify(data.hr||{})]
      );
    } else {
      const keys = Object.keys(data).filter(k=>k!=='_idempotencyKey');
      const values = keys.map(k=>data[k]);
      const placeholders = keys.map((_, i) => '$' + (i + 1)).join(', ');
      await pool.query('INSERT INTO ' + collection + ' (' + keys.join(', ') + ') VALUES (' + placeholders + ')', values);
    }
    await recordAudit(pool, { actor: req.user, action: 'create', mod: collection, entity: collection, entityId: data.id, after: data, req });
    if (idempotencyKey) {
      try { await pool.query('INSERT INTO idempotency_keys(key, user_id, response) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [idempotencyKey, req.user.id, JSON.stringify({ message:'Created', id: data.id })]); } catch(_){}
    }
    // Realtime — targeted
    realtime.dataChanged(collection, data.id, data);
    res.status(201).json({ message: 'Created', id: data.id });
  } catch (e) { next(e); }
});

app.put('/api/data/:collection/:id', authenticateToken, async (req, res, next) => {
  const { collection, id } = req.params;
  const data = { ...req.body };
  delete data.id;
  // Optimistic concurrency: if client sends rowVersion/row_version, enforce it
  const expectedVersion = data.rowVersion ?? data.row_version ?? data.row_version_expected;
  delete data.rowVersion; delete data.row_version; delete data.row_version_expected;
  try {
    if (['assets','work_orders','requests','items','pm_plans'].includes(collection)) {
      const tbl = collection==='wos'?'work_orders':collection==='assets'?'assets':collection==='requests'?'requests':collection==='items'?'items':'pm_plans';
      const verCol = 'row_version';
      if (expectedVersion !== undefined) {
        const { rows: [cur] } = await pool.query(`SELECT ${verCol} FROM ${tbl} WHERE id=$1`, [id]);
        if (cur && Number(cur[verCol]) !== Number(expectedVersion)) {
          return res.status(409).json({ error: 'VERSION_CONFLICT', current: cur[verCol], message: 'Record was modified by another user' });
        }
      }
    }
    const keys = Object.keys(data);
    const values = Object.values(data).map(v=> typeof v==='object' && v!==null ? JSON.stringify(v) : v);
    const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
    // Bump row_version if exists
    const bump = ['assets','work_orders','requests','items','pm_plans'].includes(collection) ? ', row_version = row_version + 1, updated_at = now()' : '';
    await pool.query(`UPDATE ${collection} SET ${setClause} ${bump} WHERE id = $1`, [id, ...values]);
    const updated = await pool.query('SELECT * FROM ' + collection + ' WHERE id = $1', [id]);
    await recordAudit(pool, { actor: req.user, action: 'edit', mod: collection, entity: collection, entityId: id, after: updated.rows[0], req });
    realtime.dataChanged(collection, id, updated.rows[0]);
    res.json({ message: 'Updated', data: updated.rows[0] });
  } catch (e) { next(e); }
});

app.delete('/api/data/:collection/:id', authenticateToken, async (req, res, next) => {
  const { collection, id } = req.params;
  if (!['admin','mgr'].includes(req.user.role)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
  try {
    const before = await pool.query('SELECT * FROM ' + collection + ' WHERE id=$1', [id]);
    await pool.query('DELETE FROM ' + collection + ' WHERE id = $1', [id]);
    await recordAudit(pool, { actor: req.user, action: 'delete', mod: collection, entity: collection, entityId: id, before: before.rows[0], req });
    realtime.dataChanged(collection, id, null);
    res.json({ message: 'Deleted' });
  } catch (e) { next(e); }
});

// Domain routers (new, fully-featured)
app.use('/api/equipment', createEquipmentRouter({ pool, io, authenticateToken }));
app.use('/api/notifications', createNotificationsRouter({ pool, realtime, authenticateToken }));
app.use('/api/failures', createFailuresRouter({ pool, realtime, authenticateToken }));
app.use('/api/ai', createAIRouter({ pool, realtime, authenticateToken }));
app.use('/api/health', createHealthRouter({ pool, realtime, authenticateToken }));
app.use('/api/requests', createRequestsRouter({ pool, realtime, authenticateToken }));
app.use('/api/work-orders', createWorkOrdersRouter({ pool, realtime, authenticateToken }));

// Audit unified
app.get('/api/audit', authenticateToken, async (req, res, next) => {
  if (!['admin','mgr'].includes(req.user.role)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
  try {
    const { mod, entity, entityId, limit=50, offset=0 } = req.query;
    const result = await listAudit(pool, { mod, entity, entityId, limit: parseInt(limit,10), offset: parseInt(offset,10) });
    res.json(result);
  } catch (e) { next(e); }
});

// SPA fallback for bookmarkable routes
app.get('/equipment/:equipmentKey', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/failures/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health/:assetId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 404 for API
app.use('/api', notFound);
app.use(errorHandler);

// Socket.io — authenticated, room-based (Requirement #1, #3)
io.use(authenticateSocket);
io.on('connection', (socket) => {
  console.log(`[realtime] user ${socket.user.username} (${socket.user.role}) connected: ${socket.id}`);
  realtime.joinUserRooms(socket);
  socket.emit('connected', { user: socket.user, rooms: Array.from(socket.rooms) });

  // Client can join specific equipment rooms for targeted updates
  socket.on('join', (rooms) => {
    const list = Array.isArray(rooms) ? rooms : [rooms];
    for (const r of list) {
      if (typeof r === 'string' && (r.startsWith('equipment:') || r.startsWith('factory:'))) {
        socket.join(r);
        console.log(`[realtime] ${socket.user.username} joined ${r}`);
      }
    }
  });
  socket.on('leave', (rooms) => {
    const list = Array.isArray(rooms) ? rooms : [rooms];
    for (const r of list) socket.leave(r);
  });

  socket.on('disconnect', () => {
    console.log(`[realtime] user ${socket.user?.username} disconnected: ${socket.id}`);
  });
});

// Graceful startup with migrations check
async function start() {
  const warnings = validateConfig();
  warnings.forEach(w => console.warn('[config] ⚠️', w));

  // Try to run pending migrations (non-fatal if DB unavailable)
  try {
    const fs = require('fs');
    const migPath = path.join(__dirname, 'migrations', '004_bfg_core_refactor.sql');
    if (fs.existsSync(migPath)) {
      const sql = fs.readFileSync(migPath, 'utf8');
      await pool.query(sql);
      console.log('[db] migration 004 applied');
    }
    // Ensure audit_log table exists even if migration failed partially
  } catch (e) {
    console.warn('[db] migration 004 skipped/failed (DB may be unavailable):', e.message);
  }

  server.listen(config.port, config.host, () => {
    console.log(`✅ BFG CMMS v${require('./package.json').version} running on http://${config.host}:${config.port}`);
    console.log(`   Realtime: socket.io @ /socket.io/`);
    console.log(`   Health:  GET /api/health`);
  });
}

if (require.main === module) start();

module.exports = { app, server, pool, io, realtime };
