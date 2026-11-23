import { EventType, MsgType, type MatrixEvent } from 'matrix-js-sdk';
import { stripReplyFallback } from './html';

/** События, которые показываются в ленте как сообщения. */
export function isMessageLike(ev: MatrixEvent): boolean {
  const type = ev.getType();
  if (ev.isRedacted()) return false; // удалённые не показываем вовсе
  if (type === EventType.RoomMessageEncrypted) return true; // ещё не расшифровано / ошибка
  if (type === EventType.Sticker) return true;
  if (type !== EventType.RoomMessage) return false;
  // правки показываем через исходное сообщение
  return ev.getContent()['m.relates_to']?.rel_type !== 'm.replace';
}

/** Служебные события, которые стоит показать строкой по центру. */
export function isStateNotice(ev: MatrixEvent): boolean {
  const t = ev.getType();
  return t === EventType.RoomMember || t === EventType.RoomCreate || t === EventType.RoomName || t === EventType.RoomEncryption;
}

export function isVoice(ev: MatrixEvent): boolean {
  const c = ev.getContent();
  return c.msgtype === MsgType.Audio && c['org.matrix.msc3245.voice'] !== undefined;
}

export function isUndecryptable(ev: MatrixEvent): boolean {
  return ev.isDecryptionFailure();
}

/** Ещё не расшифровано (идёт расшифровка или ключи пока не пришли). */
export function isPendingDecryption(ev: MatrixEvent): boolean {
  return !ev.isDecryptionFailure() && (ev.isBeingDecrypted() || ev.getType() === EventType.RoomMessageEncrypted);
}

/** Короткий текст для списка чатов и уведомлений. */
export function previewText(ev: MatrixEvent): string {
  if (isUndecryptable(ev)) return '🔒 Не удалось расшифровать';
  if (isPendingDecryption(ev)) return '🔒 Зашифрованное сообщение';
  const c = ev.getContent();
  if (ev.getType() === EventType.Sticker) return 'Стикер';
  switch (c.msgtype) {
    case MsgType.Image: return '📷 Фото';
    case MsgType.Video: return '🎬 Видео';
    case MsgType.File: return `📎 ${c.body ?? 'Файл'}`;
    case MsgType.Audio: return isVoice(ev) ? `🎤 Голосовое${c.info?.duration ? ` · ${formatDuration(c.info.duration)}` : ''}` : '🎵 Аудио';
    case MsgType.Location: return '📍 Геопозиция';
    case MsgType.Emote: return `* ${c.body ?? ''}`;
    default: return stripReplyFallback(String(c.body ?? '')).replace(/\s+/g, ' ').trim();
  }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const timeFmt = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' });
const dayYearFmt = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat('ru', { weekday: 'short' });
const shortDateFmt = new Intl.DateTimeFormat('ru', { day: '2-digit', month: '2-digit', year: '2-digit' });

export const formatTime = (ts: number) => timeFmt.format(ts);

const startOfDay = (ts: number) => new Date(ts).setHours(0, 0, 0, 0);

/** Время в списке чатов: сегодня — часы, на этой неделе — день, раньше — дата. */
export function formatListTime(ts: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (day === today) return timeFmt.format(ts);
  if (today - day === 86_400_000) return 'вчера';
  if (today - day < 6 * 86_400_000) return weekdayFmt.format(ts);
  return shortDateFmt.format(ts);
}

/** Разделитель дней в ленте. */
export function formatDay(ts: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (day === today) return 'Сегодня';
  if (today - day === 86_400_000) return 'Вчера';
  return new Date(ts).getFullYear() === new Date().getFullYear() ? dayFmt.format(ts) : dayYearFmt.format(ts);
}

export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);
