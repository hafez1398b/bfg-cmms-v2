/* The element owns one review only; leaving the dossier destroys its pending selection. */
(function(){
  'use strict';
  const labels={unchanged:'بدون تغییر',create:'ایجاد',edit:'ویرایش',move:'انتقال',move_edit:'انتقال و ویرایش',archive:'بایگانی',restore:'بازیابی',conflict:'تعارض',suggested:'پیشنهادی',equipment:'تجهیز',subsystem:'زیرسیستم','main-component':'جزء اصلی','sub-component':'زیرجزء'};
  const writable=new Set(['create','edit','move','move_edit','archive','restore']);
  function el(tag,text){const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;}
  class StructureReview extends HTMLElement {
    connectedCallback(){
      if(this.childNodes.length)return;
      this.dir='rtl';this.destinations={};
      this.append(el('h3','بازبینی ساختار با سلن'),el('p','هر ردیف: سطح | کد | نام | کد والد | وضعیت اختیاری (active، archive، restore یا proposed). بدون ورودی، یادداشت همین پرونده بررسی می‌شود.'));
      this.text=el('textarea');this.text.placeholder='متن یا جدول Markdown';this.file=el('input');this.file.type='file';this.file.accept='.xlsx,.md,.txt';
      this.preview=el('button','تحلیل و نمایش اختلاف‌ها');this.preview.type='button';
      this.list=el('div');this.note=el('p');this.note.setAttribute('role','status');
      this.append(this.text,this.file,this.preview,this.list,this.note);
      this.preview.onclick=()=>this.run(false);
      this.text.oninput=this.file.onchange=()=>{this.destinations={};this.invalidate();};
    }
    invalidate(){this.sequence=(this.sequence||0)+1;this.plan=null;this.list.replaceChildren();this.note.textContent='برای ادامه، پیش‌نمایش تازه بگیرید.';}
    async payload(){
      const file=this.file.files[0];
      if (file && this.text.value.trim()) throw Error('فقط یک ورودی انتخاب کنید.');
      if (file?.size>1024*1024) throw Error('حداکثر حجم فایل یک مگابایت است.');
      if (!file) return this.text.value.trim()?{text:this.text.value}:{};
      if (/\.txt$/i.test(file.name)) return {text:await file.text()};
      const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(Error('خواندن فایل ناموفق بود.'));r.onload=()=>resolve(r.result.split(',')[1]);r.readAsDataURL(file);});
      return {file:{name:file.name,base64}};
    }
    async run(commit){
      if(this.busy)return;
      const sequence=this.sequence||0;
      try {
        this.busy=true;this.preview.disabled=true;
        const body={...await this.payload(),destinations:this.destinations};
        if(commit){
          const selected=[...this.querySelectorAll('input[type=checkbox]:checked')].map(n=>Number(n.value));
          if (!selected.length||!this.reason.value.trim()) throw Error('حداقل یک ردیف و دلیل ثبت لازم است.');
          if(!window.confirm(`ثبت تراکنشی ${selected.length} ردیف انتخاب‌شده؟`))return;
          Object.assign(body,{confirmed:true,revision:this.plan.revision,selected,reason:this.reason.value});
        }
        if (!this.isConnected||sequence!==(this.sequence||0))return;
        const {data}=await window.EquipmentRepository.current().structureReview(this.dataset.id,commit?'confirm':'analyze',body);
        if(!this.isConnected||sequence!==(this.sequence||0))return;
        if(commit){
          if (!data?.committed||!data.auditIds?.length)throw Error('ثبت تأیید نشد');
          this.invalidate();this.note.textContent='تراکنش ثبت شد. شناسه‌های ممیزی: '+data.auditIds.join('، ');
          const reload=el('button','بازخوانی ساختار پرونده');reload.onclick=()=>window.eqv2RefreshReviewedStructure();this.list.append(reload);
        }else{this.plan=data;this.render();}
      }catch(e){this.invalidate();this.note.textContent=e.payload?.error||e.message;}
      finally{this.busy=false;this.preview.disabled=false;}
    }
    render(){
      this.list.replaceChildren();this.note.textContent=this.plan.items.length?'فقط ردیف‌های علامت‌خورده ثبت می‌شوند.':'دادهٔ قابل استخراج یافت نشد.';
      for(const i of this.plan.items){
        const box=el('article'),label=el('label'),check=el('input');check.type='checkbox';check.value=i.index;check.disabled=!writable.has(i.action)||!i.evidence;
        label.append(check,document.createTextNode(`${labels[i.action]} · ${labels[i.fact.kind]} · ${i.fact.code} — ${i.fact.name}`));box.append(label);
        box.append(el('p',`فعلی: ${i.current?i.current.code+' — '+i.current.name+' / والد '+i.current.parent:'—'} ← مقصد: ${i.fact.parentCode||'—'}`));
        box.append(el('small',i.evidence?`شاهد: ${i.evidence.type} / ${i.evidence.id} · تطابق منبع: ${i.confidence*100}٪ · ${i.evidence.hash}`:'بدون شاهد منطبق؛ فقط پیش‌نویس'));
        for (const [field,list] of [['target',i.candidates],['parent',i.parentCandidates]]) if(list.length>1){
          const select=el('select');select.append(new Option(field==='parent'?'انتخاب والد':'انتخاب مقصد',''));for(const n of list)select.append(new Option(n.code+' — '+n.name+' / '+n.id,n.id));
          select.value=this.destinations[i.index]?.[field]||'';select.onchange=()=>{(this.destinations[i.index]||={})[field]=select.value;this.invalidate();this.run(false);};box.append(select);
        }
        this.list.append(box);
      }
      if(this.hasAttribute('can-confirm')&&this.plan.items.some(i=>writable.has(i.action))){
        this.reason=el('input');this.reason.placeholder='دلیل ثبت';this.reason.maxLength=500;const apply=el('button','تأیید و ثبت موارد انتخاب‌شده');apply.onclick=()=>this.run(true);this.list.append(this.reason,apply);
      }
    }
  }
  customElements.define('bfg-structure-review',StructureReview);
})();
