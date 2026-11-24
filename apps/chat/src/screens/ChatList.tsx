import { useEffect, useMemo, useRef, useState } from 'react';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { useClient, useMatrix } from '../state/MatrixContext';
import { useRoomList, type RoomSummary } from '../hooks/useRoomList';
import { useSecurityState } from '../hooks/useSecurityState';
import { usePinUnlock } from '../hooks/usePinUnlock';
import { navigate } from '../hooks/useHashRoute';
import { getClearedTs } from '../lib/clear';
import { formatListTime, previewText } from '../lib/events';
import { sweepExpiredInvites } from '../lib/invites';
import { ThemeToggle } from '../components/ThemeToggle';
import { isPinUser } from '../lib/pin';
import { isBotUser } from '../bots/registry';
import { leaveRoom, setRoomMuted, setRoomPinned } from '../lib/rooms';
import { Avatar, Button, Icon, toast } from '../components/ui';
import { ExtraIcon } from '../components/extraIcons';
import { NewChatModal } from './NewChat';
import { ConfirmDialog } from './infoParts';
import '../styles/info.css';

export function roomAvatarMxc(room: Room, isDm: boolean): string | null {
  const own = room.getMxcAvatarUrl();
  if (own) return own;
  if (!isDm) return null;
  return room.getAvatarFallbackMember()?.getMxcAvatarUrl() ?? null;
}

const LONG_PRESS_MS = 450;
const RECOVERY_HIDE_KEY = 'rl.recoveryBannerHiddenUntil';
const RECOVERY_HIDE_MS = 7 * 24 * 60 * 60 * 1000;

function readRecoveryHidden(): number {
  try {
    return Number(localStorage.getItem(RECOVERY_HIDE_KEY)) || 0;
  } catch {
    return 0;
  }
}

interface MenuState {
  s: RoomSummary;
  x: number;
  y: number;
}

function RoomRow({ client, s, active, onMenu }: { client: MatrixClient; s: RoomSummary; active: boolean; onMenu: (m: MenuState) => void }) {
  const { room, lastEvent, unread, isDm, pinned, muted, mentioned } = s;
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const me = client.getUserId();
  const pin = isPinUser(me);
  const sender = lastEvent?.getSender();
  const senderName = room.getMember(sender!)?.name;
  const from = pin ? (senderName && senderName !== sender ? senderName : 'Участник') : (senderName ?? sender ?? 'Участник');
  const prefix = lastEvent && !isDm ? (sender === me ? 'Вы: ' : `${from}: `) : sender === me && lastEvent ? 'Вы: ' : '';
  const dmPeer = isDm ? room.getAvatarFallbackMember()?.userId : undefined;
  const pending = room.getPendingEvents().length > 0;

  return (
    <li>
      <a
        className={`chat-row${unread > 0 ? ' chat-row--unread' : ''}`}
        href={`#/room/${encodeURIComponent(room.roomId)}`}
        aria-current={active ? 'page' : undefined}
        onClick={(e) => {
          e.preventDefault();
          if (fired.current) {
            fired.current = false;
            return;
          }
          navigate.room(room.roomId);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          cancel();
          fired.current = false;
          onMenu({ s, x: e.clientX, y: e.clientY });
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch') return;
          fired.current = false;
          start.current = { x: e.clientX, y: e.clientY };
          cancel();
          timer.current = window.setTimeout(() => {
            fired.current = true;
            navigator.vibrate?.(15);
            onMenu({ s, x: start.current?.x ?? 0, y: start.current?.y ?? 0 });
          }, LONG_PRESS_MS);
        }}
        onPointerMove={(e) => {
          const p = start.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancel();
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
      >
        <Avatar client={client} name={room.name} seed={dmPeer ?? room.roomId} mxc={roomAvatarMxc(room, isDm)} />
        <span className="chat-row__main">
          <span className="chat-row__name">
            <span className="chat-row__title">{room.name}</span>
            {dmPeer && isBotUser(dmPeer) && <span className="bot-tag">бот</span>}
          </span>
          <span className="chat-row__preview">
            {pending ? <Icon name="clock" size={13} /> : null}
            {lastEvent ? prefix + previewText(lastEvent) : getClearedTs(room) ? 'История очищена' : 'Нет сообщений'}
          </span>
        </span>
        <span className="chat-row__meta">
          <span className="chat-row__time">{s.lastTs ? formatListTime(s.lastTs) : ''}</span>
          <span className="chat-row__icons">
            {muted && <span role="img" aria-label="Без звука"><ExtraIcon name="bellOff" size={14} /></span>}
            {pinned && <span role="img" aria-label="Закреплён"><ExtraIcon name="pin" size={14} /></span>}
            {unread > 0 && mentioned && <span className="chat-row__at" role="img" aria-label="Вас упомянули">@</span>}
            {unread > 0 && (
              <span className={`rl-badge${muted ? ' rl-badge--muted' : ''}`}>{unread > 99 ? '99+' : unread}</span>
            )}
          </span>
        </span>
      </a>
    </li>
  );
}

function InviteRow({ client, room }: { client: MatrixClient; room: Room }) {
  const [busy, setBusy] = useState<'join' | 'leave' | null>(null);
  const inviter = room.getDMInviter() ?? room.currentState.getMember(client.getUserId()!)?.events.member?.getSender();
  const pin = isPinUser(client.getUserId());
  const inviterName = inviter ? room.getMember(inviter)?.name : null;
  const from = pin ? (inviterName && inviterName !== inviter ? inviterName : 'участника') : (inviterName ?? inviter);
  const act = async (kind: 'join' | 'leave') => {
    setBusy(kind);
    try {
      if (kind === 'join') {
        await client.joinRoom(room.roomId);
        navigate.room(room.roomId);
      } else {
        await client.leave(room.roomId);
      }
    } catch (e) {
      toast(kind === 'join' ? 'Не удалось принять приглашение' : 'Не удалось отклонить', { variant: 'error' });
      console.error(e);
      setBusy(null);
    }
  };
  return (
    <li className="invite-row">
      <Avatar client={client} name={room.name} seed={room.roomId} mxc={room.getMxcAvatarUrl()} />
      <span className="chat-row__main">
        <span className="chat-row__name">{room.name}</span>
        <span className="chat-row__preview">Приглашение{inviter ? ` от ${from}` : ''}</span>
      </span>
      <span className="invite-row__actions">
        <Button size="sm" variant="primary" busy={busy === 'join'} disabled={!!busy} onClick={() => act('join')}>Принять</Button>
        <Button size="sm" variant="ghost" busy={busy === 'leave'} disabled={!!busy} onClick={() => act('leave')} aria-label="Отклонить">
          <Icon name="close" size={16} />
        </Button>
      </span>
    </li>
  );
}

function RowMenu({ menu, onClose, onToggle, onLeave }: { menu: MenuState; onClose: () => void; onToggle: (k: 'pin' | 'mute') => void; onLeave: () => void }) {
  const W = 208;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 160));
  return (
    <>
      <div className="row-menu-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="row-menu"
        role="menu"
        aria-label={`Действия: ${menu.s.room.name}`}
        style={{ left, top }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <button type="button" role="menuitem" autoFocus onClick={() => onToggle('pin')}>
          <ExtraIcon name="pin" /> {menu.s.pinned ? 'Открепить' : 'Закрепить'}
        </button>
        <button type="button" role="menuitem" onClick={() => onToggle('mute')}>
          <ExtraIcon name="bellOff" /> {menu.s.muted ? 'Включить звук' : 'Без звука'}
        </button>
        <button type="button" role="menuitem" className="is-danger" onClick={onLeave}>
          <Icon name="logout" size={18} /> Покинуть
        </button>
      </div>
    </>
  );
}

export function ChatList({ activeRoomId }: { activeRoomId?: string }) {
  const client = useClient();
  const { logout } = useMatrix();
  const pin = isPinUser(client.getUserId());
  const { rooms, invites, totalUnread } = useRoomList(client);
  const [security, refreshSecurity] = useSecurityState(client);
  const unlock = usePinUnlock(client, security, refreshSecurity);
  const [newChat, setNewChat] = useState(false);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [leaving, setLeaving] = useState<Room | null>(null);

  const [hiddenUntil, setHiddenUntil] = useState(readRecoveryHidden);
  // показ баннера (условия не менялись): тихая разблокировка PIN — только при сбое, иначе по состоянию безопасности
  const showRecovery = unlock.silent
    ? unlock.failed && security === 'needs-unlock'
    : security === 'needs-setup' || security === 'needs-unlock';
  const canDismissRecovery = !unlock.silent && !pin && security === 'needs-setup';
  const recoveryHidden = canDismissRecovery && hiddenUntil > Date.now();
  const dismissRecovery = () => {
    const until = Date.now() + RECOVERY_HIDE_MS;
    setHiddenUntil(until);
    try {
      localStorage.setItem(RECOVERY_HIDE_KEY, String(until));
    } catch {
      /* хранилище недоступно — спрячем только до перезагрузки */
    }
  };
  const recoveryText = pin
      ? 'Нужно заново ввести PIN'
      : 'Включите вход по номеру';
  const recoveryCta = pin ? 'Ввести' : 'Настроить';

  const q = query.trim().toLocaleLowerCase('ru');
  const shown = useMemo(() => (q ? rooms.filter((s) => s.room.name.toLocaleLowerCase('ru').includes(q)) : rooms), [rooms, q]);

  // список меняется сразу (оптимистично), запрос идёт в фоне; при ошибке значение откатывается
  const toggle = (kind: 'pin' | 'mute') => {
    const target = menu?.s;
    setMenu(null);
    if (!target) return;
    const req = kind === 'pin' ? setRoomPinned(client, target.room.roomId, !target.pinned) : setRoomMuted(client, target.room.roomId, !target.muted);
    req.catch((e) => {
      console.error(e);
      toast(kind === 'pin' ? 'Не удалось закрепить' : 'Не получилось изменить уведомления', { variant: 'error' });
    });
  };

  const doLeave = () => {
    if (!leaving) return;
    const id = leaving.roomId;
    setLeaving(null);
    if (activeRoomId === id) location.hash = '#/';
    leaveRoom(client, id).catch((e) => {
      console.error(e);
      toast('Не удалось покинуть чат. Проверьте интернет и попробуйте ещё раз', { variant: 'error' });
    });
  };

  useEffect(() => {
    void sweepExpiredInvites(client);
  }, [client]);

  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!nav.setAppBadge) return;
    (totalUnread > 0 ? nav.setAppBadge(totalUnread) : nav.clearAppBadge?.())?.catch(() => {});
  }, [totalUnread]);

  return (
    <section className="pane pane--list" aria-label="Чаты">
      <header className="topbar">
        <span className="topbar__logo">Redline</span>
        <span className="topbar__actions">
          <ThemeToggle />
          <Button variant="ghost" icon aria-label="Новый чат" onClick={() => setNewChat(true)}>
            <Icon name="plus" />
          </Button>
          <Button variant="ghost" icon aria-label="Настройки" onClick={() => navigate.settings()}>
            <Icon name="settings" />
          </Button>
        </span>
      </header>

      {showRecovery && !recoveryHidden && (
        <div className="banner banner--action banner--compact">
          <button
            type="button"
            className="banner__main"
            onClick={() => (pin ? void logout() : navigate.settings())}
          >
            <Icon name="key" size={18} />
            <span className="banner__text">{recoveryText}</span>
            <span className="banner__cta">{recoveryCta}</span>
          </button>
          {canDismissRecovery && (
            <button type="button" className="banner__close" aria-label="Скрыть на 7 дней" onClick={dismissRecovery}>
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
      )}

      {rooms.length > 0 && (
        <div className="chat-search" role="search">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск"
            aria-label="Поиск по чатам"
            autoComplete="off"
            enterKeyHint="search"
          />
          {query && (
            <Button variant="ghost" size="sm" icon className="chat-search__clear" aria-label="Очистить поиск" onClick={() => setQuery('')}>
              <Icon name="close" size={16} />
            </Button>
          )}
        </div>
      )}

      <div className="pane__scroll">
        {!q && invites.length > 0 && (
          <>
            <h2 className="list-heading">Приглашения</h2>
            <ul className="chat-list">
              {invites.map((r) => <InviteRow key={r.roomId} client={client} room={r} />)}
            </ul>
          </>
        )}
        {q && shown.length === 0 ? (
          <div className="empty"><p>Ничего не найдено</p></div>
        ) : shown.length > 0 ? (
          <ul className="chat-list">
            {shown.map((s) => <RoomRow key={s.room.roomId} client={client} s={s} active={s.room.roomId === activeRoomId} onMenu={setMenu} />)}
          </ul>
        ) : invites.length === 0 ? (
          <div className="empty">
            <p>Пока нет чатов</p>
            <Button variant="primary" onClick={() => setNewChat(true)}>Начать чат</Button>
          </div>
        ) : null}
      </div>

      {menu && (
        <RowMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onToggle={(k) => void toggle(k)}
          onLeave={() => {
            setLeaving(menu.s.room);
            setMenu(null);
          }}
        />
      )}
      <ConfirmDialog
        open={!!leaving}
        title="Покинуть чат"
        text={`Покинуть «${leaving?.name ?? ''}»?`}
        confirmLabel="Покинуть"
        onConfirm={doLeave}
        onClose={() => setLeaving(null)}
      />
      <NewChatModal open={newChat} onClose={() => setNewChat(false)} />
    </section>
  );
}
