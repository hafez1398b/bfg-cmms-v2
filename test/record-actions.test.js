'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('equipment dossier exposes cross-module creation, edit and archive actions',()=>{
  const equipment=read('public/equipment-v2/equipment-v2.js');
  for(const token of ["eqv2Related('wo'","eqv2Related('request'","eqv2Related('pm'",'eqv2Edit(','eqv2Delete('])assert.ok(equipment.includes(token),token);
  assert.match(equipment,/typeof openWO==='function'&&openWO/);
  assert.match(equipment,/typeof openReq==='function'&&openReq/);
  assert.match(equipment,/typeof openPM==='function'&&openPM/);
});

test('operational records provide permission-controlled edit and recoverable archive actions',()=>{
  const actions=read('public/platform-v2/record-actions.js');
  for(const fn of ['editRequestRecord','archiveRequestRecord','editWorkOrderRecord','removeWorkOrderRecord','editPMRecord','archivePMRecord','editInventoryRecord','archiveInventoryRecord','openEquipmentRelation'])assert.match(actions,new RegExp(`window\\.${fn}`),fn);
  assert.match(actions,/softDelete\('requests'/);
  assert.match(actions,/softDelete\('wos'/);
  assert.match(actions,/softDelete\('pms'/);
  assert.match(actions,/softDelete\('items'/);
  assert.doesNotMatch(actions,/\.splice\(/);
});

test('backend generic record deletion is audited soft archive with concurrency and RBAC',()=>{
  const server=read('server.js');
  const route=server.slice(server.indexOf("app.delete('/api/data/:collection/:id'"),server.indexOf('// SPA fallback'));
  assert.match(route,/hasPermission/);
  assert.match(route,/ARCHIVE_REASON_REQUIRED/);
  assert.match(route,/row_version=row_version\+1/);
  assert.match(route,/deleted_at=now\(\)/);
  assert.match(route,/INSERT INTO audit_x/);
  assert.doesNotMatch(route,/DELETE FROM/i);
});
