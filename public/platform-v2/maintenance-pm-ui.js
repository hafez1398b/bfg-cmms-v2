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
  const messages = {
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
  function date(value){
    if(!value || !Number.isFinite(Date.parse(value)))return NA;
    return typeof root.jDate==='function'?root.jDate(value):new Date(value).toISOString().slice(0,10);
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
  function readOnlyTechnical(plan){
    return [
      ['کد',plan.code],['وضعیت Plan',plan.status],['مبنای زمان‌بندی',plan.scheduleBasis],['فاصله زمانی (روز)',plan.intervalDays??plan.interval],['اولین موعد',plan.firstDueAt?date(plan.firstDueAt):null],
      ['موعد بعدی',plan.nextDueAt?date(plan.nextDueAt):null],['Tolerance (روز)',plan.toleranceDays],
      ['مدت برآوردی (دقیقه)',plan.estimatedDurationMinutes],['تخصص موردنیاز',plan.requiredSkill],
      ['تعداد نیروی موردنیاز',plan.requiredPersonnel],['ابزار موردنیاز',asList(plan.requiredTools).join('، ')],
      ['قطعات موردنیاز',asList(plan.requiredParts).map(item=>typeof item==='string'?item:(item.name||item.code||'')).filter(Boolean).join('، ')],
      ['الزامات ایمنی',asList(plan.safetyRequirements).join('، ')],
      ['LOTO',plan.lotoRequired===true?'الزامی':plan.lotoRequired===false?'الزامی نیست':null],
      ['PTW',plan.ptwRequired===true?'الزامی':plan.ptwRequired===false?'الزامی نیست':null],['دستورالعمل',plan.instructions]
    ].map(([label,value])=>field(label,value)).join('');
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
    const canSchedule=allowed('schedule')&&!!due.nextDueAt&&!list.some(item=>item.periodKey&&item.periodKey===plan.periodKey);
    const canGenerate=allowed('generate')&&['scheduled','due','overdue'].includes(dueState);
    const busy=pm.busy.has(String(plan.id));
    let actions='';
    if(archived){if(allowed('restore'))actions=`<button type="button" class="btn btn-sm btn-ghost" ${busy?'disabled':''} onclick="BFGMaintenance.pmUi.action('restore','${esc(plan.id)}',this)">↶ بازیابی</button>`;}
    else actions=`${canSchedule?`<button type="button" class="btn btn-sm btn-accent" ${busy?'disabled':''} onclick="BFGMaintenance.pmUi.action('schedule','${esc(plan.id)}',this)">＋ زمان‌بندی Occurrence</button>`:''}
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
      <h4>Occurrenceها</h4>${occurrences}<p class="muted">Due فقط خواندنی است؛ ثبت Occurrence با اقدام صریح انجام می‌شود.</p>
    </div><div class="m-foot"><button type="button" class="btn btn-ghost" onclick="closeModal()">بستن</button></div>`;
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
          ${!isArchived(plan)&&allowed('generate')&&['scheduled','due','overdue'].includes(plan.dueStatus)?`<button type="button" class="btn btn-sm btn-primary" onclick="event.stopPropagation();BFGMaintenance.pmUi.action('generate','${esc(plan.id)}',this)" ${busy?'disabled':''}>⚙</button>`:''}
          ${isArchived(plan)&&allowed('restore')?`<button type="button" class="btn btn-sm btn-ghost" ${busy?'disabled':''} onclick="event.stopPropagation();BFGMaintenance.pmUi.action('restore','${esc(plan.id)}',this)">↶</button>`:''}</td>
      </tr>`;
    }).join('');
    return `${root.head('نگهداری پیشگیرانه (PM)','PM',create+archiveToggle)}${compliance}${error}
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
  function editPlan(id,preselectedAssetId){
    const plan=id?((pm.details&&pm.details.plan)||(maintenance.getCollection?.('pms')||[]).find(row=>row.id===id)):null;
    const selectedAssetId=plan?.assetId||preselectedAssetId||'';
    if(plan&&!allowed('edit')){showError(Object.assign(new Error('PERMISSION_DENIED'),{status:403,payload:{error:'PERMISSION_DENIED'}}));return;}
    const assets=(maintenance.getCollection?.('assets')||[]).filter(row=>row.type==='eq'&&!row.deleted);
    const checks=(plan?.checklist||[]).map(item=>typeof item==='string'?item:(item.text||'')).filter(Boolean).join('\n');
    const readDate=value=>value&&Number.isFinite(Date.parse(value))&&typeof root.jDate==='function'?root.jDate(value):'';
    root.modal(`${root.mhead(plan?'ویرایش برنامه PM':'برنامه PM جدید')}<div class="m-body"><form data-pm-editor data-pm-dirty="false" onsubmit="event.preventDefault();BFGMaintenance.pmUi.save('${esc(id||'')}')">
      <label class="pm-form-field">عنوان<input data-pm-field="title" required value="${esc(plan?.title||'')}"></label>
      <label class="pm-form-field">تجهیز<select data-pm-field="assetId" required><option value="">انتخاب تجهیز</option>${assets.map(asset=>`<option value="${esc(asset.id)}" ${String(asset.id)===String(selectedAssetId)?'selected':''}>${esc(asset.code||'')} — ${esc(asset.name)}</option>`).join('')}</select></label>
      <div class="pm-form-grid"><label class="pm-form-field">تناوب (روز)<input data-pm-field="intervalDays" type="number" min="1" required value="${plan?.intervalDays??plan?.interval??''}"></label><label class="pm-form-field">تخصص<input data-pm-field="spec" value="${esc(plan?.requiredSkill||plan?.spec||'')}"></label></div>
      ${!plan?`<label class="pm-form-field">مبنای زمان‌بندی<select data-pm-field="scheduleBasis"><option value="calendar">تقویمی</option></select></label>
       <label class="pm-form-field">اولین موعد (شمسی)<input data-pm-field="firstDueAt" inputmode="numeric" placeholder="۱۴۰۵/۰۱/۰۱"></label>
       <label class="pm-form-field">موعد بعدی (اختیاری، شمسی)<input data-pm-field="nextDueAt" inputmode="numeric" placeholder="۱۴۰۵/۰۱/۰۱"></label>
       <label class="pm-form-field">Tolerance (روز)<input data-pm-field="toleranceDays" type="number" min="0" placeholder="خالی = مقدار پیش‌فرض Backend"></label>`
       :`<div class="pm-detail-grid">${readOnlyTechnical(plan)}</div>`}
      <label class="pm-form-field">چک‌لیست (هر خط یک مورد)<textarea data-pm-field="checklist" rows="4">${esc(checks)}</textarea></label>
      <p class="muted">فیلدهای فنی مطابق دادهٔ ثبت‌شده نمایش داده می‌شوند؛ مقدار ناموجود حدس زده نمی‌شود. ویرایش فقط برای فیلدهای پشتیبانی‌شده در API فعلی فعال است.</p>
    </form></div><div class="m-foot"><button type="button" class="btn btn-primary" onclick="BFGMaintenance.pmUi.save('${esc(id||'')}')">ذخیره در سرور</button><button type="button" class="btn btn-ghost" onclick="closeModal()">انصراف</button></div>`,true);
    const form=document.querySelector('[data-pm-editor]');if(form)form.querySelectorAll('input,select,textarea').forEach(input=>input.addEventListener('input',()=>{form.dataset.pmDirty='true';}));
  }
  function readEditor(id){
    const val=key=>document.querySelector(`[data-pm-field="${key}"]`)?.value??'';
    const title=val('title').trim(),assetId=val('assetId'),intervalDays=Number(val('intervalDays'));
    if(!title||!assetId||!Number.isInteger(intervalDays)||intervalDays<1)throw Object.assign(new Error('PM_FORM_INVALID'),{status:422,payload:{error:'TITLE_REQUIRED'}});
    const body={title,assetId,intervalDays,spec:val('spec').trim()||null,checklist:val('checklist').split('\n').map(line=>line.trim()).filter(Boolean)};
    if(id){body.rowVersion=Number((pm.details&&pm.details.plan&&pm.details.plan.rowVersion)||(maintenance.getCollection?.('pms')||[]).find(row=>row.id===id)?.rowVersion);return body;}
    for(const key of ['firstDueAt','nextDueAt']){const raw=val(key).trim();if(!raw)continue;const iso=typeof root.jStr2iso==='function'?root.jStr2iso(raw):null;if(!iso)throw Object.assign(new Error(key==='firstDueAt'?'PM_FIRST_DUE_AT_INVALID':'PM_NEXT_DUE_AT_INVALID'),{status:422,payload:{error:key==='firstDueAt'?'PM_FIRST_DUE_AT_INVALID':'PM_NEXT_DUE_AT_INVALID'}});body[key]=iso+'T00:00:00.000Z';}
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
  function install(){
    if(pm.uiInstalled||!maintenance.installed)return;
    pm.uiInstalled=true;
    const wrap=(name,fn)=>{const original=root[name];root[name]=function(...args){if(root.BFGRuntime?.isServerOnly())return fn.apply(this,args);return typeof original==='function'?original.apply(this,args):undefined;};};
    wrap('pgPM',renderPage);
    wrap('openPM',openPlanFromData);
    wrap('openPMForm',assetId=>allowed('create')?editPlan(null,assetId):showError({status:403,payload:{error:'PERMISSION_DENIED'}}));
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
  maintenance.pmUi={loadDetails,renderPage,renderDetails,openOccurrence,closeOccurrence(){pm.occurrenceDetails=null;if(pm.details)root.modal(renderDetails(pm.details));},edit:editPlan,save:saveEditor,action,toggleArchived,retry,allowed,date,statusText,errorText,NA,install};
  if(maintenance.installed)install();
  if(typeof module!=='undefined'&&module.exports)module.exports=maintenance.pmUi;
})(typeof window!=='undefined'?window:globalThis);
