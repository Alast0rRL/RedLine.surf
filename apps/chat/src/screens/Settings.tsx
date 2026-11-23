import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useClient, useMatrix } from '../state/MatrixContext';
import { navigate } from '../hooks/useHashRoute';
import { useSecurityState } from '../hooks/useSecurityState';
import { changePassword, passwordProblem, friendlyError } from '../lib/account';
import { findAdminRoom } from '../lib/admin';
import { isPinUser, PIN_MAX, PIN_MIN, PIN_HINT, pinOk } from '../lib/pin';
import { formatLogin } from '../lib/login';
import { NAME_MAX, nameProblem, removeAvatar, setAvatar, setName } from '../lib/profile';
import { disablePush, enablePush, getPushState, type PushState } from '../lib/push';
import { switchToPin } from '../lib/switchToPin';
import { restoreWithOldSecret } from '../lib/restoreOld';
import { normalizePhone } from '../lib/phone';
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

/** Вход по паролю → вход по номеру и PIN. Секретных фраз больше нет. */
function SwitchToPinSection() {
  const client = useClient();
  const [state] = useSecurityState(client);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (busy) return;
    setOpen(false);
    setPassword('');
    setPhone('');
    setPin('');
    setPin2('');
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return setError('Введите пароль от входа');
    if (!normalizePhone(phone)) return setError('Проверьте номер');
    if (!pinOk(pin)) return setError(`PIN — ${PIN_HINT.toLowerCase()}`);
    if (pin !== pin2) return setError('PIN не совпадает');
    setError(null);
    setBusy(true);
    try {
      await switchToPin(client, { password, phone, pin });
      toast('Готово: теперь вход по номеру и PIN', { variant: 'success' });
      setBusy(false);
      setOpen(false);
      navigate.list();
    } catch (err) {
      setError(friendlyError(err, 'Что-то пошло не так. Попробуйте ещё раз'));
      setBusy(false);
    }
  };

  const lost = state === 'needs-unlock';
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, PIN_MAX);

  return (
    <Card solid className="settings-card">
      <h2 className="settings-card__title"><Icon name="shield" size={18} /> Вход по номеру и PIN</h2>
      <p className="settings-card__text">
        Как у всех: номер телефона и PIN из {PIN_MIN}–{PIN_MAX} цифр. Пароль и секретная фраза больше не понадобятся,
        переписка откроется на любом устройстве по номеру и PIN.
      </p>
      {lost && (
        <p className="settings-card__text">
          На этом устройстве старые сообщения закрыты. Если перейти отсюда, они пропадут. Лучше сделать это там, где переписка открыта.
        </p>
      )}
      <Button variant="primary" disabled={state === 'checking' || state === 'unavailable'} onClick={() => setOpen(true)}>
        Перейти на номер и PIN
      </Button>

      <Modal open={open} onClose={close} title="Вход по номеру и PIN">
        <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
          <Field label="Текущий пароль" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          <Field label="Номер телефона" name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+7 900 123-45-67" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={busy} />
          <Field label="Новый PIN" name="pin" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={PIN_MAX} autoComplete="off" className="pin-input" hint={`${PIN_HINT}. Запомните его`} value={pin} onChange={(e) => setPin(digits(e.target.value))} disabled={busy} />
          <Field label="PIN ещё раз" name="pin2" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={PIN_MAX} autoComplete="off" className="pin-input" value={pin2} onChange={(e) => setPin2(digits(e.target.value))} disabled={busy} />
          {lost && <p className="rl-hint rl-hint--error">Старые сообщения на этом устройстве пропадут.</p>}
          {error && <p className="rl-hint rl-hint--error" role="alert">{error}</p>}
          <Button type="submit" variant="primary" size="lg" block busy={busy}>Перейти</Button>
        </form>
      </Modal>
    </Card>
  );
}

/** Старые сообщения, закрытые прежней фразой или номером (для тех, кто уже входит по PIN). */
function OldMessagesSection() {
  const client = useClient();
  const [state, refresh] = useSecurityState(client);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state !== 'needs-unlock') return null;

  const close = () => {
    if (busy) return;
    setOpen(false);
    setValue('');
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const n = await restoreWithOldSecret(client, value);
      toast(n ? `Готово, открыто ключей: ${n}` : 'Готово, старые сообщения открыты', { variant: 'success' });
      setBusy(false);
      setOpen(false);
      setValue('');
      refresh();
    } catch (err) {
      setError(friendlyError(err, 'Не получилось. Попробуйте ещё раз'));
      setBusy(false);
    }
  };

  return (
    <Card solid className="settings-card">
      <h2 className="settings-card__title"><Icon name="key" size={18} /> Старые сообщения</h2>
      <p className="settings-card__text">
        Старые сообщения закрыты прежним номером или секретной фразой. Введите их один раз, и дальше они будут открываться по номеру и PIN.
      </p>
      <Button variant="primary" onClick={() => setOpen(true)}>Открыть</Button>
      <Modal open={open} onClose={close} title="Открыть старые сообщения">
        <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
          <Field
            label="Старый номер или секретная фраза"
            name="old-secret"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            hint="Тот, что указывали для восстановления раньше"
            value={value}
            error={error}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
          />
          <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={!value.trim()}>Открыть</Button>
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
      {userId && <div className="profile__id">{formatLogin(userId)}</div>}
    </div>
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
        <ProfileSection fallbackName={name} />
        <AdminSection />
        <PushSection />
        <ThemeSection />
        {pin && <OldMessagesSection />}
        {pin && <PhoneSection />}
        {!pin && (
          <>
            <SwitchToPinSection />
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
        <p>{pin ? 'Чтобы войти снова, понадобится PIN.' : 'Чтобы войти снова, понадобится пароль.'}</p>
      </Modal>
    </section>
  );
}
