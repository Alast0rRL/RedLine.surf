/**
 * Шифрование вложений для E2E-комнат (Matrix spec: EncryptedFile, AES-CTR-256 + SHA-256).
 * https://spec.matrix.org/latest/client-server-api/#sending-encrypted-attachments
 */

export interface EncryptedFileInfo {
  url: string;
  key: {
    kty: 'oct';
    key_ops: string[];
    alg: 'A256CTR';
    k: string;
    ext: true;
  };
  iv: string;
  hashes: { sha256: string };
  v: 'v2';
}

const b64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, '');
};

const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export async function encryptAttachment(
  plain: ArrayBuffer,
): Promise<{ data: ArrayBuffer; info: Omit<EncryptedFileInfo, 'url'> }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-CTR', length: 256 }, true, ['encrypt', 'decrypt']);
  // старшие 8 байт — случайные, младшие 8 — счётчик с нуля (так требует спецификация)
  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv.subarray(0, 8));
  const data = await crypto.subtle.encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, key, plain);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return {
    data,
    info: {
      key: { kty: 'oct', key_ops: ['encrypt', 'decrypt'], alg: 'A256CTR', k: jwk.k!, ext: true },
      iv: b64(iv),
      hashes: { sha256: b64(hash) },
      v: 'v2',
    },
  };
}

export async function decryptAttachment(data: ArrayBuffer, info: EncryptedFileInfo): Promise<ArrayBuffer> {
  if (!info?.key?.k || !info.iv || !info.hashes?.sha256) throw new Error('Некорректное зашифрованное вложение');
  const hash = await crypto.subtle.digest('SHA-256', data);
  if (b64(hash) !== info.hashes.sha256.replace(/=+$/, '')) throw new Error('Хеш вложения не совпадает');
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'oct', k: info.key.k, alg: 'A256CTR', ext: true, key_ops: ['encrypt', 'decrypt'] },
    { name: 'AES-CTR' },
    false,
    ['decrypt'],
  );
  return crypto.subtle.decrypt({ name: 'AES-CTR', counter: unb64(info.iv), length: 64 }, key, data);
}
