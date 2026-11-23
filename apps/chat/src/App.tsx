import { useEffect, useState } from 'react';
import { useMatrix } from './state/MatrixContext';
import { navigate, useHashRoute } from './hooks/useHashRoute';
import { Button, Card, Icon, Modal, RedLines } from './components/ui';
import { isPinUser } from './lib/pin';
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
import { UserProfile } from './screens/UserProfile';

const OFFLINE_DELAY_MS = 5000;

/** Тонкая полоска сверху: нет интернета или сервер не отвечает дольше 5 секунд. */
function OfflineBar() {
  const { syncProblem } = useMatrix();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  useEffect(() => {
    if (!syncProblem) {
      setStalled(false);
      return;
    }
    const t = window.setTimeout(() => setStalled(true), OFFLINE_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [syncProblem]);

  if (online && !stalled) return null;
  return (
    <div className="offline-bar" role="status">
      Нет связи — сообщения отправятся, когда интернет появится
    </div>
  );
}

/** Один раз на аккаунт: что делать после первого входа. */
function Onboarding() {
  const { client } = useMatrix();
  const userId = client?.getUserId() ?? null;
  const key = userId ? `rl.welcomed:${userId}` : null;
  const [open, setOpen] = useState(() => {
    if (!key) return false;
    try {
      return !localStorage.getItem(key);
    } catch {
      return false;
    }
  });
  if (!key || !userId) return null;
  const pin = isPinUser(userId);
  const done = (toSettings: boolean) => {
    try {
      localStorage.setItem(key, '1');
    } catch {
      /* без хранилища покажем снова — не страшно */
    }
    setOpen(false);
    if (toSettings) navigate.settings();
  };
  return (
    <Modal
      open={open}
      onClose={() => done(false)}
      title={pin ? 'Готово!' : 'Добро пожаловать в Redline'}
      actions={
        pin ? (
          <Button variant="primary" size="lg" data-rl-close>Понятно</Button>
        ) : (
          <>
            <Button variant="primary" size="lg" onClick={() => done(true)}>Задать фразу</Button>
            <Button variant="ghost" size="lg" data-rl-close>Позже</Button>
          </>
        )
      }
    >
      {pin ? (
        <p>Этот телефон запомнил вас — PIN больше спрашивать не будем.</p>
      ) : (
        <div className="onboarding">
          <p>Чтобы старые сообщения открылись на новом телефоне, нужна секретная фраза.</p>
          <ol>
            <li>Придумайте фразу из 3–4 слов.</li>
            <li>Запишите её на бумаге и спрячьте дома.</li>
            <li>Никому её не говорите.</li>
          </ol>
        </div>
      )}
    </Modal>
  );
}

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
        <OfflineBar />
        <Onboarding />
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
      <OfflineBar />
      <Onboarding />
      <ChatList activeRoomId={route.name === 'room' || route.name === 'room-info' ? route.roomId : undefined} />
      {route.name === 'room' && <RoomView key={route.roomId} roomId={route.roomId} />}
      {route.name === 'room-info' && <RoomInfo key={route.roomId} roomId={route.roomId} />}
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
