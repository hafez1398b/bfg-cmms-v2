'use strict';

/** Destructive reset of the complete Asset/Equipment domain. Users and system settings remain. */
const {Pool}=require('pg');
require('dotenv').config();
const pool=new Pool({connectionString:process.env.DATABASE_URL});
async function exists(c,t){const {rows}=await c.query('SELECT to_regclass($1) IS NOT NULL ok',[t]);return rows[0].ok;}
async function count(c,t){return +(await c.query(`SELECT count(*) n FROM ${t}`)).rows[0].n;}

async function run(){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const before={assets:await count(c,'assets'),workOrders:await count(c,'work_orders'),requests:await count(c,'requests'),pmPlans:await count(c,'pm_plans'),items:await count(c,'items')};
  if(await exists(c,'work_order_assets'))await c.query('DELETE FROM work_order_assets');
  if(await exists(c,'asset_positions'))await c.query('DELETE FROM asset_positions');
  if(await exists(c,'asset_spare_parts'))await c.query('DELETE FROM asset_spare_parts');
  if(await exists(c,'plan_events'))await c.query('UPDATE plan_events SET asset_id=NULL,sub_asset_id=NULL,wo_id=NULL,pm_id=NULL,req_id=NULL');
  if(await exists(c,'tool_loans'))await c.query('UPDATE tool_loans SET asset_id=NULL,wo_id=NULL');
  if(await exists(c,'floor_maps'))await c.query('UPDATE floor_maps SET location_asset_id=NULL');
  if(await exists(c,'locations'))await c.query('UPDATE locations SET legacy_asset_id=NULL');
  await c.query('DELETE FROM permits');
  await c.query('DELETE FROM work_orders');
  await c.query('DELETE FROM requests');
  await c.query('DELETE FROM pm_plans');
  await c.query('DELETE FROM instruments');
  await c.query('DELETE FROM stock_docs');
  await c.query('DELETE FROM items');
  await c.query('DELETE FROM docs');
  if(await exists(c,'asset_categories')){await c.query('UPDATE assets SET category_id=NULL');await c.query('DELETE FROM asset_categories');}
  await c.query('DELETE FROM assets');
  if(await exists(c,'audit_x'))await c.query(`INSERT INTO audit_x(id,t,u,role,action,mod,entity,note,before,after) VALUES($1,now(),'سیستم','system','reset','assets','equipment-structure',$2,$3,$4)`,[`asset-reset-${Date.now()}`,'ساختار دارایی و تجهیزات کاملاً صفر شد؛ آماده ورود ساختار واقعی',JSON.stringify(before),JSON.stringify({assets:0,workOrders:0,requests:0,pmPlans:0,items:0})]);
  await c.query('COMMIT');
  console.log('Asset/equipment structure reset completed:',before);
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
}
run().catch(error=>{const detail=error.message||error.code||(error.errors||[]).map(e=>e.code||e.message).join(', ')||String(error);console.error('Structure reset failed:',detail);if(/ECONNREFUSED/.test(detail))console.error('PostgreSQL is unavailable. Start DATABASE_URL and run this command again.');process.exitCode=1;});
