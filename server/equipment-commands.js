'use strict';

const { v4: uuid } = require('uuid');
const { validateCreate, cleanPatch, cleanExt } = require('./equipment-service');
const { HISTORY_LABEL } = require('./selene-actions');

function coded(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

async function audit(client, user, action, entity, note, before, after) {
  await client.query(
    `INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after)
     VALUES($1,now(),$2,$3,$4,$5,'equipment',$6,$7,$8,$9)`,
    [uuid(), user.name || user.username || user.id, user.id, user.role || '', action, entity, note || '', before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}

async function createEquipment(client, user, proposed) {
  const errors = validateCreate(proposed);
  if (errors.length) throw coded(422, 'VALIDATION_ERROR');
  const id = uuid();
  const kind = proposed.nodeKind;
  const type = ['equipment', 'sub-equipment', 'subsystem', 'main-component', 'sub-component'].includes(kind) ? 'eq' : 'unit';
  const ext = cleanExt({ ...(proposed.ext || {}), nodeKind: kind, locationDescription: proposed.location, description: proposed.notes, technicalSpecification: proposed.technicalSpecification, capacity: proposed.capacity, panelCode: proposed.panelCode, refrigerant: proposed.refrigerant, dailyOperatingHours: proposed.dailyOperatingHours, criticalityScore: proposed.criticalityScore, keyParts: proposed.keyParts });
  ext.nodeKind = kind;
  const { rows } = await client.query(
    `INSERT INTO assets(id,parent,code,name,type,cls,status,crit,maker,model,serial,year,install,power,hours,ext,category_id,sort_order,is_active,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,true,now()) RETURNING *`,
    [id, proposed.parentId || null, String(proposed.code).trim(), String(proposed.name).trim(), type, proposed.cls || null, proposed.status || 'active', proposed.crit || 'C', proposed.maker || null, proposed.model || null, proposed.serial || null, proposed.year || null, proposed.install || null, proposed.power || null, Number(proposed.hours) || 0, JSON.stringify(ext), proposed.categoryId || null, Number(proposed.sortOrder) || 0]
  );
  await audit(client, user, 'create', id, 'ثبت کنترل‌شده سلن پس از تأیید کاربر', null, rows[0]);
  return rows[0];
}

async function completeEquipment(client, user, targetId, proposed, recordVersion) {
  const patch = cleanPatch(proposed);
  const extPatch = cleanExt(proposed.ext || proposed);
  if (!Object.keys(patch).length && !Object.keys(extPatch).length) throw coded(422, 'NO_EDITABLE_FIELDS');
  const map = { name: 'name', code: 'code', status: 'status', crit: 'crit', maker: 'maker', model: 'model', serial: 'serial', year: 'year', install: 'install', power: 'power', hours: 'hours', cls: 'cls', categoryId: 'category_id', sortOrder: 'sort_order', isActive: 'is_active' };
  const { rows: locked } = await client.query('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [targetId]);
  if (!locked[0]) throw coded(404, 'EQUIPMENT_NOT_FOUND');
  if (Number(recordVersion) !== Number(locked[0].row_version)) throw coded(409, 'VERSION_CONFLICT');
  const entries = Object.entries(patch);
  const values = [targetId, ...entries.map(([, value]) => value)];
  const sets = entries.map(([key], index) => `${map[key]}=$${index + 2}`);
  if (Object.keys(extPatch).length) {
    values.push(JSON.stringify(extPatch));
    sets.push(`ext=COALESCE(ext,'{}'::jsonb)||$${values.length}::jsonb`);
  }
  const { rows } = await client.query(`UPDATE assets SET ${sets.join(',')},row_version=row_version+1,updated_at=now() WHERE id=$1 RETURNING *`, values);
  await audit(client, user, 'edit', targetId, 'تکمیل کنترل‌شده سلن پس از تأیید کاربر', locked[0], rows[0]);
  return rows[0];
}

async function appendRetrospectiveHistory(client, user, targetId, proposed, recordVersion) {
  const { rows: locked } = await client.query('SELECT id,history,row_version FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [targetId]);
  if (!locked[0]) throw coded(404, 'EQUIPMENT_NOT_FOUND');
  if (Number(recordVersion) !== Number(locked[0].row_version)) throw coded(409, 'VERSION_CONFLICT');
  const entry = {
    label: HISTORY_LABEL,
    occurredAt: proposed.occurredAt,
    summary: proposed.summary,
    source: proposed.source,
    evidence: proposed.evidence
  };
  const { rows } = await client.query(
    `UPDATE assets SET history=COALESCE(history,'[]'::jsonb)||$2::jsonb,row_version=row_version+1,updated_at=now() WHERE id=$1 RETURNING id,history,row_version`,
    [targetId, JSON.stringify([entry])]
  );
  await audit(client, user, 'retrospective-history', targetId, HISTORY_LABEL, { row_version: locked[0].row_version }, { occurredAt: proposed.occurredAt, recordedAt: new Date().toISOString(), label: HISTORY_LABEL, row_version: rows[0].row_version });
  return { id: rows[0].id, occurredAt: proposed.occurredAt, label: HISTORY_LABEL, row_version: rows[0].row_version };
}

async function applyControlledAction(client, user, draft) {
  if (draft.actionType === 'equipment.create') return createEquipment(client, user, draft.proposed);
  if (draft.actionType === 'equipment.complete') return completeEquipment(client, user, draft.targetId, draft.proposed, draft.recordVersion);
  if (draft.actionType === 'equipment.retrospective-history') return appendRetrospectiveHistory(client, user, draft.targetId, draft.proposed, draft.recordVersion);
  throw coded(422, 'ACTION_NOT_ALLOWED');
}

module.exports = { applyControlledAction, createEquipment, completeEquipment, appendRetrospectiveHistory };
