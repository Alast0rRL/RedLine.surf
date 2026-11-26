import { memo, useRef, type KeyboardEvent as RKeyEvent, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { formatTime } from '../lib/events';
import { splitPhones } from '../lib/html';
import { markHtml, splitMarks } from '../lib/search';
import { Icon, toast } from '../components/ui';
import { ExtraIcon } from '../components/extraIcons';
import { ChatFile, ChatImage, ChatVideo } from './ChatMedia';
import { ChatVoicePlayer } from './ChatVoicePlayer';
import { ChatAvatar } from './ChatAvatar';
import { useBackendAvatar } from './useBackendMedia';
import type { MenuPoint } from './ChatMenu';
import type { ChatBackend, ChatMessage } from './types';

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

function Body({ backend, m, q }: { backend: ChatBackend; m: ChatMessage; q?: string }) {
  const marked = m.html && q ? markHtml(m.html, q) : m.html ?? null;
  if (marked) {
    return (
      <div
        className="msg-text msg-text--html"
        onClick={(e) => backend.onHtmlClick?.(e)}
        dangerouslySetInnerHTML={{ __html: marked }}
      />
    );
  }
  const body = m.text;
  // одни эмодзи — крупно
  const onlyEmoji = /^(\p{Extended_Pictographic}|\p{Emoji_Component}|\s){1,8}$/u.test(body) && !/\d/.test(body);
  return <div className={`msg-text${onlyEmoji ? ' msg-text--emoji' : ''}`}><Linkified text={body} q={q} /></div>;
}

function Media({ backend, m, onOpenMedia }: { backend: ChatBackend; m: ChatMessage; onOpenMedia: (m: ChatMessage) => void }) {
  const media = m.media;
  if (!media) return null;
  switch (media.kind) {
    case 'image':
    case 'sticker':
      return <ChatImage backend={backend} media={media} alt={media.name ?? 'Фото'} sticker={media.kind === 'sticker'} onOpen={() => onOpenMedia(m)} />;
    case 'video':
      return <ChatVideo backend={backend} media={media} />;
    case 'voice':
    case 'audio':
      return <ChatVoicePlayer backend={backend} media={media} own={m.own} />;
    default:
      return <ChatFile backend={backend} media={media} />;
  }
}

function Placeholder({ kind }: { kind: 'decrypting' | 'undecryptable' }) {
  return (
    <div className="msg-text msg-text--muted">
      <Icon name="lock" size={14} /> {kind === 'decrypting' ? 'Расшифровка…' : 'Старое сообщение пока недоступно'}
    </div>
  );
}

function Status({ backend, m }: { backend: ChatBackend; m: ChatMessage }) {
  switch (m.status) {
    case 'sending':
      return <span className="msg-status" aria-label="Отправляется" title="Отправляется"><Icon name="clock" size={16} /></span>;
    case 'failed':
      return (
        <span className="msg-status msg-status--failed">
          <span className="msg-status__text"><Icon name="alert" size={16} /> Не отправлено</span>
          {backend.resend && <button type="button" onClick={() => backend.resend?.(m.id)}>Повторить</button>}
          {backend.cancelSend && (
            <button type="button" onClick={() => backend.cancelSend?.(m.id)} aria-label="Удалить сообщение" title="Удалить сообщение">
              <Icon name="trash" size={16} /> Удалить
            </button>
          )}
        </span>
      );
    case 'read':
      return <span className="msg-status msg-status--read" aria-label="Прочитано" title="Прочитано"><Icon name="checks" size={16} /></span>;
    default:
      return <span className="msg-status" aria-label="Отправлено" title="Отправлено"><Icon name="check" size={16} /></span>;
  }
}

const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 10;
/** Свайп влево: после 10px выбираем направление; ответ — от 64px. */
const SWIPE_LOCK_PX = 10;
const SWIPE_REPLY_PX = 64;
const SWIPE_EDGE_PX = 24;
/** Сопротивление: сначала почти 1:1, дальше пружинит. */
const swipeShift = (d: number) => (d <= SWIPE_REPLY_PX ? d * 0.8 : Math.min(84, SWIPE_REPLY_PX * 0.8 + (d - SWIPE_REPLY_PX) * 0.15));

export interface ChatMessageViewProps {
  backend: ChatBackend;
  m: ChatMessage;
  first: boolean;
  last: boolean;
  highlight?: string;
  onMenu(m: ChatMessage, point: MenuPoint): void;
  onReply(m: ChatMessage): void;
  onJump(id: string): void;
  onOpenMedia(m: ChatMessage): void;
}

export const ChatMessageView = memo(function ChatMessageView({
  backend, m, first, last, highlight, onMenu, onReply, onJump, onOpenMedia,
}: ChatMessageViewProps) {
  const avatar = useBackendAvatar(backend, m.senderId);
  if (m.service) return <div className="state-notice">{m.service}</div>;

  const media = m.media ?? null;
  const bot = !m.own && !!m.bot;
  const botStyled = !m.own && (!!m.botStyled || bot);
  const failed = m.status === 'failed';
  const mentioned = !m.own && !!m.mentionsMe;
  const isMedia = media?.kind === 'image' || media?.kind === 'sticker';
  const isAudio = media?.kind === 'voice' || media?.kind === 'audio';
  const isFile = media?.kind === 'file' || media?.kind === 'video';
  const showSender = !m.own && ((backend.group && first) || botStyled);
  const showAvatar = m.showAvatar ?? backend.group;
  const actionable = m.actionable !== false;
  const openUser = () => backend.openProfile?.(m.senderId);

  // долгое нажатие (touch/pen); мышь — правая кнопка и кнопка «⋯»
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const lastOpen = useRef(0);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  const open = (x: number, y: number) => {
    lastOpen.current = Date.now();
    onMenu(m, { x, y });
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
      onReply(m);
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
    open(m.own ? r.left - 150 : r.right - 20, r.bottom);
  };
  const onReact = (key: string) => {
    backend.toggleReaction(m.id, key).catch(() => toast('Не удалось отправить реакцию', { variant: 'error' }));
  };
  const jump = (e: RMouseEvent | RKeyEvent) => {
    if ('key' in e && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    onJump(m.reply!.id);
  };

  const custom = m.custom ? backend.renderCustom?.(m) ?? null : null;
  const content: ReactNode = m.placeholder ? (
    <Placeholder kind={m.placeholder} />
  ) : custom ? (
    custom
  ) : (
    <>
      {m.forwardedFrom && <div className="bubble__forwarded">Переслано от {m.forwardedFrom}</div>}
      {m.reply && (
        <div className="msg-reply" role="button" tabIndex={0} onClick={jump} onKeyDown={jump} aria-label="Перейти к исходному сообщению">
          <span className="msg-reply__who">{m.reply.senderName}</span>
          <span className="msg-reply__text">{m.reply.text}</span>
        </div>
      )}
      {media ? <Media backend={backend} m={m} onOpenMedia={onOpenMedia} /> : null}
      {m.text && <Body backend={backend} m={m} q={highlight} />}
    </>
  );
  const body: ReactNode = (
    <>
      {content}
      <div className="bubble__meta">
        {m.edited && <span className="bubble__edited">изменено</span>}
        <time dateTime={m.ts > 0 ? new Date(m.ts).toISOString() : undefined}>{formatTime(m.ts)}</time>
        {m.own && !failed && <Status backend={backend} m={m} />}
      </div>
      {m.own && failed && <div className="bubble__failed"><Status backend={backend} m={m} /></div>}
    </>
  );

  return (
    <div
      className={`msg${m.own ? ' msg--own' : ''}${first ? ' msg--first' : ''}${last ? ' msg--last' : ''}${botStyled ? ' msg--bot' : ''}`}
      data-evid={m.id}
      data-ts={m.ts}
    >
      {!m.own && showAvatar && (
        <div className="msg__avatar">
          {last && (
            <button type="button" className="msg__avatar-btn" onClick={openUser} aria-label={`Профиль: ${m.senderName}`}>
              <ChatAvatar name={m.senderName} seed={m.senderId} src={m.senderAvatar !== undefined ? m.senderAvatar : avatar} size="sm" />
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
          {showSender && (
            <div className="bubble__sender">
              <button type="button" className="bubble__name" onClick={openUser}>{m.senderName}</button>
              {bot && <span className="bot-tag"><Icon name="bot" size={11} /> бот</span>}
            </div>
          )}
          {body}
        </div>
        {m.reactions.length > 0 && (
          <div className="msg-reactions">
            {m.reactions.map((r) => (
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
});
