'use strict';


// Persist new plan metadata in the existing plan extension; asset_id remains the dossier root.
const ACTIVITY_TYPES = new Set(['inspection', 'service', 'lubrication', 'adjustment', 'replacement',
  'functional-test', 'calibration', 'preventive-repair', 'condition-monitoring']);

function invalid(code) {
  return Object.assign(new Error(code), { status: 422, code });
}

function text(value, limit) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > limit) throw invalid('PM_ACTIVITY_FIELDS_INVALID');
  return value.trim() || null;
}

function integer(value, max) {
  if (value == null || value === '') return null;
  if (!Number.isInteger(value) || value < 1 || value > max) throw invalid('PM_ACTIVITY_FIELDS_INVALID');
  return value;
}

function lines(value) {
  if (!Array.isArray(value) || value.length > 100) throw invalid('PM_ACTIVITY_FIELDS_INVALID');
  return value.map(item => text(item, 500)).filter(Boolean);
}

function checklist(value) {
  if (!Array.isArray(value) || value.length > 100) throw invalid('PM_CHECKLIST_INVALID');
  return value.map(item => {
    if (typeof item === 'string') {
      const title = text(item, 500);
      if (!title) throw invalid('PM_CHECKLIST_INVALID');
      return title;
    }
    const title = text(item?.title || item?.text || item?.item, 500);
    if (!title || !['observation', 'number'].includes(item.measurementType || 'observation')) {
      throw invalid('PM_CHECKLIST_INVALID');
    }
    const measurementType = item.measurementType || 'observation';
    const checkpoint = { title, measurementType, description: text(item.description, 1200), unit: text(item.unit, 40) };
    if (item.photoRequired === true) checkpoint.photoRequired = true;
    if (measurementType === 'number') {
      for (const key of ['standard', 'min', 'max']) {
        const value = item[key];
        if (value != null && (typeof value !== 'number' || !Number.isFinite(value))) throw invalid('PM_CHECKLIST_INVALID');
        checkpoint[key] = value ?? null;
      }
      if (checkpoint.min != null && checkpoint.max != null && checkpoint.min > checkpoint.max) throw invalid('PM_CHECKLIST_INVALID');
    }
    return checkpoint;
  });
}

function checklistLabel(item) {
  return typeof item === 'string' ? item : (item?.title || item?.text || item?.item || '');
}

async function assertPlanTarget(client, assetId, nodeId) {
  if (!nodeId) return;
  const depth = await require('./equipment-structure').structureDepth(client, assetId, nodeId);
  if (depth == null || depth < 1 || depth > 3) throw invalid('PM_TARGET_OUTSIDE_DOSSIER');
}

async function activityFields(client, assetId, input, current = {}) {
  const fields = {};
  for (const [key, column, limit] of [['code','code',120], ['instructions','instructions',8000], ['requiredSkill','required_skill',240]]) {
    if (Object.hasOwn(input, key)) fields[column] = text(input[key], limit);
  }
  for (const [key, column, limit] of [['estimatedDurationMinutes','estimated_duration_minutes',100000], ['requiredPersonnel','required_personnel',1000]]) {
    if (Object.hasOwn(input, key)) fields[column] = integer(input[key], limit);
  }
  for (const [key, column] of [['requiredTools','required_tools'], ['safetyRequirements','safety_requirements']]) {
    if (Object.hasOwn(input, key)) fields[column] = JSON.stringify(lines(input[key]));
  }
  for (const [key, column] of [['lotoRequired','loto_required'], ['ptwRequired','ptw_required']]) {
    if (!Object.hasOwn(input, key)) continue;
    if (typeof input[key] !== 'boolean') throw invalid('PM_ACTIVITY_FIELDS_INVALID');
    fields[column] = input[key];
  }
  const previous = current.ext || {};
  const ext = { ...previous };
  if (Object.hasOwn(input, 'targetNodeId')) ext.targetNodeId = text(input.targetNodeId, 200);
  if (Object.hasOwn(input, 'activityGroup')) ext.activityGroup = text(input.activityGroup, 120);
  if (Object.hasOwn(input, 'activityType')) {
    ext.activityType = text(input.activityType, 50);
    if (ext.activityType && !ACTIVITY_TYPES.has(ext.activityType)) throw invalid('PM_ACTIVITY_FIELDS_INVALID');
  }
  if (Object.hasOwn(input, 'calendarFrequency')) {
    const value = text(input.calendarFrequency, 30);
    if (value && !['daily','weekly','monthly','quarterly','semiannual','annual','custom'].includes(value)) throw invalid('PM_ACTIVITY_FIELDS_INVALID');
    ext.calendarFrequency = value;
  }
  if (Object.hasOwn(input, 'productionStopRequired')) {
    if (typeof input.productionStopRequired !== 'boolean') throw invalid('PM_ACTIVITY_FIELDS_INVALID');
    ext.productionStopRequired = input.productionStopRequired;
  }
  if (ext.targetNodeId && (ext.targetNodeId !== previous.targetNodeId || assetId !== current.asset_id)) {
    await assertPlanTarget(client, assetId, ext.targetNodeId);
  }
  if (['targetNodeId','activityGroup','activityType','productionStopRequired','calendarFrequency'].some(key => Object.hasOwn(input, key))) {
    fields.ext = JSON.stringify(ext);
  }
  return fields;
}

const persianDate = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
  timeZone:'UTC', year:'numeric', month:'numeric', day:'numeric'
});
const calendarMonths = {monthly:1, quarterly:3, semiannual:6, annual:12};
function advancePersianMonths(value, months) {
  const dayMs = 86400000;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  const parts = time => Object.fromEntries(persianDate.formatToParts(time)
    .filter(part => ['year','month','day'].includes(part.type)).map(part => [part.type,Number(part.value)]));
  const start = parts(date);
  const target = start.year * 12 + start.month - 1 + months;
  // Work on UTC day boundaries while preserving the original time of day.
  const midnight = Math.floor(date / dayMs) * dayMs;
  let result = null;
  for (let delta = months * 30 - 8; delta <= months * 31 + 8; delta++) {
    const candidate = midnight + delta * dayMs;
    const current = parts(candidate);
    const month = current.year * 12 + current.month - 1;
    if (month > target) break;
    if (month === target) {
      result = candidate;
      if (current.day === start.day) break;
    }
  }
  return result == null ? null : new Date(result + date - midnight).toISOString();
}

function completionResults(template, results) {
  if (!Array.isArray(results) || results.length !== template.length) throw invalid('PM_CHECKLIST_RESULTS_REQUIRED');
  return template.map((checkpoint, index) => {
    const result = results[index];
    const status = result?.status;
    if (!['healthy','attention','defective','not_applicable'].includes(status)) throw invalid('PM_CHECKLIST_RESULTS_REQUIRED');
    const notes = text(result.notes, 1600);
    if (status !== 'healthy' && !notes) throw invalid('PM_CHECKLIST_RESULTS_REQUIRED');
    const value = result.value ?? null;
    if (checkpoint.measurementType === 'number' && status !== 'not_applicable') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid('PM_CHECKLIST_RESULTS_REQUIRED');
      if (status === 'healthy' && ((checkpoint.min != null && value < checkpoint.min) || (checkpoint.max != null && value > checkpoint.max))) {
        throw invalid('PM_CHECKLIST_MEASUREMENT_OUTSIDE_RANGE');
      }
    }
    const photoId = result.photoId || null;
    if ((checkpoint.photoRequired && status !== 'not_applicable' && !photoId)
      || (photoId && (typeof photoId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(photoId)))) {
      throw invalid('PM_CHECKLIST_PHOTO_REQUIRED');
    }
    return { status, notes, value: checkpoint.measurementType === 'number' && status !== 'not_applicable' ? value : null,
      ...(photoId ? { photoId } : {}) };
  });
}

module.exports = { advancePersianMonths, calendarMonths, activityFields, assertPlanTarget, checklist, checklistLabel, completionResults };
