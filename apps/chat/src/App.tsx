import { useEffect } from 'react';
import { useMatrix } from './state/MatrixContext';
import { navigate, useHashRoute } from './hooks/useHashRoute';
import { Splash } from './screens/Splash';
import { Login } from './screens/Login';
import { ChatList } from './screens/ChatList';
import { RoomView } from './screens/RoomView';
import { Settings } from './screens/Settings';

export function App() {
  const { status, error } = useMatrix();
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
  if (status === 'logged-out') return <Login />;
  if (status === 'starting') return <Splash text="Синхронизация…" />;

  const view = route.name === 'list' ? 'list' : 'detail';
  return (
    <div className="app" data-view={view}>
      <ChatList activeRoomId={route.name === 'room' ? route.roomId : undefined} />
      {route.name === 'room' && <RoomView key={route.roomId} roomId={route.roomId} />}
      {route.name === 'settings' && <Settings />}
      {route.name === 'list' && (
        <section className="pane pane--room pane--placeholder" aria-hidden="true">
          <p>Выберите чат</p>
        </section>
      )}
    </div>
  );
}
