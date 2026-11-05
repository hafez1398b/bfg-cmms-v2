'use strict';

// Mission D4 / Phase 3 — Selene suggestions for critical spare-part links.
// Selene only proposes DRAFTS (selene_action_drafts, actionType='equipment.spares.link') from
// authorized real facts: the dossier's real main-components/sub-components and real inventory
// items. Every suggestion carries evidence/provenance/confidence and the provider/model that
// produced it. Nothing is written to asset_spare_parts until a user confirms and the controlled
// Domain API executor re-checks permission/scope and applies the link. No item, stock or part
// is invented; a suggestion that cannot be grounded in real data is marked incomplete.
const { v4: uuid } = require('uuid');
const structure = require('./equipment-structure');
const spares = require('./equipment-spares');
const { assessDraft, publicDraft } = require('./selene-actions');
const { coded } = require('./equipment-service');

function cleanText(value, max = 500) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function clip(value, max = 8000) {
  const text = String(value || '');
  return text.length > max ? text.slice(0, max) + '\n…[truncated]' : text;
}

// Authorized context: only real rows. Candidate items are matched from the components' own
// recorded part numbers/brands/codes so the model never sees (or invents) unrelated items.
async function buildSparesContext(pool, root) {
  const targets = (await spares.spareTargets(pool, root)).filter(target => target.criticalAllowed);
  const componentIds = targets.map(target => target.id);
  const [componentRows, links, items] = await Promise.all([
    componentIds.length
      ? pool.query(
        `SELECT id,code,name,ext FROM assets WHERE id=ANY($1::text[]) AND deleted_at IS NULL`, [componentIds]
      )
      : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT rel.asset_id,rel.item_id,rel.relation_type,i.code,i.name
       FROM asset_spare_parts rel JOIN items i ON i.id=rel.item_id
       WHERE rel.asset_id=ANY($1::text[]) AND rel.deleted_at IS NULL AND i.deleted_at IS NULL
       ORDER BY i.name LIMIT 60`, [[root.id, ...componentIds]]
    ),
    pool.query(
      `SELECT i.id,i.code,i.name,i.unit,i.part_type,i.ext
       FROM items i WHERE i.deleted_at IS NULL
         AND (
           i.code IN (SELECT NULLIF(ext->>'partNumber','') FROM assets WHERE id=ANY($1::text[]))
           OR EXISTS (
             SELECT 1 FROM assets c WHERE c.id=ANY($1::text[]) AND c.deleted_at IS NULL AND (
               (NULLIF(c.ext->>'partNumber','') IS NOT NULL AND i.ext->>'partNumber' = c.ext->>'partNumber')
               OR (NULLIF(c.ext->>'brand','') IS NOT NULL AND lower(i.ext->>'brand') = lower(c.ext->>'brand'))
               OR (NULLIF(c.name,'') IS NOT NULL AND i.name ILIKE '%'||c.name||'%')
             )
           )
         )
       ORDER BY i.code LIMIT 40`, [componentIds]
    )
  ]);
  const extOf = row => (row.ext && typeof row.ext === 'object' ? row.ext : {});
  const byId = new Map(componentRows.rows.map(row => [String(row.id), row]));
  return {
    root: { id: root.id, code: root.code, name: root.name },
    targets: targets.map(target => {
      const row = byId.get(target.id);
      const ext = row ? extOf(row) : {};
      return {
        id: target.id, code: target.code, name: target.name, kind: target.kind,
        partNumber: ext.partNumber || null, brand: ext.brand || ext.manufacturer || null,
        specification: ext.technicalSpecification || null
      };
    }),
    existingLinks: links.rows.map(row => ({
      targetId: String(row.asset_id), itemCode: row.code, itemName: row.name, relationType: row.relation_type
    })),
    candidateItems: items.rows.map(row => {
      const ext = extOf(row);
      return {
        id: row.id, code: row.code, name: row.name, unit: row.unit,
        partNumber: ext.partNumber || null, brand: ext.brand || ext.manufacturer || null
      };
    })
  };
}

function buildPrompt(context) {
  return [
    'مثل یک دستیار دقیق قطعات یدکی حیاتی عمل کن. فقط از حقایق AUTHORIZED_CONTEXT پیشنهاد بده.',
    'هیچ قلم، کد، برند یا قطعه‌ای را حدس نزن. اگر شاهد کافی نیست، آن پیشنهاد را برگردان اما در missingFields بنویس.',
    'هر پیشنهاد فقط یک اتصال بین یک target واقعی (main-component یا sub-component) و یک item واقعی از candidateItems است.',
    'relationType فقط key-spare یا general-spare باشد. targetCode باید از targets و itemCode باید از candidateItems باشد.',
    'پاسخ فقط JSON باشد: {"suggestions":[{"targetCode":"","itemCode":"","relationType":"key-spare","quantityRequired":null,"explanation":"","confidence":null,"missingFields":[],"evidence":[{"field":"","value":"","origin":""}]}]}',
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

// Grounds a raw suggestion in real rows. A target/item that does not exist in the authorized
// context is dropped from the proposed payload and reported as a missing field, never guessed.
function normalizeSuggestion(raw, context) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const targetCode = cleanText(source.targetCode, 120);
  const itemCode = cleanText(source.itemCode, 120);
  const target = context.targets.find(item => targetCode && String(item.code || '').toLowerCase() === targetCode.toLowerCase()) || null;
  const candidate = context.candidateItems.find(item => itemCode && String(item.code || '').toLowerCase() === itemCode.toLowerCase()) || null;
  const relationType = spares.RELATION_TYPES[source.relationType] ? String(source.relationType) : 'key-spare';
  const evidence = Array.isArray(source.evidence)
    ? source.evidence.slice(0, 20).map(item => ({
      field: cleanText(item && item.field, 80), value: cleanText(item && item.value, 240),
      origin: cleanText(item && item.origin, 120) || 'provider-suggestion'
    })).filter(item => item.field && item.value)
    : [];
  const proposed = {
    rootEquipmentId: context.root.id,
    relationType,
    explanation: cleanText(source.explanation, 1000),
    missingFields: Array.isArray(source.missingFields) ? source.missingFields.slice(0, 20).map(field => String(field)) : []
  };
  if (target) proposed.targetId = target.id;
  else if (targetCode) proposed.missingFields.push('targetId');
  if (candidate) proposed.itemId = candidate.id;
  else if (itemCode) proposed.missingFields.push('itemId');
  const quantity = Number(source.quantityRequired);
  if (source.quantityRequired != null && source.quantityRequired !== '' && Number.isFinite(quantity) && quantity >= 0 && quantity <= 1_000_000_000) {
    proposed.quantityRequired = quantity;
  }
  return {
    proposed,
    evidence,
    confidence: Number.isFinite(Number(source.confidence)) ? Math.max(0, Math.min(1, Number(source.confidence))) : null
  };
}

async function suggestSpares({ pool, registry, security, user, rootEquipmentId }) {
  await structure.assertPermission({ pool, security, user }, 'equipment.spares.suggest');
  const root = await structure.rootEquipmentById(pool, rootEquipmentId);
  await structure.assertEquipmentScope(pool, user, root.id, root.factory_id);
  const context = await buildSparesContext(pool, root);
  const candidates = typeof registry?.candidates === 'function'
    ? registry.candidates({ media: [], purpose: 'equipment_intake', preferred: 'deepseek' })
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
        system: 'You are Selene, the controlled critical-spares assistant of an industrial CMMS. Return JSON only. Suggest links only between real AUTHORIZED_CONTEXT components and real inventory items. Never invent codes, brands, parts or stock. Suggestions are drafts for human approval, never saved records.',
        prompt: buildPrompt(context),
        media: []
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
    if (!normalized.proposed.targetId && !normalized.proposed.itemId && !normalized.evidence.length) continue;
    const assessed = assessDraft({
      actionType: 'equipment.spares.link',
      proposed: normalized.proposed,
      source: { kind: provider === 'local' ? 'text' : 'document', ref: `spares-suggestion:${model || provider}`, verified: false },
      evidence: normalized.evidence,
      confidence: normalized.confidence,
      targetId: normalized.proposed.targetId || null
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
     VALUES($1,now(),$2,$3,$4,$5,'equipment-spares',$6,$7,NULL,$8)`,
    [uuid(), user.name || user.username || user.id, user.id, user.role || '', 'spares-suggest', root.id,
      provider ? 'پیشنهاد قطعه یدکی از دادهٔ مجاز تهیه و فقط پیش‌نویس شد' : 'پیشنهاد قطعه یدکی تهیه نشد؛ سرویس تحلیل در دسترس یا فعال نیست',
      JSON.stringify({ provider, model, notice, drafts: drafts.length })]
  ).catch(() => {});
  return { provider, model, notice, suggestions: drafts, insufficient: notice ? true : drafts.length === 0 };
}

module.exports = { suggestSpares, buildSparesContext, buildPrompt, normalizeSuggestion, parseSuggestions };
