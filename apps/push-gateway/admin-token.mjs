import crypto from 'node:crypto';

const TOKEN_RE = /^[A-Za-z0-9]{16}$/;
const REQUEST_TIMEOUT_MS = 15_000;
const REPLY_TIMEOUT_MS = 20_000;
const POLL_MS = 700;

export function createAdminTokenIssuer({
  homeserverUrl,
  accessToken,
  room = '',
  log = () => undefined,
  fetchImpl = fetch,
  pollMs = POLL_MS,
} = {}) {
  if (!accessToken) return null;
  const base = String(homeserverUrl).replace(/\/+$/, '');
  let roomId = room && !room.startsWith('#') ? room : null;
  let queue = Promise.resolve();

  const request = async (path, method = 'GET', body) => {
    let r;
    try {
      r = await fetchImpl(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw Object.assign(new Error('homeserver unavailable'), { status: 502 });
    }
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  const resolveRoom = async () => {
    if (roomId) return roomId;
    let target = room;
    if (!target) {
      const who = await request('/_matrix/client/v3/account/whoami');
      const server = String(who.data.user_id ?? '').split(':')[1];
      if (!server) throw Object.assign(new Error('admin server unknown'), { status: 500 });
      target = `#admins:${server}`;
    }
    if (target.startsWith('#')) {
      const r = await request(`/_matrix/client/v3/directory/room/${encodeURIComponent(target)}`);
      if (r.status !== 200 || !r.data.room_id) throw Object.assign(new Error('admin room not found'), { status: 502 });
      roomId = r.data.room_id;
    } else {
      roomId = target;
    }
    return roomId;
  };

  async function command(text, parse) {
    const rid = await resolveRoom();
    const enc = encodeURIComponent(rid);
    const before = await request(`/_matrix/client/v3/rooms/${enc}/messages?dir=b&limit=1`);
    const from = before.data.start ?? before.data.end;
    if (!from) throw Object.assign(new Error('admin room history unavailable'), { status: 502 });
    const txn = crypto.randomBytes(8).toString('hex');
    const sent = await request(`/_matrix/client/v3/rooms/${enc}/send/m.room.message/${txn}`, 'PUT', {
      msgtype: 'm.text',
      body: text,
    });
    const eventId = sent.data.event_id;
    if (!eventId) throw Object.assign(new Error('admin command not sent'), { status: 502 });
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    for (;;) {
      const page = await request(
        `/_matrix/client/v3/rooms/${enc}/messages?dir=f&limit=100&from=${encodeURIComponent(String(from))}`,
      );
      const events = Array.isArray(page.data.chunk) ? page.data.chunk : [];
      for (const ev of events) {
        if (String(ev.sender ?? '').replace(/^@/, '').split(':')[0] !== 'conduit') continue;
        const body = typeof ev.content?.body === 'string' ? ev.content.body : '';
        const reply = ev.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
        if (reply && reply !== eventId) continue;
        const value = parse(body);
        if (value) return value;
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    log('warn', 'admin command reply timeout');
    throw Object.assign(new Error('admin command timeout'), { status: 502 });
  }

  const serialized = (fn) => {
    const result = queue.then(fn, fn);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    issue: () =>
      serialized(async () => {
        const token = await command('!admin token issue --once', (body) =>
          /New registration token issued:\s*`([A-Za-z0-9]{16})`/.exec(body)?.[1],
        );
        if (!token || !TOKEN_RE.test(token)) throw Object.assign(new Error('bad registration token'), { status: 502 });
        return token;
      }),
    revoke: (token) =>
      serialized(async () => {
        if (!TOKEN_RE.test(token)) return false;
        await command(`!admin token revoke ${token}`, (body) =>
          /^Token revoked successfully\./.test(body.trim()) ? true : null,
        );
        return true;
      }),
  };
}
