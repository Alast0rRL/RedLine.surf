/**
 * Вход по личной ссылке и PIN.
 *
 * Ссылка: #/p/<логин>/<ключ>/<токен регистрации>/<имя>. Ключ (128 бит) живёт во фрагменте адреса
 * и в nginx не попадает. Из него выводятся:
 *  - пароль Matrix = H(ключ, логин, PIN): без ссылки PIN по сети не подобрать;
 *  - ключ переписки = H(ключ, логин), от PIN не зависит: сброс PIN не теряет историю;
 *  - пароль «PIN сброшен» = H(ключ, логин, reset): его ставит админ, дальше человек задаёт новый PIN.
 */
import { createClient, type MatrixClient } from 'matrix-js-sdk';
import { changePassword, checkInvite, registerWithInvite, slugUsername } from './account';
import { loginWithPassword } from './matrix';
import { getSecurityState, KEY_MISMATCH, setupRecovery, unlockWithRecovery } from './security';
import { clearSession, type StoredSession } from './session';
import { getRealm, type Realm } from '../config';

export const PIN_MIN = 4;
export const PIN_MAX = 6;
export const PIN_HINT = `От ${PIN_MIN} до ${PIN_MAX} цифр`;
/** PIN — только цифры, от PIN_MIN до PIN_MAX. */
export const pinOk = (pin: string) => /^[0-9]+$/.test(pin) && pin.length >= PIN_MIN && pin.length <= PIN_MAX;

export interface PersonalLink {
  user: string;
  key: string;
  token: string;
  name: string;
}

export type LinkState = 'create' | 'enter' | 'invalid';

/** Ссылка (ключ) у каждого мира своя: семья — прежний ключ, Minecraft — с суффиксом. */
const savedLinkKey = (r: Realm) => (r === 'mc' ? 'rl.link.mc' : 'rl.link');
/** Логин в личной ссылке: раньше всегда с хвостом `.<12 hex>`, теперь просто `ded`, `ded2`. */
const USER_RE = /^[a-z0-9][a-z0-9._=-]{0,31}$/;
/** Старые логины со случайным хвостом: по нему одному видно, что человек входит по PIN. */
const LEGACY_PIN_RE = /^[a-z0-9][a-z0-9._=-]{0,18}\.[0-9a-f]{12}$/;
const KEY_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[A-Za-z0-9]{16}$/;

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Основа логина из имени: «Дед» → `ded`. Цифры по порядку добавляет выбор свободного логина. */
export function baseUsername(name: string): string {
  return slugUsername(name).slice(0, 24).replace(/[^a-z0-9]+$/, '') || 'user';
}

/** Пароль защищён ключом ссылки, поэтому логин может быть простым и угадываемым. */
export function newPerson(name: string, user: string): Omit<PersonalLink, 'token'> {
  return { user, key: randomHex(16), name };
}

/** Логины людей с PIN, известные админу по его списку ссылок. */
const knownPinUsers = new Set<string>();
export function rememberPinUsers(users: string[]): void {
  for (const u of users) knownPinUsers.add(u);
}

const savedLinkUser = new Map<Realm, string | null>();
function savedUser(): string | null {
  const r = getRealm();
  if (!savedLinkUser.has(r)) savedLinkUser.set(r, loadLink(r)?.user ?? null);
  return savedLinkUser.get(r) ?? null;
}

/**
 * Входит ли человек по ссылке и PIN. Старые логины узнаём по хвосту; новые (без цифр) —
 * по ссылке, сохранённой на этом устройстве (это мы сами), или по списку ссылок у админа.
 */
export function isPinUser(userId: string | null | undefined): boolean {
  if (!userId) return false;
  const local = userId.replace(/^@/, '').split(':')[0];
  return LEGACY_PIN_RE.test(local) || savedUser() === local || knownPinUsers.has(local);
}

export function isPersonalLink(value: unknown): value is PersonalLink {
  const v = value as Partial<PersonalLink> | null;
  return (
    typeof v?.user === 'string' && USER_RE.test(v.user) &&
    typeof v.key === 'string' && KEY_RE.test(v.key) &&
    typeof v.token === 'string' && TOKEN_RE.test(v.token) &&
    typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 80
  );
}

export function formatLink({ user, key, token, name }: PersonalLink): string {
  // скобки и ! мессенджеры иногда отрезают от ссылки
  const safeName = encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return `${location.origin}/#/p/${user}/${key}/${token}/${safeName}`;
}

/** Принимает и hash, и целую ссылку, вставленную в поле. */
export function parseLink(input: string): PersonalLink | null {
  const m = /#\/p\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)/.exec(input);
  if (!m) return null;
  try {
    const link = { user: m[1], key: m[2], token: m[3], name: decodeURIComponent(m[4]) };
    return isPersonalLink(link) ? link : null;
  } catch {
    return null;
  }
}

/** iOS-приложение с экрана «Домой» открывается без hash, поэтому ссылку помним на устройстве. */
export function loadLink(r: Realm = getRealm()): PersonalLink | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(savedLinkKey(r)) ?? 'null');
    return isPersonalLink(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveLink({ user, key, token, name }: PersonalLink, r: Realm = getRealm()): void {
  try {
    localStorage.setItem(savedLinkKey(r), JSON.stringify({ user, key, token, name }));
    savedLinkUser.set(r, user);
  } catch {
    console.warn('Не удалось запомнить ссылку');
  }
}

export function forgetLink(r: Realm = getRealm()): void {
  try {
    localStorage.removeItem(savedLinkKey(r));
    savedLinkUser.set(r, null);
  } catch {
    console.warn('Не удалось забыть ссылку');
  }
}

async function derive(link: PersonalLink, ...parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(['redline-pin-v1', link.key, link.user, ...parts].join('\n'));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

export const resetSecret = (link: PersonalLink) => derive(link, 'reset');

/** Ключ переписки (хранилища секретов) этой ссылки. */
export const storageSecret = (link: PersonalLink) => derive(link, 'storage');

/** Пароль Matrix для этой ссылки и PIN. */
export const pinPassword = (link: PersonalLink, pin: string) => derive(link, 'pin', pin);

/**
 * Тихое открытие старых сообщений на этом устройстве: ключ хранилища выводится из ссылки,
 * PIN для этого не нужен. Бросает, если ссылки нет или не получилось.
 */
export async function unlockSilently(client: MatrixClient): Promise<void> {
  const link = loadLink();
  const own = client.getUserId()?.replace(/^@/, '').split(':')[0];
  if (!link || link.user !== own) throw new Error('Нет ссылки на этом устройстве');
  await unlockShared(client, await derive(link, 'storage'));
}

/** Одна идущая попытка открыть историю на клиента: вход и usePinUnlock не гоняются друг с другом. */
const unlocking = new WeakMap<MatrixClient, Promise<unknown>>();

function unlockShared(client: MatrixClient, secret: string): Promise<unknown> {
  const running = unlocking.get(client);
  if (running) return running;
  const p = unlockWithRecovery(client, secret).finally(() => unlocking.delete(client));
  unlocking.set(client, p);
  return p;
}

export async function linkState(baseUrl: string, link: PersonalLink): Promise<LinkState> {
  const probe = createClient({ baseUrl });
  // логин занят — человек уже заходил по этой ссылке
  if (!(await probe.isUsernameAvailable(link.user))) return 'enter';
  return (await checkInvite(baseUrl, link.token)) ? 'create' : 'invalid';
}

export interface PinLogin {
  session: StoredSession;
  created: boolean;
  password: string;
}

/** Текст для человека, чей аккаунт удалил администратор. */
export const ACCOUNT_DELETED = 'Аккаунт удалён администратором';

export function isDeactivated(e: unknown): boolean {
  return (e as { errcode?: string } | null)?.errcode === 'M_USER_DEACTIVATED';
}

function isForbidden(e: unknown): boolean {
  return (e as { errcode?: string } | null)?.errcode === 'M_FORBIDDEN';
}

export async function loginWithPin(baseUrl: string, link: PersonalLink, pin: string, realm: Realm = getRealm()): Promise<PinLogin> {
  try {
    return await loginWithPinInner(baseUrl, link, pin, realm);
  } catch (e) {
    // удалённый аккаунт — не неверный PIN
    if (isDeactivated(e)) throw new Error(ACCOUNT_DELETED);
    throw e;
  }
}

async function loginWithPinInner(baseUrl: string, link: PersonalLink, pin: string, realm: Realm): Promise<PinLogin> {
  const password = await derive(link, 'pin', pin);
  const state = await linkState(baseUrl, link);
  if (state === 'invalid') throw new Error('Ссылка больше не действует. Попросите новую');
  if (state === 'create') {
    const session = await registerWithInvite(baseUrl, { token: link.token, username: link.user, password });
    return { session, created: true, password };
  }

  try {
    return { session: await loginWithPassword(baseUrl, link.user, password, realm), created: false, password };
  } catch (e) {
    if (!isForbidden(e)) throw e;
  }

  // PIN не подошёл: либо он неверный, либо админ его сбросил
  const temporary = await resetSecret(link);
  let session: StoredSession;
  try {
    session = await loginWithPassword(baseUrl, link.user, temporary, realm);
  } catch (e) {
    if (isForbidden(e)) throw new Error('Неверный PIN');
    throw e;
  }
  const client = createClient(session);
  try {
    await changePassword(client, temporary, password, false);
  } catch (e) {
    await client.logout(true).catch(() => console.warn('Не удалось закрыть временный сеанс'));
    clearSession(realm);
    throw e;
  }
  return { session, created: false, password };
}

/** Всё, что раньше спрашивали у человека: шифрование и история. */
export async function preparePinSession(client: MatrixClient, link: PersonalLink, login: PinLogin): Promise<void> {
  const secret = await derive(link, 'storage');
  const state = await getSecurityState(client);
  const name = login.created
    ? client.setDisplayName(link.name).catch(() => console.warn('Не удалось задать имя'))
    : Promise.resolve();
  if (state === 'needs-setup') {
    // разовая настройка должна завершиться; имя задаётся параллельно
    await Promise.all([setupRecovery(client, login.password, secret), name]);
    return;
  }
  // история открывается в фоне: чат показывается сразу, старые сообщения расшифруются по мере прихода ключей.
  // Ошибка не критична: тихая разблокировка в usePinUnlock повторит попытку и покажет баннер
  if (state === 'needs-unlock') {
    unlockShared(client, secret).catch(async (e) => {
      // История на аккаунте закрыта не ключом этой ссылки (старая фраза, ключ восстановления):
      // её не вернуть, поэтому молча заводим защиту заново. Старые сообщения останутся закрытыми.
      if ((e as Error)?.message !== KEY_MISMATCH) return console.warn('background unlock failed', e);
      try {
        await setupRecovery(client, login.password, secret);
      } catch (err) {
        console.warn('reset protection failed', err);
      }
    });
  }
  await name;
}
