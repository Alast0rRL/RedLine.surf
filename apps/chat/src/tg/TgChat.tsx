import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Avatar, Button, Icon, toast } from '../components/ui';
import { navigate } from '../hooks/useHashRoute';
import { formatDay, formatTime, sameDay } from '../lib/events';
import { loadChatTitle, sendText } from './data';
import { tgErrorText } from './client';
import { useTgHistory } from './hooks';

const MAX_LEN = 4096; // лимит Telegram на одно сообщение

/** Переписка Telegram: лента + поле ввода. Медиа пока подписями. */
export function TgChat({ peerId, ready }: { peerId: number; ready: boolean }) {
  const { msgs, error, loadOlder, loadingOlder, atStart, addOwn } = useTgHistory(peerId, ready);
  const [title, setTitle] = useState<{ name: string; group: boolean } | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // держимся у низа, пока человек не прокрутил вверх
  const prevHeight = useRef(0);
  const prevFirst = useRef<number | null>(null);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    loadChatTitle(peerId).then((t) => alive && setTitle(t), () => {});
    return () => {
      alive = false;
    };
  }, [peerId, ready]);

  // подгрузили старые сверху — сохраняем позицию; новое внизу — прокручиваем, если были у низа
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !msgs) return;
    const first = msgs[0]?.id ?? null;
    if (prevFirst.current !== null && first !== prevFirst.current && prevHeight.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
  }, [msgs]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    prevHeight.current = el.scrollHeight;
    if (el.scrollTop < 200) void loadOlder();
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const m = await sendText(peerId, body);
      setText('');
      stick.current = true;
      addOwn(m);
    } catch (e) {
      console.error(e);
      toast(tgErrorText(e), { variant: 'error' });
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const name = title?.name ?? '';
  return (
    <section className="pane pane--room pane--chat" aria-label={name || 'Telegram'}>
      <header className="topbar topbar--room">
        <Button variant="ghost" icon aria-label="Назад к чатам" className="topbar__back" onClick={() => navigate.back('#/tg')}>
          <Icon name="back" />
        </Button>
        <Avatar name={name || '?'} seed={`tg:${peerId}`} size="sm" round />
        <span className="topbar__title">
          <span className="topbar__name">{name}</span>
          <span className="topbar__sub">Telegram</span>
        </span>
      </header>

      <div className="timeline-wrap">
        <div className="timeline" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
          <div className="timeline__inner">
            {error && !msgs && <div className="timeline__start">{error}</div>}
            {!error && !msgs && <div className="timeline__older"><span className="rl-spinner" /></div>}
            {msgs && (atStart ? <div className="timeline__start">Начало переписки</div> : loadingOlder && <div className="timeline__older"><span className="rl-spinner" /></div>)}
            {msgs?.map((m, i) => {
              const prev = msgs[i - 1];
              const next = msgs[i + 1];
              const newDay = !prev || !sameDay(prev.date, m.date);
              const first = newDay || prev.senderId !== m.senderId;
              const last = !next || next.senderId !== m.senderId || !sameDay(next.date, m.date);
              return (
                <Fragment key={m.id}>
                  {newDay && <div className="day-sep"><span>{formatDay(m.date)}</span></div>}
                  <div className={`msg${m.out ? ' msg--own' : ''}${first ? ' msg--first' : ''}${last ? ' msg--last' : ''}`}>
                    {!m.out && (
                      <div className="msg__avatar">
                        {last && title?.group && <Avatar name={m.sender} seed={`tg:${m.senderId}`} size="sm" />}
                      </div>
                    )}
                    <div className="msg__col">
                      <div className="bubble">
                        {title?.group && first && !m.out && (
                          <div className="bubble__sender"><span className="bubble__name">{m.sender}</span></div>
                        )}
                        {m.media && <div className="msg-text msg-text--muted">[{m.media}]</div>}
                        {m.text && <div className="msg-text">{m.text}</div>}
                        <div className="bubble__meta">
                          {m.edited && <span className="bubble__edited">изменено</span>}
                          <time dateTime={new Date(m.date).toISOString()}>{formatTime(m.date)}</time>
                        </div>
                      </div>
                    </div>
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>

      <div className="composer-box">
        <div className="composer">
          <textarea
            className="composer__input"
            rows={1}
            placeholder="Сообщение"
            value={text}
            maxLength={MAX_LEN}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Сообщение"
            disabled={!ready}
          />
          <Button variant="primary" icon round aria-label="Отправить" onClick={() => void submit()} disabled={!text.trim() || sending || !ready}>
            <Icon name="send" />
          </Button>
        </div>
      </div>
    </section>
  );
}
