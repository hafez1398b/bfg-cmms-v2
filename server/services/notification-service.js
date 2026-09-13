'use strict';

const { v4: uuid } = require('uuid');

/**
 * Notification service — full pipeline (Requirement #4)
 * Event → Backend → Notification Service → Database → Realtime/Event Channel → Client → Notification Center
 *
 * Diagnostic: if notifications don't appear, check:
 *  1) event was fired (caller called notify())
 *  2) backend inserted into notifications + notification_recipients
 *  3) realtime emitted to correct user rooms
 *  4) client has joined user:{id} room and listens to notification:new
 */

const KIND_META = {
  critical_failure:   { priority: 'critical', title: 'خرابی بحرانی' },
  equipment_critical: { priority: 'critical', title: 'وضعیت بحرانی تجهیز' },
  overdue_pm:         { priority: 'high',     title: 'PM سررسید گذشته' },
  failed_checklist:   { priority: 'high',     title: 'چک‌لیست ناموفق' },
  new_work_order:     { priority: 'normal',   title: 'دستورکار جدید' },
  assigned_work_order:{ priority: 'normal',   title: 'دستورکار تخصیص یافت' },
  approval_required:  { priority: 'high',     title: 'نیاز به تأیید' },
  ai_recommendation:  { priority: 'normal',   title: 'پیشنهاد هوشمند' },
  inventory_alert:    { priority: 'high',     title: 'هشدار موجودی' },
  workflow_escalation:{ priority: 'high',     title: 'ارتقای گردش کار' },
  pm_due:             { priority: 'normal',   title: 'سررسید PM نزدیک' },
  calibration_due:    { priority: 'normal',   title: 'سررسید کالیبراسیون' },
  tool_overdue:       { priority: 'high',     title: 'ابزار برگشت نشده' },
  leave_pending:      { priority: 'normal',   title: 'درخواست مرخصی' },
  system:             { priority: 'normal',   title: 'اعلان سیستمی' },
};

/**
 * Resolve target users for a notification — never broadcast to all unless explicitly intended.
 * Rules:
 *  - target_role → users with that role
 *  - target_factory → users whose unit/factory matches (heuristic)
 *  - target_equipment → users related via recent WOs/PM ownership (fallback to mgr/planner)
 *  - explicit userIds overrides targeting
 */
async function resolveRecipients(pool, { kind, targetRole, targetFactory, targetEquipment, explicitUserIds, priority }) {
  if (explicitUserIds && explicitUserIds.length) return explicitUserIds;

  const conditions = [];
  const vals = [];
  let base = `SELECT id FROM users WHERE active = true`;

  if (targetRole) {
    vals.push(targetRole);
    conditions.push(`role = $${vals.length}`);
  }
  // Never silently broadcast critical to everyone — require at least role filter
  if (priority === 'critical' && !targetRole && !targetEquipment && !targetFactory) {
    // escalate to mgr + admin only
    return (await pool.query(`SELECT id FROM users WHERE active = true AND role IN ('admin','mgr')`)).rows.map(r => r.id);
  }

  if (conditions.length) base += ' WHERE ' + conditions.join(' AND ');
  // If no targeting at all, fall back to admins/managers/planners only (not all users)
  if (conditions.length === 0 && !targetFactory && !targetEquipment) {
    const { rows } = await pool.query(`SELECT id FROM users WHERE active = true AND role IN ('admin','mgr','planner')`);
    return rows.map(r => r.id);
  }
  if (conditions.length) {
    const { rows } = await pool.query(base, vals);
    return rows.map(r => r.id);
  }
  // Factory/equipment targeting — for now return role-filtered set
  const { rows } = await pool.query(`SELECT id FROM users WHERE active = true AND role IN ('admin','mgr','planner','tech')`);
  return rows.map(r => r.id);
}

async function createNotification(pool, realtime, {
  kind, title, body, priority,
  actorId = null, entity = null, entityId = null,
  targetRole = null, targetFactory = null, targetEquipment = null,
  explicitUserIds = null, meta = {}, expiresAt = null,
}) {
  const metaKind = KIND_META[kind] || {};
  const finalPriority = priority || metaKind.priority || 'normal';
  const finalTitle = title || metaKind.title || kind;

  const id = uuid();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO notifications(id, kind, priority, title, body, actor_id, entity, entity_id, target_role, target_factory, target_equipment, meta, expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, kind, finalPriority, finalTitle, body, actorId, entity, entityId ? String(entityId) : null, targetRole, targetFactory, targetEquipment, JSON.stringify(meta), expiresAt]
    );
    const recipientIds = await resolveRecipients(client, { kind, targetRole, targetFactory, targetEquipment, explicitUserIds, priority: finalPriority });
    for (const uid of recipientIds) {
      await client.query(
        `INSERT INTO notification_recipients(notification_id, user_id, is_read) VALUES($1,$2,false) ON CONFLICT DO NOTHING`,
        [id, uid]
      );
    }
    await client.query('COMMIT');

    // Fetch full notification for emission
    const { rows } = await client.query(`SELECT * FROM notifications WHERE id=$1`, [id]);
    const notif = rows[0];
    notif.recipient_count = recipientIds.length;

    // Realtime delivery to each user room
    if (realtime) {
      for (const uid of recipientIds) {
        realtime.notificationNew(uid, { ...notif, is_read: false });
      }
      // Also emit a global refresh for badge counts
      realtime.emit('notifications:refresh', { kind, priority: finalPriority, count: recipientIds.length });
    }
    console.log(`[notifications] ${kind} "${finalTitle}" → ${recipientIds.length} recipients`);
    return { notification: notif, recipients: recipientIds };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[notifications] create failed:', e);
    throw e;
  } finally {
    client.release();
  }
}

// Batch helpers for common triggers
async function notifyCriticalFailure(pool, realtime, { failure, actorId }) {
  return createNotification(pool, realtime, {
    kind: 'critical_failure',
    priority: 'critical',
    title: `خرابی بحرانی: ${failure.failure_no || failure.id}`,
    body: `${failure.description || 'خرابی بحرانی ثبت شد'} — تجهیز: ${failure.asset_id}`,
    actorId,
    entity: 'failures',
    entityId: failure.id,
    targetEquipment: failure.asset_id,
    targetRole: null, // will resolve to admin/mgr
    meta: { failure, severity: failure.severity },
  });
}

async function notifyOverduePM(pool, realtime, { pm, asset, actorId }) {
  return createNotification(pool, realtime, {
    kind: 'overdue_pm',
    priority: 'high',
    title: `PM سررسید گذشته: ${pm.title || pm.id}`,
    body: `برنامه PM برای تجهیز ${asset?.name || pm.asset_id} سررسید گذشته است`,
    actorId,
    entity: 'pm_plans',
    entityId: pm.id,
    targetEquipment: pm.asset_id,
    meta: { pm, asset },
  });
}

module.exports = { createNotification, notifyCriticalFailure, notifyOverduePM, KIND_META, resolveRecipients };
