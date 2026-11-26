/**
 * Telegram как ChatBackend: превращает сообщения mtcute в общую модель и выполняет действия.
 * Лента одного чата — хук useTgTimeline (подписка на обновления клиента).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Message, TelegramClient } from '@mtcute/web';
import type { ChatBackend, ChatForwardTarget, ChatMedia, ChatMessage, ChatTimelineState, ChatUpload } from '../chat/types';
import type { VoiceRecording } from '../lib/voice/recorder';
import { getTg, notifyTgRead, tgErrorText } from './client';
import { loadDialogs, tgAvatar } from './data';

const PAGE = 50;
const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const PHOTO_TYPES = /^image\/(jpeg|png|webp)$/;
const PHOTO_MAX = 10 * 1024 * 1024; // больше — файлом, как в Telegram

/* ---------------- сообщение mtcute → ChatMessage ---------------- */

const ACTION_TEXT: Record<string, string> = {
  chat_created: 'создал(а) группу',
  channel_created: 'создал(а) канал',
  users_added: 'добавил(а) участников',
  user_left: 'покинул(а) группу',
  user_removed: 'исключил(а) участника',
  user_joined_link: 'вступил(а) по ссылке',
  user_joined_approved: 'вступил(а) в группу',
  title_changed: 'изменил(а) название',
  photo_changed: 'изменил(а) фото',
  photo_deleted: 'удалил(а) фото',
  message_pinned: 'закрепил(а) сообщение',
  history_cleared: 'очистил(а) историю',
  contact_joined: 'теперь в Telegram',
  call: 'звонок',
  screenshot_taken: 'сделал(а) снимок экрана',
  ttl_changed: 'изменил(а) автоудаление',
};

function serviceText(m: Message): string {
  const t = (m.action as { type?: string } | null)?.type ?? '';
  return `${m.sender.displayName} ${ACTION_TEXT[t] ?? 'служебное сообщение'}`;
}

/** mtcute-объекты файлов храним по ключу: в ChatMedia.ref уходит строка. */
const fileRefs = new Map<string, unknown>();
function ref(loc: { uniqueFileId?: string } | null | undefined, fallback: string): string | undefined {
  if (!loc) return undefined;
  const k = loc.uniqueFileId ?? fallback;
  fileRefs.set(k, loc);
  return k;
}

function mediaOf(m: Message): { media: ChatMedia | null; label: string | null } {
  const md = m.media as (NonNullable<Message['media']> & Record<string, unknown>) | null;
  if (!md) return { media: null, label: null };
  const key = `${m.chat.id}:${m.id}`;
  const any = md as unknown as {
    type: string;
    width?: number;
    height?: number;
    duration?: number;
    waveform?: number[];
    fileName?: string | null;
    fileSize?: number;
    mimeType?: string;
    emoji?: string;
    isRound?: boolean;
    isAnimation?: boolean;
    getThumbnail?: (t: string) => { uniqueFileId?: string } | null;
    thumbnails?: ReadonlyArray<{ uniqueFileId?: string; type?: string }>;
  };
  const thumbOf = () => {
    const t = any.getThumbnail?.('m') ?? any.getThumbnail?.('x') ?? any.thumbnails?.[0] ?? null;
    return ref(t, `${key}:thumb`);
  };
  switch (any.type) {
    case 'photo':
      return {
        media: { kind: 'image', ref: ref(md as never, key), thumbRef: thumbOf(), w: any.width, h: any.height, mime: 'image/jpeg', name: 'photo.jpg' },
        label: 'Фото',
      };
    case 'video':
      return {
        media: {
          kind: 'video',
          ref: ref(md as never, key),
          thumbRef: thumbOf(),
          w: any.width,
          h: any.height,
          durationMs: (any.duration ?? 0) * 1000,
          size: any.fileSize,
          mime: any.mimeType ?? 'video/mp4',
          name: any.fileName ?? 'video.mp4',
        },
        label: any.isRound ? 'Видеосообщение' : any.isAnimation ? 'GIF' : 'Видео',
      };
    case 'voice':
      return {
        media: {
          kind: 'voice',
          ref: ref(md as never, key),
          durationMs: (any.duration ?? 0) * 1000,
          waveform: any.waveform?.map((v) => v / 31),
          mime: any.mimeType ?? 'audio/ogg',
          size: any.fileSize,
          name: 'voice.ogg',
        },
        label: 'Голосовое',
      };
    case 'audio':
      return {
        media: { kind: 'audio', ref: ref(md as never, key), durationMs: (any.duration ?? 0) * 1000, mime: any.mimeType, size: any.fileSize, name: any.fileName ?? 'audio' },
        label: 'Аудио',
      };
    case 'sticker': {
      // анимированные (tgs) рисовать нечем — показываем эмодзи
      if (any.mimeType !== 'image/webp') return { media: null, label: `${any.emoji ?? ''} Стикер`.trim() };
      return { media: { kind: 'sticker', ref: ref(md as never, key), w: any.width, h: any.height, mime: 'image/webp' }, label: `${any.emoji ?? ''} Стикер`.trim() };
    }
    case 'document':
      return {
        media: { kind: 'file', ref: ref(md as never, key), name: any.fileName ?? 'файл', size: any.fileSize, mime: any.mimeType },
        label: any.fileName ?? 'Файл',
      };
    case 'webpage':
    case 'web_page':
      return { media: null, label: null };
    default: {
      const names: Record<string, string> = { contact: 'Контакт', location: 'Местоположение', live_location: 'Местоположение', venue: 'Место', poll: 'Опрос', dice: 'Кубик', game: 'Игра', invoice: 'Счёт', story: 'История' };
      return { media: null, label: names[any.type] ?? 'Вложение' };
    }
  }
}

export function toChatMessage(m: Message, readOutbox: number): ChatMessage {
  const { media, label } = mediaOf(m);
  const reactions = (m.reactions?.reactions ?? [])
    .filter((r) => typeof r.emoji === 'string')
    .map((r) => ({ key: r.emoji as string, count: r.count, own: (r as unknown as { chosen?: boolean; order?: number | null }).order != null }));
  const rep = m.replyToMessage;
  const fwd = m.forward;
  const text = m.text || (!media && label ? `[${label}]` : '');
  return {
    id: String(m.id),
    senderId: String(m.sender.id),
    senderName: m.sender.displayName,
    own: m.isOutgoing,
    ts: m.date.getTime(),
    text,
    media,
    reply: rep?.id ? { id: String(rep.id), senderName: rep.sender?.displayName ?? '', text: rep.quoteText || '' } : null,
    reactions,
    edited: !!m.editDate && !m.hideEditMark,
    status: m.isOutgoing ? (m.id <= readOutbox ? 'read' : 'sent') : undefined,
    forwardedFrom: fwd ? fwd.sender.displayName : null,
    service: m.isService ? serviceText(m) : null,
    mentionsMe: m.isMention,
    bot: m.sender.type === 'user' && (m.sender as unknown as { isBot?: boolean }).isBot === true,
  };
}

/* ---------------- медиа ---------------- */

const urls = new Map<string, Promise<string>>();
/** Крупные файлы (видео, документы) держим в памяти только последние несколько. */
const big: string[] = [];
const MAX_BIG = 5;
const MAX_DOWNLOAD = 200 * 1024 * 1024;

async function download(key: string, mime?: string, evictable = false): Promise<string> {
  let p = urls.get(key);
  if (!p) {
    p = (async () => {
      const loc = fileRefs.get(key) as { fileSize?: number } | undefined;
      if (!loc) throw new Error('Файл больше недоступен — откройте чат заново');
      if ((loc.fileSize ?? 0) > MAX_DOWNLOAD) throw new Error('Файл слишком большой — откройте его в Telegram');
      const tg = await getTg();
      const bytes = await tg.downloadAsBuffer(loc as Parameters<TelegramClient['downloadAsBuffer']>[0]);
      return URL.createObjectURL(new Blob([bytes as BlobPart], mime ? { type: mime } : undefined));
    })();
    p.catch(() => urls.delete(key));
    urls.set(key, p);
  }
  if (evictable) {
    const i = big.indexOf(key);
    if (i >= 0) big.splice(i, 1);
    big.push(key);
    while (big.length > MAX_BIG) {
      const old = big.shift()!;
      const op = urls.get(old);
      urls.delete(old);
      void op?.then((u) => URL.revokeObjectURL(u), () => {});
    }
  }
  return p;
}

/** Waveform записи (0..1024) → 5-битный Telegram (0..31), 64 точки. */
function tgWaveform(src: number[]): number[] {
  if (!src.length) return [];
  const n = 64;
  return Array.from({ length: n }, (_, i) => {
    const v = src[Math.floor((i * src.length) / n)] ?? 0;
    return Math.max(0, Math.min(31, Math.round((v / 1024) * 31)));
  });
}

/* ---------------- лента ---------------- */

type UploadsSetter = (fn: (u: ChatUpload[]) => ChatUpload[]) => void;

export interface TgChatInfo {
  name: string;
  group: boolean;
  /** можно ли писать (в каналах — только админам) */
  canWrite: boolean;
  /** можно удалять чужие сообщения (у себя) */
  deleteAny: boolean;
  /** можно удалять чужие сообщения у всех (личка, админ) */
  deleteForAllAny: boolean;
}

/** Состояние ленты + backend для открытого чата Telegram. */
export function useTgChat(peerId: number, ready: boolean): { state: ChatTimelineState; backend: ChatBackend; info: TgChatInfo | null } {
  const [msgs, setMsgs] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atStart, setAtStart] = useState(false);
  const [readOutbox, setReadOutbox] = useState(0);
  const [firstUnreadId, setFirstUnreadId] = useState<string | null>(null);
  const [uploads, setUploads] = useState<ChatUpload[]>([]);
  const [typing, setTyping] = useState<Record<number, { name: string; until: number }>>({});
  const [info, setInfo] = useState<TgChatInfo | null>(null);
  const msgsRef = useRef<Message[] | null>(null);
  msgsRef.current = msgs;
  const busyOlder = useRef(false);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const offs: Array<() => void> = [];
    setMsgs(null);
    setAtStart(false);
    setError(null);
    (async () => {
      const tg = await getTg();
      const [peer, dialog] = await Promise.all([tg.getPeer(peerId), tg.getPeerDialogs(peerId).then((d) => d[0] ?? null).catch(() => null)]);
      if (!alive) return;
      const chatType = (peer as unknown as { chatType?: string }).chatType;
      const isChannel = chatType === 'channel';
      const admin = (peer as unknown as { isAdmin?: boolean; isCreator?: boolean });
      const isAdmin = !!admin.isAdmin || !!admin.isCreator;
      // в личке и обычной группе чужое можно удалить у себя; в супергруппе и канале — только админу
      setInfo({ name: peer.displayName, group: peer.type === 'chat' && !isChannel, canWrite: !isChannel || isAdmin, deleteAny: peer.type === 'user' || chatType === 'group' || isAdmin, deleteForAllAny: peer.type === 'user' || isAdmin });
      setReadOutbox(dialog?.lastReadOutgoing ?? 0);
      const lastReadIn = dialog?.lastReadIngoing ?? 0;

      const same = (m: Message) => m.chat.id === peerId;
      const pending: Message[] = [];
      const readLatest = () => {
        const last = msgsRef.current?.at(-1);
        if (last && !last.isOutgoing && document.visibilityState === 'visible') void tg.readHistory(peerId, { maxId: last.id }).then(() => notifyTgRead(peerId), () => {});
      };
      document.addEventListener('visibilitychange', readLatest);
      offs.push(() => document.removeEventListener('visibilitychange', readLatest));
      const onNew = (m: Message) => {
          if (!same(m)) return;
          if (!msgsRef.current) pending.push(m); // история ещё грузится — не теряем
          setMsgs((list) => (list && !list.some((x) => x.id === m.id) ? [...list, m] : list));
          if (!m.isOutgoing) {
            setTyping((t) => {
              const n = { ...t };
              delete n[m.sender.id];
              return n;
            });
            if (document.visibilityState === 'visible') void tg.readHistory(peerId, { maxId: m.id }).then(() => notifyTgRead(peerId), () => {});
          }
        };
      tg.onNewMessage.add(onNew);
      offs.push(() => tg.onNewMessage.remove(onNew));
      const onEdit = (m: Message) => {
        if (!same(m)) return;
        setMsgs((list) => list?.map((x) => (x.id === m.id ? m : x)) ?? list);
      };
      tg.onEditMessage.add(onEdit);
      offs.push(() => tg.onEditMessage.remove(onEdit));
      const onDelete = (u: { messageIds: number[]; channelId: number | null }) => {
        const mine = u.channelId == null ? peerId > -1e12 : -1e12 - u.channelId === peerId;
        if (!mine) return;
        setMsgs((list) => list?.filter((x) => !u.messageIds.includes(x.id)) ?? list);
      };
      tg.onDeleteMessage.add(onDelete);
      offs.push(() => tg.onDeleteMessage.remove(onDelete));
      const onRead = (u: { chatId: number; isOutbox: boolean; maxReadId: number }) => {
        if (u.chatId === peerId && u.isOutbox) setReadOutbox((r) => Math.max(r, u.maxReadId));
      };
      tg.onHistoryRead.add(onRead);
      offs.push(() => tg.onHistoryRead.remove(onRead));
      const onTyping = (u: { chatId: number; userId: number; status: string }) => {
        if (u.chatId !== peerId) return;
        setTyping((t) => {
          const n = { ...t };
          if (u.status === 'cancel') delete n[u.userId];
          else {
            const known = msgsRef.current?.find((x) => x.sender.id === u.userId)?.sender.displayName;
            n[u.userId] = { name: known ?? (peer.type === 'user' ? peer.displayName : 'Кто-то'), until: Date.now() + 6000 };
          }
          return n;
        });
      };
      tg.onUserTyping.add(onTyping);
      offs.push(() => tg.onUserTyping.remove(onTyping));
      // реакции: Telegram присылает только «у сообщения X изменились реакции» — перечитываем его
      const onRaw = (info: { update: { _: string; peer?: unknown; msgId?: number } }) => {
        const up = info.update;
        if (up._ !== 'updateMessageReactions' || !up.msgId) return;
        if (!msgsRef.current?.some((x) => x.id === up.msgId)) return;
        void tg.getMessages(peerId, [up.msgId]).then(([fresh]) => fresh && onEdit(fresh), () => {});
      };
      tg.onRawUpdate.add(onRaw as never);
      offs.push(() => tg.onRawUpdate.remove(onRaw as never));

      // история — после подписки на события, чтобы не потерять пришедшее во время загрузки
      const page = [...(await tg.getHistory(peerId, { limit: PAGE }))].reverse();
      if (!alive) return;
      const merged = [...page, ...pending.filter((p) => !page.some((x) => x.id === p.id))].sort((a, b) => a.id - b.id);
      const firstUnread = merged.find((m) => !m.isOutgoing && m.id > lastReadIn && (dialog?.unreadCount ?? 0) > 0);
      setFirstUnreadId(firstUnread ? String(firstUnread.id) : null);
      setMsgs(merged);
      if (page.length < PAGE) setAtStart(true);
      const last = merged.at(-1);
      if (last) void tg.readHistory(peerId, { maxId: last.id, clearMentions: true }).then(() => notifyTgRead(peerId), () => {});
    })().catch((e) => {
      console.error(e);
      if (alive) setError(tgErrorText(e));
    });
    return () => {
      alive = false;
      for (const off of offs) {
        try {
          off();
        } catch {
          /* уже снят */
        }
      }
    };
  }, [peerId, ready]);

  // «печатает» гаснет само через 6 секунд
  useEffect(() => {
    const ids = Object.keys(typing);
    if (!ids.length) return;
    const t = window.setTimeout(() => {
      const now = Date.now();
      setTyping((cur) => Object.fromEntries(Object.entries(cur).filter(([, v]) => v.until > now)));
    }, 1000);
    return () => window.clearTimeout(t);
  }, [typing]);

  const loadOlder = () => {
    const list = msgsRef.current;
    if (!list?.length || busyOlder.current || atStart) return false;
    busyOlder.current = true;
    setLoadingOlder(true);
    void getTg()
      .then((tg) => tg.getHistory(peerId, { limit: PAGE, offset: { id: list[0].id, date: 0 } }))
      .then((page) => {
        const older = [...page].reverse();
        if (older.length < PAGE) setAtStart(true);
        setMsgs((cur) => (cur ? [...older.filter((o) => !cur.some((c) => c.id === o.id)), ...cur] : cur));
      })
      .catch((e) => console.error(e))
      .finally(() => {
        busyOlder.current = false;
        setLoadingOlder(false);
      });
    return true;
  };

  const messages = useMemo(() => msgs?.map((m) => toChatMessage(m, readOutbox)) ?? null, [msgs, readOutbox]);

  const backend = useMemo(
    () =>
      makeBackend(peerId, { group: info?.group ?? false, deleteAny: info?.deleteAny ?? false, deleteForAllAny: info?.deleteForAllAny ?? false }, {
        setUploads,
        addOwn: (m) => setMsgs((list) => (list && !list.some((x) => x.id === m.id) ? [...list, m] : list)),
        replace: (m) => setMsgs((list) => list?.map((x) => (x.id === m.id ? m : x)) ?? list),
        current: () => msgsRef.current ?? [],
      }),
    [peerId, info?.group, info?.deleteAny, info?.deleteForAllAny],
  );

  const state: ChatTimelineState = {
    messages,
    error,
    loadingOlder,
    atStart,
    loadOlder,
    uploads,
    firstUnreadId,
    typing: Object.values(typing).map((t) => t.name),
  };
  return { state, backend, info };
}

/* ---------------- действия ---------------- */

interface LiveOps {
  setUploads: UploadsSetter;
  addOwn: (m: Message) => void;
  replace: (m: Message) => void;
  current: () => Message[];
}

function makeBackend(
  peerId: number,
  { group, deleteAny, deleteForAllAny }: { group: boolean; deleteAny: boolean; deleteForAllAny: boolean },
  { setUploads, addOwn, replace, current }: LiveOps,
): ChatBackend {
  const replyTo = (id?: string | null) => (id ? Number(id) : undefined);
  const find = (id: string) => current().find((m) => m.id === Number(id));
  let typingSent = 0;

  /** Отправка с пузырём прогресса: при ошибке пузырь остаётся с «Повторить». */
  const withUpload = async (u: Omit<ChatUpload, 'progress' | 'id'>, send: (progress: (p: number) => void) => Promise<Message>) => {
    const id = `tg-up-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const run = async () => {
      setUploads((list) => [...list.filter((x) => x.id !== id), { ...u, id, progress: 0 }]);
      try {
        const m = await send((p) => setUploads((list) => list.map((x) => (x.id === id ? { ...x, progress: p } : x))));
        addOwn(m);
        setUploads((list) => list.filter((x) => x.id !== id));
        if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
      } catch (e) {
        console.error(e);
        setUploads((list) =>
          list.map((x) =>
            x.id === id
              ? { ...x, error: tgErrorText(e), retry: () => void run(), cancel: () => {
                  if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
                  setUploads((l) => l.filter((y) => y.id !== id));
                },
              }
              : x,
          ),
        );
      }
    };
    await run();
  };

  return {
    key: `tg:${peerId}`,
    group,
    maxLength: 4096,
    quickReactions: QUICK,

    async sendText(text, replyToId) {
      const tg = await getTg();
      try {
        addOwn(await tg.sendText(peerId, text, { replyTo: replyTo(replyToId) }));
      } catch (e) {
        throw new Error(tgErrorText(e));
      }
    },

    async editText(id, text) {
      const tg = await getTg();
      try {
        await tg.editMessage({ chatId: peerId, message: Number(id), text });
      } catch (e) {
        if ((e as { text?: string }).text === 'MESSAGE_NOT_MODIFIED') return;
        throw new Error(tgErrorText(e));
      }
    },

    async sendFiles(files, replyToId) {
      const tg = await getTg();
      const { InputMedia } = await import('@mtcute/web');
      await Promise.all(
        files.map((file) => {
          const photo = PHOTO_TYPES.test(file.type) && file.size <= PHOTO_MAX;
          const video = file.type.startsWith('video/');
          return withUpload(
            { kind: photo ? 'image' : 'file', previewUrl: photo ? URL.createObjectURL(file) : undefined, name: file.name, size: file.size },
            (progress) =>
              tg.sendMedia(
                peerId,
                photo
                  ? InputMedia.photo(file)
                  : video
                    ? InputMedia.video(file, { fileName: file.name, fileMime: file.type })
                    : InputMedia.document(file, { fileName: file.name, fileMime: file.type || 'application/octet-stream' }),
                { replyTo: replyTo(replyToId), progressCallback: (done, total) => progress(total ? done / total : 0) },
              ),
          );
        }),
      );
    },

    async sendVoice(rec: VoiceRecording, replyToId) {
      const tg = await getTg();
      const { InputMedia } = await import('@mtcute/web');
      await withUpload({ kind: 'voice', durationMs: rec.durationMs }, (progress) =>
        tg.sendMedia(
          peerId,
          InputMedia.voice(rec.blob, {
            fileMime: 'audio/ogg',
            fileName: 'voice.ogg',
            duration: Math.max(1, Math.round(rec.durationMs / 1000)),
            waveform: tgWaveform(rec.waveform),
          }),
          { replyTo: replyTo(replyToId), progressCallback: (done, total) => progress(total ? done / total : 0) },
        ),
      );
    },

    async toggleReaction(id, key) {
      const tg = await getTg();
      const m = find(id);
      const mine = (m?.reactions?.reactions ?? []).filter((r) => (r as unknown as { order?: number | null }).order != null).map((r) => r.emoji);
      const next = mine.includes(key) ? null : key; // одна реакция, как у обычного аккаунта
      try {
        await tg.sendReaction({ chatId: peerId, message: Number(id), emoji: next });
        const [fresh] = await tg.getMessages(peerId, [Number(id)]);
        if (fresh) replace(fresh);
      } catch (e) {
        throw new Error(tgErrorText(e));
      }
    },

    canEdit: (m) => m.own && !m.service && !m.forwardedFrom && (!!m.text || m.media?.kind === 'image') && Date.now() - m.ts < 48 * 3600_000,
    canDelete: (m) => !m.service && (m.own || deleteAny),
    canDeleteForAll: (m) => m.own || deleteForAllAny,

    async deleteMessage(id, forAll) {
      const tg = await getTg();
      try {
        await tg.deleteMessagesById(peerId, [Number(id)], { revoke: forAll });
      } catch (e) {
        throw new Error(tgErrorText(e));
      }
    },

    async forwardTargets(): Promise<ChatForwardTarget[]> {
      const list = await loadDialogs(100);
      return list.map((d) => ({ id: String(d.id), name: d.name, avatarSeed: `tg:${d.id}` }));
    },

    async forward(id, targetId) {
      const tg = await getTg();
      try {
        await tg.forwardMessagesById({ fromChatId: peerId, messages: [Number(id)], toChatId: Number(targetId) });
      } catch (e) {
        throw new Error(tgErrorText(e));
      }
    },

    setTyping(on) {
      const now = Date.now();
      if (on && now - typingSent < 4000) return; // Telegram держит статус ~5 с
      typingSent = on ? now : 0;
      void getTg().then((tg) => tg.setTyping({ peerId, status: on ? 'typing' : 'cancel' })).catch(() => {});
    },

    mediaUrl(media: ChatMedia, thumb?: boolean) {
      const key = (thumb && media.thumbRef ? media.thumbRef : media.ref) as string;
      const evictable = !thumb && (media.kind === 'video' || media.kind === 'file' || media.kind === 'audio');
      return download(key, thumb && media.thumbRef ? 'image/jpeg' : media.mime, evictable);
    },

    avatarUrl: (senderId) => tgAvatar(Number(senderId)),
  };
}
