/**
 * Redline push gateway — минимальный Matrix Push Gateway для Web Push.
 * Заменяет Sygnal (заархивирован в 2025).
 *
 * Homeserver → POST /_matrix/push/v1/notify → Web Push (VAPID) → service worker в браузере.
 * Спецификация: https://spec.matrix.org/latest/push-gateway-api/
 *
 * Pusher, который регистрирует клиент:
 *   kind: "http", app_id: APP_ID, pushkey: <p256dh подписки>,
 *   data: { url: <этот шлюз>/_matrix/push/v1/notify, endpoint, auth }
 *
 * Слушает только внутреннюю docker-сеть: наружу не публикуется.
 */
import http from 'node:http';
import * as webpush from 'web-push';

const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`env ${name} is required`);
  return v;
};

const PORT = Number(process.env.PORT || 8080);
const APP_ID = env('PUSH_APP_ID', 'surf.redline.chat.web');
const TTL = Number(process.env.PUSH_TTL || 60 * 60 * 24);
const MAX_BODY = 64 * 1024;

webpush.setVapidDetails(env('VAPID_SUBJECT'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));

// Только настоящие push-сервисы браузеров — шлюз не должен слать запросы куда попало
const ALLOWED_ENDPOINT_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
  /^push\.api\.chrome\.google\.com$/,
];

const proxy = process.env.PUSH_PROXY || process.env.HTTPS_PROXY || undefined;

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

function endpointAllowed(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && ALLOWED_ENDPOINT_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

/** Компактный payload (< 4 КБ). Содержимое шифрованных сообщений сервер не знает — их нет. */
function buildPayload(n) {
  const content = n.content && typeof n.content === 'object' ? n.content : {};
  const body = typeof content.body === 'string' ? content.body.slice(0, 300) : undefined;
  return JSON.stringify({
    event_id: n.event_id,
    room_id: n.room_id,
    type: n.type,
    sender: n.sender,
    sender_display_name: n.sender_display_name,
    room_name: n.room_name,
    msgtype: typeof content.msgtype === 'string' ? content.msgtype : undefined,
    voice: content['org.matrix.msc3245.voice'] !== undefined || undefined,
    body,
    unread: n.counts?.unread,
    prio: n.prio,
  });
}

async function notify(notification) {
  const rejected = [];
  const devices = Array.isArray(notification.devices) ? notification.devices : [];
  const payload = buildPayload(notification);

  await Promise.all(
    devices.map(async (d) => {
      if (d.app_id !== APP_ID) {
        rejected.push(d.pushkey);
        return;
      }
      const endpoint = d.data?.endpoint;
      const auth = d.data?.auth;
      if (!endpoint || !auth || !d.pushkey || !endpointAllowed(endpoint)) {
        log('warn', 'reject device: bad subscription data', { app_id: d.app_id });
        rejected.push(d.pushkey);
        return;
      }
      try {
        await webpush.sendNotification({ endpoint, keys: { p256dh: d.pushkey, auth } }, payload, {
          TTL,
          urgency: notification.prio === 'low' ? 'normal' : 'high',
          topic: undefined,
          proxy,
        });
      } catch (e) {
        const status = e?.statusCode;
        // подписка удалена браузером (404/410) или ключи битые — homeserver должен удалить pusher.
        // Сетевые ошибки (нет связи с FCM) подписку не отменяют.
        const badKeys = status === undefined && !e?.code && /p256dh|auth/i.test(String(e?.message));
        if (status === 404 || status === 410 || badKeys) rejected.push(d.pushkey);
        log('error', 'webpush failed', { status, host: new URL(endpoint).hostname, err: String(e?.body || e?.message || e).slice(0, 200) });
      }
    }),
  );
  return rejected;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // дочитываем впустую, чтобы ответить 413, а не оборвать соединение
        if (chunks.length) chunks.length = 0;
        reject(Object.assign(new Error('too large'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://gateway');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (url.pathname !== '/_matrix/push/v1/notify') return send(res, 404, { errcode: 'M_UNRECOGNIZED' });
  if (req.method !== 'POST') return send(res, 405, { errcode: 'M_UNRECOGNIZED' });
  try {
    const body = await readJson(req);
    if (!body?.notification) return send(res, 400, { errcode: 'M_BAD_JSON', error: 'notification missing' });
    const rejected = await notify(body.notification);
    send(res, 200, { rejected });
  } catch (e) {
    send(res, e.status || 500, { errcode: 'M_UNKNOWN', error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => log('info', 'push gateway listening', { port: PORT, app_id: APP_ID, proxy: !!proxy }));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
