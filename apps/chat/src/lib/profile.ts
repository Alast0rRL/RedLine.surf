import type { MatrixClient } from 'matrix-js-sdk';

const AVATAR_SIDE = 512;
export const NAME_MAX = 40;

export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Введите имя';
  if (n.length > NAME_MAX) return `Не длиннее ${NAME_MAX} символов`;
  return null;
}

export async function setName(client: MatrixClient, name: string): Promise<void> {
  await client.setDisplayName(name.trim());
}

/** Квадрат по центру, не больше 512px: аватарка публичная, хранить оригинал незачем. */
async function squareAvatar(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file); // учитывает EXIF-поворот
  } catch {
    throw new Error('Не получилось открыть фото. Выберите JPG или PNG');
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(AVATAR_SIDE, side);
  const canvas = new OffscreenCanvas(out, out);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
}

/** Аватарка не шифруется: её видят все, с кем вы в одном чате. */
export async function setAvatar(client: MatrixClient, file: File): Promise<void> {
  const blob = await squareAvatar(file);
  const { content_uri: url } = await client.uploadContent(blob, { name: 'avatar.jpg', type: 'image/jpeg' });
  await client.setAvatarUrl(url);
}

export async function removeAvatar(client: MatrixClient): Promise<void> {
  await client.setAvatarUrl('');
}
