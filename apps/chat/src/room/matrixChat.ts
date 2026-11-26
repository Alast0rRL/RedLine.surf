import { createElement, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Direction,
  EventStatus,
  EventType,
  KnownMembership,
  MsgType,
  NotificationCountType,
  RoomMemberEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { useTimeline, isReadByOthers } from '../hooks/useTimeline';
import { navigate } from '../hooks/useHashRoute';
import {
  canAct,
  canDelete as canMatrixDelete,
  canEdit as canMatrixEdit,
  deleteMessage as redactEvent,
  forwardEvent,
  getReactions,
  plainBody,
  QUICK_REACTIONS,
  sendEdit,
  sendReply,
  toggleReaction as toggleMatrixReaction,
} from '../lib/messageActions';
import { buildMentionContent, isMentioningMe, mentionCandidates as matrixMentionCandidates } from '../lib/mentions';
import { canClearForAll, isClearCommand } from '../lib/clear';
import { isPendingDecryption, isStateNotice, isUndecryptable, isVoice, previewText } from '../lib/events';
import { sanitizeMatrixHtml } from '../lib/html';
import { getMediaUrl, type MediaSource } from '../lib/media';
import { isPinUser } from '../lib/pin';
import { sendFile, sendImage, sendText as sendMatrixText, sendVoice as sendMatrixVoice } from '../lib/send';
import { uploadStore } from '../lib/uploads';
import { findRenderer, isBotStyled, isBotUser } from '../bots/registry';
import { askClearHistory } from './ClearHistory';
import type { ChatBackend, ChatMedia, ChatMessage, ChatStatus, ChatTimelineState, ChatUpload } from '../chat/types';

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'];
const REVEAL_PAGES = 10;
const REVEAL_PAGE = 50;

type Content = Record<string, any>;

function stateText(ev: MatrixEvent, pin: boolean): string | null {
  const name = ev.sender?.name ?? (pin ? 'Участник' : ev.getSender());
  const c = ev.getContent<Content>();
  switch (ev.getType()) {
    case EventType.RoomCreate:
      return 'Чат создан';
    case EventType.RoomEncryption:
      return '🔒 Сообщения защищены сквозным шифрованием';
    case EventType.RoomName:
      return c.name ? `${name} переименовал(а) чат в «${c.name}»` : null;
    case EventType.RoomMember: {
      const prev = ev.getPrevContent().membership;
      const target = c.displayname ?? (pin ? 'участник' : ev.getStateKey());
      if (c.membership === 'invite') return `${name} пригласил(а) ${target}`;
      if (c.membership === 'join' && prev !== 'join') return `${target} в чате`;
      if (c.membership === 'leave' && ev.getStateKey() === ev.getSender()) {
        return prev === 'invite' ? `${target} отклонил(а) приглашение` : `${target} вышел(а)`;
      }
      if (c.membership === 'leave') return `${name} исключил(а) ${target}`;
      return null;
    }
    default:
      return null;
  }
}

function markRead(client: MatrixClient, room: Room, last: MatrixEvent, me: string): void {
  if (room.getUnreadNotificationCount(NotificationCountType.Total) > 0) {
    room.setUnreadNotificationCount(NotificationCountType.Total, 0);
    room.setUnreadNotificationCount(NotificationCountType.Highlight, 0);
  }
  const id = last.getId();
  if (last.getSender() !== me && id && !room.hasUserReadEvent(me, id)) client.sendReadReceipt(last).catch(() => {});
}

function mediaOf(ev: MatrixEvent): ChatMedia | null {
  if (ev.isRedacted()) return null;
  const c = ev.getContent<Content>();
  const src: MediaSource = { url: c.url, file: c.file, mimetype: c.info?.mimetype };
  const base = {
    ref: src,
    thumbRef: src,
    name: c.body,
    size: c.info?.size,
    mime: c.info?.mimetype,
    w: c.info?.w,
    h: c.info?.h,
  };
  if (ev.getType() === EventType.Sticker || c.msgtype === MsgType.Image) {
    return { kind: ev.getType() === EventType.Sticker ? 'sticker' : 'image', ...base, name: c.body ?? 'Фото' };
  }
  if (c.msgtype === MsgType.Audio) {
    const audio = (c['org.matrix.msc1767.audio'] ?? {}) as Content;
    return {
      kind: isVoice(ev) ? 'voice' : 'audio',
      ref: src,
      name: c.body ?? 'Аудио',
      size: c.info?.size,
      mime: c.info?.mimetype,
      durationMs: audio.duration ?? c.info?.duration,
      waveform: isVoice(ev) ? audio.waveform : undefined,
    };
  }
  if (c.msgtype === MsgType.Video) {
    return { kind: 'video', ...base, name: c.filename ?? c.body ?? 'Видео' };
  }
  if (c.msgtype === MsgType.File) {
    return { kind: 'file', ...base, name: c.filename ?? c.body ?? 'Файл', w: undefined, h: undefined };
  }
  return null;
}

function toChatUpload(u: ReturnType<typeof uploadStore.get>[number]): ChatUpload {
  return {
    id: u.id,
    kind: u.kind,
    previewUrl: u.previewUrl,
    durationMs: u.durationMs,
    name: u.name,
    size: u.size,
    progress: u.progress,
    error: u.error,
    retry: u.retry,
    cancel: () => uploadStore.remove(u.id),
  };
}

function firstUnread(room: Room, me: string): string | null {
  if (room.getUnreadNotificationCount(NotificationCountType.Total) <= 0) return null;
  const readId = room.getEventReadUpTo(me)
    ?? room.getAccountData('m.fully_read')?.getContent<{ event_id?: string }>()?.event_id
    ?? null;
  const events = room.getLiveTimeline().getEvents();
  let from = 0;
  if (readId) {
    const idx = events.findIndex((e) => e.getId() === readId);
    if (idx < 0) return null;
    from = idx + 1;
  }
  for (let i = from; i < events.length; i++) {
    const ev = events[i];
    if (!isStateNotice(ev) && ev.getSender() !== me && ev.getId()?.startsWith('$')) return ev.getId()!;
  }
  return null;
}

/** Лента + действия Matrix как общий ChatBackend. */
export function useMatrixChat(client: MatrixClient, room: Room): { state: ChatTimelineState; backend: ChatBackend } {
  const timeline = useTimeline(client, room);
  const me = client.getUserId() ?? '';
  const pin = isPinUser(me);
  const eventMap = useRef(new Map<string, MatrixEvent>());

  const allUploads = useSyncExternalStore(uploadStore.subscribe, uploadStore.get);
  const uploads = useMemo(
    () => allUploads.filter((u) => u.roomId === room.roomId).map(toChatUpload),
    [allUploads, room.roomId],
  );

  const [typing, setTyping] = useState<string[]>([]);
  useEffect(() => {
    const update = () => {
      setTyping(room.getMembers()
        .filter((m) => m.typing && m.userId !== me)
        .map((m) => (pin && m.name === m.userId ? 'Участник' : m.name)));
    };
    client.on(RoomMemberEvent.Typing, update);
    update();
    return () => {
      client.off(RoomMemberEvent.Typing, update);
    };
  }, [client, room, me, pin]);

  const [unreadId] = useState(() => firstUnread(room, me));

  const lastReadOwnIdx = useMemo(() => {
    for (let i = timeline.events.length - 1; i >= 0; i--) {
      const ev = timeline.events[i];
      if (ev.getId()?.startsWith('$') && isReadByOthers(room, ev, me)) return i;
    }
    return -1;
  }, [timeline.events, timeline.version, room, me]);

  const messages = useMemo(() => {
    const map = new Map<string, MatrixEvent>();
    const list = timeline.events.map((ev, i) => {
      const id = ev.getId() ?? ev.getTxnId() ?? '';
      if (id) map.set(id, ev);
      const senderId = ev.getSender() ?? '';
      const own = senderId === me;
      const senderName = ev.sender?.name && ev.sender.name !== senderId
        ? ev.sender.name
        : pin ? 'Участник' : senderId;
      const c = ev.getContent<Content>();
      const media = mediaOf(ev);
      const undecryptable = isUndecryptable(ev);
      const decrypting = !undecryptable && isPendingDecryption(ev);
      const renderer = !undecryptable && !decrypting ? findRenderer(ev) : undefined;
      const replyTo = ev.replyEventId;
      const target = replyTo ? room.findEventById(replyTo) : null;
      const status = ((): ChatStatus | undefined => {
        if (!own) return undefined;
        if (ev.status === EventStatus.NOT_SENT) return 'failed';
        if (ev.status === EventStatus.SENDING || ev.status === EventStatus.QUEUED || ev.status === EventStatus.ENCRYPTING) return 'sending';
        return i <= lastReadOwnIdx ? 'read' : 'sent';
      })();
      const plainText = plainBody(ev);
      return {
        id,
        senderId,
        senderName,
        own,
        ts: ev.getTs(),
        text: media || renderer || undecryptable || decrypting ? '' : plainText,
        html: !media && !renderer && !undecryptable && !decrypting && c.format === 'org.matrix.custom.html' && typeof c.formatted_body === 'string'
          ? sanitizeMatrixHtml(c.formatted_body)
          : null,
        media,
        reply: replyTo ? {
          id: replyTo,
          senderName: target ? (target.sender?.name ?? (pin ? 'Участник' : target.getSender() ?? '')) : 'Сообщение',
          text: target ? previewText(target) : 'не загружено',
        } : null,
        reactions: getReactions(room, ev, me).map((r) => ({ key: r.key, count: r.count, own: r.own })),
        edited: !!ev.replacingEventId(),
        status,
        service: isStateNotice(ev) ? stateText(ev, pin) : null,
        mentionsMe: !own && isMentioningMe(ev, me),
        bot: !own && isBotUser(senderId),
        placeholder: undecryptable ? 'undecryptable' : decrypting ? 'decrypting' : null,
        custom: !!renderer,
        botStyled: !own && isBotStyled(ev),
        showAvatar: !own,
        actionable: canAct(ev),
      } satisfies ChatMessage;
    });
    eventMap.current = map;
    return list;
  }, [timeline.events, timeline.version, room, me, pin, lastReadOwnIdx]);

  const findEvent = useCallback((id: string): MatrixEvent | null =>
    eventMap.current.get(id)
    ?? room.findEventById(id)
    ?? room.getPendingEvents().find((ev) => (ev.getId() ?? ev.getTxnId()) === id)
    ?? null, [room]);

  useEffect(() => {
    const last = [...timeline.events].reverse().find((ev) => ev.getId()?.startsWith('$'));
    if (last && !document.hidden) markRead(client, room, last, me);
  }, [client, room, timeline.events, timeline.version, me]);

  useEffect(() => {
    const onVisible = () => {
      const last = room.getLiveTimeline().getEvents().at(-1);
      if (last && !document.hidden) markRead(client, room, last, me);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [client, room, me]);

  const loadOlder = useCallback(() => {
    if (timeline.loadingOlder || !timeline.canLoadOlder) return false;
    void timeline.loadOlder();
    return true;
  }, [timeline.loadingOlder, timeline.canLoadOlder, timeline.loadOlder]);

  const reveal = useCallback(async (id: string): Promise<boolean> => {
    for (let page = 0; page < REVEAL_PAGES; page++) {
      if (room.findEventById(id)) return true;
      const live = room.getLiveTimeline();
      if (!live.getPaginationToken(Direction.Backward)) return false;
      try {
        await client.paginateEventTimeline(live, { backwards: true, limit: REVEAL_PAGE });
      } catch (e) {
        console.warn('paginate failed', e);
        return false;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      await Promise.all(live.getEvents()
        .filter((ev) => ev.isBeingDecrypted())
        .map((ev) => ev.getDecryptionPromise?.())
        .filter((p): p is Promise<void> => !!p));
    }
    return !!room.findEventById(id);
  }, [client, room]);

  const state: ChatTimelineState = useMemo(() => ({
    messages,
    error: null,
    loadingOlder: timeline.loadingOlder,
    atStart: !timeline.canLoadOlder,
    loadOlder,
    uploads,
    firstUnreadId: unreadId,
    typing,
    cleared: timeline.cleared,
    reveal,
  }), [messages, timeline.loadingOlder, timeline.canLoadOlder, timeline.cleared, loadOlder, uploads, unreadId, typing, reveal]);

  const backend: ChatBackend = useMemo(() => {
    let typingSent = 0;
    return {
      key: room.roomId,
      group: room.getJoinedMemberCount() > 2,
      maxLength: 2000,
      quickReactions: [...QUICK_REACTIONS],
      draftKey: `rl.draft.${room.roomId}`,
      deleteOnlyForAll: true,
      commands: [{ command: '/clear', label: 'очистить историю чата' }],

      async sendText(text, replyToId) {
        const extra = room.getJoinedMemberCount() > 2 ? buildMentionContent(room, me, text) : null;
        try {
          if (replyToId) await sendReply(client, room.roomId, text, replyToId, extra ?? undefined);
          else await sendMatrixText(client, room.roomId, text, extra ?? undefined);
        } catch (e) {
          throw new Error(e instanceof Error && e.message ? e.message : 'Не удалось отправить сообщение');
        }
      },

      async editText(id, text) {
        const ev = findEvent(id);
        if (ev) await sendEdit(client, room.roomId, ev, text);
      },

      async sendFiles(files) {
        for (const file of files) {
          if (PHOTO_TYPES.includes(file.type)) sendImage(client, room.roomId, file);
          else sendFile(client, room.roomId, file);
        }
      },

      async sendVoice(rec) {
        sendMatrixVoice(client, room.roomId, rec);
      },

      async toggleReaction(id, key) {
        const ev = findEvent(id);
        if (ev) await toggleMatrixReaction(client, room, ev, key);
      },

      canEdit(m) {
        const ev = findEvent(m.id);
        return !!ev && canMatrixEdit(ev, me);
      },

      canDelete(m) {
        const ev = findEvent(m.id);
        return !!ev && canMatrixDelete(ev, me);
      },

      canDeleteForAll(m) {
        return m.own || canClearForAll(room, me);
      },

      async deleteMessage(id) {
        const ev = findEvent(id);
        if (ev) await redactEvent(client, ev);
      },

      async forwardTargets() {
        return client.getRooms()
          .filter((r) => r.getMyMembership() === KnownMembership.Join)
          .sort((a, b) => (b.getLastActiveTimestamp() || 0) - (a.getLastActiveTimestamp() || 0))
          .map((r) => ({ id: r.roomId, name: r.name, avatarSeed: r.roomId }));
      },

      async forward(id, targetId) {
        const ev = findEvent(id);
        if (ev) await forwardEvent(client, targetId, ev);
      },

      setTyping(on) {
        const now = Date.now();
        if (on && now - typingSent < 4000) return;
        typingSent = on ? now : 0;
        void client.sendTyping(room.roomId, on, on ? 6000 : 0).catch(() => {});
      },

      async mediaUrl(media, thumb) {
        const ref = thumb && media.thumbRef ? media.thumbRef : media.ref;
        const useThumb = !!thumb && (media.kind === 'image' || media.kind === 'video' || media.kind === 'sticker');
        return getMediaUrl(client, ref as MediaSource, useThumb ? { width: media.w ?? 720, height: media.h ?? 720 } : undefined);
      },

      async avatarUrl(senderId) {
        const mxc = room.getMember(senderId)?.getMxcAvatarUrl();
        if (!mxc) return null;
        try {
          return await getMediaUrl(client, { url: mxc }, { width: 96, height: 96 });
        } catch {
          return null;
        }
      },

      openProfile(senderId) {
        if (senderId) navigate.user(senderId);
      },

      resend(id) {
        const ev = findEvent(id);
        if (ev) void client.resendEvent(ev, room);
      },

      cancelSend(id) {
        const ev = findEvent(id);
        if (ev) client.cancelPendingEvent(ev);
      },

      renderCustom(m) {
        const ev = findEvent(m.id);
        const renderer = ev ? findRenderer(ev) : null;
        return renderer ? createElement(renderer.component, { event: ev! }) : null;
      },

      mentionCandidates(query) {
        return matrixMentionCandidates(room, me, query).map((c) => ({
          id: c.member.userId,
          name: c.name,
          hint: c.member.userId.replace(/^@/, '').split(':')[0],
          avatarSeed: c.member.userId,
        }));
      },

      onHtmlClick(e) {
        const a = (e.target as HTMLElement).closest('a');
        const match = a?.getAttribute('href')?.match(/^https:\/\/matrix\.to\/#\/(@[^?/]+)/);
        if (!match) return;
        e.preventDefault();
        navigate.user(decodeURIComponent(match[1]));
      },

      onCommand(command) {
        if (!isClearCommand(command)) return false;
        askClearHistory(room.roomId);
        return true;
      },
    };
  }, [client, room, me, findEvent]);

  return { state, backend };
}
