'use strict';
const { v4: uuid } = require('uuid');

const NOTIFICATION_TYPES = new Set([
  'critical_failure','equipment_critical','overdue_pm','failed_checklist','new_work_order',
  'assigned_work_order','approval_required','ai_recommendation_approval','inventory_alert','workflow_escalation'
]);
const PRIORITIES = new Set(['low','normal','high','critical']);

function validate(input={}) {
  const fields=[];
  if (!NOTIFICATION_TYPES.has(input.type)) fields.push('type');
  if (!String(input.title||'').trim()) fields.push('title');
  if (!String(input.body||'').trim()) fields.push('body');
  if (input.priority && !PRIORITIES.has(input.priority)) fields.push('priority');
  if (!(input.targets?.userIds?.length || input.targets?.roles?.length || input.targets?.factoryId)) fields.push('targets');
  return fields;
}

async function resolveRecipients(client, targets={}) {
  const recipients = new Set((targets.userIds||[]).filter(Boolean));
  if (targets.roles?.length) {
    const { rows } = await client.query(
      'SELECT id FROM users WHERE active=true AND role=ANY($1::text[])', [targets.roles]
    );
    rows.forEach(row=>recipients.add(row.id));
  }
  if (targets.factoryId) {
    const { rows } = await client.query(
      `SELECT DISTINCT u.id FROM users u
       LEFT JOIN user_scopes s ON s.user_id=u.id
       WHERE u.active=true AND (u.role='admin' OR (s.scope_type='factory' AND s.scope_id=$1))`,
      [targets.factoryId]
    );
    rows.forEach(row=>recipients.add(row.id));
  }
  return [...recipients];
}

async function createNotification(client, input, actorId) {
  const invalid=validate(input);
  if (invalid.length) throw Object.assign(new Error('NOTIFICATION_VALIDATION_ERROR'),{status:422,fields:invalid});
  const recipients=await resolveRecipients(client,input.targets);
  if (!recipients.length) throw Object.assign(new Error('NO_AUTHORIZED_RECIPIENT'),{status:422});
  const id=uuid(),priority=input.priority||'normal';
  const { rows } = await client.query(
    `INSERT INTO notifications(id,type,title,body,priority,entity_type,entity_id,factory_id,equipment_id,metadata,created_by,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [id,input.type,String(input.title).trim(),String(input.body).trim(),priority,input.entityType||null,input.entityId||null,
     input.targets.factoryId||null,input.equipmentId||null,JSON.stringify(input.metadata||{}),actorId||null,input.expiresAt||null]
  );
  await client.query(
    `INSERT INTO notification_recipients(notification_id,user_id,delivery_channels)
     SELECT $1,unnest($2::text[]),$3::jsonb`,
    [id,recipients,JSON.stringify(input.channels?.length?input.channels:['in_app'])]
  );
  await client.query(
    `INSERT INTO event_outbox(id,event_type,aggregate_type,aggregate_id,actor_id,payload,recipient_ids)
     VALUES($1,'notification.created','notification',$2,$3,$4,$5)`,
    [uuid(),id,actorId||null,JSON.stringify({...rows[0],read_at:null}),JSON.stringify(recipients)]
  );
  return {...rows[0],recipientIds:recipients};
}

module.exports={NOTIFICATION_TYPES,PRIORITIES,validate,resolveRecipients,createNotification};
