/**
 * Защита входа по паролю от перебора PIN. Маршрут /_matrix/client/(r0|v3)/login.
 * Проксирует запрос на homeserver; неудачные пароли считает по паре (логин, IP), по логину и по IP.
 * Пароли, тела запросов, токены и логины в логи не попадают.
 */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

const MAX_BODY = 8 * 1024;
export const PAIR_FAILS = 10;
const PAIR_BASE_LOCK_MS = 15 * 60 * 1000;
const PAIR_MAX_LOCK_MS = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Логины угадываемы (ded, mama): порог по аккаунту высокий, чтобы чужой не мог держать человека заблокированным.
// Подбор PIN без ссылки невозможен (пароль = ключ ссылки + PIN), с украденной ссылкой — 100/ч, это месяцы.
export const USER_LIMIT = 100;
const IP_LIMIT = 50;
const UPSTREAM_TIMEOUT_MS = 30_000;

const LOGIN_RE = /^\/_matrix\/client\/(r0|v3)\/login\/?$/;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'x-real-ip', 'x-forwarded-for', 'forwarded']);

/** «@Mari:server» → «mari» */
export function normalizeUser(raw) {
  if (typeof raw !== 'string') return null;
  let u = raw.trim().toLowerCase().replace(/^@/, '');
  const i = u.indexOf(':');
  if (i >= 0) u = u.slice(0, i);
  return u && u.length <= 256 ? u : null;
}

function extractUser(body) {
  const id = body.identifier;
  if (id && typeof id === 'object') return id.type === 'm.id.user' ? normalizeUser(id.user) : null;
  return normalizeUser(body.user);
}

export function createLoginGuard({ homeserverUrl, log = () => {}, now = Date.now }) {
  const target = new URL(homeserverUrl);
  const client = target.protocol === 'https:' ? https : http;

  const pairs = new Map(); // `${ip}\n${user}` -> { fails, lockUntil, last }
  const users = new Map(); // user -> { times, lockUntil }
  const ips = new Map(); // ip -> { times, lockUntil }

  const timer = setInterval(() => {
    const t = now();
    for (const [k, v] of pairs) if (v.lockUntil < t && v.last < t - PAIR_MAX_LOCK_MS) pairs.delete(k);
    for (const m of [users, ips]) {
      for (const [k, v] of m) {
        v.times = v.times.filter((x) => x > t - HOUR);
        if (!v.times.length && v.lockUntil < t) m.delete(k);
      }
    }
  }, 60_000);
  timer.unref();

  const tag = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

  function lockedFor(ip, user) {
    const t = now();
    let until = ips.get(ip)?.lockUntil ?? 0;
    if (user) until = Math.max(until, pairs.get(`${ip}\n${user}`)?.lockUntil ?? 0, users.get(user)?.lockUntil ?? 0);
    return until > t ? until - t : 0;
  }

  function windowFail(map, key, limit) {
    const t = now();
    const e = map.get(key) ?? { times: [], lockUntil: 0 };
    e.times = e.times.filter((x) => x > t - HOUR);
    e.times.push(t);
    if (e.times.length >= limit) {
      e.lockUntil = t + HOUR;
      e.times = [];
    }
    map.set(key, e);
  }

  function recordFail(ip, user) {
    const t = now();
    if (user) {
      const k = `${ip}\n${user}`;
      const p = pairs.get(k) ?? { fails: 0, lockUntil: 0, last: 0 };
      p.fails++;
      p.last = t;
      if (p.fails >= PAIR_FAILS) {
        const dur = Math.min(PAIR_BASE_LOCK_MS * 2 ** (p.fails - PAIR_FAILS), PAIR_MAX_LOCK_MS);
        p.lockUntil = t + dur;
        log('warn', 'login locked', { scope: 'pair', user: tag(user), minutes: Math.round(dur / 60000) });
      }
      pairs.set(k, p);
      windowFail(users, user, USER_LIMIT);
    }
    windowFail(ips, ip, IP_LIMIT);
  }

  const recordSuccess = (ip, user) => {
    if (user) pairs.delete(`${ip}\n${user}`);
  };

  function limited(res, ms) {
    const mins = Math.max(1, Math.ceil(ms / 60000));
    res.writeHead(429, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'retry-after': String(Math.ceil(ms / 1000)),
    });
    res.end(JSON.stringify({
      errcode: 'M_LIMIT_EXCEEDED',
      error: `Слишком много попыток входа. Попробуйте через ${mins} мин.`,
      retry_after_ms: ms,
    }));
  }

  function fail(res, status, errcode, error) {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ errcode, error }));
  }

  function upstreamHeaders(req, bodyLength) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) h[k] = v;
    if (bodyLength !== undefined) h['content-length'] = String(bodyLength);
    else if (req.headers['content-length']) h['content-length'] = req.headers['content-length'];
    return h;
  }

  function open(req, headers, onResponse) {
    const u = new URL(req.url, target);
    const up = client.request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: req.method, path: u.pathname + u.search, headers, timeout: UPSTREAM_TIMEOUT_MS },
      onResponse,
    );
    up.on('timeout', () => up.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    return up;
  }

  function resHeaders(r) {
    const h = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) h[k] = v;
    return h;
  }

  const onUpstreamError = (res) => (e) => {
    log('warn', 'login upstream error', { code: e.code });
    if (!res.headersSent) fail(res, 502, 'M_UNKNOWN', 'Сервер недоступен');
    else res.destroy();
  };

  function passthrough(req, res) {
    const up = open(req, upstreamHeaders(req), (r) => {
      res.writeHead(r.statusCode, resHeaders(r));
      r.pipe(res);
    });
    up.on('error', onUpstreamError(res));
    req.pipe(up);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      let done = false;
      const chunks = [];
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > MAX_BODY) {
          done = true;
          reject(Object.assign(new Error('too large'), { status: 413 }));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => !done && resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function clientIp(req) {
    const h = req.headers['x-real-ip'];
    const v = Array.isArray(h) ? h[0] : h;
    return (v && v.trim().slice(0, 64)) || req.socket.remoteAddress || 'unknown';
  }

  async function handlePost(req, res) {
    if (Number(req.headers['content-length']) > MAX_BODY) return fail(res, 413, 'M_TOO_LARGE', 'Слишком большой запрос');
    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      return fail(res, e.status || 400, e.status === 413 ? 'M_TOO_LARGE' : 'M_BAD_JSON', 'Некорректный запрос');
    }
    let counted = false;
    let user = null;
    try {
      const body = JSON.parse(raw.toString('utf8'));
      if (body && typeof body === 'object' && body.type === 'm.login.password') {
        counted = true;
        user = extractUser(body);
      }
    } catch {
      /* пусть разбирается homeserver */
    }
    const ip = clientIp(req);
    if (counted) {
      const ms = lockedFor(ip, user);
      if (ms) return limited(res, ms);
    }

    const up = open(req, upstreamHeaders(req, raw.length), (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('error', onUpstreamError(res));
      r.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (counted) {
          if (r.statusCode === 403) {
            let errcode;
            try {
              errcode = JSON.parse(buf.toString('utf8')).errcode;
            } catch {
              /* не JSON */
            }
            if (errcode === 'M_FORBIDDEN') recordFail(ip, user);
          } else if (r.statusCode >= 200 && r.statusCode < 300) recordSuccess(ip, user);
        }
        res.writeHead(r.statusCode, { ...resHeaders(r), 'content-length': buf.length });
        res.end(buf);
      });
    });
    up.on('error', onUpstreamError(res));
    up.end(raw);
  }

  /** true — запрос обработан здесь */
  return async function loginGuard(req, res, url) {
    if (!LOGIN_RE.test(url.pathname)) return false;
    if (req.method !== 'POST') passthrough(req, res);
    else await handlePost(req, res);
    return true;
  };
}
