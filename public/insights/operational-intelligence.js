/* Deterministic operational intelligence across CMMS domains.
   This is not an LLM substitute: it calculates explainable signals from recorded data,
   exposes data sufficiency, and reports Backend AI availability without fake responses. */
(function(){
  'use strict';
  const clamp=value=>Math.max(0,Math.min(100,Number(value)||0));
  const active=a=>a&&!a.deleted&&a.isActive!==false&&a.is_active!==false;
  const kind=a=>a?.ext?.nodeKind||a?.nodeKind||(a?.type==='site'?'factory':a?.type==='eq'?'equipment':'location');
  const date=value=>{const parsed=value?new Date(value):null;return parsed&&!Number.isNaN(parsed.getTime())?parsed:null;};
  const ageDays=value=>{const parsed=date(value);return parsed?Math.max(0,(Date.now()-parsed.getTime())/864e5):null;};
  const fmt=value=>typeof fa==='function'?fa(value):String(value);
  const safe=value=>typeof esc==='function'?esc(value):String(value??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const database=()=>window.DB||{assets:[],wos:[],pms:[],items:[],requests:[]};

  function equipmentHealth(asset){
    const db=database(),factors=[];
    const add=(key,label,value,weight,evidence)=>Number.isFinite(value)&&factors.push({key,label,value:clamp(value),weight,evidence});
    const statusScore={active:100,standby:82,repair:42,maintenance:55,stopped:12,inactive:8}[asset.status];
    add('status','وضعیت بهره‌برداری',statusScore,24,`وضعیت ثبت‌شده: ${asset.status||'نامشخص'}`);

    const plans=(db.pms||[]).filter(p=>p.assetId===asset.id&&!p.deleted);
    if(plans.length){
      let onTime=0;
      for(const plan of plans){const last=date(plan.last||plan.lastRun),interval=Number(plan.interval||plan.intervalDays);if(last&&interval>0&&Date.now()<=last.getTime()+interval*864e5)onTime++;}
      add('pm','انطباق PM',100*onTime/plans.length,27,`${onTime} از ${plans.length} برنامه در محدوده سررسید`);
    }

    const orders=(db.wos||[]).filter(w=>w.assetId===asset.id),open=orders.filter(w=>!['closed','done','completed','cancel'].includes(w.status));
    if(orders.length)add('backlog','بار دستورکار باز',100-Math.min(100,open.length*18+open.filter(w=>w.priority==='critical').length*25),20,`${open.length} دستورکار باز از ${orders.length} سابقه`);

    const completed=orders.filter(w=>['closed','done','completed'].includes(w.status));
    const recentFailures=completed.filter(w=>['BD','CM','EM'].includes(w.type)&&((ageDays(w.times?.end||w.createdAt||w.created_at)??999)<=180));
    if(completed.length)add('failures','تکرار خرابی',100-Math.min(100,recentFailures.length*20),17,`${recentFailures.length} خرابی تکمیل‌شده در ۱۸۰ روز`);

    const linked=(db.items||[]).filter(item=>(item.keyFor||item.key_for||[]).includes(asset.id));
    if(linked.length){const available=linked.filter(item=>Number(item.stock)>=Number(item.min??item.minStock??0)).length;add('spares','آمادگی قطعات کلیدی',100*available/linked.length,12,`${available} از ${linked.length} قطعه کلیدی بالای حداقل`);}

    if(factors.length<3)return{score:null,status:'insufficient_data',coverage:factors.length,evidence:factors,reason:'حداقل سه عامل معتبر برای محاسبه سلامت لازم است.'};
    const weight=factors.reduce((sum,factor)=>sum+factor.weight,0),score=Math.round(factors.reduce((sum,factor)=>sum+factor.value*factor.weight,0)/weight);
    return{score,status:score>=80?'healthy':score>=60?'attention':score>=40?'degraded':'critical',coverage:factors.length,evidence:factors,reason:null};
  }

  function factoryOf(asset){
    const db=database();let current=asset,guard=0,candidate=null;
    while(current&&guard++<64){if(kind(current)==='factory')return current;if(current.type==='site')candidate=current;current=current.parent?(db.assets||[]).find(x=>x.id===current.parent):null;}
    return candidate;
  }
  function equipmentPortfolio(){
    const assets=(database().assets||[]).filter(a=>a.type==='eq'&&active(a));
    const rows=assets.map(asset=>({asset,health:equipmentHealth(asset),factory:factoryOf(asset)}));
    const eligible=rows.filter(row=>row.health.score!=null);
    const score=eligible.length?Math.round(eligible.reduce((sum,row)=>sum+row.health.score,0)/eligible.length):null;
    const groups=new Map();
    for(const row of rows){const id=row.factory?.id||'unassigned',entry=groups.get(id)||{id,name:row.factory?.name||'فاقد کارخانه مشخص',rows:[]};entry.rows.push(row);groups.set(id,entry);}
    const factories=[...groups.values()].map(group=>{const valid=group.rows.filter(row=>row.health.score!=null);return{...group,total:group.rows.length,eligible:valid.length,score:valid.length?Math.round(valid.reduce((sum,row)=>sum+row.health.score,0)/valid.length):null};});
    return{score,total:rows.length,eligible:eligible.length,insufficient:rows.length-eligible.length,rows,factories};
  }
  function inventory(){const items=database().items||[],low=items.filter(i=>Number(i.stock)<Number(i.min??i.minStock??0)),near=items.filter(i=>{const min=Number(i.min??i.minStock??0);return Number(i.stock)>=min&&Number(i.stock)<=min*1.3;});return{score:items.length?Math.round(100*(items.length-low.length-near.length*.4)/items.length):null,total:items.length,low:low.length,near:near.length,alerts:low.slice(0,3).map(i=>`${i.name}: موجودی ${i.stock} / حداقل ${i.min??i.minStock}`)};}
  function workOrders(){const all=database().wos||[],open=all.filter(w=>!['closed','done','completed','cancel'].includes(w.status)),critical=open.filter(w=>w.priority==='critical'),unassigned=open.filter(w=>!w.assignee),aged=open.filter(w=>(ageDays(w.createdAt||w.created_at)??0)>7);return{score:all.length?Math.round(clamp(100-critical.length*15-unassigned.length*5-aged.length*8)):null,total:all.length,open:open.length,critical:critical.length,unassigned:unassigned.length,aged:aged.length,alerts:[critical.length&&`${critical.length} دستورکار بحرانی باز`,unassigned.length&&`${unassigned.length} دستورکار بدون مسئول`,aged.length&&`${aged.length} دستورکار باز بیش از ۷ روز`].filter(Boolean)};}
  function requests(){const all=database().requests||[],pending=all.filter(r=>['new','review'].includes(r.status)),critical=pending.filter(r=>r.urgency==='critical'),aged=pending.filter(r=>(ageDays(r.createdAt||r.created_at)??0)>3),converted=all.filter(r=>r.status==='wo'||r.woId).length;return{score:all.length?Math.round(clamp(100-critical.length*18-aged.length*10)):null,total:all.length,pending:pending.length,critical:critical.length,aged:aged.length,converted,alerts:[critical.length&&`${critical.length} درخواست اضطراری در انتظار`,aged.length&&`${aged.length} درخواست با عمر بیش از ۳ روز`].filter(Boolean)};}
  function preventive(){const plans=database().pms||[],now=Date.now(),overdue=plans.filter(plan=>{const last=date(plan.last||plan.lastRun),interval=Number(plan.interval||plan.intervalDays);return last&&interval>0&&last.getTime()+interval*864e5<now;});return{score:plans.length?Math.round(100*(plans.length-overdue.length)/plans.length):null,total:plans.length,overdue:overdue.length,alerts:overdue.slice(0,3).map(plan=>`${plan.title}: سررسید گذشته`)};}
  function overall(){const eq=equipmentPortfolio(),inv=inventory(),wo=workOrders(),pm=preventive(),scores=[eq.score,inv.score,wo.score,pm.score].filter(Number.isFinite);return{score:scores.length?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length):null,equipment:eq,inventory:inv,workOrders:wo,pm};}

  function scoreBadge(score){if(score==null)return'<span class="badge b-gray">N/A — داده ناکافی</span>';const cls=score>=80?'b-green':score>=60?'b-blue':score>=40?'b-orange':'b-red';return`<span class="badge ${cls}">${fmt(score)} از ۱۰۰</span>`;}
  function aiBadge(){const online=typeof window.aiOnline==='function'&&window.aiOnline();return`<span class="badge ${online?'b-purple':'b-gray'}">${online?'AI Gateway آماده':'AI مولد غیرفعال'}</span>`;}
  function panel(domain){
    let result,title,metrics=[];
    if(domain==='equipment'){result=equipmentPortfolio();title='سلامت ناوگان تجهیزات';metrics=[['تجهیز قابل محاسبه',`${fmt(result.eligible)} / ${fmt(result.total)}`],['داده ناکافی',fmt(result.insufficient)],['کارخانه‌ها',fmt(result.factories.length)]];}
    if(domain==='inventory'){result=inventory();title='سلامت هوشمند انبار';metrics=[['کل اقلام',fmt(result.total)],['زیر نقطه سفارش',fmt(result.low)],['نزدیک حداقل',fmt(result.near)]];}
    if(domain==='wos'){result=workOrders();title='سلامت گردش دستورکار';metrics=[['باز',fmt(result.open)],['بحرانی',fmt(result.critical)],['بدون مسئول',fmt(result.unassigned)],['بیش از ۷ روز',fmt(result.aged)]];}
    if(domain==='requests'){result=requests();title='سلامت درخواست‌های تعمیر';metrics=[['در انتظار',fmt(result.pending)],['اضطراری',fmt(result.critical)],['تبدیل‌شده به WO',fmt(result.converted)],['بیش از ۳ روز',fmt(result.aged)]];}
    if(domain==='pm'){result=preventive();title='سلامت برنامه PM';metrics=[['برنامه فعال',fmt(result.total)],['سررسیدگذشته',fmt(result.overdue)],['انطباق',result.score==null?'N/A':`٪${fmt(result.score)}`]];}
    if(domain==='kpi'){result=overall();title='کنترل یکپارچه شاخص‌ها';metrics=[['تجهیزات',result.equipment.score??'N/A'],['انبار',result.inventory.score??'N/A'],['دستورکار',result.workOrders.score??'N/A'],['PM',result.pm.score??'N/A']];}
    if(!result)return'';
    const alerts=result.alerts||[];
    return`<section class="ops-intel" data-domain="${domain}"><div class="ops-intel-head"><div><b>◉ ${safe(title)}</b><span>محاسبه قطعی و قابل ردیابی از داده‌های ثبت‌شده</span></div><div>${scoreBadge(result.score)} ${aiBadge()}</div></div><div class="ops-intel-metrics">${metrics.map(([label,value])=>`<div><span>${safe(label)}</span><b>${safe(value)}</b></div>`).join('')}</div>${alerts.length?`<div class="ops-intel-alerts">${alerts.map(alert=>`<span>⚠ ${safe(alert)}</span>`).join('')}</div>`:''}${domain==='equipment'?factoryBars(result.factories):''}</section>`;
  }
  function factoryBars(factories){return`<div class="ops-factory-health">${factories.map(factory=>`<div><span title="${safe(factory.name)}">${safe(factory.name)}</span><i><em style="width:${factory.score??0}%"></em></i><b>${factory.score==null?'N/A':fmt(factory.score)+'٪'} <small>${fmt(factory.eligible)}/${fmt(factory.total)}</small></b></div>`).join('')||'<div class="muted">کارخانه‌ای در دامنه فعلی ثبت نشده است.</div>'}</div>`;}

  function insertBefore(html,marker,content){return html.includes(marker)?html.replace(marker,content+marker):html+content;}
  function wrap(name,domain,marker){const original=window[name];if(typeof original!=='function'||original.__opsWrapped)return;const wrapped=function(...args){return insertBefore(original.apply(this,args),marker,panel(domain));};wrapped.__opsWrapped=true;window[name]=wrapped;}
  wrap('pgTree','equipment','<div class="eqv2-toolbar">');
  wrap('pgInv','inventory','<div class="grid g3"');
  wrap('pgWOs','wos','<div class="wo-list-summary">');
  wrap('pgRequests','requests','<div class="tbl-tools">');
  wrap('pgPM','pm','<div class="grid g3"');
  wrap('pgKPI','kpi','<h3 style="margin:6px 0 10px">');

  window.BFGOperationalIntelligence={equipmentHealth,equipmentPortfolio,inventory,workOrders,requests,preventive,overall,panel};
})();
