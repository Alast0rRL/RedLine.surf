import { EventType, MsgType, RelationType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import type { RoomMessageEventContent } from 'matrix-js-sdk/lib/@types/events.js';
import { stripReplyFallback } from './html';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

export const hasServerId = (ev: MatrixEvent): boolean => !!ev.getId()?.startsWith('$');

/** Обычный текст сообщения (без цитаты-фолбэка). */
export function plainBody(ev: MatrixEvent): string {
  return stripReplyFallback(String(ev.getContent().body ?? ''));
}

export function isTextMessage(ev: MatrixEvent): boolean {
  const t = ev.getContent().msgtype;
  return !ev.isRedacted() && ev.getType() === EventType.RoomMessage && (t === MsgType.Text || t === MsgType.Notice || t === MsgType.Emote);
}

/** Можно ли открыть меню действий для сообщения. */
export function canAct(ev: MatrixEvent): boolean {
  return hasServerId(ev) && !ev.isRedacted() && !ev.isDecryptionFailure() && !ev.isBeingDecrypted() && ev.getType() !== EventType.RoomMessageEncrypted;
}

export const canEdit = (ev: MatrixEvent, me: string): boolean =>
  ev.getSender() === me && isTextMessage(ev) && ev.getContent().msgtype === MsgType.Text && hasServerId(ev);

export const canDelete = (ev: MatrixEvent, me: string): boolean => ev.getSender() === me && hasServerId(ev);

/* ---------------- реакции ---------------- */

export interface ReactionSummary {
  key: string;
  count: number;
  /** своё событие-реакция (если есть) */
  mine: MatrixEvent | null;
}

export function getReactions(room: Room, ev: MatrixEvent, me: string): ReactionSummary[] {
  const id = ev.getId();
  if (!id || !hasServerId(ev)) return [];
  const container = room.relations ?? room.getUnfilteredTimelineSet().relations;
  const rel = container?.getChildEventsForEvent(id, RelationType.Annotation, EventType.Reaction);
  if (!rel) return [];
  const out: (ReactionSummary & { ts: number })[] = [];
  for (const [key, set] of rel.getSortedAnnotationsByKey() ?? []) {
    const events = [...set].filter((e) => !e.isRedacted());
    if (!events.length) continue;
    out.push({
      key,
      count: events.length,
      mine: events.find((e) => e.getSender() === me) ?? null,
      ts: Math.min(...events.map((e) => e.getTs())),
    });
  }
  // порядок стабильный: кто раньше появился, тот левее
  return out.sort((x, y) => x.ts - y.ts).map(({ key, count, mine }) => ({ key, count, mine }));
}

/** Короткая подпись реакций — для stamp, чтобы мемо-сообщение перерисовалось. */
export function reactionsStamp(room: Room, ev: MatrixEvent, me: string): string {
  return getReactions(room, ev, me).map((r) => `${r.key}:${r.count}:${r.mine ? 1 : 0}`).join(',');
}

export async function toggleReaction(client: MatrixClient, room: Room, ev: MatrixEvent, key: string): Promise<void> {
  const id = ev.getId();
  const me = client.getUserId();
  if (!id || !me || !hasServerId(ev)) return;
  const mine = getReactions(room, ev, me).find((r) => r.key === key)?.mine;
  if (mine) {
    const mid = mine.getId();
    if (mid?.startsWith('$')) {
      await client.redactEvent(room.roomId, mid);
    }
    return;
  }
  await client.sendEvent(room.roomId, EventType.Reaction as never, {
    'm.relates_to': { rel_type: RelationType.Annotation, event_id: id, key },
  } as never);
}

/* ---------------- ответ / правка ---------------- */

export function sendReply(client: MatrixClient, roomId: string, text: string, replyToId: string): Promise<unknown> {
  const content = {
    msgtype: 'm.text',
    body: text,
    'm.relates_to': { 'm.in_reply_to': { event_id: replyToId } },
  } as unknown as RoomMessageEventContent;
  return client.sendMessage(roomId, content);
}

export async function sendEdit(client: MatrixClient, roomId: string, target: MatrixEvent, text: string): Promise<void> {
  const id = target.getId();
  if (!id) return;
  const content = {
    msgtype: 'm.text',
    body: `* ${text}`,
    'm.new_content': { msgtype: 'm.text', body: text },
    'm.relates_to': { rel_type: RelationType.Replace, event_id: id },
  } as unknown as RoomMessageEventContent;
  await client.sendMessage(roomId, content);
}

/* ---------------- пересылка ---------------- */

/** Пересылка: текст — простым текстом, медиа — те же mxc/ключи (без повторной загрузки). */
export function forwardEvent(client: MatrixClient, targetRoomId: string, ev: MatrixEvent): Promise<unknown> {
  const c = { ...ev.getContent() } as Record<string, unknown>;
  if (isTextMessage(ev)) {
    return client.sendMessage(targetRoomId, { msgtype: 'm.text', body: plainBody(ev) } as unknown as RoomMessageEventContent);
  }
  delete c['m.relates_to'];
  delete c['m.new_content'];
  return client.sendMessage(targetRoomId, c as unknown as RoomMessageEventContent);
}

export function deleteMessage(client: MatrixClient, ev: MatrixEvent): Promise<unknown> {
  return client.redactEvent(ev.getRoomId()!, ev.getId()!);
}
