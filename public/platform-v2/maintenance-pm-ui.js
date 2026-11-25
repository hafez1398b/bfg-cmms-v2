'use strict';
/* PM Phase 3-A workspace. Backend is authoritative; this module never stores PM data locally. */
(function(root){
  const maintenance = root.BFGMaintenance;
  if (!maintenance) return;
  const pm = maintenance.pm || (maintenance.pm = {});
  Object.assign(pm, { includeArchived:false, selectedId:null, loading:false, error:null, busy:new Set(), details:null, occurrenceDetails:null, editorDirty:false, allowClose:false });
  const NA = 'N/A — داده کافی ثبت نشده است';
  const statusText = {
    scheduled:['برنامه‌ریزی‌شده','b-blue'], due:['سررسیدشده','b-orange'], overdue:['عقب‌افتاده','b-red'],
    work_order_generated:['دستورکار ایجاد شده','b-purple'], in_progress:['در حال اجرا','b-orange'],
    completed:['تکمیل‌شده','b-green'], cancelled:['لغوشده','b-gray'], skipped:['ردشده/انجام‌نشده','b-gray']
  };
  const activityTypes = {
    inspection:'بازرسی', service:'سرویس', lubrication:'روانکاری', adjustment:'تنظیم', replacement:'تعویض',
    'functional-test':'تست عملکرد', calibration:'کالیبراسیون', 'preventive-repair':'تعمیرات پیشگیرانه', 'condition-monitoring':'کنترل وضعیت'
  };
  const messages = {
    PM_TARGET_OUTSIDE_DOSSIER:'جزء انتخاب‌شده در ساختار فعال این تجهیز نیست.',
    PM_EQUIPMENT_HAS_HISTORY:'این برنامه سابقهٔ زمان‌بندی دارد و تجهیز آن قابل تغییر نیست.',
    PM_ACTIVITY_FIELDS_INVALID:'مشخصات فعالیت یا منابع واردشده معتبر نیست.',
    PM_CHECKLIST_INVALID:'عنوان، نوع اندازه‌گیری یا حدود چک‌لیست را بررسی کنید.',
    PM_RESCHEDULE_REASON_REQUIRED:'دلیل جابه‌جایی الزامی است.',
    PM_RESCHEDULE_WORK_ORDER_EXISTS:'برای این موعد دستورکار صادر شده یا نوبت نهایی شده است.',
    PM_NEXT_DUE_BEFORE_COMPLETION:'موعد بعدی باید پس از آخرین اجرا باشد.',
    NO_CAPABLE_PROVIDER:'سرویس تحلیل سلن برای بازبینی PM پیکربندی نشده است.',
    CLOUD_CONTEXT_NOT_APPROVED:'ارسال دادهٔ پرونده به این سرویس مجاز نیست.',
    AI_PROVIDER_DISABLED_BY_POLICY:'سرویس تحلیل در سیاست سلن غیرفعال است.',
    PM_REPORT_RANGE_INVALID:'بازهٔ گزارش را با تاریخ شمسی معتبر و حداکثر یک سال وارد کنید.',
    PM_REPORT_TOO_MANY_ROWS:'برای دریافت همهٔ نتایج، بازه یا فیلتر گزارش را محدود کنید.',
    PM_CODE_CONFLICT:'کد این برنامه برای تجهیز فعال دیگری ثبت شده است؛ تعارض را بررسی کنید.',
    VERSION_CONFLICT:'نسخهٔ رکورد تغییر کرده است؛ اطلاعات را تازه کنید و دوباره تلاش کنید.',
    PM_SCHEDULE_DATA_REQUIRED:'دادهٔ معتبر برای زمان‌بندی کافی نیست.',
    PM_EVALUATED_AT_REQUIRED:'زمان ارزیابی سررسید الزامی است.',
    PM_EVALUATED_AT_INVALID:'زمان ارزیابی سررسید معتبر نیست.',
    PM_PERIOD_KEY_INVALID:'دورهٔ انتخاب‌شده معتبر نیست.',
    PM_PERIOD_KEY_MISMATCH:'دوره با موعد ثبت‌شده در سرور هم‌خوانی ندارد.',
    PM_OCCURRENCE_FINAL:'وضعیت نهایی Occurrence قابل تغییر نیست.',
    PM_OCCURRENCE_NOT_GENERATABLE:'برای وضعیت فعلی امکان تولید Work Order وجود ندارد.',
    RECORD_NOT_FOUND:'رکورد در سرور پیدا نشد.',
    PERMISSION_DENIED:'مجوز لازم برای این عملیات را ندارید.',
    PM_OCCURRENCE_CONFLICT:'Occurrence این دوره قبلاً ثبت شده است؛ اطلاعات از سرور دوباره دریافت شد.'
  };
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  function apiBase(){
    const config = root.BFGRuntime?.state?.config || root.BFGBackend?.config || {};
    return String(config.apiBasePath || '/api').replace(/\/$/,'');
  }
  function call(path, options){ if(typeof root.bfgApi!=='function')throw new Error('BACKEND_SESSION_REQUIRED');return root.bfgApi(apiBase()+path,options); }
  const PERMISSIONS={view:'pm.view',create:'pm.create',edit:'pm.edit',schedule:'pm.schedule',generate:'pm.generate',archive:'pm.archive',restore:'pm.restore'};
  function hasPermission(name){if(typeof root.can!=='function'||!PERMISSIONS[name])return false;const [module,operation]=PERMISSIONS[name].split('.');return root.can(module,operation);}
  function allowed(permission){
    if(permission==='view'||permission==='create'||permission==='edit'||permission==='archive')return hasPermission(permission);
    if(permission==='schedule')return hasPermission('schedule')||hasPermission('create');
    if(permission==='generate')return hasPermission('generate')||(typeof root.can==='function'&&root.can('wos','create'));
    if(permission==='restore')return hasPermission('restore')||hasPermission('archive');
    return false;
  }
  const frequencies={daily:'روزانه',weekly:'هفتگی',monthly:'ماهانه',quarterly:'فصلی',semiannual:'شش‌ماهه',annual:'سالانه',custom:'سفارشی'};
  const persianDate=new Intl.DateTimeFormat('en-u-ca-persian-nu-latn',{timeZone:'UTC',year:'numeric',month:'numeric',day:'numeric'});
  function parseJalali(value){
    const raw=String(value||'').trim().replace(/[۰-۹٠-٩]/g,digit=>String(digit.charCodeAt(0)%16));
    const match=raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if(!match)return null;
    const iso=root.jStr2iso?.(raw);
    const time=Date.parse(iso+'T00:00:00Z');
    if(!Number.isFinite(time))return null;
    const parts=Object.fromEntries(persianDate.formatToParts(time).map(item=>[item.type,Number(item.value)]));
    return parts.year===Number(match[1])&&parts.month===Number(match[2])&&parts.day===Number(match[3])?iso:null;
  }
  function date(value){
    if(!value || !Number.isFinite(Date.parse(value)))return NA;
    if(typeof root.jDate==='function')return root.jDate(value);
    return new Date(value).toISOString().slice(0,10);
  }
  function badge(status){const item=statusText[status];return item?`<span class="badge ${item[1]}">${item[0]}</span>`:'<span class="badge b-gray">—</span>';}
  function dueStatus(status,reason){
    if(!status || status==='insufficient_data')return `<span class="badge b-gray">${NA}</span>${reason?`<div class="muted">علت: ${esc(reason)}</div>`:''}`;
    return badge(status);
  }
  function isArchived(plan){return !!(plan&&(plan.archivedAt||plan.deletedAt));}
  function showError(error){
    const code=error&&(error.payload?.error||error.message),status=Number(error&&error.status);
    const text=messages[code]||(status===401?'نشست معتبر نیست؛ دوباره وارد شوید.':status===403?'مجوز مشاهده یا انجام این عملیات را ندارید.':status===404?'رکورد در سرور پیدا نشد.':status===409?'تعارض نسخه یا وضعیت رخ داده است؛ داده را تازه کنید.':status===422?'اطلاعات یا تاریخ واردشده معتبر نیست؛ فیلدها را بررسی کنید.':'ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.');
    if(typeof root.toast==='function')root.toast(text,1);
    return text;
  }
  function archivedQuery(){return pm.includeArchived?'?includeArchived=true':'';}
  const asList=value=>Array.isArray(value)?value:[];
  const canReadInventory=()=>typeof root.can==='function'&&root.can('inventory','view');
  async function loadDetails(planId){
    const id=encodeURIComponent(planId), query=archivedQuery();
    const planResponse=await call('/pm-plans/'+id+query);
    const plan=planResponse?.data;
    if(!plan)throw Object.assign(new Error('RECORD_NOT_FOUND'),{status:404,payload:{error:'RECORD_NOT_FOUND'}});
    const duePromise=allowed('schedule')
      ?call('/pm-plans/'+id+'/due?evaluatedAt='+encodeURIComponent(new Date().toISOString())+(pm.includeArchived?'&includeArchived=true':''))
      :Promise.resolve({data:{nextDueAt:plan.nextDueAt||null,dueStatus:plan.dueStatus||'insufficient_data',reason:plan.dueReason||null}});
    const [dueResponse,occurrenceResponse]=await Promise.all([duePromise,call('/pm-plans/'+id+'/occurrences'+query)]);
    return {plan,due:dueResponse?.data||{},occurrences:asList(occurrenceResponse?.data)};
  }
  function field(label,value){return `<div><b>${esc(label)}</b><span>${value==null||value===''?'ثبت نشده':esc(value)}</span></div>`;}
  function htmlField(label,value){return `<div><b>${esc(label)}</b><span>${value==null||value===''?'ثبت نشده':value}</span></div>`;}
  function readiness(details){
    if(!asList(details.plan.requiredParts).some(part=>part?.itemId)||!canReadInventory()||isArchived(details.plan))return '';
    return `<section class="pm-due-panel"><h4>آمادگی قطعات انبار</h4><button type="button" class="btn btn-sm btn-ghost" data-plan="${esc(details.plan.id)}" onclick="BFGMaintenance.pmUi.loadReadiness(this)">بررسی موجودی آزاد</button><div role="status"></div></section>`;
  }
  async function loadReadiness(button){
    const output=button.parentElement.querySelector('[role="status"]');
    button.disabled=true;
    try{
      const response=await call('/pm-plans/'+encodeURIComponent(button.dataset.plan)+'/parts-readiness');
      output.innerHTML=asList(response.data).map(part=>`<p>${esc(part.name||part.code||part.itemId)} · نیاز ${esc(part.qty)} · موجودی آزاد ${esc(part.available??'نامشخص')}${part.shortage>0?` · <b>کسری ${esc(part.shortage)}</b>`:''}</p>`).join('');
    }catch(error){output.textContent=errorText(error);}
    finally{button.disabled=false;}
  }
  function readOnlyTechnical(plan){
    return [
      ['کد',plan.code],['بخش مرتبط',plan.targetName||plan.targetNodeId||plan.equipment?.name],['نوع فعالیت',activityTypes[plan.activityType]],['گروه فعالیت',plan.activityGroup],
      ['توقف تولید',plan.productionStopRequired==null?null:plan.productionStopRequired?'الزامی':'الزامی نیست'],['وضعیت Plan',plan.status],['مبنای زمان‌بندی',plan.scheduleBasis],['تناوب',plan.calendarFrequency&&plan.calendarFrequency!=='custom'?frequencies[plan.calendarFrequency]:`${plan.intervalDays??plan.interval??'—'} روز`],['اولین موعد',plan.firstDueAt?date(plan.firstDueAt):null],
      ['موعد بعدی',plan.nextDueAt?date(plan.nextDueAt):null],['Tolerance (روز)',plan.toleranceDays],
      ['مدت برآوردی (دقیقه)',plan.estimatedDurationMinutes],['تخصص موردنیاز',plan.requiredSkill],
      ['تعداد نیروی موردنیاز',plan.requiredPersonnel],['ابزار موردنیاز',asList(plan.requiredTools).join('، ')],
      ['قطعات موردنیاز',asList(plan.requiredParts).map(item=>typeof item==='string'?item:(item.name||item.code||'')).filter(Boolean).join('، ')],
      ['الزامات ایمنی',asList(plan.safetyRequirements).join('، ')],
      ['LOTO',plan.lotoRequired===true?'الزامی':plan.lotoRequired===false?'الزامی نیست':null],
      ['PTW',plan.ptwRequired===true?'الزامی':plan.ptwRequired===false?'الزامی نیست':null],['دستورالعمل',plan.instructions]
    ].map(([label,value])=>field(label,value)).join('');
  }
  function aiReviewPanel(plan){
    if(!plan.assetId||!root.can?.('ai','use'))return '';
    return `<details class="pm-due-panel"><summary>بازبینی برنامه با سلن</summary>
      <label class="pm-form-field">پرسش تکمیلی<textarea data-pm-ai-question rows="2" maxlength="2500"></textarea></label>
      <button type="button" class="btn btn-ghost" onclick="BFGMaintenance.pmUi.askSelene(this)">دریافت پیشنهاد</button>
      <div data-pm-ai-results role="status"></div></details>`;
  }
  async function askSelene(button){
    const plan=pm.details?.plan;
    if(!plan?.assetId)return;
    const host=button.parentElement;
    const output=host.querySelector('[data-pm-ai-results]');
    const extra=host.querySelector('[data-pm-ai-question]').value.trim();
    output.textContent='در حال بازبینی سوابق و برنامه…';button.disabled=true;
    try{
      const question=[
        `برنامهٔ نگهداری «${plan.title}» (شناسه ${plan.id}) را در پروندهٔ تجهیز بررسی کن. بخش هدف: ${plan.targetName||'خود تجهیز'}.`,
        'با استناد به دادهٔ پرونده، پیشنهاد تناوب و چک‌لیست، موارد ناقص و ارتباط با خرابی‌های تکراری را به فارسی توضیح بده.',
        'مدت، مقدار و اقدام نامعلوم را به عنوان فرض یا نیاز به بررسی مشخص کن. هیچ رکوردی را تغییر نده.',
        extra
      ].filter(Boolean).join('\n');
      const result=(await call('/ai/analyze',{method:'POST', body:JSON.stringify({equipmentId:plan.assetId,purpose:'pm_review',question})})).data;
      output.innerHTML=`<p>${esc(result.summary||'')}</p>${asList(result.recommendations).map(rec=>`<article class="pm-checkpoint"><b>${esc(rec.recommendation)}</b><p>${esc(rec.reason)}</p>
        <small>پیشنهاد در انتظار بازبینی</small>
        ${root.can?.('ai','review')?`<div class="pm-toolbar">${[['approved','تأیید پیشنهاد'],['rejected','رد پیشنهاد']].map(([key,label])=>`<button type="button" class="btn btn-sm btn-ghost" data-recommendation="${esc(rec.id)}" data-version="${esc(rec.row_version)}" data-action="${key}" onclick="BFGMaintenance.pmUi.reviewAdvice(this)">${label}</button>`).join('')}</div>`:''}</article>`).join('')}`;
    }catch(error){output.textContent=errorText(error);}
    finally{button.disabled=false;}
  }
  async function reviewAdvice(button){
    if(!root.confirm('تصمیم بازبینی این پیشنهاد ثبت شود؟'))return;
    const group=button.parentElement;
    const actions=Array.from(group.querySelectorAll('button'));actions.forEach(item=>item.disabled=true);
    try{
      await call('/ai/recommendations/'+encodeURIComponent(button.dataset.recommendation)+'/review',{method:'PATCH',
        body:JSON.stringify({action:button.dataset.action,rowVersion:Number(button.dataset.version)})});
      group.previousElementSibling.textContent=button.dataset.action==='approved'?'پیشنهاد تأیید شد':'پیشنهاد رد شد';
      group.remove();
    }catch(error){actions.forEach(item=>item.disabled=false);showError(error);}
  }
  function occurrenceCard(item){
    const wo=item.workOrderId&&(maintenance.getCollection?.('wos')||[]).find(row=>row.id===item.workOrderId);
    const workOrder=item.workOrderId?(wo?`<button type="button" class="pm-link" onclick="openWO('${esc(wo.id)}')">${esc(wo.no||wo.id)}</button>`:`<span class="mono">${esc(item.workOrderId)}</span>`):'—';
    return `<article class="pm-occurrence-card"><header><b class="mono">${esc(item.periodKey||'—')}</b>${badge(item.status)}</header>
      <div class="pm-occurrence-grid">${field('موعد',item.dueAt?date(item.dueAt):null)}${htmlField('دستورکار مرتبط',workOrder)}
        ${field('ایجاد دستورکار',item.generatedAt?date(item.generatedAt):null)}${field('شروع',item.startedAt?date(item.startedAt):null)}
        ${field('تکمیل',item.completedAt?date(item.completedAt):null)}${field('لغو',item.cancelledAt?date(item.cancelledAt):null)}
        ${field('دلیل لغو',item.cancellationReason)}${field('منشأ تکمیل',item.completionSource)}
        ${field('منشأ داده',item.provenanceStatus)}${field('مقدار متر',item.dueMeterValue)}${field('ایجاد',item.createdAt?date(item.createdAt):null)}${field('rowVersion',item.rowVersion)}</div>
      <button type="button" class="btn btn-sm btn-ghost" onclick="BFGMaintenance.pmUi.openOccurrence('${esc(item.pmPlanId)}','${esc(item.id)}')">جزئیات کامل</button>
    </article>`;
  }
  function renderDetails(details){
    const plan=details.plan,due=details.due||{},archived=isArchived(plan),list=details.occurrences||[];
    const dueState=due.dueStatus||plan.dueStatus;
    const active=plan.status!=='cancelled'&&!archived;
    const canSchedule=active&&allowed('schedule')&&!!due.nextDueAt&&!list.some(item=>item.periodKey&&item.periodKey===plan.periodKey);
    const canGenerate=active&&allowed('generate')&&['scheduled','due','overdue'].includes(dueState);
    const busy=pm.busy.has(String(plan.id));
    let actions='';
    if(archived){if(allowed('restore'))actions=`<button type="button" class="btn btn-sm btn-ghost" ${busy?'disabled':''} onclick="BFGMaintenance.pmUi.action('restore','${esc(plan.id)}',this)">↶ بازیابی</button>`;}
    else if(active)actions=`${allowed('schedule')&&plan.scheduleBasis==='calendar'?`<button type="button" class="btn btn-sm btn-ghost" onclick="BFGMaintenance.pmUi.reschedule()">جابه‌جایی موعد</button>`:''}${canSchedule?`<button type="button" class="btn btn-sm btn-accent" ${busy?'disabled':''} onclick="BFGMaintenance.pmUi.action('schedule','${esc(plan.id)}',this)">＋ زمان‌بندی Occurrence</button>`:''}
      ${canGenerate?`<button type="button" class="btn btn-sm btn-primary" ${busy?'disabled':''} onclick="BFGMaintenance.pmUi.action('generate','${esc(plan.id)}',this)">⚙ صدور Work Order</button>`:''}
      ${allowed('archive')?`<button type="button" class="btn btn-sm btn-ghost pm-archive-button" ${busy?'disabled':''} title="بایگانی برنامه" aria-label="بایگانی برنامه" onclick="BFGMaintenance.pmUi.action('archive','${esc(plan.id)}',this)">▣ بایگانی</button>`:''}
      ${allowed('edit')?`<button type="button" class="btn btn-sm btn-ghost" onclick="BFGMaintenance.pmUi.edit('${esc(plan.id)}')">✎ ویرایش</button>`:''}`;
    const occurrence=pm.occurrenceDetails;
    const occurrences=occurrence?`<button type="button" class="btn btn-sm btn-ghost" onclick="BFGMaintenance.pmUi.closeOccurrence()">بازگشت به فهرست</button>${occurrenceCard(occurrence)}`:list.length?list.map(occurrenceCard).join(''):'<div class="empty">Occurrenceای از Backend دریافت نشد.</div>';
    return `${root.mhead(esc(plan.title||'برنامه PM'))}<div class="m-body pm-detail" dir="rtl">
      <div class="pm-detail-grid">${readOnlyTechnical(plan)}</div>
      <section class="pm-due-panel"><h4>موعد از Backend</h4><div>${due.nextDueAt?date(due.nextDueAt):NA}</div>${dueStatus(dueState,due.reason||plan.dueReason)}
        <small>مبنای زمان‌بندی: ${esc(plan.scheduleBasis||'ثبت نشده')} — Tolerance: ${esc(plan.toleranceDays??'ثبت نشده')}</small></section>
      <div class="pm-toolbar">${actions}<span class="muted">rowVersion: ${esc(plan.rowVersion??'—')}</span></div>
      ${readiness(details)}
      ${aiReviewPanel(plan)}
      <h4>نوبت‌های ثبت‌شده</h4>${occurrences}<p class="muted">Due فقط خواندنی است؛ ثبت Occurrence با اقدام صریح انجام می‌شود.</p>
    </div><div class="m-foot"><button type="button" class="btn btn-ghost" onclick="closeModal()">بستن</button></div>`;
  }
  const reportLabels={planned:'نوبت ثبت‌شده',due:'سررسیدشده',completed:'تکمیل‌شده',overdue:'عقب‌افتاده',
    compliance:'درصد تحقق',onTimeRate:'درصد انجام به‌موقع',plannedMinutes:'زمان برنامه‌ریزی‌شده (ساعت)',elapsedMinutes:'زمان سپری‌شده (ساعت)'};
  function reportValue(key,value){
    if(value==null)return NA;
    if(['compliance','onTimeRate'].includes(key))return new Intl.NumberFormat('fa-IR',{style:'percent',maximumFractionDigits:1}).format(value);
    if(key.endsWith('Minutes'))value/=60;
    return new Intl.NumberFormat('fa-IR',{maximumFractionDigits:1}).format(value);
  }
  function reportPanel(){
    const state=pm.report||{}, filters=state.filters||{};
    const options=(items,selected)=>items.map(([id,label])=>`<option value="${esc(id)}" ${id===selected?'selected':''}>${esc(label)}</option>`).join('');
    const people=asList(maintenance.getCollection?.('users')).map(person=>[person.id,person.name]);
    return `<details class="card pm-schedule" ${state.open?'open':''}><summary>تقویم و گزارش اجرای PM</summary>
      <form class="pm-form-grid" onsubmit="event.preventDefault();BFGMaintenance.pmUi.loadReport(this)">
        <label class="pm-form-field">بازه<select name="period">${options(Object.entries({day:'روز',week:'هفته',month:'ماه',quarter:'فصل',year:'سال',custom:'سفارشی'}),filters.period||'month')}</select></label>
        <label class="pm-form-field">تاریخ مرجع / شروع شمسی<input name="from" value="${esc(filters.from||'')}" placeholder="امروز"></label>
        <label class="pm-form-field">پایان شمسی در بازهٔ سفارشی<input name="to" value="${esc(filters.to||'')}" placeholder="آخرین روز بازه"></label>
        <label class="pm-form-field">تجهیز<select name="assetId"><option value="">همه</option>${options(availableAssets().map(asset=>[asset.id,asset.name]),filters.assetId)}</select></label>
        <label class="pm-form-field">تکنسین<select name="owner"><option value="">همه</option>${options(people,filters.owner)}</select></label>
        <label class="pm-form-field">نوع فعالیت<select name="activityType"><option value="">همه</option>${options(Object.entries(activityTypes),filters.activityType)}</select></label>
        <label class="pm-form-field">شناسهٔ کارخانه<input name="factoryId" value="${esc(filters.factoryId)}"></label>
        <label class="pm-form-field">شناسهٔ سالن<input name="hallId" value="${esc(filters.hallId)}"></label>
        <label class="pm-form-field">نمایش<select name="view">${options([['calendar','تقویم / کارت روزانه'],['table','جدول']],filters.view||'calendar')}</select></label>
        <button class="btn btn-primary" type="submit">دریافت گزارش</button>
      </form>
      <div data-pm-report-results>${renderReport(state.data)}</div></details>`;
  }
  const PM_REPORT_OPEN=new Set(['scheduled','due','overdue']);
  const consumedText=item=>asList(item.consumedParts).map(part=>[part.name,part.qty,part.unit].filter(value=>value!=null).join(' ')).join('، ');
  function renderReport(data){
    if(!data)return '';
    const entries=data.items||[], days=new Map();
    for(const item of entries){
      const key=item.dueAt.slice(0,10);
      if(!days.has(key))days.set(key,[]);
      days.get(key).push(item);
    }
    const summary=Object.entries(reportLabels).map(([key,label])=>field(label,reportValue(key,data.summary[key]))).join('');
    const shared=asList(data.sharedAssignments);
    const note=shared.length?`<section class="pm-due-panel"><h4>تخصیص‌های هم‌روز در این گزارش</h4>
      <ul>${shared.map(group=>`<li>${esc(group.ownerName||'تکنسین')} · ${date(group.dueAt)} · ${reportValue('planned',group.count)} نوبت</li>`).join('')}</ul></section>`:'';
    const occurrenceBadge=item=>{
      if(PM_REPORT_OPEN.has(item.status)){
        const evaluated=Date.parse(data.evaluatedAt);
        if(evaluated>Date.parse(item.deadline))return badge('overdue');
        if(evaluated>=Date.parse(item.dueAt))return badge('due');
        return badge('scheduled');
      }
      return badge(item.status);
    };
    const itemButton=item=>`<button type="button" class="pm-link" data-pm-report-plan="${esc(item.planId)}" onclick="openPM(this.dataset.pmReportPlan)">${esc(item.title)}</button>`;
    const table=`<div class="tbl-wrap"><table class="pm-table"><thead><tr><th>موعد</th><th>فعالیت</th><th>تجهیز / جزء</th><th>تکنسین</th><th>وضعیت</th>${data.showCosts?'<th>هزینهٔ خالص ثبت‌شده</th>':''}${data.showParts?'<th>مصرف خالص قطعات</th>':''}</tr></thead><tbody>
      ${entries.map(item=>`<tr><td>${date(item.dueAt)}</td><td>${itemButton(item)}</td><td>${esc([item.equipmentName,item.targetName].filter(Boolean).join(' / '))}</td><td>${esc(item.ownerName||'—')}</td><td>${occurrenceBadge(item)}</td>${data.showCosts?`<td>${esc(reportValue('actualCost',item.actualCost))}</td>`:''}${data.showParts?`<td>${esc(consumedText(item)||'—')}</td>`:''}</tr>`).join('')}</tbody></table></div>`;
    const calendar=[...days].map(([day,items])=>`<section class="pm-occurrence-card"><h4>${date(day+'T00:00:00Z')}</h4>${items.map(item=>`<div class="pm-toolbar">${itemButton(item)}<span>${esc(item.equipmentName)}</span>${occurrenceBadge(item)}</div>`).join('')}</section>`).join('');
    return `<section class="pm-report-output" dir="rtl"><h3>گزارش نوبت‌های PM</h3><p>${date(data.from)} تا ${date(new Date(Date.parse(data.to)-1).toISOString())}</p>
      <div class="pm-detail-grid">${summary}</div><small>تحقق بر اساس نوبت‌های سررسیدشده و انجام به‌موقع بر اساس تاریخ تکمیل و مهلت مجاز محاسبه شده است.</small>
      ${note}
      ${entries.length?`<div class="pm-toolbar pm-report-actions"><button type="button" class="btn btn-ghost" onclick="BFGMaintenance.pmUi.exportReport()">خروجی CSV برای Excel</button><button type="button" class="btn btn-ghost" onclick="window.print()">چاپ / PDF</button></div>
      ${pm.report?.filters?.view==='table'?table:`<div class="pm-calendar">${calendar}</div>`}`:'<p>در این بازه نوبتی ثبت نشده است.</p>'}</section>`;
  }
  function reportRange(filters){
    const day=86400000;
    const invalid=()=>Object.assign(new Error('PM_REPORT_RANGE_INVALID'),{status:422});
    const parse=value=>{
      const iso=parseJalali(value);
      if(!iso)throw invalid();
      return Date.parse(iso+'T00:00:00Z');
    };
    const reference=filters.from?parse(filters.from):Math.floor(Date.now()/day)*day;
    let from=reference, to=reference+day;
    if(filters.period==='custom'){
      if(!filters.from||!filters.to)throw invalid();
      to=parse(filters.to)+day;
    }else if(filters.period==='week'){
      from=reference-((new Date(reference).getUTCDay()+1)%7)*day;
      to=from+7*day;
    }else if(['month','quarter','year'].includes(filters.period)){
      const parts=new Intl.DateTimeFormat('en-u-ca-persian-nu-latn',{timeZone:'UTC',year:'numeric',month:'numeric'}).formatToParts(reference);
      const year=Number(parts.find(part=>part.type==='year').value);
      const month=Number(parts.find(part=>part.type==='month').value);
      const span={month:1,quarter:3,year:12}[filters.period];
      const first=Math.floor((month-1)/span)*span;
      const boundary=offset=>parse(`${year+Math.floor(offset/12)}/${String(offset%12+1).padStart(2,'0')}/01`);
      from=boundary(first);to=boundary(first+span);
    }
    if(to<=from)throw invalid();
    return {from:new Date(from).toISOString(),to:new Date(to).toISOString()};
  }
  async function loadReport(form){
    const output=form.parentElement.querySelector('[data-pm-report-results]');
    const button=form.querySelector('button[type="submit"]');
    const filters=Object.fromEntries(new FormData(form));
    button.disabled=true;
    output.textContent='در حال دریافت گزارش…';
    try{
      const params=new URLSearchParams(reportRange(filters));
      for(const key of ['assetId','owner','activityType','factoryId','hallId'])if(filters[key]?.trim())params.set(key,filters[key].trim());
      const response=await call('/pm-schedule?'+params);
      pm.report={open:true,filters,data:response.data};
      output.innerHTML=renderReport(response.data);
    }catch(error){output.textContent=errorText(error);}
    finally{button.disabled=false;}
  }
  function exportReport(){
    const items=pm.report?.data?.items;
    if(!items?.length)return;
    const escapeCell=value=>{
      let text=String(value??'');
      if(/^[\s]*[=+\-@\t\r]/.test(text))text="'"+text;
      return '"'+text.replace(/"/g,'""')+'"';
    };
    const {showCosts,showParts}=pm.report.data;
    const rows=[['موعد','فعالیت','تجهیز','جزء','تکنسین','کارخانه','سالن','وضعیت','تکمیل','دقایق برنامه','دقایق سپری‌شده',
      ...(showCosts?['هزینهٔ ثبت‌شده']:[]),...(showParts?['قطعات مصرفی']:[])],
      ...items.map(item=>[date(item.dueAt),item.title,item.equipmentName,item.targetName,item.ownerName,item.factoryId,item.hallName,statusText[item.status]?.[0],
        item.completedAt?date(item.completedAt):'',item.plannedMinutes,item.elapsedMinutes,
        ...(showCosts?[item.actualCost]:[]),...(showParts?[consumedText(item)]:[])])];
    const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(row=>row.map(escapeCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='PM-schedule.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function reschedule(plan){
    if(!plan||!allowed('schedule'))return;
    const entered=root.prompt('موعد جدید را به شمسی وارد کنید (مثال ۱۴۰۵/۱۰/۱۵).');
    if(!entered)return;
    const nextDueAt=parseJalali(entered);
    if(!nextDueAt){showError({status:422,payload:{error:'PM_NEXT_DUE_AT_INVALID'}});return;}
    const reason=root.prompt('دلیل جابه‌جایی را ثبت کنید.');
    if(!reason?.trim())return;
    try{
      await call('/pm-plans/'+encodeURIComponent(plan.id)+'/reschedule',{method:'POST',body:JSON.stringify({rowVersion:plan.rowVersion,nextDueAt,reason})});
      await maintenance.sync({quiet:true});
      pm.report=null;
      if(typeof root.go==='function')root.go('pm');
      await openPlanFromData(plan.id);
    }catch(error){showError(error);}
  }
  function renderPage(){
    if(!allowed('view'))return `${root.head('نگهداری پیشگیرانه (PM)','PM')}<div class="card empty">مجوز مشاهدهٔ PM برای این حساب فعال نیست.</div>`;
    if(!pm.loaded)return `${root.head('نگهداری پیشگیرانه (PM)','PM')}<div class="card empty" role="status">${pm.loading?'در حال دریافت دادهٔ PM از Backend…':'دادهٔ PM از Backend بارگذاری نشده است.'}${pm.error?`<p>${esc(errorText(pm.error))}</p><button type="button" class="btn btn-sm btn-ghost" onclick="BFGMaintenance.pmUi.retry()">تلاش دوباره</button>`:''}</div>`;
    const plans=asList(maintenance.getCollection?.('pms')).filter(plan=>pm.includeArchived?isArchived(plan):!isArchived(plan));
    const create=allowed('create')?'<button type="button" class="btn btn-primary" onclick="openPMForm()">＋ برنامه PM جدید</button>':'';
    const archiveToggle=allowed('restore')?`<button type="button" class="btn btn-ghost" aria-pressed="${pm.includeArchived}" onclick="BFGMaintenance.pmUi.toggleArchived()">${pm.includeArchived?'نمایش برنامه‌های فعال':'نمایش برنامه‌های آرشیوشده'}</button>`:'';
    const compliance=`<div class="card kpi pm-na-card"><div class="k-title">PM Compliance</div><div class="k-val">${NA}</div><div class="k-sub">دادهٔ کافی و معتبر برای محاسبهٔ این شاخص از Backend ارائه نشده است.</div></div>`;
    const error=pm.error?`<div class="card pm-error" role="alert">${esc(errorText(pm.error))}<button type="button" class="btn btn-sm btn-ghost" onclick="BFGMaintenance.pmUi.retry()">تلاش دوباره</button></div>`:'';
    const rows=plans.map(plan=>{
      const equipment=(maintenance.getCollection?.('assets')||[]).find(row=>row.id===plan.assetId);
      const busy=pm.busy.has(String(plan.id));
      const due=plan.nextDueAt&&plan.dueStatus!=='insufficient_data'?date(plan.nextDueAt):NA;
      return `<tr tabindex="0" class="pm-plan-row" onclick="openPM('${esc(plan.id)}')" onkeydown="if(event.key==='Enter'){event.preventDefault();openPM('${esc(plan.id)}')}">
        <td><b>${esc(plan.code||'—')}</b><div>${esc(plan.title||'')}</div></td><td>${esc(equipment?.name||plan.equipment?.name||'—')}</td>
        <td>${esc(plan.scheduleBasis||'ثبت نشده')}</td><td>${due}</td><td>${dueStatus(plan.dueStatus,plan.dueReason)}</td><td>${esc(plan.toleranceDays??'—')}</td>
        <td><button type="button" class="btn btn-sm btn-ghost" aria-label="جزئیات" onclick="event.stopPropagation();openPM('${esc(plan.id)}')">↗</button>
          ${!isArchived(plan)&&plan.status!=='cancelled'&&allowed('generate')&&['scheduled','due','overdue'].includes(plan.dueStatus)?`<button type="button" class="btn btn-sm btn-primary" onclick="event.stopPropagation();BFGMaintenance.pmUi.action('generate','${esc(plan.id)}',this)" ${busy?'disabled':''}>⚙</button>`:''}
          ${isArchived(plan)&&allowed('restore')?`<button type="button" class="btn btn-sm btn-ghost" ${busy?'disabled':''} onclick="event.stopPropagation();BFGMaintenance.pmUi.action('restore','${esc(plan.id)}',this)">↶</button>`:''}</td>
      </tr>`;
    }).join('');
    return `${root.head('نگهداری پیشگیرانه (PM)','PM',create+archiveToggle)}${pm.report?.data?'':compliance}${error}${reportPanel()}
      ${pm.loading?'<div class="card empty" role="status">در حال دریافت برنامه‌ها از Backend…</div>':''}
      ${!pm.loading&&!error&&!plans.length?'<div class="card empty">برنامه‌ای از Backend برای نمایش دریافت نشد.</div>':''}
      <div class="tbl-wrap"><table class="pm-table"><thead><tr><th>کد / برنامه</th><th>تجهیز</th><th>مبنای زمان‌بندی</th><th>موعد بعدی</th><th>وضعیت Due</th><th>Tolerance</th><th>عملیات</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted">موعد و وضعیت از Backend دریافت می‌شوند؛ مرورگر Due را محاسبه نمی‌کند.</p>`;
  }
  function errorText(error){
    const code=error&&(error.payload?.error||error.message),status=Number(error&&error.status);
    return messages[code]||(status===401?'نشست معتبر نیست؛ دوباره وارد شوید.':status===403?'مجوز این داده یا عملیات را ندارید.':status===404?'رکورد در سرور پیدا نشد.':status===409?'تعارض نسخه/وضعیت رخ داده است؛ داده را تازه کنید.':status===422?'تاریخ یا اطلاعات واردشده معتبر نیست.':'ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.');
  }
  async function openPlan(id){
    pm.selectedId=String(id);pm.occurrenceDetails=null;
    root.modal(root.mhead('برنامه PM')+'<div class="m-body"><div class="empty" role="status">در حال دریافت اطلاعات از Backend…</div></div>');
    try{pm.details=await loadDetails(id);root.modal(renderDetails(pm.details));}
    catch(error){pm.error=error;showError(error);root.modal(root.mhead('برنامه PM')+`<div class="m-body"><div class="card pm-error" role="alert">${esc(errorText(error))}</div><button class="btn btn-ghost" onclick="openPM('${esc(id)}')">تلاش دوباره</button></div><div class="m-foot"><button class="btn btn-ghost" onclick="closeModal()">بستن</button></div>`);}
  }
  async function openOccurrence(planId,id){
    try{const response=await call('/pm-plans/'+encodeURIComponent(planId)+'/occurrences/'+encodeURIComponent(id)+(pm.includeArchived?'?includeArchived=true':''));pm.occurrenceDetails=response?.data||null;if(pm.details)root.modal(renderDetails(pm.details));}
    catch(error){showError(error);}
  }
  const PM_ASSET_NOT_FOUND='تجهیز پرونده در فهرست مجاز تجهیزات پیدا نشد؛ لطفاً تجهیز را دستی انتخاب کنید.';
  const PM_ASSET_AMBIGUOUS='شناسه یا کد تجهیز در فهرست مجاز یکتا نیست؛ لطفاً تجهیز را دستی انتخاب کنید.';
  function availableAssets(){
    return asList(maintenance.getCollection?.('assets')).filter(asset=>asset&&asset.id!=null&&String(asset.id)!==''&&asset.type==='eq'&&!asset.deleted);
  }
  function normalizeAssetReference(value){
    if(value==null||String(value)==='')return {assetId:'',message:''};
    const reference=String(value),assets=availableAssets();
    const idMatches=assets.filter(asset=>asset.id!=null&&String(asset.id)===reference);
    if(idMatches.length===1)return {assetId:idMatches[0].id,message:''};
    if(idMatches.length>1)return {assetId:'',message:PM_ASSET_AMBIGUOUS};
    const codeMatches=assets.filter(asset=>asset.code!=null&&String(asset.code)===reference);
    if(codeMatches.length===1)return {assetId:codeMatches[0].id,message:''};
    return {assetId:'',message:codeMatches.length>1?PM_ASSET_AMBIGUOUS:PM_ASSET_NOT_FOUND};
  }
  function checklistRow(item={}){
    return `<fieldset class="pm-checkpoint" data-pm-checkpoint><legend>آیتم چک‌لیست</legend>
      <div class="pm-form-grid">
        <label class="pm-form-field">عنوان کنترل<input data-check="title" required value="${esc(item.title||item.text||item.item||'')}"></label>
        <label class="pm-form-field">نوع کنترل<select data-check="measurementType"><option value="observation">بازدید</option><option value="number" ${item.measurementType==='number'?'selected':''}>اندازه‌گیری عددی</option></select></label>
        <label class="pm-form-field">واحد<input data-check="unit" value="${esc(item.unit)}"></label>
        ${[['standard','مقدار استاندارد'],['min','حداقل'],['max','حداکثر']].map(([key,label])=>`<label class="pm-form-field">${label}<input type="number" step="any" data-check="${key}" value="${esc(item[key])}"></label>`).join('')}
      </div>
      <label class="pm-form-field">شرح کنترل<input data-check="description" value="${esc(item.description)}"></label>
      <label><input type="checkbox" data-check="photoRequired" ${item.photoRequired?'checked':''}> عکس الزامی</label>
      <button type="button" class="btn btn-sm btn-ghost" onclick="this.closest('[data-pm-editor]').dataset.pmDirty='true';this.closest('fieldset').remove()">حذف آیتم</button>
    </fieldset>`;
  }
  function addCheckpoint(){
    const form=document.querySelector('[data-pm-editor]');
    if(!form)return;
    form.querySelector('[data-pm-checkpoints]').insertAdjacentHTML('beforeend',checklistRow());
    form.dataset.pmDirty='true';
  }
  async function loadTargets(form,selected=''){
    const asset=form.querySelector('[data-pm-field="assetId"]').value;
    const target=form.querySelector('[data-pm-field="targetNodeId"]');
    const note=form.querySelector('[data-pm-target-note]');
    target.innerHTML='<option value="">خود تجهیز</option>';
    if(selected){const option=new Option('جزء ثبت‌شده',selected,true,true);target.add(option);}
    if(!asset){target.disabled=false;note.textContent='';return;}
    target.disabled=true;note.textContent='در حال دریافت ساختار تجهیز…';
    try{
      const response=await call('/equipment/'+encodeURIComponent(asset)+'/structure?depth=3');
      if(!form.isConnected||asset!==form.querySelector('[data-pm-field="assetId"]').value)return;
      const add=(nodes,depth)=>asList(nodes).forEach(node=>{
        if(node.validRelation===false||node.archived)return;
        if(node.id===selected)target.querySelector('option:checked')?.remove();
        target.add(new Option('ـ '.repeat(depth)+(node.code?node.code+' — ':'')+node.name,node.id,false,node.id===selected));
        add(node.children,depth+1);
      });
      add(response.data.nodes,0);
      note.textContent='';
    }catch(error){
      if(!form.isConnected||asset!==form.querySelector('[data-pm-field="assetId"]').value)return;
      note.textContent='ساختار تجهیز در دسترس نیست. برای انتخاب جزء، ساختار یا مجوز مشاهده را بررسی کنید.';
    }finally{
      if(asset===form.querySelector('[data-pm-field="assetId"]').value)target.disabled=false;
    }
  }
  function partRow(part){
    return `<div class="pm-toolbar" data-pm-part="${esc(part.itemId)}"><b>${esc(part.code||'')} ${esc(part.name||part.itemId)}</b>
      <label>تعداد <input type="number" min="0.001" step="0.001" required value="${esc(part.qty)}"></label>
      <button type="button" class="btn btn-sm btn-ghost" onclick="this.closest('form').dataset.pmDirty='true';this.closest('[data-pm-parts]').dataset.partsDirty='true';this.closest('[data-pm-part]').remove()">حذف</button></div>`;
  }
  async function searchParts(button){
    const area=button.closest('[data-pm-parts]');
    const query=area.querySelector('input[type="search"]').value.trim();
    const select=area.querySelector('select');
    const status=area.querySelector('[data-pm-parts-status]');
    if(!query){status.textContent='نام یا کد قلم را وارد کنید.';return;}
    button.disabled=true;
    try{
      const response=await call('/equipment/inventory-items?q='+encodeURIComponent(query));
      select.replaceChildren(new Option('انتخاب قلم',''));
      for(const part of asList(response.data)){
        const option=new Option(`${part.code||''} — ${part.name} · موجودی آزاد ${part.available}`,part.id);
        option.dataset.name=part.name;option.dataset.code=part.code;
        select.add(option);
      }
      status.textContent=select.options.length>1?'قلم موردنیاز را انتخاب کنید.':'قلمی پیدا نشد.';
    }catch(error){status.textContent=errorText(error);}
    finally{button.disabled=false;}
  }
  function addPart(button){
    const area=button.closest('[data-pm-parts]');
    const select=area.querySelector('select');
    const option=select.selectedOptions[0];
    if(!option?.value||Array.from(area.querySelectorAll('[data-pm-part]')).some(row=>row.dataset.pmPart===option.value))return;
    area.querySelector('[data-pm-part-list]').insertAdjacentHTML('beforeend',partRow({itemId:option.value,qty:1,...option.dataset}));
    area.dataset.partsDirty='true';
    area.closest('form').dataset.pmDirty='true';
  }
  function editPlan(id,preselectedAssetId,preselectionMessage=''){
    const plan=id?(pm.details?.plan?.id===id?pm.details.plan:(maintenance.getCollection?.('pms')||[]).find(row=>row.id===id)):null;
    const selectedAssetId=plan?.assetId??preselectedAssetId??'';
    if(plan&&!allowed('edit')){showError(Object.assign(new Error('PERMISSION_DENIED'),{status:403,payload:{error:'PERMISSION_DENIED'}}));return;}
    const assets=availableAssets();
    const items=plan?.checklistItems||plan?.checklist||[];
    const checks=items.filter(item=>typeof item==='string').join('\n');
    const numberField=(key,label)=>`<label class="pm-form-field">${label}<input type="number" min="1" data-pm-field="${key}" value="${esc(plan?.[key])}"></label>`;
    const textField=(key,label)=>`<label class="pm-form-field">${label}<input data-pm-field="${key}" value="${esc(plan?.[key])}"></label>`;
    root.modal(`${root.mhead(plan?'ویرایش برنامه PM':'برنامه PM جدید')}<div class="m-body"><form data-pm-editor data-pm-dirty="false" onsubmit="event.preventDefault();BFGMaintenance.pmUi.save('${esc(id||'')}')">
      <label class="pm-form-field">عنوان<input data-pm-field="title" required value="${esc(plan?.title||'')}"></label>
      <label class="pm-form-field">تجهیز<select data-pm-field="assetId" required><option value="" ${selectedAssetId==null||String(selectedAssetId)===''?'selected':''}>انتخاب تجهیز</option>${assets.map(asset=>`<option value="${esc(asset.id)}" ${String(asset.id)===String(selectedAssetId)?'selected':''}>${esc(asset.code||'')} — ${esc(asset.name)}</option>`).join('')}</select></label>
      <label class="pm-form-field">بخش مرتبط در ساختار<select data-pm-field="targetNodeId"><option value="">خود تجهیز</option></select><small data-pm-target-note role="status"></small></label>
      <div class="pm-form-grid">${textField('code','کد فعالیت')}${textField('activityGroup','گروه فعالیت')}
        <label class="pm-form-field">نوع فعالیت<select data-pm-field="activityType"><option value="">انتخاب نوع فعالیت</option>${Object.entries(activityTypes).map(([key,label])=>`<option value="${key}" ${key===plan?.activityType?'selected':''}>${label}</option>`).join('')}</select></label>
        ${textField('requiredSkill','مهارت لازم')}${numberField('estimatedDurationMinutes','مدت استاندارد (دقیقه)')}${numberField('requiredPersonnel','تعداد نفرات')}
        <label class="pm-form-field">مسئول / تکنسین<select data-pm-field="owner"><option value="">بدون تخصیص</option>${asList(maintenance.getCollection?.('users')).map(person=>`<option value="${esc(person.id)}" ${person.id===plan?.owner?'selected':''}>${esc(person.name)}</option>`).join('')}</select></label>
      </div>
      ${preselectionMessage?`<p class="pm-error" role="alert" style="display:block;margin:8px 0">${esc(preselectionMessage)}</p>`:''}
      <label class="pm-form-field">تناوب تقویمی<select data-pm-field="calendarFrequency">${Object.entries(frequencies).map(([key,label])=>`<option value="${key}" ${key===(plan?.calendarFrequency||'custom')?'selected':''}>${label}</option>`).join('')}</select></label>
      <div class="pm-form-grid"><label class="pm-form-field">فاصلهٔ تناوب سفارشی (روز)<input data-pm-field="intervalDays" type="number" min="1" required value="${plan?.intervalDays??plan?.interval??''}"></label><label class="pm-form-field">شرح فعالیت<input data-pm-field="spec" value="${esc(plan?.spec||'')}"></label></div>
      ${!plan?`<label class="pm-form-field">مبنای زمان‌بندی<select data-pm-field="scheduleBasis"><option value="calendar">تقویمی</option></select></label>
       <label class="pm-form-field">اولین موعد (شمسی)<input data-pm-field="firstDueAt" inputmode="numeric" placeholder="۱۴۰۵/۰۱/۰۱"></label>
       <label class="pm-form-field">موعد بعدی (اختیاری، شمسی)<input data-pm-field="nextDueAt" inputmode="numeric" placeholder="۱۴۰۵/۰۱/۰۱"></label>
       <label class="pm-form-field">Tolerance (روز)<input data-pm-field="toleranceDays" type="number" min="0" placeholder="خالی = مقدار پیش‌فرض Backend"></label>`
       :''}
      <label class="pm-form-field">دستورالعمل<textarea data-pm-field="instructions" rows="3">${esc(plan?.instructions)}</textarea></label>
      <div class="pm-form-grid">
        ${[['requiredTools','ابزار (یک مورد در هر خط)'],['safetyRequirements','الزامات ایمنی (یک مورد در هر خط)']].map(([key,label])=>`<label class="pm-form-field">${label}<textarea data-pm-field="${key}" rows="3">${esc(asList(plan?.[key]).join('\n'))}</textarea></label>`).join('')}
      </div>
      <div class="pm-toolbar">${[['productionStopRequired','توقف تولید'],['lotoRequired','قفل و برچسب ایمنی'],['ptwRequired','مجوز کار']].map(([key,label])=>`<label><input type="checkbox" data-pm-field="${key}" ${plan?.[key]?'checked':''}> ${label}</label>`).join('')}</div>
      ${canReadInventory()?`<section data-pm-parts class="pm-checkpoint"><h4>قطعات و مواد موردنیاز</h4>
        <div class="pm-toolbar"><input type="search" aria-label="جستجوی انبار" placeholder="نام یا کد قلم"><button type="button" class="btn btn-sm btn-ghost" onclick="BFGMaintenance.pmUi.searchParts(this)">جستجو</button>
        <select aria-label="قلم انبار"><option value="">انتخاب قلم</option></select><button type="button" class="btn btn-sm btn-ghost" onclick="BFGMaintenance.pmUi.addPart(this)">افزودن</button></div>
        <small data-pm-parts-status role="status"></small><div data-pm-part-list>${asList(plan?.requiredParts).filter(part=>part?.itemId).map(partRow).join('')}</div></section>`:''}
      <label class="pm-form-field">چک‌لیست متنی موجود (هر خط یک مورد)<textarea data-pm-field="checklist" rows="3">${esc(checks)}</textarea></label>
      ${items.some(item=>item&&typeof item==='object'&&!item.measurementType)?`<section><h4>آیتم‌های ثبت‌شدهٔ قبلی</h4><ul>${items.filter(item=>item&&typeof item==='object'&&!item.measurementType).map(item=>`<li>${esc(item.title||item.text||item.item||'—')}</li>`).join('')}</ul></section>`:''}
      <div data-pm-checkpoints>${items.filter(item=>item?.measurementType).map(checklistRow).join('')}</div>
      <button type="button" class="btn btn-sm btn-ghost" onclick="BFGMaintenance.pmUi.addCheckpoint()">＋ افزودن آیتم چک‌لیست</button>
    </form></div><div class="m-foot"><button type="button" class="btn btn-primary" onclick="BFGMaintenance.pmUi.save('${esc(id||'')}')">ذخیره در سرور</button><button type="button" class="btn btn-ghost" onclick="closeModal()">انصراف</button></div>`,true);
    const form=document.querySelector('[data-pm-editor]');
    if(form){
      form.addEventListener?.('input',event=>{
        form.dataset.pmDirty='true';
        if(event.target.closest('[data-pm-part]'))form.querySelector('[data-pm-parts]').dataset.partsDirty='true';
      });
      form.querySelector?.('[data-pm-field="assetId"]')?.addEventListener('change',()=>void loadTargets(form));
      if(form.querySelector?.('[data-pm-field="targetNodeId"]'))void loadTargets(form,plan?.targetNodeId);
      const frequency=form.querySelector?.('[data-pm-field="calendarFrequency"]');
      const interval=form.querySelector?.('[data-pm-field="intervalDays"]');
      if(frequency&&interval){
        const updateInterval=()=>{interval.disabled=frequency.value!=='custom';interval.required=!interval.disabled;};
        frequency.addEventListener('change',updateInterval);updateInterval();
      }
      const owner=form.querySelector?.('[data-pm-field="owner"]');
      if(owner&&plan?.owner&&!owner.value)owner.add(new Option('مسئول ثبت‌شده',plan.owner,true,true));
    }
  }
  function readEditor(id){
    const val=key=>document.querySelector(`[data-pm-field="${key}"]`)?.value??'';
    const title=val('title').trim(),assetId=val('assetId'),frequency=val('calendarFrequency')||'custom';
    const intervalDays=frequency==='custom'?Number(val('intervalDays')):({daily:1,weekly:7}[frequency]||30);
    if(!title||!assetId||!Number.isInteger(intervalDays)||intervalDays<1)throw Object.assign(new Error('PM_FORM_INVALID'),{status:422,payload:{error:'TITLE_REQUIRED'}});
    const list=value=>value.split('\n').map(line=>line.trim()).filter(Boolean);
    const body={title,assetId,intervalDays,spec:val('spec').trim()||null,checklist:list(val('checklist'))};
    for(const key of ['code','targetNodeId','activityType','activityGroup','calendarFrequency','requiredSkill','instructions','owner']){
      if(document.querySelector(`[data-pm-field="${key}"]`))body[key]=val(key).trim()||null;
    }
    for(const key of ['estimatedDurationMinutes','requiredPersonnel']){
      if(document.querySelector(`[data-pm-field="${key}"]`))body[key]=val(key)?Number(val(key)):null;
    }
    for(const key of ['requiredTools','safetyRequirements']){
      if(document.querySelector(`[data-pm-field="${key}"]`))body[key]=list(val(key));
    }
    for(const key of ['productionStopRequired','lotoRequired','ptwRequired']){
      const field=document.querySelector(`[data-pm-field="${key}"]`);
      if(field)body[key]=field.checked===true;
    }
    const parts=document.querySelector('[data-pm-parts]');
    if(parts?.dataset.partsDirty==='true')body.requiredParts=Array.from(parts.querySelectorAll('[data-pm-part]'),row=>({itemId:row.dataset.pmPart,qty:Number(row.querySelector('input').value)}));
    for(const checkpoint of document.querySelectorAll?.('[data-pm-checkpoint]')||[]){
      const value=key=>checkpoint.querySelector(`[data-check="${key}"]`).value.trim();
      const item={title:value('title'),measurementType:value('measurementType'),description:value('description'),unit:value('unit'),photoRequired:checkpoint.querySelector('[data-check="photoRequired"]').checked};
      if(item.measurementType==='number')for(const key of ['standard','min','max'])item[key]=value(key)===''?null:Number(value(key));
      body.checklist.push(item);
    }
    if(id&&document.querySelector('[data-pm-checkpoints]'))body.preserveLegacyChecklist=true;
    if(id){body.rowVersion=Number((pm.details?.plan?.id===id&&pm.details.plan.rowVersion)||(maintenance.getCollection?.('pms')||[]).find(row=>row.id===id)?.rowVersion);return body;}
    for(const key of ['firstDueAt','nextDueAt']){const raw=val(key).trim();if(!raw)continue;const iso=parseJalali(raw);if(!iso)throw Object.assign(new Error(key==='firstDueAt'?'PM_FIRST_DUE_AT_INVALID':'PM_NEXT_DUE_AT_INVALID'),{status:422,payload:{error:key==='firstDueAt'?'PM_FIRST_DUE_AT_INVALID':'PM_NEXT_DUE_AT_INVALID'}});body[key]=iso+'T00:00:00.000Z';}
    const tolerance=val('toleranceDays').trim();if(tolerance){const number=Number(tolerance);if(!Number.isInteger(number)||number<0)throw Object.assign(new Error('PM_TOLERANCE_DAYS_INVALID'),{status:422,payload:{error:'PM_TOLERANCE_DAYS_INVALID'}});body.toleranceDays=number;}
    body.scheduleBasis=val('scheduleBasis')||'calendar';return body;
  }
  async function saveEditor(id){
    const form=document.querySelector('[data-pm-editor]');if(!form||form.dataset.pmSaving==='true')return;
    if(id?!allowed('edit'):!allowed('create')){showError(Object.assign(new Error('PERMISSION_DENIED'),{status:403,payload:{error:'PERMISSION_DENIED'}}));return;}
    let saved=false;
    try{
      const body=readEditor(id);if(!root.confirm(id?'تغییرات برنامه PM در سرور ذخیره شود؟':'برنامه PM با همین اطلاعات در سرور ثبت شود؟'))return;
      form.dataset.pmSaving='true';document.querySelectorAll('.modal .m-foot button').forEach(button=>button.disabled=true);
      await call(id?'/pm-plans/'+encodeURIComponent(id):'/pm-plans',{method:id?'PATCH':'POST',body:JSON.stringify(body)});saved=true;
      pm.report=null;
      form.dataset.pmDirty='false';pm.allowClose=true;
      await maintenance.sync({quiet:true});if(typeof root.closeModal==='function')root.closeModal();pm.allowClose=false;
      if(typeof root.go==='function')root.go('pm');if(id)await openPlanFromData(id);
      if(typeof root.toast==='function')root.toast(id?'اطلاعات برنامه از Backend تازه شد.':'برنامه PM در Backend ثبت شد.');
    }catch(error){
      pm.allowClose=false;
      if(saved){form.dataset.pmDirty='false';pm.allowClose=true;if(typeof root.closeModal==='function')root.closeModal();pm.allowClose=false;if(typeof root.go==='function')root.go('pm');}
      else{form.dataset.pmSaving='false';document.querySelectorAll('.modal .m-foot button').forEach(button=>button.disabled=false);}
      showError(error);
    }
  }
  async function action(kind,planOrId,button,confirmation,promptReason){
    const plan=typeof planOrId==='string'?(maintenance.getCollection?.('pms')||[]).find(row=>row.id===planOrId):planOrId;
    if(!plan||!plan.id)return {cancelled:true};
    const permission=kind==='schedule'?'schedule':kind==='generate'?'generate':kind==='archive'?'archive':kind==='restore'?'restore':null;
    if(!permission||!allowed(permission))throw Object.assign(new Error('PERMISSION_DENIED'),{status:403,payload:{error:'PERMISSION_DENIED'}});
    const dueState=(pm.details&&pm.details.plan.id===plan.id&&pm.details.due.dueStatus)||plan.dueStatus;
    if(kind==='generate'&&!['scheduled','due','overdue'].includes(dueState))throw Object.assign(new Error('PM_OCCURRENCE_NOT_GENERATABLE'),{status:409,payload:{error:'PM_OCCURRENCE_NOT_GENERATABLE'}});
    const key=String(plan.id);if(pm.busy.has(key))return {duplicateSubmit:true,ignored:true};
    const confirmText=confirmation||(kind==='schedule'?'برای موعد نمایش‌داده‌شده یک Occurrence صریح در Backend ثبت شود؟':kind==='generate'?'Work Order این برنامه به‌صورت صریح در Backend صادر شود؟':kind==='archive'?'این برنامه آرشیو می‌شود و حذف فیزیکی انجام نمی‌شود؛ ادامه می‌دهید؟':'برنامهٔ آرشیوشده با rowVersion فعلی بازیابی شود؟');
    if(typeof root.confirm!=='function'||!root.confirm(confirmText))return {cancelled:true};
    let reason='';if(kind==='archive'){reason=String((typeof root.prompt==='function'?root.prompt(promptReason||'دلیل بایگانی PM (الزامی):'):'')||'').trim();if(!reason){if(typeof root.toast==='function')root.toast('دلیل بایگانی الزامی است.',1);return {cancelled:true};}}
    pm.busy.add(key);if(button){button.disabled=true;button.setAttribute('aria-busy','true');}
    try{
      const base='/pm-plans/'+encodeURIComponent(plan.id);let response;
      if(kind==='schedule'){const body={rowVersion:Number(plan.rowVersion),evaluatedAt:new Date().toISOString()};if(plan.periodKey)body.periodKey=plan.periodKey;response=await call(base+'/occurrences',{method:'POST',body:JSON.stringify(body)});}
      else if(kind==='generate')response=await call(base+'/generate-work-order',{method:'POST',body:JSON.stringify({rowVersion:Number(plan.rowVersion)})});
      else if(kind==='archive')response=await call(base+'/archive',{method:'POST',body:JSON.stringify({rowVersion:Number(plan.rowVersion),reason})});
      else response=await call(base+'/restore',{method:'POST',body:JSON.stringify({rowVersion:Number(plan.rowVersion)})});
      await maintenance.sync({quiet:true});
      pm.busy.delete(key);
      if(kind==='archive'||kind==='restore'){
        if(kind==='restore')pm.includeArchived=false;
        if(typeof root.closeModal==='function')root.closeModal();if(typeof root.go==='function')root.go('pm');
        if(kind==='restore')await maintenance.sync({quiet:true});
      }else if(pm.selectedId===String(plan.id)){
        pm.details=await loadDetails(plan.id);pm.occurrenceDetails=null;
        if(document.querySelector('.modal'))root.modal(renderDetails(pm.details));if(typeof root.go==='function'&&root.CUR==='pm')root.go('pm');
      }else if(typeof root.go==='function'&&root.CUR==='pm')root.go('pm');
      const data=response&&response.data||{},replay=!!data.idempotentReplay;
      if(typeof root.toast==='function')root.toast(replay?'این مورد قبلاً در سرور ثبت شده بود؛ همان رکورد نمایش داده شد.':'عملیات ثبت شد و داده‌ها از Backend دوباره بارگذاری شدند.');
      return {response,replay};
    }catch(error){showError(error);return {error};}
    finally{pm.busy.delete(key);if(button){button.disabled=false;button.removeAttribute('aria-busy');}}
  }
  async function toggleArchived(){if(!allowed('restore'))return;pm.includeArchived=!pm.includeArchived;try{await maintenance.sync({quiet:true});pm.error=null;}catch(error){pm.error=error;showError(error);}if(typeof root.go==='function')root.go('pm');}
  async function retry(){pm.error=null;try{await maintenance.sync({quiet:true});}catch(error){pm.error=error;showError(error);}if(typeof root.go==='function')root.go('pm');}
  async function openPlanFromData(id){pm.selectedId=String(id);pm.occurrenceDetails=null;root.modal(root.mhead('برنامه PM')+'<div class="m-body"><div class="empty" role="status">در حال دریافت اطلاعات از Backend…</div></div>');try{pm.details=await loadDetails(id);root.modal(renderDetails(pm.details));}catch(error){pm.error=error;showError(error);root.modal(root.mhead('برنامه PM')+`<div class="m-body"><div class="card pm-error" role="alert">${esc(errorText(error))}</div><button class="btn btn-ghost" onclick="openPM('${esc(id)}')">تلاش دوباره</button></div><div class="m-foot"><button class="btn btn-ghost" onclick="closeModal()">بستن</button></div>`);}}
  function installEquipmentQuickActionBoundary(){
    const original=root.eqv2Related;
    if(typeof original!=='function'||original.pmUiQuickActionBoundary)return;
    const wrapped=function(kind,...args){
      if(kind==='pm'&&typeof root.openPMForm==='function')return root.openPMForm(args[0]);
      return original.apply(this,[kind,...args]);
    };
    Object.defineProperty(wrapped,'pmUiQuickActionBoundary',{value:true});
    root.eqv2Related=wrapped;
  }
  function install(){
    if(pm.uiInstalled||!maintenance.installed)return;
    pm.uiInstalled=true;
    const wrap=(name,fn)=>{const original=root[name];root[name]=function(...args){if(root.BFGRuntime?.isServerOnly())return fn.apply(this,args);return typeof original==='function'?original.apply(this,args):undefined;};};
    wrap('pgPM',renderPage);
    wrap('openPM',openPlanFromData);
    wrap('openPMForm',assetReference=>{
      if(!allowed('create'))return showError({status:403,payload:{error:'PERMISSION_DENIED'}});
      const normalized=normalizeAssetReference(assetReference);
      return editPlan(null,normalized.assetId,normalized.message);
    });
    installEquipmentQuickActionBoundary();
    wrap('dtActPM',()=>root.openPMForm(root.DT&&root.DT.ent==='assets'?root.DT.id:null));
    wrap('dtActPMDo',()=>{if(typeof root.toast==='function')root.toast('برای ثبت PM از فرم مرکزی استفاده کنید؛ این مسیر مستقیم غیرفعال است.',1);});
    wrap('savePM',()=>saveEditor(''));
    wrap('savePMRecord',id=>saveEditor(id));
    wrap('archivePMRecord',id=>action('archive',id));
    wrap('genPMWO',id=>action('generate',id));
    const previousClose=root.closeModal;
    root.closeModal=function(...args){
      const form=document.querySelector('[data-pm-editor]');
      if(form&&form.dataset.pmDirty==='true'&&!pm.allowClose&&!root.confirm('تغییرات واردشده ذخیره نشده‌اند؛ بدون ذخیره خارج شوید؟'))return;
      pm.allowClose=false;return previousClose.apply(this,args);
    };
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.querySelector('[data-pm-editor]')){event.preventDefault();root.closeModal();}});
  }
  const previousActivate=maintenance.activate;
  maintenance.activate=async function(...args){const result=typeof previousActivate==='function'?await previousActivate.apply(this,args):undefined;install();return result;};
  maintenance.pmUi={loadDetails,renderPage,renderDetails,openOccurrence,closeOccurrence(){pm.occurrenceDetails=null;if(pm.details)root.modal(renderDetails(pm.details));},edit:editPlan,addCheckpoint,save:saveEditor,action,loadReport,exportReport,askSelene,reviewAdvice,loadReadiness,searchParts,addPart,reschedule:()=>reschedule(pm.details?.plan),toggleArchived,retry,allowed,date,statusText,errorText,NA,install};
  if(maintenance.installed)install();
  if(typeof module!=='undefined'&&module.exports)module.exports=maintenance.pmUi;
})(typeof window!=='undefined'?window:globalThis);
