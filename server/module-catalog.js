'use strict';

const { MIN_BACKEND_VERSION, MIN_CLIENT_VERSION } = require('./release-info');

function starts(path, prefix) {
  return path === prefix || path.startsWith(prefix + '/');
}

const MODULES = [
  {
    id: 'equipment',
    name: 'تجهیزات',
    version: '2.0.0',
    permissions: ['equipment.view'],
    minBackendVersion: MIN_BACKEND_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    menuIds: ['equipment'],
    matches(path) {
      return starts(path, '/api/equipment')
        || starts(path, '/api/maintenance/equipment')
        || path === '/api/data/assets';
    }
  },
  {
    id: 'requests',
    name: 'درخواست‌ها',
    version: '1.0.0',
    permissions: ['request.view'],
    minBackendVersion: MIN_BACKEND_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    menuIds: ['requests'],
    matches(path) {
      return starts(path, '/api/requests') || path === '/api/data/requests';
    }
  },
  {
    id: 'work_orders',
    name: 'دستورکارها',
    version: '1.0.0',
    permissions: ['work_order.view'],
    minBackendVersion: MIN_BACKEND_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    menuIds: ['wos'],
    matches(path) {
      return starts(path, '/api/work-orders')
        || path === '/api/data/wos'
        || path === '/api/data/work_orders'
        || /\/api\/pm-plans\/[^/]+\/generate-work-order$/.test(path);
    }
  },
  {
    id: 'pm',
    name: 'نگهداری پیشگیرانه',
    version: '1.0.0',
    permissions: ['pm.view'],
    minBackendVersion: MIN_BACKEND_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    menuIds: ['pm'],
    matches(path) {
      return starts(path, '/api/pm-plans')
        || path === '/api/data/pms'
        || path === '/api/data/pm_plans';
    }
  },
  {
    id: 'inventory',
    name: 'انبار و هزینه',
    version: '1.0.0',
    permissions: ['inventory.view'],
    minBackendVersion: MIN_BACKEND_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    menuIds: ['inv', 'costs'],
    matches(path) {
      return starts(path, '/api/items')
        || starts(path, '/api/warehouses')
        || starts(path, '/api/inventory')
        || starts(path, '/api/cost-entries')
        || ['/api/data/items', '/api/data/stock_docs', '/api/data/stockDocs', '/api/data/costEntries', '/api/data/cost_entries', '/api/data/warehouses'].includes(path)
        || /\/api\/work-orders\/[^/]+\/costs$/.test(path);
    }
  }
];

function requestPath(url) {
  const raw = String(url || '').split('?')[0].split('#')[0];
  if (!raw.startsWith('/') || raw.includes('\\') || raw.includes('..')) return '';
  return raw;
}

function publicModule(module, state = {}) {
  return {
    id: module.id,
    name: module.name,
    version: module.version,
    enabled: state.enabled !== false,
    permissions: module.permissions.slice(),
    minBackendVersion: module.minBackendVersion,
    minClientVersion: module.minClientVersion,
    menuIds: module.menuIds.slice(),
    rowVersion: Number(state.rowVersion || state.row_version || 1)
  };
}

function modules() {
  return MODULES.map(module => publicModule(module));
}

function get(id) {
  return MODULES.find(module => module.id === id) || null;
}

function modulesForPath(url) {
  const path = requestPath(url);
  if (!path) return [];
  return MODULES.filter(module => module.matches(path)).map(module => module.id);
}

function modulesForRequest(req) {
  const ids = new Set();
  modulesForPath(req && req.originalUrl).forEach(id => ids.add(id));
  const mounted = requestPath(String((req && req.baseUrl) || '') + String((req && req.path) || ''));
  modulesForPath(mounted).forEach(id => ids.add(id));
  return [...ids];
}

function visibleMenu(menu, moduleStates, options = {}) {
  const failClosed = options.failClosed === true;
  const source = Array.isArray(moduleStates)
    ? moduleStates
    : (failClosed ? MODULES.map(module => publicModule(module, { enabled: false })) : null);
  if (!source) return menu.filter(item => item.id !== 'tree');
  const managed = new Set();
  const enabled = new Set();
  source.forEach(module => {
    (module.menuIds || []).forEach(id => {
      managed.add(id);
      if (module.enabled === true) enabled.add(id);
    });
  });
  const items = menu.filter(item => item.id !== 'tree' && (item.g || !managed.has(item.id) || enabled.has(item.id)));
  return items.filter((item, index) => {
    if (!item.g) return true;
    const rest = items.slice(index + 1);
    const nextGroup = rest.findIndex(candidate => candidate.g);
    const section = nextGroup === -1 ? rest : rest.slice(0, nextGroup);
    return section.some(candidate => !candidate.g);
  });
}

module.exports = {
  modules,
  get,
  publicModule,
  modulesForPath,
  modulesForRequest,
  visibleMenu
};
