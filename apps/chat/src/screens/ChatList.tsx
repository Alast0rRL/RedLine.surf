import { useEffect, useState } from 'react';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { useClient, useMatrix } from '../state/MatrixContext';
import { useRoomList, type RoomSummary } from '../hooks/useRoomList';
import { useSecurityState } from '../hooks/useSecurityState';
import { navigate } from '../hooks/useHashRoute';
import { formatListTime, previewText } from '../lib/events';
import { sweepExpiredInvites } from '../lib/invites';
import { isBotUser } from '../bots/registry';
import { Avatar, Button, Icon, RedLines, toast } from '../components/ui';
import { NewChatModal } from './NewChat';

export function roomAvatarMxc(room: Room, isDm: boolean): string | null {
  const own = room.getMxcAvatarUrl();
  if (own) return own;
  if (!isDm) return null;
  return room.getAvatarFallbackMember()?.getMxcAvatarUrl() ?? null;
}

function RoomRow({ client, s, active }: { client: MatrixClient; s: RoomSummary; active: boolean }) {
  const { room, lastEvent, unread, highlight, isDm } = s;
  const me = client.getUserId();
  const sender = lastEvent?.getSender();
  const prefix = lastEvent && !isDm ? (sender === me ? 'Вы: ' : `${room.getMember(sender!)?.name ?? sender}: `) : sender === me && lastEvent ? 'Вы: ' : '';
  const dmPeer = isDm ? room.getAvatarFallbackMember()?.userId : undefined;
  const pending = room.getPendingEvents().length > 0;

  return (
    <li>
      <a
        className="chat-row"
        href={`#/room/${encodeURIComponent(room.roomId)}`}
        aria-current={active ? 'page' : undefined}
        onClick={(e) => {
          e.preventDefault();
          navigate.room(room.roomId);
        }}
      >
        <Avatar client={client} name={room.name} seed={dmPeer ?? room.roomId} mxc={roomAvatarMxc(room, isDm)} />
        <span className="chat-row__main">
          <span className="chat-row__name">
            {room.name}
            {dmPeer && isBotUser(dmPeer) && <span className="bot-tag">бот</span>}
          </span>
          <span className="chat-row__preview">
            {pending ? <Icon name="clock" size={13} /> : null}
            {lastEvent ? prefix + previewText(lastEvent) : 'Нет сообщений'}
          </span>
        </span>
        <span className="chat-row__meta">
          <span className="chat-row__time">{s.lastTs ? formatListTime(s.lastTs) : ''}</span>
          {unread > 0 && <span className={`rl-badge${highlight ? '' : ' rl-badge--soft'}`}>{unread > 99 ? '99+' : unread}</span>}
        </span>
      </a>
    </li>
  );
}

function InviteRow({ client, room }: { client: MatrixClient; room: Room }) {
  const [busy, setBusy] = useState<'join' | 'leave' | null>(null);
  const inviter = room.getDMInviter() ?? room.currentState.getMember(client.getUserId()!)?.events.member?.getSender();
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
        <span className="chat-row__preview">Приглашение{inviter ? ` от ${room.getMember(inviter)?.name ?? inviter}` : ''}</span>
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

export function ChatList({ activeRoomId }: { activeRoomId?: string }) {
  const client = useClient();
  const { syncProblem } = useMatrix();
  const { rooms, invites, totalUnread } = useRoomList(client);
  const [security] = useSecurityState(client);
  const [newChat, setNewChat] = useState(false);

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
      <RedLines noIntro lines={3} speed={0.5} brightness={0.22} className="pane__lines" />
      <header className="topbar">
        <span className="topbar__logo">Redline</span>
        <span className="topbar__actions">
          <Button variant="ghost" icon aria-label="Новый чат" onClick={() => setNewChat(true)}>
            <Icon name="plus" />
          </Button>
          <Button variant="ghost" icon aria-label="Настройки" onClick={() => navigate.settings()}>
            <Icon name="settings" />
          </Button>
        </span>
      </header>

      {syncProblem && (
        <div className="banner banner--warn" role="status">
          <span className="rl-spinner" /> {syncProblem === 'error' ? 'Нет связи с сервером' : 'Переподключение…'}
        </div>
      )}
      {(security === 'needs-setup' || security === 'needs-unlock') && (
        <button className="banner banner--action" onClick={() => navigate.settings()}>
          <Icon name="key" size={18} />
          <span>
            {security === 'needs-setup'
              ? 'Задайте фразу восстановления, чтобы не потерять переписку'
              : 'Введите фразу восстановления, чтобы читать старые сообщения'}
          </span>
        </button>
      )}

      <div className="pane__scroll">
        {invites.length > 0 && (
          <>
            <h2 className="list-heading">Приглашения</h2>
            <ul className="chat-list">
              {invites.map((r) => <InviteRow key={r.roomId} client={client} room={r} />)}
            </ul>
          </>
        )}
        {rooms.length > 0 ? (
          <ul className="chat-list">
            {rooms.map((s) => <RoomRow key={s.room.roomId} client={client} s={s} active={s.room.roomId === activeRoomId} />)}
          </ul>
        ) : invites.length === 0 ? (
          <div className="empty">
            <p>Пока нет чатов</p>
            <Button variant="primary" onClick={() => setNewChat(true)}>Начать чат</Button>
          </div>
        ) : null}
      </div>

      <NewChatModal open={newChat} onClose={() => setNewChat(false)} />
    </section>
  );
}
