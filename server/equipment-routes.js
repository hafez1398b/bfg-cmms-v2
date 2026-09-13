'use strict';

const express=require('express');
const {v4:uuid}=require('uuid');
const {requireEquipment,listParams,cleanPatch,validateCreate}=require('./equipment-service');

function createEquipmentRouter({pool,io,authenticateToken}){
 const router=express.Router();router.use(authenticateToken);
 const emit=(payload)=>io.emit('equipment-changed',payload);
 async function audit(c,req,action,id,before,after,note=''){
  await c.query(`INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after) VALUES($1,now(),$2,$3,$4,$5,'equipment-v2',$6,$7,$8,$9)`,
   [uuid(),req.user.name||req.user.username,req.user.id,req.user.role,action,id,note,before?JSON.stringify(before):null,after?JSON.stringify(after):null]);
 }

 router.get('/feature',requireEquipment('view'),async(req,res,next)=>{try{
  const {rows}=await pool.query(`SELECT key,enabled,rollout_percent,allowed_roles,metadata FROM feature_flags WHERE key='equipment_v2'`);
  res.json(rows[0]||{key:'equipment_v2',enabled:false,rollout_percent:0,allowed_roles:[]});
 }catch(e){next(e);}});

 router.get('/filters',requireEquipment('view'),async(req,res,next)=>{try{
  const [factories,categories]=await Promise.all([
   pool.query(`SELECT id,code,name FROM assets WHERE deleted_at IS NULL AND (ext->>'nodeKind'='factory' OR cls='کارخانه') ORDER BY sort_order,name`),
   pool.query(`SELECT c.id,c.code,c.name,c.factory_asset_id FROM asset_categories c ORDER BY c.sort_order,c.name`)
  ]);
  res.json({factories:factories.rows,categories:categories.rows.map(x=>({...x,factory_id:x.factory_asset_id}))});
 }catch(e){next(e);}});

 router.get('/',requireEquipment('view'),async(req,res,next)=>{try{
  const p=listParams(req.query),where=[`a.type='eq'`,`a.deleted_at IS NULL`],v=[];
  const add=(sql,val)=>{v.push(val);where.push(sql.replace('?',`$${v.length}`));};
  if(p.q)add(`(a.code ILIKE '%'||?||'%' OR a.name ILIKE '%'||?||'%' OR a.serial ILIKE '%'||?||'%' OR a.model ILIKE '%'||?||'%' OR a.maker ILIKE '%'||?||'%')`,p.q);
  // Expand the repeated placeholder generated above safely.
  if(p.q){where.pop();const base=v.length;where.push(`(a.code ILIKE '%'||$${base}||'%' OR a.name ILIKE '%'||$${base}||'%' OR COALESCE(a.serial,'') ILIKE '%'||$${base}||'%' OR COALESCE(a.model,'') ILIKE '%'||$${base}||'%' OR COALESCE(a.maker,'') ILIKE '%'||$${base}||'%')`);}
  if(p.factoryId)add(`c.factory_asset_id=?`,p.factoryId);if(p.categoryId)add(`a.category_id=?`,p.categoryId);if(p.status)add(`a.status=?`,p.status);if(p.criticality)add(`a.crit=?`,p.criticality);
  const from=`FROM assets a LEFT JOIN asset_categories c ON c.id=a.category_id LEFT JOIN assets f ON f.id=c.factory_asset_id LEFT JOIN assets loc ON loc.id=a.parent`;
  const count=await pool.query(`SELECT count(*)::int total ${from} WHERE ${where.join(' AND ')}`,v);
  v.push(p.limit,p.offset);
  const {rows}=await pool.query(`SELECT a.id,a.code,a.name,a.parent,a.cls,a.status,a.crit,a.maker,a.model,a.serial,a.hours,a.health_score,a.is_active,a.sort_order,a.row_version,a.updated_at,
    c.id category_id,c.name category_name,f.id factory_id,f.name factory_name,loc.name location_name,
    lp.last_run,CASE WHEN lp.last_run IS NOT NULL AND lp.interval_days IS NOT NULL THEN lp.last_run+(lp.interval_days||' days')::interval END next_pm,
    (SELECT count(*)::int FROM work_orders w WHERE w.asset_id=a.id AND w.status NOT IN ('closed','cancel')) open_wo,
    NULL::numeric maintenance_cost
    ${from} LEFT JOIN LATERAL(SELECT p.last_run,p.interval_days FROM pm_plans p WHERE p.asset_id=a.id AND p.status='active' ORDER BY p.last_run DESC NULLS LAST LIMIT 1)lp ON true
    WHERE ${where.join(' AND ')} ORDER BY ${p.sort} ${p.direction},a.id LIMIT $${v.length-1} OFFSET $${v.length}`,v);
  res.json({data:rows,pagination:{page:p.page,limit:p.limit,total:count.rows[0].total,pages:Math.ceil(count.rows[0].total/p.limit)},source:'postgresql'});
 }catch(e){next(e);}});

 router.get('/tree',requireEquipment('view'),async(req,res,next)=>{try{
  const parent=req.query.parentId||null,q=String(req.query.q||'').trim().slice(0,120),vals=[parent];
  const where=[`a.deleted_at IS NULL`];
  if(q){vals.push(q);where.push(`(a.code ILIKE '%'||$${vals.length}||'%' OR a.name ILIKE '%'||$${vals.length}||'%')`);}
  else where.push(`(($1::text IS NULL AND a.parent IS NULL) OR a.parent=$1)`);
  const filters=[];
  for(const [column,value] of [['dc.factory_asset_id',req.query.factoryId],['d.category_id',req.query.categoryId],['d.status',req.query.status],['d.crit',req.query.criticality]]){
   if(value){vals.push(value);filters.push(`${column}=$${vals.length}`);}
  }
  if(filters.length)where.push(`EXISTS(WITH RECURSIVE descendants AS (
    SELECT x.id,x.parent,x.type,x.category_id,x.status,x.crit FROM assets x WHERE x.id=a.id AND x.deleted_at IS NULL
    UNION ALL SELECT ch.id,ch.parent,ch.type,ch.category_id,ch.status,ch.crit FROM assets ch JOIN descendants d0 ON ch.parent=d0.id WHERE ch.deleted_at IS NULL
   ) SELECT 1 FROM descendants d LEFT JOIN asset_categories dc ON dc.id=d.category_id WHERE d.type='eq' AND ${filters.join(' AND ')} LIMIT 1)`);
  const {rows}=await pool.query(`SELECT a.id,a.parent,a.code,a.name,a.type,a.cls,a.status,a.crit,a.is_active,a.sort_order,a.row_version,a.ext,
    (SELECT count(*)::int FROM assets ch WHERE ch.parent=a.id AND ch.deleted_at IS NULL) child_count
    FROM assets a WHERE ${where.join(' AND ')} ORDER BY a.sort_order,a.name`,vals);
  res.json({data:rows,parentId:parent,source:'postgresql'});
 }catch(e){next(e);}});

 router.get('/:id',requireEquipment('view'),async(req,res,next)=>{try{
  const {rows}=await pool.query(`SELECT a.*,c.name category_name,f.name factory_name,p.name parent_name,
   (SELECT count(*)::int FROM work_orders w WHERE w.asset_id=a.id) wo_count,
   (SELECT count(*)::int FROM work_orders w WHERE w.asset_id=a.id AND w.status NOT IN('closed','cancel','done','completed')) open_wo,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('id',pm.id,'title',pm.title,'interval_days',pm.interval_days,'last_run',pm.last_run,'status',pm.status,'checklist',pm.checklist) ORDER BY pm.title) FROM pm_plans pm WHERE pm.asset_id=a.id),'[]'::jsonb) pm_plans,
   COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.created_at DESC) FROM work_orders w WHERE w.asset_id=a.id),'[]'::jsonb) work_orders,
   COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.created_at DESC) FROM work_orders w WHERE w.asset_id=a.id AND w.status IN('closed','done','completed')),'[]'::jsonb) maintenance_history,
   COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC) FROM requests r WHERE r.asset_id=a.id),'[]'::jsonb) requests,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'code',i.code,'name',i.name,'unit',i.unit,'stock',i.stock,'minimum',i.min_stock,'price',i.price) ORDER BY i.name) FROM asset_spare_parts rel JOIN items i ON i.id=rel.item_id WHERE rel.asset_id=a.id),'[]'::jsonb) spare_parts,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ch.id,'parent',ch.parent,'code',ch.code,'name',ch.name,'type',ch.type,'status',ch.status,'crit',ch.crit,'nodeKind',ch.ext->>'nodeKind','child_count',(SELECT count(*)::int FROM assets g WHERE g.parent=ch.id AND g.deleted_at IS NULL)) ORDER BY ch.sort_order,ch.name) FROM assets ch WHERE ch.parent=a.id AND ch.deleted_at IS NULL),'[]'::jsonb) children,
   '[]'::jsonb documents,a.history movements
   FROM assets a LEFT JOIN asset_categories c ON c.id=a.category_id LEFT JOIN assets f ON f.id=c.factory_asset_id LEFT JOIN assets p ON p.id=a.parent
   WHERE (a.id=$1 OR lower(a.code)=lower($1)) AND a.deleted_at IS NULL`,[req.params.id]);
  if(!rows[0])return res.sendStatus(404);
  const data=rows[0];
  const pathResult=await pool.query(`WITH RECURSIVE ancestry AS (
    SELECT id,parent,code,name,type,ext,0 depth FROM assets WHERE id=$1
    UNION ALL SELECT p.id,p.parent,p.code,p.name,p.type,p.ext,a.depth+1 FROM assets p JOIN ancestry a ON a.parent=p.id
   ) SELECT id,parent,code,name,type,ext->>'nodeKind' "nodeKind",depth FROM ancestry ORDER BY depth DESC`,[data.id]);
  data.path=pathResult.rows;
  data.risks=data.ext?.risks||[];data.consumed_parts=[];data.cost_entries=[];data.downtimes=[];
  for(const w of data.work_orders||[]){
   const at=w.times?.end||w.created_at||null;
   for(const part of w.parts||[]){const item=(data.spare_parts||[]).find(x=>x.id===(part.itemId||part.item_id));data.consumed_parts.push({wo_id:w.id,wo_no:w.no,item_id:item?.id||part.itemId,item_code:item?.code||'',item_name:item?.name||'قطعه ثبت‌شده',qty:Number(part.qty)||0,unit:item?.unit||'',unit_price:item?.price??null,at});}
   const values=Object.values(w.costs||{}).map(Number).filter(Number.isFinite);let amount=values.length?values.reduce((x,y)=>x+y,0):null;
   for(const part of w.parts||[]){const item=(data.spare_parts||[]).find(x=>x.id===(part.itemId||part.item_id));if(item&&Number.isFinite(Number(item.price))){amount=(amount||0)+(Number(part.qty)||0)*Number(item.price);}}
   if(amount!==null)data.cost_entries.push({wo_id:w.id,wo_no:w.no,at,amount});
   const duration=Number(w.times?.durationHours);if(Number.isFinite(duration))data.downtimes.push({wo_id:w.id,wo_no:w.no,start:w.times?.start||null,end:w.times?.end||null,hours:duration,reason:w.descr||''});
  }
  data.maintenance_cost=data.cost_entries.length?data.cost_entries.reduce((sum,x)=>sum+x.amount,0):null;
  data.rca=(data.maintenance_history||[]).map(w=>({wo_id:w.id,wo_no:w.no,at:w.times?.end||w.created_at||null,root_cause:w.report?.rootCause||w.report?.rca||null,action:w.report?.correctiveAction||null})).filter(x=>x.root_cause);
  res.json({data,source:'postgresql'});
 }catch(e){next(e);}});

 router.post('/',requireEquipment('create'),async(req,res,next)=>{const errors=validateCreate(req.body);if(errors.length)return res.status(422).json({error:'VALIDATION_ERROR',fields:errors});const c=await pool.connect();try{
  await c.query('BEGIN');const id=req.body.id||uuid(),kind=req.body.nodeKind,type=['equipment','sub-equipment','subsystem','main-component','sub-component'].includes(kind)?'eq':kind==='factory'||kind==='company'?'site':'unit';
  if(req.body.parentId){const parent=await c.query('SELECT id FROM assets WHERE id=$1 AND deleted_at IS NULL',[req.body.parentId]);if(!parent.rows[0]){await c.query('ROLLBACK');return res.status(422).json({error:'PARENT_NOT_FOUND'});}}
  const ext={...(req.body.ext||{}),nodeKind:kind};
  const {rows}=await c.query(`INSERT INTO assets(id,parent,code,name,type,cls,status,crit,maker,model,serial,hours,ext,category_id,sort_order,is_active,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,now()) RETURNING *`,
    [id,req.body.parentId||null,String(req.body.code).trim(),String(req.body.name).trim(),type,req.body.cls||null,req.body.status||'active',req.body.crit||'C',req.body.maker||null,req.body.model||null,req.body.serial||null,Number(req.body.hours)||0,JSON.stringify(ext),req.body.categoryId||null,Number(req.body.sortOrder)||0]);
  await audit(c,req,'create',id,null,rows[0]);await c.query('COMMIT');emit({action:'create',id});res.status(201).json({data:rows[0]});
 }catch(e){await c.query('ROLLBACK');next(e);}finally{c.release();}});

 router.patch('/:id',requireEquipment('edit'),async(req,res,next)=>{const patch=cleanPatch(req.body);if(!Object.keys(patch).length)return res.status(422).json({error:'NO_EDITABLE_FIELDS'});const map={name:'name',code:'code',status:'status',crit:'crit',maker:'maker',model:'model',serial:'serial',year:'year',install:'install',power:'power',hours:'hours',categoryId:'category_id',sortOrder:'sort_order',isActive:'is_active'};const c=await pool.connect();try{
  await c.query('BEGIN');const old=await c.query('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[req.params.id]);if(!old.rows[0]){await c.query('ROLLBACK');return res.sendStatus(404);}if(req.body.rowVersion!==undefined&&Number(req.body.rowVersion)!==Number(old.rows[0].row_version)){await c.query('ROLLBACK');return res.status(409).json({error:'VERSION_CONFLICT',current:old.rows[0].row_version});}
  const entries=Object.entries(patch),vals=[req.params.id,...entries.map(([,x])=>x)];const set=entries.map(([k],i)=>`${map[k]}=$${i+2}`).join(',');
  const {rows}=await c.query(`UPDATE assets SET ${set},row_version=row_version+1,updated_at=now() WHERE id=$1 RETURNING *`,vals);await audit(c,req,'edit',req.params.id,old.rows[0],rows[0]);await c.query('COMMIT');emit({action:'edit',id:req.params.id});res.json({data:rows[0]});
 }catch(e){await c.query('ROLLBACK');next(e);}finally{c.release();}});

 router.post('/:id/move',requireEquipment('move'),async(req,res,next)=>{const {parentId=null,sortOrder=0,rowVersion}=req.body,c=await pool.connect();try{
  await c.query('BEGIN');const old=await c.query('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[req.params.id]);if(!old.rows[0]){await c.query('ROLLBACK');return res.sendStatus(404);}if(rowVersion!==undefined&&Number(rowVersion)!==Number(old.rows[0].row_version)){await c.query('ROLLBACK');return res.status(409).json({error:'VERSION_CONFLICT'});}if(parentId===req.params.id){await c.query('ROLLBACK');return res.status(422).json({error:'TREE_CYCLE'});}
  if(parentId){const parent=await c.query('SELECT id FROM assets WHERE id=$1 AND deleted_at IS NULL',[parentId]);if(!parent.rows[0]){await c.query('ROLLBACK');return res.status(422).json({error:'PARENT_NOT_FOUND'});}const cycle=await c.query(`WITH RECURSIVE d(id)AS(SELECT id FROM assets WHERE parent=$1 AND deleted_at IS NULL UNION ALL SELECT a.id FROM assets a JOIN d ON a.parent=d.id WHERE a.deleted_at IS NULL)SELECT 1 FROM d WHERE id=$2 LIMIT 1`,[req.params.id,parentId]);if(cycle.rows[0]){await c.query('ROLLBACK');return res.status(422).json({error:'TREE_CYCLE'});}}
  const {rows}=await c.query('UPDATE assets SET parent=$2,sort_order=$3,row_version=row_version+1,updated_at=now() WHERE id=$1 RETURNING *',[req.params.id,parentId,Number(sortOrder)||0]);await audit(c,req,'move',req.params.id,old.rows[0],rows[0],req.body.reason||'');await c.query('COMMIT');emit({action:'move',id:req.params.id});res.json({data:rows[0]});
 }catch(e){await c.query('ROLLBACK');next(e);}finally{c.release();}});

 router.delete('/:id',requireEquipment('delete'),async(req,res,next)=>{const c=await pool.connect();try{
  await c.query('BEGIN');const old=await c.query('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[req.params.id]);if(!old.rows[0]){await c.query('ROLLBACK');return res.sendStatus(404);}const kids=await c.query('SELECT count(*)::int n FROM assets WHERE parent=$1 AND deleted_at IS NULL',[req.params.id]);if(kids.rows[0].n){await c.query('ROLLBACK');return res.status(409).json({error:'HAS_ACTIVE_CHILDREN',count:kids.rows[0].n});}
  const {rows}=await c.query(`UPDATE assets SET is_active=false,status='stopped',deleted_at=now(),deleted_by=$2,delete_reason=$3,row_version=row_version+1,updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,req.user.id,req.body?.reason||'']);await audit(c,req,'soft-delete',req.params.id,old.rows[0],rows[0]);await c.query('COMMIT');emit({action:'soft-delete',id:req.params.id});res.json({data:rows[0],historyPreserved:true});
 }catch(e){await c.query('ROLLBACK');next(e);}finally{c.release();}});

 router.use((e,_req,res,_next)=>{console.error('Equipment V2 API:',e);if(e.code==='23505')return res.status(409).json({error:'DUPLICATE_CODE'});res.status(500).json({error:'EQUIPMENT_API_ERROR',message:e.message});});
 return router;
}
module.exports={createEquipmentRouter};
