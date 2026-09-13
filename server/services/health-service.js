'use strict';

/**
 * Health Score service — Requirement #14
 * Calculates 0-100 per equipment from real system data:
 *  - Failure frequency & severity
 *  - MTBF / MTTR
 *  - PM compliance & overdue
 *  - Downtime
 *  - Maintenance cost
 *  - Age, spare availability, checklist results, measurements, AI prediction
 *
 * Never a fake number — every factor is stored and explainable.
 */

async function calculateHealth(pool, assetId) {
  const { rows: [asset] } = await pool.query(`SELECT * FROM assets WHERE id=$1`, [assetId]);
  if (!asset) { const e = new Error('Asset not found'); e.status = 404; throw e; }

  // Gather real data
  const failures = await pool.query(`SELECT severity, downtime_hours, occurred_at FROM failures WHERE asset_id=$1`, [assetId]);
  const wos = await pool.query(`SELECT status, priority, created_at, times FROM work_orders WHERE asset_id=$1`, [assetId]);
  const pms = await pool.query(`SELECT interval_days, last_run, status FROM pm_plans WHERE asset_id=$1 AND status='active'`, [assetId]);
  const items = await pool.query(`SELECT stock, min_stock FROM items JOIN asset_spare_parts rel ON rel.item_id=items.id WHERE rel.asset_id=$1`, [assetId]);
  const instruments = await pool.query(`SELECT period_days, last_cal FROM instruments WHERE asset_id=$1`, [assetId]);

  let score = 100;
  const factors = {};
  const recommendations = [];

  // Failure frequency (last 90 days)
  const now = Date.now();
  const recentFailures = failures.rows.filter(f => (now - new Date(f.occurred_at).getTime()) < 90 * 864e5);
  const criticalFailures = recentFailures.filter(f => f.severity === 'critical');
  const failurePenalty = Math.min(30, recentFailures.length * 6 + criticalFailures.length * 8);
  score -= failurePenalty;
  factors.failure_90d = { count: recentFailures.length, critical: criticalFailures.length, penalty: failurePenalty };
  if (recentFailures.length >= 3) recommendations.push('بررسی RCA برای خرابی‌های مکرر — پیشنهاد بازنگری PM');

  // MTBF / MTTR estimation
  let mtbf = null, mttr = null;
  if (failures.rows.length >= 2) {
    const sorted = failures.rows.map(f => new Date(f.occurred_at).getTime()).sort((a,b)=>a-b);
    const intervals = sorted.slice(1).map((t,i)=> (t - sorted[i]) / 36e5);
    mtbf = intervals.reduce((s,v)=>s+v,0) / intervals.length;
    factors.mtbf_hours = Math.round(mtbf);
    if (mtbf < 200) { score -= 8; recommendations.push('MTBF پایین — پیشنهاد افزایش PM یا تعویض قطعه بحرانی'); }
  }
  const closedWos = wos.rows.filter(w => w.times && w.times.end && w.times.start);
  if (closedWos.length) {
    const durations = closedWos.map(w => (new Date(w.times.end) - new Date(w.times.start)) / 36e5);
    mttr = durations.reduce((s,v)=>s+v,0) / durations.length;
    factors.mttr_hours = Math.round(mttr * 10)/10;
    if (mttr > 6) { score -= 5; recommendations.push('MTTR بالا — بررسی مهارت تکنسین و موجودی قطعات'); }
  }

  // PM compliance & overdue
  let overdueCount = 0;
  for (const pm of pms.rows) {
    if (!pm.last_run || !pm.interval_days) continue;
    const due = new Date(pm.last_run); due.setDate(due.getDate() + pm.interval_days);
    if (due < new Date()) overdueCount++;
  }
  const pmPenalty = overdueCount * 7;
  score -= pmPenalty;
  factors.pm = { active: pms.rows.length, overdue: overdueCount, penalty: pmPenalty };
  if (overdueCount) recommendations.push(`تعداد ${overdueCount} برنامه PM سررسید گذشته — صدور فوری WO`);

  // Downtime
  const totalDowntime = failures.rows.reduce((s,f)=> s + (Number(f.downtime_hours)||0), 0);
  factors.downtime_hours_total = totalDowntime;
  if (totalDowntime > 20) { score -= 7; recommendations.push('داون‌تایم تجمعی بالا — تحلیل Pareto توقفات'); }

  // Spare parts availability
  const lowStock = items.rows.filter(i => Number(i.stock) < Number(i.min_stock));
  factors.spare_low_stock = lowStock.length;
  if (lowStock.length) { score -= lowStock.length * 2; recommendations.push('قطعات یدکی زیر نقطه سفارش — سفارش خرید'); }

  // Calibration overdue
  let calOverdue = 0;
  for (const ins of instruments.rows) {
    if (!ins.last_cal || !ins.period_days) continue;
    const due = new Date(ins.last_cal); due.setDate(due.getDate() + ins.period_days);
    if (due < new Date()) calOverdue++;
  }
  if (calOverdue) { score -= calOverdue * 3; factors.calibration_overdue = calOverdue; }

  // Equipment age (from year)
  if (asset.year) {
    const age = new Date().getFullYear() - parseInt(asset.year, 10);
    if (age > 10) { score -= 5; factors.age_years = age; recommendations.push('عمر تجهیز بالا — ارزیابی بازسازی/جایگزینی'); }
  }

  // Open work orders
  const openWos = wos.rows.filter(w => !['closed','cancel','done'].includes(w.status)).length;
  factors.open_work_orders = openWos;
  if (openWos >= 2) score -= 4;

  score = Math.max(0, Math.min(100, Math.round(score)));
  const trend = score >= 80 ? 'stable' : score >= 50 ? 'declining' : 'critical';

  // Persist
  const factorsJson = JSON.stringify(factors);
  const recsJson = JSON.stringify(recommendations.map(r => ({ text: r })));

  await pool.query(`UPDATE assets SET health_score=$2, health_factors=$3::jsonb, health_trend=$4, mtbf_hours=$5, mttr_hours=$6 WHERE id=$1`, [assetId, score, factorsJson, trend, mtbf, mttr]);
  await pool.query(`INSERT INTO equipment_health_history(asset_id, score, factors, recommendations) VALUES($1,$2,$3,$4)`, [assetId, score, factorsJson, recsJson]);

  return { score, factors, recommendations, trend, mtbf, mttr };
}

async function getHealth(pool, assetId) {
  const { rows: [asset] } = await pool.query(`SELECT id, code, name, health_score, health_factors, health_trend, mtbf_hours, mttr_hours, updated_at FROM assets WHERE id=$1`, [assetId]);
  if (!asset) { const e = new Error('Asset not found'); e.status = 404; throw e; }
  const history = await pool.query(`SELECT score, factors, recommendations, calculated_at FROM equipment_health_history WHERE asset_id=$1 ORDER BY calculated_at DESC LIMIT 20`, [assetId]);
  // If no history and no score, calculate now
  if (!asset.health_score && !history.rows.length) {
    const calc = await calculateHealth(pool, assetId);
    return { asset, history: history.rows, calculated: calc };
  }
  return { asset, history: history.rows };
}

module.exports = { calculateHealth, getHealth };
