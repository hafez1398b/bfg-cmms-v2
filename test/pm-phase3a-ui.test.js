'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootDir = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(rootDir, file), 'utf8');

function createUi({ plans = [], can = () => true, confirm = () => true, prompt = () => 'fixture reason', api } = {}) {
  const requests = [];
  const DB = { pms:plans, assets:[], wos:[] };
  const window = {
    BFGMaintenance: {
      installed:false,
      pm:{ includeArchived:false, selectedId:null, loading:false, loaded:true, error:null, busy:new Set(), details:null, occurrenceDetails:null },
      getCollection(name){
        const allowed=['pms','assets','wos'];
        if(!allowed.includes(name)) return [];
        if(!Array.isArray(DB[name])) return [];
        return DB[name].slice();
      },
      sync:async () => { window.syncCount++; return plans; }
    },
    syncCount:0,
    BFGRuntime:{ state:{ config:{ apiBasePath:'/api' } }, isServerOnly:()=>true },
    BFGBackend:{ config:{ apiBasePath:'/api' } },
    bfgApi:async (url, options={}) => { requests.push({url,options}); return api?api(url,options,requests):{data:[]}; },
    can,
    confirm,
    prompt,
    toast(message){ (window.toastMessages ||= []).push(message); },
    go:()=>{},
    CUR:'pm',
    head:()=>'',
    mhead:()=>'',
    modal:()=>{},
    closeModal:()=>{},
    jDate:value=>String(value),
    jStr2iso:()=>null
  };
  const context = vm.createContext({ window, Date, Set, Map, Number, String, Array, Object, Promise, encodeURIComponent, JSON });
  vm.runInContext(read('public/platform-v2/maintenance-pm-ui.js'), context, { filename:'maintenance-pm-ui.js' });
  return { window, ui:window.BFGMaintenance.pmUi, requests };
}

test('PM UI uses canonical routes, runtime API base, returned backend fields, and no local operational storage', () => {
  const ui = read('public/platform-v2/maintenance-pm-ui.js');
  const client = read('public/platform-v2/maintenance-client.js');
  const backendClient = read('public/platform-v2/backend-client.js');
  const html = read('public/index.html');
  assert.ok(ui.includes("config.apiBasePath || '/api'"));
  assert.ok(ui.includes("'/due?evaluatedAt='"));
  assert.ok(ui.includes("'/occurrences'"));
  assert.ok(ui.includes("'/generate-work-order'"));
  assert.ok(ui.includes("'/archive'"));
  assert.ok(ui.includes("'/restore'"));
  assert.match(client, /includeArchived=true/);
  assert.match(backendClient, /x-client-version/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage/);
  assert.doesNotMatch(ui, /setDate\(|intervalDays\s*\*|interval\s*\*/);
  assert.ok(html.includes('N/A — داده کافی ثبت نشده است'));
  assert.ok(!html.includes("{id:'m1',assetId:'a9'"));
  assert.ok(html.includes('pms:[]'));
});

test('PM page stays empty until successful backend sync and displays the exact insufficient-data value', () => {
  const { window, ui } = createUi({ plans:[] });
  window.BFGMaintenance.pm.loaded=false;
  assert.match(ui.renderPage(), /دادهٔ PM از Backend بارگذاری نشده است/);
  window.BFGMaintenance.pm.loaded=true;
  const html=ui.renderPage();
  assert.ok(html.includes('N/A — داده کافی ثبت نشده است'));
  assert.match(html, /برنامه‌ای از Backend برای نمایش دریافت نشد/);
});

test('explicit scheduling prevents concurrent double-submit and reloads the backend list', async () => {
  const plan={id:'plan-1',rowVersion:7,periodKey:'calendar:2026-10-28',dueStatus:'due',nextDueAt:'2026-10-28T00:00:00.000Z'};
  let resolveRequest;
  const { window, ui, requests }=createUi({plans:[plan],api:(url,options)=>new Promise(resolve=>{resolveRequest=()=>resolve({data:{occurrence:{id:'occ-1'},idempotentReplay:false}});})});
  const button={disabled:false,setAttribute(){},removeAttribute(){}};
  const first=ui.action('schedule',plan,button);
  await Promise.resolve();
  const second=await ui.action('schedule',plan,{disabled:false,setAttribute(){},removeAttribute(){}});
  assert.equal(second.ignored,true);
  assert.equal(requests.length,1);
  assert.equal(button.disabled,true);
  assert.equal(requests[0].url,'/api/pm-plans/plan-1/occurrences');
  assert.equal(requests[0].options.method,'POST');
  const body=JSON.parse(requests[0].options.body);
  assert.equal(body.rowVersion,7);
  assert.equal(body.periodKey,'calendar:2026-10-28');
  assert.equal(typeof body.evaluatedAt,'string');
  resolveRequest();
  await first;
  assert.equal(window.syncCount,1);
  assert.equal(button.disabled,false);
  assert.equal(window.BFGMaintenance.pm.busy.size,0);
});

test('archive requires explicit reason and sends the real rowVersion without a physical delete', async () => {
  const plan={id:'plan-archive',rowVersion:9,status:'active'};
  const { ui, requests }=createUi({plans:[plan],prompt:()=>''});
  const cancelled=await ui.action('archive',plan);
  assert.equal(cancelled.cancelled,true);
  assert.equal(requests.length,0);
  const second=createUi({plans:[plan],prompt:()=> 'علت مستند'});
  await second.ui.action('archive',plan);
  assert.equal(second.requests[0].url,'/api/pm-plans/plan-archive/archive');
  assert.equal(second.requests[0].options.method,'POST');
  assert.deepEqual(JSON.parse(second.requests[0].options.body),{rowVersion:9,reason:'علت مستند'});
  assert.doesNotMatch(second.requests[0].url,/DELETE/);
});

test('restore is permission-gated and submits the real rowVersion', async () => {
  const plan={id:'plan-archived',rowVersion:12,archivedAt:'2026-10-01T00:00:00Z'};
  const denied=createUi({plans:[plan],can:(module,permission)=>!(module==='pm'&&['restore','archive'].includes(permission))});
  await assert.rejects(denied.ui.action('restore',plan),error=>error.status===403);
  assert.equal(denied.requests.length,0);
  const allowed=createUi({plans:[plan]});
  await allowed.ui.action('restore',plan);
  assert.equal(allowed.requests[0].url,'/api/pm-plans/plan-archived/restore');
  assert.deepEqual(JSON.parse(allowed.requests[0].options.body),{rowVersion:12});
});

test('generate requires its permission and sends explicit server request only once', async () => {
  const plan={id:'plan-generate',rowVersion:4,dueStatus:'overdue'};
  const denied=createUi({plans:[plan],can:(module,permission)=>!(module==='wos'&&permission==='create')&&!(module==='pm'&&permission==='generate')});
  await assert.rejects(denied.ui.action('generate',plan),error=>error.status===403);
  assert.equal(denied.requests.length,0);
  const allowed=createUi({plans:[plan]});
  await allowed.ui.action('generate',plan);
  assert.equal(allowed.requests[0].url,'/api/pm-plans/plan-generate/generate-work-order');
  assert.equal(allowed.requests[0].options.method,'POST');
  assert.deepEqual(JSON.parse(allowed.requests[0].options.body),{rowVersion:4});
});


test('Due is a canonical read-only backend response formatted through jDate', async () => {
  const plan={id:'plan-due',title:'PM',rowVersion:2,assetId:'asset-1',intervalDays:30,scheduleBasis:'calendar'};
  const { ui, requests }=createUi({plans:[plan],api:async url=>{
    if(url.endsWith('/due?evaluatedAt='+encodeURIComponent(new Date().toISOString()))) return {data:{nextDueAt:'2026-10-28T00:00:00.000Z',dueStatus:'due',reason:null}};
    if(url.endsWith('/occurrences')) return {data:[{id:'occ-1',pmPlanId:'plan-due',periodKey:'calendar:2026-10-28',status:'due',dueAt:'2026-10-28T00:00:00Z',rowVersion:1}]};
    return {data:plan};
  }});
  const result=await ui.loadDetails(plan.id);
  assert.equal(requests[0].url,'/api/pm-plans/plan-due');
  assert.match(requests[1].url,/\/due\?evaluatedAt=/);
  assert.equal(requests[1].options.method,undefined);
  assert.match(requests[2].url,/\/occurrences$/);
  assert.equal(requests[2].options.method,undefined);
  assert.equal(result.due.nextDueAt,'2026-10-28T00:00:00.000Z');
  assert.equal(result.occurrences[0].id,'occ-1');
  assert.equal(ui.date('2026-10-28T00:00:00.000Z'),'2026-10-28T00:00:00.000Z');
});

test('conflict and validation responses are translated to Persian UI messages', async () => {
  for(const [status,expected] of [[409,'تعارض نسخه یا وضعیت رخ داده است؛ داده را تازه کنید.'],[422,'اطلاعات یا تاریخ واردشده معتبر نیست؛ فیلدها را بررسی کنید.']]){
    const plan={id:`plan-${status}`,rowVersion:1,dueStatus:'due'};
    const fixture=createUi({plans:[plan],api:async()=>{const error=new Error('BACKEND_REQUEST_FAILED');error.status=status;throw error;}});
    const result=await fixture.ui.action('schedule',plan);
    assert.equal(result.error.status,status);
    assert.ok(fixture.window.toastMessages.includes(expected));
  }
  const fixture=createUi();
  assert.match(fixture.ui.errorText({status:403}),/مجوز/);
});
