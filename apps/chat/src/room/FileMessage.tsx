import { useEffect, useState } from 'react';
import { loadMediaBlob, type MediaSource } from '../lib/media';
import { useClient } from '../state/MatrixContext';
import { Icon, toast } from '../components/ui';
import './room.css';

export function formatSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} МБ`;
}

export function FileGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6" />
    </svg>
  );
}

/** Карточка файла: по нажатию скачивает, расшифровывает и сохраняет с исходным именем. */
export function FileMessage({ src, name, size }: { src: MediaSource; name: string; size?: number }) {
  const client = useClient();
  const [busy, setBusy] = useState(false);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await loadMediaBlob(client, src);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      console.warn('file download failed', e);
      toast('Не удалось скачать файл', { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button type="button" className="file-card" onClick={() => void download()} aria-busy={busy} aria-label={`Скачать файл ${name}`}>
      <span className="file-card__icon">{busy ? <span className="rl-spinner" /> : <FileGlyph />}</span>
      <span className="file-card__text">
        <span className="file-card__name">{name}</span>
        <span className="file-card__size">{busy ? 'Загрузка…' : formatSize(size)}</span>
      </span>
    </button>
  );
}

/** Видео: расшифровываем по нажатию (файл может быть большим), дальше обычный <video controls>. */
export function VideoMessage({ src, name, size, w, h }: { src: MediaSource; name: string; size?: number; w?: number; h?: number }) {
  const client = useClient();
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [ratio, setRatio] = useState(w && h ? w / h : 16 / 9);

  useEffect(() => {
    if (state !== 'loading') return;
    let alive = true;
    let made: string | null = null;
    loadMediaBlob(client, src)
      .then((blob) => {
        if (!alive) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
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

  // blob: URL освобождаем при уходе
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

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
        {state === 'error' ? 'Не загрузилось — нажмите ещё раз' : `${name}${size ? ` · ${formatSize(size)}` : ''}`}
      </span>
    </button>
  );
}
