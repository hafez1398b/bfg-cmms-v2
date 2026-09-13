'use strict';
/* BFG Wizard Engine — generic stepper for all main forms (Requirement #5)
 * Rules per step:
 *  1. One clear question
 *  2. Suitable options
 *  3. AI/software suggests context-aware options
 *  4. Always "سایر / ورود دستی"
 *  5. User can enter free text/number
 *  6. Next step is context-aware
 *  7. Can go back
 *  8. Summary before submit
 *  9. Submit to backend after confirmation
 */
(function(){
  window.BFG = window.BFG || {};

  class Wizard {
    constructor({ id, title, steps, onSubmit, storageKey }){
      this.id = id;
      this.title = title;
      this.steps = steps; // array of step configs
      this.onSubmit = onSubmit;
      this.storageKey = storageKey || `bfg_wizard_${id}`;
      this.current = 0;
      this.data = this.load() || {};
      this.aiOptions = {}; // stepIndex -> options from AI
      this.loadingAI = {};
    }
    load(){ try{ return JSON.parse(localStorage.getItem(this.storageKey)||'null'); }catch(_){ return null; } }
    save(){ localStorage.setItem(this.storageKey, JSON.stringify({ current:this.current, data:this.data })); }
    clear(){ localStorage.removeItem(this.storageKey); }

    start(initialData={}){
      this.current = 0;
      this.data = { ...initialData };
      this.save();
      this.render();
    }
    next(){
      if(this.current < this.steps.length -1){
        this.current++;
        this.save();
        this.render();
      }
    }
    prev(){
      if(this.current>0){ this.current--; this.save(); this.render(); }
    }
    go(i){
      if(i>=0 && i<this.steps.length){ this.current=i; this.save(); this.render(); }
    }
    setValue(key, value){
      this.data[key]=value;
      this.save();
    }

    async fetchAISuggestions(stepIndex){
      const step = this.steps[stepIndex];
      if(!step.ai || this.aiOptions[stepIndex]) return;
      this.loadingAI[stepIndex]=true;
      this.render(); // show loading
      try{
        const res = await window.BFG.api.ai.suggest(this.id, stepIndex+1, this.data);
        this.aiOptions[stepIndex] = res.options || [];
        // Also store text
        console.log('[wizard] AI suggestions', stepIndex, res.options);
      }catch(e){
        console.warn('[wizard] AI suggest failed', e.message);
        this.aiOptions[stepIndex] = [];
      }finally{
        this.loadingAI[stepIndex]=false;
        this.render();
      }
    }

    getOptions(step){
      const idx = this.steps.indexOf(step);
      const ai = this.aiOptions[idx] || [];
      const manual = step.options || [];
      // Merge: AI first, then static, ensure manual entry exists
      const merged = [...ai];
      for(const o of manual){
        if(!merged.find(x=>x.value===o.value)) merged.push(o);
      }
      if(!merged.find(x=>x.value==='__manual__')) merged.push({ label:'سایر / ورود دستی', value:'__manual__', reason:'ورود دلخواه' });
      return merged;
    }

    render(){
      const step = this.steps[this.current];
      const isLast = this.current === this.steps.length -1;
      const isSummary = step.type==='summary';
      const total = this.steps.length;

      // Wizard steps header
      const stepsHtml = `<div class="wiz-steps">` + this.steps.map((s,i)=>`
        <div class="wiz-step ${i<this.current?'done':i===this.current?'cur':''}" onclick="BFG.wizardEngine.go(${i})">
          <div class="wn">${i<this.current?'✓':window.fa?window.fa(i+1):i+1}</div>${s.title}
        </div>`).join('') + `</div>`;

      let body='';
      if(isSummary){
        body = `<div class="card" style="box-shadow:none;background:var(--surface-2);margin-bottom:14px">
          <h3 style="font-size:13px">📋 بازبینی نهایی — لطفاً قبل از ثبت بررسی کنید</h3>
          <div style="display:grid;gap:8px;margin-top:10px">
            ${this.steps.slice(0,-1).map(s=>{
              const v = this.data[s.key];
              const display = Array.isArray(v) ? v.join('، ') : (v || '—');
              return `<div style="display:flex;justify-content:space-between;padding:7px 10px;background:var(--surface);border-radius:9px;border:1px solid var(--border)"><span style="color:var(--text-3);font-size:11px">${s.title}</span><b style="font-size:12px">${escapeHtml(String(display).slice(0,120))}</b></div>`;
            }).join('')}
          </div>
          ${this.data._aiSuggestions ? `<div class="muted" style="font-size:11px;margin-top:10px">💡 پیشنهادات AI در نظر گرفته شد — نیازمند تأیید نهایی شماست.</div>` : ''}
        </div>`;
      } else if(step.type==='options'){
        const opts = this.getOptions(step);
        const curVal = this.data[step.key];
        if(step.ai && !this.aiOptions[this.steps.indexOf(step)] && !this.loadingAI[this.steps.indexOf(step)]){
          setTimeout(()=>this.fetchAISuggestions(this.current), 100);
        }
        body = `
          <div style="margin-bottom:14px">
            <div style="font-size:15px;font-weight:800;margin-bottom:6px">${step.question}</div>
            ${step.hint?`<div class="muted" style="font-size:11.5px;margin-bottom:12px">${step.hint}</div>`:''}
            ${this.loadingAI[this.current]?`<div style="padding:14px;text-align:center;color:var(--text-3)"><span class="ai-typing"><i></i><i></i><i></i></span> دریافت پیشنهاد هوشمند…</div>`:
              `<div class="radio-cards">
                ${opts.map(o=>`
                  <div class="radio-card ${curVal===o.value?'sel':''}" onclick="BFG.wizardEngine.select('${step.key}','${escapeAttr(o.value)}')">
                    <span class="rc-ic">${o.icon||'🔹'}</span>
                    ${escapeHtml(o.label)}
                    ${o.confidence?`<div style="font-size:10px;color:var(--text-3);margin-top:3px">اطمینان ٪${o.confidence}</div>`:''}
                    ${o.reason?`<div style="font-size:10px;color:var(--accent);margin-top:2px">${escapeHtml(o.reason.slice(0,60))}</div>`:''}
                  </div>`).join('')}
              </div>`
            }
            ${curVal==='__manual__' || (curVal && !opts.find(x=>x.value===curVal)) ? `
              <div class="field" style="margin-top:14px">
                <label>ورود دستی ${step.required?'<span class="req-star">*</span>':''}</label>
                <input id="wizManual" value="${escapeAttr(curVal!=='__manual__'?curVal:'')}" placeholder="${step.placeholder||'وارد کنید…'}" oninput="BFG.wizardEngine.setValue('${step.key}', this.value)">
                ${step.ai?`<div class="muted" style="font-size:11px;margin-top:4px">این مقدار به‌عنوان داده تأییدشده (Verified) ذخیره می‌شود، نه پیش‌بینی AI.</div>`:''}
              </div>
            `:''}
          </div>`;
      } else if(step.type==='text'){
        body = `
          <div class="field">
            <label>${step.question} ${step.required?'<span class="req-star">*</span>':''}</label>
            ${step.multiline?`<textarea id="wizInput" rows="${step.rows||3}" placeholder="${step.placeholder||''}" oninput="BFG.wizardEngine.setValue('${step.key}', this.value)">${escapeHtml(this.data[step.key]||'')}</textarea>`:
              `<input id="wizInput" value="${escapeAttr(this.data[step.key]||'')}" placeholder="${step.placeholder||''}" oninput="BFG.wizardEngine.setValue('${step.key}', this.value)">`}
            ${step.hint?`<div class="muted" style="font-size:11px;margin-top:6px">${step.hint}</div>`:''}
          </div>`;
        // For equipment selection steps, add search/tree
        if(step.key==='assetId' || step.key==='equipment'){
          body += `<div style="margin-top:12px">
            <div class="tbl-wrap" style="max-height:220px;overflow:auto">
              <div style="padding:8px;display:flex;gap:6px;flex-wrap:wrap">
                ${(window.DB?.assets||[]).filter(a=>a.type==='eq').slice(0,50).map(a=>`
                  <button class="btn btn-sm ${this.data[step.key]===a.id?'btn-primary':'btn-ghost'}" onclick="BFG.wizardEngine.setValue('${step.key}','${a.id}');BFG.wizardEngine.render()">${escapeHtml(a.name)} <span class="mono" style="font-size:9px">${a.code}</span></button>
                `).join('')}
              </div>
            </div>
            <div style="display:flex;gap:8px;margin-top:8px">
              <input id="wizAssetSearch" placeholder="جستجوی تجهیز…" oninput="BFG.wizardEngine.filterAssets(this.value)" style="flex:1">
              <span class="muted" style="font-size:11px;align-self:center">تجهیزات اخیر / مرتبط با کاربر در آینده از API لود می‌شود</span>
            </div>
          </div>`;
        }
      } else if(step.type==='custom'){
        body = step.render ? step.render(this.data, this) : '';
      }

      const canNext = (()=> {
        if(isSummary) return true;
        if(step.required){
          const v = this.data[step.key];
          if(v===undefined || v===null || String(v).trim()==='' || v==='__manual__') {
            // if manual, check manual input
            const mv = document.getElementById('wizManual')?.value || '';
            if(v==='__manual__' && !mv.trim()) return false;
            if(v==='__manual__') return true;
            return false;
          }
        }
        // For options, require selection
        if(step.type==='options' && step.required && !this.data[step.key]) return false;
        return true;
      })();

      const html = `
        <div class="m-head"><h3>${this.title} — گام ${window.fa?window.fa(this.current+1):this.current+1} از ${window.fa?window.fa(total):total}</h3><button class="x" onclick="BFG.wizardEngine.close()">✕</button></div>
        <div class="m-body">
          ${stepsHtml}
          <div style="margin-top:10px">${body}</div>
        </div>
        <div class="m-foot" style="justify-content:space-between">
          <div style="display:flex;gap:8px">
            ${this.current>0?`<button class="btn btn-ghost" onclick="BFG.wizardEngine.prev()">← مرحله قبل</button>`:''}
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost" onclick="BFG.wizardEngine.close()">انصراف</button>
            ${isLast ? `<button class="btn btn-primary" ${!canNext?'disabled style="opacity:.5"':''} onclick="BFG.wizardEngine.submit()">✅ ثبت نهایی</button>` :
              `<button class="btn btn-primary" ${!canNext?'disabled style="opacity:.5"':''} onclick="BFG.wizardEngine.next()">مرحله بعد →</button>`}
          </div>
        </div>`;

      const root = document.getElementById('modalRoot');
      root.innerHTML = `<div class="overlay" onclick="if(event.target===this)BFG.wizardEngine.close()"><div class="modal wide">${html}</div></div>`;
      // Focus manual if needed
      setTimeout(()=>{
        const inp = document.getElementById('wizManual') || document.getElementById('wizInput');
        if(inp) inp.focus();
      }, 80);
    }

    select(key, value){
      if(value==='__manual__'){
        this.data[key]='__manual__';
      } else {
        this.data[key]=value;
      }
      // Context-aware: changing current step may affect next step options — clear future AI cache
      const idx = this.steps.findIndex(s=>s.key===key);
      for(let i=idx+1;i<this.steps.length;i++) delete this.aiOptions[i];
      this.save();
      this.render();
    }
    filterAssets(q){
      // Simple client filter — in production would call /api/equipment?search=
      console.log('[wizard] filter assets', q);
    }
    async submit(){
      // Validate all required
      for(const s of this.steps){
        if(s.required && s.key){
          const v = this.data[s.key];
          if(v===undefined || v===null || String(v).trim()==='' || v==='__manual__'){
            if(v==='__manual__'){
              const mv = document.getElementById('wizManual')?.value?.trim();
              if(mv) this.data[s.key]=mv;
              else { toast(`فیلد "${s.title}" الزامی است`,1); this.go(this.steps.indexOf(s)); return; }
            } else { toast(`فیلد "${s.title}" الزامی است`,1); this.go(this.steps.indexOf(s)); return; }
          }
        }
      }
      // Resolve manual entries
      if(this.data.assetId==='__manual__') this.data.assetId = document.getElementById('wizManual')?.value || '';
      // Show loading
      const foot = document.querySelector('.m-foot');
      if(foot) foot.innerHTML = `<div style="padding:8px;color:var(--accent)">⏳ در حال ثبت…</div>`;
      try{
        const result = await this.onSubmit(this.data);
        this.clear();
        if(typeof window.closeModal==='function') window.closeModal();
        else document.getElementById('modalRoot').innerHTML='';
        toast('با موفقیت ثبت شد ✅');
        return result;
      }catch(e){
        console.error('[wizard] submit failed', e);
        toast('خطا در ثبت: '+(e.payload?.error||e.message),1);
        this.render();
      }
    }
    close(){
      if(typeof window.closeModal==='function') window.closeModal();
      else document.getElementById('modalRoot').innerHTML='';
    }
    go(i){ this.current=i; this.save(); this.render(); }
  }

  const engine = {
    current: null,
    create(opts){ this.current = new Wizard(opts); window.BFG.wizardEngine = this.current; // expose for onclick handlers
      // also expose on BFG.wizardEngine for global onclicks
      Object.assign(this, this.current);
      // Patch global for onclick strings that expect BFG.wizardEngine.method
      window.BFG.wizardEngine = this.current;
      return this.current;
    },
    start(...args){ return this.current?.start(...args); },
  };
  window.BFG.Wizard = Wizard;
  window.BFG.wizardEngine = engine;
  console.log('[BFG] wizard-engine ready');
  function escapeHtml(s){ return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function escapeAttr(s){ return String(s||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
})();
