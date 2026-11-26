import { useCallback, useEffect, useState } from 'react';
import { ClientEvent, KnownMembership, RoomEvent, type MatrixClient, type Room } from 'matrix-js-sdk';
import { useClient } from '../state/MatrixContext';
import { navigate } from '../hooks/useHashRoute';
import { isDirectRoom } from '../hooks/useRoomList';
import { setCurrentRoom } from '../lib/notifications';
import { isBotUser } from '../bots/registry';
import { Avatar, Button, Icon } from '../components/ui';
import { ChatTimeline } from '../chat/ChatTimeline';
import { ChatComposer, type ComposerContext } from '../chat/ChatComposer';
import type { ChatMessage } from '../chat/types';
import { useMatrixChat } from '../room/matrixChat';
import { ClearHistory } from '../room/ClearHistory';
import { RoomSearch, type SearchTarget } from '../room/RoomSearch';
import { ExtraIcon } from '../components/extraIcons';
import { roomAvatarMxc } from './ChatList';
import { useTabIcon } from '../hooks/useTabIcon';
import '../styles/info.css';

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

function RoomScreen({ client, room, encrypted }: { client: MatrixClient; room: Room; encrypted: boolean }) {
  const { state, backend } = useMatrixChat(client, room);
  const [context, setContext] = useState<ComposerContext>(null);
  const onReply = useCallback((m: ChatMessage) => setContext({ kind: 'reply', m }), []);
  const onEdit = useCallback((m: ChatMessage) => setContext({ kind: 'edit', m }), []);
  const clearContext = useCallback(() => setContext(null), []);

  const [searching, setSearching] = useState(false);
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null);
  const closeSearch = useCallback(() => setSearching(false), []);

  const isDm = isDirectRoom(client, room);
  const peerId = isDm ? room.getAvatarFallbackMember()?.userId : undefined;
  const typing = state.typing;

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
      <ChatTimeline backend={backend} state={state} onReply={onReply} onEdit={onEdit} highlight={searching ? searchTarget : null} />
      <ChatComposer backend={backend} context={context} onClearContext={clearContext} />
      <ClearHistory client={client} room={room} />
    </section>
  );
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

  return <RoomScreen key={room.roomId} client={client} room={room} encrypted={encrypted} />;
}
