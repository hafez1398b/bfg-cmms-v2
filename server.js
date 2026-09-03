/* =====================================================================
 * BFG CMMS/EAM — Server v2 (Sync & Multi-User)
 * Express + Socket.IO + PostgreSQL
 *
 * مدل داده:
 *   users    → تایپ‌شده (احراز هویت / مدیریت کاربران)
 *   entities → سند-محور JSONB برای همه کالکشن‌های سامانه
 *   meta     → کلید/مقدار (شمارنده شماره سند، وضعیت seed)
 *
 * API:
 *   POST /api/auth/login                {username,password} → {token,user}
 *   GET  /api/bootstrap                 ← {seeded,users,collections,serverTime}
 *   POST /api/seed          (اولین بار) {users,snapshots,seq}
 *   POST /api/sync/:collection          {kind,upserts,deletes,src}
 *   POST /api/seq/next                  {key,cur} → {n}  (اتمیک)
 *   POST /api/admin/reset   (admin)     پاک‌سازی داده‌ها برای seed مجدد
 *   GET  /api/health
 * Socket.IO: رویداد 'sync' برای همه کلاینت‌ها (به‌جز مبدأ) پخش می‌شود.
 * ===================================================================== */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'your_secret_key_change_me') {
    console.warn('⚠️  JWT_SECRET مقدار پیش‌فرض دارد — برای استقرار واقعی آن را در .env تغییر دهید.');
}

/* انتخاب دیتابیس: PostgreSQL واقعی (پیش‌فرض) یا pg-mem حافظه‌ای برای دمو/تست (PG_MEM=1) */
let Pool = null, usingMem = false, memDb = null;
if (process.env.PG_MEM === '1') {
    try {
        memDb = require('pg-mem').newDb();
        Pool = memDb.adapters.createPg().Pool;
        usingMem = true;
        console.log('🧪 دیتابیس حافظه‌ای pg-mem فعال شد (حالت دمو — داده‌ها با خاموشی سرور از بین می‌روند)');
    } catch (e) {
        console.error('❌ pg-mem یافت نشد — نصب کنید: npm i -D pg-mem');
        process.exit(1);
    }
}
if (!Pool) Pool = require('pg').Pool;
const pool = usingMem ? new Pool({}) : new Pool({ connectionString: process.env.DATABASE_URL });
if (pool.on) pool.on('error', (e) => console.error('PG pool error:', e.message));

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------ helpers ------------------------------ */
const COL_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const badCol = (c) => !COL_RE.test(c);

function userToClient(row) {
    const extra = row.extra || {};
    return {
        id: row.id, u: row.username, name: row.name, role: row.role,
        unit: row.unit, phone: row.phone, active: row.active, hr: row.hr || {},
        ...extra
    };
}

function readCookie(req, name) {
    const c = req.headers.cookie;
    if (!c) return null;
    const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
}

function authenticateToken(req, res, next) {
    /* توکن از هدر Authorization یا کوکی (برخی پراکسی‌ها هدر را حذف می‌کنند) */
    let token = req.headers['authorization']?.split(' ')[1];
    const fromCookie = !token;
    if (fromCookie) token = readCookie(req, 'bfg_tok');
    if (!token) {
        console.warn(`⚠️ 401 بدون توکن: ${req.method} ${req.path} — هدر: ${req.headers['authorization'] ? 'موجود' : 'حذف‌شده'}، کوکی: ${req.headers.cookie ? 'موجود' : 'ندارد'}`);
        return res.status(401).json({ error: 'no_token' });
    }
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.warn(`⚠️ 403 توکن نامعتبر: ${req.method} ${req.path} (${fromCookie ? 'کوکی' : 'هدر'}) — ${err.message}`);
            return res.status(403).json({ error: 'bad_token' });
        }
        req.user = user;
        next();
    });
}

const requireAdmin = (req, res, next) =>
    req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'admin_required' });

/* ------------------------------- auth -------------------------------- */
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'missing_credentials' });
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user || !user.active || !bcrypt.compareSync(String(password), user.pass_hash)) {
            return res.status(401).json({ error: 'invalid_credentials' });
        }
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, name: user.name },
            JWT_SECRET, { expiresIn: '7d' }
        );
        res.json({ token, user: userToClient(user) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ----------------------------- bootstrap ----------------------------- */
app.get('/api/bootstrap', authenticateToken, async (req, res) => {
    try {
        const [users, rows, seeded] = await Promise.all([
            pool.query('SELECT * FROM users ORDER BY created_at ASC'),
            pool.query('SELECT collection, kind, id, ord, data FROM entities ORDER BY collection, ord ASC NULLS LAST, seq ASC'),
            pool.query("SELECT value FROM meta WHERE key = 'seeded'")
        ]);
        const collections = {};
        for (const r of rows.rows) {
            const c = collections[r.collection] || (collections[r.collection] = { kind: r.kind, items: [] });
            c.items.push({ id: r.id, ord: r.ord, data: r.data });
        }
        res.json({
            seeded: seeded.rows.length > 0 && seeded.rows[0].value === true,
            users: users.rows.map(userToClient),
            collections,
            serverTime: new Date().toISOString()
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* -------------------------------- seed ------------------------------- */
/* فقط یک‌بار و فقط وقتی سرور seed نشده — داده نمونه/فعلی کلاینت را می‌ریزد */
async function upsertUser(client, u) {
    const { id, u: username, p, name, role, unit, phone, active, hr, ...rest } = u;
    if (!id || !username) return;
    const known = ['id','u','p','name','role','unit','phone','active','hr'];
    const extra = {};
    for (const k of Object.keys(rest)) if (!known.includes(k)) extra[k] = rest[k];
    if (p) {
        const pass_hash = bcrypt.hashSync(String(p), 10);
        await client.query(
            `INSERT INTO users (id, username, pass_hash, name, role, unit, phone, active, hr, extra)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (id) DO UPDATE SET
               username=EXCLUDED.username, name=EXCLUDED.name, role=EXCLUDED.role,
               unit=EXCLUDED.unit, phone=EXCLUDED.phone, active=EXCLUDED.active,
               hr=EXCLUDED.hr, extra=EXCLUDED.extra`,
            [id, username, pass_hash, name || username, role || 'tech', unit || null, phone || null,
             active !== false, JSON.stringify(hr || {}), JSON.stringify(extra)]
        );
    } else {
        await client.query(
            `INSERT INTO users (id, username, pass_hash, name, role, unit, phone, active, hr, extra)
             VALUES ($1,$2,'', $3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (id) DO UPDATE SET
               username=EXCLUDED.username, name=EXCLUDED.name, role=EXCLUDED.role,
               unit=EXCLUDED.unit, phone=EXCLUDED.phone, active=EXCLUDED.active,
               hr=EXCLUDED.hr, extra=EXCLUDED.extra`,
            [id, username, name || username, role || 'tech', unit || null, phone || null,
             active !== false, JSON.stringify(hr || {}), JSON.stringify(extra)]
        );
        // رمز کاربری که بدون p آمده و رمز ندارد = رمز پیش‌فرض
        await client.query(`UPDATE users SET pass_hash=$1 WHERE id=$2 AND pass_hash=''`,
            [bcrypt.hashSync('1234', 10), id]);
    }
}

app.post('/api/seed', authenticateToken, async (req, res) => {
    const { users = [], snapshots = {}, seq = {} } = req.body || {};
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const seeded = await client.query("SELECT value FROM meta WHERE key='seeded'");
        if (seeded.rows.length && seeded.rows[0].value === true) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'already_seeded' });
        }
        /* کاربر admin موقت ساخته‌شده در ensureAdmin را حذف کن تا با کاربر admin
           دمو (u1) که username یکسان دارد تداخل unique رخ ندهد */
        await client.query("DELETE FROM users WHERE id='admin'");
        for (const u of users) await upsertUser(client, u);
        for (const [col, snap] of Object.entries(snapshots)) {
            if (badCol(col) || !snap || !snap.items) continue;
            for (const it of snap.items) {
                await client.query(
                    `INSERT INTO entities (collection, id, ord, kind, data) VALUES ($1,$2,$3,$4,$5)
                     ON CONFLICT (collection, id) DO UPDATE SET ord=EXCLUDED.ord, data=EXCLUDED.data, updated_at=now()`,
                    [col, String(it.id), it.ord ?? null, snap.kind || 'arr', JSON.stringify(it.data)]
                );
            }
        }
        for (const [k, v] of Object.entries(seq || {})) {
            if (!/^[a-z]+$/.test(k) || typeof v !== 'number') continue;
            await client.query(
                `INSERT INTO seq_counters (key, n) VALUES ($1, $2)
                 ON CONFLICT (key) DO UPDATE SET n = GREATEST(seq_counters.n, $2)`,
                [k, v]
            );
        }
        await client.query(`INSERT INTO meta (key, value) VALUES ('seeded','true')
                            ON CONFLICT (key) DO UPDATE SET value='true'`);
        await client.query('COMMIT');
        io.emit('seeded');
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') return res.status(409).json({ error: 'username_exists' });
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
});

/* -------------------------------- sync ------------------------------- */
app.post('/api/sync/:collection', authenticateToken, async (req, res) => {
    const { collection } = req.params;
    if (badCol(collection)) return res.status(400).json({ error: 'bad_collection' });
    const { kind = 'arr', upserts = [], deletes = [], src } = req.body || {};

    try {
        let broadcastUpserts = [];

        if (collection === 'users') {
            /* کاربران: تایپ‌شده + هش رمز + خروجی امن (بدون رمز) */
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                for (const it of upserts) {
                    const u = (it && it.data) ? it.data : it;   /* فرم wrapped یا خام */
                    if (!u) continue;
                    await upsertUser(client, u);
                    const row = await client.query('SELECT * FROM users WHERE id=$1', [u.id]);
                    if (row.rows[0]) broadcastUpserts.push({ id: u.id, ord: null, data: userToClient(row.rows[0]) });
                }
                for (const id of deletes) {
                    if (id === req.user.id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'cannot_delete_self' }); }
                    const remaining = await client.query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND active AND id<>$1", [id]);
                    const target = await client.query('SELECT role FROM users WHERE id=$1', [id]);
                    if (target.rows[0]?.role === 'admin' && remaining.rows[0].n < 1) {
                        await client.query('ROLLBACK');
                        return res.status(400).json({ error: 'last_admin' });
                    }
                    await client.query('DELETE FROM users WHERE id=$1', [id]);
                }
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK');
                if (e.code === '23505') return res.status(409).json({ error: 'username_exists' });
                throw e;
            }
            finally { client.release(); }
        } else {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                for (const it of upserts) {
                    if (it == null || it.id == null) continue;
                    await client.query(
                        `INSERT INTO entities (collection, id, ord, kind, data) VALUES ($1,$2,$3,$4,$5)
                         ON CONFLICT (collection, id) DO UPDATE SET ord=EXCLUDED.ord, data=EXCLUDED.data, kind=EXCLUDED.kind, updated_at=now()`,
                        [collection, String(it.id), it.ord ?? null, kind, JSON.stringify(it.data)]
                    );
                    broadcastUpserts.push({ id: String(it.id), ord: it.ord ?? null, data: it.data });
                }
                for (const id of deletes) {
                    await client.query('DELETE FROM entities WHERE collection=$1 AND id=$2', [collection, String(id)]);
                }
                await client.query('COMMIT');
            } catch (e) { await client.query('ROLLBACK'); throw e; }
            finally { client.release(); }
        }

        io.emit('sync', {
            col: collection, kind, upserts: broadcastUpserts,
            deletes: deletes.map(String), by: req.user.id, src: src || null,
            t: new Date().toISOString()
        });
        res.json({ ok: true });
    } catch (err) {
        console.error(`❌ خطا در سینک کالکشن ${collection}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

/* --------------------------- شماره سند اتمیک -------------------------- */
app.post('/api/seq/next', authenticateToken, async (req, res) => {
    const { key, cur } = req.body || {};
    if (!/^[a-z]{1,20}$/.test(key || '')) return res.status(400).json({ error: 'bad_key' });
    try {
        const r = await pool.query(
            `INSERT INTO seq_counters (key, n) VALUES ($1, $2::int + 1)
             ON CONFLICT (key) DO UPDATE SET n = GREATEST(seq_counters.n, $2::int) + 1
             RETURNING n`,
            [key, Number.isInteger(cur) ? cur : 0]
        );
        res.json({ n: r.rows[0].n });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ------------------------- reset داده‌ها (admin) ---------------------- */
app.post('/api/admin/reset', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM entities');
        await pool.query("DELETE FROM meta WHERE key='seeded'");
        await pool.query('DELETE FROM seq_counters');
        io.emit('reset');
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true, db: true }); }
    catch (e) { res.status(503).json({ ok: false, db: false, error: e.message }); }
});

/* SPA fallback */
app.get(/^\/(?!api\/|socket\.io\/).*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ------------------------------ socket.io ---------------------------- */
io.use((socket, next) => {
    let token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) token = readCookie(socket.request, 'bfg_tok');
    if (!token) return next(new Error('unauthorized'));
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return next(new Error('unauthorized'));
        socket.user = user;
        next();
    });
});

io.on('connection', (socket) => {
    console.log(`🔌 ${socket.user?.name || 'کاربر'} متصل شد (${socket.id})`);
    socket.on('disconnect', () => console.log(`🔌 ${socket.user?.name || socket.id} قطع شد`));
});

/* ------------------------------- startup ----------------------------- */
async function applySchema() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    if (usingMem) memDb.public.none(schema);
    else await pool.query(schema);
}

async function ensureAdmin() {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM users');
    if (r.rows[0].n === 0) {
        /* کاربر موقت تا اولین ورود ممکن شود؛ در seed اولین کلاینت با کاربران دمو جایگزین می‌شود */
        await pool.query(
            `INSERT INTO users (id, username, pass_hash, name, role, unit, active)
             VALUES ('admin','admin',$1,'مدیر سیستم','admin','فناوری اطلاعات',TRUE)
             ON CONFLICT (id) DO NOTHING`,
            [bcrypt.hashSync('1234', 10)]
        );
        console.log('👤 کاربر موقت ساخته شد: admin / 1234 — پس از اولین ورود و seed، کاربران دمو/واقعی جایگزین می‌شوند');
    }
}

server.listen(PORT, HOST, async () => {
    console.log(`✅ BFG CMMS v2 روی http://${HOST}:${PORT} اجرا شد`);
    try {
        await applySchema();
        console.log('🗄️  اسکیمای دیتابیس آماده است');
        await ensureAdmin();
    } catch (e) { console.error('⚠️  اتصال/آماده‌سازی دیتابیس ناموفق:', e.message); }
});
