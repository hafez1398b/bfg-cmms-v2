const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { createEquipmentRouter } = require('./server/equipment-routes');
const { createNotificationRouter } = require('./server/notification-routes');
const { createSecurity } = require('./server/security');
const { createSessionService } = require('./server/session');
const { configureRealtime } = require('./server/realtime');
const { createProviderRegistry } = require('./server/ai-providers');
const { createAIRouter } = require('./server/ai-routes');
const { createMaintenanceRouter } = require('./server/maintenance-routes');
const { createInventoryRouter } = require('./server/inventory-routes');
const { resolveRuntimeConfig } = require('./server/runtime-config');
const release = require('./server/release-info');
const { createModuleService } = require('./server/module-service');
const { createModuleRouter, createModuleGate } = require('./server/module-routes');
const { createGenericDataHandlers } = require('./server/generic-data');
const { createUserRouter } = require('./server/user-routes');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const configuredOrigins=String(process.env.APP_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
const allowAnyOrigin=configuredOrigins.includes('*')&&process.env.NODE_ENV!=='production';
const originAllowed=(origin,callback)=>{
    if(!origin||allowAnyOrigin||configuredOrigins.includes(origin))return callback(null,true);
    callback(new Error('ORIGIN_NOT_ALLOWED'));
};
const io = new Server(server, {
    cors: {origin:configuredOrigins.length?originAllowed:false,methods:['GET','POST']}
});

const PORT = process.env.PORT || 8080;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});
const sessions = createSessionService({ pool, jwtSecret: process.env.JWT_SECRET, env: process.env });
const security = createSecurity({ pool, jwtSecret: process.env.JWT_SECRET, sessions });
const { authenticateToken, authorize, hasPermission } = security;
const aiProviders = createProviderRegistry(process.env);
const moduleService = createModuleService();
const genericData = createGenericDataHandlers({ pool, hasPermission });

app.disable('x-powered-by');
app.set('trust proxy',1);
if(configuredOrigins.length)app.use(cors({origin:originAllowed,credentials:false}));
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', sessions.mutationGuard());

app.get('/api/runtime-config', (req,res) => {
    sessions.ensureCsrfCookie(req, res);
    const config = resolveRuntimeConfig(process.env);
    res.json({ ...config, compatibility: release.assessCompatibility(req.get('x-client-version') || '') });
});

app.get('/api/health', async (_req, res) => {
    try {
        const result = await pool.query("SELECT current_database() database, to_regclass('public.notifications') notifications, to_regclass('public.event_outbox') outbox, to_regclass('public.auth_sessions') auth_sessions");
        const schemaReady = !!result.rows[0].notifications && !!result.rows[0].outbox && !!result.rows[0].auth_sessions;
        res.status(schemaReady?200:503).json({status:schemaReady?'ready':'migration_required',database:true,schemaReady});
    } catch (error) {
        res.status(503).json({status:'database_unavailable',database:false,schemaReady:false});
    }
});

function authFailure(res, error) {
    if (!error.status || error.status >= 500) sessions.logSafe('authentication failed', error);
    const status = error.status && error.status < 500 ? error.status : 500;
    if (error.code === 'LOGIN_RATE_LIMITED') res.setHeader('Retry-After', '900');
    res.status(status).json({ error: status < 500 ? (error.code || 'REQUEST_FAILED') : 'AUTHENTICATION_UNAVAILABLE' });
}

app.get('/api/auth/csrf', (req, res) => {
    sessions.ensureCsrfCookie(req, res);
    res.json({ ok: true });
});

app.post('/api/auth/login', async (req, res) => {
    try {
        res.json(await sessions.login(req, res));
    } catch (error) {
        authFailure(res, error);
    }
});

app.post('/api/auth/refresh', async (req, res) => {
    try {
        res.json(await sessions.refresh(req, res));
    } catch (error) {
        authFailure(res, error);
    }
});

app.post('/api/auth/logout', async (req, res) => {
    try {
        res.json(await sessions.logout(req, res));
    } catch (error) {
        authFailure(res, error);
    }
});

app.post('/api/auth/logout-all', authenticateToken, async (req, res) => {
    try {
        res.json(await sessions.logoutAll(req, res));
    } catch (error) {
        authFailure(res, error);
    }
});

app.get('/api/auth/me', authenticateToken, (req,res) => {
    res.json({user:{id:req.user.id,username:req.user.username,name:req.user.name,role:req.user.role,unit:req.user.unit}});
});

app.use('/api/modules', createModuleRouter({ pool, sessions, service: moduleService }));

// Compatibility reads are explicitly allowlisted. All generic mutations fail closed
// before a domain query can execute.
app.get('/api/data/:collection', authenticateToken, genericData.read);
app.post('/api/data/:collection', authenticateToken, genericData.rejectWrite);
app.put('/api/data/:collection/:id', authenticateToken, genericData.rejectWrite);
app.delete('/api/data/:collection/:id', authenticateToken, genericData.rejectWrite);

app.use('/api/users', createUserRouter({ pool, authenticateToken, hasPermission }));

// Domain module gates run after the generic fail-closed boundary so a rejected
// collection cannot trigger module-state or domain-data queries.
app.use('/api', createModuleGate({ pool, sessions, service: moduleService }));

app.use('/api/equipment', createEquipmentRouter({ pool, io, authenticateToken, aiRegistry: aiProviders, security }));
app.use('/api', createMaintenanceRouter({ pool, security, requestStorageDir:process.env.REQUEST_ATTACHMENT_DIR || path.join(__dirname, 'storage', 'request-files') }));
app.use('/api', createInventoryRouter({ pool, security, storageDir: process.env.ATTACHMENT_DIR || path.join(__dirname, 'storage', 'work-order-files') }));
app.use('/api/notifications', createNotificationRouter({ pool, authenticateToken, authorize }));
app.use('/api/ai', createAIRouter({ pool, authenticateToken, authorize, registry:aiProviders }));

// SPA fallback keeps bookmarkable Equipment Detail URLs refresh-safe.
app.get('/equipment/:equipmentKey', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const realtime = configureRealtime({ io, pool, security });

server.listen(PORT, '0.0.0.0', () => {
    console.log('✅ BFG CMMS running on http://0.0.0.0:' + PORT);
});

let shuttingDown=false;
async function shutdown(signal){
    if(shuttingDown)return;shuttingDown=true;
    console.log(`${signal} received; shutting down safely...`);
    server.close(async()=>{await pool.end().catch(()=>{});process.exit(0);});
    setTimeout(()=>process.exit(1),15000).unref();
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));