import type { MatrixClient } from 'matrix-js-sdk';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { cacheSecretStorageKey, setPendingNewSecretStorageKey } from './matrix';

/**
 * E2E-безопасность аккаунта:
 *  - needs-setup  — на аккаунте ещё нет ключа восстановления (первый вход вообще)
 *  - needs-unlock — ключ есть, но это устройство не подтверждено: история не расшифруется
 *  - ok           — устройство подтверждено, резервная копия ключей включена
 */
export type SecurityState = 'checking' | 'needs-setup' | 'needs-unlock' | 'ok' | 'unavailable';

export async function getSecurityState(client: MatrixClient): Promise<SecurityState> {
  const crypto = client.getCrypto();
  if (!crypto) return 'unavailable';
  const hasCrossSigning = await crypto.userHasCrossSigningKeys(client.getUserId()!, true);
  const has4S = await client.secretStorage.hasKey();
  if (!hasCrossSigning || !has4S) return 'needs-setup';
  const status = await crypto.getDeviceVerificationStatus(client.getUserId()!, client.getDeviceId()!);
  return status?.crossSigningVerified ? 'ok' : 'needs-unlock';
}

/**
 * Первое устройство: создаёт cross-signing, хранилище секретов и резервную копию ключей.
 * Возвращает ключ восстановления — его нужно показать и попросить сохранить.
 * Сервер для загрузки ключей подписи просит пароль (UIA).
 */
export async function setupRecovery(client: MatrixClient, password: string): Promise<string> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error('Шифрование недоступно');
  const userId = client.getUserId()!;

  await crypto.bootstrapCrossSigning({
    setupNewCrossSigning: true,
    authUploadDeviceSigningKeys: async (makeRequest) => {
      await makeRequest({ type: 'm.login.password', identifier: { type: 'm.id.user', user: userId }, password });
    },
  });

  const recovery = await crypto.createRecoveryKeyFromPassphrase();
  setPendingNewSecretStorageKey(recovery.privateKey);
  try {
    await crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => recovery,
      setupNewSecretStorage: true,
      setupNewKeyBackup: true,
    });
  } finally {
    setPendingNewSecretStorageKey(null);
  }
  if (!recovery.encodedPrivateKey) throw new Error('Не удалось получить ключ восстановления');
  return recovery.encodedPrivateKey;
}

/**
 * Новое устройство: ключ восстановления → подтверждаем устройство и
 * подтягиваем ключи старых сообщений из резервной копии.
 */
export async function unlockWithRecoveryKey(client: MatrixClient, input: string): Promise<{ imported: number }> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error('Шифрование недоступно');

  let key: Uint8Array<ArrayBuffer>;
  try {
    key = decodeRecoveryKey(input.trim());
  } catch {
    throw new Error('Это не похоже на ключ восстановления');
  }
  const keyId = await client.secretStorage.getDefaultKeyId();
  if (!keyId) throw new Error('На аккаунте нет хранилища ключей');
  const keyInfo = await client.secretStorage.getKey(keyId);
  if (!keyInfo || !(await client.secretStorage.checkKey(key, keyInfo[1]))) {
    throw new Error('Неверный ключ восстановления');
  }
  cacheSecretStorageKey(keyId, key);

  // заберёт ключи cross-signing из хранилища и подпишет это устройство
  await crypto.bootstrapCrossSigning({});
  await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
  await crypto.checkKeyBackupAndEnable();
  const res = await crypto.restoreKeyBackup();
  return { imported: res.imported };
}
