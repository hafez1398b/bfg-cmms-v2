'use strict';
/* BFG Health Module — Equipment Health Score 0-100 (Requirement #14) */
(function(){
  window.BFG = window.BFG || {};
  async function get(assetId){ return window.BFG.api.health.get(assetId); }
  async function recalc(assetId){ return window.BFG.api.health.recalc(assetId); }

  function renderHealthCard(assetId, containerId){
    const el = document.getElementById(containerId);
    if(!el) return;
    el.innerHTML='<div class="muted">محاسبه سلامت…</div>';
    get(assetId).then(res=>{
      const h = res.asset.health_score;
      const factors = res.asset.health_factors || {};
      const history = res.history || [];
      const score = h ?? res.calculated?.score;
      const color = score>=80?'var(--green)':score>=50?'var(--orange)':'var(--red)';
      const bg = score>=80?'var(--green-bg)':score>=50?'var(--orange-bg)':'var(--red-bg)';
      el.innerHTML = `
        <div style="display:flex;gap:14px;align-items:center">
          <div style="width:86px;height:86px;border-radius:50%;background:${bg};border:4px solid ${color};display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:${color}">${score!=null? (window.fa?window.fa(score):score+'٪') : '—'}</div>
          <div style="flex:1">
            <div style="font-weight:800;font-size:13px">Health Score — ${res.asset.name||assetId}</div>
            <div class="muted" style="font-size:11px">بروزرسانی: ${res.asset.updated_at? (window.jDateTime?window.jDateTime(res.asset.updated_at):res.asset.updated_at) : '—'}</div>
            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
              ${score!=null?`<span class="badge" style="background:${bg};color:${color}">${score>=80?'پایدار':score>=50?'نیازمند توجه':'بحرانی'}</span>`:''}
              <span class="badge b-gray">MTBF: ${factors.mtbf_hours||'—'}h</span>
              <span class="badge b-gray">MTTR: ${factors.mttr_hours||'—'}h</span>
            </div>
          </div>
          <button class="btn btn-sm btn-ghost" onclick="BFG.health.recalc('${assetId}').then(()=>BFG.health.renderCard('${assetId}','${containerId}'))">🔄 محاسبه مجدد</button>
        </div>
        <div style="margin-top:12px">
          <b style="font-size:12px">عوامل مؤثر:</b>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;font-size:11px">
            ${Object.entries(factors).slice(0,8).map(([k,v])=>`<div style="padding:6px 9px;background:var(--surface-2);border-radius:9px;border:1px solid var(--border)"><span style="color:var(--text-3)">${k}</span><b style="display:block">${typeof v==='object'?JSON.stringify(v).slice(0,80):v}</b></div>`).join('')||'<span class="muted">داده‌ای برای نمایش نیست — محاسبه مجدد را بزنید</span>'}
          </div>
        </div>
        ${history.length?`<div style="margin-top:12px"><b style="font-size:12px">روند امتیاز:</b><div style="margin-top:6px">${renderSparkline(history.map(h=>h.score).reverse())}</div></div>`:''}
        <div class="muted" style="font-size:11px;margin-top:10px">امتیاز بر اساس داده واقعی (خرابی، PM، داون‌تایم، قطعات، کالیبراسیون) محاسبه شده و هر عامل قابل توضیح است.</div>
      `;
    }).catch(e=>{ el.innerHTML=`<div class="muted">خطا: ${e.message}</div><button class="btn btn-sm btn-ghost" onclick="BFG.health.recalc('${assetId}')">محاسبه</button>`; });
  }
  function renderSparkline(vals){
    if(!vals.length) return '';
    const w=280,h=60;
    const max=Math.max(...vals), min=Math.min(...vals);
    const pts = vals.map((v,i)=> `${(i/(vals.length-1))*w},${h - ((v-min)/(max-min||1))*h}`).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:60px;background:var(--surface-2);border-radius:10px;border:1px solid var(--border)"><polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${pts}"/>${vals.map((v,i)=>`<circle cx="${(i/(vals.length-1))*w}" cy="${h - ((v-min)/(max-min||1))*h}" r="2" fill="var(--accent)"/>`).join('')}</svg>`;
  }
  window.BFG.health = { get, recalc, renderCard: renderHealthCard, renderHealthCard };
  console.log('[BFG] health-module ready');
})();
