import { useEffect, useState, type ReactNode } from 'react';
import { ClientEvent, RoomEvent, RoomStateEvent, type MatrixClient, type RoomMember } from 'matrix-js-sdk';
import { onOptimistic } from '../lib/optimistic';
import { isPinUser } from '../lib/pin';
import { useMediaUrl } from '../hooks/useMediaUrl';
import { Avatar, Button, Icon, Modal } from '../components/ui';
import '../styles/info.css';

/** Имя участника; для PIN-пользователей сырые id не показываем. */
export function memberName(client: MatrixClient, member: Pick<RoomMember, 'name' | 'userId'>): string {
  if (member.name && member.name !== member.userId) return member.name;
  return isPinUser(client.getUserId()) ? 'Участник' : member.userId;
}

/** Перерисовка при изменении участников, названия, аватара, тегов и push-правил. */
export function useRoomRefresh(client: MatrixClient): void {
  const [, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV((v) => v + 1);
    const events = [
      ClientEvent.AccountData,
      RoomStateEvent.Members,
      RoomStateEvent.Events,
      RoomEvent.Name,
      RoomEvent.Tags,
      RoomEvent.MyMembership,
    ] as const;
    for (const e of events) client.on(e as never, bump as never);
    const offOptimistic = onOptimistic(bump);
    return () => {
      offOptimistic();
      for (const e of events) client.off(e as never, bump as never);
    };
  }, [client]);
}

export function InfoFrame({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <section className="pane pane--room" aria-label={title}>
      <header className="topbar topbar--room">
        <Button variant="ghost" icon aria-label="Назад" onClick={onBack}>
          <Icon name="back" />
        </Button>
        <span className="topbar__title"><span className="topbar__name">{title}</span></span>
      </header>
      <div className="settings info">{children}</div>
    </section>
  );
}

/** Большая аватарка; по нажатию открывается на весь экран (если есть фото). */
export function BigAvatar({ client, name, seed, mxc, label }: { client: MatrixClient; name: string; seed: string; mxc?: string | null; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="info__avatar"
        aria-label={mxc ? `${label}: открыть фото` : label}
        disabled={!mxc}
        onClick={() => setOpen(true)}
      >
        <Avatar client={client} name={name} seed={seed} mxc={mxc} size="xl" />
      </button>
      {open && mxc && <FullPhoto mxc={mxc} alt={label} onClose={() => setOpen(false)} />}
    </>
  );
}

function FullPhoto({ mxc, alt, onClose }: { mxc: string; alt: string; onClose: () => void }) {
  const full = useMediaUrl({ url: mxc });
  return (
    <div
      className="lightbox"
      role="dialog"
      aria-label="Фото"
      tabIndex={-1}
      ref={(el) => el?.focus()}
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <button type="button" className="rl-btn rl-btn--icon rl-btn--ghost lightbox__close" aria-label="Закрыть" onClick={onClose}>
        <Icon name="close" />
      </button>
      {full && full !== 'error' ? <img src={full} alt={alt} onClick={(e) => e.stopPropagation()} /> : <span className="rl-spinner" />}
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  text,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  text: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" busy={busy} disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      <p className="settings-card__text">{text}</p>
    </Modal>
  );
}
