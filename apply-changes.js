const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'index.html');
let content = fs.readFileSync(filePath, 'utf8');

// تغییر 1: اضافه کردن Socket.IO به head
if (!content.includes('/socket.io/socket.io.js')) {
    content = content.replace('</head>', '<script src="/socket.io/socket.io.js"></script>\n</head>');
    console.log('✅ Socket.IO added to head');
}

// تغییر 2: تغییر function load() به async function load()
if (content.includes('function load()') && !content.includes('async function load()')) {
    content = content.replace('function load()', 'async function load()');
    console.log('✅ load() → async load()');
}

// تغییر 3: تغییر function save() به async function save(collection, data)
if (content.includes('function save()') && !content.includes('async function save(collection, data)')) {
    content = content.replace('function save()', 'async function save(collection, data)');
    console.log('✅ save() → async save(collection, data)');
}

// تغییر 4: تغییر function doLogin() به async function doLogin()
if (content.includes('function doLogin()') && !content.includes('async function doLogin()')) {
    content = content.replace('function doLogin()', 'async function doLogin()');
    console.log('✅ doLogin() → async doLogin()');
}

// تغییر 5: اضافه کردن setupSocket()
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
    });
}
</script>`);
    console.log('✅ setupSocket() added');
}

// ذخیره فایل
fs.writeFileSync(filePath, content, 'utf8');

console.log('✅ All changes applied successfully!');