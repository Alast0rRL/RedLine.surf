import { useEffect, useState, type FormEvent } from 'react';
import { useClient, useMatrix } from '../state/MatrixContext';
import { friendlyError } from '../lib/account';
import { createMemberInvite, formatJoinLink, loadInviteOverview, revokeMemberInvite, type GuestInvite } from '../lib/guestInvites';
import { Button, Field, Modal, toast } from './ui';
import { QrCode } from './QrCode';

/** Может ли человек приглашать: только в семье и не гость. */
export function useCanInvite(): boolean {
  const client = useClient();
  const { realm } = useMatrix();
  const accessToken = client.getAccessToken();
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    if (realm !== 'family' || !accessToken) {
      setAllowed(false);
      return;
    }
    let alive = true;
    loadInviteOverview(accessToken)
      .then((r) => alive && setAllowed(!r.guest))
      .catch(() => alive && setAllowed(true));
    return () => {
      alive = false;
    };
  }, [realm, accessToken]);
  return allowed;
}

export function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useClient();
  const accessToken = client.getAccessToken();
  const [name, setName] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [invites, setInvites] = useState<GuestInvite[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!accessToken) return;
    const overview = await loadInviteOverview(accessToken);
    setInvites(overview.invites);
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    refresh().catch(() => toast('Не удалось загрузить приглашения. Попробуйте ещё раз', { variant: 'error' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => {
    if (busy) return;
    onClose();
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

  const canShare = typeof navigator.share === 'function';
  return (
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
  );
}
