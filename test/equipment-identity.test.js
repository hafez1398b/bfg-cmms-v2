'use strict';

// Mission D4 / Phase 11 — QR label + printable identity card (شناسنامه چاپی).
// Proves the QR is a real scannable encoding of the dossier deep link, the print document is
// built only from real dossier data («ثبت نشده» for anything missing), and the actions stay
// independent header buttons — never a twelfth dossier tab.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const identity = require('../public/equipment-v2/equipment-identity');
const qrcode = require('../public/vendor/qrcode-generator');

const ASSET = {
  id: 'b1-eq-p01', code: 'B1P01', name: 'پمپ انتقال فوم', type: 'eq', status: 'active',
  operational_status: 'in_service', crit: 'A', maker: 'SIEMENS', model: 'PX-200', serial: 'SN-9912',
  manufacturer_country: 'آلمان', year: '1398', install_date: '2020-05-11', power: '15 kW',
  factory_name: 'بسپار ۱', category_name: 'پمپ‌ها', location_name: 'سالن تولید', responsible_name: 'مهندس رضایی',
  activity_type: 'تولیدی', cls: 'تجهیز اصلی', general_notes: 'سرویس دوره‌ای انجام شده',
  ext: { capacity: '120 m³/h', description: 'انتقال فوم به خط قالب‌گیری', technicalSpecification: 'IP55', panelCode: 'PNL-12', refrigerant: 'R134a', dailyOperatingHours: 16, locationDescription: 'ضلع شمالی سالن' }
};

test('D4 QR: the shared vendor encoder is the real qrcode-generator and produces a stable matrix', () => {
  const encode = text => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const matrix = [];
    for (let row = 0; row < count; row += 1) {
      matrix.push(Array.from({ length: count }, (_, col) => (qr.isDark(row, col) ? 1 : 0)));
    }
    return matrix;
  };
  const link = 'https://cmms.example.com/equipment/B1P01';
  const first = encode(link);
  assert.deepEqual(first, encode(link), 'the same payload must encode deterministically');
  assert.notDeepEqual(first, encode(link + 'X'));
  const size = first.length;
  assert.ok(size >= 21 && (size - 21) % 4 === 0, 'a valid QR version module count');
  // Finder patterns in the three corners are the structural proof of a real QR symbol.
  const finderAt = (row, col) => {
    for (let dr = 0; dr < 7; dr += 1) for (let dc = 0; dc < 7; dc += 1) {
      const edge = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      assert.equal(first[row + dr][col + dc], edge || core ? 1 : 0, `finder pattern at ${row},${col}`);
    }
  };
  finderAt(0, 0); finderAt(0, size - 7); finderAt(size - 7, 0);
  // The legacy inline copy must be gone: one shared encoder, loaded before the dossier.
  const html = read('public/index.html');
  assert.doesNotMatch(html, /var qrcode=function\(\)/);
  const vendorIndex = html.indexOf('/vendor/qrcode-generator.js');
  const dossierIndex = html.indexOf('/equipment-v2/equipment-v2.js');
  const identityIndex = html.indexOf('/equipment-v2/equipment-identity.js');
  assert.ok(vendorIndex >= 0 && vendorIndex < dossierIndex);
  assert.ok(identityIndex >= 0 && identityIndex < dossierIndex);
});

test('D4 QR: dossierLink targets the existing /equipment/{code} route and encodes safely', () => {
  assert.equal(identity.dossierLink('https://cmms.example.com/', 'B1P01'), 'https://cmms.example.com/equipment/B1P01');
  assert.equal(identity.dossierLink('https://cmms.example.com', 'B1 P01/ژ'), 'https://cmms.example.com/equipment/B1%20P01%2F%DA%98');
  assert.throws(() => identity.dossierLink('https://x', ''), error => error.code === 'EQUIPMENT_KEY_REQUIRED');
  assert.throws(() => identity.dossierLink('https://x', null), error => error.code === 'EQUIPMENT_KEY_REQUIRED');
});

test('D4 QR: qrSvg renders a real symbol and fails honestly without an encoder', () => {
  const svg = identity.qrSvg('https://cmms.example.com/equipment/B1P01', 200, qrcode);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<rect x=/);
  assert.doesNotMatch(svg, /▦/, 'a fake placeholder QR is forbidden');
  assert.throws(() => identity.qrSvg('text', 200, null), error => error.code === 'QR_ENCODER_UNAVAILABLE');
  assert.throws(() => identity.qrSvg('', 200, qrcode), error => error.code === 'QR_PAYLOAD_REQUIRED');
});

test('D4 print: the identity card carries every real field and prints «ثبت نشده» for the missing ones', () => {
  const link = identity.dossierLink('https://cmms.example.com', ASSET.code);
  const qr = identity.qrSvg(link, 200, qrcode);
  const html = identity.identityCardHtml({
    asset: ASSET,
    labels: { status: 'فعال', operationalStatus: 'در سرویس', installDate: '۱۳۹۹/۰۲/۲۲' },
    spares: { state: 'empty', rows: [] },
    link, qr, printedBy: 'مدیر نت', printedAt: '۱۴۰۵/۰۸/۱۳ ۱۰:۳۰'
  });
  for (const value of ['B1P01', 'پمپ انتقال فوم', 'SIEMENS', 'PX-200', 'SN-9912', 'آلمان', '15 kW', '120 m³/h', 'PNL-12', 'R134a', 'مهندس رضایی', 'فعال', 'در سرویس', '۱۳۹۹/۰۲/۲۲']) {
    assert.ok(html.includes(value), `identity card must include the real value: ${value}`);
  }
  assert.ok(html.includes(link));
  assert.ok(html.includes('مدیر نت'));
  assert.ok(html.includes('۱۴۰۵/۰۸/۱۳ ۱۰:۳۰'));
  assert.match(html, /شناسنامه تجهیز/);
  assert.match(html, /قطعه یدکی حیاتی متصل به قلم واقعی انبار ثبت نشده است/);
  // A sparse asset must not invent anything.
  const sparse = identity.identityCardHtml({ asset: { code: 'X-1', name: 'تجهیز خالی' }, spares: { state: 'unavailable', rows: [] }, link, qr });
  assert.ok((sparse.match(/ثبت نشده/g) || []).length >= 15, 'missing fields print as not recorded');
  assert.match(sparse, /فهرست قطعات یدکی حیاتی هنگام چاپ دریافت نشد/);
  assert.doesNotMatch(sparse, /SIEMENS|PX-200/);
  assert.throws(() => identity.identityCardHtml({ asset: {} }), error => error.code === 'EQUIPMENT_DATA_REQUIRED');
});

test('D4 print: critical spare rows come only from real links and everything is escaped', () => {
  const link = identity.dossierLink('https://cmms.example.com', ASSET.code);
  const qr = identity.qrSvg(link, 200, qrcode);
  const html = identity.identityCardHtml({
    asset: { ...ASSET, name: '<img src=x onerror=alert(1)>' },
    spares: {
      state: 'ok',
      rows: [{ code: 'SP-1', name: 'یاتاقان', relationLabel: 'قطعه یدکی حیاتی', quantityRequired: 2, unit: 'عدد', stockAvailable: 4 },
        { code: 'SP-2', name: 'تسمه', relationType: 'general-spare', quantityRequired: null, unit: null, stockAvailable: null }]
    },
    link, qr
  });
  assert.match(html, /یاتاقان/);
  assert.match(html, /تسمه/);
  assert.match(html, /قطعه یدکی حیاتی/);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const labels = identity.labelsSheetHtml({ asset: ASSET, link, qr }, 3);
  assert.equal((labels.match(/display:inline-block;width:150px/g) || []).length, 3);
  assert.match(labels, /B1P01/);
});

/* ---------- UI wiring inside the real dossier module ---------- */

function uiHarness({ sparesBehavior = null, getBehavior = null, popupBlocked = false } = {}) {
  const content = { innerHTML: '' }, detailBody = { innerHTML: '' };
  const printWindow = {
    html: '', printed: 0, focused: 0,
    document: {
      open() {}, write(html) { printWindow.html += html; }, close() {},
      title: ''
    },
    focus() { printWindow.focused += 1; },
    print() { printWindow.printed += 1; }
  };
  const calls = { get: [], spares: [] };
  const asset = JSON.parse(JSON.stringify(ASSET));
  const repository = {
    source: 'postgresql',
    async get(id) {
      calls.get.push(String(id));
      if (getBehavior) return getBehavior(id);
      return { data: JSON.parse(JSON.stringify(asset)) };
    },
    async spares(id) {
      calls.spares.push(String(id));
      if (sparesBehavior) return sparesBehavior(id);
      return {
        data: {
          equipment: { id: asset.id, code: asset.code, name: asset.name },
          parts: [{ itemId: 'item-1', code: 'SP-1', name: 'یاتاقان', unit: 'عدد', relationType: 'key-spare', relationLabel: 'قطعه یدکی حیاتی', quantityRequired: 2, stockAvailable: 4, stockOnHand: 5, stockReserved: 1, minStock: 2, archived: false, rowVersion: 1, lastPurchase: null }],
          relationTypes: [{ value: 'key-spare', label: 'قطعه یدکی حیاتی' }],
          capabilities: { create: true, update: true, archive: true, inventoryView: true }
        }
      };
    },
    async feature() { return { enabled: true }; },
    async filters() { return { factories: [], categories: [], locations: [], responsibleUsers: [] }; },
    async list() { return { data: [], pagination: { page: 1, pages: 1, total: 0, limit: 50 } }; }
  };
  const toasts = [];
  const modals = [];
  const document = {
    getElementById: id => (id === 'content' ? content : id === 'eqv2DetailBody' ? detailBody : null),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}
  };
  const context = {
    MENU: [], pgTree: () => '', doLogin() {}, ME: { name: 'مدیر نت', role: 'mgr' }, CUR: 'equipment', buildMenu() {},
    EquipmentRepository: { current: () => repository },
    sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => { throw new Error('localStorage is forbidden'); }, setItem() { throw new Error('localStorage is forbidden'); } },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: fn => fn(),
    can: () => true, esc: value => String(value ?? ''), fa: value => String(value ?? ''), money: value => String(value ?? ''),
    jDate: value => String(value ?? ''), jDateTime: () => '۱۴۰۵/۰۸/۱۳ ۱۰:۳۰',
    AS_ST: { active: ['فعال', 'b-green'] },
    document, location: { pathname: '/', search: '', hash: '', protocol: 'https:', origin: 'https://cmms.example.com', host: 'cmms.example.com' },
    history: { pushState() {}, replaceState() {} }, CSS: { escape: value => String(value) },
    scrollY: 0, scrollTo() {}, addEventListener() {}, removeEventListener() {},
    open: () => (popupBlocked ? null : printWindow),
    modal: html => modals.push(html), mhead: title => `<div class="modal-title">${title}</div>`, closeModal() {},
    confirm: () => true, prompt: () => 'دلیل', toast: (message, kind) => toasts.push({ message: String(message), kind }),
    console, LOGO: 'data:image/jpeg;base64,TESTLOGO'
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('public/vendor/qrcode-generator.js'), context);
  vm.runInContext(read('public/equipment-v2/equipment-identity.js'), context);
  vm.runInContext(read('public/equipment-v2/equipment-v2.js'), context);
  Object.assign(context.EQV2, { detail: true, detailKey: 'B1P01', detailId: asset.id, tab: 'technical' });
  return { context, content, detailBody, printWindow, calls, toasts, modals, asset };
}

test('D4 UI: QR and print are independent header actions and the dossier keeps exactly eleven tabs', async () => {
  const h = uiHarness();
  await h.context.eqv2OpenDetail('b1-eq-p01');
  const tabs = [...h.content.innerHTML.matchAll(/<button role="tab"[^>]*>([^<]+)<\/button>/g)].map(match => match[1]);
  assert.equal(tabs.length, 11);
  assert.equal(tabs.some(label => /چاپ|QR/.test(label)), false);
  assert.match(h.content.innerHTML, /eqv2QrModal\('b1-eq-p01'\)/);
  assert.match(h.content.innerHTML, /eqv2PrintIdentity\('b1-eq-p01'\)/);
});

test('D4 UI: the QR modal shows a real scannable QR of the same-origin dossier link', async () => {
  const h = uiHarness();
  await h.context.eqv2QrModal('b1-eq-p01');
  assert.equal(h.modals.length, 1);
  const modal = h.modals[0];
  assert.match(modal, /https:\/\/cmms\.example\.com\/equipment\/B1P01/);
  assert.match(modal, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.doesNotMatch(modal, /▦/);
  assert.match(modal, /eqv2PrintQrLabels\('b1-eq-p01'\)/);
  assert.match(modal, /eqv2PrintIdentity\('b1-eq-p01'\)/);
});

test('D4 UI: printing the identity card fetches real dossier + spares data and writes a print document', async () => {
  const h = uiHarness();
  await h.context.eqv2PrintIdentity('b1-eq-p01');
  assert.deepEqual(h.calls.get, ['b1-eq-p01']);
  assert.deepEqual(h.calls.spares, ['b1-eq-p01']);
  assert.equal(h.printWindow.printed, 1);
  const html = h.printWindow.html;
  assert.match(html, /شناسنامه تجهیز/);
  assert.match(html, /B1P01/);
  assert.match(html, /SIEMENS/);
  assert.match(html, /یاتاقان/);
  assert.match(html, /https:\/\/cmms\.example\.com\/equipment\/B1P01/);
  assert.match(html, /مدیر نت/);
  assert.match(html, /۱۴۰۵\/۰۸\/۱۳ ۱۰:۳۰/);
  assert.match(html, /data:image\/jpeg;base64,TESTLOGO/);
});

test('D4 UI: a failed spares fetch degrades honestly on the printed card, never invented rows', async () => {
  const h = uiHarness({ sparesBehavior: () => { throw Object.assign(new Error('SPARES_FAILED'), { payload: { error: 'SPARES_FAILED' } }); } });
  await h.context.eqv2PrintIdentity('b1-eq-p01');
  assert.match(h.printWindow.html, /فهرست قطعات یدکی حیاتی هنگام چاپ دریافت نشد/);
  assert.doesNotMatch(h.printWindow.html, /یاتاقان/);
});

test('D4 UI: QR labels print three real copies and a blocked popup reports honestly', async () => {
  const h = uiHarness();
  await h.context.eqv2PrintQrLabels('b1-eq-p01');
  assert.equal(h.printWindow.printed, 1);
  assert.equal((h.printWindow.html.match(/display:inline-block;width:150px/g) || []).length, 3);
  const blocked = uiHarness({ popupBlocked: true });
  await blocked.context.eqv2PrintIdentity('b1-eq-p01');
  assert.ok(blocked.toasts.some(item => item.message.includes('پنجره چاپ باز نشد')));
});

test('D4 UI: identity actions never read or write browser storage', () => {
  const source = read('public/equipment-v2/equipment-v2.js');
  const identitySection = source.slice(source.indexOf('Mission D4 / Phase 11'), source.indexOf('function routeKey'));
  assert.doesNotMatch(identitySection, /localStorage|sessionStorage/);
  const module = read('public/equipment-v2/equipment-identity.js');
  assert.doesNotMatch(module, /localStorage|sessionStorage/);
});

/* ---------- Mission D4: independent passport route, batch A4 printing, QR security ---------- */

test('D4 passport: passportLink is the independent /equipment/{code}/passport route with no token or secret', () => {
  assert.equal(identity.passportLink('https://cmms.example.com/', 'B1P01'), 'https://cmms.example.com/equipment/B1P01/passport');
  assert.equal(identity.passportLink('https://cmms.example.com', 'B1 P01/ژ'), 'https://cmms.example.com/equipment/B1%20P01%2F%DA%98/passport');
  assert.throws(() => identity.passportLink('https://x', ''), error => error.code === 'EQUIPMENT_KEY_REQUIRED');
  for (const link of [identity.dossierLink('https://cmms.example.com', 'B1P01'), identity.passportLink('https://cmms.example.com', 'B1P01')]) {
    assert.doesNotMatch(link, /[?&](token|jwt|auth|key|secret|session)=/i, 'links never carry credentials');
    assert.doesNotMatch(link, /eyJ[A-Za-z0-9_-]{10,}/, 'no embedded JWT');
    assert.equal(new URL(link).search, '', 'no query string at all');
  }
});

test('D4 passport: the server serves the passport route as the app shell only — data stays behind the authenticated APIs', () => {
  const server = read('server.js');
  assert.match(server, /app\.get\('\/equipment\/:equipmentKey\/passport'/);
  const routeBlock = server.slice(server.indexOf("app.get('/equipment/:equipmentKey/passport'"));
  const handler = routeBlock.slice(0, routeBlock.indexOf('});') + 3);
  assert.match(handler, /sendFile\(path\.join\(__dirname, 'public', 'index\.html'\)\)/, 'only the shell is served');
  assert.doesNotMatch(handler, /pool\.query|SELECT|assets|json\(/, 'the route itself never reads operational data');
  // The client fetches passport values through the same authenticated repository as the dossier.
  const client = read('public/equipment-v2/equipment-v2.js');
  const passportFn = client.slice(client.indexOf('async function openPassport'), client.indexOf('// Group A4 printing'));
  assert.match(passportFn, /R\(\)\.get\(key\)/);
  assert.match(passportFn, /passportModelFor\(a\)/);
  assert.match(client, /function passportRouteKey\(\)\{const match=location\.pathname\.match\(\/\^\\\/equipment\\\/\(\[\^\/\]\+\)\\\/passport/);
});

test('D4 passport: openPassport renders the real sheet in-app and a denied fetch shows an honest error, never data', async () => {
  const h = uiHarness();
  await h.context.eqv2OpenPassport('B1P01');
  assert.deepEqual(h.calls.get, ['B1P01']);
  assert.deepEqual(h.calls.spares, ['b1-eq-p01']);
  assert.match(h.content.innerHTML, /eqv2-passport-sheet/);
  assert.match(h.content.innerHTML, /شناسنامه تجهیز/);
  assert.match(h.content.innerHTML, /B1P01/);
  assert.match(h.content.innerHTML, /eqv2PrintIdentity\('b1-eq-p01'\)/);
  const denied = uiHarness({ getBehavior: () => { throw Object.assign(new Error('PERMISSION_DENIED'), { payload: { error: 'PERMISSION_DENIED' } }); } });
  await denied.context.eqv2OpenPassport('B1P01');
  assert.match(denied.content.innerHTML, /شناسنامه تجهیز دریافت نشد/);
  assert.match(denied.content.innerHTML, /PERMISSION_DENIED/);
  assert.doesNotMatch(denied.content.innerHTML, /SIEMENS|SN-9912/, 'no equipment data leaks on a denied scan');
});

test('D4 batch: identityBatchHtml prints one A4 sheet per equipment with page breaks and an honest failure page', () => {
  const link = identity.dossierLink('https://cmms.example.com', ASSET.code);
  const qr = identity.qrSvg(link, 160, qrcode);
  const model = code => ({ asset: { ...ASSET, code }, spares: { state: 'empty', rows: [] }, link, qr });
  const html = identity.identityBatchHtml([model('B1P01'), model('B1P02')], ['B1P03: EQUIPMENT_NOT_FOUND']);
  assert.equal((html.match(/<div class="sheet">/g) || []).length, 3, 'two passports + one honest notice page');
  assert.match(html, /B1P01/);
  assert.match(html, /B1P02/);
  assert.match(html, /page-break-after:always/);
  assert.match(html, /شناسنامه‌های دریافت‌نشده/);
  assert.match(html, /B1P03: EQUIPMENT_NOT_FOUND/);
  assert.match(html, /چاپ گروهی شناسنامه تجهیزات \(2\)/);
  assert.doesNotMatch(html, /B1P03<\/span>/, 'a failed equipment never gets an invented passport');
});

test('D4 batch: printBatchIdentity fetches each passport sequentially and reports failures honestly', async () => {
  const h = uiHarness({ getBehavior: id => {
    if (String(id) === 'missing-eq') throw Object.assign(new Error('EQUIPMENT_NOT_FOUND'), { payload: { error: 'EQUIPMENT_NOT_FOUND' } });
    return { data: { ...JSON.parse(JSON.stringify(ASSET)), id: String(id), code: String(id).toUpperCase() } };
  } });
  await h.context.eqv2PrintBatchIdentity(['eq-a', 'missing-eq', 'eq-b']);
  assert.deepEqual(h.calls.get, ['eq-a', 'missing-eq', 'eq-b'], 'sequential real fetches, no fabricated rows');
  assert.equal(h.printWindow.printed, 1);
  assert.equal((h.printWindow.html.match(/<div class="sheet">/g) || []).length, 3);
  assert.match(h.printWindow.html, /EQ-A/);
  assert.match(h.printWindow.html, /EQ-B/);
  assert.match(h.printWindow.html, /missing-eq: EQUIPMENT_NOT_FOUND/);
  assert.ok(h.toasts.some(item => item.message.includes('دریافت نشد')));
  // The cap and the empty selection are enforced before any fetch.
  const before = h.calls.get.length;
  await h.context.eqv2PrintBatchIdentity([]);
  await h.context.eqv2PrintBatchIdentity(Array.from({ length: 51 }, (_, i) => `eq-${i}`));
  assert.equal(h.calls.get.length, before, 'empty or oversized batches never fetch');
  assert.ok(h.toasts.some(item => item.message.includes('۵۰')));
});

test('D4 batch: the registry toolbar exposes group printing with a real selection step', () => {
  const client = read('public/equipment-v2/equipment-v2.js');
  assert.match(client, /eqv2BatchPrintModal\(\)/);
  assert.match(client, /function batchPrintModal\(\)/);
  assert.match(client, /eqv2-batch-list/);
  assert.match(client, /window\.eqv2BatchPrintRun=batchPrintRun/);
  const css = read('public/equipment-v2/equipment-v2.css');
  assert.match(css, /\.eqv2-passport-sheet/);
  assert.match(css, /\.eqv2-suggestion-card/);
});
