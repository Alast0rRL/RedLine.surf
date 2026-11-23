import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { KnownMembership, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { Avatar, Button, Icon, Modal, toast } from '../components/ui';
import { ExtraIcon } from '../components/extraIcons';
import { useBackClose } from '../hooks/useBackClose';
import { focusForInput } from '../lib/modality';
import { downloadMedia, mediaOf } from '../lib/roomMedia';
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
import '../styles/viewer.css';

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

type Item = { key: string; label: string; icon: ReactNode; danger?: boolean; run: () => void };

const PATHS = {
  reply: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 6 6v3',
  forward: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0-6 6v3',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
} as const;

function Svg({ d }: { d: string }) {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function useMenuItems({ client, ev, onReply, onEdit, onForward, onDelete }: MenuProps): Item[] {
  const me = client.getUserId() ?? '';
  const items: Item[] = [];
  items.push({ key: 'reply', label: 'Ответить', icon: <Svg d={PATHS.reply} />, run: () => onReply(ev) });
  if (canEdit(ev, me)) items.push({ key: 'edit', label: 'Изменить', icon: <ExtraIcon name="edit" size={22} />, run: () => onEdit(ev) });
  if (isTextMessage(ev)) {
    items.push({
      key: 'copy',
      label: 'Копировать',
      icon: <Icon name="copy" size={22} />,
      run: () => {
        navigator.clipboard?.writeText(plainBody(ev)).then(
          () => toast('Скопировано'),
          () => toast('Не удалось скопировать', { variant: 'error' }),
        );
      },
    });
  }
  const media = mediaOf(ev);
  if (media) {
    items.push({
      key: 'save',
      label: 'Сохранить',
      icon: <Svg d={PATHS.download} />,
      run: () => {
        downloadMedia(client, media.src, media.name).catch((e) => {
          console.warn('save failed', e);
          toast('Не удалось сохранить', { variant: 'error' });
        });
      },
    });
  }
  items.push({ key: 'forward', label: 'Переслать', icon: <Svg d={PATHS.forward} />, run: () => onForward(ev) });
  if (canDelete(ev, me)) items.push({ key: 'delete', label: 'Удалить', icon: <Icon name="trash" size={22} />, danger: true, run: () => onDelete(ev) });
  return items;
}

const isTouchLayout = () => window.matchMedia('(pointer: coarse), (max-width: 599px)').matches;

/** Меню действий над сообщением: на телефоне нижняя шторка, на десктопе всплывающее меню у точки нажатия. */
export function MessageMenu(props: MenuProps) {
  const items = useMenuItems(props);
  const [sheet] = useState(isTouchLayout);
  return sheet ? <MenuSheet {...props} items={items} /> : <MenuPopover {...props} items={items} />;
}

function Reactions({ client, room, ev, close }: { client: MatrixClient; room: Room; ev: MatrixEvent; close: () => void }) {
  return (
    <div className="msg-menu__reactions">
      {QUICK_REACTIONS.map((k) => (
        <button
          key={k}
          type="button"
          role="menuitem"
          className="msg-menu__emoji"
          aria-label={`Реакция ${k}`}
          onClick={() => {
            close();
            toggleReaction(client, room, ev, k).catch(() => toast('Не удалось отправить реакцию', { variant: 'error' }));
          }}
        >
          {k}
        </button>
      ))}
    </div>
  );
}

/** Нижняя шторка: закрывается по тапу на фон, свайпу вниз, Esc и кнопке «назад». */
function MenuSheet({ client, room, ev, onClose, items }: MenuProps & { items: Item[] }) {
  const dismiss = useBackClose(onClose);
  const [dy, setDy] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'drag' | 'settle'>('idle');
  const start = useRef<{ y: number; t: number; scroll: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    focusForInput(ref.current?.querySelector<HTMLElement>('[role="menuitem"]'), ref.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss]);

  const onDown = (e: React.PointerEvent) => {
    start.current = { y: e.clientY, t: Date.now(), scroll: ref.current?.scrollTop ?? 0 };
  };
  const onMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s || s.scroll > 0) return;
    const d = e.clientY - s.y;
    if (d > 6) {
      setPhase('drag');
      setDy(d);
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || phase !== 'drag') return;
    const d = e.clientY - s.y;
    if (d > 90 || (d > 40 && Date.now() - s.t < 250)) dismiss();
    else {
      setPhase('settle');
      setDy(0);
    }
  };

  const close = () => dismiss();
  return createPortal(
    <div
      className="msg-sheet-backdrop"
      style={{ ['--sheet-fade' as string]: Math.max(0.2, 1 - dy / 400) }}
      onPointerDown={close}
      onContextMenu={(e) => { e.preventDefault(); close(); }}
    >
      <div
        ref={ref}
        className={`msg-sheet${phase === 'drag' ? ' is-dragging' : ''}${phase === 'settle' ? ' is-settling' : ''}`}
        role="menu"
        aria-label="Действия с сообщением"
        style={{ transform: dy ? `translateY(${dy}px)` : undefined }}
        onPointerDown={(e) => { e.stopPropagation(); onDown(e); }}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => { start.current = null; setPhase('settle'); setDy(0); }}
        onTransitionEnd={() => setPhase('idle')}
      >
        <div className="msg-sheet__grip" aria-hidden="true" />
        <Reactions client={client} room={room} ev={ev} close={close} />
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            role="menuitem"
            className={`msg-menu__item${it.danger ? ' is-danger' : ''}`}
            onClick={() => {
              // действие — после того как запись истории снята, иначе back отменит навигацию
              dismiss(() => it.run());
            }}
          >
            {it.icon}
            {it.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

function MenuPopover({ client, room, ev, point, onClose, items }: MenuProps & { items: Item[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

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
    focusForInput(ref.current?.querySelector<HTMLElement>('[role="menuitem"]'), ref.current);
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
        <Reactions client={client} room={room} ev={ev} close={onClose} />
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
