/* Fail-closed client runtime policy. Execution mode is applied only after Backend confirms it. */
(function (root) {
  'use strict';

  const OPERATIONAL_KEY = 'bfg_cmms_v1';
  const SERVER_ONLY = 'server-only';
  const LOCAL_DEVELOPMENT = 'local-development';
  const CONNECTION_ERROR_MESSAGE = 'ارتباط با سرور مرکزی برقرار نشد. برنامه متوقف شد و هیچ داده عملیاتی محلی یا نمونه‌ای ساخته نمی‌شود.';
  const APPEARANCE = {
    bfg_theme: /^(dark|light)$/,
    bfg_lang: /^(fa|en)$/,
    bfg_sb_mini: /^[01]$/
  };
  const AI_SECRET_FIELDS = new Set(['apikey', 'api_key', 'sttkey', 'stt_key']);

  const state = {
    status: 'pending',
    executionMode: null,
    allowLocalCompatibility: false,
    config: null,
    error: null,
    lastUi: null
  };
  const rejectedWrites = [];
  let guardedStorage = null;

  function emptyOperationalStore() {
    return {
      users: [], assets: [], requests: [], wos: [], pms: [], items: [],
      instruments: [], permits: [], stockDocs: [], notifs: [], audit: [],
      contractors: [], contracts: [], projects: [], tools: [], docs: [],
      leaves: [], chats: {}, costEntries: [],
      settings: {
        docCode: '', docDate: '', reqRequired: {},
        ai: { provider: 'backend', endpoint: '', model: '', key: '', vision: false },
        qrBase: '',
        creator: { show: true, name: 'دکتر دهفولی - حافظ بایرامیان', role: 'طراحی، تحلیل و معماری سامانه CMMS/EAM' },
        channels: {
          smtp: { host: '', port: '587', user: '', from: '', enabled: false },
          sms: { provider: '', key: '', from: '', enabled: false },
          whatsapp: { token: '', phone: '', enabled: false },
          bale: { token: '', enabled: false },
          push: { enabled: false }, inapp: { enabled: true }
        }
      },
      seq: { wo: 0, wr: 0, ptw: 0, doc: 0 },
      savedFilters: [], backups: [], backupCfg: { freq: 'daily', time: '02:00', dest: 'سرور مرکزی', keep: 30 },
      logins: [], msgGroups: [], docMeta: {}, planEvents: [], recMeta: {},
      auditX: [], trash: [], notifSvc: {}, notifLog: [], escalations: [], escRuns: [],
      aiCfg: { provider: 'backend', baseUrl: '', apiKey: '', sttKey: '', model: '', visionModel: '', status: 'server', lastMsg: 'کلیدهای هوش مصنوعی فقط روی سرور مرکزی نگهداری می‌شوند' },
      workflows: [], wfRuns: [],
      panelCfg: { pattern: '', plant: '', seq: 1, pad: 3, autoChk: false, mandatory: false, voltages: [], statuses: [] },
      recNotes: [], comments: [], recFiles: [], purchaseReqs: [],
      toolCfg: { seq: 1, pattern: 'TL-{GRP}-{SEQ}', pad: 3, dueAlertDays: 1 },
      toolLoans: [], toolSrv: [],
      leaveCfg: { workHours: 8, seq: 1 }, holidays: [], missions: [],
      perms: { enforce: true, roles: {}, users: {}, v: 0 },
      __mfSeed: 1, __fleetSeed: 1, __structSeed: 1, __toolSeed39: 1, __hrSeed40: 1, __demoSeed: 1,
      equipmentStructureReset: { version: 'server-only', awaitingCanonicalStructure: false }
    };
  }

  function isAppearanceKey(key) { return Object.prototype.hasOwnProperty.call(APPEARANCE, String(key)); }
  function appearanceValueAllowed(key, value) { return isAppearanceKey(key) && APPEARANCE[key].test(String(value)); }
  function isReady() { return state.status === 'ready'; }
  function isBlocked() { return state.status === 'blocked'; }
  function isServerOnly() { return state.status === 'ready' && state.executionMode === SERVER_ONLY; }
  function allowsSampleData() { return state.status === 'ready' && state.executionMode === LOCAL_DEVELOPMENT && state.allowLocalCompatibility === true; }
  function allowsOperationalPersistence() { return allowsSampleData(); }
  function shouldPersistOperationalData() { return allowsOperationalPersistence(); }
  function isAiSecretField(key, parentKey) {
    const name = String(key || '').toLowerCase();
    const parent = String(parentKey || '').toLowerCase();
    if (AI_SECRET_FIELDS.has(name)) return true;
    return name === 'key' && (parent === 'ai' || parent === 'aicfg');
  }

  function scrubSecrets(value, parentKey) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) { value.forEach(item => scrubSecrets(item, parentKey)); return value; }
    Object.keys(value).forEach(key => {
      if (isAiSecretField(key, parentKey)) { value[key] = ''; return; }
      if (value[key] && typeof value[key] === 'object') scrubSecrets(value[key], key);
    });
    return value;
  }

  const OPERATIONAL_ARRAYS = [
    'users', 'assets', 'requests', 'wos', 'pms', 'items', 'instruments', 'permits', 'stockDocs',
    'notifs', 'audit', 'contractors', 'contracts', 'projects', 'tools', 'docs', 'leaves',
    'costEntries', 'logins', 'msgGroups', 'backups', 'savedFilters', 'planEvents', 'auditX', 'trash',
    'notifLog', 'escalations', 'escRuns', 'workflows', 'wfRuns', 'recNotes', 'comments', 'recFiles',
    'purchaseReqs', 'toolLoans', 'toolSrv', 'holidays', 'missions'
  ];

  function resetStore(db) {
    if (!db || typeof db !== 'object') return emptyOperationalStore();
    scrubSecrets(db);
    OPERATIONAL_ARRAYS.forEach(key => {
      if (Array.isArray(db[key])) db[key].length = 0;
      else db[key] = [];
    });
    if (db.chats && typeof db.chats === 'object') Object.keys(db.chats).forEach(key => delete db.chats[key]);
    if (db.recMeta && typeof db.recMeta === 'object') Object.keys(db.recMeta).forEach(key => delete db.recMeta[key]);
    if (db.docMeta && typeof db.docMeta === 'object') Object.keys(db.docMeta).forEach(key => delete db.docMeta[key]);
    return db;
  }

  function purgeOperationalStorage() {
    try { if (guardedStorage) guardedStorage.removeItem(OPERATIONAL_KEY); } catch (_) {}
    try { if (typeof localStorage !== 'undefined' && localStorage !== guardedStorage) localStorage.removeItem(OPERATIONAL_KEY); } catch (_) {}
  }

  function sanitizeConfig(config, executionMode, allowLocal) {
    return {
      environment: String(config.environment || ''),
      executionMode,
      allowLocalCompatibility: allowLocal === true,
      backendAuth: config.backendAuth !== false,
      backendAI: config.backendAI !== false,
      realtime: config.realtime !== false,
      apiBasePath: '/api'
    };
  }

  function applyConfig(config) {
    if (!config || typeof config !== 'object') return block('INVALID_RUNTIME_CONFIG');
    if (config.executionMode === SERVER_ONLY) {
      state.status = 'ready';
      state.executionMode = SERVER_ONLY;
      state.allowLocalCompatibility = false;
      state.config = sanitizeConfig(config, SERVER_ONLY, false);
      state.error = null;
      purgeOperationalStorage();
      return state;
    }
    if (config.executionMode === LOCAL_DEVELOPMENT && config.allowLocalCompatibility === true) {
      state.status = 'ready';
      state.executionMode = LOCAL_DEVELOPMENT;
      state.allowLocalCompatibility = true;
      state.config = sanitizeConfig(config, LOCAL_DEVELOPMENT, true);
      state.error = null;
      return state;
    }
    return block('UNSUPPORTED_EXECUTION_MODE');
  }

  function block(reason) {
    state.status = 'blocked';
    state.executionMode = null;
    state.allowLocalCompatibility = false;
    state.config = null;
    state.error = String(reason || 'BACKEND_UNREACHABLE');
    purgeOperationalStorage();
    return state;
  }

  function installStorageGuard(storage) {
    if (!storage || storage.__bfgGuarded) return storage;
    const rawSet = storage.setItem.bind(storage);
    storage.setItem = function (key, value) {
      const name = String(key);
      if (isAppearanceKey(name)) {
        if (!appearanceValueAllowed(name, value)) { rejectedWrites.push(name); return; }
        return rawSet(name, String(value));
      }
      if (name === OPERATIONAL_KEY && allowsOperationalPersistence()) {
        return rawSet(name, scrubSerialized(value));
      }
      rejectedWrites.push(name);
    };
    storage.__bfgGuarded = true;
    guardedStorage = storage;
    return storage;
  }

  function scrubSerialized(value) {
    try {
      const parsed = JSON.parse(String(value));
      scrubSecrets(parsed);
      return JSON.stringify(parsed);
    } catch (_) {
      rejectedWrites.push(OPERATIONAL_KEY);
      return '{}';
    }
  }

  function sameOriginBase() {
    try {
      const loc = root.location;
      if (loc && /^https?:$/.test(loc.protocol) && loc.host) return loc.origin + '/';
    } catch (_) {}
    return '';
  }
  function sameOriginLabel() {
    try {
      const loc = root.location;
      if (loc && /^https?:$/.test(loc.protocol) && loc.host) return loc.host;
    } catch (_) {}
    return 'سرور مرکزی';
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  function showAwaitingConfig() {
    state.lastUi = { type: 'awaiting-config' };
    if (typeof document === 'undefined') return state.lastUi;
    const button = document.getElementById('loginSubmit');
    if (button) button.disabled = true;
    return state.lastUi;
  }

  function showConnectionError(error) {
    const detail = error && error.message ? error.message : (error || state.error || 'BACKEND_UNREACHABLE');
    state.lastUi = { type: 'connection-error', message: CONNECTION_ERROR_MESSAGE, detail: String(detail) };
    if (typeof document === 'undefined' || !document.body) return state.lastUi;
    let rootEl = document.getElementById('bfg-connection-error');
    if (!rootEl) {
      rootEl = document.createElement('div');
      rootEl.id = 'bfg-connection-error';
      rootEl.setAttribute('role', 'alert');
      document.body.appendChild(rootEl);
    }
    rootEl.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:#0B2239;color:#E9EFF6;direction:rtl;padding:24px;font-family:Vazirmatn,Tahoma,sans-serif;';
    rootEl.innerHTML = '<div style="max-width:560px;background:#131E2C;border:1px solid #243447;border-radius:16px;padding:28px">'
      + '<div style="font-size:26px;font-weight:800;margin-bottom:10px">قطع ارتباط با سرور مرکزی</div>'
      + '<p style="line-height:1.9;color:#A3B2C4">' + CONNECTION_ERROR_MESSAGE + '</p>'
      + '<p style="font-size:12px;color:#6E7F93;direction:ltr;text-align:left">' + escapeHtml(detail) + '</p>'
      + '<button type="button" id="bfg-connection-retry" style="margin-top:18px;background:#0FA3A3;color:#fff;border:0;border-radius:10px;padding:10px 18px;font-weight:700;cursor:pointer">تلاش مجدد</button></div>';
    const login = document.getElementById('loginPage');
    const app = document.getElementById('app');
    if (login) login.style.display = 'none';
    if (app) app.style.display = 'none';
    const retry = document.getElementById('bfg-connection-retry');
    if (retry) retry.onclick = () => root.location.reload();
    return state.lastUi;
  }

  function clearConnectionError() {
    state.lastUi = { type: 'ready' };
    if (typeof document === 'undefined') return;
    const rootEl = document.getElementById('bfg-connection-error');
    if (rootEl) rootEl.remove();
    const login = document.getElementById('loginPage');
    if (login && login.style.display === 'none') login.style.display = '';
    const button = document.getElementById('loginSubmit');
    if (button) button.disabled = false;
  }

  function setAppearance(key, value) {
    if (!appearanceValueAllowed(key, value) || typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, String(value));
    return true;
  }

  const api = {
    OPERATIONAL_KEY, SERVER_ONLY, LOCAL_DEVELOPMENT, CONNECTION_ERROR_MESSAGE, APPEARANCE_KEYS: Object.keys(APPEARANCE),
    state, emptyOperationalStore, isReady, isBlocked, isServerOnly, allowsSampleData, allowsOperationalPersistence,
    shouldPersistOperationalData, isAiSecretField, isAppearanceKey, scrubSecrets, resetStore, purgeOperationalStorage,
    applyConfig, block, installStorageGuard, sameOriginBase, sameOriginLabel, showAwaitingConfig, showConnectionError,
    clearConnectionError, setAppearance, rejectedWrites: () => rejectedWrites.slice()
  };
  root.BFGRuntime = api;
  if (typeof localStorage !== 'undefined') installStorageGuard(localStorage);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
