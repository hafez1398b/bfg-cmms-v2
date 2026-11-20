'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const dossier=require('../server/equipment-dossier');
const fixturePath=path.join(__dirname,'fixtures','B1AD4-dossier-test-only.md');
const fixture=fs.readFileSync(fixturePath,'utf8');
const fixtureDoc={id:'fixture-doc-b1ad4',sha256:'a'.repeat(64),extension:'md',document_type:'bom',revision:'TEST-A',approval_status:'approved',buffer:Buffer.from(fixture)};

test('B1AD4 is a synthetic test-only dossier fixture, never an operational DB seed',()=>{
 assert.match(fixture,/SYNTHETIC TEST FIXTURE ONLY/);assert.match(fixture,/B1AD4-TEST/);
 const migrations=fs.readdirSync(path.join(__dirname,'..','migrations'));assert.ok(migrations.includes('021_equipment_source_documents.sql'));
 assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'..','server','equipment-dossier.js'),'utf8'),/B1AD4/);
});

test('source documents validate class, SHA-256, safe media and a real GLB 2.0 header',()=>{
 const md=dossier.validateDocument({filename:'manual.md',type:'markdown',base64:Buffer.from('# Safe manual').toString('base64')});
 assert.equal(md.sha256,require('node:crypto').createHash('sha256').update('# Safe manual').digest('hex'));
 assert.throws(()=>dossier.validateDocument({filename:'cmd.md',type:'image',base64:Buffer.from('# do not execute').toString('base64')}),e=>e.code==='DOSSIER_DOCUMENT_TYPE_MISMATCH');
 assert.throws(()=>dossier.validateDocument({filename:'../escape.md',type:'markdown',base64:Buffer.from('x').toString('base64')}),e=>e.code==='FILE_NAME_REJECTED');
 const makeGlb=value=>{const json=Buffer.from(JSON.stringify(value));const paddedLength=Math.ceil(json.length/4)*4;
  const chunk=Buffer.alloc(paddedLength,0x20);json.copy(chunk);const glb=Buffer.alloc(20+paddedLength);glb.write('glTF',0,'ascii');glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);glb.writeUInt32LE(paddedLength,12);glb.writeUInt32LE(0x4e4f534a,16);chunk.copy(glb,20);return glb;};
 const glb=makeGlb({asset:{version:'2.0'},scene:0,scenes:[{nodes:[]}]});
 assert.equal(dossier.validGlb(glb),true);assert.equal(dossier.validateDocument({filename:'engineering.glb',type:'engineering_model',base64:glb.toString('base64')}).ext,'glb');
 assert.equal(dossier.validGlb(makeGlb({asset:{version:'2.0'},buffers:[{uri:'https://example.invalid/mesh.bin'}]})),false);
 assert.equal(dossier.validGlb(Buffer.from('not a glb')),false);
});

test('literal technical extraction splits confirmed, proposed and conflict; N/A is never a fact',()=>{
 const approved={...fixtureDoc,approval_status:'approved'};
 const pending={...fixtureDoc,id:'pending-doc',sha256:'b'.repeat(64),approval_status:'pending_review',buffer:Buffer.from('Manufacturer: Unverified Maker\nModel: Pending-9\n')};
 const conflict={...fixtureDoc,id:'conflict-doc',sha256:'c'.repeat(64),buffer:Buffer.from('Manufacturer: Other Approved Maker\n')};
 const result=dossier.extractTechnicalFacts([approved,pending,conflict]);
 assert.equal(result.groups.sourceConfirmed.find(x=>x.field==='manufacturer'),undefined);
 assert.ok(result.groups.conflict.some(x=>x.field==='manufacturer'&&x.values.length===2));
 assert.ok(result.groups.proposed.some(x=>x.field==='manufacturer'&&x.confidence===null&&x.sourceStatus==='proposed'));
 assert.ok(result.groups.sourceConfirmed.some(x=>x.field==='identity'&&x.value==='B1AD4-TEST'));
 assert.equal(result.groups.sourceConfirmed.some(x=>x.field==='technicalSpecification'),false);
 assert.deepEqual(result.groups.derived,[]);assert.equal(result.visionStatus,'VISION_UNAVAILABLE');
 assert.match(result.manualTextStatus,/available_for_literal_fields/);
});

test('structure extraction is staged through exactly subsystem, main component, subcomponent',()=>{
 const rows=dossier.parseSourceStructureRows(fixture,{id:fixtureDoc.id,sha256:fixtureDoc.sha256,revision:'TEST-A'});
 const root={id:'root-id',code:'B1AD4-TEST',name:'Synthetic equipment',row_version:4};
 const noChildren=[{...root,depth:0}];
 const subsystem=dossier.buildStageProposals({rows,root,existing:noChildren,parentId:root.id});
 assert.equal(subsystem.stage,'subsystem');assert.equal(subsystem.items.length,1);assert.equal(subsystem.items[0].code,'B1AD4-SYS-01');
 assert.equal(subsystem.items[0].sourceStatus,'source-confirmed');assert.equal(subsystem.items[0].reviewStatus,'pending_review');assert.deepEqual(subsystem.items[0].evidenceIds,[fixtureDoc.id]);
 assert.equal(subsystem.items[0].taxonomy.standard,'ISO 14224');assert.equal(subsystem.items[0].taxonomy.status,'unmapped');assert.equal(subsystem.writePerformed,false);
 const sys={id:'sys-id',code:'B1AD4-SYS-01',name:'Drive section',depth:1,row_version:9};
 const main=dossier.buildStageProposals({rows,root,existing:[...noChildren,sys],parentId:sys.id});
 assert.equal(main.stage,'main-component');assert.equal(main.items.length,1);assert.equal(main.items[0].code,'B1AD4-MC-01');
 assert.equal(main.items[0].function,'Convert electrical power to shaft rotation');assert.equal(main.items[0].parent.rowVersion,9);
 const mc={id:'mc-id',code:'B1AD4-MC-01',name:'Motor assembly',depth:2,row_version:3};
 const sub=dossier.buildStageProposals({rows,root,existing:[...noChildren,sys,mc],parentId:mc.id});
 assert.equal(sub.stage,'sub-component');assert.equal(sub.items.length,1);assert.equal(sub.items[0].code,'B1AD4-SC-01');
 assert.equal(dossier.buildStageProposals({rows,root,existing:[...noChildren,sys,mc],parentId:'not-in-tree'}).error,'PARENT_NOT_IN_APPROVED_STRUCTURE');
});

test('duplicate, cycle, invalid-parent and level change candidates are blocked',()=>{
 const root={id:'root',code:'B1AD4-TEST',name:'Root',row_version:2};const existing=[{...root,depth:0},{id:'sys',code:'SYS-A',name:'Subsystem',depth:1,row_version:3}];
 const rows=[
  {kind:'main-component',code:'DUP',name:'Duplicate one',parentCode:'SYS-A',valid:true,evidenceId:'d1'},
  {kind:'main-component',code:'DUP',name:'Duplicate two',parentCode:'SYS-A',valid:true,evidenceId:'d2'},
  {kind:'main-component',code:'SYS-A',name:'Cycle',parentCode:'SYS-A',valid:true,evidenceId:'d3'},
  {kind:'main-component',code:'BAD-PARENT',name:'Invalid',parentCode:'OTHER',valid:true,evidenceId:'d4'},
  {kind:'sub-component',code:'WRONG-LEVEL',name:'Changed level',parentCode:'SYS-A',valid:true,evidenceId:'d5'}
 ];
 const plan=dossier.buildStageProposals({rows,root,existing,parentId:'sys'});
 const status=code=>plan.items.find(item=>item.code===code).conflictStatus;
 assert.equal(status('DUP'),'duplicate');assert.equal(status('SYS-A'),'cycle');assert.equal(status('BAD-PARENT'),'invalid-parent');assert.equal(status('WRONG-LEVEL'),'level-change-blocked');
 assert.ok(plan.items.every(item=>item.action==='blocked'));
});

test('scene graph is deterministic, four-level, record-linked and never labelled as-built',()=>{
 const input={root:{id:'eq',code:'B1AD4-TEST',name:'Equipment',rowVersion:1,children:[{id:'s',code:'SYS',name:'Subsystem',level:1,nodeKind:'subsystem',children:[{id:'m',code:'MC',name:'Main',level:2,nodeKind:'main-component',children:[{id:'c',code:'SC',name:'Sub',level:3,nodeKind:'sub-component',children:[]}]}]}]}};
 const a=dossier.buildSceneGraph(input),b=dossier.buildSceneGraph(input);
 assert.deepEqual(a,b);assert.equal(a.nodes.length,4);assert.deepEqual(a.nodes.map(n=>n.level),[0,1,2,3]);assert.ok(a.nodes.every(n=>n.sourceId===n.id&&n.selectable));
 assert.equal(a.label,'نمای مفهومی — نقشه مهندسی یا As-Built نیست');assert.equal(a.engineering.available,false);
 assert.ok(a.nodes.every(n=>n.geometry.startsWith('generic-')));
});

test('versioned approval rejects missing human confirmation before opening any database connection',async()=>{
 await assert.rejects(dossier.approveStructureProposal({pool:{connect(){throw new Error('must not connect');}},user:{},security:{},equipmentId:'root',input:{}}),e=>e.code==='EXPLICIT_APPROVAL_REQUIRED');
});

test('failed approved structure write is rolled back inside the version-bound approval transaction',async()=>{
 const crypto=require('node:crypto'),structure=require('../server/equipment-structure');
 const bytes=fs.readFileSync(fixturePath),sha256=crypto.createHash('sha256').update(bytes).digest('hex'),queries=[];
 const root={id:'root-id',parent:null,code:'B1AD4-TEST',name:'Synthetic equipment',type:'eq',cls:null,category_id:null,ext:{},row_version:7,deleted_at:null};
 const client={async query(sql){const text=String(sql);queries.push(text);
   if(text==='BEGIN ISOLATION LEVEL SERIALIZABLE')return{rows:[]};
   if(text==='ROLLBACK'||text==='COMMIT')return{rows:[]};
   if(text.includes('FROM equipment_source_documents'))return{rows:[{id:'source-id',sha256,extension:'md',document_type:'bom',revision:'TEST-A',storage_key:'B1AD4-dossier-test-only.md',byte_size:bytes.length,approval_status:'approved'}]};
   if(text.includes('WITH RECURSIVE ancestry AS'))return{rows:[{id:root.id,parent:null,type:'eq',node_kind:'equipment',category_id:null,depth:0}]};
   if(text.includes('SELECT id,parent,code,name,type,cls,category_id,ext,row_version,deleted_at')&&text.includes('FROM assets WHERE id=$1'))return{rows:[root]};
   if(text.includes('COALESCE(c.factory_asset_id'))return{rows:[{factory_id:null}]};
   if(text.includes('WITH RECURSIVE structure_tree'))return{rows:[{id:root.id,parent:null,code:root.code,name:root.name,old_code:null,structure_kind:null,row_version:7,deleted_at:null,depth:0}]};
   if(text.includes('INSERT INTO audit_x'))return{rows:[]};
   throw new Error(`Unexpected test SQL: ${text.slice(0,80)}`);
 },release(){}};
 const pool={connect:async()=>client};const security={hasPermission:async()=>true};const user={id:'admin-id',role:'admin',name:'Test Admin'};
 const plan=await dossier.analyzeStructureStage({pool:client,user,security,equipmentId:root.id,storageDir:path.dirname(fixturePath)});
 const proposal=plan.items.find(item=>item.action==='preview-only');assert.ok(proposal);
 const original=structure.createStructureNode;structure.createStructureNode=async()=>{throw Object.assign(new Error('simulated failure'),{code:'SIMULATED_WRITE_FAILURE'});};
 try{
   await assert.rejects(dossier.approveStructureProposal({pool,user,security,equipmentId:root.id,storageDir:path.dirname(fixturePath),input:{confirmed:true,reason:'تست rollback',revision:plan.revision,proposalId:proposal.id,parentId:proposal.parent.id,parentRowVersion:proposal.parent.rowVersion}}),e=>e.code==='SIMULATED_WRITE_FAILURE');
 }finally{structure.createStructureNode=original;}
 assert.ok(queries.includes('ROLLBACK'));assert.ok(!queries.includes('COMMIT'));
});

test('dossier endpoints and assets are server-scoped, locally hosted and no auto-write path exists',()=>{
 const routes=fs.readFileSync(path.join(__dirname,'..','server','equipment-routes.js'),'utf8');
 const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');const service=fs.readFileSync(path.join(__dirname,'..','server','equipment-dossier.js'),'utf8');
 assert.match(routes,/source-documents\/\:documentId\/review/);assert.match(routes,/structure\/dossier\/approve/);assert.match(routes,/structure\/scene/);
 assert.match(service,/equipment\.structure\.approve_ai/);assert.match(service,/rowVersion/);assert.match(service,/audit_x/);assert.match(service,/approval_status IN \('approved','pending_review'\)/);
 assert.match(html,/"three"\s*:\s*"\/vendor\/three\/three\.module\.js"/);assert.match(html,/equipment-dossier\.js/);
 const old=fs.readFileSync(path.join(__dirname,'..','test','structure-review-postgres.test.js'),'utf8');assert.match(old,/ROLLBACK|rollback/i);
});
