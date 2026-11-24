import { useEffect, useState } from 'react';
import { isBotUser } from '../bots/registry';
import { Avatar, Button, Card, Icon, Modal, toast } from '../components/ui';
import { QrCode } from '../components/QrCode';
import { navigate } from '../hooks/useHashRoute';
import { friendlyError } from '../lib/account';
import { deleteUser, findAdminRoom, listUsers, resetPin } from '../lib/admin';
import { loadLinks, removeLink } from '../lib/invites';
import { adminUnbindPhone } from '../lib/phone';
import { formatLink, type PersonalLink } from '../lib/pin';
import { useClient } from '../state/MatrixContext';

const NO_PIN_DATA = 'Нет данных игрока для сброса PIN';
const SYSTEM_LOCALPARTS = new Set(['admin', 'conduit']);
const SYSTEM_NAME = /^(server|bot|redline)(?:[._-]|$)/i;

const localpart = (id: string) => id.replace(/^@/, '').split(':')[0];

interface Player {
  id: string;
  nick: string;
  display: string;
  mxc: string | null | undefined;
}

export function McPlayers() {
  const client = useClient();
  const [adminRoom, setAdminRoom] = useState<string | null | undefined>(undefined);
  const [players, setPlayers] = useState<Player[]>([]);
  const [links, setLinks] = useState<PersonalLink[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [shownLink, setShownLink] = useState<string | null>(null);
  const [pinTarget, setPinTarget] = useState<{ player: Player; link: PersonalLink } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Player | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    setAdminRoom(undefined);
    void (async () => {
      try {
        const room = await findAdminRoom(client);
        if (cancelled) return;
        if (!room) {
          setAdminRoom(null);
          return;
        }
        const [ids, storedLinks] = await Promise.all([listUsers(client, room), loadLinks(client)]);
        const me = client.getUserId();
        const found = await Promise.all(
          ids.map(async (id): Promise<Player | null> => {
            const nick = localpart(id);
            if (isBotUser(id) || SYSTEM_LOCALPARTS.has(nick) || SYSTEM_NAME.test(nick)) return null;
            const info = await client.getProfileInfo(id).catch(() => null);
            if (info && !info.displayname && !info.avatar_url && id !== me) return null;
            const display = info?.displayname || '';
            if (SYSTEM_NAME.test(display)) return null;
            return { id, nick, display, mxc: info?.avatar_url ?? null };
          }),
        );
        if (cancelled) return;
        setAdminRoom(room);
        setLinks(storedLinks);
        setPlayers(found.filter((p): p is Player => p !== null));
      } catch (e) {
        console.warn('Не удалось загрузить список игроков', e);
        if (!cancelled) setError(friendlyError(e, 'Не удалось загрузить список. Проверьте интернет и попробуйте ещё раз'));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, retry]);

  const reload = () => setRetry((n) => n + 1);

  const copyLink = async () => {
    if (!shownLink) return;
    try {
      await navigator.clipboard.writeText(shownLink);
      toast('Ссылка скопирована', { variant: 'success' });
    } catch {
      toast('Не получилось скопировать. Выделите текст и скопируйте вручную', { variant: 'error' });
    }
  };

  const confirmPinReset = async () => {
    if (!adminRoom || !pinTarget) return;
    setAction(`pin-reset:${pinTarget.link.user}`);
    try {
      await resetPin(client, adminRoom, pinTarget.link);
      toast('PIN сброшен', { variant: 'success' });
      setPinTarget(null);
      setMenu(null);
      setShownLink(formatLink(pinTarget.link));
    } catch (e) {
      toast(friendlyError(e, 'Не удалось сбросить PIN. Проверьте интернет и попробуйте ещё раз'), { variant: 'error' });
    } finally {
      setAction(null);
    }
  };

  const confirmDelete = async () => {
    if (!adminRoom || !deleteTarget) return;
    const player = deleteTarget;
    setAction(`delete:${player.id}`);
    try {
      await deleteUser(client, adminRoom, player.id);
    } catch (e) {
      toast(friendlyError(e, 'Не удалось исключить игрока'), { variant: 'error' });
      setAction(null);
      return;
    }
    setPlayers((list) => list.filter((p) => p.id !== player.id));
    setDeleteTarget(null);
    setMenu(null);
    const warnings: string[] = [];
    try {
      await removeLink(client, adminRoom, player.nick);
      setLinks((list) => list.filter((l) => l.user !== player.nick));
    } catch {
      warnings.push('личную ссылку');
    }
    try {
      const token = client.getAccessToken();
      if (!token) throw new Error('no token');
      await adminUnbindPhone(token, player.id);
    } catch {
      warnings.push('привязку ника');
    }
    toast(`${player.nick} исключён(а) с сервера`, { variant: 'success' });
    if (warnings.length) toast(`Не удалось убрать ${warnings.join(' и ')}`, { variant: 'default' });
    setAction(null);
  };

  const term = query.trim().toLowerCase();
  const shown = term ? players.filter((p) => p.nick.toLowerCase().includes(term)) : players;

  return (
    <section className="pane pane--room" aria-label="Игроки">
      <header className="topbar topbar--room">
        <Button variant="ghost" icon aria-label="Назад" onClick={() => navigate.backToSettings()}>
          <Icon name="back" />
        </Button>
        <span className="topbar__title"><span className="topbar__name">Игроки</span></span>
      </header>
      <div className="settings">
        {busy && adminRoom === undefined && !error && (
          <div className="people-skeleton" aria-busy="true" aria-label="Загружаем список">
            {[0, 1, 2].map((i) => (
              <Card solid className="settings-card" key={i}>
                <span className="skeleton-line skeleton-line--title" />
                <span className="skeleton-line" />
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
              <h2 className="settings-card__title"><Icon name="shield" size={18} /> Игроки Minecraft</h2>
              <input
                className="rl-input"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск по нику"
                aria-label="Поиск по нику"
                autoComplete="off"
              />
            </Card>

            <Card solid className="settings-card">
              <ul className="people-list">
                {shown.map((player) => {
                  const self = player.id === client.getUserId();
                  const pinLink = links.find((l) => l.user === player.nick);
                  const opened = menu === player.id;
                  return (
                    <li className="people-row" key={player.id}>
                      <Avatar client={client} name={player.display || player.nick} seed={player.id} mxc={player.mxc} size="sm" />
                      <span className="people-row__main">
                        <span className="people-row__name">
                          {player.nick}
                          {self && <span className="person-tag">вы</span>}
                        </span>
                        <span className="people-row__meta">{player.display || player.nick}</span>
                      </span>
                      {!self && (
                        <span className="people-row__actions">
                          <Button
                            size="sm"
                            variant="ghost"
                            icon
                            aria-label={`Действия: ${player.nick}`}
                            aria-expanded={opened}
                            onClick={() => setMenu(opened ? null : player.id)}
                          >
                            <Icon name="settings" size={18} />
                          </Button>
                          {opened && (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={!pinLink || !!action}
                                title={!pinLink ? NO_PIN_DATA : undefined}
                                aria-label={!pinLink ? NO_PIN_DATA : undefined}
                                onClick={() => {
                                  if (!pinLink) return;
                                  setMenu(null);
                                  setPinTarget({ player, link: pinLink });
                                }}
                              >
                                Сбросить PIN
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                busy={action === `delete:${player.id}`}
                                disabled={!!action}
                                onClick={() => {
                                  setMenu(null);
                                  setDeleteTarget(player);
                                }}
                              >
                                Исключить
                              </Button>
                            </>
                          )}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {!shown.length && <p className="settings-card__text">Игроки не найдены</p>}
            </Card>
          </>
        )}

        <Modal open={!!shownLink} onClose={() => setShownLink(null)} title="Ссылка для входа">
          <div className="stack">
            {shownLink && <QrCode value={shownLink} />}
            <code className="invite-link">{shownLink}</code>
            <p>Это личная ссылка: она нужна и для нового телефона. Не пересылай её другим.</p>
            <Button variant="secondary" onClick={() => void copyLink()}>Скопировать</Button>
          </div>
        </Modal>

        <Modal
          open={!!pinTarget}
          onClose={() => !action && setPinTarget(null)}
          title="Сбросить PIN?"
          actions={
            <>
              <Button
                variant="primary"
                busy={action === `pin-reset:${pinTarget?.link.user ?? ''}`}
                onClick={() => void confirmPinReset()}
              >
                Сбросить
              </Button>
              <Button variant="ghost" disabled={!!action} onClick={() => setPinTarget(null)}>Отмена</Button>
            </>
          }
        >
          {pinTarget && (
            <p>{pinTarget.player.nick} выйдет на всех устройствах и задаст новый PIN по той же ссылке. Переписка сохранится.</p>
          )}
        </Modal>

        <Modal
          open={!!deleteTarget}
          onClose={() => !action && setDeleteTarget(null)}
          title={`Исключить ${deleteTarget?.nick ?? ''}?`}
          actions={
            <>
              <Button
                variant="danger"
                busy={action === `delete:${deleteTarget?.id ?? ''}`}
                onClick={() => void confirmDelete()}
              >
                Исключить
              </Button>
              <Button variant="ghost" disabled={!!action} onClick={() => setDeleteTarget(null)}>Отмена</Button>
            </>
          }
        >
          <p>Аккаунт отключится навсегда: игрок выйдет из всех чатов и больше не сможет войти, ни по ссылке, ни по нику. Его сообщения у других останутся. Отменить нельзя.</p>
        </Modal>
      </div>
    </section>
  );
}
