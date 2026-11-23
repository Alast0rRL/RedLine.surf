import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useClient, useMatrix } from '../state/MatrixContext';
import { navigate } from '../hooks/useHashRoute';
import { useSecurityState } from '../hooks/useSecurityState';
import { changePassword, passwordProblem, friendlyError } from '../lib/account';
import { findAdminRoom } from '../lib/admin';
import { isPinUser } from '../lib/pin';
import { formatLogin } from '../lib/login';
import { NAME_MAX, nameProblem, removeAvatar, setAvatar, setName } from '../lib/profile';
import { disablePush, enablePush, getPushState, type PushState } from '../lib/push';
import {
  changeRecoveryPhrase,
  getRecoveryMask,
  phonePassphrase,
  saveRecoveryMeta,
  setupRecovery,
  unlockWithRecovery,
} from '../lib/security';
import { Avatar, Button, Card, Field, Icon, Modal, toast } from '../components/ui';
import { setThemeMode, useThemeMode, type ThemeMode } from '../lib/theme';
import { PhoneSection } from './PhoneSection';

const PUSH_TEXT: Record<PushState, string> = {
  unsupported: 'Этот браузер не умеет присылать уведомления. На iPhone сначала добавьте Redline на экран «Домой»',
  'not-configured': 'Уведомления пока недоступны. Напишите тому, кто вас пригласил',
  denied: 'Уведомления выключены в настройках телефона. Включите их там для Redline',
  off: 'Выключены',
  on: 'Включены',
};

const THEME_OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: 'light', label: 'Светлая' },
  { mode: 'dark', label: 'Тёмная' },
  { mode: 'system', label: 'Как в системе' },
];

function ThemeSection() {
  const mode = useThemeMode();
  const current = THEME_OPTIONS.find((o) => o.mode === mode)!;
  return (
    <Card solid className="settings-card">
      <h2 className="settings-card__title"><Icon name="settings" size={18} /> Тема: {current.label}</h2>
      <div className="segmented" role="group" aria-label="Тема оформления">
        {THEME_OPTIONS.map((o) => (
          <button key={o.mode} type="button" aria-pressed={o.mode === mode} onClick={() => setThemeMode(o.mode)}>
            {o.label}
          </button>
        ))}
      </div>
    </Card>
  );
}

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
      toast(friendlyError(e, 'Не удалось включить уведомления. Попробуйте ещё раз'), { variant: 'error' });
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
      <h2 className="settings-card__title"><Icon name="shield" size={18} /> Люди</h2>
      <p className="settings-card__text">Здесь можно приглашать родных и близких и управлять доступом.</p>
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
  const [phone, setPhone] = useState('');
  const [legacy, setLegacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [, setTick] = useState(0);
  const mask = getRecoveryMask(client);

  const close = () => {
    setDialog(null);
    setPassword('');
    setPhone('');
    setLegacy(false);
    setErrors({});
    setBusy(false);
    setTick((t) => t + 1);
    refresh();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const mode = dialog;
    if (!mode) return;
    const next: Record<string, string> = {};
    const digits = phonePassphrase(phone);
    if (mode === 'unlock' && legacy) {
      if (!phone.trim()) next.phone = 'Введите старую секретную фразу';
    } else {
      if (mode === 'setup' && !password) next.password = 'Введите пароль от входа';
      if (!digits) next.phone = 'Проверьте номер';
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      if (mode === 'setup') {
        await setupRecovery(client, password, digits!);
        await saveRecoveryMeta(client, digits!);
        toast('Номер сохранён', { variant: 'success' });
      } else if (mode === 'change') {
        await changeRecoveryPhrase(client, digits!);
        await saveRecoveryMeta(client, digits!);
        toast('Номер сохранён', { variant: 'success' });
      } else {
        const { imported } = await unlockWithRecovery(client, legacy ? phone : digits!, legacy);
        toast(imported ? 'Готово, старые сообщения открыты' : 'Готово, этот телефон подтверждён', { variant: 'success' });
      }
      close();
    } catch (err) {
      const e2 = err as { errcode?: string; message?: string };
      const field = mode === 'unlock' ? 'phone' : 'form';
      setErrors({ [field]: e2.errcode === 'M_FORBIDDEN' ? 'Пароль не подошёл. Проверьте, нет ли опечаток' : friendlyError(err, 'Что-то пошло не так. Попробуйте ещё раз') });
      setBusy(false);
    }
  };

  const text =
    state === 'ok'
      ? mask
        ? `Старые сообщения открываются по номеру ${mask}`
        : 'Сейчас старые сообщения открываются по старой секретной фразе.'
      : {
          checking: 'Проверяем…',
          unavailable: 'Защита переписки не работает в этом браузере. Откройте Redline в Chrome или Safari.',
          'needs-setup': 'Укажите номер телефона — по нему старые сообщения откроются на новом устройстве.',
          'needs-unlock': 'Введите номер телефона, чтобы открыть старые сообщения на этом устройстве.',
        }[state];
  const isLegacyField = dialog === 'unlock' && legacy;

  return (
    <Card solid className="settings-card">
      <h2 className="settings-card__title"><Icon name="shield" size={18} /> Восстановление переписки</h2>
      <p className="settings-card__text">{text}</p>
      {state === 'needs-setup' && <Button variant="primary" onClick={() => setDialog('setup')}>Указать номер</Button>}
      {state === 'needs-unlock' && <Button variant="primary" onClick={() => setDialog('unlock')}>Ввести номер</Button>}
      {state === 'ok' && mask && <Button variant="secondary" onClick={() => setDialog('change')}>Сменить номер</Button>}
      {state === 'ok' && !mask && <Button variant="primary" onClick={() => setDialog('change')}>Перевести на номер телефона</Button>}

      <Modal
        open={dialog !== null}
        onClose={close}
        title={dialog === 'setup' ? 'Номер для восстановления' : dialog === 'change' ? (mask ? 'Сменить номер' : 'Перевести на номер телефона') : 'Открыть старые сообщения'}
      >
        <form className="stack" onSubmit={submit}>
          {dialog === 'setup' && (
            <Field
              label="Пароль от входа"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              error={errors.password ?? null}
              onChange={(e) => setPassword(e.target.value)}
              hint="Нужен, чтобы защитить вашу переписку"
            />
          )}
          {dialog === 'change' && <p>Прежний номер или фраза перестанут работать.</p>}
          <Field
            label={isLegacyField ? 'Старая секретная фраза' : 'Номер телефона'}
            name="phone"
            type={isLegacyField ? 'password' : 'tel'}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={phone}
            error={errors.phone ?? null}
            hint={errors.phone || isLegacyField ? undefined : 'Например, +7 900 123-45-67. Он понадобится, чтобы открыть старые сообщения'}
            onChange={(e) => setPhone(e.target.value)}
          />
          {dialog === 'unlock' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setLegacy((v) => !v);
                setPhone('');
                setErrors({});
              }}
            >
              {legacy ? 'Ввести номер телефона' : 'У меня старая секретная фраза'}
            </Button>
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
    if (!current) local.current = 'Введите нынешний пароль';
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
      setErrors({ current: friendlyError(err, 'Не удалось сменить пароль') });
      setBusy(false);
    }
  };

  return (
    <Card solid className="settings-card">
      <h2 className="settings-card__title"><Icon name="lock" size={18} /> Пароль</h2>
      <p className="settings-card__text">Пароль нужен для входа. Старые сообщения на новом телефоне открываются по номеру телефона.</p>
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
            hint="Не меньше 8 символов"
          />
          <label className="check-row">
            <input type="checkbox" checked={logoutOthers} onChange={(e) => setLogoutOthers(e.target.checked)} />
            <span>Выйти на других устройствах</span>
          </label>
          {logoutOthers && <p>На других устройствах придётся войти заново, а для старых сообщений понадобится номер телефона.</p>}
          <Button type="submit" variant="primary" size="lg" block busy={busy}>Сохранить</Button>
        </form>
      </Modal>
    </Card>
  );
}

/** Имя и фото: их видят все. */
function ProfileSection({ fallbackName }: { fallbackName: string }) {
  const client = useClient();
  const userId = client.getUserId()!;
  const me = client.getUser(userId);
  const [name, setNameState] = useState(me?.displayName ?? '');
  const [avatar, setAvatarState] = useState<string | null>(me?.avatarUrl ?? null);
  const [draft, setDraft] = useState(name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const edited = useRef(false);

  // в кеше клиента профиль бывает неполным: берём с сервера
  useEffect(() => {
    let alive = true;
    client.getProfileInfo(userId).then(
      (p) => {
        if (!alive) return;
        setNameState(p.displayname ?? '');
        if (!edited.current) setDraft(p.displayname ?? '');
        setAvatarState(p.avatar_url || null);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [client, userId]);

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    const problem = nameProblem(draft);
    setNameError(problem);
    if (problem) return;
    setSavingName(true);
    try {
      await setName(client, draft);
      setNameState(draft.trim());
      setDraft(draft.trim());
      edited.current = false;
      toast('Имя сохранено', { variant: 'success' });
    } catch (err) {
      setNameError(friendlyError(err, 'Не удалось сохранить имя'));
    } finally {
      setSavingName(false);
    }
  };

  const pickPhoto = async (file: File | undefined) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    setPhotoBusy(true);
    try {
      await setAvatar(client, file);
      const p = await client.getProfileInfo(userId).catch(() => null);
      setAvatarState(p?.avatar_url || null);
      toast('Фото обновлено', { variant: 'success' });
    } catch (err) {
      toast(friendlyError(err, 'Не удалось загрузить фото'), { variant: 'error' });
    } finally {
      setPhotoBusy(false);
    }
  };

  const dropPhoto = async () => {
    setPhotoBusy(true);
    try {
      await removeAvatar(client);
      setAvatarState(null);
    } catch (err) {
      toast(friendlyError(err, 'Не удалось убрать фото'), { variant: 'error' });
    } finally {
      setPhotoBusy(false);
    }
  };

  const shown = name || fallbackName;
  const changed = draft.trim() !== name;

  return (
    <Card solid className="settings-card profile-card">
    <div className="profile">
      <div className="profile__photo">
        <button
          type="button"
          className="profile__avatar"
          aria-label={avatar ? 'Сменить фото' : 'Добавить фото'}
          disabled={photoBusy}
          onClick={() => fileInput.current?.click()}
        >
          <Avatar client={client} name={shown} seed={userId} mxc={avatar} size="xl" />
          <span className="profile__badge" aria-hidden="true">
            {photoBusy ? <span className="rl-spinner" /> : <Icon name="image" size={18} />}
          </span>
        </button>
        <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => void pickPhoto(e.target.files?.[0])} />
        {avatar && (
          <Button variant="ghost" size="sm" disabled={photoBusy} onClick={() => void dropPhoto()}>
            Убрать фото
          </Button>
        )}
      </div>
      <form className="profile__form" onSubmit={saveName} noValidate>
        <Field
          label="Имя"
          name="displayname"
          autoComplete="nickname"
          maxLength={NAME_MAX}
          value={draft}
          error={nameError}
          disabled={savingName}
          onChange={(e) => {
            edited.current = true;
            setDraft(e.target.value);
            setNameError(null);
          }}
          hint="Так вас видят другие"
        />
        <Button type="submit" variant="primary" busy={savingName} disabled={!changed || savingName}>Сохранить</Button>
      </form>
      {userId && !isPinUser(userId) && <div className="profile__id">{userId}</div>}
    </div>
    </Card>
  );
      {userId && <div className="profile__id">{formatLogin(userId)}</div>}

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
        <ProfileSection fallbackName={name} />
        <AdminSection />
        <PushSection />
        <ThemeSection />
        {pin && <PhoneSection />}
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
        <p>{pin ? 'Чтобы войти снова, понадобится PIN.' : 'Если номер для восстановления не указан, старые сообщения на этом телефоне могут пропасть.'}</p>
      </Modal>
    </section>
  );
}
