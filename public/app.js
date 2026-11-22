'use strict';
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let me = null;
let msgs = [];
let hasMore = false;
let events = null;
let lastDay = '';

// ---------- api ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- login ----------
// Present when the page runs inside the Flowchat Android app.
const androidApp = window.FlowchatAndroid || null;
// Android app 1.3 and newer has its own QR codes screen, which the page's QR tab opens.
const nativeCodes = !!(androidApp && androidApp.openCodes && androidApp.pageHasCodes);
function tellApp() { try { if (androidApp) androidApp.sessionChanged(); } catch {} }

function guessDevice() {
  try { if (androidApp) return androidApp.deviceName(); } catch {}
  const ua = navigator.userAgent;
  const browser = /OPR\/|Opera/.test(ua) ? 'Opera' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
function stored(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {}
  return null;
}
function showLogin() {
  tellApp();
  if (events) { events.close(); events = null; }
  me = null;
  msgs = []; $('list').textContent = '';
  notes = []; openId = null; dirty = false; clearTimeout(saveTimer);
  $('noteList').textContent = ''; $('noteTitle').value = ''; $('noteBody').value = '';
  codes = []; $('codeGrid').textContent = ''; hideCode(); forgetCodeCache();
  $('app').hidden = true;
  $('login').hidden = false;
  $('device').value = stored('flow_device') || guessDevice();
  $('password').focus();
  fetch('/api/config').then((r) => r.json()).then((c) => {
    $('code').hidden = $('codeLabel').hidden = !c.totp;
    $('code').required = !!c.totp;
  }).catch(() => {});
}
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('loginError');
  err.hidden = true;
  const device = $('device').value.trim();
  try {
    await api('POST', '/api/login', { password: $('password').value, device, code: $('code').value });
    stored('flow_device', device);
    $('password').value = ''; $('code').value = '';
    await start();
    tellApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});
$('logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/logout'); } catch {}
  try { localStorage.removeItem('flow_draft'); } catch {}
  msgs = []; $('list').textContent = ''; text.value = '';
  showLogin();
});

// ---------- formatting ----------
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function fmtDay(ts) {
  const d = new Date(ts), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400e3);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
function fmtSize(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i && n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
function fmtAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}
function linkify(parent, text) {
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    let url = m[0].replace(/[.,;:!?)\]]+$/, '');
    parent.append(text.slice(last, m.index));
    const a = el('a', null, url);
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    parent.append(a);
    last = m.index + url.length;
    re.lastIndex = last;
  }
  parent.append(text.slice(last));
}

// ---------- rendering ----------
const scroller = $('scroll');
const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };

function messageNode(m) {
  const mine = m.device === me.device && !m.hook;
  const node = el('div', 'msg' + (mine ? ' mine' : '') + (m.hook ? ' hook' : ''));
  node.dataset.id = m.id;
  const meta = el('div', 'meta');
  meta.append(el('span', null, `${mine ? '' : m.device + (m.hook ? ' (webhook)' : '') + ' · '}${fmtTime(m.ts)}`));

  if (m.file) {
    const f = m.file;
    const src = `/api/files/${f.id}`;
    const stick = () => { if (node.dataset.stick) toBottom(); };
    let bubble;
    if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(f.type)) {
      bubble = el('div', 'bubble media');
      const a = el('a'); a.href = src; a.target = '_blank'; a.rel = 'noopener';
      const img = el('img'); img.src = src; img.alt = f.name; img.loading = 'lazy';
      img.addEventListener('load', stick);
      a.append(img); bubble.append(a);
    } else if (/^video\/(mp4|webm|ogg|quicktime)$/.test(f.type)) {
      bubble = el('div', 'bubble media');
      const v = el('video'); v.src = src; v.controls = true; v.preload = 'metadata';
      v.addEventListener('loadedmetadata', stick);
      bubble.append(v, el('div', 'cap', f.name));
    } else if (/^audio\//.test(f.type)) {
      bubble = el('div', 'bubble media');
      const a = el('audio'); a.src = src; a.controls = true; a.preload = 'none';
      bubble.append(a, el('div', 'cap', f.name));
    } else {
      bubble = el('a', 'bubble file');
      bubble.href = src + '?dl=1';
      const ext = (/\.([a-z0-9]{1,5})$/i.exec(f.name) || [, 'file'])[1];
      const info = el('span', 'file-info');
      info.append(el('span', 'file-name', f.name), el('span', 'file-size', fmtSize(f.size)));
      bubble.append(el('span', 'file-ext', ext), info);
    }
    node.append(bubble);
    const dl = el('a', null, `Download · ${fmtSize(f.size)}`);
    dl.href = src + '?dl=1';
    meta.append(dl);
  } else {
    const bubble = el('div', 'bubble');
    linkify(bubble, m.text);
    node.append(bubble);
    const copy = el('button', null, 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(m.text); }
      catch {
        const t = el('textarea'); t.value = m.text; document.body.append(t); t.select();
        document.execCommand('copy'); t.remove();
      }
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    });
    meta.append(copy);
  }
  const del = el('button', null, 'Delete');
  del.type = 'button';
  del.addEventListener('click', () => confirmDelete(m));
  meta.append(del);
  node.append(meta);
  return node;
}

function appendNode(m, isNew) {
  const day = new Date(m.ts).toDateString();
  if (day !== lastDay) { $('list').append(el('div', 'day', fmtDay(m.ts))); lastDay = day; }
  const node = messageNode(m);
  if (isNew) node.classList.add('new');
  $('list').append(node);
  return node;
}
function renderAll() {
  $('list').textContent = '';
  lastDay = '';
  for (const m of msgs) appendNode(m, false);
  $('empty').hidden = msgs.length > 0;
  $('earlier').hidden = !hasMore;
}

function confirmAction(textContent, onYes) {
  const dlg = $('confirmDlg');
  $('confirmText').textContent = textContent;
  dlg.onclose = () => { if (dlg.returnValue === 'yes') onYes(); };
  dlg.returnValue = 'no';
  dlg.showModal();
}
function confirmDelete(m) {
  confirmAction(m.file
    ? `Delete "${m.file.name}" from every device? The file is removed from the server.`
    : 'Delete this message from every device?', async () => {
    try { await api('DELETE', `/api/messages/${m.id}`); } catch (e) { if (e.message !== 'Already deleted') setStatus(e.message, 'down'); }
  });
}

// ---------- loading and live updates ----------
async function loadLatest() {
  const data = await api('GET', '/api/messages?limit=100');
  if (msgs.length && data.messages.length) {
    // Reconnect: keep earlier pages already loaded, replace the newest window.
    const oldest = data.messages[0].ts;
    msgs = msgs.filter((m) => m.ts < oldest).concat(data.messages);
  } else {
    msgs = data.messages;
    hasMore = data.more;
  }
  renderAll();
  toBottom();
}
$('earlier').addEventListener('click', async () => {
  if (!msgs.length) return;
  const before = scroller.scrollHeight;
  const data = await api('GET', `/api/messages?limit=100&before=${msgs[0].id}`);
  msgs = data.messages.concat(msgs);
  hasMore = data.more;
  renderAll();
  scroller.scrollTop = scroller.scrollHeight - before;
});

function setStatus(text, cls) {
  const s = $('status');
  s.textContent = text;
  s.className = 'status' + (cls ? ' ' + cls : '');
}
function connect() {
  if (events) events.close();
  let first = true;
  events = new EventSource('/api/events');
  events.onopen = () => {
    setStatus(`Synced · ${me.device}`, 'live');
    if (!first) { loadLatest().catch(() => {}); loadNotes().catch(() => {}); loadCodes().catch(() => {}); }
    first = false;
  };
  events.onerror = async () => {
    setStatus('Reconnecting…', 'down');
    first = false;
    try { await api('GET', '/api/me'); } catch {} // a 401 here shows the sign-in screen
  };
  events.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (msgs.some((x) => x.id === m.id)) return;
    const stick = nearBottom() || (m.device === me.device && !m.hook);
    msgs.push(m);
    if (tab !== 'chat') $('chatDot').hidden = false;
    $('empty').hidden = true;
    const node = appendNode(m, true);
    if (stick) { node.dataset.stick = '1'; toBottom(); }
  });
  events.addEventListener('delete', (e) => {
    const { id } = JSON.parse(e.data);
    const before = msgs.length;
    msgs = msgs.filter((m) => m.id !== id);
    if (msgs.length !== before) { const top = scroller.scrollTop; renderAll(); scroller.scrollTop = top; }
  });
  events.addEventListener('note', (e) => noteChanged(JSON.parse(e.data)));
  events.addEventListener('noteDelete', (e) => noteRemoved(JSON.parse(e.data).id));
  events.addEventListener('code', (e) => codeChanged(JSON.parse(e.data)));
  events.addEventListener('codeDelete', (e) => codeRemoved(JSON.parse(e.data).id));
}

// ---------- sending ----------
const text = $('text');
function autosize() { text.style.height = 'auto'; text.style.height = Math.min(text.scrollHeight + 2, 180) + 'px'; }
text.addEventListener('input', () => { autosize(); stored('flow_draft', text.value); });
text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    $('sendForm').requestSubmit();
  }
});
$('sendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = text.value.trim();
  if (!value) return;
  text.value = ''; autosize(); stored('flow_draft', '');
  try { await api('POST', '/api/messages', { text: value }); }
  catch (ex) {
    if (!text.value) { text.value = value; autosize(); }
    setStatus(`Not sent: ${ex.message}`, 'down');
  }
  text.focus();
});

// ---------- uploads ----------
const queue = [];
let uploading = false;
function addFiles(files) {
  for (const file of files) {
    const row = el('div', 'up');
    const pct = el('span', 'up-pct', 'Waiting');
    const cancel = el('button', null, 'Cancel'); cancel.type = 'button';
    const bar = el('progress'); bar.max = 1; bar.value = 0;
    row.append(el('span', 'up-name', file.name), pct, cancel, bar);
    $('uploads').append(row);
    const job = { file, row, pct, bar, xhr: null, cancelled: false };
    cancel.addEventListener('click', () => {
      job.cancelled = true;
      if (job.xhr) job.xhr.abort();
      row.remove();
    });
    if (me && file.size > me.maxUploadMb * 1024 * 1024) {
      row.classList.add('failed'); pct.textContent = `Larger than the ${me.maxUploadMb} MB limit`;
      bar.remove(); cancel.textContent = 'Dismiss';
      continue;
    }
    queue.push(job);
  }
  pump();
}
function pump() {
  if (uploading) return;
  const job = queue.shift();
  if (!job) return;
  if (job.cancelled) return pump();
  uploading = true;
  const xhr = job.xhr = new XMLHttpRequest();
  const done = (error) => {
    uploading = false;
    if (error && !job.cancelled) {
      job.row.classList.add('failed'); job.pct.textContent = error; job.bar.remove();
      job.row.querySelector('button').textContent = 'Dismiss';
    } else job.row.remove();
    pump();
  };
  xhr.open('POST', `/api/upload?name=${encodeURIComponent(job.file.name)}`);
  xhr.setRequestHeader('Content-Type', job.file.type || 'application/octet-stream');
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    job.bar.value = e.loaded / e.total;
    job.pct.textContent = `${Math.floor((e.loaded / e.total) * 100)}%`;
  };
  xhr.onload = () => {
    if (xhr.status === 201) return done();
    if (xhr.status === 401) { showLogin(); return done('Signed out'); }
    let msg = `Upload failed (${xhr.status})`;
    try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
    done(msg);
  };
  xhr.onerror = () => done('Upload failed. Check the connection and try again.');
  xhr.onabort = () => done();
  xhr.send(job.file);
}
$('attachBtn').addEventListener('click', () => $('filePick').click());
$('filePick').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
text.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (me && tab === 'chat' && hasFiles(e)) { dragDepth++; $('drop').hidden = false; } });
addEventListener('dragleave', () => { if (dragDepth && --dragDepth === 0) $('drop').hidden = true; });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; $('drop').hidden = true;
  if (me && tab === 'chat') addFiles(e.dataTransfer.files);
});

// ---------- devices ----------
if (nativeCodes) {
  $('codesOffline').closest('label').hidden = true;
  // Open the app's QR codes screen straight from the tap, without going through the page's routing.
  $('tabCodes').addEventListener('click', (e) => {
    e.preventDefault();
    try { androidApp.openCodes(); } catch (err) { setStatus('Could not open QR codes: ' + err.message, 'down'); }
  });
}
if (androidApp) {
  $('appSettingsBtn').hidden = false;
  $('appSettingsBtn').addEventListener('click', () => { try { androidApp.openAppSettings(); } catch {} });
}
$('devicesBtn').addEventListener('click', async () => {
  $('hookResult').hidden = true; $('hookError').hidden = true;
  await Promise.all([renderDevices(), renderHooks(), renderTrash()]);
  $('devicesDlg').showModal();
});
async function renderDevices() {
  const { sessions } = await api('GET', '/api/sessions');
  const list = $('deviceList');
  list.textContent = '';
  for (const s of sessions) {
    const li = el('li');
    const info = el('div', 'd-info');
    info.append(el('span', 'd-name', s.device), el('span', 'd-seen', `Active ${fmtAgo(s.seen)}`));
    li.append(info);
    if (s.current) li.append(el('span', 'tag', 'This device'));
    else {
      const b = el('button', 'ghost', 'Sign out'); b.type = 'button';
      b.addEventListener('click', async () => { await api('DELETE', `/api/sessions/${s.id}`); renderDevices(); });
      li.append(b);
    }
    list.append(li);
  }
}

// ---------- recently removed QR codes ----------
async function renderTrash() {
  const list = $('trashList');
  let removed = [];
  try { removed = (await api('GET', '/api/codes/removed')).codes; } catch { /* older server: section stays empty */ }
  list.textContent = '';
  for (const c of removed) {
    const li = el('li');
    const info = el('div', 'd-info');
    const left = Math.max(1, Math.ceil((c.purge - Date.now()) / 86400e3));
    info.append(el('span', 'd-name', c.title),
      el('span', 'd-seen', `Removed ${fmtAgo(c.removed)}${c.removedBy ? ' on ' + c.removedBy : ''} · deleted for good in ${left} day${left === 1 ? '' : 's'}`));
    const restore = el('button', 'ghost', 'Restore'); restore.type = 'button';
    restore.addEventListener('click', async () => {
      try { await api('POST', `/api/codes/${c.id}/restore`); } catch (e) { setStatus(e.message, 'down'); }
      renderTrash();
    });
    const forget = el('button', 'ghost', 'Delete now'); forget.type = 'button';
    forget.addEventListener('click', () => {
      confirmAction(`Delete "${c.title}" for good? It can't be restored afterwards.`, async () => {
        try { await api('DELETE', `/api/codes/${c.id}?forever=1`); } catch (e) { setStatus(e.message, 'down'); }
        renderTrash();
      });
    });
    li.append(info, restore, forget);
    list.append(li);
  }
  $('trashEmpty').hidden = removed.length > 0;
}

// ---------- webhooks ----------
async function renderHooks() {
  const { hooks, outgoing } = await api('GET', '/api/hooks');
  const list = $('hookList');
  list.textContent = '';
  for (const h of hooks) {
    const li = el('li');
    const info = el('div', 'd-info');
    info.append(el('span', 'd-name', h.name),
      el('span', 'd-seen', h.count ? `${h.count} message${h.count === 1 ? '' : 's'} · last ${fmtAgo(h.lastUsed)}` : 'Not used yet'));
    const b = el('button', 'ghost', 'Remove'); b.type = 'button';
    b.addEventListener('click', async () => { await api('DELETE', `/api/hooks/${h.id}`); $('hookResult').hidden = true; renderHooks(); });
    li.append(info, b);
    list.append(li);
  }
  const out = $('hookOut');
  out.hidden = !outgoing.length;
  out.textContent = outgoing.length ? `New messages are also announced to: ${outgoing.join(', ')}` : '';
}
$('hookAdd').addEventListener('click', async () => {
  const err = $('hookError');
  err.hidden = true;
  const name = $('hookName').value.trim();
  if (!name) { $('hookName').focus(); return; }
  try {
    const h = await api('POST', '/api/hooks', { name });
    const url = location.origin + h.path;
    $('hookUrl').value = url;
    $('hookExample').textContent = `curl -d "Backup finished" ${url}`;
    $('hookResult').hidden = false;
    $('hookName').value = '';
    renderHooks();
  } catch (e) { err.textContent = e.message; err.hidden = false; }
});
$('hookCopy').addEventListener('click', async () => {
  const b = $('hookCopy');
  try { await navigator.clipboard.writeText($('hookUrl').value); b.textContent = 'Copied'; }
  catch { $('hookUrl').select(); b.textContent = 'Select and copy'; }
  setTimeout(() => { b.textContent = 'Copy address'; }, 1500);
});

// ---------- tabs ----------
let tab = 'chat';
function route() {
  const h = location.hash.slice(1);
  const noteMatch = /^note-([a-f0-9]{32})$/.exec(h);
  const codeMatch = /^code-([a-f0-9]{32})$/.exec(h);
  let next = h === 'notes' || noteMatch ? 'notes' : h === 'codes' || codeMatch ? 'codes' : 'chat';
  if (offline) next = 'codes';
  if (nativeCodes && next === 'codes' && !offline) {
    // Inside the Android app, QR codes have their own screen, stored encrypted on the phone.
    try { androidApp.openCodes(); } catch {}
    location.replace(tab === 'notes' ? '#notes' : '#chat');
    return;
  }
  if (tab === 'notes' && next !== 'notes') flushNote();
  tab = next;
  $('chatView').hidden = tab !== 'chat';
  $('notesView').hidden = tab !== 'notes';
  $('codesView').hidden = tab !== 'codes';
  $('tabChat').setAttribute('aria-selected', tab === 'chat');
  $('tabNotes').setAttribute('aria-selected', tab === 'notes');
  $('tabCodes').setAttribute('aria-selected', tab === 'codes');
  if (codeMatch) showCode(codeMatch[1]); else hideCode();
  if (tab === 'codes') {
    renderCodes();
  } else if (tab === 'chat') {
    $('chatDot').hidden = true;
    if (nearBottom()) toBottom();
  } else if (noteMatch) {
    openNote(noteMatch[1]);
  } else {
    closeNote();
  }
}
addEventListener('hashchange', route);

// ---------- notes ----------
let notes = [];       // newest first
let openId = null;    // note in the editor
let base = 0;         // server version the editor started from
let dirty = false;    // editor has changes not yet saved
let saving = false;
let saveTimer = null;
const noteTitle = $('noteTitle'), noteBody = $('noteBody');

function noteLabel(n) {
  const firstLine = (n.body || '').split('\n').find((l) => l.trim()) || '';
  return { title: n.title || firstLine.trim().slice(0, 80) || 'Untitled', snip: n.title ? firstLine.trim().slice(0, 120) : '' };
}
function fmtWhen(ts) {
  const d = new Date(ts);
  return new Date().toDateString() === d.toDateString() ? fmtTime(ts)
    : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
function renderNoteList() {
  const q = $('noteSearch').value.trim().toLowerCase();
  const list = $('noteList');
  list.textContent = '';
  const shown = q ? notes.filter((n) => (n.title + '\n' + n.body).toLowerCase().includes(q)) : notes;
  for (const n of shown) {
    const { title, snip } = noteLabel(n);
    const li = el('li');
    const a = el('a', 'note-item');
    a.href = `#note-${n.id}`;
    if (n.id === openId) a.setAttribute('aria-current', 'true');
    a.append(el('strong', null, title));
    if (snip) a.append(el('span', 'snip', snip));
    a.append(el('span', 'when', `${fmtWhen(n.updated)} · ${n.by}`));
    li.append(a);
    list.append(li);
  }
  $('notesEmpty').hidden = notes.length > 0;
  $('notesNoMatch').hidden = !(notes.length && !shown.length);
}
$('noteSearch').addEventListener('input', renderNoteList);

async function loadNotes() {
  const data = await api('GET', '/api/notes');
  notes = data.notes;
  renderNoteList();
  const n = openId && notes.find((x) => x.id === openId);
  if (openId && !n) noteRemoved(openId);
  else if (n && !dirty && !saving && n.updated !== base) fillEditor(n);
}
function noteState(text, bad) {
  const s = $('noteState');
  s.textContent = text;
  s.classList.toggle('bad', !!bad);
}
function fillEditor(n) {
  noteTitle.value = n.title;
  noteBody.value = n.body;
  base = n.updated;
  dirty = false;
  $('noteConflict').hidden = true;
  noteState(`Saved ${fmtWhen(n.updated)} · ${n.by}`);
}
function openNote(id) {
  if (id !== openId) flushNote();
  const n = notes.find((x) => x.id === id);
  if (!n) { if (notes.length || !me) location.replace('#notes'); return; }
  if (id !== openId) { openId = id; fillEditor(n); }
  $('noteEditor').hidden = false;
  $('notePlaceholder').hidden = true;
  $('notesView').classList.add('editing');
  renderNoteList();
}
function closeNote() {
  flushNote();
  openId = null;
  $('noteEditor').hidden = true;
  $('notePlaceholder').hidden = false;
  $('notesView').classList.remove('editing');
  renderNoteList();
}
function scheduleSave() {
  dirty = true;
  noteState('Editing…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNote, 700);
}
noteTitle.addEventListener('input', scheduleSave);
noteBody.addEventListener('input', scheduleSave);
noteTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); noteBody.focus(); } });

async function saveNote(force) {
  clearTimeout(saveTimer);
  if (!openId || !dirty) return;
  if (saving) { saveTimer = setTimeout(saveNote, 300); return; }
  const id = openId;
  const body = { title: noteTitle.value, body: noteBody.value };
  if (!force) body.base = base;
  saving = true;
  dirty = false;
  noteState('Saving…');
  try {
    const n = await api('PUT', `/api/notes/${id}`, body);
    upsertNote(n);
    if (id === openId) {
      base = n.updated;
      $('noteConflict').hidden = true;
      if (!dirty) noteState(`Saved ${fmtWhen(n.updated)}`);
    }
  } catch (e) {
    if (id === openId) dirty = true;
    if (e.message === 'Changed on another device') {
      if (id === openId) { $('noteConflict').hidden = false; noteState('Not saved: changed on another device', true); }
    } else if (e.message === 'This note was deleted on another device') {
      noteRemoved(id);
    } else if (id === openId) {
      noteState(`Not saved: ${e.message}. Retrying…`, true);
      saveTimer = setTimeout(saveNote, 5000);
    }
  } finally {
    saving = false;
  }
}
// Save straight away when leaving a note, switching tabs or hiding the page.
function flushNote() { if (dirty && $('noteConflict').hidden) saveNote(); }
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNote(); });
addEventListener('beforeunload', (e) => { if (dirty) { flushNote(); e.preventDefault(); } });

$('conflictMine').addEventListener('click', () => { dirty = true; saveNote(true); });
$('conflictTheirs').addEventListener('click', () => {
  const n = notes.find((x) => x.id === openId);
  if (n) fillEditor(n);
});

function upsertNote(n) {
  notes = notes.filter((x) => x.id !== n.id);
  notes.unshift(n);
  notes.sort((a, b) => b.updated - a.updated);
  renderNoteList();
}
function noteChanged(n) {
  const old = notes.find((x) => x.id === n.id);
  if (old && old.updated >= n.updated) return;
  upsertNote(n);
  if (n.id !== openId || saving || n.updated === base) return;
  if (dirty) { $('noteConflict').hidden = false; noteState('Changed on another device', true); }
  else fillEditor(n);
}
function noteRemoved(id) {
  notes = notes.filter((x) => x.id !== id);
  if (id === openId) {
    dirty = false;
    clearTimeout(saveTimer);
    openId = null;
    if (tab === 'notes') location.replace('#notes');
    setStatus('A note you had open was deleted on another device', 'down');
    setTimeout(() => setStatus(`Synced · ${me ? me.device : ''}`, 'live'), 4000);
  }
  renderNoteList();
}

$('noteNew').addEventListener('click', async () => {
  flushNote();
  try {
    const n = await api('POST', '/api/notes', { title: '', body: '' });
    upsertNote(n);
    location.hash = `#note-${n.id}`;
    setTimeout(() => noteTitle.focus(), 0);
  } catch (e) { noteState(e.message, true); }
});
$('noteDelete').addEventListener('click', () => {
  const n = notes.find((x) => x.id === openId);
  if (!n) return;
  const label = noteLabel({ ...n, title: noteTitle.value, body: noteBody.value }).title;
  confirmAction(`Delete the note "${label}" from every device?`, async () => {
    const id = openId;
    dirty = false;
    clearTimeout(saveTimer);
    try { await api('DELETE', `/api/notes/${id}`); noteRemoved(id); }
    catch (e) { noteState(e.message, true); }
  });
});

// ---------- QR codes ----------
let codes = [];        // sorted by title
let offline = false;   // started without a connection: showing the copy saved on this device
const qrCache = new Map();
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
const QR_MAX_BYTES = 2331;
const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });

// Builds an SVG QR code (error correction M, 4-module quiet zone) as a string of numbers only.
function qrSvg(textContent) {
  if (qrCache.has(textContent)) return qrCache.get(textContent);
  const qr = qrcode(0, 'M');
  qr.addData(textContent, 'Byte');
  qr.make();
  const n = qr.getModuleCount(), q = 4, size = n + 2 * q;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  if (qrCache.size > 400) qrCache.clear();
  qrCache.set(textContent, svg);
  return svg;
}
function codeVisual(c) {
  if (c.kind === 'image') {
    const img = el('img');
    img.src = c.image;
    img.alt = c.title;
    return img;
  }
  const box = el('div');
  box.innerHTML = qrSvg(c.content); // generated above from numbers only, never from the content's text
  return box.firstChild;
}
const codeSummary = (c) => (c.kind === 'image' ? 'Picture' : c.content.replace(/\s+/g, ' ').slice(0, 60));

function renderCodes() {
  const q = $('codeSearch').value.trim().toLowerCase();
  const shown = q ? codes.filter((c) => (c.title + ' ' + (c.content || '')).toLowerCase().includes(q)) : codes;
  const grid = $('codeGrid');
  grid.textContent = '';
  for (const c of shown) {
    const a = el('a', 'code-card');
    a.href = `#code-${c.id}`;
    const thumb = el('span', 'code-thumb');
    try { thumb.append(codeVisual(c)); } catch { thumb.textContent = '?'; }
    a.append(thumb, el('strong', null, c.title), el('span', 'sub', codeSummary(c)));
    grid.append(a);
  }
  $('codesEmpty').hidden = codes.length > 0;
  $('codesNoMatch').hidden = !(codes.length && !shown.length);
  $('codeAdd').hidden = offline;
}
$('codeSearch').addEventListener('input', renderCodes);

async function loadCodes() {
  const data = await api('GET', '/api/codes');
  codes = data.codes.sort(byTitle);
  saveCodeCache();
  if (tab === 'codes') renderCodes();
  if (showing) {
    if (codes.some((c) => c.id === showing)) showCode(showing, true);
    else location.replace('#codes');
  }
}
function codeChanged(c) {
  codes = codes.filter((x) => x.id !== c.id).concat(c).sort(byTitle);
  saveCodeCache();
  if (tab === 'codes') renderCodes();
  if (showing === c.id) showCode(c.id, true);
}
function codeRemoved(id) {
  codes = codes.filter((x) => x.id !== id);
  saveCodeCache();
  if (tab === 'codes') renderCodes();
  if (showing === id) location.replace('#codes');
}

// ----- the copy kept on this device, for showing codes without a connection -----
// In the Android app the app keeps its own encrypted copy (see nativeCodes), so the page keeps none.
function offlineWanted() { return !nativeCodes && stored('flow_codes_offline') !== '0'; }
function forgetCodeCache() { try { localStorage.removeItem('flow_codes'); } catch {} }
function saveCodeCache() {
  if (!offlineWanted()) return forgetCodeCache();
  try { localStorage.setItem('flow_codes', JSON.stringify(codes)); }
  catch {
    // Too big for the browser's storage: keep the text codes at least.
    try { localStorage.setItem('flow_codes', JSON.stringify(codes.filter((c) => c.kind === 'text'))); } catch {}
  }
}
function cachedCodes() {
  try { return (JSON.parse(localStorage.getItem('flow_codes')) || []).sort(byTitle); } catch { return []; }
}
$('codesOffline').checked = offlineWanted();
$('codesOffline').addEventListener('change', (e) => {
  stored('flow_codes_offline', e.target.checked ? '1' : '0');
  saveCodeCache();
});

// ----- showing a code full screen -----
let showing = null;
let wakeLock = null;
function brighten(on) {
  try { if (androidApp && androidApp.setBright) androidApp.setBright(on); } catch {}
  if (on && !wakeLock && navigator.wakeLock) {
    navigator.wakeLock.request('screen').then((l) => { wakeLock = l; l.addEventListener('release', () => { wakeLock = null; }); }).catch(() => {});
  } else if (!on && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (showing && document.visibilityState === 'visible') brighten(true); });

function showCode(id, refresh) {
  const i = codes.findIndex((c) => c.id === id);
  if (i < 0) { if (me) location.replace('#codes'); return; }
  const c = codes[i];
  if (showing === id && !refresh) return;
  showing = id;
  $('showTitle').textContent = c.title;
  const box = $('showCode');
  box.textContent = '';
  box.classList.toggle('image', c.kind === 'image');
  try { box.append(codeVisual(c)); } catch { box.textContent = 'This code could not be drawn.'; }
  $('showText').textContent = c.kind === 'text' ? c.content : '';
  $('showText').hidden = c.kind !== 'text';
  $('showCount').textContent = codes.length > 1 ? `${i + 1} of ${codes.length}` : '';
  $('showPrev').disabled = i === 0;
  $('showNext').disabled = i === codes.length - 1;
  $('showEdit').hidden = offline;
  if ($('codeShow').hidden) {
    $('codeShow').hidden = false;
    brighten(true);
    $('showClose').focus();
  }
}
function hideCode() {
  if (!showing && $('codeShow').hidden) return;
  showing = null;
  $('codeShow').hidden = true;
  brighten(false);
}
function stepCode(dir) {
  const i = codes.findIndex((c) => c.id === showing);
  const next = codes[i + dir];
  if (next) location.replace(`#code-${next.id}`);
}
$('showPrev').addEventListener('click', () => stepCode(-1));
$('showNext').addEventListener('click', () => stepCode(1));
$('showEdit').addEventListener('click', () => {
  const c = codes.find((x) => x.id === showing);
  if (c) openCodeDialog(c);
});
addEventListener('keydown', (e) => {
  if (!showing || $('codeDlg').open) return;
  if (e.key === 'ArrowLeft') stepCode(-1);
  else if (e.key === 'ArrowRight') stepCode(1);
  else if (e.key === 'Escape') location.hash = '#codes';
});
let swipeX = null;
$('codeShow').addEventListener('pointerdown', (e) => { swipeX = e.clientX; });
$('codeShow').addEventListener('pointerup', (e) => {
  if (swipeX === null) return;
  const dx = e.clientX - swipeX;
  swipeX = null;
  if (Math.abs(dx) > 60) stepCode(dx < 0 ? 1 : -1);
});

// ----- adding and editing -----
let editing = null;     // code being edited, or null for a new one
let codeKind = 'text';
let pendingImage = '';  // data: URL of a picture kept as is
function setKind(kind) {
  codeKind = kind;
  for (const b of $('codeKind').querySelectorAll('.seg-btn')) b.setAttribute('aria-checked', b.dataset.kind === kind);
  $('codeTextPane').hidden = kind !== 'text';
  $('codeImagePane').hidden = kind !== 'image' || !!editing;
  updatePreview();
}
function updatePreview() {
  const box = $('codePreview');
  box.textContent = '';
  const bytes = new TextEncoder().encode($('codeContent').value).length;
  $('codeBytes').textContent = codeKind === 'text' && bytes ? `${bytes} of ${QR_MAX_BYTES} bytes` : '';
  $('codeBytes').classList.toggle('error', bytes > QR_MAX_BYTES);
  try {
    if (codeKind === 'text' && $('codeContent').value.trim() && bytes <= QR_MAX_BYTES) box.innerHTML = qrSvg($('codeContent').value);
    else if (codeKind === 'image' && (pendingImage || (editing && editing.image))) {
      const img = el('img'); img.src = pendingImage || editing.image; img.alt = 'Picture of the code'; box.append(img);
    }
  } catch {}
}
let previewTimer = null;
$('codeContent').addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(updatePreview, 150); });
for (const b of $('codeKind').querySelectorAll('.seg-btn')) {
  b.addEventListener('click', () => { if (!editing) { $('codeNote').hidden = true; setKind(b.dataset.kind); } });
}
function openCodeDialog(c) {
  editing = c || null;
  pendingImage = '';
  $('codeDlgTitle').textContent = c ? 'Edit code' : 'Add a QR code';
  $('codeTitle').value = c ? c.title : '';
  $('codeContent').value = c && c.kind === 'text' ? c.content : '';
  $('codeError').hidden = true;
  $('codeNote').hidden = true;
  $('codeDelete').hidden = !c;
  $('codeKind').hidden = !!c;
  setKind(c ? c.kind : 'text');
  $('codeDlg').showModal();
  if (!c) $('codeTitle').focus();
}
$('codeAdd').addEventListener('click', () => openCodeDialog(null));
$('codeCancel').addEventListener('click', () => $('codeDlg').close());
$('codePick').addEventListener('click', () => $('codeFile').click());
$('codeFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const note = $('codeNote');
  note.hidden = false;
  note.textContent = 'Reading the picture…';
  try {
    const found = await readPicture(file);
    if (found.text) {
      $('codeContent').value = found.text;
      setKind('text');
      note.textContent = 'QR code found in the picture. It will be redrawn sharply; you can check the text below.';
    } else {
      pendingImage = found.image;
      setKind('image');
      note.textContent = 'No QR code found, so the picture itself will be shown. That works for barcodes and tickets too.';
    }
    if (!$('codeTitle').value.trim()) $('codeTitle').value = file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 100);
  } catch (err) {
    note.textContent = err.message;
  }
});

let jsQRLoading = null;
function loadReader() {
  if (window.jsQR) return Promise.resolve();
  if (!jsQRLoading) {
    jsQRLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/jsQR.js';
      s.onload = resolve;
      s.onerror = () => { jsQRLoading = null; reject(new Error('Could not load the QR reader. Check the connection.')); };
      document.head.append(s);
    });
  }
  return jsQRLoading;
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, done: () => URL.revokeObjectURL(url) });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a picture this browser can open.')); };
    img.src = url;
  });
}
function drawScaled(img, longest) {
  const scale = Math.min(1, longest / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}
// Returns {text} when a QR code is found, otherwise {image} (a resized copy to keep as is).
async function readPicture(file) {
  const [{ img, done }] = await Promise.all([loadImage(file), loadReader()]);
  try {
    for (const size of [1600, 800, 2400]) {
      const { canvas, ctx } = drawScaled(img, size);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hit = window.jsQR(px.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
      if (hit && hit.data) return { text: hit.data };
    }
    let { canvas } = drawScaled(img, 1400);
    let image = canvas.toDataURL('image/png');
    if (image.length > 1.5e6) image = canvas.toDataURL('image/jpeg', 0.9);
    if (image.length > 1.9e6) image = drawScaled(img, 1000).canvas.toDataURL('image/jpeg', 0.85);
    return { image };
  } finally { done(); }
}

$('codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('codeError');
  err.hidden = true;
  const body = { title: $('codeTitle').value };
  if (!editing) {
    body.kind = codeKind;
    if (codeKind === 'image') {
      if (!pendingImage) { err.textContent = 'Choose a picture first.'; err.hidden = false; return; }
      body.image = pendingImage;
    }
  }
  if (codeKind === 'text') body.content = $('codeContent').value;
  $('codeSave').disabled = true;
  try {
    const c = editing ? await api('PUT', `/api/codes/${editing.id}`, body) : await api('POST', '/api/codes', body);
    codeChanged(c);
    $('codeDlg').close();
    if (!editing) location.hash = `#code-${c.id}`;
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    $('codeSave').disabled = false;
  }
});
$('codeDelete').addEventListener('click', () => {
  const c = editing;
  if (!c) return;
  $('codeDlg').close();
  confirmAction(`Remove "${c.title}" from every device? You can restore it from Settings for 30 days.`, async () => {
    try { await api('DELETE', `/api/codes/${c.id}`); codeRemoved(c.id); }
    catch (ex) { setStatus(ex.message, 'down'); }
  });
});

// ----- starting without a connection -----
function startOffline() {
  offline = true;
  me = null;
  codes = cachedCodes();
  $('login').hidden = true;
  $('app').hidden = false;
  $('app').classList.add('offline');
  $('offlineBar').hidden = false;
  $('codesOffline').closest('label').hidden = true;
  setStatus('Offline', 'down');
  if (nativeCodes) {
    try { androidApp.pageHasCodes(); androidApp.openCodes(); } catch {}
    $('codesEmpty').querySelector('p:last-child').textContent = 'Your QR codes are in the app: tap the QR codes tab above, or "Try again" once your server is reachable.';
  }
  if (!/^#code-/.test(location.hash)) location.replace('#codes');
  route();
}
$('retryBtn').addEventListener('click', () => {
  try { if (androidApp && androidApp.reconnect) { androidApp.reconnect(); return; } } catch {}
  location.reload();
});
if ('serviceWorker' in navigator) {
  addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

// ---------- boot ----------
async function start() {
  try { me = await api('GET', '/api/me'); }
  catch (e) {
    if (e instanceof TypeError) startOffline(); // the server could not be reached at all
    return;
  }
  $('login').hidden = true;
  $('app').hidden = false;
  if (nativeCodes) { try { androidApp.pageHasCodes(); } catch {} forgetCodeCache(); }
  text.value = stored('flow_draft') || '';
  autosize();
  await Promise.all([loadLatest(), loadNotes(), loadCodes()]);
  connect();
  route();
  if (tab === 'chat' && !matchMedia('(pointer: coarse)').matches) text.focus();
}
start();
