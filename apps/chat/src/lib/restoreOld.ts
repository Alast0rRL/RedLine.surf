/**
 * Старые сообщения, закрытые прежней фразой или номером (до перехода на номер и PIN):
 * один раз открываем их старым секретом и сразу переводим хранилище на личный ключ.
 * Дальше они открываются сами по номеру и PIN.
 */
import type { MatrixClient } from 'matrix-js-sdk';
import { normalizePhone } from './phone';
import { loadLink, pinPassword, storageSecret } from './pin';
import { changeRecoveryPhrase, setupRecovery, unlockWithRecovery } from './security';

export async function restoreWithOldSecret(client: MatrixClient, input: string): Promise<number> {
  const link = loadLink();
  const own = client.getUserId()?.replace(/^@/, '').split(':')[0];
  if (!link || link.user !== own) throw new Error('Войдите заново по номеру и PIN');
  const raw = input.trim();
  if (!raw) throw new Error('Введите старый номер или фразу');

  // раньше фразой был номер в виде цифр (79001234567); ещё раньше — произвольная фраза
  const tries = [...new Set([normalizePhone(raw), raw].filter((v): v is string => !!v))];
  let imported: number | null = null;
  for (const t of tries) {
    try {
      imported = (await unlockWithRecovery(client, t)).imported;
      break;
    } catch {
      /* пробуем следующий вариант */
    }
  }
  if (imported === null) throw new Error('Не подошло');

  await changeRecoveryPhrase(client, await storageSecret(link));
  return imported;
}

export interface OldHistoryInfo {
  /** Ключ хранилища сделан из фразы/номера (иначе это длинный ключ восстановления). */
  byPhrase: boolean;
  /** Сколько ключей сообщений лежит в копии на сервере (0 — восстанавливать нечего). */
  backupKeys: number;
}

export async function getOldHistoryInfo(client: MatrixClient): Promise<OldHistoryInfo> {
  const keyId = await client.secretStorage.getDefaultKeyId();
  const stored = keyId ? await client.secretStorage.getKey(keyId) : null;
  const info = await client.getCrypto()?.getKeyBackupInfo();
  return {
    byPhrase: !!stored?.[1].passphrase,
    backupKeys: typeof info?.count === 'number' ? info.count : 0,
  };
}

/**
 * Старые сообщения не вернуть: заводим защиту заново на личном ключе.
 * Новые сообщения будут сохраняться и открываться по номеру и PIN. PIN нужен серверу для подтверждения.
 */
export async function resetHistoryProtection(client: MatrixClient, pin: string): Promise<void> {
  const link = loadLink();
  const own = client.getUserId()?.replace(/^@/, '').split(':')[0];
  if (!link || link.user !== own) throw new Error('Войдите заново по номеру и PIN');
  try {
    await setupRecovery(client, await pinPassword(link, pin), await storageSecret(link));
  } catch (e) {
    if ((e as { errcode?: string })?.errcode === 'M_FORBIDDEN') throw new Error('Неверный PIN');
    throw e;
  }
}
