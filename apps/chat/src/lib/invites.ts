import { type MatrixClient } from 'matrix-js-sdk';
import { Preset, Visibility } from 'matrix-js-sdk/lib/@types/partials.js';
import { getConfig } from '../config';
import { findAdminRoom, runAdminCommand } from './admin';
import { isPersonalLink, newPerson, type PersonalLink } from './pin';

export interface Invite {
  token: string;
  createdAt: number | null;
  label: string;
}

/** Результат создания: приглашение для списка и личная ссылка для человека. */
export interface CreatedInvite {
  invite: Invite;
  link: PersonalLink;
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const INVITE_DATA_TYPE = 'surf.redline.invites';
const LINKS_DATA_TYPE = 'surf.redline.links';
const TOKEN_RE = /^[A-Za-z0-9]{16}$/;
const OWNER_POWER = 100;

/** Очередь операций: account data не должна перезаписываться гонкой. */
let inviteQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = inviteQueue.then(fn, fn);
  inviteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isNotFound(e: unknown): boolean {
  const err = e as { errcode?: string; httpStatus?: number };
  return err?.errcode === 'M_NOT_FOUND' || err?.httpStatus === 404;
}

function asInvite(value: unknown): Invite | null {
  const item = value as { token?: unknown; createdAt?: unknown; label?: unknown } | null;
  if (!item || typeof item.token !== 'string' || !TOKEN_RE.test(item.token)) return null;
  return {
    token: item.token,
    createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : null,
    label: typeof item.label === 'string' ? item.label : '',
  };
}

async function readMetadata(client: MatrixClient): Promise<Invite[]> {
  let raw: unknown;
  try {
    raw = await client.getAccountDataFromServer(INVITE_DATA_TYPE as never);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map(asInvite).filter((i): i is Invite => i !== null);
}

async function saveMetadata(client: MatrixClient, items: Invite[]): Promise<void> {
  await client.setAccountData(INVITE_DATA_TYPE as never, { items } as never);
}

/** Личные ссылки не зависят от срока токена: они нужны для нового телефона и сброса PIN. */
export async function loadLinks(client: MatrixClient): Promise<PersonalLink[]> {
  let raw: unknown;
  try {
    raw = await client.getAccountDataFromServer(LINKS_DATA_TYPE as never);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(isPersonalLink);
}

async function saveLinks(client: MatrixClient, items: PersonalLink[]): Promise<void> {
  await client.setAccountData(LINKS_DATA_TYPE as never, { items } as never);
}

async function doRevokeInvite(client: MatrixClient, adminRoom: string, token: string): Promise<void> {
  if (!TOKEN_RE.test(token)) throw new Error('Некорректный токен приглашения');
  const { body } = await runAdminCommand(client, adminRoom, `!admin token revoke ${token}`);
  if (!body.trim().startsWith('Token revoked successfully.')) throw new Error('Не удалось отозвать приглашение');
}

async function doCreateInvite(client: MatrixClient, adminRoom: string, name: string): Promise<CreatedInvite> {
  const { body } = await runAdminCommand(client, adminRoom, '!admin token issue --once');
  const match = /New registration token issued:\s*`([A-Za-z0-9]{16})`/.exec(body);
  if (!match) throw new Error('Не удалось получить токен приглашения');
  const invite: Invite = { token: match[1], createdAt: Date.now(), label: name };
  const link: PersonalLink = { ...newPerson(name), token: invite.token };
  try {
    const [currentInvites, currentLinks] = await Promise.all([readMetadata(client), loadLinks(client)]);
    await saveMetadata(client, [...currentInvites.filter((i) => i.token !== invite.token), invite]);
    await saveLinks(client, [...currentLinks.filter((l) => l.token !== link.token && l.user !== link.user), link]);
  } catch (e) {
    try {
      await doRevokeInvite(client, adminRoom, invite.token);
    } catch {
      console.warn('Не удалось отозвать токен приглашения');
    }
    throw e;
  }
  return { invite, link };
}

async function doLoadInvites(client: MatrixClient, adminRoom: string): Promise<Invite[]> {
  const { body } = await runAdminCommand(client, adminRoom, '!admin token list');
  if (!body.startsWith('Found ')) throw new Error('Не удалось получить список приглашений');
  const metadata = new Map((await readMetadata(client)).map((i) => [i.token, i]));
  const now = Date.now();
  const live: Invite[] = [];
  for (const line of body.split('\n')) {
    const match = /^- `([A-Za-z0-9]{16})` --- Token created by/.exec(line);
    if (!match) continue;
    const known = metadata.get(match[1]);
    if (known && known.createdAt !== null && now - known.createdAt >= INVITE_TTL_MS) {
      await doRevokeInvite(client, adminRoom, match[1]);
      continue;
    }
    live.push(known ?? { token: match[1], createdAt: null, label: '' });
  }
  try {
    await saveMetadata(client, live);
  } catch {
    console.warn('Не удалось обновить метаданные приглашений');
  }
  return live.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Живые токены сервера плюс даты и подписи; просроченные отзываем. */
export function loadInvites(client: MatrixClient, adminRoom: string): Promise<Invite[]> {
  return serialized(() => doLoadInvites(client, adminRoom));
}

export function createInvite(client: MatrixClient, adminRoom: string, name: string): Promise<CreatedInvite> {
  return serialized(() => doCreateInvite(client, adminRoom, name));
}

export function revokeInvite(client: MatrixClient, adminRoom: string, token: string): Promise<void> {
  return serialized(() => doRevokeInvite(client, adminRoom, token));
}

/** Комната по алиасу должна быть нашей: создатель в v12+ отсутствует в users. */
async function isOwnFamilyRoom(client: MatrixClient, roomId: string): Promise<boolean> {
  const userId = client.getUserId();
  if (!userId) return false;
  const joinedInStore = client.getRoom(roomId)?.getMyMembership() === 'join';
  let state: {
    type?: string;
    state_key?: string;
    sender?: string;
    content?: { membership?: unknown };
  }[] = [];
  try {
    const levels = (await client.getStateEvent(roomId, 'm.room.power_levels', '')) as {
      users?: Record<string, number>;
      users_default?: number;
    };
    const power = levels.users?.[userId] ?? levels.users_default ?? 0;
    if (power < OWNER_POWER) {
      state = await client.roomState(roomId);
      if (state.find((e) => e.type === 'm.room.create')?.sender !== userId) return false;
    }
  } catch {
    return false;
  }
  if (joinedInStore) return true;
  try {
    if (!state.length) state = await client.roomState(roomId);
    return state.some(
      (e) => e.type === 'm.room.member' && e.state_key === userId && e.content?.membership === 'join',
    );
  } catch {
    return false;
  }
}

/** Комната «Семья»: создаём с публичным правилом входа (сервер invite-only). */
export async function ensureFamilyRoom(client: MatrixClient): Promise<string> {
  const alias = `#family:${getConfig().serverName}`;
  try {
    const { room_id: roomId } = await client.getRoomIdForAlias(alias);
    if (!(await isOwnFamilyRoom(client, roomId))) {
      throw new Error('Адрес #family занят комнатой, которой вы не управляете');
    }
    return roomId;
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }

  const { room_id: roomId } = await client.createRoom({
    name: 'Семья',
    room_alias_name: 'family',
    visibility: Visibility.Private,
    preset: Preset.PrivateChat,
    initial_state: [
      {
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      },
      {
        type: 'm.room.join_rules',
        state_key: '',
        content: { join_rule: 'public' },
      },
    ],
  });
  return roomId;
}

const sweptClients = new WeakSet<MatrixClient>();

/** При открытии приложения: проверить даты без команд, а чистить только если есть просроченные. */
export async function sweepExpiredInvites(client: MatrixClient): Promise<void> {
  if (sweptClients.has(client)) return;
  sweptClients.add(client);
  try {
    const items = await readMetadata(client);
    const now = Date.now();
    if (!items.some((i) => i.createdAt !== null && now - i.createdAt >= INVITE_TTL_MS)) return;
    const adminRoom = await findAdminRoom(client);
    if (adminRoom) await loadInvites(client, adminRoom);
  } catch (e) {
    console.warn('Не удалось проверить срок приглашений', e);
  }
}
