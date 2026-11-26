// node --test apps/push-gateway/call.test.mjs
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createCallApi } from './call.mjs';

const TOKENS = {
  tokAlice: '@alice:fam',
  tokBob: '@bob:fam',
  tokCarol: '@carol:fam',
};
const ROOM = '!family:redline.surf';
const OTHER_ROOM = '!other:redline.surf';
const API_KEY = 'lk-api-key';
const SECRET = 'lk-api-secret';
const LIVEKIT_URL = 'wss://lk.redline.surf';
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

let hs, gw, offGw, base, offBase, hsUrl;

async function call(method, route, body, token, target = base) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(target + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json(), headers: r.headers };
}

before(async () => {
  hs = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://gateway');
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === '/_matrix/client/v3/account/whoami') {
      return TOKENS[token] ? send(200, { user_id: TOKENS[token] }) : send(401, { errcode: 'M_UNKNOWN_TOKEN' });
    }
    const m = /^\/_matrix\/client\/v3\/rooms\/(.+)\/joined_members$/.exec(u.pathname);
    if (m && req.method === 'GET') {
      const roomId = decodeURIComponent(m[1]);
      if (roomId === OTHER_ROOM) return send(500, { errcode: 'M_UNKNOWN' });
      if (roomId !== ROOM) return send(404, { errcode: 'M_NOT_FOUND' });
      const joined = { '@alice:fam': {}, '@carol:fam': {} };
      return send(200, { joined });
    }
    return send(404, { errcode: 'M_NOT_FOUND' });
  });
  await new Promise((r) => hs.listen(0, '127.0.0.1', r));
  hsUrl = `http://127.0.0.1:${hs.address().port}`;

  const log = () => undefined;
  const api = createCallApi({ homeserverUrl: hsUrl, prefix: '/api/call/', realm: 'family', apiKey: API_KEY, apiSecret: SECRET, livekitUrl: LIVEKIT_URL, log });
  const mc = createCallApi({ homeserverUrl: hsUrl, prefix: '/mc/api/call/', realm: 'mc', apiKey: API_KEY, apiSecret: SECRET, livekitUrl: LIVEKIT_URL, log });
  const off = createCallApi({ homeserverUrl: hsUrl, prefix: '/api/call/', realm: 'family', log });
  gw = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway');
    if (await api(req, res, url)) return;
    if (await mc(req, res, url)) return;
    send404(res);
  });
  offGw = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway');
    if (await off(req, res, url)) return;
    send404(res);
  });
  await Promise.all([
    new Promise((r) => gw.listen(0, '127.0.0.1', r)),
    new Promise((r) => offGw.listen(0, '127.0.0.1', r)),
  ]);
  base = `http://127.0.0.1:${gw.address().port}`;
  offBase = `http://127.0.0.1:${offGw.address().port}`;
});

function send404(res) {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
}

after(async () => {
  await Promise.all([
    new Promise((r) => gw.close(r)),
    new Promise((r) => offGw.close(r)),
    new Promise((r) => hs.close(r)),
  ]);
});

test('токен без входа и с неверным токеном не выдаётся', async () => {
  const noToken = await call('POST', '/api/call/token', { roomId: ROOM });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.json.error, 'Нужен вход');
  const badToken = await call('POST', '/api/call/token', { roomId: ROOM }, 'bad');
  assert.equal(badToken.status, 401);
});

test('не участник комнаты получает 403; неизвестная комната тоже закрыта', async () => {
  const outsider = await call('POST', '/api/call/token', { roomId: ROOM }, 'tokBob');
  assert.equal(outsider.status, 403);
  assert.equal(outsider.json.error, 'Нет доступа к чату');
  assert.equal((await call('POST', '/api/call/token', { roomId: OTHER_ROOM }, 'tokAlice')).status, 403);
  assert.equal((await call('POST', '/api/call/token', { roomId: 'bad' }, 'tokAlice')).status, 400);
});

test('без настроек LiveKit маршрут отвечает 503', async () => {
  const r = await call('POST', '/api/call/token', { roomId: ROOM }, 'tokAlice', offBase);
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'Звонки не настроены');
  assert.equal((await call('POST', '/api/call/token', { roomId: ROOM }, undefined, offBase)).status, 503);
});

test('выданный JWT подписан секретом и содержит нужные claims', async () => {
  const before = Math.floor(Date.now() / 1000);
  const r = await call('POST', '/api/call/token', { roomId: ROOM }, 'tokAlice');
  const afterTs = Math.floor(Date.now() / 1000);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.json.url, LIVEKIT_URL);

  const room = `family-${sha256hex(ROOM).slice(0, 32)}`;
  assert.equal(r.json.room, room);

  const parts = r.json.token.split('.');
  assert.equal(parts.length, 3);
  assert.doesNotMatch(r.json.token, /=/);
  const expected = crypto.createHmac('sha256', SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url').replace(/=+$/, '');
  assert.equal(parts[2], expected);

  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  assert.deepEqual(header, { alg: 'HS256', typ: 'JWT' });
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.equal(payload.iss, API_KEY);
  assert.equal(payload.sub, '@alice:fam');
  assert.equal(payload.name, '@alice:fam');
  assert.ok(payload.nbf >= before - 10 && payload.nbf <= afterTs - 10);
  assert.ok(payload.exp >= before + 6 * 3600 && payload.exp <= afterTs + 6 * 3600);
  assert.deepEqual(payload.video, { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
});

test('не более 30 токенов в минуту на пользователя', async () => {
  const statuses = [];
  for (let i = 0; i < 30; i++) {
    statuses.push((await call('POST', '/api/call/token', { roomId: ROOM }, 'tokCarol')).status);
  }
  assert.deepEqual(statuses, Array(30).fill(200));
  const over = await call('POST', '/api/call/token', { roomId: ROOM }, 'tokCarol');
  assert.equal(over.status, 429);
});

test('префикс mc — отдельный мир, чужие пути не перехватываются', async () => {
  const r = await call('POST', '/mc/api/call/token', { roomId: ROOM }, 'tokAlice');
  assert.equal(r.status, 200);
  assert.match(r.json.room, /^mc-/);
  assert.equal((await call('GET', '/api/call/token', undefined, 'tokAlice')).status, 405);
  assert.equal((await call('POST', '/api/call/other', { roomId: ROOM }, 'tokAlice')).status, 404);

  const api = createCallApi({ homeserverUrl: hsUrl, prefix: '/api/call/', realm: 'family' });
  assert.equal(await api({}, {}, new URL('http://gateway/api/phone/bind')), false);
});
