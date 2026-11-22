import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { sendImage, sendText, sendVoice } from '../lib/send';
import { formatDuration } from '../lib/events';
import { isVoiceRecordingSupported, VoiceRecorder } from '../lib/voice/recorder';
import { Button, Icon, toast } from '../components/ui';

const CANCEL_DX = 90;
const LOCK_DY = 70;
const MIN_VOICE_MS = 700;
const DRAFT_KEY = (roomId: string) => `rl.draft.${roomId}`;

type RecState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording'; locked: boolean; dx: number; dy: number };

const coarsePointer = () => window.matchMedia('(pointer: coarse)').matches;
const vibrate = (ms: number) => navigator.vibrate?.(ms);

async function micPermission(): Promise<PermissionState | 'unknown'> {
  try {
    return (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state;
  } catch {
    return 'unknown';
  }
}

export function Composer({ client, room }: { client: MatrixClient; room: Room }) {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(DRAFT_KEY(room.roomId)) ?? '';
    } catch {
      return '';
    }
  });
  const [rec, setRec] = useState<RecState>({ kind: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<VoiceRecorder | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const released = useRef(false);
  const typingTimer = useRef(0);
  const voiceOk = isVoiceRecordingSupported();

  // черновик на комнату
  useEffect(() => {
    try {
      if (text) localStorage.setItem(DRAFT_KEY(room.roomId), text);
      else localStorage.removeItem(DRAFT_KEY(room.roomId));
    } catch {
      /* приватный режим */
    }
  }, [text, room.roomId]);

  // авто-высота поля
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  // таймер записи
  useEffect(() => {
    if (rec.kind !== 'recording') return;
    const t = window.setInterval(() => setElapsed(recorder.current?.elapsedMs() ?? 0), 200);
    return () => clearInterval(t);
  }, [rec.kind]);

  // уходим из комнаты посреди записи — запись выбрасываем
  useEffect(() => () => void recorder.current?.cancel(), []);

  const typing = (on: boolean) => {
    clearTimeout(typingTimer.current);
    if (on) {
      client.sendTyping(room.roomId, true, 6000).catch(() => {});
      typingTimer.current = window.setTimeout(() => client.sendTyping(room.roomId, false, 0).catch(() => {}), 5000);
    } else {
      client.sendTyping(room.roomId, false, 0).catch(() => {});
    }
  };

  const submitText = () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    typing(false);
    sendText(client, room.roomId, body).catch((e) => console.warn('send failed (shown in timeline)', e));
    window.dispatchEvent(new Event('rl:sent'));
    textarea.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // на телефоне Enter — перенос строки, отправка кнопкой
    if (e.key === 'Enter' && !e.shiftKey && !coarsePointer() && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submitText();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      files.forEach((f) => sendImage(client, room.roomId, f));
      window.dispatchEvent(new Event('rl:sent'));
    }
  };

  const pickFiles = (files: FileList | null) => {
    [...(files ?? [])].filter((f) => f.type.startsWith('image/')).forEach((f) => sendImage(client, room.roomId, f));
    if (fileInput.current) fileInput.current.value = '';
    window.dispatchEvent(new Event('rl:sent'));
  };

  /* ---------- голосовые ---------- */

  const finish = async (send: boolean) => {
    const r = recorder.current;
    recorder.current = null;
    setRec({ kind: 'idle' });
    setLevels([]);
    setElapsed(0);
    if (!r) return;
    if (!send) {
      await r.cancel();
      return;
    }
    if (r.elapsedMs() < MIN_VOICE_MS) {
      await r.cancel();
      toast('Удерживайте кнопку, чтобы записать');
      return;
    }
    try {
      const recording = await r.stop();
      sendVoice(client, room.roomId, recording);
      window.dispatchEvent(new Event('rl:sent'));
    } catch (e) {
      console.error(e);
      toast('Не удалось записать голосовое', { variant: 'error' });
    }
  };

  const startRecording = async () => {
    const perm = await micPermission();
    if (perm === 'prompt' || perm === 'unknown') {
      // первый раз: только спрашиваем разрешение — диалог браузера сорвал бы удержание кнопки
      if (perm === 'prompt') {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach((t) => t.stop());
          toast('Микрофон разрешён — теперь удерживайте кнопку');
        } catch {
          toast('Нет доступа к микрофону', { variant: 'error' });
        }
        return;
      }
    }
    if (perm === 'denied') {
      toast('Доступ к микрофону запрещён в настройках браузера', { variant: 'error' });
      return;
    }

    released.current = false;
    setRec({ kind: 'starting' });
    const r = new VoiceRecorder();
    r.onLevel = (l) => setLevels((prev) => [...prev.slice(-31), l]);
    r.onLimit = () => void finish(true);
    try {
      await r.start();
    } catch (e) {
      console.error(e);
      setRec({ kind: 'idle' });
      toast('Нет доступа к микрофону', { variant: 'error' });
      return;
    }
    recorder.current = r;
    vibrate(20);
    if (released.current) {
      // отпустили, пока поднимался микрофон
      void finish(false);
      toast('Удерживайте кнопку, чтобы записать');
      return;
    }
    setRec({ kind: 'recording', locked: false, dx: 0, dy: 0 });
  };

  const onMicDown = (e: RPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || rec.kind !== 'idle') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = { x: e.clientX, y: e.clientY };
    void startRecording();
  };

  const onMicMove = (e: RPointerEvent<HTMLButtonElement>) => {
    if (rec.kind !== 'recording' || rec.locked) return;
    const dx = Math.min(0, e.clientX - origin.current.x);
    const dy = Math.min(0, e.clientY - origin.current.y);
    if (-dx > CANCEL_DX) {
      vibrate(40);
      void finish(false);
      return;
    }
    if (-dy > LOCK_DY) {
      vibrate(20);
      setRec({ kind: 'recording', locked: true, dx: 0, dy: 0 });
      return;
    }
    setRec({ kind: 'recording', locked: false, dx, dy });
  };

  const onMicUp = () => {
    if (rec.kind === 'starting') {
      released.current = true;
      return;
    }
    if (rec.kind === 'recording' && !rec.locked) void finish(true);
  };

  const onMicCancel = () => {
    if (rec.kind === 'starting') released.current = true;
    if (rec.kind === 'recording' && !rec.locked) void finish(false);
  };

  const recording = rec.kind === 'recording';
  const showSend = text.trim().length > 0 || !voiceOk;

  return (
    <div className={`composer${recording ? ' composer--recording' : ''}`}>
      {recording ? (
        <div className="rec-bar" aria-live="polite">
          <span className="rec-bar__dot" />
          <span className="rec-bar__time">{formatDuration(elapsed)}</span>
          <span className="rec-bar__levels" aria-hidden="true">
            {levels.map((l, i) => <span key={i} style={{ height: `${Math.max(10, l * 100)}%` }} />)}
          </span>
          {rec.locked ? (
            <Button variant="ghost" size="sm" onClick={() => void finish(false)} aria-label="Удалить запись">
              <Icon name="trash" size={18} />
            </Button>
          ) : (
            <span className="rec-bar__hint" style={{ transform: `translateX(${rec.dx * 0.6}px)`, opacity: 1 + rec.dx / CANCEL_DX }}>
              <Icon name="back" size={14} /> влево — отмена
            </span>
          )}
        </div>
      ) : (
        <>
          <Button variant="ghost" icon aria-label="Отправить фото" onClick={() => fileInput.current?.click()}>
            <Icon name="image" />
          </Button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => pickFiles(e.target.files)} />
          <textarea
            ref={textarea}
            className="composer__input"
            rows={1}
            placeholder="Сообщение"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (e.target.value) typing(true);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => typing(false)}
            enterKeyHint={coarsePointer() ? 'enter' : 'send'}
            aria-label="Сообщение"
          />
        </>
      )}

      {showSend && !recording ? (
        <Button variant="primary" icon round aria-label="Отправить" onClick={submitText} disabled={!text.trim()}>
          <Icon name="send" />
        </Button>
      ) : recording && rec.locked ? (
        <Button variant="primary" icon round aria-label="Отправить голосовое" onClick={() => void finish(true)}>
          <Icon name="send" />
        </Button>
      ) : (
        <div className="mic-wrap">
          {recording && (
            <span className="mic-lock" style={{ transform: `translateY(${rec.dy * 0.5}px)` }} aria-hidden="true">
              <Icon name="lock" size={16} />
              <Icon name="chevronUp" size={14} />
            </span>
          )}
          <button
            type="button"
            className={`mic-btn${recording ? ' is-recording' : ''}${rec.kind === 'starting' ? ' is-starting' : ''}`}
            aria-label="Удерживайте для записи голосового"
            onPointerDown={onMicDown}
            onPointerMove={onMicMove}
            onPointerUp={onMicUp}
            onPointerCancel={onMicCancel}
            onContextMenu={(e) => e.preventDefault()}
            style={recording && !rec.locked ? { transform: `translate(${rec.dx}px, 0) scale(1.35)` } : undefined}
          >
            <Icon name="mic" />
          </button>
        </div>
      )}
    </div>
  );
}
