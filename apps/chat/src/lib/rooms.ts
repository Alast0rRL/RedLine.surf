import { PushRuleActionName, PushRuleKind, Preset, RoomEvent, Visibility, type MatrixClient, type Room } from 'matrix-js-sdk';
import { emitOptimistic } from './optimistic';
import { addDirect, encryption, findExistingDm } from '../screens/NewChat';

const FAVOURITE = 'm.favourite';

/* Оптимистичные значения: интерфейс меняется сразу, запрос идёт в фоне. */
const mutedOverride = new Map<string, boolean>();
const pinnedOverride = new Map<string, boolean>();
const leavingRooms = new Set<string>();
const OVERRIDE_TTL_MS = 20_000;

function serverMuted(client: MatrixClient, roomId: string): boolean {
  const rule = client.getRoomPushRule('global', roomId);
  if (!rule || !rule.enabled) return false;
  return rule.actions.length === 0 || (rule.actions as unknown[]).includes('dont_notify');
}

/** Уведомления комнаты выключены: room-правило push с пустым списком действий или dont_notify. */
export function isRoomMuted(client: MatrixClient, roomId: string): boolean {
  return mutedOverride.get(roomId) ?? serverMuted(client, roomId);
}

/**
 * Проверка «выключены ли уведомления» для списка комнат: правила читаются один раз,
 * а не поиском по всем правилам на каждую комнату.
 */
export function roomMutedChecker(client: MatrixClient): (roomId: string) => boolean {
  const muted = new Set<string>();
  for (const rule of client.pushRules?.global?.room ?? []) {
    if (rule.enabled && (rule.actions.length === 0 || (rule.actions as unknown[]).includes('dont_notify'))) muted.add(rule.rule_id);
  }
  return (roomId) => mutedOverride.get(roomId) ?? muted.has(roomId);
}

export function setRoomMuted(client: MatrixClient, roomId: string, mute: boolean): Promise<void> {
  if (isRoomMuted(client, roomId) === mute) return Promise.resolve();
  mutedOverride.set(roomId, mute);
  emitOptimistic();
  const drop = () => {
    if (mutedOverride.get(roomId) === mute) mutedOverride.delete(roomId);
    emitOptimistic();
  };
  const run = async () => {
    if (mute) await client.addPushRule('global', PushRuleKind.RoomSpecific, roomId, { actions: [PushRuleActionName.DontNotify] });
    else await client.deletePushRule('global', PushRuleKind.RoomSpecific, roomId);
    // подтянуть правила, чтобы серверное состояние догнало; затем снять временное значение
    try {
      client.setPushRules(await client.getPushRules());
    } catch {
      /* придёт со следующей синхронизацией */
    }
    drop();
  };
  return run().catch((e) => {
    drop();
    throw e;
  });
}

export function isRoomPinned(room: Room): boolean {
  return pinnedOverride.get(room.roomId) ?? FAVOURITE in (room.tags ?? {});
}

export function setRoomPinned(client: MatrixClient, roomId: string, pinned: boolean): Promise<void> {
  pinnedOverride.set(roomId, pinned);
  emitOptimistic();
  const drop = () => {
    if (pinnedOverride.get(roomId) === pinned) pinnedOverride.delete(roomId);
    emitOptimistic();
  };
  // снимаем временное значение, когда теги из синхронизации совпали (или по таймауту)
  const onTags = (_ev: unknown, room: Room) => {
    if (room.roomId === roomId && (FAVOURITE in (room.tags ?? {})) === pinned) done();
  };
  const timer = setTimeout(() => done(), OVERRIDE_TTL_MS);
  const done = () => {
    clearTimeout(timer);
    client.off(RoomEvent.Tags, onTags as never);
    drop();
  };
  client.on(RoomEvent.Tags, onTags as never);
  const req = pinned ? client.setRoomTag(roomId, FAVOURITE, { order: 0.5 }) : client.deleteRoomTag(roomId, FAVOURITE);
  return req.then(
    () => {},
    (e) => {
      done();
      throw e;
    },
  );
}

/** Комната сразу пропадает из списка, пока идёт выход. */
export const isRoomLeaving = (roomId: string): boolean => leavingRooms.has(roomId);

/** Выйти из комнаты и убрать её из списка: список обновляется сразу, запрос идёт в фоне. */
export async function leaveRoom(client: MatrixClient, roomId: string): Promise<void> {
  leavingRooms.add(roomId);
  emitOptimistic();
  try {
    await client.leave(roomId);
    await client.forget(roomId).catch(() => {});
  } catch (e) {
    leavingRooms.delete(roomId);
    emitOptimistic();
    throw e;
  }
  // комната уже не в списке по членству; запись можно снять чуть позже
  setTimeout(() => {
    leavingRooms.delete(roomId);
    emitOptimistic();
  }, OVERRIDE_TTL_MS);
}

/** Личный чат с человеком: существующий или новый (как в «Новом чате»). */
export async function openDm(client: MatrixClient, userId: string): Promise<string> {
  const existing = findExistingDm(client, userId);
  if (existing) return existing;
  const { room_id: roomId } = await client.createRoom({
    is_direct: true,
    invite: [userId],
    preset: Preset.TrustedPrivateChat,
    visibility: Visibility.Private,
    initial_state: encryption,
  });
  await addDirect(client, userId, roomId);
  return roomId;
}

export interface RoomPower {
  me: number;
  canKick: boolean;
  canInvite: boolean;
  canRename: boolean;
  canAvatar: boolean;
  /** можно ли исключить участника с таким уровнем прав */
  canKickLevel: (level: number) => boolean;
}

export function roomPower(client: MatrixClient, room: Room): RoomPower {
  const content = room.currentState.getStateEvents('m.room.power_levels', '')?.getContent() ?? {};
  const meId = client.getUserId()!;
  const me = room.getMember(meId)?.powerLevel ?? 0;
  const kick: number = typeof content.kick === 'number' ? content.kick : 50;
  const invite: number = typeof content.invite === 'number' ? content.invite : 0;
  return {
    me,
    canKick: me >= kick,
    canInvite: me >= invite,
    canRename: room.currentState.maySendStateEvent('m.room.name', meId),
    canAvatar: room.currentState.maySendStateEvent('m.room.avatar', meId),
    canKickLevel: (level) => me >= kick && level < me,
  };
}

export function pluralMembers(n: number): string {
  const word = n % 10 === 1 && n % 100 !== 11 ? 'участник' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'участника' : 'участников';
  return `${n} ${word}`;
}
