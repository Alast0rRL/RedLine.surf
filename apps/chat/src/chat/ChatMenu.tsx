import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icon, Modal, toast } from '../components/ui';
import { ExtraIcon } from '../components/extraIcons';
import { useBackClose } from '../hooks/useBackClose';
import { focusForInput } from '../lib/modality';
import { ChatAvatar } from './ChatAvatar';
import type { ChatBackend, ChatMessage } from './types';
import '../room/room.css';
import '../styles/viewer.css';

export interface MenuPoint {
  x: number;
  y: number;
}

const MARGIN = 8;

interface MenuProps {
  backend: ChatBackend;
  m: ChatMessage;
  point: MenuPoint;
  onClose: () => void;
  onReply(m: ChatMessage): void;
  onEdit(m: ChatMessage): void;
  onForward(m: ChatMessage): void;
  onDelete(m: ChatMessage): void;
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

function useMenuItems({ backend, m, onReply, onEdit, onForward, onDelete }: MenuProps): Item[] {
  const items: Item[] = [];
  items.push({ key: 'reply', label: 'Ответить', icon: <Svg d={PATHS.reply} />, run: () => onReply(m) });
  if (backend.canEdit(m)) items.push({ key: 'edit', label: 'Изменить', icon: <ExtraIcon name="edit" size={22} />, run: () => onEdit(m) });
  if (m.text) {
    items.push({
      key: 'copy',
      label: 'Копировать',
      icon: <Icon name="copy" size={22} />,
      run: () => {
        navigator.clipboard?.writeText(m.text).then(
          () => toast('Скопировано'),
          () => toast('Не удалось скопировать', { variant: 'error' }),
        );
      },
    });
  }
  const media = m.media;
  if (media && media.kind !== 'voice' && media.kind !== 'audio') {
    items.push({
      key: 'save',
      label: 'Сохранить',
      icon: <Svg d={PATHS.download} />,
      run: () => {
        backend.mediaUrl(media).then((url) => {
          const a = document.createElement('a');
          a.href = url;
          a.download = media.name ?? 'Файл';
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
        }).catch((e) => {
          console.warn('save failed', e);
          toast('Не удалось сохранить', { variant: 'error' });
        });
      },
    });
  }
  items.push({ key: 'forward', label: 'Переслать', icon: <Svg d={PATHS.forward} />, run: () => onForward(m) });
  if (backend.canDelete(m)) items.push({ key: 'delete', label: 'Удалить', icon: <Icon name="trash" size={22} />, danger: true, run: () => onDelete(m) });
  return items;
}

const isTouchLayout = () => window.matchMedia('(pointer: coarse), (max-width: 599px)').matches;

/** Меню действий над сообщением: на телефоне нижняя шторка, на десктопе всплывающее меню у точки нажатия. */
export function ChatMenu(props: MenuProps) {
  const items = useMenuItems(props);
  const [sheet] = useState(isTouchLayout);
  return sheet ? <MenuSheet {...props} items={items} /> : <MenuPopover {...props} items={items} />;
}

function Reactions({ backend, m, close }: { backend: ChatBackend; m: ChatMessage; close: () => void }) {
  const mine = m.reactions.find((r) => r.own)?.key;
  return (
    <div className="msg-menu__reactions">
      {backend.quickReactions.map((k) => (
        <button
          key={k}
          type="button"
          role="menuitem"
          className={`msg-menu__emoji${mine === k ? ' is-mine' : ''}`}
          aria-label={`Реакция ${k}`}
          aria-pressed={mine === k}
          onClick={() => {
            close();
            backend.toggleReaction(m.id, k).catch(() => toast('Не удалось отправить реакцию', { variant: 'error' }));
          }}
        >
          {k}
        </button>
      ))}
    </div>
  );
}

/** Нижняя шторка: закрывается по тапу на фон, свайпу вниз, Esc и кнопке «назад». */
function MenuSheet({ backend, m, onClose, items }: MenuProps & { items: Item[] }) {
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
        <Reactions backend={backend} m={m} close={close} />
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

function MenuPopover({ backend, m, point, onClose, items }: MenuProps & { items: Item[] }) {
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
        <Reactions backend={backend} m={m} close={onClose} />
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

export function ChatForwardDialog({ backend, m, onClose }: { backend: ChatBackend; m: ChatMessage; onClose: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [targets, setTargets] = useState<{ id: string; name: string; avatarSeed: string }[]>([]);

  useEffect(() => {
    let alive = true;
    backend.forwardTargets().then(
      (list) => { if (alive) setTargets(list); },
      (e) => {
        console.warn('forward targets failed', e);
        toast('Не удалось загрузить чаты', { variant: 'error' });
      },
    );
    return () => { alive = false; };
  }, [backend]);

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('ru');
    return q ? targets.filter((t) => t.name.toLocaleLowerCase('ru').includes(q)) : targets;
  }, [targets, query]);

  const pick = async (targetId: string) => {
    if (busyId) return;
    setBusyId(targetId);
    try {
      await backend.forward(m.id, targetId);
      toast('Переслано');
      onClose();
    } catch (e) {
      console.warn('forward failed', e);
      toast(e instanceof Error && e.message ? e.message : 'Не удалось переслать', { variant: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal open onClose={onClose} title="Переслать в…" className="forward-dialog">
      <input
        className="rl-input"
        type="search"
        placeholder="Поиск чата"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Поиск чата"
      />
      <div className="forward-list" role="list">
        {shown.map((t) => (
          <button key={t.id} type="button" role="listitem" className="forward-row" disabled={!!busyId} onClick={() => void pick(t.id)}>
            <ChatAvatar name={t.name} seed={t.avatarSeed} size="sm" />
            <span className="forward-row__name">{t.name}</span>
            {busyId === t.id && <span className="rl-spinner" />}
          </button>
        ))}
        {shown.length === 0 && <p className="forward-empty">Нет чатов</p>}
      </div>
    </Modal>
  );
}

/* ---------------- удаление ---------------- */

export function ChatDeleteDialog({ backend, m, onClose }: { backend: ChatBackend; m: ChatMessage; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const canAll = backend.canDeleteForAll(m);
  const onlyAll = !!backend.deleteOnlyForAll;
  const confirm = async (forAll: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await backend.deleteMessage(m.id, forAll);
      onClose();
    } catch (e) {
      console.warn('delete failed', e);
      toast(e instanceof Error && e.message ? e.message : 'Не удалось удалить сообщение', { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={onlyAll ? 'Удалить сообщение у всех?' : 'Удалить сообщение?'}
      actions={
        onlyAll ? (
          <>
            <Button variant="ghost" onClick={onClose}>Отмена</Button>
            <Button variant="primary" busy={busy} disabled={busy} onClick={() => void confirm(true)}>Удалить</Button>
          </>
        ) : (
          <>
            {canAll && <Button variant="primary" busy={busy} disabled={busy} onClick={() => void confirm(true)}>Удалить у всех</Button>}
            <Button variant={canAll ? 'secondary' : 'primary'} busy={busy} disabled={busy} onClick={() => void confirm(false)}>Удалить у меня</Button>
            <Button variant="ghost" onClick={onClose}>Отмена</Button>
          </>
        )
      }
    >
      <p>Это действие нельзя отменить.</p>
    </Modal>
  );
}
