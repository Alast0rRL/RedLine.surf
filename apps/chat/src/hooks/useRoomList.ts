import { useEffect, useMemo } from 'react';
import {
  ClientEvent,
  EventType,
  KnownMembership,
  MatrixEventEvent,
  NotificationCountType,
  RoomEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { isMessageLike } from '../lib/events';
import { isRoomLeaving, isRoomPinned, roomMutedChecker } from '../lib/rooms';
import { onOptimistic } from '../lib/optimistic';
import { useThrottledVersion } from './useThrottledVersion';

export interface RoomSummary {
  room: Room;
  lastEvent: MatrixEvent | null;
  lastTs: number;
  unread: number;
  highlight: number;
  isDm: boolean;
  pinned: boolean;
  muted: boolean;
}

function lastMessage(room: Room): MatrixEvent | null {
  const events = room.getLiveTimeline().getEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    if (isMessageLike(events[i])) return events[i];
  }
  return null;
}

/** Все комнаты из m.direct одним множеством. */
function directRoomIds(client: MatrixClient): Set<string> {
  const direct = client.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>() ?? {};
  return new Set(Object.values(direct).flat());
}

/** Личный чат: помечен в m.direct или в комнате ровно двое и у неё нет имени. */
export function isDirectRoom(client: MatrixClient, room: Room, directIds: Set<string> = directRoomIds(client)): boolean {
  if (directIds.has(room.roomId)) return true;
  return room.getJoinedMemberCount() + room.getInvitedMemberCount() <= 2 && !room.currentState.getStateEvents('m.room.name', '');
}

export function useRoomList(client: MatrixClient) {
  const [version, bump] = useThrottledVersion();

  useEffect(() => {
    const events = [
      [client, ClientEvent.Room],
      [client, ClientEvent.DeleteRoom],
      [client, ClientEvent.AccountData],
      [client, RoomEvent.Timeline],
      [client, RoomEvent.Name],
      [client, RoomEvent.Tags],
      [client, RoomEvent.Receipt],
      [client, RoomEvent.UnreadNotifications],
      [client, RoomEvent.MyMembership],
      [client, RoomEvent.LocalEchoUpdated],
      [client, MatrixEventEvent.Decrypted],
    ] as const;
    for (const [emitter, name] of events) emitter.on(name as never, bump as never);
    const offOptimistic = onOptimistic(bump);
    return () => {
      offOptimistic();
      for (const [emitter, name] of events) emitter.off(name as never, bump as never);
    };
  }, [client, bump]);

  return useMemo(() => {
    const joined: RoomSummary[] = [];
    const invites: Room[] = [];
    const directIds = directRoomIds(client);
    const isMuted = roomMutedChecker(client);
    for (const room of client.getVisibleRooms()) {
      const membership = room.getMyMembership();
      if (membership === KnownMembership.Invite) {
        invites.push(room);
        continue;
      }
      if (membership !== KnownMembership.Join || isRoomLeaving(room.roomId)) continue;
      const lastEvent = lastMessage(room);
      joined.push({
        room,
        lastEvent,
        lastTs: lastEvent?.getTs() ?? room.getLastActiveTimestamp() ?? 0,
        unread: room.getUnreadNotificationCount(NotificationCountType.Total),
        highlight: room.getUnreadNotificationCount(NotificationCountType.Highlight),
        isDm: isDirectRoom(client, room, directIds),
        pinned: isRoomPinned(room),
        muted: isMuted(room.roomId),
      });
    }
    joined.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastTs - a.lastTs);
    const totalUnread = joined.reduce((n, r) => (r.muted ? n : n + r.unread), 0);
    return { rooms: joined, invites, totalUnread };
    // version — триггер пересчёта по событиям SDK
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, version]);
}
