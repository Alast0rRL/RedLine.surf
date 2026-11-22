import { useCallback, useEffect, useState } from 'react';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api/index.js';
import type { MatrixClient } from 'matrix-js-sdk';
import { getSecurityState, type SecurityState } from '../lib/security';

/*
 * Общее состояние на все экраны: проверка ходит в /keys/query, незачем
 * повторять её при каждом монтировании (список + настройки).
 */
let lastClient: MatrixClient | null = null;
let lastState: SecurityState = 'checking';
let inflight: Promise<SecurityState> | null = null;
const listeners = new Set<(s: SecurityState) => void>();

function check(client: MatrixClient, force: boolean): void {
  if (client !== lastClient) {
    lastClient = client;
    lastState = 'checking';
    inflight = null;
  }
  if (inflight && !force) return;
  const p = getSecurityState(client).catch((e) => {
    console.warn('security state check failed', e);
    return 'unavailable' as const;
  });
  inflight = p;
  void p.then((s) => {
    if (inflight !== p || lastClient !== client) return; // устаревший ответ
    lastState = s;
    listeners.forEach((l) => l(s));
  });
}

export function useSecurityState(client: MatrixClient): [SecurityState, () => void] {
  const [state, setState] = useState<SecurityState>(() => (client === lastClient ? lastState : 'checking'));

  const refresh = useCallback(() => check(client, true), [client]);

  useEffect(() => {
    listeners.add(setState);
    if (client !== lastClient || lastState === 'checking') check(client, false);
    else setState(lastState);
    const events = [CryptoEvent.KeysChanged, CryptoEvent.UserTrustStatusChanged, CryptoEvent.DevicesUpdated, CryptoEvent.KeyBackupStatus];
    events.forEach((e) => client.on(e as never, refresh as never));
    return () => {
      listeners.delete(setState);
      events.forEach((e) => client.off(e as never, refresh as never));
    };
  }, [client, refresh]);

  return [state, refresh];
}
