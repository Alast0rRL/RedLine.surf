import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Direction,
  MatrixEventEvent,
  RoomEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { onOptimistic } from '../lib/optimistic';
import { isMessageLike, isStateNotice } from '../lib/events';
import { useThrottledVersion } from './useThrottledVersion';

const PAGE = 30;

export function useTimeline(client: MatrixClient, room: Room) {
  const [version, bump] = useThrottledVersion();
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    const roomEvents = [
      RoomEvent.Timeline,
      RoomEvent.TimelineReset,
      RoomEvent.LocalEchoUpdated,
      RoomEvent.Redaction,
      RoomEvent.Receipt,
    ] as const;
    roomEvents.forEach((e) => room.on(e as never, bump as never));
    client.on(MatrixEventEvent.Decrypted, bump);
    client.on(MatrixEventEvent.Replaced, bump);
    const offOptimistic = onOptimistic(bump);
    return () => {
      offOptimistic();
      roomEvents.forEach((e) => room.off(e as never, bump as never));
      client.off(MatrixEventEvent.Decrypted, bump);
      client.off(MatrixEventEvent.Replaced, bump);
    };
  }, [client, room, bump]);

  const events = useMemo(() => {
    const live = room.getLiveTimeline().getEvents().filter((e) => isMessageLike(e) || isStateNotice(e));
    const pending = room.getPendingEvents().filter(isMessageLike);
    return [...live, ...pending];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, version]);

  const canLoadOlder = room.getLiveTimeline().getPaginationToken(Direction.Backward) !== null;

  const loadOlder = useCallback(async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      await client.paginateEventTimeline(room.getLiveTimeline(), { backwards: true, limit: PAGE });
    } catch (e) {
      console.warn('paginate failed', e);
    } finally {
      setLoadingOlder(false);
      bump();
    }
  }, [client, room, loadingOlder, bump]);

  return { events, loadOlder, loadingOlder, canLoadOlder, version };
}

/** Прочитал ли кто-то, кроме автора, это сообщение. */
export function isReadByOthers(room: Room, ev: MatrixEvent, me: string): boolean {
  const id = ev.getId();
  if (!id) return false;
  return room.getUsersReadUpTo(ev).some((u) => u !== me);
}
