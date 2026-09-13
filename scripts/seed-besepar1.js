'use strict';

/**
 * Idempotent PostgreSQL importer for the canonical Bespar 1 dataset.
 * Run after schema.sql / migrations 001 and 002: npm run seed:besepar1
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'besepar1.seed.json'), 'utf8'));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const digits = {'۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'};
const latin = value => String(value || '').replace(/[۰-۹]/g, c => digits[c]);

function jalaliToGregorian(jy, jm, jd) {
  jy=+jy; jm=+jm; jd=+jd;
  let gy=(jy<=979)?621:1600; jy-=(jy<=979)?0:979;
  let days=(365*jy)+(Math.floor(jy/33)*8)+Math.floor(((jy%33)+3)/4)+78+jd+(jm<7?(jm-1)*31:((jm-7)*30)+186);
  gy+=400*Math.floor(days/146097); days%=146097;
  if(days>36524){gy+=100*Math.floor(--days/36524);days%=36524;if(days>=365)days++;}
  gy+=4*Math.floor(days/1461);days%=1461;
  if(days>365){gy+=Math.floor((days-1)/365);days=(days-1)%365;}
  let gd=days+1, leap=(gy%4===0&&gy%100!==0)||gy%400===0;
  const md=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31]; let gm=0;
  while(gm<12&&gd>md[gm])gd-=md[gm++];
  return [gy,gm+1,gd];
}
function dateFromJalali(value) {
  const parts=latin(value).split('/').map(Number); if(parts.length<3)parts.push(1);
  const [y,m,d]=jalaliToGregorian(parts[0],parts[1],parts[2]);
  return new Date(Date.UTC(y,m-1,d,8,0,0));
}

async function upsertUser(client, t) {
  const hash=bcrypt.hashSync('1234',10);
  const {rows}=await client.query(
    `INSERT INTO users(id,username,pass_hash,name,role,unit,active,hr)
     VALUES($1,$2,$3,$4,'tech','نگهداری و تعمیرات — بسپار ۱',true,$5)
     ON CONFLICT(username) DO UPDATE SET name=EXCLUDED.name,unit=EXCLUDED.unit,active=true,
       hr=COALESCE(users.hr,'{}'::jsonb)||EXCLUDED.hr RETURNING id`,
    [t.id,t.username,hash,t.name,JSON.stringify({specialty:t.specialty,dataStatus:'imported'})]
  ); return rows[0].id;
}

async function upsertAsset(client, e, parentId, categoryId) {
  const ext={factory:'بسپار ۱',locationDescription:e.location||'',capacity:e.capacity||'',dailyOperatingHours:e.dailyHours??null,
    criticalityScore:e.criticalityScore??null,keyParts:e.keyParts||[],preventiveMaintenance:e.pm||{},pmReference:e.pmRef||null,
    pmNote:e.pmNote||'',dailyInspection:e.dailyInspection||[],panelCode:e.panel||'',refrigerant:e.refrigerant||'',
    technicalSpecification:e.spec||'',dataStatus:e.dataStatus||'registered',datasetVersion:data.version};
  const history=(e.history||[]).map(h=>({t:dateFromJalali(h.date).toISOString(),x:`${h.type} — ${h.title} — ${h.technician} — ${h.durationHours||'—'} ساعت`,source:'import-verified'}));
  const {rows}=await client.query(
    `INSERT INTO assets(id,parent,code,name,type,cls,status,crit,maker,model,year,install,power,hours,history,ext,category_id,requires_coding)
     VALUES($1,$2,$3,$4,'eq',$5,'active',$6,$7,$8,$9,$10,$11,0,$12,$13,$14,$15)
     ON CONFLICT(code) DO UPDATE SET parent=EXCLUDED.parent,name=EXCLUDED.name,cls=EXCLUDED.cls,status=EXCLUDED.status,
       crit=EXCLUDED.crit,maker=EXCLUDED.maker,model=EXCLUDED.model,year=EXCLUDED.year,install=EXCLUDED.install,
       power=EXCLUDED.power,history=EXCLUDED.history,ext=COALESCE(assets.ext,'{}'::jsonb)||EXCLUDED.ext,
       category_id=EXCLUDED.category_id,requires_coding=EXCLUDED.requires_coding RETURNING id`,
    [e.id,parentId,e.code,e.name,e.parentEquipment?'زیرتجهیز':e.category,e.criticality||'C',e.maker||null,e.model||null,e.year||null,e.install||null,e.capacity||null,JSON.stringify(history),JSON.stringify(ext),categoryId,!!e.requiresCoding]
  ); return rows[0].id;
}

async function run() {
  const client=await pool.connect();
  const stats={categories:0,technicians:0,equipment:0,spares:0,pms:0,historicalWos:0,workOrders1405:0};
  try{
    // The extension migration is idempotent and is applied before the data transaction.
    const migration=fs.readFileSync(path.join(__dirname,'..','migrations','002_bespar1_master_data.sql'),'utf8');
    await client.query(migration);
    await client.query('BEGIN');
    const {rows:companyRows}=await client.query(
      `INSERT INTO assets(id,parent,code,name,type,cls,status,ext) VALUES('bfg-company',NULL,'BFG','شرکت بسپار فوم غرب','site','شرکت','active',$1)
       ON CONFLICT(code) DO UPDATE SET parent=NULL,name=EXCLUDED.name,cls=EXCLUDED.cls,ext=COALESCE(assets.ext,'{}'::jsonb)||EXCLUDED.ext RETURNING id`,
      [JSON.stringify({datasetVersion:data.version,hierarchyVersion:'1.0'})]
    );
    const companyId=companyRows[0].id;
    await client.query(
      `INSERT INTO assets(id,parent,code,name,type,cls,status,ext) VALUES('bfg-head-office',$1,'BFG-HQ','دفتر مرکزی','unit','دفتر مرکزی','active',$2)
       ON CONFLICT(code) DO UPDATE SET parent=EXCLUDED.parent,name=EXCLUDED.name,cls=EXCLUDED.cls,ext=EXCLUDED.ext`,
      [companyId,JSON.stringify({datasetVersion:data.version})]
    );
    const {rows:factoryGroupRows}=await client.query(
      `INSERT INTO assets(id,parent,code,name,type,cls,status,ext) VALUES('bfg-factories',$1,'BFG-PLANTS','کارخانجات','unit','کارخانجات','active',$2)
       ON CONFLICT(code) DO UPDATE SET parent=EXCLUDED.parent,name=EXCLUDED.name,cls=EXCLUDED.cls,ext=EXCLUDED.ext RETURNING id`,
      [companyId,JSON.stringify({datasetVersion:data.version})]
    );
    const factoryGroupId=factoryGroupRows[0].id;
    const rootResult=await client.query(
      `INSERT INTO assets(id,parent,code,name,type,cls,status,ext) VALUES($1,$2,$3,$4,'site','کارخانه','active',$5)
       ON CONFLICT(code) DO UPDATE SET parent=EXCLUDED.parent,name=EXCLUDED.name,ext=COALESCE(assets.ext,'{}'::jsonb)||EXCLUDED.ext RETURNING id`,
      [data.factory.id,factoryGroupId,data.factory.code,data.factory.name,JSON.stringify({datasetVersion:data.version})]
    );
    const rootId=rootResult.rows[0].id;
    const categories={};
    for(const c of data.categories){
      const nodeResult=await client.query(
        `INSERT INTO assets(id,parent,code,name,type,cls,status,ext) VALUES($1,$2,$3,$4,'unit',$4,'active',$5)
         ON CONFLICT(code) DO UPDATE SET parent=EXCLUDED.parent,name=EXCLUDED.name,ext=EXCLUDED.ext RETURNING id`,
        [c.id,rootId,c.code,c.name,JSON.stringify({nodeKind:'category',sortOrder:c.sortOrder})]
      );
      const nodeId=nodeResult.rows[0].id;
      const {rows}=await client.query(
        `INSERT INTO asset_categories(id,factory_asset_id,code,name,sort_order,metadata)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(factory_asset_id,code) DO UPDATE SET name=EXCLUDED.name,
         sort_order=EXCLUDED.sort_order,metadata=EXCLUDED.metadata RETURNING id`,
        [c.id,rootId,c.code,c.name,c.sortOrder,JSON.stringify({treeAssetId:nodeId,datasetVersion:data.version})]
      ); categories[c.name]={nodeId,categoryId:rows[0].id};stats.categories++;
    }
    // Apply the same mandatory organizational category tree to Bespar 2–6.
    for(const f of data.otherFactories||[]){
      const {rows:siteRows}=await client.query(
        `INSERT INTO assets(id,parent,code,name,type,cls,status,ext) VALUES($1,$2,$3,$4,'site','کارخانه','active',$5)
         ON CONFLICT(code) DO UPDATE SET parent=EXCLUDED.parent,name=EXCLUDED.name,ext=COALESCE(assets.ext,'{}'::jsonb)||EXCLUDED.ext RETURNING id`,
        [f.id,factoryGroupId,f.code,f.name,JSON.stringify({datasetVersion:data.version,categoryTemplate:'Bespar-standard-v1'})]
      );
      for(let index=0;index<data.categories.length;index++){
        const c=data.categories[index],code=`${f.code}-CAT-${String(index+1).padStart(2,'0')}`,id=`${f.id}-cat-${index+1}`;
        const {rows:nodeRows}=await client.query(
          `INSERT INTO assets(id,parent,code,name,type,cls,status,ext) VALUES($1,$2,$3,$4,'unit',$4,'active',$5)
           ON CONFLICT(code) DO UPDATE SET parent=EXCLUDED.parent,name=EXCLUDED.name,ext=EXCLUDED.ext RETURNING id`,
          [id,siteRows[0].id,code,c.name,JSON.stringify({nodeKind:'category',sortOrder:index+1})]
        );
        await client.query(
          `INSERT INTO asset_categories(id,factory_asset_id,code,name,sort_order,metadata) VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(factory_asset_id,code) DO UPDATE SET name=EXCLUDED.name,sort_order=EXCLUDED.sort_order,metadata=EXCLUDED.metadata`,
          [id,siteRows[0].id,code,c.name,index+1,JSON.stringify({treeAssetId:nodeRows[0].id,datasetVersion:data.version})]
        );stats.categories++;
      }
    }

    const techIds={};
    for(const t of data.technicians){techIds[t.id]=await upsertUser(client,t);stats.technicians++;}

    const assetIds={};
    for(const e of data.equipment){
      const parentId=e.parentEquipment?(assetIds[e.parentEquipment]||e.parentEquipment):categories[e.category].nodeId;
      assetIds[e.id]=await upsertAsset(client,e,parentId,categories[e.category].categoryId);stats.equipment++;
    }

    for(const item of data.spareParts){
      const {rows}=await client.query(
        `INSERT INTO items(id,code,name,unit,stock,min_stock,price,loc,cat,key_for,ext)
         VALUES($1,$2,$3,$4,$5,$6,$7,'انبار فنی بسپار ۱','قطعات یدکی ماشین‌آلات',$8,$9)
         ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,unit=EXCLUDED.unit,stock=EXCLUDED.stock,
         min_stock=EXCLUDED.min_stock,price=EXCLUDED.price,key_for=EXCLUDED.key_for,ext=EXCLUDED.ext RETURNING id`,
        [item.id,item.code,item.name,item.unit,item.stock,item.minStock,item.priceToman,JSON.stringify(item.keyFor.map(id=>assetIds[id]||id)),JSON.stringify({currency:'TOMAN',supplyStatus:item.supplyStatus,factory:'بسپار ۱'})]
      );
      for(const canonicalAssetId of item.keyFor){await client.query(
        `INSERT INTO asset_spare_parts(asset_id,item_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[assetIds[canonicalAssetId]||canonicalAssetId,rows[0].id]);}
      stats.spares++;
    }

    for(const p of data.pmPlans){await client.query(
      `INSERT INTO pm_plans(id,asset_id,title,interval_days,last_run,spec,kind,checklist,status,recurring,source_ref,ext)
       VALUES($1,$2,$3,$4,$5,'مکانیک',$6,$7,$8,$9,$10,$11)
       ON CONFLICT(id) DO UPDATE SET asset_id=EXCLUDED.asset_id,title=EXCLUDED.title,interval_days=EXCLUDED.interval_days,
       kind=EXCLUDED.kind,checklist=EXCLUDED.checklist,status=EXCLUDED.status,recurring=EXCLUDED.recurring,
       source_ref=EXCLUDED.source_ref,ext=EXCLUDED.ext`,
      [p.id,assetIds[p.assetId]||p.assetId,p.title,p.intervalDays,dateFromJalali('۱۴۰۵/۰۱/۰۱'),p.frequency,JSON.stringify(p.checklist||[]),p.status||'active',p.recurring!==false,p.sourceReference||null,JSON.stringify({confirmationStatus:p.confirmationStatus||'confirmed',factory:'بسپار ۱'})]
    );stats.pms++;}

    // Closed work orders for verified records through 1404.
    for(const e of data.equipment){for(let index=0;index<(e.history||[]).length;index++){
      const h=e.history[index], no=`B1-H-${e.code}-${latin(h.date).replace(/\//g,'')}-${String(index+1).padStart(2,'0')}`;
      const tech=data.technicians.find(t=>t.name===h.technician);
      await client.query(
        `INSERT INTO work_orders(id,no,type,asset_id,descr,priority,assignee,status,times,parts,report,est,created_at,confirmation_status,source_metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,'closed',$8,'[]',$9,$10,$11,'confirmed',$12)
         ON CONFLICT(no) DO UPDATE SET asset_id=EXCLUDED.asset_id,descr=EXCLUDED.descr,assignee=EXCLUDED.assignee,
         status='closed',times=EXCLUDED.times,report=EXCLUDED.report,est=EXCLUDED.est,confirmation_status='confirmed'`,
        [`hist-${e.id}-${index}`,no,h.type==='PM'?'PM':'BD',assetIds[e.id]||e.id,h.title,h.type==='EM'?'high':'normal',tech?techIds[tech.id]:null,
         JSON.stringify({end:dateFromJalali(h.date).toISOString(),durationHours:h.durationHours}),JSON.stringify({text:`سابقه ثبت‌شده: ${h.title}`,technicianName:h.technician,durationHours:h.durationHours,dataQuality:'verified-from-source'}),h.durationHours||0,dateFromJalali(h.date),JSON.stringify({source:'equipment-history-through-1404',originalType:h.type,originalJalaliDate:h.date})]
      );stats.historicalWos++;
    }}

    for(const w of data.provisionalWorkOrders1405){
      const primaryAsset=w.assetId?(assetIds[w.assetId]||w.assetId):null;
      const provisional=w.confirmationStatus==='pending-confirmation';
      const dateLabel=w.periodLabel.length===10?w.periodLabel:w.periodLabel+'/۰۱';
      await client.query(
        `INSERT INTO work_orders(id,no,type,asset_id,descr,priority,assignee,status,times,parts,report,created_at,confirmation_status,provisional_fields,period_label,source_metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]',$10,$11,$12,$13,$14,$15)
         ON CONFLICT(no) DO UPDATE SET asset_id=EXCLUDED.asset_id,descr=EXCLUDED.descr,priority=EXCLUDED.priority,
         assignee=EXCLUDED.assignee,status=EXCLUDED.status,times=EXCLUDED.times,report=EXCLUDED.report,
         confirmation_status=EXCLUDED.confirmation_status,provisional_fields=EXCLUDED.provisional_fields,
         period_label=EXCLUDED.period_label,source_metadata=EXCLUDED.source_metadata`,
        [w.id,w.no,w.type,primaryAsset,w.title,w.priority||'normal',techIds[w.assigneeId]||w.assigneeId,w.status,
         JSON.stringify({periodLabel:w.periodLabel,periodOnly:w.periodLabel.length<10,start:null,end:null,requiresConfirmation:provisional}),
         JSON.stringify({confirmationStatus:w.confirmationStatus,assigneeProposed:!!w.assigneeProposed,notes:w.notes||'',dataQualityLabel:provisional?'نیاز به تأیید نهایی':'تأییدشده'}),dateFromJalali(dateLabel),w.confirmationStatus,JSON.stringify(w.provisionalFields||[]),w.periodLabel,
         JSON.stringify({source:'repairs-1405-source-file',sourceType:w.sourceType,additionalAssigneeIds:(w.additionalAssigneeIds||[]).map(id=>techIds[id]||id)})]
      );
      if(primaryAsset)await client.query(`INSERT INTO work_order_assets(work_order_id,asset_id,relation_type,is_confirmed) VALUES($1,$2,'primary',$3) ON CONFLICT DO NOTHING`,[w.id,primaryAsset,!provisional]);
      for(const id of w.relatedAssetIds||[])await client.query(`INSERT INTO work_order_assets(work_order_id,asset_id,relation_type,is_confirmed) VALUES($1,$2,'related',true) ON CONFLICT DO NOTHING`,[w.id,assetIds[id]||id]);
      for(const id of w.candidateAssetIds||[])await client.query(`INSERT INTO work_order_assets(work_order_id,asset_id,relation_type,is_confirmed) VALUES($1,$2,'candidate',false) ON CONFLICT DO NOTHING`,[w.id,assetIds[id]||id]);
      stats.workOrders1405++;
    }

    await client.query('COMMIT');
    console.log('Bespar 1 seed completed:',stats);
    console.log('Important: provisional 1405 records remain pending-confirmation by design.');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
}

run().catch(error=>{
  const detail=error.message||error.code||(error.errors||[]).map(e=>e.code||e.message).join(', ')||String(error);
  console.error('Bespar 1 seed failed:',detail);
  if(/ECONNREFUSED/.test(detail))console.error('PostgreSQL is unavailable. Start the database configured in DATABASE_URL and run the command again.');
  process.exitCode=1;
});
