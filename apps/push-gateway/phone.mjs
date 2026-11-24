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
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_MAX_ACTIVE = 5;
const INVITE_MAX_PER_DAY = 10;

const PROOF_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^[0-9a-f]{32}$/;
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const USER_RE = /^[a-z0-9][a-z0-9._=-]{0,63}$/;
const LOGIN_ID = 'login:';

export function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  let d = input.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  else if (d.length === 10) d = '7' + d;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

/** Ник Minecraft как логин: латиница, цифры, _, 3–16 символов, без регистра. */
export function normalizeLogin(input) {
  if (typeof input !== 'string') return null;
  const v = input.trim();
  return /^[A-Za-z0-9_]{3,16}$/.test(v) ? v.toLowerCase() : null;
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

/**
 * mode 'phone' — записи по номеру (семья), 'login' — по нику (Minecraft, плюс регистрация игроков).
 * prefix — путь API, registrationToken — секрет регистрации на сервере Minecraft (только здесь, не в браузере).
 */
export function createPhoneApi({ dbPath, homeserverUrl, log, mode = 'phone', prefix = '/api/phone/', registrationToken = '', regLimit = 5, regWindowMs = 60 * 60 * 1000, invitesPrefix }) {
  const byLogin = mode === 'login';
  const ident = (body) => {
    if (byLogin) return normalizeLogin(body.login);
    if (body.phone !== undefined) return normalizePhone(body.phone);
    const login = typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
    return USER_RE.test(login) ? LOGIN_ID + login : null;
  };
  const maskOf = (id, body) => {
    if (byLogin) return typeof body.name === 'string' && normalizeLogin(body.name) === id ? body.name : id;
    if (id.startsWith(LOGIN_ID)) return typeof body.name === 'string' && body.name.length <= 80 ? body.name : id.slice(LOGIN_ID.length);
    return maskPhone(id);
  };
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
  const findByUser = (user) => Object.keys(db).find((k) => !k.startsWith('invite:') && db[k].user === user);

  const invitePath = invitesPrefix ?? (byLogin ? '/mc/api/invites/' : '/api/invites/');
  const inviteKey = (token) => `invite:${token}`;
  const inviteRecords = () => Object.entries(db).filter(([k, r]) => k.startsWith('invite:') && r && INVITE_CODE_RE.test(r.token));
  const guestRecord = (user) => {
    const k = findByUser(user);
    if (k && db[k].guest === true) return db[k];
    // гостем делает ссылка, а не отметка браузера: не дошедший claim не превращает гостя в участника
    const inv = inviteRecords().find(([, r]) => r.user === user && !r.revokedAt && !r.promotedAt && !r.usedAt);
    return inv ? inv[1] : null;
  };

  function pruneInvites(now = Date.now()) {
    let changed = false;
    for (const [k, r] of inviteRecords()) {
      if (typeof r.createdAt !== 'number' || now - r.createdAt >= INVITE_TTL_MS) {
        delete db[k];
        changed = true;
      }
    }
    return changed;
  }

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
  async function whoamiInfo(req) {
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
    const userId = (await r.json().catch(() => null))?.user_id;
    if (typeof userId !== 'string') return null;
    const user = userId.replace(/^@/, '').split(':')[0];
    if (!USER_RE.test(user)) return null;
    return { user, userId, token: m[1] };
  }

  const whoami = async (req) => (await whoamiInfo(req))?.user ?? null;

  function clientIp(req) {
    const h = req.headers['x-real-ip'];
    return (typeof h === 'string' && h.trim()) || req.socket.remoteAddress || 'unknown';
  }

  async function bind(req, res) {
    const user = await whoami(req);
    if (!user) return send(res, 401, { error: 'Нужен вход' });
    const body = await readBody(req);
    const phone = ident(body);
    if (!phone) return send(res, 400, { error: byLogin ? 'Проверьте ник' : 'Проверьте номер или логин' });
    if ((byLogin || phone.startsWith(LOGIN_ID)) && (phone.startsWith(LOGIN_ID) ? phone.slice(LOGIN_ID.length) : phone) !== user) {
      return send(res, 400, { error: byLogin ? 'Логин — это ваш ник' : 'Логин — это ваш логин' });
    }
    if (typeof body.proof !== 'string' || !PROOF_RE.test(body.proof)) return send(res, 400, { error: 'Неверный запрос' });
    if (typeof body.key !== 'string' || !KEY_RE.test(body.key)) return send(res, 400, { error: 'Неверный запрос' });
    let name;
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.length > 80) return send(res, 400, { error: 'Неверный запрос' });
      name = body.name;
    }

    const key = recordKey(phone);
    if (db[key] && db[key].user !== user) {
      return send(res, 409, { error: byLogin ? 'Этот ник уже занят' : 'Этот номер уже привязан к другому человеку' });
    }
    const old = findByUser(user);
    const oldRec = old ? db[old] : undefined;
    if (old && old !== key) delete db[old];
    const mask = maskOf(phone, body);
    const keep = { ...pickLinks(db[key]), ...pickLinks(oldRec) };
    db[key] = {
      ...keep,
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

  /** Связь семья ↔ Minecraft: у записи семьи `mc` (ник) и `mcAllowed`, у записи игрока `family` (логин). */
  const pickLinks = (rec) => {
    const out = {};
    if (rec?.mc) out.mc = rec.mc;
    if (rec?.mcAllowed) out.mcAllowed = true;
    if (rec?.family) out.family = rec.family;
    if (rec?.guest) out.guest = true;
    if (rec?.invitedBy) out.invitedBy = rec.invitedBy;
    if (rec?.inviteName) out.inviteName = rec.inviteName;
    return out;
  };
  const linkedOf = (rec) =>
    rec.mc ? { linked: { realm: 'mc', user: rec.mc } } : rec.family ? { linked: { realm: 'family', user: rec.family } } : {};
  /** Записи другого мира (задаётся из server.mjs: семья видит базу Minecraft). */
  let peer = null;
  function unlinkRecord(rec) {
    if (!rec) return;
    if (rec.mc && peer) peer.clearFamily(rec.mc, rec.user);
    if (rec.family && peer) peer.clearMc(rec.family, rec.user);
    delete rec.mc;
    delete rec.family;
  }

  /** Блокировки входа по номеру: в памяти, по ключу номера (есть он в базе или нет). */
  const locks = new Map();

  /** Проверка proof с тем же счётчиком ошибок, что у входа. 'locked' | null | запись. */
  function checkProof(id, proof, lockMap = locks, lockKey = recordKey(id)) {
    const key = recordKey(id);
    const rec = db[key];
    const now = Date.now();
    const st = lockMap.get(lockKey);
    // кривой запрос — не попытка PIN
    if (typeof proof !== 'string' || !PROOF_RE.test(proof)) return st && st.until > now ? 'locked' : null;
    if (st && st.until > now) return 'locked';
    const ok = safeEqualHex(sha256hex('check\n' + proof), rec ? rec.check : dummyCheck);
    if (rec && ok) {
      lockMap.delete(lockKey);
      return rec;
    }
    const next = st && st.until <= now && st.until !== 0 ? { fails: 0, until: 0 } : (st ?? { fails: 0, until: 0 });
    next.fails += 1;
    if (next.fails >= MAX_FAILS) {
      next.fails = 0;
      next.until = now + LOCK_MS;
    }
    lockMap.set(lockKey, next);
    return next.until > now ? 'locked' : null;
  }
  /** Подбор PIN ника через связку считается отдельно (по тому, кто связывает): вход игрока им не блокируется. */
  const linkLocks = new Map();

  async function login(req, res) {
    if (!ipAllowed(clientIp(req))) {
      return send(res, 429, { error: 'Слишком много попыток, попробуйте через 15 минут' });
    }
    const body = await readBody(req);
    const phone = ident(body);
    const wrong = byLogin ? 'Неверный ник или PIN' : 'Неверный номер или PIN';
    if (!phone || typeof body.proof !== 'string' || !PROOF_RE.test(body.proof)) {
      return send(res, 401, { error: wrong });
    }
    const key = recordKey(phone);
    const rec = db[key];
    const now = Date.now();
    // Счётчик ошибок ведём для любого номера, есть он в базе или нет:
    // иначе по 429 можно было бы узнать, какие номера зарегистрированы.
    const st = locks.get(key);
    if (st && st.until > now) {
      return send(res, 429, { error: 'Слишком много попыток, попробуйте через 15 минут' });
    }
    const match = safeEqualHex(sha256hex('check\n' + body.proof), rec ? rec.check : dummyCheck);
    if (!rec || !match) {
      const next = st && st.until <= now && st.until !== 0 ? { fails: 0, until: 0 } : (st ?? { fails: 0, until: 0 });
      next.fails += 1;
      if (next.fails >= MAX_FAILS) {
        next.fails = 0;
        next.until = now + LOCK_MS;
        log('warn', 'phone login locked');
      }
      if (locks.size > 10000) for (const [k, v] of locks) if (v.until <= now) locks.delete(k);
      locks.set(key, next);
      if (next.until > now) return send(res, 429, { error: 'Слишком много попыток, попробуйте через 15 минут' });
      return send(res, 401, { error: wrong });
    }
    locks.delete(key);
    let payload;
    try {
      payload = decryptBlob(body.proof, rec.blob);
    } catch {
      return send(res, 401, { error: wrong });
    }
    if (rec.fails) {
      rec.fails = 0;
      save();
    }
    send(res, 200, { ...payload, ...linkedOf(rec) });
  }

  async function status(req, res) {
    const user = await whoami(req);
    if (!user) return send(res, 401, { error: 'Нужен вход' });
    const k = findByUser(user);
    if (req.method === 'GET') {
      const rec = k ? db[k] : null;
      return send(res, 200, {
        mask: rec ? rec.mask : null,
        ...(byLogin ? { family: rec?.family ?? null } : { mc: rec?.mc ?? null, mcAllowed: !!rec?.mcAllowed || admins.has(user) }),
      });
    }
    if (k) unlinkRecord(db[k]);
    if (k) {
      delete db[k];
      save();
    }
    send(res, 200, { mask: null });
  }

  /** Регистрация игрока (только в режиме ника): аккаунт создаёт сервер, секрет регистрации в браузер не уходит. */
  const regHits = new Map();
  async function hs(path, method, body, token) {
    let r;
    try {
      r = await fetch(`${homeserverUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw Object.assign(new Error('Сервер чата недоступен, попробуйте позже'), { status: 502 });
    }
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }

  function regAllowed(ip) {
    const now = Date.now();
    const hits = (regHits.get(ip) ?? []).filter((t) => t > now - regWindowMs);
    if (hits.length >= regLimit) return false;
    hits.push(now);
    regHits.set(ip, hits);
    return true;
  }

  /** Создание аккаунта на homeserver с секретом регистрации, который знает только шлюз. */
  async function createMatrixAccount(login, name, password) {
    const reqBody = { username: login, password, initial_device_display_name: 'Redline: регистрация' };
    let r = await hs('/_matrix/client/v3/register', 'POST', reqBody);
    for (let i = 0; i < 3 && r.status === 401 && r.data.session; i++) {
      const done = new Set(r.data.completed ?? []);
      const flow = (r.data.flows ?? []).find((f) => f.stages?.includes('m.login.registration_token')) ?? r.data.flows?.[0];
      const stage = flow?.stages?.find((st) => !done.has(st));
      if (!stage) break;
      const auth = stage === 'm.login.registration_token'
        ? { type: stage, token: registrationToken, session: r.data.session }
        : { type: stage, session: r.data.session };
      r = await hs('/_matrix/client/v3/register', 'POST', { ...reqBody, auth });
    }
    if (r.data.errcode === 'M_USER_IN_USE') return { error: 'taken' };
    if (r.status !== 200 || !r.data.access_token) return { error: 'failed', status: r.status, errcode: r.data.errcode };
    return { session: r.data };
  }

  async function register(req, res) {
    if (!byLogin || !registrationToken) return send(res, 404, { error: 'not found' });
    if (!regAllowed(clientIp(req))) return send(res, 429, { error: 'Слишком много регистраций, попробуйте позже' });
    const body = await readBody(req);
    const login = normalizeLogin(body.login);
    if (!login || typeof body.name !== 'string' || normalizeLogin(body.name) !== login) {
      return send(res, 400, { error: 'Ник: латиница, цифры и _, от 3 до 16 символов' });
    }
    if (typeof body.password !== 'string' || !PROOF_RE.test(body.password)) return send(res, 400, { error: 'Неверный запрос' });
    if (typeof body.proof !== 'string' || !PROOF_RE.test(body.proof)) return send(res, 400, { error: 'Неверный запрос' });
    if (typeof body.key !== 'string' || !KEY_RE.test(body.key)) return send(res, 400, { error: 'Неверный запрос' });
    const rk = recordKey(login);
    if (db[rk]) return send(res, 409, { error: 'Этот ник уже занят' });
    const result = await createMatrixAccount(login, body.name, body.password);
    if (result.error === 'taken') return send(res, 409, { error: 'Этот ник уже занят' });
    if (result.error) {
      log('warn', 'mc register failed', { status: result.status, errcode: result.errcode });
      return send(res, 502, { error: 'Не удалось зарегистрироваться, попробуйте позже' });
    }
    const token = result.session.access_token;
    const server = String(result.session.user_id).split(':')[1];
    try {
      await hs(`/_matrix/client/v3/profile/${encodeURIComponent(result.session.user_id)}/displayname`, 'PUT', { displayname: body.name }, token);
      // общая группа игроков: есть — входим, нет — создаём (первый игрок становится её владельцем)
      const alias = encodeURIComponent(`#minecraft:${server}`);
      const found = await hs(`/_matrix/client/v3/directory/room/${alias}`, 'GET', undefined, token);
      if (found.status === 200) await hs(`/_matrix/client/v3/join/${alias}`, 'POST', {}, token);
      else await hs('/_matrix/client/v3/createRoom', 'POST', { name: 'Minecraft', room_alias_name: 'minecraft', preset: 'public_chat', visibility: 'private' }, token);
    } catch (e) {
      log('warn', 'mc register: profile/group step failed', { err: String(e?.message).slice(0, 80) });
    } finally {
      await hs('/_matrix/client/v3/logout', 'POST', {}, token).catch(() => undefined);
    }
    db[rk] = {
      user: login,
      mask: body.name,
      check: sha256hex('check\n' + body.proof),
      blob: encryptBlob(body.proof, { user: login, key: body.key, name: body.name }),
      fails: 0,
      lockedUntil: 0,
      createdAt: Date.now(),
    };
    save();
    log('info', 'mc player registered');
    send(res, 200, { ok: true });
  }

  const admins = new Set(
    (process.env.PHONE_ADMINS ?? 'admin').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
  );

  /** Администратор удаляет привязку чужого номера (человека удалили из Redline). */
  async function adminRemove(req, res, mxid) {
    const caller = await whoami(req);
    if (!caller) return send(res, 401, { error: 'Нужен вход' });
    if (!admins.has(caller)) return send(res, 403, { error: 'Нет прав' });
    const target = mxid.replace(/^@/, '').split(':')[0];
    if (!USER_RE.test(target)) return send(res, 400, { error: 'Неверный запрос' });
    const k = findByUser(target);
    if (k) {
      unlinkRecord(db[k]);
      delete db[k];
      save();
      log('info', 'phone removed by admin');
    }
    send(res, 200, { removed: !!k });
  }

  /**
   * Семья: подключить ник Minecraft к своему аккаунту. Ник доказывается старым proof, дальше запись
   * игрока переписывается под ключ и PIN семьи (пароль Matrix клиент уже сменил сам).
   */
  async function link(req, res) {
    if (byLogin || !peer) return send(res, 404, { error: 'not found' });
    const caller = await whoami(req);
    if (!caller) return send(res, 401, { error: 'Нужен вход' });
    const fk = findByUser(caller);
    if (!fk) return send(res, 409, { error: 'Сначала привяжите номер телефона' });
    const fam = db[fk];
    if (req.method === 'DELETE') {
      unlinkRecord(fam);
      save();
      log('info', 'mc unlinked');
      return send(res, 200, { mc: null });
    }
    if (!fam.mcAllowed && !admins.has(caller)) return send(res, 403, { error: 'Minecraft вам не открыт' });
    if (!ipAllowed(clientIp(req))) return send(res, 429, { error: 'Слишком много попыток, попробуйте через 15 минут' });
    const body = await readBody(req);
    const login = normalizeLogin(body.login);
    if (!login) return send(res, 400, { error: 'Ник: латиница, цифры и _, от 3 до 16 символов' });
    if (typeof body.proof !== 'string' || !PROOF_RE.test(body.proof)) return send(res, 400, { error: 'Неверный запрос' });
    if (typeof body.key !== 'string' || !KEY_RE.test(body.key)) return send(res, 400, { error: 'Неверный запрос' });
    // за время await запись могла смениться (перепривязка номера)
    const fk2 = findByUser(caller);
    if (!fk2) return send(res, 409, { error: 'Сначала привяжите номер телефона' });
    const fam2 = db[fk2];
    const r = peer.relink(login, body.oldProof, body.proof, body.key, caller);
    if (r === 'locked') return send(res, 429, { error: 'Слишком много попыток, попробуйте через 15 минут' });
    if (r === 'taken') return send(res, 409, { error: 'Этот ник уже связан с другим человеком' });
    if (r !== 'ok') return send(res, 401, { error: 'Неверный ник или PIN' });
    if (fam2.mc && fam2.mc !== login) peer.clearFamily(fam2.mc, caller);
    fam2.mc = login;
    save();
    log('info', 'mc linked');
    send(res, 200, { mc: login });
  }

  /** Админ: роли людей (Minecraft открыт или нет) и их ники. */
  async function roles(req, res) {
    if (byLogin) return send(res, 404, { error: 'not found' });
    const caller = await whoami(req);
    if (!caller) return send(res, 401, { error: 'Нужен вход' });
    if (!admins.has(caller)) return send(res, 403, { error: 'Нет прав' });
    if (req.method === 'GET') {
      return send(res, 200, {
        users: Object.entries(db)
          .filter(([k, r]) => !k.startsWith('invite:') && typeof r.user === 'string')
          .map(([, r]) => ({ user: r.user, mc: r.mc ?? null, mcAllowed: !!r.mcAllowed || admins.has(r.user) })),
      });
    }
    const body = await readBody(req);
    const target = typeof body.user === 'string' ? body.user.replace(/^@/, '').split(':')[0] : '';
    if (!USER_RE.test(target) || typeof body.mc !== 'boolean') return send(res, 400, { error: 'Неверный запрос' });
    const k = findByUser(target);
    if (!k) return send(res, 404, { error: 'У человека нет входа по номеру' });
    if (body.mc) db[k].mcAllowed = true;
    else {
      delete db[k].mcAllowed;
      unlinkRecord(db[k]);
    }
    save();
    send(res, 200, { user: target, mc: db[k].mc ?? null, mcAllowed: !!db[k].mcAllowed });
  }

  function guestRows() {
    return Object.entries(db)
      .filter(([k, r]) => !k.startsWith('invite:') && r && r.guest === true && typeof r.user === 'string')
      .map(([, r]) => ({
        user: r.user,
        invitedBy: r.invitedBy ?? '',
        inviteName: r.inviteName ?? '',
        createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
      }));
  }

  async function invitesList(req, res) {
    const caller = await whoami(req);
    if (!caller) return send(res, 401, { error: 'Нужен вход' });
    if (pruneInvites()) save();
    const admin = admins.has(caller);
    const invites = inviteRecords()
      .filter(([, r]) => (admin || r.invitedBy === caller) && !r.claimedAt && !r.revokedAt && !r.usedAt)
      .map(([, r]) => ({
        token: r.token,
        label: r.label ?? '',
        user: r.user ?? '',
        invitedBy: r.invitedBy,
        createdAt: r.createdAt,
        expiresAt: r.createdAt + INVITE_TTL_MS,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
    send(res, 200, { invites, guests: admin ? guestRows() : [], guest: !!guestRecord(caller) });
  }

  async function guestsList(req, res) {
    const caller = await whoami(req);
    if (!caller) return send(res, 401, { error: 'Нужен вход' });
    if (!admins.has(caller)) return send(res, 403, { error: 'Нет прав' });
    send(res, 200, { guests: guestRows() });
  }

  async function invitesCreate(req, res) {
    const me = await whoamiInfo(req);
    if (!me) return send(res, 401, { error: 'Нужен вход' });
    if (guestRecord(me.user)) return send(res, 403, { error: 'Гость не может приглашать' });
    const body = await readBody(req);
    const label = typeof body.name === 'string' ? body.name.trim() : '';
    const user = typeof body.user === 'string' ? body.user : '';
    if (!label || label.length > 80 || !USER_RE.test(user)) return send(res, 400, { error: 'Неверный запрос' });
    if (pruneInvites()) save();
    const now = Date.now();
    const mine = inviteRecords().filter(([, r]) => r.invitedBy === me.user);
    if (mine.filter(([, r]) => now - r.createdAt < 24 * 60 * 60 * 1000).length >= INVITE_MAX_PER_DAY) {
      return send(res, 429, { error: 'Дневной лимит приглашений исчерпан. Попробуйте завтра' });
    }
    if (mine.filter(([, r]) => !r.claimedAt && !r.revokedAt && !r.usedAt).length >= INVITE_MAX_ACTIVE) {
      return send(res, 429, { error: 'Можно пригласить не больше пяти человек. Отзовите старую ссылку' });
    }
    let invitedByName = me.user;
    const profile = await hs(`/_matrix/client/v3/profile/${encodeURIComponent(me.userId)}/displayname`, 'GET', undefined, me.token).catch(() => null);
    if (profile?.status === 200 && typeof profile.data?.displayname === 'string' && profile.data.displayname) {
      invitedByName = profile.data.displayname.slice(0, 80);
    }
    const token = crypto.randomBytes(18).toString('base64url');
    db[inviteKey(token)] = { token, label, user, invitedBy: me.user, invitedByName, createdAt: now };
    save();
    log('info', 'invite created');
    send(res, 200, { token, invitedBy: me.user, createdAt: now, expiresAt: now + INVITE_TTL_MS });
  }

  async function invitesRevoke(req, res, token) {
    if (!INVITE_CODE_RE.test(token)) return send(res, 400, { error: 'Неверный запрос' });
    const caller = await whoami(req);
    if (!caller) return send(res, 401, { error: 'Нужен вход' });
    if (guestRecord(caller)) return send(res, 403, { error: 'Гость не может управлять приглашениями' });
    const rec = db[inviteKey(token)];
    if (!rec || rec.revokedAt) return send(res, 404, { error: 'Приглашение не найдено' });
    if (!admins.has(caller) && rec.invitedBy !== caller) return send(res, 403, { error: 'Нет прав' });
    rec.revokedAt = Date.now();
    save();
    log('info', 'invite revoked');
    send(res, 200, { ok: true });
  }

  function liveInvite(code, now = Date.now()) {
    if (!INVITE_CODE_RE.test(code)) return null;
    const rec = db[inviteKey(code)];
    if (!rec || rec.usedAt || rec.revokedAt) return null;
    if (typeof rec.createdAt !== 'number' || now - rec.createdAt >= INVITE_TTL_MS) return null;
    return rec;
  }

  async function invitesCheck(req, res, url) {
    const code = url.searchParams.get('code') ?? '';
    if (pruneInvites()) save();
    const rec = liveInvite(code);
    if (!rec) return send(res, 200, { valid: false });
    send(res, 200, {
      valid: true,
      name: rec.label ?? '',
      login: rec.user ?? '',
      inviter: rec.invitedByName || rec.invitedBy || '',
      invitedBy: rec.invitedBy,
      expiresAt: rec.createdAt + INVITE_TTL_MS,
    });
  }

  async function invitesRegister(req, res) {
    if (!registrationToken) return send(res, 503, { error: 'Регистрация недоступна' });
    if (!regAllowed(clientIp(req))) return send(res, 429, { error: 'Слишком много регистраций, попробуйте позже' });
    if (pruneInvites()) save();
    const body = await readBody(req);
    const code = typeof body.code === 'string' ? body.code : '';
    const rec = liveInvite(code);
    if (!rec) return send(res, 404, { error: 'Ссылка недействительна, попросите новую' });
    const login = typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
    if (!USER_RE.test(login) || login.length > 32) return send(res, 400, { error: 'Логин: латиница, цифры и . _ = -, от 1 до 32 символов' });
    if (findByUser(login)) return send(res, 409, { error: 'Этот логин уже занят' });
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) return send(res, 400, { error: 'Введите имя' });
    if (typeof body.password !== 'string' || !PROOF_RE.test(body.password)) return send(res, 400, { error: 'Неверный запрос' });
    // ссылка занята на время регистрации: второй параллельный запрос с тем же кодом её не пройдёт
    if (rec.pendingAt && Date.now() - rec.pendingAt < 60_000) return send(res, 409, { error: 'Регистрация по этой ссылке уже идёт' });
    rec.pendingAt = Date.now();
    let result;
    try {
      result = await createMatrixAccount(login, name, body.password);
    } finally {
      delete rec.pendingAt;
    }
    if (result.error === 'taken') return send(res, 409, { error: 'Этот логин уже занят' });
    if (result.error) {
      log('warn', 'invite register failed', { status: result.status, errcode: result.errcode });
      return send(res, 502, { error: 'Не удалось зарегистрироваться, попробуйте позже' });
    }
    const named = await hs(`/_matrix/client/v3/profile/${encodeURIComponent(result.session.user_id)}/displayname`, 'PUT', { displayname: name }, result.session.access_token).catch(() => null);
    if (named?.status !== 200) log('warn', 'invite register: displayname failed', { status: named?.status });
    const now = Date.now();
    db[recordKey(LOGIN_ID + login)] = {
      user: login,
      guest: true,
      invitedBy: rec.invitedBy,
      inviteName: rec.label ?? '',
      mask: name,
      createdAt: now,
    };
    rec.usedBy = login;
    rec.usedAt = now;
    save();
    log('info', 'guest registered');
    send(res, 200, {
      ok: true,
      access_token: result.session.access_token,
      user_id: result.session.user_id,
      device_id: result.session.device_id,
      login,
      invitedBy: rec.invitedBy,
    });
  }

  async function invitesClaim(req, res) {
    const caller = await whoami(req);
    if (!caller) return send(res, 401, { error: 'Нужен вход' });
    const body = await readBody(req);
    const token = typeof body.token === 'string' ? body.token : '';
    if (!INVITE_CODE_RE.test(token)) return send(res, 400, { error: 'Неверный запрос' });
    const rec = db[inviteKey(token)];
    if (!rec) return send(res, 404, { error: 'Приглашение не найдено' });
    if (rec.user !== caller || body.user !== caller) return send(res, 403, { error: 'Нет прав' });
    const k = findByUser(caller);
    if (k) {
      db[k].guest = true;
      db[k].invitedBy = rec.invitedBy;
      db[k].inviteName = rec.label ?? '';
    } else {
      db[recordKey(caller)] = {
        user: caller,
        guest: true,
        invitedBy: rec.invitedBy,
        inviteName: rec.label ?? '',
        createdAt: Date.now(),
      };
    }
    rec.claimedBy = caller;
    rec.claimedAt = Date.now();
    save();
    send(res, 200, { guest: true, invitedBy: rec.invitedBy });
  }

  async function invitesPromote(req, res) {
    const caller = await whoami(req);
    if (!caller) return send(res, 401, { error: 'Нужен вход' });
    if (!admins.has(caller)) return send(res, 403, { error: 'Нет прав' });
    const body = await readBody(req);
    const user = typeof body.user === 'string' ? body.user.replace(/^@/, '').split(':')[0] : '';
    if (!USER_RE.test(user)) return send(res, 400, { error: 'Неверный запрос' });
    if (!guestRecord(user)) return send(res, 404, { error: 'Гость не найден' });
    const k = findByUser(user);
    if (k) {
      delete db[k].guest;
      delete db[k].invitedBy;
      delete db[k].inviteName;
    }
    const now = Date.now();
    for (const [, r] of inviteRecords()) if (r.user === user) r.promotedAt = now;
    save();
    log('info', 'guest promoted');
    send(res, 200, { user, guest: false });
  }

  /** true — маршрут обработан. */
  async function handle(req, res, url) {
    const own = url.pathname.startsWith(prefix);
    const inv = url.pathname.startsWith(invitePath);
    if (!own && !inv) return false;
    const p = url.pathname.slice((inv ? invitePath : prefix).length);
    try {
      if (inv) {
        if (byLogin) send(res, 404, { error: 'not found' });
        else if (p === 'check' && req.method === 'GET') await invitesCheck(req, res, url);
        else if (p === 'register' && req.method === 'POST') await invitesRegister(req, res);
        else if (p === '' && req.method === 'GET') await invitesList(req, res);
        else if (p === '' && req.method === 'POST') await invitesCreate(req, res);
        else if (p === 'claim' && req.method === 'POST') await invitesClaim(req, res);
        else if (p === 'guests' && req.method === 'GET') await guestsList(req, res);
        else if (p === 'promote' && req.method === 'POST') await invitesPromote(req, res);
        else if (p.startsWith('revoke/') && req.method === 'DELETE') {
          let token;
          try {
            token = decodeURIComponent(p.slice('revoke/'.length));
          } catch {
            return send(res, 400, { error: 'Неверный запрос' }), true;
          }
          await invitesRevoke(req, res, token);
        } else send(res, 404, { error: 'not found' });
      } else if (p === 'bind' && req.method === 'PUT') await bind(req, res);
      else if (p === 'bind' && (req.method === 'GET' || req.method === 'DELETE')) await status(req, res);
      else if (p === 'login' && req.method === 'POST') await login(req, res);
      else if (p === 'register' && req.method === 'POST') await register(req, res);
      else if (p === 'link' && (req.method === 'PUT' || req.method === 'DELETE')) await link(req, res);
      else if (p === 'roles' && (req.method === 'GET' || req.method === 'PUT')) await roles(req, res);
      else if (p.startsWith('user/') && req.method === 'DELETE') {
        let mxid;
        try {
          mxid = decodeURIComponent(p.slice('user/'.length));
        } catch {
          return send(res, 400, { error: 'Неверный запрос' }), true;
        }
        await adminRemove(req, res, mxid);
      } else send(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'server error' });
      if (!e.status) log('error', 'phone route failed', { err: String(e?.message).slice(0, 100) });
    }
    return true;
  }

  /** Доступ соседнего мира к записям (в одном процессе, по сети не виден). */
  handle.store = {
    /** Переписать запись игрока под новый ключ и proof, если старый proof верен. */
    relink(login, oldProof, proof, key, familyUser) {
      const rec = checkProof(login, oldProof, linkLocks, `${familyUser}\n${login}`);
      if (rec === 'locked') return 'locked';
      if (!rec) return 'wrong';
      if (rec.family && rec.family !== familyUser) return 'taken';
      const name = rec.mask || login;
      db[recordKey(login)] = {
        ...rec,
        family: familyUser,
        check: sha256hex('check\n' + proof),
        blob: encryptBlob(proof, { user: rec.user, key, name }),
        fails: 0,
      };
      save();
      return 'ok';
    },
    clearFamily(login, familyUser) {
      const k = findByUser(login);
      if (k && db[k].family === familyUser) {
        delete db[k].family;
        save();
      }
    },
    clearMc(familyUser, login) {
      const k = findByUser(familyUser);
      if (k && db[k].mc === login) {
        delete db[k].mc;
        save();
      }
    },
  };
  handle.setPeer = (store) => {
    peer = store;
  };
  return handle;
}
