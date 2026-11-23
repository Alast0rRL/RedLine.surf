import type { MatrixClient } from 'matrix-js-sdk';
import { decryptAttachment, type EncryptedFileInfo } from './attachments';

/**
 * Загрузка медиа с авторизацией (authenticated media, /_matrix/client/v1/media)
 * и расшифровкой. Результат — blob: URL, кешируется по ключу.
 */

export interface MediaSource {
  /** mxc:// для незашифрованных */
  url?: string;
  /** EncryptedFile для E2E-комнат */
  file?: EncryptedFileInfo;
  mimetype?: string;
}

export interface Thumb {
  width: number;
  height: number;
}

const MAX_ENTRIES = 150;

interface Entry {
  promise: Promise<string>;
  /** сколько экранных компонентов сейчас держат этот blob: URL */
  refs: number;
  /** готовый blob: URL (пока идёт загрузка — null) */
  url: string | null;
}

const cache = new Map<string, Entry>();

/** Выкидываем самые старые записи, которых никто не держит: иначе погаснут картинки на экране. */
function evict(): void {
  if (cache.size <= MAX_ENTRIES) return;
  for (const [key, e] of cache) {
    if (cache.size <= MAX_ENTRIES) break;
    if (e.refs > 0 || !e.url) continue;
    cache.delete(key);
    URL.revokeObjectURL(e.url);
  }
}

/* ---------------- очередь загрузок: не больше 6 сразу, аватары и миниатюры вперёд ---------------- */

type Priority = 'high' | 'low';

const MAX_PARALLEL = 6;
let active = 0;
const queues: Record<Priority, (() => void)[]> = { high: [], low: [] };

function pump(): void {
  while (active < MAX_PARALLEL) {
    const next = queues.high.shift() ?? queues.low.shift();
    if (!next) return;
    active++;
    next();
  }
}

function queued<T>(priority: Priority, task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queues[priority].push(() => {
      task()
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    });
    pump();
  });
}

/* ---------------- постоянный кеш миниатюр и аватаров (Cache API) ---------------- */

const STORE = 'rl-media-v1';
const PERSIST_MAX_BYTES = 512 * 1024;
const STORE_MAX_BYTES = 50 * 1024 * 1024;
const TRIM_EVERY = 25;
let putsSinceTrim = TRIM_EVERY; // первая запись сразу проверяет объём

const storeRequest = (key: string) => new Request(`${location.origin}/__rl-media/${encodeURIComponent(key)}`);

async function storeGet(key: string): Promise<Blob | null> {
  try {
    if (typeof caches === 'undefined') return null;
    const res = await (await caches.open(STORE)).match(storeRequest(key));
    return res ? await res.blob() : null;
  } catch {
    return null;
  }
}

/** Поколение кеша: растёт при выходе, чтобы запоздавшие загрузки прежнего аккаунта ничего не сохранили. */
let generation = 0;

async function storePut(key: string, data: ArrayBuffer, type: string, gen: number): Promise<void> {
  try {
    if (gen !== generation) return;
    if (typeof caches === 'undefined' || data.byteLength > PERSIST_MAX_BYTES) return;
    const c = await caches.open(STORE);
    if (gen !== generation) return;
    await c.put(
      storeRequest(key),
      new Response(data, {
        headers: { 'Content-Type': type, 'x-rl-size': String(data.byteLength), 'x-rl-ts': String(Date.now()) },
      }),
    );
    if (++putsSinceTrim >= TRIM_EVERY) {
      putsSinceTrim = 0;
      await trimStore(c);
    }
  } catch {
    /* кеш необязателен */
  }
}

/** Держим не больше ~50 МБ: если больше, удаляем самые старые записи. */
async function trimStore(c: Cache): Promise<void> {
  const rows: { req: Request; size: number; ts: number }[] = [];
  let total = 0;
  for (const req of await c.keys()) {
    const res = await c.match(req);
    const size = Number(res?.headers.get('x-rl-size')) || 0;
    total += size;
    rows.push({ req, size, ts: Number(res?.headers.get('x-rl-ts')) || 0 });
  }
  if (total <= STORE_MAX_BYTES) return;
  rows.sort((x, y) => x.ts - y.ts);
  for (const r of rows) {
    if (total <= STORE_MAX_BYTES * 0.8) break;
    await c.delete(r.req);
    total -= r.size;
  }
}

/** Выход: стираем сохранённые миниатюры и освобождаем blob: URL. */
export async function clearMediaCache(): Promise<void> {
  generation++;
  for (const e of cache.values()) if (e.url) URL.revokeObjectURL(e.url);
  cache.clear();
  try {
    if (typeof caches !== 'undefined') await caches.delete(STORE);
  } catch {
    /* нечего чистить */
  }
}

function fetchAuthed(client: MatrixClient, httpUrl: string, priority: Priority): Promise<ArrayBuffer> {
  return queued(priority, async () => {
    const res = await fetch(httpUrl, {
      headers: { Authorization: `Bearer ${client.getAccessToken()}` },
    });
    if (!res.ok) throw new Error(`media HTTP ${res.status}`);
    return res.arrayBuffer();
  });
}

function getEntry(client: MatrixClient, src: MediaSource, thumb?: Thumb): Entry {
  const mxc = src.file?.url ?? src.url;
  if (!mxc?.startsWith('mxc://')) {
    return { promise: Promise.reject(new Error('Нет ссылки на медиа')), refs: 0, url: null };
  }
  const key = `${mxc}|${src.file ? 'enc' : thumb ? `${thumb.width}x${thumb.height}` : 'full'}`;
  const hit = cache.get(key);
  if (hit) {
    // обновляем «свежесть» (LRU)
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  // на диск кладём только миниатюры и аватары незашифрованного медиа: расшифрованное содержимое E2E-чатов не храним
  const persist = !src.file && !!thumb;
  const gen = generation;
  const job = (async () => {
    if (persist) {
      const stored = await storeGet(key);
      if (stored) return URL.createObjectURL(stored);
    }
    const httpUrl = src.file
      ? client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true)
      : thumb
        ? client.mxcUrlToHttp(mxc, thumb.width, thumb.height, 'scale', false, true, true)
        : client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true);
    if (!httpUrl) throw new Error('Не удалось построить URL медиа');
    let data = await fetchAuthed(client, httpUrl, thumb ? 'high' : 'low');
    if (src.file) data = await decryptAttachment(data, src.file);
    const type = src.mimetype || 'application/octet-stream';
    if (persist) void storePut(key, data, type, gen);
    return URL.createObjectURL(new Blob([data], { type }));
  })();
  const entry: Entry = { promise: job, refs: 0, url: null };
  cache.set(key, entry);
  job.then(
    (u) => {
      if (gen !== generation) {
        URL.revokeObjectURL(u); // аккаунт сменился, пока шла загрузка
        return;
      }
      entry.url = u;
      evict();
    },
    // неудачные загрузки не кешируем — можно повторить
    () => {
      if (cache.get(key) === entry) cache.delete(key);
    },
  );
  return entry;
}

/** blob: URL для медиа. thumb — только для незашифрованных (сервер не видит содержимое E2E). Ссылку не удерживает. */
export function getMediaUrl(client: MatrixClient, src: MediaSource, thumb?: Thumb): Promise<string> {
  return getEntry(client, src, thumb).promise;
}

/** То же, но запись защищена от вытеснения, пока не вызван release (повторный вызов безвреден). */
export function acquireMedia(
  client: MatrixClient,
  src: MediaSource,
  thumb?: Thumb,
): { promise: Promise<string>; release: () => void } {
  const entry = getEntry(client, src, thumb);
  entry.refs++;
  let released = false;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry.refs--;
      evict();
    },
  };
}

/** Сырые байты медиа (для голосовых: декодирование/волна). */
export async function getMediaBytes(client: MatrixClient, src: MediaSource): Promise<ArrayBuffer> {
  const url = await getMediaUrl(client, src);
  return (await fetch(url)).arrayBuffer();
}

/** Блоб без кеша (файлы и видео): вызывающий сам делает createObjectURL и revoke. */
export async function loadMediaBlob(client: MatrixClient, src: MediaSource): Promise<Blob> {
  const mxc = src.file?.url ?? src.url;
  if (!mxc?.startsWith('mxc://')) throw new Error('Нет ссылки на медиа');
  const httpUrl = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true);
  if (!httpUrl) throw new Error('Не удалось построить URL медиа');
  let data = await fetchAuthed(client, httpUrl, 'low');
  if (src.file) data = await decryptAttachment(data, src.file);
  return new Blob([data], { type: src.mimetype || 'application/octet-stream' });
}
