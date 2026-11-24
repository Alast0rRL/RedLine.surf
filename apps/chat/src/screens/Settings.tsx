import { Children, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useClient, useMatrix } from '../state/MatrixContext';
import { navigate } from '../hooks/useHashRoute';
import { useSecurityState } from '../hooks/useSecurityState';
import { changePassword, passwordProblem, friendlyError } from '../lib/account';
import { findAdminRoom } from '../lib/admin';
import { isPinUser, PIN_MAX, PIN_MIN, PIN_HINT, pinOk } from '../lib/pin';
import { createMemberInvite, formatJoinLink, loadInviteOverview, revokeMemberInvite, type GuestInvite } from '../lib/guestInvites';
import { formatLogin } from '../lib/login';
import { NAME_MAX, nameProblem, removeAvatar, setAvatar, setName } from '../lib/profile';
import { disablePush, enablePush, getPushState, type PushState } from '../lib/push';
import { switchToPin } from '../lib/switchToPin';
import { getBoundPhone, normalizePhone } from '../lib/phone';
import { Avatar, Button, Card, Field, Icon, Modal, toast, type IconName } from '../components/ui';
import { QrCode } from '../components/QrCode';
import { setThemeMode, useThemeMode, type ThemeMode } from '../lib/theme';
import { PhoneSection } from './PhoneSection';
import { MinecraftSection } from './MinecraftSection';
import { getRealm } from '../config';

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
  { mode: 'system', label: 'Авто' },
];

type SectionKey = 'phone' | 'mc' | 'pin' | 'password';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

function SettingsGroup({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  const rows = Children.toArray(children);
  if (!rows.length) return null;
  return (
    <Card solid className="settings-card settings-group">
      <h2 className="settings-group__title">{title}</h2>
      <div className="settings-rows" id={id}>{rows}</div>
    </Card>
  );
}

function SettingsRow({
  icon,
  label,
  note,
  value,
  onClick,
  expanded,
  danger,
  children,
}: {
  icon: IconName;
  label: string;
  note?: string;
  value?: ReactNode;
  onClick?: () => void;
  expanded?: boolean;
  danger?: boolean;
  children?: ReactNode;
}) {
  const content = (
    <>
      <span className="settings-row__icon"><Icon name={icon} size={20} /></span>
      <span className="settings-row__label">
        <span>{label}</span>
        {note && <span className="settings-row__note">{note}</span>}
      </span>
      {children ?? (value !== undefined && <span className="settings-row__value">{value}</span>)}
      {onClick && (
        <span className={cx('settings-row__chevron', expanded && 'settings-row__chevron--open')}>
          <Icon name="back" size={18} />
        </span>
      )}
    </>
  );
  const className = cx(
    'settings-row',
    onClick && 'settings-row--button',
    danger && 'settings-row--danger',
    expanded && 'settings-row--expanded',
  );
  return onClick ? (
    <button type="button" className={className} onClick={onClick}>{content}</button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function ThemeRow() {
  const mode = useThemeMode();
  return (
    <SettingsRow icon="settings" label="Тема">
      <div className="segmented segmented--compact" role="group" aria-label="Тема оформления">
        {THEME_OPTIONS.map((o) => (
          <button key={o.mode} type="button" aria-pressed={o.mode === mode} onClick={() => setThemeMode(o.mode)}>
            {o.label}
          </button>
        ))}
      </div>
    </SettingsRow>
  );
}

function PushRow() {
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

  const available = state === 'on' || state === 'off';

  return (
    <SettingsRow icon="bell" label="Уведомления" note={state && !available ? PUSH_TEXT[state] : undefined}>
      <button
        type="button"
        role="switch"
        className="rl-switch"
        aria-label="Уведомления"
        aria-checked={state === 'on'}
        disabled={!available || busy}
        onClick={() => void toggle()}
      />
    </SettingsRow>
  );
}

function AdminGroup() {
  const client = useClient();
  const { realm } = useMatrix();
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
  const mc = realm === 'mc';
  return (
    <SettingsGroup title="Администрирование">
      <SettingsRow
        icon="shield"
        label={mc ? 'Игроки' : 'Люди'}
        onClick={() => (mc ? navigate.mcPlayers() : navigate.people())}
      />
    </SettingsGroup>
  );
}

function InviteRow() {
  const client = useClient();
  const { realm } = useMatrix();
  const accessToken = client.getAccessToken();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [invites, setInvites] = useState<GuestInvite[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (realm !== 'family' || !accessToken) {
      setAllowed(false);
      return;
    }
    let alive = true;
    loadInviteOverview(accessToken)
      .then((r) => {
        if (alive) setAllowed(!r.guest);
      })
      .catch(() => {
        if (alive) setAllowed(true);
      });
    return () => {
      alive = false;
    };
  }, [realm, accessToken]);

  const refresh = async () => {
    if (!accessToken) return;
    const overview = await loadInviteOverview(accessToken);
    setInvites(overview.invites);
  };

  const openModal = async () => {
    setOpen(true);
    setError(null);
    try {
      await refresh();
    } catch {
      toast('Не удалось загрузить приглашения. Попробуйте ещё раз', { variant: 'error' });
    }
  };

  const close = () => {
    if (busy) return;
    setOpen(false);
    setName('');
    setLink(null);
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy('create');
    setError(null);
    try {
      const created = await createMemberInvite(client, name);
      setLink(formatJoinLink(created.token));
      setName('');
      await refresh();
      toast('Ссылка создана', { variant: 'success' });
    } catch (e) {
      setError(friendlyError(e, 'Не удалось создать ссылку. Попробуйте ещё раз'));
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast('Ссылка скопирована', { variant: 'success' });
    } catch {
      toast('Не получилось скопировать. Выделите текст и скопируйте вручную', { variant: 'error' });
    }
  };

  const share = async () => {
    if (!link || !navigator.share) return;
    try {
      await navigator.share({ title: 'Личная ссылка', text: 'Личная ссылка для входа в Redline Chat', url: link });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.warn('Не удалось отправить ссылку');
    }
  };

  const revoke = async (invite: GuestInvite) => {
    setBusy(`revoke:${invite.token}`);
    try {
      await revokeMemberInvite(client, invite.token);
      if (link === formatJoinLink(invite.token)) setLink(null);
      await refresh();
      toast('Ссылка отозвана', { variant: 'success' });
    } catch (e) {
      toast(friendlyError(e, 'Не удалось отозвать ссылку. Попробуйте ещё раз'), { variant: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const show = (invite: GuestInvite) => setLink(formatJoinLink(invite.token));

  if (!allowed) return null;
  const canShare = typeof navigator.share === 'function';
  return (
    <>
      <SettingsRow
        icon="plus"
        label="Пригласить"
        note="Друга, коллегу или родственника"
        onClick={() => void openModal()}
      />
      <Modal open={open} onClose={close} title="Пригласить">
        <div className="stack">
          <form className="stack" onSubmit={(e) => void submit(e)}>
            <Field
              label="Как зовут"
              name="guestName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Друг"
              maxLength={40}
              disabled={!!busy}
            />
            <Button type="submit" variant="primary" busy={busy === 'create'} disabled={!name.trim() || !!busy}>
              Создать ссылку
            </Button>
          </form>
          {error && <p className="rl-hint rl-hint--error" role="alert">{error}</p>}
          {link && (
            <div className="stack">
              <QrCode value={link} />
              <code className="invite-link">{link}</code>
              <p>Это личная ссылка: она нужна и для нового телефона. Не пересылайте её другим.</p>
              <Button variant="secondary" onClick={() => void copyLink()}>Скопировать</Button>
              {canShare && <Button variant="primary" onClick={() => void share()}>Отправить</Button>}
            </div>
          )}
          <div className="stack">
            <p className="settings-group__title">Мои приглашения</p>
            {invites.length ? (
              <ul className="people-list">
                {invites.map((invite) => (
                  <li className="people-row" key={invite.token}>
                    <span className="people-row__main">
                      <span className="people-row__name">{invite.label || 'Без подписи'}</span>
                      <span className="people-row__meta">
                        {new Date(invite.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                      </span>
                    </span>
                    <span className="people-row__actions">
                      <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => show(invite)}>Показать</Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        busy={busy === `revoke:${invite.token}`}
                        disabled={!!busy}
                        onClick={() => void revoke(invite)}
                      >
                        Отозвать
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rl-hint">Активных приглашений нет</p>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}

/** Вход по паролю → вход по номеру и PIN. Секретных фраз больше нет. */
function SwitchToPinSection() {
  const client = useClient();
  const { logout } = useMatrix();
  const [state] = useSecurityState(client);
  // номер уже привязан (переход сделан на другом устройстве или админом на сервере): здесь только перевойти
  const [boundMask, setBoundMask] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const token = client.getAccessToken();
    if (!token) return setBoundMask(null);
    let alive = true;
    getBoundPhone(token).then((m) => alive && setBoundMask(m), () => alive && setBoundMask(null));
    return () => {
      alive = false;
    };
  }, [client]);
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

  if (boundMask) {
    return (
      <Card solid className="settings-card">
        <h2 className="settings-card__title"><Icon name="shield" size={18} /> Вход по номеру и PIN</h2>
        <p className="settings-card__text">
          Вход по номеру {boundMask} и PIN уже настроен, пароль больше не действует. Выйдите и войдите по номеру и PIN.
        </p>
        <Button variant="primary" onClick={() => void logout()}>Выйти и войти по номеру</Button>
      </Card>
    );
  }

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
              {photoBusy ? <span className="rl-spinner" /> : <Icon name="image" size={16} />}
            </span>
          </button>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => void pickPhoto(e.target.files?.[0])} />
        </div>
        <form className="profile__form" onSubmit={saveName} noValidate>
          <Field
            className="profile-name"
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
            suffix={changed ? (
              <Button type="submit" variant="primary" size="sm" icon aria-label="Сохранить имя" busy={savingName} disabled={savingName}>
                <Icon name="check" size={18} />
              </Button>
            ) : null}
          />
          <div className="profile__lines">
            {userId && <span className="profile__id">{formatLogin(userId)}</span>}
            {avatar && (
              <button type="button" className="profile__remove-photo" disabled={photoBusy} onClick={() => void dropPhoto()}>
                Убрать фото
              </button>
            )}
          </div>
        </form>
      </div>
    </Card>
  );
}

export function Settings() {
  const client = useClient();
  const { logout } = useMatrix();
  const me = client.getUser(client.getUserId()!);
  const [confirm, setConfirm] = useState(false);
  const [expanded, setExpanded] = useState<SectionKey | null>(null);
  const pin = isPinUser(client.getUserId());
  const name = me?.displayName ?? (pin ? 'Вы' : client.getUserId()!);
  const toggle = (key: SectionKey) => setExpanded((current) => (current === key ? null : key));
  const openPassword = () => {
    setExpanded('password');
    document.getElementById('settings-account')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <section className="pane pane--room" aria-label="Настройки">
      <header className="topbar topbar--room">
        <Button variant="ghost" icon aria-label="Назад" className="topbar__back" onClick={() => navigate.list()}><Icon name="back" /></Button>
        <span className="topbar__title"><span className="topbar__name">Настройки</span></span>
      </header>
      <div className="settings">
        <ProfileSection fallbackName={name} />

        <SettingsGroup title="Общие">
          <InviteRow />
          <PushRow />
          <ThemeRow />
        </SettingsGroup>

        <SettingsGroup id="settings-account" title="Аккаунт">
          {pin && getRealm() === 'family' && (
            <>
              <SettingsRow icon="key" label="Вход по номеру" expanded={expanded === 'phone'} onClick={() => toggle('phone')} />
              {expanded === 'phone' && <div className="settings-expand"><PhoneSection /></div>}
              <SettingsRow icon="bot" label="Minecraft" expanded={expanded === 'mc'} onClick={() => toggle('mc')} />
              {expanded === 'mc' && <div className="settings-expand"><MinecraftSection /></div>}
            </>
          )}
          {!pin && (
            <>
              <SettingsRow icon="shield" label="Вход по номеру и PIN" expanded={expanded === 'pin'} onClick={() => toggle('pin')} />
              {expanded === 'pin' && <div className="settings-expand"><SwitchToPinSection /></div>}
              <SettingsRow icon="lock" label="Пароль и безопасность" expanded={expanded === 'password'} onClick={() => toggle('password')} />
              {expanded === 'password' && <div className="settings-expand"><PasswordSection /></div>}
            </>
          )}
        </SettingsGroup>

        <AdminGroup />

        <Card solid className="settings-card settings-logout">
          <button type="button" className="settings-row settings-row--button settings-row--danger" onClick={() => setConfirm(true)}>
            <span className="settings-row__icon"><Icon name="logout" size={20} /></span>
            <span className="settings-row__label">Выйти</span>
            <span className="settings-row__chevron"><Icon name="back" size={18} /></span>
          </button>
          {!pin && (
            <>
              <button type="button" className="settings__devices-link" onClick={openPassword}>Выйти на других устройствах</button>
              <p className="settings__device">Устройство: <code>{client.getDeviceId()}</code></p>
            </>
          )}
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
