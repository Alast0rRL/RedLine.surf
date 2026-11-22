import {
  createClient,
  IndexedDBStore,
  MemoryStore,
  PendingEventOrdering,
  type MatrixClient,
  type SecretStorage,
} from 'matrix-js-sdk';
import { clearSession, saveSession, type StoredSession } from './session';

const SYNC_DB = 'rl-sync';
const CRYPTO_DB_PREFIX = 'rl-crypto';

/**
 * Ключи хранилища секретов, которые пользователь ввёл (ключ восстановления)
 * или которые мы только что создали. Живут только в памяти вкладки.
 */
const secretStorageKeys = new Map<string, Uint8Array<ArrayBuffer>>();

/** Ключ, создаваемый прямо сейчас (bootstrapSecretStorage): его id ещё неизвестен. */
let pendingNewKey: Uint8Array<ArrayBuffer> | null = null;

/** Идущая очистка после выхода: новый вход ждёт её, иначе откроет хранилища прежнего аккаунта. */
let pendingWipe: Promise<void> = Promise.resolve();

/** Ключи в браузере от другого аккаунта или устройства: остались после прерванного выхода. */
function isForeignCryptoStore(e: unknown): boolean {
  return String(e instanceof Error ? e.message : e).includes("doesn't match the account in the constructor");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}

export function cacheSecretStorageKey(keyId: string, key: Uint8Array<ArrayBuffer>): void {
  secretStorageKeys.set(keyId, key);
}

export function setPendingNewSecretStorageKey(key: Uint8Array<ArrayBuffer> | null): void {
  pendingNewKey = key;
}

async function getSecretStorageKey(
  { keys }: { keys: Record<string, SecretStorage.SecretStorageKeyDescription> },
): Promise<[string, Uint8Array<ArrayBuffer>] | null> {
  const ids = Object.keys(keys);
  for (const keyId of ids) {
    const key = secretStorageKeys.get(keyId);
    if (key) return [keyId, key];
  }
  // при создании хранилища SDK спрашивает ровно один новый ключ
  if (pendingNewKey && ids.length === 1) {
    secretStorageKeys.set(ids[0], pendingNewKey);
    return [ids[0], pendingNewKey];
  }
  return null;
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'web';
  return `Redline Chat · ${os}`;
}

/** Логин по паролю. `username` — «mari», «@mari:server» или «mari:server». */
export async function loginWithPassword(baseUrl: string, username: string, password: string): Promise<StoredSession> {
  const tmp = createClient({ baseUrl });
  const user = username.trim().replace(/^@/, '');
  const res = await tmp.loginRequest({
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: user.includes(':') ? `@${user}` : user },
    password,
    initial_device_display_name: deviceName(),
  });
  const session: StoredSession = {
    baseUrl,
    userId: res.user_id,
    deviceId: res.device_id,
    accessToken: res.access_token,
  };
  saveSession(session);
  return session;
}

/** Создаёт клиент, поднимает хранилища и E2E и запускает синхронизацию. */
export async function startMatrix(session: StoredSession, retried = false): Promise<MatrixClient> {
  await pendingWipe;
  let store: IndexedDBStore | MemoryStore;
  try {
    store = new IndexedDBStore({ indexedDB: window.indexedDB, dbName: SYNC_DB, localStorage: window.localStorage });
    await store.startup();
  } catch (e) {
    // приватный режим Firefox и т.п. — работаем без кеша синхронизации
    console.warn('IndexedDB sync store unavailable, falling back to memory', e);
    store = new MemoryStore({ localStorage: window.localStorage });
  }

  const client = createClient({
    baseUrl: session.baseUrl,
    accessToken: session.accessToken,
    userId: session.userId,
    deviceId: session.deviceId,
    store,
    timelineSupport: true,
    cryptoCallbacks: { getSecretStorageKey },
  });

  try {
    await client.initRustCrypto({ cryptoDatabasePrefix: CRYPTO_DB_PREFIX });
  } catch (e) {
    if (retried || !isForeignCryptoStore(e)) throw e;
    // Чужие ключи нашему сеансу не нужны: его собственных в браузере всё равно нет
    console.warn('crypto store belongs to another session, wiping it', e);
    client.stopClient();
    await withTimeout(client.clearStores({ cryptoDatabasePrefix: CRYPTO_DB_PREFIX }), 10_000);
    return startMatrix(session, true);
  }

  await client.startClient({
    lazyLoadMembers: true,
    initialSyncLimit: 30,
    pendingEventOrdering: PendingEventOrdering.Detached,
    threadSupport: false,
  });
  return client;
}

/**
 * Выход: сначала чистит локальные данные (экран входа уже показан, новый вход ждёт очистку),
 * потом удаляет устройство на сервере вместе с его pusher'ами.
 */
export async function logout(client: MatrixClient | null): Promise<void> {
  if (!client) return wipeLocalData(null);
  client.stopClient();
  await wipeLocalData(client);
  try {
    await client.logout(true);
  } catch (e) {
    console.warn('logout request failed', e);
  }
}

/** Локальная очистка — после выхода или если сервер отозвал токен. */
export function wipeLocalData(client: MatrixClient | null): Promise<void> {
  // сразу, а не в очереди: иначе сотрётся сессия входа, начатого во время очистки
  clearSession();
  secretStorageKeys.clear();
  const wipe = pendingWipe.then(() => wipeStores(client));
  pendingWipe = wipe.catch(() => undefined);
  return wipe;
}

async function wipeStores(client: MatrixClient | null): Promise<void> {
  try {
    // deleteDatabase ждёт закрытия всех соединений: без предела зависнет вход
    if (client) await withTimeout(client.clearStores({ cryptoDatabasePrefix: CRYPTO_DB_PREFIX }), 10_000);
  } catch (e) {
    console.warn('clearStores failed', e);
  }
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    /* нет SW — нечего чистить */
  }
}
