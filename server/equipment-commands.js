'use strict';

const { v4: uuid } = require('uuid');
const {
  validateCreate, validateEquipmentPatch, cleanPatch, cleanExt, normalizeDate,
  isISODate, resolvePlacement, coded
} = require('./equipment-service');
const { HISTORY_LABEL } = require('./selene-actions');
const structure = require('./equipment-structure');

async function audit(client, user, action, entity, note, before, after) {
  await client.query(
    `INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after)
     VALUES($1,now(),$2,$3,$4,$5,'equipment',$6,$7,$8,$9)`,
    [uuid(), user.name || user.username || user.id, user.id, user.role || '', action, entity, note || '', before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}

function fieldText(value, max = 500) {
  if (value == null) return null;
  const text = String(value).replace(/[\u0000-\u001f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function installValues(proposed = {}) {
  const rawDate = proposed.installDate || (isISODate(proposed.install) ? proposed.install : null);
  const installDate = rawDate ? normalizeDate(rawDate) : null;
  const legacyInstall = installDate || fieldText(proposed.install, 40);
  return { installDate, legacyInstall };
}

function profileExtension(proposed = {}) {
  return cleanExt({
    ...(proposed.ext || {}),
    ...(proposed.nodeKind || proposed.ext?.nodeKind ? { nodeKind: proposed.nodeKind || proposed.ext?.nodeKind } : {}),
    locationDescription: proposed.locationDescription ?? proposed.location ?? proposed.ext?.locationDescription,
    description: proposed.functionDescription ?? proposed.notes ?? proposed.ext?.description,
    technicalSpecification: proposed.technicalSpecification ?? proposed.ext?.technicalSpecification,
    capacity: proposed.capacity ?? proposed.ext?.capacity,
    panelCode: proposed.panelCode ?? proposed.ext?.panelCode,
    refrigerant: proposed.refrigerant ?? proposed.ext?.refrigerant,
    dailyOperatingHours: proposed.dailyOperatingHours ?? proposed.ext?.dailyOperatingHours,
    criticalityScore: proposed.criticalityScore ?? proposed.ext?.criticalityScore,
    keyParts: proposed.keyParts ?? proposed.ext?.keyParts
  });
}

async function createEquipment(client, user, proposed) {
  if (['subsystem', 'main-component', 'sub-component'].includes(String(proposed && proposed.nodeKind || ''))) {
    throw coded(422, 'STRUCTURE_ACTION_REQUIRED');
  }
  const errors = validateCreate(proposed);
  if (errors.length) throw coded(422, 'VALIDATION_ERROR');
  const kind = proposed.nodeKind;
  const type = ['equipment', 'sub-equipment', 'subsystem', 'main-component', 'sub-component'].includes(kind)
    ? 'eq'
    : ['company', 'factory', 'factories'].includes(kind) ? 'site' : 'unit';
  const placement = await resolvePlacement(client, proposed);
  const ext = profileExtension(proposed);
  ext.nodeKind = kind;
  const { installDate, legacyInstall } = installValues(proposed);
  const responsibleUserId = fieldText(proposed.responsibleUserId, 120);
  const generalNotes = fieldText(proposed.generalNotes, 4000);
  const { rows } = await client.query(
    `INSERT INTO assets(
       id,parent,code,name,type,cls,status,crit,maker,model,serial,year,install,install_date,
       power,hours,ext,category_id,activity_type,manufacturer_country,operational_status,
       responsible_user_id,general_notes,record_status,sort_order,is_active,updated_by,updated_at
     ) VALUES(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,true,$26,now()
     ) RETURNING *`,
    [
      uuid(), placement.parentId, String(proposed.code).trim(), String(proposed.name).trim(), type,
      fieldText(proposed.cls, 180), fieldText(proposed.status, 80), fieldText(proposed.crit, 20),
      fieldText(proposed.maker, 180), fieldText(proposed.model, 180), fieldText(proposed.serial, 180),
      fieldText(proposed.year, 16), legacyInstall, installDate, fieldText(proposed.power, 120),
      proposed.hours != null && proposed.hours !== '' && Number.isFinite(Number(proposed.hours)) ? Number(proposed.hours) : null,
      JSON.stringify(ext), placement.categoryId,
      fieldText(proposed.activityType, 180), fieldText(proposed.manufacturerCountry, 120),
      fieldText(proposed.operationalStatus, 40), responsibleUserId, generalNotes,
      proposed.recordStatus || 'complete', Number(proposed.sortOrder) || 0, user.id
    ]
  );
  await audit(client, user, 'create', rows[0].id, 'ثبت کنترل‌شده پس از تأیید کاربر', null, rows[0]);
  return rows[0];
}

const PATCH_COLUMNS = {
  name: 'name', code: 'code', status: 'status', crit: 'crit', maker: 'maker', model: 'model',
  serial: 'serial', year: 'year', install: 'install', installDate: 'install_date', power: 'power',
  hours: 'hours', cls: 'cls', categoryId: 'category_id', parentId: 'parent', sortOrder: 'sort_order',
  isActive: 'is_active', activityType: 'activity_type', manufacturerCountry: 'manufacturer_country',
  operationalStatus: 'operational_status', responsibleUserId: 'responsible_user_id',
  generalNotes: 'general_notes', recordStatus: 'record_status'
};

async function completeEquipment(client, user, targetId, proposed, recordVersion) {
  const errors = validateEquipmentPatch(proposed);
  if (errors.length) throw coded(422, 'VALIDATION_ERROR');
  const { rows: locked } = await client.query('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [targetId]);
  if (!locked[0]) throw coded(404, 'EQUIPMENT_NOT_FOUND');
  if (!Number.isInteger(Number(recordVersion)) || Number(recordVersion) !== Number(locked[0].row_version)) throw coded(409, 'VERSION_CONFLICT');
  if (proposed.recordStatus === 'complete'
      && (!String(proposed.name ?? locked[0].name ?? '').trim() || !String(proposed.code ?? locked[0].code ?? '').trim())) {
    throw coded(422, 'REQUIRED_FIELDS_MISSING');
  }

  const patch = cleanPatch(proposed);
  // An empty Selene value is never interpreted as permission to erase a valid stored fact.
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === '') delete patch[key];
  }
  const sets = [];
  const values = [targetId];
  const patchParameter = new Map();
  for (const [key, value] of Object.entries(patch)) {
    const column = PATCH_COLUMNS[key];
    if (!column) continue;
    values.push(key === 'installDate' ? normalizeDate(value) : value);
    patchParameter.set(key, values.length);
    sets.push(`${column}=$${values.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'installDate')) {
    const installValue = normalizeDate(patch.installDate);
    values.push(installValue);
    sets.push(`install=$${values.length}`);
  }
  const extPatch = profileExtension(proposed);
  if (Object.keys(extPatch).length) {
    values.push(JSON.stringify(extPatch));
    sets.push(`ext=COALESCE(ext,'{}'::jsonb)||$${values.length}::jsonb`);
  }

  if (Object.prototype.hasOwnProperty.call(proposed, 'categoryId')
      || Object.prototype.hasOwnProperty.call(proposed, 'factoryId')
      || Object.prototype.hasOwnProperty.call(proposed, 'locationId')
      || Object.prototype.hasOwnProperty.call(proposed, 'parentId')) {
    const placement = await resolvePlacement(client, proposed, locked[0], targetId);
    for (const [key, value] of [['parentId', placement.parentId], ['categoryId', placement.categoryId]]) {
      const explicitlyChanged = Object.prototype.hasOwnProperty.call(proposed, key)
        || (key === 'parentId' && (Object.prototype.hasOwnProperty.call(proposed, 'locationId')
          || Object.prototype.hasOwnProperty.call(proposed, 'factoryId')));
      if (!explicitlyChanged) continue;
      const column = PATCH_COLUMNS[key];
      const parameter = patchParameter.get(key);
      if (parameter) values[parameter - 1] = value;
      else {
        values.push(value);
        sets.push(`${column}=$${values.length}`);
      }
    }
  }

  if (!sets.length) throw coded(422, 'NO_EDITABLE_FIELDS');
  values.push(user.id);
  const updated = await client.query(
    `UPDATE assets SET ${sets.join(',')},updated_by=$${values.length},row_version=row_version+1,updated_at=now()
     WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
    values
  );
  await audit(client, user, 'edit', targetId, 'تکمیل/ویرایش کنترل‌شده پس از تأیید کاربر', locked[0], updated.rows[0]);
  return updated.rows[0];
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
    `UPDATE assets SET history=COALESCE(history,'[]'::jsonb)||$2::jsonb,
       updated_by=$3,row_version=row_version+1,updated_at=now()
     WHERE id=$1 RETURNING id,history,row_version`,
    [targetId, JSON.stringify([entry]), user.id]
  );
  await audit(client, user, 'retrospective-history', targetId, HISTORY_LABEL,
    { row_version: locked[0].row_version },
    { occurredAt: proposed.occurredAt, recordedAt: new Date().toISOString(), label: HISTORY_LABEL, row_version: rows[0].row_version });
  return { id: rows[0].id, occurredAt: proposed.occurredAt, label: HISTORY_LABEL, row_version: rows[0].row_version };
}

async function applyControlledAction(client, user, draft, options = {}) {
  if (draft.actionType === 'equipment.create') return createEquipment(client, user, draft.proposed);
  if (draft.actionType === 'equipment.complete') return completeEquipment(client, user, draft.targetId, draft.proposed, draft.recordVersion);
  if (draft.actionType === 'equipment.retrospective-history') return appendRetrospectiveHistory(client, user, draft.targetId, draft.proposed, draft.recordVersion);
  if (draft.actionType === 'equipment.structure.add') {
    return structure.createStructureNode({
      client,
      pool: options.pool,
      security: options.security,
      user,
      rootEquipmentId: draft.proposed.rootEquipmentId,
      permission: 'equipment.structure.approve_ai',
      input: {
        ...draft.proposed,
        parentId: draft.proposed.parentId || draft.targetId,
        parentRowVersion: draft.recordVersion
      }
    });
  }
  throw coded(422, 'ACTION_NOT_ALLOWED');
}

module.exports = { applyControlledAction, createEquipment, completeEquipment, appendRetrospectiveHistory };
