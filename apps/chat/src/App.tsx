import { useEffect } from 'react';
import { useMatrix } from './state/MatrixContext';
import { navigate, useHashRoute } from './hooks/useHashRoute';
import { Button, Card, Icon } from './components/ui';
import { Splash } from './screens/Splash';
import { Login } from './screens/Login';
import { Register } from './screens/Register';
import { ChatList } from './screens/ChatList';
import { RoomView } from './screens/RoomView';
import { Settings } from './screens/Settings';
import { People } from './screens/People';

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

  if (status === 'boot') return <Splash />;
  if (status === 'fatal') return <Splash error={error} />;
  if (status === 'logged-out') {
    if (route.name === 'invite') return <Register token={route.token} roomId={route.roomId} />;
    return <Login />;
  }
  if (status === 'starting') return <Splash text={progress ?? 'Синхронизация…'} />;

  if (route.name === 'invite') {
    return (
      <div className="app" data-view="detail">
        <ChatList />
        <section className="pane pane--room" aria-label="Приглашение">
          <header className="topbar topbar--room">
            <Button variant="ghost" icon aria-label="Назад" onClick={() => { location.hash = '#/'; }}>
              <Icon name="back" />
            </Button>
            <span className="topbar__title"><span className="topbar__name">Приглашение</span></span>
          </header>
          <div className="settings">
            <Card solid className="settings-card">
              <p className="settings-card__text">Вы уже вошли как {client?.getUserId()}</p>
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
      <ChatList activeRoomId={route.name === 'room' ? route.roomId : undefined} />
      {route.name === 'room' && <RoomView key={route.roomId} roomId={route.roomId} />}
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
