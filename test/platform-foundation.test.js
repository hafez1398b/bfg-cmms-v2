'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const jwt=require('jsonwebtoken');
const {createSecurity}=require('../server/security');
const {createNotification,validate}=require('../server/notification-service');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('Second Correction migration is additive and creates durable domain foundations',()=>{
  const sql=read('migrations/004_second_correction_foundation.sql');
  for(const table of ['role_permissions','user_scopes','notifications','notification_recipients','event_outbox','failures','failure_measurements','rca_cases','ai_runs','ai_recommendations','idempotency_keys','sync_commands'])assert.match(sql,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.doesNotMatch(sql,/\b(DROP|TRUNCATE|DELETE FROM)\b/i);
  assert.match(sql,/حافظ بایرامیان/);
});

test('notification validation rejects untargeted or unsupported events',()=>{
  assert.deepEqual(validate({type:'fake',title:'x',body:'y',targets:{}}),['type','targets']);
  assert.deepEqual(validate({type:'critical_failure',title:'x',body:'y',priority:'critical',targets:{userIds:['u1']}}),[]);
});

test('notification creation persists recipients and transactional outbox envelope',async()=>{
  const calls=[];
  const client={query:async(sql,values)=>{
    calls.push({sql,values});
    if(/SELECT id FROM users WHERE active=true AND role/.test(sql))return{rows:[{id:'u2'}]};
    if(/INSERT INTO notifications/.test(sql))return{rows:[{id:values[0],type:values[1],title:values[2],priority:values[4]}]};
    return{rows:[],rowCount:1};
  }};
  const result=await createNotification(client,{type:'critical_failure',title:'خرابی بحرانی',body:'پمپ متوقف شد',priority:'critical',targets:{userIds:['u1'],roles:['mgr']},equipmentId:'eq-1'},'u-admin');
  assert.deepEqual(result.recipientIds.sort(),['u1','u2']);
  const recipients=calls.find(call=>/notification_recipients/.test(call.sql));
  assert.deepEqual(recipients.values[1].sort(),['u1','u2']);
  const outbox=calls.find(call=>/event_outbox/.test(call.sql));
  assert.ok(outbox,'outbox write is part of notification transaction');
  assert.deepEqual(JSON.parse(outbox.values[4]).sort(),['u1','u2']);
});

test('backend security revalidates active JWT user and enforces database permission',async()=>{
  const secret='test-secret-at-least-32-characters';
  const pool={query:async(sql,values)=>{
    if(/FROM users/.test(sql))return{rows:[{id:values[0],username:'admin',name:'حافظ بایرامیان',role:'admin',unit:'مدیریت سیستم',active:true}]};
    if(/role_permissions/.test(sql))return{rows:values[1]==='notification.view'?[{ok:1}]:[]};
    return{rows:[]};
  }};
  const security=createSecurity({pool,jwtSecret:secret});
  const req={headers:{authorization:'Bearer '+jwt.sign({id:'u1'},secret,{algorithm:'HS256'})}};
  let nextCalled=false;
  await security.authenticateToken(req,{status(){throw new Error('unexpected rejection');}},()=>{nextCalled=true;});
  assert.equal(nextCalled,true);assert.equal(req.user.name,'حافظ بایرامیان');
  assert.equal(await security.hasPermission(req.user,'notification.view'),true);
  assert.equal(await security.hasPermission(req.user,'notification.delete'),false);
});

test('server uses one authenticated realtime configuration instead of global connection handlers',()=>{
  const source=read('server.js'),realtime=read('server/realtime.js');
  assert.equal((source.match(/io\.on\('connection'/g)||[]).length,0);
  assert.match(source,/configureRealtime\(\{ io, pool, security \}\)/);
  assert.match(realtime,/io\.use/);
  assert.match(realtime,/socket\.join\(`user:\$\{id\}`\)/);
  assert.match(realtime,/event_outbox/);
  assert.doesNotMatch(realtime,/io\.emit/);
});

test('canonical system administrator identity is consistent in local and PostgreSQL provisioning',()=>{
  assert.match(read('public/index.html'),/u:'admin',p:'1234',name:'حافظ بایرامیان',role:'admin'/);
  assert.match(read('create-admin.js'),/حافظ بایرامیان/);
  assert.doesNotMatch(read('create-admin.js'),/admin123/);
});
