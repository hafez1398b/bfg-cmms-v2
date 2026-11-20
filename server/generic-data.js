'use strict';

const USER_DIRECTORY_SQL = `SELECT id,name,role
  FROM users
  WHERE active=true
  ORDER BY name`;

const DOMAIN_COLLECTIONS = Object.freeze({
  assets: Object.freeze({ error:'USE_EQUIPMENT_API', endpoint:'/api/equipment', message:'داده‌های تجهیز فقط از API اختصاصی تجهیزات قابل دسترسی هستند.' }),
  requests: Object.freeze({ error:'USE_MAINTENANCE_API', endpoint:'/api/requests', message:'درخواست کار فقط از API اختصاصی نگهداری قابل دسترسی است.' }),
  wos: Object.freeze({ error:'USE_MAINTENANCE_API', endpoint:'/api/work-orders', message:'دستورکار فقط از API اختصاصی نگهداری قابل دسترسی است.' }),
  work_orders: Object.freeze({ error:'USE_MAINTENANCE_API', endpoint:'/api/work-orders', message:'دستورکار فقط از API اختصاصی نگهداری قابل دسترسی است.' }),
  pms: Object.freeze({ error:'USE_MAINTENANCE_API', endpoint:'/api/pm-plans', message:'برنامه PM فقط از API اختصاصی نگهداری قابل دسترسی است.' }),
  pm_plans: Object.freeze({ error:'USE_MAINTENANCE_API', endpoint:'/api/pm-plans', message:'برنامه PM فقط از API اختصاصی نگهداری قابل دسترسی است.' }),
  items: Object.freeze({ error:'USE_INVENTORY_API', endpoint:'/api/items', message:'اقلام انبار فقط از API اختصاصی انبار قابل دسترسی هستند.' }),
  stock_docs: Object.freeze({ error:'USE_INVENTORY_API', endpoint:'/api/inventory/ledger', message:'اسناد انبار فقط از API اختصاصی انبار قابل دسترسی هستند.' }),
  stockDocs: Object.freeze({ error:'USE_INVENTORY_API', endpoint:'/api/inventory/ledger', message:'اسناد انبار فقط از API اختصاصی انبار قابل دسترسی هستند.' }),
  costEntries: Object.freeze({ error:'USE_INVENTORY_API', endpoint:'/api/cost-entries', message:'هزینه‌ها فقط از API اختصاصی انبار و هزینه قابل دسترسی هستند.' }),
  cost_entries: Object.freeze({ error:'USE_INVENTORY_API', endpoint:'/api/cost-entries', message:'هزینه‌ها فقط از API اختصاصی انبار و هزینه قابل دسترسی هستند.' }),
  warehouses: Object.freeze({ error:'USE_INVENTORY_API', endpoint:'/api/warehouses', message:'انبارها فقط از API اختصاصی انبار قابل دسترسی هستند.' }),
  inventory: Object.freeze({ error:'USE_INVENTORY_API', endpoint:'/api/inventory/ledger', message:'گردش انبار فقط از API اختصاصی انبار قابل دسترسی است.' })
});

// Every SQL statement and every selected column is server-owned. A collection name is
// only a lookup key and is never interpolated into SQL.
const READ_POLICIES = Object.freeze({
  users: Object.freeze({
    permissions:Object.freeze(['users.view']),
    scope:'permission',
    sql:USER_DIRECTORY_SQL
  }),
  auditX: Object.freeze({
    permissions:Object.freeze(['audit.view']),
    scope:'permission',
    sql:`SELECT id,t,u,action,mod,entity
      FROM audit_x
      ORDER BY t DESC
      LIMIT 500`
  }),
  tools: Object.freeze({
    permissions:Object.freeze(['tools.view']),
    scope:'system-administrator',
    sql:`SELECT id,code,name,health,status,holder,due,grp,brand,model,serial,loc,store,factory,unit,next_srv
      FROM tools
      ORDER BY name
      LIMIT 500`
  }),
  instruments: Object.freeze({
    permissions:Object.freeze(['calibration.view']),
    scope:'system-administrator',
    sql:`SELECT id,code,name,asset_id,period_days,last_cal,type,cls
      FROM instruments
      ORDER BY name
      LIMIT 500`
  }),
  contracts: Object.freeze({
    permissions:Object.freeze(['contracts.view']),
    scope:'permission',
    sql:`SELECT id,no,title,party,type,amount,used,from_at,to_at,status
      FROM contracts
      ORDER BY to_at DESC NULLS LAST
      LIMIT 500`
  }),
  projects: Object.freeze({
    permissions:Object.freeze(['projects.view']),
    scope:'permission',
    sql:`SELECT id,code,title,mgr,budget,spent,from_at,to_at,status,assets,contractor,team,descr
      FROM projects
      ORDER BY from_at DESC NULLS LAST
      LIMIT 500`
  }),
  permits: Object.freeze({
    permissions:Object.freeze(['permits.view']),
    scope:'system-administrator',
    sql:`SELECT id,no,type,wo_id,from_at,to_at,status,issuer,holder,approved_at
      FROM permits
      ORDER BY from_at DESC NULLS LAST
      LIMIT 500`
  }),
  docs: Object.freeze({
    permissions:Object.freeze(['documents.view']),
    scope:'permission',
    sql:`SELECT id,code,title,cat,ver,status,size,fmt,at
      FROM docs
      ORDER BY at DESC NULLS LAST
      LIMIT 500`
  }),
  leaves: Object.freeze({
    permissions:Object.freeze(['leaves.view']),
    scope:'system-administrator',
    sql:`SELECT id,no,kind,type,"user",from_at,to_at,date,h1,h2,days,hours,status
      FROM leaves
      ORDER BY COALESCE(from_at,date) DESC NULLS LAST
      LIMIT 500`
  }),
  planEvents: Object.freeze({
    permissions:Object.freeze(['planning.view']),
    scope:'system-administrator',
    sql:`SELECT id,title,type,prio,status,date,h1,h2,dur,descr,goals,who,team,unit,factory,project_id,wo_id,asset_id,sub_asset_id,req_id,pm_id,hse_id,progress
      FROM plan_events
      ORDER BY date DESC NULLS LAST
      LIMIT 500`
  }),
  comments: Object.freeze({
    permissions:Object.freeze(['comments.view']),
    scope:'system-administrator',
    sql:`SELECT id,ent,rec_id,parent,t,by_user,by_id,text
      FROM comments
      ORDER BY t DESC NULLS LAST
      LIMIT 500`
  })
});

function domainResponse(res, policy) {
  return res.status(409).json({ error:policy.error, message:policy.message, endpoint:policy.endpoint });
}

function permissionDenied(res, permission) {
  return res.status(403).json({
    error:'PERMISSION_DENIED',
    permission,
    message:'مجوز لازم برای مشاهده این اطلاعات وجود ندارد.'
  });
}

function createGenericDataHandlers({ pool, hasPermission }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('GENERIC_DATA_POOL_REQUIRED');
  if (typeof hasPermission !== 'function') throw new Error('GENERIC_DATA_PERMISSION_CHECK_REQUIRED');

  async function hasAnyPermission(user, permissions) {
    for (const permission of permissions) {
      if (await hasPermission(user, permission)) return true;
    }
    return false;
  }

  async function read(req, res) {
    const collection = String(req.params.collection || '');
    const domain = DOMAIN_COLLECTIONS[collection];
    if (domain) return domainResponse(res, domain);

    const policy = READ_POLICIES[collection];
    if (!policy) {
      return res.status(400).json({
        error:'COLLECTION_NOT_ALLOWED',
        message:'این مجموعه در API سازگاری مجاز نیست.'
      });
    }

    // Collections without a reliable equipment/factory relation fail closed for every
    // non-system-administrator, even if a permission is accidentally granted later.
    if (policy.scope === 'system-administrator' && req.user?.role !== 'admin') {
      return res.status(403).json({
        error:'SCOPE_DENIED',
        message:'محدوده مجاز برای این مجموعه قابل اثبات نیست.'
      });
    }

    try {
      if (!(await hasAnyPermission(req.user, policy.permissions))) {
        return permissionDenied(res, policy.permissions[0]);
      }
      const result = await pool.query(policy.sql);
      return res.json(result.rows);
    } catch (error) {
      const postgresCode = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'unknown';
      console.error(`[generic-data] read_failed postgres_code=${postgresCode}`);
      return res.status(500).json({ error:'REQUEST_FAILED', message:'خواندن اطلاعات انجام نشد.' });
    }
  }

  function rejectWrite(req, res) {
    const collection = String(req.params.collection || '');
    const domain = DOMAIN_COLLECTIONS[collection];
    if (domain) return domainResponse(res, domain);

    if (collection === 'users') {
      return res.status(403).json({
        error:'GENERIC_USER_CREATE_FORBIDDEN',
        message:'ساخت کاربر از API عمومی مجاز نیست.',
        endpoint:'/api/users'
      });
    }

    if (READ_POLICIES[collection]) {
      return res.status(403).json({
        error:'GENERIC_WRITE_FORBIDDEN',
        message:'نوشتن در مجموعه‌های سازگاری مجاز نیست.'
      });
    }

    return res.status(400).json({
      error:'COLLECTION_NOT_WRITABLE',
      message:'این مجموعه برای نوشتن مجاز نیست.'
    });
  }

  return { read, rejectWrite };
}

module.exports = {
  DOMAIN_COLLECTIONS,
  READ_POLICIES,
  USER_DIRECTORY_SQL,
  createGenericDataHandlers
};
