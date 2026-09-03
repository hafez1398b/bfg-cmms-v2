const fs = require('fs');
const path = require('path');

const projectDir = __dirname;
const publicDir = path.join(projectDir, 'public');
const indexPath = path.join(publicDir, 'index.html');
const serverPath = path.join(projectDir, 'server.js');
const envPath = path.join(projectDir, '.env');
const packagePath = path.join(projectDir, 'package.json');

// ================= نمایش وضعیت پروژه =================
function showStatus() {
    console.log('========================================');
    console.log('📊 وضعیت فعلی پروژه');
    console.log('========================================');
    
    // بررسی فایلهای اصلی
    const files = [
        { name: 'package.json', path: packagePath, desc: 'تنظیمات npm' },
        { name: '.env', path: envPath, desc: 'تنظیمات محیطی' },
        { name: 'server.js', path: serverPath, desc: 'بکاند سرور' },
        { name: 'public/index.html', path: indexPath, desc: 'فرانتاند' },
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
    
    // بررسی پوشه public
    if (fs.existsSync(publicDir)) {
        const filesInPublic = fs.readdirSync(publicDir);
        console.log(`\n📁 پوشه public (${filesInPublic.length} فایل):`);
        filesInPublic.forEach(f => console.log(`  📄 ${f}`));
    } else {
        console.log(`\n❌ پوشه public وجود ندارد`);
    }
    
    // بررسی دیتابیس
    console.log('\n🗄️ دیتابیس:');
    console.log('   اتصال: ' + (process.env.DATABASE_URL || 'postgres://postgres:123@localhost:5432/bfg_cmms'));
}

// ================= بررسی و اصلاح index.html =================
function fixIndexHtml() {
    console.log('\n========================================');
    console.log('🔍 بررسی و اصلاح index.html');
    console.log('========================================');
    
    if (!fs.existsSync(indexPath)) {
        console.log('❌ index.html وجود ندارد!');
        return;
    }
    
    let content = fs.readFileSync(indexPath, 'utf8');
    let issues = [];
    
    // بررسی وجود Socket.IO
    if (!content.includes('/socket.io/socket.io.js')) {
        issues.push('⚠️ Socket.IO در head نیست');
        content = content.replace('</head>', '<script src="/socket.io/socket.io.js"></script>\n</head>');
    }
    
    // بررسی async load()
    if (content.includes('function load()') && !content.includes('async function load()')) {
        issues.push('⚠️ load() هنوز async نیست');
        content = content.replace('function load()', 'async function load()');
    }
    
    // بررسی async save()
    if (content.includes('function save()') && !content.includes('async function save(collection, data)')) {
        issues.push('⚠️ save() هنوز async نیست');
        content = content.replace('function save()', 'async function save(collection, data)');
    }
    
    // بررسی async doLogin()
    if (content.includes('function doLogin()') && !content.includes('async function doLogin()')) {
        issues.push('⚠️ doLogin() هنوز async نیست');
        content = content.replace('function doLogin()', 'async function doLogin()');
    }
    
    // بررسی setupSocket()
    if (!content.includes('function setupSocket()')) {
        issues.push('⚠️ setupSocket() وجود ندارد');
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
    }
    
    // ذخیره فایل اگر تغییری وجود دارد
    if (issues.length > 0) {
        fs.writeFileSync(indexPath, content, 'utf8');
    }
    
    console.log(issues.length > 0 ? issues.join('\n') : '✅ همه تغییرات اعمال شدهاند');
}

// ================= بررسی و اصلاح server.js =================
function fixServerJs() {
    console.log('\n========================================');
    console.log('🔍 بررسی و اصلاح server.js');
    console.log('========================================');
    
    if (!fs.existsSync(serverPath)) {
        console.log('❌ server.js وجود ندارد!');
        return;
    }
    
    let content = fs.readFileSync(serverPath, 'utf8');
    let issues = [];
    
    // بررسی وجود Socket.IO
    if (!content.includes('socket.io')) {
        issues.push('⚠️ Socket.IO در server.js نیست');
        content = content.replace("require('express')", "require('express');\nconst http = require('http');\nconst { Server } = require('socket.io');");
    }
    
    // بررسی وجود io.emit
    if (!content.includes('io.emit')) {
        issues.push('⚠️ io.emit در server.js نیست');
        content = content.replace('res.status(201).json({ message: \'Created\', id: data.id });', 'res.status(201).json({ message: \'Created\', id: data.id });\n        io.emit(\'data-changed\', { collection, id: data.id, data });');
    }
    
    // بررسی وجود authenticateToken
    if (!content.includes('authenticateToken')) {
        issues.push('⚠️ authenticateToken در server.js نیست');
    }
    
    // ذخیره فایل اگر تغییری وجود دارد
    if (issues.length > 0) {
        fs.writeFileSync(serverPath, content, 'utf8');
    }
    
    console.log(issues.length > 0 ? issues.join('\n') : '✅ همه تغییرات server.js اعمال شدهاند');
}

// ================= اجرای اصلی =================
function main() {
    // نمایش وضعیت
    showStatus();
    
    // اصلاح فایلها
    fixIndexHtml();
    fixServerJs();
    
    console.log('\n========================================');
    console.log('✅ بررسی و اصلاح کامل شد!');
    console.log('========================================');
    console.log('📋 برای اجرای سامانه:');
    console.log('   npm start');
    console.log('');
    console.log('🔑 ورود به سامانه:');
    console.log('   Username: admin');
    console.log('   Password: admin123');
    console.log('   http://localhost:8080');
}

main();