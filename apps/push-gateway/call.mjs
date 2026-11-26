/**
 * Токены LiveKit для звонков 1:1. Маршруты /api/call/* и /mc/api/call/*.
 * Секрет подписи и адрес сервера LiveKit живут только на шлюзе, в браузер попадает готовый JWT.
 * Токен выдаётся только участнику комнаты Matrix и не больше 30 раз в минуту.
 */
import crypto from 'node:crypto';

const MAX_BODY = 4 * 1024;
const WHOAMI_TIMEOUT_MS = 5000;
const TOKEN_LIMIT = 30;
const TOKEN_WINDOW_MS = 60 * 1000;
const TOKEN_TTL = 6 * 60 * 60;
const MXID_RE = /^@[^:\s]+:[^\s]+$/;

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

function makeJwt({ apiKey, apiSecret, userId, room }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: apiKey,
      sub: userId,
      name: userId,
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
  const hits = new Map();
  // старые отметки не нужны: без этого map рос бы вместе с числом пользователей
  setInterval(() => {
    const cutoff = Date.now() - TOKEN_WINDOW_MS;
    for (const [user, list] of hits) {
      const fresh = list.filter((t) => t > cutoff);
      if (fresh.length) hits.set(user, fresh);
      else hits.delete(user);
    }
  }, TOKEN_WINDOW_MS).unref();

  function rateAllowed(userId) {
    const now = Date.now();
    const list = (hits.get(userId) ?? []).filter((t) => t > now - TOKEN_WINDOW_MS);
    if (list.length >= TOKEN_LIMIT) {
      hits.set(userId, list);
      return false;
    }
    list.push(now);
    hits.set(userId, list);
    return true;
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
    const m = /^Bearer\s+(\S{1,512})$/.exec(req.headers.authorization ?? '');
    if (!m) return send(res, 401, { error: 'Нужен вход' });

    const userId = await whoami(req, m[1]);
    if (!userId) return send(res, 401, { error: 'Нужен вход' });

    const body = await readBody(req);
    const roomId = body.roomId;
    if (typeof roomId !== 'string' || !roomId.startsWith('!') || roomId.length > 255) {
      return send(res, 400, { error: 'Неверный запрос' });
    }
    if (!(await isMember(roomId, userId, m[1]))) return send(res, 403, { error: 'Нет доступа к чату' });
    if (!rateAllowed(userId)) return send(res, 429, { error: 'Слишком много запросов' });

    const room = `${realm}-${crypto.createHash('sha256').update(roomId).digest('hex').slice(0, 32)}`;
    const token = makeJwt({ apiKey, apiSecret, userId, room });
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
