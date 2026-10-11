'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { validateImportFile } = require('../server/import-file-policy');
const { extractImport } = require('../server/import-extract');
const intake = require('../server/equipment-intake');
const { createEquipmentRouter } = require('../server/equipment-routes');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

function memoryPool() {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push(sql);
      if (/ai_provider_policies/.test(sql)) {
        return { rows: [{ provider: values[0], enabled: true, allowed_purposes: ['equipment_intake', 'wizard_suggestion'], allow_sensitive_context: true }] };
      }
      if (/equipment_import_sessions/.test(sql) && /INSERT/.test(sql)) return { rows: [] };
      if (/equipment_import_sessions/.test(sql)) return { rows: [{ id: values[0] }] };
      if (/equipment_import_messages/.test(sql) || /audit_x/.test(sql)) return { rows: [] };
      const error = new Error('unexpected sql');
      error.code = 'UNEXPECTED_SQL';
      throw error;
    }
  };
}

function registry(handlers) {
  const calls = [];
  const make = name => ({
    name,
    capabilities() { return { image: !!handlers[name].image, text: true }; },
    async generate(input) {
      calls.push({ name, input });
      return handlers[name].generate(input);
    }
  });
  return {
    calls,
    providers: {
      deepseek: make('deepseek'),
      local: make('local'),
      gemini: make('gemini')
    },
    candidates({ media = [], preferred }) {
      return [preferred || 'deepseek', 'deepseek', 'local', 'gemini']
        .filter((name, index, all) => all.indexOf(name) === index)
        .map(name => this.providers[name])
        .filter(provider => handlers[provider.name].configured && (!media.some(item => item.kind === 'image') || provider.capabilities().image));
    }
  };
}

async function withApi(pool, role, aiRegistry, run) {
  const app = express();
  app.use(express.json());
  app.use('/api/equipment', createEquipmentRouter({
    pool,
    io: { emit() {} },
    aiRegistry,
    authenticateToken(req, _res, next) {
      req.user = { id: 'user-1', username: 'tester', name: 'Tester', role };
      next();
    }
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}/api/equipment`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('import policy accepts the five intake formats and rejects active or executable content', () => {
  const csv = validateImportFile({ name: 'pumps.csv', buffer: Buffer.from('code,name\nP-100,Pump\n', 'utf8') });
  assert.equal(csv.ext, 'csv');
  assert.equal(validateImportFile({ name: 'note.md', buffer: Buffer.from('# Pump\n', 'utf8') }).ext, 'md');
  assert.equal(validateImportFile({ name: 'plate.jpg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }).ext, 'jpg');
  assert.equal(validateImportFile({ name: 'list.xlsx', buffer: zip([{ name: 'xl/worksheets/sheet1.xml', data: '<worksheet/>' }]) }).ext, 'xlsx');
  assert.equal(validateImportFile({ name: 'manual.pdf', buffer: Buffer.from('%PDF-1.4\n') }).ext, 'pdf');
  assert.throws(() => validateImportFile({ name: 'note.md.exe', buffer: Buffer.from('MZ') }), error => error.code === 'DANGEROUS_FILE_REJECTED');
  assert.throws(() => validateImportFile({ name: 'page.html', buffer: Buffer.from('<html>') }), error => error.code === 'DANGEROUS_FILE_REJECTED');
  assert.throws(() => validateImportFile({ name: 'script.pdf', buffer: Buffer.from('%PDF-1.4 /JavaScript') }), error => error.code === 'DANGEROUS_FILE_REJECTED');
  assert.throws(() => validateImportFile({ name: 'sheet.xls', buffer: Buffer.from('not-xlsx') }), error => error.code === 'FILE_TYPE_REJECTED');
});

test('csv and xlsx extraction keep only columns that are present', () => {
  const csv = extractImport({ ext: 'csv', buffer: Buffer.from('کد,نام,سازنده\nP-100,پمپ خوراک,Sulzer\n,بدون کد,\n', 'utf8') });
  const draft = intake.draftFromTable(csv.rows);
  assert.equal(draft.source, 'column-match');
  assert.equal(draft.records[0].code, 'P-100');
  assert.equal(draft.records[0].name, 'پمپ خوراک');
  assert.equal(draft.records[0].maker, 'Sulzer');
  assert.equal(draft.records[1].code, undefined);
  assert.ok(draft.records[1].missing.includes('code'));
  const sheet = `<?xml version="1.0"?><worksheet><sheetData><row><c t="inlineStr"><is><t>code</t></is></c><c t="inlineStr"><is><t>name</t></is></c></row><row><c t="inlineStr"><is><t>EQ-9</t></is></c><c t="inlineStr"><is><t>Fan</t></is></c></row></sheetData></worksheet>`;
  const xlsx = extractImport({ ext: 'xlsx', buffer: zip([{ name: 'xl/worksheets/sheet1.xml', data: sheet }]) });
  assert.equal(intake.draftFromTable(xlsx.rows).records[0].code, 'EQ-9');
  const pdf = extractImport({ ext: 'pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 20 >>\nstream\n(Pump P-100) Tj\nendstream\nendobj\n') });
  assert.match(pdf.text, /Pump P-100/);
});

test('intake asks DeepSeek, never Gemini, and does not invent a missing code', async () => {
  const pool = memoryPool();
  const ai = registry({
    deepseek: { configured: true, image: false, generate: async () => ({ text: '{"reply":"یک تجهیز پیدا شد.","records":[{"name":"پمپ خوراک","maker":"Sulzer"}]}', model: 'deepseek-chat' }) },
    local: { configured: true, image: false, generate: async () => { throw new Error('local must not be first'); } },
    gemini: { configured: true, image: true, generate: async () => { throw new Error('gemini must not receive intake'); } }
  });
  const result = await intake.prepareIntake({
    pool, registry: ai, user: { id: 'user-1', name: 'Tester', role: 'planner' },
    caption: 'پمپ خوراک سازنده Sulzer، کد را ندارم', file: null, history: []
  });
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.draft.source, 'deepseek');
  assert.equal(result.draft.records[0].name, 'پمپ خوراک');
  assert.equal(result.draft.records[0].code, undefined);
  assert.equal(result.draft.records[0].placeable, false);
  assert.deepEqual(ai.calls.map(call => call.name), ['deepseek']);
  assert.match(pool.calls.at(-1), /audit_x/);
});

test('a JPEG is not pretended to be read when DeepSeek vision is off', async () => {
  const ai = registry({
    deepseek: { configured: true, image: false, generate: async () => { throw new Error('must not invent OCR'); } },
    local: { configured: true, image: false, generate: async () => { throw new Error('must not invent OCR'); } },
    gemini: { configured: true, image: true, generate: async () => { throw new Error('gemini must not receive the image'); } }
  });
  const file = validateImportFile({ name: 'nameplate.jpg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xd9]) });
  const result = await intake.prepareIntake({
    pool: memoryPool(), registry: ai, user: { id: 'user-1', role: 'tech', name: 'Tech' },
    caption: '', file, history: []
  });
  assert.equal(result.notice, 'VISION_UNAVAILABLE');
  assert.equal(result.provider, null);
  assert.equal(result.draft.records.length, 0);
  assert.equal(ai.calls.length, 0);
});

test('import routes are not captured by the equipment id route', async () => {
  const pool = memoryPool();
  const ai = registry({
    deepseek: { configured: true, image: false, generate: async () => ({ text: '{"reply":"آماده است.","records":[{"name":"فن","code":"F-1"}]}', model: 'deepseek-chat' }) },
    local: { configured: false, image: false, generate: async () => ({ text: '{}', model: 'local' }) },
    gemini: { configured: true, image: true, generate: async () => { throw new Error('gemini'); } }
  });
  await withApi(pool, 'planner', ai, async base => {
    const denied = await fetch(`${base}/import/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'فن F-1' }) });
    assert.notEqual(denied.status, 404);
    const response = await fetch(`${base}/import/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'فن F-1' }) });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.data.draft.records[0].code, 'F-1');
    const file = await fetch(`${base}/import/files?caption=${encodeURIComponent('فهرست')}`, {
      method: 'POST',
      headers: { 'content-type': 'text/csv', 'x-file-name': 'pumps.csv' },
      body: 'code,name\nP-2,Pump\n'
    });
    assert.equal(file.status, 201);
    assert.equal((await file.json()).data.attachment.name, 'pumps.csv');
  });
  await withApi(pool, 'nobody', ai, async base => {
    const response = await fetch(`${base}/import/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }) });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'EQUIPMENT_PERMISSION_DENIED');
  });
});

test('Selene uses the native workbench and keeps drafts off the browser store', () => {
  const ui = read('public/equipment-v2/equipment-v2.js');
  const chat = read('public/equipment-v2/selene-chat.js');
  const css = read('public/equipment-v2/selene-chat.css');
  const html = read('public/index.html');
  assert.match(ui, /\['technical','مشخصه فنی'\]/);
  assert.match(ui, /\['risk','ریسک و فرصت'\]/);
  assert.doesNotMatch(ui, /\['usage','کاربری'\]/);
  assert.match(ui, /eqv2OpenIntake/);
  assert.match(ui, /ورود هوشمند/);
  assert.match(html, /selene-chat\.js/);
  assert.match(html, /selene-chat\.css/);
  assert.match(chat, /\/api\/equipment\/import\/analyze/);
  assert.match(chat, /\/api\/equipment\/actions\/drafts/);
  assert.match(chat, /eqv2OpenWizard\(/);
  assert.match(chat, /قطعی — مطابق ستون فایل/);
  assert.match(chat, /پیشنهادی — نیازمند بازبینی/);
  assert.match(chat, /متعارض با مقدار ثبت‌شده/);
  assert.match(chat, /ناقص \/ ثبت‌نشده/);
  assert.match(chat, /لازم برای ثبت/);
  assert.match(css, /var\(--primary\)/);
  assert.doesNotMatch(css, /#4d6bfe|DeepSeek/i);
  assert.doesNotMatch(chat, /#4d6bfe|تحلیل با DeepSeek|پیام به سلن|selene-model/);
  assert.doesNotMatch(chat, /localStorage|sessionStorage|gemini/i);
  assert.doesNotMatch(css, /https?:\/\//);
  assert.match(read('migrations/010_equipment_intake.sql'), /equipment_import_sessions/);
  assert.match(read('schema.sql'), /equipment_import_messages/);
  assert.doesNotMatch(read('migrations/010_equipment_intake.sql'), /:\/\//);
});

test('intake knows the exact fields required to create or complete equipment', () => {
  const prompt = intake.buildPrompt({ caption: 'این متن را تحلیل کن', extracted: { kind: 'text', text: 'پمپ' }, equipment: null, history: [] });
  assert.match(prompt, /نام تجهیز/);
  assert.match(prompt, /کد تجهیز/);
  assert.match(prompt, /مشخصات فنی/);
  assert.match(intake.SYSTEM_PROMPT, /Never invent/);
  assert.match(intake.SYSTEM_PROMPT, /analysis chat/);
  const record = intake.normalizeRecord({ name: 'پمپ' }, 0);
  assert.equal(record.coverage.find(item => item.key === 'code').status, 'missing');
  assert.equal(record.coverage.find(item => item.key === 'name').status, 'found');
  assert.equal(record.coverage.find(item => item.key === 'nodeKind').status, 'default');
});
