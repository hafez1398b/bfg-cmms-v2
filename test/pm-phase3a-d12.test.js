'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootDir = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(rootDir, file), 'utf8');

const asset = (id, code, name) => ({
  id, code, name, type:'eq', status:'active', crit:'A', parent:'factory-1', deleted:false
});
const ASSET = asset('asset-b1p06-id', 'B1P06', 'پمپ B1P06');
const OTHER_ASSET = asset('asset-b1p060-id', 'B1P060', 'پمپ مشابه B1P060');

function createIntegrationHarness(assets=[ASSET, OTHER_ASSET]) {
  const requests=[];
  const modals=[];
  const legacyQuickActionCalls=[];
  const DB={pms:[],assets:assets.map(row=>({...row})),wos:[]};
  const document={
    addEventListener(){},
    querySelector(){return null;},
    querySelectorAll(){return [];}
  };
  const window={
    BFGBackend:{config:{apiBasePath:'/api'}},
    BFGRuntime:{state:{config:{apiBasePath:'/api'}},isServerOnly:()=>true},
    bfgApi:async(url,options={})=>{requests.push({url,options});return{data:[]};},
    can:()=>true,
    confirm:()=>true,
    prompt:()=>'',
    toast(){},
    go(){},
    CUR:'pm',
    mhead:title=>`<header>${title}</header>`,
    head:()=>'',
    modal(html){modals.push(html);},
    closeModal(){},
    openPMForm(){},
    // The real equipment-v2 Quick Action resolves to this global. If the PM
    // boundary does not intercept it, this legacy path drops the equipment arg.
    eqv2Related(kind,equipmentId){
      legacyQuickActionCalls.push({kind,equipmentId});
      if(kind==='pm')return window.openPMForm();
    }
  };
  const context=vm.createContext({
    window,DB,document,Date,Set,Map,Number,String,Array,Object,Promise,JSON,
    encodeURIComponent,console,setTimeout,clearTimeout
  });
  vm.runInContext(read('public/platform-v2/maintenance-client.js'),context,{filename:'maintenance-client.js'});
  vm.runInContext(read('public/platform-v2/maintenance-pm-ui.js'),context,{filename:'maintenance-pm-ui.js'});
  window.BFGMaintenance.installed=true;
  window.BFGMaintenance.pmUi.install();
  return {window,DB,context,document,requests,modals,legacyQuickActionCalls};
}

function selectedAssetValues(html) {
  const select=html.match(/<select data-pm-field="assetId" required>([\s\S]*?)<\/select>/);
  assert.ok(select,'central PM editor equipment Select should be rendered');
  return [...select[1].matchAll(/<option value="([^"]*)"[^>]*\bselected\b/g)].map(match=>match[1]);
}

test('D1.2 dossier Quick Action forwards canonical asset ID and opens the central PM editor without a POST', () => {
  const {window,requests,modals,legacyQuickActionCalls}=createIntegrationHarness();
  assert.equal(window.DB,undefined);
  assert.deepEqual(window.BFGMaintenance.getCollection('assets').map(row=>({id:row.id,code:row.code})),[
    {id:ASSET.id,code:ASSET.code},{id:OTHER_ASSET.id,code:OTHER_ASSET.code}
  ]);

  window.eqv2Related('pm',ASSET.id);

  const html=modals.at(-1);
  assert.match(html,/برنامه PM جدید/);
  assert.deepEqual(selectedAssetValues(html),[ASSET.id]);
  assert.equal(legacyQuickActionCalls.length,0,'PM Quick Action must be intercepted before the legacy no-argument call');
  assert.equal(requests.length,0,'opening the PM editor must not POST or save a record');
});

test('D1.2 Quick Action resolves an exact asset.code to that DTO id and never selects a similar asset', () => {
  const {window,requests,modals}=createIntegrationHarness();

  window.eqv2Related('pm',ASSET.code);

  const html=modals.at(-1);
  assert.match(html,/برنامه PM جدید/);
  assert.deepEqual(selectedAssetValues(html),[ASSET.id]);
  assert.notDeepEqual(selectedAssetValues(html),[OTHER_ASSET.id]);
  assert.equal(requests.length,0);
});

test('D1.2 unknown and partial equipment references leave the central Select blank, show Persian guidance, and do not throw', () => {
  const {window,requests,modals}=createIntegrationHarness();

  assert.doesNotThrow(()=>window.eqv2Related('pm','B1P99'));
  let html=modals.at(-1);
  assert.match(html,/برنامه PM جدید/);
  assert.deepEqual(selectedAssetValues(html),['']);
  assert.match(html,/تجهیز پرونده در فهرست مجاز تجهیزات پیدا نشد/);

  assert.doesNotThrow(()=>window.eqv2Related('pm','B1P0'));
  html=modals.at(-1);
  assert.deepEqual(selectedAssetValues(html),['']);
  assert.match(html,/تجهیز پرونده در فهرست مجاز تجهیزات پیدا نشد/);
  assert.equal(requests.length,0);
});

test('D1.2 duplicate exact codes are ambiguous and never guess between assets', () => {
  const duplicate=asset('asset-b1p06-duplicate','B1P06','تجهیز دارای کد تکراری');
  const {window,requests,modals}=createIntegrationHarness([ASSET,duplicate]);

  assert.doesNotThrow(()=>window.eqv2Related('pm',ASSET.code));
  const html=modals.at(-1);
  assert.deepEqual(selectedAssetValues(html),['']);
  assert.match(html,/کد تجهیز در فهرست مجاز یکتا نیست/);
  assert.equal(requests.length,0);
});

test('D1.2 central PM create remains un-preselected and the regression uses the lexical maintenance Store', () => {
  const pmUi=read('public/platform-v2/maintenance-pm-ui.js');
  const client=read('public/platform-v2/maintenance-client.js');
  const equipment=read('public/equipment-v2/equipment-v2.js');
  const {window,DB,requests,modals}=createIntegrationHarness();

  assert.match(client,/DB\.assets\.push\(\{ id:row\.id, code:row\.code, name:row\.name/);
  assert.match(equipment,/eqv2Related\('pm','\$\{escText\(a\.id\)\}'\)/);
  assert.match(pmUi,/maintenance\.getCollection\?\.\('assets'\)/);
  assert.doesNotMatch(pmUi,/\b(?:root|window)\.DB\b|localStorage|sessionStorage/);
  assert.equal(window.DB,undefined);
  assert.equal(DB.assets[0].id,ASSET.id,'fixture DTO is held in the real lexical DB.assets collection');

  window.openPMForm();

  assert.match(modals.at(-1),/برنامه PM جدید/);
  assert.deepEqual(selectedAssetValues(modals.at(-1)),['']);
  assert.doesNotMatch(modals.at(-1),/تجهیز پرونده در فهرست مجاز پیدا نشد/);
  assert.equal(requests.length,0);
});
