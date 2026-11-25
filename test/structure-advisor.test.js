'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readAttachment, normalizeSuggestions } = require('../server/structure-advisor');
const { formFields, validate, cleanValues } = require('../public/equipment-v2/structure-drawer-controller');

test('structure advisor separates extracted text, image input and unreadable documents', () => {
  const text = Buffer.from('نقشه هیدرولیک').toString('base64');
  assert.equal(readAttachment({ name: 'map.txt', base64: text }).text, 'نقشه هیدرولیک');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=';
  assert.deepEqual(readAttachment({ name: 'plate.PNG', base64: png }).media, [
    { kind: 'image', mimeType: 'image/png', data: png }
  ]);
  assert.throws(() => readAttachment({ name: 'plate.png', base64: text }), { code: 'STRUCTURE_ADVISOR_ATTACHMENT_INVALID' });
  assert.equal(
    readAttachment({ name: 'scan.pdf', base64: Buffer.from('%PDF-1.7\n%%EOF').toString('base64') }).notice,
    'STRUCTURE_ADVISOR_NO_TEXT'
  );
});

test('provider output is limited to editable fields for the selected structure level', () => {
  const fields = formFields('sub-component');
  const [suggestion] = normalizeSuggestions({ suggestions: [
    { fields: { name: 'یاتاقان', serial: 'S-42', status: 'made-up', requiredQuantity: 2,
      rootEquipmentId: 'other-equipment', parentId: 'other-parent', inventoryItemId: 'provider-id', addCriticalSpare: true } }
  ] }, fields);
  assert.deepEqual(suggestion.fields, { name: 'یاتاقان', serial: 'S-42', requiredQuantity: 2 });
});

test('critical spare selection requires a real inventory selection and belongs only to part forms', () => {
  const values = { name: 'شفت', status: 'active', addCriticalSpare: true };
  assert.deepEqual(validate('sub-component', values), ['inventoryItemId']);
  assert.equal(cleanValues('subsystem', { ...values, inventoryItemId: 'item1' }).addCriticalSpare, undefined);
  assert.equal(cleanValues('sub-component', { ...values, inventoryItemId: 'item1' }).addCriticalSpare, true);
  assert.equal(cleanValues('sub-component', { ...values, addCriticalSpare: false }).addCriticalSpare, undefined);
});
