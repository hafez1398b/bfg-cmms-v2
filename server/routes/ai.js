'use strict';

const express = require('express');
const { v4: uuid } = require('uuid');
const { askAI, diagnoseFailure, predictFailure } = require('../services/ai-service');
const { recordAudit } = require('../services/audit-service');

function createAIRouter({ pool, realtime, authenticateToken }) {
  const router = express.Router();
  router.use(authenticateToken);

  const canUse = (user) => ['admin','mgr','planner','tech'].includes(user.role);
  const canApprove = (user) => ['admin','mgr','planner'].includes(user.role);

  // Main ask endpoint — powers chat, wizard suggestions, diagnosis (Requirements #7,8,9)
  router.post('/ask', async (req, res, next) => {
    try {
      if (!canUse(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const { question, assetId, imageDataUrl, history } = req.body;
      const result = await askAI(pool, { question, assetId, userId: req.user.id, imageDataUrl, history: history || [] });
      await recordAudit(pool, { actor: req.user, action: 'view', mod: 'ai', entity: 'ai_ask', entityId: assetId || 'general', note: question?.slice(0,120), after: { online: result.online, model: result.model }, req });
      // Log to ai_recommendations if suggestions present
      if (result.recommendations?.length) {
        for (const r of result.recommendations) {
          try {
            await pool.query(
              `INSERT INTO ai_recommendations(id, kind, entity, entity_id, asset_id, title, reason, evidence, confidence, source, context, status, meta)
               VALUES($1,'general','ai_chat',$2,$3,$4,$5,$6,$7,$8,$9,'ai_suggested',$10)`,
              [uuid(), assetId || req.user.id, assetId || null, r.recommendation.slice(0,200), r.reason, JSON.stringify(r.evidence||[]), r.confidence, r.source, JSON.stringify({ question }), JSON.stringify({ online: result.online })]
            );
          } catch (_) {}
        }
      }
      res.json(result);
    } catch (e) { next(e); }
  });

  // Diagnosis for a failure (Requirement #11)
  router.post('/diagnose/:failureId', async (req, res, next) => {
    try {
      if (!canUse(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const result = await diagnoseFailure(pool, req.params.failureId, req.user.id);
      // Persist as recommendation
      const id = uuid();
      await pool.query(
        `INSERT INTO ai_recommendations(id, kind, entity, entity_id, asset_id, title, reason, evidence, confidence, source, context, status, meta)
         VALUES($1,'diagnosis','failures',$2,(SELECT asset_id FROM failures WHERE id=$2),$3,$4,$5,$6,$7,$8,'ai_suggested',$9)`,
        [id, req.params.failureId, `تشخیص هوشمند خرابی ${req.params.failureId}`, result.text.slice(0,500), JSON.stringify([]), 65, 'ai_diagnosis', JSON.stringify({ failureId: req.params.failureId }), JSON.stringify({ online: result.online })]
      );
      await recordAudit(pool, { actor: req.user, action: 'create', mod: 'ai', entity: 'ai_diagnosis', entityId: id, after: { failureId: req.params.failureId }, req });
      res.json({ ...result, recommendationId: id });
    } catch (e) { next(e); }
  });

  // Prediction (Requirement #15)
  router.post('/predict/:assetId', async (req, res, next) => {
    try {
      if (!canUse(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const result = await predictFailure(pool, req.params.assetId, req.user.id);
      const id = uuid();
      await pool.query(
        `INSERT INTO ai_recommendations(id, kind, entity, entity_id, asset_id, title, reason, evidence, confidence, source, context, status, meta)
         VALUES($1,'prediction','assets',$2,$2,$3,$4,$5,$6,$7,'ai_predicted',$8)`,
        [id, req.params.assetId, `پیش‌بینی خرابی — ${req.params.assetId}`, result.text.slice(0,500), JSON.stringify([]), 60, 'ai_prediction', JSON.stringify({ assetId: req.params.assetId }), JSON.stringify({ online: result.online })]
      );
      res.json({ ...result, recommendationId: id, provenance: 'ai_predicted' });
    } catch (e) { next(e); }
  });

  // Wizard contextual suggestions (Requirement #8) — returns options for next step
  router.post('/suggest', async (req, res, next) => {
    try {
      if (!canUse(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const { wizard, step, context } = req.body; // wizard: maintenance_request | work_order | pm | ...
      const assetId = context?.assetId || context?.equipmentId;
      let question = '';
      if (wizard === 'maintenance_request') {
        if (step === 2) question = `برای تجهیز ${assetId || 'نامشخص'}، مشکلات محتمل را بر اساس سوابق خرابی و PM پیشنهاد بده. هر گزینه باید recommendation/reason/evidence/confidence داشته باشد.`;
        else if (step === 3) question = `شدت خرابی برای تجهیز ${assetId} را بر اساس سوابق مشابه برآورد کن.`;
        else question = `برای مرحله ${step} از ویزارد درخواست تعمیر، گزینه‌های مناسب را برای تجهیز ${assetId} پیشنهاد بده.`;
      } else {
        question = `برای ویزارد ${wizard} مرحله ${step} گزینه‌های مناسب را بر اساس Context زیر پیشنهاد بده: ${JSON.stringify(context||{}).slice(0,800)}`;
      }
      const result = await askAI(pool, { question, assetId, userId: req.user.id });
      // Format for wizard UI: options array
      const options = (result.recommendations || []).map(r => ({
        label: r.recommendation, value: r.recommendation, reason: r.reason, evidence: r.evidence, confidence: r.confidence, source: r.source, status: r.status,
      }));
      // Always include manual entry
      options.push({ label: 'سایر / ورود دستی', value: '__manual__', reason: 'ورود دلخواه کاربر', confidence: null, source: 'user', status: 'verified' });
      res.json({ text: result.text, online: result.online, options, context: result.context });
    } catch (e) { next(e); }
  });

  // List & review recommendations (Requirement #9,13)
  router.get('/recommendations', async (req, res, next) => {
    try {
      if (!canUse(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const { status, kind, assetId, limit = 50, offset = 0 } = req.query;
      const where = [];
      const vals = [];
      const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
      if (status) add('status = ?', status);
      if (kind) add('kind = ?', kind);
      if (assetId) add('asset_id = ?', assetId);
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      vals.push(parseInt(limit,10), parseInt(offset,10));
      const { rows } = await pool.query(`SELECT * FROM ai_recommendations ${w} ORDER BY created_at DESC LIMIT $${vals.length-1} OFFSET $${vals.length}`, vals);
      const count = await pool.query(`SELECT count(*)::int total FROM ai_recommendations ${w}`, vals.slice(0,-2));
      res.json({ data: rows, total: count.rows[0].total });
    } catch (e) { next(e); }
  });

  router.patch('/recommendations/:id', async (req, res, next) => {
    try {
      const { status, note } = req.body;
      const allowed = ['pending_approval','approved','rejected','applied','verified'];
      if (status && !allowed.includes(status)) return res.status(422).json({ error: 'VALIDATION_ERROR', fields: ['status'] });
      // Only manager+ can approve/reject sensitive
      if (['approved','rejected'].includes(status) && !canApprove(req.user)) return res.status(403).json({ error: 'PERMISSION_DENIED' });
      const { rows: [cur] } = await pool.query(`SELECT * FROM ai_recommendations WHERE id=$1`, [req.params.id]);
      if (!cur) return res.status(404).json({ error: 'NOT_FOUND' });
      const { rows: [upd] } = await pool.query(
        `UPDATE ai_recommendations SET status=$2, reviewed_by=$3, reviewed_at=now(), meta = meta || $4::jsonb WHERE id=$1 RETURNING *`,
        [req.params.id, status || cur.status, req.user.id, JSON.stringify({ reviewNote: note || '' })]
      );
      await recordAudit(pool, { actor: req.user, action: 'edit', mod: 'ai', entity: 'ai_recommendations', entityId: req.params.id, before: cur, after: upd, req });
      if (realtime) realtime.aiEvent('recommendation', { id: req.params.id, status }, { users: [cur.reviewed_by].filter(Boolean) });
      // If approved and kind is repair → optionally create WO (caller decides, we just flag)
      res.json({ data: upd });
    } catch (e) { next(e); }
  });

  // Diagnostics: AI pipeline health
  router.get('/_debug/status', async (req, res) => {
    const { config } = require('../config');
    res.json({
      provider: config.ai.provider,
      model: config.ai.model,
      endpoint: config.ai.endpoint.replace(/\/\/.*@/, '//***@'),
      hasKey: !!config.ai.apiKey,
      enabled: config.ai.enabled,
      timeoutMs: config.ai.timeoutMs,
      tableExists: await pool.query(`SELECT to_regclass('public.ai_recommendations') AS t`).then(r=>!!r.rows[0].t).catch(()=>false),
    });
  });

  return router;
}

module.exports = { createAIRouter };
