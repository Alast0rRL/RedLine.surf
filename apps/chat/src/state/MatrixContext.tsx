import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ClientEvent, HttpApiEvent, SyncState, type MatrixClient } from 'matrix-js-sdk';
import { getRealm, hasMcRealm, loadConfig, otherRealm, realmConfig, setRealm, type Realm } from '../config';
import { ACCOUNT_DELETED, forgetLink, isDeactivated, loadLink, loginWithPin, preparePinSession, saveLink, type PersonalLink, type PinLogin } from '../lib/pin';
import { loadSession } from '../lib/session';
import { bindPhone, getBoundPhone, NO_TOKEN, savedPhone, type LinkedAccount } from '../lib/phone';
import { PhoneOffer, type PhoneOfferData } from '../screens/PhoneOffer';
import { RealmPin } from '../screens/RealmPin';
import { loginWithPassword, logout as doLogout, logoutStored, startMatrix, wipeLocalData } from '../lib/matrix';
import { attachForegroundNotifications } from '../lib/notifications';
import { ensurePusher } from '../lib/push';

/** Вход во второй мир, сделанный с PIN в руках: при первом открытии им доводится настройка шифрования. */
export interface PreparedRealm {
  link: PersonalLink;
  login: PinLogin;
}

/** Второй мир открыт на этом устройстве: есть сеанс или хотя бы ссылка (тогда спросим PIN). */
function otherAvailable(): boolean {
  if (!hasMcRealm()) return false;
  const o = otherRealm();
  return !!loadSession(o) || !!loadLink(o);
}

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
  enterPin: (link: PersonalLink & { linked?: LinkedAccount }, pin: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Текущий мир: семья или Minecraft. */
  realm: Realm;
  /** У человека на этом устройстве есть второй мир — показываем переключатель. */
  hasOther: boolean;
  /** Переключиться в другой мир (клиент текущего останавливается, его данные остаются). */
  switchRealm: (r: Realm, prepared?: PreparedRealm) => Promise<void>;
  /** Пересчитать hasOther (после связки или отвязки в настройках). */
  refreshOther: () => void;
}

const Ctx = createContext<MatrixState | null>(null);

function errorText(e: unknown): string {
  const err = e as { errcode?: string; httpStatus?: number; message?: string; data?: { error?: string } };
  if (err?.errcode === 'M_FORBIDDEN') return 'Неверный логин или пароль';
  if (err?.errcode === 'M_USER_DEACTIVATED') return ACCOUNT_DELETED;
  if (err?.errcode === 'M_LIMIT_EXCEEDED') return err.data?.error || 'Слишком много попыток входа. Попробуйте позже.';
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
  const [realm, setRealmState] = useState<Realm>(getRealm());
  const [hasOther, setHasOther] = useState(false);
  const [askPin, setAskPin] = useState<Realm | null>(null);
  const clientRef = useRef<MatrixClient | null>(null);
  const pending = useRef(new Map<Realm, PreparedRealm>());
  /** Растёт при выходе и переключении: запуск или фоновый вход старого поколения себя отменяет. */
  const gen = useRef(0);
  const switching = useRef(false);
  const startRef = useRef<typeof start | null>(null);
  /** Растёт только при выходе: фоновый вход во второй мир после выхода себя отменяет. */
  const outGen = useRef(0);
  const refreshOther = useCallback(() => setHasOther(otherAvailable()), []);

  const start = useCallback(
    async (session: NonNullable<ReturnType<typeof loadSession>>, beforeReady?: (c: MatrixClient) => Promise<void>) => {
      setStatus('starting');
      const g = gen.current;
      const c = await startMatrix(session);
      if (g !== gen.current) {
        // пока поднимались, человек вышел или переключился
        c.stopClient();
        throw new Error('cancelled');
      }
      clientRef.current = c;
      setClient(c);

      c.on(HttpApiEvent.SessionLoggedOut, async (err?: { errcode?: string }) => {
        c.stopClient();
        await wipeLocalData(c);
        if (clientRef.current === c) clientRef.current = null;
        setClient(null);
        setError(err?.errcode === 'M_USER_DEACTIVATED' ? ACCOUNT_DELETED : 'Вход сброшен. Войди снова');
        // сеанс этого мира отозван, а второй мир жив — открываем его, а не экран входа
        const o = otherRealm();
        const os = hasMcRealm() ? loadSession(o) : null;
        if (os && startRef.current) {
          gen.current += 1;
          setRealm(o);
          setRealmState(o);
          setHasOther(otherAvailable());
          startRef.current(os).catch(() => setStatus('logged-out'));
          return;
        }
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
      if (g !== gen.current) {
        c.stopClient();
        throw new Error('cancelled');
      }
      // уведомления уже включены в браузере — pusher и для этого аккаунта (второго мира)
      ensurePusher(c, getRealm()).catch(() => console.warn('Не удалось включить уведомления этого чата'));
      setStatus('ready');
    },
    [],
  );
  startRef.current = start;

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
      // клик по уведомлению из другого мира: /?realm=mc#/room/…
      const q = new URLSearchParams(location.search).get('realm');
      if (q === 'mc' || q === 'family') {
        setRealm(q);
        history.replaceState(null, '', location.pathname + location.hash);
      }
      if (hasMcRealm()) {
        // до второго мира сеанс Minecraft лежал под ключом семьи
        const fam = loadSession('family');
        if (fam && fam.baseUrl === realmConfig('mc').homeserverUrl) {
          // базы rl-sync/rl-crypto принадлежат аккаунту Minecraft: стираем их вместе с сеансом, вход заново
          await logoutStored('family');
          forgetLink('family');
          setRealm('mc');
        }
        if (!loadSession() && loadSession(otherRealm())) setRealm(otherRealm());
      }
      setRealmState(getRealm());
      setHasOther(otherAvailable());
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
    async (link: PersonalLink & { linked?: LinkedAccount }, pin: string) => {
      setError(null);
      setProgress(null);
      const { homeserverUrl } = await loadConfig();
      // ошибки входа остаются на форме: статус не меняется, сессия не создаётся
      const r = await loginWithPin(homeserverUrl, link, pin);
      saveLink(link);
      try {
        await start(r.session, async (c) => {
          setProgress('Открываем чат…');
          // Разовая настройка шифрования (needs-setup) должна завершиться: при ошибке — назад к PIN,
          // повторный ввод повторит настройку. Разблокировка (needs-unlock) идёт в фоне и сюда не бросает.
          await preparePinSession(c, link, r);
          history.replaceState(null, '', '/#/');
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        });
        // PIN ещё в памяти: если номер не привязан, предлагаем привязать (ошибки не мешают входу).
        // Если привязан и номер известен этому устройству, обновляем привязку под текущий PIN:
        // после сброса PIN админом вход по номеру сразу работает с новым PIN.
        // второй мир того же человека: ключ и PIN общие, входим заранее, открывать будем по переключателю
        const lk = link.linked;
        if (lk && hasMcRealm()) {
          const other: PersonalLink = { user: lk.user, key: link.key, token: NO_TOKEN, name: lk.user };
          const g = outGen.current;
          loginWithPin(realmConfig(lk.realm).homeserverUrl, other, pin, lk.realm)
            .then(async (login) => {
              // за это время вышли — сеанс второго мира не оставляем
              if (g !== outGen.current) return void (await logoutStored(lk.realm));
              saveLink(other, lk.realm);
              pending.current.set(lk.realm, { link: other, login });
              setHasOther(true);
            })
            .catch((e) => {
              console.warn('second realm login failed', e);
              // PIN там другой (сбросили в одном мире) — переключатель всё равно покажем, PIN спросим при открытии
              if (g === outGen.current && !isDeactivated(e)) {
                saveLink(other, lk.realm);
                setHasOther(true);
              }
            });
        }
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
    // один выход на оба мира
    gen.current += 1;
    outGen.current += 1;
    pending.current.clear();
    setHasOther(false);
    const o = otherRealm();
    // второй мир первым: его сеанс снимается сразу, и выход текущего уже отпишет push браузера
    const other = hasMcRealm() ? logoutStored(o).then(() => forgetLink(o)) : Promise.resolve();
    await Promise.all([other, doLogout(c)]);
  }, []);

  const switchRealm = useCallback(
    async (r: Realm, prepared?: PreparedRealm) => {
      if (r === getRealm() || switching.current) return;
      if (prepared) pending.current.set(r, prepared);
      const session = loadSession(r);
      if (!session) {
        // сеанса нет (вход во второй мир не удался) — спросим PIN, текущий чат пока работает
        if (loadLink(r)) setAskPin(r);
        return;
      }
      switching.current = true;
      gen.current += 1;
      const c = clientRef.current;
      clientRef.current = null;
      c?.removeAllListeners();
      c?.stopClient();
      setClient(null);
      setPhoneOffer(null);
      setRealm(r);
      setRealmState(r);
      setHasOther(true);
      history.replaceState(null, '', '/#/');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      try {
        await start(session, async (nc) => {
          const p = pending.current.get(r);
          if (!p) return;
          pending.current.delete(r);
          setProgress('Открываем чат…');
          await preparePinSession(nc, p.link, p.login);
        });
      } catch (e) {
        console.error(e);
        if ((e as Error)?.message === 'cancelled') return;
        (clientRef.current as MatrixClient | null)?.stopClient();
        clientRef.current = null;
        setClient(null);
        const back = otherRealm(r);
        setRealm(back);
        setRealmState(back);
        const bs = loadSession(back);
        setError('Не удалось открыть второй чат');
        if (!bs) setStatus('logged-out');
        else await start(bs).catch(() => setStatus('logged-out'));
      } finally {
        switching.current = false;
        setProgress(null);
      }
    },
    [start],
  );

  const unlockOther = useCallback(
    async (r: Realm, pin: string) => {
      const link = loadLink(r);
      if (!link) throw new Error('Войдите заново');
      const login = await loginWithPin(realmConfig(r).homeserverUrl, link, pin, r);
      setAskPin(null);
      await switchRealm(r, { link, login });
    },
    [switchRealm],
  );

  return (
    <Ctx.Provider
      value={{ status, client, syncProblem, error, progress, login, enterPin, logout, realm, hasOther, switchRealm, refreshOther }}
    >
      {children}
      {phoneOffer && status === 'ready' && <PhoneOffer offer={phoneOffer} onClose={() => setPhoneOffer(null)} />}
      {askPin && status === 'ready' && (
        <RealmPin realm={askPin} onSubmit={(pin) => unlockOther(askPin, pin)} onClose={() => setAskPin(null)} />
      )}
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
