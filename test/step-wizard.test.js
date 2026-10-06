'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const engine = require('../public/platform-v2/step-wizard');
global.BFGStepWizard = engine;
const wizard = require('../public/platform-v2/maintenance-wizards');
const maintenance = require('../server/maintenance-service');

function runtime(type = 'request', overrides = {}) {
  return {
    type,
    filters: { factories: [], categories: [] },
    equipmentRows: [], equipmentDetail: null,
    requests: [], requestMap: new Map(), users: [], items: [], technicians: [],
    technicianMessage: 'داده کافی برای پیشنهاد تکنسین وجود ندارد',
    ai: { loading: false, message: '', recommendations: [], runId: null },
    quantityStep: null, quantityKeys: new Map(),
    ...overrides
  };
}

test('Jalali date helpers round-trip dates and reject invalid calendar days', () => {
  assert.deepEqual(engine.parseJalaliDate('۱۴۰۵/۰۷/۱۴'), { year: 2026, month: 10, day: 6 });
  assert.equal(engine.jalaliDateToISO('۱۴۰۵/۰۷/۱۴', '09:35'), '2026-10-06T09:35:00.000Z');
  assert.equal(engine.jalaliDateToISO('۱۴۰۵/۰۷/۳۱', '09:35'), null);
  assert.deepEqual(engine.isoToJalaliInput('2026-10-06'), { date: '۱۴۰۵/۰۷/۱۴', time: '' });
  assert.deepEqual(engine.isoToJalaliInput('not-a-date'), { date: '', time: '' });
});

test('wizard review, edit, progress and accessible controls are part of the shared engine', () => {
  const source = read('public/platform-v2/step-wizard.js');
  assert.match(source, /role="progressbar"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /data-sw-action="edit"/);
  assert.match(source, /reviewConfirmed/);
  assert.match(source, /validateAll/);
  assert.equal(typeof engine.create, 'function');
});

test('request and work-order definitions cover their required domain fields and real choice lists', () => {
  const reqSteps = wizard.requestSteps(runtime('request'));
  const reqIds = new Set(reqSteps.map(step => step.id));
  for (const id of ['actionType', 'serviceType', 'factoryId', 'categoryId', 'equipmentId', 'subsystemId', 'failureType', 'failureTiming', 'urgency', 'requestDetails', 'requestReview']) {
    assert.equal(reqIds.has(id), true, `missing request wizard step: ${id}`);
  }
  const requestDetails = reqSteps.find(step => step.id === 'requestDetails');
  assert.equal(requestDetails.fields.some(field => field.id === 'attachments' && field.persist === false), true);
  assert.equal(requestDetails.fields.some(field => field.id === 'needBy' && field.kind === 'jalali-date'), true);
  assert.equal(reqSteps.find(step => step.id === 'failureTiming').fields.some(field => field.id === 'stopOccurredAt'), true);

  const rt = runtime('work_order', { items: [{ id: 'part-a', code: 'P-A', name: 'آب‌بند', unit: 'عدد', available: 2 }] });
  const woSteps = wizard.workOrderSteps(rt);
  const woIds = new Set(woSteps.map(step => step.id));
  for (const id of ['requestId', 'workOrderType', 'equipmentId', 'failureType', 'workOrderDetails', 'assignee', 'requiredParts', 'partQuantities', 'ptwChoice', 'workOrderReview']) {
    assert.equal(woIds.has(id), true, `missing work-order wizard step: ${id}`);
  }
  assert.deepEqual(woSteps.find(step => step.id === 'requiredParts').options(), [
    { value: 'part-a', label: 'P-A — آب‌بند | موجود آزاد: 2 عدد' }
  ]);
});

test('changing branches clears hidden answers and stale equipment-based recommendations', async () => {
  const rt=runtime('work_order',{technicians:[{id:'old-tech'}],ai:{loading:false,message:'old',recommendations:[{recommendation:'stale'}],runId:'run-1',generation:2}});
  const steps=wizard.requestSteps(rt),action=steps.find(step=>step.id==='actionType');
  const answers={actionType:'emergency',serviceType:'mechanical',failureType:'thermal'};
  action.onChange({answers,value:'fab'});
  assert.equal(answers.serviceType,'');
  assert.equal(answers.failureType,'');
  assert.deepEqual(rt.ai.recommendations,[]);
  const factory=steps.find(step=>step.id==='factoryId');
  await factory.onChange({answers,value:wizard.NONE});
  assert.deepEqual(rt.technicians,[]);
  assert.equal(rt.technicianMessage,'داده کافی برای پیشنهاد تکنسین وجود ندارد');
});

test('resumed PTW decision is not silently converted to No; explicit saved answer remains', () => {
  assert.equal(wizard.restoreAnswers('work_order', { ptwRequired: false }).ptwChoice, '');
  assert.equal(wizard.restoreAnswers('work_order', { ptwRequired: true, ptwChoice: 'yes' }).ptwChoice, 'yes');
  assert.equal(wizard.restoreAnswers('work_order', { ptwRequired: false, ptwChoice: 'no' }).ptwChoice, 'no');
});

test('part quantity adapters keep quantities attached to their real item after selection changes', () => {
  const rt = runtime('work_order', {
    items: [
      { id: 'part-a', code: 'A', name: 'قطعه A', unit: 'عدد', available: 9 },
      { id: 'part-b', code: 'B', name: 'قطعه B', unit: 'عدد', available: 9 }
    ]
  });
  wizard.workOrderSteps(rt);
  const answers = { requiredParts: ['part-a'], partQuantities: { 'part-a': 4, 'part-b': 2 }, partQty_0: 4 };
  wizard.configureQuantities(rt, answers);
  answers.requiredParts = ['part-b'];
  wizard.configureQuantities(rt, answers);
  assert.equal(answers.partQty_0, 2);
  assert.equal(answers.partQuantities['part-b'], 2);
});

test('wizard mappings normalize Other, date, optional asset and no-assignee sentinels without local persistence', () => {
  const request = wizard.mapRequestAnswers({
    actionType: 'service', serviceType: engine.OTHER, serviceTypeOther: 'ترازکاری',
    failureType: engine.OTHER, failureTypeOther: 'لرزش', factoryId: 'factory-1', categoryId: '__all__',
    equipmentId: 'equipment-1', subsystemId: '__none__', description: 'بازرسی و رفع نیاز', unit: 'تولید',
    urgency: 'high', stopProduction: 'no', failureOccurredAt: { date: '۱۴۰۵/۰۷/۱۴', time: '09:35' },
    needBy: { date: '۱۴۰۵/۰۷/۱۵' }
  });
  assert.equal(request.type, 'service');
  assert.equal(request.assetId, 'equipment-1');
  assert.equal(request.form.serviceType, 'ترازکاری');
  assert.equal(request.form.failureType, 'لرزش');
  assert.equal(request.form.categoryId, null);
  assert.equal(request.form.failureOccurredAt, '2026-10-06T09:35:00.000Z');
  assert.equal(request.form.needBy, '2026-10-07T00:00:00.000Z');

  const order = wizard.mapWorkOrderAnswers({
    requestId: '__none__', workOrderType: 'CM', subsystemId: '__none__', equipmentId: 'equipment-1',
    assignee: '__none__', priority: 'normal', workDescription: 'بازرسی و تعمیر',
    failureType: engine.OTHER, failureTypeOther: 'لرزش', probableCause: 'ناهم‌محوری',
    confirmedRootCause: '', recommendedAction: 'بازبینی کوپلینگ', performedAction: '',
    requiredParts: ['part-1'], partQuantities: { 'part-1': 2 }, ptwRequired: true
  });
  assert.equal(order.assetId, 'equipment-1');
  assert.equal(order.assignee, null);
  assert.equal(order.failureType, 'لرزش');
  assert.equal(order.ptwRequired, true);
  assert.deepEqual(order.requiredParts, [{ itemId: 'part-1', qty: 2 }]);

  for (const file of ['public/platform-v2/step-wizard.js', 'public/platform-v2/maintenance-wizards.js']) {
    assert.doesNotMatch(read(file), /localStorage\.(?:getItem|setItem|removeItem)/);
  }
});

test('request attachments are fully preflighted before final draft submission', async () => {
  const mkFile = (name, bytes) => ({ name, size: bytes.length, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } });
  const pdf = Buffer.from('%PDF-1.7\\nvalid');
  await assert.doesNotReject(() => wizard.preflightFiles([mkFile('condition-report.pdf', pdf)]));
  await assert.rejects(() => wizard.preflightFiles([mkFile('payload.exe', Buffer.from('MZ'))]), error => error.code === 'DANGEROUS_FILE_REJECTED');
  await assert.rejects(() => wizard.preflightFiles([mkFile('photo.png', Buffer.from('not a PNG'))]), error => error.code === 'FILE_TYPE_REJECTED');
  const source = read('public/platform-v2/maintenance-wizards.js');
  const submit = source.slice(source.indexOf('onSubmit:async payload=>'));
  assert.ok(submit.indexOf('await preflightFiles') < submit.indexOf('await saver.flush()'));
  assert.ok(submit.indexOf('await saver.flush()') < submit.indexOf('/submit'));
  assert.ok(submit.indexOf('/submit') < submit.indexOf('await uploadFiles'));
});

test('wizard routes cannot access or mutate a different draft type under weaker permissions', async () => {
  const row={id:'draft-wo',wizard_type:'work_order',draft:{},step_id:'review',status:'draft',created_by:'owner-1',row_version:1};
  const run=async sql=>{
    if(['BEGIN','COMMIT','ROLLBACK'].includes(String(sql)))return{rows:[]};
    if(String(sql).includes('SELECT * FROM maintenance_wizard_drafts'))return{rows:[row]};
    throw new Error('unexpected draft SQL: '+sql);
  };
  const pool={query:run,async connect(){return{query:run,release(){}};}};
  const owner={id:'owner-1'};
  const mismatch=error=>error.code==='WIZARD_DRAFT_NOT_FOUND';
  await assert.rejects(()=>maintenance.getWizardDraft(pool,owner,'draft-wo','request'),mismatch);
  await assert.rejects(()=>maintenance.updateWizardDraft(pool,owner,'draft-wo',{rowVersion:1,draft:{},stepId:'x'},'request'),mismatch);
  await assert.rejects(()=>maintenance.cancelWizardDraft(pool,owner,'draft-wo',{rowVersion:1},'request'),mismatch);
  await assert.rejects(()=>maintenance.submitWizardDraft(pool,owner,'draft-wo',{rowVersion:1,confirmed:true},'request'),mismatch);
  const routes = read('server/maintenance-routes.js');
  assert.match(routes, /getWizardDraft\(pool, req\.user, req\.params\.id, 'request'\)/);
  assert.match(routes, /getWizardDraft\(pool, req\.user, req\.params\.id, 'work_order'\)/);
  assert.match(routes, /updateWizardDraft\(pool, req\.user, req\.params\.id, req\.body \|\| \{\}, 'request'\)/);
  assert.match(routes, /cancelWizardDraft\(pool, req\.user, req\.params\.id, req\.body \|\| \{\}, 'work_order'\)/);
  assert.match(routes, /submitWizardDraft\(pool, req\.user, req\.params\.id, req\.body \|\| \{\}, 'request'\)/);
  assert.match(routes, /submitWizardDraft\(pool, req\.user, req\.params\.id, req\.body \|\| \{\}, 'work_order'\)/);
});

test('backend draft mappers validate required fields and preserve diagnostic/action separation', () => {
  const request = maintenance.requestPayloadFromDraft({ answers: {
    actionType: 'service', serviceType: '__other__', serviceTypeOther: 'تراشکاری',
    factoryId: '__none__', categoryId: '__all__', equipmentId: 'equipment-1', subsystemId: '__none__',
    description: 'ساخت و تعمیر قطعه', unit: 'کارگاه', urgency: 'critical', stopProduction: 'yes',
    failureOccurredAt: '2026-10-06T09:35:00.000Z', stopDurationMinutes: '45'
  } }, { unit: 'نت' });
  assert.equal(request.type, 'service');
  assert.equal(request.assetId, 'equipment-1');
  assert.equal(request.form.serviceType, 'تراشکاری');
  assert.equal(request.form.factoryId, null);
  assert.equal(request.impact, true);
  assert.equal(request.form.stopDurationMinutes, 45);
  assert.throws(() => maintenance.requestPayloadFromDraft({ answers: { actionType: 'service' } }, { unit: '' }), error => error.code === 'WIZARD_SERVICE_TYPE_REQUIRED');

  const order = maintenance.workOrderPayloadFromDraft({ answers: {
    requestId: '__none__', workOrderType: 'CM', equipmentId: 'equipment-1', subsystemId: '__none__',
    assignee: '__none__', priority: 'high', workDescription: 'بازکردن پمپ و بازبینی',
    failureType: '__other__', failureTypeOther: 'لرزش', probableCause: 'ناهم‌محوری',
    confirmedRootCause: '', recommendedAction: 'هم‌محوری لیزری', performedAction: '',
    requiredParts: ['seal-1'], partQuantities: { 'seal-1': 2 }, ptwChoice: 'yes'
  } });
  assert.equal(order.assetId, 'equipment-1');
  assert.equal(order.assignee, null);
  assert.equal(order.failureType, 'لرزش');
  assert.equal(order.ptwRequired, true);
  assert.deepEqual(order.requiredParts, [{ itemId: 'seal-1', qty: 2 }]);
  assert.throws(() => maintenance.workOrderPayloadFromDraft({ answers: { workDescription: 'x' } }), error => error.code === 'WIZARD_WORK_ORDER_TYPE_REQUIRED');
});

test('Selene cards require confidence and non-web evidence and never select on their own', () => {
  const good = { data: { recommendations: [{ recommendation: 'بازبینی سوابق خرابی', reason: 'دو سابقه مشابه', confidence: 0.8, evidence: [{ sourceType: 'work_order', sourceId: 'wo-1', excerpt: 'نشتی پمپ' }] }] } };
  assert.equal(wizard.validAi(good).length, 1);
  assert.equal(wizard.validAi({ data: { recommendations: [{ recommendation: 'پیشنهاد بدون منبع', reason: 'حدس', confidence: 0.8, evidence: [] }] } }).length, 0);
  assert.equal(wizard.validAi({ data: { recommendations: [{ recommendation: 'جستجوی وب', reason: 'وب', confidence: 0.8, evidence: [{ sourceType: 'web', sourceId: 'https://example.test', excerpt: 'متن وب' }] }] } }).length, 0);
  const source = read('public/platform-v2/maintenance-wizards.js');
  assert.match(source, /data-sw-action="custom" data-sw-key="use-ai-/);
  assert.match(source, /افزودن به پیش‌نویس برای بازبینی/);
  assert.doesNotMatch(source, /answers\.\w+\s*=\s*item\.recommendation/);
});

test('technician suggestions fail closed without qualifications, shift, location or trusted load inputs', async () => {
  const asset = { id: 'equipment-1', code: 'P-1', name: 'پمپ', cls: 'mechanical', type: 'eq', ext: {}, factory_asset_id: 'factory-1' };
  const poolFor = ({ users, scopes = [{ '?column?': 1 }] }) => ({ query: async sql => {
    if (sql.includes('SELECT a.id,a.code,a.name,a.cls')) return { rows: [asset] };
    if (sql.includes('SELECT 1 FROM user_scopes')) return { rows: scopes };
    if (sql.includes('SELECT u.id,u.name,u.hr')) return { rows: users };
    throw new Error('unexpected technician SQL: ' + sql);
  } });
  const admin = { id: 'admin-1', role: 'admin' };
  const incomplete = await maintenance.technicianSuggestions(poolFor({ users: [{ id: 'tech-1', name: 'تکنسین', hr: { specialty: 'mechanical' }, active_load: 0, scopes: [{ scope_type: 'equipment', scope_id: 'equipment-1' }] }] }), admin, 'equipment-1', 'CM');
  assert.deepEqual(incomplete.data, []);
  assert.equal(incomplete.message, 'داده کافی برای پیشنهاد تکنسین وجود ندارد');

  const complete = await maintenance.technicianSuggestions(poolFor({ users: [{
    id: 'tech-2', name: 'تکنسین واجدشرایط', hr: { specialty: 'mechanical', authorizations: ['CM'], onDuty: true },
    active_load: 2, scopes: [{ scope_type: 'equipment', scope_id: 'equipment-1' }]
  }] }), admin, 'equipment-1', 'CM');
  assert.equal(complete.data.length, 1);
  assert.equal(complete.data[0].activeWorkOrders, 2);

  await assert.rejects(
    () => maintenance.technicianSuggestions(poolFor({ users: [], scopes: [] }), { id: 'mgr-1', role: 'mgr' }, 'equipment-1', 'CM'),
    error => error.code === 'EQUIPMENT_SCOPE_DENIED'
  );
});

test('work execution remains blocked until a real issued permit is linked', async () => {
  const order = { id: 'wo-ptw', row_version: 1, status: 'assigned', ptw: true, ptw_id: null, asset_id: 'equipment-1', times: {}, report: {}, parts: [] };
  const client = { async query(sql) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(String(sql))) return { rows: [] };
    if (String(sql).includes('SELECT * FROM work_orders')) return { rows: [{ ...order }] };
    if (String(sql).includes('SELECT * FROM permits')) return { rows: [] };
    throw new Error('unexpected permit-flow SQL: ' + sql);
  }, release() {} };
  const pool = { async connect() { return client; } };
  await assert.rejects(
    () => maintenance.transitionWorkOrder(pool, { id: 'mgr-1', name: 'مدیر', role: 'mgr' }, order.id, { rowVersion: 1, status: 'doing' }),
    error => error.code === 'WORK_PERMIT_REQUIRED'
  );
});

test('wizard draft schema is additive and does not rename controlled request API or paper form', () => {
  const migration = read('migrations/013_guided_work_wizards.sql');
  const schema = read('schema.sql');
  const routes = read('server/maintenance-routes.js');
  const page = read('public/index.html');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS maintenance_wizard_drafts/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS request_files/);
  assert.doesNotMatch(migration, /ALTER TABLE\s+requests|DROP TABLE\s+requests/i);
  assert.match(schema, /maintenance_wizard_drafts/);
  assert.match(routes, /router\.get\('\/requests'/);
  assert.match(routes, /router\.post\('\/requests'/);
  assert.match(routes, /authorize\('request\.create'\)/);
  assert.match(page, /id:'requests'/);
  assert.match(page, /درخواست کار \/ ساخت و خدمات/);
  assert.match(page, /BFG-FR-27-V2/);
  assert.match(page, /فرم درخواست تعمیرات \/ ساخت و خدمات/);
});
