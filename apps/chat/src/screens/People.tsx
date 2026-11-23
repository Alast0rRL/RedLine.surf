import { RoomStateEvent } from 'matrix-js-sdk';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { friendlyError } from '../lib/account';
import { deleteUser, findAdminRoom, listUsers, resetPassword, resetPin } from '../lib/admin';
import { createInvite, loadInvites, loadLinks, removeLink, revokeInvite, type Invite } from '../lib/invites';
import { formatLink, isPinUser, type PersonalLink } from '../lib/pin';
import { isBotUser } from '../bots/registry';
import { navigate } from '../hooks/useHashRoute';
import { useClient } from '../state/MatrixContext';
import { Avatar, Button, Card, Field, Icon, Modal, toast } from '../components/ui';
import { QrCode } from '../components/QrCode';
import { adminUnbindPhone } from '../lib/phone';
import { getFamilyRoomId, isInFamily, setInFamily } from '../lib/family';
import '../styles/people.css';

const LOAD_TIMEOUT_MS = 15_000;

interface Person {
  id: string;
  name: string;
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <section className="pane pane--room" aria-label="Люди">
      <header className="topbar topbar--room">
        <Button variant="ghost" icon aria-label="Назад" onClick={() => navigate.backToSettings()}>
          <Icon name="back" />
        </Button>
        <span className="topbar__title"><span className="topbar__name">Люди</span></span>
      </header>
      <div className="settings">{children}</div>
    </section>
  );
}

export function People() {
  const client = useClient();
  const [adminRoom, setAdminRoom] = useState<string | null | undefined>(undefined);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [links, setLinks] = useState<PersonalLink[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [label, setLabel] = useState('');
  const [action, setAction] = useState<string | null>(null);
  const [shownLink, setShownLink] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Invite | null>(null);
  const [resetTarget, setResetTarget] = useState<Person | null>(null);
  const [pinResetTarget, setPinResetTarget] = useState<{ person: Person; link: PersonalLink } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Person | null>(null);
  const [logoutDevices, setLogoutDevices] = useState(false);
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [familyTick, setFamilyTick] = useState(0);
  const [familyBusy, setFamilyBusy] = useState<Record<string, boolean>>({});
  const [familyOpt, setFamilyOpt] = useState<Record<string, boolean>>({});
  const inflight = useRef<Promise<void> | null>(null);
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    setBusy(true);
    setError(null);
    // долгая загрузка — не вечный экран: через 15 секунд предлагаем повторить
    const slowTimer = window.setTimeout(() => {
      if (alive.current) setError('Загрузка идёт слишком долго. Проверьте интернет и попробуйте ещё раз');
    }, LOAD_TIMEOUT_MS);
    if (!inflight.current) {
      const task = (async () => {
        try {
          const room = await findAdminRoom(client);
          if (!alive.current) return;
          if (!room) {
            setAdminRoom(null);
            return;
          }
          const [liveInvites, ids, storedLinks] = await Promise.all([
            loadInvites(client, room),
            listUsers(client, room),
            loadLinks(client),
          ]);
          const users = await Promise.all(
            ids.map(async (id) => {
              const name = await client.getProfileInfo(id)
                .then((info) => info.displayname || (isPinUser(id) ? 'Участник' : id))
                .catch(() => (isPinUser(id) ? 'Участник' : id));
              return { id, name };
            }),
          );
          if (!alive.current) return;
          setAdminRoom(room);
          setInvites(liveInvites);
          setLinks(storedLinks);
          setPeople(users);
          setError(null);
        } catch (e) {
          console.warn('Не удалось загрузить раздел «Люди»', e);
          if (alive.current) setError('Не удалось загрузить список. Проверьте интернет и попробуйте ещё раз');
        } finally {
          window.clearTimeout(slowTimer);
          if (alive.current) setBusy(false);
        }
      })();
      inflight.current = task;
      void task.finally(() => {
        inflight.current = null;
      });
    }
    return () => {
      window.clearTimeout(slowTimer);
      alive.current = false;
    };
  }, [client, retry]);

  useEffect(() => {
    let cancelled = false;
    void getFamilyRoomId(client).then((id) => {
      if (!cancelled) setFamilyId(id);
    }).catch(() => undefined);
    const onMembers = () => setFamilyTick((n) => n + 1);
    client.on(RoomStateEvent.Members, onMembers);
    return () => {
      cancelled = true;
      client.off(RoomStateEvent.Members, onMembers);
    };
  }, [client, retry]);

  const familyChecked = (id: string): boolean => {
    void familyTick;
    return id in familyOpt ? familyOpt[id] : isInFamily(client, familyId, id);
  };

  const familyCount = (() => {
    void familyTick;
    if (!familyId) return 0;
    const members = client.getRoom(familyId)?.getJoinedMembers() ?? [];
    return members.filter((m) => !isBotUser(m.userId)).length;
  })();

  const toggleFamily = async (person: Person, value: boolean) => {
    if (!adminRoom || familyBusy[person.id]) return;
    setFamilyBusy((b) => ({ ...b, [person.id]: true }));
    setFamilyOpt((o) => ({ ...o, [person.id]: value }));
    try {
      await setInFamily(client, adminRoom, person.id, value);
      if (!familyId) setFamilyId(await getFamilyRoomId(client));
    } catch (e) {
      toast(friendlyError(e, value ? 'Не удалось добавить в семью' : 'Не удалось убрать из семьи'), { variant: 'error' });
    } finally {
      setFamilyOpt((o) => {
        const { [person.id]: _drop, ...rest } = o;
        return rest;
      });
      setFamilyBusy((b) => {
        const { [person.id]: _drop, ...rest } = b;
        return rest;
      });
      setFamilyTick((n) => n + 1);
    }
  };

  const reload = () => setRetry((n) => n + 1);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!adminRoom || !label.trim()) return;
    setAction('create');
    try {
      const { link } = await createInvite(client, adminRoom, label.trim());
      setShownLink(formatLink(link));
      setLabel('');
      reload();
    } catch {
      toast('Не удалось создать ссылку. Проверьте интернет и попробуйте ещё раз', { variant: 'error' });
    } finally {
      setAction(null);
    }
  };

  const showLink = (link: PersonalLink) => setShownLink(formatLink(link));

  const copyLink = async () => {
    if (!shownLink) return;
    try {
      await navigator.clipboard.writeText(shownLink);
      toast('Ссылка скопирована', { variant: 'success' });
    } catch {
      toast('Не получилось скопировать. Выделите текст и скопируйте вручную', { variant: 'error' });
    }
  };

  const share = async () => {
    if (!shownLink || !navigator.share) return;
    try {
      await navigator.share({ title: 'Личная ссылка', text: 'Личная ссылка для входа в Redline Chat', url: shownLink });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.warn('Не удалось отправить ссылку');
    }
  };

  const confirmRevoke = async () => {
    if (!adminRoom || !revokeTarget) return;
    setAction(`revoke:${revokeTarget.token}`);
    try {
      await revokeInvite(client, adminRoom, revokeTarget.token);
      setRevokeTarget(null);
      toast('Ссылка отозвана', { variant: 'success' });
      reload();
    } catch {
      toast('Не удалось отозвать ссылку. Проверьте интернет и попробуйте ещё раз', { variant: 'error' });
    } finally {
      setAction(null);
    }
  };

  const openReset = (person: Person) => {
    setResetTarget(person);
    setLogoutDevices(false);
    setNewPassword(null);
  };

  const closeReset = () => {
    setResetTarget(null);
    setNewPassword(null);
    setLogoutDevices(false);
  };

  const confirmReset = async () => {
    if (!adminRoom || !resetTarget) return;
    setAction(`reset:${resetTarget.id}`);
    try {
      setNewPassword(await resetPassword(client, adminRoom, resetTarget.id, logoutDevices));
    } catch {
      toast('Не удалось сбросить пароль. Проверьте интернет и попробуйте ещё раз', { variant: 'error' });
    } finally {
      setAction(null);
    }
  };

  const confirmPinReset = async () => {
    if (!adminRoom || !pinResetTarget) return;
    setAction(`pin-reset:${pinResetTarget.link.user}`);
    try {
      await resetPin(client, adminRoom, pinResetTarget.link);
      toast('PIN сброшен', { variant: 'success' });
      setPinResetTarget(null);
      setShownLink(formatLink(pinResetTarget.link));
    } catch {
      toast('Не удалось сбросить PIN. Проверьте интернет и попробуйте ещё раз', { variant: 'error' });
    } finally {
      setAction(null);
    }
  };

  const confirmDelete = async () => {
    if (!adminRoom || !deleteTarget) return;
    const person = deleteTarget;
    setAction(`delete:${person.id}`);
    try {
      await deleteUser(client, adminRoom, person.id);
    } catch (e) {
      toast(friendlyError(e, 'Не удалось удалить'), { variant: 'error' });
      setAction(null);
      return;
    }
    setPeople((list) => list.filter((p) => p.id !== person.id));
    setDeleteTarget(null);
    const local = person.id.replace(/^@/, '').split(':')[0];
    const warnings: string[] = [];
    try {
      await removeLink(client, adminRoom, local);
      setLinks((list) => list.filter((l) => l.user !== local));
    } catch {
      warnings.push('личную ссылку');
    }
    try {
      const token = client.getAccessToken();
      if (!token) throw new Error('no token');
      await adminUnbindPhone(token, person.id);
    } catch {
      warnings.push('привязку номера');
    }
    toast(`${person.name} удалён(а) из Redline`, { variant: 'success' });
    if (warnings.length) toast(`Не удалось убрать ${warnings.join(' и ')}`, { variant: 'default' });
    setAction(null);
    reload();
  };

  const copyPassword = async () => {
    if (!newPassword) return;
    try {
      await navigator.clipboard.writeText(newPassword);
      toast('Пароль скопирован', { variant: 'success' });
    } catch {
      toast('Не получилось скопировать. Выделите текст и скопируйте вручную', { variant: 'error' });
    }
  };

  const canShare = typeof navigator.share === 'function';

  return (
    <Frame>
      {busy && adminRoom === undefined && !error && (
        <div className="people-skeleton" aria-busy="true" aria-label="Загружаем список">
          {[0, 1, 2].map((i) => (
            <Card solid className="settings-card" key={i}>
              <span className="skeleton-line skeleton-line--title" />
              <span className="skeleton-line" />
              <span className="skeleton-line skeleton-line--short" />
            </Card>
          ))}
        </div>
      )}

      {error && (
        <Card solid className="settings-card">
          <p className="settings-card__text">{error}</p>
          <Button variant="primary" onClick={reload}>Повторить</Button>
        </Card>
      )}

      {!busy && adminRoom === null && !error && (
        <Card solid className="settings-card">
          <p className="settings-card__text">Раздел только для администратора</p>
        </Card>
      )}

      {adminRoom && !error && (
        <>
          <Card solid className="settings-card">
            <h2 className="settings-card__title"><Icon name="plus" size={18} /> Добавить человека</h2>
            <p className="settings-card__text">Отправьте ссылку тому, кого хотите добавить в Redline Chat.</p>
            <form className="stack" onSubmit={(e) => void create(e)}>
              <Field
                label="Как зовут"
                name="label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Мама"
                maxLength={40}
                disabled={!!action}
                required
              />
              <Button type="submit" variant="primary" busy={action === 'create'} disabled={!label.trim() || !!action}>
                Создать ссылку
              </Button>
            </form>
          </Card>

          <Card solid className="settings-card">
            <h2 className="settings-card__title"><Icon name="key" size={18} /> Ждут входа</h2>
            <p className="settings-card__text">Ссылки старше 7 дней отзываются, когда вы открываете приложение</p>
            {invites.length ? (
              <ul className="people-list">
                {invites.map((invite) => {
                  const stored = links.find((l) => l.token === invite.token);
                  return (
                    <li className="people-row" key={invite.token}>
                      <span className="people-row__main">
                        <span className="people-row__name">{invite.label || 'Без подписи'}</span>
                        <span className="people-row__meta">
                          {invite.createdAt
                            ? new Date(invite.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
                            : 'Дата неизвестна'}
                        </span>
                      </span>
                      <span className="people-row__actions">
                        {stored && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!!action}
                            onClick={() => showLink(stored)}
                          >
                            Показать
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" disabled={!!action} onClick={() => setRevokeTarget(invite)}>
                          Отозвать
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="settings-card__text">Активных ссылок нет</p>
            )}
          </Card>

          <Card solid className="settings-card">
            <h2 className="settings-card__title"><Icon name="check" size={18} /> Люди</h2>
            <p className="settings-card__text">Семья: {familyCount} человек</p>
            <ul className="people-list">
              {people.map((person) => {
                const self = person.id === client.getUserId();
                const bot = isBotUser(person.id);
                const pinUser = isPinUser(person.id);
                const admin = /^@(admin|conduit):/.test(person.id);
                const pinLink = pinUser
                  ? links.find((l) => l.user === person.id.replace(/^@/, '').split(':')[0])
                  : undefined;
                return (
                  <li className="people-row" key={person.id}>
                    <Avatar name={person.name} seed={person.id} size="sm" />
                    <span className="people-row__main">
                      <span className="people-row__name">
                        {person.name}
                        {self && <span className="person-tag">вы</span>}
                        {bot && <span className="bot-tag">бот</span>}
                      </span>
                      {!pinUser && <span className="people-row__meta">{person.id}</span>}
                    </span>
                    {!bot && (
                      self ? (
                        <span className="people-row__meta">Вы в семье</span>
                      ) : (
                        <label className="family-toggle">
                          {familyBusy[person.id] && <span className="rl-spinner family-toggle__spin" aria-hidden="true" />}
                          <input
                            type="checkbox"
                            role="switch"
                            aria-checked={familyChecked(person.id)}
                            checked={familyChecked(person.id)}
                            disabled={!!familyBusy[person.id]}
                            onChange={(e) => void toggleFamily(person, e.target.checked)}
                          />
                          <span>Семья</span>
                        </label>
                      )
                    )}
                    {!self && !bot && (
                      <span className="people-row__actions">
                        {pinUser ? (
                          pinLink && (
                            <>
                              <Button size="sm" variant="secondary" onClick={() => showLink(pinLink)}>Ссылка</Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                busy={action === `pin-reset:${pinLink.user}`}
                                disabled={!!action}
                                onClick={() => setPinResetTarget({ person, link: pinLink })}
                              >
                                Сбросить PIN
                              </Button>
                            </>
                          )
                        ) : (
                          <Button size="sm" variant="secondary" onClick={() => openReset(person)}>
                            Сбросить пароль
                          </Button>
                        )}
                        {!admin && (
                          <Button
                            size="sm"
                            variant="danger"
                            busy={action === `delete:${person.id}`}
                            disabled={!!action}
                            onClick={() => setDeleteTarget(person)}
                          >
                            Удалить из Redline
                          </Button>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}

      <Modal open={!!shownLink} onClose={() => setShownLink(null)} title="Ссылка для входа">
        <div className="stack">
          {shownLink && <QrCode value={shownLink} />}
          <code className="invite-link">{shownLink}</code>
          <p>Это личная ссылка: она нужна и для нового телефона. Не пересылай её другим.</p>
          <Button variant="secondary" onClick={() => void copyLink()}>Скопировать</Button>
          {canShare && <Button variant="primary" onClick={() => void share()}>Отправить</Button>}
        </div>
      </Modal>

      <Modal
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        title="Отозвать ссылку?"
        actions={
          <>
            <Button
              variant="primary"
              busy={action === `revoke:${revokeTarget?.token ?? ''}`}
              onClick={() => void confirmRevoke()}
            >
              Отозвать
            </Button>
            <Button variant="ghost" onClick={() => setRevokeTarget(null)}>Отмена</Button>
          </>
        }
      >
        <p>Ссылку «{revokeTarget?.label || 'Без подписи'}» больше нельзя будет использовать.</p>
      </Modal>

      <Modal
        open={!!pinResetTarget}
        onClose={() => setPinResetTarget(null)}
        title="Сбросить PIN?"
        actions={
          <>
            <Button
              variant="primary"
              busy={action === `pin-reset:${pinResetTarget?.link.user ?? ''}`}
              onClick={() => void confirmPinReset()}
            >
              Сбросить
            </Button>
            <Button variant="ghost" onClick={() => setPinResetTarget(null)}>Отмена</Button>
          </>
        }
      >
        {pinResetTarget && (
          <p>{pinResetTarget.person.name} выйдет на всех устройствах и задаст новый PIN по той же ссылке. Переписка сохранится.</p>
        )}
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={() => !action && setDeleteTarget(null)}
        title={`Удалить ${deleteTarget?.name ?? ''}?`}
        actions={
          <>
            <Button
              variant="danger"
              busy={action === `delete:${deleteTarget?.id ?? ''}`}
              onClick={() => void confirmDelete()}
            >
              Удалить
            </Button>
            <Button variant="ghost" disabled={!!action} onClick={() => setDeleteTarget(null)}>Отмена</Button>
          </>
        }
      >
        <p>Аккаунт отключится навсегда: человек выйдет из всех чатов и больше не сможет войти, ни по ссылке, ни по номеру. Его сообщения у других останутся. Отменить нельзя.</p>
      </Modal>

      <Modal
        open={!!resetTarget}
        onClose={closeReset}
        title={newPassword ? 'Новый пароль' : 'Сбросить пароль?'}
        actions={
          newPassword ? undefined : (
            <>
              <Button
                variant="primary"
                busy={action === `reset:${resetTarget?.id ?? ''}`}
                onClick={() => void confirmReset()}
              >
                Сбросить
              </Button>
              <Button variant="ghost" onClick={closeReset}>Отмена</Button>
            </>
          )
        }
      >
        {resetTarget && !newPassword && (
          <div className="stack">
            <p>Новый пароль для {resetTarget.name} будет показан один раз.</p>
            <label className="check-row">
              <input type="checkbox" checked={logoutDevices} onChange={(e) => setLogoutDevices(e.target.checked)} />
              <span>Выйти на всех его устройствах</span>
            </label>
            <p>После выхода старые сообщения откроются только по секретной фразе.</p>
          </div>
        )}
        {newPassword && (
          <div className="stack">
            <p>Сообщите пароль лично. Сохранить его заново нельзя.</p>
            <code className="secret-value">{newPassword}</code>
            <Button variant="secondary" onClick={() => void copyPassword()}>Скопировать</Button>
            <p>Попросите сменить его в настройках.</p>
          </div>
        )}
      </Modal>
    </Frame>
  );
}
