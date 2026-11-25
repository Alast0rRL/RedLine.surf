import { Button } from '../components/ui';
import { TgList } from './TgList';
import { TgChat } from './TgChat';
import { useTgReady } from './hooks';

/** Вкладка Telegram: список слева, переписка справа (на телефоне — по очереди). */
export function TgArea({ peerId }: { peerId?: number }) {
  const [ready, retry] = useTgReady();
  const ok = ready.state === 'ready';
  return (
    <>
      <TgList ready={ok} activeId={peerId} />
      {peerId !== undefined ? (
        <TgChat key={peerId} peerId={peerId} ready={ok} />
      ) : (
        <section className="pane pane--room pane--placeholder" aria-hidden={ready.state !== 'error'}>
          {ready.state === 'error' ? (
            <div className="empty">
              <p>{ready.error}</p>
              <Button variant="primary" onClick={retry}>Повторить</Button>
            </div>
          ) : (
            <p>{ok ? 'Выберите чат' : 'Подключаемся к Telegram…'}</p>
          )}
        </section>
      )}
    </>
  );
}
