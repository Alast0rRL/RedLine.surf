import { type MatrixClient } from 'matrix-js-sdk';
import { findAdminRoom, runAdminCommand } from './admin';
import { baseUsername, isPersonalLink, newPerson, rememberPinUsers, type PersonalLink } from './pin';

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
const MEMBER_LINKS_DATA_TYPE = 'surf.redline.guest-links';
const TOKEN_RE = /^[A-Za-z0-9]{16}$/;

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
  const links = items.filter(isPersonalLink);
  rememberPinUsers(links.map((l) => l.user));
  return links;
}

async function saveLinks(client: MatrixClient, items: PersonalLink[]): Promise<void> {
  await client.setAccountData(LINKS_DATA_TYPE as never, { items } as never);
}

export async function loadMemberLinks(client: MatrixClient): Promise<PersonalLink[]> {
  let raw: unknown;
  try {
    raw = await client.getAccountDataFromServer(MEMBER_LINKS_DATA_TYPE as never);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  const items = (raw as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items.filter(isPersonalLink) : [];
}

export async function saveMemberLinks(client: MatrixClient, items: PersonalLink[]): Promise<void> {
  await client.setAccountData(MEMBER_LINKS_DATA_TYPE as never, { items } as never);
}

async function doRevokeInvite(client: MatrixClient, adminRoom: string, token: string): Promise<void> {
  if (!TOKEN_RE.test(token)) throw new Error('Приглашение не подходит. Создайте новое');
  const { body } = await runAdminCommand(client, adminRoom, `!admin token revoke ${token}`);
  if (!body.trim().startsWith('Token revoked successfully.')) throw new Error('Не удалось отозвать приглашение. Попробуйте ещё раз');
}

async function doCreateInvite(client: MatrixClient, adminRoom: string, name: string): Promise<CreatedInvite> {
  const { body } = await runAdminCommand(client, adminRoom, '!admin token issue --once');
  const match = /New registration token issued:\s*`([A-Za-z0-9]{16})`/.exec(body);
  if (!match) throw new Error('Не удалось создать приглашение. Попробуйте ещё раз');
  const invite: Invite = { token: match[1], createdAt: Date.now(), label: name };
  try {
    const [currentInvites, currentLinks] = await Promise.all([readMetadata(client), loadLinks(client)]);
    const user = await freeUsername(client, name, currentLinks);
    const link: PersonalLink = { ...newPerson(name, user), token: invite.token };
    await saveMetadata(client, [...currentInvites.filter((i) => i.token !== invite.token), invite]);
    await saveLinks(client, [...currentLinks.filter((l) => l.token !== link.token && l.user !== link.user), link]);
    rememberPinUsers([link.user]);
    return { invite, link };
  } catch (e) {
    try {
      await doRevokeInvite(client, adminRoom, invite.token);
    } catch {
      console.warn('Не удалось отозвать токен приглашения');
    }
    throw e;
  }
}

/**
 * Логин без случайных цифр: `ded`, а если занят — `ded2`, `ded3`…
 * Занятым считаем и логин из ещё не использованной ссылки, чтобы два «Деда» не получили один.
 */
export async function freeUsername(client: MatrixClient, name: string, links: PersonalLink[]): Promise<string> {
  const base = baseUsername(name);
  const pending = new Set(links.map((l) => l.user));
  for (let n = 1; n <= 99; n++) {
    const candidate = n === 1 ? base : `${base}${n}`;
    if (pending.has(candidate)) continue;
    let free: boolean;
    try {
      free = await client.isUsernameAvailable(candidate);
    } catch (e) {
      const code = (e as { errcode?: string }).errcode;
      if (code === 'M_USER_IN_USE' || code === 'M_EXCLUSIVE' || code === 'M_INVALID_USERNAME') continue;
      throw new Error('Не удалось проверить, свободен ли логин. Попробуйте ещё раз');
    }
    if (free) return candidate;
  }
  throw new Error('Не нашлось свободного логина для этого имени. Укажите имя иначе');
}

async function doLoadInvites(client: MatrixClient, adminRoom: string): Promise<Invite[]> {
  const { body } = await runAdminCommand(client, adminRoom, '!admin token list');
  if (!body.startsWith('Found ')) throw new Error('Не удалось получить список приглашений. Попробуйте ещё раз');
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

/** Забыть человека: его личная ссылка и ещё не использованный токен регистрации. */
export function removeLink(client: MatrixClient, adminRoom: string, user: string): Promise<void> {
  return serialized(async () => {
    const links = await loadLinks(client);
    const mine = links.filter((l) => l.user === user);
    if (!mine.length) return;
    await saveLinks(client, links.filter((l) => l.user !== user));
    const invites = await readMetadata(client);
    const pending = new Set(invites.map((i) => i.token));
    for (const { token } of mine) {
      // токен у человека, уже зашедшего по ссылке, использован: отзываем только ещё ждущие
      if (!pending.has(token)) continue;
      try {
        await doRevokeInvite(client, adminRoom, token);
      } catch {
        /* уже использован или отозван */
      }
    }
    const tokens = new Set(mine.map((l) => l.token));
    if (invites.some((i) => tokens.has(i.token))) {
      await saveMetadata(client, invites.filter((i) => !tokens.has(i.token))).catch(() => console.warn('Не удалось обновить метаданные приглашений'));
    }
  });
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
