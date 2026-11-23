import { EventType, JoinRule, Preset, Visibility, type MatrixClient } from 'matrix-js-sdk';
import { getConfig } from '../config';
import { runAdminCommand } from './admin';

const KICK_REASON = 'Убран(а) из семьи';

function isNotFound(e: unknown): boolean {
  const err = e as { errcode?: string; httpStatus?: number };
  return err?.errcode === 'M_NOT_FOUND' || err?.httpStatus === 404;
}

/** Id комнаты `#family:<server>` или null, если её ещё нет. */
export async function getFamilyRoomId(client: MatrixClient): Promise<string | null> {
  try {
    return (await client.getRoomIdForAlias(`#family:${getConfig().serverName}`)).room_id;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** Состоит ли человек в семье: приглашён или уже в комнате. */
export function isInFamily(client: MatrixClient, familyId: string | null, userId: string): boolean {
  if (!familyId) return false;
  const m = client.getRoom(familyId)?.getMember(userId)?.membership;
  return m === 'join' || m === 'invite';
}

async function waitForRoom(client: MatrixClient, roomId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (client.getRoom(roomId)?.getMyMembership() === 'join') return;
    await new Promise<void>((r) => setTimeout(r, 250));
  }
}

/** Находит или создаёт комнату «Семья»; закрывает вход (invite) и гарантирует, что админ в ней. */
export async function ensureFamilyRoom(client: MatrixClient): Promise<string> {
  let roomId = await getFamilyRoomId(client);
  if (!roomId) {
    ({ room_id: roomId } = await client.createRoom({
      name: 'Семья',
      room_alias_name: 'family',
      visibility: Visibility.Private,
      preset: Preset.PrivateChat,
      initial_state: [
        { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
        { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
      ],
    }));
    await waitForRoom(client, roomId);
    return roomId;
  }
  if (client.getRoom(roomId)?.getMyMembership() !== 'join') {
    await client.joinRoom(roomId);
    await waitForRoom(client, roomId);
  }
  const room = client.getRoom(roomId);
  const rule = room?.currentState.getStateEvents('m.room.join_rules', '')?.getContent().join_rule;
  if (rule === 'public') {
    await client.sendStateEvent(roomId, EventType.RoomJoinRules, { join_rule: JoinRule.Invite }, '');
  }
  return roomId;
}

function failed(body: string): boolean {
  return /fail|error|not found|не удалось/i.test(body);
}

async function waitForMembership(client: MatrixClient, roomId: string, userId: string, want: boolean): Promise<boolean> {
  for (let i = 0; i < 12; i++) {
    if (isInFamily(client, roomId, userId) === want) return true;
    await new Promise<void>((r) => setTimeout(r, 500));
  }
  return false;
}

/** Добавить или убрать человека из семьи (без приглашений, которые надо принимать). */
export async function setInFamily(
  client: MatrixClient,
  adminRoom: string,
  userId: string,
  value: boolean,
): Promise<void> {
  const roomId = await ensureFamilyRoom(client);
  if (value) {
    const reply = await runAdminCommand(client, adminRoom, `!admin users force-join-room ${userId} ${roomId}`);
    if (failed(reply.body)) {
      console.warn('force-join-room: ответ сервера', reply.body);
      throw new Error('Не удалось добавить в семью');
    }
    // членство не всегда сразу видно клиенту; при успешном ответе это не ошибка
    await waitForMembership(client, roomId, userId, true);
    return;
  }
  try {
    await client.kick(roomId, userId, KICK_REASON);
  } catch {
    const reply = await runAdminCommand(client, adminRoom, `!admin users force-leave-room ${userId} ${roomId}`);
    if (failed(reply.body)) {
      console.warn('force-leave-room: ответ сервера', reply.body);
      throw new Error('Не удалось убрать из семьи');
    }
  }
  await waitForMembership(client, roomId, userId, false);
}
