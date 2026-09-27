'use strict';
/*
  Live server for the birthday party.

  - Serves the game page (public/index.html) and talks to it over a WebSocket at /ws.
  - Only guests who sign up appear. Nobody is pretend.
  - Keeps guests, photos and buffet bills on disk (DATA_DIR), so they survive a restart.
  - /admin?key=ADMIN_KEY shows every guest's bill and lets you remove a guest.

  Settings (environment variables, all optional):
    PORT            port to listen on (hosts set this for you)
    DATA_DIR        where to keep guests and photos (default ./data)
    BIRTHDAY_NAME   name shown in the room and on the banner (default Laura)
    VIP_KEY         secret for the birthday girl's link:  https://your-site/?vip=VIP_KEY
    ADMIN_KEY       secret for the bills page:            https://your-site/admin?key=ADMIN_KEY
    MAX_GUESTS      most guests allowed to sign up (default 80)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const BIRTHDAY_NAME = (process.env.BIRTHDAY_NAME || 'Laura').replace(/[<>]/g, '').slice(0, 24) || 'Laura';
const MAX_GUESTS = Number(process.env.MAX_GUESTS) || 80;
const MAX_PHOTOS = 80;

fs.mkdirSync(PHOTO_DIR, { recursive: true });

/* ---------- things that must match public/index.html ---------- */
// Same order and prices as P.MENU in the page. The array index is the item id in messages.
const MENU = [
  ['Seafood pastilla', 855], ['Roasted chicken with vegetables', 540], ['Lhm bel barqouq', 600],
  ['Moroccan chicken with caramelized onions', 722], ['Seasonal fruit', 600], ['Tiramisu', 800],
  ['Kaab el ghazal', 800], ['Fekkas', 500], ['Moroccan mint tea', 200], ['Coca Cola', 300],
  ['Coca Zero', 400], ['Cold brew latte with gluten-free milk', 300], ['Iced latte, gluten-free milk', 344],
  ['Flat white', 200],
  ['Pumpkin Maple Matcha', 450], ['Mango Matcha Latte', 500], ['Strawberry Cream Matcha', 480],
  ['Butterfly Pea Honey Lemon Matcha', 520], ['Salted Honey Matcha Latte', 460], ['Matcha Espresso Fusion', 550],
  ['Pistachio Matcha', 500], ['Matcha Coconut Refresher', 470], ['Brown Sugar Iced Vanilla Matcha', 490],
  ['Blueberry Ube Matcha', 530], ['Caramel Apple Matcha', 480]
];
const MAX_PER_ITEM = 9;
const AV = { skin: 8, hairStyle: 8, hairColor: 10, outfitStyle: 5, outfitColor: 10, hat: 8, acc: 5 };
const BOUNDS = { minX: 16, maxX: 464, minY: 112, maxY: 310 };
const SPAWN = { x: 240, y: 300 };
const EMOTES = ['wave', 'dance', 'cheer', 'heart'];

function euro(c) { return Math.floor(c / 100) + ',' + ('0' + (c % 100)).slice(-2) + '\u00a0€'; }

/* ---------- small helpers ---------- */
function clean(s, n) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
}
function cleanAvatar(a) {
  const out = {};
  a = a && typeof a === 'object' ? a : {};
  Object.keys(AV).forEach((k) => {
    let v = Number.isInteger(a[k]) ? a[k] : 0;
    if (v < 0 || v >= AV[k]) v = 0;
    out[k] = v;
  });
  return out;
}
function cleanEaten(a) {
  const out = MENU.map(() => 0);
  if (Array.isArray(a)) a.forEach((n, i) => { if (i < out.length && Number.isInteger(n) && n > 0) out[i] = Math.min(n, MAX_PER_ITEM); });
  return out;
}
function hash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function safeEq(a, b) { return crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))); }
function randomKey() { return crypto.randomBytes(9).toString('base64url'); }
function newId() { return crypto.randomBytes(6).toString('hex'); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || '?';
}

/* ---------- secret keys: from the environment, or made once and kept on disk ---------- */
const KEY_FILE = path.join(DATA_DIR, 'keys.json');
let stored = {};
try { stored = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')) || {}; } catch (e) { stored = {}; }
let keysChanged = false;
function pickKey(envName, storedName) {
  if (process.env[envName]) return process.env[envName];
  if (!stored[storedName]) { stored[storedName] = randomKey(); keysChanged = true; }
  return stored[storedName];
}
const VIP_KEY = pickKey('VIP_KEY', 'vip');
const ADMIN_KEY = pickKey('ADMIN_KEY', 'admin');
if (keysChanged) { try { fs.writeFileSync(KEY_FILE, JSON.stringify(stored)); } catch (e) { /* read-only disk */ } }

/* ---------- saved state ---------- */
const db = { guests: [], photos: [] };
const byId = new Map();
const byHash = new Map();
let nextSlot = 0;

function loadState() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch (e) { return; }
  (raw.guests || []).forEach((g) => {
    if (!g || typeof g.id !== 'string' || typeof g.tokenHash !== 'string' || byId.has(g.id)) return;
    const guest = {
      id: g.id, tokenHash: g.tokenHash,
      first: clean(g.first, 20), last: clean(g.last, 20), avatar: cleanAvatar(g.avatar),
      slot: Number.isInteger(g.slot) ? g.slot : nextSlot,
      isBirthday: !!g.isBirthday, createdAt: +g.createdAt || Date.now(), lastSeen: +g.lastSeen || Date.now(),
      eaten: cleanEaten(g.eaten)
    };
    if (!guest.first || !guest.last) return;
    db.guests.push(guest); byId.set(guest.id, guest); byHash.set(guest.tokenHash, guest);
    nextSlot = Math.max(nextSlot, guest.slot + 1);
  });
  (raw.photos || []).forEach((p) => {
    if (p && /^[a-z0-9]+$/.test(String(p.id)) && fs.existsSync(path.join(PHOTO_DIR, p.id + '.png'))) {
      db.photos.push({ id: p.id, gid: String(p.gid), name: clean(p.name, 41), at: +p.at || Date.now(), frame: Number.isInteger(p.frame) ? p.frame : 0 });
    }
  });
}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeState(); }, 400);
}
function writeState() {
  const tmp = STATE_FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, STATE_FILE); } catch (e) { console.error('Could not save:', e.message); }
}
loadState();

/* ---------- who is here right now ---------- */
const live = new Map();        // guest id -> { ws, x, y, dir, s, moved, last: {snack, emote, chat, photo} }
const lit = new Set();         // guest ids with a candle on the cake
let blownAt = null;

function pub(g) {
  return {
    id: g.id, first: g.first, last: g.last, avatar: g.avatar, isBirthday: !!g.isBirthday,
    candle: lit.has(g.id), slot: g.slot, online: live.has(g.id), lastSeen: g.lastSeen, eaten: g.eaten
  };
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj, except) {
  const msg = JSON.stringify(obj);
  live.forEach((l) => { if (l.ws !== except && l.ws.readyState === 1) l.ws.send(msg); });
}
function positions() {
  const p = [];
  live.forEach((l, id) => p.push([id, Math.round(l.x), Math.round(l.y), l.dir, l.s]));
  return p;
}
function grantBirthday(g) {
  db.guests.forEach((o) => {
    if (o !== g && o.isBirthday) { o.isBirthday = false; broadcast({ t: 'guest', guest: pub(o) }); }
  });
  g.isBirthday = true;
  save();
}

/* ---------- web server ---------- */
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};
const GAME_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'";
const ADMIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

function reply(res, status, type, body, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) }, SECURITY, extra || {}));
  res.end(body);
}

function adminPage() {
  const rows = [];
  const dishTotals = MENU.map(() => 0);
  let grand = 0, online = 0;
  db.guests.slice().sort((a, b) => (a.first + a.last).localeCompare(b.first + b.last)).forEach((g) => {
    let total = 0;
    const items = [];
    g.eaten.forEach((n, i) => { if (n) { total += n * MENU[i][1]; dishTotals[i] += n; items.push(n + ' × ' + esc(MENU[i][0])); } });
    grand += total;
    const isOn = live.has(g.id);
    if (isOn) online++;
    rows.push('<tr><td>' + esc(g.first + ' ' + g.last) + (g.isBirthday ? ' 👑' : '') + '</td><td>' + (isOn ? '<span class="on"></span>Online' : '') + '</td><td>' +
      (items.join('<br>') || '<span class="muted">Nothing yet</span>') + '</td><td class="num">' + euro(total) + '</td><td>' +
      '<details><summary>Remove</summary><form method="post" action="/admin/remove"><input type="hidden" name="key" value="' + esc(ADMIN_KEY) + '"><input type="hidden" name="id" value="' + esc(g.id) + '"><button>Yes, remove ' + esc(g.first) + '</button></form></details></td></tr>');
  });
  const dishRows = MENU.map((m, i) => dishTotals[i] ? '<tr><td>' + esc(m[0]) + '</td><td class="num">' + dishTotals[i] + '</td><td class="num">' + euro(dishTotals[i] * m[1]) + '</td></tr>' : '').join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="20"><meta name="robots" content="noindex"><title>Party bills</title><style>' +
    'body{margin:0;padding:20px;background:#FCE6EA;color:#5A2A3C;font:16px/1.4 "Trebuchet MS","Segoe UI",system-ui,sans-serif}' +
    'main{max-width:900px;margin:0 auto}h1{margin:0 0 4px}h2{margin:28px 0 8px}.muted{color:#8A6674}' +
    '.card{background:#fff;border:3px solid #5A2A3C;border-radius:18px;box-shadow:0 5px 0 #5A2A3C;overflow-x:auto}' +
    'table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px 12px;border-bottom:2px dashed #d9c3cb;vertical-align:top}' +
    'tr:last-child td{border-bottom:0}th{background:#FBE3A0}.num{text-align:right;white-space:nowrap;font-weight:600}' +
    '.on{display:inline-block;width:12px;height:12px;margin-right:6px;background:#2ECC71;border:2px solid #5A2A3C;border-radius:50%}' +
    'summary{cursor:pointer;color:#8A6674}button{font:inherit;padding:.4em .8em;border:2px solid #5A2A3C;border-radius:999px;background:#F6A6BA;color:#5A2A3C;font-weight:600}' +
    '</style></head><body><main><h1>Party bills</h1><p class="muted">' + db.guests.length + ' signed up, ' + online + ' online now. This page refreshes by itself.</p>' +
    '<div class="card"><table><thead><tr><th>Guest</th><th></th><th>Took</th><th class="num">Bill</th><th></th></tr></thead><tbody>' +
    (rows.join('') || '<tr><td colspan="5" class="muted">Nobody has signed up yet.</td></tr>') +
    '</tbody><tfoot><tr><td colspan="3"><strong>All bills together</strong></td><td class="num">' + euro(grand) + '</td><td></td></tr></tfoot></table></div>' +
    '<h2>What was taken</h2><div class="card"><table><thead><tr><th>Dish</th><th class="num">How many</th><th class="num">Amount</th></tr></thead><tbody>' +
    (dishRows || '<tr><td colspan="3" class="muted">Nothing taken yet.</td></tr>') + '</tbody></table></div></main></body></html>';
}

function readBody(req, limit, cb) {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return reply(res, 400, 'text/plain', 'Bad request'); }
  const p = url.pathname;

  if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/index.html')) {
    return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
      if (err) return reply(res, 500, 'text/plain', 'The game page is missing (public/index.html).');
      reply(res, 200, 'text/html; charset=utf-8', html, { 'Cache-Control': 'no-cache', 'Content-Security-Policy': GAME_CSP });
    });
  }
  if (p === '/healthz') return reply(res, 200, 'text/plain', 'ok');

  const ph = /^\/photo\/([a-z0-9]+)\.png$/.exec(p);
  if (ph && req.method === 'GET') {
    return fs.readFile(path.join(PHOTO_DIR, ph[1] + '.png'), (err, buf) => {
      if (err) return reply(res, 404, 'text/plain', 'Not found');
      res.writeHead(200, Object.assign({ 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=31536000, immutable' }, SECURITY));
      res.end(buf);
    });
  }

  if (p === '/admin' && req.method === 'GET') {
    if (!safeEq(url.searchParams.get('key') || '', ADMIN_KEY)) return reply(res, 404, 'text/plain', 'Not found');
    return reply(res, 200, 'text/html; charset=utf-8', adminPage(), { 'Cache-Control': 'no-store', 'Content-Security-Policy': ADMIN_CSP });
  }
  if (p === '/admin/remove' && req.method === 'POST') {
    return readBody(req, 2048, (body) => {
      const f = new URLSearchParams(body);
      if (!safeEq(f.get('key') || '', ADMIN_KEY)) return reply(res, 404, 'text/plain', 'Not found');
      removeGuest(f.get('id') || '');
      res.writeHead(303, Object.assign({ Location: '/admin?key=' + encodeURIComponent(ADMIN_KEY) }, SECURITY));
      res.end();
    });
  }
  reply(res, 404, 'text/plain', 'Not found');
});

function removeGuest(id, reason) {
  const g = byId.get(id);
  if (!g) return;
  const l = live.get(id);
  db.guests = db.guests.filter((x) => x !== g);
  byId.delete(id); byHash.delete(g.tokenHash); lit.delete(id);
  if (l) { live.delete(id); send(l.ws, { t: 'kicked', reason: reason || 'removed' }); l.ws.gid = null; try { l.ws.close(); } catch (e) { /* already closed */ } }
  broadcast({ t: 'gone', id });
  save();
}

/* ---------- the live connection ---------- */
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 160 * 1024
  // No origin/Host check here: some hosts (Railway's proxy among them) rewrite the Host
  // header before it reaches the app, which made a same-origin check reject every real
  // connection. The token in the first message is what identifies a guest, not this.
});

const createLog = new Map();   // ip -> times of recent sign-ups
function createAllowed(ip) {
  const now = Date.now();
  const list = (createLog.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 8) { createLog.set(ip, list); return false; }
  list.push(now); createLog.set(ip, list);
  return true;
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.gid = null; ws.tokenHash = null; ws.vipOk = false;
  ws.ip = clientIp(req);
  ws.bucket = { n: 80, at: Date.now() };
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => { /* the close handler cleans up */ });
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const now = Date.now();
    ws.bucket.n = Math.min(80, ws.bucket.n + (now - ws.bucket.at) / 1000 * 50);
    ws.bucket.at = now;
    if (ws.bucket.n < 1) return;
    ws.bucket.n -= 1;
    let m;
    try { m = JSON.parse(raw.toString('utf8')); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    try { handle(ws, m, now); } catch (e) { console.error('Message error:', e.message); }
  });
  ws.on('close', () => {
    const gid = ws.gid;
    if (!gid) return;
    const l = live.get(gid);
    if (!l || l.ws !== ws) return;
    live.delete(gid);
    const g = byId.get(gid);
    if (!g) return;
    g.lastSeen = Date.now();
    save();
    broadcast({ t: 'presence', id: gid, online: false, lastSeen: g.lastSeen });
  });
});

function attach(ws, g, isNew) {
  const old = live.get(g.id);
  if (old && old.ws !== ws) {
    send(old.ws, { t: 'kicked' });
    old.ws.gid = null;
    try { old.ws.close(); } catch (e) { /* already closed */ }
  }
  if (ws.vipOk && !g.isBirthday) grantBirthday(g);
  ws.gid = g.id;
  live.set(g.id, { ws, x: SPAWN.x, y: SPAWN.y, dir: 3, s: 0, moved: true, at: { snack: 0, emote: 0, chat: 0, photo: 0 } });
  g.lastSeen = Date.now();
  save();
  send(ws, {
    t: 'welcome', you: g.id, birthdayName: BIRTHDAY_NAME, guests: db.guests.map(pub), pos: positions(),
    photos: db.photos, chat: [], lit: Array.from(lit), blownAt, eaten: g.eaten, now: Date.now()
  });
  if (isNew || g.isBirthday) broadcast({ t: 'guest', guest: pub(g) }, ws);
  else broadcast({ t: 'presence', id: g.id, online: true, lastSeen: g.lastSeen }, ws);
}

function handle(ws, m, now) {
  if (m.t === 'hello') {
    if (typeof m.token !== 'string' || !/^[0-9a-f]{16,64}$/.test(m.token)) { ws.close(); return; }
    ws.tokenHash = hash(m.token);
    ws.vipOk = typeof m.vip === 'string' && m.vip !== '' && safeEq(m.vip, VIP_KEY);
    const g = byHash.get(ws.tokenHash);
    if (g) attach(ws, g, false);
    else send(ws, { t: 'need_profile', birthdayName: BIRTHDAY_NAME });
    return;
  }
  if (!ws.tokenHash) return;

  if (m.t === 'create') {
    if (ws.gid) return;
    const existing = byHash.get(ws.tokenHash);
    if (existing) { attach(ws, existing, false); return; }
    const first = clean(m.first, 20), last = clean(m.last, 20);
    if (!first || !last) { send(ws, { t: 'error', code: 'name' }); return; }
    if (db.guests.length >= MAX_GUESTS) { send(ws, { t: 'error', code: 'full' }); return; }
    if (!createAllowed(ws.ip)) { send(ws, { t: 'error', code: 'busy' }); return; }
    if (typeof m.vip === 'string' && m.vip !== '' && safeEq(m.vip, VIP_KEY)) ws.vipOk = true;
    const g = {
      id: newId(), tokenHash: ws.tokenHash, first, last, avatar: cleanAvatar(m.avatar), slot: nextSlot++,
      isBirthday: false, createdAt: now, lastSeen: now, eaten: MENU.map(() => 0)
    };
    db.guests.push(g); byId.set(g.id, g); byHash.set(g.tokenHash, g);
    attach(ws, g, true);
    return;
  }

  const g = ws.gid ? byId.get(ws.gid) : null;
  const l = g ? live.get(g.id) : null;
  if (!g || !l || l.ws !== ws) return;

  switch (m.t) {
    case 'move': {
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
      const x = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, m.x));
      const y = Math.max(BOUNDS.minY, Math.min(BOUNDS.maxY, m.y));
      const dir = Number.isInteger(m.dir) && m.dir >= 0 && m.dir <= 3 ? m.dir : 0;
      const s = Number.isInteger(m.s) && m.s >= 0 && m.s <= 2 ? m.s : 0;
      if (x !== l.x || y !== l.y || dir !== l.dir || s !== l.s) { l.x = x; l.y = y; l.dir = dir; l.s = s; l.moved = true; }
      return;
    }
    case 'edit': {
      const f = clean(m.first, 20), la = clean(m.last, 20);
      if (f && la) { g.first = f; g.last = la; }
      g.avatar = cleanAvatar(m.avatar);
      save();
      broadcast({ t: 'guest', guest: pub(g) });
      return;
    }
    case 'leave':
      removeGuest(g.id, 'left');   // removing yourself: reuses the same path the admin page's Remove button uses
      return;
    case 'emote':
      if (EMOTES.indexOf(m.e) < 0 || now - l.at.emote < 400) return;
      l.at.emote = now;
      broadcast({ t: 'emote', id: g.id, e: m.e });
      return;
    case 'chat': {
      const text = clean(m.text, 80);
      if (!text || now - l.at.chat < 500) return;
      l.at.chat = now;
      broadcast({ t: 'chat', id: g.id, text, at: now });
      return;
    }
    case 'candle':
      lit.add(g.id);
      broadcast({ t: 'candles', lit: Array.from(lit) });
      return;
    case 'blow':
      if (!g.isBirthday || lit.size === 0) return;
      lit.clear();
      blownAt = now;
      broadcast({ t: 'blown', by: g.id, at: now });
      broadcast({ t: 'candles', lit: [] });
      return;
    case 'snack':
    case 'untake': {
      if (!Number.isInteger(m.i) || m.i < 0 || m.i >= MENU.length) return;
      if (now - l.at.snack < 120) { send(ws, { t: 'error', code: 'wait' }); return; }
      l.at.snack = now;
      const have = g.eaten[m.i] || 0;
      if (m.t === 'snack') {
        if (have >= MAX_PER_ITEM) { send(ws, { t: 'error', code: 'max', item: m.i }); return; }
        g.eaten[m.i] = have + 1;
      } else {
        if (have <= 0) return;
        g.eaten[m.i] = have - 1;
      }
      save();
      send(ws, { t: 'bill', eaten: g.eaten.slice(), item: m.i, delta: m.t === 'snack' ? 1 : -1 });
      broadcast({ t: 'guestBill', id: g.id, eaten: g.eaten.slice() }, ws);
      if (m.t === 'snack') broadcast({ t: 'snack', id: g.id, i: m.i });
      return;
    }
    case 'photo': {
      if (typeof m.data !== 'string' || m.data.indexOf('data:image/png;base64,') !== 0 || m.data.length > 90000) { send(ws, { t: 'error', code: 'photo' }); return; }
      if (now - l.at.photo < 4000) { send(ws, { t: 'error', code: 'slow' }); return; }
      const buf = Buffer.from(m.data.slice(22), 'base64');
      if (buf.length < 100 || buf.length > 70000 || buf.readUInt32BE(0) !== 0x89504e47) { send(ws, { t: 'error', code: 'photo' }); return; }
      l.at.photo = now;
      const id = 'p' + now.toString(36) + crypto.randomBytes(3).toString('hex');
      try { fs.writeFileSync(path.join(PHOTO_DIR, id + '.png'), buf); } catch (e) { send(ws, { t: 'error', code: 'photo' }); return; }
      const meta = { id, gid: g.id, name: g.first + ' ' + g.last, at: now, frame: Number.isInteger(m.frame) ? m.frame : 0 };
      db.photos.push(meta);
      while (db.photos.length > MAX_PHOTOS) {
        const gone = db.photos.shift();
        fs.unlink(path.join(PHOTO_DIR, gone.id + '.png'), () => { });
        broadcast({ t: 'photoGone', id: gone.id });
      }
      save();
      broadcast({ t: 'photo', photo: meta });
      return;
    }
    default:
      return;
  }
}

/* ---------- timers ---------- */
setInterval(() => {   // 10 times a second: tell everyone where the online guests are
  let any = false;
  live.forEach((l) => { if (l.moved) any = true; });
  if (!any) return;
  live.forEach((l) => { l.moved = false; });
  broadcast({ t: 'snap', p: positions() });
}, 100);

setInterval(() => {   // drop connections that went silent (a phone that lost signal)
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* closing */ }
  });
}, 25000);

/* ---------- start and stop ---------- */
server.listen(PORT, () => {
  console.log('Party server is running on port ' + PORT);
  console.log('Data folder: ' + DATA_DIR);
  console.log('Laura link:  /?vip=' + VIP_KEY);
  console.log('Bills page:  /admin?key=' + ADMIN_KEY);
  try {   // warn if the page and this file disagree about the menu
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    MENU.forEach((m) => {
      if (html.indexOf("name: '" + m[0] + "'") < 0 || html.indexOf('cents: ' + m[1]) < 0) console.warn('Menu mismatch for: ' + m[0]);
    });
  } catch (e) { console.warn('public/index.html not found'); }
});
function shutdown() { writeState(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
