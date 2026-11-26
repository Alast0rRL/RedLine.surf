import { useCallback, useEffect, useRef, useState } from 'react';
import { Track } from 'livekit-client';
import { Avatar, Button } from '../components/ui';
import { ExtraIcon } from '../components/extraIcons';
import { formatDuration } from '../lib/events';
import { useClient } from '../state/MatrixContext';
import {
  accept,
  flipCamera,
  getRoom,
  hangup,
  reject,
  toggleCam,
  toggleMic,
  useCall,
  type CallState,
} from './CallManager';
import '../styles/call.css';

type Attachable = {
  attach(element: HTMLMediaElement): HTMLMediaElement;
  detach(element: HTMLMediaElement): HTMLMediaElement;
};

function statusText(state: CallState): string {
  switch (state.phase) {
    case 'outgoing': return 'Вызов…';
    case 'incoming': return state.video ? 'Входящий видеозвонок' : 'Входящий звонок';
    case 'connecting': return 'Соединение…';
    case 'reconnecting': return 'Переподключение…';
    case 'active': return state.startedAt ? formatDuration(Date.now() - state.startedAt) : 'Звонок';
    case 'ended': return state.endedReason || 'Звонок завершён';
    default: return '';
  }
}

export function CallOverlay() {
  const state = useCall();
  const client = useClient();
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const audioHostRef = useRef<HTMLDivElement>(null);
  const attached = useRef<{ track: Attachable; element: HTMLMediaElement }[]>([]);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [hasLocalVideo, setHasLocalVideo] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!state.startedAt || (state.phase !== 'active' && state.phase !== 'reconnecting')) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [state.startedAt, state.phase]);

  useEffect(() => {
    for (const { track, element } of attached.current) {
      try {
        track.detach(element);
      } catch {
        /* дорожка уже отключена */
      }
      if (element instanceof HTMLAudioElement) {
        element.pause();
        element.remove();
      }
    }
    attached.current = [];

    const room = getRoom();
    if (!room) {
      setHasRemoteVideo(false);
      setHasLocalVideo(false);
      setAudioBlocked(false);
      return;
    }

    const bind = (track: Attachable, element: HTMLMediaElement) => {
      try {
        track.attach(element);
        attached.current.push({ track, element });
      } catch {
        /* дорожка недоступна для воспроизведения */
      }
    };

    let audioCount = 0;
    let remoteVideo: Attachable | null = null;
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        const track = publication.audioTrack;
        const host = audioHostRef.current;
        if (!track || !host) continue;
        const element = document.createElement('audio');
        element.autoplay = true;
        host.appendChild(element);
        bind(track, element);
        audioCount += 1;
        void element.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
      }
      const track = participant.getTrackPublication(Track.Source.Camera)?.videoTrack;
      if (track && !remoteVideo) remoteVideo = track;
    }

    const remoteElement = remoteVideoRef.current;
    if (remoteVideo && remoteElement) bind(remoteVideo, remoteElement);
    setHasRemoteVideo(!!remoteVideo && !!remoteElement);

    const localTrack = room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
    const localElement = localVideoRef.current;
    if (localTrack && localElement) {
      localElement.muted = true;
      bind(localTrack, localElement);
    }
    setHasLocalVideo(!!localTrack && !!localElement);
    if (!audioCount) setAudioBlocked(false);
  }, [state.tracksVersion, state.phase]);

  const enableSound = useCallback(() => {
    const room = getRoom();
    if (!room) return;
    void room.startAudio().catch(() => undefined);
    const plays = attached.current
      .filter(({ element }) => element instanceof HTMLAudioElement)
      .map(({ element }) => element.play().catch(() => undefined));
    void Promise.all(plays).then(() => setAudioBlocked(false));
  }, []);

  if (state.phase === 'idle') return null;

  const name = state.peerName || 'Собеседник';
  const poor = state.quality === 'poor' || state.quality === 'lost';
  const showQuality = poor && (state.phase === 'active' || state.phase === 'reconnecting');

  return (
    <div className="call" role="dialog" aria-modal="true" aria-label="Звонок">
      <div className="call__stage">
        <video ref={remoteVideoRef} className={`call__remote${hasRemoteVideo ? '' : ' is-hidden'}`} autoPlay playsInline />
        {!hasRemoteVideo && (
          <div className="call__avatar">
            <Avatar client={client} name={name} seed={state.peerId ?? state.roomId ?? name} size="xl" round />
          </div>
        )}
        <div className={`call__local${hasLocalVideo ? '' : ' is-hidden'}`}>
          <video ref={localVideoRef} autoPlay playsInline muted />
        </div>
      </div>

      <div className="call__info">
        <p className="call__peer">{name}</p>
        <p className="call__status" role="status">{statusText(state)}</p>
        {showQuality && <span className="call__badge">Плохая связь</span>}
        {state.error && <p className="call__error" role="alert">{state.error}</p>}
        {audioBlocked && state.phase !== 'ended' && (
          <Button className="call__sound" onClick={enableSound}>Включить звук</Button>
        )}
      </div>

      {state.phase === 'incoming' ? (
        <div className="call__controls">
          <Button variant="ghost" icon round className="call__btn call__btn--danger" aria-label="Отклонить звонок" onClick={() => void reject()}>
            <ExtraIcon name="phoneOff" size={26} />
          </Button>
          <Button variant="ghost" icon round className="call__btn call__btn--accept" aria-label="Принять звонок" onClick={() => void accept(false)}>
            <ExtraIcon name="phone" size={26} />
          </Button>
          {state.video && (
            <Button variant="ghost" round className="call__btn call__btn--text call__btn--accept" aria-label="Принять звонок с видео" onClick={() => void accept(true)}>
              С видео
            </Button>
          )}
        </div>
      ) : state.phase !== 'ended' ? (
        <div className="call__controls">
          <Button variant="ghost" icon round className="call__btn" aria-label={state.micOn ? 'Выключить микрофон' : 'Включить микрофон'} onClick={() => void toggleMic()}>
            <ExtraIcon name={state.micOn ? 'mic' : 'micOff'} size={26} />
          </Button>
          <Button variant="ghost" icon round className="call__btn" aria-label={state.camOn ? 'Выключить камеру' : 'Включить камеру'} onClick={() => void toggleCam()}>
            <ExtraIcon name={state.camOn ? 'video' : 'videoOff'} size={26} />
          </Button>
          {state.camOn && (
            <Button variant="ghost" icon round className="call__btn" aria-label="Переключить камеру" onClick={() => void flipCamera()}>
              <ExtraIcon name="flip" size={26} />
            </Button>
          )}
          <Button variant="ghost" icon round className="call__btn call__btn--danger" aria-label="Завершить звонок" onClick={() => void hangup()}>
            <ExtraIcon name="phoneOff" size={26} />
          </Button>
        </div>
      ) : null}

      <div className="call__audio" ref={audioHostRef} aria-hidden="true" />
    </div>
  );
}
