'use strict';

const { createHash } = require('node:crypto');
const { validateImportFile } = require('./import-file-policy');
const { extractXlsx } = require('./import-extract');
const { coded } = require('./equipment-service');
const { canonicalKindAtDepth } = require('./equipment-structure');

const digest = input => createHash('sha256').update(input).digest('hex');
const kinds = new Map(Object.entries({equipment:'equipment', تجهیز:'equipment', subsystem:'subsystem', زیرسیستم:'subsystem',
  'main component':'main-component', 'main-component':'main-component', 'جزء اصلی':'main-component',
  subcomponent:'sub-component', 'sub-component':'sub-component', 'جزء فرعی':'sub-component'}));

// A deliberately small data grammar, not an instruction prompt. Only literal table cells
// can describe structure. No formulas, prose, technical attributes or generated codes.
function facts(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text)>128*1024) throw coded(413,'STRUCTURE_INPUT_TOO_LARGE');
  const rows=[];
  for (const line of text.split(/\r?\n/)) {
    const cells=line.trim().replace(/^\||\|$/g,'').split(line.includes('\t')?'\t':'|').map(s=>s.trim());
    const [level,code,name,parentCode='',state='active']=cells;
    const kind=kinds.get(level.toLowerCase());
    if (!kind) continue;
    const valid=cells.length<=5 && !!code && !!name && (kind==='equipment'||!!parentCode) && code.length<=120 && name.length<=240 && parentCode.length<=120 && ['active','archive','restore','proposed'].includes(state) && cells.every(s=>!/[\u0000-\u001f]/.test(s));
    rows.push({kind,code,name,parentCode,state,valid});
    if (rows.length>100) throw coded(413,'STRUCTURE_ROW_LIMIT');
  }
  return rows;
}

function readInput(input, notes) {
  if (input.file && input.text != null) throw coded(422,'ONE_SOURCE_REQUIRED');
  if (!input.file) {
    const text=input.text ?? notes;
    return {rows:facts(text),source:{type:input.text==null?'dossier-notes':'text',hash:digest(text)}};
  }
  if (typeof input.file.base64!=='string'||input.file.base64.length>1400000) throw coded(413,'FILE_TOO_LARGE');
  const buffer=Buffer.from(input.file.base64,'base64');
  const file=validateImportFile({name:input.file.name,buffer});
  if (!['md','xlsx'].includes(file.ext)) throw coded(422,'FILE_TYPE_REJECTED');
  let content;
  try { content=file.ext==='xlsx'?extractXlsx(buffer):buffer.toString('utf8'); }
  catch (_) { throw coded(422,'INVALID_WORKBOOK'); }
  return {rows:facts(content),source:{type:file.ext,hash:file.sha256,name:file.originalName}};
}

const key=s=>String(s||'').toLowerCase();
function candidates(nodes,code) {
  return nodes.filter(n=>code && (key(n.code)===key(code)||key(n.old_code)===key(code)));
}
function kindConflict(n) {
  if (!n) return false;
  const expected=canonicalKindAtDepth(n.depth);
  if (n.stored_kind) return n.stored_kind!==expected;
  return n.registry_kind && n.registry_kind!=='equipment' && n.registry_kind!==expected && !(n.depth===1&&n.registry_kind==='sub-equipment');
}
function select(rows,id) { return id ? rows.find(n=>n.id===id) : rows.length===1 ? rows[0] : null; }

function compare(nodes, input, notes, rootId, parsed=readInput(input,notes), fileProof=null) {
  const reference=facts(notes).filter(r=>r.valid);
  const evidence={type:'equipment.general_notes',id:rootId,hash:digest(notes)};
  const {rows,source}=parsed;
  const items=rows.map((fact,index)=>{
    const {code,name,kind,parentCode,state}=fact;
    const choice=input.destinations?.[index];
    const matches=candidates(nodes,code), parents=candidates(nodes,parentCode);
    const current=select(matches,choice?.target), parent=select(parents,choice?.parent);
    const noteProof=reference.some(r=>JSON.stringify(r)===JSON.stringify(fact));
    const proof=fileProof || (noteProof?evidence:null);
    const item={index,fact,current:current||null,parent:parent||null,candidates:matches,parentCandidates:parents,
      provenance:proof?'source':'proposed',confidence:proof?1:null,evidence:proof,derived:{match:current?(key(current.code)===key(code)?'exact':'legacy'):null,level:current?canonicalKindAtDepth(current.depth):null},action:'conflict'};
    if (!proof||state==='proposed') return {...item,action:'suggested',status:'needs_review'};
    if (kindConflict(current)||kindConflict(parent)||!fact.valid || (reference.some(r=>key(r.code)===key(code)) && (!noteProof || reference.filter(r=>key(r.code)===key(code)).length!==1)) || rows.filter(r=>key(r.code)===key(code)).length!==1 || (matches.length&&!current) || (choice?.target&&!current) || (choice?.parent&&!parent)) return item;
    if (kind==='equipment') return {...item,action:current?.id===rootId&&name===current.name&&state==='active'?'unchanged':'conflict'};
    if (!parent&&!parents.length&&!current&&state==='active') return {...item,pendingParent:true};
    if (!parent||parent.deleted_at||canonicalKindAtDepth(parent.depth+1)!==kind || (current && canonicalKindAtDepth(current.depth)!==kind)) return item;
    // The source must explicitly describe the lifecycle change; absence never means archive.
    if (state==='archive'||state==='restore') {
      if (current && current.parent===parent.id && current.name===name && Boolean(current.deleted_at)===(state==='restore')) item.action=state;
    } else if (!current) item.action='create';
    else if (!current.deleted_at) {
      if (current.parent!==parent.id) item.action=current.name===name?'move':'move_edit';
      else item.action=current.name===name?'unchanged':'edit';
    }
    return item;
  });
  for (let depth=2;depth<=3;depth++) {
    for (const i of items.filter(i=>i.pendingParent&&i.fact.kind===canonicalKindAtDepth(depth))) {
      const p=items.find(p=>key(p.fact.code)===key(i.fact.parentCode)&&p.action==='create'&&p.fact.kind===canonicalKindAtDepth(depth-1));
      if (p) { i.parent={sourceIndex:p.index,depth:depth-1}; i.action='create'; }
    }
  }
  // Two different source codes can be aliases for the same real record.
  for (const i of items) if (i.current && items.some(j=>j!==i&&j.current?.id===i.current.id)) i.action='conflict';
  for (const i of items) if (i.action==='conflict') i.provenance='conflicting';
  return {source,items,revision:digest(JSON.stringify([rootId,nodes.find(n=>n.id===rootId)?.row_version,source,items])),status:items.length?'preview':'needs_more_data'};
}
module.exports={facts,compare,digest,readInput};
