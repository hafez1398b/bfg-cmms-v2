'use strict';

const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { isRecipientAllowed } = require('./maintenance-service');
const { coded } = require('./equipment-service');

const STRUCTURE_KINDS = new Set(['subsystem', 'main-component', 'sub-component']);
const INTERNAL_KINDS = new Set([...STRUCTURE_KINDS, 'sub-equipment']);
// Kinds that may own a dossier structure. Legacy rows may carry an explicit 'equipment',
// the old 'sub-equipment', or nothing at all (resolved to 'equipment' above).
const STRUCTURE_ROOT_KINDS = new Set(['equipment', 'sub-equipment']);
const CHILD_KINDS = Object.freeze({
  equipment: new Set(['subsystem']),
  subsystem: new Set(['main-component']),
  'main-component': new Set(['sub-component']),
  'sub-component': new Set([]),
  // Existing sub-equipment rows remain readable; new nodes still use the three kinds above.
  'sub-equipment': new Set(['subsystem'])
});
const LEVEL_LABELS = Object.freeze({
  equipment: 'تجهیز',
  'sub-equipment': 'زیرتجهیز قدیمی',
  subsystem: 'زیرسیستم',
  'main-component': 'جزء اصلی',
  'sub-component': 'جزء فرعی'
});
const EXT_TEXT_FIELDS = Object.freeze([
  'componentType', 'partNumber', 'technicalSpecification', 'structureNotes', 'manufacturer', 'brand', 'unit'
]);

function text(value, max = 1000) {
  if (value == null) return null;
  const normalized = String(value).replace(/[\u0000-\u001f]/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function jsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) { return {}; }
  }
  return {};
}

function isStructureKind(kind) {
  return STRUCTURE_KINDS.has(String(kind || ''));
}

function isInternalKind(kind) {
  return INTERNAL_KINDS.has(String(kind || ''));
}

function kindOf(row) {
  const ext = jsonObject(row && row.ext);
  return String(ext.nodeKind || row?.node_kind || row?.nodeKind || '');
}

// Single fallback rule shared by the resolver, the root check and the parent-kind check so a
// legacy row can never be read as equipment in one place and as "unknown" in another.
function effectiveKindOf(row) {
  const declared = kindOf(row);
  if (declared) return declared;
  if (!row) return '';
  return row.type === 'eq' ? 'equipment' : 'location';
}

function allowedChildKinds(parentKind) {
  return [...(CHILD_KINDS[parentKind] || [])];
}

// Normalizes the single newest real inventory_ledger receipt for an item.
// Returns null when no purchase exists, so the UI can print "ثبت نشده".
function lastPurchaseDto(source) {
  if (!source || typeof source !== 'object') return null;
  const at = source.at == null ? null : new Date(source.at);
  return {
    at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
    entryNo: source.entryNo == null ? null : String(source.entryNo),
    qty: source.qty == null ? null : Number(source.qty),
    unitCost: source.unitCost == null ? null : Number(source.unitCost),
    note: source.note == null || source.note === '' ? null : String(source.note),
    movement: source.movement == null ? null : String(source.movement),
    warehouseId: source.warehouseId == null ? null : String(source.warehouseId),
    // No supplier column exists on inventory_ledger; never fabricate one.
    supplier: null,
    source: 'inventory_ledger'
  };
}

function relationStatus(parentKind, childKind) {
  if (parentKind === 'equipment' && childKind === 'sub-equipment') return 'legacy';
  if (CHILD_KINDS[parentKind]?.has(childKind)) return 'valid';
  return 'invalid';
}

function validateParentKind(childKind, parentKind) {
  if (!STRUCTURE_KINDS.has(String(childKind || ''))) throw coded(422, 'STRUCTURE_NODE_KIND_INVALID');
  if (!CHILD_KINDS[parentKind]?.has(childKind)) throw coded(422, 'STRUCTURE_PARENT_KIND_INVALID');
  return true;
}

function versionOf(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw coded(422, 'ROW_VERSION_REQUIRED');
  return version;
}

function requiredText(value, code, max = 500) {
  const result = text(value, max);
  if (!result) throw coded(422, code);
  return result;
}

function structureExt(input = {}, { nodeKind, allowNullInventory = false } = {}) {
  const nested = jsonObject(input.ext);
  const source = { ...nested };
  for (const key of [...EXT_TEXT_FIELDS, 'requiredQuantity', 'inventoryItemId']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) source[key] = input[key];
  }
  const result = {};
  if (nodeKind) result.nodeKind = nodeKind;
  for (const key of EXT_TEXT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = text(source[key], key === 'technicalSpecification' || key === 'structureNotes' ? 4000 : 240);
    if (value) result[key] = value;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'requiredQuantity')) {
    const raw = source.requiredQuantity;
    if (raw === '' || raw == null) {
      if (raw === null) result.requiredQuantity = null;
    } else {
      const quantity = Number(raw);
      if (!Number.isFinite(quantity) || quantity < 0 || quantity > 1_000_000_000) throw coded(422, 'REQUIRED_QUANTITY_INVALID');
      result.requiredQuantity = Math.round(quantity * 1000) / 1000;
    }
  }
  if (Object.prototype.hasOwnProperty.call(source, 'inventoryItemId')) {
    const id = text(source.inventoryItemId, 120);
    if (id) result.inventoryItemId = id;
    else if (allowNullInventory && (source.inventoryItemId === null || source.inventoryItemId === '')) result.inventoryItemId = null;
  }
  return result;
}

function validateStructureInput(input = {}, { requireParentVersion = false } = {}) {
  const errors = [];
  if (!text(input.name, 240)) errors.push('name');
  if (!STRUCTURE_KINDS.has(String(input.nodeKind || ''))) errors.push('nodeKind');
  if (!text(input.parentId, 120)) errors.push('parentId');
  if (requireParentVersion) {
    try { versionOf(input.parentRowVersion ?? input.parent_row_version); }
    catch (_) { errors.push('parentRowVersion'); }
  }
  if (input.code != null && text(input.code, 120) == null && String(input.code).trim() !== '') errors.push('code');
  if (input.requiredQuantity != null && input.requiredQuantity !== '') {
    const quantity = Number(input.requiredQuantity);
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > 1_000_000_000) errors.push('requiredQuantity');
  }
  return [...new Set(errors)];
}

function diagnostic(code, node, parent, message) {
  return {
    code,
    nodeId: node && node.id || null,
    parentId: parent && parent.id || node && node.parent_id || null,
    nodeKind: node && node.node_kind || null,
    parentKind: parent && parent.node_kind || null,
    message
  };
}

function buildStructureTree(root, rows = []) {
  const rootExt = jsonObject(root && root.ext);
  const rootNode = {
    id: root.id,
    code: root.code || null,
    name: root.name,
    nodeKind: 'equipment',
    level: 0,
    levelLabel: LEVEL_LABELS.equipment,
    parentId: root.parent || root.parent_id || null,
    rootEquipmentId: root.id,
    rowVersion: Number(root.row_version) || 1,
    archived: false,
    validRelation: true,
    path: [],
    children: []
  };
  const diagnostics = [];
  const indexed = new Map([[String(root.id), rootNode]]);
  const normalized = [];

  for (const source of rows || []) {
    if (source.cycle === true || source.is_cycle === true) {
      diagnostics.push(diagnostic('STRUCTURE_CYCLE', source, null, 'چرخه در روابط قدیمی شناسایی شد؛ رکورد حذف نشده است.'));
      continue;
    }
    if (String(source.id) === String(root.id)) continue;
    const ext = jsonObject(source.ext);
    const nodeKind = String(source.node_kind || ext.nodeKind || '');
    const row = {
      id: String(source.id),
      parent_id: source.parent_id || source.parent || null,
      code: source.code || null,
      name: source.name || '',
      node_kind: nodeKind,
      ext,
      status: source.status || null,
      cls: source.cls || null,
      maker: source.maker || null,
      model: source.model || null,
      serial: source.serial || null,
      row_version: Number(source.row_version) || 1,
      deleted_at: source.deleted_at || null,
      delete_reason: source.delete_reason || null,
      is_active: source.is_active !== false,
      sort_order: Number(source.sort_order) || 0,
      depth: Number(source.depth) || 1,
      inventory_item: source.inventory_item || null,
      stock_on_hand: source.stock_on_hand == null ? null : Number(source.stock_on_hand),
      stock_reserved: source.stock_reserved == null ? null : Number(source.stock_reserved),
      stock_available: source.stock_available == null ? null : Number(source.stock_available),
      last_purchase: source.last_purchase || null
    };
    normalized.push(row);
    indexed.set(row.id, {
      id: row.id,
      code: row.code,
      name: row.name,
      nodeKind: nodeKind || null,
      level: 0,
      levelLabel: LEVEL_LABELS[nodeKind] || 'نوع ثبت‌نشده',
      parentId: row.parent_id,
      rootEquipmentId: root.id,
      rowVersion: row.row_version,
      archived: !!row.deleted_at,
      deleteReason: row.delete_reason,
      status: row.status,
      cls: row.cls,
      maker: row.maker,
      model: row.model,
      serial: row.serial,
      componentType: ext.componentType || null,
      partNumber: ext.partNumber || null,
      brand: ext.brand || null,
      manufacturer: ext.manufacturer || null,
      technicalSpecification: ext.technicalSpecification || null,
      structureNotes: ext.structureNotes || null,
      requiredQuantity: ext.requiredQuantity == null ? null : Number(ext.requiredQuantity),
      inventoryItemId: ext.inventoryItemId || null,
      inventoryItem: row.inventory_item,
      // Real stock only: read from item_balances through active storage_locations/warehouses.
      // It is never typed by the user and never written back into structure fields.
      stockOnHand: row.inventory_item ? row.stock_on_hand : null,
      stockReserved: row.inventory_item ? row.stock_reserved : null,
      stockAvailable: row.inventory_item
        ? row.stock_available
        : null,
      // Real purchase only: the newest non-reversed 'receipt' row of inventory_ledger.
      // The schema stores no supplier on a receipt, so supplier stays null ("ثبت نشده")
      // instead of being invented.
      lastPurchase: lastPurchaseDto(row.last_purchase),
      validRelation: false,
      legacy: false,
      path: [],
      children: [],
      _row: row
    });
  }

  const duplicateCodes = new Map();
  for (const node of [rootNode, ...[...indexed.values()].filter(item => item !== rootNode)]) {
    if (!node.code) continue;
    const key = String(node.code).trim().toLocaleLowerCase('en');
    if (duplicateCodes.has(key)) {
      const prior = duplicateCodes.get(key);
      diagnostics.push(diagnostic('DUPLICATE_STRUCTURE_CODE', node, prior, 'کد تکراری در ساختار موجود است؛ داده حفظ شده و برای اصلاح گزارش می‌شود.'));
    } else duplicateCodes.set(key, node);
  }

  for (const row of normalized) {
    const node = indexed.get(row.id);
    const parent = indexed.get(String(row.parent_id));
    if (!row.node_kind) {
      diagnostics.push(diagnostic('STRUCTURE_NODE_KIND_MISSING', row, parent, 'نوع گره در دادهٔ قدیمی ثبت نشده است؛ رکورد حفظ شده است.'));
    } else if (!INTERNAL_KINDS.has(row.node_kind)) {
      diagnostics.push(diagnostic('STRUCTURE_NODE_KIND_UNSUPPORTED', row, parent, 'نوع گره با ساختار داخلی پشتیبانی‌شده سازگار نیست؛ رکورد حفظ شده است.'));
    }
    if (!parent) {
      diagnostics.push(diagnostic('STRUCTURE_PARENT_OUTSIDE_SCOPE', row, null, 'والد این رکورد در Scope تجهیز جاری پیدا نشد؛ رکورد حذف نشده است.'));
      continue;
    }
    const relation = relationStatus(parent.nodeKind, node.nodeKind);
    node.validRelation = relation === 'valid';
    node.legacy = relation === 'legacy';
    if (relation === 'invalid') {
      diagnostics.push(diagnostic('STRUCTURE_PARENT_KIND_INVALID', row, parent, 'رابطهٔ والد و فرزند با زنجیرهٔ مجاز هم‌خوان نیست؛ رکورد حفظ شده است.'));
    } else if (relation === 'legacy') {
      diagnostics.push(diagnostic('LEGACY_SUB_EQUIPMENT', row, parent, 'رکورد زیرتجهیز قدیمی حفظ شده و فقط برای سازگاری نمایش داده می‌شود.'));
    }
    node.level = (parent.level || 0) + 1;
    const parentPath = Array.isArray(parent.path) ? parent.path : [];
    node.path = parentPath.concat({ id: node.id, code: node.code, name: node.name, nodeKind: node.nodeKind });
    parent.children.push(node);
  }

  const sortNodes = nodes => nodes.sort((left, right) => {
    const a = Number(left._row?.sort_order) || 0;
    const b = Number(right._row?.sort_order) || 0;
    return a - b || String(left.code || left.name).localeCompare(String(right.code || right.name), 'fa');
  }).forEach(node => {
    sortNodes(node.children);
    delete node._row;
  });
  sortNodes(rootNode.children);

  const diagnosticsByNode = new Map();
  for (const item of diagnostics) {
    if (!item.nodeId) continue;
    if (!diagnosticsByNode.has(item.nodeId)) diagnosticsByNode.set(item.nodeId, []);
    diagnosticsByNode.get(item.nodeId).push(item);
  }
  for (const [id, items] of diagnosticsByNode) {
    const node = indexed.get(id);
    if (node) node.diagnostics = items;
  }
  return {
    root: rootNode,
    nodes: rootNode.children,
    diagnostics,
    nodeCount: normalized.length,
    orphaned: normalized.filter(row => !indexed.get(row.id)?.parentId || !indexed.has(String(indexed.get(row.id).parentId))).map(row => ({
      id: row.id, code: row.code, name: row.name, nodeKind: row.node_kind || null, parentId: row.parent_id
    }))
  };
}

async function hasPermission({ pool, security, user, permission }) {
  if (!user) return false;
  if (security && typeof security.hasPermission === 'function') return !!(await security.hasPermission(user, permission));
  const executor = pool;
  const { rows } = await executor.query(
    `SELECT 1 FROM role_permissions
     WHERE role=$1 AND granted=true AND (permission=$2 OR permission='*') LIMIT 1`,
    [user.role, permission]
  );
  return !!rows[0];
}

async function assertPermission(context, permission) {
  if (!(await hasPermission({ ...context, permission }))) throw coded(403, 'PERMISSION_DENIED');
}

async function getFactoryId(client, rootId) {
  const { rows } = await client.query(
    `WITH RECURSIVE ancestry AS (
       SELECT a.id,a.parent,a.ext->>'nodeKind' AS node_kind,0 AS depth,ARRAY[a.id]::text[] AS path
       FROM assets a WHERE a.id=$1
       UNION ALL
       SELECT p.id,p.parent,p.ext->>'nodeKind',ancestry.depth+1,ancestry.path||p.id
       FROM assets p JOIN ancestry ON ancestry.parent=p.id
       WHERE ancestry.depth<64 AND NOT p.id=ANY(ancestry.path)
     )
     SELECT COALESCE(c.factory_asset_id,
       (SELECT id FROM ancestry WHERE node_kind='factory' ORDER BY depth DESC LIMIT 1)) AS factory_id
     FROM assets root LEFT JOIN asset_categories c ON c.id=root.category_id WHERE root.id=$1`,
    [rootId]
  );
  return rows[0]?.factory_id || null;
}

// Legacy equipment rows created before the digital dossier never stored ext->>'nodeKind';
// only location rows (factory/site/area/line/unit/category) carry an explicit nodeKind.
// The registry has always read those assets as equipment through
// COALESCE(ext->>'nodeKind','equipment'), so the structure resolver must apply exactly the
// same fallback. Without it every real legacy equipment record resolved to "no root" and the
// dossier answered ROOT_EQUIPMENT_NOT_FOUND even though the row exists and is visible in the list.
async function resolveRootEquipment(client, assetId) {
  const { rows } = await client.query(
    `WITH RECURSIVE ancestry AS (
       SELECT a.id,a.parent,a.type,COALESCE(NULLIF(a.ext->>'nodeKind',''),'equipment') AS node_kind,
         a.category_id,0 AS depth,ARRAY[a.id]::text[] AS path
       FROM assets a WHERE a.id=$1
       UNION ALL
       SELECT p.id,p.parent,p.type,COALESCE(NULLIF(p.ext->>'nodeKind',''),'equipment'),p.category_id,
         ancestry.depth+1,ancestry.path||p.id
       FROM assets p JOIN ancestry ON ancestry.parent=p.id
       WHERE ancestry.depth<64 AND NOT p.id=ANY(ancestry.path)
     )
     SELECT id,parent,type,node_kind,category_id,depth FROM ancestry
     WHERE node_kind IN ('equipment','sub-equipment')
     ORDER BY CASE WHEN node_kind='equipment' THEN 0 ELSE 1 END,depth DESC LIMIT 1`,
    [assetId]
  );
  return rows[0] || null;
}

// The structure API is addressed by the real PostgreSQL assets.id that the equipment list
// already returns. An empty identifier or a location/registry node is rejected explicitly;
// only a genuinely missing (or archived) equipment row yields 404.
async function rootEquipmentById(client, rootId) {
  const identifier = rootId == null ? '' : String(rootId).trim();
  if (!identifier || identifier.length > 200) throw coded(404, 'EQUIPMENT_NOT_FOUND');
  const { rows } = await client.query(
    `SELECT id,parent,code,name,type,category_id,ext,row_version,deleted_at
     FROM assets WHERE id=$1`, [identifier]
  );
  const row = rows[0];
  if (!row) throw coded(404, 'EQUIPMENT_NOT_FOUND');
  if (row.deleted_at) throw coded(404, 'EQUIPMENT_NOT_FOUND');
  // type='eq' with no explicit nodeKind is a real equipment record: keep it working.
  const kind = effectiveKindOf(row);
  if (row.type !== 'eq' || !STRUCTURE_ROOT_KINDS.has(kind)) throw coded(404, 'ROOT_EQUIPMENT_NOT_FOUND');
  const resolved = await resolveRootEquipment(client, identifier);
  // An existing root equipment without any child is valid: it resolves to itself.
  if (!resolved) throw coded(404, 'ROOT_EQUIPMENT_NOT_FOUND');
  if (String(resolved.id) !== String(identifier)) throw coded(404, 'PARENT_OUTSIDE_ROOT_EQUIPMENT');
  return { ...row, node_kind: kind, factory_id: await getFactoryId(client, identifier) };
}

async function assertEquipmentScope(client, user, rootId, factoryId = null) {
  if (!user) throw coded(401, 'AUTHENTICATION_REQUIRED');
  if (user.role === 'admin') return true;
  const factory = factoryId || await getFactoryId(client, rootId);
  const { rows } = await client.query(
    `SELECT 1 FROM user_scopes WHERE user_id=$1 AND (
       scope_type='company' OR (scope_type='equipment' AND scope_id=$2)
       OR ($3::text IS NOT NULL AND scope_type='factory' AND scope_id=$3)
     ) LIMIT 1`,
    [user.id, rootId, factory]
  );
  if (!rows[0]) throw coded(403, 'EQUIPMENT_SCOPE_DENIED');
  return true;
}

async function rootForAsset(client, user, assetId, { requireActive = true } = {}) {
  const resolved = await resolveRootEquipment(client, assetId);
  if (!resolved) throw coded(404, 'EQUIPMENT_NOT_FOUND');
  const root = await rootEquipmentById(client, resolved.id);
  if (requireActive && root.deleted_at) throw coded(404, 'EQUIPMENT_NOT_FOUND');
  await assertEquipmentScope(client, user, root.id, root.factory_id);
  return root;
}

async function lockAsset(client, id, { includeArchived = false } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM assets WHERE id=$1${includeArchived ? '' : ' AND deleted_at IS NULL'} FOR UPDATE`, [id]
  );
  if (!rows[0] || (!includeArchived && rows[0].deleted_at)) throw coded(404, 'STRUCTURE_NODE_NOT_FOUND');
  return rows[0];
}

async function assertInventoryItem(client, itemId) {
  if (!itemId) return null;
  const { rows } = await client.query(
    'SELECT id,code,name,unit,part_type,ext FROM items WHERE id=$1 AND deleted_at IS NULL FOR KEY SHARE', [itemId]
  );
  if (!rows[0]) throw coded(422, 'INVENTORY_ITEM_NOT_FOUND');
  return rows[0];
}

async function assertUniqueCode(client, code, currentId = null) {
  const clean = text(code, 120);
  if (!clean) return;
  const { rows } = await client.query(
    `SELECT id FROM assets WHERE lower(code)=lower($1) AND ($2::text IS NULL OR id<>$2) LIMIT 1`, [clean, currentId]
  );
  if (rows[0]) throw coded(409, 'DUPLICATE_CODE');
}

async function writeAudit(client, user, action, entityId, note, before, after) {
  await client.query(
    `INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after)
     VALUES($1,now(),$2,$3,$4,$5,'equipment-structure',$6,$7,$8,$9)`,
    [uuid(), user.name || user.username || user.id, user.id, user.role || '', action, entityId,
      text(note, 500) || '', before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
    catch (_) { return []; }
  }
  return [];
}

async function publishStructureEvent(client, user, roots, action, node) {
  const uniqueRoots = [...new Set((roots || []).filter(Boolean).map(String))];
  for (const rootId of uniqueRoots) {
    const factoryId = await getFactoryId(client, rootId);
    const { rows } = await client.query(
      `SELECT u.id,u.role,
        COALESCE((SELECT jsonb_agg(rp.permission) FROM role_permissions rp WHERE rp.role=u.role AND rp.granted=true),'[]'::jsonb) AS permissions,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('scope_type',s.scope_type,'scope_id',s.scope_id))
          FROM user_scopes s WHERE s.user_id=u.id),'[]'::jsonb) AS scopes
       FROM users u WHERE u.active IS TRUE`
    );
    const recipients = rows.filter(row => isRecipientAllowed(
      { ...row, permissions: asArray(row.permissions), scopes: asArray(row.scopes) },
      'equipment.structure.view', rootId, factoryId
    )).map(row => row.id);
    await client.query(
      `INSERT INTO event_outbox(id,event_type,aggregate_type,aggregate_id,actor_id,payload,recipient_ids)
       VALUES($1,'equipment.structure.changed','equipment',$2,$3,$4,$5)`,
      [crypto.randomUUID(), rootId, user.id,
        JSON.stringify({ action, rootEquipmentId: rootId, nodeId: node.id, nodeKind: kindOf(node) || null, rowVersion: Number(node.row_version) || null }),
        JSON.stringify(recipients)]
    );
  }
}

async function parentForNode(client, parentId, childKind) {
  const parent = await lockAsset(client, parentId);
  const parentKind = effectiveKindOf(parent);
  validateParentKind(childKind, parentKind);
  return { row: parent, kind: parentKind };
}

async function bumpParentVersion(client, parent, user) {
  const { rows } = await client.query(
    `UPDATE assets SET row_version=row_version+1,updated_by=$2,updated_at=now()
     WHERE id=$1 AND deleted_at IS NULL RETURNING row_version`, [parent.id, user.id]
  );
  if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
  return Number(rows[0].row_version);
}

async function getStructure({ pool, security, user, rootEquipmentId, includeArchived = false }) {
  const permissionContext = { pool, security, user };
  await assertPermission(permissionContext, 'equipment.structure.view');
  const root = await rootEquipmentById(pool, rootEquipmentId);
  await assertEquipmentScope(pool, user, root.id, root.factory_id);
  const { rows } = await pool.query(
    `WITH RECURSIVE structure AS (
       SELECT a.id,a.parent AS parent_id,a.code,a.name,a.type,a.status,a.cls,a.maker,a.model,a.serial,
         a.ext,a.row_version,a.deleted_at,a.delete_reason,a.is_active,a.sort_order,0 AS depth,
         ARRAY[a.id]::text[] AS path,false AS cycle
       FROM assets a WHERE a.id=$1 AND a.deleted_at IS NULL
       UNION ALL
       SELECT child.id,child.parent,child.code,child.name,child.type,child.status,child.cls,child.maker,
         child.model,child.serial,child.ext,child.row_version,child.deleted_at,child.delete_reason,
         child.is_active,child.sort_order,structure.depth+1,structure.path||child.id,
         child.id=ANY(structure.path)
       FROM assets child JOIN structure ON child.parent=structure.id
       WHERE child.type='eq' AND ($2::boolean OR child.deleted_at IS NULL)
         AND structure.depth<64 AND NOT structure.cycle
     )
     SELECT structure.*,
       CASE WHEN inventory.id IS NULL THEN NULL ELSE jsonb_build_object(
         'id',inventory.id,'code',inventory.code,'name',inventory.name,'unit',inventory.unit,
         'partType',inventory.part_type,'manufacturer',COALESCE(inventory.ext->>'manufacturer',inventory.ext->>'maker'),
         'partNumber',COALESCE(inventory.ext->>'partNumber',inventory.code),
         'specification',COALESCE(inventory.ext->>'technicalSpecification',inventory.ext->>'specification'),
         'available',COALESCE(availability.available,0),'archived',inventory.deleted_at IS NOT NULL
       ) END AS inventory_item,
       availability.on_hand AS stock_on_hand,
       availability.reserved AS stock_reserved,
       availability.available AS stock_available,
       CASE WHEN inventory.id IS NULL OR purchase.entry_no IS NULL THEN NULL ELSE jsonb_build_object(
         'at',purchase.created_at,'entryNo',purchase.entry_no,'qty',purchase.qty,
         'unitCost',purchase.unit_cost,'note',purchase.note,'movement',purchase.movement,
         'warehouseId',purchase.warehouse_id
       ) END AS last_purchase
     FROM structure
     LEFT JOIN items inventory ON inventory.id=structure.ext->>'inventoryItemId'
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(CASE WHEN location.id IS NOT NULL AND warehouse.id IS NOT NULL
         THEN balance.on_hand-balance.reserved ELSE 0 END),0) AS available,
         COALESCE(SUM(CASE WHEN location.id IS NOT NULL AND warehouse.id IS NOT NULL
         THEN balance.on_hand ELSE 0 END),0) AS on_hand,
         COALESCE(SUM(CASE WHEN location.id IS NOT NULL AND warehouse.id IS NOT NULL
         THEN balance.reserved ELSE 0 END),0) AS reserved
       FROM item_balances balance
       LEFT JOIN storage_locations location ON location.id=balance.location_id AND location.deleted_at IS NULL
       LEFT JOIN warehouses warehouse ON warehouse.id=location.warehouse_id AND warehouse.deleted_at IS NULL AND warehouse.active=true
       WHERE balance.item_id=inventory.id
     ) availability ON true
     LEFT JOIN LATERAL (
       SELECT receipt.created_at,receipt.entry_no,receipt.qty,receipt.unit_cost,receipt.note,
         receipt.movement,receipt.warehouse_id
       FROM inventory_ledger receipt
       WHERE receipt.item_id=inventory.id AND receipt.movement='receipt'
         AND NOT EXISTS (
           SELECT 1 FROM inventory_ledger reversal
           WHERE reversal.reverses_entry_id=receipt.id
         )
       ORDER BY receipt.created_at DESC,receipt.entry_no DESC LIMIT 1
     ) purchase ON true
     WHERE structure.depth>0
     ORDER BY structure.depth,structure.sort_order,structure.name`,
    [root.id, !!includeArchived]
  );
  const built = buildStructureTree(root, rows);
  const capabilities = {};
  for (const [key, permission] of Object.entries({
    create: 'equipment.structure.create',
    update: 'equipment.structure.update',
    move: 'equipment.structure.move',
    moveAcrossEquipment: 'equipment.structure.move_cross_equipment',
    archive: 'equipment.structure.archive',
    suggest: 'equipment.structure.suggest',
    approveAi: 'equipment.structure.approve_ai',
    inventoryView: 'inventory.view'
  })) capabilities[key] = await hasPermission({ ...permissionContext, permission });
  let suggestions = [];
  if (capabilities.suggest || capabilities.approveAi) {
    const result = await pool.query(
      `SELECT id,action_type,destination,proposed,source,evidence,confidence,missing_fields,conflicting_fields,
        status,record_version,target_id,created_by,created_at,updated_at,row_version
       FROM selene_action_drafts
       WHERE action_type='equipment.structure.add' AND proposed->>'rootEquipmentId'=$1
         AND status IN ('incomplete','conflict','pending')
         AND ($2::boolean OR created_by=$3)
       ORDER BY updated_at DESC LIMIT 100`,
      [root.id, capabilities.approveAi, user.id]
    );
    suggestions = result.rows.map(row => ({
      id: row.id, actionType: row.action_type, destination: row.destination, proposed: row.proposed,
      source: row.source, evidence: row.evidence, confidence: row.confidence == null ? null : Number(row.confidence),
      missingFields: row.missing_fields, conflictingFields: row.conflicting_fields, status: row.status,
      recordVersion: row.record_version == null ? null : Number(row.record_version), targetId: row.target_id,
      createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, rowVersion: Number(row.row_version)
    }));
  }
  return {
    rootEquipmentId: root.id,
    root: { id: root.id, code: root.code, name: root.name, nodeKind: 'equipment', rowVersion: Number(root.row_version) || 1 },
    nodes: built.nodes,
    orphaned: built.orphaned,
    diagnostics: built.diagnostics,
    nodeCount: built.nodeCount,
    includeArchived: !!includeArchived,
    capabilities,
    suggestions
  };
}

async function createStructureNode({ client, pool, security, user, rootEquipmentId, input = {}, permission = 'equipment.structure.create' }) {
  await assertPermission({ pool, security, user }, permission);
  const errors = validateStructureInput(input, { requireParentVersion: true });
  if (errors.length) throw Object.assign(coded(422, 'VALIDATION_ERROR'), { fields: errors });
  const kind = String(input.nodeKind);
  const name = requiredText(input.name, 'NAME_REQUIRED', 240);
  const code = text(input.code, 120);
  const parentId = requiredText(input.parentId, 'PARENT_NOT_FOUND', 120);
  const parentVersion = versionOf(input.parentRowVersion ?? input.parent_row_version);
  const extPatch = structureExt(input, { nodeKind: kind });
  const item = await assertInventoryItem(client, extPatch.inventoryItemId);
  const resolvedRootId = rootEquipmentId
    || (await resolveRootEquipment(client, parentId) || {}).id
    || null;
  if (!resolvedRootId) throw coded(422, 'ROOT_EQUIPMENT_NOT_FOUND');
  const root = await rootEquipmentById(client, resolvedRootId);
  await assertEquipmentScope(client, user, root.id, root.factory_id);
  const parent = await parentForNode(client, parentId, kind);
  const parentRoot = await rootForAsset(client, user, parent.row.id);
  if (String(parentRoot.id) !== String(root.id)) throw coded(422, 'PARENT_OUTSIDE_ROOT_EQUIPMENT');
  if (Number(parent.row.row_version) !== parentVersion) throw coded(409, 'VERSION_CONFLICT');
  await assertUniqueCode(client, code);
  const nodeId = uuid();
  const { rows } = await client.query(
    `INSERT INTO assets(id,parent,code,name,type,cls,status,crit,maker,model,serial,ext,category_id,sort_order,
       is_active,record_status,updated_by,updated_at)
     VALUES($1,$2,$3,$4,'eq',$5,'active',$6,$7,$8,$9,$10::jsonb,$11,$12,true,'complete',$13,now()) RETURNING *`,
    [nodeId, parent.row.id, code, name, text(input.cls, 180), text(input.crit, 20), text(input.maker || input.manufacturer, 180),
      text(input.model, 180), text(input.serial, 180), JSON.stringify(extPatch), root.category_id || null,
      Number(input.sortOrder) || 0, user.id]
  );
  const parentRowVersion = await bumpParentVersion(client, parent.row, user);
  const data = { ...rows[0], rootEquipmentId: root.id, parentRowVersion };
  await writeAudit(client, user, 'structure-create', nodeId, 'ایجاد جزء ساختاری در پرونده تجهیز', null, data);
  await publishStructureEvent(client, user, [root.id], 'create', rows[0]);
  return data;
}

async function updateStructureNode({ client, pool, security, user, id, input = {} }) {
  await assertPermission({ pool, security, user }, 'equipment.structure.update');
  const rowVersion = versionOf(input.rowVersion ?? input.row_version);
  const current = await lockAsset(client, id);
  const currentKind = kindOf(current);
  if (!isInternalKind(currentKind)) throw coded(404, 'STRUCTURE_NODE_NOT_FOUND');
  if (input.nodeKind && String(input.nodeKind) !== currentKind) throw coded(422, 'NODE_KIND_IMMUTABLE');
  if (input.parentId != null && String(input.parentId) !== String(current.parent || '')) throw coded(422, 'MOVE_ENDPOINT_REQUIRED');
  if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
  const root = await rootForAsset(client, user, current.id);
  if (input.rootEquipmentId && String(input.rootEquipmentId) !== String(root.id)) throw coded(422, 'ROOT_EQUIPMENT_MISMATCH');
  const extPatch = structureExt(input, { nodeKind: currentKind, allowNullInventory: true });
  if (Object.prototype.hasOwnProperty.call(input, 'inventoryItemId') || Object.prototype.hasOwnProperty.call(jsonObject(input.ext), 'inventoryItemId')) {
    await assertInventoryItem(client, extPatch.inventoryItemId);
  }
  const sets = [];
  const values = [current.id];
  const columns = {
    name: ['name', 240], code: ['code', 120], cls: ['cls', 180], status: ['status', 80],
    crit: ['crit', 20], maker: ['maker', 180], manufacturer: ['maker', 180], model: ['model', 180], serial: ['serial', 180]
  };
  const seenColumns = new Set();
  for (const [key, [column, max]] of Object.entries(columns)) {
    if (!Object.prototype.hasOwnProperty.call(input, key) || seenColumns.has(column)) continue;
    seenColumns.add(column);
    const clean = text(input[key], max);
    if (clean == null) continue;
    if (column === 'name' && !clean) throw coded(422, 'NAME_REQUIRED');
    if (column === 'code') await assertUniqueCode(client, clean, current.id);
    values.push(clean);
    sets.push(`${column}=$${values.length}`);
  }
  if (Object.keys(extPatch).length) {
    values.push(JSON.stringify(extPatch));
    sets.push(`ext=COALESCE(ext,'{}'::jsonb)||$${values.length}::jsonb`);
  }
  if (!sets.length) throw coded(422, 'NO_EDITABLE_FIELDS');
  values.push(user.id, rowVersion);
  const { rows } = await client.query(
    `UPDATE assets SET ${sets.join(',')},updated_by=$${values.length - 1},row_version=row_version+1,updated_at=now()
     WHERE id=$1 AND deleted_at IS NULL AND row_version=$${values.length} RETURNING *`, values
  );
  if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
  await writeAudit(client, user, 'structure-edit', current.id, 'ویرایش جزء ساختاری', current, rows[0]);
  await publishStructureEvent(client, user, [root.id], 'edit', rows[0]);
  return { ...rows[0], rootEquipmentId: root.id };
}

async function isDescendant(client, nodeId, possibleAncestorId) {
  const { rows } = await client.query(
    `WITH RECURSIVE ancestry AS (
       SELECT id,parent,ARRAY[id]::text[] AS path,0 AS depth FROM assets WHERE id=$1
       UNION ALL
       SELECT parent_asset.id,parent_asset.parent,ancestry.path||parent_asset.id,ancestry.depth+1
       FROM assets parent_asset JOIN ancestry ON ancestry.parent=parent_asset.id
       WHERE ancestry.depth<64 AND NOT parent_asset.id=ANY(ancestry.path)
     ) SELECT 1 FROM ancestry WHERE id=$2 LIMIT 1`,
    [nodeId, possibleAncestorId]
  );
  return !!rows[0];
}

async function moveStructureNode({ client, pool, security, user, id, input = {} }) {
  const rowVersion = versionOf(input.rowVersion ?? input.row_version);
  const reason = requiredText(input.reason, 'MOVE_REASON_REQUIRED', 500);
  const targetPreview = await client.query('SELECT id,parent,type,ext,category_id FROM assets WHERE id=$1 AND deleted_at IS NULL', [id]);
  const preview = targetPreview.rows[0];
  if (!preview || !isInternalKind(kindOf(preview))) throw coded(404, 'STRUCTURE_NODE_NOT_FOUND');
  const parentId = requiredText(input.parentId, 'PARENT_NOT_FOUND', 120);
  if (String(parentId) === String(id)) throw coded(422, 'TREE_CYCLE');
  const sourceRootPreview = await resolveRootEquipment(client, id);
  const destinationRootPreview = await resolveRootEquipment(client, parentId);
  if (!sourceRootPreview || !destinationRootPreview) throw coded(422, 'ROOT_EQUIPMENT_NOT_FOUND');
  const isCrossEquipment = String(sourceRootPreview.id) !== String(destinationRootPreview.id);
  if (isCrossEquipment) {
    if (input.confirmCrossEquipment !== true) throw coded(422, 'CROSS_EQUIPMENT_CONFIRMATION_REQUIRED');
    await assertPermission({ pool, security, user }, 'equipment.structure.move_cross_equipment');
  } else {
    await assertPermission({ pool, security, user }, 'equipment.structure.move');
  }
  const roots = [sourceRootPreview.id, destinationRootPreview.id].map(String).sort();
  await client.query('SELECT id FROM assets WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [roots]);
  const current = await lockAsset(client, id);
  if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
  const sourceRoot = await rootForAsset(client, user, id);
  const destinationRoot = await rootForAsset(client, user, parentId);
  if (String(sourceRoot.id) !== String(sourceRootPreview.id) || String(destinationRoot.id) !== String(destinationRootPreview.id)) {
    throw coded(409, 'STRUCTURE_ROOT_CHANGED');
  }
  const parentRow = await lockAsset(client, parentId);
  if (await isDescendant(client, parentId, current.id)) throw coded(422, 'TREE_CYCLE');
  validateParentKind(kindOf(current), effectiveKindOf(parentRow));
  const parent = { row: parentRow, kind: effectiveKindOf(parentRow) };
  const code = current.code || null;
  await assertUniqueCode(client, code, current.id);
  const { rows } = await client.query(
    `UPDATE assets SET parent=$2,sort_order=$3,category_id=$4,updated_by=$5,row_version=row_version+1,updated_at=now()
     WHERE id=$1 AND row_version=$6 AND deleted_at IS NULL RETURNING *`,
    [current.id, parent.row.id, Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : Number(current.sort_order) || 0,
      isCrossEquipment ? destinationRoot.category_id || null : current.category_id || null, user.id, rowVersion]
  );
  if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
  if (String(current.parent) !== String(parent.row.id)) {
    const oldParent = await client.query('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [current.parent]);
    if (oldParent.rows[0]) await bumpParentVersion(client, oldParent.rows[0], user);
    if (!oldParent.rows[0] || String(oldParent.rows[0].id) !== String(parent.row.id)) await bumpParentVersion(client, parent.row, user);
  }
  await writeAudit(client, user, isCrossEquipment ? 'structure-cross-equipment-move' : 'structure-move', current.id,
    reason, current, { ...rows[0], sourceRootEquipmentId: sourceRoot.id, rootEquipmentId: destinationRoot.id });
  await publishStructureEvent(client, user, [sourceRoot.id, destinationRoot.id], isCrossEquipment ? 'cross-equipment-move' : 'move', rows[0]);
  return { ...rows[0], sourceRootEquipmentId: sourceRoot.id, rootEquipmentId: destinationRoot.id, crossEquipment: isCrossEquipment };
}

async function archiveStructureNode({ client, pool, security, user, id, input = {} }) {
  await assertPermission({ pool, security, user }, 'equipment.structure.archive');
  const reason = requiredText(input.reason, 'ARCHIVE_REASON_REQUIRED', 500);
  const rowVersion = versionOf(input.rowVersion ?? input.row_version);
  const current = await lockAsset(client, id);
  if (!isInternalKind(kindOf(current))) throw coded(404, 'STRUCTURE_NODE_NOT_FOUND');
  if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
  const root = await rootForAsset(client, user, current.id);
  const children = await client.query('SELECT count(*)::int AS count FROM assets WHERE parent=$1 AND deleted_at IS NULL', [id]);
  if (Number(children.rows[0]?.count) > 0) throw coded(409, 'HAS_ACTIVE_CHILDREN');
  const { rows } = await client.query(
    `UPDATE assets SET is_active=false,deleted_at=now(),deleted_by=$2,delete_reason=$3,updated_by=$2,
       row_version=row_version+1,updated_at=now()
     WHERE id=$1 AND row_version=$4 AND deleted_at IS NULL RETURNING *`,
    [id, user.id, reason, rowVersion]
  );
  if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
  const parent = await client.query('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [current.parent]);
  if (parent.rows[0]) await bumpParentVersion(client, parent.rows[0], user);
  await writeAudit(client, user, 'structure-archive', id, reason, current, rows[0]);
  await publishStructureEvent(client, user, [root.id], 'archive', rows[0]);
  return { ...rows[0], rootEquipmentId: root.id, historyPreserved: true };
}

async function restoreStructureNode({ client, pool, security, user, id, input = {} }) {
  await assertPermission({ pool, security, user }, 'equipment.structure.archive');
  const reason = requiredText(input.reason, 'RESTORE_REASON_REQUIRED', 500);
  const rowVersion = versionOf(input.rowVersion ?? input.row_version);
  const current = await lockAsset(client, id, { includeArchived: true });
  if (!current.deleted_at || !isInternalKind(kindOf(current))) throw coded(409, 'STRUCTURE_NODE_NOT_ARCHIVED');
  if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
  const root = await rootForAsset(client, user, current.id);
  const parent = await parentForNode(client, current.parent, kindOf(current));
  if (parent.row.deleted_at) throw coded(409, 'PARENT_ARCHIVED');
  await assertUniqueCode(client, current.code, current.id);
  const { rows } = await client.query(
    `UPDATE assets SET is_active=true,deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,updated_by=$2,
       row_version=row_version+1,updated_at=now()
     WHERE id=$1 AND row_version=$3 AND deleted_at IS NOT NULL RETURNING *`,
    [id, user.id, rowVersion]
  );
  if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
  await bumpParentVersion(client, parent.row, user);
  await writeAudit(client, user, 'structure-restore', id, reason, current, rows[0]);
  await publishStructureEvent(client, user, [root.id], 'restore', rows[0]);
  return { ...rows[0], rootEquipmentId: root.id, historyPreserved: true };
}

async function assertDraftScope(pool, user, draft) {
  const proposed = jsonObject(draft && draft.proposed);
  const rootId = proposed.rootEquipmentId;
  if (!rootId) return false;
  try {
    await assertEquipmentScope(pool, user, rootId);
    return true;
  } catch (_) { return false; }
}

module.exports = {
  STRUCTURE_KINDS,
  INTERNAL_KINDS,
  STRUCTURE_ROOT_KINDS,
  CHILD_KINDS,
  LEVEL_LABELS,
  isStructureKind,
  isInternalKind,
  kindOf,
  effectiveKindOf,
  allowedChildKinds,
  relationStatus,
  validateParentKind,
  versionOf,
  structureExt,
  validateStructureInput,
  buildStructureTree,
  lastPurchaseDto,
  hasPermission,
  assertPermission,
  resolveRootEquipment,
  rootEquipmentById,
  assertEquipmentScope,
  rootForAsset,
  getStructure,
  createStructureNode,
  updateStructureNode,
  moveStructureNode,
  archiveStructureNode,
  restoreStructureNode,
  assertDraftScope
};
