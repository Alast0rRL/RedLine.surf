import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { sendFile, sendImage, sendText, sendVoice } from '../lib/send';
import { plainBody, sendEdit, sendReply } from '../lib/messageActions';
import { previewText } from '../lib/events';
import { formatDuration } from '../lib/events';
import { isVoiceRecordingSupported, VoiceRecorder } from '../lib/voice/recorder';
import { Avatar, Button, Icon, toast } from '../components/ui';
import { buildMentionContent, mentionCandidates } from '../lib/mentions';
import './room.css';

export const MAX_LEN = 2000;
const COUNTER_FROM = 1800;
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

export type ComposerContext = { kind: 'reply' | 'edit'; ev: MatrixEvent } | null;

export function Composer({ client, room, context, onClearContext }: {
  client: MatrixClient;
  room: Room;
  context: ComposerContext;
  onClearContext: () => void;
}) {
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
  const attachInput = useRef<HTMLInputElement>(null);
  const draftBeforeEdit = useRef<string | null>(null);
  const editing = context?.kind === 'edit' ? context.ev : null;
  const replying = context?.kind === 'reply' ? context.ev : null;
  const recorder = useRef<VoiceRecorder | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const released = useRef(false);
  const typingTimer = useRef(0);
  // «@» в группе: список участников по тексту до курсора
  const [caret, setCaret] = useState(0);
  const [mentionOff, setMentionOff] = useState(false);
  const [mentionIdx, setMentionIdx] = useState(0);
  const me = client.getUserId() ?? '';
  const isGroup = room.getJoinedMemberCount() > 2;
  const mentionCtx = !isGroup || editing || mentionOff ? null : /(^|s)@([^s@]*)$/.exec(text.slice(0, caret));
  const mentionQuery = mentionCtx ? mentionCtx[2] : null;
  const candidates = useMemo(
    () => (mentionQuery === null ? [] : mentionCandidates(room, me, mentionQuery)),
    // состав комнаты читаем при каждом изменении запроса
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, me, mentionQuery],
  );
  const mentionOpen = candidates.length > 0;
  useEffect(() => setMentionIdx(0), [mentionQuery]);
  const pickMention = (i: number) => {
    const c = candidates[i];
    if (!c || !mentionCtx) return;
    const start = mentionCtx.index + mentionCtx[1].length;
    const next = `${text.slice(0, start)}@${c.name} ${text.slice(caret)}`.slice(0, MAX_LEN);
    const pos = Math.min(start + c.name.length + 2, next.length);
    setText(next);
    setCaret(pos);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(pos, pos);
    });
  };
  const voiceOk = isVoiceRecordingSupported();

  // черновик на комнату
  useEffect(() => {
    if (editing) return;
    try {
      if (text) localStorage.setItem(DRAFT_KEY(room.roomId), text);
      else localStorage.removeItem(DRAFT_KEY(room.roomId));
    } catch {
      /* приватный режим */
    }
  }, [text, room.roomId, editing]);

  // вход в режим правки: подставляем текст; выход — возвращаем черновик
  const editId = editing?.getId();
  useEffect(() => {
    if (!editing) return;
    setText((cur) => {
      if (draftBeforeEdit.current === null) draftBeforeEdit.current = cur;
      return plainBody(editing).slice(0, MAX_LEN);
    });
    textarea.current?.focus();
    return () => {
      if (draftBeforeEdit.current !== null) {
        setText(draftBeforeEdit.current);
        draftBeforeEdit.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  const replyId = replying?.getId();
  useEffect(() => {
    if (replyId) textarea.current?.focus();
  }, [replyId]);

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

  const tooLong = text.length > MAX_LEN;

  const submitText = () => {
    const body = text.trim();
    if (!body || tooLong) return;
    typing(false);
    if (editing) {
      // без изменений — просто выходим
      if (body !== plainBody(editing).trim()) {
        sendEdit(client, room.roomId, editing, body).catch(() => toast('Не удалось изменить сообщение', { variant: 'error' }));
      }
      draftBeforeEdit.current = draftBeforeEdit.current ?? '';
      onClearContext();
      return;
    }
    const mention = isGroup ? buildMentionContent(room, me, body) : null;
    setText('');
    if (replying?.getId()) {
      sendReply(client, room.roomId, body, replying.getId()!, mention ?? undefined).catch((e) => console.warn('send failed (shown in timeline)', e));
      onClearContext();
    } else {
      sendText(client, room.roomId, body, mention ?? undefined).catch((e) => console.warn('send failed (shown in timeline)', e));
    }
    window.dispatchEvent(new Event('rl:sent'));
    textarea.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = candidates.length;
        setMentionIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(mentionIdx);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionOff(true);
        return;
      }
    }
    if (e.key === 'Escape' && context) {
      e.preventDefault();
      onClearContext();
      return;
    }
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

  // одна кнопка «Прикрепить»: фото — как фото, видео — m.video, остальное — файл
  const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'];
  const pickAnyFiles = (files: FileList | null) => {
    [...(files ?? [])].forEach((f) => (PHOTO_TYPES.includes(f.type) ? sendImage(client, room.roomId, f) : sendFile(client, room.roomId, f)));
    if (attachInput.current) attachInput.current.value = '';
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
  const showSend = text.trim().length > 0 || !voiceOk || !!editing;

  const ctxTarget = editing ?? replying;
  const ctxWho = replying ? (replying.sender?.name ?? replying.getSender() ?? '') : '';

  return (
    <div className="composer-box">
      {ctxTarget && !recording && (
        <div className="composer-ctx" role="group" aria-label={editing ? 'Редактирование' : 'Ответ'}>
          <span className="composer-ctx__bar" aria-hidden="true" />
          <span className="composer-ctx__text">
            <span className="composer-ctx__title">{editing ? 'Редактирование' : ctxWho}</span>
            <span className="composer-ctx__preview">{editing ? previewText(editing).split('\n')[0] : previewText(ctxTarget).split('\n')[0]}</span>
          </span>
          <Button variant="ghost" size="sm" icon onClick={onClearContext} aria-label={editing ? 'Отменить редактирование' : 'Отменить ответ'}>
            <Icon name="close" size={18} />
          </Button>
        </div>
      )}
      {mentionOpen && !recording && (
        <ul className="mention-list" role="listbox" aria-label="Упомянуть участника">
          {candidates.map((c, i) => (
            <li key={c.member.userId} role="option" aria-selected={i === mentionIdx}>
              <button
                type="button"
                className={`mention-item${i === mentionIdx ? ' is-active' : ''}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => pickMention(i)}
              >
                <Avatar client={client} name={c.name} seed={c.member.userId} mxc={c.member.getMxcAvatarUrl()} size="sm" />
                <span className="mention-item__name">{c.name}</span>
                <span className="mention-item__id">{c.member.userId}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {text.length >= COUNTER_FROM && !recording && (
        <div className={`composer-count${text.length >= MAX_LEN ? ' is-max' : ''}`} aria-live="polite">{text.length}/{MAX_LEN}</div>
      )}
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
          <Button variant="ghost" icon aria-label="Прикрепить" onClick={() => attachInput.current?.click()}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.7 1.7 0 0 1-2.4-2.4l8.3-8.3" />
            </svg>
          </Button>
          <input ref={attachInput} type="file" multiple hidden onChange={(e) => pickAnyFiles(e.target.files)} />
          <textarea
            ref={textarea}
            className="composer__input"
            rows={1}
            placeholder="Сообщение"
            value={text}
            maxLength={MAX_LEN}
            onChange={(e) => {
              const v = e.target.value.slice(0, MAX_LEN);
              setText(v);
              setCaret(e.target.selectionStart ?? v.length);
              setMentionOff(false);
              if (v && !editing) typing(true);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => typing(false)}
            enterKeyHint={coarsePointer() ? 'enter' : 'send'}
            aria-label="Сообщение"
          />
        </>
      )}

      {showSend && !recording ? (
        <Button variant="primary" icon round aria-label={editing ? 'Сохранить' : 'Отправить'} onClick={submitText} disabled={!text.trim() || tooLong}>
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
    </div>
  );
}
