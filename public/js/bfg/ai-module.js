'use strict';
/* BFG AI Module — Requirement #7,8,9
 * Unified AI entry: chat, diagnosis, prediction, wizard suggestions, approval workflow
 */
(function(){
  window.BFG = window.BFG || {};
  let chatHistory = [];

  async function ask(question, assetId){
    chatHistory.push({ role:'user', content: question });
    const res = await window.BFG.api.ai.ask(question, assetId, chatHistory);
    chatHistory.push({ role:'assistant', content: res.text });
    return res;
  }
  function renderChat(containerId){
    const el = document.getElementById(containerId);
    if(!el) return;
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;height:460px;border:1px solid var(--border);border-radius:14px;overflow:hidden;background:var(--surface-2)">
        <div id="aiMsgs" style="flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px"></div>
        <div style="display:flex;gap:8px;padding:10px;background:var(--surface);border-top:1px solid var(--border)">
          <input id="aiInput" placeholder="سؤال خود را بپرسید… (مثلاً MTTR خط ۱ چقدر است؟)" style="flex:1" onkeydown="if(event.key==='Enter')BFG.ai.send()">
          <button class="btn btn-primary" onclick="BFG.ai.send()">ارسال</button>
        </div>
      </div>
      <div class="muted" style="font-size:11px;margin-top:6px">AI به Context واقعی (تجهیز، سوابق، PM، انبار) دسترسی دارد و هرگز داده جعلی تولید نمی‌کند. برچسب‌ها: AI Suggested / Predicted / Verified</div>`;
    refreshMsgs();
  }
  function refreshMsgs(){
    const box = document.getElementById('aiMsgs');
    if(!box) return;
    box.innerHTML = chatHistory.map(m=>`
      <div class="ai-msg ${m.role==='user'?'user':'bot'}" style="${m.role==='user'?'align-self:flex-start':'align-self:flex-end'}">
        <div style="white-space:pre-wrap;line-height:1.9">${escapeHtml(m.content).replace(/\n/g,'<br>')}</div>
      </div>`).join('') || `<div class="muted" style="text-align:center;padding:20px">سلام! من دستیار هوشمند نت هستم. سؤالی درباره تجهیزات، خرابی‌ها یا PM بپرسید.</div>`;
    box.scrollTop = box.scrollHeight;
  }
  async function send(){
    const inp = document.getElementById('aiInput');
    if(!inp) return;
    const q = inp.value.trim();
    if(!q) return;
    inp.value='';
    const box = document.getElementById('aiMsgs');
    // show user msg
    chatHistory.push({ role:'user', content:q });
    refreshMsgs();
    // typing
    const typing = document.createElement('div');
    typing.className='ai-msg bot';
    typing.style.alignSelf='flex-end';
    typing.innerHTML='<span class="ai-typing"><i></i><i></i><i></i></span> در حال تحلیل…';
    box.appendChild(typing); box.scrollTop=box.scrollHeight;
    try{
      const assetId = window.selAsset || window.BFG?.currentAsset || null;
      const res = await window.BFG.api.ai.ask(q, assetId, chatHistory.slice(0,-1));
      chatHistory[chatHistory.length-1] = { role:'user', content:q }; // ensure not duplicated
      chatHistory.push({ role:'assistant', content: res.text });
      if(res.recommendations?.length){
        // also persist? already done server-side
      }
      typing.remove();
      refreshMsgs();
      if(!res.online) toast('پاسخ از موتور داخلی (آفلاین) — '+ (res.error||''),0);
    }catch(e){
      typing.innerHTML=`<span style="color:var(--red)">خطا: ${escapeHtml(e.message)}</span>`;
      toast('خطا در AI: '+e.message,1);
    }
  }
  async function predict(assetId){
    toast('پیش‌بینی خرابی در حال انجام… 🤖');
    try{
      const res = await window.BFG.api.ai.predict(assetId);
      const html = `<div class="m-head"><h3>🔮 پیش‌بینی خرابی — AI Predicted</h3><button class="x" onclick="closeModal()">✕</button></div>
      <div class="m-body"><div style="white-space:pre-wrap;line-height:1.9">${escapeHtml(res.text)}</div>
      <div style="margin-top:10px"><span class="badge b-purple">AI Predicted — نیازمند تأیید انسانی</span> <span class="badge ${res.online?'b-green':'b-orange'}">${res.online?'آنلاین':'Heuristic'}</span></div></div><div class="m-foot"><button class="btn btn-ghost" onclick="closeModal()">بستن</button></div>`;
      if(typeof window.modal==='function') window.modal(html,true); else document.getElementById('modalRoot').innerHTML=`<div class="overlay"><div class="modal wide">${html}</div></div>`;
    }catch(e){ toast(e.message,1); }
  }

  window.BFG.ai = { ask, renderChat, send, predict, get history(){return chatHistory;}, clear(){chatHistory=[]; refreshMsgs();} };
  console.log('[BFG] ai-module ready');
  function escapeHtml(s){ return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
})();
