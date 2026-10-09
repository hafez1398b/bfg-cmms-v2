'use strict';

const EQUIPMENT_PERMISSIONS = {
  admin: new Set(['view', 'create', 'edit', 'move', 'delete', 'export', 'print']),
  mgr: new Set(['view', 'create', 'edit', 'move', 'delete', 'export', 'print']),
  planner: new Set(['view', 'create', 'edit', 'move', 'export', 'print']),
  tech: new Set(['view', 'export', 'print']),
  op: new Set(['view', 'print']),
  store: new Set(['view', 'export', 'print']),
  hse: new Set(['view', 'print']),
  cal: new Set(['view', 'export', 'print'])
};
const SORT_COLUMNS = {
  code: 'a.code', name: 'a.name', status: 'a.status', criticality: 'a.crit',
  updatedAt: 'a.updated_at', sortOrder: 'a.sort_order'
};
const NODE_KINDS = new Set([
  'company', 'head-office', 'factories', 'factory', 'category', 'location',
  'equipment', 'sub-equipment', 'subsystem', 'main-component', 'sub-component'
]);
const RECORD_STATUSES = new Set(['draft', 'complete']);
const OPERATIONAL_STATUSES = new Set(['in_service', 'standby', 'out_of_service', 'reserved', 'decommissioned']);

function coded(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function canEquipment(user, operation) {
  return !!user && (user.role === 'admin' || EQUIPMENT_PERMISSIONS[user.role]?.has(operation));
}

function requireEquipment(operation) {
  return (req, res, next) => canEquipment(req.user, operation)
    ? next()
    : res.status(403).json({ error: 'EQUIPMENT_PERMISSION_DENIED', permission: `Equipment.${operation}` });
}

function listParams(query = {}) {
  const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit, 10) || 25));
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const sort = SORT_COLUMNS[query.sort] || SORT_COLUMNS.sortOrder;
  const direction = String(query.direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return {
    limit, page, offset: (page - 1) * limit, sort, direction,
    q: String(query.q || '').trim().slice(0, 120),
    factoryId: query.factoryId || null, categoryId: query.categoryId || null,
    status: query.status || null, criticality: query.criticality || null
  };
}

const PATCH_FIELDS = new Set([
  'name', 'code', 'status', 'crit', 'maker', 'model', 'serial', 'year', 'install',
  'installDate', 'power', 'hours', 'cls', 'categoryId', 'parentId', 'sortOrder',
  'isActive', 'activityType', 'manufacturerCountry', 'operationalStatus',
  'responsibleUserId', 'generalNotes', 'recordStatus'
]);

function cleanPatch(body = {}) {
  return Object.fromEntries(Object.entries(body).filter(([key, value]) => PATCH_FIELDS.has(key) && value !== undefined));
}

function cleanExt(ext) {
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return {};
  const textKeys = [
    'locationDescription', 'description', 'technicalSpecification', 'capacity',
    'panelCode', 'refrigerant'
  ];
  const out = {};
  for (const key of textKeys) {
    if (ext[key] == null) continue;
    const text = String(ext[key]).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 1000);
    if (text) out[key] = text;
  }
  const hours = Number(ext.dailyOperatingHours);
  if (Number.isFinite(hours) && hours >= 0 && hours <= 24) out.dailyOperatingHours = hours;
  const score = Number(ext.criticalityScore);
  if (Number.isFinite(score) && score >= 0 && score <= 100) out.criticalityScore = score;
  if (Array.isArray(ext.keyParts)) {
    const parts = ext.keyParts.map(part => String(part).replace(/[\u0000-\u001f]/g, ' ').trim()).filter(Boolean).slice(0, 40);
    if (parts.length) out.keyParts = parts;
  }
  return out;
}

function isISODate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeDate(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!isISODate(text)) throw coded(422, 'INVALID_INSTALL_DATE');
  return text;
}

function validateCreate(body = {}) {
  const errors = [];
  if (!String(body.name || '').trim()) errors.push('name');
  if (!String(body.code || '').trim()) errors.push('code');
  if (!String(body.nodeKind || '').trim() || !NODE_KINDS.has(body.nodeKind)) errors.push('nodeKind');
  if (body.installDate != null && body.installDate !== '' && !isISODate(body.installDate)) errors.push('installDate');
  if (body.recordStatus != null && !RECORD_STATUSES.has(body.recordStatus)) errors.push('recordStatus');
  if (body.operationalStatus != null && body.operationalStatus !== '' && !OPERATIONAL_STATUSES.has(body.operationalStatus)) errors.push('operationalStatus');
  return errors;
}

function validateEquipmentPatch(body = {}) {
  const errors = [];
  if (body.name !== undefined && !String(body.name || '').trim()) errors.push('name');
  if (body.code !== undefined && !String(body.code || '').trim()) errors.push('code');
  if (body.installDate !== undefined && body.installDate !== null && body.installDate !== '' && !isISODate(body.installDate)) errors.push('installDate');
  if (body.recordStatus !== undefined && !RECORD_STATUSES.has(body.recordStatus)) errors.push('recordStatus');
  if (body.operationalStatus !== undefined && body.operationalStatus !== null && body.operationalStatus !== '' && !OPERATIONAL_STATUSES.has(body.operationalStatus)) errors.push('operationalStatus');
  return errors;
}

async function resolvePlacement(client, input = {}, current = {}, currentId = null) {
  const categoryId = Object.prototype.hasOwnProperty.call(input, 'categoryId')
    ? (input.categoryId || null)
    : (current.category_id || null);
  let factoryId = input.factoryId || null;
  let categoryFactoryId = null;

  if (categoryId) {
    const category = await client.query('SELECT id, factory_asset_id FROM asset_categories WHERE id=$1', [categoryId]);
    if (!category.rows[0]) throw coded(422, 'CATEGORY_NOT_FOUND');
    categoryFactoryId = category.rows[0].factory_asset_id;
    if (factoryId && categoryFactoryId && String(factoryId) !== String(categoryFactoryId)) {
      throw coded(422, 'CATEGORY_FACTORY_MISMATCH');
    }
    if (!factoryId) factoryId = categoryFactoryId;
  }

  let parentId;
  if (Object.prototype.hasOwnProperty.call(input, 'parentId')) parentId = input.parentId || null;
  else if (Object.prototype.hasOwnProperty.call(input, 'locationId')) parentId = input.locationId || null;
  else if (current.parent !== undefined) parentId = current.parent || null;
  if (!parentId) parentId = factoryId || categoryFactoryId || null;

  if (parentId) {
    if (String(parentId) === String(currentId || '')) throw coded(422, 'TREE_CYCLE');
    if (currentId) {
      const cycle = await client.query(
        `WITH RECURSIVE descendants(id) AS (
           SELECT id FROM assets WHERE parent=$1 AND deleted_at IS NULL
           UNION ALL
           SELECT child.id FROM assets child JOIN descendants d ON child.parent=d.id WHERE child.deleted_at IS NULL
         ) SELECT 1 FROM descendants WHERE id=$2 LIMIT 1`,
        [currentId, parentId]
      );
      if (cycle.rows[0]) throw coded(422, 'TREE_CYCLE');
    }
    const parent = await client.query('SELECT id, parent, type, ext FROM assets WHERE id=$1 AND deleted_at IS NULL', [parentId]);
    if (!parent.rows[0]) throw coded(422, 'PARENT_NOT_FOUND');
    if (factoryId && String(parentId) !== String(factoryId)) {
      const withinFactory = await client.query(
        `WITH RECURSIVE ancestry AS (
           SELECT id,parent FROM assets WHERE id=$1 AND deleted_at IS NULL
           UNION ALL
           SELECT p.id,p.parent FROM assets p JOIN ancestry a ON a.parent=p.id WHERE p.deleted_at IS NULL
         ) SELECT 1 FROM ancestry WHERE id=$2 LIMIT 1`,
        [parentId, factoryId]
      );
      if (!withinFactory.rows[0]) throw coded(422, 'LOCATION_FACTORY_MISMATCH');
    }
  }

  return { parentId, categoryId, factoryId };
}

module.exports = {
  EQUIPMENT_PERMISSIONS, SORT_COLUMNS, NODE_KINDS, RECORD_STATUSES, OPERATIONAL_STATUSES,
  canEquipment, requireEquipment, listParams, cleanPatch, cleanExt, validateCreate,
  validateEquipmentPatch, isISODate, normalizeDate, resolvePlacement, coded
};
