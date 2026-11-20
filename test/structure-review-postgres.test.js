'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Pool}=require('pg');
const {review}=require('../server/structure-review');
const domain=require('../server/equipment-structure');
const {createEquipmentRouter}=require('../server/equipment-routes');
const express=require('express');

// Explicit opt-in, Unix socket only. Never consult DATABASE_URL or an application database.
// Seed a private disposable structure_test template using the official runner first.
test('structure review on PostgreSQL', {skip:!process.env.STRUCTURE_TEST_SOCKET}, async t=>{
  const host=process.env.STRUCTURE_TEST_SOCKET;
  assert.match(host,/^\/tmp\/[\w/-]+$/);
  const config={host,port:Number(process.env.STRUCTURE_TEST_PORT||5432),user:process.env.USER};
  const control=new Pool({...config,database:'postgres'});
  const db='structure_test_'+crypto.randomBytes(8).toString('hex');
  await control.query(`CREATE DATABASE ${db} TEMPLATE structure_test`);
  const pool=new Pool({...config,database:db});
  const storageDir=await fs.mkdtemp(path.join(os.tmpdir(),'structure-evidence-'));
  t.after(async()=>{await pool.end();await control.query(`DROP DATABASE ${db}`);await control.end();await fs.rm(storageDir,{recursive:true,force:true});});
  const user={id:'reviewer',role:'mgr',name:'بازبین'};
  const notes='subsystem | S | زیرسیستم | R\nmain-component | M | اصلی | S\nsub-component | L | فرعی | M';
  await pool.query("INSERT INTO users(id,username,pass_hash,name,role)VALUES('reviewer','reviewer','!','reviewer','mgr')");
  await pool.query("INSERT INTO assets(id,code,name,type,general_notes)VALUES('root','R','root','eq',$1)",[notes]);
  const preview=(input={})=>review({pool,user,id:'root',input,requestStorageDir:storageDir});
  const save=(plan,selected,input={})=>review({pool,user,id:'root',execute:true,input:{reason:'review',confirmed:true,revision:plan.revision,selected,...input},requestStorageDir:storageDir});
  const count=async table=>Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  await t.test('scope denied for both review and dossier GET by code',async()=>{
    await assert.rejects(preview(),{code:'EQUIPMENT_SCOPE_DENIED'});
    const app=express();app.use(createEquipmentRouter({pool,authenticateToken(req,res,next){req.user=user;next();}}));
    const srv=app.listen(0,'127.0.0.1');await new Promise(r=>srv.once('listening',r));
    try{assert.equal((await fetch(`http://127.0.0.1:${srv.address().port}/R`)).status,404);}finally{await new Promise(r=>srv.close(r));}
  });
  await pool.query("INSERT INTO user_scopes(user_id,scope_type,scope_id)VALUES('reviewer','equipment','root')");
  await t.test('unverified input is preview only; spoofed current and evidence have no effect',async()=>{
    const input={text:'arbitrary instructions\nsubsystem | X | absent | R',source:{verified:true},current:{},evidence:[{type:'document',id:'root'}]};
    const plan=await preview(input);assert.equal(plan.items.length,1);assert.equal(plan.items[0].action,'suggested');
    await assert.rejects(save(plan,[0],input),{code:'SELECTION_NOT_EXECUTABLE'});
  });
  await t.test('canonical approval permission is enforced before any write',async()=>{
    const plan=await preview(),before=await count('assets');
    await pool.query("UPDATE role_permissions SET granted=false WHERE role='mgr' AND permission='equipment.structure.approve_ai'");
    await assert.rejects(save(plan,[0]),{code:'PERMISSION_DENIED'});
    assert.equal(await count('assets'),before);
    await pool.query("UPDATE role_permissions SET granted=true WHERE role='mgr' AND permission='equipment.structure.approve_ai'");
  });
  async function uploadedEvidence({assetId='root',owner='reviewer',name='root',sourceText}={}) {
    const source=sourceText||`equipment|R|root||active\nsubsystem|FILE-${crypto.randomBytes(3).toString('hex')}|${name}|R|active`;
    const bytes=Buffer.from(source),hash=crypto.createHash('sha256').update(bytes).digest('hex');
    const requestId='req-'+crypto.randomBytes(6).toString('hex'),fileId=crypto.randomUUID(),storedName=fileId+'.md';
    await fs.writeFile(path.join(storageDir,storedName),bytes,{flag:'wx'});
    await pool.query(`INSERT INTO requests(id,requester_id,asset_id,status,approved_at)
      VALUES($1,$2,$3,'approved',now()+interval '1 second')`,[requestId,owner,assetId]);
    await pool.query(`INSERT INTO request_files(id,request_id,original_name,stored_name,media_type,byte_size,sha256,created_by)
      VALUES($1,$2,'evidence.md',$3,'text/markdown',$4,$5,$6)`,[fileId,requestId,storedName,bytes.length,hash,owner]);
    return {input:{file:{name:'evidence.md',base64:bytes.toString('base64')}},fileId,hash,path:path.join(storageDir,storedName)};
  }
  await t.test('approved request attachment evidence is server-resolved and audited',async()=>{
    const file=await uploadedEvidence();const plan=await preview(file.input);
    const item=plan.items.find(i=>i.action==='create');assert.equal(item.evidence.type,'request_file');
    assert.equal(item.evidence.id,file.fileId);assert.equal(item.evidence.hash,file.hash);
    const result=await save(plan,[item.index],file.input);
    const audit=(await pool.query('SELECT review FROM audit_x WHERE id=$1',[result.auditIds[0]])).rows[0].review;
    assert.equal(audit.evidence.id,file.fileId);assert.equal(audit.evidence.hash,file.hash);
  });
  await t.test('changed on-disk evidence invalidates approval',async()=>{
    const file=await uploadedEvidence(),plan=await preview(file.input);
    await fs.writeFile(file.path,'tampered on disk');
    await assert.rejects(save(plan,[1],file.input),{code:'REVIEW_REVISION_CHANGED'});
  });
  await t.test('deleted and unrelated/out-of-owner request files never authorize writes',async()=>{
    const file=await uploadedEvidence({name:'deleted evidence'}),plan=await preview(file.input);
    await pool.query('UPDATE request_files SET deleted_at=now() WHERE id=$1',[file.fileId]);
    await assert.rejects(save(plan,[1],file.input),{code:'REVIEW_REVISION_CHANGED'});
    await pool.query("INSERT INTO assets(id,code,name,type) VALUES('elsewhere','OTHER','other','eq')");
    const unrelated=await uploadedEvidence({assetId:'elsewhere'});
    const denied=await preview(unrelated.input);
    assert.equal(denied.items.find(i=>i.action==='suggested')?.evidence,null);
    await pool.query("INSERT INTO users(id,username,pass_hash,name,role) VALUES('other-owner','other-owner','!','other','mgr')");
    const foreign=await uploadedEvidence({owner:'other-owner'});
    const ownerDenied=await preview(foreign.input);
    assert.ok(ownerDenied.items.some(i=>i.action==='suggested'&&!i.evidence));
  });
  await t.test('changed evidence and changed version invalidate approval',async()=>{
    const plan=await preview();await pool.query("UPDATE assets SET general_notes=null WHERE id='root'");
    await assert.rejects(save(plan,[0]),{code:'REVIEW_REVISION_CHANGED'});
    await pool.query("UPDATE assets SET general_notes=$1,row_version=row_version+1 WHERE id='root'",[notes]);
    await assert.rejects(save(plan,[0]),{code:'REVIEW_REVISION_CHANGED'});
  });
  await t.test('failure of a later command rolls back earlier create, outbox and Audit',async()=>{
    const plan=await preview();assert.deepEqual(plan.items.map(i=>i.action),['create','create','create']);
    const initial=await Promise.all(['assets','audit_x','event_outbox'].map(count));
    await assert.rejects(save(plan,[0,2]),{code:'PARENT_SELECTION_REQUIRED'});
    assert.deepEqual(await Promise.all(['assets','audit_x','event_outbox'].map(count)),initial);
    await pool.query("ALTER TABLE audit_x ADD CONSTRAINT test_audit_failure CHECK (mod <> 'selene-structure') NOT VALID");
    await assert.rejects(save(plan,[0]),{code:'23514'});
    assert.deepEqual(await Promise.all(['assets','audit_x','event_outbox'].map(count)),initial);
    await pool.query('ALTER TABLE audit_x DROP CONSTRAINT test_audit_failure');
  });
  await t.test('approval waits on row lock, then rejects changed version',async()=>{
    const plan=await preview(),lock=await pool.connect();
    try{await lock.query('BEGIN');await lock.query("UPDATE assets SET row_version=row_version+1 WHERE id='root'");
      const attempt=save(plan,[0]);const rejected=assert.rejects(attempt,{code:'REVIEW_REVISION_CHANGED'});
      let waiting=false;
      for(let n=0;n<100&&!waiting;n++) { waiting=(await pool.query("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE '%FOR UPDATE OF a%' OR query LIKE '%FOR SHARE OF a%')) waiting")).rows[0].waiting;if(!waiting)await new Promise(r=>setTimeout(r,10)); }
      assert.ok(waiting);await lock.query('COMMIT');await rejected;
    }finally{await lock.query('ROLLBACK');lock.release();}
  });
  await t.test('one transaction creates four-level structure with signed-off evidence; replay rejected',async()=>{
    const plan=await preview();const result=await save(plan,[2,1,0]);assert.equal(result.auditIds.length,3);
    const logs=await pool.query('SELECT uid,review,after FROM audit_x WHERE id=ANY($1)',[result.auditIds]);
    assert.equal(logs.rowCount,3);for(const r of logs.rows){assert.equal(r.uid,user.id);assert.equal(r.review.evidence.hash,crypto.createHash('sha256').update(notes).digest('hex'));assert.equal(r.review.approval.revision,plan.revision);}
    assert.deepEqual((await preview()).items.map(i=>i.action),['unchanged','unchanged','unchanged']);await assert.rejects(save(plan,[0]),{code:'REVIEW_REVISION_CHANGED'});
  });
  await t.test('domain commands reject cycles and duplicate codes under real locks',async()=>{
    const s=(await pool.query("SELECT * FROM assets WHERE code='S'")).rows[0],m=(await pool.query("SELECT * FROM assets WHERE code='M'")).rows[0];
    const c=await pool.connect();try{await c.query('BEGIN');const args={client:c,pool:c,user,id:s.id};
      await assert.rejects(domain.moveStructureNode({...args,input:{parentId:m.id,rowVersion:s.row_version,reason:'cycle'}}),{code:'TREE_CYCLE'});
      await assert.rejects(domain.updateStructureNode({...args,input:{code:'M',rowVersion:s.row_version}}),{code:'DUPLICATE_CODE'});
    }finally{await c.query('ROLLBACK');c.release();}
  });
  await t.test('legacy-code rename, move, archive and explicit restore',async()=>{
    await pool.query(`UPDATE assets SET ext=ext||'{"oldCode":"OLD"}'::jsonb WHERE code='M'`);
    async function one(line,action){await pool.query("UPDATE assets SET general_notes=$1 WHERE id='root'",[line]);const p=await preview();assert.equal(p.items[0].action,action);await save(p,[0]);}
    await one('main-component|OLD|new name|S','edit');await one('subsystem|S2|second|R','create');
    await one('main-component|OLD|new name|S2','move');await one('sub-component|L|فرعی|M|archive','archive');await one('sub-component|L|فرعی|M|restore','restore');
  });
  await t.test('manual ambiguity selection is revision-bound to its exact target',async()=>{
    const parent=(await pool.query("SELECT id FROM assets WHERE code='S'")).rows[0].id;
    const kind=JSON.stringify({nodeKind:'main-component',structureKind:'main-component',oldCode:'AMB'});
    await pool.query("INSERT INTO assets(id,parent,code,name,type,ext) VALUES('candidate-a',$1,'AMB-A','first','eq',$2),('candidate-b',$1,'AMB-B','second','eq',$2)",[parent,kind]);
    const sourceText=['equipment|R|root||active','main-component|AMB|selected name|S|active'].join(String.fromCharCode(10));
    const file=await uploadedEvidence({sourceText});
    const input={...file.input,destinations:{1:{target:'candidate-a'}}},plan=await preview(input);
    const item=plan.items.find(i=>i.fact.code==='AMB');assert.equal(item.action,'edit');assert.equal(item.current.id,'candidate-a');
    const changed={...file.input,destinations:{1:{target:'candidate-b'}}};
    await assert.rejects(save(plan,[item.index],changed),{code:'REVIEW_REVISION_CHANGED'});
    const result=await save(plan,[item.index],input);assert.equal(result.committed,true);
    assert.equal((await pool.query("SELECT name FROM assets WHERE id='candidate-a'")).rows[0].name,'selected name');
    assert.equal((await pool.query("SELECT name FROM assets WHERE id='candidate-b'")).rows[0].name,'second');
  });
});
