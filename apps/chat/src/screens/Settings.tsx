import { useEffect, useState, type FormEvent } from 'react';
import { useClient, useMatrix } from '../state/MatrixContext';
import { navigate } from '../hooks/useHashRoute';
import { useSecurityState } from '../hooks/useSecurityState';
import { disablePush, enablePush, getPushState, type PushState } from '../lib/push';
import { setupRecovery, unlockWithRecoveryKey } from '../lib/security';
import { Avatar, Button, Card, Field, Icon, Modal, toast } from '../components/ui';

const PUSH_TEXT: Record<PushState, string> = {
  unsupported: 'Этот браузер не поддерживает push. На iPhone добавьте приложение на экран «Домой».',
  'not-configured': 'Push не настроен на сервере.',
  denied: 'Уведомления запрещены в настройках браузера.',
  off: 'Выключены',
  on: 'Включены',
};

function PushSection() {
  const client = useClient();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPushState().then(setState);
  }, []);

  const toggle = async () => {
    setBusy(true);
    try {
      setState(state === 'on' ? await disablePush(client) : await enablePush(client));
    } catch (e) {
      console.error(e);
      toast('Не удалось включить уведомления', { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card solid className="settings-card">
      <h2 className="settings-card__title"><Icon name="bell" size={18} /> Уведомления</h2>
      <p className="settings-card__text">{state ? PUSH_TEXT[state] : '…'}</p>
      {(state === 'on' || state === 'off') && (
        <Button variant={state === 'on' ? 'secondary' : 'primary'} busy={busy} onClick={toggle}>
          {state === 'on' ? 'Выключить' : 'Включить'}
        </Button>
      )}
    </Card>
  );
}

function SecuritySection() {
  const client = useClient();
  const [state, refresh] = useSecurityState(client);
  const [dialog, setDialog] = useState<'setup' | 'unlock' | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  const close = () => {
    setDialog(null);
    setInput('');
    setError(null);
    setBusy(false);
    setRecoveryKey(null);
    refresh();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (dialog === 'setup') {
        setRecoveryKey(await setupRecovery(client, input));
        setBusy(false);
      } else {
        const { imported } = await unlockWithRecoveryKey(client, input);
        toast(imported ? `Устройство подтверждено, восстановлено ключей: ${imported}` : 'Устройство подтверждено', { variant: 'success' });
        close();
      }
    } catch (err) {
      const e2 = err as { errcode?: string; message?: string };
      setError(e2.errcode === 'M_FORBIDDEN' ? 'Неверный пароль' : e2.message ?? 'Ошибка');
      setBusy(false);
    }
  };

  const text = {
    checking: 'Проверяем…',
    unavailable: 'Шифрование недоступно в этом браузере.',
    'needs-setup': 'Ключ восстановления не создан. Без него переписку не прочитать на новом устройстве.',
    'needs-unlock': 'Это устройство не подтверждено — старые сообщения не расшифруются. Введите ключ восстановления.',
    ok: 'Устройство подтверждено, ключи сообщений сохраняются в зашифрованной резервной копии.',
  }[state];

  return (
    <Card solid className="settings-card">
      <h2 className="settings-card__title"><Icon name="shield" size={18} /> Шифрование</h2>
      <p className="settings-card__text">{text}</p>
      {state === 'needs-setup' && <Button variant="primary" onClick={() => setDialog('setup')}>Создать ключ</Button>}
      {state === 'needs-unlock' && <Button variant="primary" onClick={() => setDialog('unlock')}>Ввести ключ</Button>}

      <Modal open={dialog !== null} onClose={close} title={dialog === 'setup' ? 'Ключ восстановления' : 'Подтвердить устройство'}>
        {recoveryKey ? (
          <div className="stack">
            <p>Сохраните ключ в надёжном месте (менеджер паролей, бумажка в сейфе). Он понадобится на каждом новом устройстве. Показать его снова нельзя.</p>
            <code className="recovery-key">{recoveryKey}</code>
            <Button
              variant="secondary"
              onClick={() => navigator.clipboard.writeText(recoveryKey).then(() => toast('Скопировано!'))}
            >
              <Icon name="copy" size={16} /> Скопировать
            </Button>
            <Button variant="primary" onClick={close}>Я сохранил(а) ключ</Button>
          </div>
        ) : (
          <form className="stack" onSubmit={submit}>
            {dialog === 'setup' ? (
              <Field label="Пароль от аккаунта" type="password" autoComplete="current-password" value={input} onChange={(e) => setInput(e.target.value)} error={error} hint="Сервер просит подтвердить создание ключей" />
            ) : (
              <Field label="Ключ восстановления" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="EsTc …" value={input} onChange={(e) => setInput(e.target.value)} error={error} />
            )}
            <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={!input.trim()}>
              {dialog === 'setup' ? 'Создать' : 'Подтвердить'}
            </Button>
          </form>
        )}
      </Modal>
    </Card>
  );
}

export function Settings() {
  const client = useClient();
  const { logout } = useMatrix();
  const me = client.getUser(client.getUserId()!);
  const [confirm, setConfirm] = useState(false);
  const name = me?.displayName ?? client.getUserId()!;

  return (
    <section className="pane pane--room" aria-label="Настройки">
      <header className="topbar topbar--room">
        <Button variant="ghost" icon aria-label="Назад" className="topbar__back" onClick={() => navigate.list()}><Icon name="back" /></Button>
        <span className="topbar__title"><span className="topbar__name">Настройки</span></span>
      </header>
      <div className="settings">
        <div className="profile">
          <Avatar client={client} name={name} seed={client.getUserId()!} mxc={me?.avatarUrl} size="lg" />
          <div>
            <div className="profile__name">{name}</div>
            <div className="profile__id">{client.getUserId()}</div>
          </div>
        </div>
        <PushSection />
        <SecuritySection />
        <Card solid className="settings-card">
          <h2 className="settings-card__title"><Icon name="logout" size={18} /> Сеанс</h2>
          <p className="settings-card__text">Устройство: <code>{client.getDeviceId()}</code></p>
          <Button variant="outline" onClick={() => setConfirm(true)}>Выйти</Button>
        </Card>
        <p className="settings__version">Redline Chat · {__APP_VERSION__}</p>
      </div>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Выйти?"
        actions={
          <>
            <Button variant="primary" size="lg" onClick={() => void logout()}>Выйти</Button>
            <Button variant="ghost" size="lg" data-rl-close>Отмена</Button>
          </>
        }
      >
        <p>Если ключ восстановления не сохранён, зашифрованные сообщения на этом устройстве будут потеряны.</p>
      </Modal>
    </section>
  );
}
