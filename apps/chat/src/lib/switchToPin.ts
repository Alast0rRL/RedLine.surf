/**
 * Переход с пароля на вход по номеру и PIN (как у всех остальных).
 *
 * После перехода у человека нет ни пароля, ни секретной фразы: случайный ключ переписки
 * лежит на сервере зашифрованным и выдаётся только по номеру и PIN.
 *  1. новый личный ключ (как у ссылки) — помним его до конца перехода, чтобы повтор шёл с тем же;
 *  2. проверяем текущий пароль (или что пароль уже сменён прошлой попыткой);
 *  3. привязываем номер: сервер хранит ключ, зашифрованный номером и PIN;
 *  4. ключ переписки переводим на личный ключ (старая фраза перестаёт работать);
 *  5. пароль Matrix меняем на выведенный из ключа и PIN.
 */
import type { MatrixClient } from 'matrix-js-sdk';
import { changePassword } from './account';
import { bindPhone, checkPassword, NO_TOKEN, normalizePhone } from './phone';
import { newPerson, pinPassword, saveLink, storageSecret, type PersonalLink, isPersonalLink, PIN_LENGTH } from './pin';
import { changeRecoveryPhrase, getSecurityState, setupRecovery } from './security';

const PENDING = 'rl.pendingLink';

function loadPending(user: string): PersonalLink | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PENDING) ?? 'null');
    return isPersonalLink(v) && v.user === user ? v : null;
  } catch {
    return null;
  }
}

function savePending(link: PersonalLink | null): void {
  try {
    if (link) localStorage.setItem(PENDING, JSON.stringify(link));
    else localStorage.removeItem(PENDING);
  } catch {
    /* приватный режим: повтор начнётся с нового ключа */
  }
}

export async function switchToPin(
  client: MatrixClient,
  { password, phone, pin }: { password: string; phone: string; pin: string },
): Promise<void> {
  if (!normalizePhone(phone)) throw new Error('Проверьте номер');
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) throw new Error(`PIN — ровно ${PIN_LENGTH} цифр`);
  const userId = client.getUserId()!;
  const own = userId.replace(/^@/, '').split(':')[0];
  const name = client.getUser(userId)?.displayName || own;
  const token = client.getAccessToken();
  if (!token) throw new Error('Нужно войти заново');

  const state = await getSecurityState(client);
  if (state === 'unavailable') throw new Error('Защита переписки не работает в этом браузере. Откройте Redline в Chrome или Safari');

  const pending = loadPending(own);
  const link: PersonalLink = pending ?? { ...newPerson(name, own), token: NO_TOKEN };
  savePending(link);
  const newPassword = await pinPassword(link, pin);

  // прошлая попытка могла уже сменить пароль — тогда старый пароль не подойдёт, и это нормально
  let switched = false;
  if (pending) {
    switched = await checkPassword(own, newPassword, 'x').then(() => true, () => false);
  }
  if (!switched) await checkPassword(own, password, 'Пароль не подошёл');

  await bindPhone(token, link, phone, pin);

  const secret = await storageSecret(link);
  const current = switched ? newPassword : password;
  if (state === 'ok') await changeRecoveryPhrase(client, secret);
  else await setupRecovery(client, current, secret); // старые сообщения на аккаунте сбрасываются

  if (!switched) await changePassword(client, password, newPassword, false);

  // Метка старой «фразы-номера» больше не нужна
  await client.setAccountData('surf.redline.recovery' as never, {} as never).catch(() => undefined);
  saveLink(link);
  savePending(null);
}
