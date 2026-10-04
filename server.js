const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
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
app.use('/api', createModuleGate({ pool, sessions, service: moduleService }));

app.get('/api/data/:collection', authenticateToken, async (req, res) => {
    const { collection } = req.params;
    if (['requests', 'wos', 'pms'].includes(collection)) return res.status(409).json({ error: 'USE_MAINTENANCE_API' });
    if (['items', 'stock_docs', 'stockDocs', 'costEntries', 'cost_entries', 'warehouses'].includes(collection)) return res.status(409).json({ error: 'USE_INVENTORY_API' });
    const allowed = ['assets', 'users', 'tools', 'instruments', 'contracts', 'projects', 'permits', 'docs', 'leaves', 'planEvents', 'comments', 'auditX'];
    
    if (!allowed.includes(collection)) {
        return res.status(400).json({ error: 'Collection not allowed' });
    }
    
    try {
        let result;
        if (collection === 'auditX' || collection === 'comments') {
            result = await pool.query('SELECT * FROM ' + collection + ' ORDER BY t DESC LIMIT 500');
        } else if (collection === 'users') {
            result = await pool.query('SELECT id, name, role, unit, username, active, hr FROM users');
        } else {
            result = await pool.query('SELECT * FROM ' + collection);
        }
        
        res.json(result.rows);
    } catch (err) {
        console.error('data read failed', err.code || 'db_error');
        res.status(500).json({ error: 'REQUEST_FAILED' });
    }
});

app.post('/api/data/:collection', authenticateToken, async (req, res) => {
    const { collection } = req.params;
    if (['requests', 'wos', 'pms', 'work_orders', 'pm_plans'].includes(collection)) return res.status(409).json({ error: 'USE_MAINTENANCE_API' });
    if (['items', 'stock_docs', 'stockDocs', 'costEntries', 'cost_entries', 'warehouses'].includes(collection)) return res.status(409).json({ error: 'USE_INVENTORY_API' });
    const data = req.body;
    
    try {
        if (collection === 'assets') {
            await pool.query(
                'INSERT INTO assets (id, parent, code, name, type, cls, status, crit, maker, model, serial, year, install, power, hours, history) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)',
                [data.id, data.parent, data.code, data.name, data.type, data.cls, data.status, data.crit, data.maker, data.model, data.serial, data.year, data.install, data.power, data.hours || 0, JSON.stringify(data.history || [])]
            );
        } else if (collection === 'users') {
            const password = data.p;
            if (typeof password !== 'string' || password.length < 12) {
                return res.status(400).json({ error: 'A password of at least 12 characters is required' });
            }
            const pass_hash = bcrypt.hashSync(password, 10);
            await pool.query(
                'INSERT INTO users (id, username, pass_hash, name, role, unit, phone, active, hr) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
                [data.id, data.u, pass_hash, data.name, data.role, data.unit, data.phone, data.active, JSON.stringify(data.hr || {})]
            );
        } else {
            const keys = Object.keys(data);
            const values = Object.values(data);
            const placeholders = keys.map((_, i) => '$' + (i + 1)).join(', ');
            await pool.query(
                'INSERT INTO ' + collection + ' (' + keys.join(', ') + ') VALUES (' + placeholders + ')',
                values
            );
        }
        
        io.emit('data-changed', { collection, id: data.id, data });
        res.status(201).json({ message: 'Created', id: data.id });
    } catch (err) {
        console.error('data write failed', err.code || 'db_error');
        res.status(500).json({ error: 'REQUEST_FAILED' });
    }
});

const RECORD_DOMAINS={
    assets:{table:'assets',permission:'equipment.edit',module:'equipment',fields:new Set(['parent','name','cls','status','crit','maker','model','serial','year','install','power','hours','ext','category_id'])}
};

app.put('/api/data/:collection/:id', authenticateToken, async (req, res) => {
    if (['requests','wos','pms','work_orders','pm_plans'].includes(req.params.collection)) return res.status(409).json({ error:'USE_MAINTENANCE_API' });
    if (['items','stock_docs','cost_entries','warehouses'].includes(req.params.collection)) return res.status(409).json({ error:'USE_INVENTORY_API' });
    const domain=RECORD_DOMAINS[req.params.collection];
    if(!domain)return res.status(400).json({error:'COLLECTION_NOT_EDITABLE'});
    if(!await hasPermission(req.user,domain.permission))return res.status(403).json({error:'PERMISSION_DENIED',permission:domain.permission});
    const rowVersion=Number(req.body.rowVersion??req.body.row_version);
    if(!Number.isInteger(rowVersion)||rowVersion<1)return res.status(422).json({error:'ROW_VERSION_REQUIRED'});
    const entries=Object.entries(req.body).filter(([key])=>domain.fields.has(key));
    if(!entries.length)return res.status(422).json({error:'NO_EDITABLE_FIELDS'});
    const jsonFields=new Set(['ext','checklist','key_for']),values=entries.map(([key,value])=>jsonFields.has(key)?JSON.stringify(value):value);
    const setClause=entries.map(([key],index)=>`${key}=$${index+2}`).join(', '),versionIndex=values.length+2,userIndex=values.length+3;
    const client=await pool.connect();
    try{
        await client.query('BEGIN');
        const before=await client.query(`SELECT * FROM ${domain.table} WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,[req.params.id]);
        if(!before.rows[0]){await client.query('ROLLBACK');return res.status(404).json({error:'RECORD_NOT_FOUND'});}
        const updated=await client.query(`UPDATE ${domain.table} SET ${setClause},updated_at=now(),updated_by=$${userIndex},row_version=row_version+1 WHERE id=$1 AND row_version=$${versionIndex} AND deleted_at IS NULL RETURNING *`,[req.params.id,...values,rowVersion,req.user.id]);
        if(!updated.rows[0]){await client.query('ROLLBACK');return res.status(409).json({error:'VERSION_CONFLICT'});}
        await client.query(`INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after) VALUES($1,now(),$2,$3,$4,'edit',$5,$6,$7,$8,$9)`,[uuidv4(),req.user.name,req.user.id,req.user.role,domain.module,req.params.id,'ویرایش رکورد عملیاتی',JSON.stringify(before.rows[0]),JSON.stringify(updated.rows[0])]);
        await client.query('COMMIT');
        io.emit('data-changed',{collection:req.params.collection,id:req.params.id,data:updated.rows[0]});
        res.json({message:'Updated',data:updated.rows[0]});
    }catch(error){await client.query('ROLLBACK').catch(()=>{});res.status(500).json({error:'RECORD_UPDATE_FAILED'});}finally{client.release();}
});

app.use('/api/equipment', createEquipmentRouter({ pool, io, authenticateToken, aiRegistry: aiProviders }));
app.use('/api', createMaintenanceRouter({ pool, security }));
app.use('/api', createInventoryRouter({ pool, security, storageDir: process.env.ATTACHMENT_DIR || path.join(__dirname, 'storage', 'work-order-files') }));
app.use('/api/notifications', createNotificationRouter({ pool, authenticateToken, authorize }));
app.use('/api/ai', createAIRouter({ pool, authenticateToken, authorize, registry:aiProviders }));

app.delete('/api/data/:collection/:id', authenticateToken, async (req, res) => {
    if (['requests','wos','pms','work_orders','pm_plans'].includes(req.params.collection)) return res.status(409).json({ error:'USE_MAINTENANCE_API' });
    if (['items','stock_docs','cost_entries','warehouses'].includes(req.params.collection)) return res.status(409).json({ error:'USE_INVENTORY_API' });
    const domain=RECORD_DOMAINS[req.params.collection];
    if(!domain)return res.status(400).json({error:'COLLECTION_NOT_ARCHIVABLE'});
    const permission=domain.module+'.delete';
    if(!await hasPermission(req.user,permission))return res.status(403).json({error:'PERMISSION_DENIED',permission});
    const reason=String(req.body?.reason||'').trim(),rowVersion=Number(req.body?.rowVersion??req.body?.row_version);
    if(!reason)return res.status(422).json({error:'ARCHIVE_REASON_REQUIRED'});
    if(!Number.isInteger(rowVersion)||rowVersion<1)return res.status(422).json({error:'ROW_VERSION_REQUIRED'});
    const client=await pool.connect();
    try{
        await client.query('BEGIN');
        const before=await client.query(`SELECT * FROM ${domain.table} WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,[req.params.id]);
        if(!before.rows[0]){await client.query('ROLLBACK');return res.status(404).json({error:'RECORD_NOT_FOUND'});}
        if(domain.table==='work_orders'&&(before.rows[0].times?.start||before.rows[0].report&&Object.keys(before.rows[0].report).length||before.rows[0].parts?.length)){
            await client.query('ROLLBACK');return res.status(409).json({error:'EXECUTED_WORK_ORDER_CANNOT_BE_ARCHIVED',action:'cancel'});
        }
        if(domain.table==='items'&&Number(before.rows[0].stock)!==0){await client.query('ROLLBACK');return res.status(409).json({error:'NONZERO_STOCK_CANNOT_BE_ARCHIVED'});}
        const archived=await client.query(`UPDATE ${domain.table} SET deleted_at=now(),updated_at=now(),updated_by=$3,row_version=row_version+1 WHERE id=$1 AND row_version=$2 AND deleted_at IS NULL RETURNING *`,[req.params.id,rowVersion,req.user.id]);
        if(!archived.rows[0]){await client.query('ROLLBACK');return res.status(409).json({error:'VERSION_CONFLICT'});}
        await client.query(`INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after) VALUES($1,now(),$2,$3,$4,'delete',$5,$6,$7,$8,NULL)`,[uuidv4(),req.user.name,req.user.id,req.user.role,domain.module,req.params.id,reason,JSON.stringify(before.rows[0])]);
        await client.query('COMMIT');
        io.emit('data-changed',{collection:req.params.collection,id:req.params.id,data:null});
        res.json({message:'Archived',historyPreserved:true});
    }catch(error){await client.query('ROLLBACK').catch(()=>{});res.status(500).json({error:'RECORD_ARCHIVE_FAILED'});}finally{client.release();}
});

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