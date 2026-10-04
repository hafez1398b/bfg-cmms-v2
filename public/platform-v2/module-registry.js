/* Local module shell. Menus register here so index.html can shrink over time.
   This file never fetches or evaluates code from an external address. */
(function(){
  'use strict';
  const CLIENT_VERSION = '4.0.0';
  window.BFG_CLIENT_VERSION = CLIENT_VERSION;
  const BUILTIN = [
    { id:'equipment', menuIds:['equipment'] },
    { id:'requests', menuIds:['requests'] },
    { id:'work_orders', menuIds:['wos'] },
    { id:'pm', menuIds:['pm'] },
    { id:'inventory', menuIds:['inv', 'costs'] }
  ];
  const FORBIDDEN = ['scriptUrl', 'script', 'code', 'src', 'url', 'href', 'eval', 'remote'];
  const localModules = new Map();
  const state = { ready:false, modules:null, release:null };

  function parseSemver(value){
    const parts = String(value || '').trim().split('.');
    if (!parts.length || parts.some(part => !/^\d+$/.test(part))) return null;
    return parts.map(part => Number(part));
  }

  function compareSemver(left, right){
    const a = parseSemver(left);
    const b = parseSemver(right);
    if (!a || !b) return null;
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      const av = a[index] || 0;
      const bv = b[index] || 0;
      if (av > bv) return 1;
      if (av < bv) return -1;
    }
    return 0;
  }

  function requiresUpdate(config){
    if (!config || !config.compatibility || config.compatibility.compatible !== true) return true;
    const min = config.minClientVersion || config.compatibility.minClientVersion;
    const comparison = compareSemver(CLIENT_VERSION, min);
    return comparison === null || comparison < 0;
  }

  function register(descriptor){
    if (!descriptor || typeof descriptor !== 'object') throw new Error('MODULE_DESCRIPTOR_REQUIRED');
    for (const key of Object.keys(descriptor)) {
      if (FORBIDDEN.includes(key)) throw new Error('REMOTE_MODULE_REJECTED');
    }
    if (typeof descriptor.id !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(descriptor.id)) throw new Error('MODULE_ID_INVALID');
    if (descriptor.render && typeof descriptor.render !== 'function') throw new Error('MODULE_RENDER_MUST_BE_LOCAL');
    const menuIds = Array.isArray(descriptor.menuIds) ? descriptor.menuIds.filter(id => typeof id === 'string') : [];
    localModules.set(descriptor.id, { id:descriptor.id, menuIds, render:descriptor.render || null });
    return { id:descriptor.id, registered:true };
  }

  function isServerOnly(){
    return !!(window.BFGRuntime && typeof window.BFGRuntime.isServerOnly === 'function' && window.BFGRuntime.isServerOnly());
  }

  function dropEmptyGroups(items){
    return items.filter((item, index) => {
      if (!item.g) return true;
      const rest = items.slice(index + 1);
      const nextGroup = rest.findIndex(candidate => candidate.g);
      const section = nextGroup === -1 ? rest : rest.slice(0, nextGroup);
      return section.some(candidate => !candidate.g);
    });
  }

  function withAdmin(items){
    if (!state.ready || !window.ME || window.ME.role !== 'admin' || items.some(item => item.id === 'modules')) return items;
    const next = items.slice();
    const profile = next.findIndex(item => item.id === 'profile');
    const entry = { id:'modules', ic:'🧩', t:'ماژول‌ها' };
    if (profile >= 0) next.splice(profile, 0, entry);
    else next.push(entry);
    return next;
  }

  function visibleMenu(menu){
    const managed = new Set();
    const enabled = new Set();
    BUILTIN.forEach(module => module.menuIds.forEach(id => managed.add(id)));
    localModules.forEach(module => module.menuIds.forEach(id => managed.add(id)));
    if (state.ready && Array.isArray(state.modules)) {
      state.modules.forEach(module => {
        (module.menuIds || []).forEach(id => {
          managed.add(id);
          if (module.enabled === true) enabled.add(id);
        });
      });
    } else if (!isServerOnly()) {
      return withAdmin((menu || []).filter(item => item.id !== 'tree'));
    }
    const items = (menu || []).filter(item => item.id !== 'tree' && (item.g || !managed.has(item.id) || enabled.has(item.id)));
    return withAdmin(dropEmptyGroups(items));
  }

  function allows(menuId){
    if (!menuId || menuId === 'dash' || menuId === 'modules' || menuId === 'profile') return true;
    return visibleMenu([{ id:menuId }]).some(item => item.id === menuId);
  }

  async function refresh(){
    if (typeof window.bfgApi !== 'function') {
      state.ready = false;
      state.modules = null;
      return null;
    }
    try {
      const payload = await window.bfgApi('/api/modules');
      if (!payload || !Array.isArray(payload.data)) throw new Error('MODULE_LIST_INVALID');
      state.modules = payload.data;
      state.release = {
        appVersion: payload.appVersion,
        apiVersion: payload.apiVersion,
        minClientVersion: payload.minClientVersion
      };
      state.ready = true;
      return state.modules;
    } catch (_) {
      state.ready = false;
      state.modules = null;
      return null;
    }
  }

  function showUpdatePage(config){
    const login = document.getElementById('loginPage');
    const app = document.getElementById('app');
    if (login) login.style.display = 'none';
    if (app) app.style.display = 'none';
    let root = document.getElementById('bfg-update-required');
    if (!root) {
      root = document.createElement('div');
      root.id = 'bfg-update-required';
      root.setAttribute('role', 'alert');
      root.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;background:#0B2239;color:#E9EFF6;direction:rtl;padding:24px;text-align:center;';
      const card = document.createElement('div');
      card.style.maxWidth = '520px';
      const title = document.createElement('h1');
      title.textContent = 'به‌روزرسانی کلاینت لازم است';
      const detail = document.createElement('p');
      detail.id = 'bfg-update-detail';
      const note = document.createElement('p');
      note.textContent = 'نسخه جدید فقط از بسته نرم‌افزاری امضاشده شرکت نصب می‌شود. این صفحه هیچ کدی از آدرس خارجی دریافت یا اجرا نمی‌کند.';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'بررسی دوباره همین سرور';
      button.addEventListener('click', () => location.reload());
      card.append(title, detail, note, button);
      root.appendChild(card);
      document.body.appendChild(root);
    }
    const detail = document.getElementById('bfg-update-detail');
    const compatibility = config && config.compatibility || {};
    if (detail) {
      detail.textContent = 'نسخه کلاینت ' + CLIENT_VERSION
        + ' با حداقل نسخه ' + ((config && config.minClientVersion) || compatibility.minClientVersion || 'سرور')
        + ' سازگار نیست. نسخه سرور: ' + ((config && config.appVersion) || 'نامشخص')
        + ' — نسخه API: ' + ((config && config.apiVersion) || 'نامشخص') + '.';
    }
  }

  function renderAdmin(){
    const root = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'page-head';
    const title = document.createElement('h2');
    title.textContent = 'ماژول‌های سامانه';
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'فعال و غیرفعال کردن فقط برای مدیر سیستم است. ماژول جدید فقط با نسخه امضاشده منتشر می‌شود و از آدرس خارجی بارگذاری نمی‌شود.';
    head.append(title, note);
    root.appendChild(head);
    const release = state.release || {};
    const versions = document.createElement('p');
    versions.className = 'muted';
    versions.textContent = 'نسخه برنامه ' + (release.appVersion || CLIENT_VERSION) + ' — نسخه API ' + (release.apiVersion || '—');
    root.appendChild(versions);
    if (!state.ready) {
      const empty = document.createElement('div');
      empty.className = 'card empty';
      empty.textContent = 'فهرست ماژول‌ها از سرور دریافت نشد.';
      root.appendChild(empty);
      return root;
    }
    (state.modules || []).forEach(module => {
      const card = document.createElement('article');
      card.className = 'card';
      const name = document.createElement('b');
      name.textContent = module.name + ' (' + module.id + ')';
      const meta = document.createElement('div');
      meta.className = 'muted';
      meta.textContent = 'نسخه ' + module.version + ' — ' + (module.enabled ? 'فعال' : 'غیرفعال')
        + ' — حداقل کلاینت ' + module.minClientVersion
        + ' — مجوز ' + (module.permissions || []).join('، ');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm ' + (module.enabled ? 'btn-ghost' : 'btn-primary');
      button.textContent = module.enabled ? 'غیرفعال کردن' : 'فعال کردن';
      button.addEventListener('click', () => toggle(module));
      card.append(name, meta, button);
      root.appendChild(card);
    });
    return root;
  }

  function openAdmin(){
    if (!window.ME || window.ME.role !== 'admin') {
      if (typeof toast === 'function') toast('فقط مدیر سیستم می‌تواند ماژول‌ها را تغییر دهد', 1);
      if (typeof window.go === 'function') return window.go('dash');
      return;
    }
    window.CUR = 'modules';
    if (typeof window.buildMenu === 'function') window.buildMenu();
    const content = document.getElementById('content');
    if (!content) return;
    content.replaceChildren(renderAdmin());
    if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
  }

  async function toggle(module){
    if (!window.ME || window.ME.role !== 'admin' || typeof window.bfgApi !== 'function') return;
    if (module.enabled && typeof confirm === 'function' && !confirm('ماژول «' + module.name + '» غیرفعال شود؟ منوها و API آن بسته می‌شوند.')) return;
    try {
      await window.bfgApi('/api/modules/' + encodeURIComponent(module.id), {
        method:'PATCH',
        body:JSON.stringify({ enabled: module.enabled !== true, rowVersion: module.rowVersion })
      });
      await refresh();
      if (window.CUR && window.CUR !== 'modules' && !allows(window.CUR) && typeof window.go === 'function') window.go('dash');
      else openAdmin();
    } catch (error) {
      const code = error && ((error.payload && error.payload.error) || error.message);
      if (typeof toast === 'function') toast(code === 'MODULE_ADMIN_REQUIRED' ? 'فقط مدیر سیستم مجاز است' : 'تغییر وضعیت ماژول در سرور انجام نشد', 1);
    }
  }

  window.addEventListener('bfg:domain-event', event => {
    const detail = event && event.detail || {};
    if (detail.type !== 'module.updated' && detail.aggregateType !== 'module') return;
    refresh().then(() => {
      if (typeof window.buildMenu === 'function') window.buildMenu();
      if (window.CUR === 'modules') openAdmin();
      else if (window.CUR && !allows(window.CUR) && typeof window.go === 'function') window.go('dash');
    }).catch(() => {});
  });

  BUILTIN.forEach(module => register({ id:module.id, menuIds:module.menuIds }));
  window.BFGModules = {
    version: CLIENT_VERSION,
    register,
    refresh,
    visibleMenu,
    allows,
    requiresUpdate,
    showUpdatePage,
    openAdmin,
    compareSemver
  };
})();
