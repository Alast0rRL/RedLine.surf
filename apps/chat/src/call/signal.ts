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
  const pending = new Map<MatrixEvent, () => void>();

  const process = (event: MatrixEvent, room: MatrixRoom): void => {
    const id = event.getId();
    // Таймлайн и расшифровка могут принести одно и то же событие дважды.
    if (id && seen.has(id)) return;
    // Тип проверяем после расшифровки: до неё тип может быть «m.room.encrypted».
    if (event.getType() !== CALL_EVENT) return;
    const content = readSignal(event.getContent());
    if (!content) return;
    if (id) seen.add(id);

    const ts = event.getTs() || Date.now();
    // Просроченные приглашения игнорируем, чтобы не звонить по старым событиям.
    if (content.action === 'invite' && ts + (content.lifetime ?? 60000) < Date.now()) return;

    handler({
      roomId: room.roomId || event.getRoomId() || '',
      sender: event.getSender() || '',
      own: !!client.getUserId() && event.getSender() === client.getUserId(),
      fromThisParty: content.party === PARTY,
      ts,
      content,
    });
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
  };
}
