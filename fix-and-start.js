const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// مسیر فایلها
const projectDir = __dirname;
const publicDir = path.join(projectDir, 'public');
const indexPath = path.join(publicDir, 'index.html');
const envPath = path.join(projectDir, '.env');
const serverPath = path.join(projectDir, 'server.js');

// تنظیمات
const dbConfig = {
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:123@localhost:5432/bfg_cmms'
};

const pool = new Pool(dbConfig);

// ================= بررسی و اصلاح index.html =================
function checkIndexHtml() {
    console.log('🔍 بررسی index.html...');
    let content = fs.readFileSync(indexPath, 'utf8');
    let changes = [];
    
    // بررسی Socket.IO
    if (!content.includes('/socket.io/socket.io.js')) {
        content = content.replace('</head>', '<script src="/socket.io/socket.io.js"></script>\n</head>');
        changes.push('✅ Socket.IO به head اضافه شد');
    }
    
    // بررسی async load()
    if (content.includes('function load()') && !content.includes('async function load()')) {
        content = content.replace('function load()', 'async function load()');
        changes.push('✅ load() → async load()');
    }
    
    // بررسی async save()
    if (content.includes('function save()') && !content.includes('async function save(collection, data)')) {
        content = content.replace('function save()', 'async function save(collection, data)');
        changes.push('✅ save() → async save(collection, data)');
    }
    
    // بررسی async doLogin()
    if (content.includes('function doLogin()') && !content.includes('async function doLogin()')) {
        content = content.replace('function doLogin()', 'async function doLogin()');
        changes.push('✅ doLogin() → async doLogin()');
    }
    
    // بررسی setupSocket()
    if (!content.includes('function setupSocket()')) {
        content = content.replace('</script>', `
function setupSocket() {
    socket = io();
    
    socket.on('data-changed', ({ collection, id, data }) => {
        if (collection === 'wos' && DB.wos) {
            if (data) {
                const idx = DB.wos.findIndex(w => w.id === id);
                if (idx >= 0) DB.wos[idx] = data;
                else DB.wos.unshift(data);
            } else {
                DB.wos = DB.wos.filter(w => w.id !== id);
            }
            buildMenu();
            if (CUR === 'wos') go('wos');
        }
        
        if (collection === 'assets' && DB.assets) {
            if (data) {
                const idx = DB.assets.findIndex(a => a.id === id);
                if (idx >= 0) DB.assets[idx] = data;
                else DB.assets.unshift(data);
            } else {
                DB.assets = DB.assets.filter(a => a.id !== id);
            }
            buildMenu();
            if (CUR === 'tree') go('tree');
        }
        
        if (collection === 'requests' && DB.requests) {
            if (data) {
                const idx = DB.requests.findIndex(r => r.id === id);
                if (idx >= 0) DB.requests[idx] = data;
                else DB.requests.unshift(data);
            } else {
                DB.requests = DB.requests.filter(r => r.id !== id);
            }
            buildMenu();
            if (CUR === 'requests') go('requests');
        }
    });
}
</script>`);
        changes.push('✅ setupSocket() اضافه شد');
    }
    
    // ذخیره فایل
    if (changes.length > 0) {
        fs.writeFileSync(indexPath, content, 'utf8');
    }
    
    console.log(changes.length > 0 ? changes.join('\n') : '✅ همه تغییرات قبلاً اعمال شدهاند');
    return changes.length > 0;
}

// ================= بررسی و اصلاح server.js =================
function checkServerJs() {
    console.log('🔍 بررسی server.js...');
    let content = fs.readFileSync(serverPath, 'utf8');
    let changes = [];
    
    // بررسی وجود Socket.IO
    if (!content.includes('socket.io')) {
        content = content.replace("require('express')", "require('express');\nconst http = require('http');\nconst { Server } = require('socket.io');");
        changes.push('✅ Socket.IO به server.js اضافه شد');
    }
    
    // بررسی وجود io.emit
    if (!content.includes('io.emit')) {
        content = content.replace('res.status(201).json({ message: \'Created\', id: data.id });', 'res.status(201).json({ message: \'Created\', id: data.id });\n        io.emit(\'data-changed\', { collection, id: data.id, data });');
        changes.push('✅ io.emit اضافه شد');
    }
    
    // ذخیره فایل
    if (changes.length > 0) {
        fs.writeFileSync(serverPath, content, 'utf8');
    }
    
    console.log(changes.length > 0 ? changes.join('\n') : '✅ همه تغییرات server.js قبلاً اعمال شدهاند');
    return changes.length > 0;
}

// ================= بررسی دیتابیس =================
async function checkDatabase() {
    console.log('🔍 بررسی دیتابیس...');
    
    try {
        // بررسی اتصال
        const result = await pool.query('SELECT 1');
        console.log('✅ اتصال به دیتابیس برقرار است');
        
        // بررسی وجود کاربر admin
        const adminResult = await pool.query("SELECT * FROM users WHERE username = 'admin'");
        
        if (adminResult.rows.length === 0) {
            console.log('⚠️ کاربر admin وجود ندارد. ایجاد میکنم...');
            const password = bcrypt.hashSync('admin123', 10);
            await pool.query(
                `INSERT INTO users (id, username, pass_hash, name, role, unit, active) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                ['admin', 'admin', password, 'مدیر سیستم', 'admin', 'فناوری اطلاعات', true]
            );
            console.log('✅ کاربر admin ایجاد شد');
        } else {
            console.log('✅ کاربر admin وجود دارد');
        }
        
        // بررسی وجود جداول
        const tables = ['users', 'assets', 'work_orders', 'requests', 'items', 'pm_plans', 'tools', 'permits', 'docs', 'leaves', 'plan_events'];
        const existingTables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
        const tableNames = existingTables.rows.map(r => r.tablename);
        
        const missingTables = tables.filter(t => !tableNames.includes(t));
        
        if (missingTables.length > 0) {
            console.log(`⚠️ جداول زیر وجود ندارند: ${missingTables.join(', ')}`);
            console.log('لطفاً schema.sql را اجرا کنید');
        } else {
            console.log('✅ همه جداول وجود دارند');
        }
        
        return true;
    } catch (err) {
        console.error('❌ خطا در اتصال به دیتابیس:', err.message);
        return false;
    }
}

// ================= اجرای اصلی =================
async function main() {
    console.log('========================================');
    console.log('🚀 شروع بررسی و اصلاح سامانه');
    console.log('========================================');
    
    // 1. بررسی index.html
    checkIndexHtml();
    
    // 2. بررسی server.js
    checkServerJs();
    
    // 3. بررسی دیتابیس
    const dbOk = await checkDatabase();
    
    if (!dbOk) {
        console.log('❌ دیتابیس متصل نیست. بررسی کنید:');
        console.log('   - رمز عبور در .env صحیح است؟');
        console.log('   - PostgreSQL در حال اجرا است؟');
        console.log('   - دیتابیس bfg_cmms وجود دارد؟');
        process.exit(1);
    }
    
    console.log('========================================');
    console.log('✅ همهچیز آماده است!');
    console.log('========================================');
    console.log('');
    console.log('🚀 برای اجرای سامانه:');
    console.log('   npm start');
    console.log('');
    console.log('🔑 ورود به سامانه:');
    console.log('   Username: admin');
    console.log('   Password: admin123');
    console.log('   http://localhost:8080');
    
    process.exit(0);
}

main().catch(err => {
    console.error('❌ خطا:', err.message);
    process.exit(1);
});
