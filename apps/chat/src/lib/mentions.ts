import { NotificationCountType, type MatrixEvent, type Room, type RoomMember } from 'matrix-js-sdk';
import { isMessageLike } from './events';
import { fold } from './search';

/** Есть ли в сообщении упоминание этого пользователя (m.mentions или ссылка matrix.to в formatted_body). */
export function isMentioningMe(ev: MatrixEvent, me: string | null): boolean {
  if (!me || ev.getSender() === me || ev.isRedacted()) return false;
  const c = ev.getContent();
  const ids = c['m.mentions']?.user_ids;
  if (Array.isArray(ids) && ids.includes(me)) return true;
  const html = c.formatted_body;
  return typeof html === 'string' && (html.includes(`matrix.to/#/${me}`) || html.includes(`matrix.to/#/${encodeURIComponent(me)}`));
}

/** Среди непрочитанных сообщений комнаты есть то, где упомянули меня. */
export function hasUnreadMention(room: Room, me: string | null): boolean {
  if (!me) return false;
  let left = Math.min(room.getUnreadNotificationCount(NotificationCountType.Total), 60);
  if (left <= 0) return false;
  if (room.getUnreadNotificationCount(NotificationCountType.Highlight) > 0) return true;
  const events = room.getLiveTimeline().getEvents();
  for (let i = events.length - 1; i >= 0 && left > 0; i--) {
    const ev = events[i];
    if (!isMessageLike(ev) || ev.getSender() === me) continue;
    left--;
    if (isMentioningMe(ev, me)) return true;
  }
  return false;
}

export interface MentionCandidate {
  member: RoomMember;
  name: string;
}

export const memberLabel = (m: RoomMember): string => (m.name && m.name !== m.userId ? m.name : m.userId.replace(/^@/, '').split(':')[0]);

/** Участники для списка после «@»: по имени или логину, «ё» = «е». */
export function mentionCandidates(room: Room, me: string, query: string, limit = 6): MentionCandidate[] {
  const q = fold(query);
  const out: (MentionCandidate & { rank: number })[] = [];
  for (const member of room.getJoinedMembers()) {
    if (member.userId === me) continue;
    const name = memberLabel(member);
    const n = fold(name);
    const local = fold(member.userId.replace(/^@/, '').split(':')[0]);
    if (q && !n.includes(q) && !local.includes(q)) continue;
    out.push({ member, name, rank: n.startsWith(q) || local.startsWith(q) ? 0 : 1 });
  }
  out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'ru'));
  return out.slice(0, limit);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const wordChar = /[\p{L}\p{N}_]/u;

/**
 * Ищет в готовом тексте «@Имя» участников комнаты. Если нашёл — отдаёт поля для сообщения:
 * m.mentions и formatted_body со ссылками matrix.to. Сам body остаётся обычным текстом «@Имя».
 */
export function buildMentionContent(room: Room, me: string, body: string): Record<string, unknown> | null {
  const spans: { start: number; end: number; id: string; name: string }[] = [];
  const members = room.getJoinedMembers()
    .filter((m) => m.userId !== me)
    .map((m) => ({ id: m.userId, name: memberLabel(m) }))
    .sort((a, b) => b.name.length - a.name.length); // «Анна Петрова» раньше «Анна»
  for (const m of members) {
    const token = `@${m.name}`;
    for (let i = body.indexOf(token); i >= 0; i = body.indexOf(token, i + 1)) {
      const end = i + token.length;
      if (i > 0 && wordChar.test(body[i - 1])) continue;
      if (end < body.length && wordChar.test(body[end])) continue;
      if (spans.some((s) => i < s.end && end > s.start)) continue;
      spans.push({ start: i, end, id: m.id, name: m.name });
    }
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a.start - b.start);
  let html = '';
  let at = 0;
  const text = (s: string) => esc(s).replace(/\n/g, '<br>');
  for (const s of spans) {
    html += text(body.slice(at, s.start)) + `<a href="https://matrix.to/#/${esc(s.id)}">${esc(s.name)}</a>`;
    at = s.end;
  }
  html += text(body.slice(at));
  return {
    'm.mentions': { user_ids: [...new Set(spans.map((s) => s.id))] },
    format: 'org.matrix.custom.html',
    formatted_body: html,
  };
}
