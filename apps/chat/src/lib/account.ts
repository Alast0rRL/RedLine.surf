import { createClient, type MatrixClient } from 'matrix-js-sdk';
import { deviceName } from './matrix';
import { saveSession, type StoredSession } from './session';

const TOKEN_STAGE = 'm.login.registration_token';
export const MIN_PASSWORD = 8;

interface Failure {
  errcode?: string;
  httpStatus?: number;
  message?: string;
  session?: string;
  flows?: { stages?: string[] }[];
  data?: {
    error?: string;
    httpStatus?: number;
    session?: string;
    flows?: { stages?: string[] }[];
  };
}

function failure(e: unknown): Failure {
  return (e ?? {}) as Failure;
}

function statusOf(err: Failure): number | undefined {
  return err.httpStatus ?? err.data?.httpStatus;
}

function sessionOf(err: Failure): string | undefined {
  return err.data?.session ?? err.session;
}

function flowsOf(err: Failure): { stages?: string[] }[] | undefined {
  return err.data?.flows ?? err.flows;
}

function messageOf(e: unknown, fallback: string): string {
  const err = failure(e);
  console.warn('Ответ сервера:', err.data?.error || err.message);
  return fallback;
}

/** Имя из дисплейного имени: кириллица → латиница, всё лишнее выкидываем. */
export function slugUsername(displayName: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  return displayName
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[а-яё]/g, (ch) => map[ch] ?? ch)
    .replace(/[^a-z0-9._=-]/g, '')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 32)
    .replace(/[^a-z0-9]+$/g, '');
}

export function passwordProblem(v: string): string | null {
  if (v.length < MIN_PASSWORD) return `Пароль слишком короткий: нужно хотя бы ${MIN_PASSWORD} символов`;
  return null;
}

/** Сетевая ошибка или HTTP 5xx — это не «приглашение недействительно». */
export async function checkInvite(baseUrl: string, token: string): Promise<boolean> {
  const url = `${baseUrl}/_matrix/client/v1/register/m.login.registration_token/validity?token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз');
  const data = (await res.json()) as { valid?: unknown };
  return data.valid === true;
}

/** Регистрация по одноразовому токену: результат сохраняется как обычная сессия. */
export async function registerWithInvite(
  baseUrl: string,
  { token, username, password }: { token: string; username: string; password: string },
): Promise<StoredSession> {
  const invalidInvite = () => new Error('Приглашение уже использовано или отозвано. Попросите новое');
  if (!(await checkInvite(baseUrl, token))) throw invalidInvite();

  const client = createClient({ baseUrl });
  try {
    if (!(await client.isUsernameAvailable(username))) throw new Error('Этот логин уже занят. Выберите другой');
  } catch (e) {
    if (failure(e).errcode === 'M_INVALID_USERNAME') throw new Error('Такой логин не подходит. Используйте латинские буквы и цифры');
    throw e;
  }

  let session: string;
  try {
    await client.registerRequest({ username, password });
    throw new Error('Не получилось зарегистрироваться. Попробуйте ещё раз чуть позже');
  } catch (e) {
    const err = failure(e);
    if (statusOf(err) === 403) throw invalidInvite();
    const flow = flowsOf(err)?.some((f) => f.stages?.length === 1 && f.stages[0] === TOKEN_STAGE);
    const uiaSession = sessionOf(err);
    if (statusOf(err) !== 401 || typeof uiaSession !== 'string' || !flow) throw e;
    session = uiaSession;
  }

  let result;
  try {
    result = await client.registerRequest({
      username,
      password,
      auth: { type: TOKEN_STAGE, token, session },
      initial_device_display_name: deviceName(),
    });
  } catch (e) {
    const err = failure(e);
    // токен списан до проверки имени: логин заняли между проверкой и регистрацией
    if (err.errcode === 'M_USER_IN_USE') throw new Error('Логин только что заняли. Попросите новое приглашение');
    if (err.errcode === 'M_INVALID_USERNAME') throw new Error('Такой логин не подходит. Используйте латинские буквы и цифры');
    if (statusOf(err) === 401 || statusOf(err) === 403 || err.errcode === 'M_FORBIDDEN' || /token/i.test(err.errcode ?? '')) {
      throw invalidInvite();
    }
    throw new Error(messageOf(e, 'Не получилось зарегистрироваться. Попробуйте ещё раз'));
  }
  if (!result.access_token || !result.device_id) throw new Error('Не получилось зарегистрироваться. Попробуйте ещё раз');

  const saved: StoredSession = {
    baseUrl,
    userId: result.user_id,
    deviceId: result.device_id,
    accessToken: result.access_token,
  };
  saveSession(saved);
  return saved;
}

/** Смена пароля через UIA: первый запрос ожидаемо вернёт 401 с session. */
export async function changePassword(
  client: MatrixClient,
  current: string,
  next: string,
  logoutOthers: boolean,
): Promise<void> {
  const userId = client.getUserId();
  if (!userId) throw new Error('Не получилось определить, кто вы. Выйдите и войдите заново');

  let session: string;
  try {
    await client.setPassword(undefined as never, next, logoutOthers);
    throw new Error('Не получилось сменить пароль. Попробуйте ещё раз');
  } catch (e) {
    const err = failure(e);
    const uiaSession = sessionOf(err);
    if (statusOf(err) !== 401 || typeof uiaSession !== 'string') throw e;
    session = uiaSession;
  }

  try {
    await client.setPassword(
      {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: userId },
        password: current,
        session,
      },
      next,
      logoutOthers,
    );
  } catch (e) {
    const err = failure(e);
    if (statusOf(err) === 401 || statusOf(err) === 403) throw new Error('Текущий пароль не подошёл. Проверьте, нет ли опечаток');
    throw e;
  }
}

/**
 * Текст ошибки для человека: наши русские сообщения показываем как есть,
 * сетевые сбои и английские ответы сервера заменяем понятной фразой.
 */
export function friendlyError(e: unknown, fallback: string): string {
  const err = e as { name?: string; message?: string } | null;
  const message = err?.message ?? '';
  if (/[А-Яа-яЁё]/.test(message)) return message;
  if (message) console.warn('Ошибка:', e);
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (offline || err?.name === 'ConnectionError' || /network|fetch|failed to|timeout|ECONN/i.test(message)) {
    return 'Нет связи. Проверьте интернет и попробуйте ещё раз';
  }
  return fallback;
}
