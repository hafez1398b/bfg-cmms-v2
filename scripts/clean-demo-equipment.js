'use strict';

/** Remove only legacy/sample equipment data from PostgreSQL. Real/imported assets are preserved. */
const {Pool}=require('pg');
require('dotenv').config();
const pool=new Pool({connectionString:process.env.DATABASE_URL});

async function exists(client,table){const {rows}=await client.query('SELECT to_regclass($1) IS NOT NULL AS ok',[table]);return rows[0].ok;}
async function run(){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE cleanup_demo_assets(id TEXT PRIMARY KEY) ON COMMIT DROP`);
  await client.query(`
    WITH RECURSIVE demo_tree AS (
      SELECT id FROM assets
      WHERE id IN ('a5','a6','a7','a8','a9','a10','mf0','flt0')
         OR id LIKE 'mfc%' OR id LIKE 'mfk%' OR id LIKE 'mfl%' OR id LIKE 'veh%' OR id LIKE 'mfL%' OR id LIKE 'fltG%'
         OR code IN ('BFG-PU-L1-PRS01','BFG-PU-PNL001','BFG-UT-PNL002')
         OR history::text LIKE '%ایجاد نمونه ساختار توسط سیستم%'
      UNION ALL
      SELECT a.id FROM assets a JOIN demo_tree d ON a.parent=d.id
    ) INSERT INTO cleanup_demo_assets SELECT DISTINCT id FROM demo_tree ON CONFLICT DO NOTHING`);
  const assetCount=+(await client.query('SELECT count(*) n FROM cleanup_demo_assets')).rows[0].n;

  await client.query(`CREATE TEMP TABLE cleanup_demo_wos(id TEXT PRIMARY KEY,no TEXT) ON COMMIT DROP`);
  await client.query(`INSERT INTO cleanup_demo_wos
    SELECT id,no FROM work_orders WHERE asset_id IN (SELECT id FROM cleanup_demo_assets)
      OR id IN ('w1','w2','w3','w4','w5') OR id LIKE 'demo-w%'
      OR descr LIKE '%[داده نمونه]%' ON CONFLICT DO NOTHING`);
  const woCount=+(await client.query('SELECT count(*) n FROM cleanup_demo_wos')).rows[0].n;

  if(await exists(client,'work_order_assets'))await client.query('DELETE FROM work_order_assets WHERE work_order_id IN (SELECT id FROM cleanup_demo_wos) OR asset_id IN (SELECT id FROM cleanup_demo_assets)');
  if(await exists(client,'asset_positions'))await client.query('DELETE FROM asset_positions WHERE asset_id IN (SELECT id FROM cleanup_demo_assets)');
  if(await exists(client,'asset_spare_parts'))await client.query('DELETE FROM asset_spare_parts WHERE asset_id IN (SELECT id FROM cleanup_demo_assets)');
  if(await exists(client,'permits'))await client.query('DELETE FROM permits WHERE wo_id IN (SELECT id FROM cleanup_demo_wos) OR id IN (\'p1\',\'p2\')');
  if(await exists(client,'plan_events'))await client.query(`UPDATE plan_events SET asset_id=NULL WHERE asset_id IN (SELECT id FROM cleanup_demo_assets);
    UPDATE plan_events SET sub_asset_id=NULL WHERE sub_asset_id IN (SELECT id FROM cleanup_demo_assets);
    UPDATE plan_events SET wo_id=NULL WHERE wo_id IN (SELECT id FROM cleanup_demo_wos)`);
  if(await exists(client,'tool_loans'))await client.query(`UPDATE tool_loans SET asset_id=NULL WHERE asset_id IN (SELECT id FROM cleanup_demo_assets);
    UPDATE tool_loans SET wo_id=NULL WHERE wo_id IN (SELECT id FROM cleanup_demo_wos)`);

  await client.query('DELETE FROM work_orders WHERE id IN (SELECT id FROM cleanup_demo_wos)');
  await client.query(`DELETE FROM requests WHERE asset_id IN (SELECT id FROM cleanup_demo_assets) OR id IN ('r1','r2','r3')`);
  await client.query(`DELETE FROM pm_plans WHERE asset_id IN (SELECT id FROM cleanup_demo_assets) OR id IN ('m1','m2','m3','m4')`);
  await client.query(`DELETE FROM instruments WHERE asset_id IN (SELECT id FROM cleanup_demo_assets) OR id IN ('n1','n2','n3','n4')`);

  await client.query(`CREATE TEMP TABLE cleanup_demo_items(id TEXT PRIMARY KEY) ON COMMIT DROP;
    INSERT INTO cleanup_demo_items SELECT id FROM items WHERE id IN ('i1','i2','i3','i4','i5','i6') OR id LIKE 'demo-%'`);
  const itemCount=+(await client.query('SELECT count(*) n FROM cleanup_demo_items')).rows[0].n;
  if(await exists(client,'stock_docs'))await client.query('DELETE FROM stock_docs WHERE item_id IN (SELECT id FROM cleanup_demo_items)');
  await client.query('DELETE FROM items WHERE id IN (SELECT id FROM cleanup_demo_items)');
  if(await exists(client,'docs'))await client.query(`DELETE FROM docs WHERE id IN ('dc1','dc2','dc3','dc4','dc5')`);

  // The legacy parent column has no FK; the temporary set already contains all descendants.
  await client.query('DELETE FROM assets WHERE id IN (SELECT id FROM cleanup_demo_assets)');

  if(await exists(client,'audit_x'))await client.query(
    `INSERT INTO audit_x(id,t,u,role,action,mod,entity,note,after)
     VALUES($1,now(),'سیستم','system','cleanup','assets','demo-equipment',$2,$3)`,
    [`cleanup-demo-${Date.now()}`,`پاک‌سازی ${assetCount} تجهیز نمونه و ${woCount} دستورکار وابسته؛ داده‌های واقعی حفظ شدند`,JSON.stringify({assetCount,woCount,itemCount,scope:'legacy-demo-equipment-only'})]
  );
  await client.query('COMMIT');
  console.log('Demo equipment cleanup completed:',{assetCount,woCount,itemCount});
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
}
run().catch(error=>{const detail=error.message||error.code||(error.errors||[]).map(e=>e.code||e.message).join(', ')||String(error);console.error('Demo cleanup failed:',detail);if(/ECONNREFUSED/.test(detail))console.error('PostgreSQL is unavailable. Start DATABASE_URL and run this command again.');process.exitCode=1;});
