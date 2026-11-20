'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const page=html.slice(html.indexOf('function pgWOs(){'),html.indexOf('function openWOForm()'));

test('work orders use one selectable table view without Kanban switching',()=>{
  assert.match(page,/class="tbl-wrap wo-table-wrap"/);
  assert.match(page,/class="wo-table"/);
  assert.match(page,/onclick="openWO/);
  assert.match(page,/onkeydown="if\(event\.key==='Enter'/);
  assert.match(page,/woStatusFilter/);
  assert.match(page,/woPriorityFilter/);
  assert.doesNotMatch(page,/kanban|kb-card|woView|dropWO/);
});

test('optional legacy drop hook cannot stop runtime when Kanban dropWO is absent',()=>{
  const marker='/* also attach when assigning a vehicle WO via the optional legacy drag flow */';
  const start=html.indexOf('(function(){',html.indexOf(marker));
  const end=html.indexOf('})();',start)+5;
  assert.ok(start>0&&end>start,'vehicle drop hook must be present');
  const hook=html.slice(start,end);
  assert.match(hook,/if\(typeof window\.dropWO!==['"]function['"]\)return/);
  assert.doesNotMatch(hook,/const chain=dropWO/);
  assert.doesNotThrow(()=>vm.runInNewContext(hook,{window:{}}));
});
