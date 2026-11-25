/**
 * Telegram прямо в браузере (MTProto через mtcute): сессия лежит в IndexedDB этого устройства,
 * наш сервер Telegram-трафик не видит. Библиотека грузится лениво — только у тех, кто подключил TG.
 */
import type { TelegramClient } from '@mtcute/web';
import { telegramConfig } from '../config';
import { toMsg, type TgMsg } from './data';

const STORAGE = 'rl-tg';
const FLAG = 'rl.tg.connected';

let client: TelegramClient | null = null;
let starting: Promise<TelegramClient> | null = null;
let updating = false;

async function startUpdates(tg: TelegramClient) {
  if (updating) return;
  updating = true;
  await tg.startUpdatesLoop();
}
const listeners = new Set<() => void>();
const msgListeners = new Set<(m: TgMsg, edit: boolean) => void>();
const readListeners = new Set<(peerId: number) => void>();

/** Чат прочитан (обнулить счётчик в списке). */
export function onTgRead(fn: (peerId: number) => void): () => void {
  readListeners.add(fn);
  return () => readListeners.delete(fn);
}

export function notifyTgRead(peerId: number): void {
  for (const l of readListeners) l(peerId);
}

/**
 * В РФ web.telegram.org заблокирован: ходим через свой сервер (chat.redline.surf/tgws/<dc>),
 * он пересылает WebSocket в Telegram через VPN. MTProto зашифрован до Telegram — сервер видит только шум.
 */
function proxiedUrl(url: string): string {
  const m = url.match(/^wss:\/\/([a-z]+)\.web\.telegram\.org\/apiws$/);
  if (!m) return url;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/tgws/${m[1]}`;
}

class ProxiedWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(proxiedUrl(String(url)), protocols);
  }
}

function emit() {
  for (const l of listeners) l();
}

/** Подписка на «что-то поменялось» (вход/выход, новые сообщения) — для перерисовки. */
export function onTgChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function tgAvailable(): boolean {
  return !!telegramConfig();
}

export function isTgConnected(): boolean {
  try {
    return tgAvailable() && localStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

function setConnected(on: boolean) {
  try {
    if (on) localStorage.setItem(FLAG, '1');
    else localStorage.removeItem(FLAG);
  } catch {
    /* без хранилища вкладка пропадёт после перезагрузки */
  }
  emit();
}

/** Новые и изменённые сообщения во всех чатах. */
export function onTgMessage(fn: (m: TgMsg, edit: boolean) => void): () => void {
  msgListeners.add(fn);
  return () => msgListeners.delete(fn);
}

/** Клиент; при первом вызове грузит библиотеку и подключается к Telegram. */
export function getTg(): Promise<TelegramClient> {
  if (client) return Promise.resolve(client);
  if (starting) return starting;
  const cfg = telegramConfig();
  if (!cfg) return Promise.reject(new Error('Telegram не настроен'));
  starting = (async () => {
    const { TelegramClient, WebSocketTransport } = await import('@mtcute/web');
    const tg = new TelegramClient({
      apiId: cfg.apiId,
      apiHash: cfg.apiHash,
      storage: STORAGE,
      transport: new WebSocketTransport({ ws: ProxiedWebSocket }),
    });
    await tg.connect();
    tg.onNewMessage.add((m) => {
      const msg = toMsg(m);
      for (const l of msgListeners) l(msg, false);
      emit();
    });
    tg.onEditMessage.add((m) => {
      const msg = toMsg(m);
      for (const l of msgListeners) l(msg, true);
    });
    client = tg;
    return tg;
  })();
  starting.catch(() => {
    starting = null;
  });
  return starting;
}

/** После входа: запомнить на устройстве и запустить получение обновлений. */
export async function markSignedIn(): Promise<void> {
  const tg = await getTg();
  await startUpdates(tg);
  setConnected(true);
}

/** Уже подключённый аккаунт: проверить сессию и слушать обновления. */
export async function resumeTg(): Promise<TelegramClient> {
  const tg = await getTg();
  try {
    await tg.getMe();
  } catch (e) {
    if (isAuthError(e)) {
      setConnected(false);
      throw new Error('Сессия Telegram завершена — подключите заново');
    }
    throw e;
  }
  await startUpdates(tg);
  return tg;
}

export async function disconnectTg(): Promise<void> {
  try {
    const tg = await getTg();
    await tg.logOut();
  } catch {
    /* сессию всё равно забываем локально */
  }
  try {
    await client?.destroy();
  } catch {
    /* уже закрыт */
  }
  client = null;
  starting = null;
  updating = false;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(STORAGE);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  setConnected(false);
}

export function rpcCode(e: unknown): string | null {
  const t = e as { text?: unknown } | null;
  return t && typeof t.text === 'string' ? t.text : null;
}

function isAuthError(e: unknown): boolean {
  const c = rpcCode(e);
  return !!c && /^(AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED.*)$/.test(c);
}

/** Понятный текст ошибки Telegram для человека. */
export function tgErrorText(e: unknown): string {
  const c = rpcCode(e);
  switch (c) {
    case 'PHONE_NUMBER_INVALID':
      return 'Неверный номер телефона';
    case 'PHONE_CODE_INVALID':
      return 'Неверный код';
    case 'PHONE_CODE_EXPIRED':
      return 'Код устарел — запросите новый';
    case 'PASSWORD_HASH_INVALID':
      return 'Неверный пароль';
    case 'PHONE_NUMBER_BANNED':
      return 'Этот номер заблокирован в Telegram';
    case 'API_ID_INVALID':
      return 'Ключи приложения Telegram неверные — сообщите администратору';
  }
  if (c?.startsWith('FLOOD_WAIT')) return 'Слишком много попыток. Подождите и попробуйте позже';
  if (e instanceof Error && e.message === 'Telegram не настроен') return e.message;
  return 'Не получилось. Проверьте интернет и попробуйте ещё раз';
}
