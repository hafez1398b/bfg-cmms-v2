'use strict';
/* BFG Data Provenance — visual badges & data-chain (Requirements #17, #18)
 * Provenance values: verified | ai_detected | ai_predicted | ai_suggested | inferred | pending_verification
 * Every record field / prediction / recommendation must carry a provenance tag.
 * This module renders consistent badges and a lightweight data-chain explorer.
 */
(function(){
  window.BFG = window.BFG || {};
  const MAP = {
    verified:              { label: 'تأییدشده',        color: 'var(--green)', bg: 'var(--green-bg)', icon: '✅' },
    ai_detected:           { label: 'شناسایی AI',      color: 'var(--purple)', bg: 'var(--purple-bg)', icon: '🤖' },
    ai_predicted:          { label: 'AI Predicted',    color: 'var(--purple)', bg: 'var(--purple-bg)', icon: '🔮' },
    ai_suggested:          { label: 'AI Suggested',    color: 'var(--blue)', bg: 'var(--blue-bg)', icon: '💡' },
    inferred:              { label: 'استنتاج‌شده',      color: 'var(--orange)', bg: 'var(--orange-bg)', icon: '🧩' },
    pending_verification:  { label: 'در انتظار تأیید', color: 'var(--orange)', bg: 'var(--orange-bg)', icon: '⏳' },
    pending:               { label: 'در انتظار',       color: 'var(--gray)', bg: 'var(--gray-bg)', icon: '⏳' },
  };
  function badge(provenance, extra=''){
    const m = MAP[provenance] || MAP.pending;
    return `<span class="badge" style="background:${m.bg};color:${m.color};border:1px solid ${m.color}22" title="${m.label} — provenance: ${provenance}">${m.icon} ${m.label}${extra? ' — '+extra : ''}</span>`;
  }
  function dot(provenance){
    const m = MAP[provenance] || MAP.pending;
    return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px"><span style="width:8px;height:8px;border-radius:50%;background:${m.color};display:inline-block;box-shadow:0 0 0 3px ${m.color}18"></span>${m.label}</span>`;
  }
  function chainBadge(relation){
    const icons={ request_to_wo:'📝→🛠️', wo_to_failure:'🛠️→🚨', failure_to_rca:'🚨→🔬', ai_to_recommendation:'🤖→💡', pm_to_wo:'🔁→🛠️' };
    return icons[relation] || relation;
  }

  // Render provenance inline next to any AI field — forces human approval visual
  function renderProvenanceField(value, provenance, opts={}){
    const needsApproval = ['ai_suggested','ai_predicted','ai_detected','pending_verification'].includes(provenance);
    return `<div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
      <span>${value}</span>
      ${badge(provenance)}
      ${needsApproval? '<span class="badge b-orange" style="font-size:10px">نیازمند تأیید انسانی</span>' : ''}
      ${opts.evidence? `<span class="muted" style="font-size:10.5px">Evidence: ${opts.evidence.slice(0,120)}</span>`:''}
    </div>`;
  }

  // Data chain explorer — lightweight, fetches links where available
  async function renderChain(entity, id, containerId){
    const el = document.getElementById(containerId);
    if(!el) return;
    el.innerHTML = '<div class="muted">بارگذاری زنجیره داده…</div>';
    try{
      // Try API if available
      let links = [];
      try{
        const r = await window.BFG.api.request(`/api/audit?entity=${encodeURIComponent(entity)}&entityId=${encodeURIComponent(id)}&limit=20`);
        if(r?.data) links = r.data.slice(0,12);
      }catch(_){ /* fallback to local DB */ }
      if(!links.length && window.DB){
        // Heuristic local chain from DB references
        const related = [];
        if(entity==='assets' || entity==='equipment'){
          const wos = (window.DB.wos||[]).filter(w=> w.assetId===id);
          const failures = (window.DB.failures||[]).filter(f=> f.assetId===id);
          const pms = (window.DB.pms||[]).filter(p=> p.assetId===id);
          if(wos.length) related.push({label:`${wos.length} دستورکار مرتبط`, icon:'🛠️'});
          if(failures.length) related.push({label:`${failures.length} خرابی مرتبط`, icon:'🚨'});
          if(pms.length) related.push({label:`${pms.length} برنامه PM`, icon:'🔁'});
        }
        el.innerHTML = related.length ? related.map(r=>`<div class="list-row"><div class="list-ic">${r.icon}</div><b>${r.label}</b></div>`).join('') : '<div class="muted">زنجیره‌ای یافت نشد — داده‌ها باید از طریق زنجیره رسمی ثبت شوند.</div>';
        // Provenance legend
        el.innerHTML += `<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;padding-top:8px;border-top:1px dashed var(--border)">${Object.entries(MAP).slice(0,6).map(([k,v])=>`<span class="badge" style="background:${v.bg};color:${v.color};font-size:10px">${v.icon} ${v.label}</span>`).join('')}</div>`;
        return;
      }
      el.innerHTML = links.map(l=>`<div class="tl-item"><div class="tl-time">${window.jDateTime? window.jDateTime(l.t): l.t} — ${l.actor_name||l.u||''}</div><div class="tl-txt">${l.action} ${l.entity}:${l.entity_id} ${l.note? '— '+l.note:''}</div></div>`).join('') || '<div class="muted">سابقه‌ای برای این موجودیت ثبت نشده</div>';
    }catch(e){
      el.innerHTML = `<div class="muted">خطا: ${e.message}</div>`;
    }
  }

  window.BFG.provenance = { MAP, badge, dot, chainBadge, renderProvenanceField, renderChain };
  console.log('[BFG] provenance ready');
})();
