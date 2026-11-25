import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { onTgChange, onTgMessage, resumeTg, tgErrorText } from './client';
import { loadDialogs, loadHistory, markRead, msgPreview, type TgDialog, type TgMsg } from './data';

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
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      off();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ready]);
  return { dialogs, error };
}

export function useTgHistory(peerId: number, ready: boolean) {
  const [msgs, setMsgs] = useState<TgMsg[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atStart, setAtStart] = useState(false);
  const msgsRef = useRef<TgMsg[] | null>(null);
  msgsRef.current = msgs;

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setMsgs(null);
    setAtStart(false);
    loadHistory(peerId).then(
      (m) => {
        if (!alive) return;
        setMsgs(m);
        if (m.length < 50) setAtStart(true);
        void markRead(peerId).catch(() => {});
      },
      (e) => {
        console.error(e);
        if (alive) setError(tgErrorText(e));
      },
    );
    const off = onTgMessage((m, edit) => {
      if (m.chatId !== peerId) return;
      setMsgs((list) => {
        if (!list) return list;
        const i = list.findIndex((x) => x.id === m.id);
        if (i >= 0) return list.map((x) => (x.id === m.id ? m : x));
        if (edit) return list;
        return [...list, m];
      });
      if (!m.out && document.visibilityState === 'visible') void markRead(peerId).catch(() => {});
    });
    return () => {
      alive = false;
      off();
    };
  }, [peerId, ready]);

  const loadOlder = useCallback(async () => {
    const list = msgsRef.current;
    if (!list?.length || loadingOlder || atStart) return;
    setLoadingOlder(true);
    try {
      const older = await loadHistory(peerId, list[0].id);
      if (older.length < 50) setAtStart(true);
      setMsgs((cur) => (cur ? [...older.filter((o) => !cur.some((c) => c.id === o.id)), ...cur] : cur));
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingOlder(false);
    }
  }, [peerId, loadingOlder, atStart]);

  /** Своё отправленное — сразу в ленту (обновление от Telegram потом заменит его по id). */
  const addOwn = useCallback((m: TgMsg) => {
    setMsgs((list) => (list && !list.some((x) => x.id === m.id) ? [...list, m] : list));
  }, []);

  return { msgs, error, loadOlder, loadingOlder, atStart, addOwn };
}
