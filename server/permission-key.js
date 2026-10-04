'use strict';

function renamedPermission(permission) {
  if (permission === 'tree') return 'equipment';
  if (typeof permission === 'string' && permission.startsWith('tree.')) return `equipment.${permission.slice(5)}`;
  return permission;
}

function isTreePermission(permission) {
  return permission === 'tree' || (typeof permission === 'string' && permission.startsWith('tree.'));
}

function mergeGrant(existing, incoming) {
  if (typeof existing !== 'boolean') return incoming;
  if (typeof incoming !== 'boolean') return existing;
  return existing || incoming;
}

function migrateMatrix(matrix) {
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) return { matrix, changed: false };
  const next = {};
  let changed = false;
  for (const [id, row] of Object.entries(matrix)) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !row.tree) {
      next[id] = row;
      continue;
    }
    const equipment = { ...(row.equipment && typeof row.equipment === 'object' ? row.equipment : {}) };
    for (const [operation, value] of Object.entries(row.tree)) equipment[operation] = mergeGrant(equipment[operation], value);
    const copy = { ...row, equipment };
    delete copy.tree;
    next[id] = copy;
    changed = true;
  }
  return { matrix: next, changed };
}

function migratePermissionRows(rows) {
  const kept = [];
  const index = new Map();
  for (const row of rows || []) {
    if (isTreePermission(row.permission)) continue;
    const key = `${row.role}\0${row.permission}`;
    index.set(key, row);
    kept.push({ ...row });
  }
  for (const row of rows || []) {
    if (!isTreePermission(row.permission)) continue;
    const permission = renamedPermission(row.permission);
    const key = `${row.role}\0${permission}`;
    const existing = index.get(key);
    if (!existing) {
      const created = { ...row, permission };
      index.set(key, created);
      kept.push(created);
      continue;
    }
    existing.granted = !!(existing.granted || row.granted);
  }
  return kept;
}

module.exports = { renamedPermission, isTreePermission, migrateMatrix, migratePermissionRows };
