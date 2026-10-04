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

async function createRequest(pool, user, input) {
  const descr = String(input.descr || input.desc || '').trim();
  if (!descr) throw coded(422, 'DESCRIPTION_REQUIRED');
  return withTransaction(pool, async client => {
    const assetId = input.assetId || null;
    await requireEquipment(client, assetId, false);
    const id = crypto.randomUUID();
    const no = await nextNumber(client, 'request', 'WR');
    const history = appendHistory([], `ثبت درخواست توسط ${user.name || user.username}`);
    const { rows } = await client.query(
      `INSERT INTO requests(id,no,type,unit,requester,requester_id,asset_id,descr,urgency,impact,status,form,history)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'new',$11,$12) RETURNING *`,
      [id, no, input.type || 'repair', input.unit || user.unit || null, user.name || user.username, user.id,
        assetId, descr, input.urgency || 'normal', input.impact === true,
        JSON.stringify(input.form || {}), JSON.stringify(history)]
    );
    await audit(client, user, 'create', 'request', id, null, rows[0], 'ثبت درخواست تعمیر');
    await publish(client, user, {
      type: 'request.created', aggregateType: 'request', aggregateId: id, permission: 'request.view',
      equipmentId: assetId, payload: { id, no, status: 'new', assetId }
    });
    return requestDto(rows[0]);
  });
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

async function approveRequest(pool, user, id, input) {
  const rowVersion = versionOf(input.rowVersion);
  return withTransaction(pool, async client => {
    const current = await lockRow(client, 'requests', id);
    if (!['new', 'review'].includes(current.status)) throw coded(409, 'RECORD_LOCKED');
    if (Number(current.row_version) !== rowVersion) throw coded(409, 'VERSION_CONFLICT');
    const assignee = await requireUser(client, input.assignee || null);
    const assetId = current.asset_id;
    await requireEquipment(client, assetId, false);
    const workOrderId = crypto.randomUUID();
    const workOrderNo = await nextNumber(client, 'work_order', 'WO');
    const note = String(input.note || '').trim();
    const descr = current.descr + (note ? `\nیادداشت: ${note}` : '');
    const status = assignee ? 'assigned' : 'open';
    const type = current.type === 'fab' ? 'FAB' : current.type === 'service' ? 'SRV' : (current.urgency === 'critical' ? 'BD' : 'CM');
    const created = await client.query(
      `INSERT INTO work_orders(id,no,type,asset_id,descr,priority,assignee,status,req_id,times,parts,report,est)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,$10) RETURNING *`,
      [workOrderId, workOrderNo, type, assetId, descr, input.priority || current.urgency || 'normal', assignee, status, current.id, Number(input.est) || 4]
    );
    await linkWorkOrderAsset(client, workOrderId, assetId);
    const updated = await writeUpdate(client, 'requests', id, rowVersion, user.id, {
      status: 'wo',
      work_order_id: workOrderId,
      approved_at: new Date().toISOString(),
      history: JSON.stringify(appendHistory(current.history, `تأیید و صدور دستورکار ${workOrderNo} توسط ${user.name || user.username}`))
    });
    await audit(client, user, 'approve', 'request', id, current, updated, workOrderNo);
    await audit(client, user, 'create', 'work_order', workOrderId, null, created.rows[0], `صدور از ${current.no}`);
    await publish(client, user, {
      type: 'request.approved', aggregateType: 'request', aggregateId: id, permission: 'request.view',
      equipmentId: assetId, payload: { id, status: 'wo', assetId, workOrderId, rowVersion: Number(updated.row_version) }
    });
    await publish(client, user, {
      type: 'work_order.created', aggregateType: 'work_order', aggregateId: workOrderId, permission: 'work_order.view',
      equipmentId: assetId, payload: { id: workOrderId, no: workOrderNo, status, assetId, requestId: id }
    });
    return { request: requestDto(updated), workOrder: workOrderDto(created.rows[0]) };
  });
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

async function createWorkOrder(pool, user, input) {
  const descr = String(input.descr || '').trim();
  if (!descr) throw coded(422, 'DESCRIPTION_REQUIRED');
  return withTransaction(pool, async client => {
    const assetId = input.assetId || null;
    await requireEquipment(client, assetId, false);
    const assignee = await requireUser(client, input.assignee || null);
    const id = crypto.randomUUID();
    const no = await nextNumber(client, 'work_order', 'WO');
    const status = assignee ? 'assigned' : 'open';
    const { rows } = await client.query(
      `INSERT INTO work_orders(id,no,type,asset_id,descr,priority,assignee,status,req_id,pm_id,ptw,times,parts,report,est)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'{}'::jsonb,'[]'::jsonb,'{}'::jsonb,$12) RETURNING *`,
      [id, no, input.type || 'CM', assetId, descr, input.priority || 'normal', assignee, status,
        input.requestId || null, input.pmId || null, input.ptw === true, Number(input.est) || null]
    );
    await linkWorkOrderAsset(client, id, assetId);
    await audit(client, user, 'create', 'work_order', id, null, rows[0], 'صدور دستورکار');
    await publish(client, user, {
      type: 'work_order.created', aggregateType: 'work_order', aggregateId: id, permission: 'work_order.view',
      equipmentId: assetId, payload: { id, no, status, assetId }
    });
    return workOrderDto(rows[0]);
  });
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
    const updated = await writeUpdate(client, 'work_orders', id, rowVersion, user.id, {
      type: input.type || current.type,
      asset_id: assetId,
      descr,
      priority: input.priority || current.priority,
      assignee,
      status,
      ptw: input.ptw === undefined ? current.ptw : input.ptw === true,
      est: input.est === undefined ? current.est : Number(input.est) || null
    });
    await linkWorkOrderAsset(client, id, assetId);
    await audit(client, user, 'edit', 'work_order', id, current, updated, 'ویرایش دستورکار');
    await publish(client, user, {
      type: 'work_order.updated', aggregateType: 'work_order', aggregateId: id, permission: 'work_order.view',
      equipmentId: assetId, payload: { id, no: updated.no, status: updated.status, assetId, rowVersion: Number(updated.row_version) }
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
      report.by = user.id;
      report.at = times.end;
    }
    if (status === 'closed' && !hasExecutionHistory({ ...current, times, report })) throw coded(409, 'WORK_ORDER_NOT_EXECUTED');
    const updated = await writeUpdate(client, 'work_orders', id, rowVersion, user.id, {
      status,
      times: JSON.stringify(times),
      report: JSON.stringify(report),
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
  equipmentLinks
};
