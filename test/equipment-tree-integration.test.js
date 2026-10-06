'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootPath = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(rootPath, name), 'utf8');

function harness({ wizard = false } = {}) {
  const content = { innerHTML: '' }, detailBody = { innerHTML: '' }, detailHeader = { outerHTML: '' }, listeners = {};
  const host = {
    innerHTML: '', ownerDocument: null,
    addEventListener(name, fn) { listeners[`wizard:${name}`] = fn; },
    removeEventListener(name) { delete listeners[`wizard:${name}`]; },
    querySelector() { return null; }, contains() { return true; }, replaceChildren() { this.innerHTML = ''; }
  };
  const asset = {
    id: 'eq-1', code: 'EQ-1', name: 'پمپ تست', type: 'eq', status: 'active', crit: 'A', row_version: 2,
    factory_id: 'factory-1', category_id: 'cat-1', parent: 'factory-1', factory_name: 'بسپار ۱', location_name: 'سالن تولید',
    path: [{ id: 'factory-1', code: 'B1', name: 'بسپار ۱', nodeKind: 'factory' }, { id: 'eq-1', code: 'EQ-1', name: 'پمپ تست', nodeKind: 'equipment' }],
    children: [], pm_plans: [{ id: 'pm-1', title: 'بازدید پمپ', interval_days: 30, checklist: ['یاتاقان'], status: 'active' }],
    work_orders: [], maintenance_history: [], requests: [], spare_parts: [], consumed_parts: [], cost_entries: [], downtimes: [],
    documents: [], risks: [], rca: [], movements: [], ext: { nodeKind: 'equipment' }
  };
  const repository = {
    source: 'postgresql',
    get: async () => ({ data: asset }), feature: async () => ({ enabled: true }),
    filters: async () => ({ factories: [{ id: 'factory-1', code: 'B1', name: 'بسپار ۱' }], categories: [], locations: [], responsibleUsers: [] }),
    list: async () => ({ data: [], pagination: { page: 1, pages: 1, total: 0, limit: 50 } })
  };
  const document = {
    getElementById: id => id === 'content' ? content : id === 'eqv2WizardHost' ? host : id === 'eqv2DetailBody' ? detailBody : null,
    querySelector: selector => selector === '.eqv2-detail-header' ? detailHeader : null, querySelectorAll: () => [],
    addEventListener(name, fn) { listeners[name] = fn; }
  };
  host.ownerDocument = document;
  const context = {
    MENU: [{ g: 'دارایی‌ها' }, { id: 'tree', ic: '🌳', t: 'درخت تجهیزات' }],
    pgTree: () => '<div>classic tree</div>', doLogin() {}, ME: null, CUR: 'dash', buildMenu() {},
    EquipmentRepository: { current: () => repository },
    sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: fn => fn(), can: () => true,
    esc: value => String(value ?? ''), fa: value => String(value ?? ''), money: value => String(value ?? ''),
    jDate: value => String(value ?? ''), jDateTime: value => String(value ?? ''), AS_ST: { active: ['فعال', 'b-green'] },
    document, location: { pathname: '/', search: '', hash: '' },
    history: { pushState(_s, _t, url) { context.location.pathname = url; }, replaceState(_s, _t, url) { context.location.pathname = url; } },
    CSS: { escape: value => String(value) }, scrollY: 0, scrollTo() {}, addEventListener(name, fn) { listeners[name] = fn; },
    modal(html) { context.lastModal = html; }, mhead: title => `<div class="modal-title">${title}</div>`,
    closeModal() {}, confirm: () => true, toast() {}, console
  };
  context.window = context;
  vm.createContext(context);
  if (wizard) {
    vm.runInContext(read('public/platform-v2/step-wizard.js'), context);
    vm.runInContext(read('public/platform-v2/equipment-wizard-adapter.js'), context);
  }
  const source = read('public/equipment-v2/equipment-v2.js');
  vm.runInContext(source, context);
  return { context, content, detailBody, host, listeners, source, asset };
}

test('existing Equipment entry becomes one list-only registry without active tree navigation', () => {
  const { context, source } = harness();
  assert.equal(context.MENU.filter(item => item.id === 'equipment').length, 1);
  assert.equal(context.MENU.filter(item => item.id === 'tree').length, 0);
  assert.equal(context.MENU.some(item => item.id === 'equipmentV2' || item.id === 'floormap'), false);
  const html = context.pgTree();
  assert.match(html, /فهرست جامع تجهیزات/);
  assert.doesNotMatch(html, /🌳 درخت/);
  assert.match(html, /تمام تجهیزات ثبت‌شده در یک فهرست واحد/);
  assert.match(source, /data-equipment-detail/);
  assert.match(source, /onclick="eqv2OpenDetail/);
  assert.doesNotMatch(source, /eqv2View\(['"]tree/);
  assert.doesNotMatch(source, /window\.print\(\)/);
});

test('selecting a registry row opens the dossier and a stable bookmark route', async () => {
  const { context, content } = harness();
  await context.eqv2OpenDetail('eq-1');
  assert.equal(context.EQV2.selected, 'eq-1');
  assert.equal(context.location.pathname, '/equipment/EQ-1');
  assert.match(content.innerHTML, /← فهرست تجهیزات/);
  assert.match(content.innerHTML, /EQ-1/);
  assert.match(content.innerHTML, /پمپ تست/);
  assert.match(content.innerHTML, /بسپار ۱/);
  assert.match(content.innerHTML, /سالن تولید/);
  const firstPath = context.location.pathname;
  await context.eqv2OpenDetail('eq-1');
  assert.equal(context.location.pathname, firstPath, 'repeated navigation reuses the same detail route');
});

test('Back restores comprehensive-list filters, pagination and selection', async () => {
  const { context, content } = harness();
  Object.assign(context.EQV2, { view: 'list', q: 'B1P01', factoryId: 'factory-1', categoryId: 'cat-1', status: 'active', sort: 'code', direction: 'desc', page: 3, selected: 'eq-1' });
  await context.eqv2OpenDetail('eq-1');
  await context.eqv2BackToEquipment();
  assert.equal(context.EQV2.view, 'list');
  assert.equal(context.EQV2.q, 'B1P01');
  assert.equal(context.EQV2.factoryId, 'factory-1');
  assert.equal(context.EQV2.categoryId, 'cat-1');
  assert.equal(context.EQV2.status, 'active');
  assert.equal(context.EQV2.sort, 'code');
  assert.equal(context.EQV2.direction, 'desc');
  assert.equal(context.EQV2.page, 3);
  assert.equal(context.EQV2.selected, 'eq-1');
  assert.equal(context.location.pathname, '/');
  assert.match(content.innerHTML, /فهرست تجهیزات/);
  assert.doesNotMatch(content.innerHTML, /درخت تجهیزات/);
});

test('dossier has exactly the authoritative eleven sections and no passport-print tab', async () => {
  const { context, content } = harness();
  await context.eqv2OpenDetail('eq-1');
  const labels = [...content.innerHTML.matchAll(/<button role="tab"[^>]*>([^<]+)<\/button>/g)].map(match => match[1]);
  assert.deepEqual(labels, [
    'مشخصه فنی', 'ساختار', 'قطعات یدکی حیاتی', 'برنامه نگهداری', 'سوابق', 'کالیبراسیون',
    'دستورالعمل‌ها', 'اسناد و فایل‌ها', 'تراکنش‌ها', 'پایش تجهیز', 'ریسک و فرصت'
  ]);
  assert.equal((content.innerHTML.match(/role="tab"/g) || []).length, 11);
  assert.match(content.innerHTML, /eqv2-compact-header/);
  assert.match(content.innerHTML, /مشخصات فنی/);
  assert.doesNotMatch(content.innerHTML, /چاپ شناسنامه|QR/);
  assert.match(content.innerHTML, /eqv2-breadcrumb/);
});

test('risk section maps recorded work-order root-cause analysis without inventing findings', async () => {
  const { context, content, detailBody, asset } = harness();
  asset.rca = [{ wo_id: 'wo-1', wo_no: 'WO-1', at: '2026-01-01T00:00:00Z', root_cause: 'علت ثبت‌شده', action: 'اقدام ثبت‌شده' }];
  await context.eqv2OpenDetail('eq-1');
  await context.eqv2DetailTab('risk');
  assert.match(detailBody.innerHTML, /علت ثبت‌شده/);
  assert.match(detailBody.innerHTML, /اقدام ثبت‌شده/);
});

test('equipment editor uses the shared three-step wizard and starts section edits on the requested step', async () => {
  const { context, host } = harness({ wizard: true });
  await context.eqv2OpenWizard('eq-1', 'structure', 'structure');
  assert.equal(context.EQV2.wizard.instance.getCurrentStep().id, 'structure');
  assert.match(host.innerHTML, /ساختار ثبت‌شده/);
  assert.match(host.innerHTML, /مسیر و اجزای موجود را بررسی کنید/);

  context.EQV2.wizard.allowClose = true;
  context.closeModal();
  await context.eqv2OpenWizard('eq-1', 'maintenance', 'maintenance');
  assert.equal(context.EQV2.wizard.instance.getCurrentStep().id, 'maintenance');
  assert.match(host.innerHTML, /برنامه نگهداری/);
  assert.match(host.innerHTML, /بازدید پمپ/);
});
