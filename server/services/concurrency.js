'use strict';

/**
 * Optimistic concurrency helper — Requirement #1
 * Prevents silent overwrites when two users edit the same record simultaneously.
 */

function checkVersion(currentVersion, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null || expectedVersion === '') return; // allow legacy clients
  const cur = Number(currentVersion);
  const exp = Number(expectedVersion);
  if (!Number.isFinite(exp) || cur !== exp) {
    const e = new Error(`Version conflict — current version is ${cur}, you sent ${exp}. Please refresh and retry.`);
    e.status = 409;
    e.code = 'VERSION_CONFLICT';
    e.current = cur;
    throw e;
  }
}

/**
 * SQL helper to bump row_version and updated_at atomically
 */
function bumpClause() {
  return `row_version = row_version + 1, updated_at = now()`;
}

module.exports = { checkVersion, bumpClause };
