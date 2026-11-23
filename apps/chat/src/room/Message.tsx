import { memo, useMemo, useRef, type KeyboardEvent as RKeyEvent, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { EventStatus, EventType, MsgType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { formatTime, isPendingDecryption, isUndecryptable, isVoice, previewText } from '../lib/events';
import { sanitizeMatrixHtml, splitPhones, stripReplyFallback } from '../lib/html';
import { markHtml, splitMarks } from '../lib/search';
import { isMentioningMe } from '../lib/mentions';
import type { MediaSource } from '../lib/media';
import { isPinUser } from '../lib/pin';
import { navigate } from '../hooks/useHashRoute';
import { canAct, toggleReaction, type ReactionSummary } from '../lib/messageActions';
import { findRenderer, isBotStyled, isBotUser } from '../bots/registry';
import { Avatar, Icon, toast } from '../components/ui';
import { ExtraIcon } from '../components/extraIcons';
import { FileMessage, VideoMessage } from './FileMessage';
import { ImageMessage } from './ImageMessage';
import type { MenuPoint } from './MessageMenu';
import { VoicePlayer } from './VoicePlayer';

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

/** Простой текст: переносы строк + кликабельные ссылки. */
function Marked({ text, q }: { text: string; q?: string }) {
  if (!q) return <>{text}</>;
  return <>{splitMarks(text, q).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : p.text))}</>;
}

function Linkified({ text, q }: { text: string; q?: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow"><Marked text={p} q={q} /></a>
        ) : (
          splitPhones(p).map((s, j) => (s.tel ? <a key={`${i}-${j}`} href={`tel:${s.tel}`}><Marked text={s.text} q={q} /></a> : <Marked key={`${i}-${j}`} text={s.text} q={q} />))
        ),
      )}
    </>
  );
}

/** Ссылка на человека (matrix.to/#/@user:server) открывает его профиль, а не внешний сайт. */
function onHtmlClick(e: RMouseEvent<HTMLDivElement>) {
  const a = (e.target as HTMLElement).closest('a');
  const m = a?.getAttribute('href')?.match(/^https:\/\/matrix\.to\/#\/(@[^?/]+)/);
  if (!m) return;
  e.preventDefault();
  navigate.user(decodeURIComponent(m[1]));
}

function Body({ ev, name, q }: { ev: MatrixEvent; name: string; q?: string }) {
  const content = ev.getContent();
  const html = useMemo(
    () => (content.format === 'org.matrix.custom.html' && typeof content.formatted_body === 'string'
      ? sanitizeMatrixHtml(content.formatted_body)
      : null),
    [content.format, content.formatted_body],
  );
  const marked = useMemo(() => (html && q ? markHtml(html, q) : html), [html, q]);
  if (marked) return <div className="msg-text msg-text--html" onClick={onHtmlClick} dangerouslySetInnerHTML={{ __html: marked }} />;
  const body = stripReplyFallback(String(content.body ?? ''));
  // одни эмодзи — крупно
  const onlyEmoji = /^(\p{Extended_Pictographic}|\p{Emoji_Component}|\s){1,8}$/u.test(body) && !/\d/.test(body);
  return (
    <div className={`msg-text${onlyEmoji ? ' msg-text--emoji' : ''}`}>
      {content.msgtype === MsgType.Emote && <em>* {name} </em>}
      <Linkified text={body} q={q} />
    </div>
  );
}

function ReplyQuote({ room, ev, pin }: { room: Room; ev: MatrixEvent; pin: boolean }) {
  const replyTo = ev.replyEventId;
  if (!replyTo) return null;
  const target = room.findEventById(replyTo);
  const jump = (e: RMouseEvent | RKeyEvent) => {
    if ('key' in e && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    const el = document.querySelector<HTMLElement>(`[data-evid="${CSS.escape(replyTo)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('msg--flash');
    void el.offsetWidth;
    el.classList.add('msg--flash');
    setTimeout(() => el.classList.remove('msg--flash'), 1600);
  };
  return (
    <div className="msg-reply" role="button" tabIndex={0} onClick={jump} onKeyDown={jump} aria-label="Перейти к исходному сообщению">
      <span className="msg-reply__who">{target ? (target.sender?.name ?? (pin ? 'Участник' : target.getSender())) : 'Сообщение'}</span>
      <span className="msg-reply__text">{target ? previewText(target) : 'не загружено'}</span>
    </div>
  );
}

function Status({ client, room, ev, readByOthers }: { client: MatrixClient; room: Room; ev: MatrixEvent; readByOthers: boolean }) {
  const s = ev.status;
  if (s === EventStatus.NOT_SENT) {
    return (
      <span className="msg-status msg-status--failed">
        <span className="msg-status__text"><Icon name="alert" size={16} /> Не отправлено</span>
        <button type="button" onClick={() => void client.resendEvent(ev, room)}>Повторить</button>
        <button type="button" onClick={() => client.cancelPendingEvent(ev)} aria-label="Удалить сообщение" title="Удалить сообщение">
          <Icon name="trash" size={16} /> Удалить
        </button>
      </span>
    );
  }
  if (s === EventStatus.SENDING || s === EventStatus.QUEUED || s === EventStatus.ENCRYPTING) {
    return <span className="msg-status" aria-label="Отправляется" title="Отправляется"><Icon name="clock" size={16} /></span>;
  }
  return (
    <span className={`msg-status${readByOthers ? ' msg-status--read' : ''}`} aria-label={readByOthers ? 'Прочитано' : 'Отправлено'} title={readByOthers ? 'Прочитано' : 'Отправлено'}>
      <Icon name={readByOthers ? 'checks' : 'check'} size={16} />
    </span>
  );
}

function Content({ ev, name, q }: { ev: MatrixEvent; name: string; q?: string }): ReactNode {
  if (isUndecryptable(ev)) {
    return (
      <div className="msg-text msg-text--muted">
        <Icon name="lock" size={14} /> Старое сообщение пока недоступно
      </div>
    );
  }
  if (isPendingDecryption(ev)) return <div className="msg-text msg-text--muted"><Icon name="lock" size={14} /> Расшифровка…</div>;

  const custom = findRenderer(ev);
  if (custom) {
    const C = custom.component;
    return <C event={ev} />;
  }

  const c = ev.getContent();
  const src: MediaSource = { url: c.url, file: c.file, mimetype: c.info?.mimetype };
  if (ev.getType() === EventType.Sticker || c.msgtype === MsgType.Image) {
    return <ImageMessage src={src} w={c.info?.w} h={c.info?.h} alt={c.body ?? 'Фото'} />;
  }
  if (c.msgtype === MsgType.Audio) {
    const audio = c['org.matrix.msc1767.audio'] ?? {};
    return <VoicePlayer src={src} durationMs={audio.duration ?? c.info?.duration} waveform={isVoice(ev) ? audio.waveform : undefined} />;
  }
  if (c.msgtype === MsgType.Video) {
    return <VideoMessage src={src} name={c.filename ?? c.body ?? 'Видео'} size={c.info?.size} w={c.info?.w} h={c.info?.h} />;
  }
  if (c.msgtype === MsgType.File) {
    return <FileMessage src={src} name={c.filename ?? c.body ?? 'Файл'} size={c.info?.size} />;
  }
  return <Body ev={ev} name={name} q={q} />;
}

export interface MessageProps {
  client: MatrixClient;
  room: Room;
  ev: MatrixEvent;
  own: boolean;
  /** первое сообщение в серии от одного автора — показываем имя */
  first: boolean;
  /** последнее в серии — показываем аватар */
  last: boolean;
  showSenderName: boolean;
  readByOthers: boolean;
  /**
   * MatrixEvent мутируется на месте (статус, расшифровка, правки) — memo не заметит.
   * stamp меняется вместе с ним и заставляет перерисовать именно это сообщение.
   */
  stamp: string;
  /** реакции, посчитанные один раз на проход в Timeline (в сравнении memo не участвуют: их отражает stamp) */
  reactions: ReactionSummary[];
  /** открыть меню действий (стабильная ссылка) */
  onMenu: (ev: MatrixEvent, point: MenuPoint) => void;
  /** ответить на сообщение (свайп; стабильная ссылка) */
  onReply: (ev: MatrixEvent) => void;
  /** подсветить совпадения поиска в тексте (только у выбранного результата) */
  highlight?: string;
}

export function messageStamp(ev: MatrixEvent): string {
  return [ev.status, ev.getType(), ev.isRedacted(), ev.isDecryptionFailure(), ev.isBeingDecrypted(), ev.replacingEventId(), ev.getId()].join('|');
}

const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 10;
/** Свайп влево: после 10px выбираем направление; ответ — от 64px. */
const SWIPE_LOCK_PX = 10;
const SWIPE_REPLY_PX = 64;
const SWIPE_EDGE_PX = 24;
/** Сопротивление: сначала почти 1:1, дальше пружинит. */
const swipeShift = (d: number) => (d <= SWIPE_REPLY_PX ? d * 0.8 : Math.min(84, SWIPE_REPLY_PX * 0.8 + (d - SWIPE_REPLY_PX) * 0.15));

function sameMessage(a: MessageProps, b: MessageProps): boolean {
  return (
    a.stamp === b.stamp && a.ev === b.ev && a.own === b.own && a.first === b.first && a.last === b.last &&
    a.showSenderName === b.showSenderName && a.readByOthers === b.readByOthers && a.client === b.client &&
    a.room === b.room && a.onMenu === b.onMenu && a.onReply === b.onReply && a.highlight === b.highlight
  );
}

export const Message = memo(function Message({ client, room, ev, own, first, last, showSenderName, readByOthers, reactions, onMenu, onReply, highlight }: MessageProps) {
  const bot = !own && isBotStyled(ev);
  const pin = isPinUser(client.getUserId());
  const sender = ev.sender;
  const name = sender?.name && sender.name !== ev.getSender()
    ? sender.name
    : pin ? 'Участник' : ev.getSender() ?? '';
  const isMedia = !ev.isRedacted() && [MsgType.Image].includes(ev.getContent().msgtype as MsgType);
  const isAudio = !ev.isRedacted() && ev.getContent().msgtype === MsgType.Audio;
  const failed = ev.status === EventStatus.NOT_SENT;
  const mentioned = !own && isMentioningMe(ev, client.getUserId());
  const edited = !!ev.replacingEventId();
  const isFile = !ev.isRedacted() && [MsgType.File, MsgType.Video].includes(ev.getContent().msgtype as MsgType);
  const actionable = canAct(ev);
  const senderId = ev.getSender() ?? '';
  const openUser = () => {
    if (senderId) navigate.user(senderId);
  };

  // долгое нажатие (touch/pen); мышь — правая кнопка и кнопка «⋯»
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const lastOpen = useRef(0);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  const open = (x: number, y: number) => {
    lastOpen.current = Date.now();
    onMenu(ev, { x, y });
  };
  // свайп влево = ответить (touch/pen)
  const colRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLSpanElement>(null);
  const swipe = useRef<{ x: number; y: number; mode: 'idle' | 'h'; id: number } | null>(null);
  const resetSwipe = (animate: boolean) => {
    swipe.current = null;
    const col = colRef.current;
    const arrow = arrowRef.current;
    if (col) {
      col.style.transition = animate ? 'transform 0.2s ease-out' : '';
      col.style.transform = '';
    }
    if (arrow) {
      arrow.style.opacity = '0';
      arrow.classList.remove('is-armed');
    }
  };
  const onSwipeMove = (e: RPointerEvent) => {
    const s = swipe.current;
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (s.mode === 'idle') {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_LOCK_PX) return;
      if (-dx > Math.abs(dy) * 1.2) {
        s.mode = 'h';
        cancelPress();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* указатель уже отпущен */
        }
      } else {
        swipe.current = null; // вертикальная прокрутка или свайп вправо — не наш жест
        return;
      }
    }
    const d = Math.max(0, -dx);
    const col = colRef.current;
    const arrow = arrowRef.current;
    if (col) {
      col.style.transition = '';
      col.style.transform = `translateX(${-swipeShift(d)}px)`;
    }
    if (arrow) {
      arrow.style.opacity = String(Math.min(1, d / (SWIPE_REPLY_PX * 0.7)));
      arrow.classList.toggle('is-armed', d >= SWIPE_REPLY_PX);
    }
  };
  const onSwipeEnd = (e: RPointerEvent, cancelled: boolean) => {
    const s = swipe.current;
    if (!s || e.pointerId !== s.id) return;
    const fire = s.mode === 'h' && !cancelled && s.x - e.clientX >= SWIPE_REPLY_PX;
    if (s.mode === 'h') lastOpen.current = Date.now(); // клик после жеста не должен открыть фото/ссылку
    resetSwipe(true);
    if (fire) {
      navigator.vibrate?.(10);
      onReply(ev);
    }
  };
  const onPointerDown = (e: RPointerEvent) => {
    if (!actionable || e.pointerType === 'mouse' || !e.isPrimary) return;
    cancelPress();
    const x = e.clientX;
    const y = e.clientY;
    const tgt = e.target as HTMLElement;
    // у самого края — жест «назад»; ползунки и плееры сами едут по горизонтали
    swipe.current = x > SWIPE_EDGE_PX && !tgt.closest('input, video, audio, .voice__wave, pre, table')
      ? { x, y, mode: 'idle', id: e.pointerId }
      : null;
    press.current = {
      x,
      y,
      timer: window.setTimeout(() => {
        press.current = null;
        navigator.vibrate?.(15);
        open(x, y);
      }, LONG_PRESS_MS),
    };
  };
  const onPointerMove = (e: RPointerEvent) => {
    onSwipeMove(e);
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE) cancelPress();
  };
  const onContextMenu = (e: RMouseEvent) => {
    if (!actionable) return;
    e.preventDefault();
    cancelPress();
    if (Date.now() - lastOpen.current < 800) return; // уже открыли долгим нажатием
    open(e.clientX, e.clientY);
  };
  // после долгого нажатия не даём «клику» открыть ссылку/фото
  const onClickCapture = (e: RMouseEvent) => {
    if (Date.now() - lastOpen.current < 600) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const onDotsClick = (e: RMouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    open(own ? r.left - 150 : r.right - 20, r.bottom);
  };
  const onReact = (key: string) => {
    toggleReaction(client, room, ev, key).catch(() => toast('Не удалось отправить реакцию', { variant: 'error' }));
  };

  return (
    <div
      className={`msg${own ? ' msg--own' : ''}${first ? ' msg--first' : ''}${last ? ' msg--last' : ''}${bot ? ' msg--bot' : ''}`}
      data-evid={ev.getId() ?? undefined}
      data-ts={ev.getTs()}
    >
      {!own && (
        <div className="msg__avatar">
          {last && (
            <button type="button" className="msg__avatar-btn" onClick={openUser} aria-label={`Профиль: ${name}`}>
              <Avatar client={client} name={name} seed={senderId} mxc={sender?.getMxcAvatarUrl()} size="sm" />
            </button>
          )}
        </div>
      )}
      <span ref={arrowRef} className="msg__swipe" aria-hidden="true"><ExtraIcon name="reply" size={18} /></span>
      <div className="msg__col" ref={colRef}>
        <div
          className={`bubble${mentioned ? ' bubble--mention' : ''}${isMedia ? ' bubble--media' : ''}${isAudio ? ' bubble--audio' : ''}${isFile ? ' bubble--file' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => {
            cancelPress();
            onSwipeEnd(e, false);
          }}
          onPointerCancel={(e) => {
            cancelPress();
            onSwipeEnd(e, true);
          }}
          onPointerLeave={cancelPress}
          onContextMenu={onContextMenu}
          onClickCapture={onClickCapture}
        >
          {(bot || (showSenderName && first && !own)) && (
            <div className="bubble__sender">
              <button type="button" className="bubble__name" onClick={openUser}>{name}</button>
              {isBotUser(ev.getSender()) && <span className="bot-tag"><Icon name="bot" size={11} /> бот</span>}
            </div>
          )}
          <ReplyQuote room={room} ev={ev} pin={pin} />
          <Content ev={ev} name={name} q={highlight} />
          <div className="bubble__meta">
            {edited && <span className="bubble__edited">изменено</span>}
            <time dateTime={new Date(ev.getTs()).toISOString()}>{formatTime(ev.getTs())}</time>
            {own && !failed && <Status client={client} room={room} ev={ev} readByOthers={readByOthers} />}
          </div>
          {own && failed && <div className="bubble__failed"><Status client={client} room={room} ev={ev} readByOthers={readByOthers} /></div>}
        </div>
        {reactions.length > 0 && (
          <div className="msg-reactions">
            {reactions.map((r) => (
              <button
                key={r.key}
                type="button"
                className={`reaction-chip${r.own ? ' is-mine' : ''}`}
                aria-pressed={r.own}
                aria-label={`${r.key} ${r.count}${r.own ? ', вы поставили' : ''}`}
                onClick={() => onReact(r.key)}
              >
                <span>{r.key}</span> <span className="reaction-chip__n">{r.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {actionable && (
        <button type="button" className="msg__more" aria-label="Действия с сообщением" aria-haspopup="menu" onClick={onDotsClick}>
          ⋯
        </button>
      )}
    </div>
  );
}, sameMessage);
