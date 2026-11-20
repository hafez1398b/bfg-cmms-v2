/* Dossier sources and staged, evidence-bound structure review. All data comes from the authenticated Domain API. */
(function(){
  'use strict';
  const COPY={pending_review:'در انتظار تأیید',approved:'تأییدشده',rejected:'ردشده',markdown:'Markdown',excel:'Excel',image:'تصویر',manual:'Manual',bom:'BOM',engineering_model:'مدل مهندسی GLB'};
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const text=value=>value==null||value===''?'ثبت نشده':String(value);
  const formatDate=value=>value?new Date(value).toLocaleString('fa-IR'):'ثبت نشده';
  class EquipmentDossier extends HTMLElement {
    connectedCallback(){if(this.dataset.ready)return;this.dataset.ready='1';this.dir='rtl';this.renderShell();this.loadDocuments();}
    get equipmentId(){return this.dataset.equipmentId||'';}
    get repo(){return window.EquipmentRepository?.current?.();}
    get canSuggest(){return this.hasAttribute('can-suggest')||!!this.capabilities?.suggest;}
    get canApprove(){return this.hasAttribute('can-approve')||!!this.capabilities?.approveAi;}
    renderShell(){
      this.innerHTML=`<section class="bfg-dossier"><header><div><small>پرونده دیجیتال تجهیز</small><h3>تکمیل ساختار مبتنی بر پرونده</h3><p>اسناد فقط به‌عنوان منبع ثبت می‌شوند؛ هیچ دستور درون فایل اجرا نمی‌شود و هیچ ساختاری بدون تأیید انسانی نوشته نخواهد شد.</p></div></header>
      <div class="bfg-dossier-upload"><label>نوع سند<select data-doc-type><option value="markdown">Markdown</option><option value="excel">Excel</option><option value="image">تصویر</option><option value="manual">Manual / PDF</option><option value="bom">BOM</option><option value="engineering_model">مدل مهندسی GLB</option></select></label>
      <label>Revision (اختیاری)<input data-doc-revision maxlength="120" placeholder="مثلاً Rev A"></label><label class="bfg-file-label">انتخاب فایل<input data-doc-file type="file" accept=".md,.xlsx,.csv,.pdf,.jpg,.jpeg,.png,.glb"></label>
      <button type="button" class="btn btn-primary" data-upload ${this.canSuggest?'':'disabled'}>ثبت سند منبع</button></div><div class="bfg-dossier-status" role="status" aria-live="polite"></div>
      <section class="bfg-dossier-documents"><h4>منابع ثبت‌شده</h4><div data-documents><p class="muted">در حال دریافت فهرست سندها از سرور…</p></div></section>
      <div class="bfg-dossier-analysis"><div class="bfg-dossier-analysis-toolbar"><div><h4>تحلیل مشخصات و پیشنهاد مرحله‌ای</h4><p>فقط داده‌های صریح در سند تأییدشده استخراج می‌شوند؛ مقادیر خالی/N/A «ثبت‌نشده» باقی می‌مانند.</p></div><label>والد مجاز برای مرحله بعد<select data-parent><option value="">تجهیز ریشه</option></select></label><button type="button" class="btn btn-sm btn-primary" data-analyze ${this.canSuggest?'':'disabled'}>تحلیل پرونده و پیش‌نمایش</button></div><div data-analysis><p class="muted">برای شروع، سند منبع را بارگذاری و پس از بررسی انسانی تأیید کنید.</p></div></div>
      <section class="bfg-dossier-viewer"><div><h4>نمای انفجاری ساختار تأییدشده</h4><p class="bfg-concept-label">نمای مفهومی — نقشه مهندسی یا As-Built نیست</p></div><button type="button" class="btn btn-sm btn-ghost" data-scene>بارگذاری نمای سه‌بعدی</button><div data-viewer></div><div class="bfg-image-references" data-image-refs></div></section></section>`;
      this.querySelector('[data-upload]').onclick=()=>this.upload();this.querySelector('[data-analyze]').onclick=()=>this.analyze();this.querySelector('[data-scene]').onclick=()=>this.loadScene();
      this.querySelector('[data-parent]').addEventListener('change',()=>{this.analysis=null;this.querySelector('[data-analysis]').textContent='والد تغییر کرد؛ پیش‌نمایش تازه لازم است.';});
      this.refreshParentOptions();
    }
    status(message,error=false){const node=this.querySelector('.bfg-dossier-status');node.textContent=message||'';node.classList.toggle('is-error',!!error);}
    async loadDocuments(){
      try{
        const [result,structureResult]=await Promise.all([this.repo.sourceDocuments(this.equipmentId),this.repo.structure(this.equipmentId,{depth:3})]);
        this.documents=result.data||[];this.capabilities=structureResult.data?.capabilities||{};window.EQV2&&(window.EQV2.structure=structureResult.data);
        this.querySelector('[data-upload]').disabled=!this.canSuggest;this.querySelector('[data-analyze]').disabled=!this.canSuggest;
        this.renderDocuments();this.renderImageReferences();this.refreshParentOptions();
      }
      catch(error){this.status(`فهرست اسناد از سرور دریافت نشد: ${error.payload?.error||error.message}`,true);this.querySelector('[data-documents]').textContent='خواندن اسناد سرور ناموفق بود.';}
    }
    renderDocuments(){
      const target=this.querySelector('[data-documents]');if(!this.documents?.length){target.innerHTML='<p class="muted">هنوز سند منبعی در Backend ثبت نشده است.</p>';return;}
      target.innerHTML=this.documents.map(doc=>`<article class="bfg-doc-row"><div class="bfg-doc-meta"><b>${esc(doc.filename)}</b><span>${esc(COPY[doc.documentType]||doc.documentType)} · ${esc(COPY[doc.approvalStatus]||doc.approvalStatus)} · Rev ${esc(text(doc.revision))}</span><small>شناسه ${esc(doc.id)} · SHA-256 ${esc(doc.sha256)}</small><small>ثبت ${esc(formatDate(doc.uploadedAt))} توسط ${esc(doc.uploaderId)} · تأییدکننده ${esc(doc.approvedBy||'ثبت نشده')}</small></div><a class="btn btn-sm btn-ghost" href="/api/equipment/${encodeURIComponent(this.equipmentId)}/source-documents/${encodeURIComponent(doc.id)}/content" target="_blank" rel="noopener">دریافت اصل فایل</a>${doc.approvalStatus==='pending_review'&&this.canApprove?`<button class="btn btn-sm btn-primary" data-review="${esc(doc.id)}" data-status="approved">تأیید سند</button><button class="btn btn-sm btn-ghost" data-review="${esc(doc.id)}" data-status="rejected">رد سند</button>`:''}</article>`).join('');
      target.querySelectorAll('[data-review]').forEach(button=>button.onclick=()=>this.reviewDocument(button.dataset.review,button.dataset.status));
    }
    renderImageReferences(){
      const target=this.querySelector('[data-image-refs]'),images=(this.documents||[]).filter(doc=>doc.documentType==='image'&&doc.approvalStatus==='approved');
      target.innerHTML=images.length?`<h5>تصاویر مرجع تأییدشده — بدون تبدیل خودکار به Texture</h5>${images.map(doc=>`<figure><img loading="lazy" alt="تصویر مرجع ${esc(doc.filename)}" src="/api/equipment/${encodeURIComponent(this.equipmentId)}/source-documents/${encodeURIComponent(doc.id)}/content"><figcaption>${esc(doc.filename)} · Ref ${esc(doc.id)}</figcaption></figure>`).join('')}`:'';
    }
    refreshParentOptions(){
      const select=this.querySelector('[data-parent]');if(!select)return;const previous=select.value,root=window.EQV2?.structure?.root,nodes=window.EQV2?.structure?.nodes||[];
      const choices=[];if(root)choices.push({id:root.id,label:`تجهیز · ${root.code||''} ${root.name||''}`});
      const walk=(items,depth=1)=>{for(const node of items||[]){if(!node.archived&&node.validRelation!==false&&depth<=2)choices.push({id:node.id,label:`${['','زیرسیستم','قطعه اصلی'][depth]||''} · ${node.code||''} ${node.name||''}`});walk(node.children,depth+1);}};walk(nodes);
      select.innerHTML=choices.map(item=>`<option value="${esc(item.id)}">${esc(item.label)}</option>`).join('')||'<option value="">تجهیز ریشه</option>';
      if(choices.some(item=>String(item.id)===previous))select.value=previous;else if(root)select.value=root.id;
    }
    async upload(){
      const input=this.querySelector('[data-doc-file]'),file=input.files?.[0];if(!file){this.status('ابتدا یک فایل انتخاب کنید.',true);return;}
      if(file.size>8*1024*1024){this.status('حداکثر حجم سند ۸ مگابایت است.',true);return;}
      const button=this.querySelector('[data-upload]');button.disabled=true;this.status('در حال ثبت امن سند در Backend…');
      try{
        const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('FILE_READ_FAILED'));reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(file);});
        const response=await this.repo.uploadSourceDocument(this.equipmentId,{filename:file.name,type:this.querySelector('[data-doc-type]').value,revision:this.querySelector('[data-doc-revision]').value,base64});
        if(!response.committed||response.data?.approvalStatus!=='pending_review')throw new Error('DOCUMENT_NOT_COMMITTED');
        this.status('سند در Backend ثبت شد و تا تأیید انسانی در تحلیل وارد نمی‌شود.');input.value='';await this.loadDocuments();
      }catch(error){this.status(`ثبت سند ناموفق بود: ${error.payload?.error||error.message}`,true);}finally{button.disabled=!this.canSuggest;}
    }
    async reviewDocument(id,status){
      const doc=this.documents.find(item=>String(item.id)===String(id));if(!doc)return;
      const note=window.prompt(status==='approved'?'دلیل تأیید سند را وارد کنید:':'دلیل رد سند را وارد کنید:');if(!note?.trim())return;
      try{const result=await this.repo.reviewSourceDocument(this.equipmentId,id,{status,note:note.trim(),rowVersion:doc.rowVersion});if(!result.committed||result.data?.approvalStatus!==status)throw new Error('DOCUMENT_REVIEW_NOT_COMMITTED');this.status('بازبینی سند در Backend ثبت شد.');await this.loadDocuments();}
      catch(error){this.status(`بازبینی سند انجام نشد: ${error.payload?.error||error.message}`,true);}
    }
    async analyze(){
      const button=this.querySelector('[data-analyze]');button.disabled=true;this.status('در حال استخراج literal و تهیه اختلاف نسخه‌دار…');
      try{const result=await this.repo.analyzeDossier(this.equipmentId,{parentId:this.querySelector('[data-parent]').value||undefined});this.analysis=result.data;this.renderAnalysis();this.status('پیش‌نمایش فقط‌خواندنی آماده شد؛ هیچ رکوردی ایجاد یا تغییر نکرده است.');}
      catch(error){this.status(`تحلیل انجام نشد: ${error.payload?.error||error.message}`,true);}finally{button.disabled=!this.canSuggest;}
    }
    renderAnalysis(){
      const target=this.querySelector('[data-analysis]'),data=this.analysis;if(!data)return;
      const groups=data.technical?.groups||{},labels={sourceConfirmed:'تأییدشده از منبع',derived:'مشتق‌شده',proposed:'پیشنهادی',conflict:'تعارض'};
      const groupHtml=Object.keys(labels).map(key=>`<section class="bfg-fact-group"><h5>${labels[key]}</h5>${(groups[key]||[]).length?(groups[key]||[]).map(fact=>`<article><b>${esc(fact.field||fact.value||'')}</b><span>${esc(fact.value||fact.values?.map(value=>value.value).join(' / ')||fact.reason||'')}</span><small>شواهد: ${esc((fact.evidenceIds||fact.values?.flatMap(value=>value.evidenceIds||[])||[]).join(', ')||'ثبت نشده')} · وضعیت ${esc(fact.sourceStatus||fact.status||'conflict')}</small></article>`).join(''):'<p class="muted">داده کافی ثبت نشده است.</p>'}</section>`).join('');
      const proposals=data.proposals?.items||[];
      const proposalHtml=proposals.length?proposals.map(item=>`<article class="bfg-proposal ${item.conflictStatus!=='none'?'is-conflict':''}"><div><b>${esc(item.name)} · ${esc(item.code)}</b><span>${esc(item.level)} · والد ${esc(item.parent.name||item.parent.id)}</span></div><dl><dt>عملکرد</dt><dd>${esc(item.function||'ثبت نشده')}</dd><dt>دلیل</dt><dd>${esc(item.reason)}</dd><dt>منشأ/شواهد</dt><dd>${esc(item.provenance.source)} · ${esc(item.evidenceIds.join(',')||'ثبت نشده')}</dd><dt>اطمینان</dt><dd>${item.confidence==null?'N/A':Math.round(item.confidence*100)+'٪'}</dd><dt>ISO 14224</dt><dd>${esc(item.taxonomy.status)} — ${esc(item.taxonomy.classCode||'بدون نگاشت تأییدشده')}</dd><dt>Diff</dt><dd>${esc(item.diff?.operation)} · قبل ${esc(item.diff?.before?`${item.diff.before.code} — ${item.diff.before.name}`:'—')} → بعد ${esc(item.diff?.after?.code)} — ${esc(item.diff?.after?.name)}</dd><dt>بررسی</dt><dd>${esc(item.reviewStatus)} · تعارض ${esc(item.conflictStatus)}</dd></dl>${item.action==='preview-only'&&this.canApprove?`<button class="btn btn-sm btn-primary" data-approve-proposal="${esc(item.id)}">تأیید نسخه‌دار و ثبت همین مورد</button>`:`<span class="badge b-orange">غیرقابل ثبت: ${esc(item.conflictStatus)}</span>`}</article>`).join(''):'<p class="muted">در سندهای تأییدشده، ردیف ساختاری صریح برای این مرحله پیدا نشد.</p>';
      target.innerHTML=`<div class="bfg-facts-summary"><b>منبع: ${esc(data.technical?.provider||'server')} · ${esc(data.technical?.model||'')}</b><span>Search: ${esc(data.technical?.searchStatus||'SEARCH_UNAVAILABLE')} · Vision: ${esc(data.technical?.visionStatus||'VISION_UNAVAILABLE')}</span><span>${esc(data.technical?.manualTextStatus||'')}</span></div><div class="bfg-fact-groups">${groupHtml}</div><h5>Diff آیتم‌به‌آیتم — مرحله ${esc(data.proposals?.stage||'ثبت نشده')}</h5><p>پیشنهادها فقط از سند تأییدشده استخراج شده‌اند. ترتیب اجباری است: زیرسیستم، قطعه اصلی همان زیرسیستم، سپس زیرقطعهٔ همان قطعه اصلی.</p><div class="bfg-proposals">${proposalHtml}</div>`;
      target.querySelectorAll('[data-approve-proposal]').forEach(button=>button.onclick=()=>this.approve(button.dataset.approveProposal));
    }
    async approve(proposalId){
      const plan=this.analysis?.proposals,item=plan?.items?.find(value=>value.id===proposalId);if(!plan||!item)return;
      const reason=window.prompt(`تأیید ثبت ${item.level} «${item.name}» با کد میراثی ${item.code}. دلیل تصمیم را وارد کنید:`);if(!reason?.trim())return;
      if(!window.confirm(`ثبت همین یک مورد در PostgreSQL از مسیر Domain API؟\n${item.name} / ${item.code}\nوالد: ${item.parent.name||item.parent.id}\nDiff: ایجاد پیشنهادی → ثبت تأییدشده`))return;
      try{
        const result=await this.repo.approveStructureProposal(this.equipmentId,{confirmed:true,revision:plan.revision,proposalId,parentId:item.parent.id,parentRowVersion:item.parent.rowVersion,reason:reason.trim()});
        if(!result.committed||!result.data?.data?.id)throw new Error('APPROVAL_NOT_COMMITTED');
        this.status(`ثبت تأییدشده در سرور: ${result.data.data.id} · Audit و evidence ثبت شد.`);this.analysis=null;
        await window.eqv2RefreshReviewedStructure?.();await this.loadDocuments();this.querySelector('[data-analysis]').innerHTML='<p class="muted">نسخه ساختار تغییر کرد؛ برای Diff تازه، تحلیل را دوباره اجرا کنید.</p>';
      }catch(error){this.status(`تأیید/ثبت رد شد: ${error.payload?.error||error.message}`,true);}
    }
    async loadScene(){
      const host=this.querySelector('[data-viewer]'),button=this.querySelector('[data-scene]');button.disabled=true;this.status('در حال بارگذاری Scene Graph از ساختار تأییدشده…');
      try{
        const result=await this.repo.structureScene(this.equipmentId),scene=result.data;if(scene.label!=='نمای مفهومی — نقشه مهندسی یا As-Built نیست')throw new Error('SCENE_LABEL_INVALID');
        const module=await import('/equipment-v2/structure-viewer.js');this.viewer?.dispose?.();
        this.viewer=module.mount(host,scene,scene.engineering,(node)=>{const status=`گره پرونده ${node.sourceId} انتخاب شد · ${node.name} · ${node.code||'ثبت نشده'}`;this.status(status);});
        this.status(scene.engineering?.available?`مدل مهندسی جداگانه موجود است · Rev ${scene.engineering.revision||'ثبت نشده'}`:'فقط شکل‌های Generic؛ هندسه یا ابعاد واقعی ساخته نشده است.');
      }catch(error){this.status(`Scene Graph در دسترس نیست: ${error.payload?.error||error.message}`,true);}finally{button.disabled=false;}
    }
    disconnectedCallback(){this.viewer?.dispose?.();}
  }
  if(!customElements.get('bfg-equipment-dossier'))customElements.define('bfg-equipment-dossier',EquipmentDossier);
})();
