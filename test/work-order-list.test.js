'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
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
