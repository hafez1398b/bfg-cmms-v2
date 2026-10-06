'use strict';

const crypto = require('crypto');

const CONFIRMATION_TTL_MS = 15 * 60 * 1000;
const HISTORY_LABEL = 'سابقه گذشته‌نگر تأییدشده توسط کاربر';
const ACTIONS = {
  'equipment.create': { destination: 'equipment', permission: 'create', required: ['name', 'code', 'nodeKind'] },
  'equipment.complete': { destination: 'equipment.profile', permission: 'edit', required: ['targetId'] },
  'equipment.retrospective-history': { destination: 'equipment.history', permission: 'edit', required: ['targetId', 'occurredAt', 'summary'] }
};
const VERIFIED_SOURCES = new Set(['file', 'text', 'document', 'user-confirmed-form', 'import-session']);
const FAKE_KEYS = ['failure', 'failures', 'repair', 'repairs', 'workOrder', 'workOrders', 'downtime', 'downtimes', 'rca', 'rootCause', 'history'];
const COMPARE_KEYS = [
  'name', 'code', 'maker', 'model', 'serial', 'year', 'install', 'installDate', 'power', 'cls',
  'status', 'crit', 'location', 'locationDescription', 'notes', 'functionDescription',
  'activityType', 'manufacturerCountry', 'operationalStatus', 'responsibleUserId', 'generalNotes',
  'technicalSpecification', 'capacity', 'panelCode', 'refrigerant', 'dailyOperatingHours',
  'criticalityScore', 'keyParts'
];

function coded(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function cleanText(value, max = 500) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function hasFakeHistory(proposed) {
  if (!proposed || typeof proposed !== 'object') return false;
  return FAKE_KEYS.some(key => proposed[key] != null && proposed[key] !== '' && !(Array.isArray(proposed[key]) && !proposed[key].length));
}

function sourceRejected(source) {
  if (!source || typeof source !== 'object') return true;
  const kind = String(source.kind || '');
  return source.sample === true || source.template === true || ['sample', 'template', 'example', 'generated'].includes(kind);
}

function assessDraft(input) {
  const action = ACTIONS[input && input.actionType];
  if (!action) throw coded(422, 'ACTION_NOT_ALLOWED');
  const proposed = input.proposed && typeof input.proposed === 'object' && !Array.isArray(input.proposed) ? { ...input.proposed } : {};
  const source = input.source && typeof input.source === 'object' ? { ...input.source } : null;
  const evidence = Array.isArray(input.evidence) ? input.evidence.slice(0, 40) : [];
  if (hasFakeHistory(proposed) || (input.actionType === 'equipment.retrospective-history' && hasFakeHistory(proposed))) throw coded(422, 'FAKE_HISTORY');
  if (sourceRejected(source) || proposed.sample === true || proposed.template === true) throw coded(422, 'SAMPLE_REJECTED');
  const missing = [];
  for (const field of action.required) {
    const value = field === 'targetId' ? input.targetId : proposed[field];
    if (value == null || value === '') missing.push(field);
  }
  if (input.actionType === 'equipment.retrospective-history') {
    if (!source || source.verified !== true || !VERIFIED_SOURCES.has(source.kind) || !cleanText(source.ref, 180)) missing.push('verifiedSource');
    if (!evidence.length) missing.push('evidence');
    const occurred = Date.parse(proposed.occurredAt);
    if (!Number.isFinite(occurred)) missing.push('occurredAt');
  }
  if (input.actionType === 'equipment.create' && proposed.nodeKind && !['equipment', 'sub-equipment', 'subsystem', 'main-component', 'sub-component'].includes(proposed.nodeKind)) missing.push('nodeKind');
  const conflicting = [];
  const current = input.current && typeof input.current === 'object' ? input.current : null;
  const accepted = new Set(Array.isArray(input.acceptConflicts) ? input.acceptConflicts : []);
  if (current && input.actionType !== 'equipment.create') {
    for (const key of COMPARE_KEYS) {
      if (proposed[key] == null || proposed[key] === '' || current[key] == null || current[key] === '') continue;
      if (String(proposed[key]) !== String(current[key]) && !accepted.has(key)) conflicting.push(key);
    }
  }
  let status = 'pending';
  if (missing.length) status = 'incomplete';
  else if (conflicting.length) status = 'conflict';
  const confidence = Number.isFinite(Number(input.confidence)) ? Math.max(0, Math.min(1, Number(input.confidence))) : null;
  return {
    actionType: input.actionType,
    destination: action.destination,
    permission: action.permission,
    proposed,
    source: source || {},
    evidence,
    confidence,
    missingFields: missing,
    conflictingFields: conflicting,
    status,
    recordVersion: input.recordVersion == null || input.recordVersion === '' ? null : Number(input.recordVersion),
    targetId: input.targetId ? String(input.targetId) : null
  };
}

function publicDraft(row) {
  return {
    id: row.id,
    actionType: row.actionType,
    destination: row.destination,
    proposed: row.proposed,
    source: row.source,
    evidence: row.evidence,
    confidence: row.confidence,
    missingFields: row.missingFields,
    conflictingFields: row.conflictingFields,
    status: row.status,
    recordVersion: row.recordVersion,
    targetId: row.targetId,
    rowVersion: row.rowVersion,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function createSeleneActions({ repository, commands, authorize, now = () => new Date(), ttlMs = CONFIRMATION_TTL_MS }) {
  if (!repository || !commands || typeof authorize !== 'function') throw new Error('SELENE_ACTIONS_REQUIRE_COLLABORATORS');

  function deny(user, permission) {
    if (!authorize(user, permission)) throw coded(403, 'PERMISSION_DENIED');
  }

  async function createDraft(user, input) {
    const assessed = assessDraft(input);
    deny(user, assessed.permission);
    const row = await repository.insertDraft({
      ...assessed,
      id: crypto.randomUUID(),
      createdBy: user.id,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
      rowVersion: 1
    });
    return publicDraft(row);
  }

  async function getDraft(user, id) {
    const row = await repository.getDraft(id);
    if (!row || row.createdBy !== user.id) throw coded(404, 'DRAFT_NOT_FOUND');
    return publicDraft(row);
  }

  async function editDraft(user, id, input) {
    const current = await repository.getDraft(id);
    if (!current || current.createdBy !== user.id) throw coded(404, 'DRAFT_NOT_FOUND');
    if (current.status === 'executed' || current.status === 'rejected') throw coded(409, 'DRAFT_CLOSED');
    if (input.rowVersion != null && Number(input.rowVersion) !== Number(current.rowVersion)) throw coded(409, 'VERSION_CONFLICT');
    const assessed = assessDraft({
      actionType: current.actionType,
      proposed: input.proposed == null ? current.proposed : input.proposed,
      source: input.source == null ? current.source : input.source,
      evidence: input.evidence == null ? current.evidence : input.evidence,
      confidence: input.confidence === undefined ? current.confidence : input.confidence,
      current: input.current,
      acceptConflicts: input.acceptConflicts,
      recordVersion: input.recordVersion === undefined ? current.recordVersion : input.recordVersion,
      targetId: input.targetId === undefined ? current.targetId : input.targetId
    });
    deny(user, assessed.permission);
    const row = await repository.updateDraft(id, {
      ...assessed,
      updatedAt: now().toISOString(),
      rowVersion: Number(current.rowVersion) + 1
    });
    return publicDraft(row);
  }

  async function confirmDraft(user, id) {
    return repository.transaction(async tx => {
      const draft = await tx.lockDraft(id);
      if (!draft || draft.createdBy !== user.id) throw coded(404, 'DRAFT_NOT_FOUND');
      deny(user, ACTIONS[draft.actionType].permission);
      if (draft.status === 'incomplete') throw coded(422, 'DRAFT_INCOMPLETE');
      if (draft.status === 'conflict') throw coded(409, 'DRAFT_CONFLICT');
      if (draft.status !== 'pending') throw coded(409, 'DRAFT_CLOSED');
      const confirmation = {
        id: crypto.randomUUID(),
        draftId: draft.id,
        userId: user.id,
        recordVersion: draft.recordVersion,
        requestId: null,
        expiresAt: new Date(now().getTime() + ttlMs).toISOString(),
        usedAt: null,
        createdAt: now().toISOString()
      };
      await tx.insertConfirmation(confirmation);
      return { id: confirmation.id, draftId: draft.id, recordVersion: draft.recordVersion, expiresAt: confirmation.expiresAt, userId: user.id };
    });
  }

  async function rejectDraft(user, id) {
    const draft = await repository.getDraft(id);
    if (!draft || draft.createdBy !== user.id) throw coded(404, 'DRAFT_NOT_FOUND');
    if (draft.status === 'executed') throw coded(409, 'DRAFT_CLOSED');
    const row = await repository.updateDraft(id, { status: 'rejected', updatedAt: now().toISOString(), rowVersion: Number(draft.rowVersion) + 1 });
    return publicDraft(row);
  }

  async function evidenceOf(user, id) {
    const draft = await getDraft(user, id);
    return { source: draft.source, evidence: draft.evidence };
  }

  async function executeDraft(user, id, input) {
    const requestId = cleanText(input && input.requestId, 80);
    const confirmationId = input && input.confirmationId;
    if (!requestId || !confirmationId) throw coded(422, 'CONFIRMATION_REQUIRED');
    const result = await repository.transaction(async tx => {
      if (await tx.requestExists(requestId)) throw coded(409, 'DUPLICATE_REQUEST');
      const confirmation = await tx.lockConfirmation(confirmationId);
      if (!confirmation || confirmation.draftId !== id) throw coded(404, 'CONFIRMATION_NOT_FOUND');
      if (confirmation.userId !== user.id) throw coded(403, 'CONFIRMATION_USER_MISMATCH');
      if (confirmation.usedAt) throw coded(409, 'CONFIRMATION_USED');
      if (Date.parse(confirmation.expiresAt) <= now().getTime()) throw coded(409, 'CONFIRMATION_EXPIRED');
      const draft = await tx.lockDraft(id);
      if (!draft || draft.createdBy !== user.id) throw coded(404, 'DRAFT_NOT_FOUND');
      deny(user, ACTIONS[draft.actionType].permission);
      if (draft.status !== 'pending') throw coded(draft.status === 'incomplete' ? 422 : 409, draft.status === 'incomplete' ? 'DRAFT_INCOMPLETE' : 'DRAFT_CLOSED');
      if (Number(confirmation.recordVersion) !== Number(draft.recordVersion) && !(confirmation.recordVersion == null && draft.recordVersion == null)) throw coded(409, 'VERSION_CONFLICT');
      const applied = await commands.apply(tx.client, user, clone(draft));
      await tx.markUsed(confirmation.id, requestId, now().toISOString());
      await tx.markExecuted(draft.id, now().toISOString());
      return applied;
    });
    return { committed: true, data: result };
  }

  return { createDraft, getDraft, editDraft, confirmDraft, rejectDraft, evidenceOf, executeDraft, assessDraft };
}

function memoryRepository() {
  const drafts = new Map();
  const confirmations = new Map();
  const requests = new Set();
  const snapshot = () => ({
    drafts: new Map([...drafts].map(([key, value]) => [key, clone(value)])),
    confirmations: new Map([...confirmations].map(([key, value]) => [key, clone(value)])),
    requests: new Set(requests)
  });
  const restore = saved => {
    drafts.clear();
    confirmations.clear();
    requests.clear();
    saved.drafts.forEach((value, key) => drafts.set(key, value));
    saved.confirmations.forEach((value, key) => confirmations.set(key, value));
    saved.requests.forEach(value => requests.add(value));
  };
  function tx() {
    return {
      client: { kind: 'memory' },
      async lockDraft(id) { return clone(drafts.get(id) || null); },
      async lockConfirmation(id) { return clone(confirmations.get(id) || null); },
      async requestExists(requestId) { return requests.has(requestId); },
      async insertConfirmation(row) { confirmations.set(row.id, clone(row)); },
      async markUsed(id, requestId, usedAt) {
        const row = confirmations.get(id);
        row.usedAt = usedAt;
        row.requestId = requestId;
        requests.add(requestId);
      },
      async markExecuted(id, updatedAt) {
        const row = drafts.get(id);
        row.status = 'executed';
        row.updatedAt = updatedAt;
        row.rowVersion += 1;
      }
    };
  }
  return {
    async insertDraft(row) { drafts.set(row.id, clone(row)); return clone(row); },
    async getDraft(id) { return clone(drafts.get(id) || null); },
    async updateDraft(id, patch) {
      const row = { ...drafts.get(id), ...patch };
      drafts.set(id, row);
      return clone(row);
    },
    async transaction(work) {
      const saved = snapshot();
      try {
        return await work(tx());
      } catch (error) {
        restore(saved);
        throw error;
      }
    }
  };
}

function pgRepository(pool) {
  const mapDraft = row => row && ({
    id: row.id,
    actionType: row.action_type,
    destination: row.destination,
    proposed: row.proposed,
    source: row.source,
    evidence: row.evidence,
    confidence: row.confidence == null ? null : Number(row.confidence),
    missingFields: row.missing_fields,
    conflictingFields: row.conflicting_fields,
    status: row.status,
    recordVersion: row.record_version == null ? null : Number(row.record_version),
    targetId: row.target_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rowVersion: Number(row.row_version)
  });
  const mapConfirmation = row => row && ({
    id: row.id,
    draftId: row.draft_id,
    userId: row.user_id,
    recordVersion: row.record_version == null ? null : Number(row.record_version),
    requestId: row.request_id,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at
  });
  async function insertDraft(executor, row) {
    const { rows } = await executor.query(
      `INSERT INTO selene_action_drafts(id,action_type,destination,proposed,source,evidence,confidence,missing_fields,conflicting_fields,status,record_version,target_id,created_by,created_at,updated_at,row_version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [row.id, row.actionType, row.destination, JSON.stringify(row.proposed), JSON.stringify(row.source), JSON.stringify(row.evidence), row.confidence, JSON.stringify(row.missingFields), JSON.stringify(row.conflictingFields), row.status, row.recordVersion, row.targetId, row.createdBy, row.createdAt, row.updatedAt, row.rowVersion]
    );
    return mapDraft(rows[0]);
  }
  return {
    insertDraft: row => insertDraft(pool, row),
    async getDraft(id) {
      const { rows } = await pool.query('SELECT * FROM selene_action_drafts WHERE id=$1', [id]);
      return mapDraft(rows[0]);
    },
    async updateDraft(id, patch) {
      const { rows } = await pool.query(
        `UPDATE selene_action_drafts SET proposed=$2,source=$3,evidence=$4,confidence=$5,missing_fields=$6,conflicting_fields=$7,status=$8,record_version=$9,target_id=$10,updated_at=$11,row_version=$12 WHERE id=$1 RETURNING *`,
        [id, JSON.stringify(patch.proposed), JSON.stringify(patch.source), JSON.stringify(patch.evidence), patch.confidence, JSON.stringify(patch.missingFields || []), JSON.stringify(patch.conflictingFields || []), patch.status, patch.recordVersion, patch.targetId, patch.updatedAt, patch.rowVersion]
      );
      return mapDraft(rows[0]);
    },
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work({
          client,
          lockDraft: async id => mapDraft((await client.query('SELECT * FROM selene_action_drafts WHERE id=$1 FOR UPDATE', [id])).rows[0]),
          lockConfirmation: async id => mapConfirmation((await client.query('SELECT * FROM selene_action_confirmations WHERE id=$1 FOR UPDATE', [id])).rows[0]),
          requestExists: async requestId => !!(await client.query('SELECT 1 FROM selene_action_confirmations WHERE request_id=$1', [requestId])).rows[0],
          insertConfirmation: async row => {
            await client.query(
              `INSERT INTO selene_action_confirmations(id,draft_id,user_id,record_version,request_id,expires_at,used_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
              [row.id, row.draftId, row.userId, row.recordVersion, row.requestId, row.expiresAt, row.usedAt, row.createdAt]
            );
          },
          markUsed: async (id, requestId, usedAt) => {
            await client.query('UPDATE selene_action_confirmations SET used_at=$2,request_id=$3 WHERE id=$1', [id, usedAt, requestId]);
          },
          markExecuted: async (id, updatedAt) => {
            await client.query(`UPDATE selene_action_drafts SET status='executed',updated_at=$2,row_version=row_version+1 WHERE id=$1`, [id, updatedAt]);
          }
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw error;
      } finally {
        client.release();
      }
    }
  };
}

module.exports = {
  CONFIRMATION_TTL_MS,
  HISTORY_LABEL,
  ACTIONS,
  assessDraft,
  createSeleneActions,
  memoryRepository,
  pgRepository
};
