/**
 * Вход по номеру телефона и PIN (без SMS).
 *
 * Номер и PIN остаются на устройстве: серверу уходят номер (для поиска записи) и proof =
 * PBKDF2(PIN, соль из номера). Личный ключ сервер хранит зашифрованным ключом из proof.
 */
import { loadConfig } from '../config';
import { isPersonalLink, pinPassword, type PersonalLink } from './pin';

const PROOF_SALT = 'redline-phone-v1\n';
const PROOF_ITERATIONS = 200_000;
/** Токен регистрации после входа по номеру не нужен: аккаунт уже существует. */
const NO_TOKEN = 'PhoneLogin000000';

export function normalizePhone(input: string): string | null {
  let d = input.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = `7${d.slice(1)}`;
  else if (d.length === 10) d = `7${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

export function maskPhone(phone: string): string {
  if (phone.length === 11 && phone[0] === '7') return `+7 *** ***-**-${phone.slice(-2)}`;
  return `+${'*'.repeat(Math.max(phone.length - 2, 0))}${phone.slice(-2)}`;
}

export async function phoneProof(phone: string, pin: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(PROOF_SALT + phone), iterations: PROOF_ITERATIONS },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function api<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/phone/${path}`, {
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

const SAVED_PHONE = 'rl.phone';

/** Номер, привязанный с этого устройства: нужен, чтобы после смены PIN обновить привязку без вопросов. */
export function savedPhone(user: string): string | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SAVED_PHONE) ?? 'null');
    if (v && typeof v === 'object' && (v as { user?: unknown }).user === user) {
      const phone = (v as { phone?: unknown }).phone;
      return typeof phone === 'string' ? phone : null;
    }
  } catch { /* нет доступа к хранилищу */ }
  return null;
}
function rememberPhone(user: string, phone: string | null): void {
  try {
    if (phone) localStorage.setItem(SAVED_PHONE, JSON.stringify({ user, phone }));
    else localStorage.removeItem(SAVED_PHONE);
  } catch { /* приватный режим */ }
}

/** Ссылка человека по номеру и PIN; дальше вход идёт как по обычной ссылке. */
export async function fetchLinkByPhone(phoneInput: string, pin: string): Promise<PersonalLink> {
  const phone = normalizePhone(phoneInput);
  if (!phone) throw new Error('Проверьте номер');
  const r = await api<{ user: string; key: string; name?: string }>('POST', 'login', {
    phone,
    proof: await phoneProof(phone, pin),
  });
  const link = { user: r.user, key: r.key, token: NO_TOKEN, name: r.name || 'Участник' };
  if (!isPersonalLink(link)) throw new Error('Не удалось войти по номеру');
  rememberPhone(link.user, phone);
  return link;
}

export async function getBoundPhone(token: string): Promise<string | null> {
  return (await api<{ mask: string | null }>('GET', 'bind', undefined, token)).mask;
}

export async function bindPhone(token: string, link: PersonalLink, phoneInput: string, pin: string): Promise<string> {
  const phone = normalizePhone(phoneInput);
  if (!phone) throw new Error('Проверьте номер');
  const r = await api<{ mask: string }>(
    'PUT',
    'bind',
    { phone, proof: await phoneProof(phone, pin), key: link.key, name: link.name },
    token,
  );
  rememberPhone(link.user, phone);
  return r.mask;
}

export async function unbindPhone(token: string): Promise<void> {
  await api('DELETE', 'bind', undefined, token);
  localStorage.removeItem(SAVED_PHONE);
}

/** Проверка PIN: заходим с выведенным паролем и сразу закрываем этот лишний сеанс. */
export async function verifyPin(link: PersonalLink, pin: string): Promise<void> {
  const { homeserverUrl } = await loadConfig();
  const base = homeserverUrl.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: link.user },
        password: await pinPassword(link, pin),
        initial_device_display_name: 'Redline: проверка PIN',
      }),
    });
  } catch {
    throw new Error('Нет связи с сервером');
  }
  if (res.status === 403) throw new Error('Неверный PIN');
  if (res.status === 429) throw new Error('Слишком много попыток. Подождите немного');
  const data = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!res.ok || !data?.access_token) throw new Error('Не удалось проверить PIN');
  await fetch(`${base}/_matrix/client/v3/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${data.access_token}`, 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => console.warn('Не удалось закрыть проверочный сеанс'));
}
