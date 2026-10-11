/* Server-only adapters for request/work-order wizards. No operational data is stored in localStorage. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BFGMaintenanceWizards = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const NONE='__none__', ALL='__all__', MAX_FILE_BYTES=12*1024*1024;
  const ACTIONS=[{value:'emergency',label:'تعمیر اضطراری',icon:'🚨'},{value:'preventive',label:'کار پیشگیرانه',icon:'🔁'},{value:'service',label:'خدمات فنی',icon:'🧰'},{value:'fab',label:'ساخت قطعه یا ابزار',icon:'🏗️'}];
  const SERVICES=[{value:'mechanical',label:'مکانیکی'},{value:'electrical',label:'برقی و کنترل'},{value:'hydraulic',label:'هیدرولیک و پنوماتیک'},{value:'facility',label:'تأسیسات'},{value:'inspection',label:'بازرسی یا کارشناسی'}];
  const FAILURE_TYPES=[{value:'mechanical',label:'مکانیکی'},{value:'electrical',label:'برقی یا کنترلی'},{value:'hydraulic',label:'هیدرولیکی یا پنوماتیکی'},{value:'thermal',label:'حرارتی'},{value:'process',label:'فرایندی'},{value:'unknown',label:'هنوز مشخص نیست'}];
  const PRIORITIES=[{value:'critical',label:'فوق‌العاده ضروری'},{value:'high',label:'ضروری'},{value:'normal',label:'عادی'}];
  const WO_TYPES=[{value:'BD',label:'خرابی اضطراری'},{value:'CM',label:'تعمیر اصلاحی'},{value:'PM',label:'پیشگیرانه'},{value:'SRV',label:'خدمات فنی'},{value:'FAB',label:'ساخت'}];
  const REQUESTABLE=new Set(['new','review']);
  const state={activeWizard:null,saver:null,draftId:null,draftVersion:null,closeWrapped:false,allowClose:false,closePending:false};

  function esc(value){const engine=root.BFGStepWizard;return engine&&engine.escapeHtml?engine.escapeHtml(value):String(value==null?'':value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
  function api(path,options){if(!root.bfgApi)throw new Error('BACKEND_SESSION_REQUIRED');return root.bfgApi(path,options);}
  function part(value){return encodeURIComponent(String(value));}
  function query(values){return Object.entries(values).filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');}
  function payloadData(value){return value&&value.data;}
  function detailData(value){return value&&(value.data||value);}
  function other(answers,key){return answers&&answers[key]===(root.BFGStepWizard&&root.BFGStepWizard.OTHER||'__other__')?(answers[key+'Other']||''):(answers&&answers[key]||'');}
  function dateIso(value){return value&&typeof value==='object'&&value.date&&root.BFGStepWizard?root.BFGStepWizard.jalaliDateToISO(value.date,value.time||'00:00'):null;}
  function mapRequestAnswers(answers={}){
    const actionType=other(answers,'actionType');
    const form={...answers,actionType,serviceType:other(answers,'serviceType'),failureType:other(answers,'failureType'),
      factoryId:answers.factoryId===NONE?null:(answers.factoryId||null),categoryId:answers.categoryId===ALL?null:(answers.categoryId||null),
      equipmentId:answers.equipmentId===NONE?null:(answers.equipmentId||null),subsystemId:answers.subsystemId===NONE?null:(answers.subsystemId||null),
      failureOccurredAt:dateIso(answers.failureOccurredAt),stopOccurredAt:dateIso(answers.stopOccurredAt),needBy:dateIso(answers.needBy)};
    return{type:actionType==='fab'?'fab':actionType==='service'?'service':'repair',unit:String(answers.unit||''),
      assetId:form.subsystemId||form.equipmentId||null,descr:String(answers.description||'').trim(),urgency:answers.urgency||'normal',
      impact:answers.stopProduction==='yes',form};
  }
  function mapWorkOrderAnswers(answers={}){
    const quantities=answers.partQuantities||{};
    return{requestId:answers.requestId&&answers.requestId!==NONE?answers.requestId:null,
      requestRowVersion:Number(answers.requestRowVersion)||null,workOrderType:answers.workOrderType||'CM',
      assetId:answers.subsystemId&&answers.subsystemId!==NONE?answers.subsystemId:answers.equipmentId&&answers.equipmentId!==NONE?answers.equipmentId:null,
      descr:String(answers.workDescription||'').trim(),priority:answers.priority||'normal',
      assignee:answers.assignee&&answers.assignee!==NONE?answers.assignee:null,est:Number(answers.estimatedHours)||null,
      failureType:other(answers,'failureType')||null,probableCauses:String(answers.probableCause||'').split(/[\n،,;]/).map(x=>x.trim()).filter(Boolean),
      confirmedRootCause:String(answers.confirmedRootCause||'').trim()||null,recommendedAction:String(answers.recommendedAction||'').trim()||null,
      performedAction:String(answers.performedAction||'').trim()||null,
      requiredParts:(Array.isArray(answers.requiredParts)?answers.requiredParts:[]).map(itemId=>({itemId,qty:Number(quantities[itemId])||1})),
      ptwRequired:answers.ptwRequired===true};
  }
  function normalizedDraftAnswers(type,answers={}){
    const saved={...answers};
    if(type==='request'){
      const mapped=mapRequestAnswers(answers);
      saved.actionType=mapped.form.actionType;saved.serviceType=mapped.form.serviceType;saved.failureType=mapped.form.failureType;
      saved.factoryId=mapped.form.factoryId;saved.categoryId=mapped.form.categoryId;saved.equipmentId=mapped.form.equipmentId;saved.subsystemId=mapped.form.subsystemId;
      saved.failureOccurredAt=mapped.form.failureOccurredAt;saved.stopOccurredAt=mapped.form.stopOccurredAt;saved.needBy=mapped.form.needBy;
    }
    return saved;
  }
  function restoreDate(value,withTime){
    if(value&&typeof value==='object')return value;
    if(!value||!root.BFGStepWizard||!root.BFGStepWizard.isoToJalaliInput)return withTime?{date:'',time:''}:{date:''};
    const raw=root.BFGStepWizard.isoToJalaliInput(value);
    return withTime?raw:{date:raw.date};
  }
  function restoreAnswers(type,answers={}){
    const restored={...answers};
    if(type==='request'){
      restored.failureOccurredAt=restoreDate(answers.failureOccurredAt,true);
      restored.stopOccurredAt=restoreDate(answers.stopOccurredAt,true);
      restored.needBy=restoreDate(answers.needBy,false);
    }
    if(type==='work_order')restored.ptwChoice=['yes','no'].includes(answers.ptwChoice)?answers.ptwChoice:'';
    return restored;
  }
  async function optional(path,fallback){try{return await api(path);}catch(error){if(error&&(error.status===403||error.status===404))return fallback;throw error;}}
  async function loadRuntime(type){
    const rt={type,filters:{factories:[],categories:[]},equipmentRows:[],equipmentDetail:null,requests:[],requestMap:new Map(),users:[],items:[],technicians:[],
      technicianMessage:'داده کافی برای پیشنهاد تکنسین وجود ندارد',ai:{loading:false,message:'',recommendations:[],runId:null,generation:0},quantityStep:null,quantityKeys:new Map(),
      fileTokens:new WeakMap(),uploadedFiles:new WeakSet(),dataWarnings:[]};
    const jobs=[optional('/api/equipment/filters',{factories:[],categories:[]})];
    if(type==='work_order')jobs.push(optional('/api/requests',{data:[]}),optional('/api/data/users',[]),optional('/api/inventory/items/availability',{data:[]}));
    const result=await Promise.all(jobs),filters=result[0]||{};
    rt.filters={factories:Array.isArray(filters.factories)?filters.factories:[],categories:Array.isArray(filters.categories)?filters.categories:[]};
    if(type==='work_order'){
      rt.requests=(payloadData(result[1])||[]).filter(row=>REQUESTABLE.has(row.status));rt.requests.forEach(row=>rt.requestMap.set(String(row.id),row));
      const users=Array.isArray(result[2])?result[2]:payloadData(result[2])||[];
      rt.users=users.filter(user=>user&&user.active!==false&&user.role==='tech');
      rt.items=(payloadData(result[3])||[]).filter(item=>Number(item.available)>0);
      if(!rt.users.length)rt.dataWarnings.push('فهرست تکنسین‌های فعال از Backend در دسترس نیست.');
      if(!rt.items.length)rt.dataWarnings.push('موجودی آزاد تأییدشده از Backend موجود نیست؛ قطعهٔ ساختگی نمایش داده نمی‌شود.');
    }
    return rt;
  }
  async function loadEquipment(rt,answers){
    rt.equipmentRows=[];const factoryId=answers.factoryId&&answers.factoryId!==NONE?answers.factoryId:'';if(!factoryId)return[];
    const categoryId=answers.categoryId&&answers.categoryId!==ALL?answers.categoryId:'';const rows=[];let pageNo=1,pages=1;
    do{const result=await api('/api/equipment?'+query({factoryId,categoryId,page:pageNo,limit:200}));rows.push(...(payloadData(result)||[]));pages=Number(result.pagination&&result.pagination.pages)||1;pageNo++;}while(pageNo<=pages&&pageNo<=10);
    rt.equipmentRows=rows;return rows;
  }
  async function loadEquipmentDetail(rt,id){rt.equipmentDetail=null;if(!id||id===NONE)return null;rt.equipmentDetail=detailData(await api('/api/equipment/'+part(id)))||null;return rt.equipmentDetail;}
  function subEquipment(detail){const valid=new Set(['sub-equipment','subsystem','main-component','sub-component']);return(detail&&Array.isArray(detail.children)?detail.children:[]).filter(child=>{const kind=child.nodeKind||child.node_kind;return!kind||valid.has(kind);});}
  function factoryIdFor(rt,detail){
    if(!detail)return'';const direct=detail.factory_id||detail.factory_asset_id||detail.factoryAssetId;if(direct)return direct;
    const categoryId=detail.category_id||detail.categoryId;const category=rt.filters.categories.find(row=>String(row.id)===String(categoryId));
    if(category)return category.factory_id||category.factory_asset_id||'';
    const pathRows=Array.isArray(detail.path)?detail.path:[];const factory=pathRows.find(row=>['factory','factories'].includes(row.nodeKind||row.node_kind));return factory&&factory.id||'';
  }
  function resetAi(rt){const generation=(Number(rt.ai&&rt.ai.generation)||0)+1;rt.ai={loading:false,message:'',recommendations:[],runId:null,generation};}
  function clearTechnicians(rt){rt.technicians=[];rt.technicianMessage='داده کافی برای پیشنهاد تکنسین وجود ندارد';}
  async function loadTechnicians(rt,answers){
    rt.technicians=[];rt.technicianMessage='داده کافی برای پیشنهاد تکنسین وجود ندارد';
    const equipmentId=answers.subsystemId&&answers.subsystemId!==NONE?answers.subsystemId:answers.equipmentId;if(!equipmentId||equipmentId===NONE)return;
    try{const result=await api('/api/work-orders/technician-suggestions?'+query({equipmentId,workOrderType:answers.workOrderType||'CM'}));
      const data=payloadData(result)||{};rt.technicians=Array.isArray(data.data)?data.data:[];rt.technicianMessage=data.message||(rt.technicians.length?'':'داده کافی برای پیشنهاد تکنسین وجود ندارد');
    }catch(error){rt.technicianMessage=error&&error.status===403?'برای پیشنهاد تکنسین، مجوز مشاهدهٔ تجهیز و ایجاد دستورکار لازم است.':'داده کافی برای پیشنهاد تکنسین وجود ندارد';}
  }
  async function prepareExisting(rt,answers){
    if(answers.equipmentId&&answers.equipmentId!==NONE){
      const detail=await loadEquipmentDetail(rt,answers.equipmentId);
      if(!answers.factoryId||answers.factoryId===NONE)answers.factoryId=factoryIdFor(rt,detail);
      if((!answers.categoryId||answers.categoryId===ALL)&&detail&&detail.category_id)answers.categoryId=detail.category_id;
      if(answers.factoryId&&answers.factoryId!==NONE)await loadEquipment(rt,answers);
      if(rt.type==='work_order')await loadTechnicians(rt,answers);
    }else if(answers.factoryId&&answers.factoryId!==NONE)await loadEquipment(rt,answers);
  }
  function factoryOptions(rt){return[{value:NONE,label:'مکان یا کارخانه فعلاً مشخص نیست'}].concat(rt.filters.factories.map(row=>({value:row.id,label:[row.code,row.name].filter(Boolean).join(' — ')})));}
  function categoryOptions(rt,answers){const id=answers.factoryId;if(!id||id===NONE)return[];const rows=rt.filters.categories.filter(row=>String(row.factory_id||row.factory_asset_id)===String(id));return[{value:ALL,label:'همهٔ دسته‌های ثبت‌شده'}].concat(rows.map(row=>({value:row.id,label:[row.code,row.name].filter(Boolean).join(' — ')})));}
  function equipOptions(rt){return[{value:NONE,label:'فعلاً تجهیز مشخصی انتخاب نمی‌کنم'}].concat(rt.equipmentRows.map(row=>({value:row.id,label:[row.code,row.name].filter(Boolean).join(' — ')})));}
  function subOptions(rt){return[{value:NONE,label:'بدون زیرسیستم یا قطعهٔ مشخص'}].concat(subEquipment(rt.equipmentDetail).map(row=>({value:row.id,label:[row.code,row.name].filter(Boolean).join(' — ')})));}
  function equipmentSteps(rt){return[
    {id:'factoryId',kind:'choice',title:'کارخانه یا محل درخواست کجاست؟',required:false,description:'فهرست از API واقعی تجهیزات دریافت می‌شود؛ در صورت نامشخص بودن انتخاب را خالی بگذارید.',options:()=>factoryOptions(rt),
      onChange:async({answers,value})=>{resetAi(rt);clearTechnicians(rt);answers.factoryId=value;answers.categoryId='';answers.equipmentId='';answers.subsystemId='';rt.equipmentRows=[];rt.equipmentDetail=null;if(value!==NONE)await loadEquipment(rt,answers);}},
    {id:'categoryId',kind:'choice',title:'دستهٔ تجهیز را انتخاب کنید',required:false,visibleWhen:a=>!!a.factoryId&&a.factoryId!==NONE,
      description:'این مرحله فقط فهرست را محدود می‌کند؛ درخت تجهیزات نمایش داده نمی‌شود.',options:a=>categoryOptions(rt,a),
      onChange:async({answers,value})=>{resetAi(rt);clearTechnicians(rt);answers.categoryId=value;answers.equipmentId='';answers.subsystemId='';rt.equipmentDetail=null;await loadEquipment(rt,answers);}},
    {id:'equipmentId',kind:'choice',title:'تجهیز مرتبط را انتخاب کنید',required:false,visibleWhen:a=>!!a.factoryId&&a.factoryId!==NONE,
      description:'گزینه‌ها از فهرست و فیلترهای مجاز Backend هستند.',options:()=>equipOptions(rt),
      onChange:async({answers,value})=>{resetAi(rt);answers.equipmentId=value;answers.subsystemId='';rt.equipmentDetail=null;if(value!==NONE){const detail=await loadEquipmentDetail(rt,value);if(rt.type==='work_order')await loadTechnicians(rt,answers);if(detail&&detail.category_id&&!answers.categoryId)answers.categoryId=detail.category_id;}else if(rt.type==='work_order')clearTechnicians(rt);}},
    {id:'subsystemId',kind:'choice',title:'زیرسیستم یا قطعهٔ دقیق‌تر (اختیاری)',required:false,visibleWhen:a=>!!a.equipmentId&&a.equipmentId!==NONE&&subEquipment(rt.equipmentDetail).length>0,
      description:'فهرست فرزندان همان تجهیز، بدون نمایش درختی.',options:()=>subOptions(rt),onChange:async({answers,value})=>{resetAi(rt);answers.subsystemId=value;if(rt.type==='work_order')await loadTechnicians(rt,answers);}}
  ];}
  function aiStep(rt,key){return{id:'selene-'+key,kind:'custom',title:'پیشنهاد سلن با شواهد قابل بررسی',
    description:'فقط سوابق مجاز Backend بررسی می‌شوند. هیچ پیشنهاد خودکار انتخاب یا ثبت نمی‌شود.',
    visibleWhen:a=>!!((a.subsystemId&&a.subsystemId!==NONE)||(a.equipmentId&&a.equipmentId!==NONE)),
    render:({answers})=>{
      const ai=rt.ai,equipmentSelected=!!((answers.subsystemId&&answers.subsystemId!==NONE)||(answers.equipmentId&&answers.equipmentId!==NONE));
      const button=`<button type="button" class="btn btn-ghost" data-sw-action="custom" data-sw-key="ai-${key}" ${!equipmentSelected||ai.loading?'disabled':''}>${ai.loading?'در حال بررسی شواهد…':'🤖 دریافت پیشنهاد سلن'}</button>`;
      const results=ai.recommendations.map((item,index)=>{
        const evidence=(item.evidence||[]).map(source=>`<li><b>${esc(source.sourceType)} / ${esc(source.sourceId)}</b><span>${esc(source.excerpt)}</span></li>`).join('');
        return`<article class="sw-ai-card"><div class="sw-ai-card-head"><b>${esc(item.recommendation_type||item.type)}</b><span>اطمینان ${esc(Math.round(Number(item.confidence)*100))}٪ — پیشنهاد تأییدنشده</span></div><p>${esc(item.recommendation)}</p><small>${esc(item.reason)}</small><details><summary>شواهد (${item.evidence.length})</summary><ul>${evidence}</ul></details><button type="button" class="btn btn-sm btn-primary" data-sw-action="custom" data-sw-key="use-ai-${key}" data-sw-index="${index}">افزودن به پیش‌نویس برای بازبینی</button></article>`;
      }).join('');
      return`<div class="sw-ai-panel"><p>نیازمند مجوز <code>ai.use</code> و دسترسی مشاهدهٔ تجهیز؛ سیاست Provider و Failover حفظ می‌شود.</p>${button}${ai.message?`<div class="sw-alert" role="status">${esc(ai.message)}</div>`:''}${results?`<div class="sw-ai-results">${results}</div>`:''}</div>`;
    }};}
  function requestSteps(rt){
    const details={id:'requestDetails',kind:'group',title:'شرح، تماس و تاریخ موردنیاز',description:'تاریخ‌ها در این صفحه شمسی و در Backend به میلادی ثبت می‌شوند. پیوست تا ثبت فقط در حافظهٔ همین صفحه است.',fields:[
      {id:'description',kind:'textarea',label:'شرح خرابی یا درخواست کار',required:true,rows:4,maxLength:4000,placeholder:'نشانه‌ها، نیاز یا کار درخواستی…',onChange:()=>resetAi(rt)},
      {id:'extraDescription',kind:'textarea',label:'اطلاعات تکمیلی',required:false,rows:3,maxLength:3000,onChange:()=>resetAi(rt)},
      {id:'unit',kind:'text',label:'واحد درخواست‌کننده',required:true,maxLength:160},
      {id:'phone',kind:'tel',label:'شماره تماس',required:false,maxLength:40,placeholder:'داخلی یا شماره تماس'},
      {id:'needBy',kind:'jalali-date',label:'تاریخ موردنیاز',required:false},
      {id:'attachments',kind:'file',label:'پیوست عکس، فیلم یا سند',required:false,multiple:true,maxFiles:10,persist:false,
        accept:'.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.docx,.xlsx,.mp4,.webm',help:'حداکثر ۱۲ مگابایت برای هر فایل؛ نوع واقعی فایل در Backend اعتبارسنجی می‌شود.',isUploaded:file=>rt.uploadedFiles.has(file)}
    ]};
    return[
      {id:'actionType',kind:'choice',title:'چه نوع درخواست کاری دارید؟',required:true,options:ACTIONS,onChange:({answers,value})=>{resetAi(rt);if(value==='fab'){answers.serviceType='';delete answers.serviceTypeOther;}if(!['emergency','preventive'].includes(value)){answers.failureType='';delete answers.failureTypeOther;}}},
      {id:'serviceType',kind:'choice',title:'نوع خدمت موردنیاز چیست؟',required:true,visibleWhen:a=>a.actionType!=='fab',options:SERVICES,allowOther:true,otherLabel:'سایر',otherPrompt:'نوع خدمت را شرح دهید',onChange:()=>resetAi(rt)},
      ...equipmentSteps(rt),
      {id:'failureType',kind:'choice',title:'نوع خرابی یا موضوع اصلی چیست؟',required:false,visibleWhen:a=>['emergency','preventive'].includes(a.actionType),options:FAILURE_TYPES,allowOther:true,otherLabel:'سایر',otherPrompt:'نوع خرابی را شرح دهید',onChange:()=>resetAi(rt)},
      {id:'failureTiming',kind:'group',title:'زمان و اثر توقف',description:'زمان خرابی، توقف و مدت آن از هم جدا ثبت می‌شوند.',fields:[
        {id:'failureOccurredAt',kind:'jalali-datetime',label:'زمان وقوع خرابی (در صورت اطلاع)',required:false},
        {id:'stopProduction',kind:'choice',label:'آیا خرابی باعث توقف تولید شده است؟',required:true,options:[{value:'yes',label:'بله'},{value:'no',label:'خیر'}],onChange:({answers,value})=>{if(value==='no'){answers.stopOccurredAt={date:'',time:''};answers.stopDurationMinutes='';}}},
        {id:'stopOccurredAt',kind:'jalali-datetime',label:'زمان شروع توقف',required:false,visibleWhen:a=>a.stopProduction==='yes'},
        {id:'stopDurationMinutes',kind:'number',label:'مدت توقف برآوردی (دقیقه)',required:false,min:0,max:100000,visibleWhen:a=>a.stopProduction==='yes'}
      ]},
      {id:'urgency',kind:'choice',title:'میزان ضرورت انجام کار چقدر است؟',required:true,options:PRIORITIES},
      details,aiStep(rt,'request'),{id:'requestReview',kind:'review',title:'مرور و تأیید درخواست کار'}
    ];
  }
  function requestWOrderType(request){const form=request&&request.form||{};if(request.type==='fab')return'FAB';if(request.type==='service')return'SRV';if(form.actionType==='preventive')return'PM';if(request.urgency==='critical')return'BD';return'CM';}
  function partOptions(rt){return rt.items.map(item=>({value:item.id,label:`${[item.code,item.name].filter(Boolean).join(' — ')} | موجود آزاد: ${item.available} ${item.unit||''}`}));}
  function configureQuantities(rt,answers){
    if(!rt.quantityStep)return;const selected=Array.isArray(answers.requiredParts)?answers.requiredParts:[];
    const old={...(answers.partQuantities||{})},priorValues=new Map();
    rt.quantityKeys.forEach((itemId,key)=>{if(answers[key]!==undefined)priorValues.set(String(itemId),answers[key]);});
    rt.quantityKeys.clear();
    rt.quantityStep.fields=selected.map((itemId,index)=>{
      const item=rt.items.find(row=>String(row.id)===String(itemId));if(!item)return null;
      const key='partQty_'+index;rt.quantityKeys.set(key,item.id);
      const saved=priorValues.has(String(item.id))?priorValues.get(String(item.id)):old[item.id];
      answers[key]=saved==null||saved===''?1:saved;
      return{id:key,kind:'number',label:`${item.code||item.name} — آزاد: ${item.available} ${item.unit||''}`,required:true,min:0.001,max:Number(item.available),step:0.001,
        onChange:({answers:current,value})=>{current.partQuantities={...(current.partQuantities||{}),[item.id]:Number(value)};}};
    }).filter(Boolean);
    const valid=new Set(rt.quantityStep.fields.map(field=>field.id));Object.keys(answers).filter(key=>key.startsWith('partQty_')&&!valid.has(key)).forEach(key=>delete answers[key]);
    answers.partQuantities=old;rt.quantityStep.fields.forEach(field=>{const itemId=rt.quantityKeys.get(field.id);answers.partQuantities[itemId]=Number(answers[field.id])||Number(old[itemId])||1;});
  }
  function assigneeRender(rt){return({answers})=>{
    const suggested=new Set(rt.technicians.map(row=>String(row.id))),options=[{id:NONE,name:'بعداً تخصیص می‌یابد'}].concat(rt.users);
    const cards=options.map(user=>{const isSuggested=suggested.has(String(user.id)),selected=String(answers.assignee||NONE)===String(user.id);
      const candidate=rt.technicians.find(row=>String(row.id)===String(user.id));
      const label=user.id===NONE?user.name:`${user.name}${user.hr&&user.hr.specialty?' — '+user.hr.specialty:''}${candidate?` — پیشنهاد مستند (بار باز ${candidate.activeWorkOrders})`:''}`;
      return`<button type="button" class="sw-option ${selected?'is-selected':''}" data-sw-action="answer" data-sw-question="assignee" data-sw-value="${esc(user.id)}" aria-pressed="${selected}">${isSuggested?'⭐ ':''}${esc(label)}</button>`;
    }).join('');
    const note=rt.technicians.length?'<p class="sw-help">پیشنهادها با تخصص، مجوز کاری، شیفت، محل و بار باز واقعی مرتب شده‌اند؛ انتخاب با شماست.</p>':`<div class="sw-alert" role="status">${esc(rt.technicianMessage||'داده کافی برای پیشنهاد تکنسین وجود ندارد')}</div>`;
    return`${note}${rt.users.length?`<div class="sw-options" role="group" aria-label="انتخاب تکنسین">${cards}</div>`:'<p class="sw-empty-note">فهرست تکنسین‌های فعال از Backend دریافت نشد.</p>'}`;
  };}
  function workOrderSteps(rt){
    const quantity={id:'partQuantities',kind:'group',title:'تعداد قطعات موردنیاز برای برنامه‌ریزی',required:false,fields:[]};rt.quantityStep=quantity;
    const parts={id:'requiredParts',kind:'multi-choice',title:'قطعات قابل برنامه‌ریزی از انبار',required:false,
      description:'انتخاب قطعه رزرو یا برداشت ایجاد نمی‌کند؛ انتخاب نهایی با شماست.',options:()=>partOptions(rt),
      render:({answers})=>{const choices=partOptions(rt),selected=Array.isArray(answers.requiredParts)?answers.requiredParts.map(String):[];
        if(!choices.length)return'<p class="sw-empty-note">موجودی آزاد تأییدشده در Backend وجود ندارد؛ قلم ساختگی نمایش داده نمی‌شود.</p>';
        return`<p class="sw-help">فقط Master Data و موجودی آزاد واقعی. انتخاب قطعه هیچ رزرو یا مصرفی ایجاد نمی‌کند.</p><div class="sw-options" role="group" aria-label="قطعات آزاد انبار">${choices.map(item=>`<button type="button" class="sw-option ${selected.includes(String(item.value))?'is-selected':''}" data-sw-action="multi-answer" data-sw-question="requiredParts" data-sw-value="${esc(item.value)}" aria-pressed="${selected.includes(String(item.value))}">${esc(item.label)}</button>`).join('')}</div>`;},
      onChange:({answers})=>configureQuantities(rt,answers)};
    const permit={id:'ptwChoice',kind:'choice',title:'آیا اجرای این کار به مجوز کار نیاز دارد؟',required:true,
      description:'در صورت نیاز، دستورکار «در انتظار صدور مجوز» می‌ماند و Backend شروع کار را مسدود می‌کند.',
      options:[{value:'yes',label:'بله — مجوز باید صادر شود'},{value:'no',label:'خیر — مجوز لازم نیست'}],onChange:({answers,value})=>{answers.ptwRequired=value==='yes';}};
    return[
      {id:'requestId',kind:'choice',title:'آیا دستورکار از یک درخواست کار تأییدنشده صادر می‌شود؟',required:true,
        description:'درخواست‌های واقعی Backend انتخاب می‌شوند و در ثبت نهایی با گردش تأیید موجود پیوند می‌خورند.',
        options:()=>[{value:NONE,label:'دستورکار مستقل — بدون درخواست مبدأ'}].concat(rt.requests.map(row=>({value:row.id,label:`${row.no} — ${(row.desc||'').slice(0,100)}`}))),
        onChange:async({answers,value})=>{
          resetAi(rt);clearTechnicians(rt);
          if(value===NONE){Object.assign(answers,{requestId:NONE,requestRowVersion:null,workDescription:'',priority:'',workOrderType:'',factoryId:'',categoryId:ALL,equipmentId:'',subsystemId:'',failureType:'',probableCause:'',confirmedRootCause:'',recommendedAction:'',performedAction:'',estimatedHours:'',assignee:'',ptwRequired:undefined,ptwChoice:'',requiredParts:[],partQuantities:{}});configureQuantities(rt,answers);rt.equipmentRows=[];rt.equipmentDetail=null;clearTechnicians(rt);return;}
          const request=rt.requestMap.get(String(value));if(!request)return;
          Object.assign(answers,{requestId:request.id,requestRowVersion:Number(request.rowVersion),workDescription:request.desc||request.descr||'',confirmedRootCause:'',performedAction:'',estimatedHours:'',assignee:'',requiredParts:[],partQuantities:{}});configureQuantities(rt,answers);
          answers.priority=request.urgency||'';answers.workOrderType=requestWOrderType(request);
          const form=request.form||{};answers.failureType=form.failureType||'';answers.probableCause=form.probableCause||'';answers.recommendedAction=form.recommendedAction||'';
          answers.factoryId=form.factoryId||'';answers.categoryId=form.categoryId||ALL;answers.equipmentId=form.equipmentId||request.assetId||'';answers.subsystemId=form.subsystemId||'';
          if(typeof form.ptwRequired==='boolean'){answers.ptwRequired=form.ptwRequired;answers.ptwChoice=form.ptwRequired?'yes':'no';}else{answers.ptwRequired=undefined;answers.ptwChoice='';}
          if(answers.equipmentId){const detail=detailData(await api('/api/equipment/'+part(answers.equipmentId)));if(!answers.factoryId)answers.factoryId=factoryIdFor(rt,detail);if((!answers.categoryId||answers.categoryId===ALL)&&detail&&detail.category_id)answers.categoryId=detail.category_id;
            if(answers.factoryId)await loadEquipment(rt,answers);await loadEquipmentDetail(rt,answers.equipmentId);await loadTechnicians(rt,answers);}
        }},
      {id:'workOrderType',kind:'choice',title:'نوع دستورکار چیست؟',required:true,options:WO_TYPES,onChange:async({answers})=>{resetAi(rt);if(answers.equipmentId&&answers.equipmentId!==NONE)await loadTechnicians(rt,answers);}},
      ...equipmentSteps(rt),
      {id:'priority',kind:'choice',title:'اولویت دستورکار را مشخص کنید',required:true,options:PRIORITIES},
      {id:'failureType',kind:'choice',title:'نوع خرابی (طبقه‌بندی اولیه و قابل بازبینی)',required:false,options:FAILURE_TYPES,allowOther:true,otherLabel:'سایر',otherPrompt:'نوع خرابی را شرح دهید',onChange:()=>resetAi(rt)},
      {id:'workOrderDetails',kind:'group',title:'شرح و تفکیک اطلاعات تشخیصی و اجرایی',description:'نوع خرابی، علت احتمالی، علت ریشه‌ای تأییدشده، اقدام پیشنهادی و اقدام انجام‌شده جدا هستند.',fields:[
        {id:'workDescription',kind:'textarea',label:'شرح کار',required:true,rows:4,maxLength:4000,onChange:()=>resetAi(rt)},
        {id:'probableCause',kind:'textarea',label:'علت احتمالی (تأییدنشده)',required:false,rows:2,maxLength:3000,onChange:()=>resetAi(rt)},
        {id:'confirmedRootCause',kind:'textarea',label:'علت ریشه‌ای تأییدشده (فقط پس از بررسی)',required:false,rows:2,maxLength:3000},
        {id:'recommendedAction',kind:'textarea',label:'اقدام پیشنهادی',required:false,rows:2,maxLength:3000},
        {id:'performedAction',kind:'textarea',label:'اقدام انجام‌شده (هنگام صدور معمولاً خالی بماند)',required:false,rows:2,maxLength:3000},
        {id:'estimatedHours',kind:'number',label:'مدت برآوردی (ساعت)',required:false,min:0.1,max:100000,step:0.1}
      ]},
      aiStep(rt,'work-order'),
      {id:'assignee',kind:'custom',title:'انتخاب تکنسین (اختیاری)',description:'هیچ تکنسینی به‌صورت خودکار تخصیص داده نمی‌شود.',summary:value=>{if(!value||value===NONE)return'بعداً تخصیص می‌یابد';const selected=rt.users.find(user=>String(user.id)===String(value));return selected?selected.name:'تکنسین انتخاب‌شده از فهرست فعال';},render:assigneeRender(rt)},
      parts,quantity,permit,{id:'workOrderReview',kind:'review',title:'مرور دستورکار و تأیید صدور'}
    ];
  }
  function validConfidence(value){return(typeof value==='number'||(typeof value==='string'&&value.trim()!=='') )&&Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=1;}
  function validAi(result){const data=payloadData(result)||{},rows=Array.isArray(data.recommendations)?data.recommendations:[];return rows.filter(row=>row&&typeof row.recommendation==='string'&&row.recommendation.trim()&&typeof row.reason==='string'&&row.reason.trim()&&validConfidence(row.confidence)&&Array.isArray(row.evidence)&&row.evidence.length&&row.evidence.every(ev=>ev&&typeof ev.sourceType==='string'&&ev.sourceType!=='web'&&typeof ev.sourceId==='string'&&ev.sourceId&&typeof ev.excerpt==='string'&&ev.excerpt.trim()));}
  function aiError(error){const code=error&&(error.payload&&error.payload.error||error.message);if(['AI_PROVIDER_DISABLED_BY_POLICY','AI_PURPOSE_DENIED_BY_POLICY','NO_CAPABLE_PROVIDER'].includes(code))return'Provider مجاز و فعالی برای این تحلیل در دسترس نیست؛ سیاست Provider و Failover تغییر نکرده است.';if(['EQUIPMENT_SCOPE_DENIED','PERMISSION_DENIED'].includes(code))return'مجوز ai.use و دسترسی مشاهدهٔ همین تجهیز لازم است.';if(code==='UNVERIFIED_EVIDENCE')return'پیشنهاد فاقد شواهد منطبق با دادهٔ مجاز بود و نمایش داده نشد.';return'داده کافی برای پیشنهاد سلن وجود ندارد یا سرویس مجاز Backend در دسترس نیست.';}
  async function runAi(rt,wizard,answers){
    const equipmentId=answers.subsystemId&&answers.subsystemId!==NONE?answers.subsystemId:answers.equipmentId;if(!equipmentId||equipmentId===NONE){rt.ai.message='برای تحلیل، ابتدا تجهیز واقعی را انتخاب کنید.';wizard.render();return;}
    const generation=(Number(rt.ai.generation)||0)+1;rt.ai={loading:true,message:'',recommendations:[],runId:null,generation};wizard.render();
    try{const description=[answers.description,answers.extraDescription,answers.workDescription].filter(Boolean).join(' — ')||'درخواست کار جدید';
      const question=`فقط با سوابق مجاز Backend برای تجهیز انتخاب‌شده، پیشنهادهای قابل بررسی بده. نوع اقدام/دستورکار: ${answers.actionType||answers.workOrderType||'نامشخص'}. شرح کار: ${description}. نوع خرابی/خدمت: ${other(answers,'failureType')||other(answers,'serviceType')||'نامشخص'}. علت احتمالی ثبت‌شده: ${answers.probableCause||'ثبت نشده'}. اگر شواهد دقیق کافی نیست، recommendations را خالی برگردان.`;
      const result=await api('/api/ai/analyze',{method:'POST',body:JSON.stringify({purpose:'wizard_suggestion',equipmentId,question,useSearch:false})});
      if(rt.ai.generation!==generation)return;
      rt.ai.recommendations=validAi(result);rt.ai.runId=payloadData(result)&&payloadData(result).runId||null;
      rt.ai.message=rt.ai.recommendations.length?(payloadData(result).summary||''):'داده کافی و شواهد معتبر برای پیشنهاد سلن وجود ندارد؛ هیچ گزینه‌ای انتخاب نشد.';
    }catch(error){if(rt.ai.generation===generation){rt.ai.message=aiError(error);rt.ai.recommendations=[];}}finally{if(rt.ai.generation===generation){rt.ai.loading=false;wizard.render();}}
  }
  async function adoptAi(rt,wizard,answers,index,type){
    const item=rt.ai.recommendations[Number(index)];if(!item)return;const text=`پیشنهاد سلن (تأیید انسانی نشده): ${item.recommendation}`;
    if(type==='request'){const old=String(answers.extraDescription||'').trim();await wizard.setAnswer('extraDescription',old?`${old}\n${text}`:text);await wizard.goTo('requestDetails');return;}
    const recType=item.recommendation_type||item.type;
    if(['diagnosis','investigation'].includes(recType)){await wizard.setAnswer('probableCause',text);await wizard.goTo('workOrderDetails');return;}
    if(['corrective_maintenance','preventive_action','immediate_action','inspection'].includes(recType)){await wizard.setAnswer('recommendedAction',text);await wizard.goTo('workOrderDetails');return;}
    rt.ai.message='این پیشنهاد به‌طور خودکار به طبقه‌بندی خرابی، علت ریشه‌ای یا تکنسین تبدیل نمی‌شود.';wizard.render();
  }
  function saverFor(type,id,version){
    let rowVersion=Number(version)||1,timer=null,running=false,latest=null,waiters=[],lastError=null;
    async function flush(){if(running||!latest)return;running=true;const payload=latest;latest=null;const batch=waiters;waiters=[];let retryNewer=false;
      try{const saved=await api(`/api/${type==='request'?'requests':'work-orders'}/wizard-drafts/${part(id)}`,{method:'PATCH',body:JSON.stringify({rowVersion,draft:{answers:normalizedDraftAnswers(type,payload.answers),progress:payload.progress},stepId:payload.stepId})});rowVersion=Number(payloadData(saved).rowVersion)||rowVersion+1;lastError=null;batch.forEach(w=>w.resolve());}
      catch(error){lastError=error;if(latest){retryNewer=true;waiters=batch.concat(waiters);}else{latest=payload;batch.forEach(w=>w.reject(error));}throw error;}
      finally{running=false;if(latest&&(retryNewer||!lastError))flush().catch(()=>{});}}
    function save(value){latest=value;lastError=null;const promise=new Promise((resolve,reject)=>waiters.push({resolve,reject}));clearTimeout(timer);timer=setTimeout(()=>flush().catch(()=>{}),320);return promise;}
    async function flushAll(){clearTimeout(timer);if(latest&&!running)await flush();while(running)await new Promise(resolve=>setTimeout(resolve,0));if(latest)return flushAll();if(lastError)throw lastError;}
    return{save,get rowVersion(){return rowVersion;},flush:flushAll};
  }
  function shell(title,hostId,message=''){return`${typeof root.mhead==='function'?root.mhead(esc(title)):`<div class="m-head"><h3>${esc(title)}</h3><button class="x" onclick="closeModal()">×</button></div>`}<div class="m-body" style="padding:0"><div id="${hostId}">${message?`<div class="empty">${esc(message)}</div>`:''}</div></div>`;}
  function chooseDraft(type,title,drafts,rt,initialAnswers={}){
    const hostId='bfg-wizard-drafts',buttons=drafts.map(row=>`<button type="button" class="sw-option" data-sw-draft="${esc(row.id)}"><span><b>ادامهٔ پیش‌نویس</b><br><small>${esc(row.stepId||'ابتدای فرم')} — ${esc(row.updatedAt||'')}</small></span></button>`).join('');
    root.modal(`${shell(title,hostId)}<div class="sw-draft-actions"><button type="button" class="btn btn-primary" data-sw-new>شروع پیش‌نویس تازه</button></div><div class="sw-options" aria-label="پیش‌نویس‌های ذخیره‌شده">${buttons}</div><div class="sw-actions"><button type="button" class="btn btn-ghost" data-sw-close>بستن</button></div>`,true);
    const host=root.document.getElementById(hostId);host&&host.addEventListener('click',event=>{const button=event.target.closest('[data-sw-draft],[data-sw-new],[data-sw-close]');if(!button)return;if(button.hasAttribute('data-sw-close'))return root.closeModal();if(button.hasAttribute('data-sw-new'))return startWizard(type,title,rt,null,initialAnswers);const draft=drafts.find(row=>row.id===button.dataset.swDraft);if(draft)startWizard(type,title,rt,draft);});
  }
  async function open(type,initialAnswers={}){
    const title=type==='request'?'درخواست کار / ساخت و خدمات':'صدور دستورکار راهنمایی‌شده',draftPath=`/api/${type==='request'?'requests':'work-orders'}/wizard-drafts`;
    try{if(root.modal)root.modal(shell(title,'bfg-wizard-loading','در حال دریافت فهرست‌های واقعی و پیش‌نویس‌های Backend…'),true);const[existing,rt]=await Promise.all([api(draftPath),loadRuntime(type)]);chooseDraft(type,title,payloadData(existing)||[],rt,initialAnswers);}
    catch(error){const host=root.document.getElementById('bfg-wizard-loading');if(host){host.innerHTML=`<div class="sw-alert" role="alert">${esc(error.payload&&error.payload.error||error.message||'اتصال Backend برقرار نشد')}</div><button type="button" class="btn btn-primary" data-sw-retry>تلاش دوباره</button>`;host.addEventListener('click',event=>{if(event.target.closest('[data-sw-retry]'))open(type,initialAnswers);},{once:true});}}
  }
  async function loadDraft(rt,draft){const response=await api(`/api/${rt.type==='request'?'requests':'work-orders'}/wizard-drafts/${part(draft.id)}`);return payloadData(response)||draft;}
  function defaults(type){return type==='request'?{actionType:'',serviceType:'',factoryId:'',categoryId:ALL,equipmentId:'',subsystemId:'',failureType:'',failureOccurredAt:{date:'',time:''},stopProduction:'',stopOccurredAt:{date:'',time:''},stopDurationMinutes:'',urgency:'',description:'',extraDescription:'',unit:root.ME&&root.ME.unit||'',phone:'',needBy:{date:''},attachments:[]}: {requestId:'',requestRowVersion:null,workOrderType:'',factoryId:'',categoryId:ALL,equipmentId:'',subsystemId:'',priority:'',failureType:'',workDescription:'',probableCause:'',confirmedRootCause:'',recommendedAction:'',performedAction:'',estimatedHours:'',assignee:'',requiredParts:[],partQuantities:{},ptwRequired:false,ptwChoice:''};}
  function uuid(){if(root.crypto&&root.crypto.randomUUID)return root.crypto.randomUUID();return'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&3|8)).toString(16);});}
  const SAFE_FILE_EXTENSIONS=new Set(['pdf','png','jpg','jpeg','gif','webp','txt','csv','docx','xlsx','mp4','webm']);
  const DANGEROUS_FILE_EXTENSIONS=new Set(['exe','dll','bat','cmd','com','scr','msi','js','jse','mjs','cjs','vbs','vbe','ps1','sh','bash','jar','html','htm','svg','php','asp','aspx','py','rb','pl','apk','dmg','iso','lnk','reg','app','deb','rpm','elf','so','bin','cpl','msc','hta','wsf','gadget','inf','msp','msix','appx','swf','xhtml','xml','shtml','cgi','war','class','pif','cab','img','vhd','vhdx','wasm','pkg','scf','url','command','action','workflow']);
  function fileError(code,file){const messages={FILE_TOO_LARGE:'بیش از ۱۲ مگابایت است.',FILE_EMPTY:'خالی است.',FILE_NAME_REJECTED:'نام فایل مجاز نیست.',DANGEROUS_FILE_REJECTED:'پسوند خطرناک دارد.',FILE_TYPE_REJECTED:'نوع یا محتوای فایل با پسوند آن سازگار نیست.'};return Object.assign(new Error(`فایل «${file&&file.name||''}» ${messages[code]||'معتبر نیست.'}`),{code,fileName:file&&file.name});}
  async function preflightFiles(files){
    const selected=Array.from(files||[]);if(selected.length>10)throw Object.assign(new Error('حداکثر ۱۰ پیوست مجاز است.'),{code:'ATTACHMENT_LIMIT_REACHED'});
    for(const file of selected){
      if(Number(file.size)>MAX_FILE_BYTES)throw fileError('FILE_TOO_LARGE',file);
      if(!Number(file.size))throw fileError('FILE_EMPTY',file);
      const raw=String(file.name||''),base=raw.trim();if(!base||base!==raw||raw.length>180||raw.startsWith('.')||/[\\/\u0000]/.test(raw)||raw.includes('..'))throw fileError('FILE_NAME_REJECTED',file);
      const parts=raw.toLowerCase().split('.');if(parts.length<2||parts.some(ext=>!ext))throw fileError('FILE_NAME_REJECTED',file);
      if(parts.slice(1).some(ext=>DANGEROUS_FILE_EXTENSIONS.has(ext)))throw fileError('DANGEROUS_FILE_REJECTED',file);
      const ext=parts[parts.length-1];if(!SAFE_FILE_EXTENSIONS.has(ext))throw fileError('FILE_TYPE_REJECTED',file);
      const bytes=new Uint8Array(await file.arrayBuffer());const starts=(signature,offset=0)=>signature.every((value,index)=>bytes[offset+index]===value);
      let matches=false;
      if(ext==='png')matches=starts([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
      else if(ext==='jpg'||ext==='jpeg')matches=starts([0xff,0xd8,0xff]);
      else if(ext==='gif')matches=String.fromCharCode(...bytes.slice(0,4))==='GIF8';
      else if(ext==='webp')matches=String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
      else if(ext==='pdf')matches=String.fromCharCode(...bytes.slice(0,5))==='%PDF-';
      else if(ext==='docx'||ext==='xlsx')matches=starts([0x50,0x4b,0x03,0x04]);
      else if(ext==='mp4')matches=String.fromCharCode(...bytes.slice(4,8))==='ftyp';
      else if(ext==='webm')matches=starts([0x1a,0x45,0xdf,0xa3]);
      else if(ext==='txt'||ext==='csv')matches=!bytes.includes(0)&&!starts([0x4d,0x5a])&&!starts([0x7f,0x45,0x4c,0x46]);
      if(!matches)throw fileError('FILE_TYPE_REJECTED',file);
      const content=new TextDecoder('latin1').decode(bytes);
      if(ext==='pdf'&&/\/(?:JavaScript|JS|Launch|EmbeddedFile|OpenAction)\b/.test(content))throw fileError('FILE_TYPE_REJECTED',file);
      if((ext==='docx'||ext==='xlsx')&&/\.(?:exe|dll|bat|cmd|js|vbs|ps1|html|svg|php|sh)\b/i.test(content))throw fileError('FILE_TYPE_REJECTED',file);
    }
  }
  async function uploadFiles(requestId,files,rt){
    for(const file of files||[]){if(rt.uploadedFiles.has(file))continue;if(Number(file.size)>MAX_FILE_BYTES)throw fileError('FILE_TOO_LARGE',file);
      let token=rt.fileTokens.get(file);if(!token){token=uuid();rt.fileTokens.set(file,token);}
      await api(`/api/requests/${part(requestId)}/attachments`,{method:'POST',body:file,headers:{'content-type':file.type||'application/octet-stream','x-file-name':encodeURIComponent(file.name),'x-upload-token':token}});rt.uploadedFiles.add(file);
    }
  }
  async function startWizard(type,title,rt,selected,initialAnswers={}){
    let draft=null,answers=defaults(type),initialStepId=null;
    try{
      if(selected){draft=await loadDraft(rt,selected);answers=restoreAnswers(type,{...answers,...(draft.draft&&draft.draft.answers||{})});initialStepId=draft.stepId||null;await prepareExisting(rt,answers);}
      else if(initialAnswers&&typeof initialAnswers==='object'){
        answers=restoreAnswers(type,{...answers,...initialAnswers});
        await prepareExisting(rt,answers);
      }
      let steps=type==='request'?requestSteps(rt):workOrderSteps(rt);
      if(!selected){const first=steps.find(step=>step.kind!=='review');const created=await api(`/api/${type==='request'?'requests':'work-orders'}/wizard-drafts`,{method:'POST',body:JSON.stringify({wizardType:type,draft:{answers:normalizedDraftAnswers(type,answers),progress:0},stepId:first.id})});draft=payloadData(created);}
      steps=type==='request'?requestSteps(rt):workOrderSteps(rt);
      if(type==='work_order')configureQuantities(rt,answers);
      root.modal(shell(title,'bfg-step-wizard-host'),true);const host=root.document.getElementById('bfg-step-wizard-host');if(!host)throw new Error('WIZARD_HOST_NOT_FOUND');
      state.draftId=draft.id;state.draftVersion=Number(draft.rowVersion)||1;const saver=saverFor(type,draft.id,state.draftVersion);state.saver=saver;
      let submitted=null;
      const wizard=root.BFGStepWizard.create({root:host,title,eyebrow:type==='request'?'درخواست کار / ساخت و خدمات':'دستورکار و گردش تعمیرات',steps,initialAnswers:answers,initialStepId,focusOnRender:true,
        onChange:payload=>saver.save(payload),persistenceErrorText:'ذخیرهٔ پیش‌نویس در Backend انجام نشد؛ پیش از ادامه اتصال را بازیابی کنید.',
        confirmText:type==='request'?'اطلاعات درخواست کار را بررسی و تأیید می‌کنم.':'اطلاعات دستورکار و پیوند درخواست را بررسی و صدور را تأیید می‌کنم.',
        submitLabel:type==='request'?'تأیید و ثبت درخواست کار':'تأیید و صدور دستورکار',
        confirmSubmit:async()=>root.confirm(type==='request'?'درخواست کار با همین اطلاعات در سرور ثبت شود؟':'دستورکار با همین اطلاعات در سرور صادر شود؟'),
        submitError:error=>{if(error&&error.fileName&&error.message)return error.message;if(submitted)return`رکورد ${submitted.no||submitted.id} ثبت شده، اما بارگذاری همهٔ پیوست‌ها کامل نشد؛ فایل‌ها را اصلاح و دوباره تلاش کنید. رکورد تکراری ساخته نمی‌شود.`;const code=error&&(error.payload&&error.payload.error||error.message);if(code==='FINAL_CONFIRMATION_REQUIRED')return'تأیید صریح در مرحلهٔ مرور الزامی است.';if(code==='WORK_PERMIT_REQUIRED')return'شروع کار تا صدور مجوز معتبر مجاز نیست.';if(code==='INSUFFICIENT_AVAILABLE_STOCK')return'موجودی آزاد این قلم کافی نیست؛ مقدار را بازبینی کنید. رزروی انجام نشد.';if(code==='VERSION_CONFLICT')return'پیش‌نویس یا درخواست مبدأ هم‌زمان تغییر کرده است؛ داده را تازه‌سازی و مرور کنید.';return'ثبت نهایی در Backend انجام نشد؛ پیش‌نویس ذخیره‌شده باقی است. '+(code||'');},
        onSubmitError:error=>{if(root.toast)root.toast(error.message||'ثبت در Backend ناموفق بود',1);},
        onAction:async({key,button,answers:current,wizard:currentWizard})=>{if(key==='ai-request'||key==='ai-work-order')return runAi(rt,currentWizard,current);if(key.startsWith('use-ai-'))return adoptAi(rt,currentWizard,current,button.dataset.swIndex,type);},
        onCancel:async()=>{if(submitted){if(!root.confirm(`رکورد ${submitted.no||submitted.id} ثبت شده است. پنجره بسته شود؟`))return;state.allowClose=true;root.closeModal();return;}try{await saver.flush();await api(`/api/${type==='request'?'requests':'work-orders'}/wizard-drafts/${part(draft.id)}/cancel`,{method:'POST',body:JSON.stringify({rowVersion:saver.rowVersion})});state.allowClose=true;root.closeModal();}catch(error){const code=error&&(error.payload&&error.payload.error||error.message)||'خطای نامشخص';if(state.activeWizard){state.activeWizard.state.message=`پیش‌نویس ذخیره یا لغو نشد؛ پنجره باز می‌ماند. ${code}`;state.activeWizard.render();}if(root.toast)root.toast(`پیش‌نویس ذخیره/لغو نشد: ${code}`,1);}},
        onSubmit:async payload=>{
          if(type==='request')await preflightFiles(payload.answers.attachments||[]);
          await saver.flush();
          if(!submitted){const result=await api(`/api/${type==='request'?'requests':'work-orders'}/wizard-drafts/${part(draft.id)}/submit`,{method:'POST',body:JSON.stringify({rowVersion:saver.rowVersion,confirmed:true})});const saved=payloadData(result)||{};submitted=saved.request||saved.workOrder;if(!submitted)throw new Error('SUBMITTED_RECORD_NOT_RETURNED');}
          if(type==='request')await uploadFiles(submitted.id,payload.answers.attachments||[],rt);
          if(root.BFGMaintenance&&typeof root.BFGMaintenance.sync==='function')await root.BFGMaintenance.sync({quiet:true});
          if(root.toast)root.toast(`${type==='request'?'درخواست کار':'دستورکار'} ${submitted.no||''} در Backend ثبت شد.`);
          state.allowClose=true;root.closeModal();if(root.go)root.go(type==='request'?'requests':'wos');
        }});
      state.activeWizard=wizard;
    }catch(error){
      root.modal(`${shell(title,'bfg-wizard-failure')}<div class="sw-alert" role="alert">${esc(error.payload&&error.payload.error||error.message||'ساخت ویزارد ناموفق بود')}</div><div class="sw-actions"><button type="button" class="btn btn-primary" data-sw-reopen>تلاش دوباره</button><button type="button" class="btn btn-ghost" data-sw-close>بستن</button></div>`,true);
      const dialog=root.document.querySelector('#modalRoot .modal');dialog&&dialog.addEventListener('click',event=>{if(event.target.closest('[data-sw-close]'))root.closeModal();if(event.target.closest('[data-sw-reopen]'))open(type,selected?{}:initialAnswers);});
    }
  }
  function installCloseHook(){if(state.closeWrapped||typeof root.closeModal!=='function')return;const original=root.closeModal;root.closeModal=function(...args){if(state.activeWizard&&!state.allowClose){if(!state.closePending&&typeof state.activeWizard.cancel==='function'){state.closePending=true;Promise.resolve(state.activeWizard.cancel()).catch(()=>{}).finally(()=>{state.closePending=false;});}return;}if(state.allowClose)state.allowClose=false;if(state.activeWizard){state.activeWizard.destroy();state.activeWizard=null;}state.saver=null;state.draftId=null;state.draftVersion=null;return original.apply(this,args);};state.closeWrapped=true;}
  function linkedAssetAnswers(options={}){
    return{
      equipmentId:options&&options.equipmentId?String(options.equipmentId):'',
      factoryId:options&&options.factoryId?String(options.factoryId):''
    };
  }
  function openRequest(options={}){installCloseHook();return open('request',linkedAssetAnswers(options));}
  function openWorkOrder(options={}){installCloseHook();return open('work_order',linkedAssetAnswers(options));}
  return{NONE,MAX_FILE_BYTES,ACTIONS,SERVICES,FAILURE_TYPES,PRIORITIES,WO_TYPES,mapRequestAnswers,mapWorkOrderAnswers,normalizedDraftAnswers,restoreAnswers,validAi,preflightFiles,requestSteps,workOrderSteps,configureQuantities,factoryIdFor,openRequest,openWorkOrder,_state:state};
});
