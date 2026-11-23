import { useState } from 'react';
import type { MediaSource } from '../lib/media';
import { currentRoom, mediaKey, roomImages, type RoomMediaItem } from '../lib/roomMedia';
import { useMediaUrl } from '../hooks/useMediaUrl';
import { useClient } from '../state/MatrixContext';
import { Icon } from '../components/ui';
import { MediaViewer } from '../components/MediaViewer';

const MAX_W = 280;
const MAX_H = 360;

function fit(w?: number, h?: number): { width: number; height: number } {
  if (!w || !h) return { width: MAX_W, height: 200 };
  const s = Math.min(1, MAX_W / w, MAX_H / h);
  return { width: Math.max(120, Math.round(w * s)), height: Math.max(80, Math.round(h * s)) };
}

export function ImageMessage({ src, w, h, alt }: { src: MediaSource; w?: number; h?: number; alt: string }) {
  const client = useClient();
  const box = fit(w, h);
  // для незашифрованных — превью с сервера; E2E-файл сервер не видит, грузим целиком
  const thumb = src.file ? undefined : { width: box.width * 2, height: box.height * 2 };
  const url = useMediaUrl(src, thumb);
  const [viewer, setViewer] = useState<{ items: RoomMediaItem[]; index: number } | null>(null);

  const open = () => {
    if (!url || url === 'error') return;
    // соседние фото берём из загруженной ленты открытой комнаты
    const room = currentRoom(client);
    const items = room ? roomImages(room) : [];
    const key = mediaKey(src);
    let index = items.findIndex((it) => mediaKey(it.src) === key);
    if (index < 0) {
      items.length = 0;
      items.push({ id: key, kind: 'image', src, name: alt, ts: 0 });
      index = 0;
    }
    setViewer({ items, index });
  };

  return (
    <>
      <button
        type="button"
        className="msg-image"
        style={{ aspectRatio: `${box.width} / ${box.height}`, width: box.width }}
        onClick={open}
        aria-label="Открыть фото"
      >
        {url === null && <span className="rl-skeleton msg-image__skeleton" />}
        {url === 'error' && <span className="msg-image__error"><Icon name="alert" /> Не загрузилось</span>}
        {url && url !== 'error' && <img src={url} alt={alt} loading="lazy" draggable={false} />}
      </button>
      {viewer && <MediaViewer items={viewer.items} index={viewer.index} onClose={() => setViewer(null)} />}
    </>
  );
}
