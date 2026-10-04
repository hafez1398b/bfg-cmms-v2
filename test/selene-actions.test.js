'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { migrateMatrix, migratePermissionRows } = require('../server/permission-key');
const actions = require('../server/selene-actions');
const { HISTORY_LABEL, CONFIRMATION_TTL_MS } = actions;

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const user = { id: 'u-1', name: 'حافظ', role: 'mgr' };
const source = { kind: 'import-session', ref: 'session-1', verified: true };
const evidence = [{ field: 'name', value: 'پمپ', origin: 'source' }];

function service(options = {}) {
  const calls = [];
  const now = options.now || (() => new Date('2026-10-04T08:00:00.000Z'));
  const authorize = options.authorize || (() => true);
  const commands = {
    async apply(client, actor, draft) {
      if (options.failCommit) throw Object.assign(new Error('COMMIT_FAILED'), { status: 500, code: 'COMMIT_FAILED' });
      calls.push({ clientKind: client.kind, actor: actor.id, action: draft.actionType, proposed: draft.proposed });
      return { id: 'asset-1', applied: true };
    }
  };
  const api = actions.createSeleneActions({
    repository: actions.memoryRepository(),
    commands,
    authorize,
    now,
    ttlMs: options.ttlMs
  });
  return { api, calls, now };
}

function createBody(extra = {}) {
  return {
    actionType: 'equipment.create',
    proposed: { name: 'پمپ', code: 'P-1', nodeKind: 'equipment' },
    source,
    evidence,
    confidence: 0.8,
    ...extra
  };
}

test('stored tree permissions move to equipment and no active tree grant remains', () => {
  const matrix = migrateMatrix({
    mgr: { tree: { view: true, edit: false }, equipment: { edit: true } },
    tech: { tree: { view: true, print: false } }
  });
  assert.equal(matrix.changed, true);
  assert.equal(matrix.matrix.mgr.tree, undefined);
  assert.equal(matrix.matrix.mgr.equipment.view, true);
  assert.equal(matrix.matrix.mgr.equipment.edit, true);
  assert.equal(matrix.matrix.tech.equipment.view, true);
  assert.equal(matrix.matrix.tech.equipment.print, false);
  const rows = migratePermissionRows([
    { role: 'mgr', permission: 'tree.view', granted: true },
    { role: 'mgr', permission: 'equipment.edit', granted: false },
    { role: 'tech', permission: 'tree', granted: true }
  ]);
  assert.equal(rows.some(row => row.permission === 'tree' || String(row.permission).startsWith('tree.')), false);
  assert.equal(rows.find(row => row.role === 'mgr' && row.permission === 'equipment.view').granted, true);
  assert.equal(rows.find(row => row.role === 'mgr' && row.permission === 'equipment.edit').granted, false);
  assert.equal(rows.find(row => row.role === 'tech' && row.permission === 'equipment').granted, true);
  const sql = read('migrations/011_equipment_permission_key.sql');
  assert.match(sql, /INSERT INTO role_permissions/);
  assert.ok(sql.indexOf('INSERT INTO role_permissions') < sql.indexOf('DELETE FROM role_permissions'));
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE)\b/i);
});

test('tree is not an active module, menu, route or permission', () => {
  const files = [
    'public/index.html',
    'public/equipment-v2/equipment-v2.js',
    'public/equipment-v2/selene-chat.js',
    'public/platform-v2/module-registry.js',
    'public/platform-v2/backend-client.js',
    'public/platform-v2/record-actions.js',
    'public/data/besepar1-data.js',
    'public/data/equipment-demo-cleanup.js',
    'server/module-catalog.js'
  ].map(read).join('\n');
  for (const pattern of ["go('tree')", "can('tree'", "need('tree'", "page==='tree'", "id:'tree'", "menuIds:['tree']", "CUR==='tree'", "CUR === 'tree'"]) {
    assert.equal(files.includes(pattern), false, pattern);
  }
  assert.match(read('server/module-catalog.js'), /menuIds: \['equipment'\]/);
  assert.match(read('public/index.html'), /id:'equipment',ic:'⚙️',t:'فهرست جامع تجهیزات'/);
});

test('creating a draft stores the controlled fields and does not execute', async () => {
  const { api, calls } = service();
  const draft = await api.createDraft(user, createBody());
  assert.equal(draft.actionType, 'equipment.create');
  assert.equal(draft.destination, 'equipment');
  assert.equal(draft.status, 'pending');
  assert.equal(draft.proposed.code, 'P-1');
  assert.equal(draft.source.ref, 'session-1');
  assert.equal(draft.evidence[0].field, 'name');
  assert.equal(draft.confidence, 0.8);
  assert.deepEqual(draft.missingFields, []);
  assert.deepEqual(draft.conflictingFields, []);
  assert.equal(draft.rowVersion, 1);
  assert.equal(calls.length, 0);
  const viewed = await api.getDraft(user, draft.id);
  assert.equal(viewed.id, draft.id);
  const evidence = await api.evidenceOf(user, draft.id);
  assert.equal(evidence.source.verified, true);
  assert.equal(evidence.evidence.length, 1);
  assert.equal(evidence.proposed, undefined);
});

test('insufficient data stays an incomplete draft and cannot be confirmed', async () => {
  const { api, calls } = service();
  const draft = await api.createDraft(user, createBody({ proposed: { name: 'پمپ' } }));
  assert.equal(draft.status, 'incomplete');
  assert.ok(draft.missingFields.includes('code'));
  assert.ok(draft.missingFields.includes('nodeKind'));
  await assert.rejects(() => api.confirmDraft(user, draft.id), error => error.code === 'DRAFT_INCOMPLETE');
  assert.equal(calls.length, 0);
});

test('conflicting fields block confirmation until a human edit resolves them', async () => {
  const { api } = service();
  const draft = await api.createDraft(user, {
    actionType: 'equipment.complete',
    targetId: 'asset-1',
    recordVersion: 3,
    proposed: { maker: 'نو' },
    current: { maker: 'قدیم' },
    source,
    evidence
  });
  assert.equal(draft.status, 'conflict');
  assert.deepEqual(draft.conflictingFields, ['maker']);
  await assert.rejects(() => api.confirmDraft(user, draft.id), error => error.code === 'DRAFT_CONFLICT');
  const edited = await api.editDraft(user, draft.id, { proposed: { maker: 'قدیم' }, current: { maker: 'قدیم' }, rowVersion: draft.rowVersion });
  assert.equal(edited.status, 'pending');
  assert.equal(edited.rowVersion, 2);
});

test('draft creation and confirmation recheck permission', async () => {
  const denied = service({ authorize: () => false });
  await assert.rejects(() => denied.api.createDraft(user, createBody()), error => error.code === 'PERMISSION_DENIED');
  const holder = service();
  const row = await holder.api.createDraft(user, createBody());
  const blocked = actions.createSeleneActions({
    repository: {
      async transaction(work) {
        return work({
          async lockDraft() { return { ...row, status: 'pending' }; },
          async insertConfirmation() { throw new Error('should not insert'); }
        });
      }
    },
    commands: { apply() { throw new Error('should not run'); } },
    authorize: () => false
  });
  await assert.rejects(() => blocked.confirmDraft(user, row.id), error => error.code === 'PERMISSION_DENIED');
});

test('confirmation is one-time, expires, and is bound to the user, draft and record version', async () => {
  let clock = new Date('2026-10-04T08:00:00.000Z');
  const { api, calls } = service({ now: () => clock });
  const draft = await api.createDraft(user, createBody());
  const confirmation = await api.confirmDraft(user, draft.id);
  assert.equal(confirmation.userId, user.id);
  assert.equal(confirmation.draftId, draft.id);
  assert.equal(confirmation.recordVersion, null);
  assert.equal(Date.parse(confirmation.expiresAt) - clock.getTime(), CONFIRMATION_TTL_MS);
  const requestId = 'req-1';
  const result = await api.executeDraft(user, draft.id, { confirmationId: confirmation.id, requestId });
  assert.equal(result.committed, true);
  assert.equal(calls.length, 1);
  await assert.rejects(() => api.executeDraft(user, draft.id, { confirmationId: confirmation.id, requestId: 'req-2' }), error => error.code === 'CONFIRMATION_USED' || error.code === 'DRAFT_CLOSED');
});

test('an expired confirmation cannot be used', async () => {
  let clock = new Date('2026-10-04T08:00:00.000Z');
  const { api, calls } = service({ now: () => clock });
  const draft = await api.createDraft(user, createBody());
  const confirmation = await api.confirmDraft(user, draft.id);
  clock = new Date(clock.getTime() + CONFIRMATION_TTL_MS + 1);
  await assert.rejects(() => api.executeDraft(user, draft.id, { confirmationId: confirmation.id, requestId: 'req-late' }), error => error.code === 'CONFIRMATION_EXPIRED');
  assert.equal(calls.length, 0);
});

test('a duplicate request id is rejected and a failed commit does not report success', async () => {
  const { api } = service();
  const draft = await api.createDraft(user, createBody());
  const confirmation = await api.confirmDraft(user, draft.id);
  await api.executeDraft(user, draft.id, { confirmationId: confirmation.id, requestId: 'same-request' });
  const other = await api.createDraft(user, createBody());
  const otherConfirmation = await api.confirmDraft(user, other.id);
  await assert.rejects(() => api.executeDraft(user, other.id, { confirmationId: otherConfirmation.id, requestId: 'same-request' }), error => error.code === 'DUPLICATE_REQUEST');
  const failing = service({ failCommit: true });
  const pending = await failing.api.createDraft(user, createBody());
  const token = await failing.api.confirmDraft(user, pending.id);
  await assert.rejects(() => failing.api.executeDraft(user, pending.id, { confirmationId: token.id, requestId: 'rollback' }), error => error.code === 'COMMIT_FAILED');
  assert.equal(failing.calls.length, 0);
});

test('reject closes a draft and does not execute it', async () => {
  const { api, calls } = service();
  const draft = await api.createDraft(user, createBody());
  const rejected = await api.rejectDraft(user, draft.id);
  assert.equal(rejected.status, 'rejected');
  await assert.rejects(() => api.confirmDraft(user, draft.id), error => error.code === 'DRAFT_CLOSED');
  assert.equal(calls.length, 0);
});

test('fake, sample or unverified history cannot be recorded', async () => {
  const { api, calls } = service();
  await assert.rejects(() => api.createDraft(user, {
    actionType: 'equipment.retrospective-history',
    targetId: 'asset-1',
    recordVersion: 2,
    proposed: { occurredAt: '2024-05-01', summary: 'تعمیر فرضی', failure: 'سوخت' },
    source,
    evidence
  }), error => error.code === 'FAKE_HISTORY');
  await assert.rejects(() => api.createDraft(user, {
    actionType: 'equipment.retrospective-history',
    targetId: 'asset-1',
    recordVersion: 2,
    proposed: { occurredAt: '2024-05-01', summary: 'نمونه' },
    source: { kind: 'template', ref: 'sample', verified: true },
    evidence
  }), error => error.code === 'SAMPLE_REJECTED');
  const incomplete = await api.createDraft(user, {
    actionType: 'equipment.retrospective-history',
    targetId: 'asset-1',
    recordVersion: 2,
    proposed: { summary: 'بدون تاریخ' },
    source: { kind: 'text', ref: 'note', verified: false },
    evidence: []
  });
  assert.equal(incomplete.status, 'incomplete');
  assert.ok(incomplete.missingFields.includes('occurredAt'));
  assert.ok(incomplete.missingFields.includes('verifiedSource'));
  await assert.rejects(() => api.confirmDraft(user, incomplete.id), error => error.code === 'DRAFT_INCOMPLETE');
  assert.equal(calls.length, 0);
  assert.equal(HISTORY_LABEL, 'سابقه گذشته‌نگر تأییدشده توسط کاربر');
});

test('execution records source, evidence and audit only through the destination command', async () => {
  const seen = [];
  const repository = actions.memoryRepository();
  const api = actions.createSeleneActions({
    repository,
    authorize: () => true,
    commands: {
      async apply(client, actor, draft) {
        seen.push({ draft, actor });
        assert.equal(client.kind, 'memory');
        assert.equal(draft.source.ref, 'session-1');
        assert.equal(draft.evidence[0].origin, 'source');
        return { audited: true, recordedAt: '2026-10-04T08:00:00.000Z', occurredAt: draft.proposed.occurredAt || null };
      }
    }
  });
  const draft = await api.createDraft(user, createBody());
  const confirmation = await api.confirmDraft(user, draft.id);
  const result = await api.executeDraft(user, draft.id, { confirmationId: confirmation.id, requestId: 'audit-1' });
  assert.equal(result.committed, true);
  assert.equal(result.data.audited, true);
  assert.equal(seen.length, 1);
  const sourceText = read('server/selene-actions.js');
  assert.doesNotMatch(sourceText, /INSERT INTO assets|UPDATE assets|INSERT INTO work_orders|INSERT INTO failures/i);
  assert.match(read('server/equipment-commands.js'), /INSERT INTO audit_x/);
  assert.match(read('server/equipment-commands.js'), /occurredAt/);
  assert.match(read('server/equipment-commands.js'), /now\(\)/);
  assert.match(read('migrations/012_selene_controlled_actions.sql'), /selene_action_drafts/);
  assert.match(read('migrations/012_selene_controlled_actions.sql'), /selene_action_confirmations/);
  assert.match(read('schema.sql'), /selene_action_drafts/);
  assert.doesNotMatch(read('public/equipment-v2/selene-chat.js'), /localStorage/);
  assert.match(read('public/equipment-v2/selene-chat.js'), /\/api\/equipment\/actions\/drafts/);
  assert.doesNotMatch(read('public/equipment-v2/selene-chat.js'), /\/api\/equipment',\s*\{\s*method:\s*'POST'/);
});
