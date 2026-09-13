'use strict';
/* BFG Offline Queue — Requirement #19
 * Queues mutating API calls when offline, syncs on reconnection, handles conflicts (409), shows Sync status.
 * Storage: localStorage bfg_offline_queue
 * Usage: BFG.offline.queue('POST','/api/requests', data) or BFG.api.* automatically queues on network failure.
 */
(function(){
  window.BFG = window.BFG || {};
  const KEY = 'bfg_offline_queue';
  const STATUS_KEY = 'bfg_offline_status';

  function load(){ try{ return JSON.parse(localStorage.getItem(KEY)||'[]'); }catch(_){ return []; } }
  function save(q){ localStorage.setItem(KEY, JSON.stringify(q)); updateBadge(); }
  function updateBadge(){
    const q = load();
    const pending = q.filter(x=>x.status==='pending' || x.status==='retry').length;
    let el = document.getElementById('offlineBadge');
    if(!el){
      const tb = document.querySelector('.topbar');
      if(tb){
        el = document.createElement('span');
        el.id='offlineBadge';
        el.style.cssText='font-size:10px;padding:2px 7px;border-radius:99px;background:var(--orange-bg);color:var(--orange);font-weight:800;display:none;margin-left:6px';
        tb.insertBefore(el, tb.firstChild);
      }
    }
    if(el){
      if(pending){ el.style.display='inline-flex'; el.textContent = `⏳ ${pending} Sync Pending`; el.title='آفلاین — در انتظار همگام‌سازی'; }
      else if(!navigator.onLine){ el.style.display='inline-flex'; el.textContent='📡 آفلاین'; el.style.background='var(--red-bg)'; el.style.color='var(--red)'; }
      else el.style.display='none';
    }
    // Also show in console
    window.BFG.offlinePending = pending;
  }

  async function enqueue(method, path, body){
    const q = load();
    const entry = {
      id: 'q_'+Date.now()+'_'+Math.random().toString(36).slice(2,6),
      method, path, body: body ? JSON.parse(JSON.stringify(body)) : null,
      ts: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      lastError: null,
      idempotencyKey: 'idem_'+Date.now()+'_'+Math.random().toString(36).slice(2,6),
    };
    // attach idempotency key to body if POST
    if(entry.body && typeof entry.body==='object' && !entry.body._idempotencyKey){
      entry.body._idempotencyKey = entry.idempotencyKey;
    }
    q.push(entry);
    save(q);
    toast('آفلاین — درخواست در صف Sync قرار گرفت ⏳');
    return { queued: true, id: entry.id, pending: q.length };
  }

  async function sync(){
    if(!navigator.onLine){ updateBadge(); return { synced:0, pending: load().length }; }
    const q = load();
    if(!q.length){ updateBadge(); return { synced:0 }; }
    let synced=0, failed=0;
    for(const entry of q){
      if(entry.status==='done') continue;
      try{
        entry.attempts++;
        const opts = { method: entry.method, body: entry.body ? JSON.stringify(entry.body) : undefined, headers: {} };
        const t = sessionStorage.getItem('bfg_token')||sessionStorage.getItem('token');
        if(t) opts.headers['Authorization']='Bearer '+t;
        opts.headers['Content-Type']='application/json';
        if(entry.idempotencyKey) opts.headers['X-Idempotency-Key']=entry.idempotencyKey;
        const res = await fetch(entry.path, opts);
        if(res.status===409){
          // Conflict — needs user resolution (Requirement #1)
          entry.status='conflict';
          entry.lastError='VERSION_CONFLICT — رکورد توسط کاربر دیگری تغییر کرده';
          toast('تداخل نسخه — لطفاً داده را تازه کنید',1);
          continue;
        }
        if(!res.ok){
          const txt = await res.text().catch(()=>'');
          throw new Error(`HTTP ${res.status} ${txt.slice(0,120)}`);
        }
        entry.status='done';
        entry.lastError=null;
        synced++;
      }catch(e){
        entry.status = entry.attempts >= 3 ? 'failed' : 'retry';
        entry.lastError = e.message;
        failed++;
        console.warn('[offline] sync failed', entry.id, e.message);
      }
    }
    // Keep conflicts/failed for manual resolution, remove done
    const remaining = q.filter(x=>x.status!=='done');
    save(remaining);
    if(synced) toast(`همگام‌سازی انجام شد — ${synced} مورد Sync ✅`);
    if(failed) toast(`${failed} مورد نیاز به بررسی دارد`,1);
    updateBadge();
    // Trigger refresh
    if(synced && window.BFG?.realtime?.refreshNotificationBadge) window.BFG.realtime.refreshNotificationBadge();
    return { synced, failed, pending: remaining.length };
  }

  // Monkey-patch fetch for auto-queue on offline/network error (selective)
  const origFetch = window.fetch.bind(window);
  window.fetch = async function(url, opts={}){
    const isMutating = ['POST','PUT','PATCH','DELETE'].includes((opts.method||'GET').toUpperCase());
    const isApi = typeof url==='string' && url.startsWith('/api/');
    if(isMutating && isApi && !navigator.onLine){
      const body = opts.body ? JSON.parse(opts.body) : null;
      return enqueue(opts.method||'POST', url, body).then(r=>{
        // Return a fake 202 response so caller knows it's queued
        return new Response(JSON.stringify({ queued:true, ...r }), { status:202, headers:{'Content-Type':'application/json'} });
      });
    }
    try{
      const res = await origFetch(url, opts);
      if(!res.ok && !navigator.onLine && isMutating && isApi){
        // Network error masquerading as offline
        throw new Error('offline');
      }
      return res;
    }catch(e){
      if(isMutating && isApi){
        const body = opts.body ? JSON.parse(opts.body) : null;
        const r = await enqueue(opts.method||'POST', url, body);
        return new Response(JSON.stringify({ queued:true, ...r }), { status:202, headers:{'Content-Type':'application/json'} });
      }
      throw e;
    }
  };

  window.addEventListener('online', ()=>{ console.log('[offline] online — syncing'); setTimeout(sync, 600); updateBadge(); toast('اتصال برقرار شد — همگام‌سازی…'); });
  window.addEventListener('offline', ()=>{ updateBadge(); toast('اتصال قطع شد — حالت آفلاین 📡',1); });

  window.BFG.offline = { enqueue, sync, load, save, updateBadge, get pending(){return load().filter(x=>x.status!=='done').length;} };
  setInterval(updateBadge, 3000);
  setTimeout(updateBadge, 500);
  // Sync on load if online
  setTimeout(()=>{ if(navigator.onLine) sync(); }, 1500);
  console.log('[BFG] offline-queue ready');
})();
