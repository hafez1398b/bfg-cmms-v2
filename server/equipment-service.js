'use strict';

const EQUIPMENT_PERMISSIONS={
  admin:new Set(['view','create','edit','move','delete','export','print']),
  mgr:new Set(['view','create','edit','move','delete','export','print']),
  planner:new Set(['view','create','edit','move','export','print']),
  tech:new Set(['view','export','print']),
  op:new Set(['view','print']),
  store:new Set(['view','export','print']),
  hse:new Set(['view','print']),
  cal:new Set(['view','export','print'])
};
const SORT_COLUMNS={code:'a.code',name:'a.name',status:'a.status',criticality:'a.crit',updatedAt:'a.updated_at',sortOrder:'a.sort_order'};
const NODE_KINDS=new Set(['company','head-office','factories','factory','category','location','equipment','sub-equipment','subsystem','main-component','sub-component']);

function canEquipment(user,operation){return !!user&&(user.role==='admin'||EQUIPMENT_PERMISSIONS[user.role]?.has(operation));}
function requireEquipment(operation){return (req,res,next)=>canEquipment(req.user,operation)?next():res.status(403).json({error:'EQUIPMENT_PERMISSION_DENIED',permission:`Equipment.${operation}`});}
function listParams(query={}){
 const limit=Math.min(200,Math.max(1,Number.parseInt(query.limit,10)||25));
 const page=Math.max(1,Number.parseInt(query.page,10)||1);
 const sort=SORT_COLUMNS[query.sort]||SORT_COLUMNS.sortOrder;
 const direction=String(query.direction).toLowerCase()==='desc'?'DESC':'ASC';
 return {limit,page,offset:(page-1)*limit,sort,direction,q:String(query.q||'').trim().slice(0,120),factoryId:query.factoryId||null,categoryId:query.categoryId||null,status:query.status||null,criticality:query.criticality||null};
}
function cleanPatch(body={}){
 const allowed=['name','code','status','crit','maker','model','serial','year','install','power','hours','cls','categoryId','sortOrder','isActive'];
 return Object.fromEntries(Object.entries(body).filter(([key,value])=>allowed.includes(key)&&value!==undefined));
}
function cleanExt(ext){
 if(!ext||typeof ext!=='object'||Array.isArray(ext))return {};
 const textKeys=['locationDescription','description','technicalSpecification','capacity','panelCode','refrigerant'];
 const out={};
 for(const key of textKeys){
  if(ext[key]==null)continue;
  const text=String(ext[key]).replace(/[\u0000-\u001f]/g,' ').trim().slice(0,1000);
  if(text)out[key]=text;
 }
 const hours=Number(ext.dailyOperatingHours);
 if(Number.isFinite(hours)&&hours>=0&&hours<=24)out.dailyOperatingHours=hours;
 const score=Number(ext.criticalityScore);
 if(Number.isFinite(score)&&score>=0&&score<=100)out.criticalityScore=score;
 if(Array.isArray(ext.keyParts)){
  const parts=ext.keyParts.map(part=>String(part).trim()).filter(Boolean).slice(0,40);
  if(parts.length)out.keyParts=parts;
 }
 return out;
}
function validateCreate(body={}){
 const errors=[];
 if(!String(body.name||'').trim())errors.push('name');
 if(!String(body.code||'').trim())errors.push('code');
 if(!String(body.nodeKind||'').trim()||!NODE_KINDS.has(body.nodeKind))errors.push('nodeKind');
 return errors;
}
module.exports={EQUIPMENT_PERMISSIONS,SORT_COLUMNS,NODE_KINDS,canEquipment,requireEquipment,listParams,cleanPatch,cleanExt,validateCreate};
