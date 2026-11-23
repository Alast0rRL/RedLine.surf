import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Direction, MatrixEventEvent, RoomEvent, KnownMembership } from 'matrix-js-sdk';
import { useClient } from '../state/MatrixContext';
import { navigate } from '../hooks/useHashRoute';
import { useMediaUrl } from '../hooks/useMediaUrl';
import { Button, Card, toast } from '../components/ui';
import { MediaViewer } from '../components/MediaViewer';
import { InfoFrame } from './infoParts';
import { FileGlyph, formatSize } from '../room/FileMessage';
import { downloadMedia, mediaOf, type RoomMediaItem } from '../lib/roomMedia';
import { formatDay, formatTime } from '../lib/events';
import '../styles/viewer.css';

const PAGE = 50;
const AUTO_PAGES = 4;

/** Экран «Фото и файлы»: собирает вложения, листая ленту комнаты назад. */
export function RoomMedia({ roomId }: { roomId: string }) {
  const client = useClient();
  const room = client.getRoom(roomId);
  const [tab, setTab] = useState<'photos' | 'files'>('photos');
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!room) return;
    const bump = () => setVersion((v) => v + 1);
    room.on(RoomEvent.Timeline, bump);
    room.on(RoomEvent.Redaction, bump);
    client.on(MatrixEventEvent.Decrypted, bump);
    return () => {
      room.off(RoomEvent.Timeline, bump);
      room.off(RoomEvent.Redaction, bump);
      client.off(MatrixEventEvent.Decrypted, bump);
    };
  }, [client, room]);

  const items = useMemo(() => {
    const out: RoomMediaItem[] = [];
    if (room) {
      for (const ev of room.getLiveTimeline().getEvents()) {
        const m = mediaOf(ev);
        if (m && m.id) out.push(m);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, version]);

  // новые сверху
  const photos = useMemo(() => items.filter((i) => i.kind === 'image').reverse(), [items]);
  const files = useMemo(() => items.filter((i) => i.kind !== 'image').reverse(), [items]);

  const canMore = !!room && room.getLiveTimeline().getPaginationToken(Direction.Backward) !== null;

  const loadMore = useCallback(async (): Promise<boolean> => {
    if (!room || busy.current) return false;
    busy.current = true;
    setLoading(true);
    try {
      await client.paginateEventTimeline(room.getLiveTimeline(), { backwards: true, limit: PAGE });
    } catch (e) {
      console.warn('media paginate failed', e);
      toast('Не удалось загрузить историю', { variant: 'error' });
      return false;
    } finally {
      busy.current = false;
      setLoading(false);
      setVersion((v) => v + 1);
    }
    return room.getLiveTimeline().getPaginationToken(Direction.Backward) !== null;
  }, [client, room]);

  // при открытии подгружаем историю, пока не наберётся хоть сколько-то вложений
  useEffect(() => {
    let alive = true;
    (async () => {
      for (let i = 0; i < AUTO_PAGES && alive; i++) {
        const have = (room?.getLiveTimeline().getEvents().filter((e) => mediaOf(e)).length ?? 0) >= 30;
        if (have || room?.getLiveTimeline().getPaginationToken(Direction.Backward) === null) return;
        if (!(await loadMore())) return;
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  if (!room || room.getMyMembership() !== KnownMembership.Join) {
    return (
      <InfoFrame title="Фото и файлы" onBack={() => navigate.back('#/')}>
        <p className="info__muted">Чат не найден или вы в нём не состоите</p>
      </InfoFrame>
    );
  }

  const list = tab === 'photos' ? photos : files;
  return (
    <InfoFrame title="Фото и файлы" onBack={() => navigate.back(`#/room/${encodeURIComponent(roomId)}/info`)}>
      <Card solid className="settings-card">
        <div className="rmedia__tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'photos'} className="rmedia__tab" onClick={() => setTab('photos')}>
            Фото
          </button>
          <button type="button" role="tab" aria-selected={tab === 'files'} className="rmedia__tab" onClick={() => setTab('files')}>
            Файлы
          </button>
        </div>

        {tab === 'photos' ? (
          <div className="rmedia__grid">
            {photos.map((p, i) => (
              <PhotoCell key={p.id} item={p} onOpen={() => setViewer(i)} />
            ))}
          </div>
        ) : (
          <ul className="rmedia__list">
            {files.map((f) => (
              <li key={f.id}>
                <FileRow item={f} />
              </li>
            ))}
          </ul>
        )}

        {list.length === 0 && !loading && (
          <p className="rmedia__empty">
            {tab === 'photos' ? 'Здесь пока нет фото' : 'Здесь пока нет файлов'}
            {canMore ? '. Загрузите более раннюю историю' : ''}
          </p>
        )}
        {(canMore || loading) && (
          <Button variant="outline" className="rmedia__more" busy={loading} disabled={loading} onClick={() => void loadMore()}>
            Загрузить ещё
          </Button>
        )}
      </Card>
      {viewer !== null && <MediaViewer items={photos} index={viewer} onClose={() => setViewer(null)} />}
    </InfoFrame>
  );
}

function PhotoCell({ item, onOpen }: { item: RoomMediaItem; onOpen: () => void }) {
  const url = useMediaUrl(item.src, item.src.file ? undefined : { width: 256, height: 256 });
  return (
    <button type="button" className="rmedia__cell" onClick={onOpen} aria-label={`Открыть фото ${item.name}`}>
      {url === null && <span className="rl-skeleton" style={{ position: 'absolute', inset: 0 }} />}
      {url && url !== 'error' && <img src={url} alt="" loading="lazy" draggable={false} />}
    </button>
  );
}

function FileRow({ item }: { item: RoomMediaItem }) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await downloadMedia(client, item.src, item.name);
    } catch (e) {
      console.warn('file download failed', e);
      toast('Не удалось скачать файл', { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="rmedia__file" onClick={() => void download()} aria-busy={busy} aria-label={`Скачать ${item.name}`}>
      <span className="rmedia__file-icon">{busy ? <span className="rl-spinner" /> : <FileGlyph />}</span>
      <span className="rmedia__file-text">
        <span className="rmedia__file-name">{item.name}</span>
        <span className="rmedia__file-meta">
          {[formatSize(item.size), `${formatDay(item.ts)}, ${formatTime(item.ts)}`].filter(Boolean).join(' · ')}
        </span>
      </span>
    </button>
  );
}
