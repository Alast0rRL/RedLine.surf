/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

/* ---------- офлайн-оболочка ---------- */
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
// config.json не кешируем — он должен меняться вместе с .env на сервере
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/config\.json$/] }));

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

/* ---------- push ---------- */
interface PushPayload {
  event_id?: string;
  room_id?: string;
  type?: string;
  sender?: string;
  sender_display_name?: string;
  room_name?: string;
  msgtype?: string;
  voice?: boolean;
  body?: string;
  unread?: number;
}

function describe(p: PushPayload): string {
  // в E2E-комнатах сервер не знает текста — показываем общий
  if (p.type === 'm.room.encrypted') return 'Новое сообщение';
  if (p.voice) return '🎤 Голосовое сообщение';
  switch (p.msgtype) {
    case 'm.image': return '📷 Фото';
    case 'm.audio': return '🎵 Аудио';
    case 'm.file': return '📎 Файл';
    case 'm.video': return '🎬 Видео';
    default: return p.body || 'Новое сообщение';
  }
}

function plural(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? 'новое сообщение' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'новых сообщения' : 'новых сообщений';
  return `${n} ${word}`;
}

self.addEventListener('push', (event) => {
  let p: PushPayload = {};
  try {
    p = event.data?.json() ?? {};
  } catch {
    /* пустой push — просто покажем общее уведомление */
  }

  event.waitUntil(
    (async () => {
      const nav = self.navigator as WorkerNavigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
      if (typeof p.unread === 'number') {
        await (p.unread > 0 ? nav.setAppBadge?.(p.unread) : nav.clearAppBadge?.())?.catch(() => {});
      }
      // счётчик обнулился (прочитали на другом устройстве) — убираем уведомления
      if (!p.event_id) {
        if (p.unread === 0) (await self.registration.getNotifications()).forEach((n) => n.close());
        return;
      }
      // приложение открыто и видно — оно само покажет новое
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (windows.some((w) => w.visibilityState === 'visible' && w.focused)) return;

      const isGroup = p.room_name && p.sender_display_name && p.room_name !== p.sender_display_name;
      const title = (isGroup ? p.room_name : p.sender_display_name || p.room_name) || 'Redline';
      const preview = isGroup ? `${p.sender_display_name}: ${describe(p)}` : describe(p);
      // несколько сообщений в одну комнату, пока её не открыли: «N новых сообщений» + последнее
      let count = 1;
      try {
        const previous = p.room_id ? await self.registration.getNotifications({ tag: p.room_id }) : [];
        const prev = previous[0];
        const pd = prev?.data as { count?: number; ts?: number } | null | undefined;
        if (pd && Date.now() - (pd.ts ?? 0) < 6 * 3600_000) {
          count = (pd.count ?? 1) + 1;
        }
      } catch {
        /* не вышло посчитать — покажем как одно */
      }
      const body = count > 1 ? `${plural(count)} · ${preview}` : preview;
      await self.registration.showNotification(title, {
        body,
        tag: p.room_id,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: { room_id: p.room_id, count, ts: Date.now() },
        // renotify есть в браузерах, но не в типах TS
        ...({ renotify: true } as object),
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const roomId: string | undefined = event.notification.data?.room_id;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // только окна нашего приложения; предпочитаем то, что в фокусе, затем видимое
      const windows = all.filter((w) => w.url.startsWith(self.location.origin));
      const win = windows.find((w) => w.focused) ?? windows.find((w) => w.visibilityState === 'visible') ?? windows[0];
      if (win) {
        try {
          await win.focus();
          if (roomId) win.postMessage({ type: 'open-room', roomId });
          return;
        } catch {
          /* окно не удалось поднять — откроем новое */
        }
      }
      await self.clients.openWindow(roomId ? `/#/room/${encodeURIComponent(roomId)}` : '/');
    })(),
  );
});
