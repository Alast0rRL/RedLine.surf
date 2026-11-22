import { PushRuleKind, Preset, Visibility, type MatrixClient, type Room } from 'matrix-js-sdk';
import { addDirect, encryption, findExistingDm } from '../screens/NewChat';

const FAVOURITE = 'm.favourite';

/** Уведомления комнаты выключены: room-правило push с пустым списком действий. */
export function isRoomMuted(client: MatrixClient, roomId: string): boolean {
  const rule = client.getRoomPushRule('global', roomId);
  if (!rule || !rule.enabled) return false;
  return rule.actions.length === 0 || (rule.actions as unknown[]).includes('dont_notify');
}

export async function setRoomMuted(client: MatrixClient, roomId: string, mute: boolean): Promise<void> {
  if (isRoomMuted(client, roomId) === mute) return;
  const done = client.setRoomMutePushRule('global', roomId, mute);
  if (done) {
    await done;
    return;
  }
  // запасной путь, если SDK не смог сам
  if (mute) await client.addPushRule('global', PushRuleKind.RoomSpecific, roomId, { actions: [] });
  else await client.deletePushRule('global', PushRuleKind.RoomSpecific, roomId);
}

export function isRoomPinned(room: Room): boolean {
  return FAVOURITE in (room.tags ?? {});
}

export async function setRoomPinned(client: MatrixClient, roomId: string, pinned: boolean): Promise<void> {
  if (pinned) await client.setRoomTag(roomId, FAVOURITE, { order: 0.5 });
  else await client.deleteRoomTag(roomId, FAVOURITE);
}

/** Выйти из комнаты и убрать её из списка. */
export async function leaveRoom(client: MatrixClient, roomId: string): Promise<void> {
  await client.leave(roomId);
  await client.forget(roomId).catch(() => {});
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
