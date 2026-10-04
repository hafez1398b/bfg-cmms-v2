/* Selene equipment assistant. Analysis stays on the server. The browser keeps no key and no file bytes. */
(function(){
  'use strict';
  const ACCEPT = '.md,.xlsx,.csv,.pdf,.jpg,.jpeg';
  const FIELDS = [
    ['name', 'نام تجهیز', 'ثبت'], ['code', 'کد تجهیز', 'ثبت'], ['nodeKind', 'نوع گره', 'ثبت'],
    ['maker', 'سازنده', 'شناسنامه'], ['model', 'مدل', 'شناسنامه'], ['serial', 'سریال', 'شناسنامه'],
    ['year', 'سال ساخت', 'شناسنامه'], ['install', 'تاریخ نصب', 'شناسنامه'], ['power', 'توان', 'شناسنامه'],
    ['capacity', 'ظرفیت', 'شناسنامه'], ['location', 'محل استقرار', 'شناسنامه'], ['cls', 'کلاس', 'شناسنامه'],
    ['status', 'وضعیت', 'شناسنامه'], ['crit', 'بحرانیت', 'شناسنامه'],
    ['technicalSpecification', 'مشخصات فنی', 'تکمیل'], ['notes', 'شرح', 'تکمیل'],
    ['panelCode', 'تابلو برق', 'تکمیل'], ['refrigerant', 'نوع مبرد', 'تکمیل'],
    ['dailyOperatingHours', 'کارکرد روزانه', 'تکمیل'], ['criticalityScore', 'امتیاز بحرانی', 'تکمیل'],
    ['keyParts', 'قطعات کلیدی', 'تکمیل']
  ];
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
    const state = { sessionId: null, equipmentId: opts.equipmentId || null, messages: [], file: null, sending: false, sessions: [] };
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
    function draftCard(record, draft){
      const card = el('article', 'selene-draft');
      const analyzed = draft && (draft.source === 'deepseek' || draft.source === 'local');
      card.appendChild(el('h3', '', analyzed ? (record.action === 'update' ? 'پیش‌نویس تکمیل شناسنامه' : 'پیش‌نویس ساخت تجهیز') : 'خواندن ستونی؛ هنوز تحلیل مدل نیست'));
      card.appendChild(coverage(record));
      const grid = el('div', 'selene-grid');
      const inputs = {};
      FIELDS.forEach(([key, label]) => {
        const field = el('label', key === 'technicalSpecification' || key === 'notes' || key === 'keyParts' ? 'wide' : '', label);
        const input = document.createElement(key === 'status' || key === 'crit' || key === 'nodeKind' ? 'select' : (key === 'technicalSpecification' || key === 'notes' ? 'textarea' : 'input'));
        if (key === 'nodeKind') ['equipment', 'sub-equipment', 'subsystem', 'main-component', 'sub-component'].forEach((value, index) => input.appendChild(option(value, ['تجهیز', 'زیرتجهیز', 'زیرسیستم', 'جزء اصلی', 'جزء فرعی'][index])));
        if (key === 'status') [['', '—'], ['active', 'فعال'], ['standby', 'آماده'], ['repair', 'تعمیر'], ['stopped', 'توقف']].forEach(([value, name]) => input.appendChild(option(value, name)));
        if (key === 'crit') [['', '—'], ['A', 'A'], ['B', 'B'], ['C', 'C']].forEach(([value, name]) => input.appendChild(option(value, name)));
        input.value = key === 'keyParts' && Array.isArray(record.keyParts) ? record.keyParts.join('، ') : (record[key] || '');
        inputs[key] = input;
        field.appendChild(input);
        grid.appendChild(field);
      });
      card.appendChild(grid);
      const button = el('button', 'btn btn-sm btn-primary', record.action === 'update' && state.equipmentId ? 'تکمیل شناسنامه' : 'ثبت تجهیز');
      button.type = 'button';
      const note = el('div', 'selene-note', record.missing && record.missing.length ? 'نام و کد باید قبل از ثبت کامل شوند. سلن آن‌ها را حدس نمی‌زند.' : 'ثبت فقط با این دکمه انجام می‌شود.');
      button.addEventListener('click', () => place(record, inputs, button, note));
      card.append(button, note);
      return card;
    }
    function parts(value){
      return String(value || '').split(/[،,\n]/).map(part => part.trim()).filter(Boolean);
    }
    async function place(record, inputs, button, note){
      const name = inputs.name.value.trim();
      const code = inputs.code.value.trim();
      if (!name || !code) { note.textContent = 'نام و کد الزامی است و سلن آن را حدس نمی‌زند.'; return; }
      if (typeof window.bfgApi !== 'function') { note.textContent = 'نشاندن داده فقط از سرور مرکزی انجام می‌شود.'; return; }
      button.disabled = true;
      const completing = record.action === 'update' && state.equipmentId;
      const proposed = { name, code, nodeKind: inputs.nodeKind.value || record.nodeKind || '' };
      ['maker', 'model', 'serial', 'year', 'install', 'power', 'cls', 'location', 'notes', 'technicalSpecification', 'capacity', 'panelCode', 'refrigerant'].forEach(key => {
        const value = inputs[key] && inputs[key].value.trim();
        if (value) proposed[key] = value;
      });
      if (inputs.status.value) proposed.status = inputs.status.value;
      if (inputs.crit.value) proposed.crit = inputs.crit.value;
      const hours = inputs.dailyOperatingHours.value.trim();
      const score = inputs.criticalityScore.value.trim();
      if (hours) proposed.dailyOperatingHours = hours;
      if (score) proposed.criticalityScore = score;
      const keyParts = parts(inputs.keyParts.value);
      if (keyParts.length) proposed.keyParts = keyParts;
      const evidence = Object.keys(proposed).map(field => ({ field, value: proposed[field], origin: record[field] ? 'source' : 'user' }));
      try {
        let recordVersion = null;
        let current = null;
        if (completing) {
          const loaded = await window.bfgApi('/api/equipment/' + encodeURIComponent(state.equipmentId));
          current = loaded.data || {};
          recordVersion = current.row_version || current.rowVersion || null;
        }
        const created = await window.bfgApi('/api/equipment/actions/drafts', {
          method: 'POST',
          body: JSON.stringify({
            actionType: completing ? 'equipment.complete' : 'equipment.create',
            proposed,
            targetId: completing ? state.equipmentId : null,
            recordVersion,
            current,
            source: { kind: state.sessionId ? 'import-session' : 'user-confirmed-form', ref: state.sessionId || 'typed-text', verified: true },
            evidence,
            confidence: record.confidence == null ? null : record.confidence
          })
        });
        const draft = created.data;
        if (!draft || draft.status !== 'pending') {
          button.disabled = false;
          note.textContent = draft && draft.status === 'conflict' ? 'تعارض اطلاعات باید قبل از تأیید حل شود.' : 'داده کافی نیست؛ فقط پیش‌نویس ناقص ساخته شد و ثبت نهایی انجام نمی‌شود.';
          return;
        }
        const confirmation = await window.bfgApi('/api/equipment/actions/drafts/' + encodeURIComponent(draft.id) + '/confirm', { method: 'POST', body: '{}' });
        const requestId = window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'req-' + Date.now();
        const result = await window.bfgApi('/api/equipment/actions/drafts/' + encodeURIComponent(draft.id) + '/execute', {
          method: 'POST',
          body: JSON.stringify({ confirmationId: confirmation.data.id, requestId })
        });
        if (!result || result.committed !== true) throw new Error('NOT_COMMITTED');
        note.textContent = 'پس از تأیید پایگاه داده ثبت شد. شناسنامه را تازه کنید تا داده ثبت‌شده را ببینید.';
      } catch (error) {
        button.disabled = false;
        note.textContent = 'ثبت در سرور انجام نشد: ' + ((error.payload && error.payload.error) || 'REQUEST_FAILED');
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
  }

  window.BFGSelene = { mount };
})();
