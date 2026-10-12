'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../public/equipment-v2/structure-drawer-controller');

const equipment = { id: 'eq-1', nodeKind: 'equipment', rowVersion: 7 };
const subsystem = { id: 'sub-1', nodeKind: 'subsystem', rowVersion: 4 };
const component = { id: 'component-1', nodeKind: 'main-component', rowVersion: 2 };

test('each structure type has a separate form contract and enforces its parent kind', () => {
  assert.ok(contract.formFields('subsystem').some(field => field.id === 'manufacturer'));
  assert.ok(contract.formFields('main-component').some(field => field.id === 'inventoryItemId'));
  assert.ok(contract.formFields('sub-component').some(field => field.id === 'requiredQuantity'));
  assert.equal(contract.isValidParent('subsystem', equipment), true);
  assert.equal(contract.isValidParent('subsystem', subsystem), false);
  assert.equal(contract.isValidParent('main-component', subsystem), true);
  assert.equal(contract.isValidParent('main-component', component), false);
  assert.equal(contract.isValidParent('sub-component', component), true);
  assert.equal(contract.isValidParent('sub-component', { ...component, archived: true }), false);
  assert.deepEqual(contract.validate('main-component', { name: 'bearing', code: '', status: 'active' }), ['code']);
  assert.deepEqual(contract.validate('sub-component', { name: 'washer', status: '' }), ['status']);
});

test('create payload uses the selected parent, current row version, root id, and stable retry key', () => {
  const requestId = 'client-request-123';
  const payload = contract.createPayload({
    rootEquipmentId: 'eq-1', parent: subsystem, kind: 'main-component', requestId,
    values: { name: 'Pump bearing', code: 'BRG-1', status: 'active', requiredQuantity: '2.5', inventoryItemId: '' }
  });
  assert.equal(payload.rootEquipmentId, 'eq-1');
  assert.equal(payload.parentId, 'sub-1');
  assert.equal(payload.parentRowVersion, 4);
  assert.equal(payload.requestId, requestId);
  assert.equal(payload.requiredQuantity, 2.5);
  assert.equal(payload.inventoryItemId, null);
  assert.throws(() => contract.createPayload({ rootEquipmentId: 'eq-1', parent: component, kind: 'main-component', requestId, values: { name: 'bad', code: 'x', status: 'active' } }), { code: 'STRUCTURE_PARENT_KIND_INVALID' });
  assert.throws(() => contract.createPayload({ rootEquipmentId: 'eq-1', parent: subsystem, kind: 'main-component', values: { name: 'bad', code: 'x', status: 'active' } }), { code: 'IDEMPOTENCY_KEY_REQUIRED' });
});

test('edit payload is row-versioned and cannot change the node kind', () => {
  const payload = contract.updatePayload({
    rootEquipmentId: 'eq-1', node: { ...component, code: 'CMP-1' }, kind: 'main-component',
    values: { name: 'Updated bearing', code: 'CMP-2', status: 'active' }
  });
  assert.equal(payload.rootEquipmentId, 'eq-1');
  assert.equal(payload.nodeKind, 'main-component');
  assert.equal(payload.rowVersion, 2);
  assert.throws(() => contract.updatePayload({ node: component, kind: 'sub-component', values: {} }), { code: 'STRUCTURE_NODE_KIND_INVALID' });
});

test('discard confirmation preserves an edited drawer when the user declines', async () => {
  let confirms = 0;
  const drawer = contract.create({ confirmDiscard: async () => { confirms += 1; return false; } });
  drawer.open({ mode: 'create', kind: 'subsystem', parent: equipment, values: { name: '', status: 'active' } });
  drawer.setValues({ name: 'Subsystem', status: 'active' });
  assert.equal(drawer.state.dirty, true);
  assert.equal(await drawer.close('escape'), false);
  assert.equal(confirms, 1);
  assert.equal(drawer.state.open, true);
  assert.equal(drawer.state.values.name, 'Subsystem');
});

test('structure create is single-flight and accepts only a committed 201 response', async () => {
  let release;
  let calls = 0;
  const drawer = contract.create();
  drawer.open({ mode: 'create', kind: 'subsystem', parent: equipment, values: { name: 'Subsystem', status: 'active' } });
  const submitArgs = {
    payload: { name: 'Subsystem' }, expectedStatus: 201,
    save: () => { calls += 1; return new Promise(resolve => { release = resolve; }); }
  };
  const pending = drawer.submit(submitArgs);
  assert.equal(await drawer.submit(submitArgs), false);
  assert.equal(calls, 1);
  release({ httpStatus: 201, committed: true, data: { id: 'sub-2' } });
  assert.equal(await pending, true);
  assert.equal(drawer.state.open, false);

  const failed = contract.create();
  failed.open({ mode: 'create', kind: 'subsystem', parent: equipment, values: { name: 'Keep me', status: 'active' } });
  assert.equal(await failed.submit({ payload: {}, expectedStatus: 201, save: async () => ({ httpStatus: 200, committed: true, data: { id: 'wrong-status' } }) }), false);
  assert.equal(failed.state.open, true);
  assert.equal(failed.state.saving, false);
  assert.equal(failed.state.values.name, 'Keep me');
  assert.equal(failed.state.error.code, 'UNEXPECTED_RESPONSE_STATUS');
});

test('edit drawers require an HTTP 200 commit and do not claim success without data', async () => {
  const drawer = contract.create();
  drawer.open({ mode: 'edit', kind: 'main-component', node: component, values: { name: 'Main', code: 'C-1', status: 'active' } });
  assert.equal(await drawer.submit({ expectedStatus: 200, save: async () => ({ httpStatus: 200, committed: true, data: { id: component.id } }) }), true);
  const notCommitted = contract.create();
  notCommitted.open({ mode: 'edit', kind: 'main-component', node: component, values: { name: 'Main', code: 'C-1', status: 'active' } });
  assert.equal(await notCommitted.submit({ expectedStatus: 200, save: async () => ({ httpStatus: 200, committed: false, data: { id: component.id } }) }), false);
  assert.equal(notCommitted.state.open, true);
  assert.equal(notCommitted.state.error.code, 'NOT_COMMITTED');
});
