/**
 * Вход по номеру телефона и PIN (без SMS).
 *
 * Номер и PIN остаются на устройстве: серверу уходят номер (для поиска записи) и proof =
 * PBKDF2(PIN, соль из номера). Личный ключ сервер хранит зашифрованным ключом из proof.
 */
import { createClient } from 'matrix-js-sdk';
import { getRealm, loadConfig, realmConfig, type Realm } from '../config';
import { changePassword } from './account';
import { ACCOUNT_DELETED, isPersonalLink, newPerson, pinPassword, type PersonalLink, type PinLogin } from './pin';
import { loginWithPassword } from './matrix';

const PROOF_SALT = 'redline-phone-v1\n';
const LOGIN_SALT = 'redline-login-v1\n';
const PROOF_ITERATIONS = 200_000;
/** Токен регистрации после входа по номеру не нужен: аккаунт уже существует. */
export const NO_TOKEN = 'PhoneLogin000000';

export function normalizePhone(input: string): string | null {
  let d = input.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = `7${d.slice(1)}`;
  else if (d.length === 10) d = `7${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

/** Ник Minecraft как логин: латиница, цифры, _, 3–16 символов; в аккаунте — строчными. */
export function normalizeLogin(input: string): string | null {
  const v = input.trim();
  return /^[A-Za-z0-9_]{3,16}$/.test(v) ? v.toLowerCase() : null;
}

export function normalizeFamilyLogin(input: string): string | null {
  const v = input.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._=-]{0,31}$/.test(v) ? v : null;
}

/** Номер (семья) или ник (Minecraft) — в зависимости от текущего мира. */
function normalizeId(input: string, r: Realm = getRealm()): string | null {
  return r === 'mc' ? normalizeLogin(input) : normalizePhone(input);
}

function idBody(id: string, r: Realm = getRealm()): Record<string, string> {
  return r === 'mc' ? { login: id } : { phone: id };
}

export function maskPhone(phone: string): string {
  if (phone.length === 11 && phone[0] === '7') return `+7 *** ***-**-${phone.slice(-2)}`;
  return `+${'*'.repeat(Math.max(phone.length - 2, 0))}${phone.slice(-2)}`;
}

export async function phoneProof(phone: string, pin: string, r: Realm = getRealm()): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode((r === 'mc' ? LOGIN_SALT : PROOF_SALT) + phone), iterations: PROOF_ITERATIONS },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function api<T>(method: string, path: string, body?: unknown, token?: string, r: Realm = getRealm()): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${r === 'mc' ? '/mc' : ''}/api/phone/${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Нет связи с сервером');
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error || 'Не удалось выполнить запрос');
  return data;
}

/** Свой у каждого мира: в семье номер, в Minecraft ник. */
const savedPhoneKey = (r: Realm = getRealm()) => (r === 'mc' ? 'rl.phone.mc' : 'rl.phone');

/** Номер, привязанный с этого устройства: нужен, чтобы после смены PIN обновить привязку без вопросов. */
export function savedPhone(user: string): string | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(savedPhoneKey()) ?? 'null');
    if (v && typeof v === 'object' && (v as { user?: unknown }).user === user) {
      const phone = (v as { phone?: unknown }).phone;
      return typeof phone === 'string' ? phone : null;
    }
  } catch { /* нет доступа к хранилищу */ }
  return null;
}
function rememberPhone(user: string, phone: string | null, r: Realm = getRealm()): void {
  try {
    if (phone) localStorage.setItem(savedPhoneKey(r), JSON.stringify({ user, phone }));
    else localStorage.removeItem(savedPhoneKey(r));
  } catch { /* приватный режим */ }
}

/** Второй аккаунт того же человека: ключ и PIN общие, отличается логин и сервер. */
export interface LinkedAccount {
  realm: Realm;
  user: string;
}

/** Ссылка человека по номеру (нику) и PIN; дальше вход идёт как по обычной ссылке. */
export async function fetchLinkByPhone(
  phoneInput: string,
  pin: string,
  realm: Realm = getRealm(),
): Promise<PersonalLink & { linked?: LinkedAccount }> {
  const phone = normalizeId(phoneInput, realm);
  if (!phone) throw new Error(realm === 'mc' ? 'Проверьте ник' : 'Проверьте номер');
  const familyLogin = realm === 'family' && !normalizePhone(phoneInput) ? normalizeFamilyLogin(phoneInput) : null;
  const id = familyLogin ?? phone;
  const r = await api<{ user: string; key: string; name?: string; linked?: LinkedAccount }>(
    'POST',
    'login',
    { ...(familyLogin ? { login: familyLogin } : idBody(id, realm)), proof: await phoneProof(id, pin, realm) },
    undefined,
    realm,
  );
  const link = { user: r.user, key: r.key, token: NO_TOKEN, name: r.name || 'Участник' };
  if (!isPersonalLink(link)) throw new Error('Не удалось войти по номеру');
  rememberPhone(link.user, phone, realm);
  const linked = r.linked && (r.linked.realm === 'mc' || r.linked.realm === 'family') && typeof r.linked.user === 'string'
    ? { realm: r.linked.realm, user: r.linked.user }
    : undefined;
  return linked ? { ...link, linked } : link;
}

export async function getBoundPhone(token: string): Promise<string | null> {
  return (await api<{ mask: string | null }>('GET', 'bind', undefined, token)).mask;
}

/** Привязка и связь с Minecraft текущего аккаунта семьи. */
export interface BindStatus {
  mask: string | null;
  mc: string | null;
  mcAllowed: boolean;
}

export async function getBindStatus(token: string): Promise<BindStatus> {
  const r = await api<Partial<BindStatus>>('GET', 'bind', undefined, token, 'family');
  return { mask: r.mask ?? null, mc: r.mc ?? null, mcAllowed: !!r.mcAllowed };
}

/** Логин связанного аккаунта во втором мире (по сеансу этого мира), если связка есть. */
export async function getLinkedUser(token: string, realm: Realm): Promise<string | null> {
  const r = await api<{ mc?: string | null; family?: string | null }>('GET', 'bind', undefined, token, realm);
  const u = realm === 'mc' ? r.family : r.mc;
  return typeof u === 'string' && u ? u : null;
}

export async function bindInvitedLogin(token: string, login: string, link: PersonalLink, pin: string): Promise<void> {
  await api(
    'PUT',
    'bind',
    { login, proof: await phoneProof(login, pin, 'family'), key: link.key, name: link.name },
    token,
    'family',
  );
}

export async function bindPhone(token: string, link: PersonalLink, phoneInput: string, pin: string): Promise<string> {
  const phone = normalizeId(phoneInput);
  if (!phone) throw new Error(getRealm() === 'mc' ? 'Проверьте ник' : 'Проверьте номер');
  const r = await api<{ mask: string }>(
    'PUT',
    'bind',
    { ...idBody(phone), proof: await phoneProof(phone, pin), key: link.key, name: link.name },
    token,
  );
  rememberPhone(link.user, phone);
  return r.mask;
}

export async function unbindPhone(token: string): Promise<void> {
  await api('DELETE', 'bind', undefined, token);
  localStorage.removeItem(savedPhoneKey());
}

/** Администратор снимает привязку номера удалённого человека. */
export async function adminUnbindPhone(token: string, mxid: string): Promise<boolean> {
  const r = await api<{ removed: boolean }>('DELETE', `user/${encodeURIComponent(mxid)}`, undefined, token);
  return r.removed;
}

/** Проверка PIN: заходим с выведенным паролем и сразу закрываем этот лишний сеанс. */
export async function verifyPin(link: PersonalLink, pin: string): Promise<void> {
  await checkPassword(link.user, await pinPassword(link, pin), 'Неверный PIN');
}

/** Подходит ли пароль: пробный вход и сразу выход. Неверный пароль — ошибка с текстом wrong. */
export async function checkPassword(user: string, password: string, wrong: string): Promise<void> {
  const { homeserverUrl } = await loadConfig();
  const base = homeserverUrl.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password,
        initial_device_display_name: 'Redline: проверка входа',
      }),
    });
  } catch {
    throw new Error('Нет связи с сервером');
  }
  if (res.status === 403) {
    const err = (await res.json().catch(() => null)) as { errcode?: string } | null;
    throw new Error(err?.errcode === 'M_USER_DEACTIVATED' ? ACCOUNT_DELETED : wrong);
  }
  if (res.status === 429) {
    const lim = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(lim?.error || 'Слишком много попыток входа. Попробуйте позже.');
  }
  const data = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!res.ok || !data?.access_token) throw new Error('Не удалось проверить вход');
  await fetch(`${base}/_matrix/client/v3/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${data.access_token}`, 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => console.warn('Не удалось закрыть проверочный сеанс'));
}

/**
 * Регистрация игрока Minecraft: ник = логин. Ключ и пароль считаются здесь, аккаунт создаёт сервер
 * (секрет регистрации туда не уходит). Дальше вход идёт как по обычной ссылке.
 */
export async function registerPlayer(nickInput: string, pin: string): Promise<PersonalLink> {
  if (getRealm() !== 'mc') throw new Error('Регистрация доступна только для Minecraft');
  const nick = nickInput.trim();
  const login = normalizeLogin(nick);
  if (!login) throw new Error('Ник: латиница, цифры и _, от 3 до 16 символов');
  const link: PersonalLink = { ...newPerson(nick, login), token: NO_TOKEN };
  await api('POST', 'register', {
    login,
    name: nick,
    password: await pinPassword(link, pin),
    proof: await phoneProof(login, pin),
    key: link.key,
  });
  rememberPhone(login, login);
  return link;
}

/** Ник занят, а PIN от него не дали: экрану надо спросить его. */
export const NEED_NICK_PIN = 'NEED_NICK_PIN';

/**
 * Подключить ник Minecraft к аккаунту семьи. Ник переходит на ключ и PIN семьи: дальше один вход
 * открывает оба мира. Новый ник регистрируется, занятый — по его старому PIN (nickPin).
 * Возвращает ссылку и вход в Minecraft — их хватает, чтобы сразу открыть второй мир.
 */
export async function linkMinecraft(
  token: string,
  family: PersonalLink,
  nickInput: string,
  pin: string,
  nickPin?: string,
): Promise<{ link: PersonalLink; login: PinLogin }> {
  const nick = nickInput.trim();
  const login = normalizeLogin(nick);
  if (!login) throw new Error('Ник: латиница, цифры и _, от 3 до 16 символов');
  if (!(await getBindStatus(token)).mcAllowed) throw new Error('Minecraft вам не открыт: попросите админа');
  await verifyPin(family, pin);
  const base = realmConfig('mc').homeserverUrl;
  const proof = await phoneProof(login, pin, 'mc');
  let link: PersonalLink = { user: login, key: family.key, token: NO_TOKEN, name: nick };
  const password = await pinPassword(link, pin);
  let oldProof = proof;
  let revert: (() => Promise<void>) | null = null;
  let created = false;

  if (await createClient({ baseUrl: base }).isUsernameAvailable(login)) {
    await api('POST', 'register', { login, name: nick, password, proof, key: family.key }, undefined, 'mc');
    created = true;
  } else {
    if (!nickPin) throw new Error(NEED_NICK_PIN);
    oldProof = await phoneProof(login, nickPin, 'mc');
    const old = await api<{ user: string; key: string; name?: string }>('POST', 'login', { login, proof: oldProof }, undefined, 'mc');
    const oldLink: PersonalLink = { user: old.user, key: old.key, token: NO_TOKEN, name: old.name || nick };
    link = { ...link, name: oldLink.name };
    const oldPassword = await pinPassword(oldLink, nickPin);
    if (oldPassword !== password) {
      // пароль Matrix меняем сами (нужен старый), временный сеанс сразу закрываем
      const tmp = createClient({ baseUrl: base });
      const res = await tmp.loginRequest({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: login },
        password: oldPassword,
        initial_device_display_name: 'Redline: связка аккаунтов',
      });
      const c = createClient({ baseUrl: base, accessToken: res.access_token, userId: res.user_id, deviceId: res.device_id });
      try {
        await changePassword(c, oldPassword, password, false);
      } finally {
        await c.logout(true).catch(() => undefined);
      }
      revert = async () => {
        const back = createClient({ baseUrl: base });
        const r2 = await back.loginRequest({ type: 'm.login.password', identifier: { type: 'm.id.user', user: login }, password });
        const c2 = createClient({ baseUrl: base, accessToken: r2.access_token, userId: r2.user_id, deviceId: r2.device_id });
        try {
          await changePassword(c2, password, oldPassword, false);
        } finally {
          await c2.logout(true).catch(() => undefined);
        }
      };
    }
  }

  try {
    await api('PUT', 'link', { login, oldProof, proof, key: family.key }, token, 'family');
  } catch (e) {
    if (revert) await revert().catch(() => console.warn('Не удалось вернуть пароль ника'));
    throw e;
  }
  rememberPhone(login, login, 'mc');
  const session = await loginWithPassword(base, login, password, 'mc');
  return { link, login: { session, created, password } };
}

export async function unlinkMinecraft(token: string): Promise<void> {
  await api('DELETE', 'link', undefined, token, 'family');
}

/** Админ: у кого открыт Minecraft и какой ник подключён (по логину семьи). */
export async function getRoles(token: string): Promise<Map<string, { mc: string | null; mcAllowed: boolean }>> {
  const r = await api<{ users: Array<{ user: string; mc: string | null; mcAllowed: boolean }> }>('GET', 'roles', undefined, token, 'family');
  return new Map(r.users.map((u) => [u.user, { mc: u.mc, mcAllowed: u.mcAllowed }]));
}

export async function setMcRole(token: string, user: string, on: boolean): Promise<{ mc: string | null; mcAllowed: boolean }> {
  return api('PUT', 'roles', { user, mc: on }, token, 'family');
}
