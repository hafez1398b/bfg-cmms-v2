'use strict';

const { APP_VERSION, API_VERSION, MIN_CLIENT_VERSION } = require('./release-info');

const SERVER_ONLY = 'server-only';
const LOCAL_DEVELOPMENT = 'local-development';

function resolveRuntimeConfig(env = process.env) {
  const environment = env.NODE_ENV || 'development';
  const requested = String(env.EXECUTION_MODE || '').trim();
  const explicitLocal = requested === LOCAL_DEVELOPMENT
    && env.ALLOW_LOCAL_COMPATIBILITY === 'true'
    && environment !== 'production';
  const executionMode = explicitLocal ? LOCAL_DEVELOPMENT : SERVER_ONLY;
  return {
    environment,
    executionMode,
    allowLocalCompatibility: executionMode === LOCAL_DEVELOPMENT,
    backendAuth: true,
    backendAI: true,
    realtime: true,
    apiBasePath: '/api',
    appVersion: APP_VERSION,
    apiVersion: API_VERSION,
    minClientVersion: MIN_CLIENT_VERSION
  };
}

module.exports = { resolveRuntimeConfig, SERVER_ONLY, LOCAL_DEVELOPMENT };
