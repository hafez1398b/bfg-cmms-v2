/* Server-only projection for inventory, costs and work-order files.
   Stock changes only through the central ledger. Files are never stored as Base64. */
(function(){
  'use strict';
  const state = window.BFGInventory = { installed:false, writing:false, originals:{} };
  const MESSAGES = {
    NEGATIVE_STOCK_NOT_ALLOWED:'موجودی کافی نیست. موجودی منفی ثبت نمی‌شود.',
    NONZERO_STOCK_CANNOT_BE_ARCHIVED:'قلم دارای موجودی قابل حذف یا بایگانی نیست.',
    CONSUMPTION_HISTORY_CANNOT_BE_DELETED:'قلم دارای سابقه مصرف حذف نمی‌شود.',
    DANGEROUS_FILE_REJECTED:'فایل اجرایی یا خطرناک پذیرفته نمی‌شود.',
    FILE_TYPE_REJECTED:'نوع فایل مجاز نیست یا با محتوا هم‌خوانی ندارد.',
    FILE_NAME_REJECTED:'نام فایل مجاز نیست.',
    FILE_TOO_LARGE:'حجم فایل بیش از حد مجاز سرور است.',
    PART_COST_CALCULATED_BY_SERVER:'هزینه قطعه فقط از روی مصرف در سرور محاسبه می‌شود.',
    DELIVERY_NOT_READY:'تأیید تحویل فقط پس از بستن دستورکار ممکن است.',
    DELIVERY_ALREADY_CONFIRMED:'تحویل قبلاً تأیید شده است.',
    REQUESTER_CONFIRMATION_REQUIRED:'فقط درخواست‌کننده می‌تواند تحویل را تأیید کند.',
    PERMISSION_DENIED:'مجوز این عملیات را ندارید.',
    MODULE_DISABLED:'این ماژول غیرفعال است.',
    VERSION_CONFLICT:'این رکورد هم‌زمان تغییر کرده است. فهرست را تازه کنید.',
    QUANTITY_REQUIRED:'تعداد باید بزرگ‌تر از صفر باشد.',
    EQUIPMENT_REQUIRED:'مصرف قطعه فقط برای دستورکار دارای تجهیز ثبت می‌شود.',
    WORK_ORDER_NOT_FOUND:'دستورکار در پایگاه مرکزی نیست.',
    LOCATION_NOT_FOUND:'محل نگهداری در پایگاه مرکزی نیست.'
  };
  const KIND = { receipt:'رسید', issue:'حواله', reserve:'رزرو', release:'آزادسازی', consume:'مصرف', return:'برگشت' };

  function serverOnly(){ return !!(window.BFGRuntime && window.BFGRuntime.isServerOnly()); }
  function api(path, options){ return window.bfgApi(path, options); }
  function say(error){
    const code = error && (error.payload?.error || error.message);
    if (typeof toast === 'function') toast(MESSAGES[code] || 'عملیات انبار در سرور مرکزی انجام نشد.', 1);
  }
  function itemOf(id){ return (DB.items || []).find(item => item.id === id); }
  function orderOf(id){ return (DB.wos || []).find(item => item.id === id); }
  function locationId(item){
    const balance = (item && item.balances || []).find(row => row.available > 0) || (item && item.balances || [])[0];
    return balance ? balance.locationId : 'loc-main';
  }

  function lock(list, message){
    if (!list || list.__bfgLocked) return list;
    ['push','unshift','splice','pop','shift'].forEach(name => {
      const original = Array.prototype[name];
      list[name] = function(...args){
        if (state.writing) return original.apply(this, args);
        if (typeof toast === 'function') toast(message, 1);
        throw new Error('LOCAL_INVENTORY_WRITE_BLOCKED');
      };
    });
    Object.defineProperty(list, '__bfgLocked', { value:true });
    return list;
  }

  function replace(name, rows){
    if (!Array.isArray(DB[name])) DB[name] = [];
    lock(DB[name], 'در حالت سرور این فهرست فقط از پایگاه مرکزی خوانده می‌شود.');
    state.writing = true;
    try { DB[name].splice(0, DB[name].length, ...rows); }
    finally { state.writing = false; }
  }

  async function optional(path, fallback){
    try { return await api(path); }
    catch (error) { if (error && error.status === 403) return fallback; throw error; }
  }

  async function sync(options){
    if (!serverOnly() || !window.bfgApi) return;
    const [items, ledger, costs, warehouses] = await Promise.all([
      optional('/api/items', { data:[] }),
      optional('/api/inventory/ledger', { data:[] }),
      optional('/api/cost-entries', { data:{ lines:[], totalsByWorkOrder:{} } }),
      optional('/api/warehouses', { data:[] })
    ]);
    replace('items', items.data || []);
    replace('stockDocs', (ledger.data || []).map(entry => ({
      id:entry.id, no:entry.no, kind:KIND[entry.movement] || entry.movement, itemId:entry.itemId,
      qty:entry.qty, at:entry.createdAt, by:entry.createdBy, wo:entry.workOrderId || null, movement:entry.movement
    })));
    const lines = (costs.data && costs.data.lines) || [];
    replace('costEntries', lines.map(line => ({
      id:line.id, t:line.createdAt, kind:line.kind === 'labor' ? 'دستمزد' : line.kind === 'part' ? 'قطعات' : 'پیمانکار',
      ref:line.workOrderNo || line.workOrderId, amount:line.direction === 'credit' ? -Number(line.amount) : Number(line.amount),
      workOrderId:line.workOrderId, source:'server'
    })));
    DB.serverCostTotals = (costs.data && costs.data.totalsByWorkOrder) || {};
    DB.warehouses = warehouses.data || [];
    (DB.wos || []).forEach(order => {
      order.serverCosts = DB.serverCostTotals[order.id] || null;
      const parts = (ledger.data || []).filter(entry => entry.movement === 'consume' && entry.workOrderId === order.id);
      if (parts.length) order.parts = parts.map(entry => ({ itemId:entry.itemId, qty:entry.qty, unitCost:entry.unitCost }));
    });
    if (!(options && options.quiet) && typeof go === 'function' && ['inv','costs','wos'].includes(window.CUR)) go(window.CUR);
  }

  function wrap(name, serverFn){
    const original = window[name];
    state.originals[name] = original;
    window[name] = function(...args){
      if (!serverOnly()) return typeof original === 'function' ? original.apply(this, args) : undefined;
      return serverFn.apply(this, args);
    };
  }

  async function postMovement(path, body){
    await api(path, { method:'POST', body:JSON.stringify(body) });
    await sync({ quiet:true });
  }

  function install(){
    if (state.installed || !serverOnly()) return;
    state.installed = true;
    ['items','stockDocs','costEntries'].forEach(name => { if (Array.isArray(DB[name])) lock(DB[name], 'در حالت سرور، انبار و هزینه فقط در پایگاه مرکزی ذخیره می‌شوند.'); });
    const previousSave = window.save;
    window.save = function(...args){
      const result = typeof previousSave === 'function' ? previousSave.apply(this, args) : undefined;
      if (serverOnly()) sync({ quiet:true }).catch(() => {});
      return result;
    };
    wrap('saveItem', async () => {
      const name = document.getElementById('itName')?.value.trim();
      if (!name) { if (typeof toast === 'function') toast('نام کالا الزامی است', 1); return; }
      try {
        await api('/api/items', { method:'POST', body:JSON.stringify({
          name, unit:document.getElementById('itUnit')?.value, cat:document.getElementById('itCat')?.value,
          min:Number(document.getElementById('itMin')?.value) || 0, price:Number(document.getElementById('itPrice')?.value) || 0,
          loc:document.getElementById('itLoc')?.value, initialQty:Number(document.getElementById('itStock')?.value) || 0,
          locationId:'loc-main'
        }) });
        await sync({ quiet:true });
        if (typeof closeModal === 'function') closeModal();
        if (typeof toast === 'function') toast('کالا در سرور ثبت شد');
        if (typeof go === 'function') go('inv');
      } catch (error) { say(error); }
    });
    wrap('stockDoc', async (itemId, kind) => {
      const item = itemOf(itemId);
      const qty = Number(prompt((kind || 'سند') + ' — تعداد:', '1'));
      if (!item || !(qty > 0)) return;
      try {
        await postMovement(kind === 'رسید' ? '/api/inventory/receipts' : '/api/inventory/issues', {
          itemId, locationId:locationId(item), qty, rowVersion:item.rowVersion
        });
        if (typeof toast === 'function') toast('سند در دفتر گردش سرور ثبت شد');
        if (typeof go === 'function') go('inv');
      } catch (error) { say(error); }
    });
    wrap('savePart', async woId => {
      const order = orderOf(woId);
      const item = itemOf(document.getElementById('apItem')?.value);
      const qty = Number(document.getElementById('apQty')?.value) || 0;
      if (!order || !item || !(qty > 0)) return;
      try {
        await postMovement('/api/inventory/consumptions', { itemId:item.id, locationId:locationId(item), qty, workOrderId:woId, rowVersion:item.rowVersion });
        if (typeof toast === 'function') toast('مصرف قطعه به دستورکار و تجهیز در سرور متصل شد');
        if (typeof openWO === 'function') openWO(woId);
      } catch (error) { say(error); }
    });
    wrap('saveInventoryRecord', async id => {
      const item = itemOf(id);
      const name = document.getElementById('iaName')?.value.trim();
      if (!item || !name) return;
      try {
        await api('/api/items/' + encodeURIComponent(id), { method:'PATCH', body:JSON.stringify({
          rowVersion:item.rowVersion, name, min:Number(document.getElementById('iaMin')?.value) || 0,
          loc:document.getElementById('iaLoc')?.value, price:Number(document.getElementById('iaPrice')?.value) || 0
        }) });
        await sync({ quiet:true });
        if (typeof closeModal === 'function') closeModal();
        if (typeof go === 'function') go('inv');
      } catch (error) { say(error); }
    });
    wrap('archiveInventoryRecord', async id => {
      const item = itemOf(id);
      const reason = prompt('دلیل بایگانی قلم انبار:');
      if (!item || !reason || !reason.trim()) return;
      try {
        await api('/api/items/' + encodeURIComponent(id) + '/archive', { method:'POST', body:JSON.stringify({ rowVersion:item.rowVersion, reason:reason.trim() }) });
        await sync({ quiet:true });
        if (typeof go === 'function') go('inv');
      } catch (error) { say(error); }
    });
    wrap('saveCostEntry', async () => {
      const amount = Number(document.getElementById('ceAmount')?.value) || 0;
      const ref = document.getElementById('ceRef')?.value.trim();
      const order = (DB.wos || []).find(item => item.no === ref || item.id === ref);
      if (!order) { if (typeof toast === 'function') toast('هزینه باید به یک دستورکار موجود در سرور متصل شود.', 1); return; }
      const kindName = document.getElementById('ceKind')?.value;
      try {
        if (kindName === 'دستمزد') {
          const hours = Number(prompt('نفرساعت:', '1'));
          const rate = Number(prompt('نرخ هر نفرساعت (ریال):', '900000'));
          await api('/api/work-orders/' + encodeURIComponent(order.id) + '/costs', { method:'POST', body:JSON.stringify({ kind:'labor', hours, rate, description:'نفرساعت' }) });
        } else {
          await api('/api/work-orders/' + encodeURIComponent(order.id) + '/costs', { method:'POST', body:JSON.stringify({ kind:'external_service', amount, description:kindName || 'خدمات بیرونی' }) });
        }
        await sync({ quiet:true });
        if (typeof closeModal === 'function') closeModal();
        if (typeof go === 'function') go('costs');
      } catch (error) { say(error); }
    });
    wrap('woSaveService', async woId => {
      const amount = Number(document.getElementById('wsAmount')?.value) || 0;
      const description = document.getElementById('wsTitle')?.value.trim();
      if (!description || !(amount > 0)) return;
      try {
        const result = await api('/api/work-orders/' + encodeURIComponent(woId) + '/costs', { method:'POST', body:JSON.stringify({ kind:'external_service', amount, description }) });
        await sync({ quiet:true });
        if (typeof toast === 'function') toast('هزینه خدمات در سرور ثبت شد. جمع: ' + (result.data.totals.total));
        if (typeof openWO === 'function') openWO(woId);
      } catch (error) { say(error); }
    });
    wrap('woAddLabor', woId => {
      if (typeof modal !== 'function') return;
      modal(mhead('ثبت نفرساعت در سرور') + `<div class="m-body"><div class="frow"><div class="field"><label>نفرساعت *</label><input id="wlH" type="number" step="0.5" value="1"></div><div class="field"><label>نرخ (ریال) *</label><input id="wlR" type="number" value="900000"></div></div><div class="muted">مبلغ را سرور از نفرساعت ضرب در نرخ محاسبه می‌کند.</div></div><div class="m-foot"><button class="btn btn-primary" onclick="bfgSaveLabor('${woId}')">ثبت</button><button class="btn btn-ghost" onclick="openWO('${woId}')">بازگشت</button></div>`);
    });
    window.bfgSaveLabor = async function(woId){
      try {
        const result = await api('/api/work-orders/' + encodeURIComponent(woId) + '/costs', { method:'POST', body:JSON.stringify({ kind:'labor', hours:Number(document.getElementById('wlH')?.value), rate:Number(document.getElementById('wlR')?.value), amount:1 }) });
        await sync({ quiet:true });
        if (typeof toast === 'function') toast('نفرساعت در سرور محاسبه شد: ' + result.data.line.amount);
        if (typeof openWO === 'function') openWO(woId);
      } catch (error) { say(error); }
    };
    wrap('addMedia', async (woId, phase, input) => {
      const files = [...(input && input.files || [])];
      if (!files.length) return;
      try {
        for (const file of files) {
          await api('/api/work-orders/' + encodeURIComponent(woId) + '/attachments', {
            method:'POST',
            headers:{ 'content-type': file.type || 'application/octet-stream', 'x-file-name': file.name, 'x-file-phase': phase || 'during' },
            body:file
          });
        }
        await sync({ quiet:true });
        if (typeof toast === 'function') toast('پیوست در سرور ذخیره شد و در مرورگر به‌صورت Base64 نگه‌داشته نمی‌شود');
        if (typeof openWO === 'function') openWO(woId);
      } catch (error) { say(error); }
    });
    wrap('openWO', async id => {
      if (typeof state.originals.openWO === 'function') await state.originals.openWO(id);
      const order = orderOf(id);
      const body = document.querySelector('.modal .m-body');
      if (order && order.serverCosts && body && !body.querySelector('[data-server-costs]')) {
        const totals = order.serverCosts;
        body.insertAdjacentHTML('beforeend', `<div data-server-costs class="card" style="box-shadow:none;margin-top:12px"><b>جمع هزینه محاسبه‌شده در سرور</b><div class="muted">قطعه ${totals.parts} — نفرساعت ${totals.labor} — خدمات ${totals.externalServices} — کل ${totals.total}</div></div>`);
      }
      document.querySelectorAll('.modal button').forEach(button => {
        if (button.textContent.includes('تأیید تحویل')) button.onclick = () => window.bfgConfirmDelivery(id);
      });
    });
    window.bfgConfirmDelivery = async function(id){
      const order = orderOf(id);
      if (!order) return;
      try {
        await api('/api/work-orders/' + encodeURIComponent(id) + '/delivery-confirmation', { method:'POST', body:JSON.stringify({ rowVersion:order.rowVersion, note:'تأیید تحویل' }) });
        await sync({ quiet:true });
        if (typeof toast === 'function') toast('تأیید تحویل در سرور ثبت شد');
        if (typeof openWO === 'function') openWO(id);
      } catch (error) { say(error); }
    };
  }

  state.activate = async function(){ install(); await sync({ quiet:true }); };
  state.sync = sync;
  if (window.BFGBackend && window.BFGBackend.user) state.activate().catch(() => {});
})();
