// node --test apps/push-gateway/link.test.mjs — связка аккаунта семьи с ником Minecraft
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createPhoneApi } from './phone.mjs';

const TOKENS = { tokDed: '@ded:fam', tokBob: '@bob:fam', tokAdmin: '@admin:fam', tokSteve: '@steve:mc', tokAlex: '@alex:mc' };
const pf = (pin, id, salt) => crypto.pbkdf2Sync(pin, salt + id, 1000, 32, 'sha256').toString('hex');
const phoneProof = (pin, phone) => pf(pin, phone, 'redline-phone-v1\n');
const nickProof = (pin, nick) => pf(pin, nick, 'redline-login-v1\n');
const K_DED = 'd'.repeat(32);
const K_BOB = 'b'.repeat(32);
const K_STEVE = '5'.repeat(32);

let hs, gw, base, dir;

async function call(method, route, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
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
  const hsUrl = `http://127.0.0.1:${hs.address().port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-test-'));
  const log = () => undefined;
  const fam = createPhoneApi({ dbPath: path.join(dir, 'phones.json'), homeserverUrl: hsUrl, log });
  const mc = createPhoneApi({ dbPath: path.join(dir, 'mc.json'), homeserverUrl: hsUrl, log, mode: 'login', prefix: '/mc/api/phone/' });
  fam.setPeer(mc.store);
  mc.setPeer(fam.store);
  gw = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (await fam(req, res, url)) return;
    if (await mc(req, res, url)) return;
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gw.address().port}`;

  // семья: ded и bob по номеру; игроки steve и alex по нику
  assert.equal((await call('PUT', '/api/phone/bind', { phone: '+79001110001', proof: phoneProof('1111', '79001110001'), key: K_DED, name: 'Дед' }, 'tokDed')).status, 200);
  assert.equal((await call('PUT', '/api/phone/bind', { phone: '+79001110002', proof: phoneProof('2222', '79001110002'), key: K_BOB }, 'tokBob')).status, 200);
  assert.equal((await call('PUT', '/mc/api/phone/bind', { login: 'steve', proof: nickProof('9999', 'steve'), key: K_STEVE, name: 'Steve' }, 'tokSteve')).status, 200);
});

after(() => {
  gw?.close();
  hs?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const linkBody = (oldPin, newPin, key = K_DED) => ({ login: 'Steve', oldProof: nickProof(oldPin, 'steve'), proof: nickProof(newPin, 'steve'), key });

test('без роли Minecraft связать нельзя', async () => {
  const r = await call('PUT', '/api/phone/link', linkBody('9999', '1111'), 'tokDed');
  assert.equal(r.status, 403);
});

test('роли меняет только админ', async () => {
  assert.equal((await call('PUT', '/api/phone/roles', { user: 'ded', mc: true }, 'tokDed')).status, 403);
  const r = await call('PUT', '/api/phone/roles', { user: '@ded:fam', mc: true }, 'tokAdmin');
  assert.equal(r.status, 200);
  assert.equal(r.json.mcAllowed, true);
  const list = await call('GET', '/api/phone/roles', undefined, 'tokAdmin');
  assert.deepEqual(list.json.users.find((u) => u.user === 'ded'), { user: 'ded', mc: null, mcAllowed: true });
});

test('неверный PIN ника — 401, запись игрока не меняется', async () => {
  const r = await call('PUT', '/api/phone/link', linkBody('0000', '1111'), 'tokDed');
  assert.equal(r.status, 401);
  assert.equal((await call('POST', '/mc/api/phone/login', { login: 'steve', proof: nickProof('9999', 'steve') })).status, 200);
});

test('связка: ник переходит на ключ и PIN семьи, вход с обеих сторон знает о связи', async () => {
  const r = await call('PUT', '/api/phone/link', linkBody('9999', '1111'), 'tokDed');
  assert.equal(r.status, 200);
  assert.equal(r.json.mc, 'steve');

  assert.equal((await call('POST', '/mc/api/phone/login', { login: 'steve', proof: nickProof('9999', 'steve') })).status, 401);
  const m = await call('POST', '/mc/api/phone/login', { login: 'steve', proof: nickProof('1111', 'steve') });
  assert.equal(m.status, 200);
  assert.equal(m.json.key, K_DED);
  assert.equal(m.json.user, 'steve');
  assert.equal(m.json.name, 'Steve');
  assert.deepEqual(m.json.linked, { realm: 'family', user: 'ded' });

  const f = await call('POST', '/api/phone/login', { phone: '+79001110001', proof: phoneProof('1111', '79001110001') });
  assert.equal(f.status, 200);
  assert.deepEqual(f.json.linked, { realm: 'mc', user: 'steve' });

  const st = await call('GET', '/api/phone/bind', undefined, 'tokDed');
  assert.equal(st.json.mc, 'steve');
  assert.equal(st.json.mcAllowed, true);
  const ms = await call('GET', '/mc/api/phone/bind', undefined, 'tokSteve');
  assert.equal(ms.json.family, 'ded');
});

test('перепривязка номера не теряет связь', async () => {
  assert.equal((await call('PUT', '/api/phone/bind', { phone: '+79001110001', proof: phoneProof('1111', '79001110001'), key: K_DED, name: 'Дед' }, 'tokDed')).status, 200);
  const f = await call('POST', '/api/phone/login', { phone: '+79001110001', proof: phoneProof('1111', '79001110001') });
  assert.deepEqual(f.json.linked, { realm: 'mc', user: 'steve' });
});

test('чужой ник, уже связанный с другим, не забрать', async () => {
  assert.equal((await call('PUT', '/api/phone/roles', { user: 'bob', mc: true }, 'tokAdmin')).status, 200);
  const r = await call('PUT', '/api/phone/link', { login: 'steve', oldProof: nickProof('1111', 'steve'), proof: nickProof('2222', 'steve'), key: K_BOB }, 'tokBob');
  assert.equal(r.status, 409);
});

test('снятие роли рвёт связь с обеих сторон, аккаунт игрока остаётся', async () => {
  const r = await call('PUT', '/api/phone/roles', { user: 'ded', mc: false }, 'tokAdmin');
  assert.equal(r.status, 200);
  assert.equal(r.json.mc, null);
  const m = await call('POST', '/mc/api/phone/login', { login: 'steve', proof: nickProof('1111', 'steve') });
  assert.equal(m.status, 200);
  assert.equal(m.json.linked, undefined);
  const f = await call('POST', '/api/phone/login', { phone: '+79001110001', proof: phoneProof('1111', '79001110001') });
  assert.equal(f.json.linked, undefined);
});

test('игрок не может звать маршруты связки и ролей', async () => {
  assert.equal((await call('PUT', '/mc/api/phone/link', linkBody('1111', '1111'), 'tokSteve')).status, 404);
  assert.equal((await call('GET', '/mc/api/phone/roles', undefined, 'tokSteve')).status, 404);
});

test('подбор PIN ника через связку не блокирует вход самого игрока', async () => {
  assert.equal((await call('PUT', '/mc/api/phone/bind', { login: 'alex', proof: nickProof('4444', 'alex'), key: 'a'.repeat(32) }, 'tokAlex')).status, 200);
  assert.equal((await call('PUT', '/api/phone/roles', { user: 'ded', mc: true }, 'tokAdmin')).status, 200);
  let last;
  for (let i = 0; i < 6; i++) {
    last = await call('PUT', '/api/phone/link', { login: 'alex', oldProof: nickProof(String(1000 + i), 'alex'), proof: nickProof('1111', 'alex'), key: K_DED }, 'tokDed');
  }
  assert.equal(last.status, 429);
  assert.equal((await call('POST', '/mc/api/phone/login', { login: 'alex', proof: nickProof('4444', 'alex') })).status, 200);
});
