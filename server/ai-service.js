'use strict';
const crypto=require('node:crypto');
const {v4:uuid}=require('uuid');
const {AIProviderError}=require('./ai-providers');

const PURPOSES=new Set(['failure_diagnosis','rca','repair_recommendation','wizard_suggestion','pm_review','checklist_review','trend_analysis']);
const RECOMMENDATION_TYPES=new Set(['diagnosis','investigation','immediate_action','corrective_maintenance','preventive_action','inspection','spare_part','technician_skill','pm_change','checklist_change']);

function mediaSize(item){try{return Buffer.from(item.data||'','base64').length;}catch(_){return Infinity;}}
function validateRequest(input={}){
  const fields=[];
  if(!PURPOSES.has(input.purpose))fields.push('purpose');
  if(!String(input.equipmentId||'').trim())fields.push('equipmentId');
  if(!String(input.question||'').trim())fields.push('question');
  if(String(input.question||'').length>4000)fields.push('question:maxLength');
  const media=input.media||[];
  if(!Array.isArray(media)||media.length>5)fields.push('media');
  else for(const item of media){if(!['image','audio'].includes(item.kind)||!String(item.mimeType||'').match(/^(image|audio)\//)||mediaSize(item)>(item.kind==='image'?8:20)*1024*1024)fields.push('media:item');}
  return [...new Set(fields)];
}

async function requireEquipmentScope(client,user,equipmentId){
  const {rows}=await client.query(`SELECT a.id,a.code,a.name,a.parent,a.status,a.crit,a.hours,a.ext,a.health_score,a.category_id,c.factory_asset_id factory_id
    FROM assets a LEFT JOIN asset_categories c ON c.id=a.category_id
    WHERE (a.id=$1 OR lower(a.code)=lower($1)) AND a.deleted_at IS NULL`,[equipmentId]);
  const asset=rows[0];if(!asset)throw Object.assign(new Error('EQUIPMENT_NOT_FOUND'),{status:404});
  if(user.role==='admin')return asset;
  const access=await client.query(`SELECT 1 FROM user_scopes WHERE user_id=$1 AND (
    (scope_type='equipment' AND scope_id=$2) OR (scope_type='factory' AND scope_id=$3) OR scope_type='company') LIMIT 1`,[user.id,asset.id,asset.factory_id]);
  if(!access.rows[0])throw Object.assign(new Error('EQUIPMENT_SCOPE_DENIED'),{status:403});
  return asset;
}

async function buildContext(client,user,equipmentId){
  const asset=await requireEquipmentScope(client,user,equipmentId);
  const [workOrders,failures,pms,requests,spares]=await Promise.all([
    client.query(`SELECT id,no,type,status,descr,priority,times,report,costs,created_at FROM work_orders WHERE asset_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50`,[asset.id]),
    client.query(`SELECT id,failure_no,occurred_at,condition,symptoms,description,failure_type,failure_mode,cause,effect,severity,frequency,detectability,risk_score,downtime_minutes,status,provenance_status FROM failures WHERE equipment_id=$1 AND deleted_at IS NULL ORDER BY occurred_at DESC LIMIT 50`,[asset.id]),
    client.query(`SELECT id,title,interval_days,last_run,spec,kind,status,checklist,ext FROM pm_plans WHERE asset_id=$1 AND deleted_at IS NULL ORDER BY title LIMIT 100`,[asset.id]),
    client.query(`SELECT id,no,type,descr,urgency,impact,status,form,created_at FROM requests WHERE asset_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 30`,[asset.id]),
    client.query(`SELECT i.id,i.code,i.name,i.unit,i.stock,i.min_stock,i.price,rel.relation_type FROM asset_spare_parts rel JOIN items i ON i.id=rel.item_id WHERE rel.asset_id=$1 AND i.deleted_at IS NULL ORDER BY i.name LIMIT 100`,[asset.id])
  ]);
  const context={asset,workOrders:workOrders.rows,failures:failures.rows,pmPlans:pms.rows,requests:requests.rows,spareParts:spares.rows};
  const sourceIds={asset:[asset.id],work_order:workOrders.rows.map(x=>x.id),failure:failures.rows.map(x=>String(x.id)),pm:pms.rows.map(x=>x.id),request:requests.rows.map(x=>x.id),spare_part:spares.rows.map(x=>x.id)};
  return {context,sourceIds,manifest:{equipmentId:asset.id,factoryId:asset.factory_id,counts:Object.fromEntries(Object.entries(sourceIds).map(([k,v])=>[k,v.length])),sourceIds}};
}

function parseStructured(text){
  const clean=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let value;try{value=JSON.parse(clean);}catch(_){throw new AIProviderError('INVALID_STRUCTURED_OUTPUT','AI response was not valid JSON');}
  if(!Array.isArray(value.recommendations))throw new AIProviderError('INVALID_STRUCTURED_OUTPUT','AI response has no recommendations array');
  return value;
}

function normalizeRecommendations(value,sourceIds,{allowWebUrls=[]}={}){
  const allowed=new Map(Object.entries(sourceIds).map(([type,ids])=>[type,new Set(ids.map(String))])),webAllowed=new Set(allowWebUrls);
  return value.recommendations.slice(0,12).map((item,index)=>{
    if(!RECOMMENDATION_TYPES.has(item.type))throw new AIProviderError('INVALID_RECOMMENDATION_TYPE',`Invalid recommendation type at ${index}`);
    if(!item.recommendation||!item.reason)throw new AIProviderError('INCOMPLETE_RECOMMENDATION',`Recommendation ${index} lacks recommendation or reason`);
    const evidence=Array.isArray(item.evidence)?item.evidence:[];
    for(const ev of evidence){
      if(ev.sourceType==='web'){if(!webAllowed.has(ev.sourceId))throw new AIProviderError('UNVERIFIED_EVIDENCE','Web evidence was not returned by provider grounding');continue;}
      if(!allowed.get(ev.sourceType)?.has(String(ev.sourceId)))throw new AIProviderError('UNVERIFIED_EVIDENCE',`Evidence is outside authorized context: ${ev.sourceType}/${ev.sourceId}`);
    }
    return {type:item.type,recommendation:String(item.recommendation).slice(0,4000),reason:String(item.reason).slice(0,4000),evidence,confidence:Number.isFinite(Number(item.confidence))?Math.max(0,Math.min(1,Number(item.confidence))):null,sourceContext:item.sourceContext||{}};
  });
}

const SYSTEM_PROMPT=`You are the controlled maintenance analysis engine of an industrial CMMS/EAM. Return JSON only with a recommendations array. Each item must contain: type, recommendation, reason, evidence, confidence, sourceContext. Evidence entries must contain sourceType, sourceId and excerpt. Use only facts in AUTHORIZED_CONTEXT or cited web grounding. Never invent history, measurements, costs, completion, parts, causes or KPI values. If evidence is insufficient, return an empty recommendations array and explain it in summary. AI output is a suggestion pending human approval, never a confirmed diagnosis or executable action.`;

const FALLBACK_PROVIDER_CODES=new Set(['PROVIDER_TIMEOUT','PROVIDER_UNREACHABLE','PROVIDER_HTTP_ERROR','INVALID_PROVIDER_JSON','INVALID_PROVIDER_RESPONSE','INVALID_STRUCTURED_OUTPUT','INVALID_RECOMMENDATION_TYPE','INCOMPLETE_RECOMMENDATION','UNVERIFIED_EVIDENCE']);
function policyError(code,status=403){return Object.assign(new Error(code),{status,code});}
function isFallbackFailure(error){return error instanceof AIProviderError&&FALLBACK_PROVIDER_CODES.has(error.code);}

async function analyze({pool,registry,user,input}){
  const invalid=validateRequest(input);if(invalid.length)throw Object.assign(new Error('AI_REQUEST_VALIDATION_ERROR'),{status:422,fields:invalid});
  const client=await pool.connect();let activeRunId=null,start=Date.now(),transaction=false;
  try{
    const built=await buildContext(client,user,input.equipmentId);
    const routing={media:input.media||[],useSearch:!!input.useSearch,purpose:input.purpose,preferred:input.preferredProvider};
    const candidates=registry.candidates(routing);
    if(!candidates.length)throw new AIProviderError('NO_CAPABLE_PROVIDER','No configured provider supports this request',503);
    const prompt=`PURPOSE: ${input.purpose}\nUSER_QUESTION: ${input.question}\nAUTHORIZED_CONTEXT:\n${JSON.stringify(built.context)}`;
    const promptHash=crypto.createHash('sha256').update(prompt).digest('hex');
    const fallbackChain=[];let lastPolicyFailure=null,lastProviderFailure=null;

    for(let index=0;index<candidates.length;index++){
      const provider=candidates[index];
      const policyResult=await client.query('SELECT * FROM ai_provider_policies WHERE provider=$1',[provider.name]);
      const policy=policyResult.rows[0],purposes=Array.isArray(policy?.allowed_purposes)?policy.allowed_purposes:[];
      let denied=null;
      if(!policy?.enabled)denied=policyError('AI_PROVIDER_DISABLED_BY_POLICY');
      else if(!purposes.includes(input.purpose))denied=policyError('AI_PURPOSE_DENIED_BY_POLICY');
      else if(provider.name!=='local'&&!policy.allow_sensitive_context)denied=policyError('CLOUD_CONTEXT_NOT_APPROVED');
      else if(input.useSearch&&!policy.allow_search)denied=policyError('AI_SEARCH_DISABLED_BY_POLICY');
      if(denied){lastPolicyFailure=denied;fallbackChain.push({provider:provider.name,status:'skipped',reason:denied.code});continue;}

      activeRunId=uuid();const attemptStart=Date.now();
      const manifest={...built.manifest,routing:{attempt:index+1,order:candidates.map(item=>item.name),fallbackFrom:fallbackChain.filter(x=>x.status==='failed').map(x=>x.provider)}};
      await client.query(`INSERT INTO ai_runs(id,purpose,provider,model,user_id,factory_id,equipment_id,context_manifest,prompt_hash,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running')`,[activeRunId,input.purpose,provider.name,provider.model,user.id,built.context.asset.factory_id,built.context.asset.id,JSON.stringify(manifest),promptHash]);
      try{
        const result=await provider.generate({system:SYSTEM_PROMPT,prompt,media:input.media||[],useSearch:!!input.useSearch});
        const webUrls=(result.groundingMetadata?.groundingChunks||[]).map(chunk=>chunk.web?.uri).filter(Boolean);
        const parsed=parseStructured(result.text),recommendations=normalizeRecommendations(parsed,built.sourceIds,{allowWebUrls:webUrls});
        fallbackChain.push({provider:provider.name,status:'succeeded'});
        await client.query('BEGIN');transaction=true;
        await client.query(`UPDATE ai_runs SET status='succeeded',model=$2,response_metadata=$3,duration_ms=$4,completed_at=now() WHERE id=$1`,[activeRunId,result.model,JSON.stringify({usage:result.usage,providerRequestId:result.providerRequestId,groundingMetadata:result.groundingMetadata||null,fallbackChain}),Date.now()-attemptStart]);
        const rows=[];
        for(const rec of recommendations){const id=uuid();const inserted=await client.query(`INSERT INTO ai_recommendations(id,ai_run_id,recommendation_type,recommendation,reason,evidence,confidence,source_context,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending_approval') RETURNING *`,[id,activeRunId,rec.type,rec.recommendation,rec.reason,JSON.stringify(rec.evidence),rec.confidence,JSON.stringify(rec.sourceContext)]);rows.push(inserted.rows[0]);}
        await client.query(`INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after) VALUES($1,now(),$2,$3,$4,'ai-analyze','ai',$5,$6,NULL,$7)`,[uuid(),user.name,user.id,user.role,activeRunId,`${input.purpose} — ${provider.name}`,JSON.stringify({recommendationCount:rows.length,equipmentId:built.context.asset.id,fallbackChain})]);
        await client.query('COMMIT');transaction=false;
        return {runId:activeRunId,provider:provider.name,model:result.model,summary:String(parsed.summary||''),recommendations:rows,fallbackChain};
      }catch(error){
        if(transaction){await client.query('ROLLBACK').catch(()=>{});transaction=false;}
        const code=error.code||'PROVIDER_ERROR';
        await client.query(`UPDATE ai_runs SET status=$2,error_code=$3,response_metadata=$4,duration_ms=$5,completed_at=now() WHERE id=$1`,[activeRunId,code==='PROVIDER_TIMEOUT'?'timed_out':'failed',code,JSON.stringify({fallbackChain:[...fallbackChain,{provider:provider.name,status:'failed',reason:code}]}),Date.now()-attemptStart]).catch(()=>{});
        fallbackChain.push({provider:provider.name,status:'failed',reason:code});lastProviderFailure=error;
        if(!isFallbackFailure(error))throw error;
      }
    }
    if(lastProviderFailure)throw lastProviderFailure;
    if(lastPolicyFailure)throw lastPolicyFailure;
    throw new AIProviderError('NO_CAPABLE_PROVIDER','No approved provider is available',503);
  }catch(error){
    if(transaction)await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{client.release();}
}

module.exports={PURPOSES,RECOMMENDATION_TYPES,validateRequest,requireEquipmentScope,buildContext,parseStructured,normalizeRecommendations,analyze,SYSTEM_PROMPT};
