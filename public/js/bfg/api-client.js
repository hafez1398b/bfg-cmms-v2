'use strict';
/* BFG API Client — unified, authenticated, retry, idempotency (Requirement #1, #19) */
(function(){
  const TOKEN_KEY = 'bfg_token';
  window.BFG = window.BFG || {};

  function token(){ return sessionStorage.getItem(TOKEN_KEY) || sessionStorage.getItem('bfg_token') || sessionStorage.getItem('token'); }
  function setToken(t){ sessionStorage.setItem(TOKEN_KEY, t); }
  function headers(extra={}){
    const h = { 'Content-Type': 'application/json', ...extra };
    const t = token();
    if(t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }
  async function request(path, opts={}){
    const res = await fetch(path, { ...opts, headers: { ...headers(), ...(opts.headers||{}) } });
    if(!res.ok){
      const body = await res.json().catch(()=>({}));
      const err = new Error(body.message || body.error || `HTTP ${res.status}`);
      err.status = res.status; err.body = body; err.payload = body;
      throw err;
    }
    const ct = res.headers.get('content-type')||'';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  // Idempotency key for offline queue
  function idempotencyKey(){ return 'idem_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); }

  const api = {
    token, setToken, headers, request, idempotencyKey,
    get:(p)=>request(p),
    post:(p, data, opts={})=>request(p, { method:'POST', body: JSON.stringify(data), ...opts }),
    patch:(p, data)=>request(p, { method:'PATCH', body: JSON.stringify(data) }),
    del:(p)=>request(p, { method:'DELETE' }),
    // domain helpers
    auth: {
      login:(username,password)=>request('/api/auth/login',{method:'POST', body: JSON.stringify({username,password})}),
      me:()=>request('/api/auth/me').catch(()=>null),
    },
    equipment: {
      list:(q)=>request('/api/equipment?'+new URLSearchParams(q||{})),
      tree:(q)=>request('/api/equipment/tree?'+new URLSearchParams(q||{})),
      get:(id)=>request('/api/equipment/'+encodeURIComponent(id)),
      create:(d)=>request('/api/equipment',{method:'POST', body: JSON.stringify(d)}),
      update:(id,d)=>request('/api/equipment/'+encodeURIComponent(id),{method:'PATCH', body: JSON.stringify(d)}),
    },
    requests: {
      list:(q)=>request('/api/requests?'+new URLSearchParams(q||{})),
      get:(id)=>request('/api/requests/'+encodeURIComponent(id)),
      create:(d)=>request('/api/requests',{method:'POST', body: JSON.stringify({...d, _idempotencyKey: d._idempotencyKey||idempotencyKey()})}),
      approve:(id)=>request('/api/requests/'+encodeURIComponent(id)+'/approve',{method:'POST', body:'{}'}),
    },
    workOrders: {
      list:(q)=>request('/api/work-orders?'+new URLSearchParams(q||{})),
      get:(id)=>request('/api/work-orders/'+encodeURIComponent(id)),
      create:(d)=>request('/api/work-orders',{method:'POST', body: JSON.stringify({...d, _idempotencyKey: d._idempotencyKey||idempotencyKey()})}),
      setStatus:(id,s,report,rowVersion)=>request('/api/work-orders/'+encodeURIComponent(id)+'/status',{method:'PATCH', body: JSON.stringify({status:s, report, rowVersion})}),
      assign:(id,assignee,rowVersion)=>request('/api/work-orders/'+encodeURIComponent(id)+'/assign',{method:'PATCH', body: JSON.stringify({assignee,rowVersion})}),
      addPart:(id,itemId,qty)=>request('/api/work-orders/'+encodeURIComponent(id)+'/parts',{method:'POST', body: JSON.stringify({itemId,qty})}),
    },
    failures: {
      list:(q)=>request('/api/failures?'+new URLSearchParams(q||{})),
      get:(id)=>request('/api/failures/'+encodeURIComponent(id)),
      create:(d)=>request('/api/failures',{method:'POST', body: JSON.stringify(d)}),
      update:(id,d)=>request('/api/failures/'+encodeURIComponent(id),{method:'PATCH', body: JSON.stringify(d)}),
      rca:(id,method,content)=>request('/api/failures/'+encodeURIComponent(id)+'/rca',{method:'POST', body: JSON.stringify({method,content})}),
    },
    health: {
      get:(assetId)=>request('/api/health/'+encodeURIComponent(assetId)),
      recalc:(assetId)=>request('/api/health/'+encodeURIComponent(assetId)+'/recalculate',{method:'POST', body:'{}'}),
      list:(q)=>request('/api/health?'+new URLSearchParams(q||{})),
    },
    ai: {
      ask:(question, assetId, history, imageDataUrl)=>request('/api/ai/ask',{method:'POST', body: JSON.stringify({question, assetId, history, imageDataUrl})}),
      diagnose:(failureId)=>request('/api/ai/diagnose/'+encodeURIComponent(failureId),{method:'POST', body:'{}'}),
      predict:(assetId)=>request('/api/ai/predict/'+encodeURIComponent(assetId),{method:'POST', body:'{}'}),
      suggest:(wizard,step,context)=>request('/api/ai/suggest',{method:'POST', body: JSON.stringify({wizard,step,context})}),
      recommendations:(q)=>request('/api/ai/recommendations?'+new URLSearchParams(q||{})),
      review:(id,status,note)=>request('/api/ai/recommendations/'+encodeURIComponent(id),{method:'PATCH', body: JSON.stringify({status,note})}),
    },
    notifications: {
      list:(q)=>request('/api/notifications?'+new URLSearchParams(q||{})),
      markRead:(id,isRead=true)=>request('/api/notifications/'+encodeURIComponent(id)+'/read',{method:'PATCH', body: JSON.stringify({is_read:isRead})}),
      markAllRead:()=>request('/api/notifications/read-all',{method:'POST', body:'{}'}),
      debug:()=>request('/api/notifications/_debug/pipeline'),
    },
    audit: {
      list:(q)=>request('/api/audit?'+new URLSearchParams(q||{})),
    },
  };
  window.BFG.api = api;
  console.log('[BFG] api-client ready');
})();
