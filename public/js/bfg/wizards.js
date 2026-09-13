'use strict';
/* BFG Wizards — all main forms as Stepper (Requirement #5,6)
 * Covers: Maintenance Request, Work Order, Add Equipment, Failure Report, Checklist, PM, Spare Part, Approval
 */
(function(){
  window.BFG = window.BFG || {};
  function esc(s){ return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  // 7-step Maintenance Request Wizard (detailed spec in Requirement #6)
  function openMaintenanceRequestWizard(initial={}){
    const steps = [
      {
        title: 'تجهیز', key: 'assetId', type: 'text', required: true,
        question: 'کدام تجهیز مشکل دارد؟',
        hint: 'از درخت تجهیزات، جستجو، تجهیزات اخیر یا مرتبط با شما انتخاب کنید — یا دستی وارد کنید.',
        // We'll render custom equipment picker via type text + extra UI in wizard-engine
        // To keep it context-aware we use ai suggestions based on user & history
        ai: true, placeholder: 'جستجوی تجهیز…',
      },
      {
        title: 'مشکل', key: 'problem', type: 'options', required: true,
        question: 'مشکل چیست؟',
        hint: 'گزینه‌ها بر اساس سوابق همان تجهیز توسط AI پیشنهاد می‌شود.',
        ai: true,
        options: [
          { label:'لرزش', value:'لرزش', icon:'〰️' },
          { label:'صدای غیرعادی', value:'صدای غیرعادی', icon:'🔊' },
          { label:'نشتی', value:'نشتی', icon:'💧' },
          { label:'افزایش دما', value:'افزایش دما', icon:'🌡️' },
          { label:'کاهش عملکرد', value:'کاهش عملکرد', icon:'📉' },
          { label:'توقف کامل', value:'توقف', icon:'⛔' },
          { label:'خطای الکتریکی', value:'خطای الکتریکی', icon:'⚡' },
        ],
      },
      {
        title: 'شدت', key: 'severity', type: 'options', required: true,
        question: 'شدت مشکل چقدر است؟',
        ai: true,
        options: [
          { label:'کم', value:'low', icon:'🟢' },
          { label:'متوسط', value:'medium', icon:'🟡' },
          { label:'زیاد', value:'high', icon:'🟠' },
          { label:'بحرانی', value:'critical', icon:'🔴' },
        ],
      },
      {
        title: 'توقف', key: 'downtime', type: 'options', required: true,
        question: 'آیا تجهیز متوقف شده؟',
        options: [
          { label:'بله — متوقف', value:'yes', icon:'⛔' },
          { label:'خیر — در حال کار', value:'no', icon:'✅' },
          { label:'عملکرد محدود', value:'limited', icon:'⚠️' },
          { label:'نامشخص', value:'unknown', icon:'❓' },
        ],
      },
      {
        title: 'توضیحات', key: 'description', type: 'text', required: true,
        question: 'توضیحات و شواهد',
        hint: 'متن، عکس، فایل، Measurement یا توضیحات تکمیلی را وارد کنید. عکس‌ها به failure_media ذخیره می‌شود.',
        multiline: true, rows: 4, placeholder: 'شرح دقیق علائم، زمان شروع، اقدامات اولیه…',
      },
      {
        title: 'پیوست', key: 'attachments', type: 'custom', required: false,
        question: 'پیوست‌ها',
        render: (data, wiz)=>{
          const atts = data.attachments || [];
          return `<div class="field"><label>عکس / فایل / Measurement</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
              <label class="btn btn-sm btn-ghost" style="margin:0">📷 افزودن عکس<input type="file" accept="image/*" multiple hidden onchange="BFG.wizards.handleFiles(this,'attachments')"></label>
              <label class="btn btn-sm btn-ghost" style="margin:0">📎 افزودن فایل<input type="file" multiple hidden onchange="BFG.wizards.handleFiles(this,'attachments')"></label>
              <button class="btn btn-sm btn-ghost" onclick="BFG.wizards.addMeasurement()">📏 افزودن اندازه‌گیری</button>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">${atts.map((a,i)=>`<span class="badge b-blue" style="font-size:10px">${a.name||a.filename||'فایل'} <a onclick="BFG.wizards.removeAtt(${i})" style="cursor:pointer">✕</a></span>`).join('')||'<span class="muted" style="font-size:11px">پیوستی ثبت نشده</span>'}</div>
            <div style="margin-top:10px"><label>سطح اضطرار</label>
              <select onchange="BFG.wizardEngine.setValue('urgency', this.value)" style="max-width:220px"><option value="normal">عادی</option><option value="high">فوری</option><option value="critical">اضطراری</option></select>
            </div>
          </div>`;
        }
      },
      { title: 'بازبینی', key: '_summary', type: 'summary', question: 'بازبینی نهایی' },
    ];

    const wiz = window.BFG.wizardEngine.create({
      id: 'maintenance_request',
      title: 'درخواست تعمیر — ویزارد ۷ مرحله‌ای',
      steps,
      onSubmit: async (data)=>{
        // Map to backend /api/requests
        const payload = {
          assetId: data.assetId !== '__manual__' ? data.assetId : null,
          problem: data.problem,
          severity: data.severity,
          downtime: data.downtime,
          description: data.description,
          urgency: data.urgency || (data.severity==='critical'?'critical': data.severity==='high'?'high':'normal'),
          impact: data.downtime === 'yes',
          form: { wizard:'maintenance_request', ...data },
          media: data.attachments || [],
        };
        // Try API, fallback to local DB for demo if offline
        try{
          const res = await window.BFG.api.requests.create(payload);
          if(res.queued){
            toast('درخواست در صف آفلاین قرار گرفت ⏳');
            // also push to local DB for immediate UI
            if(window.DB){ window.DB.requests.unshift({ id: res.id || Date.now(), no: 'WR-PENDING', descr: payload.description, status:'new', ...payload }); if(window.buildMenu) window.buildMenu(); }
            return res;
          }
          const created = res.data || res;
          // Data chain: also create failure if critical?
          if(data.severity==='critical'){
            try{ await window.BFG.api.failures.create({ asset_id: payload.assetId, description: payload.description, severity:'critical', provenance:'verified', symptoms:[payload.problem] }); }catch(_){}
          }
          // Audit is server-side, but also local audit for UI
          if(window.audit) window.audit('ثبت درخواست ویزارد: '+(created.no||''));
          if(window.go) window.go('requests');
          return created;
        }catch(e){
          if(e.status===202 && e.body?.queued){
            toast('آفلاین — در صف Sync');
            return e.body;
          }
          throw e;
        }
      }
    });
    wiz.start(initial);
  }

  // Work Order Wizard
  function openWorkOrderWizard(initial={}){
    const steps = [
      { title:'تجهیز', key:'assetId', type:'text', required:true, question:'برای کدام تجهیز دستورکار صادر می‌شود؟', ai:true, placeholder:'انتخاب تجهیز…' },
      { title:'نوع کار', key:'type', type:'options', required:true, question:'نوع کار چیست؟', ai:true, options:[
        {label:'اصلاحی (CM)', value:'CM', icon:'🔧'}, {label:'پیشگیرانه (PM)', value:'PM', icon:'🔁'}, {label:'اضطراری (BD)', value:'BD', icon:'🚨'}, {label:'پیش‌بینانه (PdM)', value:'PdM', icon:'📈'}
      ]},
      { title:'اولویت', key:'priority', type:'options', required:true, question:'اولویت؟', options:[
        {label:'عادی', value:'normal', icon:'🔵'}, {label:'فوری', value:'high', icon:'🟠'}, {label:'اضطراری', value:'critical', icon:'🔴'}
      ]},
      { title:'شرح', key:'descr', type:'text', required:true, question:'شرح کار', multiline:true, rows:3, placeholder:'شرح دقیق فعالیت…' },
      { title:'تکنسین', key:'assignee', type:'text', required:false, question:'تکنسین مسئول (اختیاری)', hint:'می‌توانید بعداً تخصیص دهید.' },
      { title:'بازبینی', key:'_summary', type:'summary', question:'بازبینی' },
    ];
    const wiz = window.BFG.wizardEngine.create({
      id: 'work_order', title: 'دستورکار — ویزارد', steps,
      onSubmit: async (data)=>{
        const payload = { assetId: data.assetId, descr: data.descr, priority: data.priority, type: data.type, assignee: data.assignee||null };
        const res = await window.BFG.api.workOrders.create(payload);
        const wo = res.data || res;
        if(window.DB){ window.DB.wos.unshift({ id: wo.id, no: wo.no, ...payload, status: wo.status||'open' }); if(window.buildMenu) window.buildMenu(); }
        if(window.go) window.go('wos');
        return wo;
      }
    });
    wiz.start(initial);
  }

  // Add Equipment Wizard
  function openEquipmentWizard(initial={}){
    const steps = [
      { title:'والد', key:'parentId', type:'text', required:false, question:'محل استقرار (والد در درخت)؟', hint:'سایت / واحد / خط — خالی = سطح ریشه' },
      { title:'نوع گره', key:'nodeKind', type:'options', required:true, question:'نوع گره چیست؟', options:[
        {label:'تجهیز', value:'equipment', icon:'⚙️'}, {label:'زیرتجهیز', value:'sub-equipment', icon:'🔩'}, {label:'مکان', value:'location', icon:'📍'}, {label:'دسته', value:'category', icon:'📂'}
      ]},
      { title:'کد', key:'code', type:'text', required:true, question:'کد تجهیز', placeholder:'مثلاً BFG-PU-L1-PMP02' },
      { title:'نام', key:'name', type:'text', required:true, question:'نام تجهیز', placeholder:'مثلاً پمپ تزریق' },
      { title:'مشخصات', key:'spec', type:'custom', question:'مشخصات فنی', render:(d)=>`
        <div class="frow"><div class="field"><label>سازنده</label><input value="${esc(d.maker||'')}" oninput="BFG.wizardEngine.setValue('maker', this.value)"></div><div class="field"><label>مدل</label><input value="${esc(d.model||'')}" oninput="BFG.wizardEngine.setValue('model', this.value)"></div></div>
        <div class="frow"><div class="field"><label>سریال</label><input value="${esc(d.serial||'')}" oninput="BFG.wizardEngine.setValue('serial', this.value)"></div><div class="field"><label>بحرانیت</label><select onchange="BFG.wizardEngine.setValue('crit', this.value)"><option>A</option><option>B</option><option>C</option></select></div></div>
      `},
      { title:'بازبینی', key:'_summary', type:'summary', question:'بازبینی' },
    ];
    const wiz = window.BFG.wizardEngine.create({
      id: 'add_equipment', title: 'افزودن تجهیز — ویزارد', steps,
      onSubmit: async (data)=>{
        const payload = { nodeKind: data.nodeKind, code: data.code, name: data.name, parentId: data.parentId||null, maker: data.maker, model: data.model, serial: data.serial, crit: data.crit };
        const res = await window.BFG.api.equipment.create(payload);
        if(window.eqv2Load) await window.eqv2Load();
        return res;
      }
    });
    wiz.start(initial);
  }

  // Failure Report Wizard
  function openFailureWizard(assetId){
    const steps = [
      { title:'تجهیز', key:'asset_id', type:'text', required:true, question:'کدام تجهیز خراب شده؟', ai:true },
      { title:'علائم', key:'symptoms', type:'options', required:true, question:'علائم مشاهده‌شده چیست؟', ai:true, options:[
        {label:'لرزش', value:'لرزش'}, {label:'صدا', value:'صدای غیرعادی'}, {label:'دما بالا', value:'افزایش دما'}, {label:'نشتی', value:'نشتی'}, {label:'افت فشار', value:'افت فشار'}
      ]},
      { title:'شدت', key:'severity', type:'options', required:true, question:'شدت؟', options:[
        {label:'کم', value:'low'}, {label:'متوسط', value:'medium'}, {label:'زیاد', value:'high'}, {label:'بحرانی', value:'critical'}
      ]},
      { title:'شرح', key:'description', type:'text', required:true, question:'شرح کامل خرابی', multiline:true, rows:3 },
      { title:'پیوست', key:'media', type:'custom', question:'پیوست و اندازه‌گیری', render:(d)=>`
        <div style="display:flex;gap:8px"><label class="btn btn-sm btn-ghost">📷 عکس<input type="file" hidden onchange="BFG.wizards.handleFiles(this,'media')"></label>
        <button class="btn btn-sm btn-ghost" onclick="BFG.wizards.addMeasurement('media')">📏 Measurement</button></div>
      `},
      { title:'بازبینی', key:'_summary', type:'summary', question:'بازبینی' },
    ];
    const wiz = window.BFG.wizardEngine.create({
      id: 'failure_report', title: 'گزارش خرابی — ویزارد', steps,
      onSubmit: async (data)=>{
        const payload = { asset_id: data.asset_id, symptoms: [data.symptoms], description: data.description, severity: data.severity, provenance:'verified' };
        const res = await window.BFG.api.failures.create(payload);
        const f = res.data || res;
        // Trigger AI diagnosis automatically (Requirement #11)
        try{ const diag = await window.BFG.api.ai.diagnose(f.id); toast('تشخیص هوشمند تولید شد 🤖'); console.log(diag);}catch(_){}
        if(window.go) window.go('failures');
        return f;
      }
    });
    wiz.start({ asset_id: assetId });
  }

  // Generic PM Wizard
  function openPMWizard(assetId){
    const steps = [
      { title:'تجهیز', key:'assetId', type:'text', required:true, question:'تجهیز هدف PM؟', ai:true },
      { title:'عنوان', key:'title', type:'text', required:true, question:'عنوان برنامه PM', placeholder:'مثلاً PM ماهانه پمپ' },
      { title:'تناوب', key:'interval', type:'options', required:true, question:'تناوب؟', options:[
        {label:'هفتگی (7 روز)', value:'7'}, {label:'ماهانه (30 روز)', value:'30'}, {label:'فصلی (90 روز)', value:'90'}, {label:'شش‌ماهه (180)', value:'180'}
      ]},
      { title:'چک‌لیست', key:'checklist', type:'text', required:false, question:'چک‌لیست (هر خط یک فعالیت)', multiline:true, rows:3, placeholder:'بازدید تسمه\nگریس‌کاری' },
      { title:'بازبینی', key:'_summary', type:'summary', question:'بازبینی' },
    ];
    const wiz = window.BFG.wizardEngine.create({
      id: 'pm_create', title: 'برنامه PM — ویزارد', steps,
      onSubmit: async (data)=>{
        // Use legacy local for now, but also call API if exists
        try{
          const res = await window.BFG.api.request('/api/data/pms', { method:'POST', body: JSON.stringify({ id: 'm_'+Date.now(), assetId: data.assetId, title: data.title, interval: parseInt(data.interval,10), last: new Date().toISOString(), spec:'مکانیک', checklist: (data.checklist||'').split('\n').filter(Boolean) }) });
          toast('برنامه PM ثبت شد ✅'); if(window.go) window.go('pm');
          return res;
        }catch(e){ // fallback local
          if(window.DB){ window.DB.pms.push({ id:'m_'+Date.now(), assetId: data.assetId, title:data.title, interval:parseInt(data.interval,10), last:new Date().toISOString(), spec:'مکانیک', checklist:(data.checklist||'').split('\n').filter(Boolean)}); if(window.save) window.save(); }
          toast('برنامه PM (local) ثبت شد ✅'); if(window.go) window.go('pm');
        }
      }
    });
    wiz.start({ assetId });
  }

  function handleFiles(input, key){
    const files = [...input.files].map(f=>({ name:f.name, size:f.size, type:f.type, _file:f }));
    const wiz = window.BFG.wizardEngine.current;
    if(!wiz) return;
    const cur = wiz.data[key] || [];
    wiz.setValue(key, [...cur, ...files]);
    wiz.render();
    toast(`${files.length} فایل افزوده شد 📎`);
  }
  function removeAtt(idx){
    const wiz = window.BFG.wizardEngine.current;
    if(!wiz) return;
    const cur = [...(wiz.data.attachments||[])];
    cur.splice(idx,1);
    wiz.setValue('attachments', cur);
    wiz.render();
  }
  function addMeasurement(key='attachments'){
    const param = prompt('نام پارامتر (مثلاً ارتعاش mm/s یا دما °C):');
    if(!param) return;
    const val = prompt(`مقدار ${param}:`);
    if(!val) return;
    const wiz = window.BFG.wizardEngine.current;
    if(!wiz) return;
    const cur = wiz.data[key] || [];
    cur.push({ kind:'measurement', param, value: val, at: new Date().toISOString(), provenance:'verified' });
    wiz.setValue(key, cur);
    wiz.render();
  }

  window.BFG.wizards = {
    openMaintenanceRequestWizard, openWorkOrderWizard, openEquipmentWizard, openFailureWizard, openPMWizard,
    handleFiles, removeAtt, addMeasurement,
  };
  // Replace global openReqForm etc to use wizards
  window.openReqForm = openMaintenanceRequestWizard;
  window.openWOForm = openWorkOrderWizard;
  window.openAssetForm = openEquipmentWizard;
  window.openPMForm = openPMWizard;
  console.log('[BFG] wizards ready');
})();
