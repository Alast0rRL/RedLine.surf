import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ClientEvent, HttpApiEvent, SyncState, type MatrixClient } from 'matrix-js-sdk';
import { loadConfig } from '../config';
import { loginWithPin, preparePinSession, saveLink, type PersonalLink } from '../lib/pin';
import { loadSession } from '../lib/session';
import { bindPhone, getBoundPhone, savedPhone } from '../lib/phone';
import { PhoneOffer, type PhoneOfferData } from '../screens/PhoneOffer';
import { loginWithPassword, logout as doLogout, startMatrix, wipeLocalData } from '../lib/matrix';
import { attachForegroundNotifications } from '../lib/notifications';

export type AppStatus = 'boot' | 'logged-out' | 'starting' | 'ready' | 'fatal';

interface MatrixState {
  status: AppStatus;
  client: MatrixClient | null;
  /** null — синхронизация в норме; иначе состояние проблемы */
  syncProblem: 'reconnecting' | 'error' | null;
  error: string | null;
  /** Текст шага открытия чата, который надо показать после входа. */
  progress: string | null;
  login: (username: string, password: string) => Promise<void>;
  enterPin: (link: PersonalLink, pin: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<MatrixState | null>(null);

function errorText(e: unknown): string {
  const err = e as { errcode?: string; httpStatus?: number; message?: string; data?: { error?: string } };
  if (err?.errcode === 'M_FORBIDDEN') return 'Неверный логин или пароль';
  if (err?.errcode === 'M_USER_DEACTIVATED') return 'Аккаунт отключён';
  if (err?.errcode === 'M_LIMIT_EXCEEDED') return 'Слишком много попыток. Подождите немного';
  if (err?.httpStatus === undefined && /fetch|network/i.test(String(err?.message))) return 'Нет связи с сервером';
  return err?.data?.error || err?.message || 'Неизвестная ошибка';
}

export function MatrixProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AppStatus>('boot');
  const [client, setClient] = useState<MatrixClient | null>(null);
  const [syncProblem, setSyncProblem] = useState<MatrixState['syncProblem']>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [phoneOffer, setPhoneOffer] = useState<PhoneOfferData | null>(null);
  const clientRef = useRef<MatrixClient | null>(null);

  const start = useCallback(
    async (session: NonNullable<ReturnType<typeof loadSession>>, beforeReady?: (c: MatrixClient) => Promise<void>) => {
      setStatus('starting');
      const c = await startMatrix(session);
      clientRef.current = c;
      setClient(c);

      c.on(HttpApiEvent.SessionLoggedOut, async () => {
        c.stopClient();
        await wipeLocalData(c);
        clientRef.current = null;
        setClient(null);
        setError('Вход сброшен. Войди снова');
        setStatus('logged-out');
      });

      await new Promise<void>((resolve) => {
        if (c.isInitialSyncComplete()) return resolve();
        const onSync = (state: SyncState) => {
          if (state === SyncState.Prepared || state === SyncState.Syncing) {
            c.off(ClientEvent.Sync, onSync);
            resolve();
          }
        };
        c.on(ClientEvent.Sync, onSync);
      });

      c.on(ClientEvent.Sync, (state) => {
        setSyncProblem(
          state === SyncState.Reconnecting ? 'reconnecting' : state === SyncState.Error ? 'error' : null,
        );
      });
      attachForegroundNotifications(c);
      if (beforeReady) await beforeReady(c);
      setStatus('ready');
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadConfig();
      } catch (e) {
        if (!cancelled) {
          setError(`Не удалось загрузить настройки: ${errorText(e)}`);
          setStatus('fatal');
        }
        return;
      }
      const session = loadSession();
      if (!session) {
        if (!cancelled) setStatus('logged-out');
        return;
      }
      try {
        await start(session);
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setError(errorText(e));
          setStatus('logged-out');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [start]);

  const login = useCallback(
    async (username: string, password: string) => {
      setError(null);
      const { homeserverUrl } = await loadConfig();
      try {
        const session = await loginWithPassword(homeserverUrl, username, password);
        await start(session);
      } catch (e) {
        setStatus('logged-out');
        throw new Error(errorText(e));
      }
    },
    [start],
  );

  const enterPin = useCallback(
    async (link: PersonalLink, pin: string) => {
      setError(null);
      setProgress(null);
      const { homeserverUrl } = await loadConfig();
      // ошибки входа остаются на форме: статус не меняется, сессия не создаётся
      const r = await loginWithPin(homeserverUrl, link, pin);
      saveLink(link);
      try {
        await start(r.session, async (c) => {
          setProgress('Открываем чат…');
          await preparePinSession(c, link, r);
          history.replaceState(null, '', '/#/');
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        });
        // PIN ещё в памяти: если номер не привязан, предлагаем привязать (ошибки не мешают входу).
        // Если привязан и номер известен этому устройству, обновляем привязку под текущий PIN:
        // после сброса PIN админом вход по номеру сразу работает с новым PIN.
        const token = r.session.accessToken;
        getBoundPhone(token)
          .then(async (mask) => {
            if (mask === null) return setPhoneOffer({ link, pin, token });
            const phone = savedPhone(link.user);
            if (phone) await bindPhone(token, link, phone, pin);
          })
          .catch(() => console.warn('Не удалось проверить привязку номера'));
      } catch (e) {
        console.error(e);
        const c = clientRef.current;
        if (c) await doLogout(c);
        else await wipeLocalData(null);
        clientRef.current = null;
        setClient(null);
        setError('Не удалось открыть чат. Введи PIN ещё раз');
        setStatus('logged-out');
      } finally {
        setProgress(null);
      }
    },
    [start],
  );

  const logout = useCallback(async () => {
    const c = clientRef.current;
    clientRef.current = null;
    setClient(null);
    setPhoneOffer(null);
    setStatus('logged-out');
    await doLogout(c);
  }, []);

  return (
    <Ctx.Provider value={{ status, client, syncProblem, error, progress, login, enterPin, logout }}>
      {children}
      {phoneOffer && status === 'ready' && <PhoneOffer offer={phoneOffer} onClose={() => setPhoneOffer(null)} />}
    </Ctx.Provider>
  );
}

export function useMatrix(): MatrixState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMatrix outside MatrixProvider');
  return v;
}

/** Клиент в экранах, которые показываются только в состоянии ready. */
export function useClient(): MatrixClient {
  const { client } = useMatrix();
  if (!client) throw new Error('client not ready');
  return client;
}
