'use strict';
/* BFG Realtime Client — socket.io with auth, rooms, reconnection, handling (Requirement #3) */
(function(){
  window.BFG = window.BFG || {};
  let socket = null;
  let connected = false;
  const listeners = new Map();

  function token(){ return sessionStorage.getItem('bfg_token') || sessionStorage.getItem('token') || ''; }

  function connect(){
    if(socket) { try{ socket.disconnect(); }catch(_){} }
    const t = token();
    if(!t){ console.warn('[realtime] no token — skipping connect'); return; }
    socket = io({ auth: { token: t }, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1500 });
    window.BFG.socket = socket;

    socket.on('connect', ()=>{
      connected = true;
      console.log('[realtime] connected', socket.id);
      toast('اتصال Realtime برقرار شد ✅');
      // Re-join is automatic via server joinUserRooms on connect
    });
    socket.on('disconnect', (reason)=>{
      connected = false;
      console.warn('[realtime] disconnected', reason);
      if(reason !== 'io client disconnect') toast('ارتباط Realtime قطع شد — تلاش مجدد…',1);
    });
    socket.on('connect_error', (err)=>{
      console.error('[realtime] connect_error', err.message);
    });

    // Generic data-changed — refresh affected views without full reload
    socket.on('data-changed', (payload)=>{
      console.log('[realtime] data-changed', payload);
      handleDataChanged(payload);
    });
    socket.on('equipment-changed', (p)=>{
      console.log('[realtime] equipment-changed', p);
      if(window.eqv2Load) window.eqv2Load().catch(()=>{});
    });
    socket.on('notification:new', (n)=>{
      console.log('[realtime] notification:new', n);
      handleNotificationNew(n);
    });
    socket.on('notifications:refresh', ()=>{
      refreshNotificationBadge();
    });
    // Domain events
    ['failure:created','failure:updated','health:updated','ai:recommendation'].forEach(ev=>{
      socket.on(ev, (p)=>{ console.log('[realtime]',ev,p); handleDomainEvent(ev,p); });
    });
  }

  function handleDataChanged({collection, id, data}){
    if(!window.DB) return;
    const map = { wos: 'wos', assets: 'assets', requests: 'requests', failures: 'failures' };
    const key = map[collection] || collection;
    if(window.DB[key]){
      if(data){
        const idx = window.DB[key].findIndex(x=>x.id===id);
        if(idx>=0) window.DB[key][idx] = data; else window.DB[key].unshift(data);
      } else {
        window.DB[key] = window.DB[key].filter(x=>x.id!==id);
      }
      if(typeof window.buildMenu === 'function') window.buildMenu();
      const cur = window.CUR;
      if((cur==='wos' && collection==='wos') || (cur==='requests' && collection==='requests') || (cur==='tree' && collection==='assets')){
        if(typeof window.go === 'function') window.go(cur);
      }
      // Update detail if open
      try{ if(cur==='tree' && window.selAsset===id && typeof window.renderDossier==='function') window.go('tree'); }catch(_){}
    }
    // If API-backed, refresh via fetch instead of local DB
    if(window.BFG?.refreshCurrent) window.BFG.refreshCurrent();
  }

  function handleNotificationNew(n){
    // Update local notification center if exists
    if(window.BFG?.notifications?.onNew) window.BFG.notifications.onNew(n);
    refreshNotificationBadge();
    // Native notification if permitted
    if(window.Notification && Notification.permission==='granted'){
      try{ new Notification(n.title||'اعلان جدید', { body: (n.body||'').slice(0,120) }); }catch(_){}
    }
    // Toast for critical/high
    if(n.priority==='critical' || n.priority==='high'){
      toast((n.title||'اعلان')+': '+(n.body||'').slice(0,80), n.priority==='critical');
      // Optional sound
      try{ const a=new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA=='); a.volume=0.2; a.play().catch(()=>{});}catch(_){}
    }
  }

  function handleDomainEvent(ev,payload){
    if(ev.startsWith('failure:')){
      toast('خرابی جدید/به‌روزشده — مشاهده کنید');
      if(typeof window.go==='function' && window.CUR==='failures') window.go('failures');
    }
    if(ev==='health:updated'){
      // update badge on equipment tree if visible
      if(window.eqv2Load) window.eqv2Load();
    }
  }

  async function refreshNotificationBadge(){
    try{
      const r = await window.BFG.api.notifications.list({ limit: 1 });
      const count = r.unread ?? 0;
      const badge = document.getElementById('nBadge');
      if(badge){ badge.style.display = count ? 'block' : 'none'; badge.textContent = window.fa ? window.fa(count) : count; }
    }catch(_){}
  }

  function on(event, cb){
    if(!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(cb);
    if(socket) socket.on(event, cb);
  }
  function off(event, cb){
    if(socket) socket.off(event, cb);
  }

  window.BFG.realtime = { connect, get socket(){return socket;}, get connected(){return connected;}, on, off, refreshNotificationBadge };
  // Auto-connect when token appears (after login)
  const origSetItem = sessionStorage.setItem.bind(sessionStorage);
  sessionStorage.setItem = function(k,v){ origSetItem(k,v); if(k==='bfg_token' || k==='token') setTimeout(connect, 100); };
  // Try immediate
  setTimeout(()=>{ if(token()) connect(); }, 800);
  console.log('[BFG] realtime-client ready');
})();
