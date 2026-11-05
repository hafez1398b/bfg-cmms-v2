'use strict';

// Mission D4 / Phase 3 — critical spare parts of the digital equipment dossier.
// Links live in the existing asset_spare_parts table (asset_id, item_id) and always point at
// real inventory master data (items). A link targets the equipment root (general spares) or
// one of its internal components; a CRITICAL part (relation_type='key-spare') may only target
// a main-component or sub-component of the dossier structure. Stock is read-only and comes
// exclusively from item_balances on active warehouses/storage_locations; the last purchase
// comes from the newest non-reversed inventory_ledger receipt. Nothing is typed or fabricated.
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const structure = require('./equipment-structure');
const { isRecipientAllowed } = require('./maintenance-service');
const { coded } = require('./equipment-service');

const RELATION_TYPES = Object.freeze({
  'key-spare': 'قطعه یدکی حیاتی',
  'general-spare': 'قطعه یدکی عمومی'
});
const CRITICAL_TARGET_KINDS = Object.freeze(['main-component', 'sub-component']);
const MAX_QUANTITY = 1_000_000_000;

function cleanText(value, max = 2000) {
  if (value == null) return null;
  const normalized = String(value).replace(/[\u0000-\u001f]/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function versionOf(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw coded(422, 'ROW_VERSION_REQUIRED');
  return version;
}

function reasonOf(value, code) {
  const reason = cleanText(value, 500);
  if (!reason) throw coded(422, code);
  return reason;
}

// Validates the writable link fields. itemId and the target are immutable after creation:
// changing either means archiving (soft) and linking again, so history stays truthful.
function validateLinkInput(input, { partial = false } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const errors = [];
  const values = {};
  if (!partial || Object.prototype.hasOwnProperty.call(source, 'itemId')) {
    const itemId = cleanText(source.itemId, 120);
    if (!itemId) errors.push({ field: 'itemId', code: 'INVENTORY_ITEM_REQUIRED' });
    else values.itemId = itemId;
  }
  if (!partial || Object.prototype.hasOwnProperty.call(source, 'relationType')) {
    const relationType = source.relationType == null || source.relationType === ''
      ? (partial ? undefined : 'key-spare')
      : String(source.relationType);
    if (relationType !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(RELATION_TYPES, relationType)) {
        errors.push({ field: 'relationType', code: 'SPARE_RELATION_TYPE_INVALID' });
      } else values.relationType = relationType;
    }
  }
  if (Object.prototype.hasOwnProperty.call(source, 'quantityRequired')) {
    const raw = source.quantityRequired;
    if (raw == null || raw === '') values.quantityRequired = null;
    else {
      const quantity = Number(raw);
      if (!Number.isFinite(quantity) || quantity < 0 || quantity > MAX_QUANTITY) {
        errors.push({ field: 'quantityRequired', code: 'REQUIRED_QUANTITY_INVALID' });
      } else values.quantityRequired = quantity;
    }
  }
  if (Object.prototype.hasOwnProperty.call(source, 'notes')) {
    values.notes = cleanText(source.notes, 2000);
  }
  return { errors, values };
}

function relationLabelOf(relationType) {
  return RELATION_TYPES[relationType] || relationType || null;
}

function targetKindAtDepth(depth) {
  const value = Number(depth);
  if (value === 0) return 'equipment';
  return structure.canonicalKindAtDepth(value);
}

// Stock numbers are aggregated from item_balances exactly like the structure dossier reads
// them; a missing balance is a real zero, never an invented quantity. min_stock stays null
// when the item master has no recorded minimum so the UI can print «ثبت نشده».
function spareDto(row) {
  const itemExt = row.item_ext && typeof row.item_ext === 'object' ? row.item_ext : {};
  const archived = !!row.deleted_at;
  const targetDepth = Number(row.target_depth);
  const targetKind = Number.isInteger(targetDepth) ? targetKindAtDepth(targetDepth) : null;
  return {
    itemId: String(row.item_id),
    targetId: String(row.asset_id),
    target: {
      id: String(row.asset_id),
      code: row.target_code || null,
      name: row.target_name || null,
      kind: targetKind,
      label: targetKind ? (structure.LEVEL_LABELS[targetKind] || targetKind) : null,
      criticalAllowed: CRITICAL_TARGET_KINDS.includes(targetKind)
    },
    code: row.code || null,
    name: row.name || null,
    unit: row.unit || null,
    partType: row.part_type || null,
    brand: itemExt.brand || itemExt.manufacturer || null,
    partNumber: itemExt.partNumber || null,
    specification: itemExt.technicalSpecification || itemExt.specification || null,
    itemArchived: !!row.item_deleted_at,
    relationType: row.relation_type || null,
    relationLabel: relationLabelOf(row.relation_type),
    quantityRequired: row.quantity_required == null ? null : Number(row.quantity_required),
    notes: row.notes || null,
    rowVersion: Number(row.row_version) || 1,
    archived,
    deleteReason: archived ? row.delete_reason || null : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    minStock: row.min_stock == null ? null : Number(row.min_stock),
    stockOnHand: row.stock_on_hand == null ? null : Number(row.stock_on_hand),
    stockReserved: row.stock_reserved == null ? null : Number(row.stock_reserved),
    stockAvailable: row.stock_available == null ? null : Number(row.stock_available),
    lastPurchase: structure.lastPurchaseDto(row.last_purchase),
    source: 'asset_spare_parts'
  };
}

async function writeAudit(client, user, action, equipmentId, itemId, note, before, after) {
  await client.query(
    `INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after)
     VALUES($1,now(),$2,$3,$4,$5,'equipment-spares',$6,$7,$8,$9)`,
    [uuid(), user.name || user.username || user.id, user.id, user.role || '', action,
      `${equipmentId}:${itemId}`, cleanText(note, 500) || '',
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
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

// Realtime is delivered only to users who hold equipment.spares.view AND are inside the
// equipment/factory scope, through the same event_outbox contract as the structure dossier.
async function publishSparesEvent(client, user, root, action, link) {
  const { rows } = await client.query(
    `SELECT u.id,u.role,
      COALESCE((SELECT jsonb_agg(rp.permission) FROM role_permissions rp WHERE rp.role=u.role AND rp.granted=true),'[]'::jsonb) AS permissions,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('scope_type',s.scope_type,'scope_id',s.scope_id))
        FROM user_scopes s WHERE s.user_id=u.id),'[]'::jsonb) AS scopes
     FROM users u WHERE u.active IS TRUE`
  );
  const recipients = rows.filter(row => isRecipientAllowed(
    { ...row, permissions: asArray(row.permissions), scopes: asArray(row.scopes) },
    'equipment.spares.view', root.id, root.factory_id
  )).map(row => row.id);
  await client.query(
    `INSERT INTO event_outbox(id,event_type,aggregate_type,aggregate_id,actor_id,payload,recipient_ids)
     VALUES($1,'equipment.spares.changed','equipment',$2,$3,$4,$5)`,
    [crypto.randomUUID(), root.id, user.id,
      JSON.stringify({ action, equipmentId: root.id, targetId: String(link.asset_id), itemId: String(link.item_id), rowVersion: Number(link.row_version) || null }),
      JSON.stringify(recipients)]
  );
}

async function capabilitiesOf(context) {
  const capabilities = {};
  for (const [key, permission] of Object.entries({
    create: 'equipment.spares.create',
    update: 'equipment.spares.update',
    archive: 'equipment.spares.archive',
    suggest: 'equipment.spares.suggest',
    approveAi: 'equipment.spares.approve_ai',
    inventoryView: 'inventory.view'
  })) capabilities[key] = await structure.hasPermission({ ...context, permission });
  return capabilities;
}

// The dossier node set: the equipment root plus its internal structure down to sub-components
// (depth 3). Placement decides the canonical kind, exactly like the structure dossier.
const DOSSIER_NODES_CTE = `WITH RECURSIVE dossier_nodes AS (
       SELECT a.id,a.parent,a.code,a.name,0 AS depth,ARRAY[a.id]::text[] AS path
       FROM assets a WHERE a.id=$1 AND a.deleted_at IS NULL
       UNION ALL
       SELECT child.id,child.parent,child.code,child.name,dossier_nodes.depth+1,dossier_nodes.path||child.id
       FROM assets child JOIN dossier_nodes ON child.parent=dossier_nodes.id
       WHERE child.type='eq' AND child.deleted_at IS NULL
         AND dossier_nodes.depth<3 AND NOT child.id=ANY(dossier_nodes.path)
     )`;

// One shared read contract for the list and for the single row returned after a write, so a
// link response always carries the same real ledger stock facts as the list itself.
function sparesSelect(singleLink = false) {
  return `${DOSSIER_NODES_CTE}
     SELECT rel.asset_id,rel.item_id,rel.relation_type,rel.quantity_required,rel.notes,
       rel.row_version,rel.created_at,rel.updated_at,rel.deleted_at,rel.delete_reason,
       node.code AS target_code,node.name AS target_name,node.depth AS target_depth,
       i.code,i.name,i.unit,i.part_type,i.min_stock,i.ext AS item_ext,i.deleted_at AS item_deleted_at,
       availability.on_hand AS stock_on_hand,
       availability.reserved AS stock_reserved,
       availability.available AS stock_available,
       CASE WHEN purchase.entry_no IS NULL THEN NULL ELSE jsonb_build_object(
         'at',purchase.created_at,'entryNo',purchase.entry_no,'qty',purchase.qty,
         'unitCost',purchase.unit_cost,'note',purchase.note,'movement',purchase.movement,
         'warehouseId',purchase.warehouse_id
       ) END AS last_purchase
     FROM asset_spare_parts rel
     JOIN items i ON i.id=rel.item_id
     JOIN dossier_nodes node ON node.id=rel.asset_id
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
       WHERE balance.item_id=i.id
     ) availability ON true
     LEFT JOIN LATERAL (
       SELECT receipt.created_at,receipt.entry_no,receipt.qty,receipt.unit_cost,receipt.note,
         receipt.movement,receipt.warehouse_id
       FROM inventory_ledger receipt
       WHERE receipt.item_id=i.id AND receipt.movement='receipt'
         AND NOT EXISTS (
           SELECT 1 FROM inventory_ledger reversal
           WHERE reversal.reverses_entry_id=receipt.id
         )
       ORDER BY receipt.created_at DESC,receipt.entry_no DESC LIMIT 1
     ) purchase ON true
     WHERE ($2::boolean OR rel.deleted_at IS NULL)${singleLink ? ' AND rel.asset_id=$3 AND rel.item_id=$4' : ''}
     ORDER BY rel.deleted_at NULLS FIRST,node.depth,i.name,i.code`;
}

// Selectable link targets: the root (general spares only) plus every real main-component and
// sub-component of this dossier. Critical parts are only allowed on the component targets.
async function spareTargets(client, root) {
  const { rows } = await client.query(
    `${DOSSIER_NODES_CTE}
     SELECT id,code,name,depth FROM dossier_nodes WHERE depth IN (0,2,3) ORDER BY depth,name,code`,
    [root.id]
  );
  return rows.map(row => {
    const kind = targetKindAtDepth(Number(row.depth));
    return {
      id: String(row.id), code: row.code || null, name: row.name || null, kind,
      label: structure.LEVEL_LABELS[kind] || kind,
      criticalAllowed: CRITICAL_TARGET_KINDS.includes(kind)
    };
  });
}

async function listSpares({ pool, security, user, equipmentId, includeArchived = false }) {
  const context = { pool, security, user };
  await structure.assertPermission(context, 'equipment.spares.view');
  const root = await structure.rootEquipmentById(pool, equipmentId);
  await structure.assertEquipmentScope(pool, user, root.id, root.factory_id);
  const canArchive = await structure.hasPermission({ ...context, permission: 'equipment.spares.archive' });
  const withArchived = !!includeArchived && canArchive;
  const { rows } = await pool.query(sparesSelect(false), [root.id, withArchived]);
  return {
    equipment: { id: root.id, code: root.code, name: root.name },
    parts: rows.map(spareDto),
    targets: await spareTargets(pool, root),
    relationTypes: Object.entries(RELATION_TYPES).map(([value, label]) => ({ value, label })),
    capabilities: await capabilitiesOf(context),
    includeArchived: withArchived
  };
}

async function lockRoot(client, equipmentId) {
  const root = await structure.rootEquipmentById(client, equipmentId);
  // Serialize link writes per equipment and make sure the dossier row cannot be archived
  // mid-transaction. The equipment row itself is never rewritten by spare-part operations.
  const { rows } = await client.query(
    'SELECT id FROM assets WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE', [root.id]
  );
  if (!rows[0]) throw coded(404, 'EQUIPMENT_NOT_FOUND');
  return root;
}

// Resolves and validates the link target inside this dossier. The root accepts general
// spares; only a real main-component/sub-component accepts a critical part. A subsystem or a
// node outside the dossier is never a valid spare target.
async function resolveTarget(client, root, targetId) {
  const clean = cleanText(targetId, 120);
  if (!clean || clean === String(root.id)) {
    return { id: root.id, kind: 'equipment', depth: 0, criticalAllowed: false };
  }
  const depth = await structure.structureDepth(client, root.id, clean);
  if (depth == null || depth < 1) throw coded(422, 'SPARE_TARGET_NOT_FOUND');
  const kind = targetKindAtDepth(depth);
  if (!CRITICAL_TARGET_KINDS.includes(kind)) throw coded(422, 'SPARE_TARGET_KIND_INVALID');
  return { id: clean, kind, depth, criticalAllowed: true };
}

function assertCriticalTarget(relationType, target) {
  if (relationType === 'key-spare' && !target.criticalAllowed) {
    throw coded(422, 'SPARE_CRITICAL_TARGET_INVALID');
  }
}

async function assertRealItem(client, itemId) {
  const { rows } = await client.query(
    'SELECT id,code,name,unit,part_type,ext FROM items WHERE id=$1 AND deleted_at IS NULL FOR KEY SHARE', [itemId]
  );
  if (!rows[0]) throw coded(422, 'INVENTORY_ITEM_NOT_FOUND');
  return rows[0];
}

async function lockLink(client, targetId, itemId) {
  const { rows } = await client.query(
    'SELECT * FROM asset_spare_parts WHERE asset_id=$1 AND item_id=$2 FOR UPDATE', [targetId, itemId]
  );
  return rows[0] || null;
}

function linkSnapshot(row) {
  if (!row) return null;
  return {
    asset_id: row.asset_id, item_id: row.item_id, relation_type: row.relation_type,
    quantity_required: row.quantity_required == null ? null : Number(row.quantity_required),
    notes: row.notes || null, row_version: Number(row.row_version) || 1,
    deleted_at: row.deleted_at || null, delete_reason: row.delete_reason || null
  };
}

async function linkSparePart({ client, pool, security, user, equipmentId, input, permission = 'equipment.spares.create' }) {
  const context = { pool, security, user };
  await structure.assertPermission(context, permission);
  const root = await lockRoot(client, equipmentId);
  await structure.assertEquipmentScope(client, user, root.id, root.factory_id);
  const { errors, values } = validateLinkInput(input);
  if (errors.length) throw Object.assign(coded(422, 'VALIDATION_ERROR'), { fields: errors });
  const target = await resolveTarget(client, root, input && input.targetId);
  assertCriticalTarget(values.relationType || 'key-spare', target);
  const item = await assertRealItem(client, values.itemId);
  const existing = await lockLink(client, target.id, values.itemId);
  if (existing && !existing.deleted_at) throw coded(409, 'SPARE_LINK_EXISTS');
  let row;
  if (existing) {
    // A previously archived link is reactivated explicitly instead of creating a duplicate
    // row; the full before/after stays in audit_x.
    const updated = await client.query(
      `UPDATE asset_spare_parts
       SET relation_type=$3,quantity_required=$4,notes=$5,deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,
         updated_by=$6,updated_at=now(),row_version=row_version+1
       WHERE asset_id=$1 AND item_id=$2 AND deleted_at IS NOT NULL AND row_version=$7
       RETURNING *`,
      [target.id, values.itemId, values.relationType || 'key-spare',
        values.quantityRequired == null ? null : values.quantityRequired, values.notes || null,
        user.id, Number(existing.row_version)]
    );
    if (!updated.rows[0]) throw coded(409, 'VERSION_CONFLICT');
    row = updated.rows[0];
    await writeAudit(client, user, 'spare-link-reactivate', root.id, values.itemId,
      'اتصال بایگانی‌شدهٔ قطعه یدکی با دادهٔ جدید فعال شد', linkSnapshot(existing), linkSnapshot(row));
  } else {
    const inserted = await client.query(
      `INSERT INTO asset_spare_parts(asset_id,item_id,relation_type,quantity_required,notes,created_by,updated_by,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$6,now())
       RETURNING *`,
      [target.id, values.itemId, values.relationType || 'key-spare',
        values.quantityRequired == null ? null : values.quantityRequired, values.notes || null, user.id]
    );
    row = inserted.rows[0];
    await writeAudit(client, user, 'spare-link', root.id, values.itemId,
      'قطعه یدکی واقعی انبار به پرونده تجهیز متصل شد', null, linkSnapshot(row));
  }
  await publishSparesEvent(client, user, root, existing ? 'reactivate' : 'link', row);
  return { ...(await readLinkRow(client, root.id, target.id, item.id)), committed: true };
}

async function updateSparePart({ client, pool, security, user, equipmentId, itemId, input }) {
  const context = { pool, security, user };
  await structure.assertPermission(context, 'equipment.spares.update');
  const root = await lockRoot(client, equipmentId);
  await structure.assertEquipmentScope(client, user, root.id, root.factory_id);
  const rowVersion = versionOf(input && (input.rowVersion ?? input.row_version));
  const cleanItemId = cleanText(itemId, 120);
  if (!cleanItemId) throw coded(404, 'SPARE_LINK_NOT_FOUND');
  const target = await resolveTarget(client, root, input && input.targetId);
  const existing = await lockLink(client, target.id, cleanItemId);
  if (!existing || existing.deleted_at) throw coded(404, 'SPARE_LINK_NOT_FOUND');
  if (Number(existing.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
  const { errors, values } = validateLinkInput(input, { partial: true });
  if (errors.length) throw Object.assign(coded(422, 'VALIDATION_ERROR'), { fields: errors });
  delete values.itemId; // the linked item never changes through PATCH
  // Designating a part as critical is only valid on a main-component/sub-component. Legacy
  // critical rows on the equipment root stay editable for quantity/notes (history preserved);
  // explicitly re-designating them as critical is rejected by the same rule as new links.
  if (values.relationType !== undefined) assertCriticalTarget(values.relationType, target);
  const editable = ['relationType', 'quantityRequired', 'notes'].filter(key => Object.prototype.hasOwnProperty.call(values, key));
  if (!editable.length) throw coded(422, 'NO_EDITABLE_FIELDS');
  const updated = await client.query(
    `UPDATE asset_spare_parts
     SET relation_type=$3,quantity_required=$4,notes=$5,updated_by=$6,updated_at=now(),row_version=row_version+1
     WHERE asset_id=$1 AND item_id=$2 AND deleted_at IS NULL AND row_version=$7
     RETURNING *`,
    [target.id, cleanItemId,
      values.relationType !== undefined ? values.relationType : existing.relation_type,
      values.quantityRequired !== undefined ? values.quantityRequired : existing.quantity_required,
      values.notes !== undefined ? values.notes : existing.notes,
      user.id, rowVersion]
  );
  if (!updated.rows[0]) throw coded(409, 'VERSION_CONFLICT');
  const row = updated.rows[0];
  await writeAudit(client, user, 'spare-link-edit', root.id, cleanItemId,
    'مشخصات اتصال قطعه یدکی ویرایش شد', linkSnapshot(existing), linkSnapshot(row));
  await publishSparesEvent(client, user, root, 'edit', row);
  return { ...(await readLinkRow(client, root.id, target.id, cleanItemId)), committed: true };
}

async function archiveSparePart({ client, pool, security, user, equipmentId, itemId, input }) {
  const context = { pool, security, user };
  await structure.assertPermission(context, 'equipment.spares.archive');
  const root = await lockRoot(client, equipmentId);
  await structure.assertEquipmentScope(client, user, root.id, root.factory_id);
  const rowVersion = versionOf(input && (input.rowVersion ?? input.row_version));
  const reason = reasonOf(input && input.reason, 'ARCHIVE_REASON_REQUIRED');
  const cleanItemId = cleanText(itemId, 120);
  if (!cleanItemId) throw coded(404, 'SPARE_LINK_NOT_FOUND');
  const target = await resolveTarget(client, root, input && input.targetId);
  const existing = await lockLink(client, target.id, cleanItemId);
  if (!existing) throw coded(404, 'SPARE_LINK_NOT_FOUND');
  if (existing.deleted_at) throw coded(409, 'SPARE_LINK_ALREADY_ARCHIVED');
  if (Number(existing.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
  const updated = await client.query(
    `UPDATE asset_spare_parts
     SET deleted_at=now(),deleted_by=$3,delete_reason=$4,updated_by=$3,updated_at=now(),row_version=row_version+1
     WHERE asset_id=$1 AND item_id=$2 AND deleted_at IS NULL AND row_version=$5
     RETURNING *`,
    [target.id, cleanItemId, user.id, reason, rowVersion]
  );
  if (!updated.rows[0]) throw coded(409, 'VERSION_CONFLICT');
  const row = updated.rows[0];
  await writeAudit(client, user, 'spare-link-archive', root.id, cleanItemId, reason, linkSnapshot(existing), linkSnapshot(row));
  await publishSparesEvent(client, user, root, 'archive', row);
  return { archived: true, historyPreserved: true, data: { itemId: cleanItemId, targetId: target.id, rowVersion: Number(row.row_version) } };
}

async function restoreSparePart({ client, pool, security, user, equipmentId, itemId, input }) {
  const context = { pool, security, user };
  await structure.assertPermission(context, 'equipment.spares.archive');
  const root = await lockRoot(client, equipmentId);
  await structure.assertEquipmentScope(client, user, root.id, root.factory_id);
  const rowVersion = versionOf(input && (input.rowVersion ?? input.row_version));
  const reason = reasonOf(input && input.reason, 'RESTORE_REASON_REQUIRED');
  const cleanItemId = cleanText(itemId, 120);
  if (!cleanItemId) throw coded(404, 'SPARE_LINK_NOT_FOUND');
  const target = await resolveTarget(client, root, input && input.targetId);
  const existing = await lockLink(client, target.id, cleanItemId);
  if (!existing) throw coded(404, 'SPARE_LINK_NOT_FOUND');
  if (!existing.deleted_at) throw coded(409, 'SPARE_LINK_NOT_ARCHIVED');
  if (Number(existing.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
  await assertRealItem(client, cleanItemId);
  const updated = await client.query(
    `UPDATE asset_spare_parts
     SET deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,updated_by=$3,updated_at=now(),row_version=row_version+1
     WHERE asset_id=$1 AND item_id=$2 AND deleted_at IS NOT NULL AND row_version=$4
     RETURNING *`,
    [target.id, cleanItemId, user.id, rowVersion]
  );
  if (!updated.rows[0]) throw coded(409, 'VERSION_CONFLICT');
  const row = updated.rows[0];
  await writeAudit(client, user, 'spare-link-restore', root.id, cleanItemId, reason, linkSnapshot(existing), linkSnapshot(row));
  await publishSparesEvent(client, user, root, 'restore', row);
  return { restored: true, historyPreserved: true, committed: true, data: { itemId: cleanItemId, targetId: target.id, rowVersion: Number(row.row_version) } };
}

// Re-reads one written link through the same ledger contract so the write response carries
// real stock and last-purchase facts, never values echoed from the request body.
async function readLinkRow(client, rootId, targetId, itemId) {
  const { rows } = await client.query(sparesSelect(true), [rootId, true, targetId, itemId]);
  if (!rows[0]) throw coded(404, 'SPARE_LINK_NOT_FOUND');
  return spareDto(rows[0]);
}

module.exports = {
  RELATION_TYPES,
  CRITICAL_TARGET_KINDS,
  validateLinkInput,
  relationLabelOf,
  spareDto,
  spareTargets,
  resolveTarget,
  listSpares,
  linkSparePart,
  updateSparePart,
  archiveSparePart,
  restoreSparePart
};
