'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { v4: uuid } = require('uuid');
const { validateImportFile, MAX_BYTES } = require('./import-file-policy');
const { extractXlsx, extractPdfText, parseCsv } = require('./import-extract');
const { facts } = require('./structure-analysis');
const structure = require('./equipment-structure');
const { coded } = require('./equipment-service');

const TYPES = Object.freeze({
  markdown: new Set(['md']), excel: new Set(['xlsx']), image: new Set(['jpg','jpeg','png']),
  manual: new Set(['pdf','md']), bom: new Set(['xlsx','csv','md']), engineering_model: new Set(['glb'])
});
const PLACEHOLDERS = new Set(['', 'n/a', 'na', 'ثبت نشده', 'ثبت‌نشده', 'نامشخص', '—', '-', 'not available', 'unknown']);
const FIELD_ALIASES = Object.freeze({
  identity: ['identity','equipment id','شناسه','هویت تجهیز'],
  equipmentClass: ['class','equipment class','کلاس','کلاس تجهیز'],
  function: ['function','service','عملکرد','وظیفه'],
  manufacturer: ['manufacturer','maker','سازنده','تولیدکننده'],
  model: ['model','مدل'],
  technicalSpecification: ['technical specification','specification','spec','مشخصات فنی','مشخصات']
});
const MIME = Object.freeze({md:'text/markdown',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',csv:'text/csv',pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',glb:'model/gltf-binary'});
const storageRoot = root => path.resolve(root || process.env.EQUIPMENT_DOSSIER_STORAGE_DIR || path.join(__dirname,'..','storage','equipment-dossier'));

function fail(status, code) { throw coded(status, code); }
function safeName(name) {
  const value=String(name||'').trim();
  if(!value||value.length>180||/[\\/\0]/.test(value)||value.includes('..')||value.startsWith('.'))fail(422,'FILE_NAME_REJECTED');
  return value;
}
function validGlb(buffer) {
  if(buffer.length<20||buffer.toString('ascii',0,4)!=='glTF'||buffer.readUInt32LE(4)!==2||buffer.readUInt32LE(8)!==buffer.length)return false;
  const length=buffer.readUInt32LE(12),type=buffer.readUInt32LE(16);
  if(type!==0x4e4f534a||length<2||20+length>buffer.length)return false;
  try {
    const json=JSON.parse(buffer.toString('utf8',20,20+length).replace(/[\u0000\u0020]+$/g,''));
    const hasExternalUri=(value)=>{
      if(!value||typeof value!=='object')return false;
      if(Array.isArray(value))return value.some(hasExternalUri);
      return Object.entries(value).some(([key,item])=>key.toLowerCase()==='uri'
        ?(typeof item!=='string'||!item.startsWith('data:')):hasExternalUri(item));
    };
    return json.asset?.version==='2.0'&&!hasExternalUri(json);
  } catch (_) { return false; }
}
function validateDocument({filename,type,base64}) {
  const name=safeName(filename), ext=path.extname(name).slice(1).toLowerCase();
  if(!TYPES[type]||!TYPES[type].has(ext))fail(422,'DOSSIER_DOCUMENT_TYPE_MISMATCH');
  if(typeof base64!=='string'||base64.length>Math.ceil(MAX_BYTES*4/3)+8)fail(413,'FILE_TOO_LARGE');
  const buffer=Buffer.from(base64,'base64');
  if(!buffer.length||buffer.length>MAX_BYTES)fail(buffer.length?413:422,buffer.length?'FILE_TOO_LARGE':'FILE_EMPTY');
  if(ext==='png') {
    if(buffer.length<24||buffer.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||buffer.toString('ascii',12,16)!=='IHDR')fail(422,'FILE_TYPE_REJECTED');
  } else if(ext==='glb') {
    if(!validGlb(buffer))fail(422,'GLB_INVALID');
  } else {
    validateImportFile({name,buffer});
  }
  return {name,ext,type,buffer,sha256:crypto.createHash('sha256').update(buffer).digest('hex'),byteSize:buffer.length,mimeType:MIME[ext]||'application/octet-stream'};
}
function filePath(root,key) {
  const base=storageRoot(root),target=path.resolve(base,String(key||''));
  if(!target.startsWith(base+path.sep))fail(500,'DOSSIER_STORAGE_KEY_INVALID');
  return target;
}
function publicDocument(row) {
  return {id:row.id,equipmentId:row.equipment_id,sha256:row.sha256,filename:row.original_name,documentType:row.document_type,
    mimeType:row.mime_type,revision:row.revision||null,byteSize:Number(row.byte_size),approvalStatus:row.approval_status,
    rowVersion:Number(row.row_version),uploaderId:row.uploader_id,uploadedAt:row.uploaded_at,reviewedBy:row.reviewed_by||null,
    reviewedAt:row.reviewed_at||null,approvedBy:row.approved_by||null,approvedAt:row.approved_at||null,reviewNote:row.review_note||null};
}
async function assertRoot({pool,user,security,equipmentId,permission='equipment.structure.view'}) {
  await structure.assertPermission({pool,security,user},permission);
  const root=await structure.rootForAsset(pool,user,equipmentId);
  if(String(root.id)!==String(equipmentId))fail(422,'ROOT_EQUIPMENT_MISMATCH');
  return root;
}
async function listDocuments({pool,user,security,equipmentId}) {
  await assertRoot({pool,user,security,equipmentId});
  const {rows}=await pool.query(`SELECT * FROM equipment_source_documents WHERE equipment_id=$1 ORDER BY uploaded_at DESC,id`,[equipmentId]);
  return rows.map(publicDocument);
}
async function uploadDocument({pool,user,security,equipmentId,input={},storageDir}) {
  const root=await assertRoot({pool,user,security,equipmentId,permission:'equipment.structure.suggest'});
  const file=validateDocument(input);
  const client=await pool.connect();let key=null;
  try {
    await client.query('BEGIN');
    const duplicate=await client.query('SELECT id FROM equipment_source_documents WHERE equipment_id=$1 AND sha256=$2 FOR SHARE',[root.id,file.sha256]);
    if(duplicate.rows[0])fail(409,'DOSSIER_DOCUMENT_DUPLICATE');
    const id=uuid();key=`${id}.${file.ext}`;
    const target=filePath(storageDir,key);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,file.buffer,{flag:'wx',mode:0o600});
    const revision=String(input.revision||'').trim().slice(0,120)||null;
    const {rows}=await client.query(`INSERT INTO equipment_source_documents
      (id,equipment_id,sha256,original_name,storage_key,extension,document_type,mime_type,revision,byte_size,uploader_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id,root.id,file.sha256,file.name,key,file.ext,file.type,file.mimeType,revision,file.byteSize,user.id]);
    await client.query(`INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after)
      VALUES($1,now(),$2,$3,$4,'source-upload','equipment-dossier',$5,$6,NULL,$7)`,
      [uuid(),user.name||user.username||user.id,user.id,user.role,id,'ثبت سند منبع در انتظار بررسی',JSON.stringify({sha256:file.sha256,type:file.type,revision})]);
    await client.query('COMMIT');return publicDocument(rows[0]);
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>{});
    if(key)await fs.unlink(filePath(storageDir,key)).catch(()=>{});
    throw error;
  } finally { client.release(); }
}
async function reviewDocument({pool,user,security,equipmentId,documentId,input={},storageDir}) {
  await assertRoot({pool,user,security,equipmentId,permission:'equipment.structure.approve_ai'});
  const status=input.status;
  if(!['approved','rejected'].includes(status)||!String(input.note||'').trim()||String(input.note).length>500)fail(422,'DOSSIER_REVIEW_INVALID');
  const version=Number(input.rowVersion);if(!Number.isInteger(version)||version<1)fail(422,'ROW_VERSION_REQUIRED');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows}=await client.query('SELECT * FROM equipment_source_documents WHERE id=$1 AND equipment_id=$2 FOR UPDATE',[documentId,equipmentId]);
    const current=rows[0];if(!current)fail(404,'DOSSIER_DOCUMENT_NOT_FOUND');
    if(Number(current.row_version)!==version)fail(409,'VERSION_CONFLICT');
    if(current.approval_status!=='pending_review')fail(409,'DOSSIER_DOCUMENT_ALREADY_REVIEWED');
    const full=filePath(storageDir,current.storage_key),bytes=await fs.readFile(full);
    if(bytes.length!==Number(current.byte_size)||crypto.createHash('sha256').update(bytes).digest('hex')!==current.sha256)fail(409,'DOSSIER_DOCUMENT_INTEGRITY_FAILED');
    if(current.document_type==='engineering_model'&&(!validGlb(bytes)||current.extension!=='glb'))fail(422,'GLB_INVALID');
    const updated=await client.query(`UPDATE equipment_source_documents SET approval_status=$2,reviewed_by=$3,reviewed_at=now(),
      approved_by=CASE WHEN $2='approved' THEN $3 ELSE NULL END,approved_at=CASE WHEN $2='approved' THEN now() ELSE NULL END,
      review_note=$4,row_version=row_version+1 WHERE id=$1 AND row_version=$5 RETURNING *`,[documentId,status,user.id,String(input.note).trim(),version]);
    if(!updated.rows[0])fail(409,'VERSION_CONFLICT');
    await client.query(`INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after)
      VALUES($1,now(),$2,$3,$4,'source-review','equipment-dossier',$5,$6,$7,$8)`,
      [uuid(),user.name||user.username||user.id,user.id,user.role,documentId,String(input.note).trim(),JSON.stringify(current),JSON.stringify(updated.rows[0])]);
    await client.query('COMMIT');return publicDocument(updated.rows[0]);
  } catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}
async function getDocumentBytes({pool,user,security,equipmentId,documentId,storageDir}) {
  await assertRoot({pool,user,security,equipmentId});
  const {rows}=await pool.query('SELECT * FROM equipment_source_documents WHERE id=$1 AND equipment_id=$2',[documentId,equipmentId]);
  const row=rows[0];if(!row)fail(404,'DOSSIER_DOCUMENT_NOT_FOUND');
  const bytes=await fs.readFile(filePath(storageDir,row.storage_key));
  if(bytes.length!==Number(row.byte_size)||crypto.createHash('sha256').update(bytes).digest('hex')!==row.sha256)fail(409,'DOSSIER_DOCUMENT_INTEGRITY_FAILED');
  return {bytes,row:publicDocument(row),mimeType:row.mime_type,filename:row.original_name};
}
function normalizeField(value) {
  const result=String(value||'').replace(/^[\s*#>`-]+|[\s*_`]+$/g,'').trim().slice(0,1200);
  if(PLACEHOLDERS.has(result.toLowerCase().replace(/[\u200c\s]+/g,' ')))return null;
  return result||null;
}
function parseSourceStructureRows(sourceText,document) {
  const out=[];
  for(const rawLine of String(sourceText||'').split(/\r?\n/)){
    const line=rawLine.trim().replace(/^\|/,'').replace(/\|$/,'');
    const cells=line.split(line.includes('\t')?'\t':'|').map(value=>value.trim());
    if(cells.length<3)continue;
    const kinds=new Set(['equipment','تجهیز','subsystem','زیرسیستم','main component','main-component','جزء اصلی','subcomponent','sub-component','جزء فرعی']);
    if(!kinds.has(String(cells[0]).toLowerCase()))continue;
    let base=cells.slice(0,5),functionValue=null,reasonValue=null;
    if(cells.length===5&&!['active','archive','restore','proposed'].includes(String(cells[4]).toLowerCase())){
      functionValue=normalizeField(cells[4]);base[4]='active';
    }else{
      functionValue=normalizeField(cells[5]);reasonValue=normalizeField(cells[6]);
    }
    const fact=facts(base.join('|'))[0];
    if(!fact)continue;
    const code=normalizeField(fact.code),name=normalizeField(fact.name),parentCode=normalizeField(fact.parentCode);
    const parentWasPlaceholder=Boolean(String(fact.parentCode||'').trim()&&!parentCode);
    out.push({...fact,code:code||'',name:name||'',parentCode:parentCode||'',function:functionValue,reason:reasonValue,evidenceId:document.id,sourceHash:document.sha256,sourceRevision:document.revision||null,
      valid:fact.valid&&!!code&&!!name&&!parentWasPlaceholder&&cells.length<=7&&cells.every(value=>!/[\u0000-\u001f]/.test(value))});
  }
  return out;
}
function extractTechnicalFacts(docs) {
  const hits=new Map(Object.keys(FIELD_ALIASES).map(key=>[key,[]]));
  for(const doc of docs) {
    const ext=doc.extension;let text='';
    if(['md','csv'].includes(ext))text=doc.buffer.toString('utf8').slice(0,16000);
    else if(ext==='xlsx')text=extractXlsx(doc.buffer).slice(0,16000);
    else if(ext==='pdf')text=extractPdfText(doc.buffer).slice(0,16000);
    else continue;
    // Strict key:value parsing only. Arbitrary prose, formulas, scripts and instructions are never run.
    for(const line of text.split(/\r?\n/)) {
      const cleaned=line.replace(/^\s*\|?\s*|\s*\|?\s*$/g,'');
      const match=cleaned.match(/^\s*(?:[-*]\s*)?([^:|\t]{1,100})\s*[:|\t]\s*([^|\t]+)\s*$/);
      if(!match)continue;
      const label=match[1].trim().toLowerCase().replace(/[\u200c\s]+/g,' '),value=normalizeField(match[2]);
      if(!value)continue;
      const key=Object.keys(FIELD_ALIASES).find(field=>FIELD_ALIASES[field].includes(label));
      if(key)hits.get(key).push({value,documentId:doc.id,sha256:doc.sha256,revision:doc.revision||null,approvalStatus:doc.approval_status||'approved'});
    }
  }
  const groups={sourceConfirmed:[],derived:[],proposed:[],conflict:[]};
  for(const [field,entries] of hits) {
    const approved=entries.filter(item=>item.approvalStatus==='approved'),pending=entries.filter(item=>item.approvalStatus==='pending_review');
    const groupValues=values=>[...values.reduce((map,item)=>{const key=item.value.toLowerCase();if(!map.has(key))map.set(key,[]);map.get(key).push(item);return map;},new Map()).values()]
      .map(items=>({value:items[0].value,entries:items,evidenceIds:[...new Set(items.map(item=>item.documentId))],provenance:items.map(item=>({sha256:item.sha256,revision:item.revision||null}))}));
    const confirmed=groupValues(approved),proposals=groupValues(pending);
    if(confirmed.length>1)groups.conflict.push({field,values:confirmed.map(({value,evidenceIds,provenance})=>({value,evidenceIds,provenance})),reason:'مقادیر صریح اسناد تأییدشده با هم اختلاف دارند.',status:'conflict'});
    else if(confirmed.length===1)groups.sourceConfirmed.push({field,value:confirmed[0].value,evidenceIds:confirmed[0].evidenceIds,provenance:{source:'approved_equipment_document',sources:confirmed[0].provenance},confidence:1,sourceStatus:'source-confirmed',reviewStatus:'source-document-approved'});
    for(const proposal of proposals)groups.proposed.push({field,value:proposal.value,evidenceIds:proposal.evidenceIds,provenance:{source:'unapproved_equipment_document',sources:proposal.provenance},confidence:null,sourceStatus:'proposed',reviewStatus:'pending_review',conflictsWithSourceConfirmed:confirmed.some(item=>item.value.toLowerCase()!==proposal.value.toLowerCase())});
  }
  const imageIds=docs.filter(doc=>doc.document_type==='image'&&doc.approval_status==='approved').map(doc=>doc.id);
  const manualPdfs=docs.filter(doc=>doc.document_type==='manual'&&doc.extension==='pdf').map(doc=>doc.id);
  return {groups,visionStatus:'VISION_UNAVAILABLE',imageEvidenceIds:imageIds,
    manualTextStatus:manualPdfs.length?'PDF_TEXT_LAYER_LITERAL_ONLY_NO_OCR':'available_for_literal_fields',manualEvidenceIds:manualPdfs};
}
async function analyzeApprovedDocuments({pool,user,security,equipmentId,storageDir}) {
  const root=await assertRoot({pool,user,security,equipmentId,permission:'equipment.structure.suggest'});
  const {rows}=await pool.query(`SELECT id,sha256,extension,document_type,revision,storage_key,byte_size,approval_status FROM equipment_source_documents
    WHERE equipment_id=$1 AND approval_status IN ('approved','pending_review') ORDER BY uploaded_at,id`,[root.id]);
  const docs=[];
  for(const row of rows) {
    const full=filePath(storageDir,row.storage_key),buffer=await fs.readFile(full);
    if(buffer.length!==Number(row.byte_size)||crypto.createHash('sha256').update(buffer).digest('hex')!==row.sha256)fail(409,'DOSSIER_DOCUMENT_INTEGRITY_FAILED');
    docs.push({...row,buffer});
  }
  const extracted=extractTechnicalFacts(docs);
  const identity=extracted.groups.sourceConfirmed.find(item=>item.field==='identity');
  if(identity&&!new Set([String(root.id),String(root.code||''),String(root.name||'')].filter(Boolean).map(value=>value.toLowerCase())).has(String(identity.value).toLowerCase())){
    extracted.groups.sourceConfirmed=extracted.groups.sourceConfirmed.filter(item=>item!==identity);
    extracted.groups.conflict.push({field:'identity',values:[{value:identity.value,evidenceIds:identity.evidenceIds,provenance:identity.provenance}],reason:'هویت صریح سند با تجهیز انتخاب‌شده هم‌خوان نیست؛ به‌عنوان هویت این پرونده تأیید نشد.',status:'conflict'});
  }
  return {equipment:{id:root.id,code:root.code,name:root.name},...extracted,sourceDocuments:rows.map(row=>({id:row.id,sha256:row.sha256,type:row.document_type,revision:row.revision||null})),searchStatus:'SEARCH_UNAVAILABLE',model:'deterministic-literal-extractor-v1',provider:'server',readOnly:true};
}
function buildSceneGraph(structurePayload) {
  const root=structurePayload?.root;
  const label='نمای مفهومی — نقشه مهندسی یا As-Built نیست';
  if(!root)return {schema:'bfg.conceptual-scene.v1',label,nodes:[],rootId:null,engineering:{available:false}};
  const sceneNodes=[],visited=new Set();
  function visit(node,parentId,level,pathIds){
    const id=String(node.id);
    if(!id||visited.has(id)||pathIds.has(id)||node.archived||level>3||(level>0&&(node.validRelation===false||node.conflict)))return false;
    visited.add(id);
    const nextPath=new Set(pathIds);nextPath.add(id);
    const children=Array.isArray(node.children)?node.children.slice().sort((a,b)=>String(a.id).localeCompare(String(b.id))):[];
    const sceneNode={id,parentId,sourceId:id,name:String(node.name||node.code||'جزء ثبت‌شده'),code:node.code||null,
      level,structureKind:level===0?'equipment':node.canonicalKind||node.nodeKind||({1:'subsystem',2:'main-component',3:'sub-component'}[level]||'invalid'),
      geometry:level===0?'generic-equipment-envelope':level===1?'generic-subsystem-block':level===2?'generic-component-block':'generic-subcomponent-block',
      selectable:true,sourceStatus:'persisted_structure_record',recordVersion:Number(node.rowVersion||node.row_version)||null,children:[]};
    sceneNodes.push(sceneNode);
    for(const child of children)if(visit(child,id,level+1,nextPath))sceneNode.children.push(String(child.id));
    return true;
  }
  visit(root,null,0,new Set());
  const revision=crypto.createHash('sha256').update(JSON.stringify(sceneNodes)).digest('hex');
  return {schema:'bfg.conceptual-scene.v1',label,rootId:String(root.id),revision,nodes:sceneNodes,
    engineering:{available:false,reason:'بدون سند GLB معتبر و تأییدشده؛ نمای مهندسی ارائه نشده است.'}};
}
async function analyzeStructureStage({pool,user,security,equipmentId,parentId,storageDir}) {
  const root=await assertRoot({pool,user,security,equipmentId,permission:'equipment.structure.suggest'});
  const {rows:documents}=await pool.query(`SELECT id,sha256,extension,document_type,revision,storage_key,byte_size FROM equipment_source_documents
    WHERE equipment_id=$1 AND approval_status='approved' AND document_type IN ('markdown','excel','bom') ORDER BY uploaded_at,id`,[root.id]);
  const parsedRows=[];
  for(const doc of documents){
    const buffer=await fs.readFile(filePath(storageDir,doc.storage_key));
    if(buffer.length!==Number(doc.byte_size)||crypto.createHash('sha256').update(buffer).digest('hex')!==doc.sha256)fail(409,'DOSSIER_DOCUMENT_INTEGRITY_FAILED');
    let sourceText='';
    if(doc.extension==='md'||doc.extension==='csv')sourceText=buffer.toString('utf8').slice(0,128*1024);
    else if(doc.extension==='xlsx')sourceText=extractXlsx(buffer).slice(0,128*1024);
    if(!sourceText)continue;
    if(doc.extension==='csv')sourceText=parseCsv(sourceText).map(row=>row.join('|')).join('\n');
    parsedRows.push(...parseSourceStructureRows(sourceText,doc));
  }
  const {rows:tree}=await pool.query(`WITH RECURSIVE structure_tree(id,parent,depth,path) AS (
    SELECT a.id,a.parent,0,ARRAY[a.id]::text[] FROM assets a WHERE a.id=$1 AND a.type='eq' AND a.deleted_at IS NULL
    UNION ALL SELECT child.id,child.parent,t.depth+1,t.path||child.id FROM assets child JOIN structure_tree t ON child.parent=t.id
      WHERE child.type='eq' AND child.deleted_at IS NULL AND t.depth<3 AND NOT child.id=ANY(t.path)
  ) SELECT a.id,a.parent,a.code,a.name,a.ext->>'oldCode' AS old_code,a.ext->>'structureKind' AS structure_kind,a.row_version,a.deleted_at,t.depth
    FROM structure_tree t JOIN assets a ON a.id=t.id ORDER BY t.depth,a.id`,[root.id]);
  const selected=parentId?tree.find(row=>String(row.id)===String(parentId)):tree.find(row=>String(row.id)===String(root.id));
  if(!selected)fail(422,parentId?'PARENT_NOT_IN_APPROVED_STRUCTURE':'ROOT_EQUIPMENT_MISMATCH');
  if(Number(selected.depth)>2)fail(409,'STRUCTURE_DEPTH_EXCEEDED');
  const canonicalParentKind={0:'equipment',1:'subsystem',2:'main-component'}[Number(selected.depth)];
  if(!canonicalParentKind||(selected.structure_kind&&selected.structure_kind!==canonicalParentKind))fail(409,'PARENT_KIND_CONFLICT');
  const plan=buildStageProposals({rows:parsedRows,root,existing:tree,parentId:selected.id});
  return {equipment:{id:root.id,code:root.code,name:root.name},...plan,sourceDocuments:documents.map(doc=>({id:doc.id,sha256:doc.sha256,type:doc.document_type,revision:doc.revision||null})),
    provider:'server',model:'deterministic-source-extractor-v1',searchStatus:'SEARCH_UNAVAILABLE',readOnly:true,writePerformed:false};
}

async function approveStructureProposal({pool,user,security,equipmentId,input={},storageDir}) {
  if(input.confirmed!==true||!String(input.reason||'').trim()||String(input.reason).length>500)fail(422,'EXPLICIT_APPROVAL_REQUIRED');
  if(!/^[a-f0-9]{64}$/i.test(String(input.revision||''))||!String(input.proposalId||''))fail(422,'PROPOSAL_REVISION_REQUIRED');
  const client=await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await structure.assertPermission({pool:client,security,user},'equipment.structure.approve_ai');
    const plan=await analyzeStructureStage({pool:client,user,security,equipmentId,parentId:input.parentId,storageDir});
    if(plan.revision!==input.revision)fail(409,'PROPOSAL_REVISION_CHANGED');
    const proposal=plan.items.find(item=>item.id===input.proposalId);
    if(!proposal||proposal.action!=='preview-only'||proposal.conflictStatus!=='none'||!proposal.evidenceIds.length)fail(422,'PROPOSAL_NOT_APPROVABLE');
    if(Number(input.parentRowVersion)!==Number(proposal.parent.rowVersion))fail(409,'VERSION_CONFLICT');
    const approvedAt=new Date().toISOString();
    const saved=await structure.createStructureNode({client,pool:client,security,user,rootEquipmentId:equipmentId,input:{
      parentId:proposal.parent.id,parentRowVersion:proposal.parent.rowVersion,name:proposal.name,code:proposal.code,nodeKind:proposal.level,
      reason:String(input.reason).trim(),requestId:uuid()
    }});
    await client.query(`INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after,review)
      VALUES($1,now(),$2,$3,$4,'dossier-structure-approve','selene-structure',$5,$6,NULL,$7,$8)`,
      [uuid(),user.name||user.username||user.id,user.id,user.role,saved.id,String(input.reason).trim(),JSON.stringify(saved),
        JSON.stringify({revision:plan.revision,proposalId:proposal.id,evidenceIds:proposal.evidenceIds,sourceStatus:proposal.sourceStatus,
          taxonomy:proposal.taxonomy,approvedBy:user.id,approvedAt,model:plan.model,provider:plan.provider})]);
    await client.query('COMMIT');
    return {committed:true,data:saved,proposalId:proposal.id,revision:plan.revision,evidenceIds:proposal.evidenceIds,approvedBy:user.id,approvedAt};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});if(['40001','40P01'].includes(error.code))throw coded(409,'PROPOSAL_REVISION_CHANGED');throw error;}
  finally{client.release();}
}

function buildStageProposals({rows=[],root,existing=[],parentId=null}) {
  const active=existing.filter(row=>!row.deleted_at),currentDepths=active.map(row=>Number(row.depth)||0);
  const depth=parentId?active.find(row=>String(row.id)===String(parentId))?.depth:Math.max(0,...currentDepths);
  if(depth==null) return {stage:null,items:[],error:'PARENT_NOT_IN_APPROVED_STRUCTURE'};
  const targetDepth=Number(depth)+1,expected={1:'subsystem',2:'main-component',3:'sub-component'}[targetDepth];
  if(!expected)return {stage:null,items:[],error:'STRUCTURE_DEPTH_EXCEEDED'};
  const parent=parentId?active.find(row=>String(row.id)===String(parentId)):root;
  if(!parent|| (targetDepth===1&&parent.id!==root.id))return {stage:expected,items:[],error:'INVALID_PARENT'};
  const expectedParentCode=String(parent.code||'').toLowerCase();
  const parentMatchesFact=row=>{const code=String(row.parentCode||'').toLowerCase();return targetDepth===1?(!code||code===expectedParentCode):code===expectedParentCode;};
  const candidateRows=rows.filter(row=>row.kind===expected||parentMatchesFact(row)).sort((a,b)=>String(a.code).localeCompare(String(b.code),'en'));
  const codeFrequency=new Map();for(const row of candidateRows){const key=String(row.code||'').toLowerCase();codeFrequency.set(key,(codeFrequency.get(key)||0)+1);}
  const ancestors=new Set();let ancestor=parent;for(let depthWalk=0;ancestor&&depthWalk<4;depthWalk++){
    if(ancestor.code)ancestors.add(String(ancestor.code).toLowerCase());
    ancestor=active.find(row=>String(row.id)===String(ancestor.parent));
  }
  const items=candidateRows.map(row=>{
    const key=String(row.code||'').toLowerCase(),duplicateInSource=(codeFrequency.get(key)||0)>1;
    const existingCode=active.find(node=>[node.code,node.old_code].some(code=>String(code||'').toLowerCase()===key));
    const parentMatches=parentMatchesFact(row);
    const conflictStatus=row.kind!==expected?'level-change-blocked':duplicateInSource?'duplicate':ancestors.has(key)?'cycle':existingCode?'duplicate':!parentMatches?'invalid-parent':!row.valid?'invalid-source':'none';
    const proposalId=crypto.createHash('sha256').update([expected,key,parent.id,row.evidenceId||'',row.sourceHash||''].join('|')).digest('hex').slice(0,24);
    return {id:`proposal-${proposalId}`,name:row.name,code:row.code,level:row.kind,parent:{id:String(parent.id),code:parent.code||null,name:parent.name||null,rowVersion:Number(parent.row_version)||null},
      diff:{operation:existingCode?'blocked-conflict':'create',before:existingCode?{id:existingCode.id,code:existingCode.code,name:existingCode.name,parentId:existingCode.parent}:null,
        after:{code:row.code,name:row.name,level:row.kind,parentId:String(parent.id)}},
      function:row.function||null,reason:row.reason||'استخراج ساختاری صریح از سند منبع تأییدشده؛ پیش از ثبت نیازمند بازبینی انسانی است.',
      evidenceIds:row.evidenceId?[row.evidenceId]:[],provenance:{source:'approved_equipment_document',sourceHash:row.sourceHash||null,revision:row.sourceRevision||null},confidence:row.valid&&row.state!=='proposed'?1:null,
      sourceStatus:row.valid&&row.state!=='proposed'?'source-confirmed':'proposed',taxonomy:{standard:'ISO 14224',classCode:null,status:'unmapped'},reviewStatus:'pending_review',conflictStatus,
      cycleStatus:conflictStatus==='cycle'?'blocked':'clear',action:conflictStatus==='none'?'preview-only':'blocked'};
  });
  const revision=crypto.createHash('sha256').update(JSON.stringify({equipment:root.id,stage:expected,parent:{id:parent.id,rowVersion:parent.row_version},items})).digest('hex');
  return {stage:expected,parent:{id:String(parent.id),name:parent.name||null,code:parent.code||null,rowVersion:Number(parent.row_version)||null},revision,items,writePerformed:false};
}
module.exports={TYPES,PLACEHOLDERS,FIELD_ALIASES,validateDocument,validGlb,filePath,publicDocument,listDocuments,uploadDocument,reviewDocument,getDocumentBytes,
  normalizeField,parseSourceStructureRows,extractTechnicalFacts,analyzeApprovedDocuments,analyzeStructureStage,approveStructureProposal,buildSceneGraph,buildStageProposals};
