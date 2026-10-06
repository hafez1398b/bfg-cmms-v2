'use strict';
const express=require('express');
const {v4:uuid}=require('uuid');
const {analyze,requireEquipmentScope}=require('./ai-service');
const {equipmentHealth}=require('./equipment-health-service');

function createAIRouter({pool,authenticateToken,authorize,registry}){
  const router=express.Router();router.use(authenticateToken);
  router.get('/status',authorize('ai.use'),async(_req,res,next)=>{try{const policies=await pool.query('SELECT provider,enabled,allowed_purposes,allow_sensitive_context,allow_search,data_region_note,row_version,updated_at FROM ai_provider_policies ORDER BY provider');res.json({backend:true,providers:registry.status(),policies:policies.rows,policy:{humanApprovalRequired:true,keysExposedToClient:false,kpiEngine:'deterministic'}});}catch(error){next(error);}});
  router.patch('/providers/:provider',authorize('ai.configure'),async(req,res,next)=>{
    if(!['local','deepseek','gemini'].includes(req.params.provider))return res.status(404).json({error:'UNKNOWN_PROVIDER'});
    const version=Number(req.body.rowVersion);if(!Number.isFinite(version))return res.status(422).json({error:'ROW_VERSION_REQUIRED'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const current=await client.query('SELECT * FROM ai_provider_policies WHERE provider=$1 FOR UPDATE',[req.params.provider]);
      if(!current.rows[0]){await client.query('ROLLBACK');return res.sendStatus(404);}
      if(Number(current.rows[0].row_version)!==version){await client.query('ROLLBACK');return res.status(409).json({error:'VERSION_CONFLICT',current:current.rows[0]});}
      const updated=await client.query(`UPDATE ai_provider_policies SET enabled=$2,allow_sensitive_context=$3,allow_search=$4,updated_by=$5,updated_at=now(),row_version=row_version+1 WHERE provider=$1 AND row_version=$6 RETURNING provider,enabled,allowed_purposes,allow_sensitive_context,allow_search,data_region_note,row_version,updated_at`,[req.params.provider,!!req.body.enabled,!!req.body.allowSensitiveContext,!!req.body.allowSearch,req.user.id,version]);
      if(!updated.rows[0]){await client.query('ROLLBACK');return res.status(409).json({error:'VERSION_CONFLICT'});}
      await client.query(`INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after) VALUES($1,now(),$2,$3,$4,'ai-provider-policy','ai',$5,$6,$7,$8)`,[uuid(),req.user.name,req.user.id,req.user.role,req.params.provider,'AI provider policy changed',JSON.stringify(current.rows[0]),JSON.stringify(updated.rows[0])]);
      await client.query('COMMIT');res.json({data:updated.rows[0]});
    }catch(error){await client.query('ROLLBACK').catch(()=>{});next(error);}finally{client.release();}
  });
  router.post('/analyze',authorize('equipment.view'),authorize('ai.use'),async(req,res,next)=>{try{res.status(201).json({data:await analyze({pool,registry,user:req.user,input:req.body})});}catch(error){next(error);}});
  router.get('/equipment/:id/health',authorize('equipment.view'),async(req,res,next)=>{try{res.json({data:await equipmentHealth(pool,req.user,req.params.id,requireEquipmentScope)});}catch(error){next(error);}});
  router.patch('/recommendations/:id/review',authorize('ai.review'),async(req,res,next)=>{
    const action=req.body.action,note=String(req.body.note||'').slice(0,2000),version=Number(req.body.rowVersion);
    if(!['approved','rejected'].includes(action)||!Number.isFinite(version))return res.status(422).json({error:'REVIEW_VALIDATION_ERROR'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const current=await client.query(`SELECT r.*,run.equipment_id FROM ai_recommendations r JOIN ai_runs run ON run.id=r.ai_run_id WHERE r.id=$1 FOR UPDATE`,[req.params.id]);
      if(!current.rows[0]){await client.query('ROLLBACK');return res.sendStatus(404);}
      if(Number(current.rows[0].row_version)!==version){await client.query('ROLLBACK');return res.status(409).json({error:'VERSION_CONFLICT',current:current.rows[0]});}
      if(!['pending_approval','ai_suggested'].includes(current.rows[0].status)){await client.query('ROLLBACK');return res.status(409).json({error:'ALREADY_REVIEWED',current:current.rows[0]});}
      const updated=await client.query(`UPDATE ai_recommendations SET status=$2,reviewed_by=$3,reviewed_at=now(),review_note=$4,row_version=row_version+1 WHERE id=$1 RETURNING *`,[req.params.id,action,req.user.id,note]);
      await client.query(`INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after) VALUES($1,now(),$2,$3,$4,'ai-review','ai',$5,$6,$7,$8)`,[uuid(),req.user.name,req.user.id,req.user.role,req.params.id,note,JSON.stringify(current.rows[0]),JSON.stringify(updated.rows[0])]);
      await client.query('COMMIT');res.json({data:updated.rows[0]});
    }catch(error){await client.query('ROLLBACK').catch(()=>{});next(error);}finally{client.release();}
  });
  router.use((error,_req,res,_next)=>{
    const status=Number(error.status)||500;
    console.error('AI API:', error.code || 'request_failed');
    if(status>=500) return res.status(500).json({error:error.code||'AI_API_ERROR'});
    res.status(status).json({error:error.code||error.message||'AI_API_ERROR',fields:error.fields});
  });
  return router;
}
module.exports={createAIRouter};
