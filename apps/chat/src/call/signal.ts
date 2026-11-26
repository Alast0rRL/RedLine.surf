import {
  MatrixEventEvent,
  RoomEvent,
  type IRoomTimelineData,
  type MatrixClient,
  type MatrixEvent,
  type Room as MatrixRoom,
} from 'matrix-js-sdk';

/** Тип события Matrix, которым передаём сигналы звонка. */
export const CALL_EVENT = 'surf.redline.call';

/** Содержание сигнального события звонка. */
export interface CallSignal {
  call_id: string;
  action: 'invite' | 'accept' | 'reject' | 'hangup' | 'busy';
  video?: boolean;
  /** Время жизни приглашения, мс (только invite). */
  lifetime?: number;
  /** Длительность состоявшегося звонка, мс (только hangup). */
  duration?: number;
  /** Идентификатор вкладки, от которой пришёл сигнал. */
  party: string;
}

/** Идентификатор вкладки: позволяет отличать свои события от другой вкладки. */
export const PARTY = (() => {
  const fallback = () => `tab-${Math.random().toString(36).slice(2)}`;
  try {
    return globalThis.crypto?.randomUUID?.() ?? fallback();
  } catch {
    return fallback();
  }
})();

/** Сигнал в удобном для CallManager виде. */
export interface CallSignalEvent {
  roomId: string;
  sender: string;
  own: boolean;
  fromThisParty: boolean;
  ts: number;
  content: CallSignal;
}

const ACTIONS: CallSignal['action'][] = ['invite', 'accept', 'reject', 'hangup', 'busy'];
const MAX_SEEN_IDS = 500;
const INVITE_DEBOUNCE_MS = 300;

function readSignal(raw: unknown): CallSignal | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<CallSignal>;
  if (typeof c.call_id !== 'string' || typeof c.party !== 'string') return null;
  if (!ACTIONS.includes(c.action as CallSignal['action'])) return null;
  return c as CallSignal;
}

export async function sendSignal(client: MatrixClient, roomId: string, content: CallSignal): Promise<void> {
  await client.sendEvent(roomId, CALL_EVENT as any, content);
}

/** Подписка на живые сигнальные события комнаты. */
export function subscribeSignals(client: MatrixClient, handler: (ev: CallSignalEvent) => void): () => void {
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  const pending = new Map<MatrixEvent, () => void>();
  const pendingInvites = new Map<string, number>();

  const markSeen = (id: string): boolean => {
    if (seen.has(id)) return false;
    if (seenOrder.length >= MAX_SEEN_IDS) {
      const oldest = seenOrder.shift();
      if (oldest) seen.delete(oldest);
    }
    seen.add(id);
    seenOrder.push(id);
    return true;
  };

  const cancelInvite = (callId: string): void => {
    const timer = pendingInvites.get(callId);
    if (timer !== undefined) window.clearTimeout(timer);
    pendingInvites.delete(callId);
  };

  const process = (event: MatrixEvent, room: MatrixRoom): void => {
    const id = event.getId();
    // Таймлайн и расшифровка могут принести одно и то же событие дважды.
    if (id && seen.has(id)) return;
    // Тип проверяем после расшифровки: до неё тип может быть «m.room.encrypted».
    if (event.getType() !== CALL_EVENT) return;
    const content = readSignal(event.getContent());
    if (!content) return;
    if (id) markSeen(id);

    const ts = event.getTs() || Date.now();
    // Возраст event.getLocalAge() учитывает задержку доставки и расшифровки.
    const age = typeof event.getLocalAge === 'function' ? event.getLocalAge() : Date.now() - ts;
    // Просроченные приглашения игнорируем, чтобы не звонить по старым событиям.
    if (content.action === 'invite' && age > (content.lifetime ?? 60000)) return;

    const ev: CallSignalEvent = {
      roomId: room.roomId || event.getRoomId() || '',
      sender: event.getSender() || '',
      own: !!client.getUserId() && event.getSender() === client.getUserId(),
      fromThisParty: content.party === PARTY,
      ts,
      content,
    };
    if (content.action === 'invite') {
      // Ответ/отбой, пришедший в эти 300 мс, отменяет доставку приглашения.
      cancelInvite(content.call_id);
      const timer = window.setTimeout(() => {
        pendingInvites.delete(content.call_id);
        handler(ev);
      }, INVITE_DEBOUNCE_MS);
      pendingInvites.set(content.call_id, timer);
      return;
    }
    if (content.action === 'accept' || content.action === 'reject' || content.action === 'hangup') {
      cancelInvite(content.call_id);
    }
    handler(ev);
  };

  const onTimeline = (
    event: MatrixEvent,
    room: MatrixRoom | undefined,
    toStart: boolean | undefined,
    _removed: boolean,
    data: IRoomTimelineData,
  ): void => {
    if (!room || toStart || !data?.liveEvent) return;
    if (event.isBeingDecrypted() || event.shouldAttemptDecryption()) {
      if (pending.has(event)) return;
      const onDecrypted = () => {
        event.off(MatrixEventEvent.Decrypted, onDecrypted);
        pending.delete(event);
        process(event, room);
      };
      pending.set(event, onDecrypted);
      event.once(MatrixEventEvent.Decrypted, onDecrypted);
      return;
    }
    process(event, room);
  };

  client.on(RoomEvent.Timeline, onTimeline);
  return () => {
    client.off(RoomEvent.Timeline, onTimeline);
    pending.forEach((cb, event) => event.off(MatrixEventEvent.Decrypted, cb));
    pending.clear();
    pendingInvites.forEach((timer) => window.clearTimeout(timer));
    pendingInvites.clear();
  };
}
