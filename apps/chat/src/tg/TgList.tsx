import { useMemo, useState } from 'react';
import { Avatar, Button, Icon } from '../components/ui';
import { RealmSwitch } from '../components/RealmSwitch';
import { ThemeToggle } from '../components/ThemeToggle';
import { navigate } from '../hooks/useHashRoute';
import { formatListTime } from '../lib/events';
import { useTgDialogs } from './hooks';

/** Список чатов Telegram — в той же колонке, что и обычные чаты. */
export function TgList({ ready, activeId }: { ready: boolean; activeId?: number }) {
  const { dialogs, error } = useTgDialogs(ready);
  const [query, setQuery] = useState('');
  const q = query.trim().toLocaleLowerCase('ru');
  const shown = useMemo(() => {
    if (!dialogs) return null;
    const list = q ? dialogs.filter((d) => d.name.toLocaleLowerCase('ru').includes(q)) : dialogs;
    // закреплённые сверху, дальше по времени
    return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.date - a.date);
  }, [dialogs, q]);

  return (
    <section className="pane pane--list" aria-label="Чаты Telegram">
      <header className="topbar">
        <span className="topbar__logo">Redline</span>
        <span className="topbar__actions">
          <ThemeToggle className="topbar__wide" />
          <Button variant="ghost" icon aria-label="Настройки Telegram" onClick={() => navigate.tgConnect()}>
            <Icon name="settings" />
          </Button>
        </span>
      </header>
      <RealmSwitch />

      {dialogs && dialogs.length > 0 && (
        <div className="chat-search" role="search">
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск" aria-label="Поиск по чатам Telegram" autoComplete="off" enterKeyHint="search" />
          {query && (
            <Button variant="ghost" size="sm" icon className="chat-search__clear" aria-label="Очистить поиск" onClick={() => setQuery('')}>
              <Icon name="close" size={16} />
            </Button>
          )}
        </div>
      )}

      <div className="pane__scroll">
        {error && !dialogs ? (
          <div className="empty"><p>{error}</p></div>
        ) : !shown ? (
          <div className="empty"><span className="rl-spinner" /></div>
        ) : shown.length === 0 ? (
          <div className="empty"><p>{q ? 'Ничего не найдено' : 'Пока нет чатов'}</p></div>
        ) : (
          <ul className="chat-list">
            {shown.map((d) => (
              <li key={d.id}>
                <a
                  className={`chat-row${d.unread > 0 ? ' chat-row--unread' : ''}`}
                  href={`#/tg/${d.id}`}
                  aria-current={d.id === activeId ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate.tgChat(d.id);
                  }}
                >
                  <Avatar name={d.name} seed={`tg:${d.id}`} round />
                  <span className="chat-row__main">
                    <span className="chat-row__name"><span className="chat-row__title">{d.name}</span></span>
                    <span className="chat-row__preview">{d.preview}</span>
                  </span>
                  <span className="chat-row__meta">
                    <span className="chat-row__time">{formatListTime(d.date)}</span>
                    <span className="chat-row__icons">
                      {d.unread > 0 && <span className="rl-badge">{d.unread > 99 ? '99+' : d.unread}</span>}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
