import { useEffect, useState, type FormEvent } from 'react';
import { useClient, useMatrix } from '../state/MatrixContext';
import { navigate } from '../hooks/useHashRoute';
import { useSecurityState } from '../hooks/useSecurityState';
import { changePassword, passwordProblem } from '../lib/account';
import { findAdminRoom } from '../lib/admin';
import { isPinUser } from '../lib/pin';
import { disablePush, enablePush, getPushState, type PushState } from '../lib/push';
import {
  changeRecoveryPhrase,
  normalizePhrase,
  phraseProblem,
  setupRecovery,
  unlockWithRecovery,
} from '../lib/security';
import { Avatar, Button, Card, Field, Icon, Modal, toast } from '../components/ui';

const PUSH_TEXT: Record<PushState, string> = {
  unsupported: 'Этот браузер не поддерживает push. На iPhone добавьте приложение на экран «Домой».',
  'not-configured': 'Push не настроен на сервере.',
  denied: 'Уведомления запрещены в настройках браузера.',
  off: 'Выключены',
  on: 'Включены',
};

const PHRASE_HINT = 'Нужна на новом телефоне, чтобы прочитать старую переписку. Лучше 3–4 слова. Запишите её';

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

function AdminSection() {
  const client = useClient();
  const [adminRoom, setAdminRoom] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    findAdminRoom(client)
      .then((roomId) => {
        if (alive) setAdminRoom(roomId);
      })
      .catch(() => {
        if (alive) setAdminRoom(null);
      });
    return () => {
      alive = false;
    };
  }, [client]);

  if (!adminRoom) return null;
  return (
    <Card solid className="settings-card">
      <h2 className="settings-card__title"><Icon name="shield" size={18} /> Семья</h2>
      <p className="settings-card__text">Здесь можно приглашать родных и управлять ссылками.</p>
      <Button variant="primary" onClick={() => navigate.people()}>Пригласить и управлять</Button>
    </Card>
  );
}

type SecurityDialog = 'setup' | 'unlock' | 'change' | null;

function SecuritySection() {
  const client = useClient();
  const [state, refresh] = useSecurityState(client);
  const [dialog, setDialog] = useState<SecurityDialog>(null);
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [phrase2, setPhrase2] = useState('');
  const [recovery, setRecovery] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const close = () => {
    setDialog(null);
    setPassword('');
    setPhrase('');
    setPhrase2('');
    setRecovery('');
    setErrors({});
    setBusy(false);
    refresh();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const mode = dialog;
    if (!mode) return;
    const next: Record<string, string> = {};
    if (mode === 'unlock') {
      if (!recovery.trim()) next.recovery = 'Введите фразу или ключ';
    } else {
      if (mode === 'setup' && !password) next.password = 'Введите пароль от аккаунта';
      const problem = phraseProblem(phrase, mode === 'setup' ? password : undefined);
      if (problem) next.phrase = problem;
      else if (normalizePhrase(phrase) !== normalizePhrase(phrase2)) next.phrase2 = 'Фразы не совпадают';
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      if (mode === 'setup') {
        await setupRecovery(client, password, phrase);
        toast('Фраза восстановления создана', { variant: 'success' });
      } else if (mode === 'change') {
        await changeRecoveryPhrase(client, phrase);
        toast('Фраза восстановления изменена', { variant: 'success' });
      } else {
        const { imported } = await unlockWithRecovery(client, recovery);
        toast(imported ? `Устройство подтверждено, восстановлено ключей: ${imported}` : 'Устройство подтверждено', { variant: 'success' });
      }
      close();
    } catch (err) {
      const e2 = err as { errcode?: string; message?: string };
      const field = mode === 'unlock' ? 'recovery' : 'form';
      setErrors({ [field]: e2.errcode === 'M_FORBIDDEN' ? 'Неверный пароль' : e2.message || 'Ошибка' });
      setBusy(false);
    }
  };

  const text = {
    checking: 'Проверяем…',
    unavailable: 'Шифрование недоступно в этом браузере.',
    'needs-setup': 'Задайте фразу восстановления, чтобы не потерять переписку.',
    'needs-unlock': 'Введите фразу восстановления, чтобы читать старые сообщения.',
    ok: 'Устройство подтверждено, фраза восстановления задана.',
  }[state];

  return (
    <Card solid className="settings-card">
      <h2 className="settings-card__title"><Icon name="shield" size={18} /> Шифрование</h2>
      <p className="settings-card__text">{text}</p>
      {state === 'needs-setup' && <Button variant="primary" onClick={() => setDialog('setup')}>Задать фразу</Button>}
      {state === 'needs-unlock' && <Button variant="primary" onClick={() => setDialog('unlock')}>Ввести фразу</Button>}
      {state === 'ok' && <Button variant="secondary" onClick={() => setDialog('change')}>Сменить фразу</Button>}

      <Modal
        open={dialog !== null}
        onClose={close}
        title={dialog === 'setup' ? 'Фраза восстановления' : dialog === 'change' ? 'Сменить фразу' : 'Подтвердить устройство'}
      >
        <form className="stack" onSubmit={submit}>
          {dialog === 'setup' && (
            <Field
              label="Пароль от аккаунта"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              error={errors.password ?? null}
              onChange={(e) => setPassword(e.target.value)}
              hint="Сервер просит подтвердить создание ключей"
            />
          )}
          {dialog === 'unlock' && (
            <Field
              label="Фраза или старый ключ восстановления"
              name="recovery"
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={recovery}
              error={errors.recovery ?? null}
              onChange={(e) => setRecovery(e.target.value)}
            />
          )}
          {(dialog === 'setup' || dialog === 'change') && (
            <>
              {dialog === 'change' && <p>Старая фраза и старый ключ перестанут работать. Запишите новую фразу.</p>}
              <Field
                label="Фраза восстановления"
                name="phrase"
                type="password"
                autoComplete="off"
                value={phrase}
                error={errors.phrase ?? null}
                hint={errors.phrase ? undefined : PHRASE_HINT}
                onChange={(e) => setPhrase(e.target.value)}
              />
              <Field
                label="Повторите фразу"
                name="phrase2"
                type="password"
                autoComplete="off"
                value={phrase2}
                error={errors.phrase2 ?? null}
                onChange={(e) => setPhrase2(e.target.value)}
              />
            </>
          )}
          {errors.form && <p className="rl-hint rl-hint--error" role="alert">{errors.form}</p>}
          <Button type="submit" variant="primary" size="lg" block busy={busy}>
            {dialog === 'unlock' ? 'Подтвердить' : 'Сохранить'}
          </Button>
        </form>
      </Modal>
    </Card>
  );
}

function PasswordSection() {
  const client = useClient();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [logoutOthers, setLogoutOthers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const close = () => {
    setOpen(false);
    setCurrent('');
    setNext('');
    setLogoutOthers(false);
    setErrors({});
    setBusy(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!current) local.current = 'Введите текущий пароль';
    const problem = passwordProblem(next);
    if (problem) local.next = problem;
    setErrors(local);
    if (Object.keys(local).length) return;

    setBusy(true);
    try {
      await changePassword(client, current, next, logoutOthers);
      toast('Пароль изменён', { variant: 'success' });
      close();
    } catch (err) {
      setErrors({ current: (err as Error).message || 'Не удалось сменить пароль' });
      setBusy(false);
    }
  };

  return (
    <Card solid className="settings-card">
      <h2 className="settings-card__title"><Icon name="lock" size={18} /> Пароль</h2>
      <p className="settings-card__text">Пароль нужен для входа. Переписку открывает отдельная фраза восстановления.</p>
      <Button variant="outline" onClick={() => setOpen(true)}>Сменить пароль</Button>
      <Modal open={open} onClose={close} title="Сменить пароль">
        <form className="stack" onSubmit={submit}>
          <Field
            label="Текущий пароль"
            name="current"
            type="password"
            autoComplete="current-password"
            value={current}
            error={errors.current ?? null}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Field
            label="Новый пароль"
            name="next"
            type="password"
            autoComplete="new-password"
            value={next}
            error={errors.next ?? null}
            onChange={(e) => setNext(e.target.value)}
            hint="Не короче 8 символов"
          />
          <label className="check-row">
            <input type="checkbox" checked={logoutOthers} onChange={(e) => setLogoutOthers(e.target.checked)} />
            <span>Выйти на других устройствах</span>
          </label>
          {logoutOthers && <p>На этих устройствах для чтения старой переписки понадобится фраза восстановления.</p>}
          <Button type="submit" variant="primary" size="lg" block busy={busy}>Сохранить</Button>
        </form>
      </Modal>
    </Card>
  );
}

export function Settings() {
  const client = useClient();
  const { logout } = useMatrix();
  const me = client.getUser(client.getUserId()!);
  const [confirm, setConfirm] = useState(false);
  const pin = isPinUser(client.getUserId());
  const name = me?.displayName ?? (pin ? 'Вы' : client.getUserId()!);

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
            {!pin && <div className="profile__id">{client.getUserId()}</div>}
          </div>
        </div>
        <AdminSection />
        <PushSection />
        {!pin && (
          <>
            <SecuritySection />
            <PasswordSection />
          </>
        )}
        <Card solid className="settings-card">
          <h2 className="settings-card__title"><Icon name="logout" size={18} /> Сеанс</h2>
          {!pin && <p className="settings-card__text">Устройство: <code>{client.getDeviceId()}</code></p>}
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
        <p>{pin ? 'Чтобы войти снова, понадобится PIN.' : 'Если фраза восстановления не сохранена, зашифрованные сообщения на этом устройстве будут потеряны.'}</p>
      </Modal>
    </section>
  );
}
