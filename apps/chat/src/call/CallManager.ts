import { useSyncExternalStore } from 'react';
import {
  AudioPresets,
  ConnectionQuality,
  ConnectionState,
  Room as LiveKitRoom,
  RoomEvent,
  Track,
  VideoPresets,
} from 'livekit-client';
import { type MatrixClient, type Room as MatrixRoom } from 'matrix-js-sdk';
import { apiBase } from '../config';
import { PARTY, sendSignal, subscribeSignals, type CallSignal, type CallSignalEvent } from './signal';

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'reconnecting' | 'ended';
export type CallQuality = 'good' | 'poor' | 'lost';

export interface CallState {
  phase: CallPhase;
  roomId?: string;
  callId?: string;
  video: boolean;
  peerId?: string;
  peerName?: string;
  startedAt?: number;
  micOn: boolean;
  camOn: boolean;
  quality: CallQuality;
  endedReason?: string;
  error?: string;
  /** Увеличивается при появлении/смене дорожек, чтобы UI перерисовал видео. */
  tracksVersion: number;
  /** Браузер запретил автовоспроизведение: нужно нажать «Включить звук». */
  audioBlocked: boolean;
}

interface ScreenLock {
  addEventListener(type: 'release', listener: () => void): void;
  release(): Promise<void>;
}

interface Session {
  roomId: string;
  callId: string;
  direction: 'outgoing' | 'incoming';
  video: boolean;
  peerId?: string;
  peerName?: string;
  accepted: boolean;
  ending: boolean;
  activating: boolean;
  connecting?: Promise<void>;
  /** Своя комната сессии: устаревшая сессия не должна закрывать чужую. */
  room?: LiveKitRoom;
  startedAt?: number;
  inviteTimer?: number;
  graceTimer?: number;
  watchdogTimer?: number;
  reconnectWatchdogTimer?: number;
  reconnectTimer?: number;
  reconnecting: boolean;
  reconnectAttempts: number;
  reconnectStart: number;
  /** Online/visible пришёл во время попытки — повторим сразу после неё. */
  retryRequested: boolean;
  peerGone: boolean;
  screenLock?: ScreenLock;
}

const CONNECT_WATCHDOG_MS = 30000;
const CONNECT_TIMEOUT_MS = 20000;
const RECONNECT_LIMIT_MS = 60000;
const PEER_GRACE_MS = 30000;
const TOKEN_TIMEOUT_MS = 8000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 3000, 5000];

interface TokenResponse {
  url: string;
  token: string;
  room: string;
}

const listeners = new Set<() => void>();

let state: CallState = {
  phase: 'idle',
  video: false,
  micOn: false,
  camOn: false,
  quality: 'good',
  tracksVersion: 0,
  audioBlocked: false,
};
let matrix: MatrixClient | null = null;
let unsubscribeSignals: (() => void) | null = null;
let session: Session | null = null;
let room: LiveKitRoom | null = null;
const roomListeners = new WeakMap<LiveKitRoom, () => void>();
let globalListenersAttached = false;

function isCurrent(s: Session): boolean {
  return session === s && !s.ending;
}

function isBusy(): boolean {
  return state.phase === 'outgoing' || state.phase === 'incoming' || state.phase === 'connecting'
    || state.phase === 'active' || state.phase === 'reconnecting';
}

function update(patch: Partial<CallState>): void {
  const wasRinging = state.phase === 'incoming' || state.phase === 'outgoing';
  const ringingNow = patch.phase === 'incoming' || patch.phase === 'outgoing';
  state = { ...state, ...patch };
  // Звонок всегда прекращает звучать при выходе из ringing-фазы.
  if (wasRinging && patch.phase !== undefined && !ringingNow) stopRinging();
  listeners.forEach((l) => l());
}

function bumpTracks(): void {
  update({ tracksVersion: state.tracksVersion + 1 });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* Звук звонка: WebAudio без внешних файлов. */

type RingMode = 'incoming' | 'outgoing';
let audio: AudioContext | null = null;
let ringTimer: number | undefined;
let oscillators: OscillatorNode[] = [];
let ringMode: RingMode | null = null;

function audioContext(): AudioContext | null {
  try {
    if (!audio) audio = new AudioContext();
    if (audio.state === 'suspended') void audio.resume().catch(() => undefined);
    return audio;
  } catch {
    return null;
  }
}

function tone(ctx: AudioContext, freq: number, start: number, twoTone: boolean): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  if (twoTone) {
    osc.frequency.setValueAtTime(440, start);
    osc.frequency.setValueAtTime(480, start + 0.5);
  } else {
    osc.frequency.setValueAtTime(freq, start);
  }
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.08, start + 0.02);
  gain.gain.setValueAtTime(0.08, start + 0.95);
  gain.gain.linearRampToValueAtTime(0, start + 1);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + 1);
  oscillators.push(osc);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
    oscillators = oscillators.filter((o) => o !== osc);
  };
}

function ringBurst(mode: RingMode): void {
  const ctx = audioContext();
  if (!ctx) return;
  const start = ctx.currentTime + 0.01;
  tone(ctx, 425, start, mode === 'incoming');
}

function scheduleRing(mode: RingMode): void {
  ringBurst(mode);
  // Входящий: 1 с звука / 2 с паузы. Исходящий: 1 с / 4 с.
  ringTimer = window.setTimeout(() => {
    if (ringMode === mode) scheduleRing(mode);
  }, mode === 'incoming' ? 3000 : 5000);
}

function startRinging(mode: RingMode): void {
  stopRinging();
  ringMode = mode;
  scheduleRing(mode);
}

function stopRinging(): void {
  ringMode = null;
  if (ringTimer !== undefined) {
    window.clearTimeout(ringTimer);
    ringTimer = undefined;
  }
  for (const osc of oscillators) {
    try {
      osc.stop();
    } catch {
      /* осциллятор уже остановлен */
    }
  }
  oscillators = [];
}

/* Удержание экрана и системные события. */

function wakeLockHolder(): { wakeLock?: { request(type: 'screen'): Promise<ScreenLock> } } {
  return navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<ScreenLock> } };
}

function requestWakeLock(): void {
  const s = session;
  if (!s || !isCurrent(s) || !wakeLockHolder().wakeLock) return;
  void wakeLockHolder().wakeLock!.request('screen').then((lock) => {
    // Браузер снимает lock при уходе в фон: без этого повторный request не сработает.
    lock.addEventListener('release', () => {
      if (s.screenLock === lock) s.screenLock = undefined;
    });
    if (isCurrent(s) && !s.screenLock) s.screenLock = lock;
    else void lock.release().catch(() => undefined);
  }).catch(() => undefined);
}

function releaseWakeLock(s: Session): void {
  if (!s.screenLock) return;
  const lock = s.screenLock;
  s.screenLock = undefined;
  void lock.release().catch(() => undefined);
}

function onOnline(): void {
  retryNow();
}

function onVisibility(): void {
  if (document.visibilityState !== 'visible') return;
  requestWakeLock();
  retryNow();
}

function onPageHide(e: PageTransitionEvent): void {
  // При переходе в bfcache звонок продолжается — страница может вернуться.
  if (e.persisted) return;
  void hangup();
}

/* Токен LiveKit. */

async function fetchToken(roomId: string, callId: string): Promise<TokenResponse> {
  if (!matrix) throw new Error('Клиент Matrix не подключён');
  const res = await fetch(`${apiBase()}/api/call/token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${matrix.getAccessToken() ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ roomId, callId, party: PARTY }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => null)) as Partial<TokenResponse> & { error?: string } | null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  if (!data?.url || !data.token) throw new Error(data?.error || 'Некорректный ответ сервера звонка');
  return { url: data.url, token: data.token, room: data.room ?? roomId };
}

/* Сессии и очистка. */

function createSession(
  roomId: string,
  callId: string,
  direction: Session['direction'],
  video: boolean,
  info: { peerId?: string; peerName?: string },
): Session {
  return {
    roomId,
    callId,
    direction,
    video,
    peerId: info.peerId,
    peerName: info.peerName,
    accepted: false,
    ending: false,
    activating: false,
    reconnecting: false,
    reconnectAttempts: 0,
    reconnectStart: Date.now(),
    retryRequested: false,
    peerGone: false,
  };
}

function clearTimers(s: Session): void {
  if (s.inviteTimer !== undefined) window.clearTimeout(s.inviteTimer);
  if (s.graceTimer !== undefined) window.clearTimeout(s.graceTimer);
  if (s.watchdogTimer !== undefined) window.clearTimeout(s.watchdogTimer);
  if (s.reconnectWatchdogTimer !== undefined) window.clearTimeout(s.reconnectWatchdogTimer);
  if (s.reconnectTimer !== undefined) window.clearTimeout(s.reconnectTimer);
  s.inviteTimer = undefined;
  s.graceTimer = undefined;
  s.watchdogTimer = undefined;
  s.reconnectWatchdogTimer = undefined;
  s.reconnectTimer = undefined;
  s.retryRequested = false;
}

/** Убираем только свою комнату: уже созданная новая сессия не должна пострадать. */
function teardownRoom(r: LiveKitRoom | null = room): void {
  if (!r) return;
  if (room === r) room = null;
  if (session?.room === r) session.room = undefined;
  const off = roomListeners.get(r);
  if (off) {
    off();
    roomListeners.delete(r);
  }
  for (const publication of r.localParticipant.trackPublications.values()) {
    const track = publication.audioTrack ?? publication.videoTrack;
    try {
      track?.stop();
    } catch {
      /* дорожка уже остановлена */
    }
  }
  void r.disconnect(true).catch(() => undefined).then(() => void r.dispose().catch(() => undefined));
}

function cleanup(s: Session): void {
  if (s.ending) return;
  s.ending = true;
  clearTimers(s);
  stopRinging();
  if (session === s) session = null;
  teardownRoom(s.room ?? (session === null ? room : null));
  s.room = undefined;
  releaseWakeLock(s);
}

function reset(): void {
  session = null;
  update({
    phase: 'idle',
    roomId: undefined,
    callId: undefined,
    video: false,
    peerId: undefined,
    peerName: undefined,
    startedAt: undefined,
    micOn: false,
    camOn: false,
    quality: 'good',
    endedReason: undefined,
    error: undefined,
    audioBlocked: false,
  });
}

function sendHangup(s: Session): void {
  if (!matrix) return;
  const content: CallSignal = {
    call_id: s.callId,
    action: 'hangup',
    party: PARTY,
    ...(s.startedAt ? { duration: Date.now() - s.startedAt } : {}),
  };
  void sendSignal(matrix, s.roomId, content).catch(() => undefined);
}

function finish(reason: string, options: { s?: Session | null; error?: string; signal?: boolean } = {}): void {
  const s = options.s ?? session;
  if (!s || s.ending) return;
  const sendHangupSignal = options.signal === true;
  cleanup(s);
  if (sendHangupSignal) sendHangup(s);
  update({
    phase: 'ended',
    endedReason: reason,
    error: options.error,
    micOn: false,
    camOn: false,
    audioBlocked: false,
  });
  window.setTimeout(() => {
    if (state.phase === 'ended' && state.callId === s.callId) reset();
  }, 2500);
}

function fail(message: string, s?: Session | null): void {
  finish(message, { s, error: message, signal: true });
}

function abort(s: Session): void {
  cleanup(s);
  reset();
}

/* Комната LiveKit. */

function peerInfo(matrixRoom: MatrixRoom | undefined, sender?: string): { peerId?: string; peerName?: string } {
  // В личной комнате это второй участник.
  const member = matrixRoom?.getAvatarFallbackMember();
  return { peerId: sender ?? member?.userId, peerName: member?.name ?? sender };
}

/** Identity других устройств того же человека начинается с его Matrix ID. */
function isOwnIdentity(identity: string): boolean {
  if (!identity) return false;
  const id = matrix?.getUserId();
  return !!id && identity.startsWith(`${id}|`);
}

function hasPeer(r: LiveKitRoom | null): boolean {
  if (!r) return false;
  for (const identity of r.remoteParticipants.keys()) {
    if (!isOwnIdentity(identity)) return true;
  }
  return false;
}

function hasSubscribedAudio(r: LiveKitRoom | null): boolean {
  if (!r) return false;
  for (const [identity, participant] of r.remoteParticipants) {
    if (isOwnIdentity(identity)) continue;
    const publication = participant.getTrackPublication(Track.Source.Microphone);
    if (publication?.audioTrack && !publication.isMuted) return true;
  }
  return false;
}

function clearConnectWatchdog(s: Session): void {
  if (s.watchdogTimer !== undefined) window.clearTimeout(s.watchdogTimer);
  s.watchdogTimer = undefined;
}

function armConnectWatchdog(s: Session): void {
  // Таймер нужен только до первого соединения: позже за-peer'ы следит peer-gone.
  if (!isCurrent(s) || !s.accepted || s.startedAt) return;
  if (hasPeer(room)) {
    clearConnectWatchdog(s);
    return;
  }
  if (s.watchdogTimer !== undefined) return;
  // Если после accept собеседник не появился — завершаем, а не висим в «Соединение…».
  s.watchdogTimer = window.setTimeout(() => {
    if (!isCurrent(s)) return;
    if (hasPeer(room)) {
      clearConnectWatchdog(s);
      return;
    }
    finish('Не удалось соединиться', { s, signal: true });
  }, CONNECT_WATCHDOG_MS);
}

function clearReconnectWatchdog(s: Session): void {
  if (s.reconnectWatchdogTimer !== undefined) window.clearTimeout(s.reconnectWatchdogTimer);
  s.reconnectWatchdogTimer = undefined;
}

function armReconnectWatchdog(s: Session): void {
  if (s.reconnectWatchdogTimer !== undefined) return;
  // 60 с непрерывного переподключения — предел, дальше звонок бесполезен.
  s.reconnectWatchdogTimer = window.setTimeout(() => {
    if (!isCurrent(s)) return;
    if (state.phase !== 'reconnecting' || hasPeer(room)) {
      clearReconnectWatchdog(s);
      return;
    }
    finish('Связь потеряна', { s, signal: true });
  }, RECONNECT_LIMIT_MS);
}

function enterReconnecting(s: Session): void {
  if (!isCurrent(s)) return;
  if (state.phase !== 'reconnecting') s.reconnectStart = Date.now();
  armReconnectWatchdog(s);
  update({ phase: 'reconnecting' });
}

function markActive(s: Session): void {
  if (!isCurrent(s)) return;
  clearConnectWatchdog(s);
  clearReconnectWatchdog(s);
  if (s.peerGone) {
    if (s.graceTimer !== undefined) window.clearTimeout(s.graceTimer);
    s.graceTimer = undefined;
    s.peerGone = false;
  }
  s.retryRequested = false;
  const patch: Partial<CallState> = { phase: 'active', error: undefined };
  // Таймер звонка не сбрасываем при переподключениях.
  if (!s.startedAt) {
    s.startedAt = Date.now();
    patch.startedAt = s.startedAt;
  }
  update(patch);
  requestWakeLock();
}

function maybePeerGone(s: Session, r: LiveKitRoom, identity?: string): void {
  if (identity && isOwnIdentity(identity)) return;
  if (s.peerGone || hasPeer(r)) return;
  if (state.phase !== 'active' && state.phase !== 'connecting' && state.phase !== 'reconnecting') return;
  s.peerGone = true;
  enterReconnecting(s);
  // Даём собеседнику 30 с на возвращение в комнату.
  s.graceTimer = window.setTimeout(() => {
    if (isCurrent(s) && s.peerGone && !hasPeer(room)) finish('Связь потеряна', { s, signal: true });
  }, PEER_GRACE_MS);
}

function scheduleReconnect(s: Session, delay?: number): void {
  if (!isCurrent(s) || s.reconnecting) return;
  if (s.reconnectTimer !== undefined) window.clearTimeout(s.reconnectTimer);
  if (Date.now() - s.reconnectStart >= RECONNECT_LIMIT_MS) {
    finish('Связь потеряна', { s, signal: true });
    return;
  }
  const index = Math.max(0, Math.min(s.reconnectAttempts - 1, RECONNECT_BACKOFF_MS.length - 1));
  s.reconnectTimer = window.setTimeout(() => void reconnect(s), delay ?? RECONNECT_BACKOFF_MS[index]);
}

function beginReconnect(s: Session): void {
  if (!isCurrent(s) || s.reconnecting || s.reconnectTimer !== undefined) return;
  s.reconnectAttempts = 0;
  s.reconnectStart = Date.now();
  armReconnectWatchdog(s);
  scheduleReconnect(s, RECONNECT_BACKOFF_MS[0]);
}

/** Online и return to tab ускоряют retry, но не создают параллельных попыток. */
function retryNow(): void {
  const s = session;
  if (!s || !isCurrent(s)) return;
  if (room && room.state === ConnectionState.Connected) {
    if (state.phase === 'reconnecting') {
      clearReconnectWatchdog(s);
      update({ phase: s.accepted ? 'connecting' : 'outgoing' });
      armConnectWatchdog(s);
    }
    return;
  }
  if (state.phase === 'idle' || state.phase === 'ended' || state.phase === 'incoming') return;
  if (!s.reconnecting && state.phase !== 'reconnecting') enterReconnecting(s);
  if (s.reconnectTimer !== undefined) {
    window.clearTimeout(s.reconnectTimer);
    s.reconnectTimer = undefined;
  }
  if (!s.reconnecting && !s.connecting && Date.now() - s.reconnectStart >= RECONNECT_LIMIT_MS) {
    finish('Связь потеряна', { s, signal: true });
    return;
  }
  if (s.reconnecting || s.connecting) {
    s.retryRequested = true;
    return;
  }
  void reconnect(s);
}

async function reconnect(s: Session): Promise<void> {
  s.reconnectTimer = undefined;
  if (!isCurrent(s) || s.reconnecting) return;
  if (s.connecting) {
    s.retryRequested = true;
    return;
  }
  if (Date.now() - s.reconnectStart >= RECONNECT_LIMIT_MS) {
    finish('Связь потеряна', { s, signal: true });
    return;
  }
  enterReconnecting(s);
  s.reconnecting = true;
  let failure: unknown;
  try {
    s.reconnectAttempts += 1;
    const tokens = await fetchToken(s.roomId, s.callId);
    if (!isCurrent(s)) return;
    await connectRoom(s, tokens.url, tokens.token);
    if (!isCurrent(s)) return;
    await enableMedia(s);
    if (!isCurrent(s)) return;
    s.reconnectAttempts = 0;
  } catch (e) {
    failure = e;
  } finally {
    s.reconnecting = false;
  }
  if (!isCurrent(s)) return;
  const retryRequested = s.retryRequested;
  s.retryRequested = false;
  if (failure !== undefined) {
    if (failure instanceof Error && failure.message === 'Нет доступа к микрофону') fail(failure.message, s);
    else {
      armConnectWatchdog(s);
      scheduleReconnect(s);
    }
  } else if (hasPeer(room)) {
    markActive(s);
  } else {
    clearReconnectWatchdog(s);
    update({ phase: s.accepted ? 'connecting' : 'outgoing' });
    armConnectWatchdog(s);
  }
  // Событие сети пришло во время попытки — сразу после неё пробуем ещё раз.
  if (retryRequested) window.setTimeout(() => retryNow(), 0);
}

function wireRoom(s: Session, r: LiveKitRoom): void {
  const onReconnecting = () => {
    if (isCurrent(s)) enterReconnecting(s);
  };
  const onReconnected = () => {
    if (!isCurrent(s)) return;
    if (hasPeer(r)) markActive(s);
    else update({ phase: s.accepted ? 'connecting' : 'outgoing' });
  };
  const onDisconnected = () => {
    if (!isCurrent(s)) return;
    enterReconnecting(s);
    beginReconnect(s);
  };
  const onParticipantConnected = (participant: { identity: string }) => {
    if (!isCurrent(s)) return;
    bumpTracks();
    if (isOwnIdentity(participant.identity) || !s.peerGone || !hasPeer(r)) return;
    if (s.graceTimer !== undefined) window.clearTimeout(s.graceTimer);
    s.graceTimer = undefined;
    s.peerGone = false;
    markActive(s);
  };
  const onParticipantDisconnected = (participant: { identity: string }) => {
    if (!isCurrent(s)) return;
    bumpTracks();
    maybePeerGone(s, r, participant.identity);
  };
  const onTrackSubscribed = (track: Track, publication: { isMuted?: boolean }, participant: { identity: string }) => {
    if (!isCurrent(s)) return;
    bumpTracks();
    if (track.kind !== Track.Kind.Audio || isOwnIdentity(participant.identity)) return;
    if (track.isMuted || publication?.isMuted) return;
    if (hasSubscribedAudio(room)) markActive(s);
  };
  const onQuality = (quality: ConnectionQuality, participant: { identity: string }) => {
    if (!isCurrent(s) || participant.identity !== r.localParticipant.identity) return;
    if (quality === ConnectionQuality.Excellent || quality === ConnectionQuality.Good) update({ quality: 'good' });
    else if (quality === ConnectionQuality.Poor) update({ quality: 'poor' });
    else if (quality === ConnectionQuality.Lost) update({ quality: 'lost' });
  };
  const onLocalTrack = () => {
    if (isCurrent(s)) bumpTracks();
  };
  const onTrackChange = () => {
    if (isCurrent(s)) bumpTracks();
  };
  const onAudioStatus = () => {
    if (isCurrent(s)) update({ audioBlocked: !r.canPlaybackAudio });
  };

  r.on(RoomEvent.Reconnecting, onReconnecting);
  r.on(RoomEvent.SignalReconnecting, onReconnecting);
  r.on(RoomEvent.Reconnected, onReconnected);
  r.on(RoomEvent.Disconnected, onDisconnected);
  r.on(RoomEvent.ParticipantConnected, onParticipantConnected);
  r.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
  r.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
  r.on(RoomEvent.TrackUnsubscribed, onTrackChange);
  r.on(RoomEvent.TrackMuted, onTrackChange);
  r.on(RoomEvent.TrackUnmuted, onTrackChange);
  r.on(RoomEvent.TrackUnpublished, onTrackChange);
  r.on(RoomEvent.TrackPublished, onTrackChange);
  r.on(RoomEvent.AudioPlaybackStatusChanged, onAudioStatus);
  r.on(RoomEvent.ConnectionQualityChanged, onQuality);
  r.on(RoomEvent.LocalTrackPublished, onLocalTrack);
  r.on(RoomEvent.LocalTrackUnpublished, onLocalTrack);

  const off = () => {
    r.off(RoomEvent.Reconnecting, onReconnecting);
    r.off(RoomEvent.SignalReconnecting, onReconnecting);
    r.off(RoomEvent.Reconnected, onReconnected);
    r.off(RoomEvent.Disconnected, onDisconnected);
    r.off(RoomEvent.ParticipantConnected, onParticipantConnected);
    r.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    r.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
    r.off(RoomEvent.TrackUnsubscribed, onTrackChange);
    r.off(RoomEvent.TrackMuted, onTrackChange);
    r.off(RoomEvent.TrackUnmuted, onTrackChange);
    r.off(RoomEvent.TrackUnpublished, onTrackChange);
    r.off(RoomEvent.TrackPublished, onTrackChange);
    r.off(RoomEvent.AudioPlaybackStatusChanged, onAudioStatus);
    r.off(RoomEvent.ConnectionQualityChanged, onQuality);
    r.off(RoomEvent.LocalTrackPublished, onLocalTrack);
    r.off(RoomEvent.LocalTrackUnpublished, onLocalTrack);
  };
  roomListeners.set(r, off);
}

async function connectRoom(s: Session, url: string, token: string): Promise<void> {
  // Предварительное подключение и accept могут прийти одновременно.
  if (s.connecting) {
    await s.connecting;
    return;
  }
  const task = (async () => {
    const previous = room;
    const r = new LiveKitRoom({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: false,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      videoCaptureDefaults: {
        resolution: VideoPresets.h540.resolution,
        facingMode: 'user',
      },
      publishDefaults: {
        dtx: true,
        red: true,
        simulcast: true,
        audioPreset: AudioPresets.speech,
        videoCodec: 'vp8',
        backupCodec: true,
      },
      reconnectPolicy: {
        nextRetryDelayInMs: (ctx) => ctx.elapsedMs > 60000 ? null : Math.min(300 * 2 ** ctx.retryCount, 3000),
      },
    });
    s.room = r;
    if (isCurrent(s)) room = r;
    wireRoom(s, r);
    try {
      let timeout: number | undefined;
      try {
        await Promise.race([
          r.connect(url, token, { autoSubscribe: true, maxRetries: 3, peerConnectionTimeout: 15000 }),
          new Promise<void>((_resolve, reject) => {
            timeout = window.setTimeout(() => reject(new Error('Не удалось подключиться к звонку')), CONNECT_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timeout !== undefined) window.clearTimeout(timeout);
      }
      // Устаревшая сессия не должна трогать комнату новой — только свой экземпляр.
      if (!isCurrent(s)) {
        teardownRoom(r);
        s.room = undefined;
        return;
      }
      if (previous && previous !== r && room === previous) teardownRoom(previous);
      update({ audioBlocked: !r.canPlaybackAudio });
      bumpTracks();
      if (s.retryRequested) window.setTimeout(() => retryNow(), 0);
    } catch (e) {
      // Гонка таймаута не отменяет r.connect — закрываем только нашу комнату.
      teardownRoom(r);
      s.room = undefined;
      throw e;
    }
  })();
  s.connecting = task;
  try {
    await task;
  } finally {
    if (s.connecting === task) s.connecting = undefined;
  }
}

async function enableMedia(s: Session): Promise<void> {
  const r = s.room ?? room;
  if (!isCurrent(s) || !r || room !== r || r.state !== ConnectionState.Connected) {
    throw new Error('Не удалось подключиться к звонку');
  }
  try {
    const mic = await r.localParticipant.setMicrophoneEnabled(true);
    if (!isCurrent(s)) return;
    if (!mic) throw new Error('Нет доступа к микрофону');
    update({ micOn: true });
  } catch (e) {
    if (isCurrent(s)) fail('Нет доступа к микрофону', s);
    throw e;
  }
  if (s.video) {
    try {
      const cam = await r.localParticipant.setCameraEnabled(true);
      if (cam && isCurrent(s)) update({ camOn: true });
    } catch {
      if (isCurrent(s)) update({ error: 'Не удалось включить камеру', video: false, camOn: false });
    }
  }
  bumpTracks();
}

/** Accept может прийти до завершения warmup — используем уже идущее подключение. */
async function ensureRoomConnected(s: Session): Promise<void> {
  if (s.connecting) await s.connecting;
  if (!isCurrent(s)) return;
  const r = s.room ?? room;
  if (r && room === r && r.state === ConnectionState.Connected) return;
  const tokens = await fetchToken(s.roomId, s.callId);
  if (!isCurrent(s)) return;
  await connectRoom(s, tokens.url, tokens.token);
}

async function activateAccepted(s: Session): Promise<void> {
  if (!isCurrent(s) || s.activating) return;
  s.activating = true;
  try {
    if (s.reconnecting || s.reconnectTimer !== undefined) {
      armConnectWatchdog(s);
      return;
    }
    await ensureRoomConnected(s);
    if (!isCurrent(s)) return;
    await enableMedia(s);
    if (!isCurrent(s)) return;
    if (hasSubscribedAudio(room)) markActive(s);
    else armConnectWatchdog(s);
  } catch (e) {
    if (!isCurrent(s)) return;
    if (e instanceof Error && e.message === 'Нет доступа к микрофону') fail(e.message, s);
    else {
      armConnectWatchdog(s);
      if (!s.reconnecting && s.reconnectTimer === undefined) beginReconnect(s);
    }
  } finally {
    s.activating = false;
  }
}

async function warmup(s: Session): Promise<void> {
  try {
    const tokens = await fetchToken(s.roomId, s.callId);
    if (!isCurrent(s)) return;
    await connectRoom(s, tokens.url, tokens.token);
    if (!isCurrent(s)) return;
    if (s.accepted) await activateAccepted(s);
  } catch (e) {
    if (!isCurrent(s)) return;
    // До accept обрыв не должен срывать звонок: ответ всё ещё может прийти.
    enterReconnecting(s);
    beginReconnect(s);
    update({ error: errorText(e) });
  }
}

/* Сигналы Matrix. */

async function sendBusy(ev: CallSignalEvent): Promise<void> {
  if (!matrix) return;
  try {
    await sendSignal(matrix, ev.roomId, { call_id: ev.content.call_id, action: 'busy', party: PARTY });
  } catch {
    /* не удалось сообщить о занятости */
  }
}

function incoming(ev: CallSignalEvent): void {
  if (!matrix) return;
  const s = createSession(ev.roomId, ev.content.call_id, 'incoming', ev.content.video ?? false,
    peerInfo(matrix.getRoom(ev.roomId) ?? undefined, ev.sender));
  session = s;
  update({
    phase: 'incoming',
    roomId: s.roomId,
    callId: s.callId,
    video: s.video,
    peerId: s.peerId,
    peerName: s.peerName,
    micOn: false,
    camOn: false,
    quality: 'good',
    endedReason: undefined,
    error: undefined,
    audioBlocked: false,
  });
  startRinging('incoming');
  requestWakeLock();
  const lifetime = ev.content.lifetime ?? 60000;
  s.inviteTimer = window.setTimeout(() => {
    if (isCurrent(s) && state.phase === 'incoming') finish('Пропущенный', { s });
  }, Math.max(0, ev.ts + lifetime - Date.now()));
}

/** Коллизия: приглашение в ту же комнату во время исходящего звонка. */
function handleGlare(ev: CallSignalEvent, s: Session): boolean {
  if (ev.content.action !== 'invite' || ev.fromThisParty || s.direction !== 'outgoing') return false;
  if (state.phase !== 'outgoing' || s.roomId !== ev.roomId) return false;
  // Выигрывает звонок с меньшим call_id: иначе ждём, что примут наш.
  if (s.callId <= ev.content.call_id) return true;
  const video = s.video;
  cleanup(s);
  if (matrix) {
    void sendSignal(matrix, s.roomId, { call_id: s.callId, action: 'hangup', party: PARTY })
      .catch(() => undefined);
  }
  incoming(ev);
  void accept(video);
  return true;
}

function onSignal(ev: CallSignalEvent): void {
  const s = session;
  if (!s) {
    if (!ev.own && !ev.fromThisParty && ev.content.action === 'invite') {
      if (isBusy()) void sendBusy(ev);
      else incoming(ev);
    }
    return;
  }
  if (ev.fromThisParty) return;
  if (handleGlare(ev, s)) return;

  if (ev.content.call_id !== s.callId) {
    if (!ev.own && ev.content.action === 'invite') {
      if (isBusy()) void sendBusy(ev);
      else incoming(ev);
    }
    return;
  }

  // Другое устройство того же человека уже приняло звонок: наше устройство выходит.
  if (ev.own && ev.content.action === 'accept' && s.direction === 'incoming' && state.phase !== 'idle') {
    cleanup(s);
    reset();
    update({ endedReason: 'Принят на другом устройстве' });
    return;
  }

  // Другая вкладка того же пользователя уже ответила — звонить больше не нужно.
  if (ev.own) {
    if ((ev.content.action === 'accept' || ev.content.action === 'reject')
      && (state.phase === 'incoming' || state.phase === 'outgoing')) abort(s);
    return;
  }
  if (ev.content.action !== 'accept' && s.peerId && ev.sender !== s.peerId) return;

  switch (ev.content.action) {
    case 'accept':
      if (s.direction === 'outgoing' && !s.accepted
        && (state.phase === 'outgoing' || state.phase === 'connecting' || state.phase === 'reconnecting')) {
        s.accepted = true;
        if (s.inviteTimer !== undefined) window.clearTimeout(s.inviteTimer);
        s.inviteTimer = undefined;
        s.peerId = s.peerId ?? ev.sender;
        update({ phase: 'connecting', peerId: s.peerId, peerName: s.peerName ?? ev.sender });
        armConnectWatchdog(s);
        void activateAccepted(s);
      }
      break;
    case 'reject':
      if (s.direction === 'outgoing' && !s.accepted) finish('Отклонён', { s });
      break;
    case 'busy':
      if (s.direction === 'outgoing' && !s.accepted) finish('Занято', { s });
      break;
    case 'hangup':
      if (state.phase === 'incoming') finish('Пропущенный', { s });
      else if (s.direction === 'outgoing' && !s.accepted) finish('Отменён', { s });
      else finish('Звонок завершён', { s });
      break;
    case 'invite':
      break;
  }
}

/* Публичное API. */

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): CallState {
  return state;
}

export function getRoom(): LiveKitRoom | null {
  return room;
}

export function useCall(): CallState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function attach(client: MatrixClient): void {
  if (matrix === client && unsubscribeSignals) return;
  detach();
  matrix = client;
  unsubscribeSignals = subscribeSignals(client, onSignal);
  if (!globalListenersAttached) {
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    globalListenersAttached = true;
  }
}

export function detach(): void {
  unsubscribeSignals?.();
  unsubscribeSignals = null;
  matrix = null;
  if (session) cleanup(session);
  if (globalListenersAttached) {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    globalListenersAttached = false;
  }
  reset();
}

export async function start(roomId: string, video: boolean): Promise<void> {
  if (!matrix || isBusy()) return;
  const s = createSession(roomId, `call-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    'outgoing', video, peerInfo(matrix.getRoom(roomId) ?? undefined));
  session = s;
  update({
    phase: 'outgoing',
    roomId: s.roomId,
    callId: s.callId,
    video: s.video,
    peerId: s.peerId,
    peerName: s.peerName,
    micOn: false,
    camOn: false,
    quality: 'good',
    endedReason: undefined,
    error: undefined,
    audioBlocked: false,
  });
  startRinging('outgoing');
  requestWakeLock();

  // Приглашение и подключение к медиа идут одновременно.
  void sendSignal(matrix, roomId, {
    call_id: s.callId,
    action: 'invite',
    video,
    lifetime: 60000,
    party: PARTY,
  }).catch((e: unknown) => {
    if (isCurrent(s)) fail(errorText(e), s);
  });
  void warmup(s);

  const checkNoAnswer = () => {
    if (!isCurrent(s) || s.accepted) return;
    // Фаза connect/reconnect без accept тоже считается отсутствием ответа.
    if (matrix) {
      void sendSignal(matrix, s.roomId, { call_id: s.callId, action: 'hangup', party: PARTY })
        .catch(() => undefined);
    }
    finish('Нет ответа', { s });
  };
  s.inviteTimer = window.setTimeout(checkNoAnswer, 45000);
}

export async function accept(video: boolean): Promise<void> {
  const s = session;
  if (!s || !matrix || s.direction !== 'incoming' || state.phase !== 'incoming') return;
  s.accepted = true;
  s.video = video;
  if (s.inviteTimer !== undefined) window.clearTimeout(s.inviteTimer);
  s.inviteTimer = undefined;
  update({ phase: 'connecting', video, camOn: false });
  armConnectWatchdog(s);
  void activateAccepted(s);
  try {
    await sendSignal(matrix, s.roomId, { call_id: s.callId, action: 'accept', video, party: PARTY });
  } catch (e) {
    if (isCurrent(s)) fail(errorText(e), s);
  }
}

export async function reject(): Promise<void> {
  const s = session;
  if (!s || !matrix || s.direction !== 'incoming' || state.phase !== 'incoming') return;
  try {
    await sendSignal(matrix, s.roomId, { call_id: s.callId, action: 'reject', party: PARTY });
  } catch {
    /* всё равно завершаем входящий звонок */
  }
  finish('Отклонён', { s });
}

export async function hangup(): Promise<void> {
  finish('Завершён', { signal: true });
}

export async function toggleMic(): Promise<void> {
  const s = session;
  const r = room;
  if (!s || !r || !isCurrent(s)) return;
  const next = !state.micOn;
  try {
    await r.localParticipant.setMicrophoneEnabled(next);
    if (isCurrent(s)) update({ micOn: next });
  } catch {
    if (isCurrent(s)) update({ error: 'Не удалось переключить микрофон' });
  }
}

export async function toggleCam(): Promise<void> {
  const s = session;
  const r = room;
  if (!s || !r || !isCurrent(s)) return;
  const next = !state.camOn;
  try {
    await r.localParticipant.setCameraEnabled(next);
    if (isCurrent(s)) update({ camOn: next });
  } catch {
    if (isCurrent(s)) update({ error: 'Не удалось переключить камеру' });
  }
}

export async function flipCamera(): Promise<void> {
  const s = session;
  const r = room;
  if (!s || !r || !isCurrent(s) || !state.camOn) return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    if (devices.length < 2) return;
    const currentId = r.localParticipant.getTrackPublication(Track.Source.Camera)
      ?.videoTrack?.mediaStreamTrack.getSettings().deviceId;
    const index = devices.findIndex((d) => d.deviceId === currentId);
    const next = devices[(index + 1) % devices.length];
    const changed = await r.switchActiveDevice('videoinput', next.deviceId);
    if (isCurrent(s)) update({ error: changed ? undefined : 'Не удалось переключить камеру' });
  } catch {
    if (isCurrent(s)) update({ error: 'Не удалось переключить камеру' });
  }
}

/** Пользовательский жест для снятия блокировки автовоспроизведения. */
export async function startAudio(): Promise<void> {
  const r = room;
  if (!r) return;
  try {
    await r.startAudio();
    update({ audioBlocked: false });
  } catch {
    /* браузер всё ещё запрещает звук */
  }
}
