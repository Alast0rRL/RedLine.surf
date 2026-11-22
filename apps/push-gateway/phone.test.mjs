// node --test apps/push-gateway/phone.test.mjs
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKENS = { tokA: '@alice.0123456789ab:test', tokB: '@bob.0123456789cd:test' };
const KEY_A = 'a'.repeat(32);
const KEY_B = 'b'.repeat(32);

let hs, gw, base, dir, dbFile, port;

const proof = (pin, phone) =>
  crypto.pbkdf2Sync(pin, 'redline-phone-v1\n' + phone, 1000, 32, 'sha256').toString('hex');

async function call(method, route, body, token, ip) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (ip) headers['x-real-ip'] = ip;
  const r = await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}

before(async () => {
  hs = http.createServer((req, res) => {
    const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (req.url === '/_matrix/client/v3/account/whoami' && TOKENS[t]) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ user_id: TOKENS[t] }));
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"errcode":"M_UNKNOWN_TOKEN"}');
  });
  await new Promise((r) => hs.listen(0, '127.0.0.1', r));

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-test-'));
  dbFile = path.join(dir, 'phones.json');
  port = 18000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  gw = spawn(process.execPath, [path.join(here, 'server.mjs')], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      PHONE_ONLY: '1',
      PHONE_DB: dbFile,
      HOMESERVER_INTERNAL_URL: `http://127.0.0.1:${hs.address().port}`,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + '/health')).ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('gateway did not start');
});

after(() => {
  gw?.kill();
  hs?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const PHONE_A = '+7 (900) 111-22-33';
const NORM_A = '79001112233';

test('bind requires a valid token', async () => {
  const body = { phone: PHONE_A, proof: proof('123456', NORM_A), key: KEY_A };
  assert.equal((await call('PUT', '/api/phone/bind', body)).status, 401);
  assert.equal((await call('PUT', '/api/phone/bind', body, 'bad')).status, 401);
  const ok = await call('PUT', '/api/phone/bind', body, 'tokA');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.mask, '+7 *** ***-**-33');
  assert.equal((await call('GET', '/api/phone/bind', null, 'tokA')).json.mask, '+7 *** ***-**-33');
  assert.equal((await call('GET', '/api/phone/bind', null, 'tokB')).json.mask, null);
});

test('login ok (phone formats are normalised)', async () => {
  const r = await call('POST', '/api/phone/login', { phone: '8 900 111 22 33', proof: proof('123456', NORM_A) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { user: 'alice.0123456789ab', key: KEY_A });
});

test('wrong proof and unknown phone give the same 401', async () => {
  const wrong = await call('POST', '/api/phone/login', { phone: PHONE_A, proof: proof('000000', NORM_A) });
  const unknown = await call('POST', '/api/phone/login', { phone: '79990000000', proof: proof('123456', '79990000000') });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.json, unknown.json);
});

test('lockout after 5 wrong attempts', async () => {
  const ip = '10.0.0.5';
  let last;
  for (let i = 0; i < 5; i++) {
    last = await call('POST', '/api/phone/login', { phone: PHONE_A, proof: proof('00000' + i, NORM_A) }, null, ip);
  }
  assert.equal(last.status, 429);
  // даже верный PIN теперь не пускает
  const r = await call('POST', '/api/phone/login', { phone: PHONE_A, proof: proof('123456', NORM_A) }, null, ip);
  assert.equal(r.status, 429);
});

test('phone bound to another user gives 409', async () => {
  const r = await call('PUT', '/api/phone/bind', { phone: PHONE_A, proof: proof('654321', NORM_A), key: KEY_B }, 'tokB');
  assert.equal(r.status, 409);
});

test('rebind replaces the old record', async () => {
  const phone2 = '79005556677';
  const r = await call('PUT', '/api/phone/bind', { phone: phone2, proof: proof('111111', phone2), key: KEY_A }, 'tokA');
  assert.equal(r.status, 200);
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  assert.equal(Object.values(db).filter((x) => x.user === 'alice.0123456789ab').length, 1);
  // старый номер освободился: Боб может его занять
  const b = await call('PUT', '/api/phone/bind', { phone: PHONE_A, proof: proof('654321', NORM_A), key: KEY_B }, 'tokB');
  assert.equal(b.status, 200);
  const ok = await call('POST', '/api/phone/login', { phone: phone2, proof: proof('111111', phone2) }, null, '10.0.0.6');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.key, KEY_A);
});

test('db file has no phone, proof or key in clear', () => {
  const raw = fs.readFileSync(dbFile, 'utf8');
  for (const needle of ['79001112233', '79005556677', KEY_A, KEY_B, proof('123456', NORM_A), proof('111111', '79005556677')]) {
    assert.ok(!raw.includes(needle), `leaked: ${needle.slice(0, 6)}`);
  }
});

test('unbind removes own record', async () => {
  await call('DELETE', '/api/phone/bind', null, 'tokB');
  assert.equal((await call('GET', '/api/phone/bind', null, 'tokB')).json.mask, null);
});
