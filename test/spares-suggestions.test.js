'use strict';

// Mission D4 — Selene critical-spares suggestions and the controlled approval path.
// Proves, without a live PostgreSQL, that:
//   * suggestSpares only writes selene_action_drafts (never asset_spare_parts);
//   * every draft carries evidence/provenance/confidence/provider/model/status;
//   * provider policy gates (disabled / purpose / cloud-context) are honored;
//   * ungrounded targets/items become missingFields, never invented records;
//   * a draft writes nothing until confirm+execute, and execute re-enters the Domain API
//     (equipment-commands.applyControlledAction -> equipment-spares.linkSparePart) with the
//     approve_ai permission, re-checking permission/scope/target-kind/real-item/row_version.

const test = require('node:test');
const assert = require('node:assert/strict');
const sparesSuggestions = require('../server/spares-suggestions');
const spares = require('../server/equipment-spares');
const actions = require('../server/selene-actions');
const commands = require('../server/equipment-commands');

const user = { id: 'u-mgr', name: 'مدیر', username: 'mgr', role: 'mgr' };
const security = { hasPermission: async () => true };

// A compact in-memory pool covering exactly the SQL contracts that suggestSpares and the
// linkSparePart executor issue. It records every write so tests can assert what was persisted.
function harnessPool(options = {}) {
  const assets = new Map(Object.entries({
    'factory-1': { id: 'factory-1', parent: null, code: 'B1', name: 'بسپار ۱', type: 'site', cls: 'کارخانه', ext: { nodeKind: 'factory' }, deleted_at: null, category_id: null, row_version: 1 },
    'eq-root': { id: 'eq-root', parent: 'factory-1', code: 'B1P01', name: 'پمپ واقعی', type: 'eq', cls: null, ext: {}, deleted_at: null, category_id: null, row_version: 4 },
    'eq-internal': { id: 'eq-internal', parent: 'eq-root', code: 'SUB-1', name: 'زیرسیستم', type: 'eq', cls: null, ext: { nodeKind: 'subsystem' }, deleted_at: null, category_id: null, row_version: 1 },
    'eq-main': { id: 'eq-main', parent: 'eq-internal', code: 'MC-1', name: 'یاتاقان اصلی', type: 'eq', cls: null, ext: { nodeKind: 'main-component', partNumber: 'P-100', brand: 'SKF' }, deleted_at: null, category_id: null, row_version: 1 }
  }));
  const items = new Map(Object.entries({
    'item-1': { id: 'item-1', code: 'SP-1', name: 'یاتاقان', unit: 'عدد', part_type: 'spare', min_stock: 2, ext: { partNumber: 'P-100', brand: 'SKF' }, deleted_at: null }
  }));
  const links = new Map();
  const drafts = new Map();
  const policies = options.policies || { deepseek: { provider: 'deepseek', enabled: true, allowed_purposes: ['equipment_intake'], allow_sensitive_context: true } };
  const state = { calls: [], audit: [], outbox: [], spareWrites: 0, transactions: [] };

  function dossierNodes(rootId) {
    const nodes = [];
    const walk = (id, depth, path) => {
      const asset = assets.get(id);
      if (!asset || asset.deleted_at || path.includes(id)) return;
      nodes.push({ id: asset.id, code: asset.code, name: asset.name, depth });
      if (depth >= 3) return;
      for (const child of assets.values()) if (child.parent === id && child.type === 'eq') walk(child.id, depth + 1, [...path, id]);
    };
    walk(rootId, 0, []);
    return nodes;
  }
  function factoryOf(assetId) {
    let current = assets.get(assetId); const seen = new Set();
    while (current && !seen.has(current.id)) { seen.add(current.id); if (current.ext && current.ext.nodeKind === 'factory') return current.id; current = assets.get(current.parent); }
    return null;
  }
  function spareRows(rootId, includeArchived, targetId, itemId) {
    const nodes = new Map(dossierNodes(rootId).map(node => [node.id, node]));
    const rows = [];
    for (const link of links.values()) {
      const node = nodes.get(link.asset_id);
      if (!node) continue;
      if (link.deleted_at && !includeArchived) continue;
      if (targetId !== undefined && link.asset_id !== targetId) continue;
      if (itemId !== undefined && link.item_id !== itemId) continue;
      const item = items.get(link.item_id); if (!item) continue;
      rows.push({ ...link, target_code: node.code, target_name: node.name, target_depth: node.depth, code: item.code, name: item.name, unit: item.unit, part_type: item.part_type, min_stock: item.min_stock, item_ext: item.ext, item_deleted_at: item.deleted_at, stock_on_hand: 0, stock_reserved: 0, stock_available: 0, last_purchase: null });
    }
    return rows;
  }

  async function query(sql, values = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.calls.push({ sql: text, values });
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) { state.transactions.push(text.split(' ')[0]); return { rows: [] }; }
    if (/^SELECT id,parent,code,name,type,cls,category_id,ext,row_version,deleted_at FROM assets WHERE id=\$1$/.test(text)) {
      const row = assets.get(values[0]); return { rows: row ? [row] : [] };
    }
    if (/WITH RECURSIVE ancestry AS/.test(text) && /SELECT COALESCE\(c\.factory_asset_id/.test(text)) return { rows: [{ factory_id: factoryOf(values[0]) }] };
    if (/SELECT 1 FROM user_scopes WHERE user_id=\$1/.test(text)) return { rows: [{ 1: 1 }] };
    if (/SELECT 1 FROM role_permissions/.test(text)) return { rows: [{ 1: 1 }] };
    if (/SELECT id FROM assets WHERE id=\$1 AND deleted_at IS NULL FOR NO KEY UPDATE/.test(text)) {
      const row = assets.get(values[0]); return { rows: row && !row.deleted_at ? [{ id: row.id }] : [] };
    }
    if (/SELECT id,code,name,unit,part_type,ext FROM items WHERE id=\$1 AND deleted_at IS NULL FOR KEY SHARE/.test(text)) {
      const item = items.get(values[0]); return { rows: item && !item.deleted_at ? [item] : [] };
    }
    if (/SELECT \* FROM asset_spare_parts WHERE asset_id=\$1 AND item_id=\$2 FOR UPDATE/.test(text)) {
      const link = links.get(`${values[0]}:${values[1]}`); return { rows: link ? [{ ...link }] : [] };
    }
    if (/SELECT id,code,name,depth FROM dossier_nodes WHERE depth IN \(0,2,3\)/.test(text)) {
      return { rows: dossierNodes(values[0]).filter(node => [0, 2, 3].includes(node.depth)) };
    }
    if (/WITH RECURSIVE structure_path AS/.test(text)) {
      const node = dossierNodes(values[0]).find(item => item.id === values[1]); return { rows: node ? [{ depth: node.depth }] : [] };
    }
    if (/SELECT rel\.asset_id,rel\.item_id,rel\.relation_type/.test(text)) {
      const single = values.length >= 4;
      return { rows: spareRows(values[0], values[1] === true, single ? values[2] : undefined, single ? values[3] : undefined) };
    }
    // buildSparesContext queries
    if (/SELECT id,code,name,ext FROM assets WHERE id=ANY\(\$1::text\[\]\) AND deleted_at IS NULL/.test(text)) {
      return { rows: values[0].map(id => assets.get(id)).filter(Boolean) };
    }
    if (/SELECT rel\.asset_id,rel\.item_id,rel\.relation_type,i\.code,i\.name FROM asset_spare_parts rel JOIN items i/.test(text)) {
      const rows = [];
      for (const link of links.values()) { if (link.deleted_at) continue; const item = items.get(link.item_id); if (!item || item.deleted_at) continue; rows.push({ asset_id: link.asset_id, item_id: link.item_id, relation_type: link.relation_type, code: item.code, name: item.name }); }
      return { rows };
    }
    if (/SELECT i\.id,i\.code,i\.name,i\.unit,i\.part_type,i\.ext FROM items i WHERE i\.deleted_at IS NULL/.test(text)) {
      return { rows: [...items.values()].filter(item => !item.deleted_at) };
    }
    if (/SELECT provider,enabled,allowed_purposes,allow_sensitive_context FROM ai_provider_policies WHERE provider=\$1/.test(text)) {
      const policy = policies[values[0]]; return { rows: policy ? [policy] : [] };
    }
    if (/INSERT INTO selene_action_drafts/.test(text)) {
      const row = { id: values[0], action_type: values[1], destination: values[2], proposed: JSON.parse(values[3]), source: JSON.parse(values[4]), evidence: JSON.parse(values[5]), confidence: values[6], missing_fields: JSON.parse(values[7]), conflicting_fields: JSON.parse(values[8]), status: values[9], record_version: values[10], target_id: values[11], created_by: values[12], created_at: values[13], updated_at: values[14], row_version: 1 };
      drafts.set(row.id, row); return { rows: [{ ...row }] };
    }
    if (/INSERT INTO asset_spare_parts/.test(text)) {
      state.spareWrites += 1;
      const row = { asset_id: values[0], item_id: values[1], relation_type: values[2], quantity_required: values[3], notes: values[4], created_by: values[5], updated_by: values[5], created_at: '2026-11-04T10:00:00Z', updated_at: '2026-11-04T10:00:00Z', row_version: 1, deleted_at: null, deleted_by: null, delete_reason: null };
      links.set(`${row.asset_id}:${row.item_id}`, row); return { rows: [{ ...row }] };
    }
    if (/INSERT INTO audit_x/.test(text)) { state.audit.push({ action: values[4], entity: values[5], after: values[8] }); return { rows: [] }; }
    if (/SELECT u\.id,u\.role,/.test(text) && /FROM users u WHERE u\.active IS TRUE/.test(text)) return { rows: [{ id: 'u-mgr', role: 'mgr', permissions: ['equipment.spares.view'], scopes: [{ scope_type: 'company', scope_id: 'co' }] }] };
    if (/INSERT INTO event_outbox/.test(text)) { state.outbox.push({ payload: JSON.parse(values[3]) }); return { rows: [] }; }
    const error = new Error(`unexpected sql: ${text}`); error.code = 'UNEXPECTED_SQL'; throw error;
  }
  return { state, assets, items, links, drafts, query, async connect() { return { query, release() {} }; } };
}

function registryReturning(text, model = 'deepseek-chat') {
  const provider = { name: 'deepseek', configured: () => true, generate: async () => ({ text, model }) };
  return { candidates: () => [provider] };
}

const groundedResponse = JSON.stringify({ suggestions: [{
  targetCode: 'MC-1', itemCode: 'SP-1', relationType: 'key-spare', quantityRequired: 2,
  explanation: 'یاتاقان اصلی طبق شماره فنی P-100 به قلم انبار SP-1 متصل شود.', confidence: 0.82,
  missingFields: [], evidence: [{ field: 'partNumber', value: 'P-100', origin: 'component-ext' }]
}] });

test('D4 suggest: only drafts are written — asset_spare_parts is never touched without approval', async () => {
  const pool = harnessPool();
  const result = await sparesSuggestions.suggestSpares({ pool, registry: registryReturning(groundedResponse), security, user, rootEquipmentId: 'eq-root' });
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.model, 'deepseek-chat');
  assert.equal(result.suggestions.length, 1);
  assert.equal(pool.state.spareWrites, 0, 'a suggestion must never write a spare link');
  assert.equal(pool.links.size, 0);
  assert.equal(pool.drafts.size, 1);
  assert.equal(pool.state.outbox.length, 0, 'no realtime link event before approval');
});

test('D4 suggest: every draft carries evidence/provenance/confidence/provider/model/status and the controlled actionType', async () => {
  const pool = harnessPool();
  const result = await sparesSuggestions.suggestSpares({ pool, registry: registryReturning(groundedResponse), security, user, rootEquipmentId: 'eq-root' });
  const draft = result.suggestions[0];
  assert.equal(draft.actionType, 'equipment.spares.link');
  assert.equal(draft.destination, 'equipment.spares');
  assert.equal(draft.status, 'pending');
  assert.equal(draft.proposed.rootEquipmentId, 'eq-root');
  assert.equal(draft.proposed.targetId, 'eq-main');
  assert.equal(draft.proposed.itemId, 'item-1');
  assert.equal(draft.proposed.relationType, 'key-spare');
  assert.equal(draft.confidence, 0.82);
  assert.ok(Array.isArray(draft.evidence) && draft.evidence.length >= 1);
  assert.equal(draft.evidence[0].field, 'partNumber');
  assert.ok(draft.source && draft.source.ref && draft.source.kind, 'provenance source must be present');
  assert.match(draft.source.ref, /spares-suggestion:/);
  assert.ok(result.provider && result.model, 'provider and model are reported');
  assert.ok(pool.state.audit.some(row => row.action === 'spares-suggest'), 'the suggestion run is audited');
});

test('D4 suggest: an ungrounded target/item is reported as missingFields, never invented', async () => {
  const pool = harnessPool();
  const raw = JSON.stringify({ suggestions: [{ targetCode: 'NO-SUCH', itemCode: 'NO-ITEM', relationType: 'key-spare', explanation: 'حدس', confidence: 0.9, evidence: [{ field: 'name', value: 'ساختگی', origin: 'guess' }] }] });
  const result = await sparesSuggestions.suggestSpares({ pool, registry: registryReturning(raw), security, user, rootEquipmentId: 'eq-root' });
  assert.equal(pool.state.spareWrites, 0);
  const draft = result.suggestions[0];
  assert.equal(draft.proposed.targetId, undefined);
  assert.equal(draft.proposed.itemId, undefined);
  assert.ok(draft.proposed.missingFields.includes('targetId'));
  assert.ok(draft.proposed.missingFields.includes('itemId'));
  assert.equal(draft.status, 'incomplete', 'an ungrounded suggestion cannot be pending/approvable');
});

test('D4 suggest: provider policy gates are honored (disabled / purpose / cloud-context)', async () => {
  const disabled = harnessPool({ policies: { deepseek: { provider: 'deepseek', enabled: false, allowed_purposes: ['equipment_intake'], allow_sensitive_context: true } } });
  let result = await sparesSuggestions.suggestSpares({ pool: disabled, registry: registryReturning(groundedResponse), security, user, rootEquipmentId: 'eq-root' });
  assert.equal(result.notice, 'AI_PROVIDER_DISABLED_BY_POLICY');
  assert.equal(result.suggestions.length, 0);
  assert.equal(disabled.drafts.size, 0);

  const purposeDenied = harnessPool({ policies: { deepseek: { provider: 'deepseek', enabled: true, allowed_purposes: ['chat'], allow_sensitive_context: true } } });
  result = await sparesSuggestions.suggestSpares({ pool: purposeDenied, registry: registryReturning(groundedResponse), security, user, rootEquipmentId: 'eq-root' });
  assert.equal(result.notice, 'AI_PURPOSE_DENIED_BY_POLICY');

  const cloudBlocked = harnessPool({ policies: { deepseek: { provider: 'deepseek', enabled: true, allowed_purposes: ['equipment_intake'], allow_sensitive_context: false } } });
  result = await sparesSuggestions.suggestSpares({ pool: cloudBlocked, registry: registryReturning(groundedResponse), security, user, rootEquipmentId: 'eq-root' });
  assert.equal(result.notice, 'CLOUD_CONTEXT_NOT_APPROVED');
  assert.equal(cloudBlocked.drafts.size, 0);
});

test('D4 suggest: no capable provider yields an honest notice and no drafts', async () => {
  const pool = harnessPool();
  const result = await sparesSuggestions.suggestSpares({ pool, registry: { candidates: () => [] }, security, user, rootEquipmentId: 'eq-root' });
  assert.equal(result.notice, 'NO_CAPABLE_PROVIDER');
  assert.equal(result.suggestions.length, 0);
  assert.equal(result.insufficient, true);
  assert.equal(pool.drafts.size, 0);
});

test('D4 normalize/parse: grounding and JSON robustness', () => {
  const context = { root: { id: 'eq-root' }, targets: [{ id: 'eq-main', code: 'MC-1' }], candidateItems: [{ id: 'item-1', code: 'SP-1' }] };
  const grounded = sparesSuggestions.normalizeSuggestion({ targetCode: 'mc-1', itemCode: 'sp-1', relationType: 'key-spare', confidence: 1.4 }, context);
  assert.equal(grounded.proposed.targetId, 'eq-main');
  assert.equal(grounded.proposed.itemId, 'item-1');
  assert.equal(grounded.confidence, 1, 'confidence is clamped to [0,1]');
  const ungrounded = sparesSuggestions.normalizeSuggestion({ targetCode: 'X', itemCode: 'Y' }, context);
  assert.ok(ungrounded.proposed.missingFields.includes('targetId'));
  assert.ok(ungrounded.proposed.missingFields.includes('itemId'));
  assert.deepEqual(sparesSuggestions.parseSuggestions('```json\n{"suggestions":[{"itemCode":"SP-1"}]}\n```'), [{ itemCode: 'SP-1' }]);
  assert.deepEqual(sparesSuggestions.parseSuggestions('not json'), []);
});

test('D4 assess: a spares.link draft requires root/target/item, a source and evidence', () => {
  const base = { actionType: 'equipment.spares.link', proposed: { rootEquipmentId: 'eq-root', targetId: 'eq-main', itemId: 'item-1', relationType: 'key-spare' }, source: { kind: 'document', ref: 'spares-suggestion:m', verified: false }, evidence: [{ field: 'partNumber', value: 'P-100', origin: 'ext' }], confidence: 0.8, targetId: 'eq-main' };
  const pending = actions.assessDraft(base);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.approvalPermission, 'equipment.spares.approve_ai');
  const noEvidence = actions.assessDraft({ ...base, evidence: [] });
  assert.equal(noEvidence.status, 'incomplete');
  assert.ok(noEvidence.missingFields.includes('evidence'));
  const noTarget = actions.assessDraft({ ...base, targetId: undefined, proposed: { ...base.proposed, targetId: undefined } });
  assert.ok(noTarget.missingFields.includes('targetId'));
  const badRelation = actions.assessDraft({ ...base, proposed: { ...base.proposed, relationType: 'made-up' } });
  assert.ok(badRelation.missingFields.includes('relationType'));
  assert.throws(() => actions.assessDraft({ ...base, source: { kind: 'sample', ref: 'x' } }), error => error.code === 'SAMPLE_REJECTED');
});

// The approval path: confirm -> execute must re-enter the Domain API executor, which calls
// linkSparePart with the approve_ai permission. Nothing is written before confirmation.
function approvalService(pool, options = {}) {
  const authorize = options.authorize || (async () => true);
  const api = actions.createSeleneActions({
    repository: actions.memoryRepository(),
    // The real pgRepository hands the executor a live PG client; the memory repository's tx
    // client is a stub, so the harness supplies the query-capable pool as the execution client.
    commands: { apply: (_client, actor, draft) => commands.applyControlledAction(pool, actor, draft, { pool, security }) },
    authorize,
    now: () => new Date('2026-11-04T08:00:00.000Z')
  });
  return api;
}

async function seedPendingDraft(api) {
  return api.createDraft(user, {
    actionType: 'equipment.spares.link',
    proposed: { rootEquipmentId: 'eq-root', targetId: 'eq-main', itemId: 'item-1', relationType: 'key-spare', quantityRequired: 2 },
    source: { kind: 'document', ref: 'spares-suggestion:deepseek-chat', verified: false },
    evidence: [{ field: 'partNumber', value: 'P-100', origin: 'component-ext' }],
    confidence: 0.82, targetId: 'eq-main'
  });
}

test('D4 approval: execute without a confirmation is rejected and writes nothing', async () => {
  const pool = harnessPool();
  const api = approvalService(pool);
  const draft = await seedPendingDraft(api);
  await assert.rejects(api.executeDraft(user, draft.id, { requestId: 'r1' }), error => error.code === 'CONFIRMATION_REQUIRED');
  assert.equal(pool.state.spareWrites, 0);
  assert.equal(pool.links.size, 0);
});

test('D4 approval: confirm+execute writes the link through the Domain API with approve_ai, audit and realtime', async () => {
  const pool = harnessPool();
  let usedPermission = null;
  const api = approvalService(pool, { authorize: async (_u, permission) => { usedPermission = permission; return true; } });
  const draft = await seedPendingDraft(api);
  assert.equal(pool.links.size, 0, 'creating a draft writes no link');
  const confirmation = await api.confirmDraft(user, draft.id);
  assert.ok(confirmation.id);
  assert.equal(pool.links.size, 0, 'confirmation alone writes no link');
  const result = await api.executeDraft(user, draft.id, { requestId: 'req-1', confirmationId: confirmation.id });
  assert.equal(result.committed, true);
  assert.equal(result.actionType, 'equipment.spares.link');
  assert.equal(pool.state.spareWrites, 1);
  const stored = pool.links.get('eq-main:item-1');
  assert.ok(stored, 'the approved link targets the real component');
  assert.equal(stored.relation_type, 'key-spare');
  assert.equal(stored.quantity_required, 2);
  assert.equal(usedPermission, 'equipment.spares.approve_ai', 'approval re-checks the approve_ai permission');
  assert.ok(pool.state.audit.some(row => row.action === 'spare-link'));
  assert.equal(pool.state.outbox.length, 1);
  assert.equal(pool.state.outbox[0].payload.action, 'link');
  // The confirmation is single-use: replaying it (even with a fresh request id) is rejected.
  await assert.rejects(api.executeDraft(user, draft.id, { requestId: 'req-2', confirmationId: confirmation.id }), error => error.code === 'CONFIRMATION_USED');
  // Replaying the exact same request id is idempotent-safe (duplicate request rejected).
  await assert.rejects(api.executeDraft(user, draft.id, { requestId: 'req-1', confirmationId: confirmation.id }), error => error.code === 'DUPLICATE_REQUEST');
  assert.equal(pool.state.spareWrites, 1, 'no double write from replayed requests');
});

test('D4 approval: a user without approve_ai cannot confirm or execute the draft', async () => {
  const pool = harnessPool();
  const api = approvalService(pool, { authorize: async (_u, permission) => permission !== 'equipment.spares.approve_ai' });
  const draft = await seedPendingDraft(api);
  await assert.rejects(api.confirmDraft(user, draft.id), error => error.code === 'PERMISSION_DENIED');
  assert.equal(pool.links.size, 0);
});

test('D4 approval: the executor rejects a critical link aimed at the equipment root (rule re-applied at approval)', async () => {
  const pool = harnessPool();
  const api = approvalService(pool);
  const draft = await api.createDraft(user, {
    actionType: 'equipment.spares.link',
    proposed: { rootEquipmentId: 'eq-root', targetId: 'eq-root', itemId: 'item-1', relationType: 'key-spare' },
    source: { kind: 'document', ref: 'spares-suggestion:m', verified: false },
    evidence: [{ field: 'partNumber', value: 'P-100', origin: 'ext' }], confidence: 0.7, targetId: 'eq-root'
  });
  const confirmation = await api.confirmDraft(user, draft.id);
  await assert.rejects(api.executeDraft(user, draft.id, { requestId: 'req-x', confirmationId: confirmation.id }), error => error.code === 'SPARE_CRITICAL_TARGET_INVALID');
  assert.equal(pool.state.spareWrites, 0, 'the critical-target rule blocks the write even after approval');
  assert.equal(pool.links.size, 0);
});

test('D4 wiring: the action is registered and the executor/routes dispatch it through the Domain API', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
  assert.equal(actions.ACTIONS['equipment.spares.link'].permission, 'equipment.spares.suggest');
  assert.equal(actions.ACTIONS['equipment.spares.link'].approvalPermission, 'equipment.spares.approve_ai');
  assert.deepEqual(actions.ACTIONS['equipment.spares.link'].required, ['rootEquipmentId', 'targetId', 'itemId']);
  const commandsSrc = read('server/equipment-commands.js');
  assert.match(commandsSrc, /equipment\.spares\.link/);
  assert.match(commandsSrc, /permission: 'equipment\.spares\.approve_ai'/);
  const routesSrc = read('server/selene-action-routes.js');
  assert.match(routesSrc, /equipment\.spares\./, 'spares permissions route through role_permissions');
  const equipRoutes = read('server/equipment-routes.js');
  assert.match(equipRoutes, /spares\/suggestions/);
});
