import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { KnownMembership, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { Avatar, Button, Modal, toast } from '../components/ui';
import { isDirectRoom } from '../hooks/useRoomList';
import {
  QUICK_REACTIONS,
  canDelete,
  canEdit,
  deleteMessage,
  forwardEvent,
  isTextMessage,
  plainBody,
  toggleReaction,
} from '../lib/messageActions';
import { roomAvatarMxc } from '../screens/ChatList';
import './room.css';

export interface MenuPoint {
  x: number;
  y: number;
}

const MARGIN = 8;

interface MenuProps {
  client: MatrixClient;
  room: Room;
  ev: MatrixEvent;
  point: MenuPoint;
  onClose: () => void;
  onReply: (ev: MatrixEvent) => void;
  onEdit: (ev: MatrixEvent) => void;
  onForward: (ev: MatrixEvent) => void;
  onDelete: (ev: MatrixEvent) => void;
}

/** Меню действий над сообщением: быстрые реакции + список. Закрывается по Esc и тапу снаружи. */
export function MessageMenu({ client, room, ev, point, onClose, onReply, onEdit, onForward, onDelete }: MenuProps) {
  const me = client.getUserId() ?? '';
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const items: { key: string; label: string; danger?: boolean; run: () => void }[] = [];
  items.push({ key: 'reply', label: 'Ответить', run: () => onReply(ev) });
  if (canEdit(ev, me)) items.push({ key: 'edit', label: 'Изменить', run: () => onEdit(ev) });
  if (isTextMessage(ev)) {
    items.push({
      key: 'copy',
      label: 'Копировать',
      run: () => {
        navigator.clipboard?.writeText(plainBody(ev)).then(
          () => toast('Скопировано'),
          () => toast('Не удалось скопировать', { variant: 'error' }),
        );
      },
    });
  }
  items.push({ key: 'forward', label: 'Переслать', run: () => onForward(ev) });
  if (canDelete(ev, me)) items.push({ key: 'delete', label: 'Удалить', danger: true, run: () => onDelete(ev) });

  // позиция: у точки нажатия, но целиком внутри экрана
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const left = Math.max(MARGIN, Math.min(point.x, vw - width - MARGIN));
    let top = point.y + 4;
    if (top + height > vh - MARGIN) top = Math.max(MARGIN, point.y - height - 4);
    setPos({ left, top: Math.max(MARGIN, Math.min(top, vh - height - MARGIN)) });
  }, [point.x, point.y]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    let n = -1;
    if (e.key === 'ArrowDown') n = (i + 1) % nodes.length;
    else if (e.key === 'ArrowUp') n = (i - 1 + nodes.length) % nodes.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = nodes.length - 1;
    else if (e.key === 'Tab') {
      e.preventDefault();
      n = (i + (e.shiftKey ? -1 : 1) + nodes.length) % nodes.length;
    }
    if (n >= 0) {
      e.preventDefault();
      nodes[n]?.focus();
    }
  };

  return createPortal(
    <div className="msg-menu-backdrop" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        ref={ref}
        className="msg-menu"
        role="menu"
        aria-label="Действия с сообщением"
        style={{ left: pos?.left ?? point.x, top: pos?.top ?? point.y, visibility: pos ? 'visible' : 'hidden' }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onMenuKey}
      >
        <div className="msg-menu__reactions">
          {QUICK_REACTIONS.map((k) => (
            <button
              key={k}
              type="button"
              role="menuitem"
              className="msg-menu__emoji"
              aria-label={`Реакция ${k}`}
              onClick={() => {
                onClose();
                toggleReaction(client, room, ev, k).catch(() => toast('Не удалось отправить реакцию', { variant: 'error' }));
              }}
            >
              {k}
            </button>
          ))}
        </div>
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            role="menuitem"
            className={`msg-menu__item${it.danger ? ' is-danger' : ''}`}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------- пересылка ---------------- */

export function ForwardDialog({ client, ev, onClose }: { client: MatrixClient; ev: MatrixEvent | null; onClose: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const rooms = useMemo(
    () =>
      ev
        ? client
            .getRooms()
            .filter((r) => r.getMyMembership() === KnownMembership.Join)
            .sort((a, b) => (b.getLastActiveTimestamp() || 0) - (a.getLastActiveTimestamp() || 0))
        : [],
    [client, ev],
  );

  const pick = async (room: Room) => {
    if (!ev || busyId) return;
    setBusyId(room.roomId);
    try {
      await forwardEvent(client, room.roomId, ev);
      toast(`Переслано в «${room.name}»`);
      onClose();
    } catch (e) {
      console.warn('forward failed', e);
      toast('Не удалось переслать', { variant: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal open={!!ev} onClose={onClose} title="Переслать в…" className="forward-dialog">
      <div className="forward-list" role="list">
        {rooms.map((r) => {
          const dm = isDirectRoom(client, r);
          return (
            <button key={r.roomId} type="button" role="listitem" className="forward-row" disabled={!!busyId} onClick={() => void pick(r)}>
              <Avatar client={client} name={r.name} seed={r.roomId} mxc={roomAvatarMxc(r, dm)} size="sm" />
              <span className="forward-row__name">{r.name}</span>
              {busyId === r.roomId && <span className="rl-spinner" />}
            </button>
          );
        })}
        {rooms.length === 0 && <p className="forward-empty">Нет чатов</p>}
      </div>
    </Modal>
  );
}

/* ---------------- удаление ---------------- */

export function DeleteDialog({ client, ev, onClose }: { client: MatrixClient; ev: MatrixEvent | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (!ev) return;
    setBusy(true);
    try {
      await deleteMessage(client, ev);
      onClose();
    } catch (e) {
      console.warn('delete failed', e);
      toast('Не удалось удалить сообщение', { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!ev}
      onClose={onClose}
      title="Удалить сообщение у всех?"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" busy={busy} disabled={busy} onClick={() => void confirm()}>Удалить</Button>
        </>
      }
    >
      <p>Это действие нельзя отменить.</p>
    </Modal>
  );
}
