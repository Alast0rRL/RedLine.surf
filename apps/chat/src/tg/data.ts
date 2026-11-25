import type { Message, Dialog } from '@mtcute/web';
import { getTg } from './client';

export interface TgDialog {
  id: number;
  name: string;
  preview: string;
  date: number;
  unread: number;
  pinned: boolean;
  group: boolean;
}

export interface TgMsg {
  id: number;
  chatId: number;
  text: string;
  date: number;
  out: boolean;
  sender: string;
  senderId: number;
  /** подпись вместо медиа, пока медиа не показываем */
  media: string | null;
  edited: boolean;
}

const MEDIA_LABEL: Record<string, string> = {
  photo: 'Фото',
  video: 'Видео',
  voice: 'Голосовое',
  audio: 'Аудио',
  sticker: 'Стикер',
  document: 'Файл',
  contact: 'Контакт',
  location: 'Местоположение',
  live_location: 'Местоположение',
  venue: 'Место',
  poll: 'Опрос',
  dice: 'Кубик',
  game: 'Игра',
  web_page: '',
  invoice: 'Счёт',
  story: 'История',
};

function mediaLabel(m: Message): string | null {
  const t = m.media?.type;
  if (!t) return null;
  const label = MEDIA_LABEL[t];
  if (label === '') return null; // превью ссылки — текст и так есть
  return label ?? 'Вложение';
}

export function toMsg(m: Message): TgMsg {
  return {
    id: m.id,
    chatId: m.chat.id,
    text: m.text,
    date: m.date.getTime(),
    out: m.isOutgoing,
    sender: m.sender.displayName,
    senderId: m.sender.id,
    media: mediaLabel(m),
    edited: !!m.editDate,
  };
}

export function msgPreview(m: Pick<TgMsg, 'text' | 'media'>): string {
  if (m.media && m.text) return `${m.media}: ${m.text}`;
  return m.media ?? m.text;
}

function toDialog(d: Dialog): TgDialog {
  const last = d.lastMessage ? toMsg(d.lastMessage) : null;
  const group = d.peer.type === 'chat' && d.peer.chatType !== 'channel';
  const prefix = last && group ? (last.out ? 'Вы: ' : `${last.sender}: `) : last?.out ? 'Вы: ' : '';
  return {
    id: d.peer.id,
    name: d.peer.displayName,
    preview: last ? prefix + msgPreview(last) : '',
    date: last?.date ?? 0,
    unread: d.unreadCount,
    pinned: d.isPinned,
    group,
  };
}

export async function loadDialogs(limit = 100): Promise<TgDialog[]> {
  const tg = await getTg();
  const out: TgDialog[] = [];
  for await (const d of tg.iterDialogs({ limit, archived: 'exclude' })) out.push(toDialog(d));
  return out;
}

/** Последние сообщения (или более старые, чем beforeId) — по возрастанию даты. */
export async function loadHistory(peerId: number, beforeId?: number, limit = 50): Promise<TgMsg[]> {
  const tg = await getTg();
  const page = await tg.getHistory(peerId, { limit, ...(beforeId ? { offset: { id: beforeId, date: 0 } } : {}) });
  return page.map(toMsg).reverse();
}

export async function loadChatTitle(peerId: number): Promise<{ name: string; group: boolean }> {
  const tg = await getTg();
  const peer = await tg.getPeer(peerId);
  return { name: peer.displayName, group: peer.type === 'chat' && peer.chatType !== 'channel' };
}

export async function sendText(peerId: number, text: string): Promise<TgMsg> {
  const tg = await getTg();
  return toMsg(await tg.sendText(peerId, text));
}

export async function markRead(peerId: number): Promise<void> {
  const tg = await getTg();
  await tg.readHistory(peerId);
}
