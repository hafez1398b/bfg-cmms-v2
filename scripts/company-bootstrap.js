'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {Pool}=require('pg');
const bcrypt=require('bcryptjs');
require('dotenv').config();

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function connectWithRetry(pool){
  let lastError;
  for(let attempt=1;attempt<=30;attempt++){
    try{const client=await pool.connect();await client.query('SELECT 1');return client;}
    catch(error){lastError=error;console.log(`Database not ready (${attempt}/30); retrying...`);await sleep(2000);}
  }
  throw lastError||new Error('Database unavailable');
}

async function ensureAdmin(client){
  const username=process.env.ADMIN_USERNAME||'admin',password=process.env.ADMIN_INITIAL_PASSWORD;
  if(!password||password.length<12)throw new Error('ADMIN_INITIAL_PASSWORD must contain at least 12 characters');
  const existing=await client.query("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1");
  if(existing.rows[0]){console.log('Administrator already exists; startup will not reset its password.');return;}
  const hash=await bcrypt.hash(password,12);
  await client.query(`INSERT INTO users(id,username,pass_hash,name,role,unit,active)
    VALUES('u1',$1,$2,'حافظ بایرامیان','admin','مدیریت سیستم',true)`,[username,hash]);
  console.log('Initial system administrator created:',username);
}

async function main(){
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:5000});
  const client=await connectWithRetry(pool);
  let seed=false;
  try{
    await client.query('SELECT pg_advisory_lock($1)',[13981398]);
    const schema=fs.readFileSync(path.join(__dirname,'..','schema.sql'),'utf8');
    await client.query(schema);
    await ensureAdmin(client);
    const count=await client.query("SELECT count(*)::int count FROM assets WHERE type='eq' AND COALESCE(deleted_at,now()+'1 day'::interval)>now()");
    seed=process.env.AUTO_SEED_BESPAR1==='true'&&count.rows[0].count===0;
    await client.query('SELECT pg_advisory_unlock($1)',[13981398]);
  }finally{client.release();await pool.end();}
  if(seed){
    console.log('Fresh database detected; importing verified Bespar 1 master data...');
    const result=spawnSync(process.execPath,[path.join(__dirname,'seed-besepar1.js')],{stdio:'inherit',env:process.env});
    if(result.status!==0)throw new Error('Bespar 1 seed failed');
  }
  console.log('Database schema and startup checks completed.');
}

main().catch(error=>{console.error('Company bootstrap failed:',error.message);process.exit(1);});
