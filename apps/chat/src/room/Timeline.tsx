import { Fragment, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { EventType, NotificationCountType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useTimeline, isReadByOthers } from '../hooks/useTimeline';
import { formatDay, formatDuration, isStateNotice, sameDay } from '../lib/events';
import { uploadStore } from '../lib/uploads';
import { Button, Icon } from '../components/ui';
import { Message, messageStamp } from './Message';

const GROUP_GAP_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 120;

function stateText(ev: MatrixEvent): string | null {
  const name = ev.sender?.name ?? ev.getSender();
  const c = ev.getContent();
  switch (ev.getType()) {
    case EventType.RoomCreate:
      return 'Чат создан';
    case EventType.RoomEncryption:
      return '🔒 Сообщения защищены сквозным шифрованием';
    case EventType.RoomName:
      return c.name ? `${name} переименовал(а) чат в «${c.name}»` : null;
    case EventType.RoomMember: {
      const prev = ev.getPrevContent().membership;
      const target = c.displayname ?? ev.getStateKey();
      if (c.membership === 'invite') return `${name} пригласил(а) ${target}`;
      if (c.membership === 'join' && prev !== 'join') return `${target} в чате`;
      if (c.membership === 'leave' && ev.getStateKey() === ev.getSender()) return prev === 'invite' ? `${target} отклонил(а) приглашение` : `${target} вышел(а)`;
      if (c.membership === 'leave') return `${name} исключил(а) ${target}`;
      return null; // смена имени/аватара — шум
    }
    default:
      return null;
  }
}

function markRead(client: MatrixClient, room: Room, last: MatrixEvent, me: string) {
  // бейдж гасим сразу, не дожидаясь, пока сервер пришлёт новые счётчики в sync
  if (room.getUnreadNotificationCount(NotificationCountType.Total) > 0) {
    room.setUnreadNotificationCount(NotificationCountType.Total, 0);
    room.setUnreadNotificationCount(NotificationCountType.Highlight, 0);
  }
  if (last.getSender() !== me && !room.hasUserReadEvent(me, last.getId()!)) client.sendReadReceipt(last).catch(() => {});
}

function Uploads({ roomId }: { roomId: string }) {
  const all = useSyncExternalStore(uploadStore.subscribe, uploadStore.get);
  const list = all.filter((u) => u.roomId === roomId);
  if (list.length === 0) return null;
  return (
    <>
      {list.map((u) => (
        <div key={u.id} className="msg msg--own msg--first msg--last">
          <div className={`bubble bubble--upload${u.kind === 'image' ? ' bubble--media' : ''}`}>
            {u.kind === 'image' && u.previewUrl && <img className="upload-preview" src={u.previewUrl} alt="" />}
            {u.kind === 'voice' && (
              <div className="upload-voice"><Icon name="mic" size={16} /> Голосовое · {formatDuration(u.durationMs ?? 0)}</div>
            )}
            {u.error ? (
              <div className="msg-status msg-status--failed">
                <Icon name="alert" size={14} /> {u.error}
                {u.retry && <button type="button" onClick={u.retry}>Повторить</button>}
                <button type="button" onClick={() => uploadStore.remove(u.id)} aria-label="Удалить"><Icon name="trash" size={14} /></button>
              </div>
            ) : (
              <div className="upload-progress" role="progressbar" aria-valuenow={Math.round(u.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${Math.max(4, u.progress * 100)}%` }} />
              </div>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

export function Timeline({ client, room }: { client: MatrixClient; room: Room }) {
  const { events, loadOlder, loadingOlder, canLoadOlder, version } = useTimeline(client, room);
  const me = client.getUserId()!;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // прилипать к низу при новых сообщениях
  const prevHeight = useRef(0);
  const loadingOlderRef = useRef(false);
  const isGroup = room.getJoinedMemberCount() > 2;

  // позиция прокрутки: внизу — держим низ; подгрузили старое — сохраняем место
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (loadingOlderRef.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      loadingOlderRef.current = false;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevHeight.current = el.scrollHeight;
  }, [version, events.length]);

  // пусто или мало сообщений — сразу подгружаем историю
  useEffect(() => {
    if (events.length < 15 && canLoadOlder && !loadingOlder) {
      loadingOlderRef.current = true;
      prevHeight.current = scroller.current?.scrollHeight ?? 0;
      void loadOlder();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.roomId, events.length < 15]);

  // квитанция о прочтении последнего сообщения, когда чат открыт и виден
  useEffect(() => {
    const last = [...events].reverse().find((e) => e.getId()?.startsWith('$'));
    if (last && !document.hidden) markRead(client, room, last, me);
  }, [client, room, events, me]);

  useEffect(() => {
    const onVisible = () => {
      const last = room.getLiveTimeline().getEvents().at(-1);
      if (last && !document.hidden) markRead(client, room, last, me);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [client, room, me]);

  // своё сообщение — всегда прокручиваем вниз
  useEffect(() => {
    const onSent = () => {
      stick.current = true;
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    window.addEventListener('rl:sent', onSent);
    return () => window.removeEventListener('rl:sent', onSent);
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (el.scrollTop < 300 && canLoadOlder && !loadingOlder) {
      loadingOlderRef.current = true;
      prevHeight.current = el.scrollHeight;
      void loadOlder();
    }
  };

  // последнее своё сообщение, прочитанное другими — для галочек
  const lastReadOwnIdx = (() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.getSender() === me && e.getId()?.startsWith('$') && isReadByOthers(room, e, me)) return i;
    }
    return -1;
  })();

  return (
    <div className="timeline" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
      <div className="timeline__inner">
        {canLoadOlder ? (
          <div className="timeline__older">
            {loadingOlder ? <span className="rl-spinner" /> : <Button size="sm" variant="ghost" onClick={() => void loadOlder()}>Загрузить ещё</Button>}
          </div>
        ) : (
          <div className="timeline__start">Начало переписки</div>
        )}
        {events.map((ev, i) => {
          const prev = events[i - 1];
          const next = events[i + 1];
          const newDay = !prev || !sameDay(prev.getTs(), ev.getTs());
          const dayEl = newDay ? <div className="day-sep"><span>{formatDay(ev.getTs())}</span></div> : null;

          if (isStateNotice(ev)) {
            const text = stateText(ev);
            return text ? <Fragment key={ev.getId() ?? i}>{dayEl}<div className="state-notice">{text}</div></Fragment> : dayEl && <Fragment key={ev.getId() ?? i}>{dayEl}</Fragment>;
          }

          const sameAsPrev = prev && !isStateNotice(prev) && prev.getSender() === ev.getSender() && ev.getTs() - prev.getTs() < GROUP_GAP_MS && !newDay;
          const sameAsNext = next && !isStateNotice(next) && next.getSender() === ev.getSender() && next.getTs() - ev.getTs() < GROUP_GAP_MS && sameDay(next.getTs(), ev.getTs());
          const own = ev.getSender() === me;
          const readByOthers = own && i <= lastReadOwnIdx;
          return (
            <Fragment key={ev.getTxnId() ?? ev.getId() ?? i}>
              {dayEl}
              <Message
                client={client}
                room={room}
                ev={ev}
                own={own}
                first={!sameAsPrev}
                last={!sameAsNext}
                showSenderName={isGroup}
                readByOthers={readByOthers}
                stamp={messageStamp(ev) + (readByOthers ? 'r' : '')}
              />
            </Fragment>
          );
        })}
        <Uploads roomId={room.roomId} />
      </div>
    </div>
  );
}
