'use strict';

const crypto = require('crypto');

const REQUEST_FLOW = {
  new: ['review', 'rejected', 'cancelled'],
  review: ['rejected', 'cancelled'],
  approved: [],
  wo: [],
  closed: [],
  rejected: [],
  cancelled: []
};
const WORK_ORDER_FLOW = {
  draft: ['open', 'assigned'],
  open: ['assigned'],
  assigned: ['seen', 'doing', 'open', 'hold'],
  seen: ['doing', 'hold'],
  doing: ['hold', 'done'],
  hold: ['doing', 'assigned'],
  done: ['closed'],
  closed: [],
  cancel: []
};
const LOCKED_REQUEST = new Set(['approved', 'wo', 'closed', 'rejected', 'cancelled']);
const LOCKED_WORK_ORDER = new Set(['done', 'closed', 'cancel']);
const LOCKED_PM = new Set(['cancelled']);
const CANCELLABLE_WORK_ORDER = new Set(['draft', 'open', 'assigned', 'seen', 'doing', 'hold']);

function coded(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (_) { return {}; }
  }
  return typeof value === 'object' ? value : {};
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; }
  }
  return [];
}

function hasExecutionHistory(row) {
  if (!row) return false;
  const times = asObject(row.times);
  const report = asObject(row.report);
  return Boolean(times.start || times.end || report.text || asArray(row.parts).length);
}

function isRecipientAllowed(user, permission, equipmentId, factoryId) {
  const permissions = asArray(user.permissions);
  const permitted = user.role === 'admin' || permissions.includes('*') || permissions.includes(permission);
  if (!permitted) return false;
  if (user.role === 'admin') return true;
  const scopes = asArray(user.scopes);
  const companyWide = scopes.some(scope => scope && scope.scope_type === 'company');
  if (!equipmentId) return companyWide;
  if (companyWide) return true;
  return scopes.some(scope => scope && (
    (scope.scope_type === 'equipment' && scope.scope_id === equipmentId)
    || (factoryId && scope.scope_type === 'factory' && scope.scope_id === factoryId)
  ));
}

function assertTransition(flow, from, to) {
  if (!Object.prototype.hasOwnProperty.call(flow, from) || !flow[from].includes(to)) {
    throw coded(409, 'INVALID_STATUS_TRANSITION');
  }
}

function versionOf(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw coded(422, 'ROW_VERSION_REQUIRED');
  return version;
}

function reasonOf(value, code) {
  const reason = String(value || '').trim();
  if (!reason) throw coded(422, code);
  return reason.slice(0, 500);
}

function appendHistory(history, text) {
  const next = asArray(history).slice();
  next.push({ t: new Date().toISOString(), x: text });
  return next;
}

function equipmentOf(row) {
  if (!row.asset_id && !row.equipment_id) return null;
  return {
    id: row.equipment_id || row.asset_id,
    code: row.equipment_code || null,
    name: row.equipment_name || null
  };
}

function requestDto(row) {
  return {
    id: row.id, no: row.no, type: row.type, unit: row.unit, requester: row.requester,
    requesterId: row.requester_id, assetId: row.asset_id, equipment: equipmentOf(row),
    desc: row.descr, descr: row.descr, urgency: row.urgency, impact: row.impact === true,
    status: row.status, form: asObject(row.form), history: asArray(row.history),
    createdAt: row.created_at, updatedAt: row.updated_at, rowVersion: Number(row.row_version),
    workOrderId: row.work_order_id, cancelReason: row.cancel_reason, deletedAt: row.deleted_at || null
  };
}

function workOrderDto(row) {
  return {
    id: row.id, no: row.no, type: row.type, assetId: row.asset_id, equipment: equipmentOf(row),
    desc: row.descr, descr: row.descr, priority: row.priority, assignee: row.assignee,
    status: row.status, reqId: row.req_id, pmId: row.pm_id, ptw: row.ptw === true,
    ptwId: row.ptw_id || null, permitStatus: row.permit_status || (row.ptw ? 'pending_issuance' : 'not_required'),
    failureType: row.failure_type || null, probableCauses: asArray(row.probable_causes),
    confirmedRootCause: row.confirmed_root_cause || null, recommendedAction: row.recommended_action || null,
    performedAction: row.performed_action || null, requiredParts: asArray(row.required_parts),
    times: asObject(row.times), parts: asArray(row.parts), report: asObject(row.report),
    est: row.est == null ? null : Number(row.est), createdAt: row.created_at, updatedAt: row.updated_at,
    rowVersion: Number(row.row_version), holdReason: row.hold_reason, cancelReason: row.cancel_reason,
    requesterOK: row.requester_confirmed_at ? { by: row.requester_confirmed_name || row.requester_confirmed_by, t: row.requester_confirmed_at, note: row.requester_confirmation_note || null } : null,
    deletedAt: row.deleted_at || null
  };
}

function pmDto(row) {
  const checklist = asArray(row.checklist).map(item => typeof item === 'string' ? item : (item.text || item.item || item.title || '')).filter(Boolean);
  return {
    id: row.id, assetId: row.asset_id, equipment: equipmentOf(row), title: row.title,
    interval: row.interval_days, intervalDays: row.interval_days, last: row.last_run, spec: row.spec,
    owner: row.owner, sup: row.sup, kind: row.kind, checklist, status: row.status || 'active',
    createdAt: row.created_at, updatedAt: row.updated_at, rowVersion: Number(row.row_version),
    cancelReason: row.cancel_reason, deletedAt: row.deleted_at || null
  };
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function nextNumber(client, name, prefix) {
  const { rows } = await client.query(
    `INSERT INTO maintenance_counters(name, value) VALUES($1, 1)
     ON CONFLICT(name) DO UPDATE SET value = maintenance_counters.value + 1
     RETURNING value`,
    [name]
  );
  return `${prefix}-${String(rows[0].value).padStart(6, '0')}`;
}

async function requireEquipment(client, assetId, required = false) {
  if (!assetId) {
    if (required) throw coded(422, 'EQUIPMENT_REQUIRED');
    return null;
  }
  const { rows } = await client.query(
    'SELECT id, code, name, deleted_at FROM assets WHERE id=$1',
    [assetId]
  );
  if (!rows[0] || rows[0].deleted_at) throw coded(422, 'EQUIPMENT_NOT_FOUND');
  return rows[0];
}

async function requireUser(client, userId) {
  if (!userId) return null;
  const { rows } = await client.query('SELECT id FROM users WHERE id=$1 AND active=true', [userId]);
  if (!rows[0]) throw coded(422, 'ASSIGNEE_NOT_FOUND');
  return rows[0].id;
}

async function lockRow(client, table, id) {
  const { rows } = await client.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
  if (!rows[0] || rows[0].deleted_at) throw coded(404, 'RECORD_NOT_FOUND');
  return rows[0];
}

async function writeUpdate(client, table, id, rowVersion, userId, fields) {
  const keys = Object.keys(fields);
  const values = keys.map(key => fields[key]);
  const assignments = keys.map((key, index) => `${key}=$${index + 3}`).join(', ');
  const userIndex = keys.length + 3;
  const { rows } = await client.query(
    `UPDATE ${table} SET ${assignments}, updated_at=now(), updated_by=$${userIndex}, row_version=row_version+1
     WHERE id=$1 AND row_version=$2 AND deleted_at IS NULL RETURNING *`,
    [id, rowVersion, ...values, userId]
  );
  if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
  return rows[0];
}

async function audit(client, user, action, module, entity, before, after, note) {
  await client.query(
    `INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after)
     VALUES($1,now(),$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [crypto.randomUUID(), user.name || user.username, user.id, user.role, action, module, entity, note,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}

async function factoryOf(client, equipmentId) {
  if (!equipmentId) return null;
  const { rows } = await client.query(
    `SELECT c.factory_asset_id FROM assets a
     LEFT JOIN asset_categories c ON c.id=a.category_id WHERE a.id=$1`,
    [equipmentId]
  );
  return rows[0] ? rows[0].factory_asset_id : null;
}

async function selectRecipients(client, permission, equipmentId) {
  const factoryId = await factoryOf(client, equipmentId);
  const { rows } = await client.query(
    `SELECT u.id, u.role,
      COALESCE((SELECT jsonb_agg(rp.permission) FROM role_permissions rp WHERE rp.role=u.role AND rp.granted=true), '[]'::jsonb) AS permissions,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('scope_type', s.scope_type, 'scope_id', s.scope_id)) FROM user_scopes s WHERE s.user_id=u.id), '[]'::jsonb) AS scopes
     FROM users u WHERE u.active=true`
  );
  return rows.filter(user => isRecipientAllowed(user, permission, equipmentId, factoryId)).map(user => user.id);
}

async function publish(client, user, event) {
  const recipients = await selectRecipients(client, event.permission, event.equipmentId || null);
  await client.query(
    `INSERT INTO event_outbox(id,event_type,aggregate_type,aggregate_id,actor_id,payload,recipient_ids)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [crypto.randomUUID(), event.type, event.aggregateType, event.aggregateId, user.id,
      JSON.stringify(event.payload), JSON.stringify(recipients)]
  );
  return recipients;
}

async function linkWorkOrderAsset(client, workOrderId, assetId) {
  if (!assetId) return;
  await client.query(
    `INSERT INTO work_order_assets(work_order_id, asset_id, relation_type, is_confirmed)
     VALUES($1,$2,'primary',true)
     ON CONFLICT(work_order_id, asset_id, relation_type) DO NOTHING`,
    [workOrderId, assetId]
  );
}

async function createRequestInTransaction(client, user, input) {
  const descr = String(input.descr || input.desc || '').trim();
  if (!descr) throw coded(422, 'DESCRIPTION_REQUIRED');
  const assetId = input.assetId || null;
  await requireEquipment(client, assetId, false);
  const id = crypto.randomUUID();
  const no = await nextNumber(client, 'request', 'WR');
  const history = appendHistory([], `ثبت درخواست توسط ${user.name || user.username}`);
  const form = input.form && typeof input.form === 'object' && !Array.isArray(input.form) ? input.form : {};
  const { rows } = await client.query(
    `INSERT INTO requests(id,no,type,unit,requester,requester_id,asset_id,descr,urgency,impact,status,form,history)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'new',$11,$12) RETURNING *`,
    [id, no, input.type || 'repair', String(input.unit || user.unit || '').trim() || null, user.name || user.username, user.id,
      assetId, descr, input.urgency || 'normal', input.impact === true,
      JSON.stringify(form), JSON.stringify(history)]
  );
  await audit(client, user, 'create', 'request', id, null, rows[0], 'ثبت درخواست کار');
  await publish(client, user, {
    type: 'request.created', aggregateType: 'request', aggregateId: id, permission: 'request.view',
    equipmentId: assetId, payload: { id, no, status: 'new', assetId }
  });
  return requestDto(rows[0]);
}

async function createRequest(pool, user, input) {
  return withTransaction(pool, client => createRequestInTransaction(client, user, input));
}

async function listRequests(pool, filters = {}) {
  const { rows } = await pool.query(
    `SELECT r.*, a.id AS equipment_id, a.code AS equipment_code, a.name AS equipment_name
     FROM requests r LEFT JOIN assets a ON a.id=r.asset_id
     WHERE r.deleted_at IS NULL AND ($1::text IS NULL OR r.asset_id=$1)
     ORDER BY r.created_at DESC LIMIT 500`,
    [filters.assetId || null]
  );
  return rows.map(requestDto);
}

async function getRequest(pool, id) {
  const { rows } = await pool.query(
    `SELECT r.*, a.id AS equipment_id, a.code AS equipment_code, a.name AS equipment_name
     FROM requests r LEFT JOIN assets a ON a.id=r.asset_id
     WHERE r.id=$1 AND r.deleted_at IS NULL`,
    [id]
  );
  if (!rows[0]) throw coded(404, 'RECORD_NOT_FOUND');
  return requestDto(rows[0]);
}

async function updateRequest(pool, user, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  return withTransaction(pool, async client => {
    const current = await lockRow(client, 'requests', id);
    if (LOCKED_REQUEST.has(current.status)) throw coded(409, 'RECORD_LOCKED');
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    const assetId = input.assetId === undefined ? current.asset_id : (input.assetId || null);
    await requireEquipment(client, assetId, false);
    const descr = String(input.descr ?? current.descr ?? '').trim();
    if (!descr) throw coded(422, 'DESCRIPTION_REQUIRED');
    const updated = await writeUpdate(client, 'requests', id, rowVersion, user.id, {
      type: input.type || current.type,
      unit: input.unit === undefined ? current.unit : input.unit,
      asset_id: assetId,
      descr,
      urgency: input.urgency || current.urgency,
      impact: input.impact === undefined ? current.impact : input.impact === true,
      form: JSON.stringify(input.form || asObject(current.form)),
      history: JSON.stringify(appendHistory(current.history, `ویرایش توسط ${user.name || user.username}`))
    });
    await audit(client, user, 'edit', 'request', id, current, updated, 'ویرایش درخواست');
    await publish(client, user, {
      type: 'request.updated', aggregateType: 'request', aggregateId: id, permission: 'request.view',
      equipmentId: updated.asset_id, payload: { id, no: updated.no, status: updated.status, assetId: updated.asset_id, rowVersion: Number(updated.row_version) }
    });
    return requestDto(updated);
  });
}

async function transitionRequest(pool, user, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  const status = String(input.status || '');
  return withTransaction(pool, async client => {
    const current = await lockRow(client, 'requests', id);
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    assertTransition(REQUEST_FLOW, current.status, status);
    const reason = ['rejected', 'cancelled'].includes(status) ? reasonOf(input.reason, 'CANCEL_REASON_REQUIRED') : null;
    const updated = await writeUpdate(client, 'requests', id, rowVersion, user.id, {
      status,
      cancel_reason: status === 'cancelled' || status === 'rejected' ? reason : current.cancel_reason,
      cancelled_at: status === 'cancelled' ? new Date().toISOString() : current.cancelled_at,
      history: JSON.stringify(appendHistory(current.history, `${status} توسط ${user.name || user.username}${reason ? ' — ' + reason : ''}`))
    });
    await audit(client, user, 'transition', 'request', id, current, updated, reason || status);
    await publish(client, user, {
      type: 'request.transitioned', aggregateType: 'request', aggregateId: id, permission: 'request.view',
      equipmentId: updated.asset_id, payload: { id, status, assetId: updated.asset_id, rowVersion: Number(updated.row_version) }
    });
    return requestDto(updated);
  });
}

async function normalizeRequiredParts(client, value) {
  if (!Array.isArray(value)) return [];
  if (value.length > 50) throw coded(422, 'TOO_MANY_REQUIRED_PARTS');
  const parts = [];
  const seen = new Set();
  for (const entry of value) {
    const itemId = String(entry && (entry.itemId || entry.item_id || entry.id) || '').trim();
    const qty = Number(entry && entry.qty);
    if (!itemId) throw coded(422, 'PART_NOT_FOUND');
    if (seen.has(itemId)) continue;
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) throw coded(422, 'INVALID_PART_QUANTITY');
    const { rows } = await client.query(
      `SELECT i.id, COALESCE(SUM(CASE WHEN l.id IS NOT NULL AND w.id IS NOT NULL THEN b.on_hand - b.reserved ELSE 0 END),0) AS available
       FROM items i LEFT JOIN item_balances b ON b.item_id=i.id
       LEFT JOIN storage_locations l ON l.id=b.location_id AND l.deleted_at IS NULL
       LEFT JOIN warehouses w ON w.id=l.warehouse_id AND w.deleted_at IS NULL AND w.active=true
       WHERE i.id=$1 AND i.deleted_at IS NULL
       GROUP BY i.id`,
      [itemId]
    );
    if (!rows[0]) throw coded(422, 'PART_NOT_FOUND');
    if (Number(rows[0].available) < qty) throw coded(409, 'INSUFFICIENT_AVAILABLE_STOCK');
    parts.push({ itemId, qty:Math.round(qty * 1000) / 1000 });
    seen.add(itemId);
  }
  return parts;
}

function textList(value, maxItems = 20) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean).slice(0, maxItems);
  return String(value || '').split(/[\n،,;]/).map(item => item.trim()).filter(Boolean).slice(0, maxItems);
}

function workOrderInput(input = {}, request = null) {
  const requestForm = request ? asObject(request.form) : {};
  const ptw = input.ptwRequired !== undefined ? input.ptwRequired === true
    : input.ptw !== undefined ? input.ptw === true
      : requestForm.ptwRequired === true || requestForm.ptw === true;
  return {
    type:input.workOrderType || input.type || (request ? (request.type === 'fab' ? 'FAB' : request.type === 'service' ? 'SRV' : request.urgency === 'critical' ? 'BD' : 'CM') : 'CM'),
    assetId:input.assetId === undefined && request ? request.asset_id : input.assetId || null,
    descr:String(input.descr || (request && request.descr) || '').trim(),
    priority:input.priority || (request && request.urgency) || 'normal',
    assignee:input.assignee || null,
    est:input.est,
    failureType:input.failureType || requestForm.failureType || null,
    probableCauses:textList(input.probableCauses ?? input.probableCause ?? requestForm.probableCause),
    confirmedRootCause:String(input.confirmedRootCause || '').trim() || null,
    recommendedAction:String(input.recommendedAction || '').trim() || null,
    performedAction:String(input.performedAction || '').trim() || null,
    requiredParts:Array.isArray(input.requiredParts) ? input.requiredParts : [],
    ptw,
    permitId:input.permitId || null
  };
}

async function createWorkOrderInTransaction(client, user, input, requestId = null) {
  const fields = workOrderInput(input);
  if (!fields.descr) throw coded(422, 'DESCRIPTION_REQUIRED');
  const assetId = fields.assetId || null;
  await requireEquipment(client, assetId, false);
  const assignee = await requireUser(client, fields.assignee);
  const requiredParts = await normalizeRequiredParts(client, fields.requiredParts);
  const id = crypto.randomUUID();
  const no = await nextNumber(client, 'work_order', 'WO');
  const status = assignee ? 'assigned' : 'open';
  const permitStatus = fields.ptw ? 'pending_issuance' : 'not_required';
  if (fields.permitId) throw coded(422, 'PERMIT_MUST_BE_LINKED_AFTER_WORK_ORDER_CREATION');
  const { rows } = await client.query(
    `INSERT INTO work_orders(id,no,type,asset_id,descr,priority,assignee,status,req_id,pm_id,ptw,times,parts,report,est,
       failure_type,probable_causes,confirmed_root_cause,recommended_action,performed_action,required_parts,permit_status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [id, no, fields.type, assetId, fields.descr, fields.priority, assignee, status,
      requestId, input.pmId || null, fields.ptw, Number(fields.est) > 0 ? Number(fields.est) : null,
      fields.failureType, JSON.stringify(fields.probableCauses), fields.confirmedRootCause, fields.recommendedAction,
      fields.performedAction, JSON.stringify(requiredParts), permitStatus]
  );
  await linkWorkOrderAsset(client, id, assetId);
  await audit(client, user, 'create', 'work_order', id, null, rows[0], requestId ? `صدور از درخواست ${requestId}` : 'صدور دستورکار');
  await publish(client, user, {
    type: 'work_order.created', aggregateType: 'work_order', aggregateId: id, permission: 'work_order.view',
    equipmentId: assetId, payload: { id, no, status, assetId, requestId }
  });
  return workOrderDto(rows[0]);
}

async function createWorkOrder(pool, user, input) {
  return withTransaction(pool, client => createWorkOrderInTransaction(client, user, input, input.requestId || null));
}

async function approveRequestInTransaction(client, user, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  const current = await lockRow(client, 'requests', id);
  if (!['new', 'review'].includes(current.status)) throw coded(409, 'RECORD_LOCKED');
  if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
  const request = current;
  const fields = workOrderInput(input, request);
  const assignee = await requireUser(client, fields.assignee);
  const assetId = fields.assetId || null;
  await requireEquipment(client, assetId, false);
  const requiredParts = await normalizeRequiredParts(client, fields.requiredParts);
  const workOrderId = crypto.randomUUID();
  const workOrderNo = await nextNumber(client, 'work_order', 'WO');
  const note = String(input.note || '').trim().slice(0, 1000);
  const descr = fields.descr + (note ? `\nیادداشت: ${note}` : '');
  const status = assignee ? 'assigned' : 'open';
  const permitStatus = fields.ptw ? 'pending_issuance' : 'not_required';
  if (fields.permitId) throw coded(422, 'PERMIT_MUST_BE_LINKED_AFTER_WORK_ORDER_CREATION');
  const { rows:createdRows } = await client.query(
    `INSERT INTO work_orders(id,no,type,asset_id,descr,priority,assignee,status,req_id,ptw,times,parts,report,est,
       failure_type,probable_causes,confirmed_root_cause,recommended_action,performed_action,required_parts,permit_status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [workOrderId, workOrderNo, fields.type, assetId, descr, fields.priority, assignee, status, request.id, fields.ptw,
      Number(fields.est) > 0 ? Number(fields.est) : null, fields.failureType, JSON.stringify(fields.probableCauses),
      fields.confirmedRootCause, fields.recommendedAction, fields.performedAction, JSON.stringify(requiredParts), permitStatus]
  );
  await linkWorkOrderAsset(client, workOrderId, assetId);
  const updated = await writeUpdate(client, 'requests', id, rowVersion, user.id, {
    status:'wo', work_order_id:workOrderId, approved_at:new Date().toISOString(),
    history:JSON.stringify(appendHistory(current.history, `تأیید و صدور دستورکار ${workOrderNo} توسط ${user.name || user.username}`))
  });
  await audit(client, user, 'approve', 'request', id, current, updated, workOrderNo);
  await audit(client, user, 'create', 'work_order', workOrderId, null, createdRows[0], `صدور از ${current.no}`);
  await publish(client, user, {
    type:'request.approved', aggregateType:'request', aggregateId:id, permission:'request.view',
    equipmentId:assetId, payload:{ id, status:'wo', assetId, workOrderId, rowVersion:Number(updated.row_version) }
  });
  await publish(client, user, {
    type:'work_order.created', aggregateType:'work_order', aggregateId:workOrderId, permission:'work_order.view',
    equipmentId:assetId, payload:{ id:workOrderId, no:workOrderNo, status, assetId, requestId:id }
  });
  return { request:requestDto(updated), workOrder:workOrderDto(createdRows[0]) };
}

async function approveRequest(pool, user, id, input) {
  return withTransaction(pool, client => approveRequestInTransaction(client, user, id, input));
}

async function archiveRequest(pool, user, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  const reason = reasonOf(input.reason, 'ARCHIVE_REASON_REQUIRED');
  return withTransaction(pool, async client => {
    const current = await lockRow(client, 'requests', id);
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    const linked = await client.query(
      'SELECT count(*)::int AS linked FROM work_orders WHERE req_id=$1 AND deleted_at IS NULL',
      [id]
    );
    if (linked.rows[0].linked) throw coded(409, 'REQUEST_HAS_WORK_ORDER');
    const { rows } = await client.query(
      `UPDATE requests SET deleted_at=now(), updated_at=now(), updated_by=$3, row_version=row_version+1, cancel_reason=$4
       WHERE id=$1 AND row_version=$2 AND deleted_at IS NULL RETURNING *`,
      [id, rowVersion, user.id, reason]
    );
    if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
    await audit(client, user, 'archive', 'request', id, current, rows[0], reason);
    await publish(client, user, {
      type: 'request.archived', aggregateType: 'request', aggregateId: id, permission: 'request.view',
      equipmentId: current.asset_id, payload: { id, archived: true, assetId: current.asset_id }
    });
    return { archived: true, historyPreserved: true };
  });
}


function normalizeMatch(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('fa').replace(/[\u064B-\u065F\u0670]/g, '').replace(/[\s\u200c_-]+/g, ' ');
}

async function technicianSuggestions(pool, user, equipmentId, workOrderType = '') {
  if (!equipmentId) throw coded(422, 'EQUIPMENT_REQUIRED');
  const { rows:assets } = await pool.query(
    `SELECT a.id,a.code,a.name,a.cls,a.type,a.ext,c.factory_asset_id
     FROM assets a LEFT JOIN asset_categories c ON c.id=a.category_id
     WHERE a.id=$1 AND a.deleted_at IS NULL`, [equipmentId]
  );
  const asset = assets[0];
  if (!asset) throw coded(422, 'EQUIPMENT_NOT_FOUND');
  if (user && user.role !== 'admin') {
    const { rows:scopes } = await pool.query(
      `SELECT 1 FROM user_scopes WHERE user_id=$1 AND (
        (scope_type='equipment' AND scope_id=$2) OR
        (scope_type='factory' AND scope_id=$3) OR scope_type='company') LIMIT 1`,
      [user.id,asset.id,asset.factory_asset_id]
    );
    if (!scopes[0]) throw coded(403, 'EQUIPMENT_SCOPE_DENIED');
  }
  const { rows:users } = await pool.query(
    `SELECT u.id,u.name,u.hr,
       (SELECT count(*)::int FROM work_orders w WHERE w.assignee=u.id AND w.deleted_at IS NULL
         AND w.status IN ('open','assigned','seen','doing','hold')) AS active_load,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('scope_type',s.scope_type,'scope_id',s.scope_id))
         FROM user_scopes s WHERE s.user_id=u.id),'[]'::jsonb) AS scopes
     FROM users u WHERE u.active=true AND u.role='tech'`
  );
  const assetTerms = [asset.cls, asset.ext && (asset.ext.maintenanceDomain || asset.ext.specialty), asset.type]
    .map(normalizeMatch).filter(Boolean);
  const wantedType = normalizeMatch(workOrderType);
  const candidates = users.flatMap(row => {
    const hr = asObject(row.hr);
    const specialty = normalizeMatch(hr.specialty);
    const authorizations = [].concat(hr.authorizations || hr.workAuthorizations || hr.licenses || hr.certifications || [])
      .map(normalizeMatch).filter(Boolean);
    const onDuty = hr.onDuty === true || hr.shiftOnDuty === true || asObject(hr.shift).onDuty === true;
    const scoped = asArray(row.scopes).some(scope => scope && (
      (scope.scope_type === 'equipment' && scope.scope_id === asset.id)
      || (asset.factory_asset_id && scope.scope_type === 'factory' && scope.scope_id === asset.factory_asset_id)
    ));
    const specialtyMatch = !!specialty && assetTerms.some(term => term === specialty || term.includes(specialty) || specialty.includes(term));
    const authorized = authorizations.some(item => item === '*' || item === wantedType || (!wantedType && item));
    if (!specialtyMatch || !authorized || !onDuty || !scoped) return [];
    return [{ id:row.id, name:row.name, specialty:hr.specialty, activeWorkOrders:Number(row.active_load) || 0 }];
  }).sort((a,b) => a.activeWorkOrders - b.activeWorkOrders || a.name.localeCompare(b.name,'fa'));
  return {
    data:candidates,
    message:candidates.length ? null : 'داده کافی برای پیشنهاد تکنسین وجود ندارد',
    evaluated:{ equipmentId:asset.id, workOrderType:workOrderType || null, source:'users.hr, user_scopes, active work_orders' }
  };
}

async function listWorkOrders(pool, filters = {}) {
  const { rows } = await pool.query(
    `SELECT w.*, a.id AS equipment_id, a.code AS equipment_code, a.name AS equipment_name
     FROM work_orders w LEFT JOIN assets a ON a.id=w.asset_id
     WHERE w.deleted_at IS NULL AND ($1::text IS NULL OR w.asset_id=$1)
     ORDER BY w.created_at DESC LIMIT 500`,
    [filters.assetId || null]
  );
  return rows.map(workOrderDto);
}

async function getWorkOrder(pool, id) {
  const { rows } = await pool.query(
    `SELECT w.*, a.id AS equipment_id, a.code AS equipment_code, a.name AS equipment_name
     FROM work_orders w LEFT JOIN assets a ON a.id=w.asset_id
     WHERE w.id=$1 AND w.deleted_at IS NULL`,
    [id]
  );
  if (!rows[0]) throw coded(404, 'RECORD_NOT_FOUND');
  return workOrderDto(rows[0]);
}

async function issuedPermit(client, permitId, workOrderId) {
  if (!permitId) return null;
  const { rows } = await client.query(
    'SELECT * FROM permits WHERE id=$1 AND wo_id=$2 FOR UPDATE', [String(permitId), workOrderId]
  );
  if (!rows[0]) throw coded(422, 'WORK_PERMIT_NOT_LINKED');
  return rows[0];
}

function permitIsIssued(permit, now = Date.now()) {
  if (!permit || permit.status !== 'active' || !permit.approved_at) return false;
  const startsAt = permit.from_at ? Date.parse(permit.from_at) : null;
  const expiresAt = permit.to_at ? Date.parse(permit.to_at) : null;
  if (startsAt != null && (!Number.isFinite(startsAt) || startsAt > now)) return false;
  if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt < now)) return false;
  return true;
}

async function updateWorkOrder(pool, user, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  return withTransaction(pool, async client => {
    const current = await lockRow(client, 'work_orders', id);
    if (LOCKED_WORK_ORDER.has(current.status)) throw coded(409, 'RECORD_LOCKED');
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    const assetId = input.assetId === undefined ? current.asset_id : (input.assetId || null);
    await requireEquipment(client, assetId, false);
    const assignee = input.assignee === undefined ? current.assignee : await requireUser(client, input.assignee || null);
    const descr = String(input.descr ?? current.descr ?? '').trim();
    if (!descr) throw coded(422, 'DESCRIPTION_REQUIRED');
    let status = current.status;
    if (current.status === 'open' && assignee) status = 'assigned';
    const requiredParts = input.requiredParts === undefined ? asArray(current.required_parts) : await normalizeRequiredParts(client, input.requiredParts);
  let ptw = input.ptwRequired === undefined && input.ptw === undefined ? current.ptw === true : (input.ptwRequired === true || input.ptw === true);
  if (current.ptw === true && !ptw) throw coded(409, 'PTW_REQUIREMENT_CANNOT_BE_REMOVED');
  let ptwId = current.ptw_id || null;
    let permitStatus = ptw ? (current.ptw === true && current.permit_status && current.permit_status !== 'not_required' ? current.permit_status : 'pending_issuance') : 'not_required';
    if (input.permitId !== undefined) {
      if (!ptw) throw coded(422, 'PERMIT_NOT_REQUIRED');
      const permit = await issuedPermit(client, input.permitId, id);
      ptwId = permit.id;
      permitStatus = permitIsIssued(permit) ? 'issued' : 'pending_issuance';
    } else if (!ptw) {
      ptwId = null;
    }
    const probableCauses = input.probableCauses === undefined && input.probableCause === undefined
      ? asArray(current.probable_causes)
      : textList(input.probableCauses ?? input.probableCause);
    const updated = await writeUpdate(client, 'work_orders', id, rowVersion, user.id, {
      type:input.workOrderType || input.type || current.type,
      asset_id:assetId,
      descr,
      priority:input.priority || current.priority,
      assignee,
      status,
      ptw,
      ptw_id:ptwId,
      permit_status:permitStatus,
      failure_type:input.failureType === undefined ? current.failure_type : (String(input.failureType || '').trim() || null),
      probable_causes:JSON.stringify(probableCauses),
      confirmed_root_cause:input.confirmedRootCause === undefined ? current.confirmed_root_cause : (String(input.confirmedRootCause || '').trim() || null),
      recommended_action:input.recommendedAction === undefined ? current.recommended_action : (String(input.recommendedAction || '').trim() || null),
      performed_action:input.performedAction === undefined ? current.performed_action : (String(input.performedAction || '').trim() || null),
      required_parts:JSON.stringify(requiredParts),
      est:input.est === undefined ? current.est : Number(input.est) > 0 ? Number(input.est) : null
    });
    await linkWorkOrderAsset(client, id, assetId);
    await audit(client, user, 'edit', 'work_order', id, current, updated, 'ویرایش دستورکار');
    await publish(client, user, {
      type:'work_order.updated', aggregateType:'work_order', aggregateId:id, permission:'work_order.view',
      equipmentId:assetId, payload:{ id, no:updated.no, status:updated.status, assetId, rowVersion:Number(updated.row_version) }
    });
    return workOrderDto(updated);
  });
}

async function linkWorkOrderPermit(pool, user, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  return withTransaction(pool, async client => {
    const current = await lockRow(client, 'work_orders', id);
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    if (LOCKED_WORK_ORDER.has(current.status)) throw coded(409, 'RECORD_LOCKED');
    if (current.ptw !== true) throw coded(422, 'PERMIT_NOT_REQUIRED');
    const permit = await issuedPermit(client, input.permitId, id);
    const updated = await writeUpdate(client, 'work_orders', id, rowVersion, user.id, {
      ptw_id:permit.id,
      permit_status:permitIsIssued(permit) ? 'issued' : 'pending_issuance'
    });
    await audit(client, user, 'link-permit', 'work_order', id, current, updated, permit.no || permit.id);
    await publish(client, user, {
      type:'work_order.permit_linked', aggregateType:'work_order', aggregateId:id, permission:'work_order.view',
      equipmentId:current.asset_id, payload:{ id, permitId:permit.id, permitStatus:updated.permit_status, rowVersion:Number(updated.row_version) }
    });
    return workOrderDto(updated);
  });
}

async function transitionWorkOrder(pool, user, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  const status = String(input.status || '');
  return withTransaction(pool, async client => {
    const current = await lockRow(client, 'work_orders', id);
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    assertTransition(WORK_ORDER_FLOW, current.status, status);
    let permitStatus = current.permit_status || (current.ptw ? 'pending_issuance' : 'not_required');
    if (status === 'doing' && current.ptw === true) {
      if (!current.ptw_id) throw coded(409, 'WORK_PERMIT_REQUIRED');
      const permit = await issuedPermit(client, current.ptw_id, id);
      if (!permitIsIssued(permit)) throw coded(409, 'WORK_PERMIT_REQUIRED');
      permitStatus = 'issued';
    }
    const times = asObject(current.times);
    const report = asObject(current.report);
    if (status === 'seen' && !times.seen) times.seen = new Date().toISOString();
    if (status === 'doing' && !times.start) times.start = new Date().toISOString();
    if (status === 'hold') current.hold_reason = reasonOf(input.reason, 'HOLD_REASON_REQUIRED');
    if (status === 'done') {
      const text = String(input.report?.text || '').trim();
      if (!text) throw coded(422, 'REPORT_REQUIRED');
      times.end = new Date().toISOString();
      report.text = text;
      report.cause = input.report.cause || null;
      current.performed_action = text;
      report.by = user.id;
      report.at = times.end;
    }
    if (status === 'closed' && !hasExecutionHistory({ ...current, times, report })) throw coded(409, 'WORK_ORDER_NOT_EXECUTED');
    const updated = await writeUpdate(client, 'work_orders', id, rowVersion, user.id, {
      status,
      times: JSON.stringify(times),
      report: JSON.stringify(report),
      performed_action: status === 'done' ? current.performed_action : current.performed_action,
      permit_status: permitStatus,
      hold_reason: status === 'hold' ? current.hold_reason : current.hold_reason
    });
    await audit(client, user, 'transition', 'work_order', id, current, updated, status);
    await publish(client, user, {
      type: 'work_order.transitioned', aggregateType: 'work_order', aggregateId: id, permission: 'work_order.view',
      equipmentId: current.asset_id, payload: { id, status, assetId: current.asset_id, rowVersion: Number(updated.row_version) }
    });
    return workOrderDto(updated);
  });
}

async function archiveWorkOrder(pool, user, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  const reason = reasonOf(input.reason, 'ARCHIVE_REASON_REQUIRED');
  return withTransaction(pool, async client => {
    const current = await lockRow(client, 'work_orders', id);
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    if (hasExecutionHistory(current)) throw coded(409, 'EXECUTED_WORK_ORDER_CANNOT_BE_ARCHIVED');
    const consumed = await client.query('SELECT 1 FROM work_order_parts WHERE work_order_id=$1 LIMIT 1', [id]);
    if (consumed.rows[0]) throw coded(409, 'EXECUTED_WORK_ORDER_CANNOT_BE_ARCHIVED');
    const { rows } = await client.query(
      `UPDATE work_orders SET deleted_at=now(), updated_at=now(), updated_by=$3, row_version=row_version+1
       WHERE id=$1 AND row_version=$2 AND deleted_at IS NULL RETURNING *`,
      [id, rowVersion, user.id]
    );
    if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
    await audit(client, user, 'archive', 'work_order', id, current, rows[0], reason);
    await publish(client, user, {
      type: 'work_order.archived', aggregateType: 'work_order', aggregateId: id, permission: 'work_order.view',
      equipmentId: current.asset_id, payload: { id, archived: true, assetId: current.asset_id }
    });
    return { archived: true, historyPreserved: true };
  });
}

async function cancelWorkOrder(pool, user, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  const reason = reasonOf(input.reason, 'CANCEL_REASON_REQUIRED');
  return withTransaction(pool, async client => {
    const current = await lockRow(client, 'work_orders', id);
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    if (!CANCELLABLE_WORK_ORDER.has(current.status)) throw coded(409, 'RECORD_LOCKED');
    const updated = await writeUpdate(client, 'work_orders', id, rowVersion, user.id, {
      status: 'cancel',
      cancel_reason: reason,
      cancelled_at: new Date().toISOString(),
      cancelled_by: user.id
    });
    await audit(client, user, 'cancel', 'work_order', id, current, updated, reason);
    await publish(client, user, {
      type: 'work_order.cancelled', aggregateType: 'work_order', aggregateId: id, permission: 'work_order.view',
      equipmentId: current.asset_id, payload: { id, status: 'cancel', assetId: current.asset_id, historyPreserved: true }
    });
    return workOrderDto(updated);
  });
}

async function correctRecord(pool, user, kind, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  const reason = reasonOf(input.reason, 'CORRECTION_REASON_REQUIRED');
  const table = kind === 'request' ? 'requests' : kind === 'work_order' ? 'work_orders' : 'pm_plans';
  const allowed = kind === 'request'
    ? { descr: 'descr', urgency: 'urgency', assetId: 'asset_id' }
    : kind === 'work_order'
      ? { descr: 'descr', priority: 'priority', est: 'est' }
      : { title: 'title', interval: 'interval_days', spec: 'spec' };
  return withTransaction(pool, async client => {
    const current = await lockRow(client, table, id);
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    const patch = {};
    for (const [key, column] of Object.entries(allowed)) {
      if (input.patch && input.patch[key] !== undefined) patch[column] = key === 'est' || key === 'interval' ? Number(input.patch[key]) : input.patch[key];
    }
    if (patch.asset_id) await requireEquipment(client, patch.asset_id, false);
    if (!Object.keys(patch).length) throw coded(422, 'NO_EDITABLE_FIELDS');
    if (patch.descr !== undefined && !String(patch.descr).trim()) throw coded(422, 'DESCRIPTION_REQUIRED');
    const updated = await writeUpdate(client, table, id, rowVersion, user.id, patch);
    if (updated.status !== current.status) throw coded(409, 'RECORD_LOCKED');
    await client.query(
      `INSERT INTO maintenance_corrections(id,entity_type,entity_id,reason,patch,previous_row_version,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [crypto.randomUUID(), kind, id, reason, JSON.stringify(patch), rowVersion, user.id]
    );
    await audit(client, user, 'correct', kind, id, current, updated, reason);
    await publish(client, user, {
      type: `${kind}.corrected`, aggregateType: kind, aggregateId: id,
      permission: kind === 'work_order' ? 'work_order.view' : kind === 'request' ? 'request.view' : 'pm.view',
      equipmentId: updated.asset_id, payload: { id, rowVersion: Number(updated.row_version), assetId: updated.asset_id }
    });
    return kind === 'request' ? requestDto(updated) : kind === 'work_order' ? workOrderDto(updated) : pmDto(updated);
  });
}

async function createPmPlan(pool, user, input) {
  const title = String(input.title || '').trim();
  if (!title) throw coded(422, 'TITLE_REQUIRED');
  return withTransaction(pool, async client => {
    const assetId = input.assetId || null;
    await requireEquipment(client, assetId, true);
    const owner = await requireUser(client, input.owner || null);
    const id = crypto.randomUUID();
    const { rows } = await client.query(
      `INSERT INTO pm_plans(id,asset_id,title,interval_days,last_run,spec,owner,kind,checklist,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'active') RETURNING *`,
      [id, assetId, title, Number(input.intervalDays || input.interval) || 30, input.lastRun || new Date().toISOString(),
        input.spec || null, owner, input.kind || 'PM', JSON.stringify(input.checklist || [])]
    );
    await audit(client, user, 'create', 'pm_plan', id, null, rows[0], 'ثبت برنامه PM');
    await publish(client, user, {
      type: 'pm_plan.created', aggregateType: 'pm_plan', aggregateId: id, permission: 'pm.view',
      equipmentId: assetId, payload: { id, title, assetId, status: 'active' }
    });
    return pmDto(rows[0]);
  });
}

async function listPmPlans(pool, filters = {}) {
  const { rows } = await pool.query(
    `SELECT p.*, a.id AS equipment_id, a.code AS equipment_code, a.name AS equipment_name
     FROM pm_plans p LEFT JOIN assets a ON a.id=p.asset_id
     WHERE p.deleted_at IS NULL AND ($1::text IS NULL OR p.asset_id=$1)
     ORDER BY p.title LIMIT 500`,
    [filters.assetId || null]
  );
  return rows.map(pmDto);
}

async function getPmPlan(pool, id) {
  const { rows } = await pool.query(
    `SELECT p.*, a.id AS equipment_id, a.code AS equipment_code, a.name AS equipment_name
     FROM pm_plans p LEFT JOIN assets a ON a.id=p.asset_id
     WHERE p.id=$1 AND p.deleted_at IS NULL`,
    [id]
  );
  if (!rows[0]) throw coded(404, 'RECORD_NOT_FOUND');
  return pmDto(rows[0]);
}

async function updatePmPlan(pool, user, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  return withTransaction(pool, async client => {
    const current = await lockRow(client, 'pm_plans', id);
    if (current.deleted_at || LOCKED_PM.has(current.status)) throw coded(409, 'RECORD_LOCKED');
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    const assetId = input.assetId || current.asset_id;
    await requireEquipment(client, assetId, true);
    const title = String(input.title ?? current.title ?? '').trim();
    if (!title) throw coded(422, 'TITLE_REQUIRED');
    const updated = await writeUpdate(client, 'pm_plans', id, rowVersion, user.id, {
      asset_id: assetId,
      title,
      interval_days: Number(input.intervalDays || input.interval || current.interval_days) || 30,
      spec: input.spec === undefined ? current.spec : input.spec,
      checklist: JSON.stringify(input.checklist || asArray(current.checklist))
    });
    await audit(client, user, 'edit', 'pm_plan', id, current, updated, 'ویرایش برنامه PM');
    await publish(client, user, {
      type: 'pm_plan.updated', aggregateType: 'pm_plan', aggregateId: id, permission: 'pm.view',
      equipmentId: assetId, payload: { id, assetId, rowVersion: Number(updated.row_version) }
    });
    return pmDto(updated);
  });
}

async function archivePmPlan(pool, user, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  const reason = reasonOf(input.reason, 'ARCHIVE_REASON_REQUIRED');
  return withTransaction(pool, async client => {
    const current = await lockRow(client, 'pm_plans', id);
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    const { rows } = await client.query(
      `UPDATE pm_plans SET deleted_at=now(), updated_at=now(), updated_by=$3, row_version=row_version+1
       WHERE id=$1 AND row_version=$2 AND deleted_at IS NULL RETURNING *`,
      [id, rowVersion, user.id]
    );
    if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
    await audit(client, user, 'archive', 'pm_plan', id, current, rows[0], reason);
    await publish(client, user, {
      type: 'pm_plan.archived', aggregateType: 'pm_plan', aggregateId: id, permission: 'pm.view',
      equipmentId: current.asset_id, payload: { id, archived: true, assetId: current.asset_id }
    });
    return { archived: true, historyPreserved: true };
  });
}

async function cancelPmPlan(pool, user, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  const reason = reasonOf(input.reason, 'CANCEL_REASON_REQUIRED');
  return withTransaction(pool, async client => {
    const current = await lockRow(client, 'pm_plans', id);
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    if (LOCKED_PM.has(current.status)) throw coded(409, 'RECORD_LOCKED');
    const updated = await writeUpdate(client, 'pm_plans', id, rowVersion, user.id, {
      status: 'cancelled',
      cancel_reason: reason,
      cancelled_at: new Date().toISOString()
    });
    await audit(client, user, 'cancel', 'pm_plan', id, current, updated, reason);
    await publish(client, user, {
      type: 'pm_plan.cancelled', aggregateType: 'pm_plan', aggregateId: id, permission: 'pm.view',
      equipmentId: current.asset_id, payload: { id, status: 'cancelled', assetId: current.asset_id }
    });
    return pmDto(updated);
  });
}

async function generatePmWorkOrder(pool, user, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  return withTransaction(pool, async client => {
    const current = await lockRow(client, 'pm_plans', id);
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    if (LOCKED_PM.has(current.status)) throw coded(409, 'RECORD_LOCKED');
    await requireEquipment(client, current.asset_id, true);
    const workOrderId = crypto.randomUUID();
    const no = await nextNumber(client, 'work_order', 'WO');
    const checklist = asArray(current.checklist);
    const descr = `${current.title}${checklist.length ? ' — ' + checklist.join('، ') : ''}`;
    const created = await client.query(
      `INSERT INTO work_orders(id,no,type,asset_id,descr,priority,assignee,status,pm_id,times,parts,report,est)
       VALUES($1,$2,'PM',$3,$4,'normal',$5,$6,$7,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,2) RETURNING *`,
      [workOrderId, no, current.asset_id, descr, current.owner || null, current.owner ? 'assigned' : 'open', current.id]
    );
    await linkWorkOrderAsset(client, workOrderId, current.asset_id);
    const updated = await writeUpdate(client, 'pm_plans', id, rowVersion, user.id, { last_run: new Date().toISOString() });
    await audit(client, user, 'generate', 'pm_plan', id, current, updated, no);
    await audit(client, user, 'create', 'work_order', workOrderId, null, created.rows[0], `صدور از PM ${current.title}`);
    await publish(client, user, {
      type: 'pm_plan.generated', aggregateType: 'pm_plan', aggregateId: id, permission: 'pm.view',
      equipmentId: current.asset_id, payload: { id, workOrderId, assetId: current.asset_id }
    });
    await publish(client, user, {
      type: 'work_order.created', aggregateType: 'work_order', aggregateId: workOrderId, permission: 'work_order.view',
      equipmentId: current.asset_id, payload: { id: workOrderId, no, assetId: current.asset_id, pmId: id }
    });
    return { plan: pmDto(updated), workOrder: workOrderDto(created.rows[0]) };
  });
}

async function equipmentLinks(pool, assetId) {
  const equipment = await requireEquipment({ query: (sql, params) => pool.query(sql, params) }, assetId, true);
  const [requests, workOrders, plans] = await Promise.all([
    pool.query('SELECT id, no, status, asset_id FROM requests WHERE asset_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC', [assetId]),
    pool.query('SELECT id, no, status, asset_id, req_id, pm_id FROM work_orders WHERE asset_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC', [assetId]),
    pool.query('SELECT id, title, status, asset_id FROM pm_plans WHERE asset_id=$1 AND deleted_at IS NULL ORDER BY title', [assetId])
  ]);
  return {
    equipment,
    requests: requests.rows,
    workOrders: workOrders.rows,
    pmPlans: plans.rows
  };
}

const MAX_WIZARD_DRAFT_BYTES = 96 * 1024;

function normalizeDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw coded(422, 'WIZARD_DRAFT_INVALID');
  let serialized;
  try { serialized = JSON.stringify(value); } catch (_) { throw coded(422, 'WIZARD_DRAFT_INVALID'); }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_WIZARD_DRAFT_BYTES) throw coded(413, 'WIZARD_DRAFT_TOO_LARGE');
  return JSON.parse(serialized);
}

function wizardDraftDto(row) {
  return {
    id:row.id, wizardType:row.wizard_type, draft:asObject(row.draft), stepId:row.step_id || '',
    status:row.status, targetEntityType:row.target_entity_type || null, targetEntityId:row.target_entity_id || null,
    createdAt:row.created_at, updatedAt:row.updated_at, rowVersion:Number(row.row_version)
  };
}

async function createWizardDraft(pool, user, input = {}) {
  const wizardType = String(input.wizardType || '');
  if (!['request','work_order'].includes(wizardType)) throw coded(422, 'WIZARD_TYPE_INVALID');
  const draft = normalizeDraft(input.draft || {});
  const stepId = String(input.stepId || '').slice(0, 120);
  return withTransaction(pool, async client => {
    const id = crypto.randomUUID();
    const { rows } = await client.query(
      `INSERT INTO maintenance_wizard_drafts(id,wizard_type,draft,step_id,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$5) RETURNING *`,
      [id, wizardType, JSON.stringify(draft), stepId, user.id]
    );
    await audit(client, user, 'wizard-draft-create', wizardType, id, null, rows[0], 'ایجاد پیش‌نویس فرم پله‌ای');
    return wizardDraftDto(rows[0]);
  });
}

async function listWizardDrafts(pool, user, wizardType) {
  if (!['request','work_order'].includes(wizardType)) throw coded(422, 'WIZARD_TYPE_INVALID');
  const { rows } = await pool.query(
    `SELECT * FROM maintenance_wizard_drafts
     WHERE created_by=$1 AND wizard_type=$2 AND status='draft' AND deleted_at IS NULL
     ORDER BY updated_at DESC LIMIT 20`,
    [user.id, wizardType]
  );
  return rows.map(wizardDraftDto);
}

async function getWizardDraft(pool, user, id, expectedType = null) {
  const { rows } = await pool.query(
    `SELECT * FROM maintenance_wizard_drafts WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL`, [id,user.id]
  );
  if (!rows[0] || (expectedType && rows[0].wizard_type !== expectedType)) throw coded(404, 'WIZARD_DRAFT_NOT_FOUND');
  return wizardDraftDto(rows[0]);
}

async function updateWizardDraft(pool, user, id, input = {}, expectedType = null) {
  const rowVersion = versionOf(input.rowVersion);
  const draft = normalizeDraft(input.draft || {});
  const stepId = String(input.stepId || '').slice(0, 120);
  return withTransaction(pool, async client => {
    const { rows:locked } = await client.query(
      `SELECT * FROM maintenance_wizard_drafts
       WHERE id=$1 AND created_by=$2 AND status='draft' AND deleted_at IS NULL FOR UPDATE`, [id,user.id]
    );
    const current = locked[0];
    if (!current || (expectedType && current.wizard_type !== expectedType)) throw coded(404, 'WIZARD_DRAFT_NOT_FOUND');
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    const { rows } = await client.query(
      `UPDATE maintenance_wizard_drafts SET draft=$3,step_id=$4,updated_at=now(),updated_by=$5,row_version=row_version+1
       WHERE id=$1 AND row_version=$2 AND created_by=$5 AND status='draft' AND deleted_at IS NULL RETURNING *`,
      [id,rowVersion,JSON.stringify(draft),stepId,user.id]
    );
    if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
    await audit(client, user, 'wizard-draft-update', current.wizard_type, id, current, rows[0], 'ذخیره پیش‌نویس فرم پله‌ای');
    return wizardDraftDto(rows[0]);
  });
}

async function cancelWizardDraft(pool, user, id, input = {}, expectedType = null) {
  const rowVersion = versionOf(input.rowVersion);
  return withTransaction(pool, async client => {
    const { rows:locked } = await client.query(
      `SELECT * FROM maintenance_wizard_drafts WHERE id=$1 AND created_by=$2 AND status='draft' AND deleted_at IS NULL FOR UPDATE`, [id,user.id]
    );
    const current = locked[0];
    if (!current || (expectedType && current.wizard_type !== expectedType)) throw coded(404, 'WIZARD_DRAFT_NOT_FOUND');
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    const { rows } = await client.query(
      `UPDATE maintenance_wizard_drafts SET status='cancelled',updated_at=now(),updated_by=$3,row_version=row_version+1
       WHERE id=$1 AND row_version=$2 AND created_by=$3 AND status='draft' AND deleted_at IS NULL RETURNING *`,
      [id,rowVersion,user.id]
    );
    if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
    await audit(client, user, 'wizard-draft-cancel', current.wizard_type, id, current, rows[0], 'انصراف از پیش‌نویس');
    return wizardDraftDto(rows[0]);
  });
}

function wizardOther(answers, key) {
  if (answers[key] === '__other__') return String(answers[key + 'Other'] || 'سایر').trim();
  return answers[key] == null ? '' : String(answers[key]).trim();
}

function wizardDate(value, field) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw coded(422, `WIZARD_${field.toUpperCase()}_INVALID`);
  return date.toISOString();
}

function requestPayloadFromDraft(draft, user) {
  const answers = asObject(draft.answers);
  const actionType = String(answers.actionType || '');
  if (!['emergency','preventive','service','fab'].includes(actionType)) throw coded(422, 'WIZARD_ACTION_TYPE_REQUIRED');
  const serviceType = wizardOther(answers, 'serviceType');
  if (actionType !== 'fab' && !serviceType) throw coded(422, 'WIZARD_SERVICE_TYPE_REQUIRED');
  const urgency = String(answers.urgency || '');
  if (!['critical','high','normal'].includes(urgency)) throw coded(422, 'WIZARD_URGENCY_INVALID');
  const stopProduction = String(answers.stopProduction || '');
  if (!['yes','no'].includes(stopProduction)) throw coded(422, 'WIZARD_PRODUCTION_IMPACT_REQUIRED');
  const descr = String(answers.description || answers.desc || '').trim();
  if (!descr) throw coded(422, 'DESCRIPTION_REQUIRED');
  const unit = String(answers.unit || user.unit || '').trim();
  if (!unit) throw coded(422, 'WIZARD_UNIT_REQUIRED');
  const subsystemId = answers.subsystemId && answers.subsystemId !== '__none__' ? answers.subsystemId : null;
  const equipmentId = answers.equipmentId && answers.equipmentId !== '__none__' ? answers.equipmentId : null;
  const form = { ...answers,
    actionType,
    serviceType,
    failureType:wizardOther(answers, 'failureType') || null,
    factoryId:answers.factoryId === '__none__' ? null : (answers.factoryId || null),
    categoryId:answers.categoryId === '__all__' ? null : (answers.categoryId || null),
    equipmentId,
    subsystemId,
    failureOccurredAt:wizardDate(answers.failureOccurredAt, 'failure_time'),
    stopOccurredAt:wizardDate(answers.stopOccurredAt, 'stop_time'),
    needBy:wizardDate(answers.needBy, 'need_by'),
    unit,
    phone:String(answers.phone || '').trim(),
    description:descr
  };
  const stopDuration = answers.stopDurationMinutes == null || answers.stopDurationMinutes === '' ? null : Number(answers.stopDurationMinutes);
  if (stopDuration != null && (!Number.isFinite(stopDuration) || stopDuration < 0 || stopDuration > 100000)) throw coded(422, 'WIZARD_STOP_DURATION_INVALID');
  form.stopDurationMinutes = stopDuration;
  delete form.attachments;
  return {
    type:actionType === 'fab' ? 'fab' : actionType === 'service' ? 'service' : 'repair',
    unit,
    assetId:subsystemId || equipmentId,
    descr,
    urgency,
    impact:stopProduction === 'yes',
    form
  };
}

function workOrderPayloadFromDraft(draft) {
  const answers = asObject(draft.answers);
  const requestId = answers.requestId && answers.requestId !== '__none__' ? String(answers.requestId) : null;
  const quantities = asObject(answers.partQuantities);
  const selectedParts = Array.isArray(answers.requiredParts) ? answers.requiredParts : [];
  if (selectedParts.length > 50) throw coded(422, 'TOO_MANY_REQUIRED_PARTS');
  const estimateInput=answers.estimatedHours;
  const estimatedHours=estimateInput==null||estimateInput===''?null:Number(estimateInput);
  if (estimatedHours!=null&&(!Number.isFinite(estimatedHours)||estimatedHours<=0||estimatedHours>100000)) throw coded(422, 'WIZARD_ESTIMATE_INVALID');
  const subsystemId = answers.subsystemId && answers.subsystemId !== '__none__' ? answers.subsystemId : null;
  const equipmentId = answers.equipmentId && answers.equipmentId !== '__none__' ? answers.equipmentId : null;
  const assignee = answers.assignee && answers.assignee !== '__none__' ? answers.assignee : null;
  const workOrderType = String(answers.workOrderType || answers.type || '');
  if (!['BD','CM','PM','SRV','FAB'].includes(workOrderType)) throw coded(422, 'WIZARD_WORK_ORDER_TYPE_REQUIRED');
  const priority = String(answers.priority || '');
  if (!['critical','high','normal'].includes(priority)) throw coded(422, 'WIZARD_PRIORITY_INVALID');
  const ptwChoice = answers.ptwChoice;
  if (!['yes','no'].includes(ptwChoice)) throw coded(422, 'WIZARD_PERMIT_DECISION_REQUIRED');
  const descr = String(answers.workDescription || answers.description || '').trim();
  if (!descr) throw coded(422, 'DESCRIPTION_REQUIRED');
  return {
    requestId,
    rowVersion:Number(answers.requestRowVersion),
    workOrderType,
    type:workOrderType,
    assetId:subsystemId || equipmentId,
    descr,
    priority,
    assignee,
    est:estimatedHours,
    failureType:wizardOther(answers, 'failureType') || null,
    probableCauses:answers.probableCause || '',
    confirmedRootCause:answers.confirmedRootCause || '',
    recommendedAction:answers.recommendedAction || '',
    performedAction:answers.performedAction || '',
    requiredParts:selectedParts.map(itemId => {
      const qty=Number(quantities[itemId]);
      if (!Number.isFinite(qty) || qty <= 0) throw coded(422, 'INVALID_PART_QUANTITY');
      return { itemId, qty };
    }),
    ptwRequired:ptwChoice === 'yes'
  };
}

async function submitWizardDraft(pool, user, id, input = {}, expectedType = null) {
  if (input.confirmed !== true) throw coded(422, 'FINAL_CONFIRMATION_REQUIRED');
  const rowVersion = versionOf(input.rowVersion);
  return withTransaction(pool, async client => {
    const { rows:locked } = await client.query(
      `SELECT * FROM maintenance_wizard_drafts WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL FOR UPDATE`, [id,user.id]
    );
    const current = locked[0];
    if (!current || (expectedType && current.wizard_type !== expectedType)) throw coded(404, 'WIZARD_DRAFT_NOT_FOUND');
    if (current.status === 'submitted') {
      if (current.target_entity_type === 'request') {
        const { rows } = await client.query(
          `SELECT r.*,a.id AS equipment_id,a.code AS equipment_code,a.name AS equipment_name
           FROM requests r LEFT JOIN assets a ON a.id=r.asset_id WHERE r.id=$1`, [current.target_entity_id]
        );
        if (!rows[0]) throw coded(404, 'RECORD_NOT_FOUND');
        return { request:requestDto(rows[0]), draft:wizardDraftDto(current), alreadySubmitted:true };
      }
      if (current.target_entity_type === 'work_order') {
        const { rows } = await client.query(
          `SELECT w.*,a.id AS equipment_id,a.code AS equipment_code,a.name AS equipment_name
           FROM work_orders w LEFT JOIN assets a ON a.id=w.asset_id WHERE w.id=$1`, [current.target_entity_id]
        );
        if (!rows[0]) throw coded(404, 'RECORD_NOT_FOUND');
        return { workOrder:workOrderDto(rows[0]), draft:wizardDraftDto(current), alreadySubmitted:true };
      }
      throw coded(409, 'WIZARD_DRAFT_ALREADY_SUBMITTED');
    }
    if (current.status !== 'draft') throw coded(409, 'WIZARD_DRAFT_NOT_ACTIVE');
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    const saved = asObject(current.draft);
    let result, targetType, targetId;
    if (current.wizard_type === 'request') {
      const created = await createRequestInTransaction(client, user, requestPayloadFromDraft(saved, user));
      result = { request:created };
      targetType = 'request';
      targetId = created.id;
    } else if (current.wizard_type === 'work_order') {
      const payload = workOrderPayloadFromDraft(saved);
      if (payload.requestId) {
        if (!Number.isInteger(payload.rowVersion) || payload.rowVersion < 1) throw coded(422, 'REQUEST_VERSION_REQUIRED');
        result = await approveRequestInTransaction(client, user, payload.requestId, payload);
        targetType = 'work_order';
        targetId = result.workOrder.id;
      } else {
        const created = await createWorkOrderInTransaction(client, user, payload);
        result = { workOrder:created };
        targetType = 'work_order';
        targetId = created.id;
      }
    } else {
      throw coded(422, 'WIZARD_TYPE_INVALID');
    }
    const { rows } = await client.query(
      `UPDATE maintenance_wizard_drafts SET status='submitted',target_entity_type=$3,target_entity_id=$4,
         updated_at=now(),updated_by=$5,row_version=row_version+1
       WHERE id=$1 AND row_version=$2 AND created_by=$5 AND status='draft' AND deleted_at IS NULL RETURNING *`,
      [id,rowVersion,targetType,targetId,user.id]
    );
    if (!rows[0]) throw coded(409, 'VERSION_CONFLICT');
    await audit(client, user, 'wizard-draft-submit', current.wizard_type, id, current, rows[0], `${targetType}:${targetId}`);
    return { ...result, draft:wizardDraftDto(rows[0]) };
  });
}

function requestFileDto(row) {
  return { id:row.id, name:row.original_name, mediaType:row.media_type, byteSize:Number(row.byte_size), sha256:row.sha256, createdAt:row.created_at };
}

async function saveRequestFile(pool, user, requestId, file, uploadToken = null) {
  return withTransaction(pool, async client => {
    const { rows:requests } = await client.query(
      'SELECT * FROM requests WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [requestId]
    );
    const request = requests[0];
    if (!request || (request.requester_id !== user.id && user.role !== 'admin')) throw coded(404, 'RECORD_NOT_FOUND');
    if (uploadToken) {
      const existing = await client.query('SELECT * FROM request_files WHERE request_id=$1 AND upload_token=$2 AND deleted_at IS NULL', [requestId,uploadToken]);
      if (existing.rows[0]) return requestFileDto(existing.rows[0]);
    }
    const { rows:counts } = await client.query('SELECT count(*)::int AS total FROM request_files WHERE request_id=$1 AND deleted_at IS NULL', [requestId]);
    if (Number(counts[0] && counts[0].total) >= 10) throw coded(422, 'ATTACHMENT_LIMIT_REACHED');
    const id = file.id || crypto.randomUUID();
    const { rows } = await client.query(
      `INSERT INTO request_files(id,request_id,original_name,stored_name,media_type,byte_size,sha256,upload_token,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
      [id,requestId,file.originalName,file.storedName,file.mediaType,file.byteSize,file.sha256,uploadToken,user.id]
    );
    await audit(client, user, 'attachment-create', 'request', requestId, null, rows[0], file.originalName);
    await publish(client, user, {
      type:'request.attachment_added', aggregateType:'request', aggregateId:requestId, permission:'request.view',
      equipmentId:request.asset_id, payload:{ requestId, fileId:id, name:file.originalName }
    });
    return requestFileDto(rows[0]);
  });
}

async function getRequestFileByUploadToken(pool, user, requestId, uploadToken) {
  const { rows } = await pool.query(
    `SELECT f.* FROM request_files f JOIN requests r ON r.id=f.request_id
     WHERE f.request_id=$1 AND f.upload_token=$2 AND f.deleted_at IS NULL
       AND r.deleted_at IS NULL AND (r.requester_id=$3 OR $4='admin')`,
    [requestId,uploadToken,user.id,user.role]
  );
  return rows[0] ? requestFileDto(rows[0]) : null;
}

async function listRequestFiles(pool, requestId) {
  const { rows } = await pool.query(
    'SELECT * FROM request_files WHERE request_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC', [requestId]
  );
  return rows.map(requestFileDto);
}

async function getRequestFile(pool, requestId, fileId) {
  const { rows } = await pool.query(
    'SELECT * FROM request_files WHERE request_id=$1 AND id=$2 AND deleted_at IS NULL', [requestId,fileId]
  );
  if (!rows[0]) throw coded(404, 'FILE_NOT_FOUND');
  return rows[0];
}

module.exports = {
  REQUEST_FLOW,
  WORK_ORDER_FLOW,
  LOCKED_REQUEST,
  LOCKED_WORK_ORDER,
  hasExecutionHistory,
  isRecipientAllowed,
  assertTransition,
  requestDto,
  workOrderDto,
  pmDto,
  createRequest,
  listRequests,
  getRequest,
  updateRequest,
  transitionRequest,
  approveRequest,
  archiveRequest,
  createWorkOrder,
  listWorkOrders,
  getWorkOrder,
  updateWorkOrder,
  linkWorkOrderPermit,
  transitionWorkOrder,
  archiveWorkOrder,
  cancelWorkOrder,
  correctRecord,
  createPmPlan,
  listPmPlans,
  getPmPlan,
  updatePmPlan,
  archivePmPlan,
  cancelPmPlan,
  generatePmWorkOrder,
  equipmentLinks,
  normalizeRequiredParts,
  technicianSuggestions,
  requestPayloadFromDraft,
  workOrderPayloadFromDraft,
  wizardOther,
  wizardDate,
  createWizardDraft,
  listWizardDrafts,
  getWizardDraft,
  updateWizardDraft,
  cancelWizardDraft,
  submitWizardDraft,
  saveRequestFile,
  getRequestFileByUploadToken,
  listRequestFiles,
  getRequestFile
};
