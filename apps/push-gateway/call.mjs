/**
 * Токены LiveKit для звонков 1:1. Маршруты /api/call/* и /mc/api/call/*.
 * Секрет подписи и адрес сервера LiveKit живут только на шлюзе, в браузер попадает готовый JWT.
 * Токен выдаётся только участнику комнаты Matrix: не больше 30 раз в минуту
 * пользователю и 60 раз в минуту с одного IP (ещё до обращения к homeserver).
 */
import crypto from 'node:crypto';

const MAX_BODY = 4 * 1024;
const WHOAMI_TIMEOUT_MS = 5000;
const IP_LIMIT = 60;
const TOKEN_LIMIT = 30;
const TOKEN_WINDOW_MS = 60 * 1000;
const TOKEN_TTL = 6 * 60 * 60;
const MXID_RE = /^@[^:\s]+:[^\s]+$/;
const CALL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PARTY_RE = /^[A-Za-z0-9_-]{1,64}$/;

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

const b64url = (v) => Buffer.from(v).toString('base64url').replace(/=+$/, '');

function makeJwt({ apiKey, apiSecret, identity, name, room }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: apiKey,
      sub: identity,
      name,
      nbf: now - 10,
      exp: now + TOKEN_TTL,
      video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
    }),
  );
  const data = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', apiSecret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

export function createCallApi({ homeserverUrl, prefix, realm, apiKey = '', apiSecret = '', livekitUrl = '', log = () => undefined }) {
  const userHits = new Map();
  const ipHits = new Map();
  // старые отметки не нужны: без этого map рос бы вместе с числом пользователей и IP
  function prune(hits) {
    const cutoff = Date.now() - TOKEN_WINDOW_MS;
    for (const [key, list] of hits) {
      const fresh = list.filter((t) => t > cutoff);
      if (fresh.length) hits.set(key, fresh);
      else hits.delete(key);
    }
  }
  setInterval(() => {
    prune(userHits);
    prune(ipHits);
  }, TOKEN_WINDOW_MS).unref();

  function rateAllowed(hits, key, limit) {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => t > now - TOKEN_WINDOW_MS);
    if (list.length >= limit) {
      hits.set(key, list);
      return false;
    }
    list.push(now);
    hits.set(key, list);
    return true;
  }

  /** IP из заголовка прокси или с самого соединения. */
  function clientIp(req) {
    const header = req.headers?.['x-real-ip'];
    return (typeof header === 'string' && header ? header : req.socket?.remoteAddress) || '';
  }

  /** Полный Matrix ID владельца токена или null. */
  async function whoami(req, token) {
    let r;
    try {
      r = await fetch(`${homeserverUrl}/_matrix/client/v3/account/whoami`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(WHOAMI_TIMEOUT_MS),
      });
    } catch {
      throw Object.assign(new Error('homeserver unavailable'), { status: 502 });
    }
    if (!r.ok) return null;
    const userId = (await r.json().catch(() => null))?.user_id;
    return typeof userId === 'string' && MXID_RE.test(userId) ? userId : null;
  }

  async function isMember(roomId, userId, token) {
    let r;
    try {
      r = await fetch(`${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(WHOAMI_TIMEOUT_MS),
      });
    } catch {
      throw Object.assign(new Error('homeserver unavailable'), { status: 502 });
    }
    if (!r.ok) return false;
    const data = await r.json().catch(() => null);
    return !!data?.joined && typeof data.joined === 'object' && Object.hasOwn(data.joined, userId);
  }

  async function route(req, res, url) {
    const p = url.pathname.slice(prefix.length);
    if (p !== 'token') return send(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

    if (!apiKey || !apiSecret || !livekitUrl) return send(res, 503, { error: 'Звонки не настроены' });
    // лимит по IP проверяем до whoami, чтобы не нагружать homeserver лишними запросами
    if (!rateAllowed(ipHits, clientIp(req), IP_LIMIT)) return send(res, 429, { error: 'Слишком много запросов' });

    const m = /^Bearer\s+(\S{1,512})$/.exec(req.headers.authorization ?? '');
    if (!m) return send(res, 401, { error: 'Нужен вход' });

    const userId = await whoami(req, m[1]);
    if (!userId) return send(res, 401, { error: 'Нужен вход' });

    const body = await readBody(req);
    const { roomId, callId, party } = body;
    if (
      typeof roomId !== 'string' || !roomId.startsWith('!') || roomId.length > 255 ||
      typeof callId !== 'string' || !CALL_ID_RE.test(callId) ||
      typeof party !== 'string' || !PARTY_RE.test(party)
    ) {
      return send(res, 400, { error: 'Неверный запрос' });
    }
    // лимит на пользователя — до запроса joined_members
    if (!rateAllowed(userHits, userId, TOKEN_LIMIT)) return send(res, 429, { error: 'Слишком много запросов' });
    if (!(await isMember(roomId, userId, m[1]))) return send(res, 403, { error: 'Нет доступа к чату' });

    const hash = crypto.createHash('sha256').update(`${roomId}\n${callId}`).digest('hex').slice(0, 32);
    const room = `${realm}-${hash}`;
    const token = makeJwt({ apiKey, apiSecret, identity: `${userId}|${party}`, name: userId, room });
    send(res, 200, { url: livekitUrl, token, room });
    log('info', 'call token issued', { realm, room });
  }

  /** true — маршрут обработан. */
  async function handle(req, res, url) {
    if (!url.pathname.startsWith(prefix)) return false;
    try {
      await route(req, res, url);
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'server error' });
      if (!e.status) log('error', 'call route failed', { err: String(e?.message).slice(0, 100) });
    }
    return true;
  }

  return handle;
}
