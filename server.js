'use strict';
// Flowchat: a personal cross-device chat and file drop. No dependencies.
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const PORT = Number(process.env.PORT) || 8080;
const DATA = path.resolve(process.env.DATA_DIR || '/data');
const UPLOADS = path.join(DATA, 'uploads');
const MSG_FILE = path.join(DATA, 'messages.jsonl');
const SESS_FILE = path.join(DATA, 'sessions.json');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 2048;
const MAX_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const SESSION_MS = (Number(process.env.SESSION_DAYS) || 90) * 86400e3;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const REQUIRE_HTTPS = process.env.REQUIRE_HTTPS === '1';
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const RETENTION_MS = (Number(process.env.RETENTION_DAYS) || 0) * 86400e3;
const PUBLIC = path.join(__dirname, 'public');

// `node server.js --totp-new` prints a fresh two-step sign-in secret and exits.
if (process.argv.includes('--totp-new')) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const secret = [...crypto.randomBytes(32)].map((b) => A[b & 31]).join('');
  console.log(`TOTP_SECRET=${secret}`);
  console.log(`Authenticator link: otpauth://totp/Flowchat?secret=${secret}&issuer=Flowchat`);
  process.exit(0);
}

// Started as root (the container entrypoint): switch to the unprivileged user before doing anything else.
if (process.getuid && process.getuid() === 0 && process.env.PUID) {
  process.setgroups([]);
  process.setgid(Number(process.env.PGID || process.env.PUID));
  process.setuid(Number(process.env.PUID));
}
process.umask(0o077); // data files are readable by the app's user only
fs.mkdirSync(UPLOADS, { recursive: true });

// ---------- password ----------
let PASSWORD = process.env.APP_PASSWORD || '';
if (!PASSWORD) {
  const pf = path.join(DATA, 'generated-password.txt');
  try { PASSWORD = fs.readFileSync(pf, 'utf8').trim(); } catch {}
  if (!PASSWORD) {
    PASSWORD = crypto.randomBytes(12).toString('base64url');
    fs.writeFileSync(pf, PASSWORD + '\n', { mode: 0o600 });
  }
  console.log(`APP_PASSWORD is not set. A generated password is saved in ${pf}`);
}
if (/^(change-?me|password|admin|flowchat|123456.*)$/i.test(PASSWORD)) {
  console.error('Refusing to start: APP_PASSWORD is a placeholder or a common password. Choose your own.');
  process.exit(1);
}
if (PASSWORD.length < 12) console.warn('Warning: APP_PASSWORD is shorter than 12 characters. Use a longer one if this is reachable from the internet.');
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const PASS_HASH = sha(PASSWORD);
const passwordOk = (p) => typeof p === 'string' && crypto.timingSafeEqual(sha(p), PASS_HASH);
// Sessions are tied to the password: changing it signs every device out.
const PASS_ID = sha('flowchat-session-binding:' + PASSWORD).toString('hex').slice(0, 16);

// ---------- two-step sign-in (TOTP, RFC 6238) ----------
let TOTP_KEY = null;
if (process.env.TOTP_SECRET) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = process.env.TOTP_SECRET.toUpperCase().replace(/[\s=-]/g, '');
  let bits = '';
  for (const ch of clean) {
    const v = A.indexOf(ch);
    if (v < 0) { console.error('Refusing to start: TOTP_SECRET is not valid base32.'); process.exit(1); }
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  if (bytes.length < 10) { console.error('Refusing to start: TOTP_SECRET is too short.'); process.exit(1); }
  TOTP_KEY = Buffer.from(bytes);
}
let totpLastStep = 0; // a code is accepted once
function totpAt(step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', TOTP_KEY).update(msg).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
function totpOk(code) {
  if (!TOTP_KEY) return true;
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return false;
  const now = Math.floor(Date.now() / 30e3);
  let hit = 0;
  for (const step of [now - 1, now, now + 1]) {
    if (step > totpLastStep && crypto.timingSafeEqual(Buffer.from(totpAt(step)), Buffer.from(code.trim()))) hit = step;
  }
  if (hit) totpLastStep = hit;
  return hit > 0;
}

// ---------- encryption at rest (optional) ----------
// With ENCRYPTION_KEY set, message text, file names and file contents are
// stored encrypted, so a copy of the data folder alone reveals nothing.
let MASTER = null;
if (process.env.ENCRYPTION_KEY) {
  if (process.env.ENCRYPTION_KEY.length < 16) { console.error('Refusing to start: ENCRYPTION_KEY must be at least 16 characters.'); process.exit(1); }
  const sf = path.join(DATA, 'encryption-salt');
  let salt;
  try { salt = fs.readFileSync(sf); } catch { salt = crypto.randomBytes(16); fs.writeFileSync(sf, salt); }
  MASTER = crypto.scryptSync(process.env.ENCRYPTION_KEY, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}
const MSG_KEY = MASTER && crypto.createHmac('sha256', MASTER).update('messages').digest();
function sealLine(obj) {
  const plain = JSON.stringify(obj);
  if (!MASTER) return plain + '\n';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', MSG_KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return JSON.stringify({ e: Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') }) + '\n';
}
function openLine(o) {
  if (!o.e) return o;
  if (!MASTER) throw new Error('The stored messages are encrypted but ENCRYPTION_KEY is not set.');
  const buf = Buffer.from(o.e, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', MSG_KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  try { return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')); }
  catch { throw new Error('The stored messages cannot be decrypted. ENCRYPTION_KEY is different from the one they were saved with.'); }
}
// File contents use AES-256-CTR with a per-file key, which allows seeking.
const fileKey = (id) => crypto.createHmac('sha256', MASTER).update('file:' + id).digest();
function fileCipher(id, ivHex, offset = 0) {
  const block = BigInt(Math.floor(offset / 16));
  const ctr = (BigInt('0x' + ivHex) + block) & ((1n << 128n) - 1n);
  const c = crypto.createCipheriv('aes-256-ctr', fileKey(id), Buffer.from(ctr.toString(16).padStart(32, '0'), 'hex'));
  if (offset % 16) c.update(Buffer.alloc(offset % 16));
  return c;
}

// ---------- messages (append-only log, compacted at startup) ----------
let messages = [];
const fileIndex = new Map(); // file id -> message
async function loadMessages() {
  let raw = '';
  try { raw = fs.readFileSync(MSG_FILE, 'utf8'); } catch {}
  const byId = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    o = openLine(o); // throws when the key is missing or wrong: never compact data we cannot read
    if (o.del) byId.delete(o.del); else if (o.id) byId.set(o.id, o);
  }
  messages = [...byId.values()].sort((a, b) => a.ts - b.ts);
  if (RETENTION_MS) messages = messages.filter((m) => Date.now() - m.ts < RETENTION_MS);
  for (const m of messages) if (m.file) fileIndex.set(m.file.id, m);
  // Encrypt files that were stored before ENCRYPTION_KEY was set.
  if (MASTER) for (const m of messages) {
    if (!m.file || m.file.iv) continue;
    const p = path.join(UPLOADS, m.file.id);
    if (!fs.existsSync(p)) continue;
    const iv = crypto.randomBytes(16).toString('hex');
    await pipeline(fs.createReadStream(p), fileCipher(m.file.id, iv), fs.createWriteStream(p + '.enc'));
    fs.renameSync(p + '.enc', p);
    m.file.iv = iv;
  }
  const tmp = MSG_FILE + '.tmp';
  fs.writeFileSync(tmp, messages.map(sealLine).join(''));
  fs.renameSync(tmp, MSG_FILE);
  // remove uploads no message points at (interrupted uploads, old deletes)
  for (const f of fs.readdirSync(UPLOADS)) {
    if (!fileIndex.has(f)) fs.rmSync(path.join(UPLOADS, f), { force: true });
  }
}

// ---------- webhooks ----------
// Incoming: each hook has a secret address (/hook/<token>) that posts a message into the chat.
// Only a hash of the token is stored.
const HOOK_FILE = path.join(DATA, 'hooks.json');
let hooks = []; // {id, name, hash, created, lastUsed, count}
try { hooks = JSON.parse(fs.readFileSync(HOOK_FILE, 'utf8')); } catch {}
const saveHooksNow = () => { fs.writeFileSync(HOOK_FILE + '.tmp', JSON.stringify(hooks)); fs.renameSync(HOOK_FILE + '.tmp', HOOK_FILE); };
let hookSaveTimer = null;
function saveHooks() {
  if (hookSaveTimer) return;
  hookSaveTimer = setTimeout(() => {
    hookSaveTimer = null;
    try { saveHooksNow(); } catch (e) { console.error(`Could not save webhooks: ${e.message}`); }
  }, 2000);
}
const hookRate = new Map(); // hook id -> recent timestamps
// Outgoing: every new message is announced to the addresses in WEBHOOK_URL.
const OUT_URLS = (process.env.WEBHOOK_URL || '').split(',').map((u) => u.trim()).filter(Boolean);
for (const u of OUT_URLS) {
  let ok = false;
  try { ok = /^https?:$/.test(new URL(u).protocol); } catch {}
  if (!ok) { console.error(`Refusing to start: WEBHOOK_URL entry is not an http(s) address: ${u}`); process.exit(1); }
}
const OUT_SECRET = process.env.WEBHOOK_SECRET || '';
const OUT_TEXT = process.env.WEBHOOK_INCLUDE_TEXT !== '0';
function notifyOut(m) {
  if (!OUT_URLS.length) return;
  const message = { id: m.id, ts: m.ts, from: m.device, source: m.hook ? 'webhook' : 'device' };
  if (OUT_TEXT) {
    message.text = m.text;
    if (m.file) message.file = { name: m.file.name, size: m.file.size, type: m.file.type };
  } else message.hasFile = !!m.file;
  const body = JSON.stringify({ event: 'message', message });
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Flowchat-Webhook' };
  if (OUT_SECRET) headers['X-Flowchat-Signature'] = 'sha256=' + crypto.createHmac('sha256', OUT_SECRET).update(body).digest('hex');
  for (const u of OUT_URLS) {
    fetch(u, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(10e3) })
      .then((r) => { if (!r.ok) console.warn(`Outgoing webhook to ${new URL(u).host} answered ${r.status}`); })
      .catch((e) => console.warn(`Outgoing webhook to ${new URL(u).host} failed: ${e.cause?.code || e.name}`));
  }
}

function addMessage(m) {
  if (messages.length && m.ts <= messages[messages.length - 1].ts) m.ts = messages[messages.length - 1].ts + 1;
  messages.push(m);
  if (m.file) fileIndex.set(m.file.id, m);
  fs.appendFileSync(MSG_FILE, sealLine(m));
  broadcast('message', m);
  notifyOut(m);
}
function deleteMessage(id) {
  const i = messages.findIndex((m) => m.id === id);
  if (i < 0) return false;
  const [m] = messages.splice(i, 1);
  fs.appendFileSync(MSG_FILE, JSON.stringify({ del: id }) + '\n');
  if (m.file) {
    fileIndex.delete(m.file.id);
    fs.rm(path.join(UPLOADS, m.file.id), { force: true }, () => {});
  }
  broadcast('delete', { id });
  return true;
}
if (RETENTION_MS) setInterval(() => {
  while (messages.length && Date.now() - messages[0].ts > RETENTION_MS) deleteMessage(messages[0].id);
}, 600e3).unref();

// ---------- sessions ----------
const sessions = new Map(); // sha256(token) hex -> {id, device, created, seen}
try {
  const saved = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8'));
  if (saved.passId === PASS_ID) for (const [k, v] of Object.entries(saved.sessions)) sessions.set(k, v);
} catch {}
const sessionsJson = () => JSON.stringify({ passId: PASS_ID, sessions: Object.fromEntries(sessions) });
let saveTimer = null;
function saveSessions() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = SESS_FILE + '.tmp';
    fs.writeFile(tmp, sessionsJson(), { mode: 0o600 }, (e) => {
      if (!e) fs.rename(tmp, SESS_FILE, () => {});
    });
  }, 500);
}
function getSession(req) {
  const m = (isHttps(req) ? /(?:^|;\s*)__Host-flow=([A-Za-z0-9_-]+)/ : /(?:^|;\s*)flow_session=([A-Za-z0-9_-]+)/).exec(req.headers.cookie || '');
  if (!m) return null;
  const key = sha(m[1]).toString('hex');
  const s = sessions.get(key);
  if (!s) return null;
  const now = Date.now();
  if (now - s.seen > SESSION_MS) { sessions.delete(key); saveSessions(); return null; }
  if (now - s.seen > 600e3) { s.seen = now; saveSessions(); }
  return { key, ...s };
}
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function cookieHeader(req, token, maxAgeSec) {
  // Over HTTPS the cookie is host-locked and never sent over plain HTTP.
  return isHttps(req)
    ? `__Host-flow=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`
    : `flow_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

// ---------- login throttling ----------
const fails = new Map(); // ip -> {count, until}
let recentFails = []; // timestamps across all addresses
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || '?';
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of fails) if (now - f.last > 3600e3) fails.delete(ip);
}, 600e3).unref();

// ---------- live updates (SSE) ----------
const streams = new Set(); // {res, key}
function broadcast(event, data) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const s of streams) s.res.write(chunk);
}
setInterval(() => { for (const s of streams) s.res.write(': ping\n\n'); }, 25e3).unref();
function dropStreams(key) {
  for (const s of streams) if (s.key === key) { s.res.end(); streams.delete(s); }
}

// ---------- helpers ----------
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};
function json(res, status, body, extra) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}
function readJson(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const newId = () => crypto.randomBytes(16).toString('hex');
const cleanDevice = (d) => (typeof d === 'string' ? d.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) : '') || 'Unnamed device';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
};
const PAGE_CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

// Types a browser may display in place. Everything else downloads.
const INLINE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/[\w.+-]+|application\/pdf|text\/plain)$/;

async function sendFile(req, res, m, forceDownload) {
  const f = m.file;
  const p = path.join(UPLOADS, f.id);
  let st;
  try { st = await fsp.stat(p); } catch { return json(res, 404, { error: 'File is missing' }); }
  const inline = !forceDownload && INLINE.test(f.type);
  const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const headers = {
    ...BASE_HEADERS,
    'Content-Type': inline ? f.type : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store', // shared files are never left in a browser's disk cache
  };
  if (f.type !== 'application/pdf') headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
  let start = 0, end = st.size - 1, status = 200;
  const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (r && (r[1] || r[2]) && st.size > 0) {
    if (r[1]) { start = Number(r[1]); if (r[2]) end = Math.min(Number(r[2]), end); }
    else start = Math.max(0, st.size - Number(r[2]));
    if (start > end || start >= st.size) {
      res.writeHead(416, { ...BASE_HEADERS, 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  const src = fs.createReadStream(p, { start, end }).on('error', () => res.destroy());
  if (f.iv) {
    if (!MASTER) return res.destroy();
    src.pipe(fileCipher(f.id, f.iv, start)).pipe(res);
  } else src.pipe(res);
}

async function handleUpload(req, res, url, sess) {
  const name = (url.searchParams.get('name') || 'file').replace(/[\u0000-\u001f/\\]/g, '_').trim().slice(0, 200) || 'file';
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_BYTES) {
    res.setHeader('Connection', 'close');
    return json(res, 413, { error: `File is larger than the ${MAX_UPLOAD_MB} MB limit` });
  }
  let type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(type)) type = 'application/octet-stream';
  const id = newId();
  const dest = path.join(UPLOADS, id);
  const iv = MASTER ? crypto.randomBytes(16).toString('hex') : null;
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_BYTES) cb(Object.assign(new Error('too large'), { status: 413 }));
      else cb(null, chunk);
    },
  });
  try {
    if (iv) await pipeline(req, counter, fileCipher(id, iv), fs.createWriteStream(dest));
    else await pipeline(req, counter, fs.createWriteStream(dest));
  } catch (e) {
    fs.rm(dest, { force: true }, () => {});
    if (e.status === 413) { res.setHeader('Connection', 'close'); return json(res, 413, { error: `File is larger than the ${MAX_UPLOAD_MB} MB limit` }); }
    if (!res.headersSent && !res.destroyed) json(res, 400, { error: 'Upload was interrupted' });
    return;
  }
  if (size === 0) { fs.rm(dest, { force: true }, () => {}); return json(res, 400, { error: 'File is empty' }); }
  const m = { id: newId(), ts: Date.now(), device: sess.device, text: '', file: { id, name, size, type } };
  if (iv) m.file.iv = iv;
  addMessage(m);
  json(res, 201, m);
}

// ---------- router ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const method = req.method;

  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

  const host = String(req.headers.host || '').toLowerCase();
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(host) && !ALLOWED_HOSTS.includes(host.replace(/:\d+$/, ''))) {
    return json(res, 421, { error: 'This address is not allowed' });
  }
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  else if (REQUIRE_HTTPS) {
    if (method === 'GET' || method === 'HEAD') { res.writeHead(308, { Location: `https://${host}${req.url}` }); return res.end(); }
    return json(res, 400, { error: 'HTTPS is required' });
  }
  if (p === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /\n'); }

  if ((method === 'GET' || method === 'HEAD') && STATIC[p]) {
    const [file, type] = STATIC[p];
    const body = await fsp.readFile(path.join(PUBLIC, file));
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': PAGE_CSP });
    return res.end(method === 'HEAD' ? undefined : body);
  }
  let hm;
  if ((hm = /^\/hook\/([A-Za-z0-9_-]{20,})$/.exec(p))) {
    if (method !== 'POST') return json(res, 405, { error: 'Send a POST request' }, { Allow: 'POST' });
    const hash = sha(hm[1]).toString('hex');
    const hook = hooks.find((h) => h.hash === hash);
    if (!hook) return json(res, 404, { error: 'Unknown webhook' });
    const now = Date.now();
    const recent = (hookRate.get(hook.id) || []).filter((t) => now - t < 60e3);
    if (recent.length >= 60) return json(res, 429, { error: 'Too many messages. Limit is 60 per minute.' }, { 'Retry-After': '60' });
    recent.push(now); hookRate.set(hook.id, recent);
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 256 * 1024) return json(res, 413, { error: 'Message is larger than 256 KB' }, { Connection: 'close' }); chunks.push(c); }
    const raw = Buffer.concat(chunks).toString('utf8');
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    let fields = null;
    if (type === 'application/json') {
      try { fields = JSON.parse(raw); } catch { return json(res, 400, { error: 'Body is not valid JSON' }); }
      if (typeof fields === 'string') fields = { text: fields };
    } else if (type === 'application/x-www-form-urlencoded') fields = Object.fromEntries(new URLSearchParams(raw));
    let text = raw;
    if (fields && typeof fields === 'object') {
      const pick = (...keys) => { for (const k of keys) if (typeof fields[k] === 'string' || typeof fields[k] === 'number') return String(fields[k]); return ''; };
      const title = pick('title', 'subject');
      const bodyText = pick('text', 'content', 'message', 'body', 'description');
      text = title && bodyText ? `${title}\n${bodyText}` : title || bodyText;
      // `curl -d "some text"` labels plain text as a form: fall back to the raw body.
      if (!text && type === 'application/x-www-form-urlencoded') text = raw;
    }
    text = text.trim().slice(0, 100000);
    if (!text) return json(res, 400, { error: 'No message text. Send plain text, or JSON with a "text" field.' });
    const m = { id: newId(), ts: now, device: hook.name, hook: true, text };
    addMessage(m);
    hook.lastUsed = now; hook.count = (hook.count || 0) + 1; saveHooks();
    return json(res, 200, { ok: true, id: m.id });
  }
  if (!p.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

  // Cross-site request guard: other websites may neither change nor read anything.
  const site = req.headers['sec-fetch-site'];
  const navigation = req.headers['sec-fetch-mode'] === 'navigate' && method === 'GET';
  if (site && site !== 'same-origin' && site !== 'none' && !navigation) return json(res, 403, { error: 'Cross-site request refused' });
  if (method !== 'GET' && method !== 'HEAD' && req.headers.origin) {
    let origin = '';
    try { origin = new URL(req.headers.origin).host; } catch {}
    if (origin !== req.headers.host) return json(res, 403, { error: 'Cross-site request refused' });
  }
  if (p === '/api/config' && method === 'GET') return json(res, 200, { totp: !!TOTP_KEY });

  if (p === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    const f = fails.get(ip);
    const now = Date.now();
    if (f && f.until > now) {
      return json(res, 429, { error: `Too many attempts. Try again in ${Math.ceil((f.until - now) / 1000)} seconds.` });
    }
    recentFails = recentFails.filter((t) => now - t < 600e3);
    if (recentFails.length >= 50) return json(res, 429, { error: 'Too many failed sign-ins. Try again in a few minutes.' });
    const body = await readJson(req, 4096);
    const passOk = passwordOk(body.password); // check both, so a wrong code does not confirm the password
    if (!(totpOk(passOk ? body.code : '') && passOk)) {
      recentFails.push(now);
      console.warn(`Failed sign-in from ${ip}`);
      const n = (f ? f.count : 0) + 1;
      fails.set(ip, { count: n, last: now, until: n >= 5 ? now + Math.min(30e3 * 2 ** (n - 5), 3600e3) : 0 });
      await new Promise((r) => setTimeout(r, 400));
      return json(res, 401, { error: TOTP_KEY ? 'Wrong password or code' : 'Wrong password' });
    }
    fails.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const s = { id: newId().slice(0, 12), device: cleanDevice(body.device), created: now, seen: now };
    sessions.set(sha(token).toString('hex'), s);
    saveSessions();
    console.log(`Signed in: "${s.device}" from ${ip}`);
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, token, Math.floor(SESSION_MS / 1000)) });
  }

  const sess = getSession(req);
  if (!sess) return json(res, 401, { error: 'Not signed in' });

  if (p === '/api/logout' && method === 'POST') {
    sessions.delete(sess.key); saveSessions(); dropStreams(sess.key);
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, 'x', 0), 'Clear-Site-Data': '"cache", "storage"' });
  }
  if (p === '/api/me' && method === 'GET') {
    return json(res, 200, { device: sess.device, sid: sess.id, maxUploadMb: MAX_UPLOAD_MB });
  }
  if (p === '/api/messages' && method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    const before = url.searchParams.get('before');
    let end = messages.length;
    if (before) { const i = messages.findIndex((m) => m.id === before); if (i >= 0) end = i; }
    const start = Math.max(0, end - limit);
    return json(res, 200, { messages: messages.slice(start, end), more: start > 0 });
  }
  if (p === '/api/messages' && method === 'POST') {
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return json(res, 400, { error: 'Message is empty' });
    if (text.length > 100000) return json(res, 413, { error: 'Message is too long' });
    const m = { id: newId(), ts: Date.now(), device: sess.device, text };
    addMessage(m);
    return json(res, 201, m);
  }
  let mm;
  if ((mm = /^\/api\/messages\/([a-f0-9]{32})$/.exec(p)) && method === 'DELETE') {
    return deleteMessage(mm[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Already deleted' });
  }
  if (p === '/api/upload' && method === 'POST') return handleUpload(req, res, url, sess);
  if ((mm = /^\/api\/files\/([a-f0-9]{32})$/.exec(p)) && (method === 'GET' || method === 'HEAD')) {
    const m = fileIndex.get(mm[1]);
    if (!m) return json(res, 404, { error: 'File not found' });
    return sendFile(req, res, m, url.searchParams.get('dl') === '1');
  }
  if (p === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const s = { res, key: sess.key };
    streams.add(s);
    req.on('close', () => streams.delete(s));
    return;
  }
  if (p === '/api/hooks' && method === 'GET') {
    return json(res, 200, {
      hooks: hooks.map((h) => ({ id: h.id, name: h.name, created: h.created, lastUsed: h.lastUsed || 0, count: h.count || 0 })),
      outgoing: OUT_URLS.map((u) => new URL(u).host),
    });
  }
  if (p === '/api/hooks' && method === 'POST') {
    const body = await readJson(req, 4096);
    const name = cleanDevice(body.name);
    if (hooks.length >= 50) return json(res, 400, { error: 'Limit of 50 webhooks reached. Remove one first.' });
    const token = crypto.randomBytes(32).toString('base64url');
    const h = { id: newId().slice(0, 12), name, hash: sha(token).toString('hex'), created: Date.now(), lastUsed: 0, count: 0 };
    hooks.push(h); saveHooksNow();
    console.log(`Webhook created: "${name}" by "${sess.device}"`);
    return json(res, 201, { id: h.id, name, path: `/hook/${token}` }); // the only time the address is shown
  }
  if ((mm = /^\/api\/hooks\/([a-f0-9]{12})$/.exec(p)) && method === 'DELETE') {
    hooks = hooks.filter((h) => h.id !== mm[1]); saveHooksNow();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/sessions' && method === 'GET') {
    const list = [...sessions.values()]
      .map((s) => ({ id: s.id, device: s.device, created: s.created, seen: s.seen, current: s.id === sess.id }))
      .sort((a, b) => b.seen - a.seen);
    return json(res, 200, { sessions: list });
  }
  if ((mm = /^\/api\/sessions\/([a-f0-9]{12})$/.exec(p)) && method === 'DELETE') {
    for (const [k, s] of sessions) {
      if (s.id === mm[1]) { sessions.delete(k); dropStreams(k); }
    }
    saveSessions();
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!e.status) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    else res.destroy();
  });
});
server.requestTimeout = 0; // large uploads on slow links
loadMessages().then(() => {
  server.listen(PORT, () => console.log(`Flowchat listening on :${PORT}, data in ${DATA}` +
    ` (encryption at rest: ${MASTER ? 'on' : 'off'}, two-step sign-in: ${TOTP_KEY ? 'on' : 'off'})`));
}, (e) => { console.error(`Refusing to start: ${e.message}`); process.exit(1); });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  try { fs.writeFileSync(SESS_FILE, sessionsJson(), { mode: 0o600 }); } catch {}
  try { if (hookSaveTimer) saveHooksNow(); } catch {}
  process.exit(0);
});
