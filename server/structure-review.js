'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const domain = require('./equipment-structure');
const { compare, digest, readInput } = require('./structure-analysis');
const { coded } = require('./equipment-service');

const mutations = {
  create: domain.createStructureNode, edit: domain.updateStructureNode, move: domain.moveStructureNode,
  archive: domain.archiveStructureNode, restore: domain.restoreStructureNode
};
const allowed = new Set([...Object.keys(mutations),'move_edit']);

// A previously registered attachment is evidence only for its own approved request,
// equipment and explicit inventory of that equipment. A matching filename is not proof.
async function fileEvidence(client,user,root,parsed,locked,requestStorageDir) {
  const roots=parsed.rows.filter(r=>r.kind==='equipment');
  if (parsed.source.type==='dossier-notes' || roots.length!==1 || !roots[0].valid ||
      roots[0].code!==root.code || roots[0].name!==root.name || roots[0].state!=='active') return null;
  if (!(await domain.hasPermission({pool:client,user,permission:'request.view'}))) return null;
  const {rows}=await client.query(`SELECT f.id,f.sha256,f.stored_name,f.byte_size,r.id AS request_id FROM request_files f
    JOIN requests r ON r.id=f.request_id WHERE f.sha256=$1 AND r.asset_id=$2
    AND r.deleted_at IS NULL AND f.deleted_at IS NULL AND r.approved_at>=f.created_at
    AND (r.requester_id=$3 OR $4='admin') ORDER BY f.id LIMIT 1 ${locked?'FOR SHARE OF r,f':''}`,
    [parsed.source.hash,root.id,user.id,user.role]);
  const file=rows[0];
  if (!file || !/^[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i.test(file.stored_name)) return null;
  const rootDir=path.resolve(requestStorageDir || process.env.REQUEST_ATTACHMENT_DIR || path.join(__dirname,'..','storage','request-files'));
  const full=path.resolve(rootDir,file.stored_name);
  if (!full.startsWith(rootDir+path.sep)) return null;
  try {
    const bytes=await fs.readFile(full);
    if (bytes.length!==Number(file.byte_size) || crypto.createHash('sha256').update(bytes).digest('hex')!==file.sha256 || file.sha256!==parsed.source.hash) return null;
  } catch (_) { return null; }
  return {type:'request_file',id:file.id,requestId:file.request_id,hash:file.sha256};
}

async function snapshot(client,user,id,input,locked,requestStorageDir) {
  const ctx={pool:client,user};
  for (const permission of ['equipment.structure.view','equipment.structure.suggest']) await domain.assertPermission(ctx,permission);
  if (locked) {
    // Prevent scope/permission revocations and reparenting of the factory chain during the batch.
    await client.query('SELECT 1 FROM role_permissions WHERE role=$1 AND granted FOR SHARE',[user.role]);
    await client.query('SELECT 1 FROM user_scopes WHERE user_id=$1 FOR SHARE',[user.id]);
    await client.query(`WITH RECURSIVE chain(id,parent) AS (
      SELECT id,parent FROM assets WHERE id=$1 UNION SELECT a.id,a.parent FROM assets a JOIN chain ON a.id=chain.parent
    ) SELECT a.id FROM assets a JOIN chain ON a.id=chain.id ORDER BY a.id FOR SHARE OF a`,[id]);
    await client.query('SELECT c.id FROM asset_categories c JOIN assets a ON c.id=a.category_id WHERE a.id=$1 FOR SHARE OF c',[id]);
  }
  const root=await domain.rootForAsset(client,user,id);
  if (root.id!==id) throw coded(422,'ROOT_EQUIPMENT_MISMATCH');
  const {rows}=await client.query(`WITH RECURSIVE tree(id,depth,path) AS (
    SELECT a.id,0,ARRAY[a.id] FROM assets a WHERE id=$1 AND type='eq' AND deleted_at IS NULL
    UNION ALL SELECT c.id,t.depth+1,t.path||c.id FROM assets c JOIN tree t ON c.parent=t.id
    WHERE c.type='eq' AND t.depth<4 AND NOT c.id=ANY(t.path)
  ) SELECT a.id,a.parent,a.code,a.name,a.ext->>'oldCode' old_code,a.ext->>'structureKind' stored_kind,a.ext->>'nodeKind' registry_kind,a.row_version,a.deleted_at,t.depth,
    CASE WHEN t.depth=0 THEN a.general_notes END notes FROM tree t JOIN assets a ON a.id=t.id
    ORDER BY a.id ${locked?'FOR UPDATE OF a':''}`, [id]);
  if (rows.some(n=>n.depth>3)) throw coded(409,'STRUCTURE_DEPTH_EXCEEDED');
  const notes=rows.find(n=>n.id===id)?.notes || '';
  const nodes=rows.map(({notes,...node})=>node);
  const parsed=readInput(input,notes);
  const fileProof=await fileEvidence(client,user,root,parsed,locked,requestStorageDir);
  const plan=compare(nodes,input,notes,id,parsed,fileProof);
  // Global uniqueness (including archived records), without disclosing out-of-scope rows.
  const creates=plan.items.filter(i=>i.action==='create');
  if (creates.length) {
    const codes=(await client.query('SELECT lower(code) AS code FROM assets WHERE lower(code)=ANY($1::text[])',
      [creates.map(i=>i.fact.code.toLowerCase())])).rows.map(r=>r.code);
    for (const item of creates) if (codes.includes(item.fact.code.toLowerCase())) {item.action='conflict';item.provenance='conflicting';}
  }
  plan.revision=digest(JSON.stringify([plan.revision,plan.items.map(i=>i.action)]));
  return plan;
}

async function applyBatch(client,user,id,plan,selection,reason) {
  const created=new Map(), auditIds=[], approvalId=crypto.randomUUID();
  const approval={id:approvalId,userId:user.id,revision:plan.revision,selection,reason};
  const ordered=selection.map(i=>plan.items[i]).sort((a,b)=>(a.parent?.depth??0)-(b.parent?.depth??0));
  for (const item of ordered) {
    let node=item.current;
    const parentId=item.parent.id ?? created.get(item.parent.sourceIndex);
    if (!parentId) throw coded(409,'PARENT_SELECTION_REQUIRED');
    for (const action of item.action==='move_edit'?['move','edit']:[item.action]) {
      // All base versions were checked under lock before any command. Versions can now
      // advance ONLY through earlier commands in this transaction (e.g. sibling creates).
      const rowId=action==='create'?parentId:node.id;
      const version=(await client.query('SELECT row_version FROM assets WHERE id=$1 FOR UPDATE',[rowId])).rows[0].row_version;
      const input={reason,rowVersion:version};
      if (action==='create') Object.assign(input,{name:item.fact.name,code:item.fact.code,nodeKind:item.fact.kind,parentId,parentRowVersion:version});
      if (action==='edit') input.name=item.fact.name;
      if (action==='move') input.parentId=parentId;
      const after=await mutations[action]({client,pool:client,user,rootEquipmentId:id,id:node?.id,input});
      if (action==='create') created.set(item.index,after.id);
      const auditId=crypto.randomUUID();
      await client.query(`INSERT INTO audit_x(id,t,u,uid,role,action,mod,entity,note,before,after,review)
        VALUES($1,now(),$2,$3,$4,$5,'selene-structure',$6,$7,$8,$9,$10)`,[auditId,user.name||user.id,user.id,user.role,action,after.id,reason,
        node?JSON.stringify(node):null,JSON.stringify(after),JSON.stringify({source:plan.source,evidence:item.evidence,fact:item.fact,approval})]);
      auditIds.push(auditId);node=after;
    }
  }
  return {committed:true,auditIds,approvalId,revision:plan.revision};
}

// Confirmation is consumed in the same transaction: no reusable bearer approval and no
// persisted draft write before review. Only selections from the exact preview can execute.
async function review({pool,user,id,input={},execute=false,requestStorageDir}) {
  const client=await pool.connect();
  try {
    await client.query(execute?'BEGIN ISOLATION LEVEL SERIALIZABLE':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const plan=await snapshot(client,user,id,input,false,requestStorageDir);
    let result=plan;
    if (execute) {
      await domain.assertPermission({pool:client,user},'equipment.structure.approve_ai');
      const {selected,revision,reason}=input;
      if (input.confirmed!==true || !Array.isArray(selected)||!selected.length||selected.length>100||typeof reason!=='string'||!reason.trim()||reason.length>500) throw coded(422,'EXPLICIT_APPROVAL_REQUIRED');
      if (revision!==plan.revision) throw coded(409,'REVIEW_REVISION_CHANGED');
      if (new Set(selected).size!==selected.length || selected.some(i=>!Number.isInteger(i)||!allowed.has(plan.items[i]?.action)||!plan.items[i]?.evidence)) throw coded(422,'SELECTION_NOT_EXECUTABLE');
      const locked=await snapshot(client,user,id,input,true,requestStorageDir);
      if (locked.revision!==revision) throw coded(409,'REVIEW_REVISION_CHANGED');
      result=await applyBatch(client,user,id,locked,selected,reason.trim());
    }
    await client.query('COMMIT');return result;
  } catch (e) {
    await client.query('ROLLBACK');
    if (['40001','40P01'].includes(e.code)) throw coded(409,'REVIEW_REVISION_CHANGED');
    throw e;
  } finally { client.release(); }
}
module.exports={review};
