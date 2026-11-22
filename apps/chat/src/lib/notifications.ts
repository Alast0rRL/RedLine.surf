import {
  MatrixEventEvent,
  RoomEvent,
  type IRoomTimelineData,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { isMessageLike, previewText } from './events';
import { isPinUser } from './pin';
import { getPushState } from './push';

/**
 * Системные уведомления, пока вкладка жива, но скрыта — когда web push выключен.
 * Если push включён, уведомления показывает service worker, а здесь молчим, чтобы не было дублей.
 */

let currentRoomId: string | null = null;
export function setCurrentRoom(roomId: string | null): void {
  currentRoomId = roomId;
}

async function show(client: MatrixClient, ev: MatrixEvent, room: Room) {
  if (ev.getSender() === client.getUserId() || !isMessageLike(ev)) return;
  if (!document.hidden && currentRoomId === room.roomId) return;
  if (!document.hidden) return; // во вкладке видно бейдж — системное не нужно
  if (Notification.permission !== 'granted') return;
  if ((await getPushState()) === 'on') return;
  if (!client.getPushActionsForEvent(ev)?.notify) return;

  const senderId = ev.getSender()!;
  const memberName = room.getMember(senderId)?.name;
  const sender = memberName && memberName !== senderId
    ? memberName
    : isPinUser(client.getUserId()) ? 'Участник' : senderId;
  const isDm = room.getJoinedMemberCount() <= 2;
  const reg = await navigator.serviceWorker?.getRegistration();
  const title = isDm ? sender : room.name;
  const body = isDm ? previewText(ev) : `${sender}: ${previewText(ev)}`;
  const opts: NotificationOptions = {
    body,
    tag: room.roomId,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { room_id: room.roomId },
  };
  if (reg) await reg.showNotification(title, opts);
  else new Notification(title, opts);
}

export function attachForegroundNotifications(client: MatrixClient): void {
  if (!('Notification' in window)) return;
  client.on(RoomEvent.Timeline, (ev: MatrixEvent, room: Room | undefined, toStart: boolean | undefined, _removed: boolean, data: IRoomTimelineData) => {
    if (!room || toStart || !data.liveEvent) return;
    if (ev.isBeingDecrypted() || ev.shouldAttemptDecryption()) {
      ev.once(MatrixEventEvent.Decrypted, () => void show(client, ev, room));
    } else {
      void show(client, ev, room);
    }
  });
}
