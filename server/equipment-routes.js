'use strict';

const express = require('express');
const { v4: uuid } = require('uuid');
const {
  requireEquipment, listParams, validateCreate, validateEquipmentPatch, coded
} = require('./equipment-service');
const { createEquipment, completeEquipment } = require('./equipment-commands');
const { createEquipmentIntakeRouter } = require('./equipment-intake-routes');
const { createSeleneActionRouter } = require('./selene-action-routes');

function createEquipmentRouter({ pool, io, authenticateToken, aiRegistry }) {
  const router = express.Router();
  router.use(authenticateToken);
  const emit = payload => io.emit('equipment-changed', payload);

  async function audit(client, req, action, id, before, after, note = '') {
    await client.query(
      `INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after)
       VALUES($1,now(),$2,$3,$4,$5,'equipment-v2',$6,$7,$8,$9)`,
      [uuid(), req.user.name || req.user.username, req.user.id, req.user.role, action, id,
        note, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
    );
  }

  router.get('/feature', requireEquipment('view'), async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT key,enabled,rollout_percent,allowed_roles,metadata
         FROM feature_flags WHERE key='equipment_v2'`
      );
      res.json(rows[0] || { key: 'equipment_v2', enabled: false, rollout_percent: 0, allowed_roles: [] });
    } catch (error) { next(error); }
  });

  router.get('/filters', requireEquipment('view'), async (_req, res, next) => {
    try {
      const [factories, categories, locations, responsibleUsers] = await Promise.all([
        pool.query(
          `SELECT id,code,name FROM assets
           WHERE deleted_at IS NULL AND (ext->>'nodeKind'='factory' OR cls='کارخانه')
           ORDER BY sort_order,name`
        ),
        pool.query(
          `SELECT c.id,c.code,c.name,c.factory_asset_id
           FROM asset_categories c ORDER BY c.sort_order,c.name`
        ),
        pool.query(
          `SELECT location.id,location.parent,location.code,location.name,
             COALESCE(location.ext->>'nodeKind','location') node_kind,factory.id factory_id
           FROM assets location
           LEFT JOIN LATERAL(
             WITH RECURSIVE ancestry(id,parent,kind,depth) AS (
               SELECT root.id,root.parent,root.ext->>'nodeKind',0 FROM assets root WHERE root.id=location.id
               UNION ALL
               SELECT parent_asset.id,parent_asset.parent,parent_asset.ext->>'nodeKind',ancestry.depth+1
               FROM assets parent_asset JOIN ancestry ON ancestry.parent=parent_asset.id
               WHERE parent_asset.deleted_at IS NULL AND ancestry.depth<64
             ) SELECT id FROM ancestry WHERE kind='factory' ORDER BY depth DESC LIMIT 1
           ) factory ON true
           WHERE location.deleted_at IS NULL AND location.type<>'eq'
             AND COALESCE(location.ext->>'nodeKind','location') IN ('location','area','line','unit')
           ORDER BY location.sort_order,location.name`
        ),
        pool.query('SELECT id,name,role FROM users WHERE active IS TRUE ORDER BY name')
      ]);
      res.json({
        factories: factories.rows,
        categories: categories.rows.map(row => ({ ...row, factory_id: row.factory_asset_id })),
        locations: locations.rows,
        responsibleUsers: responsibleUsers.rows
      });
    } catch (error) { next(error); }
  });

  router.get('/', requireEquipment('view'), async (req, res, next) => {
    try {
      const params = listParams(req.query);
      const where = [
        `a.type='eq'`,
        `a.deleted_at IS NULL`,
        `COALESCE(a.ext->>'nodeKind','equipment') NOT IN ('sub-equipment','subsystem','main-component','sub-component','sub','sys','panel')`,
        `NOT EXISTS(SELECT 1 FROM assets structural_parent WHERE structural_parent.id=a.parent
          AND structural_parent.type='eq' AND structural_parent.deleted_at IS NULL)`
      ];
      const values = [];
      const add = (sql, value) => {
        values.push(value);
        where.push(sql.replace('?', `$${values.length}`));
      };
      if (params.q) {
        values.push(params.q);
        const index = values.length;
        where.push(`(a.code ILIKE '%'||$${index}||'%' OR a.name ILIKE '%'||$${index}||'%'
          OR COALESCE(a.serial,'') ILIKE '%'||$${index}||'%'
          OR COALESCE(a.model,'') ILIKE '%'||$${index}||'%'
          OR COALESCE(a.maker,'') ILIKE '%'||$${index}||'%')`);
      }
      if (params.factoryId) add('COALESCE(c.factory_asset_id,ancestry_factory.id)=?', params.factoryId);
      if (params.categoryId) add('a.category_id=?', params.categoryId);
      if (params.status) add('a.status=?', params.status);
      if (params.criticality) add('a.crit=?', params.criticality);

      const from = `FROM assets a
        LEFT JOIN asset_categories c ON c.id=a.category_id
        LEFT JOIN LATERAL(
          WITH RECURSIVE ancestry(id,parent,kind,depth) AS (
            SELECT root.id,root.parent,root.ext->>'nodeKind',0 FROM assets root WHERE root.id=a.id
            UNION ALL
            SELECT parent_asset.id,parent_asset.parent,parent_asset.ext->>'nodeKind',ancestry.depth+1
            FROM assets parent_asset JOIN ancestry ON ancestry.parent=parent_asset.id
            WHERE parent_asset.deleted_at IS NULL AND ancestry.depth<64
          ) SELECT id FROM ancestry WHERE kind='factory' ORDER BY depth DESC LIMIT 1
        ) ancestry_factory ON true
        LEFT JOIN assets f ON f.id=COALESCE(c.factory_asset_id,ancestry_factory.id)
        LEFT JOIN assets loc ON loc.id=a.parent
        LEFT JOIN users responsible ON responsible.id=a.responsible_user_id`;
      const count = await pool.query(
        `SELECT count(*)::int total ${from} WHERE ${where.join(' AND ')}`,
        values
      );
      const total = count.rows[0]?.total || 0;
      const queryValues = [...values, params.limit, params.offset];
      const limitIndex = queryValues.length - 1;
      const offsetIndex = queryValues.length;
      const { rows } = await pool.query(
        `SELECT a.id,a.code,a.name,a.parent,a.cls,a.status,a.crit,a.maker,a.model,a.serial,a.year,
          a.install,a.install_date,a.power,a.hours,a.health_score,a.is_active,a.sort_order,a.row_version,a.updated_at,
          a.activity_type,a.manufacturer_country,a.operational_status,a.responsible_user_id,
          responsible.name responsible_name,a.general_notes,a.record_status,
          a.ext->>'nodeKind' AS node_kind,c.id category_id,c.name category_name,
          f.id factory_id,f.name factory_name,
          COALESCE(NULLIF(a.ext->>'locationDescription',''),loc.name) location_name,
          lp.last_run,CASE WHEN lp.last_run IS NOT NULL AND lp.interval_days IS NOT NULL
            THEN lp.last_run+(lp.interval_days||' days')::interval END next_pm,
          (SELECT count(*)::int FROM work_orders w WHERE w.asset_id=a.id AND w.deleted_at IS NULL
            AND w.status NOT IN ('closed','cancel','done','completed')) open_wo,
          NULL::numeric maintenance_cost
         ${from}
         LEFT JOIN LATERAL(
           SELECT p.last_run,p.interval_days FROM pm_plans p
           WHERE p.asset_id=a.id AND p.status='active' AND p.deleted_at IS NULL
           ORDER BY p.last_run DESC NULLS LAST LIMIT 1
         ) lp ON true
         WHERE ${where.join(' AND ')} ORDER BY ${params.sort} ${params.direction},a.id
         LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
        queryValues
      );
      res.json({
        data: rows,
        pagination: { page: params.page, limit: params.limit, total, pages: Math.ceil(total / params.limit) },
        source: 'postgresql'
      });
    } catch (error) { next(error); }
  });

  // Kept as a compatibility/data endpoint only; the Equipment UI has no Tree mode or route.
  router.get('/tree', requireEquipment('view'), async (req, res, next) => {
    try {
      const parent = req.query.parentId || null;
      const query = String(req.query.q || '').trim().slice(0, 120);
      const values = [parent];
      const where = ['a.deleted_at IS NULL'];
      if (query) {
        values.push(query);
        where.push(`(a.code ILIKE '%'||$${values.length}||'%' OR a.name ILIKE '%'||$${values.length}||'%')`);
      } else {
        where.push('(($1::text IS NULL AND a.parent IS NULL) OR a.parent=$1)');
      }
      const filters = [];
      for (const [column, value] of [
        ['dc.factory_asset_id', req.query.factoryId], ['d.category_id', req.query.categoryId],
        ['d.status', req.query.status], ['d.crit', req.query.criticality]
      ]) {
        if (value) { values.push(value); filters.push(`${column}=$${values.length}`); }
      }
      if (filters.length) {
        where.push(`EXISTS(WITH RECURSIVE descendants AS (
          SELECT x.id,x.parent,x.type,x.category_id,x.status,x.crit FROM assets x WHERE x.id=a.id AND x.deleted_at IS NULL
          UNION ALL
          SELECT ch.id,ch.parent,ch.type,ch.category_id,ch.status,ch.crit FROM assets ch
            JOIN descendants d0 ON ch.parent=d0.id WHERE ch.deleted_at IS NULL
        ) SELECT 1 FROM descendants d LEFT JOIN asset_categories dc ON dc.id=d.category_id
          WHERE d.type='eq' AND ${filters.join(' AND ')} LIMIT 1)`);
      }
      const { rows } = await pool.query(
        `SELECT a.id,a.parent,a.code,a.name,a.type,a.cls,a.status,a.crit,a.is_active,a.sort_order,a.row_version,a.ext,
          (SELECT count(*)::int FROM assets ch WHERE ch.parent=a.id AND ch.deleted_at IS NULL) child_count
         FROM assets a WHERE ${where.join(' AND ')} ORDER BY a.sort_order,a.name`, values
      );
      res.json({ data: rows, parentId: parent, source: 'postgresql' });
    } catch (error) { next(error); }
  });

  router.use('/import', createEquipmentIntakeRouter({
    pool, registry: aiRegistry || { providers: {}, candidates() { return []; } }
  }));
  router.use('/actions', createSeleneActionRouter({ pool, io }));

  router.get('/:id', requireEquipment('view'), async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT a.*,c.name category_name,COALESCE(c.factory_asset_id,ancestry_factory.id) factory_id,f.name factory_name,
          p.name parent_name,COALESCE(NULLIF(a.ext->>'locationDescription',''),p.name) location_name,
          responsible.name responsible_name,
          (SELECT max(pm_last.last_run) FROM pm_plans pm_last
            WHERE pm_last.asset_id=a.id AND pm_last.status='active' AND pm_last.deleted_at IS NULL) last_run,
          (SELECT count(*)::int FROM work_orders w WHERE w.asset_id=a.id AND w.deleted_at IS NULL) wo_count,
          (SELECT count(*)::int FROM work_orders w WHERE w.asset_id=a.id AND w.deleted_at IS NULL
            AND w.status NOT IN('closed','cancel','done','completed')) open_wo,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id',pm.id,'title',pm.title,'interval_days',pm.interval_days,'last_run',pm.last_run,
            'status',pm.status,'checklist',pm.checklist,'code',COALESCE(pm.ext->>'code',pm.source_ref),
            'owner_role',COALESCE(pm.ext->>'ownerRole',pm.spec),'consumable',pm.ext->>'consumable',
            'row_version',pm.row_version
          ) ORDER BY pm.title) FROM pm_plans pm WHERE pm.asset_id=a.id AND pm.deleted_at IS NULL),'[]'::jsonb) pm_plans,
          COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.created_at DESC) FROM work_orders w
            WHERE w.asset_id=a.id AND w.deleted_at IS NULL),'[]'::jsonb) work_orders,
          COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.created_at DESC) FROM work_orders w
            WHERE w.asset_id=a.id AND w.deleted_at IS NULL AND w.status IN('closed','done','completed')),'[]'::jsonb) maintenance_history,
          COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC) FROM requests r
            WHERE r.asset_id=a.id AND r.deleted_at IS NULL),'[]'::jsonb) requests,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id',i.id,'code',i.code,'name',i.name,'unit',i.unit,'stock',i.stock,
            'minimum',i.min_stock,'price',i.price,'relation_type',rel.relation_type,
            'quantity_required',rel.quantity_required,'notes',rel.notes
          ) ORDER BY i.name) FROM asset_spare_parts rel JOIN items i ON i.id=rel.item_id
            WHERE rel.asset_id=a.id AND i.deleted_at IS NULL),'[]'::jsonb) spare_parts,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id',ch.id,'parent',ch.parent,'code',ch.code,'name',ch.name,'type',ch.type,
            'status',ch.status,'crit',ch.crit,'nodeKind',ch.ext->>'nodeKind',
            'child_count',(SELECT count(*)::int FROM assets g WHERE g.parent=ch.id AND g.deleted_at IS NULL)
          ) ORDER BY ch.sort_order,ch.name) FROM assets ch WHERE ch.parent=a.id AND ch.deleted_at IS NULL),'[]'::jsonb) children,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id',n.id,'code',n.code,'name',n.name,'period_days',n.period_days,
            'last_cal',n.last_cal,'type',n.type,'cls',n.cls
          ) ORDER BY n.name) FROM instruments n WHERE n.asset_id=a.id),'[]'::jsonb) calibration_instruments,
          COALESCE((SELECT jsonb_agg(to_jsonb(failure) ORDER BY failure.occurred_at DESC)
            FROM failures failure WHERE failure.equipment_id=a.id AND failure.deleted_at IS NULL),'[]'::jsonb) failures,
          COALESCE((SELECT jsonb_agg(
            to_jsonb(execution)||jsonb_build_object('template_title',template.title,'answers',
              COALESCE((SELECT jsonb_agg(to_jsonb(answer) ORDER BY answer.item_key)
                FROM checklist_results answer WHERE answer.execution_id=execution.id),'[]'::jsonb))
            ORDER BY execution.started_at DESC)
            FROM checklist_executions execution LEFT JOIN checklist_templates template ON template.id=execution.template_id
            WHERE execution.equipment_id=a.id),'[]'::jsonb) checklist_executions,
          COALESCE(a.ext->'documents','[]'::jsonb) documents,
          COALESCE(a.ext->'instructions','[]'::jsonb) instructions,a.history movements
         FROM assets a
         LEFT JOIN asset_categories c ON c.id=a.category_id
         LEFT JOIN LATERAL(
           WITH RECURSIVE factory_chain(id,parent,kind,depth) AS (
             SELECT root.id,root.parent,root.ext->>'nodeKind',0 FROM assets root WHERE root.id=a.id
             UNION ALL
             SELECT parent_asset.id,parent_asset.parent,parent_asset.ext->>'nodeKind',factory_chain.depth+1
             FROM assets parent_asset JOIN factory_chain ON factory_chain.parent=parent_asset.id
             WHERE parent_asset.deleted_at IS NULL AND factory_chain.depth<64
           ) SELECT id FROM factory_chain WHERE kind='factory' ORDER BY depth DESC LIMIT 1
         ) ancestry_factory ON true
         LEFT JOIN assets f ON f.id=COALESCE(c.factory_asset_id,ancestry_factory.id)
         LEFT JOIN assets p ON p.id=a.parent
         LEFT JOIN users responsible ON responsible.id=a.responsible_user_id
         WHERE (a.id=$1 OR lower(a.code)=lower($1)) AND a.deleted_at IS NULL`,
        [req.params.id]
      );
      if (!rows[0]) return res.sendStatus(404);
      const data = rows[0];
      const pathResult = await pool.query(
        `WITH RECURSIVE ancestry AS (
           SELECT id,parent,code,name,type,ext,0 depth FROM assets WHERE id=$1
           UNION ALL
           SELECT parent_asset.id,parent_asset.parent,parent_asset.code,parent_asset.name,parent_asset.type,parent_asset.ext,ancestry.depth+1
           FROM assets parent_asset JOIN ancestry ON ancestry.parent=parent_asset.id
           WHERE ancestry.depth<64
         ) SELECT id,parent,code,name,type,ext->>'nodeKind' "nodeKind",depth
           FROM ancestry ORDER BY depth DESC`, [data.id]
      );
      data.path = pathResult.rows;
      data.risks = data.ext?.risks || [];
      data.consumed_parts = [];
      data.cost_entries = [];
      data.downtimes = [];
      for (const workOrder of data.work_orders || []) {
        const at = workOrder.times?.end || workOrder.created_at || null;
        for (const part of workOrder.parts || []) {
          const item = (data.spare_parts || []).find(row => row.id === (part.itemId || part.item_id));
          data.consumed_parts.push({
            wo_id: workOrder.id, wo_no: workOrder.no, item_id: item?.id || part.itemId,
            item_code: item?.code || '', item_name: item?.name || 'قطعه ثبت‌شده',
            qty: Number(part.qty) || 0, unit: item?.unit || '', unit_price: item?.price ?? null, at
          });
        }
        const values = Object.values(workOrder.costs || {}).map(Number).filter(Number.isFinite);
        let amount = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
        for (const part of workOrder.parts || []) {
          const item = (data.spare_parts || []).find(row => row.id === (part.itemId || part.item_id));
          if (item && Number.isFinite(Number(item.price))) amount = (amount || 0) + (Number(part.qty) || 0) * Number(item.price);
        }
        if (amount !== null) data.cost_entries.push({ wo_id: workOrder.id, wo_no: workOrder.no, at, amount });
        const duration = Number(workOrder.times?.durationHours);
        if (Number.isFinite(duration)) data.downtimes.push({
          wo_id: workOrder.id, wo_no: workOrder.no, start: workOrder.times?.start || null,
          end: workOrder.times?.end || null, hours: duration, reason: workOrder.descr || ''
        });
      }
      data.maintenance_cost = data.cost_entries.length
        ? data.cost_entries.reduce((sum, row) => sum + row.amount, 0)
        : null;
      data.rca = (data.maintenance_history || []).map(workOrder => ({
        wo_id: workOrder.id, wo_no: workOrder.no, at: workOrder.times?.end || workOrder.created_at || null,
        root_cause: workOrder.report?.rootCause || workOrder.report?.rca || null,
        action: workOrder.report?.correctiveAction || null
      })).filter(row => row.root_cause);
      res.json({ data, source: 'postgresql' });
    } catch (error) { next(error); }
  });

  router.post('/', requireEquipment('create'), async (req, res, next) => {
    const errors = validateCreate(req.body || {});
    if (errors.length) return res.status(422).json({ error: 'VALIDATION_ERROR', fields: errors });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await createEquipment(client, req.user, req.body || {});
      await client.query('COMMIT');
      emit({ action: 'create', id: row.id });
      res.status(201).json({ data: row, committed: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { client.release(); }
  });

  router.patch('/:id', requireEquipment('edit'), async (req, res, next) => {
    const body = req.body || {};
    const rowVersion = Number(body.rowVersion ?? body.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion < 1) return res.status(422).json({ error: 'ROW_VERSION_REQUIRED' });
    const errors = validateEquipmentPatch(body);
    if (errors.length) return res.status(422).json({ error: 'VALIDATION_ERROR', fields: errors });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await completeEquipment(client, req.user, req.params.id, body, rowVersion);
      await client.query('COMMIT');
      emit({ action: 'edit', id: req.params.id });
      res.json({ data: row, committed: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { client.release(); }
  });

  router.post('/:id/move', requireEquipment('move'), async (req, res, next) => {
    const { parentId = null, sortOrder = 0, rowVersion } = req.body || {};
    if (!Number.isInteger(Number(rowVersion)) || Number(rowVersion) < 1) return res.status(422).json({ error: 'ROW_VERSION_REQUIRED' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const old = await client.query('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [req.params.id]);
      if (!old.rows[0]) { await client.query('ROLLBACK'); return res.sendStatus(404); }
      if (Number(rowVersion) !== Number(old.rows[0].row_version)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'VERSION_CONFLICT', current: old.rows[0].row_version });
      }
      if (parentId === req.params.id) { await client.query('ROLLBACK'); return res.status(422).json({ error: 'TREE_CYCLE' }); }
      if (parentId) {
        const parent = await client.query('SELECT id FROM assets WHERE id=$1 AND deleted_at IS NULL', [parentId]);
        if (!parent.rows[0]) { await client.query('ROLLBACK'); return res.status(422).json({ error: 'PARENT_NOT_FOUND' }); }
        const cycle = await client.query(
          `WITH RECURSIVE descendants(id) AS (
             SELECT id FROM assets WHERE parent=$1 AND deleted_at IS NULL
             UNION ALL SELECT a.id FROM assets a JOIN descendants d ON a.parent=d.id WHERE a.deleted_at IS NULL
           ) SELECT 1 FROM descendants WHERE id=$2 LIMIT 1`, [req.params.id, parentId]
        );
        if (cycle.rows[0]) { await client.query('ROLLBACK'); return res.status(422).json({ error: 'TREE_CYCLE' }); }
      }
      const { rows } = await client.query(
        `UPDATE assets SET parent=$2,sort_order=$3,updated_by=$4,row_version=row_version+1,updated_at=now()
         WHERE id=$1 AND row_version=$5 RETURNING *`,
        [req.params.id, parentId, Number(sortOrder) || 0, req.user.id, rowVersion]
      );
      await audit(client, req, 'move', req.params.id, old.rows[0], rows[0], req.body.reason || '');
      await client.query('COMMIT');
      emit({ action: 'move', id: req.params.id });
      res.json({ data: rows[0] });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { client.release(); }
  });

  router.delete('/:id', requireEquipment('delete'), async (req, res, next) => {
    const reason = String(req.body?.reason || '').trim();
    const rowVersion = Number(req.body?.rowVersion ?? req.body?.row_version);
    if (!reason) return res.status(422).json({ error: 'ARCHIVE_REASON_REQUIRED' });
    if (!Number.isInteger(rowVersion) || rowVersion < 1) return res.status(422).json({ error: 'ROW_VERSION_REQUIRED' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const old = await client.query('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [req.params.id]);
      if (!old.rows[0]) { await client.query('ROLLBACK'); return res.sendStatus(404); }
      if (Number(old.rows[0].row_version) !== rowVersion) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'VERSION_CONFLICT', current: old.rows[0].row_version });
      }
      const children = await client.query('SELECT count(*)::int count FROM assets WHERE parent=$1 AND deleted_at IS NULL', [req.params.id]);
      if (children.rows[0].count) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'HAS_ACTIVE_CHILDREN', count: children.rows[0].count });
      }
      const archived = await client.query(
        `UPDATE assets SET is_active=false,status='stopped',deleted_at=now(),deleted_by=$2,
          delete_reason=$3,updated_by=$2,row_version=row_version+1,updated_at=now()
         WHERE id=$1 AND row_version=$4 AND deleted_at IS NULL RETURNING *`,
        [req.params.id, req.user.id, reason, rowVersion]
      );
      if (!archived.rows[0]) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'VERSION_CONFLICT' }); }
      await audit(client, req, 'soft-delete', req.params.id, old.rows[0], archived.rows[0], reason);
      await client.query('COMMIT');
      emit({ action: 'soft-delete', id: req.params.id });
      res.json({ data: archived.rows[0], historyPreserved: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { client.release(); }
  });

  router.use((error, _req, res, _next) => {
    console.error('Equipment V2 API:', error.code || 'db_error');
    if (error.code === '23505') return res.status(409).json({ error: 'DUPLICATE_CODE' });
    const status = Number(error.status) || 500;
    if (status >= 500) return res.status(500).json({ error: 'EQUIPMENT_API_ERROR' });
    res.status(status).json({ error: error.code || 'EQUIPMENT_API_ERROR' });
  });
  return router;
}

module.exports = { createEquipmentRouter };
