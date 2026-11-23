import type { MatrixClient } from 'matrix-js-sdk';
import { decodeRecoveryKey, deriveRecoveryKeyFromPassphrase } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { cacheSecretStorageKey, setPendingNewSecretStorageKey } from './matrix';

export const MIN_PHRASE = 8;

/**
 * E2E-безопасность аккаунта:
 *  - needs-setup  — на аккаунте ещё нет ключа восстановления (первый вход вообще)
 *  - needs-unlock — ключ есть, но это устройство не подтверждено: история не расшифруется
 *  - ok           — устройство подтверждено, резервная копия ключей включена
 */
export type SecurityState = 'checking' | 'needs-setup' | 'needs-unlock' | 'ok' | 'unavailable';

export function normalizePhrase(s: string): string {
  return s.normalize('NFC').trim().replace(/\s+/g, ' ');
}

export function phraseProblem(phrase: string, password?: string): string | null {
  const value = normalizePhrase(phrase);
  if (value.length < MIN_PHRASE) return `Фраза короче ${MIN_PHRASE} символов`;
  if (/^(.)\1*$/.test(value)) return 'Фраза не должна состоять из одного символа';
  if (password && value === normalizePhrase(password)) return 'Фраза должна отличаться от пароля';
  return null;
}

export async function getSecurityState(client: MatrixClient): Promise<SecurityState> {
  const crypto = client.getCrypto();
  if (!crypto) return 'unavailable';
  const [hasCrossSigning, has4S] = await Promise.all([
    crypto.userHasCrossSigningKeys(client.getUserId()!, true),
    client.secretStorage.hasKey(),
  ]);
  if (!hasCrossSigning || !has4S) return 'needs-setup';
  const status = await crypto.getDeviceVerificationStatus(client.getUserId()!, client.getDeviceId()!);
  return status?.crossSigningVerified ? 'ok' : 'needs-unlock';
}

/**
 * Первое устройство: создаёт cross-signing, хранилище секретов и резервную копию ключей.
 * Ключ хранилища выводится из фразы восстановления, сохранять его отдельно не нужно.
 * Сервер для загрузки ключей подписи просит пароль (UIA).
 */
export async function setupRecovery(client: MatrixClient, password: string, phrase: string): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error('Защита переписки не работает в этом браузере. Откройте Redline в Chrome или Safari');
  const userId = client.getUserId()!;

  await crypto.bootstrapCrossSigning({
    setupNewCrossSigning: true,
    authUploadDeviceSigningKeys: async (makeRequest) => {
      await makeRequest({ type: 'm.login.password', identifier: { type: 'm.id.user', user: userId }, password });
    },
  });

  const recovery = await crypto.createRecoveryKeyFromPassphrase(normalizePhrase(phrase));
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
}

/**
 * Смена фразы на подтверждённом устройстве: пересоздаём хранилище секретов,
 * но сохраняем существующую резервную копию ключей. Без всех локальных ключей
 * это приведёт к потере доступа к старой переписке — поэтому сначала проверка.
 */
export async function changeRecoveryPhrase(client: MatrixClient, phrase: string): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error('Защита переписки не работает в этом браузере. Откройте Redline в Chrome или Safari');
  const noKeys = new Error('Не получилось сменить фразу на этом телефоне. Сделайте это на том устройстве, где вы уже открывали переписку');

  try {
    const status = await crypto.getCrossSigningStatus();
    const cached = status.privateKeysCachedLocally;
    if (!cached.masterKey || !cached.selfSigningKey || !cached.userSigningKey) throw noKeys;
    const info = await crypto.getKeyBackupInfo();
    if (!info) throw noKeys;
    const backupKey = await crypto.getSessionBackupPrivateKey();
    if (!backupKey) throw noKeys;
    if (!(await crypto.isKeyBackupTrusted(info)).matchesDecryptionKey) throw noKeys;
  } catch (e) {
    if (e === noKeys) throw e;
    throw noKeys;
  }

  const recovery = await crypto.createRecoveryKeyFromPassphrase(normalizePhrase(phrase));
  setPendingNewSecretStorageKey(recovery.privateKey);
  try {
    await crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => recovery,
      setupNewSecretStorage: true,
    });
  } finally {
    setPendingNewSecretStorageKey(null);
  }
}

/**
 * Новое устройство: фраза или ключ восстановления → подтверждаем устройство и
 * подтягиваем ключи старых сообщений из резервной копии.
 */
export async function unlockWithRecovery(client: MatrixClient, input: string): Promise<{ imported: number }> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error('Защита переписки не работает в этом браузере. Откройте Redline в Chrome или Safari');

  const keyId = await client.secretStorage.getDefaultKeyId();
  if (!keyId) throw new Error('Секретная фраза ещё не задана. Задайте её на телефоне, где переписка открыта');
  const stored = await client.secretStorage.getKey(keyId);
  if (!stored) throw new Error('Секретная фраза ещё не задана. Задайте её на телефоне, где переписка открыта');

  let key: Uint8Array<ArrayBuffer> | null = null;
  try {
    key = decodeRecoveryKey(input.trim());
  } catch {
    const passphrase = stored[1].passphrase;
    if (passphrase?.algorithm === 'm.pbkdf2' && typeof passphrase.salt === 'string' && typeof passphrase.iterations === 'number') {
      try {
        key = await deriveRecoveryKeyFromPassphrase(
          normalizePhrase(input),
          passphrase.salt,
          passphrase.iterations,
          passphrase.bits,
        );
      } catch {
        /* неверная фраза — ниже будет общая ошибка */
      }
    }
  }
  if (!key || !(await client.secretStorage.checkKey(key, stored[1]))) {
    throw new Error('Фраза не подошла. Проверьте, нет ли опечаток');
  }
  cacheSecretStorageKey(keyId, key);

  // заберёт ключи cross-signing из хранилища и подпишет это устройство
  await crypto.bootstrapCrossSigning({});
  await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
  await crypto.checkKeyBackupAndEnable();
  const res = await crypto.restoreKeyBackup();
  return { imported: res.imported };
}
