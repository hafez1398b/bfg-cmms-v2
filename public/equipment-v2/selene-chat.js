/* Selene equipment assistant. Analysis stays on the server. The browser keeps no key and no file bytes. */
(function(){
  'use strict';
  const ACCEPT = '.md,.xlsx,.csv,.pdf,.jpg,.jpeg';
  const FIELD_LABELS = {
    name: 'نام تجهیز', code: 'کد تجهیز', nodeKind: 'نوع گره', activityType: 'نوع فعالیت',
    maker: 'سازنده', manufacturerCountry: 'کشور سازنده', model: 'مدل', serial: 'سریال',
    year: 'سال ساخت', install: 'تاریخ نصب', installDate: 'تاریخ نصب', power: 'توان',
    capacity: 'ظرفیت', location: 'محل استقرار', cls: 'کلاس', status: 'وضعیت فنی',
    operationalStatus: 'وضعیت بهره‌برداری', crit: 'بحرانیت', hours: 'کارکرد تجمعی',
    technicalSpecification: 'مشخصات فنی', notes: 'شرح عملکرد', panelCode: 'تابلو برق',
    refrigerant: 'نوع مبرد', dailyOperatingHours: 'کارکرد روزانه',
    criticalityScore: 'امتیاز بحرانی', keyParts: 'قطعات کلیدی'
  };
  const INTENTS = { analyze: 'تحلیل', create: 'ساخت تجهیز', complete: 'تکمیل شناسنامه', generate: 'تولید از داده' };
  const COVERAGE = { found: 'موجود', missing: 'لازم', empty: 'خالی', default: 'پیش‌فرض' };
  const MESSAGES = {
    CLOUD_CONTEXT_NOT_APPROVED: 'ارسال متن صنعتی به سرویس تحلیل هنوز در سیاست سرور تأیید نشده است.',
    AI_PROVIDER_DISABLED_BY_POLICY: 'سرویس تحلیل در سیاست سرور غیرفعال است.',
    AI_PURPOSE_DENIED_BY_POLICY: 'سیاست سرور هنوز ورود هوشمند تجهیزات را مجاز نکرده است.',
    VISION_UNAVAILABLE: 'مدل فعلی تصویر را نمی‌بیند. متن همراه را می‌تواند تحلیل کند؛ برای JPG باید بینایی مدل روی سرور روشن باشد.',
    FILE_TYPE_REJECTED: 'فقط md، xlsx، csv، pdf و jpg پذیرفته می‌شود.',
    DANGEROUS_FILE_REJECTED: 'این فایل پذیرفته نمی‌شود.',
    FILE_TOO_LARGE: 'حجم فایل بیش از حد مجاز سرور است.',
    EQUIPMENT_PERMISSION_DENIED: 'مجوز مشاهده تجهیزات را ندارید.',
    NO_CAPABLE_PROVIDER: 'سرویس تحلیل برای این درخواست پیکربندی نشده است.'
  };

  function csrf(){
    const parts = String(document.cookie || '').split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed.startsWith('bfg_csrf=')) continue;
      try { return decodeURIComponent(trimmed.slice('bfg_csrf='.length)); }
      catch (_) { return trimmed.slice('bfg_csrf='.length); }
    }
    return '';
  }

  function el(tag, className, text){
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function seal(){ return el('span', 'selene-seal', 'س'); }

  function addInline(parent, text){
    const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      if (match[2]) parent.appendChild(el('strong', '', match[2]));
      else parent.appendChild(el('code', '', match[3]));
      last = match.index + match[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderAnswer(text){
    const root = el('div', 'selene-answer');
    String(text || '').split(/\n{2,}/).forEach(block => {
      const paragraph = el('p');
      block.split('\n').forEach((line, index) => {
        if (index) paragraph.appendChild(document.createElement('br'));
        const item = line.replace(/^[-•]\s+/, '');
        if (item !== line) paragraph.appendChild(document.createTextNode('• '));
        addInline(paragraph, item);
      });
      root.appendChild(paragraph);
    });
    return root;
  }

  function option(value, label){
    const node = el('option', '', label);
    node.value = value;
    return node;
  }

  function mount(root, options){
    if (!root) return;
    const opts = options || {};
    const state = { sessionId: null, equipmentId: opts.equipmentId || null, current: null, currentStatus: opts.equipmentId ? 'loading' : 'none', messages: [], file: null, sending: false, sessions: [] };
    root.replaceChildren();
    const shell = el('section', 'selene');
    shell.setAttribute('aria-label', 'سلن، ورود هوشمند تجهیزات');
    const side = el('aside', 'selene-side');
    const brand = el('div', 'selene-brand');
    const brandText = el('div');
    brandText.append(el('b', '', 'سلن'), el('small', '', 'دستیار تجهیزات'));
    brand.append(seal(), brandText);
    const fresh = el('button', 'btn btn-sm btn-ghost selene-new', 'گفتگوی جدید');
    fresh.type = 'button';
    const sessions = el('div', 'selene-sessions');
    side.append(brand, fresh, sessions, el('p', 'selene-side-foot', 'فایل روی سرور تحلیل می‌شود و در مرورگر نمی‌ماند.'));
    const main = el('div', 'selene-main');
    const top = el('div', 'selene-top');
    const title = el('div');
    title.append(el('b', '', 'ورود هوشمند تجهیزات'), el('span', '', opts.equipmentName ? ('تکمیل شناسنامه ' + opts.equipmentCode + ' — ' + opts.equipmentName) : 'تحلیل فایل یا متن، سپس ثبت فقط با تأیید شما'));
    top.append(title, el('span', 'badge b-blue', 'پیش‌نویس'));
    const thread = el('div', 'selene-thread');
    const column = el('div', 'selene-column');
    thread.appendChild(column);
    const composer = el('form', 'selene-composer');
    const box = el('div', 'selene-box');
    const chips = el('div', 'selene-chips');
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.hidden = true;
    fileInput.accept = ACCEPT;
    const area = document.createElement('textarea');
    area.rows = 2;
    area.placeholder = 'متن را بچسبانید، یا بپرسید برای ثبت و تکمیل تجهیز چه داده‌ای کم است';
    const tools = el('div', 'selene-tools');
    const plus = el('button', 'btn btn-sm btn-ghost', 'پیوست فایل');
    plus.type = 'button';
    const send = el('button', 'btn btn-sm btn-primary', 'ارسال برای تحلیل');
    send.type = 'submit';
    send.disabled = true;
    tools.append(plus, el('span', 'selene-formats', 'md · xlsx · csv · pdf · jpg'), send, fileInput);
    box.append(chips, area, tools);
    composer.appendChild(box);
    main.append(top, thread, composer);
    shell.append(side, main);
    root.appendChild(shell);

    function scroll(){ thread.scrollTop = thread.scrollHeight; }
    function paintSessions(){
      sessions.replaceChildren();
      state.sessions.forEach(item => {
        const button = el('button', 'selene-session' + (item.id === state.sessionId ? ' on' : ''), item.title || 'گفتگو');
        button.type = 'button';
        button.addEventListener('click', () => openSession(item.id));
        sessions.appendChild(button);
      });
    }
    function paintChips(){
      chips.replaceChildren();
      if (!state.file) return;
      const chip = el('span', 'selene-chip');
      chip.append(el('span', '', state.file.name), el('span', '', Math.ceil(state.file.size / 1024) + ' KB'));
      const remove = el('button', '', '×');
      remove.type = 'button';
      remove.addEventListener('click', () => { state.file = null; paintChips(); syncSend(); });
      chip.appendChild(remove);
      chips.appendChild(chip);
    }
    function syncSend(){ send.disabled = state.sending || (!area.value.trim() && !state.file); }
    function welcome(){
      column.replaceChildren();
      const hello = el('div', 'selene-hello');
      const hero = el('div', 'selene-hero');
      const copy = el('div');
      copy.append(el('h2', '', 'داده تجهیز را از فایل یا متن جدا می‌کند'));
      copy.appendChild(el('p', '', 'بعد از بارگذاری یا چسباندن متن، سلن همان را تحلیل می‌کند، می‌گوید برای ساخت یا تکمیل تجهیز چه چیزی موجود است و چه چیزی لازم است، و اگر بخواهید از همان داده‌ها جمع‌بندی یا شرح می‌سازد. تا تأیید نکنید چیزی ثبت نمی‌شود.'));
      hero.append(seal(), copy);
      const map = el('div', 'selene-map');
      [['لازم برای ثبت', 'نام تجهیز، کد تجهیز، نوع گره'], ['شناسنامه', 'سازنده، مدل، سریال، سال ساخت، نصب، توان، ظرفیت، محل، کلاس، وضعیت، بحرانیت'], ['تکمیل مرتبط', 'مشخصات فنی، شرح، کارکرد روزانه، امتیاز بحرانی، تابلو برق، نوع مبرد، قطعات کلیدی']].forEach(([label, value]) => {
        const card = el('article');
        card.append(el('span', '', label), el('b', '', value));
        map.appendChild(card);
      });
      const ideas = el('div', 'selene-suggestions');
      ['این متن را تحلیل کن و بگو چه داده‌ای برای ثبت کم است', 'شناسنامه تجهیز باز را از همین فایل کامل کن', 'از داده‌های موجود یک شرح فنی کوتاه بساز'].forEach(label => {
        const button = el('button', '', label);
        button.type = 'button';
        button.addEventListener('click', () => { area.value = label; area.focus(); syncSend(); });
        ideas.appendChild(button);
      });
      hello.append(hero, map, ideas);
      column.appendChild(hello);
    }
    function paint(){
      if (!state.messages.length) { welcome(); return; }
      column.replaceChildren();
      state.messages.forEach(message => column.appendChild(message.role === 'user' ? userBubble(message) : assistantBubble(message)));
      scroll();
    }
    function userBubble(message){
      const node = el('article', 'selene-bubble selene-user');
      node.appendChild(el('span', 'selene-kicker', 'شما'));
      node.appendChild(el('div', 'selene-answer', message.body || ''));
      if (message.attachment) node.appendChild(el('div', 'selene-file', message.attachment.name));
      return node;
    }
    function assistantBubble(message){
      const wrap = el('div', 'selene-assistant');
      const body = el('article', 'selene-bubble');
      const head = el('span', 'selene-kicker', 'سلن' + (message.intent && INTENTS[message.intent] ? ' · ' + INTENTS[message.intent] : ''));
      body.append(head, renderAnswer(message.body));
      if (message.notice && MESSAGES[message.notice]) body.appendChild(el('div', 'selene-note', MESSAGES[message.notice]));
      if (message.gaps && message.gaps.length) body.appendChild(el('div', 'selene-note', 'برای ثبت هنوز لازم است: ' + message.gaps.join('، ')));
      (message.draft && message.draft.records || []).forEach(record => body.appendChild(draftCard(record, message.draft)));
      wrap.append(seal(), body);
      return wrap;
    }
    function coverage(record){
      const row = el('div', 'selene-coverage');
      (record.coverage || []).forEach(item => {
        const chip = el('i', item.status, item.label + ' · ' + (COVERAGE[item.status] || item.status));
        row.appendChild(chip);
      });
      return row;
    }
    function sourceLabel(draft){
      const source = draft && draft.source;
      if (source === 'column-match') return 'ستون‌های واقعی فایل';
      if (source === 'deepseek') return 'پیشنهاد مدل DeepSeek';
      if (source === 'local') return 'پیشنهاد مدل محلی';
      return 'ورودی همین گفتگو';
    }
    function valueText(value){
      if (Array.isArray(value)) return value.join('، ');
      if (value == null || value === '') return '—';
      return String(value);
    }
    function draftCard(record, draft){
      const card = el('article', 'selene-draft');
      const analyzed = draft && (draft.source === 'deepseek' || draft.source === 'local');
      card.appendChild(el('h3', '', analyzed ? (record.action === 'update' ? 'پیشنهاد تکمیل شناسنامه' : 'پیشنهاد ساخت تجهیز') : 'خواندن ستونی؛ بدون تحلیل مدل'));
      const summary = el('p', 'selene-evidence-summary', `منبع: ${sourceLabel(draft)}${record.confidence == null ? ' · اطمینان عددی: ثبت نشده' : ` · اطمینان کلی مدل: ${Math.round(record.confidence * 100)}٪`}`);
      card.appendChild(summary);
      const entries = record.coverage || [];
      const certain = entries.filter(item => item.status === 'found' && draft && draft.source === 'column-match');
      const suggested = entries.filter(item => item.status === 'found' && (!draft || draft.source !== 'column-match'));
      const defaulted = entries.filter(item => item.status === 'default');
      const incomplete = entries.filter(item => item.status === 'missing' || item.status === 'empty');
      const conflicts = state.current ? recordConflicts(record) : [];
      const group = (title, css, items, describe, emptyText='موردی ثبت نشده است.') => {
        const section = el('section', `selene-evidence-group ${css}`);
        section.appendChild(el('b', '', title));
        if (!items.length) section.appendChild(el('span', 'selene-evidence-empty', emptyText));
        items.forEach(item => section.appendChild(el('span', 'selene-evidence-item', `${item.label}: ${valueText(item.value)}${describe ? ` · ${describe}` : ''}`)));
        card.appendChild(section);
      };
      group('قطعی — مطابق ستون فایل', 'is-certain', certain, 'شاهد: مقدار خوانده‌شده از همان ستون فایل');
      group('پیشنهادی — نیازمند بازبینی', 'is-suggested', suggested, `منبع: ${sourceLabel(draft)} · نقل‌قول مستقل در دسترس نیست`);
      if (state.equipmentId) {
        if (state.current) group('متعارض با مقدار ثبت‌شده', 'is-conflict', conflicts.map(item=>({label:FIELD_LABELS[item.key]||item.key,value:`ثبت‌شده: ${valueText(item.current)} · پیشنهاد: ${valueText(item.proposed)}`})), '', 'با رکورد فعلی تعارضی در فیلدهای پیشنهادی دیده نشد.');
        else group('تعارض با پرونده موجود', 'is-conflict', [], '', state.currentStatus==='loading'?'در حال دریافت رکورد فعلی؛ مقایسه هنوز انجام نشده است.':'رکورد فعلی برای مقایسه در دسترس نیست؛ مقایسه در ویزارد دوباره انجام می‌شود.');
      }
      group('پیش‌فرض‌های نیازمند تأیید', 'is-default', defaulted, 'منشأ: مقدار پیش‌فرض سیستم؛ بدون تأیید ذخیره نمی‌شود');
      group('ناقص / ثبت‌نشده', 'is-incomplete', incomplete, 'سلن مقداری را حدس نمی‌زند');
      const footer = el('div', 'selene-draft-actions');
      const button = el('button', 'btn btn-sm btn-primary', record.action === 'update' && state.equipmentId ? 'بازبینی در ویزارد مشترک' : 'بازبینی در ویزارد مشترک');
      button.type = 'button';
      const note = el('div', 'selene-note', 'تحلیل هنوز ذخیره نشده است. مقادیر را در همان ویزارد تجهیز بازبینی کنید؛ ذخیره فقط پس از تأیید نهایی انجام می‌شود.');
      button.addEventListener('click', () => handoff(record, draft, button, note));
      footer.append(button, note);
      card.appendChild(footer);
      return card;
    }
    function proposedFromRecord(record){
      const proposed = {};
      for (const key of Object.keys(FIELD_LABELS)) {
        if (record[key] == null || record[key] === '') continue;
        proposed[key] = record[key];
      }
      if (Array.isArray(record.keyParts) && record.keyParts.length) proposed.keyParts = record.keyParts;
      return proposed;
    }
    function comparisonValue(key,value){
      if(value==null||value==='')return'';
      if(key==='install'||key==='installDate'){
        const text=String(value).trim(),iso=text.match(/^(\d{4}-\d{2}-\d{2})/);
        if(iso)return iso[1];
        const engine=window.BFGStepWizard,parts=engine&&engine.parseJalaliDate(text);
        if(parts)return`${parts.year}-${String(parts.month).padStart(2,'0')}-${String(parts.day).padStart(2,'0')}`;
      }
      if(Array.isArray(value))return JSON.stringify(value.map(item=>String(item).trim().toLowerCase()));
      return String(value).trim().toLowerCase();
    }
    function recordConflicts(record){
      const proposed=proposedFromRecord(record),conflicts=[];
      for(const [key,value] of Object.entries(proposed)){
        const current=state.current&&state.current[key];
        if(current==null||current===''||value==null||value==='')continue;
        if(comparisonValue(key,current)!==comparisonValue(key,value))conflicts.push({key,current,proposed:value});
      }
      return conflicts;
    }
    function currentForAction(current){
      const ext = current.ext || {};
      return {
        id: current.id, rowVersion: current.row_version || current.rowVersion,
        name: current.name || '', code: current.code || '', maker: current.maker || '',
        model: current.model || '', serial: current.serial || '', year: current.year || '',
        install: current.installDate || current.install_date || current.install || '',
        installDate: current.installDate || current.install_date || null, power: current.power || '',
        cls: current.cls || '', status: current.status || '', crit: current.crit || '',
        location: ext.locationDescription || current.location_name || current.location || '',
        notes: ext.description || current.general_notes || current.generalNotes || '',
        activityType: current.activity_type || current.activityType || '',
        manufacturerCountry: current.manufacturer_country || current.manufacturerCountry || '',
        operationalStatus: current.operational_status || current.operationalStatus || '',
        responsibleUserId: current.responsible_user_id || current.responsibleUserId || '',
        technicalSpecification: ext.technicalSpecification || current.technicalSpecification || '',
        capacity: ext.capacity || current.capacity || '', panelCode: ext.panelCode || current.panelCode || '',
        refrigerant: ext.refrigerant || current.refrigerant || '',
        dailyOperatingHours: ext.dailyOperatingHours ?? current.dailyOperatingHours ?? null,
        criticalityScore: ext.criticalityScore ?? current.criticalityScore ?? null,
        keyParts: Array.isArray(ext.keyParts) ? ext.keyParts : (current.keyParts || [])
      };
    }
    async function handoff(record, draft, button, note){
      if (typeof window.bfgApi !== 'function' || typeof window.eqv2OpenWizard !== 'function') {
        note.textContent = 'اتصال سرور یا ویزارد مشترک در دسترس نیست؛ هیچ داده‌ای ذخیره نشد.';
        return;
      }
      button.disabled = true;
      try {
        const completing = record.action === 'update' && state.equipmentId;
        let current = null;
        let recordVersion = null;
        if (completing) {
          const loaded = await window.bfgApi('/api/equipment/' + encodeURIComponent(state.equipmentId));
          current = currentForAction(loaded.data || {});
          recordVersion = current.rowVersion || null;
          if (!recordVersion) throw new Error('ROW_VERSION_REQUIRED');
        }
        const proposed = proposedFromRecord(record);
        if (!proposed.nodeKind && !completing) proposed.nodeKind = 'equipment';
        const sourceRef = state.sessionId || (record.sourceRef || 'selene-intake');
        const evidence = (record.coverage || []).filter(item => item.status === 'found' || item.status === 'default').map(item => ({
          field: item.key, value: item.value, origin: item.status === 'default' ? 'system-default' : (draft.source === 'column-match' ? 'matched-source-column' : 'model-suggestion'),
          sourceRef, confidence: record.confidence
        }));
        const created = await window.bfgApi('/api/equipment/actions/drafts', {
          method: 'POST',
          body: JSON.stringify({
            actionType: completing ? 'equipment.complete' : 'equipment.create',
            proposed, targetId: completing ? state.equipmentId : null,
            recordVersion, current,
            source: { kind: state.sessionId ? 'import-session' : (draft.source === 'column-match' ? 'document' : 'text'), ref: sourceRef, verified: false },
            evidence, confidence: record.confidence
          })
        });
        const actionDraft = created.data;
        if (!actionDraft || !actionDraft.id) throw new Error('ACTION_DRAFT_NOT_CREATED');
        note.textContent = actionDraft.status === 'conflict'
          ? 'تعارض با مقدار ثبت‌شده پیدا شد؛ در ویزارد مقدارها را مقایسه و صریحاً تأیید کنید.'
          : actionDraft.status === 'incomplete'
            ? 'پیش‌نویس ناقص است؛ در ویزارد فقط داده واقعی را تکمیل کنید.'
            : 'پیشنهاد در سرور پیش‌نویس شد؛ هنوز هیچ رکورد تجهیزی ذخیره نشده است.';
        window.eqv2OpenWizard({
          source: 'selene', record, actionDraft, current, targetId: completing ? state.equipmentId : null,
          sessionId: state.sessionId, provider: draft.source, returnTab: window.EQV2?.intakeReturn?.tab || 'technical'
        });
      } catch (error) {
        button.disabled = false;
        note.textContent = 'آماده‌سازی پیش‌نویس انجام نشد: ' + ((error.payload && error.payload.error) || error.message || 'REQUEST_FAILED');
      }
    }
    async function openSession(id){
      state.sessionId = id;
      paintSessions();
      if (typeof window.bfgApi !== 'function') return;
      try {
        const result = await window.bfgApi('/api/equipment/import/sessions/' + encodeURIComponent(id));
        state.messages = (result.data || []).map(row => ({
          role: row.role, body: row.body, attachment: row.attachment, draft: row.draft,
          intent: row.draft && row.draft.intent, gaps: row.draft && row.draft.gaps, notice: null
        }));
        paint();
      } catch (_) { welcome(); }
    }
    async function loadSessions(){
      if (typeof window.bfgApi !== 'function') return;
      try {
        const result = await window.bfgApi('/api/equipment/import/sessions');
        state.sessions = result.data || [];
        paintSessions();
      } catch (_) {}
    }
    async function loadCurrentEquipment(){
      if(!state.equipmentId||typeof window.bfgApi!=='function')return;
      try{
        const result=await window.bfgApi('/api/equipment/'+encodeURIComponent(state.equipmentId));
        if(!result||!result.data||!result.data.id)throw new Error('EQUIPMENT_NOT_FOUND');
        state.current=currentForAction(result.data);state.currentStatus='ready';
      }catch(_){state.current=null;state.currentStatus='unavailable';}
      if(state.messages.length)paint();
    }
    function pushLocal(message){ state.messages.push(message); paint(); }
    async function submit(event){
      event.preventDefault();
      const text = area.value.trim();
      if (state.sending || (!text && !state.file)) return;
      state.sending = true;
      syncSend();
      const file = state.file;
      pushLocal({ role: 'user', body: text || file.name, attachment: file ? { name: file.name } : null });
      const pending = el('div', 'selene-assistant');
      const typing = el('div', 'selene-typing');
      typing.append(el('i'), el('i'), el('i'));
      pending.append(seal(), typing);
      column.appendChild(pending);
      scroll();
      area.value = '';
      state.file = null;
      paintChips();
      try {
        const data = file ? await sendFile(file, text) : await sendText(text);
        state.sessionId = data.sessionId || state.sessionId;
        state.messages.push({ role: 'assistant', body: data.reply, draft: data.draft, intent: data.draft && data.draft.intent, gaps: data.draft && data.draft.gaps, notice: data.notice });
        if (data.sessionId && !state.sessions.some(item => item.id === data.sessionId)) {
          state.sessions.unshift({ id: data.sessionId, title: text || file.name });
        }
      } catch (error) {
        const code = error && error.payload && error.payload.error;
        state.messages.push({ role: 'assistant', body: MESSAGES[code] || 'تحلیل در سرور انجام نشد.', notice: code || null, draft: { records: [] } });
      } finally {
        state.sending = false;
        syncSend();
        paint();
        paintSessions();
      }
    }
    async function sendText(text){
      return (await window.bfgApi('/api/equipment/import/analyze', {
        method: 'POST',
        body: JSON.stringify({ text, equipmentId: state.equipmentId, sessionId: state.sessionId, history: state.messages.slice(0, -1).slice(-8) })
      })).data;
    }
    async function sendFile(file, text){
      const params = new URLSearchParams();
      if (text) params.set('caption', text);
      if (state.equipmentId) params.set('equipmentId', state.equipmentId);
      if (state.sessionId) params.set('sessionId', state.sessionId);
      const response = await fetch('/api/equipment/import/files?' + params.toString(), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': file.name, 'x-csrf-token': csrf() },
        body: file
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || 'BACKEND_REQUEST_FAILED');
        error.payload = payload;
        throw error;
      }
      return payload.data;
    }
    function takeFile(file){
      if (!file) return;
      const ext = file.name.split('.').pop().toLowerCase();
      if (!['md', 'xlsx', 'csv', 'pdf', 'jpg', 'jpeg'].includes(ext)) {
        pushLocal({ role: 'assistant', body: MESSAGES.FILE_TYPE_REJECTED, draft: { records: [] } });
        return;
      }
      state.file = file;
      paintChips();
      syncSend();
    }
    fresh.addEventListener('click', () => { state.sessionId = null; state.messages = []; state.file = null; paintChips(); paint(); paintSessions(); });
    plus.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { takeFile(fileInput.files && fileInput.files[0]); fileInput.value = ''; });
    area.addEventListener('input', syncSend);
    area.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); } });
    composer.addEventListener('submit', submit);
    shell.addEventListener('dragover', event => { event.preventDefault(); shell.classList.add('selene-drop'); });
    shell.addEventListener('dragleave', () => shell.classList.remove('selene-drop'));
    shell.addEventListener('drop', event => { event.preventDefault(); shell.classList.remove('selene-drop'); takeFile(event.dataTransfer.files && event.dataTransfer.files[0]); });
    welcome();
    loadSessions();
    loadCurrentEquipment();
  }

  window.BFGSelene = { mount };
})();
