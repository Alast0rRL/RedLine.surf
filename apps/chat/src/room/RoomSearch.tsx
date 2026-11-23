import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Direction, type MatrixClient, type Room } from 'matrix-js-sdk';
import { useTimeline } from '../hooks/useTimeline';
import { useBackClose } from '../hooks/useBackClose';
import { findMatches } from '../lib/search';
import { Button, Icon } from '../components/ui';
import { ExtraIcon } from '../components/extraIcons';

export interface SearchTarget {
  id: string;
  query: string;
  /** растёт при каждом переходе: даже к тому же сообщению прокрутка повторяется */
  nonce: number;
}

/** Страниц истории за одно нажатие «Искать дальше». */
const MAX_PAGES = 10;
const PAGE_SIZE = 50;

/**
 * Поиск по чату. Сервер зашифрованные комнаты не ищет, поэтому ищем у себя —
 * по уже расшифрованным сообщениям загруженной ленты, а историю подгружаем по кнопке.
 */
export function RoomSearch({ client, room, onClose, onTarget }: {
  client: MatrixClient;
  room: Room;
  onClose: () => void;
  onTarget: (t: SearchTarget | null) => void;
}) {
  const dismiss = useBackClose(onClose);
  const { events, canLoadOlder } = useTimeline(client, room);
  const [query, setQuery] = useState('');
  const [curId, setCurId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [paging, setPaging] = useState<number | null>(null);
  const alive = useRef(true);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    alive.current = true;
    input.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  const matches = useMemo(() => findMatches(events, query), [events, query]);
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  // новый запрос — переходим к самому свежему совпадению
  useEffect(() => {
    setCurId(matchesRef.current.at(-1) ?? null);
    setNonce((n) => n + 1);
  }, [query]);
  // совпадения появились позже (подгрузили историю) — тоже к самому свежему
  useEffect(() => {
    if (!curId && matches.length) {
      setCurId(matches.at(-1)!);
      setNonce((n) => n + 1);
    }
  }, [matches, curId]);

  useEffect(() => {
    onTarget(curId ? { id: curId, query, nonce } : null);
  }, [curId, query, nonce, onTarget]);
  useEffect(() => () => onTarget(null), [onTarget]);

  const idx = curId ? matches.indexOf(curId) : -1;
  const go = (dir: 1 | -1) => {
    if (!matches.length) return;
    const next = idx < 0 ? matches.length - 1 : (idx + dir + matches.length) % matches.length;
    setCurId(matches[next]);
    setNonce((n) => n + 1);
  };

  const deepen = async () => {
    const live = room.getLiveTimeline();
    const before = matches.length;
    for (let i = 1; i <= MAX_PAGES && alive.current; i++) {
      if (live.getPaginationToken(Direction.Backward) === null) break;
      setPaging(i);
      try {
        await client.paginateEventTimeline(live, { backwards: true, limit: PAGE_SIZE });
      } catch (e) {
        console.warn('search paginate failed', e);
        break;
      }
      // старые события приходят зашифрованными — ждём расшифровку, иначе совпадений не увидим
      await new Promise((r) => setTimeout(r, 150));
      await Promise.all(live.getEvents().filter((e) => e.isBeingDecrypted()).map((e) => e.getDecryptionPromise()?.catch(() => {})));
      if (findMatches(live.getEvents(), query).length > before) break;
    }
    if (alive.current) setPaging(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(e.shiftKey ? 1 : -1); // Enter — к более старому, как в большинстве мессенджеров
    }
  };

  const trimmed = query.trim();
  const counter = !trimmed ? '' : matches.length ? `${idx + 1} из ${matches.length}` : 'Нет';

  return (
    <div className="searchbar">
      <header className="topbar topbar--room">
        <span className="searchbar__icon" aria-hidden="true"><ExtraIcon name="search" size={20} /></span>
        <input
          ref={input}
          className="searchbar__input"
          type="search"
          enterKeyHint="search"
          placeholder="Поиск в чате"
          aria-label="Поиск в чате"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="searchbar__count" aria-live="polite">{counter}</span>
        <Button variant="ghost" size="sm" icon aria-label="Предыдущее (старее)" disabled={!matches.length} onClick={() => go(-1)}><ExtraIcon name="arrowUp" /></Button>
        <Button variant="ghost" size="sm" icon aria-label="Следующее (новее)" disabled={!matches.length} onClick={() => go(1)}><ExtraIcon name="arrowDown" /></Button>
        <Button variant="ghost" size="sm" icon aria-label="Закрыть поиск" onClick={dismiss}><Icon name="close" size={18} /></Button>
      </header>
      {trimmed && canLoadOlder && (
        <div className="searchbar__more">
          {paging !== null ? (
            <span className="searchbar__progress"><span className="rl-spinner" /> Ищем в истории… {paging} из {MAX_PAGES}</span>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => void deepen()}>Искать дальше в истории</Button>
          )}
        </div>
      )}
    </div>
  );
}
