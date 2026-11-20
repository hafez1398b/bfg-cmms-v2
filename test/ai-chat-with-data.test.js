'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chatWithData,classifyGlobalQuestion,GLOBAL_QUERIES,NO_DATA_ANSWER}=require('../server/ai-chat-service');

function mockPool(handler){const calls=[];return {calls,pool:{query:async(sql,params)=>{calls.push({sql,params});return handler(sql,params);},connect:async()=>({query:async(sql,params)=>{calls.push({sql,params});if(sql.includes('SELECT a.id'))return{rows:[{id:'eq-1'}]};return handler(sql,params);},release(){}})}};}
const permissions=async(_user,p)=>['equipment.view','work_order.view','pm.view','inventory.view'].includes(p);

test('global PostgreSQL equipment count works without an equipment id and has fixed SQL/evidence envelope',async()=>{
 const mock=mockPool(async()=>({rows:[{value:7,source_ids:['eq-1','eq-2']}]}));
 const result=await chatWithData({pool:mock.pool,user:{id:'u1',role:'planner'},input:{queryType:'global',question:'فقط براساس PostgreSQL بگو چند تجهیز ثبت شده است'},hasPermission:permissions});
 assert.equal(result.status,'answered');assert.match(result.answer,/7/);assert.equal(result.provider,'PostgreSQL');assert.deepEqual(result.evidence[0].sourceIds,['eq-1','eq-2']);
 assert.equal(mock.calls.length,1);assert.doesNotMatch(mock.calls[0].sql,/\b(assetId|equipmentId)\b/i);assert.equal(mock.calls[0].params[1],'u1');
});

test('equipment-scoped request without selection fails before database access',async()=>{
 const mock=mockPool(()=>({rows:[]}));await assert.rejects(chatWithData({pool:mock.pool,user:{id:'u1',role:'planner'},input:{queryType:'equipment',question:'چند تجهیز ثبت شده؟'},hasPermission:permissions}),e=>e.code==='EQUIPMENT_REQUIRED');assert.equal(mock.calls.length,0);
});

test('global query honors user scope predicate and binds identity/role',async()=>{
 const mock=mockPool(async()=>({rows:[{value:2,source_ids:['eq-1','eq-2']}]}));
 await chatWithData({pool:mock.pool,user:{id:'u2',role:'planner'},input:{queryType:'global',question:'چند تجهیز ثبت شده؟'},hasPermission:permissions});
 assert.match(mock.calls[0].sql,/user_scopes/);assert.match(mock.calls[0].sql,/scope_type='equipment'/);assert.deepEqual(mock.calls[0].params,['planner','u2']);
});

test('empty PostgreSQL portfolio returns exact N/A and insufficient-data status',async()=>{
 const mock=mockPool(async()=>({rows:[{value:0,source_ids:[]}]}));const result=await chatWithData({pool:mock.pool,user:{id:'u1',role:'admin'},input:{queryType:'global',question:'تعداد تجهیزات'},hasPermission:permissions});
 assert.equal(result.answer,NO_DATA_ANSWER);assert.equal(result.status,'insufficient_data');assert.equal(result.confidence,null);
});

test('unsupported question returns N/A without querying SQL',async()=>{
 const mock=mockPool(()=>({rows:[]}));const result=await chatWithData({pool:mock.pool,user:{id:'u1',role:'admin'},input:{queryType:'global',question:'فردا هوا چطور است؟'},hasPermission:permissions});
 assert.equal(result.status,'unsupported');assert.equal(result.answer,NO_DATA_ANSWER);assert.equal(mock.calls.length,0);
});

test('only predefined query catalog executes; model-provided SQL is never accepted',async()=>{
 const mock=mockPool(async()=>({rows:[{value:1,source_ids:['eq-1']}]}));const result=await chatWithData({pool:mock.pool,user:{id:'u1',role:'admin'},input:{queryType:'global',question:'تعداد تجهیزات',sql:'DROP TABLE assets'},hasPermission:permissions});
 assert.equal(result.status,'answered');assert.equal(mock.calls.length,1);assert.ok(Object.values(GLOBAL_QUERIES).includes(mock.calls[0].sql));assert.doesNotMatch(mock.calls[0].sql,/DROP TABLE/i);
});

test('query classifier handles UAT question; no mocked AI-center KPI or forecasts remain',()=>{
 assert.equal(classifyGlobalQuestion('فقط براساس PostgreSQL بگو چند تجهیز ثبت شده است'),'equipment_count');
 const html=fs.readFileSync('public/index.html','utf8');const center=html.slice(html.indexOf('function pgAI(){'),html.indexOf('/* ================= Report Builder ================= */'));
 assert.match(center,/N\/A/);assert.doesNotMatch(center,/۶۸|۴۱|۱۲|3\.4|Downtime نسبت به ماه قبل|مکانیکال‌سیل CR-32/);
 assert.match(center,/value="global"/);assert.match(center,/ابتدا تجهیز را انتخاب کنید/);
});

test('Chat with Data is read-only and does not call legacy analyze, audit, or write paths',()=>{
 const service=fs.readFileSync('server/ai-chat-service.js','utf8');const route=fs.readFileSync('server/ai-routes.js','utf8');
 assert.match(route,/post\('\/chat-with-data',authorize\('ai\.use'\)/);assert.match(service,/readOnly: true/);assert.doesNotMatch(service,/INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|audit_x|ai_runs/i);
});
