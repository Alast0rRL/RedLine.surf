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
const proof = (pin, phone) => crypto.pbkdf2Sync(pin, 'redline-phone-v1\n' + phone, 1000, 32, 'sha256').toString('hex');

let hs, gw, base, dir, dbFile;
let next = 0;
const issued = [];
const revoked = [];
const tokenIssuer = {
  async issue() {
    const token = 'T' + String(next++).padStart(15, '0');
    issued.push(token);
    return token;
  },
  async revoke(token) {
    revoked.push(token);
    return true;
  },
};

async function call(method, route, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}

const create = (name, user, token) => call('POST', '/api/invites/', { name, user }, token);

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invites-test-'));
  dbFile = path.join(dir, 'phones.json');
  process.env.PHONE_PEPPER = PEPPER;
  const hsUrl = `http://127.0.0.1:${hs.address().port}`;
  const fam = createPhoneApi({ dbPath: dbFile, homeserverUrl: hsUrl, log: () => undefined, inviteIssuer: tokenIssuer });
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

const db = () => JSON.parse(fs.readFileSync(dbFile, 'utf8'));

test('invites need a valid bearer token; mc realm has no invites', async () => {
  assert.equal((await call('GET', '/api/invites/')).status, 401);
  assert.equal((await create('Мама', 'mama', 'bad')).status, 401);
  assert.equal((await call('GET', '/mc/api/invites/', null, 'tokAlice')).status, 404);
});

test('member creates invite; invitedBy is recorded', async () => {
  const r = await create('Мама', 'mama', 'tokAlice');
  assert.equal(r.status, 200);
  assert.equal(r.json.invitedBy, 'alice');
  assert.match(r.json.token, /^T\d{15}$/);
  assert.equal(db()[`invite:${r.json.token}`].invitedBy, 'alice');
  const list = await call('GET', '/api/invites/', null, 'tokAlice');
  assert.equal(list.json.invites.length, 1);
  assert.equal(list.json.invites[0].invitedBy, 'alice');
  assert.equal(list.json.guest, false);
});

test('revoke only own invites; admin sees all', async () => {
  const mine = await create('Папа', 'papa', 'tokBob');
  assert.equal(mine.status, 200);
  const other = db();
  const aliceToken = Object.values(other).find((r) => r.invitedBy === 'alice' && !r.claimedAt).token;
  assert.equal((await call('DELETE', `/api/invites/revoke/${aliceToken}`, null)).status, 401);
  assert.equal((await call('DELETE', `/api/invites/revoke/${aliceToken}`, null, 'tokBob')).status, 403);
  assert.equal((await call('DELETE', `/api/invites/revoke/${aliceToken}`, null, 'tokAdmin')).status, 200);
  assert.ok(revoked.includes(aliceToken));
  const all = await call('GET', '/api/invites/', null, 'tokAdmin');
  assert.ok(all.json.invites.some((i) => i.invitedBy === 'bob'));
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

test('first registration marks guest; guests cannot invite', async () => {
  const inv = await create('Гость', 'guest', 'tokAlice');
  assert.equal(inv.status, 200);
  const claim = await call('POST', '/api/invites/claim', { token: inv.json.token, user: 'guest' }, 'tokGuest');
  assert.equal(claim.status, 200);
  assert.equal(claim.json.invitedBy, 'alice');
  const key = crypto.createHmac('sha256', PEPPER).update('guest').digest('hex');
  assert.equal(db()[key].guest, true);
  assert.equal(db()[key].invitedBy, 'alice');
  const me = await call('GET', '/api/invites/', null, 'tokGuest');
  assert.equal(me.json.guest, true);
  assert.equal((await create('Друг', 'drug', 'tokGuest')).status, 403);
  assert.equal((await call('POST', '/api/invites/claim', { token: inv.json.token, user: 'guest' }, 'tokAlice')).status, 403);
});

test('guest record survives phone binding; admin lists guests and promotes them', async () => {
  const phone = '79009998877';
  assert.equal((await call('PUT', '/api/phone/bind', { phone, proof: proof('123456', phone), key: KEY }, 'tokGuest')).status, 200);
  const guests = await call('GET', '/api/invites/guests', null, 'tokAdmin');
  assert.ok(guests.json.guests.some((g) => g.user === 'guest' && g.invitedBy === 'alice'));
  assert.equal((await call('GET', '/api/invites/guests', null, 'tokAlice')).status, 403);
  assert.equal((await call('POST', '/api/invites/promote', { user: 'guest' }, 'tokAlice')).status, 403);
  assert.equal((await call('POST', '/api/invites/promote', { user: 'guest' }, 'tokAdmin')).status, 200);
  const after = await call('GET', '/api/invites/guests', null, 'tokAdmin');
  assert.ok(!after.json.guests.some((g) => g.user === 'guest'));
  const rec = Object.values(db()).find((r) => r.user === 'guest');
  assert.equal(rec.guest, undefined);
  assert.equal(rec.mcAllowed, undefined);
});
