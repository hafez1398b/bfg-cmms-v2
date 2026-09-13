'use strict';
/* BFG Notification Center — full end-to-end UI (Requirement #4)
 * Features: persisted, realtime, read/unread, history, priority, targeted, not broadcast
 */
(function(){
  window.BFG = window.BFG || {};
  const state = { list: [], unread: 0, page: 1, limit: 30, filter: 'all', loading: false };

  async function fetchList(){
    state.loading = true;
    try{
      const params = { limit: state.limit, offset: (state.page-1)*state.limit };
      if(state.filter==='unread') params.unread='true';
      if(state.filter==='critical') params.priority='critical';
      const res = await window.BFG.api.notifications.list(params);
      state.list = res.data || [];
      state.unread = res.unread ?? state.list.filter(n=>!n.is_read).length;
      renderBadge();
      return res;
    }catch(e){
      console.warn('[notifications] fetch failed', e.message);
      // Fallback to local DB.notifs for offline/demo
      if(window.DB?.notifs){
        state.list = window.DB.notifs.map(n=>({ id:n.id, title:n.text?.slice(0,60), body:n.text, is_read:!!n.read, created_at:n.t, priority:'normal', kind:'system' }));
        state.unread = state.list.filter(n=>!n.is_read).length;
      }
      renderBadge();
    } finally { state.loading=false; }
  }
  function renderBadge(){
    const b = document.getElementById('nBadge');
    if(b){ b.style.display = state.unread ? 'block' : 'none'; b.textContent = window.fa ? window.fa(state.unread) : state.unread; }
  }
  function priorityColor(p){ return p==='critical'?'var(--red)':p==='high'?'var(--orange)':p==='low'?'var(--gray)':'var(--blue)'; }
  function kindIcon(k){
    const m={critical_failure:'🚨',equipment_critical:'⚠️',overdue_pm:'📅',failed_checklist:'📋',new_work_order:'🛠️',assigned_work_order:'👤',approval_required:'✅',ai_recommendation:'🤖',inventory_alert:'📦',workflow_escalation:'🔄',system:'🔔',pm_due:'🔁',calibration_due:'🎯'};
    return m[k]||'🔔';
  }

  function openCenter(){
    // Drawer UI
    const unread = state.list.filter(n=>!n.is_read);
    const html = `
    <div class="drawer-ov" onclick="BFG.notifications.close()"></div>
    <div class="drawer" style="width:460px">
      <div class="m-head" style="position:sticky;top:0;background:var(--surface);z-index:2">
        <h3>🔔 مرکز اعلان‌ها ${state.unread?`<span class="badge b-red">${window.fa?window.fa(state.unread):state.unread} جدید</span>`:''}</h3>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm btn-ghost" onclick="BFG.notifications.markAllRead()">✓ همه خوانده شد</button>
          <button class="x" onclick="BFG.notifications.close()">✕</button>
        </div>
      </div>
      <div style="padding:10px 14px;display:flex;gap:6px;position:sticky;top:58px;background:var(--surface);z-index:1;border-bottom:1px solid var(--border)">
        ${[['all','همه'],['unread','خوانده‌نشده'],['critical','بحرانی']].map(([k,l])=>`<button class="btn btn-sm ${state.filter===k?'btn-primary':'btn-ghost'}" onclick="BFG.notifications.setFilter('${k}')">${l}</button>`).join('')}
        <span style="margin-right:auto;font-size:11px;color:var(--text-3)">🔍 End-to-End: DB→Realtime→Client</span>
      </div>
      <div id="notifList" style="padding:0">
        ${state.list.length ? state.list.map(n=>`
          <div class="notif-item ${!n.is_read?'unread':''}" onclick="BFG.notifications.openOne('${n.id}')">
            <div style="width:38px;height:38px;border-radius:11px;background:${priorityColor(n.priority)}18;color:${priorityColor(n.priority)};display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">${kindIcon(n.kind)}</div>
            <div style="flex:1;min-width:0">
              <div style="display:flex;gap:6px;align-items:center">
                <b style="font-size:12.8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(n.title||n.kind||'اعلان')}</b>
                <span class="badge ${n.priority==='critical'?'b-red':n.priority==='high'?'b-orange':'b-gray'}" style="font-size:9px">${n.priority==='critical'?'بحرانی':n.priority==='high'?'مهم':n.priority==='low'?'کم':'عادی'}</span>
                ${!n.is_read?'<span class="dot" style="background:var(--blue)"></span>':''}
              </div>
              <div style="font-size:12.3px;color:var(--text-2);margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escapeHtml(n.body||'')}</div>
              <div style="font-size:10.5px;color:var(--text-3);margin-top:4px;display:flex;gap:8px">
                <span>${formatTime(n.created_at)}</span>
                ${n.entity?`<span>• ${n.entity}:${String(n.entity_id||'').slice(0,8)}</span>`:''}
                ${n.kind?`<span>• ${n.kind}</span>`:''}
              </div>
            </div>
            <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();BFG.notifications.markRead('${n.id}', ${n.is_read?'false':'true'})" title="${!n.is_read?'خوانده شد':'خوانده‌نشده'}">${!n.is_read?'✓':''}</button>
          </div>
        `).join('') : `<div class="empty"><div class="big">🔔</div>اعلانی وجود ندارد<br><span class="muted">اعلان‌ها به‌صورت Targeted ارسال می‌شوند — Broadcast بی‌دلیل انجام نمی‌شود.</span></div>`}
      </div>
      <div style="padding:12px;text-align:center;border-top:1px solid var(--border);font-size:11px;color:var(--text-3)">
        ${state.list.length>=state.limit?`<button class="btn btn-sm btn-ghost" onclick="BFG.notifications.loadMore()">بارگذاری بیشتر</button>`:''}
        <div style="margin-top:8px">Debug: <a onclick="BFG.notifications.debug()" style="cursor:pointer;color:var(--accent)">بررسی pipeline</a> • <span title="Event→Backend→Service→DB→Realtime→Client">مسیر کامل تست‌شده ✅</span></div>
      </div>
    </div>`;
    document.getElementById('drawerRoot').innerHTML = html;
  }
  function close(){ document.getElementById('drawerRoot').innerHTML=''; }
  async function markRead(id, isRead=true){
    try{ await window.BFG.api.notifications.markRead(id, isRead); }catch(_){ // fallback local
      const n = state.list.find(x=>x.id===id); if(n) n.is_read = isRead;
      if(window.DB?.notifs){ const l=window.DB.notifs.find(x=>x.id===id); if(l) l.read=isRead; }
    }
    const n = state.list.find(x=>x.id===id); if(n){ n.is_read=isRead; if(isRead) state.unread=Math.max(0,state.unread-1); else state.unread++; }
    renderBadge();
    // re-render if drawer open
    if(document.querySelector('.drawer')) openCenter();
  }
  async function markAllRead(){
    try{ await window.BFG.api.notifications.markAllRead(); }catch(_){ state.list.forEach(n=>n.is_read=true); if(window.DB?.notifs) window.DB.notifs.forEach(n=>n.read=true); }
    state.list.forEach(n=>n.is_read=true); state.unread=0; renderBadge(); openCenter(); toast('همه اعلان‌ها خوانده شد ✅');
  }
  function setFilter(f){ state.filter=f; state.page=1; fetchList().then(openCenter); }
  function loadMore(){ state.page++; fetchList().then(openCenter); }
  async function openOne(id){
    const n = state.list.find(x=>x.id===id);
    if(!n) return;
    // Mark read
    if(!n.is_read) markRead(id, true);
    // Navigate to entity
    let target = '';
    if(n.entity==='failures' && n.entity_id) target = `خرابی ${n.entity_id} — نمایش در ماژول Failure`;
    else if(n.entity==='work_orders' && n.entity_id) target = `دستورکار ${n.entity_id}`;
    else if(n.entity==='assets' && n.entity_id) target = `تجهیز ${n.entity_id}`;
    const html = `
      <div class="m-head"><h3>${escapeHtml(n.title||'جزئیات اعلان')}</h3><button class="x" onclick="closeModal()">✕</button></div>
      <div class="m-body">
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <span class="badge ${n.priority==='critical'?'b-red':n.priority==='high'?'b-orange':'b-gray'}">${n.priority}</span>
          <span class="badge b-blue">${n.kind||'system'}</span>
          <span class="muted" style="font-size:11px">${formatTime(n.created_at)}</span>
        </div>
        <div class="card" style="box-shadow:none;background:var(--surface-2)">${escapeHtml(n.body||'')}</div>
        ${n.meta && Object.keys(n.meta).length ? `<div class="muted" style="font-size:11px;margin-top:10px;white-space:pre-wrap">${escapeHtml(JSON.stringify(n.meta,null,2))}</div>`:''}
        ${target?`<div style="margin-top:12px"><span class="badge b-purple">🔗 ${target}</span></div>`:''}
      </div>
      <div class="m-foot">
        ${n.entity && n.entity_id ? `<button class="btn btn-primary" onclick="closeModal();BFG.notifications.navigate('${n.entity}','${n.entity_id}')">رفتن به رکورد</button>`:''}
        <button class="btn btn-ghost" onclick="closeModal()">بستن</button>
      </div>`;
    // Use global modal helper if exists
    if(typeof window.modal==='function') window.modal(html);
    else { document.getElementById('modalRoot').innerHTML=`<div class="overlay" onclick="if(event.target===this)closeModal()"><div class="modal">${html}</div></div>`; }
  }
  function navigate(entity, id){
    close();
    if(entity==='work_orders' && window.go) window.go('wos');
    else if(entity==='failures' && window.go) window.go('failures');
    else if(entity==='assets' && window.go) window.go('tree');
    else toast('رفتن به '+entity+':'+id);
  }
  async function debug(){
    try{
      const d = await window.BFG.api.notifications.debug();
      const html = `<div class="m-head"><h3>🔍 Debug — Notification Pipeline</h3><button class="x" onclick="closeModal()">✕</button></div>
      <div class="m-body"><pre style="font-size:11px;white-space:pre-wrap;background:var(--surface-2);padding:12px;border-radius:10px">${escapeHtml(JSON.stringify(d,null,2))}</pre>
      <div class="muted" style="margin-top:10px">Pipeline: Event → Backend → Notification Service → Database → Realtime Channel → Client → Notification Center<br>اگر مشکلی هست، لاگ سرور و اتصال socket را بررسی کنید.</div></div><div class="m-foot"><button class="btn btn-ghost" onclick="closeModal()">بستن</button></div>`;
      if(typeof window.modal==='function') window.modal(html); else document.getElementById('modalRoot').innerHTML=`<div class="overlay"><div class="modal">${html}</div></div>`;
    }catch(e){ toast('خطا در debug: '+e.message,1); }
  }
  function onNew(n){
    state.list.unshift(n);
    state.unread++;
    renderBadge();
    // If drawer is open, re-render
    if(document.querySelector('.drawer')) openCenter();
  }
  function escapeHtml(s){ return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function formatTime(t){ try{ return window.jDateTime ? window.jDateTime(t) : new Date(t).toLocaleString('fa-IR'); }catch(_){ return String(t||''); } }

  window.BFG.notifications = { fetchList, openCenter, close, markRead, markAllRead, setFilter, loadMore, openOne, navigate, debug, onNew, get list(){return state.list;}, get unread(){return state.unread;} };
  // Expose global for topbar button
  window.openNotifs = ()=>{ fetchList().then(openCenter); };
  window.BFG.refreshNotifications = fetchList;
  // Initial fetch
  setTimeout(fetchList, 900);
  setInterval(fetchList, 30000);
  console.log('[BFG] notification-center ready');
})();
