/* Shared backend session. The browser never stores the access token. */
(function(){
  'use strict';
  const policy = window.BFGRuntime;
  const state = window.BFGBackend = { mode:'awaiting-config', config:null, user:null, realtime:null };

  function csrfToken(){
    const parts = String(document.cookie || '').split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed.startsWith('bfg_csrf=')) continue;
      try { return decodeURIComponent(trimmed.slice('bfg_csrf='.length)); }
      catch (_) { return trimmed.slice('bfg_csrf='.length); }
    }
    return '';
  }

  async function api(path, options={}, allowRefresh=true){
    const headers = { ...(options.headers || {}) };
    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['x-csrf-token'] = csrfToken();
    if (options.body && !(options.body instanceof FormData) && !headers['content-type']) headers['content-type'] = 'application/json';
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (response.status === 401 && allowRefresh && path !== '/api/auth/login' && path !== '/api/auth/refresh' && path !== '/api/auth/logout') {
      await api('/api/auth/refresh', { method:'POST', body:'{}' }, false);
      return api(path, options, false);
    }
    if (!response.ok) {
      const error = new Error(payload?.error || 'BACKEND_REQUEST_FAILED');
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }
  window.bfgApi = api;

  function syncDemoUsers(){
    const demo = document.getElementById('demoUsers');
    if (demo) demo.hidden = !(policy && policy.allowsSampleData());
  }

  function showLoginPage(){
    state.user = null;
    if (policy) policy.clearConnectionError();
    const login = document.getElementById('loginPage');
    const app = document.getElementById('app');
    if (login) login.style.display = '';
    if (app) app.style.display = 'none';
  }

  function enterApplication(user){
    let shellUser = (DB.users || []).find(x => x.id === user.id || x.u === user.username);
    if (!shellUser) {
      shellUser = { id:user.id, u:user.username, name:user.name, role:user.role, unit:user.unit, active:true, backendIdentity:true };
      DB.users.push(shellUser);
    }
    Object.assign(shellUser, { name:user.name, role:user.role, unit:user.unit || shellUser.unit, active:true, backendIdentity:true });
    if (policy) policy.scrubSecrets(DB);
    ME = shellUser;
    state.user = user;
    state.mode = policy && policy.isServerOnly() ? 'server-only' : 'backend';
    if (policy && policy.shouldPersistOperationalData()) sessionStorage.setItem('bfg_me', shellUser.id);
    else sessionStorage.removeItem('bfg_me');
    document.getElementById('loginPage').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    document.getElementById('uName').textContent = ME.name;
    document.getElementById('uRole').textContent = ROLES[ME.role] || ME.role;
    document.getElementById('uAvatar').textContent = ME.name[0];
    connectRealtime();
    const ready = policy && policy.isServerOnly()
      ? Promise.resolve(window.BFGMaintenance && window.BFGMaintenance.activate()).then(() => window.BFGInventory && window.BFGInventory.activate())
      : Promise.resolve();
    Promise.resolve(ready).then(async () => {
      if (window.BFGModules && typeof window.BFGModules.refresh === 'function') {
        try { await window.BFGModules.refresh(); } catch (_) {}
      }
      buildMenu();
      go('dash');
      updateBadge();
    });
    if (window.AIBackend && typeof window.AIBackend.refresh === 'function') window.AIBackend.refresh(false);
  }

  function connectRealtime(){
    if (!state.user || typeof io !== 'function') return;
    try { state.realtime?.disconnect(); } catch (_) {}
    state.realtime = io({ withCredentials: true, transports:['websocket', 'polling'] });
    state.realtime.on('realtime:ready', () => { document.documentElement.dataset.realtime = 'connected'; });
    state.realtime.on('disconnect', () => { document.documentElement.dataset.realtime = 'disconnected'; });
    state.realtime.on('domain:event', event => {
      window.dispatchEvent(new CustomEvent('bfg:domain-event', { detail:event }));
      if (event.type === 'notification.created' && typeof toast === 'function') toast('🔔 ' + (event.payload?.title || 'اعلان جدید'));
      if (event.aggregateType === 'equipment' && (CUR === 'equipment') && typeof eqv2Load === 'function') eqv2Load();
      if (window.BFGMaintenance && ['request','work_order','pm_plan'].includes(event.aggregateType)) window.BFGMaintenance.sync({ quiet:true });
      if (window.BFGInventory && ['inventory','cost','work_order_file','work_order'].includes(event.aggregateType)) window.BFGInventory.sync({ quiet:true });
    });
  }

  function loginMessage(error){
    if (error && error.status === 429) return 'تلاش‌های ورود بیش از حد است. ۱۵ دقیقه بعد دوباره تلاش کنید.';
    if (error && error.status === 401) return 'نام کاربری یا رمز عبور نادرست است.';
    if (error && error.status === 403) return 'نشست امن صفحه منقضی شده است. صفحه را یک‌بار تازه‌سازی کنید.';
    return 'ورود به سرور مرکزی ممکن نشد.';
  }

  const localLogin = window.doLogin;
  window.doLogin = async function(){
    if (!policy || policy.isBlocked() || !policy.isReady()) {
      if (policy && policy.isBlocked()) policy.showConnectionError(policy.state.error);
      else if (typeof toast === 'function') toast('تنظیمات سرور هنوز دریافت نشده است', 1);
      return;
    }
    if (policy.isServerOnly()) {
      const username = document.getElementById('loginUser').value.trim();
      const passwordField = document.getElementById('loginPass');
      const password = passwordField.value;
      try {
        if (!csrfToken()) await fetch('/api/auth/csrf', { credentials:'same-origin', cache:'no-store' });
        const result = await api('/api/auth/login', { method:'POST', body:JSON.stringify({ username, password }) });
        passwordField.value = '';
        enterApplication(result.user);
      } catch (error) {
        if (typeof toast === 'function') toast(loginMessage(error), 1);
      }
      return;
    }
    if (policy.allowsSampleData() && typeof localLogin === 'function') {
      localLogin();
      return;
    }
    policy.block('UNSUPPORTED_EXECUTION_MODE');
    policy.showConnectionError('UNSUPPORTED_EXECUTION_MODE');
  };

  function finishLocalExit(){
    sessionStorage.removeItem('bfg_token');
    sessionStorage.removeItem('token');
    state.user = null;
    try { state.realtime?.disconnect(); } catch (_) {}
    const localLogout = window.BFGLocalLogout;
    if (typeof localLogout === 'function') localLogout();
    else location.reload();
  }

  const localLogout = window.logout;
  window.BFGLocalLogout = localLogout;
  window.logout = async function(){
    try { await api('/api/auth/logout', { method:'POST', body:'{}' }, false); } catch (_) {}
    finishLocalExit();
  };
  window.logoutAllDevices = async function(){
    if (!state.user) { finishLocalExit(); return; }
    try {
      await api('/api/auth/logout-all', { method:'POST', body:'{}' });
    } catch (_) {
      if (typeof toast === 'function') toast('خروج از همه دستگاه‌ها انجام نشد. اتصال سرور را بررسی کنید.', 1);
      return;
    }
    finishLocalExit();
  };

  function enforceServerOnlyMemory(){
    if (typeof window.bfgResetOperationalStore === 'function') window.bfgResetOperationalStore();
    else if (policy && window.DB) policy.resetStore(window.DB);
    policy.purgeOperationalStorage();
    if (window.DB) policy.scrubSecrets(window.DB);
  }

  function stopWithoutPolicy(){
    state.mode = 'blocked';
    const login = document.getElementById('loginPage');
    const app = document.getElementById('app');
    if (login) login.style.display = 'none';
    if (app) app.style.display = 'none';
    if (!document.getElementById('bfg-connection-error')) {
      const rootEl = document.createElement('div');
      rootEl.id = 'bfg-connection-error';
      rootEl.setAttribute('role', 'alert');
      rootEl.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:#0B2239;color:#E9EFF6;direction:rtl;padding:24px;';
      rootEl.textContent = 'ارتباط با سرور مرکزی برقرار نشد. برنامه متوقف شد و هیچ داده عملیاتی محلی یا نمونه‌ای ساخته نمی‌شود.';
      document.body.appendChild(rootEl);
    }
    try { localStorage.removeItem('bfg_cmms_v1'); } catch (_) {}
  }

  async function restoreSession(){
    showLoginPage();
    try {
      const result = await api('/api/auth/me');
      enterApplication(result.user);
    } catch (error) {
      if (!error.status || error.status >= 500) {
        state.mode = 'blocked';
        policy.block('BACKEND_UNREACHABLE');
        enforceServerOnlyMemory();
        policy.showConnectionError(error);
        return;
      }
      showLoginPage();
    }
  }

  async function restoreBackend(){
    try { sessionStorage.removeItem('bfg_token'); sessionStorage.removeItem('token'); } catch (_) {}
    if (!policy) { stopWithoutPolicy(); return; }
    policy.showAwaitingConfig();
    syncDemoUsers();
    try {
      const response = await fetch('/api/runtime-config', {
        cache:'no-store',
        credentials:'same-origin',
        headers:{ 'x-client-version': window.BFG_CLIENT_VERSION || '' }
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const config = await response.json();
      if (!window.BFGModules || window.BFGModules.requiresUpdate(config)) {
        if (window.BFGModules) window.BFGModules.showUpdatePage(config);
        else policy.block('CLIENT_UPDATE_REQUIRED');
        enforceServerOnlyMemory();
        return;
      }
      const applied = policy.applyConfig(config);
      if (!applied || applied.status !== 'ready') throw new Error(applied?.error || 'INVALID_RUNTIME_CONFIG');
      state.config = applied.config;
      if (policy.isServerOnly()) {
        enforceServerOnlyMemory();
        state.mode = 'server-only';
        policy.clearConnectionError();
        syncDemoUsers();
        await restoreSession();
        return;
      }
      if (policy.allowsSampleData()) {
        state.mode = 'local-development';
        if (typeof window.bfgLoadOperationalStore === 'function') window.bfgLoadOperationalStore();
        if (typeof window.importBespar1 === 'function') window.importBespar1();
        policy.clearConnectionError();
        syncDemoUsers();
        return;
      }
      throw new Error('UNSUPPORTED_EXECUTION_MODE');
    } catch (error) {
      state.config = null;
      state.user = null;
      state.mode = 'blocked';
      policy.block(error && error.message ? error.message : 'BACKEND_UNREACHABLE');
      enforceServerOnlyMemory();
      syncDemoUsers();
      policy.showConnectionError(error);
    }
  }

  restoreBackend();
})();
