'use strict';
const fs=require('fs');const path=require('path');const crypto=require('crypto');const {Pool}=require('pg');const {v4:uuid}=require('uuid');require('dotenv').config();
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const TABLES=['assets','asset_categories','requests','work_orders','pm_plans','items','stock_docs','instruments','docs','plan_events','audit_x'];
async function exists(c,t){return(await c.query('SELECT to_regclass($1) IS NOT NULL ok',[t])).rows[0].ok;}
async function run(){const c=await pool.connect();const id=uuid(),stamp=new Date().toISOString().replace(/[:.]/g,'-'),dir=path.join(__dirname,'..','backups','equipment'),file=path.join(dir,`${stamp}-${id}.json`);try{
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const tables={},counts={};for(const t of TABLES){if(await exists(c,t)){const {rows}=await c.query(`SELECT * FROM ${t}`);tables[t]=rows;counts[t]=rows.length;}}await c.query('COMMIT');
 const payload=JSON.stringify({id,scope:'equipment-v2-foundation',createdAt:new Date().toISOString(),schemaVersion:3,counts,tables});fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file,payload,{mode:0o600});const checksum=crypto.createHash('sha256').update(payload).digest('hex'),verified=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')===checksum;if(!verified)throw new Error('RESTORE_POINT_CHECKSUM_FAILED');
 if(await exists(c,'system_restore_points'))await c.query(`INSERT INTO system_restore_points(id,scope,label,storage_path,checksum,status,table_counts,metadata,verified_at) VALUES($1,'equipment-v2-foundation',$2,$3,$4,'verified',$5,$6,now())`,[id,`Before Equipment V2 Phase 1 — ${stamp}`,path.relative(path.join(__dirname,'..'),file),checksum,JSON.stringify(counts),JSON.stringify({format:'json',schemaVersion:3})]);
 console.log('Verified restore point created:',{id,file,checksum,counts});
 }catch(e){try{await c.query('ROLLBACK');}catch(_){}throw e;}finally{c.release();await pool.end();}}
run().catch(e=>{const d=e.message||e.code||(e.errors||[]).map(x=>x.code||x.message).join(', ')||String(e);console.error('Restore point failed:',d);process.exitCode=1;});
