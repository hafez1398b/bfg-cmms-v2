/* Server-only projection for requests, work orders and PM plans.
   PostgreSQL is the only store. The arrays below are a non-persistent view. */
(function(){
  'use strict';
  const state = window.BFGMaintenance = { installed:false, writing:false, originals:{} };
  const MESSAGES = {
    INVALID_STATUS_TRANSITION:'تغییر وضعیت با گردش کار مجاز نیست.',
    RECORD_LOCKED:'رکورد بسته یا تأییدشده بدون گردش اصلاح بازنویسی نمی‌شود.',
    VERSION_CONFLICT:'این رکورد هم‌زمان تغییر کرده است. فهرست را تازه کنید.',
    EXECUTED_WORK_ORDER_CANNOT_BE_ARCHIVED:'دستورکار دارای سابقه اجرا حذف یا بایگانی نمی‌شود؛ فقط لغو می‌شود.',
    REQUEST_HAS_WORK_ORDER:'درخواست متصل به دستورکار بایگانی نمی‌شود.',
    EQUIPMENT_NOT_FOUND:'تجهیز انتخاب‌شده در پایگاه مرکزی وجود ندارد.',
    EQUIPMENT_REQUIRED:'انتخاب تجهیز الزامی است.',
    PERMISSION_DENIED:'مجوز این عملیات را ندارید.',
    MODULE_DISABLED:'این ماژول غیرفعال است.',
    DESCRIPTION_REQUIRED:'شرح الزامی است.',
    TITLE_REQUIRED:'عنوان الزامی است.',
    REPORT_REQUIRED:'شرح اقدام الزامی است.',
    CANCEL_REASON_REQUIRED:'دلیل لغو یا رد الزامی است.',
    ARCHIVE_REASON_REQUIRED:'دلیل بایگانی الزامی است.',
    CORRECTION_REASON_REQUIRED:'دلیل گردش اصلاح الزامی است.',
    HOLD_REASON_REQUIRED:'دلیل تعلیق الزامی است.',
    ASSIGNEE_NOT_FOUND:'کاربر انتخاب‌شده در پایگاه مرکزی نیست.',
    WORK_PERMIT_REQUIRED:'شروع دستورکار تا اتصال مجوز معتبر و تأییدشده مجاز نیست.',
    PTW_REQUIREMENT_CANNOT_BE_REMOVED:'نیاز ثبت‌شده به مجوز کار را نمی‌توان از دستورکار حذف کرد.',
    PERMIT_NOT_REQUIRED:'برای این دستورکار مجوز کار تعیین نشده است.',
    INSUFFICIENT_AVAILABLE_STOCK:'موجودی آزاد واقعی برای مقدار درخواستی کافی نیست؛ هیچ رزروی انجام نشد.',
    PART_NOT_FOUND:'قلم انتخاب‌شده در Master Data موجود نیست.',
    WIZARD_DRAFT_NOT_FOUND:'پیش‌نویس در Backend پیدا نشد.',
    WIZARD_DRAFT_TOO_LARGE:'حجم پیش‌نویس از حد مجاز بیشتر است.',
    EQUIPMENT_SCOPE_DENIED:'برای مشاهدهٔ اطلاعات این تجهیز دسترسی مکانی ندارید.'
  };

  function serverOnly(){ return !!(window.BFGRuntime && window.BFGRuntime.isServerOnly()); }
  function api(path, options){ return window.bfgApi(path, options); }
  function say(error){
    const code = error && (error.payload?.error || error.message);
    if (typeof toast === 'function') toast(MESSAGES[code] || 'عملیات در سرور مرکزی انجام نشد.', 1);
  }
  function record(collection, id){ return (DB[collection] || []).find(item => item.id === id); }
  function reason(message){ const value = prompt(message || 'دلیل این عملیات را وارد کنید:'); return value && value.trim() ? value.trim() : null; }

  function lock(list){
    if (!list || list.__bfgLocked) return list;
    ['push','unshift','splice','pop','shift'].forEach(name => {
      const original = Array.prototype[name];
      list[name] = function(...args){
        if (state.writing) return original.apply(this, args);
        if (typeof toast === 'function') toast('در حالت سرور، درخواست، دستورکار و PM فقط در پایگاه مرکزی ذخیره می‌شوند.', 1);
        throw new Error('LOCAL_MAINTENANCE_WRITE_BLOCKED');
      };
    });
    Object.defineProperty(list, '__bfgLocked', { value:true });
    return list;
  }

  function replace(name, rows){
    if (!Array.isArray(DB[name])) DB[name] = [];
    lock(DB[name]);
    state.writing = true;
    try { DB[name].splice(0, DB[name].length, ...rows); }
    finally { state.writing = false; }
  }

  function mergeAssets(rows){
    if (!Array.isArray(DB.assets)) DB.assets = [];
    const seen = new Set(DB.assets.map(asset => asset.id));
    (rows || []).forEach(row => {
      if (seen.has(row.id)) return;
      DB.assets.push({ id:row.id, code:row.code, name:row.name, type:'eq', status:row.status || 'active', crit:row.crit, parent:row.parent, deleted:false });
    });
  }

  function mergeUsers(rows){
    if (!Array.isArray(DB.users)) DB.users = [];
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const existing = DB.users.find(user => user.id === row.id);
      if (existing) { existing.name = row.name; existing.role = row.role; existing.active = row.active !== false; return; }
      DB.users.push({ id:row.id, u:row.username, name:row.name, role:row.role, unit:row.unit, active:row.active !== false, backendIdentity:true });
    });
  }

  async function optionalModule(path){
    try { return await api(path); }
    catch (error) {
      if (error && error.status === 403 && error.payload && error.payload.error === 'MODULE_DISABLED') return { data: [] };
      throw error;
    }
  }

  async function sync(options){
    if (!serverOnly() || !window.bfgApi) return;
    const [requests, orders, plans] = await Promise.all([
      optionalModule('/api/requests'), optionalModule('/api/work-orders'), optionalModule('/api/pm-plans')
    ]);
    replace('requests', requests.data || []);
    replace('wos', orders.data || []);
    replace('pms', plans.data || []);
    try { mergeAssets((await api('/api/equipment?limit=200')).data); } catch (_) {}
    try { mergeUsers(await api('/api/data/users')); } catch (_) {}
    if (!(options && options.quiet) && typeof go === 'function' && ['requests','wos','pm'].includes(window.CUR)) go(window.CUR);
  }

  function wrap(name, serverFn){
    const original = window[name];
    state.originals[name] = original;
    window[name] = function(...args){
      if (!serverOnly()) return typeof original === 'function' ? original.apply(this, args) : undefined;
      return serverFn.apply(this, args);
    };
  }

  async function saveRequestFromForm(){
    const descr = document.getElementById('rqDesc')?.value.trim();
    if (!descr) { if (typeof toast === 'function') toast('شرح درخواست الزامی است', 1); return; }
    try {
      const created = await api('/api/requests', { method:'POST', body:JSON.stringify({
        type:document.getElementById('rqType')?.value || 'repair',
        assetId:document.getElementById('rqAsset')?.value || null,
        descr, urgency:document.getElementById('rqUrg')?.value || 'normal',
        impact:document.getElementById('rqImp')?.value === '1',
        unit:ME?.unit, form:{ qty:document.getElementById('rqQty')?.value, material:document.getElementById('rqMat')?.value, service:document.getElementById('rqSrv')?.value }
      }) });
      await sync({ quiet:true });
      if (typeof closeModal === 'function') closeModal();
      if (typeof toast === 'function') toast('درخواست ' + created.data.no + ' در سرور ثبت شد');
      if (typeof go === 'function') go('requests');
    } catch (error) { say(error); }
  }

  async function saveRequestWizard(){
    const data = window.W && window.W.data || {};
    if (!String(data.desc || '').trim()) { if (typeof toast === 'function') toast('شرح درخواست الزامی است', 1); return; }
    try {
      const created = await api('/api/requests', { method:'POST', body:JSON.stringify({
        type:data.actionType === 'fab' ? 'fab' : data.actionType === 'service' ? 'service' : 'repair',
        unit:data.unit || ME?.unit, assetId:data.assetId || null, descr:data.desc,
        urgency:data.urgency || 'normal', impact:data.stopProd === 'yes', form:data
      }) });
      await sync({ quiet:true });
      if (typeof closeModal === 'function') closeModal();
      if (typeof toast === 'function') toast('درخواست ' + created.data.no + ' در سرور ثبت شد');
      if (typeof go === 'function') go('requests');
    } catch (error) { say(error); }
  }

  async function approveFromDialog(id){
    const current = record('requests', id);
    if (!current) return;
    try {
      const result = await api('/api/requests/' + encodeURIComponent(id) + '/approve', { method:'POST', body:JSON.stringify({
        rowVersion:current.rowVersion, assignee:document.getElementById('apTech')?.value || null,
        priority:document.getElementById('apPrio')?.value || current.urgency, est:Number(document.getElementById('apEst')?.value) || 4,
        note:document.getElementById('apNote')?.value || ''
      }) });
      await sync({ quiet:true });
      if (typeof closeModal === 'function') closeModal();
      if (typeof toast === 'function') toast('دستورکار ' + result.data.workOrder.no + ' در سرور صادر شد');
      if (typeof go === 'function') go('wos');
    } catch (error) { say(error); }
  }

  async function rejectRequest(id){
    const current = record('requests', id);
    const why = reason('دلیل رد درخواست:');
    if (!current || !why) return;
    try {
      await api('/api/requests/' + encodeURIComponent(id) + '/transition', { method:'POST', body:JSON.stringify({ status:'rejected', rowVersion:current.rowVersion, reason:why }) });
      await sync({ quiet:true });
      if (typeof closeModal === 'function') closeModal();
      if (typeof go === 'function') go('requests');
    } catch (error) { say(error); }
  }

  async function saveWorkOrderForm(){
    const descr = document.getElementById('woDesc')?.value.trim();
    if (!descr) { if (typeof toast === 'function') toast('شرح کار الزامی است', 1); return; }
    try {
      const created = await api('/api/work-orders', { method:'POST', body:JSON.stringify({
        type:document.getElementById('woType')?.value, assetId:document.getElementById('woAsset')?.value || null,
        descr, priority:document.getElementById('woPr')?.value, assignee:document.getElementById('woTech')?.value || null,
        ptw:document.getElementById('woPtw')?.value === '1', est:Number(document.getElementById('woEst')?.value) || 2
      }) });
      await sync({ quiet:true });
      if (typeof closeModal === 'function') closeModal();
      if (typeof toast === 'function') toast('دستورکار ' + created.data.no + ' در سرور صادر شد');
      if (typeof go === 'function') go('wos');
    } catch (error) { say(error); }
  }

  async function transition(id, body, after){
    const current = record('wos', id);
    if (!current) return;
    try {
      await api('/api/work-orders/' + encodeURIComponent(id) + '/transition', { method:'POST', body:JSON.stringify({ ...body, rowVersion:current.rowVersion }) });
      await sync({ quiet:true });
      if (after) after();
    } catch (error) { say(error); }
  }

  function reportText(){
    const voice = document.getElementById('rpVocBox') && document.getElementById('rpVocBox').style.display !== 'none';
    return (voice ? document.getElementById('rpTextV') : document.getElementById('rpText'))?.value.trim() || '';
  }

  async function savePmForm(){
    const title = document.getElementById('pmTitle')?.value.trim();
    if (!title) { if (typeof toast === 'function') toast('عنوان الزامی است', 1); return; }
    try {
      await api('/api/pm-plans', { method:'POST', body:JSON.stringify({
        title, assetId:document.getElementById('pmAsset')?.value, interval:Number(document.getElementById('pmInt')?.value) || 30,
        spec:document.getElementById('pmSpec')?.value, checklist:(document.getElementById('pmChk')?.value || '').split('\n').map(line => line.trim()).filter(Boolean)
      }) });
      await sync({ quiet:true });
      if (typeof closeModal === 'function') closeModal();
      if (typeof toast === 'function') toast('برنامه PM در سرور ثبت شد');
      if (typeof go === 'function') go('pm');
    } catch (error) { say(error); }
  }

  async function markSeen(id){
    const current = record('wos', id);
    if (!current || current.status !== 'assigned' || !ME || ME.role !== 'tech' || current.assignee !== ME.id || (current.times && current.times.seen)) return;
    await api('/api/work-orders/' + encodeURIComponent(id) + '/transition', { method:'POST', body:JSON.stringify({ status:'seen', rowVersion:current.rowVersion }) });
    await sync({ quiet:true });
  }

  async function correctFromPrompt(kind, id){
    const collection = kind === 'request' ? 'requests' : kind === 'work_order' ? 'wos' : 'pms';
    const current = record(collection, id);
    const why = reason('دلیل گردش اصلاح (الزامی):');
    if (!current || !why) return;
    const currentText = kind === 'pm_plan' ? current.title : (current.desc || current.descr || '');
    const next = prompt(kind === 'pm_plan' ? 'عنوان اصلاح‌شده:' : 'شرح اصلاح‌شده:', currentText);
    if (!next || !next.trim()) return;
    const path = kind === 'request' ? '/api/requests/' : kind === 'work_order' ? '/api/work-orders/' : '/api/pm-plans/';
    const patch = kind === 'pm_plan' ? { title:next.trim() } : { descr:next.trim() };
    try {
      await api(path + encodeURIComponent(id) + '/corrections', { method:'POST', body:JSON.stringify({ rowVersion:current.rowVersion, reason:why, patch }) });
      await sync({ quiet:true });
      if (typeof toast === 'function') toast('اصلاح در سرور ثبت شد و وضعیت رکورد تغییر نکرد');
    } catch (error) { say(error); }
  }

  function offerCorrection(kind, id, locked){
    if (!locked || !ME || !['admin','mgr'].includes(ME.role)) return;
    setTimeout(() => {
      const foot = document.querySelector('.modal .m-foot');
      if (!foot || foot.querySelector('[data-maintenance-correct]')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost';
      button.dataset.maintenanceCorrect = '1';
      button.textContent = 'اصلاح کنترل‌شده';
      button.addEventListener('click', () => correctFromPrompt(kind, id));
      foot.prepend(button);
    }, 30);
  }

  function install(){
    if (state.installed || !serverOnly()) return;
    state.installed = true;
    ['requests','wos','pms'].forEach(name => { if (Array.isArray(DB[name])) lock(DB[name]); });
    const originalSave = window.save;
    window.save = function(...args){
      if (!serverOnly()) return typeof originalSave === 'function' ? originalSave.apply(this, args) : undefined;
      sync({ quiet:true }).catch(() => {});
    };
    wrap('openReqForm', () => {
      if (window.BFGMaintenanceWizards && typeof window.BFGMaintenanceWizards.openRequest === 'function') return window.BFGMaintenanceWizards.openRequest();
      if (typeof toast === 'function') toast('موتور ویزارد درخواست کار بارگذاری نشده است.', 1);
    });
    wrap('openWOForm', () => {
      if (window.BFGMaintenanceWizards && typeof window.BFGMaintenanceWizards.openWorkOrder === 'function') return window.BFGMaintenanceWizards.openWorkOrder();
      if (typeof toast === 'function') toast('موتور ویزارد دستورکار بارگذاری نشده است.', 1);
    });
    wrap('saveReq', saveRequestFromForm);
    wrap('saveReqWiz', saveRequestWizard);
    wrap('approveReqDo', approveFromDialog);
    wrap('rejectReq', rejectRequest);
    wrap('saveWO', saveWorkOrderForm);
    wrap('startWO', id => {
      const current = record('wos', id);
      if (!current) return;
      if (!['assigned','seen','hold'].includes(current.status)) { if (typeof toast === 'function') toast('شروع کار فقط از وضعیت تخصیص‌یافته، مشاهده‌شده یا معلق مجاز است.', 1); return; }
      return transition(id, { status:'doing' }, () => openWO(id));
    });
    wrap('holdWO', id => { const why = reason('دلیل تعلیق (الزامی):'); if (why) transition(id, { status:'hold', reason:why }, () => openWO(id)); });
    wrap('saveReport', id => transition(id, { status:'done', report:{ text:reportText(), cause:document.getElementById('rpCause')?.value } }, () => openWO(id)));
    wrap('saveReportV2', id => transition(id, { status:'done', report:{ text:reportText(), cause:document.getElementById('rpCause')?.value } }, () => openWO(id)));
    wrap('closeWO', id => transition(id, { status:'closed' }, () => { if (typeof closeModal === 'function') closeModal(); if (typeof go === 'function') go('wos'); }));
    wrap('savePM', savePmForm);
    wrap('genPMWO', async id => {
      const current = record('pms', id);
      if (!current) return;
      try {
        const result = await api('/api/pm-plans/' + encodeURIComponent(id) + '/generate-work-order', { method:'POST', body:JSON.stringify({ rowVersion:current.rowVersion }) });
        await sync({ quiet:true });
        if (typeof closeModal === 'function') closeModal();
        if (typeof toast === 'function') toast('دستورکار ' + result.data.workOrder.no + ' از PM در سرور صادر شد');
        if (typeof go === 'function') go('wos');
      } catch (error) { say(error); }
    });
    wrap('dtActPMDo', async () => {
      const title = document.getElementById('qpTitle')?.value.trim();
      if (!title) return;
      try {
        await api('/api/pm-plans', { method:'POST', body:JSON.stringify({
          title, assetId:document.getElementById('qpAsset')?.value, interval:Number(document.getElementById('qpInt')?.value) || 30,
          spec:document.getElementById('qpSpec')?.value, owner:document.getElementById('qpOwner')?.value || null,
          checklist:(document.getElementById('qpChk')?.value || '').split('\n').map(line => line.trim()).filter(Boolean)
        }) });
        await sync({ quiet:true });
        if (typeof toast === 'function') toast('برنامه PM در سرور ثبت شد');
        if (typeof go === 'function') go('pm');
      } catch (error) { say(error); }
    });
    wrap('dtActGenPM', () => { const current = record('pms', window.DT && window.DT.id); if (current && typeof genPMWO === 'function') genPMWO(current.id); });
    wrap('saveRequestRecord', async id => {
      const current = record('requests', id);
      const descr = document.getElementById('raDesc')?.value.trim();
      if (!current || !descr) return;
      try {
        await api('/api/requests/' + encodeURIComponent(id), { method:'PATCH', body:JSON.stringify({ rowVersion:current.rowVersion, assetId:document.getElementById('raAsset')?.value || null, urgency:document.getElementById('raUrg')?.value, descr }) });
        await sync({ quiet:true });
        if (typeof openReq === 'function') openReq(id);
      } catch (error) { say(error); }
    });
    wrap('archiveRequestRecord', async id => {
      const current = record('requests', id);
      const why = reason('دلیل بایگانی درخواست:');
      if (!current || !why) return;
      try {
        await api('/api/requests/' + encodeURIComponent(id) + '/archive', { method:'POST', body:JSON.stringify({ rowVersion:current.rowVersion, reason:why }) });
        await sync({ quiet:true });
        if (typeof closeModal === 'function') closeModal();
        if (typeof go === 'function') go('requests');
      } catch (error) { say(error); }
    });
    wrap('saveWorkOrderRecord', async id => {
      const current = record('wos', id);
      const descr = document.getElementById('waDesc')?.value.trim();
      if (!current || !descr) return;
      try {
        await api('/api/work-orders/' + encodeURIComponent(id), { method:'PATCH', body:JSON.stringify({
          rowVersion:current.rowVersion, assetId:document.getElementById('waAsset')?.value || null,
          assignee:document.getElementById('waTech')?.value || null, priority:document.getElementById('waPriority')?.value,
          est:Number(document.getElementById('waEst')?.value) || 0, descr
        }) });
        await sync({ quiet:true });
        if (typeof openWO === 'function') openWO(id);
      } catch (error) { say(error); }
    });
    wrap('openWO', async id => {
      try { await markSeen(id); } catch (error) { say(error); }
      const current = record('wos', id);
      if (typeof state.originals.openWO === 'function') state.originals.openWO(id);
      if (current) offerCorrection('work_order', id, ['done','closed','cancel'].includes(current.status));
    });
    wrap('openReq', id => {
      if (typeof state.originals.openReq === 'function') state.originals.openReq(id);
      const current = record('requests', id);
      if (current) offerCorrection('request', id, ['approved','wo','closed','rejected','cancelled'].includes(current.status));
    });
    wrap('openPM', id => {
      if (typeof state.originals.openPM === 'function') state.originals.openPM(id);
      const current = record('pms', id);
      if (current) offerCorrection('pm_plan', id, current.status === 'cancelled');
    });
    wrap('savePart', () => { if (typeof toast === 'function') toast('مصرف قطعه در حالت سرور فقط از مسیر انبار مرکزی ثبت می‌شود و روی دستورکار محلی ذخیره نمی‌شود.', 1); });
    wrap('dropWO', () => { if (typeof toast === 'function') toast('تغییر وضعیت دستورکار فقط از گردش کار سرور انجام می‌شود.', 1); });
    wrap('removeWorkOrderRecord', async id => {
      const current = record('wos', id);
      if (!current) return;
      if (current.status === 'done') { if (typeof toast === 'function') toast('دستورکار انجام‌شده حذف یا لغو نمی‌شود؛ فقط تأیید و بستن مجاز است.', 1); return; }
      if (['closed','cancel'].includes(current.status)) { if (typeof toast === 'function') toast('رکورد نهایی حذف نمی‌شود. برای اصلاح از گردش اصلاح استفاده کنید.', 1); return; }
      const executed = !!(current.times && (current.times.start || current.times.end)) || !!(current.report && current.report.text) || (current.parts || []).length;
      const why = reason(executed ? 'این دستورکار سابقه اجرایی دارد و حذف نمی‌شود. دلیل لغو را وارد کنید:' : 'دلیل بایگانی دستورکار اجرا‌نشده:');
      if (!why) return;
      try {
        await api('/api/work-orders/' + encodeURIComponent(id) + (executed ? '/cancel' : '/archive'), { method:'POST', body:JSON.stringify({ rowVersion:current.rowVersion, reason:why }) });
        await sync({ quiet:true });
        if (typeof closeModal === 'function') closeModal();
        if (typeof go === 'function') go('wos');
      } catch (error) { say(error); }
    });
    wrap('savePMRecord', async id => {
      const current = record('pms', id);
      const title = document.getElementById('paTitle')?.value.trim();
      if (!current || !title) return;
      try {
        await api('/api/pm-plans/' + encodeURIComponent(id), { method:'PATCH', body:JSON.stringify({
          rowVersion:current.rowVersion, title, assetId:document.getElementById('paAsset')?.value,
          interval:Number(document.getElementById('paInterval')?.value) || 30,
          checklist:(document.getElementById('paChecklist')?.value || '').split('\n').map(line => line.trim()).filter(Boolean)
        }) });
        await sync({ quiet:true });
        if (typeof openPM === 'function') openPM(id);
      } catch (error) { say(error); }
    });
    wrap('archivePMRecord', async id => {
      const current = record('pms', id);
      const why = reason('دلیل بایگانی برنامه PM:');
      if (!current || !why) return;
      try {
        await api('/api/pm-plans/' + encodeURIComponent(id) + '/archive', { method:'POST', body:JSON.stringify({ rowVersion:current.rowVersion, reason:why }) });
        await sync({ quiet:true });
        if (typeof closeModal === 'function') closeModal();
        if (typeof go === 'function') go('pm');
      } catch (error) { say(error); }
    });
  }

  state.activate = async function(){ install(); await sync({ quiet:true }); };
  state.sync = sync;
  state.install = install;
  if (window.BFGBackend && window.BFGBackend.user) state.activate().catch(() => {});
})();
