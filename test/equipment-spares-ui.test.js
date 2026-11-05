'use strict';

// Mission D4 / Phase 3 — the critical spare parts tab inside the real dossier module.
// The harness mounts public/equipment-v2/equipment-v2.js in a VM with a controlled repository
// and proves: real ledger stock rendering, honest empty/error states, server-searched item
// linking (no typed stock, no item creation), versioned edits, reasoned soft-archive/restore,
// capability gating and scoped realtime refresh.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
async function settleUntil(testFn) { for (let i = 0; i < 40 && !testFn(); i += 1) await settle(); }

const EQ_ID = 'b1-eq-p01';

function partsPayload(overrides = {}) {
  return {
    equipment: { id: EQ_ID, code: 'B1P01', name: 'پمپ انتقال فوم' },
    parts: [{
      itemId: 'item-1', code: 'SP-1', name: 'یاتاقان', unit: 'عدد', partType: 'spare',
      brand: 'SKF', partNumber: 'P-100', relationType: 'key-spare', relationLabel: 'قطعه یدکی حیاتی',
      quantityRequired: 4, notes: 'سمت پروانه', rowVersion: 2, archived: false, deleteReason: null,
      minStock: 2, stockOnHand: 5, stockReserved: 2, stockAvailable: 3,
      lastPurchase: { at: '2026-10-15T08:00:00Z', entryNo: 'RC-2', qty: 2, unitCost: 130000, supplier: null, source: 'inventory_ledger' },
      itemArchived: false
    }],
    relationTypes: [{ value: 'key-spare', label: 'قطعه یدکی حیاتی' }, { value: 'general-spare', label: 'قطعه یدکی عمومی' }],
    targets: [
      { id: EQ_ID, code: 'B1P01', name: 'پمپ انتقال فوم', kind: 'equipment', label: 'تجهیز', criticalAllowed: false },
      { id: 'node-main', code: 'MC-1', name: 'یاتاقان اصلی', kind: 'main-component', label: 'قطعه اصلی زیرسیستم', criticalAllowed: true },
      { id: 'node-sub', code: 'SC-1', name: 'بوش', kind: 'sub-component', label: 'زیرقطعه قطعه اصلی', criticalAllowed: true }
    ],
    capabilities: { create: true, update: true, archive: true, suggest: true, approveAi: true, inventoryView: true },
    includeArchived: false,
    ...overrides
  };
}

function harness({ payload = partsPayload(), sparesError = null, capabilities = null } = {}) {
  const detailBody = { innerHTML: '' };
  const calls = { spares: [], link: [], update: [], archive: [], restore: [], inventoryItems: [], suggest: [], confirm: [], execute: [], reject: [] };
  const behavior = { link: null, update: null, archive: null, restore: null, spares: null, suggest: null };
  const livePayload = JSON.parse(JSON.stringify(payload));
  if (capabilities) livePayload.capabilities = { ...livePayload.capabilities, ...capabilities };
  const asset = {
    id: EQ_ID, code: 'B1P01', name: 'پمپ انتقال فوم', type: 'eq', status: 'active', crit: 'A', row_version: 4,
    ext: { keyParts: ['تسمه (SP-2)', 'الکتروموتور'] },
    path: [], spare_parts: [], pm_plans: [], work_orders: [], maintenance_history: [], requests: [],
    consumed_parts: [], cost_entries: [], downtimes: [], documents: [], risks: [], rca: [], movements: []
  };
  const fields = {};
  const fieldNode = id => (fields[id] || (fields[id] = { value: '', hidden: true, textContent: '', innerHTML: '' }));
  const repository = {
    source: 'postgresql',
    async get() { return { data: JSON.parse(JSON.stringify(asset)) }; },
    async spares(id, options = {}) {
      calls.spares.push({ id: String(id), options: { ...options } });
      if (behavior.spares) return behavior.spares(id, options);
      if (sparesError) throw Object.assign(new Error(sparesError), { payload: { error: sparesError } });
      return { data: JSON.parse(JSON.stringify(livePayload)) };
    },
    async spareLink(id, data) {
      calls.link.push({ id: String(id), payload: JSON.parse(JSON.stringify(data)) });
      if (behavior.link) return behavior.link(id, data);
      return { committed: true, data: { ...data, rowVersion: 1 } };
    },
    async spareUpdate(id, itemId, data) {
      calls.update.push({ id: String(id), itemId: String(itemId), payload: JSON.parse(JSON.stringify(data)) });
      if (behavior.update) return behavior.update(id, itemId, data);
      return { committed: true, data: { ...data, itemId } };
    },
    async spareArchive(id, itemId, reason, rowVersion) {
      calls.archive.push({ id: String(id), itemId: String(itemId), reason, rowVersion });
      if (behavior.archive) return behavior.archive(id, itemId, reason, rowVersion);
      return { archived: true, historyPreserved: true, data: { itemId, rowVersion: rowVersion + 1 } };
    },
    async spareRestore(id, itemId, data) {
      calls.restore.push({ id: String(id), itemId: String(itemId), payload: JSON.parse(JSON.stringify(data)) });
      if (behavior.restore) return behavior.restore(id, itemId, data);
      return { restored: true, historyPreserved: true, committed: true, data: { itemId, rowVersion: data.rowVersion + 1 } };
    },
    async sparesSuggestions(id) {
      calls.suggest.push(String(id));
      if (behavior.suggest) return behavior.suggest(id);
      return { data: {
        provider: 'deepseek', model: 'deepseek-chat', notice: null, insufficient: false,
        suggestions: [{
          id: 'draft-1', actionType: 'equipment.spares.link', destination: 'equipment.spares', status: 'pending',
          proposed: { rootEquipmentId: EQ_ID, targetId: 'node-main', itemId: 'item-1', relationType: 'key-spare', quantityRequired: 2, explanation: 'تطبیق شماره فنی P-100', missingFields: [] },
          source: { kind: 'document', ref: 'spares-suggestion:deepseek-chat', verified: false },
          evidence: [{ field: 'partNumber', value: 'P-100', origin: 'component-ext' }],
          confidence: 0.82, missingFields: [], conflictingFields: [], rowVersion: 1
        }]
      } };
    },
    async actionConfirm(id) { calls.confirm.push(String(id)); return { data: { id: 'conf-1', draftId: id } }; },
    async actionExecute(id, data) { calls.execute.push({ id: String(id), payload: { ...data } }); return { committed: true, actionType: 'equipment.spares.link', data: { itemId: 'item-1' } }; },
    async actionReject(id) { calls.reject.push(String(id)); return { data: { id, status: 'rejected' } }; },
    async inventoryItems(q) {
      calls.inventoryItems.push(String(q || ''));
      return {
        data: [
          { id: 'item-9', code: 'SP-9', name: 'کاسه نمد', unit: 'عدد', available: 7, lastPurchaseAt: '2026-09-01T08:00:00Z' },
          { id: 'item-1', code: 'SP-1', name: 'یاتاقان', unit: 'عدد', available: 3, lastPurchaseAt: null }
        ]
      };
    },
    async feature() { return { enabled: true }; },
    async filters() { return { factories: [], categories: [], locations: [], responsibleUsers: [] }; },
    async list() { return { data: [], pagination: { page: 1, pages: 1, total: 0, limit: 50 } }; }
  };
  const listeners = new Map();
  const modals = [];
  const toasts = [];
  let closedModals = 0;
  let promptAnswer = 'دلیل آزمون';
  let confirmAnswer = true;
  const document = {
    getElementById(id) {
      if (id === 'eqv2DetailBody') return detailBody;
      if (id === 'content') return { innerHTML: '' };
      if (['spareItemQuery', 'spareItemSelect', 'spareRelation', 'spareQuantity', 'spareNotes', 'spareFormError', 'spareTarget'].includes(id)) return fieldNode(id);
      return null;
    },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener(type, handler) { const set = listeners.get(type) || new Set(); set.add(handler); listeners.set(type, set); },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); }
  };
  const context = {
    MENU: [], pgTree: () => '', doLogin() {}, ME: { name: 'مدیر نت', role: 'mgr' }, CUR: 'equipment', buildMenu() {},
    EquipmentRepository: { current: () => repository },
    sessionStorage: { getItem: () => null, setItem() {} },
    localStorage: { getItem: () => { throw new Error('localStorage forbidden'); }, setItem() { throw new Error('localStorage forbidden'); } },
    setTimeout: fn => { fn(); return 0; }, clearTimeout() {}, requestAnimationFrame: fn => fn(),
    can: () => true, esc: value => String(value ?? ''), fa: value => String(value ?? ''), money: value => String(value ?? ''),
    jDate: value => String(value ?? '').slice(0, 10), jDateTime: value => String(value ?? ''),
    AS_ST: { active: ['فعال', 'b-green'] },
    document, location: { pathname: '/equipment/B1P01', search: '', hash: '', protocol: 'https:', origin: 'https://cmms.example.com' },
    history: { pushState() {}, replaceState() {} }, CSS: { escape: value => String(value) },
    scrollY: 0, scrollTo() {},
    addEventListener(type, handler) { const set = listeners.get(type) || new Set(); set.add(handler); listeners.set(type, set); },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    modal: html => modals.push(html), mhead: title => `<div class="modal-title">${title}</div>`,
    closeModal: () => { closedModals += 1; },
    prompt: () => promptAnswer, confirm: () => confirmAnswer,
    toast: (message, kind) => toasts.push({ message: String(message), kind }), console,
    crypto: { randomUUID: () => 'req-1' }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('public/equipment-v2/equipment-identity.js'), context);
  vm.runInContext(read('public/equipment-v2/equipment-v2.js'), context);
  Object.assign(context.EQV2, { detail: true, detailKey: 'B1P01', detailId: EQ_ID, tab: 'technical' });
  return {
    context, detailBody, calls, behavior, livePayload, fields: fieldNode, modals, toasts, listeners,
    get closedModals() { return closedModals; },
    setPrompt(value) { promptAnswer = value; }, setConfirm(value) { confirmAnswer = value; },
    dispatchDomain(detail) { for (const handler of [...(listeners.get('bfg:domain-event') || [])]) handler({ detail }); }
  };
}

async function showSpares(h) {
  await h.context.eqv2DetailTab('spares');
  await settleUntil(() => h.calls.spares.length > 0 && !h.detailBody.innerHTML.includes('در حال دریافت قطعات یدکی حیاتی'));
  await settle();
  return h.detailBody.innerHTML;
}

test('D4 UI: the spares tab loads by real equipment id and renders ledger stock, shortage and last purchase', async () => {
  const h = harness();
  const html = await showSpares(h);
  assert.deepEqual(h.calls.spares[0], { id: EQ_ID, options: { includeArchived: false } });
  assert.match(html, /قطعات یدکی حیاتی/);
  assert.match(html, /SP-1/);
  assert.match(html, /یاتاقان/);
  assert.match(html, /قطعه یدکی حیاتی/);
  assert.match(html, /data-spare-item="item-1"/);
  // available 3 < required 4 → real shortage badge, computed from ledger facts only.
  assert.match(html, /کسری نسبت به نیاز تجهیز/);
  assert.match(html, /در دست: 5 · رزرو: 2/);
  assert.match(html, /RC-2/);
  assert.match(html, /2026-10-15/);
  // Legacy ext.keyParts stays a descriptive text section, not inventory.
  assert.match(html, /قطعات کلیدیِ متنی در پرونده قدیمی/);
  assert.match(html, /تسمه \(SP-2\)/);
  assert.match(html, /قلم انبار یا موجودی محسوب نمی‌شود/);
});

test('D4 UI: no shortage badge when stock covers the need or facts are missing', async () => {
  const covered = partsPayload();
  covered.parts[0].stockAvailable = 9;
  const h1 = harness({ payload: covered });
  const html1 = await showSpares(h1);
  assert.doesNotMatch(html1, /کسری نسبت به نیاز تجهیز/);
  const unknown = partsPayload();
  unknown.parts[0].quantityRequired = null;
  unknown.parts[0].stockAvailable = null;
  unknown.parts[0].stockOnHand = null;
  unknown.parts[0].stockReserved = null;
  unknown.parts[0].lastPurchase = null;
  const h2 = harness({ payload: unknown });
  const html2 = await showSpares(h2);
  assert.doesNotMatch(html2, /کسری نسبت به نیاز تجهیز/);
  assert.match(html2, /ثبت نشده/);
});

test('D4 UI: honest empty state and Persian error state with retry', async () => {
  const empty = harness({ payload: partsPayload({ parts: [] }) });
  const emptyHtml = await showSpares(empty);
  assert.match(emptyHtml, /هنوز قطعه یدکی به قلم واقعی انبار متصل نشده است/);
  const failing = harness({ sparesError: 'EQUIPMENT_SCOPE_DENIED' });
  const errorHtml = await showSpares(failing);
  assert.match(errorHtml, /این تجهیز در محدوده دسترسی شما نیست/);
  assert.match(errorHtml, /eqv2SparesRefresh\(\)/);
  assert.doesNotMatch(errorHtml, /EQUIPMENT_SCOPE_DENIED/, 'raw backend codes are never shown');
});

test('D4 UI: add form searches real items server-side and has no typed stock field', async () => {
  const h = harness();
  await showSpares(h);
  h.context.eqv2SpareAdd();
  assert.equal(h.modals.length, 1);
  const form = h.modals[0];
  assert.match(form, /افزودن قطعه یدکی/);
  assert.match(form, /id="spareTarget"/, 'the link target is chosen explicitly');
  assert.match(form, /قطعه حیاتی فقط برای «جزء اصلی» و «جزء فرعی» مجاز است/);
  assert.match(form, /id="spareItemQuery"/);
  assert.match(form, /id="spareItemSelect"/);
  assert.match(form, /id="spareRelation"/);
  assert.match(form, /id="spareQuantity"/);
  assert.match(form, /موجودی تایپ نمی‌شود و فقط از دفتر انبار خوانده می‌شود/);
  assert.doesNotMatch(form, /id="spareStock"|id="spareOnHand"|id="spareMinStock"|name="stock"/);
  h.fields('spareItemQuery').value = 'کاسه';
  await h.context.eqv2SpareItemSearch();
  assert.deepEqual(h.calls.inventoryItems, ['کاسه']);
  assert.match(h.fields('spareItemSelect').innerHTML, /SP-9/);
  assert.match(h.fields('spareItemSelect').innerHTML, /موجودی قابل دسترس: 7/);
});

test('D4 UI: linking posts the real item id and relation, then reloads from the server', async () => {
  const h = harness();
  await showSpares(h);
  h.context.eqv2SpareAdd();
  h.fields('spareItemSelect').value = 'item-9';
  h.fields('spareRelation').value = 'key-spare';
  h.fields('spareQuantity').value = '2';
  h.fields('spareNotes').value = 'قطعه حیاتی خط';
  const before = h.calls.spares.length;
  await h.context.eqv2SpareSubmit('create', '');
  assert.equal(h.calls.link.length, 1);
  assert.deepEqual(h.calls.link[0], { id: EQ_ID, payload: { relationType: 'key-spare', quantityRequired: 2, notes: 'قطعه حیاتی خط', itemId: 'item-9' } });
  assert.ok(h.calls.spares.length > before, 'the list must reload from the server after commit');
  assert.ok(h.toasts.some(item => item.message.includes('commit')));
  assert.equal(h.closedModals, 1);
});

test('D4 UI: submit without an item or with a bad quantity never posts', async () => {
  const h = harness();
  await showSpares(h);
  h.context.eqv2SpareAdd();
  h.fields('spareItemSelect').value = '';
  await h.context.eqv2SpareSubmit('create', '');
  assert.equal(h.calls.link.length, 0);
  assert.match(h.fields('spareFormError').textContent, /قلم واقعی انبار را جستجو و انتخاب کنید/);
  h.fields('spareItemSelect').value = 'item-9';
  h.fields('spareQuantity').value = '-2';
  await h.context.eqv2SpareSubmit('create', '');
  assert.equal(h.calls.link.length, 0);
  assert.match(h.fields('spareFormError').textContent, /تعداد موردنیاز باید عددی مثبت یا صفر/);
});

test('D4 UI: a backend rejection keeps the form open with a Persian message', async () => {
  const h = harness();
  await showSpares(h);
  h.behavior.link = async () => { throw Object.assign(new Error('SPARE_LINK_EXISTS'), { payload: { error: 'SPARE_LINK_EXISTS' } }); };
  h.context.eqv2SpareAdd();
  h.fields('spareItemSelect').value = 'item-1';
  await h.context.eqv2SpareSubmit('create', '');
  assert.equal(h.calls.link.length, 1);
  assert.equal(h.closedModals, 0, 'the form stays open on failure');
  assert.match(h.fields('spareFormError').textContent, /قبلاً به پرونده همین تجهیز متصل شده است/);
  assert.equal(h.toasts.some(item => item.message.includes('commit')), false);
});

test('D4 UI: edit patches the exact link with its real rowVersion', async () => {
  const h = harness();
  await showSpares(h);
  h.context.eqv2SpareEdit('item-1');
  const form = h.modals[0];
  assert.match(form, /ویرایش اتصال قطعه یدکی/);
  assert.match(form, /غیرقابل تغییر/);
  assert.doesNotMatch(form, /id="spareItemSelect"/);
  h.fields('spareRelation').value = 'general-spare';
  h.fields('spareQuantity').value = '6';
  h.fields('spareNotes').value = 'به‌روزرسانی';
  await h.context.eqv2SpareSubmit('edit', 'item-1');
  assert.equal(h.calls.update.length, 1);
  assert.deepEqual(h.calls.update[0], {
    id: EQ_ID, itemId: 'item-1',
    payload: { relationType: 'general-spare', quantityRequired: 6, notes: 'به‌روزرسانی', rowVersion: 2 }
  });
});

test('D4 UI: archive demands a reason and confirms; restore is explicit', async () => {
  const h = harness();
  await showSpares(h);
  h.setPrompt('   ');
  await h.context.eqv2SpareArchive('item-1');
  assert.equal(h.calls.archive.length, 0, 'blank reason must not archive');
  h.setPrompt('قطعه جایگزین شد');
  h.setConfirm(false);
  await h.context.eqv2SpareArchive('item-1');
  assert.equal(h.calls.archive.length, 0, 'cancelled confirmation must not archive');
  h.setConfirm(true);
  await h.context.eqv2SpareArchive('item-1');
  assert.deepEqual(h.calls.archive[0], { id: EQ_ID, itemId: 'item-1', reason: 'قطعه جایگزین شد', rowVersion: 2 });
  assert.ok(h.toasts.some(item => item.message.includes('بایگانی')));
  // Archived view + restore.
  h.livePayload.parts[0].archived = true;
  h.livePayload.parts[0].deleteReason = 'قطعه جایگزین شد';
  h.livePayload.parts[0].rowVersion = 3;
  await h.context.eqv2SparesArchivedToggle();
  await settle();
  assert.equal(h.calls.spares.at(-1).options.includeArchived, true);
  assert.match(h.detailBody.innerHTML, /بایگانی‌شده/);
  assert.match(h.detailBody.innerHTML, /eqv2SpareRestore\('item-1',''\)/);
  h.setPrompt('بازگشت به سرویس');
  await h.context.eqv2SpareRestore('item-1');
  assert.deepEqual(h.calls.restore[0], { id: EQ_ID, itemId: 'item-1', payload: { reason: 'بازگشت به سرویس', rowVersion: 3 } });
});

test('D4 UI: capabilities hide write actions server-side truth', async () => {
  const h = harness({ capabilities: { create: false, update: false, archive: false } });
  const html = await showSpares(h);
  assert.doesNotMatch(html, /eqv2SpareAdd\(\)/);
  assert.doesNotMatch(html, /eqv2SpareEdit\(/);
  assert.doesNotMatch(html, /eqv2SpareArchive\(/);
  assert.doesNotMatch(html, /eqv2SparesArchivedToggle\(\)/);
  assert.match(html, /SP-1/, 'read-only data stays visible');
});

test('D4 UI: the target selector gates critical relations — root allows general only, components allow critical', async () => {
  const h = harness();
  await showSpares(h);
  h.context.eqv2SpareAdd();
  const form = h.modals[0];
  // Default target is the equipment root: critical must not be offered.
  assert.match(form, /id="spareTarget"/);
  const rootRelationBlock = form.match(/<select id="spareRelation">([\s\S]*?)<\/select>/)[1];
  assert.doesNotMatch(rootRelationBlock, /value="key-spare"/, 'critical is not offered on the equipment root');
  assert.match(rootRelationBlock, /value="general-spare"/);
  // Switching to a main-component re-offers critical.
  h.fields('spareTarget').value = 'node-main';
  h.context.eqv2SpareTargetChanged();
  assert.match(h.fields('spareRelation').innerHTML, /value="key-spare"/);
  // The create payload carries the chosen target.
  h.fields('spareItemSelect').value = 'item-9';
  h.fields('spareRelation').value = 'key-spare';
  await h.context.eqv2SpareSubmit('create', '');
  assert.equal(h.calls.link.length, 1);
  assert.equal(h.calls.link[0].payload.targetId, 'node-main');
  assert.equal(h.calls.link[0].payload.relationType, 'key-spare');
});

test('D4 UI: the spares table shows the link target column', async () => {
  const payload = partsPayload();
  payload.parts[0].targetId = 'node-main';
  payload.parts[0].target = { id: 'node-main', code: 'MC-1', name: 'یاتاقان اصلی', kind: 'main-component', label: 'قطعه اصلی زیرسیستم', criticalAllowed: true };
  const h = harness({ payload });
  const html = await showSpares(h);
  assert.match(html, /<th>هدف اتصال<\/th>/);
  assert.match(html, /یاتاقان اصلی/);
  assert.match(html, /قطعه اصلی زیرسیستم/);
  assert.match(html, /data-spare-target="node-main"/);
});

test('D4 UI: Selene suggestions render evidence/provenance/confidence/provider/model and write nothing by themselves', async () => {
  const h = harness();
  await showSpares(h);
  assert.match(h.detailBody.innerHTML, /eqv2SpareSuggest\(\)/);
  await h.context.eqv2SpareSuggest();
  await settleUntil(() => h.detailBody.innerHTML.includes('draft-1'));
  const html = h.detailBody.innerHTML;
  assert.deepEqual(h.calls.suggest, [EQ_ID]);
  assert.match(html, /تطبیق شماره فنی P-100/);
  assert.match(html, /partNumber/);
  assert.match(html, /spares-suggestion:deepseek-chat/);
  assert.match(html, /deepseek/);
  assert.match(html, /۸۲٪|82/);
  assert.match(html, /در انتظار تأیید/);
  assert.match(html, /eqv2SpareApprove\('draft-1'\)/);
  assert.match(html, /eqv2SpareReject\('draft-1'\)/);
  // Suggesting alone performs no link write and no confirm/execute.
  assert.equal(h.calls.link.length, 0);
  assert.equal(h.calls.confirm.length, 0);
  assert.equal(h.calls.execute.length, 0);
});

test('D4 UI: approving a suggestion goes through confirm then execute with a request id, then reloads', async () => {
  const h = harness();
  await showSpares(h);
  await h.context.eqv2SpareSuggest();
  await settleUntil(() => h.detailBody.innerHTML.includes('draft-1'));
  const before = h.calls.spares.length;
  await h.context.eqv2SpareApprove('draft-1');
  await settleUntil(() => h.calls.execute.length > 0);
  assert.deepEqual(h.calls.confirm, ['draft-1']);
  assert.equal(h.calls.execute.length, 1);
  assert.equal(h.calls.execute[0].id, 'draft-1');
  assert.equal(h.calls.execute[0].payload.confirmationId, 'conf-1');
  assert.ok(h.calls.execute[0].payload.requestId, 'execute carries an idempotency request id');
  assert.equal(h.calls.link.length, 0, 'approval never bypasses the controlled action endpoint');
  await settleUntil(() => h.calls.spares.length > before);
  assert.ok(h.toasts.some(item => item.message.includes('Domain API')));
});

test('D4 UI: rejecting a suggestion calls the reject endpoint and removes the card without any write', async () => {
  const h = harness();
  await showSpares(h);
  await h.context.eqv2SpareSuggest();
  await settleUntil(() => h.detailBody.innerHTML.includes('draft-1'));
  h.setPrompt('شاهد کافی نیست');
  await h.context.eqv2SpareReject('draft-1');
  await settleUntil(() => !h.detailBody.innerHTML.includes('data-suggestion="draft-1"'));
  assert.deepEqual(h.calls.reject, ['draft-1']);
  assert.equal(h.calls.link.length, 0);
  assert.equal(h.calls.execute.length, 0);
});

test('D4 UI: without suggest/approve capabilities the suggestion panel and buttons stay hidden', async () => {
  const h = harness({ capabilities: { suggest: false, approveAi: false } });
  const html = await showSpares(h);
  assert.doesNotMatch(html, /eqv2SpareSuggest\(\)/);
  assert.doesNotMatch(html, /پیشنهاد سلن برای قطعات یدکی/);
});

test('D4 UI: a scoped realtime spares event refreshes only the open dossier tab', async () => {
  const h = harness();
  await showSpares(h);
  const before = h.calls.spares.length;
  h.dispatchDomain({ type: 'equipment.spares.changed', aggregateType: 'equipment', aggregateId: 'another-eq', payload: {} });
  await settle();
  assert.equal(h.calls.spares.length, before, 'other equipment events are ignored');
  h.dispatchDomain({ type: 'equipment.spares.changed', aggregateType: 'equipment', aggregateId: EQ_ID, payload: { action: 'edit' } });
  await settleUntil(() => h.calls.spares.length > before);
  assert.equal(h.calls.spares.at(-1).id, EQ_ID);
  // Structure events keep their own contract.
  h.dispatchDomain({ type: 'equipment.structure.changed', aggregateType: 'equipment', aggregateId: EQ_ID, payload: {} });
  await settle();
});
