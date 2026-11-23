/**
 * INFASUB — сервер входа по Gmail-коду (Node.js, без зависимостей, письма через Brevo).
 * Настройки берутся из Environment Variables на Render:
 *   BREVO_API_KEY  — API-ключ Brevo (начинается с xkeysib-)
 *   SENDER_EMAIL   — адрес отправителя, подтверждённый в Brevo
 *   SITE_URL       — адрес вашего сайта, например https://insasub.onrender.com/
 *   SENDER_NAME    — (необязательно) имя отправителя
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

/* ---------- хранилище (файл data.json) ---------- */
let db = { users: {}, codes: {}, magic: {}, fails: {}, ms: {}, sess: {}, msgs: [] };
const seen = {}; /* email -> время последней активности (в памяти) */
const SESS_TTL = 60 * 24 * 3600 * 1000;
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
function save() {
  const now = Date.now();
  for (const k in db.codes) if (db.codes[k].exp < now) delete db.codes[k];
  for (const k in db.magic) if (db.magic[k].exp < now) delete db.magic[k];
  for (const k in db.sess) if (db.sess[k].t + SESS_TTL < now) delete db.sess[k];
  if (db.msgs.length > 20000) db.msgs = db.msgs.slice(-20000);
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { console.error('save error', e.message); }
}

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
const maskEmail = (e) => { const [a, d] = e.split('@'); return a.slice(0, 2) + '***@' + d; };
const MAINS = ['inf', 'alg', 'geo', 'phy', 'che', 'bio'];
function newToken(email) {
  const t = crypto.randomBytes(24).toString('hex');
  db.sess[t] = { email, t: Date.now() };
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
      id: uid(e), name: u.name, em: maskEmail(e), main: p.main || '', av: p.av || '', school: p.school || '',
      country: p.country || '', city: p.city || '', about: p.about || '', created: u.created || 0,
      ago: seen[e] ? Math.round((now - seen[e]) / 1000) : null
    };
  });
  const msgs = db.msgs.filter((m) => m.to === myId || m.from === myId).slice(-300).map((m) => outMsg(m, ids));
  return { ok: true, me: myId, users, msgs, now };
}

function actPublicUsers() {
  const now = Date.now();
  const users = Object.keys(db.users).map((e) => {
    const u = db.users[e], p = u.p || {};
    return {
      id: uid(e), name: u.name, em: maskEmail(e), main: p.main || '', av: p.av || '', school: p.school || '',
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

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method === 'GET') return reply(res, 200, { ok: true, service: 'infasub-api' });
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'invalid' });

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
        case 'profile_save': out = actProfile(d); break;
        case 'msg_send':   out = actMsgSend(d); break;
        case 'msg_read':   out = actMsgRead(d); break;
        default:           out = { ok: false, error: 'invalid' };
      }
    } catch (e) { console.error(e); out = { ok: false, error: 'net' }; }
    reply(res, 200, out);
  });
}).listen(PORT, () => console.log('infasub-api listening on', PORT));
