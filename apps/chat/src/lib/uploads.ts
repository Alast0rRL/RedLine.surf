/**
 * Загрузки, которые ещё не стали событиями: показываем их в конце ленты с прогрессом.
 * После загрузки файла событие отправляется обычным путём и появляется как local echo.
 */

export interface PendingUpload {
  id: string;
  roomId: string;
  kind: 'image' | 'voice';
  /** blob: URL превью (для фото) */
  previewUrl?: string;
  durationMs?: number;
  /** 0..1 */
  progress: number;
  error?: string;
  retry?: () => void;
}

type Listener = () => void;
let uploads: PendingUpload[] = [];
const listeners = new Set<Listener>();

const emit = () => listeners.forEach((l) => l());

export const uploadStore = {
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get(): PendingUpload[] {
    return uploads;
  },
  add(u: PendingUpload) {
    uploads = [...uploads, u];
    emit();
  },
  update(id: string, patch: Partial<PendingUpload>) {
    uploads = uploads.map((u) => (u.id === id ? { ...u, ...patch } : u));
    emit();
  },
  remove(id: string) {
    const u = uploads.find((x) => x.id === id);
    if (u?.previewUrl) URL.revokeObjectURL(u.previewUrl);
    uploads = uploads.filter((x) => x.id !== id);
    emit();
  },
};
