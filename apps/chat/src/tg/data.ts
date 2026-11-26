import type { Message, Dialog } from '@mtcute/web';
import { getTg, notifyTgRead } from './client';

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

/** Фото профиля, которые видели в диалогах и сообщениях: id → файл. */
type PhotoLoc = NonNullable<Dialog['peer']['photo']>['small'];
const photos = new Map<number, PhotoLoc | null>();

function rememberPhoto(peer: { id: number; photo: { small: PhotoLoc } | null }) {
  photos.set(peer.id, peer.photo?.small ?? null);
}

export function toMsg(m: Message): TgMsg {
  rememberPhoto(m.sender);
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
  rememberPhoto(d.peer);
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

/** Отметить прочитанным до сообщения maxId (или всё) и обнулить счётчик в списке. */
export async function markRead(peerId: number, maxId?: number): Promise<void> {
  const tg = await getTg();
  await tg.readHistory(peerId, { maxId: maxId ?? 0, clearMentions: true });
  notifyTgRead(peerId);
}

const AVATAR_CACHE = 'rl-tg-avatars';
const avatars = new Map<string, Promise<string | null>>();
let active = 0;
const queue: Array<() => void> = [];

/** Не больше трёх загрузок сразу: в списке может быть сотня чатов. */
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 3) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

/** Маленькое фото профиля как blob-URL; кэшируется на устройстве. null — фото нет. */
export function tgAvatar(peerId: number): Promise<string | null> {
  const loc = photos.get(peerId);
  if (!loc) return Promise.resolve(null);
  const key = `/tg-avatar/${peerId}/${loc.uniqueFileId}`;
  let p = avatars.get(key);
  if (!p) {
    p = (async () => {
      const cache = typeof caches === 'undefined' ? null : await caches.open(AVATAR_CACHE).catch(() => null);
      const hit = await cache?.match(key).catch(() => undefined);
      if (hit) return URL.createObjectURL(await hit.blob());
      const bytes = await limited(async () => (await getTg()).downloadAsBuffer(loc));
      const blob = new Blob([bytes as BlobPart], { type: 'image/jpeg' });
      void cache?.put(key, new Response(blob)).catch(() => {});
      return URL.createObjectURL(blob);
    })().catch((e) => {
      console.warn('tg avatar', e);
      avatars.delete(key);
      return null;
    });
    avatars.set(key, p);
  }
  return p;
}
