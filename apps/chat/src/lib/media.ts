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
const cache = new Map<string, Promise<string>>();

function remember(key: string, value: Promise<string>): Promise<string> {
  cache.set(key, value);
  if (cache.size > MAX_ENTRIES) {
    const [oldKey, old] = cache.entries().next().value as [string, Promise<string>];
    cache.delete(oldKey);
    old.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  }
  // неудачные загрузки не кешируем — можно повторить
  value.catch(() => cache.delete(key));
  return value;
}

async function fetchAuthed(client: MatrixClient, httpUrl: string): Promise<ArrayBuffer> {
  const res = await fetch(httpUrl, {
    headers: { Authorization: `Bearer ${client.getAccessToken()}` },
  });
  if (!res.ok) throw new Error(`media HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** blob: URL для медиа. thumb — только для незашифрованных (сервер не видит содержимое E2E). */
export function getMediaUrl(client: MatrixClient, src: MediaSource, thumb?: Thumb): Promise<string> {
  const mxc = src.file?.url ?? src.url;
  if (!mxc?.startsWith('mxc://')) return Promise.reject(new Error('Нет ссылки на медиа'));
  const key = `${mxc}|${src.file ? 'enc' : thumb ? `${thumb.width}x${thumb.height}` : 'full'}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const job = (async () => {
    const httpUrl = src.file
      ? client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true)
      : thumb
        ? client.mxcUrlToHttp(mxc, thumb.width, thumb.height, 'scale', false, true, true)
        : client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true);
    if (!httpUrl) throw new Error('Не удалось построить URL медиа');
    let data = await fetchAuthed(client, httpUrl);
    if (src.file) data = await decryptAttachment(data, src.file);
    return URL.createObjectURL(new Blob([data], { type: src.mimetype || 'application/octet-stream' }));
  })();
  return remember(key, job);
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
  let data = await fetchAuthed(client, httpUrl);
  if (src.file) data = await decryptAttachment(data, src.file);
  return new Blob([data], { type: src.mimetype || 'application/octet-stream' });
}
