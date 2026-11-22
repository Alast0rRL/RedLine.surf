import type { MatrixClient } from 'matrix-js-sdk';
import type { RoomMessageEventContent } from 'matrix-js-sdk/lib/@types/events.js';
import { encryptAttachment, type EncryptedFileInfo } from './attachments';
import { uploadStore } from './uploads';
import type { VoiceRecording } from './voice/recorder';

const MAX_IMAGE_SIDE = 2560;
const REENCODE_OVER_BYTES = 2.5 * 1024 * 1024;

/** Ссылка на загруженный файл: url для обычных комнат, file — для E2E. */
type FileRef = { url: string } | { file: EncryptedFileInfo };

async function isEncrypted(client: MatrixClient, roomId: string): Promise<boolean> {
  return (await client.getCrypto()?.isEncryptionEnabledInRoom(roomId)) ?? false;
}

async function uploadBlob(
  client: MatrixClient,
  roomId: string,
  blob: Blob,
  name: string,
  onProgress: (p: number) => void,
): Promise<FileRef> {
  const progressHandler = ({ loaded, total }: { loaded: number; total: number }) => onProgress(total ? loaded / total : 0);
  if (await isEncrypted(client, roomId)) {
    const { data, info } = await encryptAttachment(await blob.arrayBuffer());
    const res = await client.uploadContent(new Blob([data]), {
      name: 'encrypted',
      type: 'application/octet-stream',
      includeFilename: false,
      progressHandler,
    });
    return { file: { ...info, url: res.content_uri } };
  }
  const res = await client.uploadContent(blob, { name, type: blob.type, progressHandler });
  return { url: res.content_uri };
}

const uid = () => crypto.randomUUID();

export function sendText(client: MatrixClient, roomId: string, text: string): Promise<unknown> {
  const content: RoomMessageEventContent = { msgtype: 'm.text', body: text } as RoomMessageEventContent;
  return client.sendMessage(roomId, content);
}

/** Уменьшает большие фото (телефонные 12 Мп → 2560px JPEG) и снимает размеры. */
async function prepareImage(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file); // учитывает EXIF-поворот
  const { width, height } = bitmap;
  const animated = file.type === 'image/gif' || file.type === 'image/webp';
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
  if (animated || (scale === 1 && file.size <= REENCODE_OVER_BYTES)) {
    bitmap.close();
    return { blob: file, width, height };
  }
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return { blob, width: w, height: h };
}

export function sendImage(client: MatrixClient, roomId: string, file: File): void {
  const id = uid();
  uploadStore.add({ id, roomId, kind: 'image', previewUrl: URL.createObjectURL(file), progress: 0 });

  const run = async () => {
    uploadStore.update(id, { error: undefined, progress: 0 });
    try {
      const { blob, width, height } = await prepareImage(file);
      const name = blob === file ? file.name : file.name.replace(/\.\w+$/, '') + '.jpg';
      const ref = await uploadBlob(client, roomId, blob, name, (p) => uploadStore.update(id, { progress: p }));
      const content = {
        msgtype: 'm.image',
        body: name,
        info: { mimetype: blob.type, size: blob.size, w: width, h: height },
        ...ref,
      } as unknown as RoomMessageEventContent;
      await client.sendMessage(roomId, content);
      uploadStore.remove(id);
    } catch (e) {
      console.error('image send failed', e);
      uploadStore.update(id, { error: 'Не удалось отправить фото', retry: () => void run() });
    }
  };
  void run();
}

/**
 * Голосовое в формате Element: m.audio + MSC1767 (волна, длительность) + MSC3245 (признак голосового).
 */
export function sendVoice(client: MatrixClient, roomId: string, rec: VoiceRecording): void {
  const id = uid();
  uploadStore.add({ id, roomId, kind: 'voice', durationMs: rec.durationMs, progress: 0 });

  const run = async () => {
    uploadStore.update(id, { error: undefined, progress: 0 });
    try {
      const name = `voice-${new Date().toISOString().replace(/[:.]/g, '-')}.ogg`;
      const ref = await uploadBlob(client, roomId, rec.blob, name, (p) => uploadStore.update(id, { progress: p }));
      const body = 'Голосовое сообщение';
      const content = {
        msgtype: 'm.audio',
        body,
        info: { mimetype: 'audio/ogg', size: rec.blob.size, duration: rec.durationMs },
        ...ref,
        'org.matrix.msc1767.text': body,
        'org.matrix.msc1767.file': { name, mimetype: 'audio/ogg', size: rec.blob.size, ...('url' in ref ? { url: ref.url } : { file: ref.file }) },
        'org.matrix.msc1767.audio': { duration: rec.durationMs, waveform: rec.waveform },
        'org.matrix.msc3245.voice': {},
      } as unknown as RoomMessageEventContent;
      await client.sendMessage(roomId, content);
      uploadStore.remove(id);
    } catch (e) {
      console.error('voice send failed', e);
      uploadStore.update(id, { error: 'Не удалось отправить голосовое', retry: () => void run() });
    }
  };
  void run();
}
