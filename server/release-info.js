'use strict';

const pkg = require('../package.json');

const APP_VERSION = pkg.version;
const API_VERSION = '5.0.0';
const MIN_CLIENT_VERSION = pkg.version;
const MIN_BACKEND_VERSION = pkg.version;

function parseSemver(value) {
  const parts = String(value || '').trim().split('.');
  if (!parts.length || parts.some(part => !/^\d+$/.test(part))) return null;
  return parts.map(part => Number(part));
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = a[index] || 0;
    const bv = b[index] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function assessCompatibility(clientVersion, release = {}) {
  const minClientVersion = release.minClientVersion || MIN_CLIENT_VERSION;
  const comparison = compareSemver(clientVersion, minClientVersion);
  const compatible = comparison !== null && comparison >= 0;
  return {
    compatible,
    reason: compatible ? null : 'CLIENT_UPDATE_REQUIRED',
    clientVersion: clientVersion ? String(clientVersion) : null,
    minClientVersion,
    appVersion: release.appVersion || APP_VERSION,
    apiVersion: release.apiVersion || API_VERSION
  };
}

module.exports = {
  APP_VERSION,
  API_VERSION,
  MIN_CLIENT_VERSION,
  MIN_BACKEND_VERSION,
  compareSemver,
  assessCompatibility
};
