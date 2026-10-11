'use strict';

const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const structure = require('./equipment-structure');
const { coded } = require('./equipment-service');
const { assessDraft, publicDraft } = require('./selene-actions');

const SUGGESTION_KINDS = new Set(['subsystem', 'main-component', 'sub-component']);

function cleanText(value, max = 500) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function clip(value, max = 8000) {
  const text = String(value || '');
  return text.length > max ? text.slice(0, max) + '\n…[truncated]' : text;
}

async function buildStructureContext(pool, rootId) {
  const root = await structure.rootEquipmentById(pool, rootId);
  const [category, nodes, spares, documents, history] = await Promise.all([
    pool.query('SELECT name FROM asset_categories WHERE id=$1', [root.category_id || null]),
    pool.query(
      `WITH RECURSIVE structure AS (
         SELECT id,parent,code,name,ext->>'nodeKind' AS node_kind,0 AS depth,ARRAY[id]::text[] AS path,false AS cycle
         FROM assets WHERE id=$1 AND deleted_at IS NULL
         UNION ALL
         SELECT child.id,child.parent,child.code,child.name,child.ext->>'nodeKind',structure.depth+1,
           structure.path||child.id,child.id=ANY(structure.path)
         FROM assets child JOIN structure ON child.parent=structure.id
         WHERE child.type='eq' AND child.deleted_at IS NULL AND structure.depth<8 AND NOT structure.cycle
       )
       SELECT id,parent,code,name,node_kind,depth FROM structure WHERE depth>0 ORDER BY depth,name`,
      [root.id]
    ),
    pool.query(
      `SELECT i.code,i.name,rel.relation_type FROM asset_spare_parts rel JOIN items i ON i.id=rel.item_id
       WHERE rel.asset_id=$1 AND i.deleted_at IS NULL ORDER BY i.name LIMIT 40`, [root.id]
    ),
    pool.query(
      `SELECT COALESCE(value->>'title', value->>'name') AS title, COALESCE(value->>'status','') AS status
       FROM assets, jsonb_array_elements(COALESCE(ext->'documents','[]'::jsonb)) AS value
       WHERE id=$1 LIMIT 40`, [root.id]
    ),
    pool.query(
      `SELECT count(*)::int AS failures FROM failures WHERE equipment_id=$1 AND deleted_at IS NULL`, [root.id]
    )
  ]);
  const ext = root.ext && typeof root.ext === 'object' ? root.ext : {};
  return {
    root: {
      id: root.id, code: root.code, name: root.name,
      category: category.rows[0]?.name || null,
      activityType: root.activity_type || null,
      maker: root.maker || null, model: root.model || null,
      technicalSpecification: ext.technicalSpecification || null,
      cls: root.cls || null
    },
    approvedDocuments: documents.rows.filter(row => /approved|verified|تأیید/i.test(row.status || '')).map(row => row.title).filter(Boolean),
    currentStructure: nodes.rows.map(row => ({
      id: row.id, parent: row.parent, code: row.code, name: row.name, nodeKind: row.node_kind, depth: Number(row.depth)
    })),
    spareParts: spares.rows.map(row => ({ code: row.code, name: row.name, relation: row.relation_type })),
    recordedFailures: Number(history.rows[0]?.failures) || 0
  };
}

function buildPrompt(context) {
  return [
    'مثل یک دستیار دقیق ساختار تجهیز عمل کن. فقط از حقایق AUTHORIZED_CONTEXT پیشنهاد بده.',
    'هیچ کد، برند، مدل یا قطعه‌ای را حدس نزن. اگر شاهد کافی نیست، آن پیشنهاد را برگردان اما در missingFields بنویس.',
    'nodeKind فقط یکی از subsystem، main-component یا sub-component باشد. زنجیرهٔ مجاز: تجهیز ← زیرسیستم ← جزء اصلی ← جزء فرعی.',
    'parentCode فقط کدی باشد که در currentStructure یا root وجود دارد؛ در غیر این صورت خالی بگذار.',
    'پاسخ فقط JSON باشد: {"suggestions":[{"nodeKind":"","name":"","code":"","parentCode":"","explanation":"","confidence":null,"missingFields":[],"evidence":[{"field":"","value":"","origin":""}]}]}',
    'AUTHORIZED_CONTEXT:',
    clip(JSON.stringify(context), 12000)
  ].join('\n\n');
}

function parseSuggestions(text) {
  const clean = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 30) : [];
  } catch (_) {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(clean.slice(start, end + 1));
        return Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 30) : [];
      } catch (_) { return []; }
    }
    return [];
  }
}

function normalizeSuggestion(raw, context) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const nodeKind = String(source.nodeKind || '');
  if (!SUGGESTION_KINDS.has(nodeKind)) return null;
  const name = cleanText(source.name, 240);
  if (!name) return null;
  const evidence = Array.isArray(source.evidence)
    ? source.evidence.slice(0, 20).map(item => ({
      field: cleanText(item && item.field, 80), value: cleanText(item && item.value, 240),
      origin: cleanText(item && item.origin, 120) || 'provider-suggestion'
    })).filter(item => item.field && item.value)
    : [];
  const proposed = {
    rootEquipmentId: context.root.id,
    nodeKind,
    name,
    explanation: cleanText(source.explanation, 1000),
    missingFields: Array.isArray(source.missingFields) ? source.missingFields.slice(0, 20).map(field => String(field)) : []
  };
  const code = cleanText(source.code, 120);
  // A code is kept only when the same code appears in the authorized evidence.
  if (code && evidence.some(item => String(item.value).includes(code))) proposed.code = code;
  const parentCode = cleanText(source.parentCode, 120);
  const parent = parentCode
    ? context.currentStructure.find(node => String(node.code || '').toLowerCase() === parentCode.toLowerCase())
      || (String(context.root.code || '').toLowerCase() === parentCode.toLowerCase() ? { id: context.root.id, nodeKind: 'equipment' } : null)
    : null;
  if (parent && structure.allowedChildKinds(parent.nodeKind === 'equipment' ? 'equipment' : parent.nodeKind).includes(nodeKind)) {
    proposed.parentId = parent.id;
  } else if (parentCode) {
    proposed.missingFields.push('parentId');
  }
  if (nodeKind === 'subsystem' && !proposed.parentId) proposed.parentId = context.root.id;
  return { proposed, evidence, confidence: Number.isFinite(Number(source.confidence)) ? Math.max(0, Math.min(1, Number(source.confidence))) : null };
}

async function suggestStructures({ pool, registry, security, user, rootEquipmentId }) {
  await structure.assertPermission({ pool, security, user }, 'equipment.structure.suggest');
  const root = await structure.rootEquipmentById(pool, rootEquipmentId);
  await structure.assertEquipmentScope(pool, user, root.id);
  const context = await buildStructureContext(pool, root.id);
  const media = [];
  const candidates = typeof registry?.candidates === 'function'
    ? registry.candidates({ media, purpose: 'equipment_intake', preferred: 'deepseek' })
      .filter(provider => provider.name === 'deepseek' || provider.name === 'local')
    : [];
  let provider = null;
  let model = null;
  let notice = null;
  let rawSuggestions = [];
  for (const candidate of candidates) {
    const { rows } = await pool.query('SELECT provider,enabled,allowed_purposes,allow_sensitive_context FROM ai_provider_policies WHERE provider=$1', [candidate.name]);
    const policy = rows[0];
    const purposes = Array.isArray(policy?.allowed_purposes) ? policy.allowed_purposes : [];
    if (!policy?.enabled) { notice = notice || 'AI_PROVIDER_DISABLED_BY_POLICY'; continue; }
    if (!purposes.includes('equipment_intake') && !purposes.includes('wizard_suggestion')) { notice = notice || 'AI_PURPOSE_DENIED_BY_POLICY'; continue; }
    if (candidate.name !== 'local' && !policy.allow_sensitive_context) { notice = notice || 'CLOUD_CONTEXT_NOT_APPROVED'; continue; }
    try {
      const result = await candidate.generate({
        system: 'You are Selene, the controlled equipment structure assistant of an industrial CMMS. Return JSON only. Suggest internal structure nodes only from AUTHORIZED_CONTEXT facts. Never invent codes, brands, models or parts. Suggestions are drafts for human approval, never saved records.',
        prompt: buildPrompt(context),
        media
      });
      provider = candidate.name;
      model = result.model || null;
      rawSuggestions = parseSuggestions(result.text);
      notice = null;
      break;
    } catch (error) {
      notice = error.code || 'NO_CAPABLE_PROVIDER';
    }
  }
  if (!provider && !notice) notice = 'NO_CAPABLE_PROVIDER';

  const drafts = [];
  for (const raw of rawSuggestions) {
    const normalized = normalizeSuggestion(raw, context);
    if (!normalized) continue;
    const assessed = assessDraft({
      actionType: 'equipment.structure.add',
      proposed: normalized.proposed,
      source: { kind: provider === 'local' ? 'text' : 'document', ref: `structure-suggestion:${model || provider}`, verified: false },
      evidence: normalized.evidence,
      confidence: normalized.confidence
    });
    const row = await pool.query(
      `INSERT INTO selene_action_drafts(id,action_type,destination,proposed,source,evidence,confidence,missing_fields,conflicting_fields,status,record_version,target_id,created_by,created_at,updated_at,row_version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,1) RETURNING *`,
      [uuid(), assessed.actionType, assessed.destination, JSON.stringify(assessed.proposed), JSON.stringify(assessed.source),
        JSON.stringify(assessed.evidence), assessed.confidence, JSON.stringify(assessed.missingFields),
        JSON.stringify(assessed.conflictingFields), assessed.status, assessed.recordVersion, assessed.targetId,
        user.id, new Date().toISOString(), new Date().toISOString()]
    ).catch(error => {
      if (error && error.code === '42P01') throw coded(503, 'SELENE_DRAFTS_UNAVAILABLE');
      throw error;
    });
    drafts.push(publicDraft({
      id: row.rows[0].id, actionType: row.rows[0].action_type, destination: row.rows[0].destination,
      proposed: row.rows[0].proposed, source: row.rows[0].source, evidence: row.rows[0].evidence,
      confidence: row.rows[0].confidence == null ? null : Number(row.rows[0].confidence),
      missingFields: row.rows[0].missing_fields, conflictingFields: row.rows[0].conflicting_fields,
      status: row.rows[0].status, recordVersion: row.rows[0].record_version, targetId: row.rows[0].target_id,
      rowVersion: Number(row.rows[0].row_version), createdBy: row.rows[0].created_by,
      createdAt: row.rows[0].created_at, updatedAt: row.rows[0].updated_at
    }));
  }
  await pool.query(
    `INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after)
     VALUES($1,now(),$2,$3,$4,$5,'equipment-structure',$6,$7,NULL,$8)`,
    [uuid(), user.name || user.username || user.id, user.id, user.role || '', 'structure-suggest', root.id,
      provider ? 'پیشنهاد ساختار از دادهٔ مجاز تهیه و فقط پیش‌نویس شد' : 'پیشنهاد ساختار تهیه نشد؛ سرویس تحلیل در دسترس یا فعال نیست',
      JSON.stringify({ provider, model, notice, drafts: drafts.length })]
  ).catch(() => {});
  return { provider, model, notice, suggestions: drafts, insufficient: notice ? true : drafts.length === 0 };
}

async function searchInventoryItems({ pool, security, user, query, limit = 50 }) {
  const allowed = security && typeof security.hasPermission === 'function'
    ? await security.hasPermission(user, 'inventory.view')
    : (await pool.query(
      `SELECT 1 FROM role_permissions WHERE role=$1 AND granted=true AND (permission='inventory.view' OR permission='*') LIMIT 1`,
      [user.role]
    )).rows.length > 0;
  if (!allowed) throw coded(403, 'PERMISSION_DENIED');
  const q = cleanText(query, 120);
  const values = [];
  const filters = ['i.deleted_at IS NULL'];
  if (q) {
    values.push(`%${q}%`);
    const index = values.length;
    filters.push(`(i.code ILIKE $${index} OR i.name ILIKE $${index}
      OR COALESCE(i.ext->>'partNumber','') ILIKE $${index}
      OR COALESCE(i.ext->>'brand','') ILIKE $${index}
      OR COALESCE(i.ext->>'manufacturer','') ILIKE $${index}
      OR COALESCE(i.ext->>'technicalSpecification','') ILIKE $${index})`);
  }
  values.push(Math.min(Math.max(Number(limit) || 50, 1), 100));
  const { rows } = await pool.query(
    `SELECT i.id,i.code,i.name,i.unit,i.part_type,i.ext,
       COALESCE((SELECT SUM(CASE WHEN l.id IS NOT NULL AND w.id IS NOT NULL THEN b.on_hand-b.reserved ELSE 0 END)
         FROM item_balances b LEFT JOIN storage_locations l ON l.id=b.location_id AND l.deleted_at IS NULL
         LEFT JOIN warehouses w ON w.id=l.warehouse_id AND w.deleted_at IS NULL AND w.active=true
         WHERE b.item_id=i.id),0) AS available,
       (SELECT receipt.created_at FROM inventory_ledger receipt
         WHERE receipt.item_id=i.id AND receipt.movement='receipt'
           AND NOT EXISTS (SELECT 1 FROM inventory_ledger reversal WHERE reversal.reverses_entry_id=receipt.id)
         ORDER BY receipt.created_at DESC,receipt.entry_no DESC LIMIT 1) AS last_purchase_at
     FROM items i
     WHERE ${filters.join(' AND ')}
     ORDER BY i.code LIMIT $${values.length}`,
    values
  );
  return rows.map(row => ({
    id: row.id, code: row.code, name: row.name, unit: row.unit, partType: row.part_type || null,
    brand: row.ext?.brand || row.ext?.manufacturer || null,
    partNumber: row.ext?.partNumber || null,
    specification: row.ext?.technicalSpecification || null,
    available: Number(row.available) || 0,
    // Real receipt date from inventory_ledger, or null so the UI prints "ثبت نشده".
    lastPurchaseAt: row.last_purchase_at ? new Date(row.last_purchase_at).toISOString() : null,
    source: 'inventory_master_data'
  }));
}

module.exports = { suggestStructures, searchInventoryItems, buildStructureContext, normalizeSuggestion, parseSuggestions };
