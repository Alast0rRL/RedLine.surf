import { useCallback, useEffect, useState } from 'react';
import { ClientEvent, KnownMembership, RoomEvent, RoomMemberEvent, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useClient } from '../state/MatrixContext';
import { navigate } from '../hooks/useHashRoute';
import { isDirectRoom } from '../hooks/useRoomList';
import { setCurrentRoom } from '../lib/notifications';
import { isPinUser } from '../lib/pin';
import { isBotUser } from '../bots/registry';
import { Avatar, Button, Icon } from '../components/ui';
import { Timeline } from '../room/Timeline';
import { RoomSearch, type SearchTarget } from '../room/RoomSearch';
import { ExtraIcon } from '../components/extraIcons';
import { Composer, type ComposerContext } from '../room/Composer';
import { roomAvatarMxc } from './ChatList';
import { useTabIcon } from '../hooks/useTabIcon';
import '../styles/info.css';

function useTyping(client: MatrixClient, room: Room | null): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!room) return;
    const update = () => {
      const me = client.getUserId();
      const pin = isPinUser(me);
      setNames(room.getMembers().filter((m) => m.typing && m.userId !== me).map((m) =>
        pin && m.name === m.userId ? 'Участник' : m.name));
    };
    client.on(RoomMemberEvent.Typing, update);
    update();
    return () => {
      client.off(RoomMemberEvent.Typing, update);
    };
  }, [client, room]);
  return names;
}

function subtitle(room: Room, typing: string[], isDm: boolean, encrypted: boolean): string {
  if (typing.length === 1) return isDm ? 'печатает…' : `${typing[0]} печатает…`;
  if (typing.length > 1) return `${typing.length} печатают…`;
  if (isDm) {
    const peer = room.getAvatarFallbackMember();
    if (peer && isBotUser(peer.userId)) return 'бот';
    return encrypted ? 'личный чат · зашифрован' : 'личный чат';
  }
  const n = room.getJoinedMemberCount();
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'участник' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'участника' : 'участников'}${encrypted ? ' · зашифрован' : ''}`;
}

export function RoomView({ roomId }: { roomId: string }) {
  const client = useClient();
  // комната и наше членство приходят синком: после «Принять» экран должен обновиться сам
  const [, bump] = useState(0);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const onChange = () => bump((n) => n + 1);
    client.on(ClientEvent.Room, onChange);
    client.on(RoomEvent.MyMembership, onChange);
    const t = window.setTimeout(() => setWaited(true), 20000);
    return () => {
      client.off(ClientEvent.Room, onChange);
      client.off(RoomEvent.MyMembership, onChange);
      window.clearTimeout(t);
    };
  }, [client, roomId]);
  const room = client.getRoom(roomId);
  const [encrypted, setEncrypted] = useState(false);
  const typing = useTyping(client, room);
  const [context, setContext] = useState<ComposerContext>(null);
  const onReply = useCallback((ev: MatrixEvent) => setContext({ kind: 'reply', ev }), []);
  const onEdit = useCallback((ev: MatrixEvent) => setContext({ kind: 'edit', ev }), []);
  const clearContext = useCallback(() => setContext(null), []);

  const [searching, setSearching] = useState(false);
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null);
  const closeSearch = useCallback(() => setSearching(false), []);

  useEffect(() => {
    setContext(null);
    setSearching(false);
  }, [roomId]);

  useEffect(() => {
    setCurrentRoom(roomId);
    return () => setCurrentRoom(null);
  }, [roomId]);

  useEffect(() => {
    let alive = true;
    client.getCrypto()?.isEncryptionEnabledInRoom(roomId).then((v) => alive && setEncrypted(v));
    return () => {
      alive = false;
    };
  }, [client, roomId]);

  const joined = !!room && room.getMyMembership() === KnownMembership.Join;
  const tabDm = joined && isDirectRoom(client, room);
  useTabIcon(
    joined
      ? { name: room.name, seed: (tabDm && room.getAvatarFallbackMember()?.userId) || room.roomId, mxc: roomAvatarMxc(room, tabDm) }
      : null,
  );

  if (!room || !joined) {
    return (
      <section className="pane pane--room pane--chat">
        <header className="topbar">
          <Button variant="ghost" icon aria-label="Назад" onClick={() => navigate.list()}><Icon name="back" /></Button>
        </header>
        <div className="empty">
          <p>{waited || room?.getMyMembership() === KnownMembership.Leave ? 'Чат не найден или вы в нём не состоите' : 'Открываем чат…'}</p>
        </div>
      </section>
    );
  }

  const isDm = isDirectRoom(client, room);
  const peerId = isDm ? room.getAvatarFallbackMember()?.userId : undefined;

  return (
    <section className="pane pane--room pane--chat" aria-label={room.name}>
      {searching ? (
        <RoomSearch client={client} room={room} onClose={closeSearch} onTarget={setSearchTarget} />
      ) : (
      <header className="topbar topbar--room">
        <Button variant="ghost" icon aria-label="Назад к чатам" className="topbar__back" onClick={() => navigate.list()}>
          <Icon name="back" />
        </Button>
        <button
          type="button"
          className="topbar__open"
          aria-label={isDm ? `Профиль: ${room.name}` : `Информация о группе ${room.name}`}
          onClick={() => (isDm && peerId ? navigate.user(peerId) : navigate.roomInfo(room.roomId))}
        >
          <Avatar client={client} name={room.name} seed={peerId ?? room.roomId} mxc={roomAvatarMxc(room, isDm)} size="sm" />
          <span className="topbar__title">
            <span className="topbar__name">{room.name}</span>
            <span className={`topbar__sub${typing.length ? ' is-typing' : ''}`}>
              {encrypted && !typing.length && <Icon name="lock" size={11} />} {subtitle(room, typing, isDm, encrypted)}
            </span>
          </span>
        </button>
        <Button variant="ghost" icon aria-label="Поиск в чате" onClick={() => setSearching(true)}>
          <ExtraIcon name="search" size={20} />
        </Button>
      </header>
      )}
      <Timeline key={room.roomId} client={client} room={room} onReply={onReply} onEdit={onEdit} searchTarget={searching ? searchTarget : null} />
      <Composer key={room.roomId} client={client} room={room} context={context} onClearContext={clearContext} />
    </section>
  );
}
