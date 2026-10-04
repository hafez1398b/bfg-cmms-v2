'use strict';

const express = require('express');
const catalog = require('./module-catalog');
const release = require('./release-info');

function sendError(res, error, fallback) {
  const status = error && error.status && error.status < 500 ? error.status : 500;
  if (status >= 500) console.error(fallback, error && error.code ? error.code : 'db_error');
  res.status(status).json({ error: status < 500 ? (error.code || 'REQUEST_FAILED') : fallback });
}

function createModuleRouter({ pool, sessions, service }) {
  const router = express.Router();
  router.use(async (req, res, next) => {
    try {
      req.user = req.user || await sessions.authenticate(req);
      next();
    } catch (error) {
      sendError(res, error, 'AUTHENTICATION_UNAVAILABLE');
    }
  });

  router.get('/', async (req, res) => {
    try {
      res.json({
        appVersion: release.APP_VERSION,
        apiVersion: release.API_VERSION,
        minClientVersion: release.MIN_CLIENT_VERSION,
        data: await service.list(pool)
      });
    } catch (error) {
      sendError(res, error, 'MODULE_LIST_FAILED');
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      res.json({ data: await service.setEnabled(pool, req.user, req.params.id, req.body || {}) });
    } catch (error) {
      sendError(res, error, 'MODULE_UPDATE_FAILED');
    }
  });

  function rejectPublish(_req, res) {
    res.status(405).json({ error: 'MODULE_PUBLISH_REQUIRES_SIGNED_RELEASE' });
  }
  router.post('/', rejectPublish);
  router.put('/', rejectPublish);
  router.post('/:id', rejectPublish);

  return router;
}

function createModuleGate({ pool, sessions, service }) {
  return async function moduleGate(req, res, next) {
    const moduleIds = catalog.modulesForRequest(req);
    if (!moduleIds.length) return next();
    try {
      req.user = req.user || await sessions.authenticate(req);
      for (const moduleId of moduleIds) {
        if (!(await service.isEnabled(pool, moduleId))) {
          return res.status(403).json({ error: 'MODULE_DISABLED', module: moduleId });
        }
      }
      return next();
    } catch (error) {
      return sendError(res, error, 'MODULE_CHECK_FAILED');
    }
  };
}

module.exports = { createModuleRouter, createModuleGate };
