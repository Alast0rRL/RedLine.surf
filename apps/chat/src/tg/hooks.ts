import { useEffect, useReducer, useState } from 'react';
import { onTgChange, onTgMessage, onTgRead, resumeTg, tgErrorText } from './client';
import { loadDialogs, msgPreview, tgAvatar, type TgDialog } from './data';

/** Перерисовка при входе/выходе и новых сообщениях. */
export function useTgVersion(): number {
  const [v, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => onTgChange(bump), []);
  return v;
}

type Ready = { state: 'loading' } | { state: 'ready' } | { state: 'error'; error: string };

/** Подключиться к уже вошедшему аккаунту (один раз на запуск приложения). */
let resumed: Promise<unknown> | null = null;
export function useTgReady(): [Ready, () => void] {
  const [ready, setReady] = useState<Ready>({ state: 'loading' });
  const [attempt, retry] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    let alive = true;
    if (!resumed) resumed = resumeTg();
    resumed.then(
      () => alive && setReady({ state: 'ready' }),
      (e) => {
        resumed = null;
        if (alive) setReady({ state: 'error', error: e instanceof Error && e.message.startsWith('Сессия') ? e.message : tgErrorText(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [attempt]);
  return [ready, () => {
    setReady({ state: 'loading' });
    retry();
  }];
}

const DIALOGS_DEBOUNCE_MS = 1200;

export function useTgDialogs(ready: boolean): { dialogs: TgDialog[] | null; error: string | null } {
  const [dialogs, setDialogs] = useState<TgDialog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    let timer = 0;
    const load = () =>
      loadDialogs().then(
        (d) => {
          if (!alive) return;
          setDialogs(d);
          setError(null);
        },
        (e) => {
          console.error(e);
          if (alive) setError(tgErrorText(e));
        },
      );
    void load();
    // новое сообщение: сразу поднимаем чат наверх, а точный список — с задержкой одним запросом
    const off = onTgMessage((m, edit) => {
      if (edit) return;
      setDialogs((list) => {
        if (!list) return list;
        const i = list.findIndex((d) => d.id === m.chatId);
        if (i < 0) return list;
        const d = list[i];
        const upd: TgDialog = { ...d, preview: (m.out ? 'Вы: ' : d.group ? `${m.sender}: ` : '') + msgPreview(m), date: m.date, unread: m.out ? 0 : d.unread + 1 };
        return [upd, ...list.slice(0, i), ...list.slice(i + 1)];
      });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), DIALOGS_DEBOUNCE_MS);
    });
    const offRead = onTgRead((id) => setDialogs((list) => list?.map((d) => (d.id === id && d.unread ? { ...d, unread: 0 } : d)) ?? list));
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      off();
      offRead();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ready]);
  return { dialogs, error };
}

/** Фото профиля Telegram (null — нет или ещё грузится). */
export function useTgAvatar(peerId: number, ready = true): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void tgAvatar(peerId).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [peerId, ready]);
  return url;
}
