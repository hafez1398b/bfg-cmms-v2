'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {Pool}=require('pg');
const {v4:uuid}=require('uuid');
require('dotenv').config();

async function run(){
  if(process.env.CONFIRM_SECOND_CORRECTION_MIGRATION!=='YES')throw new Error('CONFIRM_SECOND_CORRECTION_MIGRATION=YES is required');
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
  const restorePath=path.resolve(process.env.RESTORE_POINT_PATH||'');
  if(!process.env.RESTORE_POINT_PATH||!fs.existsSync(restorePath))throw new Error('RESTORE_POINT_PATH must reference a verified database backup');
  const stat=fs.statSync(restorePath);
  if(!stat.isFile()||stat.size===0)throw new Error('Restore point is empty or invalid');
  if(Date.now()-stat.mtimeMs>24*60*60*1000)throw new Error('Restore point must be less than 24 hours old');
  const checksum=crypto.createHash('sha256').update(fs.readFileSync(restorePath)).digest('hex');
  const migrationFiles=['004_second_correction_foundation.sql','005_ai_orchestration.sql'];
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  const client=await pool.connect();
  try{
    for(const file of migrationFiles)await client.query(fs.readFileSync(path.join(__dirname,'..','migrations',file),'utf8'));
    await client.query(
      `INSERT INTO system_restore_points(id,scope,label,storage_path,checksum,status,metadata,verified_at)
       VALUES($1,'second-correction-foundation',$2,$3,$4,'verified',$5,now()) ON CONFLICT(id) DO NOTHING`,
      [uuid(),`Before Second Correction — ${new Date(stat.mtimeMs).toISOString()}`,restorePath,checksum,JSON.stringify({size:stat.size,migrations:migrationFiles})]
    );
    console.log('Second Correction foundation migration applied. Restore checksum:',checksum);
  }finally{client.release();await pool.end();}
}
run().catch(error=>{console.error('Migration blocked/failed:',error.message);process.exitCode=1;});
