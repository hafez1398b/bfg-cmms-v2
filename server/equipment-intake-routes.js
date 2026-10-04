'use strict';

const express = require('express');
const { validateImportFile, MAX_BYTES } = require('./import-file-policy');
const intake = require('./equipment-intake');

function readBody(req, max) {
  const declared = Number(req.get('content-length') || 0);
  if (declared > max) return Promise.reject(Object.assign(new Error('FILE_TOO_LARGE'), { status: 413, code: 'FILE_TOO_LARGE' }));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    const fail = error => { if (!failed) { failed = true; reject(error); } };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > max) {
        fail(Object.assign(new Error('FILE_TOO_LARGE'), { status: 413, code: 'FILE_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', fail);
  });
}

function sendError(res, error) {
  const status = error && error.status && error.status < 500 ? error.status : 500;
  if (status >= 500) console.error('equipment intake', error && error.code ? error.code : 'db_error');
  res.status(status).json({ error: status < 500 ? (error.code || 'REQUEST_FAILED') : 'EQUIPMENT_INTAKE_FAILED' });
}

function createEquipmentIntakeRouter({ pool, registry }) {
  const router = express.Router();

  router.get('/sessions', async (req, res) => {
    try { res.json(await intake.listSessions(pool, req.user)); }
    catch (error) { sendError(res, error); }
  });

  router.get('/sessions/:id', async (req, res) => {
    try { res.json({ data: await intake.sessionMessages(pool, req.user, req.params.id) }); }
    catch (error) { sendError(res, error); }
  });

  router.post('/analyze', async (req, res) => {
    try {
      const body = req.body || {};
      const text = String(body.text || '').trim().slice(0, 4000);
      if (!text) return res.status(422).json({ error: 'INTAKE_TEXT_REQUIRED' });
      const history = Array.isArray(body.history) ? body.history.slice(-8).map(turn => ({
        role: turn && turn.role === 'assistant' ? 'assistant' : 'user',
        body: String(turn && turn.body || '').slice(0, 2000)
      })) : [];
      res.status(201).json({ data: await intake.prepareIntake({
        pool,
        registry,
        user: req.user,
        caption: text,
        equipmentId: body.equipmentId || null,
        sessionId: body.sessionId || null,
        history
      }) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/files', async (req, res) => {
    try {
      const buffer = await readBody(req, MAX_BYTES);
      const file = validateImportFile({ name: req.get('x-file-name') || '', buffer });
      const caption = String(req.query.caption || '').trim().slice(0, 4000);
      res.status(201).json({ data: await intake.prepareIntake({
        pool,
        registry,
        user: req.user,
        caption,
        file,
        equipmentId: req.query.equipmentId || null,
        sessionId: req.query.sessionId || null,
        history: []
      }) });
    } catch (error) { sendError(res, error); }
  });

  return router;
}

module.exports = { createEquipmentIntakeRouter };
