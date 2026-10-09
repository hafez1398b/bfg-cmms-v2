/* Comprehensive Equipment Registry and digital dossier. The legacy tree is intentionally not exposed. */
(function(){
  'use strict';

  const STORAGE_KEY='bfg_equipment_ui_state_v2';
  const DEFAULT_COLUMNS=['code','name','factory','location','category','model','maker','status','crit','health','lastPm','nextPm','openWo','cost'];
  const COLUMNS={code:'کد تجهیز',name:'نام تجهیز',factory:'کارخانه',location:'محل',category:'دسته',model:'مدل',maker:'سازنده',status:'وضعیت',crit:'بحرانیت',health:'سلامت',lastPm:'آخرین PM',nextPm:'PM بعدی',openWo:'WO باز',cost:'هزینه نت'};
  const DETAIL_TABS=[
    ['technical','مشخصه فنی'],['structure','ساختار'],['spares','قطعات یدکی حیاتی'],
    ['maintenance','برنامه نگهداری'],['history','سوابق'],['calibration','کالیبراسیون'],
    ['instructions','دستورالعمل‌ها'],['documents','اسناد و فایل‌ها'],['transactions','تراکنش‌ها'],
    ['monitoring','پایش تجهیز'],['risk','ریسک و فرصت']
  ];

  const saved=readState();
  const E=window.EQV2={
    view:'list',page:saved.page||1,limit:50,q:saved.q||'',factoryId:saved.factoryId||'',categoryId:saved.categoryId||'',
    status:saved.status||'',criticality:saved.criticality||'',sort:saved.sort||'sortOrder',direction:saved.direction||'asc',
    selected:saved.selected||null,columns:Array.isArray(saved.columns)&&saved.columns.length?saved.columns:DEFAULT_COLUMNS,
    scroll:{list:saved.listScroll||0,window:saved.windowScroll||0},
    tab:'technical',detail:false,detailKey:null,rows:[],pagination:null,
    options:{factories:[],categories:[],locations:[],responsibleUsers:[]},routeBusy:false,
    intakeReturn:null,wizard:null,
    structure:null,structurePanel:[],structureFocus:null,structureArchived:false,structureLoading:false,
    structureExpanded:{},
    structureError:null,structureSuggestNotice:null,structurePendingReject:null,inventoryOptions:[]
  };

  // The legacy shell declares MENU with `const`, so it is not available as window.MENU.
  // Update only the existing Equipment entry to make this in-place upgrade visible.
  try{
    const equipmentMenu=typeof MENU!=='undefined'&&Array.isArray(MENU)?MENU.find(item=>item?.id==='equipment'||item?.id==='tree'):null;
    if(equipmentMenu){equipmentMenu.id='equipment';equipmentMenu.t='فهرست جامع تجهیزات';equipmentMenu.ic='⚙️';}
    if(typeof ME!=='undefined'&&ME&&typeof buildMenu==='function')buildMenu();
  }catch(error){console.warn('Equipment menu label was not updated',error);}

  const R=()=>EquipmentRepository.current();
  const canDo=operation=>typeof can!=='function'||can('equipment',operation==='move'?'edit':operation);
  const escText=value=>typeof esc==='function'?esc(value):String(value??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const faText=value=>typeof fa==='function'?fa(value):String(value??'');
  const formatDate=value=>value&&typeof jDate==='function'?jDate(value):(value||'—');
  const formatDateTime=value=>value&&typeof jDateTime==='function'?jDateTime(value):(value||'—');
  const statusInfo=a=>typeof AS_ST!=='undefined'&&AS_ST[a.status]?AS_ST[a.status]:[a.status||'—','b-gray'];
  const empty=text=>`<div class="eqv2-empty"><div><i>—</i><div>${escText(text)}</div></div></div>`;

  function readState(){try{return JSON.parse(sessionStorage.getItem(STORAGE_KEY)||'{}');}catch(_){return{};}}
  function saveState(){
    try{sessionStorage.setItem(STORAGE_KEY,JSON.stringify({page:E.page,q:E.q,factoryId:E.factoryId,categoryId:E.categoryId,status:E.status,criticality:E.criticality,sort:E.sort,direction:E.direction,selected:E.selected,columns:E.columns,listScroll:E.scroll.list,windowScroll:E.scroll.window}));}catch(_){}
  }
  function captureExplorerState(){
    E.scroll.window=window.scrollY||0;
    const scroller=document.querySelector('.eqv2-table-wrap');
    E.scroll.list=scroller?.scrollTop||0;
    saveState();
  }
  function restoreExplorerScroll(){
    requestAnimationFrame(()=>{
      const scroller=document.querySelector('.eqv2-table-wrap');
      if(scroller)scroller.scrollTop=E.scroll.list||0;
      window.scrollTo(0,E.scroll.window||0);
    });
  }

  function sourceBadge(){const source=R().source;const label=source==='postgresql'?'PostgreSQL · منبع حقیقت':'اتصال به سرور مرکزی لازم است';return`<span class="eqv2-source ${source==='postgresql'?'':'local'}">${label}</span>`;}
  function shell(){
    return`<div class="eqv2" id="eqv2Explorer"><div class="eqv2-head"><div class="eqv2-title"><small>دارایی‌ها › تجهیزات <span class="eqv2-version">Registry 3.0</span></small><h2>فهرست جامع تجهیزات</h2><p class="eqv2-subtitle">تمام تجهیزات ثبت‌شده در یک فهرست واحد؛ برای مشاهده پرونده دیجیتال، تجهیز را انتخاب کنید.</p></div>${sourceBadge()}${canDo('view')?'<button class="btn btn-sm btn-ghost" onclick="eqv2OpenIntake()">ورود هوشمند</button>':''}${canDo('create')?'<button class="btn btn-sm btn-primary" onclick="eqv2Create()">＋ افزودن تجهیز</button>':''}</div>${toolbar()}<div class="eqv2-layout eqv2-list-only"><section class="eqv2-main"><div class="eqv2-loading">در حال دریافت فهرست تجهیزات…</div></section></div></div>`;
  }
  function toolbar(){
    const factories=E.options.factories.map(x=>`<option value="${escText(x.id)}" ${E.factoryId===x.id?'selected':''}>${escText(x.name)}</option>`).join('');
    const categories=E.options.categories.filter(x=>!E.factoryId||x.factory_id===E.factoryId).map(x=>`<option value="${escText(x.id)}" ${E.categoryId===x.id?'selected':''}>${escText(x.name)}</option>`).join('');
    return`<div class="eqv2-toolbar"><div class="eqv2-search"><span>⌕</span><input value="${escText(E.q)}" placeholder="کد، نام، سریال، مدل یا سازنده…" oninput="eqv2Search(this.value)"></div><select aria-label="کارخانه" onchange="eqv2Filter('factoryId',this.value)"><option value="">همه کارخانه‌ها</option>${factories}</select><select aria-label="دسته" onchange="eqv2Filter('categoryId',this.value)"><option value="">همه دسته‌ها</option>${categories}</select><select aria-label="وضعیت" onchange="eqv2Filter('status',this.value)"><option value="">همه وضعیت‌ها</option>${Object.entries(typeof AS_ST==='undefined'?{}:AS_ST).map(([key,value])=>`<option value="${key}" ${E.status===key?'selected':''}>${value[0]}</option>`).join('')}</select><select aria-label="بحرانیت" onchange="eqv2Filter('criticality',this.value)"><option value="">همه بحرانیت‌ها</option>${['A','B','C'].map(x=>`<option ${E.criticality===x?'selected':''}>${x}</option>`).join('')}</select><button class="btn btn-sm btn-ghost" onclick="eqv2Columns()">ستون‌ها</button><button class="btn btn-sm btn-ghost" onclick="eqv2Export()">↓ Excel</button></div>`;
  }

  function equipmentModuleAllowed(){return !window.BFGModules||typeof window.BFGModules.allows!=='function'||window.BFGModules.allows('equipment');}
  function page(){
    E.detail=false;E.detailKey=null;
    if(!equipmentModuleAllowed())return head('فهرست تجهیزات','ماژول غیرفعال')+'<div class="card empty">ماژول تجهیزات غیرفعال است.</div>';
    if(location.pathname.startsWith('/equipment/'))history.replaceState({equipmentExplorer:true},'','/');
    if(typeof can==='function'&&!can('equipment','view'))return head('فهرست تجهیزات','دسترسی محدود')+'<div class="card empty">اجازه مشاهده تجهیزات را ندارید.</div>';
    setTimeout(()=>initExplorer(true),0);return shell();
  }
  async function initExplorer(restore=false){
    try{
      await R().feature();
      const filters=R().filters?await R().filters():{factories:[],categories:[]};E.options=filters;
      const root=document.getElementById('eqv2Explorer');if(root){const old=root.querySelector('.eqv2-toolbar');if(old)old.outerHTML=toolbar();}
      await load();if(restore)restoreExplorerScroll();
    }catch(error){showError(error);}
  }
  async function load(){E.view='list';const main=document.querySelector('.eqv2-main');if(!main)return;main.innerHTML='<div class="eqv2-loading">در حال بارگذاری…</div>';await loadList();saveState();}

  const valueFor=(a,key)=>({code:a.code,name:a.name,factory:a.factory_name,location:a.location_name,category:a.category_name,model:a.model,maker:a.maker,status:a.status,crit:a.crit,health:a.health_score,lastPm:a.last_run,nextPm:a.next_pm,openWo:a.open_wo,cost:a.maintenance_cost})[key];
  function cell(a,key){const value=valueFor(a,key);if(key==='code')return`<span class="eqv2-code">${escText(value||'—')}</span>`;if(key==='name')return`<b>${escText(value||'—')}</b><div class="muted" style="font-size:9px">${escText(a.cls||'')}</div>`;if(key==='status'){const s=statusInfo(a);return`<span class="badge ${s[1]}"><span class="dot"></span>${escText(s[0])}</span>`;}if(key==='health')return value==null?'<span class="eqv2-na">داده کافی نیست</span>':`<b>${faText(Math.round(value))}</b>/۱۰۰`;if(key==='lastPm'||key==='nextPm')return value?formatDate(value):'<span class="eqv2-na">—</span>';if(key==='openWo')return value?`<span class="badge b-orange">${faText(value)}</span>`:'۰';if(key==='cost')return value==null?'<span class="eqv2-na">N/A</span>':money(value);return escText(value??'—');}
  const sortKey=key=>({crit:'criticality',factory:'name',location:'name',category:'name',maker:'name',model:'name',health:'name',lastPm:'updatedAt',nextPm:'updatedAt',openWo:'updatedAt',cost:'updatedAt'}[key]||key);
  async function loadList(){
    const result=await R().list(E);E.rows=result.data;E.pagination=result.pagination;
    document.querySelector('.eqv2-main').innerHTML=`<div class="eqv2-card-head"><b>فهرست جامع تجهیزات</b><span class="muted">${faText(result.pagination.total)} تجهیز · انتخاب هر ردیف = پرونده دیجیتال</span></div><div class="eqv2-table-wrap"><table><thead><tr>${E.columns.map(key=>`<th onclick="eqv2Sort('${key}')">${COLUMNS[key]} ${sortKey(key)===E.sort?(E.direction==='asc'?'↑':'↓'):''}</th>`).join('')}<th class="eqv2-open-col">پرونده</th></tr></thead><tbody>${result.data.map(a=>`<tr data-equipment-detail="${escText(a.id)}" class="${E.selected===a.id?'sel':''}" tabindex="0" onclick="eqv2OpenDetail('${escText(a.id)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();eqv2OpenDetail('${escText(a.id)}')}" title="بازکردن پرونده دیجیتال تجهیز">${E.columns.map(key=>`<td>${cell(a,key)}</td>`).join('')}<td class="eqv2-open-col"><button type="button" class="eqv2-open-dossier" aria-label="بازکردن پرونده ${escText(a.name)}">پرونده دیجیتال ←</button></td></tr>`).join('')||`<tr><td colspan="${E.columns.length+1}" class="empty">تجهیزی یافت نشد</td></tr>`}</tbody></table></div>${pager(result.pagination)}`;
  }
  function pager(p){return`<div class="eqv2-pager"><button class="btn btn-sm btn-ghost" ${p.page<=1?'disabled':''} onclick="eqv2Page(${p.page-1})">قبلی</button><span>صفحه ${faText(p.page)} از ${faText(p.pages)} · ${faText(p.total)} رکورد</span><button class="btn btn-sm btn-ghost" ${p.page>=p.pages?'disabled':''} onclick="eqv2Page(${p.page+1})">بعدی</button></div>`;}
  function icon(a){const kind=a?.ext?.nodeKind||a?.nodeKind||a?.type;return kind==='factory'||kind==='site'?'🏭':kind==='location'||kind==='unit'?'📍':'⚙️';}


  async function select(id,resetTab=true){
    if(E.selected!==id&&resetTab)E.tab='technical';E.selected=id;saveState();
    document.querySelectorAll('.eqv2 tbody tr').forEach(x=>x.classList.remove('sel'));
    document.querySelector(`[data-equipment-detail="${CSS.escape(id)}"]`)?.classList.add('sel');
    try{const {data:a}=await R().get(id),panel=document.getElementById('eqv2Summary');if(panel)panel.innerHTML=summary(a);}catch(error){showError(error);}
  }
  function summary(a){const s=statusInfo(a);return`<div class="eqv2-card-head"><b>خلاصه تجهیز</b><button class="btn btn-sm btn-ghost" onclick="eqv2CloseSummary()">×</button></div><div class="eqv2-dossier-in"><div class="eqv2-asset-hero"><div class="eqv2-asset-icon">${icon(a)}</div><div><h3>${escText(a.name)}</h3><small>${escText(a.code)}</small><span class="badge ${s[1]}">${escText(s[0])}</span></div></div>${[['کارخانه',a.factory_name],['دسته',a.category_name],['محل',a.location_name],['مدل',a.model],['بحرانیت',a.crit],['WO باز',faText(a.open_wo||0)]].map(([k,v])=>`<div class="eqv2-kv"><span>${k}</span><b>${escText(v??'—')}</b></div>`).join('')}<button class="btn btn-primary btn-block" style="margin-top:12px" onclick="eqv2OpenDetail('${escText(a.id)}')">بازکردن پرونده کامل</button><div class="muted" style="text-align:center;margin-top:7px">برای بازکردن پرونده، ردیف تجهیز را انتخاب کنید.</div></div>`;}

  function detailHeader(a){
    const s=statusInfo(a),tab=E.tab||'technical';
    return`<header class="eqv2-detail-header eqv2-compact-header">
      <button class="btn btn-ghost eqv2-back" onclick="eqv2BackToEquipment()">← فهرست تجهیزات</button>
      <div class="eqv2-detail-identity">
        <div class="eqv2-header-primary"><span class="eqv2-code">${escText(a.code||'—')}</span><h1>${escText(a.name||'—')}</h1></div>
        <div class="eqv2-header-meta"><span class="badge ${s[1]}">${escText(s[0])}</span>
          <span>${escText(a.factory_name||'کارخانه ثبت نشده')}</span><span>${escText(a.location_name||'محل ثبت نشده')}</span>
          <span>${escText(a.category_name||'دسته ثبت نشده')}</span>
          ${a.responsible_name?`<span>مسئول: ${escText(a.responsible_name)}</span>`:''}
        </div>
      </div>
      <div class="eqv2-detail-actions">
        ${canDo('create')?`<button class="btn btn-sm btn-primary" onclick="eqv2Related('wo','${escText(a.id)}')">＋ دستورکار</button><button class="btn btn-sm btn-ghost" onclick="eqv2Related('request','${escText(a.id)}')">＋ درخواست</button><button class="btn btn-sm btn-ghost" onclick="eqv2Related('pm','${escText(a.id)}')">＋ PM</button>`:''}
        ${canDo('view')?`<button class="btn btn-sm btn-ghost" onclick="eqv2OpenIntake('${escText(a.id)}')">ورود هوشمند</button>`:''}
        ${canDo('edit')?`<button class="btn btn-sm btn-ghost" onclick="eqv2OpenWizard('${escText(a.id)}','initial','${escText(tab)}')">✎ ویرایش</button>`:''}
        ${canDo('delete')?`<button class="btn btn-sm btn-danger" onclick="eqv2Delete('${escText(a.id)}')">بایگانی</button>`:''}
      </div>
    </header>`;
  }
  function breadcrumb(a){
    const path=a.path||[];
    if(!path.length)return'';
    return`<div class="eqv2-breadcrumb" aria-label="مسیر ساختاری این تجهیز">${path.map((item,index)=>`<span class="${index===path.length-1?'current':''}">${escText((item.code?item.code+' — ':'')+item.name)}</span>`).join('<i aria-hidden="true">›</i>')}</div>`;
  }
  function detailPage(a){
    return`<div class="eqv2 eqv2-detail-page" id="eqv2Detail" data-equipment-id="${escText(a.id)}">${detailHeader(a)}${breadcrumb(a)}
      <div class="eqv2-detail-tabs" role="tablist" aria-label="بخش‌های پرونده تجهیز">${DETAIL_TABS.map(([key,label])=>`<button role="tab" aria-selected="${E.tab===key}" class="${E.tab===key?'on':''}" onclick="eqv2DetailTab('${key}')">${label}</button>`).join('')}</div>
      <main class="eqv2-detail-body" id="eqv2DetailBody">${detailBody(a)}</main>
    </div>`;
  }
  function cards(rows){return`<div class="eqv2-detail-grid">${rows.map(([key,value])=>`<div class="eqv2-info-card"><span>${escText(key)}</span><b>${value==null||value===''?'—':value}</b></div>`).join('')}</div>`;}
  function rowsList(rows,render,none){return rows?.length?`<div class="eqv2-record-list">${rows.map(render).join('')}</div>`:empty(none);}
  function woRow(w){return`<article class="clickable" onclick="typeof openWO==='function'&&openWO('${escText(w.id)}')"><div><b>${escText(w.no||'بدون شماره')}</b><span class="muted">${formatDate(w.created_at||w.createdAt)}</span></div><p>${escText(w.descr||w.desc||'بدون شرح')}</p><span class="badge b-gray">${escText(w.status||'—')}</span><span class="eqv2-go">مشاهده، ویرایش یا بایگانی ←</span></article>`;}
  function healthExplanation(a){const health=a.ext?.operationalHealth;if(!health)return'';if(health.score==null)return`<section class="eqv2-health-evidence"><div><b>شاخص سلامت تجهیز</b><span class="badge b-gray">N/A — داده ناکافی</span></div><p>${escText(health.reason||'داده کافی برای محاسبه وجود ندارد.')}</p></section>`;const badge=health.score>=80?'b-green':health.score>=60?'b-blue':health.score>=40?'b-orange':'b-red';return`<section class="eqv2-health-evidence"><div><b>شاخص سلامت قطعی</b><span class="badge ${badge}">${faText(health.score)} از ۱۰۰ · ${faText(health.coverage)} عامل معتبر</span></div><div class="eqv2-health-factors">${(health.evidence||[]).map(factor=>`<article><span>${escText(factor.label)}</span><b>${faText(Math.round(factor.value))}٪</b><small>${escText(factor.evidence)}</small></article>`).join('')}</div><p>این امتیاز توسط موتور قواعد از داده‌های ثبت‌شده محاسبه شده است؛ تشخیص AI مولد محسوب نمی‌شود.</p></section>`;}
  const notRecorded='<span class="eqv2-na">ثبت نشده</span>';
  function detailBody(a){
    const ext=a.ext||{},workOrders=a.work_orders||[],completed=a.maintenance_history||[],plans=a.pm_plans||[];
    const executions=a.checklist_executions||[],failures=a.failures||[];
    if(E.tab==='technical'){
      const rows=[
        ['کد تجهیز',escText(a.code)],['نام تجهیز',escText(a.name)],['کارخانه',a.factory_name?escText(a.factory_name):notRecorded],
        ['دسته',a.category_name?escText(a.category_name):notRecorded],['محل استقرار',escText(ext.locationDescription||a.location_name)],
        ['نوع فعالیت',escText(a.activity_type)],['کلاس',escText(a.cls)],['وضعیت فنی',escText(a.status)],
        ['وضعیت بهره‌برداری',escText(a.operational_status)],['بحرانیت',escText(a.crit)],['سازنده',escText(a.maker)],
        ['کشور سازنده',escText(a.manufacturer_country)],['مدل',escText(a.model)],['سریال',escText(a.serial)],
        ['سال ساخت',escText(a.year)],['تاریخ نصب',a.install_date||a.install?formatDate(a.install_date||a.install):notRecorded],
        ['توان',escText(a.power)],['ظرفیت',escText(ext.capacity)],['مسئول تجهیز',escText(a.responsible_name)],
        ['شرح عملکرد',escText(ext.description)],['مشخصات فنی',escText(ext.technicalSpecification)],
        ['تابلو برق',escText(ext.panelCode)],['نوع مبرد',escText(ext.refrigerant)],
        ['کارکرد روزانه',ext.dailyOperatingHours==null?notRecorded:faText(ext.dailyOperatingHours)+' ساعت'],
        ['امتیاز بحرانی',ext.criticalityScore==null?notRecorded:faText(ext.criticalityScore)+' از ۱۰۰'],
        ['ملاحظات عمومی',escText(a.general_notes)]
      ];
      return`<section class="eqv2-section-heading"><div><span>پرونده دیجیتال تجهیز</span><h2>مشخصه فنی</h2><p>مقادیر از رجیستری PostgreSQL و فیلدهای موجود ext خوانده می‌شوند؛ مقدار ثبت‌نشده حدس زده نمی‌شود.</p></div>${canDo('edit')?`<button class="btn btn-sm btn-primary" onclick="eqv2OpenWizard('${escText(a.id)}','initial','technical')">ویرایش مشخصه فنی</button>`:''}</section>${cards(rows)}`;
    }
    if(E.tab==='structure'){return structureSection(a);}
    if(E.tab==='spares'){
      const stored=a.spare_parts||[],keyParts=Array.isArray(ext.keyParts)?ext.keyParts:[];
      const linked=stored.length?`<div class="eqv2-record-list">${stored.map(part=>`<article><div><b>${escText(part.code||'')} — ${escText(part.name)}</b><span>${escText(part.relation_type||'')}</span></div><p>موجودی: ${part.stock==null?notRecorded:faText(part.stock)} · حداقل: ${part.minimum==null?notRecorded:faText(part.minimum)} · نیاز تجهیز: ${part.quantity_required==null?notRecorded:faText(part.quantity_required)} ${escText(part.unit||'')}</p>${part.notes?`<small>${escText(part.notes)}</small>`:''}</article>`).join('')}</div>`:empty('قلم قطعه یدکی متصل به موجودی ثبت نشده است.');
      const noted=keyParts.length?`<section class="eqv2-subsection"><h3>قطعات کلیدیِ متنی در پرونده</h3><p class="muted">این متن از ext آمده و قلم انبار یا موجودی محسوب نمی‌شود.</p><div class="eqv2-parts-chips">${keyParts.map(part=>`<span>${escText(part)}</span>`).join('')}</div></section>`:'';
      return`<section class="eqv2-section-heading"><div><span>دادهٔ قطعات مرتبط</span><h2>قطعات یدکی حیاتی</h2><p>فقط لینک‌های واقعی asset_spare_parts و items نمایش داده می‌شوند.</p></div></section>${linked}${noted}`;
    }
    if(E.tab==='maintenance'){
      const plansHtml=plans.length?`<div class="eqv2-record-list">${plans.map(plan=>`<article><div><b>${escText((plan.code?plan.code+' — ':'')+(plan.title||'برنامه PM'))}</b><span>${plan.interval_days?faText(plan.interval_days)+' روز':notRecorded}</span></div><p>مسئول: ${escText(plan.owner_role)} · آخرین اجرا: ${plan.last_run?formatDate(plan.last_run):notRecorded} · وضعیت: ${escText(plan.status)}</p>${Array.isArray(plan.checklist)&&plan.checklist.length?`<ul class="eqv2-checklist">${plan.checklist.map(item=>`<li>${escText(typeof item==='string'?item:(item.title||item.text||item.label||''))}</li>`).join('')}</ul>`:''}</article>`).join('')}</div>`:empty('برنامه PM ثبت نشده است.');
      const daily=Array.isArray(ext.dailyInspection)?ext.dailyInspection:[];
      const checklist=daily.length?`<section class="eqv2-subsection"><h3>بازرسی‌های ثبت‌شده در پرونده قدیمی</h3><ul class="eqv2-checklist">${daily.map(item=>`<li>${escText(typeof item==='string'?item:(item.title||item.text||item.label||''))}</li>`).join('')}</ul></section>`:'';
      return`<section class="eqv2-section-heading"><div><span>برنامه‌های واقعی maintenance-service</span><h2>برنامه نگهداری</h2><p>PM و چک‌لیستِ تعریف‌شده نگه داشته می‌شوند؛ اجراهای واقعی در بخش سوابق می‌آیند.</p></div><div class="eqv2-section-actions">${canDo('edit')?`<button class="btn btn-sm btn-ghost" onclick="eqv2OpenWizard('${escText(a.id)}','maintenance','maintenance')">بازبینی در ویزارد تجهیز</button>`:''}${canDo('create')?`<button class="btn btn-sm btn-primary" onclick="eqv2Related('pm','${escText(a.id)}')">＋ برنامه PM</button>`:''}</div></section>${plansHtml}${checklist}`;
    }
    if(E.tab==='history'){
      const woHtml=completed.length?`<section class="eqv2-subsection"><h3>دستورکارهای تکمیل‌شده</h3><div class="eqv2-record-list">${completed.map(woRow).join('')}</div></section>`:'';
      const failureHtml=failures.length?`<section class="eqv2-subsection"><h3>سوابق خرابی ثبت‌شده</h3><div class="eqv2-record-list">${failures.map(failure=>`<article><div><b>${escText(failure.failure_no||failure.id)}</b><span>${formatDate(failure.occurred_at)}</span></div><p>${escText(failure.description||failure.condition||'شرح ثبت نشده')} · ${escText(failure.status||'')}</p>${failure.cause?`<p>علت ثبت‌شده: ${escText(failure.cause)}</p>`:''}</article>`).join('')}</div></section>`:'';
      const executionHtml=executions.length?`<section class="eqv2-subsection"><h3>اجراهای چک‌لیست</h3><div class="eqv2-record-list">${executions.map(run=>`<article><div><b>${escText(run.template_title||'اجرای چک‌لیست')}</b><span>${formatDateTime(run.completed_at||run.started_at)}</span></div><p>وضعیت: ${escText(run.overall_status||run.status||'ثبت نشده')} · منشأ داده: ${escText(run.provenance_status||'ثبت نشده')}</p>${Array.isArray(run.answers)&&run.answers.length?`<details><summary>پاسخ‌ها (${faText(run.answers.length)})</summary><ul class="eqv2-checklist">${run.answers.map(answer=>`<li>${escText(answer.item_key)}: ${escText(answer.result||answer.value_text||answer.value_numeric||'ثبت نشده')}${answer.note?` — ${escText(answer.note)}`:''}</li>`).join('')}</ul></details>`:''}</article>`).join('')}</div></section>`:'';
      const historyRows=(a.movements||[]).map(item=>`<article><div><b>${formatDateTime(item.t||item.at)}</b><span>${escText(item.label||'تغییر ثبت‌شده')}</span></div><p>${escText(item.x||item.note||item.summary||'')}</p></article>`);
      const movementHtml=historyRows.length?`<section class="eqv2-subsection"><h3>تاریخچه و جابه‌جایی ثبت‌شده</h3><div class="eqv2-record-list">${historyRows.join('')}</div></section>`:'';
      return`${woHtml}${failureHtml}${executionHtml}${movementHtml}`||empty('سابقه تعمیر، خرابی، اجرای چک‌لیست یا تغییر ثبت نشده است.');
    }
    if(E.tab==='calibration'){
      const instruments=a.calibration_instruments||[];
      return`<section class="eqv2-section-heading"><div><span>ابزارهای مرتبط واقعی</span><h2>کالیبراسیون</h2><p>گردش و سوابقِ ثبت‌شدهٔ ابزارها نمایش داده می‌شود؛ تاریخچهٔ کالیبراسیون پیشرفته در فاز بعدی است.</p></div></section>${rowsList(instruments,item=>`<article><div><b>${escText(item.code||'')} — ${escText(item.name)}</b><span>${escText(item.type||'')}</span></div><p>دوره: ${item.period_days==null?notRecorded:faText(item.period_days)+' روز'} · آخرین کالیبراسیون: ${item.last_cal?formatDate(item.last_cal):notRecorded} · کلاس: ${escText(item.cls)}</p></article>`,'ابزار کالیبراسیون مرتبط ثبت نشده است.')}`;
    }
    if(E.tab==='instructions'){
      const instructions=Array.isArray(a.instructions)?a.instructions:[];
      return`<section class="eqv2-section-heading"><div><span>محتوای موجود در پرونده</span><h2>دستورالعمل‌ها</h2><p>فقط دستورالعمل‌های واقعاً متصل به تجهیز نمایش داده می‌شوند.</p></div></section>${rowsList(instructions,item=>`<article><div><b>${escText(item.title||item.name||'دستورالعمل')}</b><span>${escText(item.code||item.version||'')}</span></div><p>${escText(item.summary||item.description||item.status||'')}</p></article>`,'دستورالعمل متصل از Backend ثبت نشده است.')}`;
    }
    if(E.tab==='documents'){
      const docs=Array.isArray(a.documents)?a.documents:[];
      return`<section class="eqv2-section-heading"><div><span>اسناد متصل به همین تجهیز</span><h2>اسناد و فایل‌ها</h2><p>فایل خام سلن ذخیره نمی‌شود؛ فقط پیوندهای واقعیِ ثبت‌شده نمایش داده می‌شوند.</p></div></section>${rowsList(docs,document=>`<article><div><b>${escText(document.title||document.name||'سند')}</b><span>${escText(document.code||document.fmt||document.format||'')}</span></div><p>${escText(document.status||document.version||'')}</p></article>`,'سند متصل از Backend ثبت نشده است.')}`;
    }
    if(E.tab==='transactions'){
      const requests=a.requests||[],parts=a.consumed_parts||[],costs=a.cost_entries||[],openOrders=workOrders.filter(item=>!['closed','cancel','done','completed'].includes(item.status));
      const sections=[];
      if(requests.length)sections.push(`<section class="eqv2-subsection"><h3>درخواست‌های مرتبط</h3><div class="eqv2-record-list">${requests.map(request=>`<article class="clickable" onclick="typeof openReq==='function'&&openReq('${escText(request.id)}')"><div><b>${escText(request.no||'درخواست')}</b><span>${formatDate(request.created_at)}</span></div><p>${escText(request.descr||'شرح ثبت نشده')}</p><span class="badge b-gray">${escText(request.status||'')}</span></article>`).join('')}</div></section>`);
      if(openOrders.length)sections.push(`<section class="eqv2-subsection"><h3>دستورکارهای باز (${faText(openOrders.length)})</h3><div class="eqv2-record-list">${openOrders.map(woRow).join('')}</div></section>`);
      if(parts.length)sections.push(`<section class="eqv2-subsection"><h3>قطعات مصرف‌شده</h3><div class="eqv2-record-list">${parts.map(part=>`<article><div><b>${escText(part.item_code)} — ${escText(part.item_name)}</b><span>${faText(part.qty)} ${escText(part.unit)}</span></div><p>دستورکار ${escText(part.wo_no||'—')} · ${formatDate(part.at)}</p></article>`).join('')}</div></section>`);
      if(costs.length)sections.push(`<section class="eqv2-subsection"><h3>هزینه‌های ثبت‌شده</h3><div class="eqv2-total">مجموع هزینهٔ قابل محاسبه از رکوردهای واقعی: <b>${money(costs.reduce((sum,row)=>sum+Number(row.amount||0),0))}</b></div><div class="eqv2-record-list">${costs.map(cost=>`<article><div><b>${escText(cost.wo_no||'دستورکار')}</b><span>${money(cost.amount)}</span></div><p>${formatDate(cost.at)}</p></article>`).join('')}</div></section>`);
      return sections.join('')||empty('تراکنش درخواست، دستورکار، قطعه یا هزینهٔ قابل انتساب ثبت نشده است.');
    }
    if(E.tab==='monitoring'){
      const health=a.health_score==null?notRecorded:`${faText(a.health_score)} از ۱۰۰`;
      const downtime=(a.downtimes||[]).filter(item=>Number.isFinite(Number(item.hours)));
      const reliabilityEnough=failures.length>=2&&downtime.length>=2&&Number(a.hours)>0;
      return`<section class="eqv2-section-heading"><div><span>دادهٔ مشاهده‌شده، بدون شاخص ساختگی</span><h2>پایش تجهیز</h2><p>شاخص‌های قابل محاسبه فقط با شواهد واقعی ارائه می‌شوند؛ در غیر این صورت «ثبت نشده» نمایش داده می‌شود.</p></div></section>${cards([
        ['شاخص سلامت ثبت‌شده',health],['وضعیت بهره‌برداری',escText(a.operational_status)],
        ['دستورکار باز',a.open_wo==null?notRecorded:faText(a.open_wo)],
        ['آخرین اجرای PM',a.last_run?formatDate(a.last_run):notRecorded],
        ['MTBF / MTTR / دسترس‌پذیری',reliabilityEnough?'محاسبهٔ مرحله‌ای در دسترس نیست':'N/A — شواهد زمانی کافی نیست']
      ])}`;
    }
    if(E.tab==='risk'){
      const risks=Array.isArray(ext.risks)?ext.risks:[];
      const opportunities=Array.isArray(ext.opportunities)?ext.opportunities:[];
      const causeItems=failures.filter(item=>item.cause||item.effect||item.risk_score!=null);
      const rcaRows=Array.isArray(a.rca)?a.rca.filter(item=>item.root_cause):[];
      const sections=[];
      if(risks.length)sections.push(`<section class="eqv2-subsection"><h3>ریسک‌های ثبت‌شده</h3><div class="eqv2-record-list">${risks.map(risk=>`<article><div><b>${escText(risk.title||risk.risk||risk)}</b><span>${escText(risk.level||risk.status||'')}</span></div><p>${escText(risk.control||risk.mitigation||'کنترل ثبت نشده')}</p></article>`).join('')}</div></section>`);
      if(opportunities.length)sections.push(`<section class="eqv2-subsection"><h3>فرصت‌های ثبت‌شده</h3><div class="eqv2-record-list">${opportunities.map(item=>`<article><div><b>${escText(item.title||item.opportunity||item)}</b><span>${escText(item.status||'')}</span></div><p>${escText(item.description||item.action||'')}</p></article>`).join('')}</div></section>`);
      if(causeItems.length)sections.push(`<section class="eqv2-subsection"><h3>علل و اثرهای ثبت‌شده در سوابق خرابی</h3><div class="eqv2-record-list">${causeItems.map(item=>`<article><div><b>${escText(item.failure_no||'خرابی')}</b><span>امتیاز ثبت‌شده: ${item.risk_score==null?notRecorded:faText(item.risk_score)}</span></div><p>علت: ${escText(item.cause)} · اثر: ${escText(item.effect)}</p></article>`).join('')}</div></section>`);
      if(rcaRows.length)sections.push(`<section class="eqv2-subsection"><h3>تحلیل علت ریشه‌ای ثبت‌شده در دستورکار</h3><div class="eqv2-record-list">${rcaRows.map(item=>`<article class="clickable" onclick="typeof openWO==='function'&&openWO('${escText(item.wo_id)}')"><div><b>${escText(item.wo_no||'دستورکار')}</b><span>${formatDate(item.at)}</span></div><p>علت ثبت‌شده: ${escText(item.root_cause)}</p>${item.action?`<p>اقدام اصلاحی ثبت‌شده: ${escText(item.action)}</p>`:''}<span class="eqv2-go">بازکردن دستورکار ←</span></article>`).join('')}</div></section>`);
      return sections.join('')||empty('ریسک یا فرصت تأییدشده و متصل به این تجهیز ثبت نشده است.');
    }
    return empty('بخش پرونده در دسترس نیست.');
  }
  /* ---------- Phase 2: internal equipment structure (dossier-scoped only) ---------- */
  const STRUCTURE_CHILD_KINDS={equipment:['subsystem'],'sub-equipment':['subsystem'],subsystem:['main-component'],'main-component':['sub-component'],'sub-component':[]};
  const STRUCTURE_KIND_LABEL={subsystem:'زیرسیستم','main-component':'جزء اصلی','sub-component':'جزء فرعی','sub-equipment':'زیرتجهیز قدیمی',equipment:'تجهیز'};
  const STRUCTURE_MESSAGES={
    STRUCTURE_PARENT_KIND_INVALID:'این نوع جزء فقط زیر سطح مجاز خودش تعریف می‌شود.',
    STRUCTURE_NODE_KIND_INVALID:'نوع جزء ساختاری معتبر نیست.',
    PARENT_OUTSIDE_ROOT_EQUIPMENT:'والد انتخاب‌شده داخل پرونده همین تجهیز نیست.',
    TREE_CYCLE:'انتقال باعث چرخه والد/فرزند می‌شود؛ انجام نشد.',
    DUPLICATE_CODE:'این کد ساختاری در محدوده تجهیز تکراری است.',
    HAS_ACTIVE_CHILDREN:'گره دارای فرزند فعال است؛ ابتدا تکلیف فرزندان را مشخص کنید.',
    VERSION_CONFLICT:'رکورد هم‌زمان تغییر کرده است؛ ساختار را تازه‌سازی کنید.',
    ROW_VERSION_REQUIRED:'نسخه رکورد (row_version) لازم است.',
    ARCHIVE_REASON_REQUIRED:'دلیل بایگانی الزامی است.',
    MOVE_REASON_REQUIRED:'دلیل جابه‌جایی الزامی است.',
    RESTORE_REASON_REQUIRED:'دلیل بازیابی الزامی است.',
    CROSS_EQUIPMENT_CONFIRMATION_REQUIRED:'انتقال بین دو تجهیز به تأیید صریح و مجوز ویژه نیاز دارد.',
    INVENTORY_ITEM_NOT_FOUND:'قلم انبار وجود ندارد؛ ایجاد خودکار انجام نمی‌شود.',
    PERMISSION_DENIED:'مجوز این عملیات ساختاری را ندارید.',
    EQUIPMENT_SCOPE_DENIED:'این تجهیز در Scope دسترسی شما نیست.',
    PARENT_ARCHIVED:'والد بایگانی شده است؛ ابتدا والد را بازیابی کنید.',
    STRUCTURE_NODE_NOT_FOUND:'جزء ساختاری پیدا نشد.',
    EQUIPMENT_NOT_FOUND:'این تجهیز در پایگاه‌داده پیدا نشد؛ فهرست تجهیزات را تازه‌سازی کنید.',
    ROOT_EQUIPMENT_NOT_FOUND:'این رکورد تجهیز ریشه‌ای نیست؛ ساختار فقط در پروندهٔ خود تجهیز باز می‌شود.',
    EQUIPMENT_ID_INVALID:'شناسهٔ تجهیز نامعتبر است؛ ساختار فقط با شناسهٔ واقعی رکورد باز می‌شود.',
    STRUCTURE_ROOT_CHANGED:'ساختار هم‌زمان تغییر کرده است؛ دوباره تازه‌سازی کنید.',
    STRUCTURE_FAILED:'ساختار از Backend دریافت نشد؛ دوباره تلاش کنید.',
    SERVER_REQUIRED:'اتصال به Backend برقرار نیست؛ ساختار فقط از سرور خوانده می‌شود.',
    STRUCTURE_NODE_NOT_ARCHIVED:'این جزء بایگانی نشده است.',
    AI_PROVIDER_DISABLED_BY_POLICY:'سرویس تحلیل غیرفعال است؛ پیشنهاد سلن برای ساختار در دسترس نیست. فرم دستی کامل فعال است.',
    AI_PURPOSE_DENIED_BY_POLICY:'سیاست سرور پیشنهاد ساختار را مجاز نکرده است؛ فرم دستی فعال است.',
    CLOUD_CONTEXT_NOT_APPROVED:'ارسال متن به سرویس ابری تأیید نشده است؛ فرم دستی فعال است.',
    NO_CAPABLE_PROVIDER:'N/A — داده کافی برای پیشنهاد ساختار وجود ندارد یا سرویس تحلیل پیکربندی نشده است.',
    DRAFT_INCOMPLETE:'پیشنهاد ناقص است؛ فیلدهای لازم را کامل کنید.',
    DRAFT_CONFLICT:'تعارض پیشنهاد حل نشده است.',
    DRAFT_CLOSED:'این پیش‌نویس بسته شده است.',
    CONFIRMATION_REQUIRED:'تأیید کاربر پیش از ثبت الزامی است.',
    CONFIRMATION_EXPIRED:'مهلت تأیید تمام شده است؛ دوباره تأیید کنید.',
    DUPLICATE_REQUEST:'این عملیات قبلاً با همین شناسه انجام شده است.'
  };
  const structureSay=error=>{const code=error&&(error.payload&&error.payload.error||error.message);toast(STRUCTURE_MESSAGES[code]||('عملیات ساختار انجام نشد: '+(code||'REQUEST_FAILED')),1);};
  function structureAllowedChildren(kind){return STRUCTURE_CHILD_KINDS[kind]||[];}
  function flattenStructure(nodes,out=[]){for(const node of nodes||[]){out.push(node);flattenStructure(node.children,out);}return out;}
  function structureNodeById(id){const st=E.structure;if(!st)return null;if(String(st.root&&st.root.id)===String(id))return {id:st.root.id,code:st.root.code,name:st.root.name,nodeKind:'equipment',rowVersion:st.root.rowVersion,children:st.nodes,path:[]};return flattenStructure(st.nodes).find(node=>String(node.id)===String(id))||null;}
  function structureRowVersion(id){const node=structureNodeById(id);return node?Number(node.rowVersion)||null:null;}
  function structureParentOptions(ctx){
    if(!ctx.structure||!ctx.asset)return[];
    const nodes=flattenStructure(ctx.structure.nodes).filter(node=>structureAllowedChildren(node.nodeKind).length&&!node.archived);
    return[{value:ctx.asset.id,label:`${ctx.asset.code?ctx.asset.code+' — ':''}${ctx.asset.name} (ریشه تجهیز)`},
      ...nodes.map(node=>({value:node.id,label:`${node.code?node.code+' — ':''}${node.name} (${STRUCTURE_KIND_LABEL[node.nodeKind]||node.nodeKind})`}))];
  }
  // The dossier is always keyed by the real PostgreSQL assets.id; the API field is
  // rootEquipmentId, so it is normalized here and never re-derived from a code or local cache.
  function normalizeStructure(id,payload){
    const data=payload&&typeof payload==='object'?payload:{};
    const rootId=data.rootEquipmentId||(data.root&&data.root.id)||id;
    return {...data,rootId,rootEquipmentId:rootId,nodes:Array.isArray(data.nodes)?data.nodes:[],
      capabilities:data.capabilities||{},suggestions:Array.isArray(data.suggestions)?data.suggestions:[],
      diagnostics:Array.isArray(data.diagnostics)?data.diagnostics:[]};
  }
  async function loadStructure(id,options={}){
    if(typeof R().structure!=='function'){E.structure=normalizeStructure(id,{error:'SERVER_REQUIRED'});if(E.tab==='structure')await renderCurrentDetail();return;}
    try{
      const result=await R().structure(id,{includeArchived:E.structureArchived});
      E.structure=normalizeStructure(id,result.data);E.structureError=null;
      if(!options.keepPanel)E.structurePanel=[];
      if(options.focus&&structureNodeById(options.focus))E.structureFocus=options.focus;
    }catch(error){
      E.structureError=(error.payload&&error.payload.error)||error.message||'STRUCTURE_FAILED';
      E.structure=normalizeStructure(id,{error:E.structureError});
    }
    if(E.tab==='structure')await renderCurrentDetail();
  }
  function queueStructureLoad(id){
    if(E.structureLoading)return;
    E.structureLoading=true;
    setTimeout(()=>{loadStructure(id).finally(()=>{E.structureLoading=false;});},0);
  }
  function structureCrumb(){
    const st=E.structure;if(!st||!st.root)return'';
    const chain=[{id:st.root.id,name:st.root.name||st.root.code,nodeKind:'equipment'}];
    for(const nodeId of E.structurePanel||[]){const node=structureNodeById(nodeId);if(node)chain.push(node);}
    return`<nav class="eqv2-structure-crumbs" aria-label="مسیر سطح جاری ساختار">${chain.map((node,index)=>`<button type="button" class="${index===chain.length-1?'current':''}" onclick="eqv2StructureCrumb(${index})">${escText(node.name||node.code||'')}</button>`).join('<i aria-hidden="true">›</i>')}</nav>`;
  }
  function structureInventoryCard(node){
    const item=node&&node.inventoryItem;
    if(!node)return'';
    if(!item)return`<div class="eqv2-structure-inventory"><b>اتصال به Master Data انبار</b><span>قلم انبار متصل نشده است؛ اتصال فقط از طریق جستجوی قلم واقعی انجام می‌شود.</span></div>`;
    return`<div class="eqv2-structure-inventory"><b>قلم واقعی انبار: ${escText(item.code||'')} — ${escText(item.name||'')}</b>
      <span>موجودی قابل دسترس (فقط از دفتر انبار): ${faText(item.available==null?0:item.available)} ${escText(item.unit||'')}</span>
      <span>شماره قطعه: ${escText(item.partNumber||'ثبت نشده')} · برند/سازنده: ${escText(item.manufacturer||'ثبت نشده')} · مشخصات: ${escText(item.specification||'ثبت نشده')}</span></div>`;
  }
  const STRUCTURE_COLUMNS=['نام','کد','نوع','برند / سازنده','مدل','شماره قطعه','تعداد','وضعیت','بحرانیت',
    'قلم انبار مرتبط','موجودی واقعی','آخرین خرید','تأمین‌کننده آخرین خرید','عملیات'];
  function structureCell(value){return value==null||value===''?'<span class="eqv2-na">—</span>':escText(String(value));}
  function faDate(value){
    if(!value)return null;
    const date=new Date(value);
    if(Number.isNaN(date.getTime()))return null;
    try{return new Intl.DateTimeFormat('fa-IR',{dateStyle:'short'}).format(date);}catch(_){return date.toLocaleDateString();}
  }
  function structureStockCell(node){
    if(!node.inventoryItemId&&!node.inventoryItem)return '<span class="eqv2-na">ثبت نشده</span>';
    const value=node.stockAvailable==null?(node.inventoryItem&&node.inventoryItem.available):node.stockAvailable;
    const unit=(node.inventoryItem&&node.inventoryItem.unit)||node.unit||'';
    if(value==null)return '<span class="eqv2-na">ثبت نشده</span>';
    const reserved=node.stockReserved==null?0:node.stockReserved;
    return `<b>${faText(value)}</b> ${escText(unit)}${reserved?` <span class="muted">(رزرو ${faText(reserved)})</span>`:''}`;
  }
  function structurePurchaseCell(node){
    const purchase=node.lastPurchase;
    if(!purchase||!purchase.at)return '<span class="eqv2-na">ثبت نشده</span>';
    return `${escText(faDate(purchase.at)||'')} <span class="muted">${escText(purchase.entryNo||'')}</span>`;
  }
  function structureSupplierCell(node){
    // A real receipt in inventory_ledger carries no supplier, so nothing is invented.
    if(!node.lastPurchase)return '<span class="eqv2-na">ثبت نشده</span>';
    return node.lastPurchase.supplier?escText(node.lastPurchase.supplier):'<span class="eqv2-na">ثبت نشده</span>';
  }
  function structureInventoryCell(node){
    const item=node.inventoryItem;
    if(!item)return '<span class="eqv2-na">ثبت نشده</span>';
    return `<span title="${escText(item.name||'')}">${escText(item.code||'—')}</span>`;
  }
  function structureRowActions(node,caps,canChild){
    return `<button type="button" class="btn btn-sm btn-ghost" onclick="eqv2StructureFocus('${escText(node.id)}')">مشاهده جزئیات</button>
      ${canChild&&!node.archived?`<button type="button" class="btn btn-sm btn-ghost" onclick="eqv2StructureAdd('${escText(node.id)}')">افزودن فرزند</button>`:''}
      ${caps.update&&!node.archived?`<button type="button" class="btn btn-sm btn-ghost" onclick="eqv2StructureEdit('${escText(node.id)}')">ویرایش</button>`:''}
      ${(caps.move||caps.moveAcrossEquipment)&&!node.archived?`<button type="button" class="btn btn-sm btn-ghost" onclick="eqv2StructureMove('${escText(node.id)}')">جابه‌جایی</button>`:''}
      ${caps.archive&&!node.archived?`<button type="button" class="btn btn-sm btn-danger" onclick="eqv2StructureArchive('${escText(node.id)}')">بایگانی</button>`:''}
      ${caps.archive&&node.archived?`<button type="button" class="btn btn-sm btn-ghost" onclick="eqv2StructureRestore('${escText(node.id)}')">بازیابی</button>`:''}`;
  }
  function structureRowCells(node,caps,level){
    const children=node.children||[];
    const canChild=caps.create&&structureAllowedChildren(node.nodeKind).length>0;
    const expanded=E.structureExpanded[node.id]!==false;
    const brand=node.brand||node.manufacturer||node.inventoryItem&&node.inventoryItem.manufacturer||node.maker||null;
    const partNumber=node.partNumber||(node.inventoryItem&&node.inventoryItem.partNumber)||null;
    const quantity=node.requiredQuantity==null?null:faText(node.requiredQuantity)+(node.unit?' '+node.unit:'');
    return `<tr class="eqv2-structure-tr${node.archived?' is-archived':''}${node.validRelation===false?' is-invalid':''}" data-structure-node="${escText(node.id)}">
      <td class="eqv2-structure-name" style="--eqv2-level:${Math.max(level,0)}">
        ${children.length?`<button type="button" class="eqv2-structure-toggle" aria-expanded="${expanded}" aria-label="${expanded?'بستن':'باز کردن'} زیرمجموعه‌های ${escText(node.name||node.code||'')}" onclick="eqv2StructureToggle('${escText(node.id)}')">${expanded?'▾':'◂'}</button>`:'<span class="eqv2-structure-leaf" aria-hidden="true"></span>'}
        <b>${escText(node.name||'بدون نام')}</b>
        ${node.archived?'<span class="badge b-orange">بایگانی</span>':''}
        ${node.validRelation===false?'<span class="badge b-orange">رابطه ناسازگار ثبت‌شده</span>':''}
      </td>
      <td>${structureCell(node.code)}</td>
      <td>${structureCell(STRUCTURE_KIND_LABEL[node.nodeKind]||node.nodeKind)}</td>
      <td>${structureCell(brand)}</td>
      <td>${structureCell(node.model)}</td>
      <td>${structureCell(partNumber)}</td>
      <td>${quantity==null?'<span class="eqv2-na">ثبت نشده</span>':escText(quantity)}</td>
      <td>${structureCell(node.status)}</td>
      <td>${structureCell(node.crit)}</td>
      <td>${structureInventoryCell(node)}</td>
      <td class="eqv2-structure-stock">${structureStockCell(node)}</td>
      <td>${structurePurchaseCell(node)}</td>
      <td>${structureSupplierCell(node)}</td>
      <td class="eqv2-structure-actions">${structureRowActions(node,caps,canChild)}</td>
    </tr>${expanded&&children.length?children.map(child=>structureRowCells(child,caps,level+1)).join(''):''}`;
  }
  function structureTable(nodes,caps){
    return `<div class="eqv2-structure-table-wrap"><table class="eqv2-structure-table">
      <thead><tr>${STRUCTURE_COLUMNS.map((column,index)=>`<th${index===0?' class="eqv2-structure-name"':''}${index===STRUCTURE_COLUMNS.length-1?' class="eqv2-structure-actions"':''}>${escText(column)}</th>`).join('')}</tr></thead>
      <tbody>${nodes.map(node=>structureRowCells(node,caps,0)).join('')}</tbody></table></div>`;
  }
  function structureToggle(id){
    E.structureExpanded[id]=E.structureExpanded[id]===false;
    if(E.tab==='structure')renderCurrentDetail();
  }
  function structureEmptyState(caps){
    return `<div class="eqv2-empty eqv2-structure-empty"><div><i>—</i>
      <div>این تجهیز هنوز زیرسیستم، قطعه اصلی یا زیرقطعه‌ای ثبت نشده دارد.</div>
      <div class="muted">هیچ ساختاری خودکار یا آزمایشی ساخته نمی‌شود؛ اولین سطح را خودتان ثبت کنید.</div>
      ${caps.create?`<button type="button" class="btn btn-primary" onclick="eqv2StructureAddRoot()">افزودن زیرسیستم</button>`:''}</div></div>`;
  }
  function structureAddRoot(){
    const st=E.structure;
    if(!st||!st.root)return;
    structureAdd(st.root.id);
  }
  function structureSuggestionPanel(){
    const st=E.structure;if(!st)return'';
    const caps=st.capabilities||{};
    if(!caps.suggest&&!caps.approveAi)return'';
    const rows=(st.suggestions||[]).map(draft=>{
      const proposed=draft.proposed||{};
      const parent=proposed.parentId?structureNodeById(proposed.parentId):null;
      return`<article class="eqv2-structure-suggestion">
        <div><b>${escText(STRUCTURE_KIND_LABEL[proposed.nodeKind]||proposed.nodeKind||'')}</b> — ${escText(proposed.name||'بدون نام')}
          <span class="eqv2-code">${escText(proposed.code||'کد پیشنهادی ندارد')}</span></div>
        <p>والد پیشنهادی: ${escText(parent?(parent.name||parent.code):'ریشه تجهیز')} · توضیح: ${escText(proposed.explanation||'توضیح ثبت نشده')}</p>
        <p>منبع: ${escText((draft.source&&draft.source.kind)||'ثبت نشده')}/${escText((draft.source&&draft.source.ref)||'')} · اطمینان: ${draft.confidence==null?notRecorded:faText(Math.round(draft.confidence*100))+'٪'} · وضعیت: ${escText(draft.status||'')}</p>
        <p>شواهد: ${faText((draft.evidence||[]).length)} مورد · فیلدهای ناقص: ${(draft.missingFields||[]).length?escText(draft.missingFields.join('، ')):'ندارد'}</p>
        <div class="eqv2-structure-actions">
          ${caps.update?`<button type="button" class="btn btn-sm btn-ghost" onclick="eqv2StructureEditSuggestion('${escText(draft.id)}')">ویرایش</button>`:''}
          ${caps.approveAi?`<button type="button" class="btn btn-sm btn-primary" onclick="eqv2StructureApprove('${escText(draft.id)}')">تأیید و ثبت کنترل‌شده</button>
          <button type="button" class="btn btn-sm btn-ghost" onclick="eqv2StructureReject('${escText(draft.id)}')">رد</button>`:''}
        </div></article>`;
    }).join('');
    return`<section class="eqv2-subsection eqv2-structure-suggestions"><h3>پیشنهاد سلن برای ساختار</h3>
      <p class="muted">سلن فقط پیش‌نویس پیشنهاد می‌دهد؛ هیچ پیشنهادی بدون تأیید شما ثبت نمی‌شود و کد یا قطعهٔ ناموجود حدس زده نمی‌شود.</p>
      ${caps.suggest?`<button type="button" class="btn btn-sm btn-ghost" onclick="eqv2StructureSuggest()">پیشنهاد سلن</button>`:''}
      ${E.structureSuggestNotice?`<div class="eqv2-wizard-note">${escText(STRUCTURE_MESSAGES[E.structureSuggestNotice]||E.structureSuggestNotice)}</div>`:''}
      ${rows||'<div class="eqv2-wizard-note">پیش‌نویس پیشنهادی باز نیست.</div>'}</section>`;
  }
  function structureSection(a){
    const st=E.structure;
    if(!st||String(st.rootId)!==String(a.id)){
      queueStructureLoad(a.id);
      return`<section class="eqv2-section-heading"><div><span>ساختار داخلی پرونده همین تجهیز</span><h2>ساختار</h2><p>زیرسیستم‌ها، قطعات اصلی و زیرقطعات فقط داخل پرونده همین تجهیز مدیریت می‌شوند؛ رجیستری اصلی فهرست جامع و مسطح باقی می‌ماند.</p></div></section><div class="eqv2-loading">در حال دریافت ساختار تجهیز…</div>`;
    }
    if(st.error){
      return`<section class="eqv2-section-heading"><div><span>ساختار داخلی پرونده همین تجهیز</span><h2>ساختار</h2><p>${escText(STRUCTURE_MESSAGES[st.error]||'ساختار از Backend دریافت نشد؛ دوباره تلاش کنید.')}</p></div></section>${empty('ساختار تجهیز در دسترس نیست.')}`;
    }
    const caps=st.capabilities||{};
    const focusNode=E.structureFocus?structureNodeById(E.structureFocus):null;
    const levelNode=focusNode||structureNodeById((E.structurePanel||[]).at(-1))||{id:st.root.id,children:st.nodes,nodeKind:'equipment',name:st.root.name};
    const levelChildren=levelNode.children||[];
    const heading=`<section class="eqv2-section-heading"><div><span>ساختار داخلی پرونده همین تجهیز</span><h2>ساختار</h2><p>زیرسیستم ← قطعه اصلی ← زیرقطعه؛ فقط داخل پرونده همین تجهیز. رجیستری اصلی فهرست جامع و مسطح باقی می‌ماند و اجزای داخلی در آن نمایش داده نمی‌شوند.</p></div>
      <div class="eqv2-section-actions">
        ${canDo('edit')?`<button type="button" class="btn btn-sm btn-primary" onclick="eqv2OpenWizard('${escText(a.id)}','structure','structure')">ویرایش ساختار</button>`:''}
        ${caps.create?`<button type="button" class="btn btn-sm btn-ghost" onclick="eqv2StructureAdd('${escText(levelNode.id)}')">＋ افزودن جزء</button>`:''}
        ${caps.archive?`<button type="button" class="btn btn-sm btn-ghost" onclick="eqv2StructureArchivedToggle()">${E.structureArchived?'نمایش فعال‌ها':'نمایش بایگانی'}</button>`:''}
      </div></section>`;
    const focusCard=focusNode?`<section class="eqv2-structure-panel" aria-label="پنل جزئیات جزء ساختاری">
      <div class="eqv2-structure-panel-head"><b>جزئیات: ${escText(focusNode.name||focusNode.code||'')}</b>
        <button type="button" class="btn btn-sm btn-ghost" onclick="eqv2StructureClose()">بستن / بازگشت به سطح قبلی</button></div>
      <div class="eqv2-detail-grid">
        ${[['نوع',STRUCTURE_KIND_LABEL[focusNode.nodeKind]||focusNode.nodeKind],['کد',focusNode.code],['نام',focusNode.name],
          ['نوع قطعه',focusNode.componentType],['برند',focusNode.brand],['سازنده',focusNode.manufacturer||focusNode.maker],
          ['مدل',focusNode.model],['شماره قطعه',focusNode.partNumber],['تعداد',focusNode.requiredQuantity==null?null:faText(focusNode.requiredQuantity)+(focusNode.unit?' '+focusNode.unit:'')],
          ['وضعیت',focusNode.status],['بحرانیت',focusNode.crit],['تعداد فرزند فعال',faText((focusNode.children||[]).length)],
          ['قلم انبار مرتبط',focusNode.inventoryItem?`${focusNode.inventoryItem.code||''} — ${focusNode.inventoryItem.name||''}`:null],
          ['موجودی واقعی (از دفتر انبار)',focusNode.stockAvailable==null?null:faText(focusNode.stockAvailable)+((focusNode.inventoryItem&&focusNode.inventoryItem.unit)?' '+(focusNode.inventoryItem.unit||''):'')],
          ['آخرین خرید',focusNode.lastPurchase?faDate(focusNode.lastPurchase.at):null],
          ['تأمین‌کننده آخرین خرید',focusNode.lastPurchase?focusNode.lastPurchase.supplier:null]
        ].map(([key,value])=>`<div class="eqv2-info-card"><span>${escText(key)}</span><b>${value==null||value===''?'—':escText(value)}</b></div>`).join('')}
      </div>
      <div class="eqv2-detail-grid"><div class="eqv2-info-card"><span>مشخصات فنی</span><b>${escText(focusNode.technicalSpecification||'ثبت نشده')}</b></div>
        <div class="eqv2-info-card"><span>توضیحات</span><b>${escText(focusNode.structureNotes||'ثبت نشده')}</b></div></div>
      ${structureInventoryCard(focusNode)}
      ${Array.isArray(focusNode.diagnostics)&&focusNode.diagnostics.length?`<div class="eqv2-wizard-note">${focusNode.diagnostics.map(item=>escText(item.message)).join(' ')}</div>`:''}
    </section>`:'';
    return`${heading}${structureCrumb()}${focusCard}
      <div class="eqv2-structure-level"><b>سطح جاری: ${escText(STRUCTURE_KIND_LABEL[levelNode.nodeKind]||levelNode.nodeKind||'')} — ${escText(levelNode.name||levelNode.code||'')}</b>
      <span class="muted">${faText((levelNode.children||[]).length)} جزء در این سطح</span></div>
      ${levelChildren.length?structureTable(levelChildren,caps):(E.structureArchived?empty('جزء بایگانی‌شده‌ای ثبت نشده است.'):structureEmptyState(caps))}
      ${structureSuggestionPanel()}`;
  }
  async function refreshStructure(options={}){
    const rootId=E.structure&&E.structure.rootId;
    if(rootId)await loadStructure(rootId,{keepPanel:true,...options});
  }
  async function structureAdd(parentId){
    const st=E.structure;if(!st||!st.capabilities.create){toast('مجوز ایجاد جزء ساختاری را ندارید',1);return;}
    const parent=structureNodeById(parentId)||structureNodeById(st.root.id);
    if(!parent)return;
    openStructureWizard({mode:'create',parent});
  }
  async function structureEdit(nodeId){
    const st=E.structure;if(!st||!st.capabilities.update){toast('مجوز ویرایش ساختار را ندارید',1);return;}
    const node=structureNodeById(nodeId);if(!node)return;
    const parent=structureNodeById(node.parentId)||structureNodeById(st.root.id);
    openStructureWizard({mode:'edit',node,parent});
  }
  function structureWizardSteps(ctx){
    const kindOptions=ctx.mode==='create'
      ?structureAllowedChildren(ctx.parent.nodeKind).map(kind=>({value:kind,label:STRUCTURE_KIND_LABEL[kind]}))
      :[{value:ctx.node.nodeKind,label:STRUCTURE_KIND_LABEL[ctx.node.nodeKind]}];
    const statusOptions=Object.entries(typeof AS_ST==='undefined'?{}:AS_ST).map(([value,row])=>({value,label:row[0]}));
    let wizardApi=null;
    const steps=[
      {id:'structureNode',kind:'group',title:'ساختار داخلی',description:'مرحله ۱ — نوع جزء بر اساس سطح والد محدود می‌شود و والد فعلی مشخص است.',fields:[
        {id:'nodeKind',kind:'select',label:'نوع جزء',required:true,options:()=>kindOptions,help:ctx.mode==='create'?`والد: ${ctx.parent.name||ctx.parent.code} — فقط این نوع‌ها مجازند.`:'نوع جزء پس از ثبت تغییر نمی‌کند.'},
        {id:'name',kind:'text',label:'نام',required:true,maxLength:240},
        {id:'code',kind:'text',label:'کد',maxLength:120,help:'کد در محدوده همین تجهیز باید یکتا باشد.'},
        {id:'componentType',kind:'text',label:'نوع / نوع قطعه',maxLength:240},
        {id:'brand',kind:'text',label:'برند',maxLength:180},
        {id:'manufacturer',kind:'text',label:'سازنده',maxLength:180},
        {id:'model',kind:'text',label:'مدل',maxLength:180},
        {id:'partNumber',kind:'text',label:'شماره قطعه',maxLength:180}
      ],afterRender:()=>`<div class="eqv2-structure-evidence"><b>والد فعلی</b><p>${escText(ctx.parent.name||ctx.parent.code||'')} — ${escText(STRUCTURE_KIND_LABEL[ctx.parent.nodeKind]||ctx.parent.nodeKind||'')}</p><span>ساختار فقط داخل پرونده همین تجهیز ثبت می‌شود.</span></div>`},
      {id:'structureQuantity',kind:'group',title:'ساختار داخلی',description:'مرحله ۲ — وضعیت، بحرانیّت و تعداد.',fields:[
        {id:'requiredQuantity',kind:'number',label:'تعداد',min:0,step:0.001},
        {id:'unit',kind:'text',label:'واحد تعداد',maxLength:40},
        {id:'status',kind:'select',label:'وضعیت',options:()=>statusOptions},
        {id:'crit',kind:'select',label:'بحرانیت',options:[{value:'A',label:'A'},{value:'B',label:'B'},{value:'C',label:'C'}]}
      ]},
      {id:'structureSpec',kind:'group',title:'ساختار داخلی',description:'مرحله ۳ — مشخصات فنی و توضیحات؛ مقدار ثبت‌نشده حدس زده نمی‌شود.',fields:[
        {id:'technicalSpecification',kind:'textarea',label:'مشخصات فنی',rows:3,maxLength:4000},
        {id:'structureNotes',kind:'textarea',label:'توضیحات',rows:2,maxLength:4000}
      ]},
      {id:'structureInventory',kind:'group',title:'اتصال به Master Data انبار',description:'مرحله ۴ — اتصال اختیاری به قلم واقعی انبار؛ موجودی تایپ دستی نمی‌شود.',renderOnChange:true,fields:[
        {id:'inventoryQuery',kind:'text',label:'جستجوی قلم انبار (نام، کد، شماره قطعه، برند، مشخصات)',maxLength:120,renderOnChange:true,onChange:async({value})=>{
          clearTimeout(steps.inventoryTimer);
          steps.inventoryTimer=setTimeout(async()=>{
            try{
              const result=await R().inventoryItems(String(value||'').trim());
              E.inventoryOptions=(result.data||[]).map(item=>({value:item.id,label:`${item.code} — ${item.name} · موجودی واقعی (دفتر انبار): ${item.available} ${item.unit||''} · آخرین خرید: ${item.lastPurchaseAt?faDate(item.lastPurchaseAt):'ثبت نشده'}`}));
            }catch(error){E.inventoryOptions=[];}
            wizardApi&&wizardApi.render();
          },250);
        }},
        {id:'inventoryItemId',kind:'select',label:'قلم واقعی انبار',options:()=>E.inventoryOptions||[],help:'انتخاب قلم، Part ID واقعی را ذخیره می‌کند؛ ایجاد خودکار قلم انجام نمی‌شود.'}
      ],afterRender:wizardContext=>{
        const chosen=(E.inventoryOptions||[]).find(item=>String(item.value)===String(wizardContext.answers.inventoryItemId||''));
        return chosen?`<div class="eqv2-wizard-note">قلم انتخاب‌شده: ${escText(chosen.label)} — مشخصات قلم انبار بدون تأیید شما اطلاعات ساختاری را بازنویسی نمی‌کند.</div>`:'<div class="eqv2-wizard-note">اگر قلم وجود ندارد، از مسیر رسمی انبار درخواست ایجاد قلم بدهید و پس از ایجاد، همان شناسه را اینجا متصل کنید.</div>';
      }}
    ];
    steps.setWizard=api=>{wizardApi=api;};
    return steps;
  }
  function structureInitialAnswers(mode,parent,node,prefill){
    const source=mode==='edit'?node:(prefill||{});
    if(mode==='edit')return{
      nodeKind:node.nodeKind,name:node.name||'',code:node.code||'',componentType:node.componentType||'',
      brand:node.brand||'',manufacturer:node.manufacturer||node.maker||'',model:node.model||'',partNumber:node.partNumber||'',
      requiredQuantity:node.requiredQuantity==null?'':node.requiredQuantity,unit:node.unit||'',status:node.status||'',crit:node.crit||'',
      technicalSpecification:node.technicalSpecification||'',structureNotes:node.structureNotes||'',
      inventoryItemId:node.inventoryItemId||'',inventoryQuery:''
    };
    return{
      nodeKind:structureAllowedChildren(parent.nodeKind).includes(source.nodeKind)?source.nodeKind:(structureAllowedChildren(parent.nodeKind)[0]||''),
      name:source.name||'',code:source.code||'',componentType:source.componentType||'',brand:source.brand||'',
      manufacturer:source.manufacturer||'',model:source.model||'',partNumber:source.partNumber||'',
      requiredQuantity:source.requiredQuantity==null?'':source.requiredQuantity,unit:source.unit||'',
      status:source.status||'',crit:source.crit||'',technicalSpecification:source.technicalSpecification||'',
      structureNotes:source.structureNotes||source.explanation||'',inventoryItemId:source.inventoryItemId||'',inventoryQuery:''
    };
  }
  function openStructureWizard({mode,parent,node=null,prefill=null}){
    const st=E.structure;
    if(!st)return;
    if(!window.BFGStepWizard||!window.BFGEquipmentWizardAdapter){toast('موتور مشترک ویزارد بارگذاری نشده است.',1);return;}
    if(E.wizard)return;
    const ctx={mode,parent,node,rootId:st.root.id};
    const steps=structureWizardSteps(ctx);
    const initial=structureInitialAnswers(mode,parent,node,prefill);
    modal(mhead(mode==='edit'?'ویرایش جزء ساختاری':'افزودن جزء ساختاری')+`<div class="m-body eqv2-wizard-modal"><div id="eqv2StructureWizardHost"></div></div>`,true);
    const host=document.getElementById('eqv2StructureWizardHost');if(!host)return;
    E.wizard={allowClose:false,closePending:false,instance:null,structureWizard:true};
    installWizardCloseGuard();
    const wizard=window.BFGEquipmentWizardAdapter.create({
      root:host,
      title:mode==='edit'?'ویرایش جزء ساختاری':'افزودن جزء ساختاری',
      contract:{resource:'equipment',version:window.BFGEquipmentWizardAdapter.CONTRACT_VERSION,steps},
      initialAnswers:initial,
      persistDraft:async()=>undefined,
      confirmText:'این جزء ساختاری را بررسی و تأیید می‌کنم.',
      submitLabel:mode==='edit'?'ثبت ویرایش در PostgreSQL':'ثبت جزء در PostgreSQL',
      confirmSubmit:async()=>window.confirm('پس از این تأیید، جزء ساختاری در Backend ثبت می‌شود. ادامه می‌دهید؟'),
      onPersistenceError:()=>{},
      submit:async({answers})=>{
        const payload={
          rootEquipmentId:ctx.rootId,nodeKind:String(answers.nodeKind||''),name:String(answers.name||'').trim(),
          code:String(answers.code||'').trim()||null,componentType:answers.componentType||null,brand:answers.brand||null,
          manufacturer:answers.manufacturer||null,model:answers.model||null,partNumber:answers.partNumber||null,
          requiredQuantity:answers.requiredQuantity===''||answers.requiredQuantity==null?null:Number(answers.requiredQuantity),
          unit:answers.unit||null,status:answers.status||null,crit:answers.crit||null,
          technicalSpecification:answers.technicalSpecification||null,structureNotes:answers.structureNotes||null,
          inventoryItemId:answers.inventoryItemId||null
        };
        let saved;
        if(mode==='edit'){
          saved=await R().structureUpdate(node.id,{...payload,rowVersion:Number(node.rowVersion)});
        }else{
          saved=await R().structureCreate({...payload,parentId:parent.id,parentRowVersion:Number(parent.rowVersion)});
        }
        if(!saved||!saved.data)throw Object.assign(new Error('NOT_COMMITTED'),{payload:{error:'NOT_COMMITTED'}});
        if(E.structurePendingReject){
          const draftId=E.structurePendingReject;E.structurePendingReject=null;
          await R().actionReject(draftId).catch(()=>{});
        }
        E.wizard.allowClose=true;window.closeModal();
        toast('جزء ساختاری پس از commit در PostgreSQL ثبت شد.');
        E.structureFocus=mode==='edit'?node.id:saved.data.id;
        await refreshStructure({focus:E.structureFocus});
      },
      onSubmitError:error=>{structureSay(error);},
      onCancel:async()=>{
        if(!window.confirm('ویزارد بسته شود؟ تغییرهای تأییدنشده ذخیره نمی‌شوند.'))return;
        E.wizard.allowClose=true;window.closeModal();
      }
    });
    steps.setWizard(wizard);
    E.wizard.instance=wizard;
  }
  function structureMoveModal(nodeId){
    const st=E.structure;if(!st)return;
    const node=structureNodeById(nodeId);if(!node)return;
    const candidates=[{id:st.root.id,name:st.root.name||st.root.code,nodeKind:'equipment',path:[]},...flattenStructure(st.nodes)]
      .filter(item=>structureAllowedChildren(item.nodeKind).includes(node.nodeKind))
      .filter(item=>String(item.id)!==String(node.id))
      .filter(item=>!(item.path||[]).some(step=>String(step.id||step)===String(node.id)))
      .filter(item=>!item.archived);
    modal(mhead('جابه‌جایی جزء ساختاری')+`<div class="m-body">
      <div class="eqv2-wizard-note">والد مقصد باید از نظر سطح مجاز باشد و چرخه والد/فرزند ایجاد نکند. جابه‌جایی در Audit ثبت می‌شود و روابط تاریخی حفظ می‌ماند.</div>
      <div class="field"><label>والد مقصد *</label><select id="stMoveParent">${candidates.map(item=>`<option value="${escText(item.id)}">${escText((item.code?item.code+' — ':'')+item.name)} (${escText(STRUCTURE_KIND_LABEL[item.nodeKind]||item.nodeKind)})</option>`).join('')||'<option value="">والد مجازی پیدا نشد</option>'}</select></div>
      ${st.capabilities.moveAcrossEquipment?`<label class="checkline"><input type="checkbox" id="stMoveCross"> انتقال به تجهیز دیگر (مجوز ویژه + تأیید صریح)</label>
      <div class="field"><label>کد یا نام تجهیز مقصد</label><input id="stMoveCrossQuery" placeholder="جستجوی تجهیز مقصد…"><button type="button" class="btn btn-sm btn-ghost" onclick="eqv2StructureCrossSearch()">جستجو</button></div>
      <div class="field"><label>تجهیز مقصد</label><select id="stMoveCrossRoot"><option value="">— تجهیز جاری —</option></select></div>
      <label class="checkline"><input type="checkbox" id="stMoveCrossConfirm"> انتقال بین دو تجهیز را صریحاً تأیید می‌کنم</label>`:''}
      <div class="field"><label>دلیل جابه‌جایی *</label><textarea id="stMoveReason" rows="2"></textarea></div>
      <div class="m-foot"><button class="btn btn-primary" onclick="eqv2StructureMoveSubmit('${escText(node.id)}')">ثبت جابه‌جایی</button><button class="btn btn-ghost" onclick="closeModal()">انصراف</button></div></div>`,true);
  }
  async function structureCrossSearch(){
    const q=String(document.getElementById('stMoveCrossQuery')?.value||'').trim();
    if(!q)return;
    try{
      const result=await R().list({q,limit:10});
      const select=document.getElementById('stMoveCrossRoot');
      if(select)select.innerHTML='<option value="">— تجهیز جاری —</option>'+(result.data||[]).map(row=>`<option value="${escText(row.id)}">${escText(row.code+' — '+row.name)}</option>`).join('');
    }catch(error){structureSay(error);}
  }
  async function structureMoveSubmit(nodeId){
    const st=E.structure;if(!st)return;
    const node=structureNodeById(nodeId);if(!node)return;
    const reason=String(document.getElementById('stMoveReason')?.value||'').trim();
    const cross=document.getElementById('stMoveCross')?.checked;
    const crossRoot=document.getElementById('stMoveCrossRoot')?.value||'';
    const payload={rowVersion:Number(node.rowVersion),reason};
    if(cross&&crossRoot){
      if(!document.getElementById('stMoveCrossConfirm')?.checked){toast(STRUCTURE_MESSAGES.CROSS_EQUIPMENT_CONFIRMATION_REQUIRED,1);return;}
      try{
        const other=await R().structure(crossRoot);
        const candidates=[{id:other.data.root.id,nodeKind:'equipment',path:[]},...flattenStructure(other.data.nodes)];
        const select=window.prompt('شناسه والد مقصد را از ساختار تجهیز مقصد وارد کنید:','');
        const parent=candidates.find(item=>String(item.id)===String(select));
        if(!parent){toast('والد مقصد در تجهیز مقصد پیدا نشد.',1);return;}
        payload.parentId=parent.id;payload.confirmCrossEquipment=true;
      }catch(error){structureSay(error);return;}
    }else{
      payload.parentId=document.getElementById('stMoveParent')?.value||'';
    }
    if(!payload.parentId){toast('والد مقصد را انتخاب کنید.',1);return;}
    try{
      await R().structureMove(node.id,payload);
      closeModal();toast('جابه‌جایی در Backend ثبت شد و روابط تاریخی حفظ ماند.');
      await refreshStructure({keepPanel:true});
    }catch(error){structureSay(error);}
  }
  async function structureArchive(nodeId){
    const st=E.structure;if(!st)return;
    const node=structureNodeById(nodeId);if(!node)return;
    const reason=prompt('دلیل بایگانی جزء ساختاری (الزامی):');
    if(!reason||!reason.trim())return;
    try{
      await R().structureArchive(node.id,reason.trim(),Number(node.rowVersion));
      toast('جزء بایگانی شد؛ سابقه و روابط تاریخی حفظ شد.');
      await refreshStructure({keepPanel:true});
    }catch(error){structureSay(error);}
  }
  async function structureRestore(nodeId){
    const st=E.structure;if(!st)return;
    const node=structureNodeById(nodeId);if(!node)return;
    const reason=prompt('دلیل بازیابی جزء بایگانی‌شده (الزامی):');
    if(!reason||!reason.trim())return;
    try{
      await R().structureRestore(node.id,{reason:reason.trim(),rowVersion:Number(node.rowVersion)});
      toast('جزء با مجوز و Audit بازیابی شد.');
      await refreshStructure({keepPanel:true});
    }catch(error){structureSay(error);}
  }
  async function structureSuggest(){
    const st=E.structure;if(!st)return;
    E.structureSuggestNotice=null;
    try{
      const result=await R().structureSuggestions(st.rootId);
      if(result.data&&result.data.notice)E.structureSuggestNotice=result.data.notice;
      await refreshStructure({keepPanel:true});
      if(!result.data.notice)toast('پیشنهادها فقط به‌صورت پیش‌نویس ثبت شدند؛ بدون تأیید شما چیزی اعمال نمی‌شود.');
    }catch(error){structureSay(error);}
  }
  async function structureApprove(draftId){
    try{
      const confirmation=await R().actionConfirm(draftId);
      const requestId=window.crypto&&window.crypto.randomUUID?window.crypto.randomUUID():`st-${draftId}-${Date.now()}`;
      const result=await R().actionExecute(draftId,{confirmationId:confirmation.data.id,requestId});
      if(!result||result.committed!==true)throw Object.assign(new Error('NOT_COMMITTED'),{payload:{error:'NOT_COMMITTED'}});
      toast('پیشنهاد پس از تأیید شما و بررسی دوباره مجوز ثبت شد.');
      await refreshStructure({keepPanel:true});
    }catch(error){structureSay(error);}
  }
  async function structureReject(draftId){
    try{
      await R().actionReject(draftId);
      await refreshStructure({keepPanel:true});
    }catch(error){structureSay(error);}
  }
  function structureEditSuggestion(draftId){
    const draft=(E.structure&&E.structure.suggestions||[]).find(item=>item.id===draftId);
    if(!draft)return;
    const proposed=draft.proposed||{};
    const parent=proposed.parentId?structureNodeById(proposed.parentId):structureNodeById(E.structure.root.id);
    if(!parent)return;
    E.structurePendingReject=draftId;
    openStructureWizard({mode:'create',parent,prefill:proposed});
  }
  function structureFocusNode(id){
    const node=structureNodeById(id);if(!node)return;
    E.structurePanel=((node.path||[]).map(step=>step.id||step).filter(stepId=>String(stepId)!==String(id)));
    E.structureFocus=id;
    renderCurrentDetail().catch(showError);
  }
  function structureClosePanel(){
    if(E.structureFocus){E.structureFocus=null;}
    else E.structurePanel=(E.structurePanel||[]).slice(0,-1);
    renderCurrentDetail().catch(showError);
  }
  function structureCrumbTo(index){
    E.structurePanel=(E.structurePanel||[]).slice(0,index);
    E.structureFocus=null;
    renderCurrentDetail().catch(showError);
  }
  async function structureArchivedToggle(){
    E.structureArchived=!E.structureArchived;
    await refreshStructure({keepPanel:true});
  }

  function routeKey(){const match=location.pathname.match(/^\/equipment\/([^/]+)\/?$/);return match?decodeURIComponent(match[1]):null;}
  async function openDetail(idOrCode,{push=true,fromRoute=false}={}){
    if(!equipmentModuleAllowed())return;
    if(E.routeBusy)return;E.routeBusy=true;
    try{
      if(!E.detail)captureExplorerState();
      E.detail=true;E.tab='technical';
      const content=document.getElementById('content');if(content)content.innerHTML='<div class="eqv2-loading">در حال بازکردن پرونده تجهیز…</div>';
      const {data:a}=await R().get(idOrCode);E.selected=a.id;E.detailKey=a.code||a.id;saveState();
      const target='/equipment/'+encodeURIComponent(E.detailKey);
      if(push&&location.pathname!==target)history.pushState({equipment:true,key:E.detailKey},'',target);
      else if(fromRoute&&location.pathname!==target)history.replaceState({equipment:true,key:E.detailKey},'',target);
      if(content)content.innerHTML=detailPage(a);window.scrollTo(0,0);
    }catch(error){E.detail=false;showError(error);}finally{E.routeBusy=false;}
  }
  function openIntake(equipmentId=E.selected||null){
    if(!equipmentModuleAllowed())return;
    const main=document.querySelector('.eqv2-main')||document.getElementById('content');if(!main)return;
    E.intakeReturn={detail:E.detail,detailKey:E.detailKey,tab:E.tab||'technical'};
    main.innerHTML='<div id="seleneMount" class="selene-mount"></div>';
    if(window.BFGSelene)window.BFGSelene.mount(document.getElementById('seleneMount'),{equipmentId:equipmentId||null});
  }
  async function renderCurrentDetail(){
    if(!E.detailKey)return;
    const {data:a}=await R().get(E.detailKey),body=document.getElementById('eqv2DetailBody');
    if(body)body.innerHTML=detailBody(a);
    const header=document.querySelector('.eqv2-detail-header');if(header)header.outerHTML=detailHeader(a);
    document.querySelectorAll('.eqv2-detail-tabs button').forEach((button,index)=>{
      const on=DETAIL_TABS[index]?.[0]===E.tab;button.classList.toggle('on',on);button.setAttribute('aria-selected',String(on));
    });
  }
  async function backToEquipment({historyMode='push'}={}){
    E.detail=false;E.detailKey=null;E.view='list';if(historyMode==='push')history.pushState({equipmentExplorer:true},'','/');
    const content=document.getElementById('content');if(!content)return;content.innerHTML=shell();await initExplorer(true);restoreExplorerScroll();
  }
  async function restoreRoute(){if(!equipmentModuleAllowed())return false;const key=routeKey();if(!key||!ME)return false;CUR='equipment';buildMenu();document.getElementById('sidebar')?.classList.remove('open');await openDetail(key,{push:false,fromRoute:true});return true;}

  function filter(key,value){E[key]=value;if(key==='factoryId')E.categoryId='';E.page=1;saveState();const toolbarNode=document.querySelector('.eqv2-toolbar');if(toolbarNode)toolbarNode.outerHTML=toolbar();load().then(restoreExplorerScroll).catch(showError);}
  function view(){captureExplorerState();E.view='list';E.page=1;saveState();document.getElementById('content').innerHTML=shell();initExplorer(true);}
  function pageTo(value){E.page=Math.max(1,value);saveState();load().then(restoreExplorerScroll).catch(showError);}
  function search(value){clearTimeout(search.timer);E.q=value;E.page=1;saveState();search.timer=setTimeout(()=>load().then(restoreExplorerScroll).catch(showError),250);}
  function sortBy(key){const mapped=sortKey(key);E.direction=E.sort===mapped&&E.direction==='asc'?'desc':'asc';E.sort=mapped;saveState();load().catch(showError);}
  function closeSummary(){E.selected=null;saveState();const panel=document.getElementById('eqv2Summary');if(panel)panel.innerHTML=empty('تجهیزی انتخاب نشده است.');}

  const WIZARD_STEPS=[
    {id:'initialDetails',title:'مشخصات اولیه'},
    {id:'structure',title:'ساختار داخلی'},
    {id:'maintenance',title:'برنامه نگهداری'}
  ];
  const NODE_OPTIONS=[
    {value:'equipment',label:'تجهیز'}, {value:'sub-equipment',label:'زیرتجهیز'},
    {value:'subsystem',label:'زیرسیستم'}, {value:'main-component',label:'جزء اصلی'},
    {value:'sub-component',label:'جزء فرعی'}
  ];
  const OPERATIONAL_OPTIONS=[
    {value:'in_service',label:'در سرویس'}, {value:'standby',label:'آماده‌به‌کار'},
    {value:'out_of_service',label:'خارج از سرویس'}, {value:'reserved',label:'رزرو'},
    {value:'decommissioned',label:'از رده خارج'}
  ];
  const pad=value=>String(value).padStart(2,'0');
  function dateAnswer(value){
    const engine=window.BFGStepWizard;if(!value||!engine)return{date:''};
    const text=String(value).trim();
    const isoDate=text.match(/^(\d{4}-\d{2}-\d{2})/);
    if(isoDate)return engine.isoToJalaliInput(isoDate[1]);
    if(engine.parseJalaliDate(text))return{date:engine.toPersianDigits(text.replace(/-/g,'/'))};
    return{date:''};
  }
  function dateToIso(value){
    const engine=window.BFGStepWizard,parts=engine&&value&&engine.parseJalaliDate(value.date||'');
    if(!parts)return null;
    return`${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  }
  function arrayText(value){return Array.isArray(value)?value.join('، '):String(value||'');}
  function splitParts(value){return String(value||'').split(/[،,\n]/).map(item=>item.trim()).filter(Boolean).slice(0,40);}
  function asNum(value){return value===''||value==null?null:Number(value);}
  function canonicalFromAsset(asset){
    const ext=asset.ext||{},factoryFromPath=(asset.path||[]).find(item=>(item.nodeKind||item.node_kind)==='factory');
    return{
      name:asset.name||'',code:asset.code||'',nodeKind:ext.nodeKind||asset.node_kind||'equipment',
      activityType:asset.activity_type||asset.activityType||'',maker:asset.maker||'',
      manufacturerCountry:asset.manufacturer_country||asset.manufacturerCountry||'',model:asset.model||'',
      serial:asset.serial||'',year:asset.year||'',installDate:asset.install_date||asset.installDate||null,
      power:asset.power||'',hours:asset.hours==null?'':String(asset.hours),cls:asset.cls||'',status:asset.status||'',
      operationalStatus:asset.operational_status||asset.operationalStatus||'',crit:asset.crit||'',
      capacity:ext.capacity||asset.capacity||'',locationDescription:ext.locationDescription||'',
      functionDescription:ext.description||'',technicalSpecification:ext.technicalSpecification||'',
      panelCode:ext.panelCode||'',refrigerant:ext.refrigerant||'',
      dailyOperatingHours:ext.dailyOperatingHours==null?'':String(ext.dailyOperatingHours),
      criticalityScore:ext.criticalityScore==null?'':String(ext.criticalityScore),keyParts:arrayText(ext.keyParts),
      generalNotes:asset.general_notes||asset.generalNotes||'',responsibleUserId:asset.responsible_user_id||asset.responsibleUserId||'',
      factoryId:asset.factory_id||asset.factoryId||factoryFromPath?.id||'',
      categoryId:asset.category_id||asset.categoryId||'',locationId:asset.parent||asset.parentId||''
    };
  }
  function answersFromAsset(asset,record){
    const answers=canonicalFromAsset(asset||{});
    answers.installDate=dateAnswer(answers.installDate||asset?.install||'');
    if(record){
      const suggested={
        name:record.name,code:record.code,nodeKind:record.nodeKind,activityType:record.activityType,
        maker:record.maker,manufacturerCountry:record.manufacturerCountry,model:record.model,serial:record.serial,
        year:record.year,power:record.power,cls:record.cls,status:record.status,
        operationalStatus:record.operationalStatus,crit:record.crit,capacity:record.capacity,
        locationDescription:record.location,functionDescription:record.notes,
        technicalSpecification:record.technicalSpecification,panelCode:record.panelCode,refrigerant:record.refrigerant,
        dailyOperatingHours:record.dailyOperatingHours,criticalityScore:record.criticalityScore,
        keyParts:record.keyParts==null?undefined:arrayText(record.keyParts),hours:record.hours,
        generalNotes:record.generalNotes
      };
      for(const [key,value] of Object.entries(suggested))if(value!=null&&value!=='')answers[key]=value;
      const rawDate=record.installDate||record.install;
      if(rawDate){const converted=dateAnswer(rawDate);if(converted.date)answers.installDate=converted;else answers.__rawInstallDate=String(rawDate);}
    }
    if(!answers.nodeKind)answers.nodeKind='equipment';
    if(!asset&&answers.factoryId==null)answers.factoryId='';
    if(!asset&&answers.categoryId==null)answers.categoryId='';
    if(!asset&&answers.locationId==null)answers.locationId='';
    return answers;
  }
  function payloadFromAnswers(answers,isNew){
    const payload={
      nodeKind:String(answers.nodeKind||'equipment'),name:String(answers.name||'').trim(),code:String(answers.code||'').trim(),
      activityType:answers.activityType||null,maker:answers.maker||null,manufacturerCountry:answers.manufacturerCountry||null,
      model:answers.model||null,serial:answers.serial||null,year:answers.year||null,
      installDate:dateToIso(answers.installDate),power:answers.power||null,hours:asNum(answers.hours),
      cls:answers.cls||null,status:answers.status||null,operationalStatus:answers.operationalStatus||null,
      crit:answers.crit||null,capacity:answers.capacity||null,locationDescription:answers.locationDescription||null,
      functionDescription:answers.functionDescription||null,technicalSpecification:answers.technicalSpecification||null,
      panelCode:answers.panelCode||null,refrigerant:answers.refrigerant||null,
      dailyOperatingHours:asNum(answers.dailyOperatingHours),criticalityScore:asNum(answers.criticalityScore),
      keyParts:splitParts(answers.keyParts),generalNotes:answers.generalNotes||null,
      responsibleUserId:answers.responsibleUserId||null,
      factoryId:answers.factoryId||null,categoryId:answers.categoryId||null,
      locationId:answers.locationId||answers.factoryId||null
    };
    if(isNew)payload.recordStatus='complete';
    return payload;
  }
  function baselineField(asset,key){
    const ext=asset.ext||{};
    const map={
      activityType:asset.activity_type,manufacturerCountry:asset.manufacturer_country,installDate:asset.install_date,
      operationalStatus:asset.operational_status,generalNotes:asset.general_notes,responsibleUserId:asset.responsible_user_id,
      capacity:ext.capacity,locationDescription:ext.locationDescription,functionDescription:ext.description,
      technicalSpecification:ext.technicalSpecification,panelCode:ext.panelCode,refrigerant:ext.refrigerant,
      dailyOperatingHours:ext.dailyOperatingHours,criticalityScore:ext.criticalityScore,keyParts:ext.keyParts,
      factoryId:asset.factory_id,categoryId:asset.category_id,locationId:asset.parent||asset.factory_id
    };
    return map[key]!==undefined?map[key]:asset[key];
  }
  function sameValue(a,b){
    if(Array.isArray(a)||Array.isArray(b))return JSON.stringify(a||[])===JSON.stringify(b||[]);
    if(a==null||a==='')return b==null||b==='';if(b==null||b==='')return a==null||a==='';
    if(typeof a==='number'||typeof b==='number')return Number(a)===Number(b);
    return String(a)===String(b);
  }
  function changedPayload(payload,asset){
    const changed={};
    for(const [key,value] of Object.entries(payload)){
      if(key==='nodeKind')continue;
      if(key==='recordStatus'){
        const current=asset.record_status||asset.recordStatus||'complete';
        if(value==='complete'&&current!=='complete')changed.recordStatus='complete';
        continue;
      }
      if(value==null||value==='')continue;
      if(!sameValue(value,baselineField(asset,key)))changed[key]=value;
    }
    return changed;
  }
  function conflictKeys(answers,current){
    if(!current)return[];
    const proposed=payloadFromAnswers(answers,false),keys=['name','code','maker','model','serial','year','installDate','power','cls','status','crit','locationDescription','functionDescription','technicalSpecification','capacity','panelCode','refrigerant','activityType','manufacturerCountry','operationalStatus','responsibleUserId','generalNotes'];
    return keys.filter(key=>proposed[key]!=null&&proposed[key]!==''&&current[key]!=null&&current[key]!==''&&!sameValue(proposed[key],current[key]));
  }
  function conflictPanel(ctx){
    if(!ctx.selene||!ctx.actionCurrent)return'';
    const fields=conflictKeys(ctx.answers,ctx.actionCurrent);
    if(!fields.length)return'<div class="eqv2-wizard-note">تعارضی با مقدار ثبت‌شده دیده نمی‌شود؛ داده‌های پیشنهادی همچنان نیازمند بازبینی شما هستند.</div>';
    return`<section class="eqv2-conflict-panel"><b>تعارض با رکورد فعلی — تأیید صریح لازم است</b>${fields.map(key=>{
      const label=({name:'نام تجهیز',code:'کد تجهیز',maker:'سازنده',model:'مدل',serial:'سریال',year:'سال ساخت',installDate:'تاریخ نصب',power:'توان',cls:'کلاس',status:'وضعیت فنی',crit:'بحرانیت',locationDescription:'محل توصیفی',functionDescription:'شرح عملکرد',technicalSpecification:'مشخصات فنی',capacity:'ظرفیت',panelCode:'تابلو برق',refrigerant:'نوع مبرد',activityType:'نوع فعالیت',manufacturerCountry:'کشور سازنده',operationalStatus:'وضعیت بهره‌برداری',responsibleUserId:'مسئول تجهیز',generalNotes:'ملاحظات عمومی'})[key]||key;
      const accepted=!!ctx.answers[`acceptConflict:${key}`];
      return`<label class="eqv2-conflict-row"><span><b>${label}</b><small>ثبت‌شده: ${escText(ctx.actionCurrent[key])} · پیشنهادی: ${escText(ctx.answers[key])}</small></span><input type="checkbox" data-sw-field="acceptConflict:${key}" ${accepted?'checked':''}><em>جایگزینی را تأیید می‌کنم</em></label>`;
    }).join('')}</section>`;
  }
  function wizardSteps(ctx){
    const selectedParent=ctx.asset&&ctx.asset.parent?ctx.asset.parent:'';
    const locations=[...(E.options.locations||[])];
    if(selectedParent&&!locations.some(item=>String(item.id)===String(selectedParent)))locations.push({id:selectedParent,name:ctx.asset.parent_name||ctx.asset.location_name||'محل فعلی',factory_id:ctx.asset.factory_id||null,node_kind:'current'});
    const statusOptions=Object.entries(typeof AS_ST==='undefined'?{}:AS_ST).map(([value,row])=>({value,label:row[0]}));
    if(ctx.asset?.status&&!statusOptions.some(item=>item.value===ctx.asset.status))statusOptions.push({value:ctx.asset.status,label:ctx.asset.status});
    const steps=[
      {id:'initialDetails',kind:'group',title:'مشخصات اولیه',description:'نام و کد الزامی است. سایر مشخصات فقط با داده واقعی تکمیل می‌شوند.',fields:[
        {id:'code',kind:'text',label:'کد تجهیز',required:true,maxLength:120},
        {id:'name',kind:'text',label:'نام تجهیز',required:true,maxLength:240},
        {id:'nodeKind',kind:'select',label:'نوع رکورد',required:true,options:()=>NODE_OPTIONS,help:'نوع تجهیز یا جزء ساختاری را با توجه به رکورد واقعی انتخاب کنید.'},
        {id:'activityType',kind:'text',label:'نوع فعالیت',maxLength:180},
        {id:'maker',kind:'text',label:'سازنده',maxLength:180},
        {id:'manufacturerCountry',kind:'text',label:'کشور سازنده',maxLength:120},
        {id:'model',kind:'text',label:'مدل',maxLength:180},
        {id:'serial',kind:'text',label:'شماره سریال',maxLength:180},
        {id:'year',kind:'text',label:'سال ساخت',maxLength:16},
        {id:'installDate',kind:'jalali-date',label:'تاریخ نصب شمسی',help:'در Backend به تاریخ میلادی/DATE تبدیل می‌شود.'},
        {id:'power',kind:'text',label:'توان',maxLength:120},
        {id:'capacity',kind:'text',label:'ظرفیت'},
        {id:'status',kind:'select',label:'وضعیت فنی',options:()=>statusOptions},
        {id:'operationalStatus',kind:'select',label:'وضعیت بهره‌برداری',options:()=>OPERATIONAL_OPTIONS},
        {id:'crit',kind:'select',label:'بحرانیت',options:[{value:'A',label:'A'},{value:'B',label:'B'},{value:'C',label:'C'}]},
        {id:'hours',kind:'number',label:'کارکرد تجمعی',min:0,step:0.1},
        {id:'responsibleUserId',kind:'select',label:'مسئول تجهیز',options:()=>[
          ...(E.options.responsibleUsers||[]).map(user=>({value:user.id,label:`${user.name}${user.role?' — '+user.role:''}`}))
        ]},
        {id:'locationDescription',kind:'text',label:'محل توصیفی',maxLength:1000},
        {id:'functionDescription',kind:'textarea',label:'شرح عملکرد',rows:3,maxLength:1000},
        {id:'technicalSpecification',kind:'textarea',label:'مشخصات فنی',rows:4,maxLength:1000},
        {id:'generalNotes',kind:'textarea',label:'ملاحظات عمومی',rows:3,maxLength:4000},
        {id:'panelCode',kind:'text',label:'کد تابلو برق',maxLength:1000},
        {id:'refrigerant',kind:'text',label:'نوع مبرد',maxLength:1000},
        {id:'dailyOperatingHours',kind:'number',label:'ساعت کارکرد روزانه',min:0,max:24,step:0.1},
        {id:'criticalityScore',kind:'number',label:'امتیاز بحرانی ثبت‌شده',min:0,max:100,step:1},
        {id:'keyParts',kind:'textarea',label:'قطعات کلیدی (متن پرونده، نه قلم انبار)',rows:2,maxLength:1000}
      ],afterRender:wizardContext=>`${ctx.selene?`<div class="eqv2-wizard-evidence"><b>پیشنهاد سلن</b><span>منبع: ${escText(ctx.sourceLabel||'ورودی سلن')} · وضعیت اطمینان: ${ctx.confidence==null?'ثبت نشده':faText(Math.round(ctx.confidence*100))+'٪'}</span><small>هیچ پیشنهادی تا تأیید نهایی شما در تجهیز اعمال نمی‌شود.</small></div>${ctx.rawInstall?`<div class="eqv2-wizard-note">تاریخ استخراج‌شده «${escText(ctx.rawInstall)}» به تاریخ شمسی معتبر تبدیل نشد؛ مقدار در پایگاه تغییر نمی‌کند مگر آن را اصلاح کنید.</div>`:''}${conflictPanel({...ctx,answers:wizardContext.answers})}`:''}`},
      {id:'structure',kind:'group',title:'ساختار داخلی',description:'مرحله ۲ از ۳ — مسیر و اجزای موجود را بررسی کنید؛ افزودن زیرسیستم، قطعه اصلی یا زیرقطعه نیز از همین مرحله انجام می‌شود.',renderOnChange:true,fields:[
        {id:'factoryId',kind:'select',label:'کارخانه',options:()=>[
          ...(E.options.factories||[]).map(factory=>({value:factory.id,label:`${factory.code?factory.code+' — ':''}${factory.name}`}))
        ],renderOnChange:true,onChange:({answers,value,previous})=>{
          if(previous!==value){
            const category=E.options.categories.find(item=>String(item.id)===String(answers.categoryId));
            if(category&&value&&String(category.factory_id)!==String(value))answers.categoryId='';
            const location=locations.find(item=>String(item.id)===String(answers.locationId));
            if(location&&value&&location.factory_id&&String(location.factory_id)!==String(value))answers.locationId='';
          }
        }},
        {id:'categoryId',kind:'select',label:'دسته تجهیز',options:answers=>(E.options.categories||[]).filter(item=>!answers.factoryId||String(item.factory_id)===String(answers.factoryId)).map(item=>({value:item.id,label:`${item.code?item.code+' — ':''}${item.name}`}))},
        {id:'locationId',kind:'select',label:'محل / گره والد موجود',options:answers=>locations.filter(item=>!answers.factoryId||!item.factory_id||String(item.factory_id)===String(answers.factoryId)).map(item=>({value:item.id,label:`${item.code?item.code+' — ':''}${item.name}`}))},
        {id:'newChildParent',kind:'select',label:'والد جزء ساختاری جدید (اختیاری)',options:()=>structureParentOptions(ctx),renderOnChange:true,help:'زیرسیستم فقط زیر تجهیز، قطعه اصلی فقط زیر زیرسیستم و زیرقطعه فقط زیر قطعه اصلی ثبت می‌شود.',onChange:({answers,value,previous})=>{
          if(previous!==value&&!structureParentOptions(ctx).some(item=>item.value===value))answers.newChildParent='';
          const parentKind=value===ctx.asset?.id?'equipment':(structureNodeById(value)?.nodeKind||'equipment');
          if(!structureAllowedChildren(parentKind).includes(answers.newChildKind))answers.newChildKind='';
        }},
        {id:'newChildKind',kind:'select',label:'نوع جزء جدید',options:answers=>{
          const parentKind=!answers.newChildParent||answers.newChildParent===ctx.asset?.id?'equipment':(structureNodeById(answers.newChildParent)?.nodeKind||'equipment');
          return structureAllowedChildren(parentKind).map(kind=>({value:kind,label:STRUCTURE_KIND_LABEL[kind]}));
        },help:'نوع بر اساس سطح والد محدود می‌شود.'},
        {id:'newChildName',kind:'text',label:'نام جزء جدید',maxLength:240},
        {id:'newChildCode',kind:'text',label:'کد جزء جدید',maxLength:120}
      ],afterRender:()=>{
        const nodes=ctx.structure?flattenStructure(ctx.structure.nodes):[];
        const list=nodes.length?`<ul class="eqv2-checklist">${nodes.map(node=>`<li>${escText(STRUCTURE_KIND_LABEL[node.nodeKind]||node.nodeKind||'')} — ${escText(node.name||'بدون نام')} (${escText(node.code||'بدون کد')}) · فرزندان: ${faText((node.children||[]).length)}</li>`).join('')}</ul>`:'';
        return`<div class="eqv2-structure-evidence"><b>ساختار ثبت‌شده</b><p>${ctx.asset?(ctx.asset.path||[]).map(item=>escText(item.name||item.code)).join(' ← ')||notRecorded:'تجهیز جدید است؛ والد یا دسته‌ای به‌صورت خودکار انتخاب نشده است.'}</p><span>${ctx.structure?`${faText(nodes.length)} جزء داخلی ثبت‌شده — فقط داخل پرونده همین تجهیز`: ctx.asset?`${faText((ctx.asset.children||[]).length)} جزء فعال متصل به رکورد`: 'هیچ رابطه‌ای بدون انتخاب شما ساخته نمی‌شود.'}</span>${list}${ctx.structureError?`<span>ساختار از Backend دریافت نشد؛ افزودن جزء در این مرحله غیرفعال است.</span>`:''}</div>`;
      }},
      {id:'maintenance',kind:'custom',title:'برنامه نگهداری',description:'مرحله ۳ از ۳ — قابلیت‌های واقعی PM و چک‌لیست فعلی فقط برای بررسی نمایش داده می‌شوند؛ توسعه پیشرفته در فاز بعدی است.',summary:()=>ctx.asset?`${faText((ctx.asset.pm_plans||[]).length)} برنامه واقعی — بدون تغییر`: 'برنامه PM به‌صورت خودکار ساخته نمی‌شود',render:()=>{
        const plans=ctx.asset?.pm_plans||[];
        const html=plans.length?`<div class="eqv2-wizard-pm-list">${plans.map(plan=>`<article><b>${escText(plan.title||'برنامه PM')}</b><span>${plan.interval_days?faText(plan.interval_days)+' روز':notRecorded}</span><small>آخرین اجرا: ${plan.last_run?formatDate(plan.last_run):'ثبت نشده'} · چک‌لیست: ${faText((plan.checklist||[]).length)} مورد</small></article>`).join('')}</div>`:'<div class="eqv2-wizard-note">برای این تجهیز برنامه PM ثبت نشده است.</div>';
        return`<div class="eqv2-wizard-maintenance"><div class="eqv2-wizard-note">در این فاز PM موجود حذف یا بازنویسی نمی‌شود. ویرایش برنامه و اجرای چک‌لیست از مسیرهای فعلی maintenance-service انجام می‌شود.</div>${html}</div>`;
      }}
    ];
    return steps;
  }
  function installWizardCloseGuard(){
    if(E.closeGuardInstalled||typeof window.closeModal!=='function')return;
    const original=window.closeModal;
    window.closeModal=function(...args){
      const active=E.wizard;
      if(active&&!active.allowClose){
        if(!active.closePending&&active.instance){active.closePending=true;Promise.resolve(active.instance.cancel()).catch(()=>{}).finally(()=>{active.closePending=false;});}
        return;
      }
      if(active){active.allowClose=false;active.instance?.destroy();E.wizard=null;}
      return original.apply(this,args);
    };
    E.closeGuardInstalled=true;
  }
  function setWizardMessage(message){
    const active=E.wizard;if(!active?.instance)return;
    active.instance.state.message=message;active.instance.render();
  }
  function acceptedConflicts(answers){
    return Object.keys(answers||{}).filter(key=>key.startsWith('acceptConflict:')&&answers[key]).map(key=>key.slice('acceptConflict:'.length));
  }
  function evidenceForAction(ctx,payload){
    const existing=Array.isArray(ctx.actionDraft?.evidence)?ctx.actionDraft.evidence.slice():[];
    const sourceRef=ctx.actionDraft?.source?.ref||ctx.sessionId||'user-review';
    for(const [field,value] of Object.entries(payload)){
      if(value==null||value==='')continue;
      const previous=existing.find(item=>item.field===field&&sameValue(item.value,value));
      if(!previous)existing.push({field,value,origin:'user-confirmed-form',sourceRef});
    }
    return existing.slice(0,80);
  }
  async function executeSeleneDraft(ctx,payload,answers){
    const currentVersion=ctx.asset?Number(ctx.asset.row_version||ctx.asset.rowVersion):null;
    if(ctx.actionDraft.actionType==='equipment.complete'&&(!Number.isInteger(currentVersion)||currentVersion<1))throw Object.assign(new Error('ROW_VERSION_REQUIRED'),{payload:{error:'ROW_VERSION_REQUIRED'}});
    const update=await window.bfgApi('/api/equipment/actions/drafts/'+encodeURIComponent(ctx.actionDraft.id),{
      method:'PATCH',body:JSON.stringify({
        rowVersion:ctx.actionDraft.rowVersion,proposed:payload,source:ctx.actionDraft.source,
        evidence:evidenceForAction(ctx,payload),confidence:ctx.actionDraft.confidence,
        current:ctx.actionCurrent||null,acceptConflicts:acceptedConflicts(answers),
        targetId:ctx.actionDraft.targetId,recordVersion:currentVersion
      })
    });
    ctx.actionDraft=update.data;
    if(!ctx.actionDraft||ctx.actionDraft.status!=='pending'){
      const code=ctx.actionDraft?.status==='conflict'?'DRAFT_CONFLICT':'DRAFT_INCOMPLETE';
      throw Object.assign(new Error(code),{payload:{error:code}});
    }
    const confirmation=await window.bfgApi('/api/equipment/actions/drafts/'+encodeURIComponent(ctx.actionDraft.id)+'/confirm',{method:'POST',body:'{}'});
    const requestId=window.crypto?.randomUUID?window.crypto.randomUUID():`eq-${ctx.actionDraft.id}-${Date.now()}`;
    const result=await window.bfgApi('/api/equipment/actions/drafts/'+encodeURIComponent(ctx.actionDraft.id)+'/execute',{
      method:'POST',body:JSON.stringify({confirmationId:confirmation.data.id,requestId})
    });
    if(!result||result.committed!==true)throw Object.assign(new Error('NOT_COMMITTED'),{payload:{error:'NOT_COMMITTED'}});
    return result.data;
  }
  async function returnAfterWizard(ctx,saved,isNew){
    const id=saved?.id||ctx.asset?.id;
    if(!id){await backToEquipment();return;}
    const key=saved?.code||ctx.asset?.code||id;
    if(ctx.returnContext.detail||ctx.selene){
      await openDetail(key,{push:!ctx.returnContext.detail,fromRoute:false});
      E.tab=ctx.returnTab||'technical';
      await renderCurrentDetail();
    }else if(isNew){
      await load();
      await openDetail(key,{push:true});
      E.tab='technical';await renderCurrentDetail();
    }else{
      await load();await select(id,false);
    }
  }
  async function openWizard(idOrOptions=null,step='initial',returnTab=null){
    const opts=idOrOptions&&typeof idOrOptions==='object'?idOrOptions:{id:idOrOptions,startStep:step,returnTab};
    const isSelene=opts.source==='selene';
    const existingId=opts.id||opts.targetId||null;
    if(existingId&&!canDo('edit')){toast('مجوز ویرایش تجهیز را ندارید',1);return;}
    if(!existingId&&!isSelene&&!canDo('create')){toast('مجوز ثبت تجهیز را ندارید',1);return;}
    if(R().source!=='postgresql'){toast('برای ثبت یا ویرایش تجهیز اتصال به Backend الزامی است؛ هیچ داده‌ای به‌صورت محلی ذخیره نمی‌شود.',1);return;}
    if(!window.BFGEquipmentWizardAdapter||!window.BFGStepWizard){toast('موتور مشترک ویزارد بارگذاری نشده است.',1);return;}
    if(E.wizard)return;
    try{
      E.options=await R().filters();
      let asset=null;
      if(existingId){asset=opts.asset||null;if(!asset)asset=(await R().get(existingId)).data;}
      let structureData=null;
      if(existingId&&opts.source!=='selene'){try{structureData=(await R().structure(existingId)).data;}catch(_){structureData=null;}}
      const actionDraft=opts.actionDraft||null;
      const actionCurrent=opts.current||null;
      const record=opts.record||null;
      const answers=answersFromAsset(asset,record);
      const startId=opts.startStep==='structure'?'structure':opts.startStep==='maintenance'?'maintenance':'initialDetails';
      const ctx={
        asset,record,selene:isSelene,actionDraft,actionCurrent,sessionId:opts.sessionId||null,structure:structureData,
        confidence:record?.confidence??actionDraft?.confidence??null,
        sourceLabel:opts.provider==='column-match'?'ستون‌های فایل':opts.provider==='deepseek'?'پیشنهاد مدل DeepSeek':opts.provider==='local'?'پیشنهاد مدل محلی':'ورودی سلن',
        rawInstall:answers.__rawInstallDate||null,returnTab:opts.returnTab||E.intakeReturn?.tab||E.tab||'technical',
        returnContext:{detail:E.detail,detailKey:E.detailKey,tab:E.tab||'technical'},instance:null,allowClose:false,closePending:false
      };
      delete answers.__rawInstallDate;
      if(isSelene&&!actionDraft)throw new Error('SELENE_ACTION_DRAFT_REQUIRED');
      const title=asset?'ویرایش پرونده تجهیز':'ثبت تجهیز';
      modal(mhead(title)+`<div class="m-body eqv2-wizard-modal"><div id="eqv2WizardHost"></div></div>`,true);
      const host=document.getElementById('eqv2WizardHost');if(!host)throw new Error('WIZARD_HOST_NOT_FOUND');
      E.wizard=ctx;installWizardCloseGuard();
      const adapterContract={resource:'equipment',version:window.BFGEquipmentWizardAdapter.CONTRACT_VERSION,steps:wizardSteps(ctx)};
      const wizard=window.BFGEquipmentWizardAdapter.create({
        root:host,title,contract:adapterContract,initialAnswers:answers,initialStepId:startId,
        persistDraft:async()=>undefined,
        confirmText:isSelene?'پیشنهاد سلن و همه تغییرهای نمایش‌داده‌شده را برای ذخیره تأیید می‌کنم.':'اطلاعات تجهیز را بررسی و تأیید می‌کنم.',
        submitLabel:isSelene?'تأیید نهایی و ذخیره از مسیر کنترل‌شده':'ثبت در PostgreSQL',
        confirmSubmit:async()=>window.confirm(isSelene?'پس از این تأیید، اقدام کنترل‌شده سلن اجرا و رکورد در Backend ثبت می‌شود. ادامه می‌دهید؟':'پس از این تأیید، اطلاعات تجهیز در Backend ثبت می‌شود. ادامه می‌دهید؟'),
        onPersistenceError:()=>{},
        submit:async({answers:finalAnswers})=>{
          const payload=payloadFromAnswers(finalAnswers,!asset);
          if(asset&&(asset.record_status||asset.recordStatus)==='draft')payload.recordStatus='complete';
          let saved;
          if(isSelene){
            saved=await executeSeleneDraft(ctx,payload,finalAnswers);
          }else if(!asset){
            const result=await R().create(payload);
            if(!result||!result.committed||!result.data)throw Object.assign(new Error('NOT_COMMITTED'),{payload:{error:'NOT_COMMITTED'}});
            saved=result.data;
          }else{
            const changes=changedPayload(payload,asset);
            if(!Object.keys(changes).length){
              toast('تغییری برای ثبت وجود نداشت؛ رکورد دست‌نخورده ماند.');
              ctx.allowClose=true;window.closeModal();return;
            }
            const result=await R().update(asset.id,{...changes,rowVersion:Number(asset.row_version||asset.rowVersion)});
            if(!result||result.committed!==true||!result.data)throw Object.assign(new Error('NOT_COMMITTED'),{payload:{error:'NOT_COMMITTED'}});
            saved=result.data;
          }
          if(asset&&!isSelene&&ctx.structure&&String(finalAnswers.newChildName||'').trim()&&finalAnswers.newChildKind&&finalAnswers.newChildParent){
            const parentId=String(finalAnswers.newChildParent);
            const parentRowVersion=parentId===asset.id?Number(ctx.structure.root&&ctx.structure.root.rowVersion):structureRowVersion(parentId);
            if(parentRowVersion){
              try{
                await R().structureCreate({
                  rootEquipmentId:asset.id,nodeKind:String(finalAnswers.newChildKind),parentId,parentRowVersion,
                  name:String(finalAnswers.newChildName).trim(),code:String(finalAnswers.newChildCode||'').trim()||null
                });
                ctx.returnTab='structure';
              }catch(error){
                toast('تجهیز ثبت شد، اما جزء ساختاری ثبت نشد: '+((error.payload&&error.payload.error)||error.message),1);
              }
            }
          }
          ctx.allowClose=true;window.closeModal();
          toast('تغییرات تجهیز پس از commit در PostgreSQL ثبت شد.');
          await returnAfterWizard(ctx,saved,!asset);
        },
        onSubmitError:error=>{
          const code=error?.payload?.error||error?.message||'EQUIPMENT_SAVE_FAILED';
          if(code==='VERSION_CONFLICT')toast('رکورد هم‌زمان تغییر کرده است؛ داده تازه را بارگذاری و دوباره بازبینی کنید.',1);
          else if(code==='DRAFT_CONFLICT')toast('تعارض داده حل نشده است؛ مقدار فعلی یا پیشنهاد را صریحاً انتخاب کنید.',1);
          else toast('ثبت در PostgreSQL انجام نشد: '+code,1);
        },
        onCancel:async()=>{
          if(!window.confirm('ویزارد بسته شود؟ تغییرهای تأییدنشده ذخیره نمی‌شوند.'))return;
          if(isSelene&&ctx.actionDraft?.id){
            try{await window.bfgApi('/api/equipment/actions/drafts/'+encodeURIComponent(ctx.actionDraft.id)+'/reject',{method:'POST',body:'{}'});}
            catch(error){setWizardMessage('پیش‌نویس سلن رد نشد؛ پنجره باز می‌ماند. '+(error.payload?.error||error.message));return;}
          }
          ctx.allowClose=true;window.closeModal();
          if(ctx.selene&&ctx.returnContext.detail){
            await openDetail(ctx.returnContext.detailKey||E.detailKey,{push:false});E.tab=ctx.returnTab;await renderCurrentDetail();
          }else if(ctx.returnContext.detail){await renderCurrentDetail();}
          else await backToEquipment();
        }
      });
      ctx.instance=wizard;
    }catch(error){
      if(E.wizard){E.wizard.allowClose=true;E.wizard=null;}
      closeModal();
      toast('ساخت ویزارد تجهیز انجام نشد: '+(error.payload?.error||error.message||'خطای نامشخص'),1);
    }
  }
  function create(){return openWizard(null,'initial','technical');}
  function edit(id){return openWizard(id,'initial',E.tab||'technical');}
  async function remove(id){
    const reason=prompt('دلیل بایگانی تجهیز را وارد کنید:');
    if(reason===null||!reason.trim()){if(reason!==null)toast('ثبت دلیل بایگانی الزامی است',1);return;}
    if(!confirm('تجهیز بایگانی شود؟ تمام روابط و سوابق آن حفظ خواهد شد.'))return;
    try{
      const {data}=await R().get(id);const row=await R().remove(id,reason.trim(),Number(data.row_version||data.rowVersion));
      if(!row||!row.data)throw new Error('NOT_COMMITTED');
      toast('تجهیز پس از بایگانی نرم در Backend تأیید شد؛ سوابق حفظ شده‌اند.');E.selected=null;
      if(E.detail)await backToEquipment();else await load();
    }catch(error){toast(error.message==='HAS_ACTIVE_CHILDREN'?'ابتدا فرزندان فعال را منتقل کنید':'بایگانی انجام نشد: '+(error.payload?.error||error.message),1);}
  }
  function columns(){modal(mhead('انتخاب ستون‌های لیست')+`<div class="m-body"><div class="eqv2-check-cols">${Object.entries(COLUMNS).map(([key,label])=>`<label class="eqv2-col-opt"><input type="checkbox" value="${key}" ${E.columns.includes(key)?'checked':''}>${label}</label>`).join('')}</div></div><div class="m-foot"><button class="btn btn-primary" onclick="eqv2SaveColumns()">اعمال</button><button class="btn btn-ghost" onclick="closeModal()">انصراف</button></div>`);}
  function saveColumns(){const selected=[...document.querySelectorAll('.eqv2-col-opt input:checked')].map(x=>x.value);if(!selected.length){toast('حداقل یک ستون انتخاب کنید',1);return;}E.columns=selected;saveState();closeModal();load();}
  function exportCsv(){const rows=[[...E.columns.map(key=>COLUMNS[key])],...E.rows.map(a=>E.columns.map(key=>valueFor(a,key)??''))],csv='\ufeff'+rows.map(row=>row.map(value=>'"'+String(value).replace(/"/g,'""')+'"').join(',')).join('\n'),link=document.createElement('a');link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));link.download='equipment-list.csv';link.click();URL.revokeObjectURL(link.href);}
  function createRelated(kind,equipmentId){
    const selected=String(equipmentId||'');
    if(kind==='request'&&window.BFGMaintenanceWizards&&typeof window.BFGMaintenanceWizards.openRequest==='function'){
      return window.openReqForm({equipmentId:selected});
    }
    if(kind==='wo'&&window.BFGMaintenanceWizards&&typeof window.BFGMaintenanceWizards.openWorkOrder==='function'){
      return window.openWOForm({equipmentId:selected});
    }
    const actions={request:['openReqForm','rqAsset'],wo:['openWOForm','woAsset'],pm:['openPMForm','pmAsset']},entry=actions[kind];
    if(!entry||typeof window[entry[0]]!=='function'){toast('فرم مرتبط در دسترس نیست',1);return;}
    window[entry[0]]();requestAnimationFrame(()=>{const input=document.getElementById(entry[1]);if(input){input.value=selected;input.dispatchEvent(new Event('change',{bubbles:true}));}});
  }
  function showError(error){console.error(error);const main=document.querySelector('.eqv2-main')||document.getElementById('content');if(main)main.innerHTML=`<div class="eqv2-empty"><div><i>⚠️</i><b>خطا در دریافت اطلاعات تجهیزات</b><div>${escText(error.payload?.error||error.message)}</div></div></div>`;if(typeof toast==='function')toast('خطا در بخش تجهیزات: '+(error.payload?.error||error.message),1);}

  window.eqv2Search=search;window.eqv2Filter=filter;window.eqv2View=view;window.eqv2Page=pageTo;window.eqv2Load=load;window.eqv2OpenIntake=openIntake;
  window.eqv2Select=select;window.eqv2Create=create;window.eqv2OpenWizard=openWizard;
  window.eqv2Edit=edit;window.eqv2Delete=remove;window.eqv2Columns=columns;window.eqv2SaveColumns=saveColumns;
  window.eqv2Export=exportCsv;window.eqv2Sort=sortBy;window.eqv2OpenDetail=id=>openDetail(id);window.eqv2BackToEquipment=()=>backToEquipment();
  window.eqv2CloseSummary=closeSummary;window.eqv2DetailTab=async tab=>{if(!DETAIL_TABS.some(item=>item[0]===tab))return;E.tab=tab;await renderCurrentDetail();};window.eqv2Related=createRelated;
  window.eqv2StructureAdd=structureAdd;window.eqv2StructureEdit=structureEdit;window.eqv2StructureMove=structureMoveModal;
  window.eqv2StructureArchive=structureArchive;window.eqv2StructureRestore=structureRestore;window.eqv2StructureFocus=structureFocusNode;
  window.eqv2StructureToggle=structureToggle;window.eqv2StructureAddRoot=structureAddRoot;
  window.eqv2StructureClose=structureClosePanel;window.eqv2StructureCrumb=structureCrumbTo;window.eqv2StructureArchivedToggle=structureArchivedToggle;
  window.eqv2StructureSuggest=structureSuggest;window.eqv2StructureApprove=structureApprove;window.eqv2StructureReject=structureReject;
  window.eqv2StructureEditSuggestion=structureEditSuggestion;window.eqv2StructureMoveSubmit=structureMoveSubmit;window.eqv2StructureCrossSearch=structureCrossSearch;
  window.addEventListener('bfg:domain-event',event=>{
    const payload=event&&event.detail;
    if(!payload||payload.type!=='equipment.structure.changed')return;
    if(!E.detail||E.structure?.rootId!==payload.aggregateId)return;
    refreshStructure({keepPanel:true}).catch(()=>{});
  });

  window.addEventListener('popstate',()=>{const key=routeKey();if(key)openDetail(key,{push:false,fromRoute:true});else if(E.detail)backToEquipment({historyMode:'none'});});

  const classicTreePage=pgTree;
  pgTree=page;
  const previousLogin=doLogin;
  doLogin=function(){previousLogin();if(ME)setTimeout(restoreRoute,250);};
  if(ME)setTimeout(restoreRoute,250);
})();
