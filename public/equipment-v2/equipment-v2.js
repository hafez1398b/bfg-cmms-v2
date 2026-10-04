/* Comprehensive Equipment Registry and digital dossier. The legacy tree is intentionally not exposed. */
(function(){
  'use strict';

  const STORAGE_KEY='bfg_equipment_ui_state_v2';
  const EQUIPMENT_KINDS=new Set(['equipment','sub-equipment','subsystem','main-component','sub-component','main','sub','sys','panel']);
  const DEFAULT_COLUMNS=['code','name','factory','location','category','model','maker','status','crit','health','lastPm','nextPm','openWo','cost'];
  const COLUMNS={code:'کد تجهیز',name:'نام تجهیز',factory:'کارخانه',location:'محل',category:'دسته',model:'مدل',maker:'سازنده',status:'وضعیت',crit:'بحرانیت',health:'سلامت',lastPm:'آخرین PM',nextPm:'PM بعدی',openWo:'WO باز',cost:'هزینه نت'};
  const DETAIL_TABS=[
    ['profile','شناسنامه تجهیز'],['usage','کاربری'],['structure','ساختار / Components'],['maintenance','برنامه نگهداری و تعمیرات'],
    ['checklists','چک‌لیست‌ها و بازرسی‌ها'],['requests','درخواست‌های تعمیر'],['workorders','Work Orders'],
    ['maintenanceHistory','سوابق تعمیرات'],['failures','سوابق خرابی'],['pmHistory','PM History'],
    ['consumedParts','قطعات یدکی مصرف‌شده'],['costs','هزینه‌های تعمیرات'],['downtime','توقفات تجهیز'],
    ['reliability','شاخص‌های قابلیت اطمینان'],['documents','مستندات و فایل‌ها'],['risks','ریسک‌ها'],
    ['rca','RCA / تحلیل خرابی'],['changes','سایر / سابقه تغییرات']
  ];

  const saved=readState();
  const E=window.EQV2={
    view:'list',page:saved.page||1,limit:50,q:saved.q||'',factoryId:saved.factoryId||'',categoryId:saved.categoryId||'',
    status:saved.status||'',criticality:saved.criticality||'',sort:saved.sort||'sortOrder',direction:saved.direction||'asc',
    selected:saved.selected||null,columns:Array.isArray(saved.columns)&&saved.columns.length?saved.columns:DEFAULT_COLUMNS,
    open:new Set(saved.open||[]),scroll:{tree:saved.treeScroll||0,list:saved.listScroll||0,window:saved.windowScroll||0},
    tab:'profile',detail:false,detailKey:null,returnView:'list',rows:[],pagination:null,dragId:null,
    options:{factories:[],categories:[]},routeBusy:false
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
  const nodeKind=a=>a?.ext?.nodeKind||a?.nodeKind||(a?.type==='eq'?'equipment':a?.type==='site'?'factory':'location');
  const hasIdentity=a=>a?.type==='eq'||EQUIPMENT_KINDS.has(nodeKind(a));
  const empty=text=>`<div class="eqv2-empty"><div><i>—</i><div>${escText(text)}</div></div></div>`;

  function readState(){try{return JSON.parse(sessionStorage.getItem(STORAGE_KEY)||'{}');}catch(_){return{};}}
  function saveState(){
    try{sessionStorage.setItem(STORAGE_KEY,JSON.stringify({view:E.view,page:E.page,q:E.q,factoryId:E.factoryId,categoryId:E.categoryId,status:E.status,criticality:E.criticality,sort:E.sort,direction:E.direction,selected:E.selected,columns:E.columns,open:[...E.open],treeScroll:E.scroll.tree,listScroll:E.scroll.list,windowScroll:E.scroll.window}));}catch(_){}
  }
  function captureExplorerState(){
    E.scroll.window=window.scrollY||0;
    const scroller=document.querySelector('.eqv2-table-wrap');
    E.scroll[E.view]=scroller?.scrollTop||0;
    saveState();
  }
  function restoreExplorerScroll(){
    requestAnimationFrame(()=>{
      const scroller=document.querySelector('.eqv2-table-wrap');
      if(scroller)scroller.scrollTop=E.scroll[E.view]||0;
      window.scrollTo(0,E.scroll.window||0);
    });
  }

  function sourceBadge(){const source=R().source;const label=source==='postgresql'?'PostgreSQL · Source of Truth':source==='server-required'?'سرور مرکزی · بدون پایگاه محلی':'حالت سازگاری محلی';return`<span class="eqv2-source ${source==='postgresql'?'':'local'}">${label}</span>`;}
  function shell(){
    return`<div class="eqv2" id="eqv2Explorer"><div class="eqv2-head"><div class="eqv2-title"><small>دارایی‌ها › تجهیزات <span class="eqv2-version">Registry 3.0</span></small><h2>فهرست جامع تجهیزات</h2><p class="eqv2-subtitle">تمام تجهیزات ثبت‌شده در یک فهرست واحد؛ برای مشاهده پرونده دیجیتال، تجهیز را انتخاب کنید.</p></div>${sourceBadge()}${canDo('view')?'<button class="btn btn-sm btn-ghost" onclick="eqv2OpenIntake()">ورود هوشمند</button>':''}${canDo('create')?'<button class="btn btn-sm btn-primary" onclick="eqv2Create()">＋ افزودن تجهیز</button>':''}</div>${toolbar()}<div class="eqv2-layout eqv2-list-only"><section class="eqv2-main"><div class="eqv2-loading">در حال دریافت فهرست تجهیزات…</div></section></div></div>`;
  }
  function toolbar(){
    const factories=E.options.factories.map(x=>`<option value="${escText(x.id)}" ${E.factoryId===x.id?'selected':''}>${escText(x.name)}</option>`).join('');
    const categories=E.options.categories.filter(x=>!E.factoryId||x.factory_id===E.factoryId).map(x=>`<option value="${escText(x.id)}" ${E.categoryId===x.id?'selected':''}>${escText(x.name)}</option>`).join('');
    return`<div class="eqv2-toolbar"><div class="eqv2-search"><span>⌕</span><input value="${escText(E.q)}" placeholder="کد، نام، سریال، مدل یا سازنده…" oninput="eqv2Search(this.value)"></div><select aria-label="کارخانه" onchange="eqv2Filter('factoryId',this.value)"><option value="">همه کارخانه‌ها</option>${factories}</select><select aria-label="دسته" onchange="eqv2Filter('categoryId',this.value)"><option value="">همه دسته‌ها</option>${categories}</select><select aria-label="وضعیت" onchange="eqv2Filter('status',this.value)"><option value="">همه وضعیت‌ها</option>${Object.entries(typeof AS_ST==='undefined'?{}:AS_ST).map(([key,value])=>`<option value="${key}" ${E.status===key?'selected':''}>${value[0]}</option>`).join('')}</select><select aria-label="بحرانیت" onchange="eqv2Filter('criticality',this.value)"><option value="">همه بحرانیت‌ها</option>${['A','B','C'].map(x=>`<option ${E.criticality===x?'selected':''}>${x}</option>`).join('')}</select><button class="btn btn-sm btn-ghost" onclick="eqv2Columns()">ستون‌ها</button><button class="btn btn-sm btn-ghost" onclick="eqv2Export()">↓ Excel</button><button class="btn btn-sm btn-ghost" onclick="window.print()">🖨 چاپ</button></div>`;
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
    if(E.selected!==id&&resetTab)E.tab='profile';E.selected=id;saveState();
    document.querySelectorAll('.eqv2-node-row,.eqv2 tbody tr').forEach(x=>x.classList.remove('sel'));
    document.querySelector(`[data-node="${CSS.escape(id)}"]>.eqv2-node-row`)?.classList.add('sel');
    document.querySelector(`[data-equipment-detail="${CSS.escape(id)}"]`)?.classList.add('sel');
    try{const {data:a}=await R().get(id),panel=document.getElementById('eqv2Summary');if(panel)panel.innerHTML=summary(a);}catch(error){showError(error);}
  }
  function summary(a){const s=statusInfo(a);return`<div class="eqv2-card-head"><b>خلاصه تجهیز</b><button class="btn btn-sm btn-ghost" onclick="eqv2CloseSummary()">×</button></div><div class="eqv2-dossier-in"><div class="eqv2-asset-hero"><div class="eqv2-asset-icon">${icon(a)}</div><div><h3>${escText(a.name)}</h3><small>${escText(a.code)}</small><span class="badge ${s[1]}">${escText(s[0])}</span></div></div>${[['کارخانه',a.factory_name],['دسته',a.category_name],['محل',a.location_name],['مدل',a.model],['بحرانیت',a.crit],['WO باز',faText(a.open_wo||0)]].map(([k,v])=>`<div class="eqv2-kv"><span>${k}</span><b>${escText(v??'—')}</b></div>`).join('')}<button class="btn btn-primary btn-block" style="margin-top:12px" onclick="eqv2OpenDetail('${escText(a.id)}')">بازکردن پرونده کامل</button><div class="muted" style="text-align:center;margin-top:7px">یا روی تجهیز دوبار کلیک کنید</div></div>`;}

  function detailHeader(a){const s=statusInfo(a);return`<header class="eqv2-detail-header"><button class="btn btn-ghost eqv2-back" onclick="eqv2BackToEquipment()">← بازگشت به تجهیزات</button><div class="eqv2-detail-identity"><span class="eqv2-code">${escText(a.code)}</span><h1>${escText(a.name)}</h1><div><span>🏭 ${escText(a.factory_name||'—')}</span><span>📍 ${escText(a.location_name||'—')}</span><span class="badge ${s[1]}">${escText(s[0])}</span></div></div><div class="eqv2-detail-actions">${canDo('create')?`<button class="btn btn-sm btn-primary" onclick="eqv2Related('wo','${escText(a.id)}')">＋ دستورکار</button><button class="btn btn-sm btn-ghost" onclick="eqv2Related('request','${escText(a.id)}')">＋ درخواست</button><button class="btn btn-sm btn-ghost" onclick="eqv2Related('pm','${escText(a.id)}')">＋ PM</button>`:''}${canDo('edit')?`<button class="btn btn-sm btn-ghost" onclick="eqv2Edit('${escText(a.id)}')">✎ ویرایش</button>`:''}${canDo('delete')?`<button class="btn btn-sm btn-danger" onclick="eqv2Delete('${escText(a.id)}')">🗄 بایگانی</button>`:''}</div></header>`;}
  function breadcrumb(a){const path=(a.path||[]);return`<nav class="eqv2-breadcrumb" aria-label="مسیر تجهیز"><button onclick="eqv2BackToEquipment()">تجهیزات</button>${path.map((x,index)=>`<span>›</span><button class="${index===path.length-1?'current':''}" onclick="eqv2Breadcrumb('${escText(x.id)}','${escText(x.nodeKind||x.type||'')}')">${escText((x.code?x.code+' - ':'')+x.name)}</button>`).join('')}</nav>`;}
  function detailPage(a){return`<div class="eqv2 eqv2-detail-page" id="eqv2Detail" data-equipment-id="${escText(a.id)}">${detailHeader(a)}${breadcrumb(a)}<div class="eqv2-detail-tabs" role="tablist">${DETAIL_TABS.map(([key,label])=>`<button role="tab" aria-selected="${E.tab===key}" class="${E.tab===key?'on':''}" onclick="eqv2DetailTab('${key}')">${label}</button>`).join('')}</div><main class="eqv2-detail-body" id="eqv2DetailBody">${detailBody(a)}</main></div>`;}
  function cards(rows){return`<div class="eqv2-detail-grid">${rows.map(([key,value])=>`<div class="eqv2-info-card"><span>${escText(key)}</span><b>${value==null||value===''?'—':value}</b></div>`).join('')}</div>`;}
  function rowsList(rows,render,none){return rows?.length?`<div class="eqv2-record-list">${rows.map(render).join('')}</div>`:empty(none);}
  function woRow(w){return`<article class="clickable" onclick="typeof openWO==='function'&&openWO('${escText(w.id)}')"><div><b>${escText(w.no||'بدون شماره')}</b><span class="muted">${formatDate(w.created_at||w.createdAt)}</span></div><p>${escText(w.descr||w.desc||'بدون شرح')}</p><span class="badge b-gray">${escText(w.status||'—')}</span><span class="eqv2-go">مشاهده، ویرایش یا بایگانی ←</span></article>`;}
  function healthExplanation(a){const health=a.ext?.operationalHealth;if(!health)return'';if(health.score==null)return`<section class="eqv2-health-evidence"><div><b>شاخص سلامت تجهیز</b><span class="badge b-gray">N/A — داده ناکافی</span></div><p>${escText(health.reason||'داده کافی برای محاسبه وجود ندارد.')}</p></section>`;const badge=health.score>=80?'b-green':health.score>=60?'b-blue':health.score>=40?'b-orange':'b-red';return`<section class="eqv2-health-evidence"><div><b>شاخص سلامت قطعی</b><span class="badge ${badge}">${faText(health.score)} از ۱۰۰ · ${faText(health.coverage)} عامل معتبر</span></div><div class="eqv2-health-factors">${(health.evidence||[]).map(factor=>`<article><span>${escText(factor.label)}</span><b>${faText(Math.round(factor.value))}٪</b><small>${escText(factor.evidence)}</small></article>`).join('')}</div><p>این امتیاز توسط موتور قواعد از داده‌های ثبت‌شده محاسبه شده است؛ تشخیص AI مولد محسوب نمی‌شود.</p></section>`;}
  function detailBody(a){
    const workOrders=a.work_orders||[],completed=a.maintenance_history||[],failures=completed.filter(w=>['BD','CM','EM'].includes(w.type)),pmHistory=completed.filter(w=>w.type==='PM');
    if(E.tab==='usage')return `<div id="seleneMount" class="selene-mount"></div>`;
    if(E.tab==='profile'){
      const ext=a.ext||{},parts=ext.keyParts||[];
      return`<div class="eqv2-profile-hero"><div class="eqv2-asset-icon">${icon(a)}</div><div><h2>${escText(a.code)} — ${escText(a.name)}</h2><p>${escText(ext.description||'شناسنامه از رجیستری واحد تجهیزات، PM و سوابق واقعی خوانده می‌شود.')}</p></div></div>${cards([['کد تجهیز',escText(a.code)],['نام تجهیز',escText(a.name)],['کارخانه',escText(a.factory_name)],['دسته',escText(a.category_name)],['محل استقرار',escText(ext.locationDescription||a.location_name)],['کلاس',escText(a.cls)],['سازنده',escText(a.maker)],['مدل',escText(a.model)],['سریال',escText(a.serial)],['سال ساخت',escText(a.year)],['تاریخ نصب',escText(a.install)],['توان / ظرفیت',escText(ext.capacity||a.power)],['کارکرد روزانه',ext.dailyOperatingHours==null?'—':faText(ext.dailyOperatingHours)+' ساعت'],['امتیاز بحرانی',ext.criticalityScore==null?'<span class="eqv2-na">ثبت نشده</span>':faText(ext.criticalityScore)+' از ۱۰۰'],['تابلو برق',escText(ext.panelCode)],['نوع مبرد',escText(ext.refrigerant)],['مشخصات فنی',escText(ext.technicalSpecification)],['Health Score',a.health_score==null?'<span class="eqv2-na">N/A — داده کافی نیست</span>':faText(a.health_score)],['هزینه ثبت‌شده',a.maintenance_cost==null?'<span class="eqv2-na">N/A — داده کافی نیست</span>':money(a.maintenance_cost)]])}${healthExplanation(a)}${parts.length?`<h3 style="margin:18px 0 9px">قطعات و مشخصات ثبت‌شده</h3><div class="eqv2-parts-chips">${parts.map(part=>`<span>${escText(part)}</span>`).join('')}</div>`:''}`;
    }
    if(E.tab==='structure'){
      const children=a.children||[],parts=a.ext?.keyParts||[];
      if(!children.length&&!parts.length)return empty('زیرتجهیز یا Component ثبت نشده است.');
      return`<div class="eqv2-record-list">${children.map(x=>`<article class="clickable" onclick="eqv2OpenDetail('${escText(x.id)}')"><div><b>${escText(x.code)} — ${escText(x.name)}</b><span>${icon(x)}</span></div><p>${escText(x.nodeKind||x.type)} · ${faText(x.child_count||0)} زیرگره</p><span class="eqv2-go">مشاهده پرونده ←</span></article>`).join('')}${parts.map((part,index)=>`<article><div><b>${faText(index+1)}. ${escText(part)}</b><span>قطعه / مشخصه</span></div></article>`).join('')}</div>`;
    }
    if(E.tab==='maintenance')return rowsList(a.pm_plans,p=>`<article class="clickable" onclick="typeof openPM==='function'&&openPM('${escText(p.id)}')"><div><b>${escText((p.code?p.code+' — ':'')+(p.title||'برنامه PM'))}</b><span>${p.interval_days?faText(p.interval_days)+' روز':'—'}</span></div><p>مسئول: ${escText(p.owner_role||'—')} · قطعه مصرفی: ${escText(p.consumable||'—')} · آخرین اجرا: ${formatDate(p.last_run)} · وضعیت: ${escText(p.status||'—')}</p><span class="eqv2-go">مشاهده یا ویرایش برنامه ←</span></article>`,'برنامه نگهداری و تعمیرات ثبت نشده است.');
    if(E.tab==='checklists'){const daily=(a.ext?.dailyInspection||[]).map((item,index)=>({plan:'بازرسی روزانه تجهیز',index,item})),items=[...daily,...(a.pm_plans||[]).flatMap(p=>(p.checklist||[]).map((item,index)=>({plan:p.title,index,item})) )];return rowsList(items,x=>`<article><div><b>${escText(x.plan)}</b><span>آیتم ${faText(x.index+1)}</span></div><p>${escText(typeof x.item==='string'?x.item:(x.item.title||x.item.text||x.item.label||'آیتم چک‌لیست'))}</p></article>`,'چک‌لیست یا بازرسی ثبت نشده است.');}
    if(E.tab==='requests')return rowsList(a.requests,r=>`<article class="clickable" onclick="typeof openReq==='function'&&openReq('${escText(r.id)}')"><div><b>${escText(r.no||'درخواست')}</b><span>${formatDate(r.created_at)}</span></div><p>${escText(r.descr||'بدون شرح')}</p><span class="badge b-gray">${escText(r.status||'—')}</span><span class="eqv2-go">مشاهده، ویرایش یا بایگانی ←</span></article>`,'درخواست تعمیر مرتبط ثبت نشده است.');
    if(E.tab==='workorders')return rowsList(workOrders,woRow,'دستورکاری برای این تجهیز ثبت نشده است.');
    if(E.tab==='maintenanceHistory')return rowsList(completed,woRow,'سابقه تعمیر تکمیل‌شده ثبت نشده است.');
    if(E.tab==='failures')return rowsList(failures,woRow,'سابقه خرابی تأییدشده ثبت نشده است.');
    if(E.tab==='pmHistory')return rowsList(pmHistory,woRow,'سابقه اجرای PM ثبت نشده است.');
    if(E.tab==='consumedParts')return rowsList(a.consumed_parts,x=>`<article><div><b>${escText(x.item_code)} — ${escText(x.item_name)}</b><span>${faText(x.qty)} ${escText(x.unit)}</span></div><p>دستورکار ${escText(x.wo_no||'—')} · ${formatDate(x.at)}</p></article>`,'قطعه مصرف‌شده ثبت نشده است.');
    if(E.tab==='costs'){const total=(a.cost_entries||[]).reduce((sum,x)=>sum+Number(x.amount||0),0);return(a.cost_entries||[]).length?`<div class="eqv2-total">جمع هزینه واقعی ثبت‌شده: <b>${money(total)}</b></div>${rowsList(a.cost_entries,x=>`<article><div><b>${escText(x.wo_no||'دستورکار')}</b><span>${money(x.amount)}</span></div><p>${formatDate(x.at)}</p></article>`,'')}`:empty('داده کافی برای محاسبه هزینه تعمیرات وجود ندارد.');}
    if(E.tab==='downtime')return rowsList(a.downtimes,x=>`<article><div><b>${escText(x.wo_no||'توقف')}</b><span>${faText(x.hours)} ساعت</span></div><p>${escText(x.reason||'بدون شرح')} · ${formatDate(x.end||x.start)}</p></article>`,'توقف قابل محاسبه‌ای ثبت نشده است.');
    if(E.tab==='reliability')return reliability(a,failures);
    if(E.tab==='documents')return rowsList(a.documents,d=>`<article><div><b>${escText(d.title||d.name||'مدرک')}</b><span>${escText(d.code||d.fmt||d.format||'')}</span></div><p>${escText(d.status||'—')}</p></article>`,'مستند یا فایل مرتبط ثبت نشده است.');
    if(E.tab==='risks')return rowsList(a.risks,r=>`<article><div><b>${escText(r.title||r.risk||r)}</b><span>${escText(r.level||'')}</span></div><p>${escText(r.control||r.mitigation||'کنترل ثبت نشده')}</p></article>`,'ریسک تأییدشده‌ای ثبت نشده است.');
    if(E.tab==='rca')return rowsList(a.rca,x=>`<article><div><b>${escText(x.wo_no||'RCA')}</b><span>${formatDate(x.at)}</span></div><p><b>علت ریشه‌ای:</b> ${escText(x.root_cause)}</p><p><b>اقدام اصلاحی:</b> ${escText(x.action||'—')}</p></article>`,'تحلیل علت ریشه‌ای تأییدشده‌ای ثبت نشده است.');
    return rowsList(a.movements,h=>`<article><div><b>${formatDateTime(h.t)}</b></div><p>${escText(h.x||h.note||'تغییر ثبت‌شده')}</p></article>`,'سابقه تغییر ساختاری ثبت نشده است.');
  }
  function reliability(a,failures){
    const repairHours=failures.map(w=>Number(w.duration_hours)).filter(Number.isFinite),operating=Number(a.hours),downtime=(a.downtimes||[]).reduce((sum,x)=>sum+Number(x.hours||0),0);
    const enough=failures.length>=2&&repairHours.length===failures.length&&Number.isFinite(operating)&&operating>0;
    if(!enough)return empty('داده واقعی و کافی برای محاسبه MTBF، MTTR و Availability وجود ندارد. حداقل دو خرابی تکمیل‌شده با زمان تعمیر و کارکرد معتبر لازم است.');
    const mtbf=operating/failures.length,mttr=repairHours.reduce((s,x)=>s+x,0)/repairHours.length,availability=operating+downtime>0?operating/(operating+downtime)*100:null;
    return cards([['تعداد خرابی معتبر',faText(failures.length)],['MTBF',faText(mtbf.toFixed(1))+' ساعت'],['MTTR',faText(mttr.toFixed(1))+' ساعت'],['Availability',availability==null?'N/A':'٪'+faText(availability.toFixed(1))]]);
  }

  function routeKey(){const match=location.pathname.match(/^\/equipment\/([^/]+)\/?$/);return match?decodeURIComponent(match[1]):null;}
  async function openDetail(idOrCode,{push=true,fromRoute=false}={}){
    if(!equipmentModuleAllowed())return;
    if(E.routeBusy)return;E.routeBusy=true;
    try{
      if(!E.detail)captureExplorerState();
      E.returnView=E.view;E.detail=true;E.tab='profile';
      const content=document.getElementById('content');if(content)content.innerHTML='<div class="eqv2-loading">در حال بازکردن پرونده تجهیز…</div>';
      const {data:a}=await R().get(idOrCode);E.selected=a.id;E.detailKey=a.code||a.id;saveState();
      const target='/equipment/'+encodeURIComponent(E.detailKey);
      if(push&&location.pathname!==target)history.pushState({equipment:true,key:E.detailKey},'',target);
      else if(fromRoute&&location.pathname!==target)history.replaceState({equipment:true,key:E.detailKey},'',target);
      if(content)content.innerHTML=detailPage(a);mountUsage(a);window.scrollTo(0,0);
    }catch(error){E.detail=false;showError(error);}finally{E.routeBusy=false;}
  }
  function mountUsage(a){if(E.tab!=='usage')return;const root=document.getElementById('seleneMount');if(root&&window.BFGSelene)window.BFGSelene.mount(root,{equipmentId:a&&a.id,equipmentName:a&&a.name,equipmentCode:a&&a.code});}
  function openIntake(){if(!equipmentModuleAllowed())return;const main=document.querySelector('.eqv2-main')||document.getElementById('content');if(!main)return;main.innerHTML='<div id="seleneMount" class="selene-mount"></div>';if(window.BFGSelene)window.BFGSelene.mount(document.getElementById('seleneMount'),{equipmentId:E.selected||null});}
  async function renderCurrentDetail(){if(!E.detailKey)return;const {data:a}=await R().get(E.detailKey),body=document.getElementById('eqv2DetailBody');if(body)body.innerHTML=detailBody(a);document.querySelectorAll('.eqv2-detail-tabs button').forEach((button,index)=>{const on=DETAIL_TABS[index]?.[0]===E.tab;button.classList.toggle('on',on);button.setAttribute('aria-selected',String(on));});mountUsage(a);}
  async function backToEquipment({historyMode='push'}={}){
    E.detail=false;E.detailKey=null;E.view='list';if(historyMode==='push')history.pushState({equipmentExplorer:true},'','/');
    const content=document.getElementById('content');if(!content)return;content.innerHTML=shell();await initExplorer(true);restoreExplorerScroll();
  }
  async function breadcrumbNavigate(id,kind){
    if(EQUIPMENT_KINDS.has(kind)||kind==='eq'||kind==='equipment'){await openDetail(id);return;}
    const target=E.options.factories.find(x=>x.id===id);if(target)E.factoryId=id;
    const category=E.options.categories.find(x=>x.id===id);if(category){E.factoryId=category.factory_id||E.factoryId;E.categoryId=id;}
    E.view='list';await backToEquipment();
  }
  async function restoreRoute(){if(!equipmentModuleAllowed())return false;const key=routeKey();if(!key||!ME)return false;CUR='equipment';buildMenu();document.getElementById('sidebar')?.classList.remove('open');await openDetail(key,{push:false,fromRoute:true});return true;}

  function filter(key,value){E[key]=value;if(key==='factoryId')E.categoryId='';E.page=1;saveState();const toolbarNode=document.querySelector('.eqv2-toolbar');if(toolbarNode)toolbarNode.outerHTML=toolbar();load().then(restoreExplorerScroll).catch(showError);}
  function view(){captureExplorerState();E.view='list';E.page=1;saveState();document.getElementById('content').innerHTML=shell();initExplorer(true);}
  function pageTo(value){E.page=Math.max(1,value);saveState();load().then(restoreExplorerScroll).catch(showError);}
  function search(value){clearTimeout(search.timer);E.q=value;E.page=1;saveState();search.timer=setTimeout(()=>load().then(restoreExplorerScroll).catch(showError),250);}
  function sortBy(key){const mapped=sortKey(key);E.direction=E.sort===mapped&&E.direction==='asc'?'desc':'asc';E.sort=mapped;saveState();load().catch(showError);}
  function closeSummary(){E.selected=null;saveState();const panel=document.getElementById('eqv2Summary');if(panel)panel.innerHTML=empty('تجهیزی انتخاب نشده است.');}

  function create(parentId=null){modal(mhead('افزودن گره به ساختار تجهیزات')+`<div class="m-body"><div class="field"><label>نوع گره *</label><select id="eqNodeKind"><option value="equipment">تجهیز</option><option value="sub-equipment">زیرتجهیز</option><option value="subsystem">زیرسیستم</option><option value="main-component">قطعه اصلی</option><option value="sub-component">زیرقطعه</option><option value="location">مکان</option><option value="category">دسته</option></select></div><div class="frow"><div class="field"><label>کد *</label><input id="eqCode"></div><div class="field"><label>نام *</label><input id="eqName"></div></div><input type="hidden" id="eqParent" value="${escText(parentId||'')}"><div class="field"><label>توضیحات</label><textarea id="eqDesc"></textarea></div></div><div class="m-foot"><button class="btn btn-primary" onclick="eqv2SaveCreate()">ثبت</button><button class="btn btn-ghost" onclick="closeModal()">انصراف</button></div>`);}
  async function saveCreate(){const data={nodeKind:$('#eqNodeKind').value,code:$('#eqCode').value.trim(),name:$('#eqName').value.trim(),parentId:$('#eqParent').value||null,ext:{description:$('#eqDesc').value}};if(!data.code||!data.name){toast('کد و نام الزامی است',1);return;}try{await R().create(data);closeModal();toast('گره جدید ثبت شد ✅');await load();}catch(error){showError(error);}}
  async function edit(id){try{const {data:a}=await R().get(id);modal(mhead('ویرایش — '+escText(a.name))+`<div class="m-body"><div class="frow"><div class="field"><label>کد</label><input id="eqEditCode" value="${escText(a.code)}"></div><div class="field"><label>نام</label><input id="eqEditName" value="${escText(a.name)}"></div></div><div class="frow"><div class="field"><label>وضعیت</label><select id="eqEditStatus">${Object.entries(AS_ST).map(([key,value])=>`<option value="${key}" ${a.status===key?'selected':''}>${value[0]}</option>`).join('')}</select></div><div class="field"><label>بحرانیت</label><select id="eqEditCrit">${['A','B','C'].map(x=>`<option ${a.crit===x?'selected':''}>${x}</option>`).join('')}</select></div></div></div><div class="m-foot"><button class="btn btn-primary" onclick="eqv2SaveEdit('${escText(id)}',${a.row_version||1})">ذخیره</button><button class="btn btn-ghost" onclick="closeModal()">انصراف</button></div>`);}catch(error){showError(error);}}
  async function saveEdit(id,version){try{await R().update(id,{code:$('#eqEditCode').value.trim(),name:$('#eqEditName').value.trim(),status:$('#eqEditStatus').value,crit:$('#eqEditCrit').value,rowVersion:version});closeModal();toast('تغییرات ذخیره شد ✅');if(E.detail){E.detailKey=id;await openDetail(id,{push:false});}else{await load();await select(id);}}catch(error){if(error.status===409)toast('این رکورد توسط کاربر دیگری تغییر کرده است؛ صفحه را تازه کنید',1);else showError(error);}}
  async function remove(id){const reason=prompt('دلیل بایگانی تجهیز را وارد کنید:');if(reason===null||!reason.trim()){if(reason!==null)toast('ثبت دلیل بایگانی الزامی است',1);return;}if(!confirm('تجهیز بایگانی شود؟ تمام روابط و سوابق آن حفظ خواهد شد.'))return;try{await R().remove(id,reason.trim());toast('تجهیز بایگانی شد؛ سوابق و روابط حفظ شده‌اند ✅');E.selected=null;if(E.detail)await backToEquipment();else await load();}catch(error){toast(error.message==='HAS_ACTIVE_CHILDREN'?'ابتدا فرزندان فعال را منتقل کنید':'بایگانی انجام نشد: '+error.message,1);}}
  function columns(){modal(mhead('انتخاب ستون‌های لیست')+`<div class="m-body"><div class="eqv2-check-cols">${Object.entries(COLUMNS).map(([key,label])=>`<label class="eqv2-col-opt"><input type="checkbox" value="${key}" ${E.columns.includes(key)?'checked':''}>${label}</label>`).join('')}</div></div><div class="m-foot"><button class="btn btn-primary" onclick="eqv2SaveColumns()">اعمال</button><button class="btn btn-ghost" onclick="closeModal()">انصراف</button></div>`);}
  function saveColumns(){const selected=[...document.querySelectorAll('.eqv2-col-opt input:checked')].map(x=>x.value);if(!selected.length){toast('حداقل یک ستون انتخاب کنید',1);return;}E.columns=selected;saveState();closeModal();load();}
  function exportCsv(){const rows=[[...E.columns.map(key=>COLUMNS[key])],...E.rows.map(a=>E.columns.map(key=>valueFor(a,key)??''))],csv='\ufeff'+rows.map(row=>row.map(value=>'"'+String(value).replace(/"/g,'""')+'"').join(',')).join('\n'),link=document.createElement('a');link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));link.download='equipment-list.csv';link.click();URL.revokeObjectURL(link.href);}
  function createRelated(kind,equipmentId){
    const actions={request:['openReqForm','rqAsset'],wo:['openWOForm','woAsset'],pm:['openPMForm','pmAsset']},entry=actions[kind];
    if(!entry||typeof window[entry[0]]!=='function'){toast('فرم مرتبط در دسترس نیست',1);return;}
    window[entry[0]]();requestAnimationFrame(()=>{const input=document.getElementById(entry[1]);if(input){input.value=equipmentId;input.dispatchEvent(new Event('change',{bubbles:true}));}});
  }
  function showError(error){console.error(error);const main=document.querySelector('.eqv2-main')||document.getElementById('content');if(main)main.innerHTML=`<div class="eqv2-empty"><div><i>⚠️</i><b>خطا در دریافت اطلاعات تجهیزات</b><div>${escText(error.payload?.error||error.message)}</div></div></div>`;if(typeof toast==='function')toast('خطا در بخش تجهیزات: '+(error.payload?.error||error.message),1);}

  window.eqv2Search=search;window.eqv2Filter=filter;window.eqv2View=view;window.eqv2Page=pageTo;window.eqv2Load=load;window.eqv2OpenIntake=openIntake;
  window.eqv2Select=select;window.eqv2Create=create;window.eqv2SaveCreate=saveCreate;
  window.eqv2Edit=edit;window.eqv2SaveEdit=saveEdit;window.eqv2Delete=remove;window.eqv2Columns=columns;window.eqv2SaveColumns=saveColumns;
  window.eqv2Export=exportCsv;window.eqv2Sort=sortBy;window.eqv2OpenDetail=id=>openDetail(id);window.eqv2BackToEquipment=()=>backToEquipment();
  window.eqv2CloseSummary=closeSummary;window.eqv2DetailTab=async tab=>{E.tab=tab;await renderCurrentDetail();};window.eqv2Breadcrumb=breadcrumbNavigate;window.eqv2Related=createRelated;

  window.addEventListener('popstate',()=>{const key=routeKey();if(key)openDetail(key,{push:false,fromRoute:true});else if(E.detail)backToEquipment({historyMode:'none'});});

  const classicTreePage=pgTree;
  pgTree=page;
  const previousLogin=doLogin;
  doLogin=function(){previousLogin();if(ME)setTimeout(restoreRoute,250);};
  if(ME)setTimeout(restoreRoute,250);
})();
