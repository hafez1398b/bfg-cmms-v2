/* One-time complete reset of the Asset/Equipment domain before real structure import. */
(function(){
  'use strict';
  if(typeof DB==='undefined'||!DB)return;

  // Prevent every legacy enhancement layer from recreating sample structures.
  DB.__mfSeed=1;
  DB.__demoSeed=1;
  DB.__fleetSeed=1;
  DB.__structSeed=1;

  async function loadCanonicalStructure(){
    if(typeof importBespar1!=='function')return;
    const ok=await importBespar1();
    if(!ok)return;
    DB.equipmentStructureReset.awaitingCanonicalStructure=false;
    DB.equipmentStructureReset.canonicalLoadedAt=new Date().toISOString();
    DB.canonicalAssetHierarchy={version:'1.0',root:'شرکت بسپار فوم غرب',loadedAt:DB.equipmentStructureReset.canonicalLoadedAt};
    save();
    if(typeof ME!=='undefined'&&ME&&typeof go==='function')go('tree');
    if(typeof toast==='function')toast('ساختار واقعی شرکت، کارخانجات و بسپار ۱ بارگذاری شد ✅');
  }

  // Never reset repeatedly: records entered after the canonical load must be preserved.
  if(DB.equipmentStructureReset?.version==='2.0'){
    if(DB.equipmentStructureReset.awaitingCanonicalStructure)setTimeout(loadCanonicalStructure,0);
    return;
  }

  const before={
    assets:(DB.assets||[]).length,
    workOrders:(DB.wos||[]).length,
    requests:(DB.requests||[]).length,
    pmPlans:(DB.pms||[]).length,
    items:(DB.items||[]).length,
    instruments:(DB.instruments||[]).length
  };
  const removedAssetIds=new Set((DB.assets||[]).map(a=>a.id));
  const removedWoIds=new Set((DB.wos||[]).map(w=>w.id));

  // Complete zero baseline: locations, categories, equipment and their operational history.
  DB.assets=[];
  DB.wos=[];
  DB.requests=[];
  DB.pms=[];
  DB.items=[];
  DB.stockDocs=[];
  DB.instruments=[];
  DB.permits=[];
  DB.docs=[];
  DB.costEntries=[];

  // Keep non-equipment modules, but remove dangling equipment relations.
  (DB.planEvents||[]).forEach(e=>{
    e.assetId='';e.subAssetId='';e.woId='';e.pmId='';e.reqId='';
  });
  (DB.projects||[]).forEach(p=>{p.assets=[];});
  (DB.tools||[]).forEach(t=>{if(removedAssetIds.has(t.assetId))t.assetId='';});
  (DB.toolLoans||[]).forEach(l=>{if(removedAssetIds.has(l.assetId))l.assetId='';if(removedWoIds.has(l.woId))l.woId='';});
  if(Array.isArray(DB.comments))DB.comments=DB.comments.filter(c=>!['assets','wos','requests','pms','items','instruments'].includes(c.ent));
  if(Array.isArray(DB.auditX))DB.auditX=DB.auditX.filter(a=>!['assets','wos','requests','pms','items','instruments'].includes(a.entity));

  if(DB.floorPlan?.positions)Object.keys(DB.floorPlan.positions).forEach(mapId=>DB.floorPlan.positions[mapId]=[]);
  if(typeof selAsset!=='undefined')selAsset=null;
  if(typeof treeOpen!=='undefined')Object.keys(treeOpen).forEach(k=>delete treeOpen[k]);

  DB.seq=DB.seq||{};
  DB.seq.wo=0;DB.seq.wr=0;DB.seq.ptw=0;
  DB.equipmentStructureReset={
    version:'2.0',at:new Date().toISOString(),scope:'complete-asset-domain-reset',before,
    after:{assets:0,workOrders:0,requests:0,pmPlans:0,items:0,instruments:0},
    canonicalImportMode:'one-time-after-reset',awaitingCanonicalStructure:true
  };
  DB.audit=DB.audit||[];
  DB.audit.unshift({t:DB.equipmentStructureReset.at,u:'سیستم',x:`ساختار دارایی و تجهیزات کاملاً صفر شد — ${before.assets} گره، ${before.workOrders} دستورکار و ${before.pmPlans} برنامه PM حذف شد؛ آماده ورود ساختار واقعی`});
  save();
  console.info('Asset/equipment structure reset completed',DB.equipmentStructureReset);
  if(typeof toast==='function')setTimeout(()=>toast('ساختار قبلی صفر شد؛ در حال چیدمان ساختار واقعی…'),200);
  setTimeout(loadCanonicalStructure,0);
})();
