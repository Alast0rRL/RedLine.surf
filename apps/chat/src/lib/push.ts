import type { MatrixClient } from 'matrix-js-sdk';
import { getConfig, getRealm, otherRealm, type Realm } from '../config';
import { loadSession } from './session';

/** Должен совпадать с PUSH_APP_ID push-шлюза. */
export const PUSH_APP_ID = 'surf.redline.chat.web';

export type PushState = 'unsupported' | 'not-configured' | 'denied' | 'off' | 'on';

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  let s = '';
  new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const { vapidPublicKey, pushGatewayUrl } = getConfig();
  if (!vapidPublicKey || !pushGatewayUrl) return 'not-configured';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Включить push: разрешение → подписка браузера → pusher на homeserver. Вызывать из жеста пользователя. */
export async function enablePush(client: MatrixClient): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const { vapidPublicKey, pushGatewayUrl } = getConfig();
  if (!vapidPublicKey || !pushGatewayUrl) return 'not-configured';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = b64urlToBytes(vapidPublicKey);
  // подписка под другим VAPID-ключом (ключи сменили) — пересоздаём
  const sameKey = sub?.options.applicationServerKey &&
    bytesToB64url(sub.options.applicationServerKey) === bytesToB64url(key.buffer);
  if (sub && !sameKey) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });

  await registerPusher(client, sub, pushGatewayUrl, getRealm());
  return 'on';
}

/** pusher этого аккаунта на его сервере; realm уходит в push, чтобы по клику открыть нужный мир. */
async function registerPusher(client: MatrixClient, sub: PushSubscription, pushGatewayUrl: string, realm: Realm): Promise<void> {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth || !json.endpoint) throw new Error('Браузер вернул неполную подписку');

  await client.setPusher({
    kind: 'http',
    app_id: PUSH_APP_ID,
    app_display_name: 'Redline Chat',
    device_display_name: client.getDeviceId() ?? 'web',
    pushkey: p256dh,
    lang: 'ru',
    data: { url: pushGatewayUrl, endpoint: json.endpoint, auth, ...(realm === 'mc' ? { realm: 'mc' } : {}) } as never,
    append: false,
  });
}

/**
 * Уведомления уже включены в браузере — тихо регистрирует pusher и для этого аккаунта
 * (второй мир того же человека). Без запроса разрешения.
 */
export async function ensurePusher(client: MatrixClient, realm: Realm): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const { vapidPublicKey, pushGatewayUrl } = getConfig();
  if (!vapidPublicKey || !pushGatewayUrl) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await registerPusher(client, sub, pushGatewayUrl, realm);
}

export async function disablePush(client: MatrixClient): Promise<PushState> {
  const reg = await navigator.serviceWorker?.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  const p256dh = sub?.toJSON().keys?.p256dh;
  if (p256dh) {
    try {
      await client.setPusher({ kind: null, app_id: PUSH_APP_ID, pushkey: p256dh } as never);
    } catch (e) {
      console.warn('pusher removal failed', e);
    }
  }
  // подписка общая с другим миром: пока он открыт, отписываем только этот аккаунт
  if (!loadSession(otherRealm())) await sub?.unsubscribe();
  return getPushState();
}
