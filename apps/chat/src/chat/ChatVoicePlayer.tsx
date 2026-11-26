import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { analyseVoice, playableUrl } from '../lib/voice/playback';
import { normalizeEventWaveform } from '../lib/voice/waveform';
import { formatDuration } from '../lib/events';
import { Icon } from '../components/ui';
import { useBackendMedia } from './useBackendMedia';
import type { ChatBackend, ChatMedia } from './types';

const BARS = 40;
const SPEEDS = [1, 1.5, 2];

/** Одновременно играет только одно голосовое. */
let playing: HTMLAudioElement | null = null;

export function ChatVoicePlayer({ backend, media, own }: { backend: ChatBackend; media: ChatMedia; own: boolean }) {
  const url = useBackendMedia(backend, media);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [bars, setBars] = useState<number[] | null>(() => normalizeEventWaveform(media.waveform, BARS));
  const [duration, setDuration] = useState(media.durationMs ?? 0);
  const [position, setPosition] = useState(0);
  const [isPlaying, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [speed, setSpeed] = useState(1);
  const waveRef = useRef<HTMLDivElement>(null);

  // нет волны в сообщении — посчитаем по файлу
  useEffect(() => {
    if (bars || !url || url === 'error') return;
    let alive = true;
    analyseVoice(url, BARS)
      .then((r) => {
        if (!alive) return;
        setBars(r.waveform);
        if (!media.durationMs) setDuration(r.durationMs);
      })
      .catch(() => alive && setBars(new Array(BARS).fill(0.15)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => () => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      if (playing === a) playing = null;
    }
  }, []);

  const ensureAudio = useCallback(async (): Promise<HTMLAudioElement> => {
    if (audioRef.current) return audioRef.current;
    if (!url || url === 'error') throw new Error('Нет ссылки на голосовое');
    setLoading(true);
    try {
      const playable = await playableUrl(url, media.mime);
      const a = new Audio(playable);
      a.preload = 'auto';
      a.addEventListener('timeupdate', () => setPosition(a.currentTime * 1000));
      a.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(a.duration) && a.duration > 0) setDuration(a.duration * 1000);
      });
      a.addEventListener('play', () => setPlaying(true));
      a.addEventListener('pause', () => setPlaying(false));
      a.addEventListener('ended', () => {
        setPlaying(false);
        setPosition(0);
      });
      audioRef.current = a;
      return a;
    } finally {
      setLoading(false);
    }
  }, [url, media.mime]);

  const toggle = async () => {
    try {
      const a = await ensureAudio();
      if (a.paused) {
        if (playing && playing !== a) playing.pause();
        playing = a;
        a.playbackRate = speed;
        await a.play();
      } else {
        a.pause();
      }
    } catch (e) {
      console.error('voice playback failed', e);
      setFailed(true);
    }
  };

  const seekTo = async (clientX: number) => {
    const el = waveRef.current;
    if (!el || !duration) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    setPosition(frac * duration);
    try {
      const a = await ensureAudio();
      a.currentTime = (frac * duration) / 1000;
    } catch {
      setFailed(true);
    }
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    void seekTo(e.clientX);
  };
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) void seekTo(e.clientX);
  };

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const progress = duration ? Math.min(1, position / duration) : 0;

  return (
    <div className={`voice${own ? ' voice--own' : ''}`}>
      <button
        type="button"
        className="voice__play"
        onClick={() => void toggle()}
        aria-label={isPlaying ? 'Пауза' : 'Слушать'}
        aria-busy={loading || undefined}
        disabled={failed}
      >
        {loading ? <span className="rl-spinner" /> : <Icon name={isPlaying ? 'pause' : 'play'} size={18} />}
      </button>
      <div className="voice__body">
        <div
          ref={waveRef}
          className="voice__wave"
          role="slider"
          aria-label="Перемотка"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration / 1000)}
          aria-valuenow={Math.round(position / 1000)}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onKeyDown={(e) => {
            const a = audioRef.current;
            if (!a) return;
            if (e.key === 'ArrowRight') a.currentTime = Math.min(a.duration, a.currentTime + 5);
            if (e.key === 'ArrowLeft') a.currentTime = Math.max(0, a.currentTime - 5);
          }}
        >
          {(bars ?? new Array(BARS).fill(0.12)).map((v, i) => (
            <span
              key={i}
              className={(i + 0.5) / BARS <= progress ? 'is-played' : undefined}
              style={{ height: `${Math.max(12, v * 100)}%` }}
            />
          ))}
        </div>
        <div className="voice__meta">
          <span className="voice__time">{failed ? 'ошибка' : isPlaying || position > 0 ? `${formatDuration(position)} / ${formatDuration(duration)}` : formatDuration(duration)}</span>
          <button type="button" className="voice__speed" onClick={cycleSpeed} aria-label={`Скорость ${speed}×`}>
            {speed}×
          </button>
        </div>
      </div>
    </div>
  );
}
