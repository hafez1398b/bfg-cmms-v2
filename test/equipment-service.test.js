'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {canEquipment,listParams,cleanPatch,validateCreate}=require('../server/equipment-service');
test('server RBAC denies equipment mutation to technicians and operators',()=>{assert.equal(canEquipment({role:'tech'},'edit'),false);assert.equal(canEquipment({role:'op'},'move'),false);assert.equal(canEquipment({role:'mgr'},'move'),true);assert.equal(canEquipment({role:'admin'},'delete'),true);});
test('list query is bounded and sort is allow-listed',()=>{const p=listParams({limit:'9999',page:'-2',sort:'a;drop table assets',direction:'DESC',q:'x'.repeat(300)});assert.equal(p.limit,200);assert.equal(p.page,1);assert.equal(p.sort,'a.sort_order');assert.equal(p.direction,'DESC');assert.equal(p.q.length,120);});
test('patch strips unknown and immutable fields',()=>{assert.deepEqual(cleanPatch({name:'Pump',parent:'bad',deleted_at:'bad',rowVersion:2,hours:8}),{name:'Pump',hours:8});});
test('create requires code, name and a known node kind',()=>{assert.deepEqual(validateCreate({}),['name','code','nodeKind']);assert.deepEqual(validateCreate({name:'P',code:'P-1',nodeKind:'equipment'}),[]);assert.deepEqual(validateCreate({name:'P',code:'P-1',nodeKind:'unknown'}),['nodeKind']);});
