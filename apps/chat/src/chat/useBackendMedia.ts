/**
 * URL медиа и аватаров через ChatBackend. Кеш живёт всё время вкладки:
 * blob:-ссылки не отзываем, пока запись в кеше.
 */
import { useEffect, useState } from 'react';
import type { ChatBackend, ChatMedia } from './types';

type MediaValue = string | null | 'error';

interface MediaEntry {
  promise: Promise<string>;
  value: MediaValue;
}

const mediaCache = new Map<string, Map<unknown, Map<boolean, MediaEntry>>>();

function mediaEntry(backend: ChatBackend, media: ChatMedia, thumb: boolean): MediaEntry {
  let byRef = mediaCache.get(backend.key);
  if (!byRef) {
    byRef = new Map();
    mediaCache.set(backend.key, byRef);
  }
  let byThumb = byRef.get(media.ref);
  if (!byThumb) {
    byThumb = new Map();
    byRef.set(media.ref, byThumb);
  }
  const hit = byThumb.get(thumb);
  if (hit) return hit;
  const created: MediaEntry = { promise: backend.mediaUrl(media, thumb), value: null };
  byThumb.set(thumb, created);
  created.promise.then(
    (url) => { created.value = url; },
    () => {
      created.value = 'error';
      byThumb.delete(thumb); // сбой сети — при следующем показе попробуем снова
    },
  );
  return created;
}

/** null — грузится, 'error' — не вышло. */
export function useBackendMedia(backend: ChatBackend, media: ChatMedia | null, thumb = false): MediaValue {
  const [url, setUrl] = useState<MediaValue>(() => (media ? mediaEntry(backend, media, thumb).value : null));

  useEffect(() => {
    if (!media) {
      setUrl(null);
      return;
    }
    let alive = true;
    const entry = mediaEntry(backend, media, thumb);
    setUrl(entry.value);
    entry.promise.then(
      (value) => { if (alive) setUrl(value); },
      () => { if (alive) setUrl('error'); },
    );
    return () => {
      alive = false;
    };
  }, [backend, media, thumb]);

  return url;
}

interface AvatarEntry {
  promise: Promise<string | null>;
  value: string | null;
}

const avatarCache = new Map<string, AvatarEntry>();

function avatarEntry(backend: ChatBackend, senderId: string): AvatarEntry {
  const key = `${backend.key}\u0000${senderId}`;
  const hit = avatarCache.get(key);
  if (hit) return hit;
  const created: AvatarEntry = { promise: backend.avatarUrl(senderId), value: null };
  avatarCache.set(key, created);
  created.promise.then(
    (url) => { created.value = url; },
    () => { created.value = null; },
  );
  return created;
}

export function useBackendAvatar(backend: ChatBackend, senderId: string): string | null {
  const [url, setUrl] = useState<string | null>(() => (senderId ? avatarEntry(backend, senderId).value : null));

  useEffect(() => {
    if (!senderId) {
      setUrl(null);
      return;
    }
    let alive = true;
    const entry = avatarEntry(backend, senderId);
    setUrl(entry.value);
    entry.promise.then(
      (value) => { if (alive) setUrl(value); },
      () => { if (alive) setUrl(null); },
    );
    return () => {
      alive = false;
    };
  }, [backend, senderId]);

  return url;
}
