import { useEffect } from 'react';
import { useMatrix } from './state/MatrixContext';
import { navigate, useHashRoute } from './hooks/useHashRoute';
import { Button, Card, Icon, RedLines } from './components/ui';
import { ThemeToggle } from './components/ThemeToggle';
import { loadLink } from './lib/pin';
import { Splash } from './screens/Splash';
import { Login } from './screens/Login';
import { PinEntry } from './screens/PinEntry';
import { ChatList } from './screens/ChatList';
import { RoomView } from './screens/RoomView';
import { Settings } from './screens/Settings';
import { People } from './screens/People';
import { RoomInfo } from './screens/RoomInfo';
import { RoomMedia } from './screens/RoomMedia';
import { UserProfile } from './screens/UserProfile';

/** Один фон на весь экран: у панелей своих линий нет. */
function AppLines() {
  return <RedLines noIntro speed={0.5} brightness={0.22} className="app__lines" />;
}

export function App() {
  const { status, error, progress, client } = useMatrix();
  const route = useHashRoute();

  // клик по уведомлению: service worker просит открыть комнату
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'open-room' && typeof e.data.roomId === 'string') navigate.room(e.data.roomId);
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (status !== 'ready') return;
    const ownLocalpart = client?.getUserId()?.replace(/^@/, '').split(':')[0];
    if (route.name === 'old-invite' || (route.name === 'personal' && ownLocalpart === route.link.user)) {
      history.replaceState(null, '', '/#/');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  }, [status, route, client]);

  if (status === 'boot') return <Splash />;
  if (status === 'fatal') return <Splash error={error} />;
  if (status === 'logged-out') {
    if (route.name === 'personal') return <PinEntry key={route.link.user + route.link.key} link={route.link} />;
    if (route.name === 'old-invite') {
      return (
        <main className="screen login">
          <RedLines />
          <ThemeToggle className="screen__theme" />
          <div className="login__glow" aria-hidden="true" />
          <Card solid className="login__card">
            <p className="login__note">Ссылка устарела. Попроси новую</p>
          </Card>
        </main>
      );
    }
    const saved = loadLink();
    if (saved) return <PinEntry key={saved.user + saved.key} link={saved} />;
    return <Login />;
  }
  if (status === 'starting') return <Splash text={progress ?? 'Синхронизация…'} />;
  if (route.name === 'old-invite') return null;

  if (route.name === 'personal') {
    const userId = client?.getUserId();
    const ownName = userId ? client?.getUser(userId)?.displayName : null;
    return (
      <div className="app" data-view="detail">
        <AppLines />
        <ChatList />
        <section className="pane pane--room" aria-label="Ссылка">
          <header className="topbar topbar--room">
            <Button variant="ghost" icon aria-label="Назад" onClick={() => { location.hash = '#/'; }}>
              <Icon name="back" />
            </Button>
            <span className="topbar__title"><span className="topbar__name">Ссылка</span></span>
          </header>
          <div className="settings">
            <Card solid className="settings-card">
              <p className="settings-card__text">На этом устройстве уже открыт чат: {ownName ?? ''}</p>
              <Button variant="primary" onClick={() => { location.hash = '#/'; }}>Перейти к чатам</Button>
            </Card>
          </div>
        </section>
      </div>
    );
  }

  const view = route.name === 'list' ? 'list' : 'detail';
  return (
    <div className="app" data-view={view}>
      <AppLines />
      <ChatList activeRoomId={route.name === 'room' || route.name === 'room-info' || route.name === 'room-media' ? route.roomId : undefined} />
      {route.name === 'room' && <RoomView key={route.roomId} roomId={route.roomId} />}
      {route.name === 'room-info' && <RoomInfo key={route.roomId} roomId={route.roomId} />}
      {route.name === 'room-media' && <RoomMedia key={route.roomId} roomId={route.roomId} />}
      {route.name === 'user' && <UserProfile key={route.userId} userId={route.userId} />}
      {route.name === 'settings' && <Settings />}
      {route.name === 'people' && <People />}
      {route.name === 'list' && (
        <section className="pane pane--room pane--placeholder" aria-hidden="true">
          <p>Выберите чат</p>
        </section>
      )}
    </div>
  );
}
