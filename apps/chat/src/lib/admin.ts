import { Direction, MsgType, type MatrixClient } from 'matrix-js-sdk';
import { getConfig } from '../config';
import { isPersonalLink, resetSecret, type PersonalLink } from './pin';

const COMMAND_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 700;

/** Команды администратора идут в одну очередь: ответ ищется по event_id. */
let commandQueue: Promise<unknown> = Promise.resolve();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNotFound(e: unknown): boolean {
  const err = e as { errcode?: string; httpStatus?: number };
  return err?.errcode === 'M_NOT_FOUND' || err?.httpStatus === 404;
}

function isReplyTo(event: unknown, eventId: string): event is { event_id: string; content: { body: string } } {
  const e = event as {
    sender?: unknown;
    event_id?: unknown;
    content?: { body?: unknown; 'm.relates_to'?: { 'm.in_reply_to'?: { event_id?: unknown } } };
  };
  return (
    e?.sender === `@conduit:${getConfig().serverName}` &&
    e.content?.['m.relates_to']?.['m.in_reply_to']?.event_id === eventId &&
    typeof e.event_id === 'string' &&
    typeof e.content?.body === 'string'
  );
}

interface AdminReply {
  body: string;
  /** событие с ответом conduit (может содержать секрет) */
  eventId: string;
  /** сама команда — её тоже надо скрыть, если в ней был секрет */
  commandId: string;
}

async function sendAndWait(client: MatrixClient, roomId: string, command: string): Promise<AdminReply> {
  if (/[\r\n]/.test(command)) throw new Error('Команда не должна содержать переводы строк');
  const sent = await client.sendMessage(roomId, { msgtype: MsgType.Text, body: command });
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  for (;;) {
    const response = await client.createMessagesRequest(roomId, null, 30, Direction.Backward);
    for (const event of response.chunk) {
      if (isReplyTo(event, sent.event_id)) {
        return { body: event.content.body, eventId: event.event_id, commandId: sent.event_id };
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('Сервер не ответил на команду');
}

/** Комната администраторов ищется только по алиасу, не по названию. */
export async function findAdminRoom(client: MatrixClient): Promise<string | null> {
  const alias = `#admins:${getConfig().serverName}`;
  let roomId: string;
  try {
    roomId = (await client.getRoomIdForAlias(alias)).room_id;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
  return client.getRoom(roomId)?.getMyMembership() === 'join' ? roomId : null;
}

/** Отправка команды и ожидание ответа от conduit; ошибка не ломает очередь. */
export function runAdminCommand(client: MatrixClient, roomId: string, command: string): Promise<AdminReply> {
  const result = commandQueue.then(
    () => sendAndWait(client, roomId, command),
    () => sendAndWait(client, roomId, command),
  );
  commandQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Список локальных пользователей из ответа `!admin users list`. */
export async function listUsers(client: MatrixClient, roomId: string): Promise<string[]> {
  const { body } = await runAdminCommand(client, roomId, '!admin users list');
  if (!body.startsWith('Found ')) throw new Error('Не удалось получить список пользователей');
  const serverName = getConfig().serverName;
  const line = new RegExp(`^@[a-z0-9._=/+-]+:${escapeRegExp(serverName)}$`);
  return body
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => line.test(s) && s !== `@conduit:${serverName}`);
}

/** Сброс пароля: возвращает новый пароль и скрывает событие с ним. */
export async function resetPassword(
  client: MatrixClient,
  roomId: string,
  userId: string,
  logoutDevices: boolean,
): Promise<string> {
  const serverName = getConfig().serverName;
  const suffix = `:${serverName}`;
  if (!userId.endsWith(suffix)) throw new Error('Пользователь не на этом сервере');
  const localpart = userId.slice(0, -suffix.length).replace(/^@/, '');
  if (!/^[a-z0-9._=-]+$/.test(localpart) || localpart.startsWith('-')) {
    throw new Error('Некорректный логин пользователя');
  }

  const command = `!admin users reset-password ${logoutDevices ? '--logout ' : ''}${localpart}`;
  const reply = await runAdminCommand(client, roomId, command);
  const match = /Successfully reset the password for user @[^\s:]+:[^\s:]+:\s*`([^`]+)`/.exec(reply.body);
  if (!match) throw new Error('Не удалось сбросить пароль');

  try {
    await client.redactEvent(roomId, reply.eventId);
  } catch {
    // событие с паролем осталось видимым — секрет в лог не пишем
    console.warn('Не удалось скрыть событие с новым паролем');
  }
  return match[1];
}

/** Сброс PIN: временный пароль в команде и ответ скрываем сразу после ответа. */
export async function resetPin(client: MatrixClient, room: string, link: PersonalLink): Promise<void> {
  if (!isPersonalLink(link)) throw new Error('Некорректная личная ссылка');
  const secret = await resetSecret(link);
  const reply = await runAdminCommand(client, room, `!admin users reset-password --logout ${link.user} ${secret}`);
  const redactions = await Promise.allSettled([
    client.redactEvent(room, reply.commandId),
    client.redactEvent(room, reply.eventId),
  ]);
  if (redactions.some((r) => r.status === 'rejected')) console.warn('Не удалось скрыть события сброса PIN');
  if (!reply.body.trim().startsWith('Successfully reset the password for user')) throw new Error('Не удалось сбросить PIN');
}

/** Удаление человека: Continuwuity отключает аккаунт и выводит его из всех комнат. */
export async function deleteUser(client: MatrixClient, roomId: string, localpartOrMxid: string): Promise<void> {
  const serverName = getConfig().serverName;
  const suffix = `:${serverName}`;
  const raw = localpartOrMxid.trim();
  if (raw.includes(':') && !raw.endsWith(suffix)) throw new Error('Пользователь не на этом сервере');
  const localpart = (raw.endsWith(suffix) ? raw.slice(0, -suffix.length) : raw).replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._=-]+$/.test(localpart) || localpart.startsWith('-')) throw new Error('Некорректный логин пользователя');
  const own = client.getUserId()?.replace(/^@/, '').split(':')[0].toLowerCase();
  if (localpart === own) throw new Error('Нельзя удалить самого себя');
  if (localpart === 'admin' || localpart === 'conduit') throw new Error('Нельзя удалить администратора сервера');

  const reply = await runAdminCommand(client, roomId, `!admin users deactivate @${localpart}${suffix}`);
  if (!/deactivated/i.test(reply.body)) {
    throw new Error(reply.body.trim().split(/\r?\n/)[0].slice(0, 200) || 'Не удалось удалить пользователя');
  }
}
