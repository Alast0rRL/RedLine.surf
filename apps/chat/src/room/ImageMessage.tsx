import { useState } from 'react';
import type { MediaSource } from '../lib/media';
import { useMediaUrl } from '../hooks/useMediaUrl';
import { Icon } from '../components/ui';

const MAX_W = 280;
const MAX_H = 360;

function fit(w?: number, h?: number): { width: number; height: number } {
  if (!w || !h) return { width: MAX_W, height: 200 };
  const s = Math.min(1, MAX_W / w, MAX_H / h);
  return { width: Math.max(120, Math.round(w * s)), height: Math.max(80, Math.round(h * s)) };
}

export function ImageMessage({ src, w, h, alt }: { src: MediaSource; w?: number; h?: number; alt: string }) {
  const box = fit(w, h);
  // для незашифрованных — превью с сервера; E2E-файл сервер не видит, грузим целиком
  const thumb = src.file ? undefined : { width: box.width * 2, height: box.height * 2 };
  const url = useMediaUrl(src, thumb);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="msg-image"
        style={{ aspectRatio: `${box.width} / ${box.height}`, width: box.width }}
        onClick={() => url && url !== 'error' && setOpen(true)}
        aria-label="Открыть фото"
      >
        {url === null && <span className="rl-skeleton msg-image__skeleton" />}
        {url === 'error' && <span className="msg-image__error"><Icon name="alert" /> Не загрузилось</span>}
        {url && url !== 'error' && <img src={url} alt={alt} loading="lazy" draggable={false} />}
      </button>
      {open && <Lightbox src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}

function Lightbox({ src, alt, onClose }: { src: MediaSource; alt: string; onClose: () => void }) {
  const full = useMediaUrl(src);
  return (
    <div className="lightbox" role="dialog" aria-label="Фото" onClick={onClose} onKeyDown={(e) => e.key === 'Escape' && onClose()} tabIndex={-1} ref={(el) => el?.focus()}>
      <button type="button" className="rl-btn rl-btn--icon rl-btn--ghost lightbox__close" aria-label="Закрыть" onClick={onClose}>
        <Icon name="close" />
      </button>
      {full && full !== 'error' ? <img src={full} alt={alt} onClick={(e) => e.stopPropagation()} /> : <span className="rl-spinner" />}
    </div>
  );
}
