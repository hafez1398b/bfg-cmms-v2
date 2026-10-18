'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const stepWizard = require('../public/platform-v2/step-wizard');
const equipmentAdapter = require('../public/platform-v2/equipment-wizard-adapter');

class WizardRoot {
  constructor() {
    this.ownerDocument = {};
    this.listeners = new Map();
    this.added = [];
    this.removed = [];
    this.innerHTML = '';
  }
  addEventListener(type, listener) {
    this.added.push(type);
    const handlers = this.listeners.get(type) || [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }
  removeEventListener(type, listener) {
    this.removed.push(type);
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener));
  }
  contains() { return true; }
  querySelector() { return null; }
  replaceChildren() { this.innerHTML = ''; }
  dispatch(type, target) {
    for (const listener of [...(this.listeners.get(type) || [])]) listener({ type, target, preventDefault() {} });
  }
}

function action(name) {
  return {
    dataset: { swAction: name },
    closest(selector) { return selector === '[data-sw-action]' ? this : null; },
    matches() { return false; }
  };
}
function field(key, value) {
  return {
    dataset: { swField: key }, tagName: 'INPUT', type: 'text', value,
    closest(selector) { return selector === '[data-sw-field]' ? this : null; },
    matches() { return false; }
  };
}
function confirmation(checked) {
  return {
    checked,
    closest() { return null; },
    matches(selector) { return selector === '[data-sw-confirm]'; }
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

async function reachReview(root, instance) {
  root.dispatch('input', field('name', 'پمپ تست'));
  await settle();
  root.dispatch('click', action('next'));
  await settle();
  root.dispatch('click', action('next'));
  await settle();
  assert.equal(instance.getCurrentStep().kind, 'review');
  root.dispatch('change', confirmation(true));
  await settle();
}

test('regression: final wizard stage stays on review instead of restarting at step one', async () => {
  const root = new WizardRoot();
  const instance = stepWizard.create({
    root,
    focusOnRender: false,
    steps: [
      { id: 'name', kind: 'text', title: 'نام', required: true },
      { id: 'extra', kind: 'group', title: 'جزئیات', fields: [] }
    ]
  });
  await reachReview(root, instance);
  assert.equal(instance.getCurrentStep().id, '__review__');
  instance.destroy();
});

test('structure kinds use independent drawers and never share the multi-stage wizard loop', () => {
  const ui = read('public/equipment-v2/equipment-v2.js');
  assert.doesNotMatch(ui, /function structureWizardSteps\s*\(/,
    'the previous four-stage structureWizardSteps sequencer must be removed');
  assert.doesNotMatch(ui, /function openStructureWizard\s*\(/,
    'structure create/edit must not mount the shared StepWizard');
  assert.match(ui, /eqv2-structure-drawer/);
  assert.match(ui, /افزودن زیرسیستم/);
  assert.match(ui, /افزودن قطعه اصلی/);
  assert.match(ui, /افزودن زیرقطعه/);
});

test('structure controller loads before the dossier and the equipment adapter forwards cancel and error callbacks', async () => {
  const html = read('public/index.html');
  const controllerIndex = html.indexOf('/equipment-v2/structure-drawer-controller.js');
  const equipmentIndex = html.indexOf('/equipment-v2/equipment-v2.js');
  assert.ok(controllerIndex >= 0 && controllerIndex < equipmentIndex, 'the drawer contract must exist before equipment-v2.js initializes');
  let engineOptions;
  const canceled = [];
  const adapterResult = equipmentAdapter.create({
    root: {},
    engine: { create(options) { engineOptions = options; return { id: 'wizard' }; } },
    contract: { resource: 'equipment', version: 1, steps: [{ id: 'asset', kind: 'text' }] },
    persistDraft: async () => {}, submit: async () => {},
    onCancel: async payload => { canceled.push(payload); },
    onSubmitError: error => { canceled.push(error); }
  });
  assert.equal(adapterResult.id, 'wizard');
  await engineOptions.onCancel({ reason: 'escape', state: { dirty: true } });
  assert.equal(canceled[0].resource, 'equipment');
  assert.equal(canceled[0].contractVersion, 1);
  assert.equal(canceled[0].reason, 'escape');
  const saveError = new Error('save failed');
  engineOptions.onSubmitError(saveError);
  assert.equal(canceled[1], saveError);
});

test('equipment metadata wizard no longer submits structure children as a side effect', () => {
  const ui = read('public/equipment-v2/equipment-v2.js');
  assert.doesNotMatch(ui, /newChildParent|newChildKind|newChildName|newChildCode/);
  assert.match(ui, /onCancel:async\(\{state\}\)=>/);
  assert.match(ui, /state\.dirty&&!window\.confirm/);
});

test('regression: two submit clicks during pending confirmation result in one backend POST', async () => {
  const root = new WizardRoot();
  let release;
  let confirmationPromise;
  let confirmCalls = 0;
  let posts = 0;
  const instance = stepWizard.create({
    root,
    focusOnRender: false,
    steps: [
      { id: 'name', kind: 'text', title: 'نام', required: true },
      { id: 'extra', kind: 'group', title: 'جزئیات', fields: [] }
    ],
    confirmSubmit: () => {
      confirmCalls += 1;
      if (!confirmationPromise) confirmationPromise = new Promise(resolve => { release = resolve; });
      return confirmationPromise;
    },
    onSubmit: async () => { posts += 1; }
  });
  await reachReview(root, instance);

  root.dispatch('click', action('submit'));
  root.dispatch('click', action('submit'));
  await settle();
  release(true);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(posts, 1, 'a single confirmed submission must not issue duplicate POST requests');
  instance.destroy();
});
