/* Shared Equipment Registry adapter: PostgreSQL first, explicit local compatibility otherwise. */
(function(){
  'use strict';

  const token=()=>sessionStorage.getItem('bfg_token')||sessionStorage.getItem('token');
  const apiAvailable=()=>Boolean(token());
  const active=a=>a&&!a.deleted&&a.isActive!==false&&a.is_active!==false;
  const nodeKind=a=>a?.ext?.nodeKind||a?.nodeKind||(a?.type==='eq'?'equipment':a?.type==='site'?'factory':'location');

  async function api(path,options={}){
    const response=await fetch('/api/equipment'+path,{
      ...options,
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+token(),...(options.headers||{})}
    });
    if(!response.ok){
      const payload=await response.json().catch(()=>({}));
      throw Object.assign(new Error(payload.error||`HTTP ${response.status}`),{status:response.status,payload});
    }
    return response.json();
  }

  function ancestry(asset){
    const result=[];let current=asset,guard=0;
    while(current&&guard++<64){result.unshift(current);current=current.parent?DB.assets.find(x=>x.id===current.parent):null;}
    return result;
  }
  function itemById(id){return (DB.items||[]).find(x=>x.id===id);}
  function actualDurationHours(wo){
    const t=wo.times||{};
    if(Number.isFinite(Number(t.durationHours)))return Number(t.durationHours);
    if(t.start&&t.end){const hours=(new Date(t.end)-new Date(t.start))/36e5;return hours>=0?hours:null;}
    return null;
  }
  function actualCost(wo){
    let known=false,total=0;
    (wo.parts||[]).forEach(part=>{const item=itemById(part.itemId||part.item_id);if(item&&Number.isFinite(Number(item.price))){known=true;total+=Number(part.qty||0)*Number(item.price);}});
    const costs=wo.costs||{};
    Object.values(costs).forEach(value=>{if(Number.isFinite(Number(value))){known=true;total+=Number(value);}});
    return known?total:null;
  }

  function dto(a){
    const path=ancestry(a),factory=path.find(x=>nodeKind(x)==='factory'),category=path.find(x=>nodeKind(x)==='category'),parent=DB.assets.find(x=>x.id===a.parent);
    const pms=(DB.pms||[]).filter(p=>p.assetId===a.id&&!p.deleted);
    const sortedPms=[...pms].sort((x,y)=>new Date(y.last||y.lastRun||0)-new Date(x.last||x.lastRun||0));
    const last=sortedPms[0],lastDate=last&&(last.last||last.lastRun),interval=last&&(last.interval||last.intervalDays);
    const next=lastDate?new Date(new Date(lastDate).getTime()+(Number(interval)||30)*864e5):null;
    const workOrders=(DB.wos||[]).filter(w=>w.assetId===a.id);
    const requests=(DB.requests||[]).filter(r=>r.assetId===a.id);
    const completed=workOrders.filter(w=>['closed','done','completed'].includes(w.status));
    const spareParts=(DB.items||[]).filter(i=>(i.keyFor||i.key_for||[]).includes(a.id));
    const consumed=[];
    workOrders.forEach(w=>(w.parts||[]).forEach(part=>{const item=itemById(part.itemId||part.item_id);consumed.push({wo_id:w.id,wo_no:w.no,item_id:item?.id||part.itemId,item_code:item?.code||'',item_name:item?.name||'قطعه ثبت‌شده',qty:Number(part.qty)||0,unit:item?.unit||'',unit_price:item?.price??null,at:w.times?.end||w.createdAt||null});}));
    const costs=workOrders.map(w=>({wo_id:w.id,wo_no:w.no,at:w.times?.end||w.createdAt||null,amount:actualCost(w)})).filter(x=>x.amount!==null);
    const downtimes=completed.map(w=>({wo_id:w.id,wo_no:w.no,start:w.times?.start||null,end:w.times?.end||null,hours:actualDurationHours(w),reason:w.desc||w.descr||''})).filter(x=>x.hours!==null);
    return {
      id:a.id,parent:a.parent,code:a.code,name:a.name,type:a.type,cls:a.cls,status:a.status,crit:a.crit,
      maker:a.maker,model:a.model,serial:a.serial,year:a.year,install:a.install,power:a.power,hours:a.hours||0,
      is_active:active(a),sort_order:a.sortOrder||a.sort_order||0,row_version:a.rowVersion||a.row_version||1,
      health_score:a.healthScore??a.health_score??null,category_id:a.categoryId||a.category_id||null,
      category_name:category?.name||a.cat||'—',factory_id:factory?.id||null,factory_name:factory?.name||'—',
      location_name:parent?.name||'—',parent_name:parent?.name||'—',last_run:lastDate||null,next_pm:next?.toISOString()||null,
      open_wo:workOrders.filter(w=>!['closed','cancel','done','completed'].includes(w.status)).length,
      maintenance_cost:costs.length?costs.reduce((sum,x)=>sum+x.amount,0):null,
      child_count:DB.assets.filter(x=>x.parent===a.id&&active(x)).length,
      path:path.map(x=>({id:x.id,code:x.code,name:x.name,type:x.type,nodeKind:nodeKind(x)})),
      children:DB.assets.filter(x=>x.parent===a.id&&active(x)).map(x=>({id:x.id,parent:x.parent,code:x.code,name:x.name,type:x.type,status:x.status,crit:x.crit,nodeKind:nodeKind(x),child_count:DB.assets.filter(y=>y.parent===x.id&&active(y)).length})),
      pm_plans:pms.map(p=>({id:p.id,title:p.title,interval_days:p.intervalDays||p.interval,last_run:p.lastRun||p.last,status:p.status||'active',checklist:p.checklist||[]})),
      work_orders:workOrders.map(w=>({...w,descr:w.desc||w.descr,created_at:w.createdAt||w.created_at,duration_hours:actualDurationHours(w),actual_cost:actualCost(w)})),
      requests:requests.map(r=>({...r,descr:r.desc||r.descr,created_at:r.createdAt||r.created_at})),
      maintenance_history:completed.map(w=>({...w,descr:w.desc||w.descr,created_at:w.createdAt||w.created_at,duration_hours:actualDurationHours(w)})),
      spare_parts:spareParts.map(i=>({id:i.id,code:i.code,name:i.name,unit:i.unit,stock:i.stock,minimum:i.minStock??i.min_stock})),
      consumed_parts:consumed,cost_entries:costs,downtimes,
      documents:(DB.docs||[]).filter(d=>d.assetId===a.id||d.asset_id===a.id),
      risks:a.risks||a.ext?.risks||[],rca:completed.map(w=>({wo_id:w.id,wo_no:w.no,at:w.times?.end||w.createdAt||null,root_cause:w.report?.rootCause||w.report?.rca||null,action:w.report?.correctiveAction||null})).filter(x=>x.root_cause),
      movements:a.history||[],ext:{...(a.ext||{}),nodeKind:nodeKind(a)}
    };
  }

  function auditLocal(action,a,before){
    DB.auditX=DB.auditX||[];
    DB.auditX.unshift({id:uid(),t:new Date().toISOString(),u:ME?.name||'-',uid:ME?.id,role:ME?.role,action,mod:'equipment',entity:a.id,note:a.code,before,after:{...a}});
    if(typeof audit==='function')audit(`Equipment — ${action} ${a.code}`);
    save();
  }

  const local={
    source:'local-compatibility',
    async feature(){DB.featureFlags=DB.featureFlags||{};if(DB.featureFlags.equipmentV2===undefined)DB.featureFlags.equipmentV2=true;return{key:'equipment_v2',enabled:DB.featureFlags.equipmentV2,rollout_percent:100,metadata:{mode:'local-compatibility'}};},
    async filters(){
      const factories=DB.assets.filter(a=>active(a)&&nodeKind(a)==='factory').map(a=>({id:a.id,code:a.code,name:a.name}));
      const categories=DB.assets.filter(a=>active(a)&&nodeKind(a)==='category').map(a=>{const p=ancestry(a),factory=p.find(x=>nodeKind(x)==='factory');return{id:a.id,code:a.code,name:a.name,factory_id:factory?.id||null};});
      return{factories,categories};
    },
    async list(query={}){
      let rows=DB.assets.filter(a=>a.type==='eq'&&active(a)).map(dto),text=(query.q||'').toLowerCase();
      if(text)rows=rows.filter(a=>[a.code,a.name,a.serial,a.model,a.maker].some(v=>String(v||'').toLowerCase().includes(text)));
      if(query.factoryId)rows=rows.filter(a=>a.factory_id===query.factoryId);
      if(query.categoryId)rows=rows.filter(a=>a.category_id===query.categoryId||a.path.some(x=>x.id===query.categoryId));
      if(query.status)rows=rows.filter(a=>a.status===query.status);
      if(query.criticality)rows=rows.filter(a=>a.crit===query.criticality);
      const key={code:'code',name:'name',status:'status',criticality:'crit',sortOrder:'sort_order'}[query.sort]||'sort_order',direction=query.direction==='desc'?-1:1;
      rows.sort((a,b)=>String(a[key]??'').localeCompare(String(b[key]??''),'fa')*direction);
      const page=Number(query.page)||1,limit=Number(query.limit)||25,total=rows.length;
      return{data:rows.slice((page-1)*limit,page*limit),pagination:{page,limit,total,pages:Math.ceil(total/limit)||1},source:this.source};
    },
    async tree({parentId=null,q='',factoryId='',categoryId='',status='',criticality=''}={}){
      let rows=DB.assets.filter(a=>active(a)&&a.parent===parentId);
      if(q){const text=q.toLowerCase();rows=DB.assets.filter(a=>active(a)&&((a.code||'').toLowerCase().includes(text)||(a.name||'').toLowerCase().includes(text)));}
      if(factoryId||categoryId||status||criticality){
        const matching=DB.assets.filter(a=>a.type==='eq'&&active(a)).map(dto).filter(a=>(!factoryId||a.factory_id===factoryId)&&(!categoryId||a.category_id===categoryId||a.path.some(x=>x.id===categoryId))&&(!status||a.status===status)&&(!criticality||a.crit===criticality));
        const visible=new Set();matching.forEach(a=>a.path.forEach(x=>visible.add(x.id)));
        rows=rows.filter(a=>visible.has(a.id));
      }
      return{data:rows.map(dto).sort((a,b)=>a.sort_order-b.sort_order||a.name.localeCompare(b.name,'fa')),parentId,source:this.source};
    },
    async get(idOrCode){const a=DB.assets.find(x=>active(x)&&(x.id===idOrCode||String(x.code).toLowerCase()===String(idOrCode).toLowerCase()));if(!a)throw Object.assign(new Error('NOT_FOUND'),{status:404});return{data:dto(a),source:this.source};},
    async create(data){const a={id:uid(),parent:data.parentId||null,code:data.code,name:data.name,type:['equipment','sub-equipment','subsystem','main-component','sub-component'].includes(data.nodeKind)?'eq':data.nodeKind==='factory'||data.nodeKind==='company'?'site':'unit',cls:data.cls||'',status:data.status||'active',crit:data.crit||'C',maker:data.maker||'',model:data.model||'',serial:data.serial||'',hours:Number(data.hours)||0,sortOrder:Number(data.sortOrder)||0,rowVersion:1,ext:{...(data.ext||{}),nodeKind:data.nodeKind}};if(DB.assets.some(x=>x.code===a.code&&active(x)))throw Object.assign(new Error('DUPLICATE_CODE'),{status:409});DB.assets.push(a);auditLocal('create',a,null);return{data:dto(a)};},
    async update(id,patch){const a=DB.assets.find(x=>x.id===id&&active(x));if(!a)throw Object.assign(new Error('NOT_FOUND'),{status:404});if(patch.rowVersion!==undefined&&Number(patch.rowVersion)!==Number(a.rowVersion||1))throw Object.assign(new Error('VERSION_CONFLICT'),{status:409});const before={...a},map={categoryId:'categoryId',sortOrder:'sortOrder',isActive:'isActive'};Object.entries(patch).forEach(([key,value])=>{if(key!=='rowVersion')a[map[key]||key]=value;});a.rowVersion=(a.rowVersion||1)+1;a.updatedAt=new Date().toISOString();auditLocal('edit',a,before);return{data:dto(a)};},
    async move(id,{parentId=null,sortOrder=0,rowVersion,reason=''}){const a=DB.assets.find(x=>x.id===id&&active(x));if(!a)throw Object.assign(new Error('NOT_FOUND'),{status:404});if(rowVersion!==undefined&&Number(rowVersion)!==Number(a.rowVersion||1))throw Object.assign(new Error('VERSION_CONFLICT'),{status:409});let p=parentId?DB.assets.find(x=>x.id===parentId&&active(x)):null,guard=0;while(p&&guard++<64){if(p.id===id)throw Object.assign(new Error('TREE_CYCLE'),{status:422});p=p.parent?DB.assets.find(x=>x.id===p.parent):null;}const before={...a};a.parent=parentId;a.sortOrder=Number(sortOrder)||0;a.rowVersion=(a.rowVersion||1)+1;a.history=a.history||[];a.history.push({t:new Date().toISOString(),x:`جابه‌جایی ساختاری توسط ${ME?.name||'-'} — ${reason}`});auditLocal('move',a,before);return{data:dto(a)};},
    async remove(id,reason=''){const a=DB.assets.find(x=>x.id===id&&active(x));if(!a)throw Object.assign(new Error('NOT_FOUND'),{status:404});if(DB.assets.some(x=>x.parent===id&&active(x)))throw Object.assign(new Error('HAS_ACTIVE_CHILDREN'),{status:409});const before={...a};a.deleted=true;a.deletedAt=new Date().toISOString();a.deletedBy=ME?.id;a.deleteReason=reason;a.isActive=false;a.status='stopped';a.rowVersion=(a.rowVersion||1)+1;auditLocal('soft-delete',a,before);return{data:dto({...a,deleted:false,isActive:true}),historyPreserved:true};}
  };

  const remote={
    source:'postgresql',feature:()=>api('/feature'),filters:()=>api('/filters'),
    list:q=>api('/?'+new URLSearchParams(Object.entries(q).filter(([,v])=>v!==''&&v!=null))),
    tree:q=>api('/tree?'+new URLSearchParams(Object.entries(q).filter(([,v])=>v!==''&&v!=null))),
    get:id=>api('/'+encodeURIComponent(id)),create:data=>api('/',{method:'POST',body:JSON.stringify(data)}),
    update:(id,data)=>api('/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(data)}),
    move:(id,data)=>api('/'+encodeURIComponent(id)+'/move',{method:'POST',body:JSON.stringify(data)}),
    remove:(id,reason)=>api('/'+encodeURIComponent(id),{method:'DELETE',body:JSON.stringify({reason})})
  };

  window.EquipmentRepository={mode:apiAvailable()?'postgresql':'local-compatibility',current(){return apiAvailable()?remote:local;},remote,local};
})();
