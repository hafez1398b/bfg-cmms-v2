/* Mission D4 / Phase 11 — equipment QR label and printable identity card (شناسنامه چاپی).
   Pure rendering contracts: every value comes from the real dossier payload; a missing value
   prints «ثبت نشده» and is never guessed. The QR encodes the dossier deep link so a scan opens
   the same equipment file after sign-in. No browser storage, no fabricated field. */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.BFGEquipmentIdentity=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';

  const NOT_RECORDED='ثبت نشده';
  const COMPANY_DEFAULT='شرکت بسپار فوم غرب';

  function esc(value){
    return String(value==null?'':value).replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
  }
  function text(value){
    if(value==null)return null;
    const normalized=String(value).trim();
    return normalized?normalized:null;
  }
  function shown(value){const clean=text(value);return clean?esc(clean):`<span class="na">${NOT_RECORDED}</span>`;}

  // The dossier route is the existing History API path /equipment/{code}; the code is the
  // unique routing key the registry itself uses. Falls back to the real record id only when
  // no code exists. The base must be the signed-in same-origin address, never localhost.
  // Neither link ever carries a token, session id or secret — authorization happens after the
  // scan, through the authenticated APIs.
  function dossierLink(base,codeOrId){
    const key=text(codeOrId);
    if(!key)throw Object.assign(new Error('EQUIPMENT_KEY_REQUIRED'),{code:'EQUIPMENT_KEY_REQUIRED'});
    const cleanBase=String(base==null?'':base).replace(/\/+$/,'');
    return `${cleanBase}/equipment/${encodeURIComponent(key)}`;
  }
  function passportLink(base,codeOrId){
    return `${dossierLink(base,codeOrId)}/passport`;
  }

  // Real, scannable QR via the shared qrcode-generator encoder. When the encoder is absent
  // the call fails honestly instead of drawing a fake placeholder.
  function qrSvg(markup,size,encoder){
    const factoryFn=encoder||(typeof qrcode==='function'?qrcode:null);
    if(typeof factoryFn!=='function')throw Object.assign(new Error('QR_ENCODER_UNAVAILABLE'),{code:'QR_ENCODER_UNAVAILABLE'});
    const payload=String(markup==null?'':markup);
    if(!payload)throw Object.assign(new Error('QR_PAYLOAD_REQUIRED'),{code:'QR_PAYLOAD_REQUIRED'});
    const px=Number(size)||220;
    const qr=factoryFn(0,'M');
    qr.addData(payload);
    qr.make();
    const count=qr.getModuleCount(),cell=px/(count+8),offset=cell*4;
    let rects='';
    for(let row=0;row<count;row+=1)for(let col=0;col<count;col+=1){
      if(qr.isDark(row,col))rects+=`<rect x="${(offset+col*cell).toFixed(2)}" y="${(offset+row*cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" role="img" aria-label="QR پرونده تجهیز" style="width:100%;height:100%;display:block"><rect width="${px}" height="${px}" fill="#fff"/><g fill="#111">${rects}</g></svg>`;
  }

  function identityRows(asset,labels){
    const a=asset||{},ext=a.ext&&typeof a.ext==='object'?a.ext:{},l=labels||{};
    return [
      ['کد تجهیز',a.code],['نام تجهیز',a.name],
      ['کارخانه',a.factory_name],['دسته تجهیز',a.category_name],
      ['محل استقرار',ext.locationDescription||a.location_name],['نوع فعالیت',a.activity_type],
      ['کلاس',a.cls],['وضعیت فنی',l.status!=null?l.status:a.status],
      ['وضعیت بهره‌برداری',l.operationalStatus!=null?l.operationalStatus:a.operational_status],
      ['بحرانیت',a.crit],['سازنده',a.maker],['کشور سازنده',a.manufacturer_country],
      ['مدل',a.model],['شماره سریال',a.serial],['سال ساخت',a.year],
      ['تاریخ نصب',l.installDate!=null?l.installDate:(a.install_date||a.install)],
      ['توان',a.power],['ظرفیت',ext.capacity],['مسئول تجهیز',a.responsible_name],
      ['کارکرد روزانه',ext.dailyOperatingHours==null?null:`${ext.dailyOperatingHours} ساعت`],
      ['شرح عملکرد',ext.description],['مشخصات فنی',ext.technicalSpecification],
      ['تابلو برق',ext.panelCode],['نوع مبرد',ext.refrigerant],
      ['ملاحظات عمومی',a.general_notes]
    ];
  }

  function sparesSection(spares){
    const state=spares&&spares.state||'unavailable';
    if(state==='unavailable'){
      return `<h2>قطعات یدکی حیاتی</h2><p class="na">فهرست قطعات یدکی حیاتی هنگام چاپ دریافت نشد؛ این بخش ناقص است و باید پس از اتصال دوباره چاپ شود.</p>`;
    }
    const rows=Array.isArray(spares&&spares.rows)?spares.rows:[];
    if(!rows.length){
      return `<h2>قطعات یدکی حیاتی</h2><p class="na">قطعه یدکی حیاتی متصل به قلم واقعی انبار ثبت نشده است.</p>`;
    }
    const body=rows.map(part=>`<tr>
      <td>${shown(part.code)}</td><td>${shown(part.name)}</td>
      <td>${shown(part.relationLabel||part.relationType)}</td>
      <td>${part.quantityRequired==null?`<span class="na">${NOT_RECORDED}</span>`:esc(part.quantityRequired)}</td>
      <td>${shown(part.unit)}</td>
      <td>${part.stockAvailable==null?`<span class="na">${NOT_RECORDED}</span>`:esc(part.stockAvailable)}</td>
    </tr>`).join('');
    return `<h2>قطعات یدکی حیاتی</h2>
      <p class="muted">فقط اتصال‌های واقعی به قلم انبار؛ موجودی قابل دسترس از دفتر انبار خوانده می‌شود.</p>
      <table class="grid"><thead><tr><th>کد قلم</th><th>نام قلم</th><th>نوع اتصال</th><th>تعداد موردنیاز</th><th>واحد</th><th>موجودی قابل دسترس</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  const PRINT_CSS=`
    @page{size:A4;margin:12mm}
    *{box-sizing:border-box}
    body{font-family:Vazirmatn,Tahoma,sans-serif;color:#10202f;margin:0;padding:14px;font-size:11px;line-height:1.8}
    .sheet{max-width:186mm;margin:0 auto}
    .head{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:2.5px solid #10202f;padding-bottom:10px}
    .head .brand{display:flex;align-items:center;gap:10px}
    .head img{width:52px;height:52px;border-radius:10px;object-fit:cover}
    .head h1{font-size:15px;margin:0}
    .head small{color:#456;display:block;font-size:9.5px}
    .qrbox{width:96px;text-align:center;flex:none}
    .qrbox .frame{width:96px;height:96px;border:1.5px solid #10202f;border-radius:8px;padding:4px;background:#fff}
    .qrbox small{font-size:8px;color:#456;display:block;margin-top:3px}
    .title{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:12px 0 8px}
    .title h2{font-size:14px;margin:0}
    .title .code{font-size:13px;font-weight:800;direction:ltr}
    h2{font-size:12px;margin:14px 0 6px;border-right:3px solid #10202f;padding-right:7px}
    table.grid{width:100%;border-collapse:collapse;font-size:10.5px}
    table.grid th,table.grid td{border:1px solid #9ab;padding:5px 7px;text-align:right;vertical-align:top}
    table.grid th{background:#eef3f8;font-size:10px}
    table.fields td.k{width:16%;background:#f6f9fc;font-weight:700;color:#345}
    table.fields td.v{width:34%}
    .na{color:#889}
    .muted{color:#567;font-size:9.5px;margin:4px 0}
    .foot{margin-top:14px;border-top:1.5px solid #10202f;padding-top:8px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:9px;color:#456}
    .foot .link{direction:ltr;font-size:8.5px;word-break:break-all}
    .signatures{display:flex;gap:14px;margin-top:16px}
    .signatures div{flex:1;border:1px dashed #9ab;border-radius:8px;padding:8px;min-height:52px;font-size:9.5px;color:#456}
    @media print{body{padding:0}.noprint{display:none}.sheet{page-break-after:always}.sheet:last-child{page-break-after:auto}}
    .noprint{margin:0 auto 12px;max-width:186mm;text-align:left}
    .noprint button{font:inherit;padding:7px 16px;border-radius:8px;border:1px solid #10202f;background:#10202f;color:#fff;cursor:pointer}
  `;

  // The A4 sheet markup, shared by the single print document, the batch document and the
  // in-app passport route. model: {asset, labels:{status,operationalStatus,installDate},
  // spares:{state,rows}, link, qr, printedBy, printedAt, companyName, logo}
  function identitySheetHtml(model){
    const m=model||{},a=m.asset||{};
    if(!text(a.code)&&!text(a.name))throw Object.assign(new Error('EQUIPMENT_DATA_REQUIRED'),{code:'EQUIPMENT_DATA_REQUIRED'});
    const rows=identityRows(a,m.labels);
    const fieldRows=[];
    for(let index=0;index<rows.length;index+=2){
      const left=rows[index],right=rows[index+1]||[null,null];
      fieldRows.push(`<tr><td class="k">${esc(left[0])}</td><td class="v">${shown(left[1])}</td><td class="k">${right[0]?esc(right[0]):''}</td><td class="v">${right[0]?shown(right[1]):''}</td></tr>`);
    }
    const company=text(m.companyName)||COMPANY_DEFAULT;
    const logo=m.logo?`<img src="${esc(m.logo)}" alt="">`:'';
    const qr=m.qr?`<div class="qrbox"><div class="frame">${m.qr}</div><small>اسکن = پرونده دیجیتال تجهیز</small></div>`:'';
    return `<div class="sheet">
  <div class="head">
    <div class="brand">${logo}<div><h1>${esc(company)}</h1><small>سامانه جامع نگهداری و تعمیرات (CMMS) · پرونده دیجیتال تجهیز</small></div></div>
    ${qr}
  </div>
  <div class="title"><h2>شناسنامه تجهیز</h2><span class="code">${esc(a.code||'')}</span></div>
  <table class="grid fields"><tbody>${fieldRows.join('')}</tbody></table>
  ${sparesSection(m.spares)}
  <div class="signatures"><div>تهیه و تأیید مسئول تجهیز:</div><div>تأیید مدیر نگهداری و تعمیرات:</div></div>
  <div class="foot">
    <span>تاریخ چاپ: ${shown(m.printedAt)} · چاپ‌کننده: ${shown(m.printedBy)}</span>
    <span>منبع داده: PostgreSQL — مقدار ثبت‌نشده حدس زده نمی‌شود.</span>
    <span class="link">${esc(m.link||'')}</span>
  </div>
</div>`;
  }

  function printDocument(title,body){
    return `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<title>${esc(title)}</title><style>${PRINT_CSS}</style></head>
<body>
<div class="noprint"><button onclick="window.print()">🖨️ چاپ</button></div>
${body}
</body></html>`;
  }

  function identityCardHtml(model){
    const a=(model||{}).asset||{};
    return printDocument(`شناسنامه تجهیز — ${esc(a.code||a.name||'')}`,identitySheetHtml(model));
  }

  // Group A4 printing: one real passport per page. models is an array of the same model shape;
  // failed loads are reported honestly on a final notice page instead of being invented.
  function identityBatchHtml(models,failures){
    const list=Array.isArray(models)?models:[];
    const sheets=list.map(model=>identitySheetHtml(model)).join('\n');
    const failed=Array.isArray(failures)?failures.filter(Boolean):[];
    const notice=failed.length?`<div class="sheet"><h2>شناسنامه‌های دریافت‌نشده</h2>
      <p class="na">دادهٔ واقعی این تجهیزات هنگام چاپ گروهی دریافت نشد و چاپ نشدند؛ هیچ مقداری ساخته نشد:</p>
      <ul>${failed.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></div>`:'';
    return printDocument(`چاپ گروهی شناسنامه تجهیزات (${list.length})`,sheets+notice);
  }

  // Small stick-on label: QR + code + name, same deep link as the identity card.
  function qrLabelHtml(model){
    const m=model||{},a=m.asset||{};
    const company=text(m.companyName)||COMPANY_DEFAULT;
    const logo=m.logo?`<img src="${esc(m.logo)}" style="width:16px;height:16px;border-radius:4px" alt="">`:'';
    return `<div style="display:inline-block;width:150px;border:1.5px solid #333;border-radius:9px;padding:8px;margin:5px;text-align:center;page-break-inside:avoid;vertical-align:top;background:#fff">
      <div style="display:flex;align-items:center;gap:5px;justify-content:center;margin-bottom:4px">${logo}<b style="font-size:8.5px">${esc(company)}</b></div>
      <div style="width:112px;height:112px;margin:0 auto">${m.qr||''}</div>
      <div style="font-size:9.5px;font-weight:800;margin-top:4px;direction:ltr">${esc(a.code||'')}</div>
      <div style="font-size:8px;color:#444">${esc(String(a.name||'').slice(0,30))}</div>
    </div>`;
  }

  function labelsSheetHtml(model,copies){
    const m=model||{},a=m.asset||{};
    const count=Math.max(1,Math.min(Number(copies)||3,12));
    const labels=Array.from({length:count},()=>qrLabelHtml(m)).join('');
    return `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<title>برچسب QR تجهیز — ${esc(a.code||'')}</title>
<style>@page{margin:9mm}body{font-family:Vazirmatn,Tahoma,sans-serif;padding:10px;text-align:center}</style></head>
<body>${labels}
<div style="font-size:9px;color:#888;margin-top:8px">اسکن این کد پس از ورود به سامانه، پرونده دیجیتال همین تجهیز را باز می‌کند.</div>
</body></html>`;
  }

  return {NOT_RECORDED,dossierLink,passportLink,qrSvg,identityRows,identitySheetHtml,identityCardHtml,identityBatchHtml,qrLabelHtml,labelsSheetHtml};
});
