import { EventType, MsgType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { loadMediaBlob, type MediaSource } from './media';

export interface RoomMediaItem {
  id: string;
  kind: 'image' | 'video' | 'file';
  src: MediaSource;
  name: string;
  size?: number;
  w?: number;
  h?: number;
  ts: number;
}

/** Медиа-вложение события (фото, стикер, видео, файл) или null. Голосовые не считаем. */
export function mediaOf(ev: MatrixEvent): RoomMediaItem | null {
  if (ev.isRedacted()) return null;
  const type = ev.getType();
  if (type !== EventType.RoomMessage && type !== EventType.Sticker) return null;
  const c = ev.getContent();
  if (c['m.relates_to']?.rel_type === 'm.replace') return null;
  if (!c.url && !c.file) return null;
  const src: MediaSource = { url: c.url, file: c.file, mimetype: c.info?.mimetype };
  const base = { id: ev.getId() ?? '', src, size: c.info?.size, w: c.info?.w, h: c.info?.h, ts: ev.getTs() };
  if (type === EventType.Sticker || c.msgtype === MsgType.Image) {
    return { ...base, kind: 'image', name: c.filename ?? c.body ?? 'photo' };
  }
  if (c.msgtype === MsgType.Video) return { ...base, kind: 'video', name: c.filename ?? c.body ?? 'video' };
  if (c.msgtype === MsgType.File) return { ...base, kind: 'file', name: c.filename ?? c.body ?? 'file' };
  return null;
}

export function saveUrl(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Скачивает расшифрованный оригинал под исходным именем. */
export async function downloadMedia(client: MatrixClient, src: MediaSource, name: string): Promise<void> {
  const blob = await loadMediaBlob(client, src);
  const url = URL.createObjectURL(blob);
  saveUrl(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const mediaKey = (src: MediaSource): string => src.file?.url ?? src.url ?? '';

/** Комната, открытая сейчас (из hash) — нужна, чтобы листать фото соседних сообщений. */
export function currentRoom(client: MatrixClient): Room | null {
  const m = location.hash.match(/^#\/room\/([^/]+)/);
  return m ? client.getRoom(decodeURIComponent(m[1])) : null;
}

/** Все загруженные в ленте фото комнаты по порядку (старые → новые). */
export function roomImages(room: Room): RoomMediaItem[] {
  const out: RoomMediaItem[] = [];
  for (const ev of room.getLiveTimeline().getEvents()) {
    const m = mediaOf(ev);
    if (m && m.kind === 'image') out.push(m);
  }
  return out;
}
