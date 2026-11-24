// node --test apps/push-gateway/invites.test.mjs
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createPhoneApi } from './phone.mjs';

const TOKENS = {
  tokAlice: '@alice:fam',
  tokBob: '@bob:fam',
  tokCarl: '@carl:fam',
  tokGuest: '@guest:fam',
  tokAdmin: '@admin:fam',
};
const KEY = 'a'.repeat(32);
const PEPPER = 'invite-test-pepper';
const SECRET = 'family-secret-token';
const PASSWORD = 'c'.repeat(64);
const proof = (pin, login) => crypto.pbkdf2Sync(pin, 'redline-phone-v1\n' + login, 1000, 32, 'sha256').toString('hex');
const dbKey = (login) => crypto.createHmac('sha256', PEPPER).update('login:' + login).digest('hex');

let hs, gw, base, dir, dbFile, hsUrl;
const registrations = [];

async function call(method, route, body, token, ip) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (ip) headers['x-real-ip'] = ip;
  const r = await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}

const create = (name, user, token) => call('POST', '/api/invites/', { name, user }, token);
const check = (code) => call('GET', `/api/invites/check?code=${encodeURIComponent(code)}`);
const register = (body, ip) => call('POST', '/api/invites/register', body, undefined, ip);
const db = () => JSON.parse(fs.readFileSync(dbFile, 'utf8'));

before(async () => {
  hs = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://gateway');
    const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === '/_matrix/client/v3/account/whoami' && TOKENS[t]) return send(200, { user_id: TOKENS[t] });
    if (u.pathname.startsWith('/_matrix/client/v3/profile/') && req.method === 'GET') {
      const names = { '@alice:fam': 'Алиса', '@bob:fam': 'Боб' };
      return send(200, { displayname: names[decodeURIComponent(u.pathname.split('/')[5])] ?? '' });
    }
    if (u.pathname.startsWith('/_matrix/client/v3/profile/') && req.method === 'PUT') return send(200, {});
    if (u.pathname === '/_matrix/client/v3/register') {
      const body = JSON.parse(raw || '{}');
      if (body.auth) {
        if (body.auth.type !== 'm.login.registration_token' || body.auth.token !== SECRET) {
          return send(403, { errcode: 'M_FORBIDDEN' });
        }
        if (registrations.includes(body.username)) return send(409, { errcode: 'M_USER_IN_USE' });
        registrations.push(body.username);
        TOKENS['tok-reg-' + body.username] = `@${body.username}:fam`;
        return send(200, {
          access_token: 'tok-reg-' + body.username,
          user_id: `@${body.username}:fam`,
          device_id: 'dev-' + body.username,
        });
      }
      return send(401, {
        session: 'uiaa-session',
        flows: [{ stages: ['m.login.registration_token'] }],
      });
    }
    return send(401, { errcode: 'M_UNKNOWN_TOKEN' });
  });
  await new Promise((r) => hs.listen(0, '127.0.0.1', r));
  hsUrl = `http://127.0.0.1:${hs.address().port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invites-test-'));
  dbFile = path.join(dir, 'phones.json');
  process.env.PHONE_PEPPER = PEPPER;
  const fam = createPhoneApi({ dbPath: dbFile, homeserverUrl: hsUrl, log: () => undefined, registrationToken: SECRET, regLimit: 100 });
  const mc = createPhoneApi({ dbPath: path.join(dir, 'mc.json'), homeserverUrl: hsUrl, log: () => undefined, mode: 'login', prefix: '/mc/api/phone/' });
  gw = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway');
    if (await fam(req, res, url)) return;
    if (await mc(req, res, url)) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gw.address().port}`;
});

after(() => {
  gw?.close();
  hs?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.PHONE_PEPPER;
});

test('invites need a valid bearer token; mc realm has no invites', async () => {
  assert.equal((await call('GET', '/api/invites/')).status, 401);
  assert.equal((await create('Мама', 'mama', 'bad')).status, 401);
  assert.equal((await call('GET', '/mc/api/invites/', null, 'tokAlice')).status, 404);
  assert.equal((await check('short')).json.valid, false);
});

test('member creates invite with a gateway code; invitedBy and inviter name are recorded', async () => {
  const r = await create('Мама', 'mama', 'tokAlice');
  assert.equal(r.status, 200);
  assert.equal(r.json.invitedBy, 'alice');
  assert.match(r.json.token, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(r.json.expiresAt - r.json.createdAt, 7 * 24 * 60 * 60 * 1000);
  assert.equal(db()[`invite:${r.json.token}`].invitedBy, 'alice');
  assert.equal(db()[`invite:${r.json.token}`].invitedByName, 'Алиса');
  const list = await call('GET', '/api/invites/', null, 'tokAlice');
  assert.equal(list.json.invites.length, 1);
  assert.equal(list.json.invites[0].token, r.json.token);
  assert.equal(list.json.guest, false);
});

test('public check reports validity, label and inviter without secrets', async () => {
  const inv = await create('Папа', 'papa', 'tokBob');
  const good = await check(inv.json.token);
  assert.equal(good.status, 200);
  assert.equal(good.json.valid, true);
  assert.equal(good.json.name, 'Папа');
  assert.equal(good.json.login, 'papa');
  assert.equal(good.json.inviter, 'Боб');
  assert.equal(good.json.invitedBy, 'bob');
  assert.equal(good.json.token, undefined);
  assert.equal((await check('не-код')).json.valid, false);
  assert.equal((await check('T000000000000000')).json.valid, false);
});

test('revoke only own invites; admin sees and revokes all; guests cannot manage invites', async () => {
  const guestInvite = await create('Гость', 'guest', 'tokAlice');
  assert.equal((await call('POST', '/api/invites/claim', { token: guestInvite.json.token, user: 'guest' }, 'tokGuest')).status, 200);
  const mine = await create('Папа', 'papa2', 'tokBob');
  const alice = await create('Тётя', 'tetya', 'tokAlice');
  assert.equal((await call('DELETE', `/api/invites/revoke/${alice.json.token}`)).status, 401);
  assert.equal((await call('DELETE', `/api/invites/revoke/${alice.json.token}`, null, 'tokBob')).status, 403);
  assert.equal((await call('POST', '/api/invites/', { name: 'Друг', user: 'drug' }, 'tokGuest')).status, 403);
  assert.equal((await call('DELETE', `/api/invites/revoke/${alice.json.token}`, null, 'tokGuest')).status, 403);
  assert.equal((await call('DELETE', `/api/invites/revoke/${alice.json.token}`, null, 'tokAdmin')).status, 200);
  assert.equal((await check(alice.json.token)).json.valid, false);
  const all = await call('GET', '/api/invites/', null, 'tokAdmin');
  assert.ok(all.json.invites.some((i) => i.invitedBy === 'bob' && i.token === mine.json.token));
  const bob = await call('GET', '/api/invites/', null, 'tokBob');
  assert.ok(bob.json.invites.every((i) => i.invitedBy === 'bob'));
  assert.deepEqual(bob.json.guests, []);
});

test('limits: 5 active invites and 10 created per day per member', async () => {
  const created = [];
  for (let i = 0; i < 5; i++) {
    const r = await create('Гость' + i, 'guest' + i, 'tokCarl');
    assert.equal(r.status, 200);
    created.push(r.json.token);
  }
  const active = await create('Шестой', 'sixth', 'tokCarl');
  assert.equal(active.status, 429);
  for (let i = 5; i < 10; i++) {
    assert.equal((await call('DELETE', `/api/invites/revoke/${created[i - 5]}`, null, 'tokCarl')).status, 200);
    const r = await create('Гость' + i, 'guest' + i, 'tokCarl');
    assert.equal(r.status, 200);
    created.push(r.json.token);
  }
  const daily = await create('Одиннадцатый', 'eleventh', 'tokCarl');
  assert.equal(daily.status, 429);
  assert.match(daily.json.error, /Дневной/);
});

test('register rejects bad, revoked, used and expired codes', async () => {
  const bad = await register({ code: 'k'.repeat(24), login: 'newone', name: 'Новый', password: PASSWORD }, 'ip-bad');
  assert.equal(bad.status, 404);
  assert.match(bad.json.error, /Ссылка недействительна/);

  const revoked = await create('Отозван', 'revokedone', 'tokAlice');
  assert.equal((await call('DELETE', `/api/invites/revoke/${revoked.json.token}`, null, 'tokAlice')).status, 200);
  assert.equal((await register({ code: revoked.json.token, login: 'revokedone', name: 'X', password: PASSWORD }, 'ip-bad')).status, 404);

  const expired = await create('Старый', 'expiredone', 'tokAlice');
  const realNow = Date.now;
  Date.now = () => realNow() + 8 * 24 * 60 * 60 * 1000;
  try {
    assert.equal((await check(expired.json.token)).json.valid, false);
    assert.equal((await register({ code: expired.json.token, login: 'expiredone', name: 'X', password: PASSWORD }, 'ip-bad')).status, 404);
  } finally {
    Date.now = realNow;
  }

  const inv = await create('Гость', 'guestvip', 'tokAlice');
  const badLogin = await register({ code: inv.json.token, login: 'bad login!', name: 'X', password: PASSWORD }, 'ip-bad');
  assert.equal(badLogin.status, 400);
  const badPass = await register({ code: inv.json.token, login: 'guestvip', name: 'X', password: 'short' }, 'ip-bad');
  assert.equal(badPass.status, 400);
  assert.equal((await check(inv.json.token)).json.valid, true);
});

test('register creates guest account, marks code used and binds login+PIN', async () => {
  const inv = await create('Гость', 'guestvip', 'tokAlice');
  const before = registrations.length;
  const r = await register(
    { code: inv.json.token, login: 'guestvip', name: 'Гость', password: PASSWORD },
    'ip-guest',
  );
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.login, 'guestvip');
  assert.equal(r.json.invitedBy, 'alice');
  assert.ok(r.json.access_token && r.json.user_id && r.json.device_id);
  assert.equal(registrations.length, before + 1);
  assert.equal(db()[`invite:${inv.json.token}`].usedBy, 'guestvip');
  assert.ok(db()[`invite:${inv.json.token}`].usedAt);
  assert.equal((await check(inv.json.token)).json.valid, false);
  const again = await register({ code: inv.json.token, login: 'guestvip2', name: 'X', password: PASSWORD }, 'ip-guest');
  assert.equal(again.status, 404);

  const guest = db()[dbKey('guestvip')];
  assert.equal(guest.guest, true);
  assert.equal(guest.invitedBy, 'alice');
  assert.equal(guest.inviteName, 'Гость');

  const pinProof = proof('1234', 'guestvip');
  const bound = await call('PUT', '/api/phone/bind', { login: 'guestvip', proof: pinProof, key: KEY, name: 'Гость' }, r.json.access_token);
  assert.equal(bound.status, 200);
  const afterBind = db()[dbKey('guestvip')];
  assert.equal(afterBind.guest, true);
  assert.equal(afterBind.invitedBy, 'alice');
  const signedIn = await call('POST', '/api/phone/login', { login: 'guestvip', proof: pinProof });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.json.user, 'guestvip');
  assert.equal(signedIn.json.key, KEY);
  assert.equal((await create('Друг', 'drug', 'tok-reg-guestvip')).status, 403);
  const guests = await call('GET', '/api/invites/guests', null, 'tokAdmin');
  assert.ok(guests.json.guests.some((g) => g.user === 'guestvip' && g.invitedBy === 'alice'));
});

test('admin promotes a registered guest; promoted guest can invite', async () => {
  assert.equal((await call('POST', '/api/invites/promote', { user: 'guestvip' }, 'tokAlice')).status, 403);
  assert.equal((await call('POST', '/api/invites/promote', { user: 'guestvip' }, 'tokAdmin')).status, 200);
  assert.equal(db()[dbKey('guestvip')].guest, undefined);
  assert.equal((await create('Сестра', 'sestra', 'tok-reg-guestvip')).status, 200);
});

test('registration is rate limited per IP', async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'invites-reg-limit-'));
  const limited = createPhoneApi({ dbPath: path.join(dir2, 'phones.json'), homeserverUrl: hsUrl, log: () => undefined, registrationToken: SECRET });
  const gw2 = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway');
    if (await limited(req, res, url)) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => gw2.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${gw2.address().port}`;
  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(root + '/api/invites/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': 'limit-ip' },
        body: JSON.stringify({ code: 'z'.repeat(24), login: 'user' + i, name: 'X', password: PASSWORD }),
      });
      statuses.push(r.status);
      await r.arrayBuffer();
    }
    assert.deepEqual(statuses, [404, 404, 404, 404, 404, 429]);
  } finally {
    await new Promise((r) => gw2.close(r));
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});
