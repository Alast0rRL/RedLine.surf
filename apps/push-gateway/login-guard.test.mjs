// node --test apps/push-gateway/login-guard.test.mjs
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLoginGuard, normalizeUser } from './login-guard.mjs';

const SECRET = 'S3cretPassw0rd-xyz';
const MIN = 60 * 1000;

let hs, gw, base, clock, calls, logs, lastUpstream;

const hsHandler = (req, res) => {
  calls++;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    lastUpstream = { url: req.url, headers: req.headers };
    const h = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
    if (req.method !== 'POST') {
      res.writeHead(200, h);
      return res.end('{"flows":[{"type":"m.login.password"}]}');
    }
    const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (b.type !== 'm.login.password') {
      res.writeHead(403, h);
      return res.end('{"errcode":"M_FORBIDDEN"}');
    }
    if (b.password === 'good') {
      res.writeHead(200, h);
      return res.end('{"access_token":"t","user_id":"@x:test"}');
    }
    res.writeHead(403, h);
    res.end('{"errcode":"M_FORBIDDEN","error":"Wrong"}');
  });
};

before(async () => {
  hs = http.createServer(hsHandler);
  await new Promise((r) => hs.listen(0, '127.0.0.1', r));
  const guard = createLoginGuard({
    homeserverUrl: `http://127.0.0.1:${hs.address().port}`,
    log: (level, msg, extra) => logs.push(JSON.stringify({ level, msg, ...extra })),
    now: () => clock,
  });
  gw = http.createServer(async (req, res) => {
    if (!(await guard(req, res, new URL(req.url, 'http://gw')))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gw.address().port}`;
});

after(() => {
  gw.close();
  hs.close();
});

// каждому тесту — свой логин и «чистое» время, чтобы счётчики не пересекались
let seq = 0;
let user;
beforeEach(() => {
  clock = Date.now() + seq * 1000 * 24 * 3600 * 1000;
  user = `u${++seq}abc`;
  calls = 0;
  logs = [];
});

const login = (u, password, ip, extra = {}) =>
  fetch(base + '/_matrix/client/v3/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: u }, password, ...extra }),
  });

test('normalizeUser', () => {
  assert.equal(normalizeUser('@Mari:Server'), 'mari');
  assert.equal(normalizeUser('mari'), 'mari');
  assert.equal(normalizeUser(5), null);
});

test('GET и OPTIONS проходят насквозь с CORS и query', async () => {
  const r = await fetch(base + '/_matrix/client/v3/login?x=1');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal((await r.json()).flows[0].type, 'm.login.password');
  assert.equal(lastUpstream.url, '/_matrix/client/v3/login?x=1');
  const o = await fetch(base + '/_matrix/client/r0/login', { method: 'OPTIONS' });
  assert.equal(o.status, 200);
  assert.equal(calls, 2);
});

test('верный пароль — 200', async () => {
  const r = await login(user, 'good', '10.0.0.1');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).access_token, 't');
});

test('5 неверных, шестой — 429 без обращения к homeserver; ответ с CORS и Retry-After', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login(user, 'bad', '10.0.0.2')).status, 403);
  assert.equal(calls, 5);
  const r = await login(user, 'good', '10.0.0.2');
  assert.equal(r.status, 429);
  assert.equal(calls, 5);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  const j = await r.json();
  assert.equal(j.errcode, 'M_LIMIT_EXCEEDED');
  assert.match(j.error, /Попробуйте через 15 мин/);
  assert.equal(j.retry_after_ms, 15 * MIN);
});

test('другой IP того же логина не заблокирован по паре, но блокируется по логину после 20 неудач', async () => {
  for (let i = 0; i < 4; i++) await login(user, 'bad', '10.0.1.1');
  assert.equal((await login(user, 'good', '10.0.1.2')).status, 200);
  // ещё неудачи с разных IP: всего 20 по логину
  for (let i = 4; i < 20; i++) assert.equal((await login(user, 'bad', `10.0.2.${i}`)).status, 403);
  const before = calls;
  const r = await login(user, 'good', '10.0.3.1');
  assert.equal(r.status, 429);
  assert.equal(calls, before);
  clock += 61 * MIN;
  assert.equal((await login(user, 'good', '10.0.3.1')).status, 200);
});

test('успех сбрасывает счётчик пары', async () => {
  for (let i = 0; i < 4; i++) await login(user, 'bad', '10.0.4.1');
  assert.equal((await login(user, 'good', '10.0.4.1')).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await login(user, 'bad', '10.0.4.1')).status, 403);
  assert.equal((await login(user, 'good', '10.0.4.1')).status, 200);
});

test('блокировка удваивается, максимум 24 ч', async () => {
  for (let i = 0; i < 5; i++) await login(user, 'bad', '10.0.5.1');
  let j = await (await login(user, 'good', '10.0.5.1')).json();
  assert.equal(j.retry_after_ms, 15 * MIN);
  clock += 15 * MIN + 1;
  assert.equal((await login(user, 'bad', '10.0.5.1')).status, 403);
  j = await (await login(user, 'good', '10.0.5.1')).json();
  assert.equal(j.retry_after_ms, 30 * MIN);
  clock += 30 * MIN + 1;
  await login(user, 'bad', '10.0.5.1');
  j = await (await login(user, 'good', '10.0.5.1')).json();
  assert.equal(j.retry_after_ms, 60 * MIN);
});

test('по IP: 50 неудач для разных логинов блокируют IP', async () => {
  for (let i = 0; i < 50; i++) await login(`ipuser${seq}x${i}`, 'bad', '10.0.6.1');
  const before = calls;
  const r = await login(`other${seq}`, 'good', '10.0.6.1');
  assert.equal(r.status, 429);
  assert.equal(calls, before);
  assert.equal((await login(`other${seq}`, 'good', '10.0.6.2')).status, 200);
});

test('другие типы входа не считаются', async () => {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(base + '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '10.0.7.1' },
      body: JSON.stringify({ type: 'm.login.token', token: 'abc' }),
    });
    assert.equal(r.status, 403);
  }
  assert.equal(calls, 8);
  assert.equal((await login(user, 'good', '10.0.7.1')).status, 200);
});

test('тело больше 8 КБ — 413', async () => {
  const r = await fetch(base + '/_matrix/client/v3/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'm.login.password', user, password: 'x'.repeat(9000) }),
  });
  assert.equal(r.status, 413);
  assert.equal(calls, 0);
});

test('пароль и логин не попадают в логи', async () => {
  for (let i = 0; i < 6; i++) await login(user, SECRET, '10.0.8.1');
  assert.ok(logs.length > 0);
  const all = logs.join('\n');
  assert.ok(!all.includes(SECRET));
  assert.ok(!all.includes(user));
});
