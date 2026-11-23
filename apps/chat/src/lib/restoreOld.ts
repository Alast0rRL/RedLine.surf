/**
 * Старые сообщения, закрытые прежней фразой или номером (до перехода на номер и PIN):
 * один раз открываем их старым секретом и сразу переводим хранилище на личный ключ.
 * Дальше они открываются сами по номеру и PIN.
 */
import type { MatrixClient } from 'matrix-js-sdk';
import { normalizePhone } from './phone';
import { loadLink, storageSecret } from './pin';
import { changeRecoveryPhrase, unlockWithRecovery } from './security';

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
  if (imported === null) throw new Error('Не подошло. Введите номер или фразу, которые указывали раньше');

  await changeRecoveryPhrase(client, await storageSecret(link));
  return imported;
}
