'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const css=fs.readFileSync(path.join(root,'public/design-system/enterprise-compact.css'),'utf8');

test('dashboard provides dependency-free radar and doughnut SVG charts',()=>{
  assert.match(html,/function radarChart\(labels,values,color=/);
  assert.match(html,/function pieChart\(segments,colors=/);
  assert.match(html,/وضعیت کلی کارخانه/);
  assert.match(html,/radarChart\(\['OEE','Availability','PM','ایمنی','انبار'\]/);
  assert.match(html,/pieChart\(equipmentStatus,equipmentColors\)/);
  assert.doesNotMatch(html,/chart\.js|new Chart\(/i);
});

test('dashboard uses compact responsive KPI and chart grids',()=>{
  assert.match(html,/class="dashboard-kpi-grid"/);
  assert.match(html,/class="dashboard-chart-grid"/);
  assert.match(css,/dashboard-kpi-grid\{[^}]*repeat\(6/);
  assert.match(css,/@media\(max-width:1600px\)\{\.dashboard-kpi-grid\{grid-template-columns:repeat\(5/);
  assert.match(css,/@media\(max-width:780px\)/);
  assert.match(css,/factory-overview-grid/);
});
