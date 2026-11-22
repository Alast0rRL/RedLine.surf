import { useEffect, useState } from 'react';
import { getMediaUrl, type MediaSource, type Thumb } from '../lib/media';
import { useClient } from '../state/MatrixContext';

/** blob: URL медиа (с авторизацией и расшифровкой). null — грузится, 'error' — не вышло. */
export function useMediaUrl(src: MediaSource | null, thumb?: Thumb): string | null | 'error' {
  const client = useClient();
  const [url, setUrl] = useState<string | null | 'error'>(null);
  const key = src ? `${src.file?.url ?? src.url}|${thumb?.width ?? ''}` : '';

  useEffect(() => {
    if (!src || !key) {
      setUrl(null);
      return;
    }
    let alive = true;
    setUrl(null);
    getMediaUrl(client, src, thumb)
      .then((u) => alive && setUrl(u))
      .catch((e) => {
        console.warn('media load failed', e);
        if (alive) setUrl('error');
      });
    return () => {
      alive = false;
    };
    // src/thumb сравниваем по ключу
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  return url;
}
