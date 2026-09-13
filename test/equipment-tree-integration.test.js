'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(){
  const content={innerHTML:''},listeners={};
  const asset={id:'eq-1',code:'EQ-1',name:'پمپ تست',type:'eq',status:'active',crit:'A',factory_name:'بسپار ۱',location_name:'سالن تولید',path:[{id:'factory-1',code:'B1',name:'بسپار ۱',nodeKind:'factory'},{id:'eq-1',code:'EQ-1',name:'پمپ تست',nodeKind:'equipment'}],children:[],pm_plans:[],work_orders:[],maintenance_history:[],requests:[],spare_parts:[],consumed_parts:[],cost_entries:[],downtimes:[],documents:[],risks:[],rca:[],movements:[],ext:{nodeKind:'equipment'}};
  const context={
    MENU:[{g:'دارایی‌ها'},{id:'tree',ic:'🌳',t:'درخت تجهیزات'}],pgTree:()=>'<div>classic tree</div>',doLogin(){},ME:null,CUR:'dash',buildMenu(){},
    EquipmentRepository:{current:()=>({source:'local-compatibility',get:async()=>({data:asset}),feature:async()=>({enabled:true}),filters:async()=>({factories:[],categories:[]}),tree:async()=>({data:[]}),list:async()=>({data:[],pagination:{page:1,pages:1,total:0,limit:25}})})},
    sessionStorage:{getItem:()=>null,setItem(){}},localStorage:{getItem:()=>null,setItem(){}},
    setTimeout:()=>0,clearTimeout(){},requestAnimationFrame:fn=>fn(),can:()=>true,esc:value=>String(value??''),fa:value=>String(value??''),money:value=>String(value??''),jDate:value=>String(value??''),jDateTime:value=>String(value??''),AS_ST:{active:['فعال','b-green']},
    document:{getElementById:id=>id==='content'?content:null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener:(name,fn)=>{listeners[name]=fn;}},
    location:{pathname:'/',search:'',hash:''},history:{pushState(_s,_t,url){context.location.pathname=url;},replaceState(_s,_t,url){context.location.pathname=url;}},
    CSS:{escape:value=>String(value)},scrollY:0,scrollTo(){},addEventListener:(name,fn)=>{listeners[name]=fn;},console
  };
  context.window=context;
  vm.createContext(context);
  const source=fs.readFileSync(path.join(__dirname,'../public/equipment-v2/equipment-v2.js'),'utf8');
  vm.runInContext(source,context);
  return{context,content,listeners,source};
}

test('existing pgTree is upgraded without creating a duplicate menu module',()=>{
  const {context,source}=harness();
  assert.equal(context.MENU.filter(item=>item.id==='tree').length,1);
  assert.equal(context.MENU.some(item=>item.id==='equipmentV2'||item.id==='floormap'),false);
  const html=context.pgTree();
  assert.match(html,/درخت تجهیزات و شناسنامه/);
  assert.match(html,/🌳 درخت/);
  assert.match(html,/☷ لیست/);
  assert.match(source,/data-equipment-detail/);
  assert.match(source,/addEventListener\('dblclick'/);
});

test('Tree/List detail navigation keeps the selected equipment and creates a bookmark route',async()=>{
  const {context,content}=harness();
  context.EQV2.view='tree';
  await context.eqv2OpenDetail('eq-1');
  assert.equal(context.EQV2.selected,'eq-1');
  assert.equal(context.location.pathname,'/equipment/EQ-1');
  assert.match(content.innerHTML,/← بازگشت به تجهیزات/);
  assert.match(content.innerHTML,/EQ-1/);
  assert.match(content.innerHTML,/پمپ تست/);
  assert.match(content.innerHTML,/بسپار ۱/);
  assert.match(content.innerHTML,/سالن تولید/);

  const firstPath=context.location.pathname;
  await context.eqv2OpenDetail('eq-1');
  assert.equal(context.location.pathname,firstPath,'repeated navigation reuses the same detail route');
});

test('Back restores the originating List context instead of resetting it',async()=>{
  const {context,content}=harness();
  Object.assign(context.EQV2,{view:'list',q:'B1P01',factoryId:'factory-1',categoryId:'cat-1',status:'active',sort:'code',direction:'desc',page:3,selected:'eq-1'});
  context.EQV2.open.add('factory-1');
  await context.eqv2OpenDetail('eq-1');
  await context.eqv2BackToEquipment();
  assert.equal(context.EQV2.view,'list');
  assert.equal(context.EQV2.q,'B1P01');
  assert.equal(context.EQV2.factoryId,'factory-1');
  assert.equal(context.EQV2.categoryId,'cat-1');
  assert.equal(context.EQV2.status,'active');
  assert.equal(context.EQV2.sort,'code');
  assert.equal(context.EQV2.direction,'desc');
  assert.equal(context.EQV2.page,3);
  assert.equal(context.EQV2.selected,'eq-1');
  assert.equal(context.EQV2.open.has('factory-1'),true);
  assert.equal(context.location.pathname,'/');
  assert.match(content.innerHTML,/فهرست|درخت تجهیزات/);
});

test('Back also preserves Tree expansion, selection, filters and scroll position',async()=>{
  const {context}=harness();
  Object.assign(context.EQV2,{view:'tree',factoryId:'factory-1',categoryId:'cat-1',selected:'eq-1',treeScroll:246,windowScroll:91});
  context.EQV2.open.add('factory-1');context.EQV2.open.add('area-1');
  await context.eqv2OpenDetail('eq-1');
  await context.eqv2BackToEquipment();
  assert.equal(context.EQV2.view,'tree');
  assert.equal(context.EQV2.selected,'eq-1');
  assert.equal(context.EQV2.factoryId,'factory-1');
  assert.equal(context.EQV2.categoryId,'cat-1');
  assert.equal(context.EQV2.treeScroll,246);
  assert.equal(context.EQV2.open.has('factory-1'),true);
  assert.equal(context.EQV2.open.has('area-1'),true);
});

test('detail page preserves all previous tabs and requested maintenance layers',async()=>{
  const {context,content}=harness();
  await context.eqv2OpenDetail('eq-1');
  const labels=['شناسنامه تجهیز','ساختار / Components','برنامه نگهداری و تعمیرات','چک‌لیست‌ها و بازرسی‌ها','درخواست‌های تعمیر','Work Orders','سوابق تعمیرات','سوابق خرابی','PM History','قطعات یدکی مصرف‌شده','هزینه‌های تعمیرات','توقفات تجهیز','شاخص‌های قابلیت اطمینان','مستندات و فایل‌ها','ریسک‌ها','RCA / تحلیل خرابی','سایر / سابقه تغییرات'];
  labels.forEach(label=>assert.ok(content.innerHTML.includes(label),label));
  assert.match(content.innerHTML,/eqv2-breadcrumb/);
});

test('capture-phase delegated double click opens draggable Tree nodes reliably',async()=>{
  const {context,content,listeners}=harness();
  let prevented=false,stopped=false;
  listeners.dblclick({target:{closest:()=>({dataset:{equipmentDetail:'eq-1'}})},preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(prevented,true);assert.equal(stopped,true);
  assert.match(content.innerHTML,/پمپ تست/);
  assert.equal(context.location.pathname,'/equipment/EQ-1');
});
