const fs = require('fs');
const path = require('path');

const projectDir = __dirname;
const publicDir = path.join(projectDir, 'public');
const indexPath = path.join(publicDir, 'index.html');
const serverPath = path.join(projectDir, 'server.js');
const envPath = path.join(projectDir, '.env');
const packagePath = path.join(projectDir, 'package.json');
const schemaPath = path.join(projectDir, 'schema.sql');

// ================= بررسی وضعیت =================
function showStatus() {
    console.log('========================================');
    console.log('📊 وضعیت فعلی پروژه');
    console.log('========================================');
    
    const files = [
        { name: 'package.json', path: packagePath, desc: 'تنظیمات npm' },
        { name: '.env', path: envPath, desc: 'تنظیمات محیطی' },
        { name: 'server.js', path: serverPath, desc: 'بکاند سرور' },
        { name: 'public/index.html', path: indexPath, desc: 'فرانتاند' },
        { name: 'schema.sql', path: schemaPath, desc: 'ساختار دیتابیس' },
        { name: 'create-admin.js', path: path.join(projectDir, 'create-admin.js'), desc: 'ایجاد کاربر Admin' }
    ];
    
    for (const file of files) {
        if (fs.existsSync(file.path)) {
            const size = fs.statSync(file.path).size;
            console.log(`✅ ${file.name} (${size} bytes) — ${file.desc}`);
        } else {
            console.log(`❌ ${file.name} — ${file.desc} (وجود ندارد)`);
        }
    }
    
    console.log('\n📁 پوشه public:');
    if (fs.existsSync(publicDir)) {
        const filesInPublic = fs.readdirSync(publicDir);
        filesInPublic.forEach(f => console.log(`  📄 ${f}`));
    } else {
        console.log('  ❌ وجود ندارد');
    }
}

// ================= اصلاح index.html =================
function fixIndexHtml() {
    console.log('\n========================================');
    console.log('🔍 اصلاح index.html برای سینک لحظهای');
    console.log('========================================');
    
    if (!fs.existsSync(indexPath)) {
        console.log('❌ index.html وجود ندارد!');
        return;
    }
    
    let content = fs.readFileSync(indexPath, 'utf8');
    let changes = [];
    
    // 1. اضافه کردن Socket.IO
    if (!content.includes('/socket.io/socket.io.js')) {
        content = content.replace('</head>', '<script src="/socket.io/socket.io.js"></script>\n</head>');
        changes.push('✅ Socket.IO اضافه شد');
    }
    
    // 2. تغییر load() به async load()
    if (content.includes('function load()') && !content.includes('async function load()')) {
        content = content.replace('function load()', 'async function load()');
        changes.push('✅ load() → async load()');
    }
    
    // 3. تغییر save() به async save(collection, data)
    if (content.includes('function save()') && !content.includes('async function save(collection, data)')) {
        content = content.replace('function save()', 'async function save(collection, data)');
        changes.push('✅ save() → async save(collection, data)');
    }
    
    // 4. تغییر doLogin() به async doLogin()
    if (content.includes('function doLogin()') && !content.includes('async function doLogin()')) {
        content = content.replace('function doLogin()', 'async function doLogin()');
        changes.push('✅ doLogin() → async doLogin()');
    }
    
    // 5. اضافه کردن setupSocket()
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
}

// ================= اصلاح server.js =================
function fixServerJs() {
    console.log('\n========================================');
    console.log('🔍 اصلاح server.js برای سینک لحظهای');
    console.log('========================================');
    
    if (!fs.existsSync(serverPath)) {
        console.log('❌ server.js وجود ندارد!');
        return;
    }
    
    let content = fs.readFileSync(serverPath, 'utf8');
    let changes = [];
    
    // 1. اضافه کردن Socket.IO
    if (!content.includes('socket.io')) {
        content = content.replace("require('express')", "require('express');\nconst http = require('http');\nconst { Server } = require('socket.io');");
        changes.push('✅ Socket.IO به server.js اضافه شد');
    }
    
    // 2. اضافه کردن io.emit
    if (!content.includes('io.emit')) {
        content = content.replace('res.status(201).json({ message: \'Created\', id: data.id });', 'res.status(201).json({ message: \'Created\', id: data.id });\n        io.emit(\'data-changed\', { collection, id: data.id, data });');
        changes.push('✅ io.emit اضافه شد');
    }
    
    // 3. اضافه کردن io.on('connection')
    if (!content.includes("io.on('connection')")) {
        content = content.replace('server.listen', `io.on('connection', (socket) => {\n    console.log('User connected:', socket.id);\n    \n    socket.on('disconnect', () => {\n        console.log('User disconnected:', socket.id);\n    });\n});\n\nserver.listen`);
        changes.push('✅ io.on(connection) اضافه شد');
    }
    
    // ذخیره فایل
    if (changes.length > 0) {
        fs.writeFileSync(serverPath, content, 'utf8');
    }
    
    console.log(changes.length > 0 ? changes.join('\n') : '✅ همه تغییرات server.js قبلاً اعمال شدهاند');
}

// ================= تنظیمات Windows Server 2022 =================
function createServerSetup() {
    console.log('\n========================================');
    console.log('🔧 ایجاد فایل راهنمای استقرار');
    console.log('========================================');
    
    const setupContent = `# راهنمای استقرار سامانه CMMS روی Windows Server 2022

## پیشنیازها
- Windows Server 2022
- Node.js 20 LTS
- PostgreSQL 18
- IIS (برای Reverse Proxy)

## مراحل استقرار

### 1. نصب Node.js
- دانلود از https://nodejs.org/en/download/
- نصب با گزینههای پیشفرض

### 2. نصب PostgreSQL 18
- دانلود از https://www.postgresql.org/download/windows/
- نصب با گزینههای پیشفرض
- رمز عبور برای کاربر postgres تعیین کنید

### 3. انتقال فایلهای پروژه
- فایلهای پروژه را به پوشه C:\\bfg-cmms کپی کنید

### 4. تنظیم .env
- فایل .env را ویرایش کنید:
  DATABASE_URL=postgres://postgres:your_password@localhost:5432/bfg_cmms

### 5. نصب وابستگیها
- cd C:\\bfg-cmms
- npm install

### 6. اجرای Schema
- C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe -U postgres -d bfg_cmms -f C:\\bfg-cmms\\schema.sql

### 7. ایجاد کاربر Admin
- node create-admin.js

### 8. اجرای سامانه با PM2
- npm install -g pm2
- pm2 start server.js --name "bfg-cmms"
- pm2 save
- pm2 startup

### 9. پیکربندی IIS (Reverse Proxy)
1. IIS Manager را باز کنید
2. Application Request Routing (ARR) را نصب کنید
3. URL Rewrite را نصب کنید
4. وبسایت جدید با پورت 80 ایجاد کنید
5. web.config را در پوشه public قرار دهید

### 10. پیکربندی فایروال
- پورت 80 را باز کنید:
  New-NetFirewallRule -DisplayName "HTTP" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow

## تست نهایی
- مرورگر را باز کنید: http://server-ip
- ورود با: admin / admin123

## پشتیبانگیری
- روزانه از دیتابیس پشتیبان بگیرید:
  pg_dump -U postgres -d bfg_cmms -f "C:\\backup\\bfg_cmms_$(Get-Date -Format 'yyyyMMdd').sql"
`;

    fs.writeFileSync(path.join(projectDir, 'DEPLOY-WINDOWS.md'), setupContent, 'utf8');
    console.log('✅ فایل DEPLOY-WINDOWS.md ایجاد شد');
}

// ================= اجرای اصلی =================
function main() {
    console.log('========================================');
    console.log('🚀 آمادهسازی سامانه برای Windows Server 2022');
    console.log('========================================');
    
    // نمایش وضعیت
    showStatus();
    
    // اصلاح فایلها
    fixIndexHtml();
    fixServerJs();
    
    // ایجاد راهنمای استقرار
    createServerSetup();
    
    console.log('\n========================================');
    console.log('✅ آمادهسازی کامل شد!');
    console.log('========================================');
    console.log('\n📋 مراحل بعدی:');
    console.log('1. اجرای npm start');
    console.log('2. ورود به سامانه: http://localhost:8080');
    console.log('3. استفاده از فایل DEPLOY-WINDOWS.md برای استقرار روی سرور');
}

main();