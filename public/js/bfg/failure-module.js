'use strict';
/* BFG Failure Module — Requirement #10,11,12,13
 * Entity: Failure, RCA (5Why, Fishbone, FaultTree, Pareto, Trend), AI Diagnosis, Repair Recommendation
 */
(function(){
  window.BFG = window.BFG || {};
  async function list(q={}){ return window.BFG.api.failures.list(q); }
  async function openFailure(id){
    try{
      const { data } = await window.BFG.api.failures.get(id);
      renderDetail(data);
    }catch(e){ toast('خطا: '+e.message,1); }
  }
  function renderDetail(f){
    const mediaHtml = (f.media||[]).map(m=>`<span class="badge b-blue" style="font-size:10px">${m.kind}: ${m.filename||m.url||''}</span>`).join(' ')||'<span class="muted">بدون پیوست</span>';
    const rcaHtml = (f.rca||[]).map(r=>`<div class="card" style="box-shadow:none;background:var(--surface-2);margin-bottom:8px"><b>${r.method}</b><pre style="font-size:11px;white-space:pre-wrap">${escapeHtml(JSON.stringify(r.content,null,2))}</pre><div class="muted" style="font-size:10px">${r.created_at}</div></div>`).join('')||'<div class="muted">تحلیلی ثبت نشده</div>';
    const html = `
      <div class="m-head"><h3>خرابی ${escapeHtml(f.failure_no)} — ${escapeHtml(f.asset_name||f.asset_id)}</h3><button class="x" onclick="closeModal()">✕</button></div>
      <div class="m-body">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <span class="badge ${f.severity==='critical'?'b-red':f.severity==='high'?'b-orange':'b-gray'}">${f.severity||'—'}</span>
          <span class="badge b-blue">${f.status||'open'}</span>
          <span class="badge ${f.provenance==='ai_predicted'?'b-purple':f.provenance==='ai_detected'?'b-purple':'b-gray'}">${f.provenance||'verified'}</span>
          ${f.provenance?.startsWith('ai')?'<span class="badge b-purple">🤖 AI</span>':''}
        </div>
        <div class="spec">
          <div><b>تجهیز</b>${escapeHtml(f.asset_name||f.asset_id)}</div>
          <div><b>زمان وقوع</b>${f.occurred_at ? (window.jDateTime?window.jDateTime(f.occurred_at):f.occurred_at) : '—'}</div>
          <div><b>نوع</b>${escapeHtml(f.failure_type||'—')}</div>
          <div><b>حالت</b>${escapeHtml(f.failure_mode||'—')}</div>
          <div><b>علت</b>${escapeHtml(f.cause||'—')}</div>
          <div><b>اثر</b>${escapeHtml(f.effect||'—')}</div>
          <div><b>داون‌تایم</b>${f.downtime_hours||0} ساعت</div>
          <div><b>ریسک</b>${f.risk_score||'—'}</div>
        </div>
        <div class="field" style="margin-top:12px"><label>شرح</label><div class="card" style="box-shadow:none">${escapeHtml(f.description||'—')}</div></div>
        <div class="field"><label>علائم</label><div>${(f.symptoms||[]).map(s=>`<span class="badge b-orange" style="margin:2px">${escapeHtml(s)}</span>`).join('')||'—'}</div></div>
        <div class="field"><label>پیوست‌ها و اندازه‌گیری‌ها</label><div>${mediaHtml}</div></div>
        <div style="display:flex;gap:8px;margin:12px 0;flex-wrap:wrap">
          <button class="btn btn-sm btn-accent" onclick="BFG.failures.diagnose('${f.id}')">🤖 تشخیص هوشمند</button>
          <button class="btn btn-sm btn-ghost" onclick="BFG.failures.openRCA('${f.id}','5why')">🔍 5 Why</button>
          <button class="btn btn-sm btn-ghost" onclick="BFG.failures.openRCA('${f.id}','fishbone')">🐟 Fishbone</button>
          <button class="btn btn-sm btn-ghost" onclick="BFG.failures.openRCA('${f.id}','pareto')">📊 Pareto</button>
          <button class="btn btn-sm btn-primary" onclick="BFG.failures.createWO('${f.id}')">🛠️ ایجاد دستورکار</button>
        </div>
        <h3 style="font-size:13px;margin:12px 0 6px">📋 تحلیل‌های RCA</h3>
        ${rcaHtml}
        <h3 style="font-size:13px;margin:12px 0 6px">🤖 پیشنهادات AI</h3>
        <div id="aiRecs">در حال بارگذاری…</div>
      </div>
      <div class="m-foot"><button class="btn btn-ghost" onclick="closeModal()">بستن</button></div>`;
    if(typeof window.modal==='function') window.modal(html, true);
    else document.getElementById('modalRoot').innerHTML=`<div class="overlay"><div class="modal wide">${html}</div></div>`;
    loadAIRecommendations(f.id);
  }
  async function diagnose(id){
    toast('در حال تحلیل هوشمند… 🤖');
    try{
      const res = await window.BFG.api.ai.diagnose(id);
      // Show result
      const html = `<div class="m-head"><h3>🤖 تشخیص هوشمند — ${id}</h3><button class="x" onclick="closeModal()">✕</button></div>
      <div class="m-body"><div style="white-space:pre-wrap;line-height:1.9;font-size:13px">${escapeHtml(res.text)}</div>
      <div style="margin-top:10px"><span class="badge ${res.online?'b-green':'b-orange'}">${res.online?'آنلاین':'آفلاین — Heuristic'}</span> <span class="badge b-gray">${res.model||''}</span></div>
      <div class="muted" style="font-size:11px;margin-top:8px">این تشخیص AI Suggested است و نیازمند تأیید انسانی (Pending Approval) می‌باشد.</div></div>
      <div class="m-foot"><button class="btn btn-primary" onclick="closeModal();BFG.failures.openFailure('${id}')">بازگشت</button></div>`;
      if(typeof window.modal==='function') window.modal(html,true); else document.getElementById('modalRoot').innerHTML=`<div class="overlay"><div class="modal wide">${html}</div></div>`;
      loadAIRecommendations(id);
    }catch(e){ toast('خطا در تشخیص: '+e.message,1); }
  }
  async function loadAIRecommendations(failureId){
    try{
      const res = await window.BFG.api.ai.recommendations({ entity:'failures', entityId: failureId });
      const el = document.getElementById('aiRecs');
      if(!el) return;
      if(!res.data?.length) el.innerHTML='<div class="muted">پیشنهادی ثبت نشده — دکمه تشخیص را بزنید.</div>';
      else el.innerHTML = res.data.map(r=>`
        <div class="card" style="box-shadow:none;border-right:3px solid ${r.status==='approved'?'var(--green)':r.status==='rejected'?'var(--red)':'var(--purple)'};margin-bottom:8px">
          <div style="display:flex;justify-content:space-between"><b style="font-size:12.5px">${escapeHtml(r.title)}</b><span class="badge ${r.status==='ai_suggested'?'b-purple':r.status==='approved'?'b-green':'b-gray'}" style="font-size:9px">${r.status}</span></div>
          <div style="font-size:12px;margin-top:4px">${escapeHtml(r.reason||'')}</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:4px">اطمینان ٪${r.confidence||'—'} • منبع: ${r.source||'—'} • ${r.created_at?window.jDateTime?window.jDateTime(r.created_at):r.created_at:''}</div>
          <div style="display:flex;gap:6px;margin-top:8px">
            ${r.status==='ai_suggested'?`<button class="btn btn-sm btn-accent" onclick="BFG.failures.reviewRec('${r.id}','approved')">✅ تأیید</button><button class="btn btn-sm btn-ghost" onclick="BFG.failures.reviewRec('${r.id}','rejected')">❌ رد</button>`:''}
            <button class="btn btn-sm btn-ghost" onclick="BFG.failures.createWOFromRec('${r.id}')">🛠️ WO</button>
          </div>
        </div>`).join('');
    }catch(e){ const el=document.getElementById('aiRecs'); if(el) el.innerHTML='<div class="muted">خطا در بارگذاری</div>'; }
  }
  async function reviewRec(id,status){
    try{ await window.BFG.api.ai.review(id, status); toast(status==='approved'?'تأیید شد ✅':'رد شد'); }catch(e){ toast(e.message,1); }
  }
  function openRCA(id, method){
    const content = prompt(`محتوای تحلیل ${method} را وارد کنید (JSON یا متن):`);
    if(content===null) return;
    let parsed = content;
    try{ parsed = JSON.parse(content); }catch(_){}
    window.BFG.api.failures.rca(id, method, typeof parsed==='object'?parsed:{ text: parsed }).then(()=>{ toast('RCA ثبت شد ✅'); openFailure(id); }).catch(e=>toast(e.message,1));
  }
  async function createWO(failureId){
    const descr = prompt('شرح دستورکار برای این خرابی:');
    if(!descr) return;
    try{
      const { data: f } = await window.BFG.api.failures.get(failureId);
      const wo = await window.BFG.api.workOrders.create({ assetId: f.asset_id, descr, priority: f.severity==='critical'?'critical':'high', type:'CM' });
      toast('دستورکار '+ (wo.data?.no||wo.no) +' ایجاد شد ✅');
      // Link chain
      try{ await fetch('/api/data/data_chain_links',{method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer '+(sessionStorage.getItem('bfg_token')||'')}, body: JSON.stringify({from_entity:'failures', from_id:failureId, to_entity:'work_orders', to_id:wo.data?.id||wo.id, relation:'failure-to-wo'})}); }catch(_){}
    }catch(e){ toast(e.message,1); }
  }
  function createWOFromRec(recId){ toast('ایجاد WO از پیشنهاد '+recId+' — در دست پیاده‌سازی، لطفاً از failure استفاده کنید'); }

  function pgFailures(){
    return `<div class="page-head"><div><div class="crumb">خانه › خرابی‌ها</div><h2>مدیریت خرابی‌ها (Failure Management)</h2></div>
      <div class="head-actions"><button class="btn btn-primary" onclick="BFG.wizards.openFailureWizard()">＋ گزارش خرابی (ویزارد)</button><button class="btn btn-ghost" onclick="BFG.failures.refresh()">🔄 بروزرسانی</button></div></div>
      <div id="failureList" style="min-height:200px"><div class="empty">در حال بارگذاری…</div></div>`;
  }
  async function refresh(){
    const el = document.getElementById('failureList');
    if(!el) return;
    try{
      const res = await list({ limit: 50 });
      const data = res.data || [];
      if(!data.length) el.innerHTML='<div class="empty"><div class="big">🔧</div>خرابی ثبت نشده — اولین گزارش را ثبت کنید</div>';
      else el.innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>شماره</th><th>تجهیز</th><th>شرح</th><th>شدت</th><th>وضعیت</th><th>منبع</th><th>تاریخ</th></tr></thead><tbody>`+
        data.map(f=>`<tr onclick="BFG.failures.openFailure('${f.id}')"><td class="mono">${f.failure_no||f.id.slice(0,8)}</td><td>${escapeHtml(f.asset_name||f.asset_id)}</td><td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.description||'—')}</td><td><span class="badge ${f.severity==='critical'?'b-red':f.severity==='high'?'b-orange':'b-gray'}">${f.severity||'—'}</span></td><td><span class="badge b-blue">${f.status||'—'}</span></td><td><span class="badge ${String(f.provenance).startsWith('ai')?'b-purple':'b-gray'}" style="font-size:9px">${f.provenance||'verified'}</span></td><td>${f.occurred_at?(window.jDate?window.jDate(f.occurred_at):f.occurred_at):'—'}</td></tr>`).join('')+`</tbody></table></div>`;
    }catch(e){
      // Fallback to local if API fails
      el.innerHTML='<div class="empty">خطا در بارگذاری — حالت آفلاین/دمو</div>';
    }
  }

  window.BFG.failures = { list, openFailure, renderDetail, diagnose, loadAIRecommendations, reviewRec, openRCA, createWO, createWOFromRec, pgFailures, refresh };
  // Register menu hook
  console.log('[BFG] failure-module ready');
  function escapeHtml(s){ return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
})();
