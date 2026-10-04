/* Backend-governed AI client: no provider keys or direct cloud calls in the browser. */
(function(){
  'use strict';
  const state=window.AIBackend={loading:false,loaded:false,error:null,status:null};
  const hasSession=()=>Boolean(window.BFGBackend&&window.BFGBackend.user);
  const textOf=content=>typeof content==='string'?content:(content||[]).filter(x=>x.type==='text').map(x=>x.text||'').join('\n');
  const mediaOf=messages=>{
    const media=[];
    for(const message of messages||[])for(const part of Array.isArray(message.content)?message.content:[]){
      if(part.type==='image_url'&&part.image_url?.url?.startsWith('data:')){const match=part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);if(match)media.push({kind:'image',mimeType:match[1],data:match[2]});}
      if(part.type==='input_audio'&&part.input_audio?.data)media.push({kind:'audio',mimeType:`audio/${part.input_audio.format||'wav'}`,data:part.input_audio.data});
    }
    return media;
  };
  async function refresh(render=false){
    if(state.loading)return;state.loading=true;state.error=null;
    try{state.status=await bfgApi('/api/ai/status');state.loaded=true;}catch(error){state.error=error;state.status=null;}finally{state.loading=false;if(render&&typeof CUR!=='undefined'&&CUR==='aicfg')go('aicfg');}
  }
  state.refresh=refresh;

  async function backendAIChat(messages,opts={}){
    const userMessages=(messages||[]).filter(x=>x.role==='user'),last=userMessages[userMessages.length-1];
    const equipmentId=opts.equipmentId||window.EQV2?.selected||(typeof selAsset!=='undefined'?selAsset:null);
    if(!hasSession())return{ok:false,error:'برای AI واقعی باید با حساب Backend وارد شوید؛ حالت Local پاسخ ساختگی تولید نمی‌کند.'};
    if(!equipmentId)return{ok:false,error:'برای تحلیل نگهداری ابتدا یک تجهیز را انتخاب کنید.'};
    try{
      const result=await bfgApi('/api/ai/analyze',{method:'POST',body:JSON.stringify({purpose:opts.purpose||'repair_recommendation',equipmentId,question:textOf(last?.content)||'تحلیل وضعیت تجهیز',media:mediaOf(messages),useSearch:!!opts.useSearch,preferredProvider:opts.provider||null})});
      const data=result.data,lines=[data.summary||'تحلیل ثبت شد.'];
      if((data.fallbackChain||[]).length>1)lines.push('مسیر بازیابی Provider: '+data.fallbackChain.map(step=>`${step.provider} (${step.status==='succeeded'?'موفق':step.status==='failed'?'ناموفق':'رد شد'})`).join(' ← '));
      for(const [index,item] of (data.recommendations||[]).entries())lines.push(`${index+1}) ${item.recommendation}\nدلیل: ${item.reason}\nاطمینان: ${item.confidence==null?'N/A':Math.round(item.confidence*100)+'٪'}\nوضعیت: در انتظار تأیید انسانی`);
      return{ok:true,text:lines.join('\n\n'),runId:data.runId,recommendations:data.recommendations,provider:data.provider,model:data.model,fallbackChain:data.fallbackChain||[]};
    }catch(error){return{ok:false,error:error.payload?.message||error.message,code:error.payload?.error};}
  }
  window.aiChat=backendAIChat;
  window.aiOnline=()=>!!state.status&&Object.values(state.status.providers||{}).some(x=>x.configured);

  window.aiProviderPolicy=async function(provider,enabled,sensitive,search,rowVersion){
    try{await bfgApi('/api/ai/providers/'+encodeURIComponent(provider),{method:'PATCH',body:JSON.stringify({enabled,allowSensitiveContext:sensitive,allowSearch:search,rowVersion})});await refresh(true);toast('سیاست Provider ذخیره شد ✅');}catch(error){toast('ذخیره سیاست AI ناموفق بود: '+error.message,1);}
  };

  window.pgAICfg=function(){
    if(!hasSession())return head('موتور هوش مصنوعی','تنظیمات › AI')+`<div class="card"><h3>Backend AI غیرفعال در نشست محلی</h3><p class="muted">PostgreSQL یا ورود Backend در دسترس نیست. برای جلوگیری از پاسخ ساختگی، موتور آفلاین نمایشی پاسخ تولید نمی‌کند. پس از اتصال دیتابیس با حساب Backend وارد شوید.</p></div>`;
    if(!state.loaded&&!state.loading)setTimeout(()=>refresh(true),0);
    if(state.loading)return head('موتور هوش مصنوعی','تنظیمات › AI')+'<div class="card empty">در حال دریافت وضعیت Backend AI…</div>';
    if(state.error)return head('موتور هوش مصنوعی','تنظیمات › AI')+`<div class="card"><h3>خطا در AI Gateway</h3><p class="muted">${esc(state.error.message)}</p><button class="btn btn-primary" onclick="AIBackend.refresh(true)">تلاش مجدد</button></div>`;
    const providers=state.status?.providers||{},policies=state.status?.policies||[];
    return head('موتور هوش مصنوعی','تنظیمات › AI')+`<div class="card" style="margin-bottom:14px"><h3>AI Gateway سازمانی</h3><div class="muted">کلیدها فقط در Environment سرور نگهداری می‌شوند. محاسبات KPI توسط موتور قطعی انجام می‌شود و همه پیشنهادهای AI نیازمند تأیید انسانی هستند.</div></div><div class="grid g3">${Object.entries(providers).map(([name,provider])=>{const policy=policies.find(x=>x.provider===name)||{};return`<div class="card"><h3>${name==='local'?'🏭 Local AI':name==='deepseek'?'🧠 DeepSeek':'✨ Google Gemini'}</h3><p class="muted">مدل: ${esc(provider.model||'تنظیم نشده')}</p><p><span class="badge ${provider.configured?'b-green':'b-red'}">${provider.configured?'پیکربندی‌شده':'کلید/Endpoint تنظیم نشده'}</span> <span class="badge ${policy.enabled?'b-blue':'b-gray'}">${policy.enabled?'مجاز':'غیرفعال در Policy'}</span></p><div class="muted">Text: ${provider.capabilities?.text?'✓':'—'} · Image: ${provider.capabilities?.image?'✓':'—'} · Audio: ${provider.capabilities?.audio?'✓':'—'} · Search: ${provider.capabilities?.search?'✓':'—'}</div>${ME?.role==='admin'?`<div style="margin-top:12px">${name!=='local'?`<label class="checkline"><input type="checkbox" ${policy.allow_sensitive_context?'checked':''} onchange="aiProviderPolicy('${name}',${!!policy.enabled},this.checked,${!!policy.allow_search},${policy.row_version||1})"> مجوز ارسال Context صنعتی به Cloud</label>`:''}${name==='gemini'?`<label class="checkline"><input type="checkbox" ${policy.allow_search?'checked':''} onchange="aiProviderPolicy('${name}',${!!policy.enabled},${!!policy.allow_sensitive_context},this.checked,${policy.row_version||1})"> مجوز Google Search Grounding</label>`:''}<button class="btn btn-sm ${policy.enabled?'btn-danger':'btn-primary'}" onclick="aiProviderPolicy('${name}',${!policy.enabled},${!!policy.allow_sensitive_context},${!!policy.allow_search},${policy.row_version||1})">${policy.enabled?'غیرفعال‌کردن':'فعال‌کردن'}</button></div>`:''}</div>`;}).join('')}</div><div class="card" style="margin-top:14px"><h3>متغیرهای لازم در سرور</h3><pre style="direction:ltr;text-align:left;white-space:pre-wrap">LOCAL_AI_BASE_URL / LOCAL_AI_MODEL\nDEEPSEEK_API_KEY / DEEPSEEK_MODEL\nGEMINI_API_KEY / GEMINI_MODEL\nGEMINI_SEARCH_ENABLED=true</pre><p class="muted">Secretها در این صفحه وارد یا نمایش داده نمی‌شوند.</p></div>`;
  };
  window.addEventListener('bfg:domain-event',event=>{if(event.detail?.type?.startsWith('ai.'))refresh(false);});
  if(hasSession())refresh(false);
})();
