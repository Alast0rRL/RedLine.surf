import { useCallback, useEffect, useRef, useState } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { isPinUser, loadLink, unlockSilently } from '../lib/pin';
import type { SecurityState } from '../lib/security';

const MAX_AUTO_ATTEMPTS = 3;
const attempts = new WeakMap<MatrixClient, number>();

/**
 * PIN вводят один раз на устройстве. После перезагрузки состояние «needs-unlock» часто временное
 * (шифрование ещё поднимается), поэтому для людей со ссылкой на устройстве открываем старые
 * сообщения молча, без выхода и без PIN. Баннер появляется, только если это не получилось.
 *
 * silent — режим «ссылка есть»; failed — тихая попытка не удалась; retry повторяет её.
 */
export function usePinUnlock(
  client: MatrixClient,
  security: SecurityState,
  refresh: () => void,
): { silent: boolean; failed: boolean; retry: () => void } {
  const silent = isPinUser(client.getUserId()) && !!loadLink();
  const [failed, setFailed] = useState(false);
  const running = useRef(false);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      await unlockSilently(client);
      setFailed(false);
    } catch (e) {
      console.warn('silent unlock failed', e);
      setFailed(true);
    } finally {
      running.current = false;
      refresh();
    }
  }, [client, refresh]);

  useEffect(() => {
    if (!silent) return;
    if (security === 'ok') {
      setFailed(false);
      return;
    }
    if (security !== 'needs-unlock' || running.current) return;
    const n = attempts.get(client) ?? 0;
    if (n >= MAX_AUTO_ATTEMPTS) {
      // попытки кончились, а ключи так и не открылись: показываем «повторить»
      setFailed(true);
      return;
    }
    attempts.set(client, n + 1);
    void run();
  }, [silent, security, client, run]);

  const retry = useCallback(() => {
    setFailed(false);
    void run();
  }, [run]);

  return { silent, failed, retry };
}
