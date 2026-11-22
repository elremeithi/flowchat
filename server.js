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
// Shown in Settings (browser and app) so it is easy to tell whether a server is up to date.
const SERVER_VERSION = '1.6';

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
const PASSWORD_GENERATED = !process.env.APP_PASSWORD;
if (/^(change-?me|password|admin|flowchat|123456.*)$/i.test(PASSWORD)) {
  console.error('Refusing to start: APP_PASSWORD is a placeholder or a common password. Choose your own.');
  process.exit(1);
}
if (PASSWORD.length < 12) console.warn('Warning: APP_PASSWORD is shorter than 12 characters. Use a longer one if this is reachable from the internet.');
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const PASS_HASH = sha(PASSWORD);
const passwordOk = (p) => typeof p === 'string' && crypto.timingSafeEqual(sha(p), PASS_HASH);

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

// ---------- encryption at rest (always on) ----------
// Everything stored (messages, notes, file names and contents, devices, webhooks) is encrypted
// with a random data key. That key is kept in key.json, locked with a key derived from
// APP_PASSWORD (scrypt), so a copy of the data folder is unreadable without the password.
const KEY_FILE = path.join(DATA, 'key.json');
const LEGACY_SALT = path.join(DATA, 'encryption-salt');
const KDF = { N: 1 << 17, r: 8, p: 1 }; // about 128 MB of memory per guess
function deriveKek(password, salt, kdf) {
  return crypto.scryptSync(password, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 512 * 1024 * 1024 });
}
function lockKey(dek, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKek(password, salt, KDF), iv);
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return { v: 1, kdf: { name: 'scrypt', ...KDF }, salt: salt.toString('base64'), key: Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') };
}
function unlockKey(stored, password) {
  try {
    const buf = Buffer.from(stored.key, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', deriveKek(password, Buffer.from(stored.salt, 'base64'), stored.kdf), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
  } catch { return null; }
}
function saveKeyFile(stored) {
  fs.writeFileSync(KEY_FILE + '.tmp', JSON.stringify(stored));
  fs.renameSync(KEY_FILE + '.tmp', KEY_FILE);
}
function refuse(message) { console.error(`Refusing to start: ${message}`); process.exit(1); }

let MASTER = null;
let keyStored = null;
if (fs.existsSync(KEY_FILE)) {
  try { keyStored = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); } catch { refuse(`${KEY_FILE} is damaged. Restore it from a backup.`); }
  MASTER = unlockKey(keyStored, PASSWORD);
  if (!MASTER && process.env.OLD_APP_PASSWORD) {
    MASTER = unlockKey(keyStored, process.env.OLD_APP_PASSWORD);
    if (!MASTER) refuse('neither APP_PASSWORD nor OLD_APP_PASSWORD unlocks the stored data.');
    keyStored = lockKey(MASTER, PASSWORD);
    saveKeyFile(keyStored);
    console.log('The data is now locked with the new APP_PASSWORD. Remove OLD_APP_PASSWORD from the settings.');
  }
  if (!MASTER) {
    refuse('APP_PASSWORD does not unlock the stored data. If you changed the password, '
      + 'set OLD_APP_PASSWORD to the previous one for one start, and the data is moved to the new password.');
  }
  if (process.env.ENCRYPTION_KEY) console.log('ENCRYPTION_KEY is no longer used and can be removed: the data is locked with APP_PASSWORD.');
} else {
  if (fs.existsSync(LEGACY_SALT)) {
    // Data from an older version, encrypted with ENCRYPTION_KEY: keep its key, now locked with the password.
    if (!process.env.ENCRYPTION_KEY) refuse('this data was encrypted with ENCRYPTION_KEY. Set it for one start so the data can be moved to password-based encryption.');
    MASTER = crypto.scryptSync(process.env.ENCRYPTION_KEY, fs.readFileSync(LEGACY_SALT), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    // Check the key against stored data before locking it in.
    let sample = null;
    try { sample = fs.readFileSync(MSG_FILE, 'utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((o) => o && o.e); } catch {}
    if (sample) {
      try {
        const buf = Buffer.from(sample.e, 'base64');
        const d = crypto.createDecipheriv('aes-256-gcm', crypto.createHmac('sha256', MASTER).update('messages').digest(), buf.subarray(0, 12));
        d.setAuthTag(buf.subarray(12, 28));
        Buffer.concat([d.update(buf.subarray(28)), d.final()]);
      } catch { refuse('ENCRYPTION_KEY does not decrypt the stored messages. Check that it is the one the data was saved with.'); }
    }
    console.log('Moved encryption from ENCRYPTION_KEY to APP_PASSWORD. ENCRYPTION_KEY can be removed after this start.');
  } else {
    MASTER = crypto.randomBytes(32);
  }
  keyStored = lockKey(MASTER, PASSWORD);
  saveKeyFile(keyStored);
}
const subKey = (purpose) => crypto.createHmac('sha256', MASTER).update(purpose).digest();
const MSG_KEY = subKey('messages');
function seal(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function unseal(key, b64, what) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  try { return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'); }
  catch { throw new Error(`The stored ${what} cannot be decrypted. The data folder may be damaged or mixed with another one.`); }
}
const sealLine = (obj) => JSON.stringify({ e: seal(MSG_KEY, JSON.stringify(obj)) }) + '\n';
const openLine = (o) => (o.e ? JSON.parse(unseal(MSG_KEY, o.e, 'messages')) : o); // plain lines: older versions
// Small files (notes, devices, webhooks) are stored whole as one encrypted block.
function writeSealed(file, purpose, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify({ e: seal(subKey(purpose), JSON.stringify(value)) }));
  fs.renameSync(file + '.tmp', file);
}
function readSealed(file, purpose, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  const o = JSON.parse(raw);
  return o && typeof o.e === 'string' && Object.keys(o).length === 1 ? JSON.parse(unseal(subKey(purpose), o.e, purpose)) : o;
}
if (PASSWORD_GENERATED) {
  console.warn('Warning: the generated password is saved in the data folder, so the encryption does not protect '
    + 'a copy of that folder. Set APP_PASSWORD to a password of your own.');
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
  // Encrypt files that were stored by a version without encryption.
  for (const m of messages) {
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
hooks = readSealed(HOOK_FILE, 'hooks', []);
const saveHooksNow = () => writeSealed(HOOK_FILE, 'hooks', hooks);
if (hooks.length && !/^\{"e":/.test(fs.readFileSync(HOOK_FILE, 'utf8'))) saveHooksNow(); // encrypt an older plain file
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
  fs.appendFileSync(MSG_FILE, sealLine({ del: id }));
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

// ---------- notes ----------
const NOTES_FILE = path.join(DATA, 'notes.json');
const notes = new Map(); // id -> {id, title, body, created, updated, by}
for (const n of readSealed(NOTES_FILE, 'notes', [])) notes.set(n.id, n);
const saveNotes = () => writeSealed(NOTES_FILE, 'notes', [...notes.values()]);
const MAX_NOTES = 5000;
function noteFields(body) {
  const title = typeof body.title === 'string' ? body.title.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) : '';
  const text = typeof body.body === 'string' ? body.body : '';
  if (text.length > 500000) throw Object.assign(new Error('Note is too long (500,000 characters at most)'), { status: 413 });
  return { title, body: text };
}

// ---------- QR codes ----------
// A code is either text (shown as a generated QR code) or an image the person imported
// (a ticket, boarding pass or other barcode that could not be read as a QR code).
const CODES_FILE = path.join(DATA, 'codes.json');
const codes = new Map(); // id -> {id, title, kind, content | image, created, updated, by}
for (const c of readSealed(CODES_FILE, 'codes', [])) codes.set(c.id, c);
const saveCodes = () => writeSealed(CODES_FILE, 'codes', [...codes.values()]);
// Removed codes stay in a "Recently removed" bin for 30 days, so a code deleted on a lost or
// stolen phone (or by mistake) can be restored. `removed` holds the time it was removed.
const TRASH_MS = 30 * 86400e3;
const liveCodes = () => [...codes.values()].filter((c) => !c.removed);
function purgeTrash() {
  let gone = 0;
  for (const [id, c] of codes) if (c.removed && Date.now() - c.removed > TRASH_MS) { codes.delete(id); gone++; }
  if (gone) saveCodes();
}
purgeTrash();
setInterval(purgeTrash, 3600e3).unref();
const MAX_CODES = 300;
const MAX_QR_BYTES = 2331;                 // the most a QR code holds at error correction level M
const MAX_IMAGE_CHARS = 2 * 1024 * 1024;   // per image, as a data: URL
const MAX_IMAGES_TOTAL = 40 * 1024 * 1024; // all images together
const badCode = (message, status = 400) => Object.assign(new Error(message), { status });
function codeFields(body, existing) {
  const title = typeof body.title === 'string' ? body.title.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 100) : '';
  if (!title) throw badCode('Give the code a title');
  const kind = existing ? existing.kind : body.kind;
  if (kind === 'text') {
    const content = typeof body.content === 'string' ? body.content : existing ? existing.content : '';
    if (!content.trim()) throw badCode('Enter the text or link the code should hold');
    if (Buffer.byteLength(content, 'utf8') > MAX_QR_BYTES) throw badCode(`Too long for a QR code (${MAX_QR_BYTES} bytes at most)`, 413);
    return { title, kind, content };
  }
  if (kind === 'image') {
    if (existing) return { title, kind, image: existing.image };
    const image = typeof body.image === 'string' ? body.image : '';
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(image)) throw badCode('The image must be a PNG, JPEG or WebP picture');
    if (image.length > MAX_IMAGE_CHARS) throw badCode('The image is too large (2 MB at most)', 413);
    let total = image.length;
    for (const c of codes.values()) if (c.image) total += c.image.length;
    if (total > MAX_IMAGES_TOTAL) throw badCode('Storage for code images is full (40 MB). Remove some image codes first.', 413);
    return { title, kind, image };
  }
  throw badCode('Unknown kind of code');
}

// ---------- sessions ----------
const sessions = new Map(); // sha256(token) hex -> {id, device, created, seen}
// Sessions are tied to the current password lock: changing the password signs every device out.
const PASS_ID = crypto.createHmac('sha256', MASTER).update('sessions:' + keyStored.salt).digest('hex').slice(0, 16);
try {
  const saved = readSealed(SESS_FILE, 'sessions', null);
  if (saved && saved.passId === PASS_ID) for (const [k, v] of Object.entries(saved.sessions)) sessions.set(k, v);
} catch {}
const sessionsJson = () => JSON.stringify({ e: seal(subKey('sessions'), JSON.stringify({ passId: PASS_ID, sessions: Object.fromEntries(sessions) })) });
try { // replace a device list left unencrypted by an older version
  if (!/^\{"e":/.test(fs.readFileSync(SESS_FILE, 'utf8'))) fs.writeFileSync(SESS_FILE, sessionsJson(), { mode: 0o600 });
} catch {}
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
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/vendor/qrcode.js': ['vendor/qrcode.js', 'text/javascript; charset=utf-8'],
  '/vendor/jsQR.js': ['vendor/jsQR.js', 'text/javascript; charset=utf-8'],
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
  const iv = crypto.randomBytes(16).toString('hex');
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
  if (p === '/api/config' && method === 'GET') return json(res, 200, { totp: !!TOTP_KEY, version: SERVER_VERSION });

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
    return json(res, 200, { device: sess.device, sid: sess.id, maxUploadMb: MAX_UPLOAD_MB, version: SERVER_VERSION });
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
  if (p === '/api/notes' && method === 'GET') {
    return json(res, 200, { notes: [...notes.values()].sort((a, b) => b.updated - a.updated) });
  }
  if (p === '/api/notes' && method === 'POST') {
    if (notes.size >= MAX_NOTES) return json(res, 400, { error: `Limit of ${MAX_NOTES} notes reached. Delete some first.` });
    const f = noteFields(await readJson(req, 2 * 1024 * 1024));
    const now = Date.now();
    const n = { id: newId(), ...f, created: now, updated: now, by: sess.device };
    notes.set(n.id, n); saveNotes();
    broadcast('note', n);
    return json(res, 201, n);
  }
  if ((mm = /^\/api\/notes\/([a-f0-9]{32})$/.exec(p)) && method === 'PUT') {
    const n = notes.get(mm[1]);
    if (!n) return json(res, 404, { error: 'This note was deleted on another device' });
    const body = await readJson(req, 2 * 1024 * 1024);
    // `base` is the version the editor started from: refuse to overwrite a newer edit from another device.
    if (body.base !== undefined && body.base !== n.updated) return json(res, 409, { error: 'Changed on another device', note: n });
    Object.assign(n, noteFields(body), { updated: Math.max(Date.now(), n.updated + 1), by: sess.device });
    saveNotes();
    broadcast('note', n);
    return json(res, 200, n);
  }
  if ((mm = /^\/api\/notes\/([a-f0-9]{32})$/.exec(p)) && method === 'DELETE') {
    if (notes.delete(mm[1])) { saveNotes(); broadcast('noteDelete', { id: mm[1] }); }
    return json(res, 200, { ok: true });
  }
  if (p === '/api/codes' && method === 'GET') {
    return json(res, 200, { codes: liveCodes() });
  }
  if (p === '/api/codes/removed' && method === 'GET') {
    const list = [...codes.values()].filter((c) => c.removed).sort((a, b) => b.removed - a.removed)
      .map((c) => ({ id: c.id, title: c.title, kind: c.kind, removed: c.removed, removedBy: c.removedBy, purge: c.removed + TRASH_MS }));
    return json(res, 200, { codes: list });
  }
  if ((mm = /^\/api\/codes\/([a-f0-9]{32})\/restore$/.exec(p)) && method === 'POST') {
    const c = codes.get(mm[1]);
    if (!c || !c.removed) return json(res, 404, { error: 'This code is no longer in Recently removed' });
    delete c.removed; delete c.removedBy;
    Object.assign(c, { updated: Math.max(Date.now(), c.updated + 1), by: sess.device });
    saveCodes();
    console.log(`QR code restored: "${c.title}" by "${sess.device}"`);
    broadcast('code', c);
    return json(res, 200, c);
  }
  if (p === '/api/codes' && method === 'POST') {
    if (liveCodes().length >= MAX_CODES) return json(res, 400, { error: `Limit of ${MAX_CODES} codes reached. Remove some first.` });
    if (codes.size >= MAX_CODES * 2) return json(res, 400, { error: 'Recently removed is full. Empty it in Settings first.' });
    const f = codeFields(await readJson(req, 3 * 1024 * 1024));
    const now = Date.now();
    const c = { id: newId(), ...f, created: now, updated: now, by: sess.device };
    codes.set(c.id, c); saveCodes();
    broadcast('code', c);
    return json(res, 201, c);
  }
  if ((mm = /^\/api\/codes\/([a-f0-9]{32})$/.exec(p)) && method === 'PUT') {
    const c = codes.get(mm[1]);
    if (!c || c.removed) return json(res, 404, { error: 'This code was removed on another device' });
    Object.assign(c, codeFields(await readJson(req, 64 * 1024), c), { updated: Math.max(Date.now(), c.updated + 1), by: sess.device });
    saveCodes();
    broadcast('code', c);
    return json(res, 200, c);
  }
  if ((mm = /^\/api\/codes\/([a-f0-9]{32})$/.exec(p)) && method === 'DELETE') {
    const c = codes.get(mm[1]);
    if (c && !c.removed) {
      // Moved to Recently removed, not deleted.
      c.removed = Date.now(); c.removedBy = sess.device;
      saveCodes();
      console.log(`QR code removed: "${c.title}" by "${sess.device}" (kept 30 days in Recently removed)`);
      broadcast('codeDelete', { id: c.id });
    } else if (c && c.removed && url.searchParams.get('forever') === '1') {
      codes.delete(c.id); saveCodes(); // deleted for good from the bin
    }
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
    ` (data encrypted with APP_PASSWORD, two-step sign-in: ${TOTP_KEY ? 'on' : 'off'})`));
}, (e) => { console.error(`Refusing to start: ${e.message}`); process.exit(1); });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  try { fs.writeFileSync(SESS_FILE, sessionsJson(), { mode: 0o600 }); } catch {}
  try { if (hookSaveTimer) saveHooksNow(); } catch {}
  process.exit(0);
});
