/**
 * INFASUB — сервер входа по Gmail-коду (Node.js, без зависимостей, письма через Brevo).
 * Настройки берутся из Environment Variables на Render:
 *   BREVO_API_KEY  — API-ключ Brevo (начинается с xkeysib-)
 *   SENDER_EMAIL   — адрес отправителя, подтверждённый в Brevo
 *   SITE_URL       — адрес вашего сайта, например https://insasub.onrender.com/
 *   SENDER_NAME    — (необязательно) имя отправителя
 *
 * UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — (рекомендуется) постоянное хранилище, чтобы данные не пропадали при обновлении.
 *
 * ADMIN_EMAILS — Gmail-адреса администраторов через запятую (им открывается раздел «Админ»).
 *
 * Дополнительно сервер хранит профили, сообщения между пользователями и статус «в сети».
 */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const SENDER_EMAIL = process.env.SENDER_EMAIL || '';
const SENDER_NAME = process.env.SENDER_NAME || 'INFASUB';
const SITE_URL = process.env.SITE_URL || '';
const DB_FILE = process.env.DB_FILE || './data.json';

const CODE_TTL = 10 * 60 * 1000;
const LINK_TTL = 15 * 60 * 1000;
const RESEND = 60 * 1000;
const MAX_TRIES = 5;
const MAX_FAILS = 8;
const LOCK = 15 * 60 * 1000;

const T = {
  ru: {
    cs: 'Код подтверждения INFASUB',
    cb: (c) => `Ваш код подтверждения: ${c}\nОн действует 10 минут.\nЕсли вы не регистрировались — просто игнорируйте письмо.`,
    ls: 'Ссылка для входа в INFASUB',
    lb: (u) => `Нажмите, чтобы войти:\n${u}\nСсылка действует 15 минут.`
  },
  tg: {
    cs: 'Рамзи тасдиқ INFASUB',
    cb: (c) => `Рамзи тасдиқи шумо: ${c}\nОн 10 дақиқа амал мекунад.\nАгар шумо сабти ном накарда бошед, ин мактубро нодида гиред.`,
    ls: 'Истиноди воридшавӣ ба INFASUB',
    lb: (u) => `Барои ворид шудан пахш кунед:\n${u}\nИстинод 15 дақиқа амал мекунад.`
  },
  en: {
    cs: 'INFASUB confirmation code',
    cb: (c) => `Your confirmation code: ${c}\nIt is valid for 10 minutes.\nIf you did not sign up, just ignore this email.`,
    ls: 'Your INFASUB sign-in link',
    lb: (u) => `Click to sign in:\n${u}\nThe link is valid for 15 minutes.`
  }
};

/* ---------- хранилище ----------
 * По умолчанию данные лежат в файле data.json. На бесплатном Render файловая система
 * стирается при каждом обновлении сайта, поэтому для постоянного хранения подключите
 * бесплатную базу Upstash Redis: переменные UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN.
 * Тогда пользователи, сообщения, серии и результаты олимпиады больше не пропадают. */
const REST_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const USE_REST = !!(REST_URL && REST_TOKEN);
const PREFIX = process.env.DB_PREFIX || 'infasub:';
const SHARDS = ['users', 'codes', 'magic', 'fails', 'ms', 'sess', 'msgs', 'streak', 'olymp', 'prog'];
let db = { users: {}, codes: {}, magic: {}, fails: {}, ms: {}, sess: {}, msgs: [], streak: {}, olymp: {}, prog: {} };
const seen = {}; /* email -> время последней активности (в памяти) */
const SESS_TTL = 60 * 24 * 3600 * 1000;
const lastSaved = {};
let loaded = false, dirty = false, flushing = false, flushTimer = null;
const ADMINS = new Set(String(process.env.ADMIN_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(path, body) {
  const r = await fetch(REST_URL + path, { method: 'POST', headers: { Authorization: 'Bearer ' + REST_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  const items = Array.isArray(j) ? j : [j];
  const bad = items.find((x) => x && x.error);
  if (!r.ok || bad) throw new Error((bad && bad.error) || 'HTTP ' + r.status);
  return j;
}
function normalizeDb() {
  SHARDS.forEach((k) => { if (db[k] === undefined || db[k] === null) db[k] = k === 'msgs' ? [] : {}; });
}
async function loadDb() {
  let fileData = null;
  try { fileData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
  if (USE_REST) {
    for (;;) {
      try {
        const j = await rest('', ['MGET', ...SHARDS.map((k) => PREFIX + k)]);
        const vals = j.result || [];
        const remote = {};
        let any = false;
        SHARDS.forEach((k, i) => { if (vals[i]) { remote[k] = JSON.parse(vals[i]); lastSaved[k] = vals[i]; any = true; } });
        if (any) Object.assign(db, remote);
        else if (fileData) { Object.assign(db, fileData); dirty = true; console.log('перенос data.json в постоянное хранилище'); }
        break;
      } catch (e) { console.error('storage load failed, retry in 3s:', e.message); await sleep(3000); }
    }
  } else if (fileData) Object.assign(db, fileData);
  normalizeDb();
  loaded = true;
  console.log('storage:', USE_REST ? 'Upstash Redis (постоянное)' : 'файл ' + DB_FILE + ' (на бесплатном Render стирается при обновлении)', '| users:', Object.keys(db.users).length);
  if (dirty) scheduleFlush();
}
function scheduleFlush() { if (flushTimer) return; flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 400); }
async function flush() {
  if (!USE_REST || flushing || !dirty) return;
  flushing = true; dirty = false;
  try {
    const cmds = [], upd = {};
    for (const k of SHARDS) { const v = JSON.stringify(db[k]); if (lastSaved[k] !== v) { cmds.push(['SET', PREFIX + k, v]); upd[k] = v; } }
    if (cmds.length) { await rest('/pipeline', cmds); Object.assign(lastSaved, upd); }
  } catch (e) { console.error('flush failed:', e.message); dirty = true; setTimeout(scheduleFlush, 5000); }
  flushing = false;
  if (dirty && !flushTimer) scheduleFlush();
}
async function flushNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  while (flushing) await sleep(50);
  dirty = true; await flush();
}
function save() {
  const now = Date.now();
  for (const k in db.codes) if (db.codes[k].exp < now) delete db.codes[k];
  for (const k in db.magic) if (db.magic[k].exp < now) delete db.magic[k];
  for (const k in db.sess) if (db.sess[k].t + SESS_TTL < now) delete db.sess[k];
  if (db.msgs.length > 4000) db.msgs = db.msgs.slice(-4000);
  if (!loaded) return; /* пока данные не загружены, ничего не пишем: так нельзя затереть базу пустой */
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { if (!USE_REST) console.error('save error', e.message); }
  if (USE_REST) { dirty = true; scheduleFlush(); }
}
['SIGTERM', 'SIGINT'].forEach((sg) => process.on(sg, () => { flushNow().catch(() => {}).then(() => process.exit(0)); }));

const validEmail = (e) => /^[^\s@]+@gmail\.com$/.test(e) && e.length <= 80;

/* ---------- письмо через Brevo ---------- */
async function sendMail(to, subject, text) {
  if (!BREVO_API_KEY || !SENDER_EMAIL) { console.error('BREVO_API_KEY или SENDER_EMAIL не заданы'); return 'net'; }
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: SENDER_NAME, email: SENDER_EMAIL }, to: [{ email: to }], subject, textContent: text })
    });
    if (!r.ok) { console.error('Brevo error', r.status, await r.text()); return r.status === 429 ? 'quota' : 'net'; }
    return null;
  } catch (e) { console.error('Brevo fetch failed', e.message); return 'net'; }
}

/* ---------- действия ---------- */
async function actSend(email, lang) {
  if (!validEmail(email)) return { ok: false, error: 'invalid' };
  if (db.users[email]) return { ok: false, error: 'exists' };
  const now = Date.now(), prev = db.codes[email];
  if (prev && now - prev.sent < RESEND) return { ok: false, error: 'wait' };
  const code = String(crypto.randomInt(100000, 1000000));
  db.codes[email] = { code, exp: now + CODE_TTL, tries: 0, sent: now };
  const err = await sendMail(email, T[lang].cs, T[lang].cb(code));
  if (err) { delete db.codes[email]; return { ok: false, error: err }; }
  save();
  return { ok: true };
}

function actVerify(email, code, name, hash) {
  const rec = db.codes[email];
  if (!rec || Date.now() > rec.exp) return { ok: false, error: 'expired' };
  if (rec.tries >= MAX_TRIES) return { ok: false, error: 'tries' };
  if (String(code) !== rec.code) { rec.tries++; save(); return { ok: false, error: 'bad_code' }; }
  if (db.users[email]) return { ok: false, error: 'exists' };
  const nm = String(name || '').trim().slice(0, 60) || email.split('@')[0];
  db.users[email] = { name: nm, hash: String(hash || ''), created: Date.now() };
  delete db.codes[email];
  const token = newToken(email);
  save();
  return { ok: true, name: nm, token };
}

function actLogin(email, hash) {
  const now = Date.now();
  const f = db.fails[email] || { n: 0, until: 0 };
  if (f.until > now) return { ok: false, error: 'locked' };
  const u = db.users[email];
  if (!u || u.hash !== String(hash)) {
    f.n++;
    if (f.n >= MAX_FAILS) { f.n = 0; f.until = now + LOCK; }
    db.fails[email] = f; save();
    return { ok: false, error: 'bad_login' };
  }
  delete db.fails[email];
  const token = newToken(email);
  save();
  return { ok: true, name: u.name, token };
}

async function actMagicSend(email, lang) {
  if (!validEmail(email)) return { ok: false, error: 'invalid' };
  if (!db.users[email]) return { ok: false, error: 'no_user' };
  const now = Date.now(), last = db.ms[email];
  if (last && now - last < RESEND) return { ok: false, error: 'wait' };
  const token = crypto.randomBytes(32).toString('hex');
  const url = SITE_URL + (SITE_URL.includes('?') ? '&' : '?') + 'ml=' + token + '&e=' + encodeURIComponent(email);
  const err = await sendMail(email, T[lang].ls, T[lang].lb(url));
  if (err) return { ok: false, error: err };
  db.magic[token] = { email, exp: now + LINK_TTL };
  db.ms[email] = now;
  save();
  return { ok: true };
}

function actMagic(token, email) {
  const rec = token ? db.magic[token] : null;
  if (!rec || rec.email !== email || Date.now() > rec.exp) return { ok: false, error: 'bad_link' };
  delete db.magic[token];
  const u = db.users[email];
  if (!u) { save(); return { ok: false, error: 'no_user' }; }
  const tok = newToken(email);
  save();
  return { ok: true, name: u.name, token: tok };
}


/* ---------- сессии, профили, сообщения, статус «в сети» ---------- */
const uid = (email) => crypto.createHash('sha256').update('infasub:' + email).digest('hex').slice(0, 12);
const MAINS = ['inf', 'alg', 'geo', 'phy', 'che', 'bio'];
function newToken(email) {
  const t = crypto.randomBytes(24).toString('hex');
  db.sess[t] = { email, t: Date.now() };
  const mine = Object.keys(db.sess).filter((k) => db.sess[k].email === email).sort((x, y) => db.sess[x].t - db.sess[y].t);
  while (mine.length > 5) delete db.sess[mine.shift()];
  return t;
}
function authTok(d) {
  const rec = d.token ? db.sess[String(d.token)] : null;
  if (!rec || !db.users[rec.email]) return null;
  return rec.email;
}
function idMap() {
  const m = {};
  for (const e in db.users) m[uid(e)] = e;
  return m;
}
function outMsg(m, ids) {
  const nm = (id) => (ids[id] && db.users[ids[id]] ? db.users[ids[id]].name : '?');
  return { id: m.id, from: m.from, to: m.to, fromName: nm(m.from), toName: nm(m.to), text: m.text, t: m.t, read: !!m.read };
}

function actSync(d) {
  const me = authTok(d);
  if (!me) return { ok: false, error: 'auth' };
  const now = Date.now();
  seen[me] = now;
  const ids = idMap(), myId = uid(me);
  const users = Object.keys(db.users).map((e) => {
    const u = db.users[e], p = u.p || {};
    return {
      id: uid(e), name: u.name, main: p.main || '', av: p.av || '', school: p.school || '',
      country: p.country || '', city: p.city || '', about: p.about || '', created: u.created || 0,
      ago: seen[e] ? Math.round((now - seen[e]) / 1000) : null
    };
  });
  const msgs = db.msgs.filter((m) => m.to === myId || m.from === myId).slice(-300).map((m) => outMsg(m, ids));
  return { ok: true, me: myId, users, msgs, now, days: db.streak[me] || [], olymp: db.olymp[me] || null, solved: db.prog[me] || [], admin: ADMINS.has(me) };
}


/* ---------- огонёк (серия дней), таблица лидеров, олимпиада ---------- */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayNum = (k) => { const p = k.split('-'); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000); };
function streakStats(days) {
  const set = new Set(days.map(dayNum));
  const arr = [...set].sort((a, b) => a - b);
  let best = 0, run = 0, prev = null;
  arr.forEach((n) => { run = prev !== null && n - prev === 1 ? run + 1 : 1; prev = n; if (run > best) best = run; });
  const today = Math.floor(Date.now() / 86400000);
  let cur = 0;
  if (arr.length) {
    const last = arr[arr.length - 1];
    if (last >= today - 1) { cur = 1; let n = last; while (set.has(n - 1)) { cur++; n--; } }
  }
  return { cur, best, total: arr.length };
}
const OL_SUBJ = ['inf', 'alg', 'geo', 'phy', 'che', 'bio'];

function actStreakSave(d) {
  const me = authTok(d);
  if (!me) return { ok: false, error: 'auth' };
  const today = Math.floor(Date.now() / 86400000);
  const minDay = Math.floor((db.users[me].created || Date.now()) / 86400000) - 1; /* нельзя «нарисовать» дни до регистрации */
  const incoming = (Array.isArray(d.days) ? d.days : []).filter((k) => typeof k === 'string' && DAY_RE.test(k) && dayNum(k) >= minDay && dayNum(k) <= today + 1);
  const set = new Set([...(db.streak[me] || []), ...incoming]);
  db.streak[me] = [...set].sort().slice(-400);
  save();
  return { ok: true };
}

function actProgressSave(d) {
  const me = authTok(d);
  if (!me) return { ok: false, error: 'auth' };
  const ids = (Array.isArray(d.solved) ? d.solved : []).filter((x) => typeof x === 'string' && /^[a-z]\d{1,3}$/.test(x));
  const set = new Set([...(db.prog[me] || []), ...ids]);
  db.prog[me] = [...set].slice(0, 400);
  save();
  return { ok: true };
}

function actOlympJoin(d) {
  const me = authTok(d);
  if (!me) return { ok: false, error: 'auth' };
  if (!db.olymp[me]) db.olymp[me] = { joined: Date.now(), cls: String(d.cls || '').trim().slice(0, 10), res: {} };
  save();
  return { ok: true, olymp: db.olymp[me] };
}

function actOlympSubmit(d) {
  const me = authTok(d);
  if (!me) return { ok: false, error: 'auth' };
  const o = db.olymp[me];
  const subj = String(d.subj || '');
  if (!o) return { ok: false, error: 'notjoined' };
  if (!OL_SUBJ.includes(subj)) return { ok: false, error: 'invalid' };
  if (!o.res[subj]) {
    const score = Math.max(0, Math.min(20, Math.floor(Number(d.score) || 0)));
    const secs = Math.max(score * 4, Math.min(1800, Math.floor(Number(d.secs) || 0)));
    o.res[subj] = { score, secs, t: Date.now() };
    save();
  }
  return { ok: true, olymp: o };
}

function actLeaderboard() {
  const ids = {};
  const info = (e) => { const u = db.users[e], p = u.p || {}; return { id: uid(e), name: u.name, av: p.av || '', country: p.country || '' }; };
  const streak = Object.keys(db.users).map((e) => ({ ...info(e), ...streakStats(db.streak[e] || []) }))
    .filter((x) => x.total > 0)
    .sort((a, b) => b.cur - a.cur || b.best - a.best || b.total - a.total)
    .slice(0, 100);
  const olymp = Object.keys(db.olymp).filter((e) => db.users[e]).map((e) => {
    const o = db.olymp[e]; let total = 0, secs = 0;
    Object.keys(o.res || {}).forEach((k) => { total += o.res[k].score; secs += o.res[k].secs; });
    return { ...info(e), cls: o.cls || '', joined: o.joined || 0, res: o.res || {}, total, secs };
  }).sort((a, b) => b.total - a.total || a.secs - b.secs).slice(0, 300);
  return { ok: true, streak, olymp, now: Date.now() };
}

/* ---------- администратор (ADMIN_EMAILS) ---------- */
function adminTok(d) {
  const me = authTok(d);
  return me && ADMINS.has(me) ? me : null;
}
function cleanProfile(p, old) {
  const cut = (v, n) => String(v || '').trim().slice(0, n);
  return {
    main: MAINS.includes(p.main) ? p.main : '',
    av: /^[a-z]+:\d$/.test(String(p.av || old.av || '')) ? String(p.av || old.av || '') : '',
    school: cut(p.school, 60), country: cut(p.country, 40), city: cut(p.city, 40), about: cut(p.about, 200)
  };
}
function actAdminUsers(d) {
  const me = adminTok(d);
  if (!me) return { ok: false, error: 'admin' };
  const now = Date.now();
  const users = Object.keys(db.users).map((e) => {
    const u = db.users[e], p = u.p || {}, o = db.olymp[e];
    let pts = 0, cnt = 0;
    if (o) Object.keys(o.res || {}).forEach((k) => { pts += o.res[k].score; cnt++; });
    const st = streakStats(db.streak[e] || []);
    return {
      id: uid(e), email: e, name: u.name, adm: ADMINS.has(e), av: p.av || '', main: p.main || '', school: p.school || '',
      country: p.country || '', city: p.city || '', about: p.about || '', created: u.created || 0,
      ago: seen[e] ? Math.round((now - seen[e]) / 1000) : null,
      olymp: o ? { joined: true, pts, cnt, cls: o.cls || '' } : null, streak: st.cur, days: st.total, solved: (db.prog[e] || []).length
    };
  });
  return { ok: true, users, now };
}
function adminTarget(d) {
  const ids = idMap(), e = ids[String(d.target || '')];
  return e && db.users[e] ? e : null;
}
function actAdminUpdate(d) {
  const me = adminTok(d);
  if (!me) return { ok: false, error: 'admin' };
  const e = adminTarget(d);
  if (!e) return { ok: false, error: 'invalid' };
  const p = d.profile || {}, u = db.users[e];
  const nm = String(p.name || '').trim().slice(0, 60);
  if (nm.length >= 2) u.name = nm;
  u.p = cleanProfile(p, u.p || {});
  save();
  return { ok: true };
}
function actAdminDelete(d) {
  const me = adminTok(d);
  if (!me) return { ok: false, error: 'admin' };
  const e = adminTarget(d);
  if (!e) return { ok: false, error: 'invalid' };
  if (e === me) return { ok: false, error: 'self' };
  const id = uid(e);
  delete db.users[e]; delete db.streak[e]; delete db.olymp[e]; delete db.prog[e]; delete seen[e];
  for (const k in db.sess) if (db.sess[k].email === e) delete db.sess[k];
  db.msgs = db.msgs.filter((m) => m.from !== id && m.to !== id);
  save();
  return { ok: true };
}
function actAdminReset(d) {
  const me = adminTok(d);
  if (!me) return { ok: false, error: 'admin' };
  const e = adminTarget(d);
  if (!e) return { ok: false, error: 'invalid' };
  const kind = String(d.kind || '');
  if (kind === 'olymp') delete db.olymp[e];
  else if (kind === 'streak') delete db.streak[e];
  else if (kind === 'progress') delete db.prog[e];
  else return { ok: false, error: 'invalid' };
  save();
  return { ok: true };
}

function actPublicUsers() {
  const now = Date.now();
  const users = Object.keys(db.users).map((e) => {
    const u = db.users[e], p = u.p || {};
    return {
      id: uid(e), name: u.name, main: p.main || '', av: p.av || '', school: p.school || '',
      country: p.country || '', city: p.city || '', created: u.created || 0,
      ago: seen[e] ? Math.round((now - seen[e]) / 1000) : null
    };
  });
  return { ok: true, users, now };
}

function actProfile(d) {
  const me = authTok(d);
  if (!me) return { ok: false, error: 'auth' };
  const p = d.profile || {}, cut = (v, n) => String(v || '').trim().slice(0, n);
  const u = db.users[me];
  const nm = cut(p.name, 60);
  if (nm.length >= 2) u.name = nm;
  u.p = {
    main: MAINS.includes(p.main) ? p.main : '',
    av: /^[a-z]+:\d$/.test(String(p.av || '')) ? String(p.av) : '',
    school: cut(p.school, 60), country: cut(p.country, 40), city: cut(p.city, 40), about: cut(p.about, 200)
  };
  save();
  return { ok: true };
}

function actMsgSend(d) {
  const me = authTok(d);
  if (!me) return { ok: false, error: 'auth' };
  const ids = idMap(), myId = uid(me), to = String(d.to || '');
  const text = String(d.text || '').trim().slice(0, 500);
  if (!ids[to] || to === myId || !text) return { ok: false, error: 'invalid' };
  const now = Date.now();
  if (db.msgs.filter((m) => m.from === myId && now - m.t < 60000).length >= 10) return { ok: false, error: 'wait' };
  const m = { id: crypto.randomBytes(6).toString('hex'), from: myId, to, text, t: now, read: false };
  db.msgs.push(m);
  save();
  return { ok: true, msg: outMsg(m, ids) };
}

function actMsgRead(d) {
  const me = authTok(d);
  if (!me) return { ok: false, error: 'auth' };
  const myId = uid(me);
  let ch = false;
  db.msgs.forEach((m) => { if (m.to === myId && !m.read) { m.read = true; ch = true; } });
  if (ch) save();
  return { ok: true };
}

/* ---------- HTTP ---------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function reply(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS));
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method === 'GET') return reply(res, 200, { ok: true, service: 'infasub-api', storage: USE_REST ? 'remote' : 'file', ready: loaded });
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'invalid' });
  if (!loaded) return reply(res, 200, { ok: false, error: 'net' });

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 40000) req.destroy(); });
  req.on('end', async () => {
    let out;
    try {
      const d = JSON.parse(body || '{}');
      const email = String(d.email || '').trim().toLowerCase();
      const lang = T[d.lang] ? d.lang : 'ru';
      switch (d.action) {
        case 'send':       out = await actSend(email, lang); break;
        case 'verify':     out = actVerify(email, d.code, d.name, d.hash); break;
        case 'login':      out = actLogin(email, d.hash); break;
        case 'magic_send': out = await actMagicSend(email, lang); break;
        case 'magic':      out = actMagic(d.token, email); break;
        case 'sync':       out = actSync(d); break;
        case 'public_users': out = actPublicUsers(); break;
        case 'streak_save': out = actStreakSave(d); break;
        case 'progress_save': out = actProgressSave(d); break;
        case 'admin_users': out = actAdminUsers(d); break;
        case 'admin_update': out = actAdminUpdate(d); break;
        case 'admin_delete': out = actAdminDelete(d); break;
        case 'admin_reset': out = actAdminReset(d); break;
        case 'leaderboard': out = actLeaderboard(); break;
        case 'olymp_join': out = actOlympJoin(d); break;
        case 'olymp_submit': out = actOlympSubmit(d); break;
        case 'profile_save': out = actProfile(d); break;
        case 'msg_send':   out = actMsgSend(d); break;
        case 'msg_read':   out = actMsgRead(d); break;
        default:           out = { ok: false, error: 'invalid' };
      }
    } catch (e) { console.error(e); out = { ok: false, error: 'net' }; }
    reply(res, 200, out);
  });
});
server.listen(PORT, () => console.log('infasub-api listening on', PORT));
loadDb();
