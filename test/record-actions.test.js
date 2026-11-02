'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('equipment dossier exposes cross-module creation, edit and archive actions',()=>{
  const equipment=read('public/equipment-v2/equipment-v2.js');
  for(const token of ["eqv2Related('wo'","eqv2Related('request'","eqv2Related('pm'",'window.eqv2Edit=edit','eqv2OpenWizard(','eqv2Delete('])assert.ok(equipment.includes(token),token);
  assert.match(equipment,/typeof openWO==='function'&&openWO/);
  assert.match(equipment,/typeof openReq==='function'&&openReq/);
  assert.match(equipment,/pm:\['openPMForm','pmAsset'\]/);
  assert.match(read('public/platform-v2/maintenance-client.js'),/\/api\/pm-plans/);
  assert.match(equipment,/BFGMaintenanceWizards\.openRequest/);
  assert.match(equipment,/BFGMaintenanceWizards\.openWorkOrder/);
  const wizards=read('public/platform-v2/maintenance-wizards.js');
  assert.match(wizards,/async function startWizard\(type,title,rt,selected,initialAnswers=\{\}\)/);
  assert.match(wizards,/prepareExisting\(rt,answers\)/);
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

test('backend generic mutations fail closed and equipment archive remains in its domain route',()=>{
  const server=read('server.js'),generic=read('server/generic-data.js'),equipment=read('server/equipment-routes.js');
  for(const method of ['post','put','delete'])assert.match(server,new RegExp(`app\\.${method}\\('\\/api\\/data\\/:collection`));
  assert.match(server,/genericData\.rejectWrite/);
  assert.doesNotMatch(generic,/INSERT INTO|UPDATE\s+[a-z_]+|DELETE FROM/i);
  assert.match(equipment,/ARCHIVE_REASON_REQUIRED/);
  assert.match(equipment,/row_version=row_version\+1/);
  assert.match(equipment,/deleted_at=now\(\)/);
  assert.match(equipment,/INSERT INTO audit_x/);
  assert.doesNotMatch(equipment,/DELETE FROM assets/i);
});
