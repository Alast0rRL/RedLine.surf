import { Fragment, useCallback, useMemo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { EventType, NotificationCountType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useTimeline, isReadByOthers } from '../hooks/useTimeline';
import { formatDay, formatDuration, isStateNotice, sameDay } from '../lib/events';
import { getReactions, reactionsStamp, type ReactionSummary } from '../lib/messageActions';
import { isPinUser } from '../lib/pin';
import { uploadStore } from '../lib/uploads';
import { Button, Icon } from '../components/ui';
import { FileGlyph, formatSize } from './FileMessage';
import { Message, messageStamp } from './Message';
import { DeleteDialog, ForwardDialog, MessageMenu, type MenuPoint } from './MessageMenu';
import './room.css';

const GROUP_GAP_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 120;
/** Сколько последних событий рисуем; растёт при прокрутке вверх. */
const WINDOW = 150;
const WINDOW_STEP = 100;
const NO_REACTIONS: ReactionSummary[] = [];
const isMessageEvent = (e: MatrixEvent) => !isStateNotice(e);

function stateText(ev: MatrixEvent, pin: boolean): string | null {
  const name = ev.sender?.name ?? (pin ? 'Участник' : ev.getSender());
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
      const target = c.displayname ?? (pin ? 'участник' : ev.getStateKey());
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

const isHidden = (ev: MatrixEvent, pin: boolean) => isStateNotice(ev) && stateText(ev, pin) === null;
function neighbour(list: MatrixEvent[], i: number, dir: 1 | -1, pin: boolean): MatrixEvent | undefined {
  for (let j = i + dir; j >= 0 && j < list.length; j += dir) if (!isHidden(list[j], pin)) return list[j];
  return undefined;
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
            {u.kind === 'file' && (
              <div className="upload-file"><FileGlyph size={18} /> <span className="upload-file__name">{u.name}</span> <span>{formatSize(u.size)}</span></div>
            )}
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

export interface TimelineProps {
  client: MatrixClient;
  room: Room;
  onReply: (ev: MatrixEvent) => void;
  onEdit: (ev: MatrixEvent) => void;
}

export function Timeline({ client, room, onReply, onEdit }: TimelineProps) {
  const { events, loadOlder, loadingOlder, canLoadOlder, version } = useTimeline(client, room);
  const me = client.getUserId()!;
  const pin = isPinUser(me);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // прилипать к низу при новых сообщениях
  const prevHeight = useRef(0);
  const loadingOlderRef = useRef(false);
  const isGroup = room.getJoinedMemberCount() > 2;

  const [limit, setLimit] = useState(WINDOW);
  useEffect(() => setLimit(WINDOW), [room.roomId]);
  const hidden = Math.max(0, events.length - limit);
  const shown = useMemo(() => (hidden > 0 ? events.slice(hidden) : events), [events, hidden]);

  // реакции считаются один раз на проход (а не дважды на сообщение при каждом обновлении)
  const reactionMap = useMemo(() => {
    const m = new Map<string, ReactionSummary[]>();
    for (const ev of shown) {
      const id = ev.getId();
      if (!id || isStateNotice(ev)) continue;
      const list = getReactions(room, ev, me);
      if (list.length) m.set(id, list);
    }
    return m;
    // version: события мутируются на месте, сам список событий может не поменяться
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, room, me, version]);

  /** Подгрузить старое: сперва показываем уже загруженное, потом тянем с сервера. */
  const growOrLoad = (el: HTMLElement | null) => {
    if (hidden > 0) {
      loadingOlderRef.current = true;
      prevHeight.current = el?.scrollHeight ?? 0;
      setLimit((l) => l + WINDOW_STEP);
    } else if (canLoadOlder && !loadingOlder) {
      loadingOlderRef.current = true;
      prevHeight.current = el?.scrollHeight ?? 0;
      void loadOlder();
    }
  };

  const [menu, setMenu] = useState<{ ev: MatrixEvent; point: MenuPoint } | null>(null);
  const [forwarding, setForwarding] = useState<MatrixEvent | null>(null);
  const [deleting, setDeleting] = useState<MatrixEvent | null>(null);
  const openMenu = useCallback((ev: MatrixEvent, point: MenuPoint) => setMenu({ ev, point }), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  // кнопка «вниз» и счётчик новых, пока лента прокручена вверх
  const [far, setFar] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const tailId = useRef<string | null>(null);

  useEffect(() => {
    const visible = events.filter(isMessageEvent);
    const last = visible.at(-1)?.getId() ?? null;
    const prevTail = tailId.current;
    tailId.current = last;
    if (!prevTail || !last || prevTail === last || stick.current) return;
    const idx = visible.findIndex((e) => e.getId() === prevTail);
    if (idx < 0) return;
    const fresh = visible.slice(idx + 1).filter((e) => e.getSender() !== me && e.getId()?.startsWith('$')).length;
    if (fresh > 0) setUnseen((n) => n + fresh);
  }, [events, me]);

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
  }, [version, shown.length]);

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
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = dist < NEAR_BOTTOM_PX;
    setFar(dist > el.clientHeight);
    if (stick.current) setUnseen(0);
    if (el.scrollTop < 300) growOrLoad(el);
  };

  const jumpToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setUnseen(0);
  };

  // последнее своё сообщение, прочитанное другими — для галочек
  const lastReadOwnIdx = (() => {
    for (let i = shown.length - 1; i >= 0; i--) {
      const e = shown[i];
      if (e.getSender() === me && e.getId()?.startsWith('$') && isReadByOthers(room, e, me)) return i;
    }
    return -1;
  })();

  return (
    <div className="timeline-wrap">
    <div className="timeline" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
      <div className="timeline__inner">
        {hidden > 0 || canLoadOlder ? (
          <div className="timeline__older">
            {loadingOlder ? <span className="rl-spinner" /> : <Button size="sm" variant="ghost" onClick={() => growOrLoad(scroller.current)}>Загрузить ещё</Button>}
          </div>
        ) : (
          <div className="timeline__start">Начало переписки</div>
        )}
        {shown.map((ev, i) => {
          // соседей ищем среди реально отрисованных событий (пустые служебные не рвут серию)
          const prev = neighbour(shown, i, -1, pin);
          const next = neighbour(shown, i, 1, pin);
          const newDay = !prev || !sameDay(prev.getTs(), ev.getTs());
          const dayEl = newDay ? <div className="day-sep"><span>{formatDay(ev.getTs())}</span></div> : null;

          if (isStateNotice(ev)) {
            const text = stateText(ev, pin);
            return text ? <Fragment key={ev.getId() ?? i}>{dayEl}<div className="state-notice">{text}</div></Fragment> : dayEl && <Fragment key={ev.getId() ?? i}>{dayEl}</Fragment>;
          }

          const sameAsPrev = prev && !isStateNotice(prev) && prev.getSender() === ev.getSender() && ev.getTs() - prev.getTs() < GROUP_GAP_MS && !newDay;
          const sameAsNext = next && !isStateNotice(next) && next.getSender() === ev.getSender() && next.getTs() - ev.getTs() < GROUP_GAP_MS && sameDay(next.getTs(), ev.getTs());
          const own = ev.getSender() === me;
          const readByOthers = own && i <= lastReadOwnIdx;
          const reactions = reactionMap.get(ev.getId() ?? '') ?? NO_REACTIONS;
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
                reactions={reactions}
                stamp={messageStamp(ev) + (readByOthers ? 'r' : '') + '|' + reactionsStamp(reactions)}
                onMenu={openMenu}
              />
            </Fragment>
          );
        })}
        <Uploads roomId={room.roomId} />
      </div>
    </div>
    {far && (
      <button type="button" className="jump-bottom" onClick={jumpToBottom} aria-label={unseen > 0 ? `Вниз, новых сообщений: ${unseen}` : 'Вниз'}>
        <Icon name="chevronUp" size={22} />
        {unseen > 0 && <span className="jump-bottom__badge">{unseen > 99 ? '99+' : unseen}</span>}
      </button>
    )}
    {menu && (
      <MessageMenu
        client={client}
        room={room}
        ev={menu.ev}
        point={menu.point}
        onClose={closeMenu}
        onReply={onReply}
        onEdit={onEdit}
        onForward={setForwarding}
        onDelete={setDeleting}
      />
    )}
    <ForwardDialog client={client} ev={forwarding} onClose={() => setForwarding(null)} />
    <DeleteDialog client={client} ev={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}
