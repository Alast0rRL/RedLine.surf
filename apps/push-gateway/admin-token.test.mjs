// node --test apps/push-gateway/admin-token.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAdminTokenIssuer } from './admin-token.mjs';

test('invite tokens are issued and revoked with admin room commands', async () => {
  const commands = [];
  const hs = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://gateway');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    assert.equal(req.headers.authorization, 'Bearer admin-secret');
    if (u.pathname === '/_matrix/client/v3/account/whoami') return send(200, { user_id: '@admin:test' });
    if (u.pathname === '/_matrix/client/v3/directory/room/%23admins%3Atest') return send(200, { room_id: '!admins:test' });
    if (u.pathname === '/_matrix/client/v3/rooms/!admins%3Atest/messages') {
      if (u.searchParams.get('dir') === 'b') return send(200, { start: 's0', end: 's1', chunk: [] });
      const last = commands.at(-1);
      if (!last) return send(200, { chunk: [], start: 's0' });
      return send(200, {
        chunk: [{ sender: '@conduit:test', event_id: '$reply', content: { body: last.reply, 'm.relates_to': { 'm.in_reply_to': { event_id: last.eventId } } } }],
      });
    }
    if (u.pathname.startsWith('/_matrix/client/v3/rooms/!admins%3Atest/send/m.room.message/')) {
      const body = JSON.parse(raw);
      const eventId = `$e${commands.length + 1}`;
      const reply = body.body.startsWith('!admin token issue')
        ? 'New registration token issued: `AbcDEF1234567890`'
        : 'Token revoked successfully.';
      commands.push({ ...body, eventId, reply });
      return send(200, { event_id: eventId });
    }
    return send(404, { errcode: 'M_UNRECOGNIZED' });
  });
  await new Promise((r) => hs.listen(0, '127.0.0.1', r));
  try {
    const issuer = createAdminTokenIssuer({
      homeserverUrl: `http://127.0.0.1:${hs.address().port}`,
      accessToken: 'admin-secret',
      pollMs: 5,
    });
    assert.ok(issuer);
    assert.equal(await issuer.issue(), 'AbcDEF1234567890');
    assert.equal(await issuer.revoke('AbcDEF1234567890'), true);
    assert.deepEqual(commands.map((c) => c.body), ['!admin token issue --once', '!admin token revoke AbcDEF1234567890']);
    assert.equal(createAdminTokenIssuer({ homeserverUrl: 'http://x', accessToken: '' }), null);
  } finally {
    await new Promise((r) => hs.close(r));
  }
});
