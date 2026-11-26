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
  startAudio,
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

type Attachment = { track: Attachable; element: HTMLMediaElement };

type VideoHolder = { current: Attachment | null };

function detachAttachment(attachment: Attachment | null): void {
  if (!attachment) return;
  try {
    attachment.track.detach(attachment.element);
  } catch {
    /* дорожка уже отключена */
  }
  if (attachment.element instanceof HTMLAudioElement) {
    attachment.element.pause();
    attachment.element.remove();
  }
}

function detachAudio(elements: Map<string, HTMLAudioElement>, tracks: Map<string, Attachable>, sid: string): void {
  const element = elements.get(sid);
  const track = tracks.get(sid);
  if (element && track) {
    try {
      track.detach(element);
    } catch {
      /* дорожка уже отключена */
    }
  }
  element?.pause();
  element?.remove();
  elements.delete(sid);
  tracks.delete(sid);
}

/** Меняем элемент только при смене дорожки: существующий <audio> переиспользуем. */
function syncVideo(holder: VideoHolder, element: HTMLVideoElement | null, track: Attachable | null): boolean {
  const current = holder.current;
  if (current && (current.track !== track || current.element !== element)) {
    detachAttachment(current);
    holder.current = null;
  }
  if (track && element && !holder.current) {
    try {
      track.attach(element);
      holder.current = { track, element };
    } catch {
      /* дорожка недоступна для воспроизведения */
    }
  }
  return !!holder.current;
}

function hasLiveVideo(publication: { isMuted: boolean } | undefined, track: Track | undefined): boolean {
  return !!track && !publication?.isMuted && !track.isMuted && track.mediaStreamTrack.readyState === 'live';
}

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
  const audioElements = useRef(new Map<string, HTMLAudioElement>());
  const audioTracks = useRef(new Map<string, Attachable>());
  const remoteAttachment = useRef<Attachment | null>(null);
  const localAttachment = useRef<Attachment | null>(null);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [hasLocalVideo, setHasLocalVideo] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!state.startedAt || (state.phase !== 'active' && state.phase !== 'reconnecting')) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [state.startedAt, state.phase]);

  useEffect(() => () => {
    // При размонтировании снимаем все дорожки, включая аудио в скрытом контейнере.
    for (const sid of [...audioElements.current.keys()]) {
      detachAudio(audioElements.current, audioTracks.current, sid);
    }
    detachAttachment(remoteAttachment.current);
    detachAttachment(localAttachment.current);
    remoteAttachment.current = null;
    localAttachment.current = null;
  }, []);

  useEffect(() => {
    const room = getRoom();
    const host = audioHostRef.current;
    if (!room || !host) {
      for (const sid of [...audioElements.current.keys()]) {
        detachAudio(audioElements.current, audioTracks.current, sid);
      }
      detachAttachment(remoteAttachment.current);
      detachAttachment(localAttachment.current);
      remoteAttachment.current = null;
      localAttachment.current = null;
      setHasRemoteVideo(false);
      setHasLocalVideo(false);
      return;
    }

    const ownId = client.getUserId();
    const liveAudio = new Set<string>();
    let remoteTrack: Track | undefined;
    let remotePublication: { isMuted: boolean } | undefined;

    for (const participant of room.remoteParticipants.values()) {
      // Своя вторая вкладка приходит с identity `${userId}|${party}` — не проигрываем её.
      if (ownId && participant.identity.startsWith(`${ownId}|`)) continue;
      for (const publication of participant.audioTrackPublications.values()) {
        const track = publication.audioTrack;
        if (!track) continue;
        const sid = String(publication.trackSid || track.sid);
        liveAudio.add(sid);
        let element = audioElements.current.get(sid);
        if (!element) {
          element = document.createElement('audio');
          element.autoplay = true;
          host.appendChild(element);
          audioElements.current.set(sid, element);
        }
        const previous = audioTracks.current.get(sid);
        if (previous !== track) {
          if (previous) {
            try {
              previous.detach(element);
            } catch {
              /* дорожка уже отключена */
            }
          }
          try {
            track.attach(element);
            audioTracks.current.set(sid, track);
          } catch {
            /* дорожка недоступна для воспроизведения */
          }
        }
        void element.play().catch(() => undefined);
      }
      const camera = participant.getTrackPublication(Track.Source.Camera);
      const candidate = camera?.videoTrack;
      if (!remoteTrack && candidate && hasLiveVideo(camera, candidate)) {
        remoteTrack = candidate;
        remotePublication = camera;
      }
    }

    for (const sid of [...audioElements.current.keys()]) {
      if (!liveAudio.has(sid)) detachAudio(audioElements.current, audioTracks.current, sid);
    }

    const remoteVisible = hasLiveVideo(remotePublication, remoteTrack)
      && syncVideo(remoteAttachment, remoteVideoRef.current, remoteTrack ?? null);
    setHasRemoteVideo(remoteVisible);

    const localCamera = room.localParticipant.getTrackPublication(Track.Source.Camera);
    const localTrack = localCamera?.videoTrack;
    const localVisible = hasLiveVideo(localCamera, localTrack)
      && syncVideo(localAttachment, localVideoRef.current, localTrack ?? null);
    if (localVideoRef.current) localVideoRef.current.muted = true;
    setHasLocalVideo(localVisible);
  }, [state.tracksVersion, state.phase, client]);

  const enableSound = useCallback(() => {
    void startAudio();
    const plays = [...audioElements.current.values()].map((element) => element.play().catch(() => undefined));
    void Promise.all(plays);
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
        {state.audioBlocked && state.phase !== 'ended' && (
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
