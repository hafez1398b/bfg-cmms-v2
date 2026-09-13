const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { createEquipmentRouter } = require('./server/equipment-routes');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 8080;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.sendStatus(401);
    
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        
        if (!user || !bcrypt.compareSync(password, user.pass_hash)) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, name: user.name },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/data/:collection', authenticateToken, async (req, res) => {
    const { collection } = req.params;
    const allowed = ['assets', 'wos', 'requests', 'items', 'pms', 'users', 'tools', 'instruments', 'contracts', 'projects', 'permits', 'docs', 'leaves', 'planEvents', 'comments', 'auditX'];
    
    if (!allowed.includes(collection)) {
        return res.status(400).json({ error: 'Collection not allowed' });
    }
    
    try {
        let result;
        if (collection === 'auditX' || collection === 'comments') {
            result = await pool.query('SELECT * FROM ' + collection + ' ORDER BY t DESC LIMIT 500');
        } else if (collection === 'users') {
            result = await pool.query('SELECT id, name, role, unit, username, active, hr FROM users');
        } else if (collection === 'wos') {
            result = await pool.query('SELECT * FROM work_orders ORDER BY created_at DESC');
        } else if (collection === 'requests') {
            result = await pool.query('SELECT * FROM requests ORDER BY created_at DESC');
        } else {
            result = await pool.query('SELECT * FROM ' + collection);
        }
        
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/data/:collection', authenticateToken, async (req, res) => {
    const { collection } = req.params;
    const data = req.body;
    
    try {
        if (collection === 'wos') {
            await pool.query(
                'INSERT INTO work_orders (id, no, type, asset_id, descr, priority, assignee, status, req_id, times, parts, media, report, est, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
                [data.id, data.no, data.type, data.assetId, data.desc, data.priority, data.assignee, data.status, data.reqId, JSON.stringify(data.times), JSON.stringify(data.parts), JSON.stringify(data.media || []), JSON.stringify(data.report || null), data.est, new Date()]
            );
        } else if (collection === 'assets') {
            await pool.query(
                'INSERT INTO assets (id, parent, code, name, type, cls, status, crit, maker, model, serial, year, install, power, hours, history) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)',
                [data.id, data.parent, data.code, data.name, data.type, data.cls, data.status, data.crit, data.maker, data.model, data.serial, data.year, data.install, data.power, data.hours || 0, JSON.stringify(data.history || [])]
            );
        } else if (collection === 'users') {
            const password = data.p || '1234';
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
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/data/:collection/:id', authenticateToken, async (req, res) => {
    const { collection, id } = req.params;
    const data = req.body;
    delete data.id;
    
    try {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const setClause = keys.map((key, i) => key + ' = $' + (i + 2)).join(', ');
        
        await pool.query(
            'UPDATE ' + collection + ' SET ' + setClause + ' WHERE id = $1',
            [id, ...values]
        );
        
        const updated = await pool.query('SELECT * FROM ' + collection + ' WHERE id = $1', [id]);
        io.emit('data-changed', { collection, id, data: updated.rows[0] });
        res.json({ message: 'Updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.use('/api/equipment', createEquipmentRouter({ pool, io, authenticateToken }));

app.delete('/api/data/:collection/:id', authenticateToken, async (req, res) => {
    const { collection, id } = req.params;
    
    try {
        await pool.query('DELETE FROM ' + collection + ' WHERE id = $1', [id]);
        io.emit('data-changed', { collection, id, data: null });
        res.json({ message: 'Deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// SPA fallback keeps bookmarkable Equipment Detail URLs refresh-safe.
app.get('/equipment/:equipmentKey', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('✅ BFG CMMS running on http://0.0.0.0:' + PORT);
});