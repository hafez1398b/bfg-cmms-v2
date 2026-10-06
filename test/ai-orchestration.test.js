'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createProviderRegistry,AIProviderError}=require('../server/ai-providers');
const {analyze,parseStructured,normalizeRecommendations,validateRequest}=require('../server/ai-service');
const {calculateHealth}=require('../server/equipment-health-service');
const root=path.join(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('provider router chooses DeepSeek for RCA and Gemini for multimodal/search',()=>{
  const registry=createProviderRegistry({DEEPSEEK_API_KEY:'secret',DEEPSEEK_MODEL:'reasoner',GEMINI_API_KEY:'secret',GEMINI_MODEL:'flash',GEMINI_SEARCH_ENABLED:'true',AI_TIMEOUT_MS:'5000'});
  assert.equal(registry.select({purpose:'rca'}).name,'deepseek');
  assert.equal(registry.select({purpose:'failure_diagnosis',media:[{kind:'image'}]}).name,'gemini');
  assert.equal(registry.select({purpose:'trend_analysis',useSearch:true}).name,'gemini');
  const status=registry.status();assert.equal(status.gemini.capabilities.audio,true);assert.equal(status.deepseek.capabilities.audio,false);
});

test('provider fallback order is specialist, then DeepSeek, then Local with capability filtering',()=>{
  const registry=createProviderRegistry({LOCAL_AI_BASE_URL:'http://local/v1',LOCAL_AI_MODEL:'local-model',DEEPSEEK_API_KEY:'secret',GEMINI_API_KEY:'secret',GEMINI_MODEL:'flash',GEMINI_SEARCH_ENABLED:'true'});
  assert.deepEqual(registry.order({preferred:'gemini'}),['gemini','deepseek','local']);
  assert.deepEqual(registry.order({purpose:'rca'}),['deepseek','local']);
  assert.deepEqual(registry.candidates({media:[{kind:'image'}]}).map(x=>x.name),['gemini']);
  assert.deepEqual(registry.candidates({purpose:'rca'}).map(x=>x.name),['deepseek','local']);
});

test('orchestrator fails over after provider timeout and audits the successful provider chain',async()=>{
  const primary={name:'gemini',model:'vision',async generate(){throw new AIProviderError('PROVIDER_TIMEOUT','timeout',504);}};
  const fallback={name:'deepseek',model:'reasoner',async generate(){return{text:'{"summary":"fallback ok","recommendations":[]}',model:'reasoner'};}};
  const calls=[];
  const client={async query(sql,args=[]){calls.push([sql,args]);
    if(sql.includes('FROM assets'))return{rows:[{id:'eq-1',code:'EQ-1',name:'Pump',factory_id:'f-1'}]};
    if(sql.includes('FROM work_orders')||sql.includes('FROM failures')||sql.includes('FROM pm_plans')||sql.includes('FROM requests')||sql.includes('FROM asset_spare_parts'))return{rows:[]};
    if(sql.includes('FROM ai_provider_policies'))return{rows:[{provider:args[0],enabled:true,allowed_purposes:['rca'],allow_sensitive_context:true,allow_search:false}]};
    return{rows:[]};},release(){}};
  const result=await analyze({pool:{connect:async()=>client},registry:{candidates:()=>[primary,fallback]},user:{id:'u-1',name:'Admin',role:'admin'},input:{purpose:'rca',equipmentId:'eq-1',question:'why?',media:[]}});
  assert.equal(result.provider,'deepseek');
  assert.deepEqual(result.fallbackChain.map(x=>[x.provider,x.status]),[['gemini','failed'],['deepseek','succeeded']]);
  assert.ok(calls.some(([sql,args])=>sql.includes('UPDATE ai_runs SET status=$2')&&args[2]==='PROVIDER_TIMEOUT'));
});

test('AI request validator prevents oversized or context-free analysis',()=>{
  assert.deepEqual(validateRequest({purpose:'invalid'}),['purpose','equipmentId','question']);
  assert.deepEqual(validateRequest({purpose:'rca',equipmentId:'eq-1',question:'why?',media:[]}),[]);
});

test('structured recommendations reject evidence outside authorized database context',()=>{
  const parsed=parseStructured('{"summary":"x","recommendations":[{"type":"diagnosis","recommendation":"بررسی پمپ","reason":"سابقه خرابی","confidence":0.7,"evidence":[{"sourceType":"failure","sourceId":"f-unknown","excerpt":"x"}]}]}');
  assert.throws(()=>normalizeRecommendations(parsed,{asset:['eq-1'],failure:['f-1']}),/outside authorized context/);
  parsed.recommendations[0].evidence[0].sourceId='f-1';
  const normalized=normalizeRecommendations(parsed,{asset:['eq-1'],failure:['f-1']});
  assert.equal(normalized[0].confidence,0.7);
});

test('wizard AI evidence is an exact authorized excerpt and confidence is a bounded numeric score',()=>{
  const sourceTexts=new Map([['work_order:wo-1','{"descr":"نشتی پمپ شماره دو","status":"done"}']]);
  const sourceIds={work_order:['wo-1']};
  const make=(confidence,excerpt='نشتی پمپ شماره دو')=>({recommendations:[{type:'diagnosis',recommendation:'بررسی نشتی',reason:'سابقه ثبت‌شده',confidence,evidence:[{sourceType:'work_order',sourceId:'wo-1',excerpt}]}]});
  assert.equal(normalizeRecommendations(make(0.75),sourceIds,{strictEvidence:true,sourceTexts}).length,1);
  for(const confidence of ['',true,-0.1,1.1,'high'])assert.throws(
    ()=>normalizeRecommendations(make(confidence),sourceIds,{strictEvidence:true,sourceTexts}),/confidence/);
  assert.throws(()=>normalizeRecommendations(make(0.75,'شواهد ساختگی'),sourceIds,{strictEvidence:true,sourceTexts}),/excerpt does not match/);
});

test('deterministic Health Score returns N/A until enough verified factors exist',()=>{
  const insufficient=calculateHealth({failures:[],completedWorkOrders:[],pm:{total:0},checklists:{total:0},spares:[]});
  assert.equal(insufficient.score,null);assert.equal(insufficient.status,'insufficient_data');
  const calculated=calculateHealth({
    failures:[
      {occurred_at:'2026-08-01',severity:8,downtime_minutes:240,status:'verified',provenance_status:'verified'},
      {occurred_at:'2026-07-01',severity:6,downtime_minutes:120,status:'resolved',provenance_status:'verified'}
    ],completedWorkOrders:[{duration_hours:4},{duration_hours:2}],pm:{total:10,compliant:8},checklists:{total:10,passed:9},spares:[{stock:0,min_stock:1},{stock:2,min_stock:1}]
  },new Date('2026-09-16T00:00:00Z'));
  assert.equal(calculated.status,'calculated');assert.ok(calculated.score>=0&&calculated.score<=100);assert.ok(calculated.factors.length>=3);assert.equal(calculated.modelVersion,'health-rule-1.0');
});

test('AI migration and frontend keep secrets server-side and require human approval',()=>{
  const sql=read('migrations/005_ai_orchestration.sql'),client=read('public/ai/ai-client.js'),providers=read('server/ai-providers.js');
  assert.match(sql,/ai_provider_policies/);assert.match(sql,/checklist_executions/);assert.match(sql,/equipment_health_snapshots/);
  assert.match(client,/کلیدها فقط در Environment سرور/);assert.doesNotMatch(client,/apiKey\s*[:=]\s*document/);
  assert.match(providers,/process\.env/);assert.match(read('server/ai-service.js'),/pending_approval/);
  assert.match(read('server.js'),/\/api\/ai/);
});
