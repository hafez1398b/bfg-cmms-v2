'use strict';

const { requireEquipmentScope } = require('./ai-service');

const NO_DATA_ANSWER = 'N/A — داده کافی ثبت نشده است';
const QUERY_ID = Object.freeze({
  equipment_count: 'portfolio.equipment.count.v1',
  open_work_orders: 'portfolio.work_orders.open_count.v1',
  overdue_pm: 'portfolio.pm.overdue_count.v1',
  low_stock: 'portfolio.inventory.low_stock_count.v1'
});
const REQUIRED_PERMISSION = Object.freeze({
  equipment_count: 'equipment.view',
  open_work_orders: 'work_order.view',
  overdue_pm: 'pm.view',
  low_stock: 'inventory.view'
});

function coded(status, code) {
  return Object.assign(new Error(code), { status, code });
}

function normalizeQuestion(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('fa')
    .replace(/[ي]/g, 'ی').replace(/[ك]/g, 'ک').replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\s\u200c]+/g, ' ').trim();
}

function classifyGlobalQuestion(value) {
  const q = normalizeQuestion(value);
  if (!q) return null;
  if (/(چند|تعداد|count|number).{0,30}(تجهیز|دارایی)|(تجهیز|دارایی).{0,30}(چند|تعداد|ثبت|count)/i.test(q)) return 'equipment_count';
  if (/(دستور.?کار|work order).{0,30}(باز|فعال|open)|(باز|فعال|open).{0,30}(دستور.?کار|work order)/i.test(q)) return 'open_work_orders';
  if (/(pm|نگهداری پیشگیرانه).{0,35}(سررسید|معوق|عقب.?افتاده|overdue)|(سررسید|معوق|عقب.?افتاده|overdue).{0,35}(pm|نگهداری پیشگیرانه)/i.test(q)) return 'overdue_pm';
  if (/(کمبود موجودی|کمبود انبار|زیر نقطه سفارش|low stock|stock shortage)/i.test(q)) return 'low_stock';
  if (/(وضعیت داده|وضعیت اطلاعات|کیفیت داده|داده.?های? موجود|data status)/i.test(q)) return 'data_status';
  return null;
}

function authorizedEquipmentCte() {
  return `WITH RECURSIVE authorized_equipment AS (
    SELECT a.id,COALESCE(c.factory_asset_id,factory_ancestor.id) AS factory_id
    FROM assets a
    LEFT JOIN asset_categories c ON c.id=a.category_id
    LEFT JOIN LATERAL (
      WITH RECURSIVE ancestors(id,parent,node_kind,depth) AS (
        SELECT p.id,p.parent,p.ext->>'nodeKind',0 FROM assets p WHERE p.id=a.id
        UNION ALL
        SELECT p.id,p.parent,p.ext->>'nodeKind',ancestors.depth+1
        FROM assets p JOIN ancestors ON p.id=ancestors.parent
        WHERE ancestors.depth<64
      ) SELECT id FROM ancestors WHERE lower(COALESCE(node_kind,''))='factory' ORDER BY depth LIMIT 1
    ) factory_ancestor ON true
    WHERE a.type='eq' AND a.deleted_at IS NULL
      AND ($1='admin' OR EXISTS (
        SELECT 1 FROM user_scopes s WHERE s.user_id=$2 AND (
          s.scope_type='company' OR (s.scope_type='equipment' AND s.scope_id=a.id)
          OR (s.scope_type='factory' AND s.scope_id=COALESCE(c.factory_asset_id,factory_ancestor.id))
        )
      ))
  )`;
}

const GLOBAL_QUERIES = Object.freeze({
  equipment_count: `${authorizedEquipmentCte()}
    SELECT count(*)::int AS value,
      COALESCE((SELECT array_agg(id) FROM (SELECT id FROM authorized_equipment ORDER BY id LIMIT 50) sample),'{}') AS source_ids
    FROM authorized_equipment`,
  open_work_orders: `${authorizedEquipmentCte()}
    SELECT count(w.id)::int AS value,
      COALESCE((SELECT array_agg(id) FROM (SELECT w2.id FROM work_orders w2 JOIN authorized_equipment e2 ON e2.id=w2.asset_id
        WHERE w2.deleted_at IS NULL AND lower(COALESCE(w2.status,'')) NOT IN ('closed','cancel','cancelled','canceled','done','archived') ORDER BY w2.id LIMIT 50) sample),'{}') AS source_ids
    FROM work_orders w JOIN authorized_equipment e ON e.id=w.asset_id
    WHERE w.deleted_at IS NULL AND lower(COALESCE(w.status,'')) NOT IN ('closed','cancel','cancelled','canceled','done','archived')`,
  overdue_pm: `${authorizedEquipmentCte()}
    SELECT count(o.id)::int AS value,
      COALESCE((SELECT array_agg(id) FROM (SELECT o2.id FROM pm_occurrences o2 JOIN authorized_equipment e2 ON e2.id=o2.equipment_id
        WHERE o2.status IN ('due','overdue') AND o2.due_at<=now() AND o2.provenance_status='verified' ORDER BY o2.id LIMIT 50) sample),'{}') AS source_ids
    FROM pm_occurrences o JOIN authorized_equipment e ON e.id=o.equipment_id
    WHERE o.status IN ('due','overdue') AND o.due_at<=now() AND o.provenance_status='verified'`,
  low_stock: `WITH scoped_warehouses AS (
      SELECT w.id FROM warehouses w WHERE w.deleted_at IS NULL
        AND ($1='admin' OR EXISTS (
          SELECT 1 FROM user_scopes s WHERE s.user_id=$2 AND (
            s.scope_type='company' OR (s.scope_type='factory' AND s.scope_id=w.factory_asset_id)
          )
        ))
    ), item_availability AS (
      SELECT i.id,i.min_stock,SUM(b.on_hand-b.reserved) AS available
      FROM scoped_warehouses sw
      JOIN storage_locations l ON l.warehouse_id=sw.id AND l.deleted_at IS NULL
      JOIN item_balances b ON b.location_id=l.id
      JOIN items i ON i.id=b.item_id AND i.deleted_at IS NULL
      GROUP BY i.id,i.min_stock
    )
    SELECT count(*) FILTER (WHERE min_stock>0 AND available<min_stock)::int AS value,
      count(*)::int AS observed_items,
      (SELECT count(*)::int FROM scoped_warehouses) AS observed_warehouses,
      COALESCE(array_agg(id) FILTER (WHERE min_stock>0 AND available<min_stock),'{}') AS source_ids
    FROM item_availability`
});

function scopeLabel(user) {
  if (user.role === 'admin') return 'company';
  return 'user_scopes';
}

function resultEnvelope({ answer, metric, value, sourceIds = [], scope, status, note }) {
  const sourceType = metric === 'equipment_count' ? 'asset'
    : metric === 'open_work_orders' ? 'work_order'
      : metric === 'overdue_pm' ? 'pm_occurrence'
        : metric === 'low_stock' ? 'inventory_item' : 'portfolio_metric';
  const hasData = Number(value) > 0;
  return {
    answer,
    evidence: [{ sourceType, sourceIds: (sourceIds || []).slice(0, 50), observedCount: Number(value) || 0, queryId: QUERY_ID[metric] || 'portfolio.data_status.v1' }],
    provenance: { source: 'PostgreSQL', queryId: QUERY_ID[metric] || 'portfolio.data_status.v1', scope, readOnly: true, note: note || 'پرس‌وجوی ثابت و ازپیش‌تعریف‌شده؛ SQL از مدل دریافت یا اجرا نمی‌شود.' },
    confidence: hasData ? 1 : null,
    provider: 'PostgreSQL',
    model: 'deterministic-query-catalog-v1',
    status
  };
}

async function runGlobalMetric({ pool, user, metric }) {
  const query = GLOBAL_QUERIES[metric];
  if (!query) throw coded(422, 'UNSUPPORTED_CHAT_QUERY');
  const result = await pool.query(query, [user.role, user.id]);
  const row = result.rows[0] || {};
  const value = Number(row.value) || 0;
  const hasObservedData = metric !== 'low_stock' || (Number(row.observed_items) > 0 && Number(row.observed_warehouses) > 0);
  const hasData = value > 0 || (metric === 'equipment_count' && value > 0);
  if (!hasObservedData || !hasData) {
    return resultEnvelope({
      answer: NO_DATA_ANSWER, metric, value: hasObservedData ? value : 0,
      sourceIds: row.source_ids || [], scope: scopeLabel(user), status: 'insufficient_data',
      note: !hasObservedData ? 'در Scope مجاز، موجودی قابل مشاهده‌ای برای ارزیابی وجود ندارد.' : 'Query ثابت اجرا شد اما رکورد معتبر کافی یافت نشد.'
    });
  }
  const labels = {
    equipment_count: `در PostgreSQL تعداد ${value} تجهیز مجاز ثبت شده است.`,
    open_work_orders: `تعداد دستورکارهای باز در Scope مجاز: ${value}.`,
    overdue_pm: `تعداد PMهای سررسیدشده و تأییدشده در Scope مجاز: ${value}.`,
    low_stock: `تعداد اقلام زیر نقطه سفارش در انبارهای مجاز: ${value}.`
  };
  return resultEnvelope({ answer: labels[metric], metric, value, sourceIds: row.source_ids || [], scope: scopeLabel(user), status: 'answered' });
}

async function dataStatus({ pool, user, hasPermission }) {
  const metrics = [];
  for (const metric of Object.keys(REQUIRED_PERMISSION)) {
    if (!(await hasPermission(user, REQUIRED_PERMISSION[metric]))) {
      metrics.push({ metric, status: 'restricted', answer: 'به‌دلیل مجوز یا Scope در این درخواست بررسی نشد.' });
      continue;
    }
    const result = await runGlobalMetric({ pool, user, metric });
    metrics.push({ metric, status: result.status, answer: result.answer, evidence: result.evidence });
  }
  const available = metrics.filter(item => item.status === 'answered').length;
  const answer = available
    ? `وضعیت داده در Scope مجاز: ${available} شاخص دارای رکورد معتبر است؛ سایر شاخص‌ها فاقد داده کافی یا محدود به مجوز هستند.`
    : NO_DATA_ANSWER;
  return {
    answer, evidence: metrics.flatMap(item => item.evidence || []),
    provenance: { source: 'PostgreSQL', queryId: 'portfolio.data_status.v1', scope: scopeLabel(user), readOnly: true, metrics: metrics.map(({ metric, status }) => ({ metric, status })) },
    confidence: available ? 1 : null, provider: 'PostgreSQL', model: 'deterministic-query-catalog-v1',
    status: available ? 'answered' : 'insufficient_data'
  };
}

async function answerGlobal({ pool, user, input, hasPermission }) {
  const metric = classifyGlobalQuestion(input.question);
  if (!metric) return {
    answer: NO_DATA_ANSWER, evidence: [], provenance: { source: 'PostgreSQL', queryId: null, scope: scopeLabel(user), readOnly: true },
    confidence: null, provider: 'PostgreSQL', model: 'deterministic-query-catalog-v1', status: 'unsupported'
  };
  if (metric === 'data_status') return dataStatus({ pool, user, hasPermission });
  if (!(await hasPermission(user, REQUIRED_PERMISSION[metric]))) throw coded(403, 'PERMISSION_DENIED');
  return runGlobalMetric({ pool, user, metric });
}

async function answerEquipment({ pool, user, input, hasPermission }) {
  if (!String(input.equipmentId || '').trim()) throw coded(422, 'EQUIPMENT_REQUIRED');
  if (!(await hasPermission(user, 'equipment.view'))) throw coded(403, 'PERMISSION_DENIED');
  const client = await pool.connect();
  let equipment;
  try { equipment = await requireEquipmentScope(client, user, input.equipmentId); }
  finally { client.release(); }
  const metric = classifyGlobalQuestion(input.question);
  if (!metric || metric === 'data_status') return {
    answer: NO_DATA_ANSWER, evidence: [{ sourceType: 'asset', sourceIds: [equipment.id], observedCount: 1, queryId: 'equipment.chat.scope.v1' }],
    provenance: { source: 'PostgreSQL', queryId: 'equipment.chat.scope.v1', scope: 'equipment', readOnly: true },
    confidence: null, provider: 'PostgreSQL', model: 'deterministic-query-catalog-v1', status: 'unsupported'
  };
  if (!(await hasPermission(user, REQUIRED_PERMISSION[metric]))) throw coded(403, 'PERMISSION_DENIED');
  let query, sourceType;
  if (metric === 'equipment_count') {
    query = `SELECT id FROM assets WHERE id=$1 AND type='eq' AND deleted_at IS NULL`;
    sourceType = 'asset';
  } else if (metric === 'open_work_orders') {
    query = `WITH matches AS (SELECT id FROM work_orders WHERE asset_id=$1 AND deleted_at IS NULL AND lower(COALESCE(status,'')) NOT IN ('closed','cancel','cancelled','canceled','done','archived'))
      SELECT count(*)::int AS value,COALESCE((SELECT array_agg(id) FROM (SELECT id FROM matches ORDER BY id LIMIT 50) sample),'{}') AS source_ids FROM matches`;
    sourceType = 'work_order';
  } else if (metric === 'overdue_pm') {
    query = `WITH matches AS (SELECT id FROM pm_occurrences WHERE equipment_id=$1 AND status IN ('due','overdue') AND due_at<=now() AND provenance_status='verified')
      SELECT count(*)::int AS value,COALESCE((SELECT array_agg(id) FROM (SELECT id FROM matches ORDER BY id LIMIT 50) sample),'{}') AS source_ids FROM matches`;
    sourceType = 'pm_occurrence';
  } else {
    query = `WITH authorized_warehouses AS (SELECT w.id FROM warehouses w WHERE w.deleted_at IS NULL
        AND ($2='admin' OR EXISTS (SELECT 1 FROM user_scopes s WHERE s.user_id=$3 AND
          (s.scope_type='company' OR (s.scope_type='factory' AND s.scope_id=w.factory_asset_id)))),
      stock AS (SELECT b.item_id,SUM(b.on_hand-b.reserved) available FROM item_balances b
        JOIN storage_locations l ON l.id=b.location_id AND l.deleted_at IS NULL
        JOIN authorized_warehouses w ON w.id=l.warehouse_id GROUP BY b.item_id),
      matches AS (SELECT DISTINCT i.id FROM asset_spare_parts rel JOIN items i ON i.id=rel.item_id
        JOIN stock s ON s.item_id=i.id WHERE rel.asset_id=$1 AND rel.deleted_at IS NULL
          AND i.deleted_at IS NULL AND i.min_stock>0 AND s.available<i.min_stock)
      SELECT count(*)::int AS value,COALESCE((SELECT array_agg(id) FROM (SELECT id FROM matches ORDER BY id LIMIT 50) sample),'{}') AS source_ids FROM matches`;
    sourceType = 'inventory_item';
  }
  const params = metric === 'low_stock' ? [equipment.id, user.role, user.id] : [equipment.id];
  const selected = await pool.query(query, params);
  const value = metric === 'equipment_count' ? selected.rows.length : Number(selected.rows[0]?.value) || 0;
  const sourceIds = metric === 'equipment_count' ? selected.rows.map(row => row.id) : (selected.rows[0]?.source_ids || []);
  if (!value) return {
    answer: NO_DATA_ANSWER, evidence: [{ sourceType, sourceIds: [], observedCount: 0, queryId: `equipment.${metric}.v1` }],
    provenance: { source: 'PostgreSQL', queryId: `equipment.${metric}.v1`, scope: 'equipment', readOnly: true },
    confidence: null, provider: 'PostgreSQL', model: 'deterministic-query-catalog-v1', status: 'insufficient_data'
  };
  const text = {
    equipment_count: 'رکورد تجهیز انتخاب‌شده در PostgreSQL مجاز است.',
    open_work_orders: `برای تجهیز انتخاب‌شده ${value} دستورکار باز ثبت شده است.`,
    overdue_pm: `برای تجهیز انتخاب‌شده ${value} مورد PM سررسیدشده و تأییدشده ثبت شده است.`,
    low_stock: `برای تجهیز انتخاب‌شده ${value} قلم مرتبط زیر نقطه سفارش است.`
  };
  return {
    answer: text[metric], evidence: [{ sourceType, sourceIds, observedCount: value, queryId: `equipment.${metric}.v1` }],
    provenance: { source: 'PostgreSQL', queryId: `equipment.${metric}.v1`, scope: 'equipment', equipmentId: equipment.id, readOnly: true },
    confidence: 1, provider: 'PostgreSQL', model: 'deterministic-query-catalog-v1', status: 'answered'
  };
}

async function chatWithData({ pool, user, input, hasPermission }) {
  const queryType = input.queryType;
  const question = String(input.question || '').trim();
  if (!['global', 'equipment'].includes(queryType)) throw coded(422, 'QUERY_TYPE_REQUIRED');
  if (!question || question.length > 1000) throw coded(422, 'QUESTION_REQUIRED');
  return queryType === 'global'
    ? answerGlobal({ pool, user, input: { ...input, question }, hasPermission })
    : answerEquipment({ pool, user, input: { ...input, question }, hasPermission });
}

module.exports = {
  NO_DATA_ANSWER, QUERY_ID, REQUIRED_PERMISSION, classifyGlobalQuestion, GLOBAL_QUERIES,
  authorizedEquipmentCte, runGlobalMetric, answerGlobal, answerEquipment, dataStatus, chatWithData
};
