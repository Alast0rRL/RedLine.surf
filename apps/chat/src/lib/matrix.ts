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
export async function startMatrix(session: StoredSession): Promise<MatrixClient> {
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

  await client.initRustCrypto({ cryptoDatabasePrefix: CRYPTO_DB_PREFIX });

  await client.startClient({
    lazyLoadMembers: true,
    initialSyncLimit: 30,
    pendingEventOrdering: PendingEventOrdering.Detached,
    threadSupport: false,
  });
  return client;
}

/** Выход: удаляет устройство на сервере (вместе с его pusher'ами) и чистит локальные данные. */
export async function logout(client: MatrixClient | null): Promise<void> {
  if (client) {
    try {
      await client.logout(true);
    } catch (e) {
      console.warn('logout request failed', e);
    }
    client.stopClient();
    await wipeLocalData(client);
  } else {
    await wipeLocalData(null);
  }
}

/** Локальная очистка — после выхода или если сервер отозвал токен. */
export async function wipeLocalData(client: MatrixClient | null): Promise<void> {
  clearSession();
  secretStorageKeys.clear();
  try {
    if (client) await client.clearStores({ cryptoDatabasePrefix: CRYPTO_DB_PREFIX });
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
