import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatDay, formatDuration, sameDay } from '../lib/events';
import { Button, Icon } from '../components/ui';
import { FileGlyph, formatSize } from '../room/FileMessage';
import { ChatMessageView } from './ChatMessageView';
import { ChatMediaViewer } from './ChatMediaViewer';
import { ChatDeleteDialog, ChatForwardDialog, ChatMenu, type MenuPoint } from './ChatMenu';
import type { ChatBackend, ChatMessage, ChatTimelineState, ChatUpload } from './types';
import '../room/room.css';

const GROUP_GAP_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 120;

function Uploads({ uploads }: { uploads: ChatUpload[] }) {
  if (uploads.length === 0) return null;
  return (
    <>
      {uploads.map((u) => (
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
                <Icon name="alert" size={16} /> {u.error}
                {u.retry && <button type="button" onClick={u.retry}>Повторить</button>}
                <button type="button" onClick={u.cancel} aria-label="Удалить" title="Удалить"><Icon name="trash" size={16} /> Удалить</button>
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

export interface ChatSearchTarget {
  id: string;
  query: string;
  nonce: number;
}

export interface ChatTimelineProps {
  backend: ChatBackend;
  state: ChatTimelineState;
  onReply(m: ChatMessage): void;
  onEdit(m: ChatMessage): void;
  /** результат поиска, к которому надо прокрутить и подсветить текст */
  highlight?: ChatSearchTarget | null;
}

export function ChatTimeline({ backend, state, onReply, onEdit, highlight = null }: ChatTimelineProps) {
  const messages = state.messages ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // прилипать к низу при новых сообщениях
  const prevHeight = useRef(0);
  const loadingOlderRef = useRef(false);

  const [menu, setMenu] = useState<{ m: ChatMessage; point: MenuPoint } | null>(null);
  const [forwarding, setForwarding] = useState<ChatMessage | null>(null);
  const [deleting, setDeleting] = useState<ChatMessage | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const openMenu = useCallback((m: ChatMessage, point: MenuPoint) => setMenu({ m, point }), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const mediaItems = useMemo(
    () => messages.filter((m) => !!m.media && (m.media.kind === 'image' || m.media.kind === 'video' || m.media.kind === 'sticker')),
    [messages],
  );
  const openMedia = useCallback((m: ChatMessage) => {
    const i = mediaItems.findIndex((x) => x.id === m.id);
    if (i >= 0) setViewer(i);
  }, [mediaItems]);

  // кнопка «вниз» и счётчик новых, пока лента прокручена вверх
  const [far, setFar] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const tailId = useRef<string | null>(null);

  useEffect(() => {
    const last = messages.at(-1)?.id ?? null;
    const prevTail = tailId.current;
    tailId.current = last;
    if (!prevTail || !last || prevTail === last || stick.current) return;
    const idx = messages.findIndex((m) => m.id === prevTail);
    if (idx < 0) return;
    const fresh = messages.slice(idx + 1).filter((m) => !m.own && !m.service).length;
    if (fresh > 0) setUnseen((n) => n + fresh);
  }, [messages]);

  // позиция прокрутки: внизу — держим низ; подгрузили старое — сохраняем место
  useEffect(() => {
    if (state.loadingOlder) {
      loadingOlderRef.current = true;
      prevHeight.current = scroller.current?.scrollHeight ?? 0;
    }
  }, [state.loadingOlder]);

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
  }, [messages.length, state.loadingOlder]);

  // переход к результату поиска; если сообщение ещё не загружено — просим backend догрузить историю
  const jumpedNonce = useRef<string | null>(null);
  const revealTried = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !highlight) return;
    const key = `${highlight.id}|${highlight.query}|${highlight.nonce}`;
    if (jumpedNonce.current === key) return;
    let alive = true;
    const jump = () => {
      const node = el.querySelector<HTMLElement>(`[data-evid="${CSS.escape(highlight.id)}"]`);
      if (!node) return false;
      jumpedNonce.current = key;
      stick.current = false;
      unreadScrolled.current = true;
      node.scrollIntoView({ block: 'center' });
      prevHeight.current = el.scrollHeight;
      node.classList.remove('msg--flash');
      void node.offsetWidth;
      node.classList.add('msg--flash');
      window.setTimeout(() => node.classList.remove('msg--flash'), 1600);
      return true;
    };
    if (jump()) return;
    if (state.reveal && revealTried.current !== key) {
      revealTried.current = key;
      void state.reveal(highlight.id).then(() => {
        if (alive) requestAnimationFrame(jump);
      });
    }
    return () => {
      alive = false;
    };
  }, [highlight, messages.length, state.reveal]);

  // непрочитанные: маркер фиксируем в момент открытия и больше не двигаем
  const unreadScrolled = useRef(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !state.firstUnreadId || unreadScrolled.current) return;
    const mark = el.querySelector<HTMLElement>('[data-unread-divider]');
    if (!mark) return;
    unreadScrolled.current = true;
    stick.current = false;
    el.scrollTop += mark.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
    prevHeight.current = el.scrollHeight;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setFar(dist > el.clientHeight);
  }, [state.firstUnreadId, messages.length]);

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

  // плавающая плашка дня: только во время прокрутки
  const [floatDay, setFloatDay] = useState<string | null>(null);
  const [floatOn, setFloatOn] = useState(false);
  const [floatHide, setFloatHide] = useState(false);
  const floatTimer = useRef(0);
  const floatRaf = useRef(0);
  useEffect(() => () => {
    clearTimeout(floatTimer.current);
    cancelAnimationFrame(floatRaf.current);
  }, []);
  const updateFloat = (el: HTMLElement) => {
    if (floatRaf.current) return;
    floatRaf.current = requestAnimationFrame(() => {
      floatRaf.current = 0;
      const top = el.getBoundingClientRect().top;
      // рядом с верхом уже виден inline-разделитель дня — плавающая плашка не нужна
      let nearSep = false;
      for (const s of el.querySelectorAll<HTMLElement>('.day-sep')) {
        const r = s.getBoundingClientRect();
        if (r.bottom > top && r.top < top + 44) { nearSep = true; break; }
      }
      setFloatHide(nearSep);
      const items = el.querySelectorAll<HTMLElement>('.msg[data-ts]');
      for (const it of items) {
        if (it.getBoundingClientRect().bottom > top + 4) {
          setFloatDay(formatDay(Number(it.dataset.ts)));
          break;
        }
      }
    });
    setFloatOn(true);
    clearTimeout(floatTimer.current);
    floatTimer.current = window.setTimeout(() => setFloatOn(false), 700);
  };

  const loadOlder = () => {
    if (state.loadingOlder || state.atStart) return;
    loadingOlderRef.current = true;
    prevHeight.current = scroller.current?.scrollHeight ?? 0;
    if (!state.loadOlder()) loadingOlderRef.current = false;
  };

  // Лента не заполняет экран (только что принятый или новый чат): прокручивать нечего, onScroll не сработает —
  // догружаем историю сами, пока экран не заполнится или не дойдём до начала переписки.
  // Предохранитель: 8 страниц подряд без новых видимых сообщений (служебные события, ошибки сети) — дальше кнопкой.
  const autoFill = useRef({ count: -1, tries: 0 });
  useEffect(() => {
    const el = scroller.current;
    if (!el || state.messages === null || state.loadingOlder || state.atStart) return;
    if (el.scrollHeight > el.clientHeight + 300) return;
    const t = autoFill.current;
    if (t.count !== messages.length) {
      t.count = messages.length;
      t.tries = 0;
    }
    if (t.tries >= 8) return;
    t.tries += 1;
    loadOlder();
  });

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    updateFloat(el);
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = dist < NEAR_BOTTOM_PX;
    setFar(dist > el.clientHeight);
    if (stick.current) setUnseen(0);
    if (el.scrollTop < 300) loadOlder();
  };

  const jumpToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setUnseen(0);
  };

  const neighbour = (i: number, dir: 1 | -1): ChatMessage | undefined => {
    for (let j = i + dir; j >= 0 && j < messages.length; j += dir) {
      if (!messages[j].service) return messages[j];
    }
    return undefined;
  };

  return (
    <div className="timeline-wrap">
    <div className="timeline" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
      <div className="timeline__inner">
        {state.error && <div className="state-notice">{state.error}</div>}
        {!state.atStart ? (
          <div className="timeline__older">
            {state.loadingOlder ? <span className="rl-spinner" /> : <Button size="sm" variant="ghost" onClick={loadOlder}>Загрузить ещё</Button>}
          </div>
        ) : (
          <div className="timeline__start">{state.cleared ? 'История очищена' : 'Начало переписки'}</div>
        )}
        {state.messages === null && <div className="timeline__older"><span className="rl-spinner" /></div>}
        {messages.map((m, i) => {
          // соседей ищем среди реально отрисованных сообщений (служебные не рвут серию)
          const prev = neighbour(i, -1);
          const next = neighbour(i, 1);
          // день меняется относительно любого предыдущего элемента, включая служебные
          const before = messages[i - 1];
          const newDay = !before || !sameDay(before.ts, m.ts);
          const dayEl = newDay ? <div className="day-sep"><span>{formatDay(m.ts)}</span></div> : null;

          if (m.service) {
            return (
              <Fragment key={m.id || i}>
                {dayEl}
                <div className="state-notice">{m.service}</div>
              </Fragment>
            );
          }

          const sameAsPrev = !!prev && !prev.service && prev.senderId === m.senderId && m.ts - prev.ts < GROUP_GAP_MS && !newDay;
          const sameAsNext = !!next && !next.service && next.senderId === m.senderId && next.ts - m.ts < GROUP_GAP_MS && sameDay(next.ts, m.ts);
          return (
            <Fragment key={m.id || i}>
              {dayEl}
              {m.id === state.firstUnreadId && <div className="unread-sep" data-unread-divider><span>Новые сообщения</span></div>}
              <ChatMessageView
                backend={backend}
                m={m}
                first={!sameAsPrev}
                last={!sameAsNext}
                highlight={highlight && highlight.id === m.id ? highlight.query : undefined}
                onMenu={openMenu}
                onReply={onReply}
                onJump={(id) => {
                  const el = scroller.current;
                  const node = el?.querySelector<HTMLElement>(`[data-evid="${CSS.escape(id)}"]`);
                  if (!node && state.reveal) {
                    void state.reveal(id).then(() => {
                      const fresh = scroller.current?.querySelector<HTMLElement>(`[data-evid="${CSS.escape(id)}"]`);
                      fresh?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    });
                    return;
                  }
                  if (!node) return;
                  stick.current = false;
                  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
                  node.classList.remove('msg--flash');
                  void node.offsetWidth;
                  node.classList.add('msg--flash');
                  window.setTimeout(() => node.classList.remove('msg--flash'), 1600);
                }}
                onOpenMedia={openMedia}
              />
            </Fragment>
          );
        })}
        <Uploads uploads={state.uploads} />
      </div>
    </div>
    {floatDay && <div className={`day-float${floatOn && !floatHide ? ' is-on' : ''}`} aria-hidden="true"><span>{floatDay}</span></div>}
    {far && (
      <button type="button" className="jump-bottom" onClick={jumpToBottom} aria-label={unseen > 0 ? `Вниз, новых сообщений: ${unseen}` : 'Вниз'}>
        <Icon name="chevronUp" size={22} />
        {unseen > 0 && <span className="jump-bottom__badge">{unseen > 99 ? '99+' : unseen}</span>}
      </button>
    )}
    {menu && (
      <ChatMenu
        backend={backend}
        m={menu.m}
        point={menu.point}
        onClose={closeMenu}
        onReply={onReply}
        onEdit={onEdit}
        onForward={setForwarding}
        onDelete={setDeleting}
      />
    )}
    {forwarding && <ChatForwardDialog backend={backend} m={forwarding} onClose={() => setForwarding(null)} />}
    {deleting && <ChatDeleteDialog backend={backend} m={deleting} onClose={() => setDeleting(null)} />}
    {viewer !== null && mediaItems.length > 0 && (
      <ChatMediaViewer backend={backend} items={mediaItems} index={viewer} onClose={() => setViewer(null)} />
    )}
    </div>
  );
}
