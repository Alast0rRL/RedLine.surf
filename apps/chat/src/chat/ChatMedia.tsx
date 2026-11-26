import { useEffect, useState } from 'react';
import { FileGlyph, formatSize } from '../room/FileMessage';
import { Icon, toast } from '../components/ui';
import { useBackendMedia } from './useBackendMedia';
import type { ChatBackend, ChatMedia } from './types';
import '../room/room.css';

const MAX_W = 280;
const MAX_H = 360;

function fit(w?: number, h?: number, sticker = false): { width: number; height: number } {
  const maxW = sticker ? 160 : MAX_W;
  const maxH = sticker ? 200 : MAX_H;
  if (!w || !h) return { width: maxW, height: sticker ? 160 : 200 };
  const s = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(sticker ? 80 : 120, Math.round(w * s)), height: Math.max(80, Math.round(h * s)) };
}

export function ChatImage({
  backend,
  media,
  alt,
  onOpen,
  sticker,
}: {
  backend: ChatBackend;
  media: ChatMedia;
  alt: string;
  onOpen: () => void;
  sticker?: boolean;
}) {
  const box = fit(media.w, media.h, sticker);
  const url = useBackendMedia(backend, media, true);

  return (
    <button
      type="button"
      className="msg-image"
      style={{ aspectRatio: `${box.width} / ${box.height}`, width: box.width }}
      onClick={() => { if (url && url !== 'error') onOpen(); }}
      aria-label={sticker ? 'Открыть стикер' : 'Открыть фото'}
    >
      {url === null && <span className="rl-skeleton msg-image__skeleton" />}
      {url === 'error' && <span className="msg-image__error"><Icon name="alert" /> Не загрузилось</span>}
      {url && url !== 'error' && <img src={url} alt={alt} loading="lazy" draggable={false} />}
    </button>
  );
}

export function ChatVideo({ backend, media }: { backend: ChatBackend; media: ChatMedia }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [ratio, setRatio] = useState(media.w && media.h ? media.w / media.h : 16 / 9);
  const name = media.name ?? 'Видео';

  useEffect(() => {
    if (state !== 'loading') return;
    let alive = true;
    backend.mediaUrl(media)
      .then((u) => {
        if (!alive) return;
        setUrl(u);
        setState('ready');
      })
      .catch((e) => {
        console.warn('video load failed', e);
        if (alive) setState('error');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state === 'loading']);

  if (state === 'ready' && url) {
    return (
      <video
        className="msg-video"
        src={url}
        controls
        autoPlay
        playsInline
        preload="metadata"
        style={{ aspectRatio: String(ratio) }}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth && v.videoHeight) setRatio(v.videoWidth / v.videoHeight);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="msg-video msg-video--poster"
      style={{ aspectRatio: String(ratio) }}
      onClick={() => setState('loading')}
      aria-label={`Воспроизвести видео ${name}`}
      aria-busy={state === 'loading'}
    >
      <span className="msg-video__play">
        {state === 'loading' ? <span className="rl-spinner" /> : state === 'error' ? <Icon name="alert" /> : <Icon name="play" size={26} />}
      </span>
      <span className="msg-video__label">
        {state === 'error' ? 'Не загрузилось — нажмите ещё раз' : `${name}${media.size ? ` · ${formatSize(media.size)}` : ''}`}
      </span>
    </button>
  );
}

export function ChatFile({ backend, media }: { backend: ChatBackend; media: ChatMedia }) {
  const [busy, setBusy] = useState(false);
  const name = media.name ?? 'Файл';

  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const url = await backend.mediaUrl(media);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      console.warn('file download failed', e);
      toast(e instanceof Error && e.message ? e.message : 'Не удалось скачать файл', { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button type="button" className="file-card" onClick={() => void download()} aria-busy={busy} aria-label={`Скачать файл ${name}`}>
      <span className="file-card__icon">{busy ? <span className="rl-spinner" /> : <FileGlyph />}</span>
      <span className="file-card__text">
        <span className="file-card__name">{name}</span>
        <span className="file-card__size">{busy ? 'Загрузка…' : formatSize(media.size)}</span>
      </span>
    </button>
  );
}
