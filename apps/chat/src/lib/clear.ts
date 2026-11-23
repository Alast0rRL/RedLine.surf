import { Direction, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { toast } from '../components/ui';
import { isMessageLike } from './events';
import { hasServerId } from './messageActions';

export const CLEARED_TYPE = 'surf.redline.cleared';
const CAP = 2000;
const DELAY_MS = 150;

/** Метка «история очищена у меня»: события не новее неё скрыты. 0 — не очищалось. */
export function getClearedTs(room: Room): number {
  const c = room.getAccountData(CLEARED_TYPE as never)?.getContent() as { ts?: unknown } | undefined;
  return typeof c?.ts === 'number' ? c.ts : 0;
}

export function visibleAfterClear(room: Room, events: MatrixEvent[]): MatrixEvent[] {
  const ts = getClearedTs(room);
  return ts ? events.filter((e) => e.getTs() > ts) : events;
}

export function isClearCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === '/clear' || t === '/очистить';
}

/** Можно ли удалять чужие сообщения в этой комнате.
 *  Уровень берём у SDK: в комнатах версии 12 создатель не записан в power_levels, но права у него максимальные. */
export function canClearForAll(room: Room, me: string): boolean {
  const level = room.getMember(me)?.powerLevel ?? 0;
  return room.currentState.hasSufficientPowerLevelFor('redact', level);
}

export async function clearForMe(client: MatrixClient, room: Room): Promise<void> {
  const events = room.getLiveTimeline().getEvents();
  let ts = Date.now();
  if (events.length) ts = Math.max(...events.map((e) => e.getTs()));
  await client.setRoomAccountData(room.roomId, CLEARED_TYPE as never, { ts } as never);
}

export async function clearForAll(client: MatrixClient, room: Room): Promise<void> {
  await clearForMe(client, room);
  const me = client.getUserId()!;
  const live = room.getLiveTimeline();
  const collect = () =>
    live.getEvents().filter((e) => isMessageLike(e) && hasServerId(e) && (e.getSender() === me || canClearForAll(room, me)));

  let dismiss = toast('Собираем сообщения…', { duration: 0 });
  try {
    while (live.getPaginationToken(Direction.Backward) !== null && collect().length < CAP + 1) {
      await client.paginateEventTimeline(live, { backwards: true, limit: 100 });
    }
  } catch (e) {
    console.warn('clear: paginate failed', e);
  }
  const all = collect().sort((a, b) => b.getTs() - a.getTs());
  const list = all.slice(0, CAP);
  let done = 0;
  try {
    for (const ev of list) {
      await client.redactEvent(room.roomId, ev.getId()!);
      done++;
      if (done % 5 === 0 || done === list.length) {
        dismiss();
        dismiss = toast(`Удаляем… ${done}/${list.length}`, { duration: 0 });
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  } catch (e) {
    dismiss();
    console.warn('clear: redact failed', e);
    toast(`Не удалось удалить всё: удалено ${done} из ${list.length}`, { variant: 'error' });
    return;
  }
  dismiss();
  if (all.length > CAP) toast(`Удалено ${CAP}, запустите /clear ещё раз`);
  else toast('История очищена', { variant: 'success' });
}
