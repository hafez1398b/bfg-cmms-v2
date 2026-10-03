'use strict';

function clamp(value,min=0,max=100){return Math.max(min,Math.min(max,value));}
function finite(values){return values.map(Number).filter(Number.isFinite);}

function calculateHealth(input,now=new Date()){
  const factors=[];
  const failures=(input.failures||[]).filter(x=>x.provenance_status==='verified'&&!['cancelled'].includes(x.status));
  const recent=failures.filter(x=>now-new Date(x.occurred_at)<=365*86400000);
  if(failures.length>=2){
    const frequencyPenalty=clamp(recent.length*8,0,35);
    factors.push({key:'failure_frequency',score:100-frequencyPenalty,weight:20,evidenceCount:failures.length,reason:`${recent.length} خرابی تأییدشده در ۳۶۵ روز`});
  }
  const severity=finite(failures.map(x=>x.severity));
  if(severity.length){const avg=severity.reduce((a,b)=>a+b,0)/severity.length;factors.push({key:'failure_severity',score:clamp(100-avg*8),weight:15,evidenceCount:severity.length,reason:`میانگین شدت ${avg.toFixed(2)} از ۱۰`});}
  const downtime=finite(failures.map(x=>x.downtime_minutes));
  if(downtime.length){const hours=downtime.reduce((a,b)=>a+b,0)/60;factors.push({key:'downtime',score:clamp(100-hours/2),weight:15,evidenceCount:downtime.length,reason:`${hours.toFixed(1)} ساعت توقف ثبت‌شده`});}
  const repairHours=finite((input.completedWorkOrders||[]).map(x=>x.duration_hours));
  if(repairHours.length>=2){const mttr=repairHours.reduce((a,b)=>a+b,0)/repairHours.length;factors.push({key:'mttr',score:clamp(100-mttr*5),weight:10,evidenceCount:repairHours.length,reason:`MTTR برابر ${mttr.toFixed(1)} ساعت`});}
  const pm=input.pm||{};
  if(Number.isFinite(Number(pm.total))&&Number(pm.total)>0){const compliance=100*Number(pm.compliant||0)/Number(pm.total);factors.push({key:'pm_compliance',score:clamp(compliance),weight:20,evidenceCount:Number(pm.total),reason:`انطباق PM برابر ${compliance.toFixed(1)}٪`});}
  const checks=input.checklists||{};
  if(Number(checks.total)>0){const pass=100*Number(checks.passed||0)/Number(checks.total);factors.push({key:'checklist_results',score:clamp(pass),weight:10,evidenceCount:Number(checks.total),reason:`نتیجه قابل قبول ${pass.toFixed(1)}٪`});}
  const spares=input.spares||[];
  if(spares.length){const shortages=spares.filter(x=>Number(x.stock)<Number(x.min_stock)).length;factors.push({key:'spare_availability',score:clamp(100-shortages/spares.length*100),weight:10,evidenceCount:spares.length,reason:`${shortages} کمبود از ${spares.length} قطعه کلیدی`});}
  if(factors.length<3)return {score:null,status:'insufficient_data',reason:'حداقل سه عامل معتبر برای Health Score لازم است.',factors};
  const totalWeight=factors.reduce((sum,x)=>sum+x.weight,0);
  const score=factors.reduce((sum,x)=>sum+x.score*x.weight,0)/totalWeight;
  return {score:Number(score.toFixed(2)),status:'calculated',reason:'محاسبه قطعی از داده‌های تأییدشده موجود',factors,modelVersion:'health-rule-1.0'};
}

async function equipmentHealth(pool,user,equipmentId,requireScope){
  const client=await pool.connect();
  try{
    const asset=await requireScope(client,user,equipmentId);
    const [failureResult,woResult,pmResult,checkResult,spareResult]=await Promise.all([
      client.query(`SELECT occurred_at,severity,downtime_minutes,status,provenance_status FROM failures WHERE equipment_id=$1 AND deleted_at IS NULL`,[asset.id]),
      client.query(`SELECT NULLIF(times->>'durationHours','')::numeric duration_hours FROM work_orders WHERE asset_id=$1 AND status IN ('closed','done','completed') AND deleted_at IS NULL AND confirmation_status='confirmed'`,[asset.id]),
      client.query(`SELECT count(*)::int total,count(*) FILTER(WHERE last_run IS NOT NULL AND last_run+(interval_days||' days')::interval>=now())::int compliant FROM pm_plans WHERE asset_id=$1 AND status='active' AND deleted_at IS NULL`,[asset.id]),
      client.query(`SELECT count(*)::int total,count(*) FILTER(WHERE overall_status IN ('passed','acceptable'))::int passed FROM checklist_executions WHERE equipment_id=$1 AND status='completed'`,[asset.id]).catch(error=>error.code==='42P01'?{rows:[{total:0,passed:0}]}:Promise.reject(error)),
      client.query(`SELECT i.stock,i.min_stock FROM asset_spare_parts r JOIN items i ON i.id=r.item_id WHERE r.asset_id=$1 AND i.deleted_at IS NULL`,[asset.id])
    ]);
    return {equipmentId:asset.id,...calculateHealth({failures:failureResult.rows,completedWorkOrders:woResult.rows,pm:pmResult.rows[0],checklists:checkResult.rows[0],spares:spareResult.rows})};
  }finally{client.release();}
}

module.exports={calculateHealth,equipmentHealth};
