/**
 * Вход по номеру телефона + PIN (без SMS). Маршруты /api/phone/*.
 *
 * Клиент присылает номер и proof = PBKDF2(PIN, соль из номера). Личный ключ человека лежит на
 * сервере только зашифрованным (AES-GCM, ключ из proof): без PIN сервер его не прочтёт.
 * Номер в базе не хранится: ключ записи = HMAC(pepper, номер).
 * В логи не попадают ни номер, ни proof, ни ключ, ни токены.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BODY = 4 * 1024;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const IP_LIMIT = 20;
const IP_WINDOW_MS = 10 * 60 * 1000;
const WHOAMI_TIMEOUT_MS = 5000;

const PROOF_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^[0-9a-f]{32}$/;
const USER_RE = /^[a-z0-9][a-z0-9._=-]{0,63}$/;

export function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  let d = input.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  else if (d.length === 10) d = '7' + d;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

export function maskPhone(phone) {
  if (phone.length === 11 && phone[0] === '7') return `+7 *** ***-**-${phone.slice(-2)}`;
  return `+${'*'.repeat(phone.length - 2)}${phone.slice(-2)}`;
}

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqualHex(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function blobKey(proof) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(proof, 'utf8'), Buffer.alloc(0), 'blob', 32));
}

function encryptBlob(proof, payload) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', blobKey(proof), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

function decryptBlob(proof, blob) {
  const d = crypto.createDecipheriv('aes-256-gcm', blobKey(proof), Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const pt = Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]);
  return JSON.parse(pt.toString('utf8'));
}

export function createPhoneApi({ dbPath, homeserverUrl, log }) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const pepper = (() => {
    if (process.env.PHONE_PEPPER) return Buffer.from(process.env.PHONE_PEPPER, 'utf8');
    const file = path.join(dir, 'pepper');
    try {
      return fs.readFileSync(file);
    } catch {
      const p = crypto.randomBytes(32);
      fs.writeFileSync(file, p, { mode: 0o600 });
      return p;
    }
  })();

  let db = {};
  try {
    db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const save = () => {
    const tmp = `${dbPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, dbPath);
  };

  const recordKey = (phone) => crypto.createHmac('sha256', pepper).update(phone).digest('hex');
  const findByUser = (user) => Object.keys(db).find((k) => db[k].user === user);

  // для неизвестного номера делаем ту же работу, что и для известного
  const dummyCheck = sha256hex('check\n' + 'f'.repeat(64));

  const ipHits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - IP_WINDOW_MS;
    for (const [ip, list] of ipHits) {
      const fresh = list.filter((t) => t > cutoff);
      if (fresh.length) ipHits.set(ip, fresh);
      else ipHits.delete(ip);
    }
  }, 60_000).unref();

  function ipAllowed(ip) {
    const now = Date.now();
    const list = (ipHits.get(ip) ?? []).filter((t) => t > now - IP_WINDOW_MS);
    list.push(now);
    ipHits.set(ip, list);
    return list.length <= IP_LIMIT;
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
          resolve(v);
        } catch {
          reject(Object.assign(new Error('bad json'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  /** Логин (localpart) владельца токена или null. */
  async function whoami(req) {
    const m = /^Bearer\s+(\S{1,512})$/.exec(req.headers.authorization ?? '');
    if (!m) return null;
    let r;
    try {
      r = await fetch(`${homeserverUrl}/_matrix/client/v3/account/whoami`, {
        headers: { authorization: `Bearer ${m[1]}` },
        signal: AbortSignal.timeout(WHOAMI_TIMEOUT_MS),
      });
    } catch {
      throw Object.assign(new Error('homeserver unavailable'), { status: 502 });
    }
    if (!r.ok) return null;
    const id = (await r.json().catch(() => null))?.user_id;
    if (typeof id !== 'string') return null;
    const user = id.replace(/^@/, '').split(':')[0];
    return USER_RE.test(user) ? user : null;
  }

  function clientIp(req) {
    const h = req.headers['x-real-ip'];
    return (typeof h === 'string' && h.trim()) || req.socket.remoteAddress || 'unknown';
  }

  async function bind(req, res) {
    const user = await whoami(req);
    if (!user) return send(res, 401, { error: 'Нужен вход' });
    const body = await readBody(req);
    const phone = normalizePhone(body.phone);
    if (!phone) return send(res, 400, { error: 'Проверьте номер' });
    if (typeof body.proof !== 'string' || !PROOF_RE.test(body.proof)) return send(res, 400, { error: 'Неверный запрос' });
    if (typeof body.key !== 'string' || !KEY_RE.test(body.key)) return send(res, 400, { error: 'Неверный запрос' });
    let name;
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.length > 80) return send(res, 400, { error: 'Неверный запрос' });
      name = body.name;
    }

    const key = recordKey(phone);
    if (db[key] && db[key].user !== user) {
      return send(res, 409, { error: 'Этот номер уже привязан к другому человеку' });
    }
    const old = findByUser(user);
    if (old && old !== key) delete db[old];
    const mask = maskPhone(phone);
    db[key] = {
      user,
      mask,
      check: sha256hex('check\n' + body.proof),
      blob: encryptBlob(body.proof, { user, key: body.key, ...(name ? { name } : {}) }),
      fails: 0,
      lockedUntil: 0,
      createdAt: Date.now(),
    };
    save();
    log('info', 'phone bound');
    send(res, 200, { mask });
  }

  async function login(req, res) {
    if (!ipAllowed(clientIp(req))) {
      return send(res, 429, { error: 'Слишком много попыток, попробуйте через 15 минут' });
    }
    const body = await readBody(req);
    const phone = normalizePhone(body.phone);
    if (!phone || typeof body.proof !== 'string' || !PROOF_RE.test(body.proof)) {
      return send(res, 401, { error: 'Неверный номер или PIN' });
    }
    const key = recordKey(phone);
    const rec = db[key];
    const now = Date.now();
    if (rec && rec.lockedUntil > now) {
      return send(res, 429, { error: 'Слишком много попыток, попробуйте через 15 минут' });
    }
    const match = safeEqualHex(sha256hex('check\n' + body.proof), rec ? rec.check : dummyCheck);
    if (!rec || !match) {
      if (rec) {
        rec.fails = (rec.fails ?? 0) + 1;
        if (rec.fails >= MAX_FAILS) {
          rec.fails = 0;
          rec.lockedUntil = now + LOCK_MS;
          save();
          log('warn', 'phone record locked');
          return send(res, 429, { error: 'Слишком много попыток, попробуйте через 15 минут' });
        }
        save();
      }
      return send(res, 401, { error: 'Неверный номер или PIN' });
    }
    let payload;
    try {
      payload = decryptBlob(body.proof, rec.blob);
    } catch {
      return send(res, 401, { error: 'Неверный номер или PIN' });
    }
    if (rec.fails) {
      rec.fails = 0;
      save();
    }
    send(res, 200, payload);
  }

  async function status(req, res) {
    const user = await whoami(req);
    if (!user) return send(res, 401, { error: 'Нужен вход' });
    const k = findByUser(user);
    if (req.method === 'GET') return send(res, 200, { mask: k ? db[k].mask : null });
    if (k) {
      delete db[k];
      save();
    }
    send(res, 200, { mask: null });
  }

  /** true — маршрут обработан. */
  return async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/phone/')) return false;
    try {
      if (url.pathname === '/api/phone/bind' && req.method === 'PUT') await bind(req, res);
      else if (url.pathname === '/api/phone/bind' && (req.method === 'GET' || req.method === 'DELETE')) await status(req, res);
      else if (url.pathname === '/api/phone/login' && req.method === 'POST') await login(req, res);
      else send(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'server error' });
      if (!e.status) log('error', 'phone route failed', { err: String(e?.message).slice(0, 100) });
    }
    return true;
  };
}
