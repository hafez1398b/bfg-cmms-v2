'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootPath = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(rootPath, file), 'utf8');
const ROOT_ID = 'equipment-b1bt';
const LEGACY_ID = 'equipment-b1bt9955';
const SUBSYSTEM_ID = 'subsystem-1';
const MAIN_ID = 'main-1';
const PART_ID = 'part-1';
const copy = value => JSON.parse(JSON.stringify(value));

function structureTree({ descendants = true, archived = false, diagnostics = [] } = {}) {
  const legacy = {
    id: LEGACY_ID, code: 'B1BT9955', name: 'تجهیز انتخاب‌شده B1BT9955', nodeKind: 'sub-equipment',
    rowVersion: 6, archived, legacy: true, validRelation: false, path: [{ id: LEGACY_ID }], children: []
  };
  if (descendants) {
    legacy.children.push({
      id: SUBSYSTEM_ID, code: 'SYS-1', name: 'زیرسیستم یک', nodeKind: 'subsystem', rowVersion: 3,
      archived: false, legacy: false, validRelation: true, path: [{ id: LEGACY_ID }, { id: SUBSYSTEM_ID }], children: [{
        id: MAIN_ID, code: 'CMP-1', name: 'قطعه اصلی یک', nodeKind: 'main-component', rowVersion: 2,
        archived: false, legacy: false, validRelation: true, path: [{ id: LEGACY_ID }, { id: SUBSYSTEM_ID }, { id: MAIN_ID }], children: [{
          id: PART_ID, code: 'PART-1', name: 'زیرقطعه یک', nodeKind: 'sub-component', rowVersion: 1,
          archived: false, legacy: false, validRelation: true,
          path: [{ id: LEGACY_ID }, { id: SUBSYSTEM_ID }, { id: MAIN_ID }, { id: PART_ID }], children: []
        }]
      }]
    });
  }
  return {
    rootId: ROOT_ID, rootEquipmentId: ROOT_ID,
    root: { id: ROOT_ID, code: 'B1BT', name: 'تجهیز B1BT', nodeKind: 'equipment', rowVersion: 9 },
    nodes: [legacy], rootAllowedChildren: ['subsystem'], nodeCount: descendants ? 4 : 1,
    capabilities: { create: true, update: true, move: true, moveAcrossEquipment: false, archive: true, suggest: false, approveAi: false },
    suggestions: [], diagnostics: copy(diagnostics)
  };
}

class DrawerRoot {
  constructor(html) {
    this.innerHTML = html;
    this.listeners = new Map();
    this.removed = false;
    this.fields = [...html.matchAll(/data-structure-field="([^"]+)"/g)].map(match => ({
      dataset: { structureField: match[1] }, value: match[1] === 'status' ? 'active' : '',
      isConnected: true, focus() { this.focused = true; }
    }));
    this.errorNode = { hidden: true, textContent: '' };
    this.inventoryResult = { textContent: '' };
    this.actionButtons = new Map();
    for (const match of html.matchAll(/data-structure-action="([^"]+)"/g)) {
      const action = match[1];
      if (!this.actionButtons.has(action)) this.actionButtons.set(action, []);
      this.actionButtons.get(action).push({ dataset: { structureAction: action }, disabled: false, textContent: '' });
    }
  }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler); this.listeners.set(type, handlers);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== handler));
  }
  querySelector(selector) {
    if (selector === '[data-structure-error]') return this.errorNode;
    if (selector === '[data-inventory-results]') return this.inventoryResult;
    if (selector === '[data-structure-action="save"]') return this.actionButtons.get('save')?.[0] || null;
    if (selector === '[data-structure-action="parent-continue"]') return this.actionButtons.get('parent-continue')?.[0] || null;
    if (selector === '[data-structure-inventory-search]') return null;
    if (selector === '[data-structure-field="inventoryItemId"]') return this.fields.find(field => field.dataset.structureField === 'inventoryItemId') || null;
    if (selector === '[data-autofocus]') return null;
    if (selector.includes('.eqv2-structure-form input')) return this.fields[0] || null;
    if (selector === '#eqv2StructureParentChoice') return this.parentChoice || null;
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '[data-structure-field]') return this.fields;
    if (selector === '[data-structure-action="cancel"],[data-structure-action="close"],.eqv2-structure-drawer-x') {
      return [...(this.actionButtons.get('cancel') || []), ...(this.actionButtons.get('close') || [])];
    }
    return [];
  }
  contains() { return true; }
  remove() { this.removed = true; }
  focus() { this.focused = true; }
  click(action, index = 0) {
    const button = this.actionButtons.get(action)?.[index];
    assert.ok(button, `missing drawer action: ${action} (${index})`);
    const target = { dataset: button.dataset, closest: selector => selector === '[data-structure-action]' ? button : null };
    for (const handler of [...(this.listeners.get('click') || [])]) handler({ target, preventDefault() {} });
  }
  clickBackdrop() {
    for (const handler of [...(this.listeners.get('click') || [])]) handler({ target: this, preventDefault() {} });
  }
  input(fieldId, value) {
    const field = this.fields.find(item => item.dataset.structureField === fieldId);
    assert.ok(field, `missing drawer field: ${fieldId}`); field.value = value;
    const target = { dataset: { structureField: fieldId }, value, closest: selector => selector === '[data-structure-field]' ? field : null };
    for (const handler of [...(this.listeners.get('input') || [])]) handler({ target, type: 'input' });
  }
}

function harness({ initialTree = structureTree(), shallowTree = null } = {}) {
  let liveTree = copy(initialTree);
  const calls = { structure: [], create: [], archive: [], restore: [] };
  const behavior = { structure: null, archive: null, restore: null };
  const asset = { id: ROOT_ID, code: 'B1BT', name: 'تجهیز B1BT', type: 'eq', status: 'active', crit: 'A', row_version: 9, ext: {}, path: [], children: [], pm_plans: [], work_orders: [], maintenance_history: [], requests: [], spare_parts: [], consumed_parts: [], cost_entries: [], downtimes: [], documents: [], risks: [], rca: [], movements: [] };
  const activeTree = tree => {
    const result = copy(tree);
    const filter = nodes => (nodes || []).filter(node => !node.archived).map(node => ({ ...node, children: filter(node.children) }));
    result.nodes = filter(result.nodes); return result;
  };
  const repository = {
    source: 'postgresql',
    async get() { return { data: copy(asset) }; },
    async structure(id, options = {}) {
      calls.structure.push({ id, options: { ...options } });
      if (behavior.structure) return behavior.structure(id, options);
      const tree = options.includeArchived ? liveTree : activeTree(liveTree);
      return { data: copy(tree) };
    },
    async structureCreate(payload) {
      calls.create.push(copy(payload));
      return { httpStatus: 201, committed: true, data: { id: 'created-subsystem', ...copy(payload), row_version: 1 } };
    },
    async structureArchive(id, reason, rowVersion) {
      calls.archive.push({ id, reason, rowVersion });
      if (behavior.archive) return behavior.archive(id, reason, rowVersion);
      const node = flatten(liveTree.nodes).find(item => String(item.id) === String(id));
      node.archived = true; return { archived: true, historyPreserved: true, data: { id, row_version: rowVersion + 1 } };
    },
    async structureRestore(id, payload) {
      calls.restore.push({ id, payload: copy(payload) });
      if (behavior.restore) return behavior.restore(id, payload);
      const node = flatten(liveTree.nodes).find(item => String(item.id) === String(id));
      node.archived = false; return { committed: true, restored: true, historyPreserved: true, data: { id, row_version: payload.rowVersion + 1 } };
    },
    async inventoryItems() { return { data: [] }; },
    async actionReject() { return { committed: true }; }
  };
  if (shallowTree) liveTree = copy(shallowTree);
  const detailBody = { innerHTML: '' }, scrollWrap = { scrollTop: 47, scrollLeft: 19 };
  const listeners = new Map();
  const previousFocus = { isConnected: true, focus() { this.focused = true; } };
  const document = {
    body: { style: { overflow: 'auto' }, insertAdjacentHTML(_position, html) { document.drawerRoot = new DrawerRoot(html); } },
    documentElement: { style: { overflow: 'scroll' } }, activeElement: previousFocus,
    getElementById(id) { if (id === 'eqv2DetailBody') return detailBody; if (id === 'eqv2StructureDrawer') return document.drawerRoot || null; if (id === 'content') return { innerHTML: '' }; return null; },
    querySelector(selector) { if (selector === '.eqv2-structure-table-wrap') return scrollWrap; return null; },
    querySelectorAll() { return []; },
    addEventListener(type, handler) { const set = listeners.get(type) || new Set(); set.add(handler); listeners.set(type, set); },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); }
  };
  const context = {
    MENU: [{ id: 'equipment', t: 'فهرست جامع تجهیزات' }], pgTree: () => '', doLogin() {}, ME: null, CUR: 'equipment', buildMenu() {},
    EquipmentRepository: { current: () => repository }, sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: fn => fn(),
    can: () => true, esc: value => String(value ?? ''), fa: value => String(value ?? ''), money: value => String(value ?? ''),
    jDate: value => String(value ?? ''), jDateTime: value => String(value ?? ''), AS_ST: { active: ['فعال', 'b-green'], stopped: ['متوقف', 'b-gray'] },
    document, location: { pathname: '/equipment/B1BT', search: '', hash: '' },
    history: { pushState() {}, replaceState() {} }, CSS: { escape: value => String(value) },
    scrollY: 326, scrollX: 0, scrollTo(x, y) { context.scrollX = x; context.scrollY = y; },
    addEventListener(type, handler) { const set = listeners.get(type) || new Set(); set.add(handler); listeners.set(type, set); },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    modal() {}, mhead: title => title, closeModal() {},
    prompt: () => 'دلیل آزمون', confirm: () => true, toasts: [], toast(message) { context.toasts.push(String(message)); },
    console, crypto: { randomUUID: () => 'request-1' }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('public/equipment-v2/structure-drawer-controller.js'), context);
  vm.runInContext(read('public/equipment-v2/equipment-v2.js'), context);
  Object.assign(context.EQV2, { detail: true, detailKey: 'B1BT', detailId: ROOT_ID, tab: 'structure', structure: copy(liveTree) });
  return { context, document, detailBody, calls, behavior, repository, get liveTree() { return liveTree; }, set liveTree(value) { liveTree = copy(value); }, scrollWrap, previousFocus, listeners };
}

function flatten(nodes, result = []) { for (const node of nodes || []) { result.push(node); flatten(node.children, result); } return result; }
async function showStructure(h) { await h.context.eqv2DetailTab('structure'); return h.detailBody.innerHTML; }
const settle = () => new Promise(resolve => setImmediate(resolve));
async function settleUntil(testFn) { for (let i = 0; i < 30 && !testFn(); i++) await settle(); }

// The legacy row action is deliberately tested through the rendered row, then through the real create callback.
test('row action uses the exact selected equipment id from Drawer through POST', async () => {
  const h = harness();
  const html = await showStructure(h);
  assert.match(html, new RegExp(`eqv2StructureAdd\\('${LEGACY_ID}'\\)`));
  assert.match(html, /افزودن زیرسیستم تجهیز/);
  await h.context.eqv2StructureAdd(LEGACY_ID);
  const drawer = h.document.drawerRoot;
  assert.match(drawer.innerHTML, /B1BT9955/);
  assert.doesNotMatch(drawer.innerHTML, /تجهیز انتخاب‌شده:.*B1BT<\/b>/);
  h.context.EQV2.structure.rootId = 'stale-root-id';
  drawer.input('name', 'زیرسیستم ثبت‌شده');
  drawer.click('save');
  await settleUntil(() => h.calls.create.length === 1);
  assert.equal(h.calls.create[0].parentId, LEGACY_ID);
  assert.equal(h.calls.create[0].rootEquipmentId, ROOT_ID);
});

test('expand all lazily loads each registered level, shows loading, and preserves expansion state', async () => {
  const full = structureTree({ descendants: true });
  const initial = structureTree({ descendants: false });
  initial.nodes[0].hasChildren = true; initial.nodes[0].childCount = 1;
  const depthTwo = copy(full);
  depthTwo.nodes[0].children = [depthTwo.nodes[0].children[0]];
  depthTwo.nodes[0].children[0].children = [];
  depthTwo.nodes[0].children[0].hasChildren = true; depthTwo.nodes[0].children[0].childCount = 1;
  const depthThree = copy(full);
  depthThree.nodes[0].children[0].children = [depthThree.nodes[0].children[0].children[0]];
  depthThree.nodes[0].children[0].children[0].children = [];
  depthThree.nodes[0].children[0].children[0].hasChildren = true; depthThree.nodes[0].children[0].children[0].childCount = 1;
  const h = harness({ initialTree: initial, shallowTree: initial });
  await showStructure(h);
  let release;
  h.behavior.structure = (_id, options) => options.depth === 2
    ? new Promise(resolve => { release = resolve; })
    : Promise.resolve({ data: options.depth === 3 ? depthThree : full });
  const pending = h.context.eqv2StructureExpandAll(true);
  await settle();
  assert.match(h.detailBody.innerHTML, /در حال بارگذاری سطوح ساختار/);
  release({ data: depthTwo });
  await pending;
  assert.deepEqual(h.calls.structure.map(call => call.options.depth), [2, 3, 4]);
  assert.equal(h.context.EQV2.structureExpanded[LEGACY_ID], true);
  assert.equal(h.context.EQV2.structureExpanded[SUBSYSTEM_ID], true);
  assert.equal(h.context.EQV2.structureExpanded[MAIN_ID], true);
});

test('opening one unloaded section fetches only through that registered level', async () => {
  const initial = structureTree({ descendants: false });
  initial.nodes[0].hasChildren = true; initial.nodes[0].childCount = 1;
  const full = structureTree({ descendants: true });
  const h = harness({ initialTree: initial });
  await showStructure(h);
  h.behavior.structure = async (_id, options) => { assert.equal(options.depth, 2); return { data: full }; };
  await h.context.eqv2StructureToggle(LEGACY_ID);
  assert.equal(h.calls.structure[0].options.depth, 2);
  assert.equal(h.context.EQV2.structureExpanded[LEGACY_ID], true);
  assert.equal(h.context.EQV2.structure.nodes[0].children[0].id, SUBSYSTEM_ID);
});

test('expand all with no descendants gives a clear message and does not silently do nothing', async () => {
  const leafOnly = structureTree({ descendants: false });
  const h = harness({ initialTree: leafOnly });
  await showStructure(h);
  await h.context.eqv2StructureExpandAll(true);
  assert.match(h.detailBody.innerHTML, /ساختار تجهیز بخش پایین‌تری ندارد/);
  assert.match(h.detailBody.innerHTML, /eqv2StructureExpandAll\(true\)" disabled/);
  assert.ok(h.context.toasts.some(message => message.includes('بخش پایین‌تری ندارد')));
});

test('expand all reports a localized error when lazy loading fails', async () => {
  const initial = structureTree({ descendants: false });
  initial.nodes[0].hasChildren = true; initial.nodes[0].childCount = 1;
  const h = harness({ initialTree: initial });
  await showStructure(h);
  h.behavior.structure = async () => { throw Object.assign(new Error('SERVER_REQUIRED'), { payload: { error: 'SERVER_REQUIRED' } }); };
  await h.context.eqv2StructureExpandAll(true);
  assert.match(h.detailBody.innerHTML, /بارگذاری سطوح ساختار تجهیز انجام نشد/);
  assert.ok(h.context.toasts.some(message => message.includes('اتصال به سرور برقرار نیست')));
});

test('collapse all closes every deeper level while preserving selected row and scroll', async () => {
  const h = harness();
  await showStructure(h);
  Object.assign(h.context.EQV2, {
    structureSelected: MAIN_ID, structurePanel: [LEGACY_ID, SUBSYSTEM_ID], structureFocus: SUBSYSTEM_ID,
    structureExpanded: { [LEGACY_ID]: true, [SUBSYSTEM_ID]: true, [MAIN_ID]: true }
  });
  h.scrollWrap.scrollTop = 82; h.scrollWrap.scrollLeft = 23; h.context.scrollY = 511;
  await h.context.eqv2StructureExpandAll(false);
  assert.equal(h.context.EQV2.structureExpanded[LEGACY_ID], false);
  assert.equal(h.context.EQV2.structureExpanded[SUBSYSTEM_ID], false);
  assert.equal(h.context.EQV2.structureExpanded[MAIN_ID], false);
  assert.equal(h.context.EQV2.structurePanel.length, 0);
  assert.equal(h.context.EQV2.structureFocus, null);
  assert.equal(h.context.EQV2.structureSelected, MAIN_ID);
  assert.match(h.detailBody.innerHTML, /eqv2StructureExpandAll\(false\)" disabled/);
  assert.equal(h.scrollWrap.scrollTop, 82);
  assert.equal(h.scrollWrap.scrollLeft, 23);
  assert.equal(h.context.scrollY, 511);
});

test('archive requires a non-empty reason before any request', async () => {
  const h = harness(); h.context.prompt = () => '  ';
  await h.context.eqv2StructureArchive(LEGACY_ID);
  assert.equal(h.calls.archive.length, 0);
  assert.ok(h.context.toasts.some(message => message.includes('دلیل بایگانی الزامی است')));
});

test('legacy and non-archivable rows show a Persian reason and never silently no-op', async () => {
  const tree = structureTree({ descendants: false });
  tree.capabilities.archive = false;
  tree.nodes[0].canArchive = false; tree.nodes[0].archiveReason = 'این بخش به دلیل وضعیت ثبت‌شده قابل بایگانی نیست.';
  const h = harness({ initialTree: tree });
  await showStructure(h);
  assert.match(h.detailBody.innerHTML, /این بخش به دلیل وضعیت ثبت‌شده قابل بایگانی نیست/);
  assert.match(h.detailBody.innerHTML, /مجوز بایگانی یا بازیابی بخش‌های ساختار تجهیز را ندارید/);
  await h.context.eqv2StructureArchive(LEGACY_ID);
  assert.ok(h.context.toasts.some(message => message.includes('مجوز بایگانی ساختار تجهیز را ندارید')));
  assert.equal(h.calls.archive.length, 0);
});

test('archive confirmation cancellation prevents any archive request', async () => {
  const h = harness({ initialTree: structureTree({ descendants: false }) });
  h.context.prompt = () => 'دلیل آزمون'; h.context.confirm = () => false;
  await h.context.eqv2StructureArchive(LEGACY_ID);
  assert.equal(h.calls.archive.length, 0);
});

test('archive confirmation and success use soft archive then remove the section from the active view', async () => {
  const h = harness({ initialTree: structureTree({ descendants: false }) }); let confirmations = 0;
  h.context.prompt = () => 'پایان بهره‌برداری';
  h.context.confirm = () => { confirmations += 1; return true; };
  await showStructure(h);
  await h.context.eqv2StructureArchive(LEGACY_ID);
  assert.equal(confirmations, 1);
  assert.deepEqual(h.calls.archive[0], { id: LEGACY_ID, reason: 'پایان بهره‌برداری', rowVersion: 6 });
  assert.doesNotMatch(h.detailBody.innerHTML, /B1BT9955/);
  assert.ok(h.context.toasts.some(message => message.includes('بایگانی نرم')));
});

test('archive failure shows a Persian reason and does not remove the section', async () => {
  const h = harness();
  h.context.prompt = () => 'دلیل'; h.context.confirm = () => true;
  h.behavior.archive = async () => { throw Object.assign(new Error('HAS_ACTIVE_CHILDREN'), { payload: { error: 'HAS_ACTIVE_CHILDREN' } }); };
  await showStructure(h);
  await h.context.eqv2StructureArchive(LEGACY_ID);
  assert.match(h.detailBody.innerHTML, /B1BT9955/);
  assert.ok(h.context.toasts.some(message => message.includes('بخش‌های فعال')));
});

test('archived filter exposes Restore and a successful restore returns the section', async () => {
  const h = harness({ initialTree: structureTree({ descendants: false, archived: true }) });
  await h.context.eqv2StructureArchivedToggle();
  assert.equal(h.calls.structure.at(-1).options.includeArchived, true);
  assert.equal(h.calls.structure.at(-1).options.depth, 1, 'switching the archive filter stays lazy at the loaded depth');
  assert.match(h.detailBody.innerHTML, /eqv2StructureRestore\('equipment-b1bt9955'\)/);
  h.context.prompt = () => 'بازگشت به سرویس'; h.context.confirm = () => true;
  await h.context.eqv2StructureRestore(LEGACY_ID);
  assert.deepEqual(h.calls.restore[0], { id: LEGACY_ID, payload: { reason: 'بازگشت به سرویس', rowVersion: 6 } });
  assert.match(h.detailBody.innerHTML, /B1BT9955/);
  await h.context.eqv2StructureArchivedToggle();
  assert.equal(h.calls.structure.at(-1).options.includeArchived, false);
});

test('active structure UI uses approved Persian terminology only', async () => {
  const h = harness();
  h.context.EQV2.structureFocus = MAIN_ID;
  const html = await showStructure(h);
  await h.context.eqv2StructureAdd(MAIN_ID);
  const combined = `${html}\n${h.document.drawerRoot.innerHTML}`;
  const visibleText = combined.replace(/<[^>]*>/g, ' ').replace(/&(?:[a-z]+|#\d+);/gi, ' ');
  assert.doesNotMatch(visibleText, /والد|فرزند|Parent|Child|Components|Master Data/i);
  assert.match(visibleText, /اطلاعات مرجع انبار/);
  assert.match(visibleText, /تجهیز انتخاب‌شده|زیرسیستم تجهیز انتخاب‌شده|قطعه اصلی زیرسیستم انتخاب‌شده/);
  assert.match(combined, /ساختار مجاز: تجهیز ← زیرسیستم تجهیز ← قطعه اصلی زیرسیستم ← زیرقطعه قطعه اصلی/);
  assert.match(html, /ساختار تجهیز/);
  assert.match(read('public/equipment-v2/equipment-v2.js'), /\['structure','ساختار تجهیز'\]/);
});

test('legacy diagnostics are deduplicated in the rendered structure UI', async () => {
  const warning = { code: 'LEGACY_SUB_EQUIPMENT', nodeId: LEGACY_ID, message: 'رکورد زیرتجهیز قدیمی حفظ شده و فقط برای سازگاری نمایش داده می‌شود.' };
  const h = harness({ initialTree: structureTree({ diagnostics: [warning, copy(warning), copy(warning)] }) });
  h.context.EQV2.structureFocus = LEGACY_ID;
  const html = await showStructure(h);
  assert.equal((html.match(/رکورد قدیمی تجهیز حفظ شده و برای سازگاری نمایش داده می‌شود\./g) || []).length, 1);
});

test('drawer overlay blocks page interaction and X, Close, Cancel, Escape restore scroll and focus', async () => {
  const h = harness();
  const open = async () => { await h.context.eqv2StructureAddRoot(); return h.document.drawerRoot; };
  let drawer = await open();
  assert.equal(h.document.body.style.overflow, 'hidden');
  assert.equal(h.document.documentElement.style.overflow, 'hidden');
  assert.match(drawer.innerHTML, /role="dialog" aria-modal="true"/);
  drawer.clickBackdrop(); await settle();
  assert.equal(drawer.removed, true, 'the full-screen overlay receives clicks instead of page content');
  assert.equal(h.document.body.style.overflow, 'auto');
  assert.equal(h.document.documentElement.style.overflow, 'scroll');
  assert.equal(h.context.scrollY, 326);

  drawer = await open(); drawer.click('close', 0); await settle();
  assert.equal(drawer.removed, true, 'the X closes the drawer');
  assert.equal(h.document.body.style.overflow, 'auto');
  assert.equal(h.context.scrollY, 326);

  drawer = await open(); drawer.click('close', 1); await settle();
  assert.equal(drawer.removed, true, 'the footer Close control closes the drawer');

  drawer = await open(); drawer.input('name', 'تغییرنشده'); h.context.confirm = () => false;
  drawer.click('cancel'); await settle();
  assert.equal(drawer.removed, false, 'declining discard leaves the drawer and its values open');
  h.context.confirm = () => true; drawer.click('cancel'); await settle();
  assert.equal(drawer.removed, true);

  drawer = await open();
  const keydown = [...(h.listeners.get('keydown') || [])];
  assert.equal(keydown.length, 1);
  keydown[0]({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); await settle();
  assert.equal(drawer.removed, true);
  assert.equal(h.document.body.style.overflow, 'auto');
  assert.equal(h.context.scrollY, 326);
  assert.equal(h.previousFocus.focused, true);
});
