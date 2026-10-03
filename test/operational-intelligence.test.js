'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function harness(){
  const now=new Date(),recent=new Date(now-10*864e5).toISOString();
  const DB={
    assets:[{id:'factory',name:'کارخانه ۱',type:'site',ext:{nodeKind:'factory'}},{id:'eq1',parent:'factory',name:'پمپ',type:'eq',status:'active'}],
    pms:[{id:'pm1',assetId:'eq1',title:'PM پمپ',last:recent,interval:30}],
    wos:[{id:'wo1',assetId:'eq1',type:'CM',status:'closed',priority:'normal',createdAt:recent,times:{end:recent}}],
    items:[{id:'sp1',name:'سیل',stock:4,min:2,keyFor:['eq1']}],requests:[]
  };
  const context={window:null,DB,console,Date,Math,Number,String,Object,Array,Map,Set,
    fa:String,esc:String,aiOnline:()=>false,
    pgTree:()=>'<div class="eqv2-toolbar">x</div>',pgInv:()=>'<div class="grid g3">x</div>',pgWOs:()=>'<div class="wo-list-summary">x</div>',pgRequests:()=>'<div class="tbl-tools">x</div>',pgPM:()=>'<div class="grid g3">x</div>',pgKPI:()=>'<h3 style="margin:6px 0 10px">x</h3>'};
  context.window=context;vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/insights/operational-intelligence.js'),'utf8'),context);
  return context;
}

test('equipment health is deterministic, evidence-based, and enforces minimum coverage',()=>{
  const context=harness(),engine=context.BFGOperationalIntelligence;
  const result=engine.equipmentHealth(context.DB.assets[1]);
  assert.equal(Number.isFinite(result.score),true);
  assert.ok(result.evidence.length>=3);
  context.DB.pms=[];context.DB.wos=[];context.DB.items=[];
  const insufficient=engine.equipmentHealth(context.DB.assets[1]);
  assert.equal(insufficient.score,null);
  assert.equal(insufficient.status,'insufficient_data');
});

test('operational intelligence is mounted across equipment, inventory, WO, request, PM and KPI pages',()=>{
  const context=harness();
  for(const [name,domain] of [['pgTree','equipment'],['pgInv','inventory'],['pgWOs','wos'],['pgRequests','requests'],['pgPM','pm'],['pgKPI','kpi']]){
    const html=context[name]();
    assert.match(html,new RegExp(`data-domain="${domain}"`),name);
    assert.match(html,/محاسبه قطعی و قابل ردیابی/);
  }
});
