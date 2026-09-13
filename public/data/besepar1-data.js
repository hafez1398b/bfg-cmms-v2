/* Canonical Bespar 1 dataset importer — idempotent, non-destructive local/demo adapter. */
(function () {
  'use strict';
  const DATA_URL='/data/besepar1.seed.json';
  const digitMap={'۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'};
  const latin=s=>String(s||'').replace(/[۰-۹]/g,x=>digitMap[x]);
  const isoDate=s=>{
    try { if(typeof jStr2iso==='function') return jStr2iso(latin(s)); } catch(_){}
    return new Date().toISOString();
  };
  const categoryClass={
    'ماشین‌آلات تولید':'ماشین‌آلات تولید','عمرانی':'ساختمان و تأسیسات','ایمنی و پشتیبانی':'تجهیزات ایمنی',
    'برق':'تجهیزات برقی','اداری':'اداری','آی‌تی':'فناوری اطلاعات','ترابری':'خودرو و ماشین‌آلات متحرک',
    'ابزارآلات':'ابزار','اندازه‌گیری':'تجهیزات ابزار دقیق','گیاهان':'فضای سبز'
  };

  function upsertBy(arr,key,value,record){
    const found=arr.find(x=>x[key]===value);
    if(found){Object.assign(found,record,{id:found.id});return found;}
    arr.push(record);return record;
  }
  function roleLabel(spec){return spec.includes('برق')?'برق':spec.includes('تأسیسات')?'تأسیسات':spec.includes('جوش')?'جوشکاری':'مکانیک';}

  async function importBespar1(){
    if(typeof DB==='undefined'||!DB)return;
    try{
      const data=await fetch(DATA_URL,{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();});
      DB.bespar1Data=DB.bespar1Data||{};
      // Canonical enterprise hierarchy: Company → Head Office / Factories → B1…B6.
      const company=upsertBy(DB.assets,'code','BFG',{
        id:'bfg-company',parent:null,code:'BFG',name:'شرکت بسپار فوم غرب',type:'site',status:'active',cls:'شرکت',nodeKind:'company',ext:{datasetVersion:data.version,hierarchyVersion:'1.0'}
      });
      upsertBy(DB.assets,'code','BFG-HQ',{
        id:'bfg-head-office',parent:company.id,code:'BFG-HQ',name:'دفتر مرکزی',type:'unit',status:'active',cls:'دفتر مرکزی',nodeKind:'head-office',ext:{datasetVersion:data.version}
      });
      const factories=upsertBy(DB.assets,'code','BFG-PLANTS',{
        id:'bfg-factories',parent:company.id,code:'BFG-PLANTS',name:'کارخانجات',type:'unit',status:'active',cls:'کارخانجات',nodeKind:'factories'
      });
      const root=upsertBy(DB.assets,'code',data.factory.code,{
        id:data.factory.id,parent:factories.id,code:data.factory.code,name:data.factory.name,type:'site',status:'active',
        cls:'کارخانه',nodeKind:'factory',ext:{datasetVersion:data.version,source:'داده‌های تاییدشده کارخانه بسپار ۱'}
      });
      const catByName={};
      data.categories.forEach(c=>{
        const node=upsertBy(DB.assets,'code',c.code,{id:c.id,parent:root.id,code:c.code,name:c.name,type:'unit',status:'active',cls:categoryClass[c.name]||c.name,nodeKind:'category',cat:c.name,ext:{sortOrder:c.sortOrder,relation:'factory-category'}});
        catByName[c.name]=node;
      });
      // The same mandatory organizational taxonomy is created for Bespar 2–6.
      (data.otherFactories||[]).forEach(f=>{
        const site=upsertBy(DB.assets,'code',f.code,{id:f.id,parent:factories.id,code:f.code,name:f.name,type:'site',status:'active',cls:'کارخانه',nodeKind:'factory',ext:{datasetVersion:data.version,categoryTemplate:'Bespar-standard-v1'}});
        data.categories.forEach((c,index)=>upsertBy(DB.assets,'code',`${f.code}-CAT-${String(index+1).padStart(2,'0')}`,{id:`${f.id}-cat-${index+1}`,parent:site.id,code:`${f.code}-CAT-${String(index+1).padStart(2,'0')}`,name:c.name,type:'unit',status:'active',cls:categoryClass[c.name]||c.name,nodeKind:'category',cat:c.name,ext:{sortOrder:index+1,relation:'factory-category'}}));
      });

      const techByCanonical={};
      data.technicians.forEach(t=>{
        const u=upsertBy(DB.users,'u',t.username,{id:t.id,u:t.username,p:'1234',name:t.name,role:'tech',unit:'نگهداری و تعمیرات — بسپار ۱',spec:t.specialty,active:true,hr:{dataStatus:'imported',specialty:t.specialty}});
        techByCanonical[t.id]=u.id;
      });

      const assetIdMap={};
      data.equipment.forEach(e=>{
        const parent=e.parentEquipment ? (assetIdMap[e.parentEquipment]||e.parentEquipment) : catByName[e.category].id;
        const rec={
          id:e.id,parent,code:e.code,name:e.name,type:'eq',cls:e.parentEquipment?'زیرتجهیز':(categoryClass[e.category]||e.category),cat:e.category,
          status:e.status||'active',crit:e.criticality||'C',maker:e.maker||'',model:e.model||'',year:e.year||'',install:e.install||'',
          power:e.capacity||'',hours:0,nodeKind:e.parentEquipment?'sub':'main',history:(e.history||[]).map(h=>({t:isoDate(h.date),x:`${h.type} — ${h.title} — ${h.technician} — ${h.durationHours||'—'} ساعت`,source:'import-verified'})),
          ext:{factory:'بسپار ۱',locationDescription:e.location||'',capacity:e.capacity||'',dailyOperatingHours:e.dailyHours??null,criticalityScore:e.criticalityScore??null,keyParts:e.keyParts||[],preventiveMaintenance:e.pm||{},pmReference:e.pmRef||null,pmNote:e.pmNote||'',dailyInspection:e.dailyInspection||[],panelCode:e.panel||'',refrigerant:e.refrigerant||'',technicalSpecification:e.spec||'',requiresCoding:!!e.requiresCoding,dataStatus:e.dataStatus||'registered',datasetVersion:data.version}
        };
        const a=upsertBy(DB.assets,'code',e.code,rec);assetIdMap[e.id]=a.id;
      });

      data.spareParts.forEach(i=>{
        const linked=i.keyFor.map(id=>assetIdMap[id]||id);
        upsertBy(DB.items,'code',i.code,{id:i.id,code:i.code,name:i.name,unit:i.unit,stock:i.stock,min:i.minStock,minStock:i.minStock,price:i.priceToman,loc:'انبار فنی بسپار ۱',cat:'قطعات یدکی ماشین‌آلات',maxStock:null,partType:'یدکی',keyFor:linked,key_for:linked,ext:{currency:'TOMAN',supplyStatus:i.supplyStatus,factory:'بسپار ۱',datasetVersion:data.version}});
      });

      data.pmPlans.forEach(p=>{
        const aid=assetIdMap[p.assetId]||p.assetId;
        const rec={id:p.id,assetId:aid,title:p.title,interval:p.intervalDays,last:isoDate('۱۴۰۵/۰۱/۰۱'),spec:'مکانیک',checklist:p.checklist||[],kind:p.frequency,status:p.status||'active',recurring:p.recurring!==false,ext:{sourceReference:p.sourceReference||'',confirmationStatus:p.confirmationStatus||'confirmed',factory:'بسپار ۱'}};
        upsertBy(DB.pms,'id',p.id,rec);
      });

      // Verified history through 1404 is represented both in the asset timeline and as closed work orders.
      data.equipment.forEach(e=>(e.history||[]).forEach((h,index)=>{
        const no=`B1-H-${e.code}-${latin(h.date).replace(/\//g,'')}-${String(index+1).padStart(2,'0')}`;
        const tech=data.technicians.find(t=>t.name===h.technician);
        const rec={id:'hist-'+e.id+'-'+index,no,type:h.type==='PM'?'PM':'BD',assetId:assetIdMap[e.id]||e.id,desc:h.title,priority:h.type==='EM'?'high':'normal',assignee:tech?techByCanonical[tech.id]:null,status:'closed',times:{end:isoDate(h.date),durationHours:h.durationHours},parts:[],createdAt:isoDate(h.date),est:h.durationHours||0,report:{text:`سابقه ثبت‌شده: ${h.title}`,source:'historical-import',technicianName:h.technician,durationHours:h.durationHours,dataQuality:'verified-from-source'}};
        upsertBy(DB.wos,'no',no,rec);
      }));

      data.provisionalWorkOrders1405.forEach(w=>{
        const assignee=techByCanonical[w.assigneeId]||w.assigneeId;
        const assetId=w.assetId?(assetIdMap[w.assetId]||w.assetId):null;
        const date=w.periodLabel.length===10?w.periodLabel:w.periodLabel+'/۰۱';
        const rec={id:w.id,no:w.no,type:w.type,assetId,desc:w.title,priority:w.priority||'normal',assignee,status:w.status,parts:[],createdAt:isoDate(date),est:null,
          times:{periodLabel:w.periodLabel,periodOnly:w.periodLabel.length<10,start:null,end:null,requiresConfirmation:w.confirmationStatus==='pending-confirmation'},
          report:{source:'repairs-1405-source-file',sourceType:w.sourceType,confirmationStatus:w.confirmationStatus,provisionalFields:w.provisionalFields||[],assigneeProposed:!!w.assigneeProposed,notes:w.notes||'',relatedAssetIds:(w.relatedAssetIds||[]).map(id=>assetIdMap[id]||id),candidateAssetIds:(w.candidateAssetIds||[]).map(id=>assetIdMap[id]||id),additionalAssigneeIds:(w.additionalAssigneeIds||[]).map(id=>techByCanonical[id]||id),dataQualityLabel:w.confirmationStatus==='pending-confirmation'?'نیاز به تأیید نهایی':'تأییدشده'}};
        upsertBy(DB.wos,'no',w.no,rec);
      });

      // Put registered Bespar 1 equipment on the floor-plan demo with normalized coordinates.
      if(DB.floorPlan&&DB.floorPlan.positions){
        const list=DB.floorPlan.positions['map-b1-foam']||(DB.floorPlan.positions['map-b1-foam']=[]);
        const codes=['B1P01','B1P02','B1P06','B1P07','B1P08','B1PF09','B1PF10','B1PF11','B1AF1','B1AD6'];
        const coords=[[.22,.28],[.36,.28],[.50,.28],[.64,.28],[.42,.48],[.75,.64],[.84,.64],[.66,.64],[.93,.64],[.93,.42]];
        codes.forEach((code,i)=>{const a=DB.assets.find(x=>x.code===code);if(a&&!list.some(p=>p.assetId===a.id))list.push({id:'pos-'+a.id,assetId:a.id,x:coords[i][0],y:coords[i][1],rotation:0,scale:1,layer:code==='B1AF1'?'electrical':code==='B1AD6'?'building':'production',symbol:code.includes('PF09')?'compressor':code.includes('PF11')?'chiller':code.includes('AF')?'generator':code.includes('AD')?'industrial-door':code.includes('P06')||code.includes('P07')?'turntable':code==='B1P08'?'conveyor':'injection'});});
      }

      DB.seq=DB.seq||{};DB.seq.wo=Math.max(Number(DB.seq.wo)||0,49);
      DB.bespar1Data={version:data.version,importedAt:new Date().toISOString(),equipmentCount:data.equipment.length,historyCount:data.equipment.reduce((n,e)=>n+(e.history||[]).length,0),provisionalWoCount:data.provisionalWorkOrders1405.filter(w=>w.confirmationStatus==='pending-confirmation').length,qualityNotes:data.dataQualityNotes};
      if(!DB.audit.some(a=>a.x&&a.x.includes('داده‌های کارخانه بسپار ۱ نسخه '+data.version)))DB.audit.unshift({t:new Date().toISOString(),u:'سیستم',x:`ورود داده‌های کارخانه بسپار ۱ نسخه ${data.version}: ${data.equipment.length} تجهیز/زیرتجهیز، ${data.pmPlans.length} برنامه PM، ${data.provisionalWorkOrders1405.length} دستورکار ۱۴۰۵`});
      save();
      console.info('Bespar 1 dataset imported',DB.bespar1Data);
      if(typeof updateBadge==='function')updateBadge();
      return true;
    }catch(error){console.error('Bespar 1 dataset import failed:',error);if(typeof toast==='function')toast('ورود داده‌های بسپار ۱ ناموفق بود',1);return false;}
  }
  // UI adapters keep imported data quality and extended identity visible in the existing screens.
  if(typeof pgWOs==='function'){
    const baseWos=pgWOs;
    pgWOs=function(){
      const html=baseWos();
      const pending=DB.wos.filter(w=>w.report?.confirmationStatus==='pending-confirmation');
      if(!pending.length)return html;
      return html+`<div class="card" style="margin-top:14px;border-color:var(--orange)"><h3><span class="ic">⚠️</span>دستورکارهای ۱۴۰۵ نیازمند تأیید نهایی</h3><div class="muted" style="margin-bottom:8px">زمان شروع/پایان و تعمیرکار این رکوردها از فایل منبع استخراج نشده و مقادیر فعلی پیشنهادی هستند.</div><div style="display:flex;gap:6px;flex-wrap:wrap">${pending.map(w=>`<button class="btn btn-sm btn-ghost" onclick="openWO('${w.id}')"><span class="dot" style="color:var(--orange)"></span>${esc(w.no)} · ${esc(w.times?.periodLabel||'')}</button>`).join('')}</div></div>`;
    };
  }
  if(typeof openWO==='function'){
    const baseOpenWo=openWO;
    openWO=function(id){
      baseOpenWo(id);
      const w=DB.wos.find(x=>x.id===id);
      if(w?.report?.confirmationStatus==='pending-confirmation')setTimeout(()=>{
        const body=document.querySelector('.modal .m-body');if(!body||body.querySelector('[data-b1-quality]'))return;
        const warning=document.createElement('div');warning.dataset.b1Quality='1';warning.className='card';
        warning.style.cssText='background:var(--orange-bg);border-color:var(--orange);color:var(--orange);padding:10px 13px;margin-bottom:12px;font-size:12px';
        warning.innerHTML=`<b>⚠️ نیاز به تأیید نهایی مسئول نت</b><br><span style="color:var(--text-2)">دوره وقوع: ${esc(w.times?.periodLabel||'—')} · فیلدهای موقت: ${esc((w.report.provisionalFields||[]).join('، '))}<br>ساعت شروع و پایان واقعی ثبت نشده است؛ تعمیرکار فعلی پیشنهادی است.</span>`;
        body.prepend(warning);
      },80);
    };
  }
  if(typeof renderDossier==='function'){
    const baseDossier=renderDossier;
    renderDossier=function(){
      const html=baseDossier(),a=typeof selAsset!=='undefined'?asset(selAsset):null,e=a?.ext;
      if(!a||!e||e.factory!=='بسپار ۱'||(typeof dossierTab!=='undefined'&&dossierTab!=='base'))return html;
      const quality=e.requiresCoding?'<span class="badge b-orange">نیاز به کدگذاری رسمی</span>':'';
      const details=`<div class="card" style="margin-top:13px;box-shadow:none"><h3><span class="ic">🏭</span>شناسنامه تکمیلی کارخانه بسپار ۱ ${quality}</h3>
       <div class="spec"><div><b>محل دقیق استقرار</b>${esc(e.locationDescription||'—')}</div><div><b>ظرفیت</b>${esc(e.capacity||'—')}</div><div><b>کارکرد روزانه</b>${e.dailyOperatingHours==null?'—':fa(e.dailyOperatingHours)+' ساعت'}</div><div><b>امتیاز بحرانی</b>${e.criticalityScore==null?'—':fa(e.criticalityScore)+' از ۱۰۰'}</div></div>
       ${e.keyParts?.length?`<h3 style="font-size:12px;margin:12px 0 6px">قطعات و زیرسیستم‌های کلیدی</h3><div style="display:flex;gap:5px;flex-wrap:wrap">${e.keyParts.map(x=>`<span class="badge b-gray">${esc(x)}</span>`).join('')}</div>`:''}
       ${e.dailyInspection?.length?`<h3 style="font-size:12px;margin:12px 0 6px">چک‌لیست بازرسی روزانه</h3>${e.dailyInspection.map(x=>`<div class="list-row" style="padding:6px"><span style="color:var(--green)">✓</span><span>${esc(x)}</span></div>`).join('')}`:''}
       <div class="muted" style="margin-top:9px">نسخه داده: ${esc(e.datasetVersion||'—')} · وضعیت: ${e.dataStatus==='needs-coding'?'در انتظار کدگذاری':'ثبت‌شده'}</div></div>`;
      return html+details;
    };
  }

  // Deliberately manual: real master data must never be recreated automatically after a cleanup.
  window.importBespar1=importBespar1;
})();
