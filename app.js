/* ============================================================
   iChat — app.js
   الترتيب: ثوابت → أدوات → حالة → تخزين → عرض → أحداث → init
   ============================================================ */
'use strict';

/* ===== ثوابت ===== */
const APP_VERSION = 'v1.0.2';            // تزامن مع VERSION في sw.js
const LS_PREFS = 'ichat:prefs';
const LS_CHATS = 'ichat:chats';
const LS_UI    = 'ichat:ui';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODELS = [
  { id:'gemini-2.5-flash', name:'Gemini 2.5 Flash' },
  { id:'gemini-2.5-pro',   name:'Gemini 2.5 Pro' },
  { id:'gemini-2.0-flash', name:'Gemini 2.0 Flash' },
  { id:'gemini-1.5-flash', name:'Gemini 1.5 Flash' }
];
const CHATS_CAP = 50;
const BLOB_CAP = 120;
const STREAM_FLUSH_MS = 420;   // تجميع تحديثات البث قبل رسمها

/* ===== أدوات عامة ===== */
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtNum(n) {
  try { return Number(n || 0).toLocaleString('en-US'); } catch (e) { return String(n || 0); }
}
function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function relTime(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'الآن';
  if (diff < 3600) return 'منذ ' + Math.floor(diff / 60) + ' د';
  if (diff < 86400) return 'منذ ' + Math.floor(diff / 3600) + ' س';
  return 'منذ ' + Math.floor(diff / 86400) + ' يوم';
}
function vibrate(ms) { try { navigator.vibrate && navigator.vibrate(ms || 10); } catch (e) {} }

/* كاش LRU لعناوين blob */
const blobCache = new Map();
function blobURL(blob) {
  const url = URL.createObjectURL(blob);
  blobCache.set(url, Date.now());
  if (blobCache.size > BLOB_CAP) {
    const oldest = blobCache.keys().next().value;
    try { URL.revokeObjectURL(oldest); } catch (e) {}
    blobCache.delete(oldest);
  }
  return url;
}
function revokeAllBlobs() {
  for (const u of blobCache.keys()) { try { URL.revokeObjectURL(u); } catch (e) {} }
  blobCache.clear();
}

/* ===== حالة مركزية ===== */
const DEFAULT_PREFS = {
  theme: 'dark', glass: 'soft', bg: 'on',
  model: 'gemini-2.5-flash', key: '',
  usage: { d: '', req: 0, tok: 0 }
};
let prefs = { ...DEFAULT_PREFS, usage: { ...DEFAULT_PREFS.usage } };
const state = {
  tab: 'chat',        // chat | chats
  chats: [],          // [{id,title,ts,updated,msgs:[{role,text}]}]
  cur: null,          // id المحادثة الحالية
  streaming: false,
  pinned: true,       // تثبيت التمرير التلقائي
  conn: 'idle',       // idle | ok | busy | err
  retryDelay: 2000,
  abort: null
};

/* ===== طبقة التخزين (localStorage) ===== */
function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_PREFS) || '{}');
    prefs = { ...DEFAULT_PREFS, ...raw, usage: { ...DEFAULT_PREFS.usage, ...(raw.usage || {}) } };
  } catch (e) { prefs = { ...DEFAULT_PREFS, usage: { ...DEFAULT_PREFS.usage } }; }
}
function savePrefs() {
  try { localStorage.setItem(LS_PREFS, JSON.stringify(prefs)); } catch (e) {}
}
function loadChats() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_CHATS) || '[]');
    state.chats = Array.isArray(arr) ? arr.filter(c => c && c.id) : [];
  } catch (e) { state.chats = []; }
}
function saveChats() {
  try { localStorage.setItem(LS_CHATS, JSON.stringify(state.chats)); } catch (e) {}
}
function loadUI() {
  try { return JSON.parse(localStorage.getItem(LS_UI) || '{}') || {}; } catch (e) { return {}; }
}
function saveUI() {
  try { localStorage.setItem(LS_UI, JSON.stringify({ tab: state.tab, chat: state.cur })); } catch (e) {}
}
function getChat(id) { return state.chats.find(c => c.id === id) || null; }

/* ===== مراجع DOM ===== */
const el = {};
/* ===== دوال العرض ===== */
function cacheDOM() {
  el.bg = $('#bg'); el.updateBar = $('#updateBar'); el.btnUpdate = $('#btnUpdate');
  el.connStatus = $('#connStatus'); el.usagePill = $('#usagePill');
  el.tabs = $('#tabs'); el.ink = $('#tabInk');
  el.chatScroll = $('#chatScroll'); el.messages = $('#messages'); el.chatEmpty = $('#chatEmpty');
  el.composer = $('#composer'); el.input = $('#input'); el.btnSend = $('#btnSend');
  el.viewChat = $('#view-chat'); el.viewChats = $('#view-chats');
  el.chatsEmpty = $('#chatsEmpty'); el.chatList = $('#chatList');
  el.sheet = $('#sheetSettings'); el.sheetBackdrop = $('#sheetBackdrop');
  el.optList = $('#optList');
  el.valTheme = $('#valTheme'); el.valGlass = $('#valGlass'); el.valBg = $('#valBg');
  el.valModel = $('#valModel'); el.valKey = $('#valKey'); el.valUsage = $('#valUsage');
  el.valVersion = $('#valVersion');
  el.modalKey = $('#modalKey'); el.inputKey = $('#inputKey'); el.btnSaveKey = $('#btnSaveKey');
  el.modalConfirm = $('#modalConfirm'); el.confirmTitle = $('#confirmTitle');
  el.confirmMsg = $('#confirmMsg'); el.btnConfirmYes = $('#btnConfirmYes'); el.btnConfirmNo = $('#btnConfirmNo');
  el.toasts = $('#toasts');
}

/* توست قصير بعد كل فعل مهم */
function toast(msg, type) {
  try {
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    el.toasts.appendChild(t);
    while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 2600);
    vibrate(8);
  } catch (e) {}
}

/* مودالات عامة (بدون confirm/alert الأصلية) */
function openModal(backdrop) {
  backdrop.hidden = false;
  requestAnimationFrame(() => backdrop.classList.add('show'));
}
function closeModal(backdrop) {
  backdrop.classList.remove('show');
  setTimeout(() => { backdrop.hidden = true; }, 230);
}
function confirmBox(title, msg) {
  return new Promise(resolve => {
    el.confirmTitle.textContent = title;
    el.confirmMsg.textContent = msg;
    openModal(el.modalConfirm);
    const done = val => {
      el.btnConfirmYes.onclick = el.btnConfirmNo.onclick = null;
      closeModal(el.modalConfirm);
      resolve(val);
    };
    el.btnConfirmYes.onclick = () => done(true);
    el.btnConfirmNo.onclick = () => done(false);
  });
}

/* ورقة الإعدادات */
function openSheet() { el.sheetBackdrop.hidden = false; el.sheet.hidden = false; requestAnimationFrame(() => { el.sheetBackdrop.classList.add('show'); el.sheet.classList.add('open'); }); }
function closeSheet() {
  el.sheetBackdrop.classList.remove('show'); el.sheet.classList.remove('open');
  setTimeout(() => { el.sheetBackdrop.hidden = true; el.sheet.hidden = true; closeOptList(); }, 320);
}
/* قائمة اختيار بعلامة ✓ فقط */
function openOptList(title, options, current, onPick) {
  el.optList.textContent = '';
  const h = document.createElement('div');
  h.style.cssText = 'font-weight:800;font-size:15px;padding:6px 14px 10px';
  h.textContent = title;
  el.optList.appendChild(h);
  options.forEach(op => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt' + (op.v === current ? ' sel' : '');
    const nm = document.createElement('span');
    nm.textContent = op.n;
    const tk = document.createElement('span');
    tk.className = 'tick';
    tk.textContent = '✓';
    b.append(nm, tk);
    b.onclick = () => { closeOptList(); onPick(op.v); };
    el.optList.appendChild(b);
  });
  el.optList.hidden = false;
}
function closeOptList() { el.optList.hidden = true; }

/* تطبيق prefs على الواجهة */
const THEME_L = { dark:'داكن', light:'فاتح' };
const GLASS_L = { clear:'شفاف', soft:'ناعم', solid:'مصنّر', off:'بلا (كلاسيكي)' };
function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.glass = prefs.glass;
  if (prefs.bg === 'off') document.documentElement.dataset.bg = 'off';
  else delete document.documentElement.dataset.bg;
  const mt = $('#metaTheme');
  if (mt) mt.content = prefs.theme === 'light' ? '#eef1f8' : '#0b0e17';
  el.valTheme.textContent = THEME_L[prefs.theme] || prefs.theme;
  el.valGlass.textContent = GLASS_L[prefs.glass] || prefs.glass;
  el.valBg.textContent = prefs.bg === 'off' ? 'بلا' : 'متحركة';
  const m = MODELS.find(x => x.id === prefs.model);
  el.valModel.textContent = m ? m.id : prefs.model;
  el.valKey.textContent = prefs.key ? 'محفوظ ✓' : 'غير محفوظ';
  el.valVersion.textContent = APP_VERSION;
  renderUsage();
  bgfx && bgfx.refresh();
}

/* الاستخدام اليومي */
function bumpUsage(tokens) {
  if (prefs.usage.d !== today()) prefs.usage = { d: today(), req: 0, tok: 0 };
  prefs.usage.req++;
  prefs.usage.tok += tokens || 0;
  savePrefs();
  renderUsage();
}
function renderUsage() {
  if (prefs.usage.d !== today()) { el.usagePill.textContent = '⚡ 0 طلب'; el.valUsage.textContent = '0 طلب'; return; }
  el.usagePill.textContent = '⚡ ' + fmtNum(prefs.usage.req) + ' طلب · ~' + fmtNum(prefs.usage.tok) + ' ت';
  el.usagePill.classList.add('tnum');
  el.valUsage.textContent = fmtNum(prefs.usage.req) + ' طلب · ~' + fmtNum(prefs.usage.tok) + ' توكن';
}

/* حالة الاتصال في الهيدر */
function setConn(status, text) {
  state.conn = status;
  el.connStatus.className = 'status ' + (status === 'ok' ? 'ok' : status === 'busy' ? 'busy' : status === 'err' ? 'err' : '');
  el.connStatus.innerHTML = '';
  const dot = document.createElement('i');
  dot.className = 'dot';
  const span = document.createElement('span');
  span.textContent = text;
  el.connStatus.append(dot, span);
}

/* ===== Markdown مصغّر (بلا مكتبات) ===== */
function mdInline(s) {
  s = s.replace(/`([^`]+)`/g, (m, c) => '<code>' + c + '</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
function md(src) {
  let s = esc(src || '');
  const blocks = [];
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    blocks.push({ lang: lang || 'code', code: code.replace(/\n$/, '') });
    return '\u0000B' + (blocks.length - 1) + '\u0000';
  });
  const lines = s.split('\n');
  let out = '', list = null, table = null;
  const flushList = () => { if (list) { out += '<' + list + '>' + '</' + list + '>'; list = null; } };
  const flushTable = () => {
    if (table && table.length) {
      let t = '<table><thead><tr>';
      table[0].forEach(c => t += '<th>' + mdInline(c) + '</th>');
      t += '</tr></thead><tbody>';
      for (let i = 1; i < table.length; i++) {
        t += '<tr>';
        table[i].forEach(c => t += '<td>' + mdInline(c) + '</td>');
        t += '</tr>';
      }
      out += t + '</tbody></table>';
    }
    table = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bm = line.match(/^\u0000B(\d+)\u0000$/);
    if (bm) { flushList(); flushTable(); const b = blocks[+bm[1]]; out += codeBlockHTML(b); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushList(); flushTable(); out += '<h' + h[1].length + '>' + mdInline(h[2]) + '</h' + h[1].length + '>'; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flushList(); flushTable(); out += '<hr>'; continue; }
    if (/^```/.test(line)) continue;
    const tq = line.match(/^&gt;\s?(.*)$/);
    if (tq) { flushList(); flushTable(); out += '<blockquote>' + mdInline(tq[1]) + '</blockquote>'; continue; }
    if (/^\|(.+)\|$/.test(line)) {
      flushList();
      const cells = line.slice(1, -1).split('|').map(c => c.trim());
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
      if (!table) table = [];
      table.push(cells);
      continue;
    } else flushTable();
    const ul = line.match(/^\s*[-•*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul) { if (list !== 'ul') { flushList(); out += list === 'ol' ? '</ol>' : ''; list = 'ul'; out += '<ul>'; } out += '<li>' + mdInline(ul[1]) + '</li>'; continue; }
    if (ol) { if (list !== 'ol') { flushList(); out += list === 'ul' ? '</ul>' : ''; list = 'ol'; out += '<ol>'; } out += '<li>' + mdInline(ol[1]) + '</li>'; continue; }
    if (list) { out += '</' + list + '>'; list = null; }
    if (line.trim() === '') continue;
    out += '<p>' + mdInline(line) + '</p>';
  }
  flushList(); flushTable();
  for (let i = 0; i < blocks.length; i++) {
    out = out.replace('\u0000B' + i + '\u0000', codeBlockHTML(blocks[i]));
  }
  return out;
}
function codeBlockHTML(b) {
  return '<div class="codeblock"><div class="cb-head"><span>' + esc(b.lang) +
    '</span><button class="cb-copy" type="button" data-code="' + esc(b.code) + '">نسخ</button></div><pre>' +
    esc(b.code) + '</pre></div>';
}
/* ===== عرض الرسائل والمحادثات ===== */
const SPARK_SVG = '<svg viewBox="0 0 48 48"><path d="M24 6 L28 19 L41 24 L28 29 L24 42 L20 29 L7 24 L20 19 Z" fill="currentColor"/></svg>';

function switchTab(tab) {
  state.tab = tab;
  const chatActive = tab === 'chat';
  el.viewChat.hidden = !chatActive;
  el.viewChats.hidden = chatActive;
  $$('.tab', el.tabs).forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  el.ink.style.transform = tab === 'chats' ? 'translateX(-100%)' : 'translateX(0)';
  if (!chatActive) renderChatList();
  saveUI();
}

/* تمرير ذكي: يتوقف إذا أزل المستخدم لأعلى */
function bindScrollPinning() {
  el.chatScroll.addEventListener('scroll', () => {
    const nearBottom = el.chatScroll.scrollHeight - el.chatScroll.scrollTop - el.chatScroll.clientHeight < 90;
    state.pinned = nearBottom;
  }, { passive: true });
}
function scrollBottom(force) {
  if (!force && !state.pinned) return;
  el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
}

/* بناء رسالة واحدة */
function msgNode(m) {
  const wrap = document.createElement('div');
  if (m.role === 'user') {
    wrap.className = 'msg user';
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = m.text;
    wrap.appendChild(b);
  } else {
    wrap.className = 'msg ai';
    const av = document.createElement('div');
    av.className = 'avatar';
    av.innerHTML = SPARK_SVG;
    const b = document.createElement('div');
    b.className = 'bubble md';
    b.innerHTML = md(m.text);
    wrap.append(av, b);
    if (m.fail) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = '↻ إعادة المحاولة';
      chip.onclick = () => retryLast();
      wrap.appendChild(chip);
    }
  }
  return wrap;
}

/* إعادة رسم كامل لمحادثة */
function renderChat() {
  const chat = getChat(state.cur);
  el.messages.textContent = '';
  const has = chat && chat.msgs.length;
  el.chatEmpty.hidden = !!has;
  if (has) {
    chat.msgs.forEach(m => el.messages.appendChild(msgNode(m)));
    state.pinned = true;
    requestAnimationFrame(() => scrollBottom(true));
  }
}

/* قائمة المحادثات */
function renderChatList() {
  el.chatList.textContent = '';
  const sorted = [...state.chats].sort((a, b) => (b.updated || b.ts) - (a.updated || a.ts));
  el.chatsEmpty.hidden = sorted.length > 0;
  sorted.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'chat-item' + (c.id === state.cur ? ' open' : '');
    row.style.animationDelay = Math.min(i * 45, 400) + 'ms';
    const ico = document.createElement('div');
    ico.className = 'ci-ico';
    ico.innerHTML = SPARK_SVG;
    const main = document.createElement('div');
    main.className = 'ci-main';
    const ti = document.createElement('div');
    ti.className = 'ci-title';
    ti.textContent = c.title || 'محادثة';
    const sub = document.createElement('div');
    sub.className = 'ci-sub tnum';
    sub.textContent = (c.msgs ? c.msgs.length : 0) + ' رسالة · ' + relTime(c.updated || c.ts);
    main.append(ti, sub);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn sm';
    del.title = 'حذف';
    del.setAttribute('aria-label', 'حذف المحادثة');
    del.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h2v-8H10zm4 0v8h2v-8h-2z" fill="currentColor"/></svg>';
    del.onclick = async ev => {
      ev.stopPropagation();
      const ok = await confirmBox('حذف المحادثة', 'سيتم حذف «' + (c.title || 'بدون عنوان') + '» نهائيًا من هذا الجهاز.');
      if (!ok) return;
      state.chats = state.chats.filter(x => x.id !== c.id);
      if (state.cur === c.id) { state.cur = null; renderChat(); }
      saveChats(); saveUI(); renderChatList();
      toast('حُذفت المحادثة', 'ok');
    };
    row.append(ico, main, del);
    row.onclick = () => {
      state.cur = c.id;
      switchTab('chat');
      renderChat();
      saveUI();
    };
    el.chatList.appendChild(row);
  });
}

/* محادثة جديدة */
function newChat(silent) {
  const c = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: 'محادثة جديدة', ts: Date.now(), updated: Date.now(), msgs: [] };
  state.chats.push(c);
  state.cur = c.id;
  saveChats(); saveUI();
  if (state.tab !== 'chat') switchTab('chat');
  renderChat();
  if (!silent) { toast('بدأت محادثة جديدة', 'ok'); el.input.focus(); }
  return c;
}
function ensureChat() { return getChat(state.cur) || newChat(true); }

/* نسخ كتلة الكود (تفويض أحداث) */
function bindCopy() {
  el.messages.addEventListener('click', ev => {
    const btn = ev.target.closest('.cb-copy');
    if (!btn) return;
    const code = btn.dataset.code || '';
    const done = () => { btn.textContent = 'تم ✓'; setTimeout(() => { btn.textContent = 'نسخ'; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(() => fallbackCopy(code, done));
    } else fallbackCopy(code, done);
  });
}
function fallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  } catch (e) { toast('تعذّر النسخ', 'err'); }
}
/* ===== الخلفية المتحركة (Canvas) — شبكة جزيئات أنيقة ===== */
const bgfx = {
  cv: null, ctx: null, raf: 0, parts: [], w: 0, h: 0, colors: null,
  start() {
    this.cv = el.bg;
    if (!this.cv) return;
    this.ctx = this.cv.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop(); else if (prefs.bg !== 'off') this.loop();
    });
    this.refresh();
    this.loop();
  },
  resize() {
    if (!this.cv) return;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    this.w = window.innerWidth; this.h = window.innerHeight;
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(this.h * dpr);
    this.cv.style.width = this.w + 'px';
    this.cv.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.seed();
  },
  seed() {
    const n = clamp(Math.round((this.w * this.h) / 26000), 24, 70);
    this.parts = [];
    for (let i = 0; i < n; i++) {
      this.parts.push({
        x: Math.random() * this.w, y: Math.random() * this.h,
        vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35,
        r: 1.2 + Math.random() * 2.4
      });
    }
  },
  refresh() {
    const cs = getComputedStyle(document.documentElement);
    const isLight = document.documentElement.dataset.theme === 'light';
    this.colors = isLight
      ? { dot: 'rgba(47,107,255,', line: 'rgba(47,107,255,', glow: 'rgba(79,141,255,.10)' }
      : { dot: 'rgba(79,141,255,', line: 'rgba(79,141,255,', glow: 'rgba(79,141,255,.07)' };
  },
  loop() {
    if (!this.ctx || prefs.bg === 'off') return;
    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    const grad = this.ctx.createRadialGradient(this.w * .8, this.h * .1, 0, this.w * .8, this.h * .1, this.w * .9);
    grad.addColorStop(0, this.colors.glow);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.w, this.h);
    const P = this.parts;
    for (const p of P) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < -20) p.x = this.w + 20; if (p.x > this.w + 20) p.x = -20;
      if (p.y < -20) p.y = this.h + 20; if (p.y > this.h + 20) p.y = -20;
    }
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const dx = P[i].x - P[j].x, dy = P[i].y - P[j].y;
        const d = Math.hypot(dx, dy);
        if (d < 130) {
          ctx.strokeStyle = this.colors.line + (0.16 * (1 - d / 130)).toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(P[i].x, P[i].y); ctx.lineTo(P[j].x, P[j].y); ctx.stroke();
        }
      }
    }
    for (const p of P) {
      ctx.fillStyle = this.colors.dot + '.55)';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    this.raf = requestAnimationFrame(() => this.loop());
  },
  stop() { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; } }
};

/* ===== طبقة API — Gemini مع بث SSE ===== */
function apiHeaders() { return { 'Content-Type': 'application/json' }; }
function buildContents(chat) {
  return chat.msgs.filter(m => !m.fail).map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
}

async function sendToAI(userText) {
  if (!prefs.key) {
    toast('أدخل مفتاح API من الإعدادات أولًا', 'err');
    openModal(el.modalKey);
    return;
  }
  const chat = ensureChat();
  if (userText) {
    chat.msgs.push({ role: 'user', text: userText });
    if (chat.title === 'محادثة جديدة') chat.title = userText.slice(0, 40);
  }
  state.streaming = true;
  state.pinned = true;
  renderChat();
  setSendMode(true);
  setConn('busy', 'جارٍ الاتصال…');
  el.chatEmpty.hidden = true;

  // فقاعة بث مباشر
  const wrap = document.createElement('div');
  wrap.className = 'msg ai';
  const av = document.createElement('div');
  av.className = 'avatar';
  av.innerHTML = SPARK_SVG;
  const bub = document.createElement('div');
  bub.className = 'bubble md';
  bub.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  wrap.append(av, bub);
  el.messages.appendChild(wrap);
  requestAnimationFrame(() => scrollBottom(true));

  let buf = '';
  let usageTokens = 0;
  let pendingRender = false;
  const flushTimer = setInterval(() => {
    if (!pendingRender) return;
    pendingRender = false;
    bub.innerHTML = md(buf);
    scrollBottom();
  }, STREAM_FLUSH_MS);

  state.abort = new AbortController();
  try {
    const url = API_BASE + '/models/' + encodeURIComponent(prefs.model) + ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(prefs.key);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ contents: buildContents(chat), generationConfig: { temperature: 0.7 } }),
      signal: state.abort.signal
    });
    if (!res.ok) {
      let em = 'فشل الطلب (' + res.status + ')';
      try { const j = await res.json(); em = j?.error?.message || em; } catch (e) {}
      throw new Error(em);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let sse = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sse += dec.decode(value, { stream: true });
      const lines = sse.split('\n');
      sse = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const parts = j?.candidates?.[0]?.content?.parts || [];
          for (const p of parts) if (p.text) buf += p.text;
          if (j?.usageMetadata?.totalTokenCount) usageTokens = j.usageMetadata.totalTokenCount;
          pendingRender = true;
        } catch (e) {}
      }
    }
    clearInterval(flushTimer);
    if (!buf.trim()) throw new Error('رد فارغ من الخدمة');
    bub.innerHTML = md(buf);
    chat.msgs.push({ role: 'model', text: buf });
    chat.updated = Date.now();
    saveChats();
    setConn('ok', 'متصل');
    setSendMode(false);
  } catch (err) {
    clearInterval(flushTimer);
    const aborted = err && err.name === 'AbortError';
    if (aborted) {
      if (buf.trim()) { chat.msgs.push({ role: 'model', text: buf + '\n\n*(أُوقفت)*' }); chat.updated = Date.now(); saveChats(); }
      bub.innerHTML = md(buf || '*(أُوقفت الإجابة)*');
      toast('أُوقفت الإجابة', '');
      setConn('ok', 'متصل');
    } else {
      bub.remove();
      wrap.remove();
      chat.msgs.push({ role: 'model', text: (err && err.message) || 'خطأ غير معروف', fail: true });
      saveChats();
      renderChat();
      toast('فشل الاتصال: ' + ((err && err.message) || 'خطأ شبكة'), 'err');
      setConn('err', 'خطأ — إعادة المحاولة لاحقًا');
      scheduleConnRetry();
    }
    setSendMode(false);
  } finally {
    clearInterval(flushTimer);
    state.abort = null;
    state.streaming = false;
    if (usageTokens) bumpUsage(usageTokens); else bumpUsage(Math.ceil((buf.length || 0) / 4) + 10);
  }
}

function setSendMode(streaming) {
  if (streaming) {
    el.btnSend.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="6" y="6" width="12" height="12" rx="3" fill="currentColor"/></svg>';
    el.btnSend.title = 'إيقاف';
    el.btnSend.setAttribute('aria-label', 'إيقاف');
  } else {
    el.btnSend.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 11.5 21 3l-6.5 18-3.2-7.3L3 11.5z" fill="currentColor"/></svg>';
    el.btnSend.title = 'إرسال';
    el.btnSend.setAttribute('aria-label', 'إرسال');
  }
}

function retryLast() {
  const chat = getChat(state.cur);
  if (!chat || state.streaming) return;
  // آخر رسالة model فاشلة → حذفها وإعادة الإرسال
  if (chat.msgs.length && chat.msgs[chat.msgs.length - 1].fail) chat.msgs.pop();
  sendToAI(null);
}

/* فحص الاتصال تلقائيًا بتزايد زمني — أخطاء المفتاح 4xx لا تُعاد */
function scheduleConnRetry() {
  setTimeout(async () => {
    if (state.conn !== 'err' || !prefs.key) return;
    setConn('busy', 'جارٍ إعادة الاتصال…');
    try {
      const r = await fetch(API_BASE + '/models?key=' + encodeURIComponent(prefs.key), { method: 'GET' });
      if (r.ok) { setConn('ok', 'متصل'); state.retryDelay = 2000; }
      else if (r.status >= 400 && r.status < 500) setConn('err', 'المفتاح غير صالح');
      else throw new Error('bad');
    } catch (e) {
      setConn('err', 'خطأ — إعادة المحاولة…');
      state.retryDelay = clamp(state.retryDelay * 2, 2000, 60000);
      scheduleConnRetry();
    }
  }, state.retryDelay);
}
async function initialConnCheck() {
  if (!prefs.key) { setConn('idle', 'أدخل مفتاح API من الإعدادات'); return; }
  setConn('busy', 'جارٍ الاتصال…');
  try {
    const r = await fetch(API_BASE + '/models?key=' + encodeURIComponent(prefs.key), { method: 'GET' });
    if (r.ok) setConn('ok', 'متصل');
    else if (r.status >= 400 && r.status < 500) setConn('err', 'المفتاح غير صالح');
    else { setConn('err', 'خطأ في الخدمة'); state.retryDelay = 2000; scheduleConnRetry(); }
  } catch (e) { setConn('err', 'لا يوجد اتصال'); state.retryDelay = 2000; scheduleConnRetry(); }
}
/* ===== ربط الأحداث ===== */
function bindEvents() {
  // التبويبات
  $$('.tab', el.tabs).forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // الهيدر
  $('#btnNew').addEventListener('click', () => { if (!state.streaming) newChat(); else toast('انتظر انتهاء الرد الحالي', ''); });
  $('#btnSettings').addEventListener('click', openSheet);
  el.sheetBackdrop.addEventListener('click', closeSheet);
  el.usagePill.addEventListener('click', () => {
    toast('اليوم: ' + fmtNum(prefs.usage.req) + ' طلب · ~' + fmtNum(prefs.usage.tok) + ' توكن', '');
  });

  // صفوف الإعدادات
  $('#rowTheme').onclick = () => openOptList('المظهر', [{ v:'dark', n:'داكن' }, { v:'light', n:'فاتح' }], prefs.theme, v => { prefs.theme = v; savePrefs(); applyPrefs(); });
  $('#rowGlass').onclick = () => openOptList('الزجاج', [
    { v:'clear', n:'شفاف' }, { v:'soft', n:'ناعم' }, { v:'solid', n:'مصنّر' }, { v:'off', n:'بلا (كلاسيكي)' }
  ], prefs.glass, v => { prefs.glass = v; savePrefs(); applyPrefs(); toast('تم تغيير درجة الزجاج', 'ok'); });
  $('#rowBg').onclick = () => openOptList('الخلفية', [{ v:'on', n:'متحركة' }, { v:'off', n:'بلا' }], prefs.bg, v => { prefs.bg = v; savePrefs(); applyPrefs(); });
  $('#rowModel').onclick = () => openOptList('النموذج', MODELS.map(m => ({ v:m.id, n:m.name })), prefs.model, v => { prefs.model = v; savePrefs(); applyPrefs(); toast('النموذج: ' + v, 'ok'); });
  $('#rowKey').onclick = () => { el.inputKey.value = prefs.key; openModal(el.modalKey); setTimeout(() => el.inputKey.focus(), 250); };
  $('#rowUsage').onclick = async () => {
    const ok = await confirmBox('تصفير الاستخدام', 'سيتم تصفير عدّاد اليوم. هل تريد المتابعة؟');
    if (ok) { prefs.usage = { d: today(), req: 0, tok: 0 }; savePrefs(); renderUsage(); toast('صُفّر العدّاد', 'ok'); }
  };

  // مفتاح API
  el.btnSaveKey.onclick = () => {
    const v = el.inputKey.value.trim();
    if (!v) { toast('أدخل المفتاح أولًا', 'err'); return; }
    prefs.key = v;
    savePrefs(); applyPrefs(); closeModal(el.modalKey);
    toast('حُفظ المفتاح على جهازك', 'ok');
    initialConnCheck();
  };
  $$('#modalKey [data-close]').forEach(b => b.addEventListener('click', () => closeModal(el.modalKey)));
  $$('#modalConfirm [data-close]').forEach(b => b.addEventListener('click', () => closeModal(el.modalConfirm)));
  el.modalKey.addEventListener('click', ev => { if (ev.target === el.modalKey) closeModal(el.modalKey); });
  el.modalConfirm.addEventListener('click', ev => { if (ev.target === el.modalConfirm) el.btnConfirmNo.click(); });

  // قائمة الخيارات
  el.optList.addEventListener('click', ev => { if (ev.target === el.optList) closeOptList(); });

  // الإرسال + إيقاف البث
  el.composer.addEventListener('submit', ev => {
    ev.preventDefault();
    if (state.streaming) { el.input.blur(); state.abort && state.abort.abort(); return; }
    // بلا مفتاح: نُبقي النص في الحقل ونفتح المودال (لا نضيع رسالة المستخدم)
    if (!prefs.key) {
      el.input.blur();
      toast('أدخل مفتاح API من الإعدادات أولًا', 'err');
      openModal(el.modalKey);
      return;
    }
    const txt = el.input.value.trim();
    if (!txt) return;
    el.input.blur(); // سحب لوحة المفاتيح فور الإرسال
    el.input.value = '';
    el.input.style.height = 'auto';
    sendToAI(txt);
  });
  el.input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      el.composer.requestSubmit ? el.composer.requestSubmit() : el.composer.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
  el.input.addEventListener('input', () => {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 170) + 'px';
  });

  // حالات الشبكة العامة
  window.addEventListener('online', () => { if (prefs.key && state.conn !== 'busy') setConn('ok', 'متصل'); });
  window.addEventListener('offline', () => setConn('err', 'لا يوجد اتصال بالإنترنت'));
}

/* ===== دورة تحديث Service Worker (إلزامية) ===== */
let swReg = null;
let wantReload = false; // إعادة التحميل فقط بعد قبول التحديث عمدًا
let reloaded = false;   // علم منع حلقة إعادة التحميل
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    swReg = reg;
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar();
      });
    });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wantReload || reloaded) return;
    reloaded = true;
    location.reload();
  });
}
function showUpdateBar() {
  el.updateBar.hidden = false;
  document.body.classList.add('has-update');
}
function bindUpdateBar() {
  el.btnUpdate.addEventListener('click', () => {
    wantReload = true;
    if (swReg && swReg.waiting) swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
    else if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
    toast('جارٍ التحديث…', '');
  });
}

/* ===== التنظيف الدوري + beforeunload ===== */
let cleanupTimer = 0;
function startCleanupTimer() {
  cleanupTimer = setInterval(() => {
    // تصفير الاستخدام عند تغيّر اليوم
    if (prefs.usage.d && prefs.usage.d !== today()) {
      prefs.usage = { d: today(), req: 0, tok: 0 };
      savePrefs(); renderUsage();
    }
    // حصر المحادثات بالحد الأقصى (الأحدث تبقى)
    if (state.chats.length > CHATS_CAP) {
      state.chats.sort((a, b) => (b.updated || b.ts) - (a.updated || a.ts));
      state.chats = state.chats.slice(0, CHATS_CAP);
      saveChats();
    }
  }, 60000);
}
function cleanupAll() {
  try {
    if (cleanupTimer) clearInterval(cleanupTimer);
    state.abort && state.abort.abort();
    revokeAllBlobs();
    savePrefs(); saveChats(); saveUI();
  } catch (e) {}
}

/* ===== init ===== */
function init() {
  cacheDOM();
  loadPrefs();
  loadChats();
  applyPrefs();
  bindEvents();
  bindUpdateBar();
  bindScrollPinning();
  bindCopy();
  // استعادة آخر حالة استخدام
  const ui = loadUI();
  const restore = ui.chat && getChat(ui.chat) ? ui.chat : null;
  if (restore) state.cur = restore;
  else if (state.chats.length) state.cur = [...state.chats].sort((a, b) => (b.updated || b.ts) - (a.updated || a.ts))[0].id;
  switchTab(ui.tab === 'chats' ? 'chats' : 'chat');
  renderChat();
  bgfx.start();
  registerSW();
  initialConnCheck();
  startCleanupTimer();
  window.addEventListener('beforeunload', cleanupAll);
}

document.addEventListener('DOMContentLoaded', init);




