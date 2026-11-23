import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { KnownMembership, type MatrixClient, type Room, type RoomMember } from 'matrix-js-sdk';
import { useClient } from '../state/MatrixContext';
import { navigate } from '../hooks/useHashRoute';
import { getConfig } from '../config';
import { squareAvatar } from '../lib/profile';
import { isRoomMuted, leaveRoom, pluralMembers, roomPower, setRoomMuted } from '../lib/rooms';
import { Avatar, Button, Card, Field, Icon, Modal, toast } from '../components/ui';
import { ExtraIcon } from '../components/extraIcons';
import { BigAvatar, ConfirmDialog, InfoFrame, memberName, useRoomRefresh } from './infoParts';

const NAME_MAX = 60;

function AddMembers({ client, room, open, onClose }: { client: MatrixClient; room: Room; open: boolean; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const candidates = useMemo(() => {
    if (!open) return [];
    const me = client.getUserId();
    const conduit = `@conduit:${getConfig().serverName}`;
    const here = new Set(
      [...room.getMembersWithMembership(KnownMembership.Join), ...room.getMembersWithMembership(KnownMembership.Invite)].map((m) => m.userId),
    );
    const seen = new Set<string>();
    const list: { id: string; name: string }[] = [];
    for (const r of client.getRooms()) {
      if (r.getMyMembership() !== KnownMembership.Join) continue;
      for (const m of r.getJoinedMembers()) {
        if (m.userId === me || m.userId === conduit || here.has(m.userId) || seen.has(m.userId)) continue;
        seen.add(m.userId);
        list.push({ id: m.userId, name: memberName(client, m) });
      }
    }
    return list;
  }, [open, client, room]);

  const close = () => {
    setPicked([]);
    setBusy(false);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!picked.length) return;
    setBusy(true);
    let failed = 0;
    for (const id of picked) {
      try {
        await client.invite(room.roomId, id);
      } catch (err) {
        failed++;
        console.error(err);
      }
    }
    if (failed) toast(failed === picked.length ? 'Не удалось пригласить' : 'Не всех удалось пригласить', { variant: 'error' });
    close();
  };

  return (
    <Modal open={open} onClose={close} title="Добавить участника">
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <div className="person-picker" role="group" aria-label="Люди">
          {candidates.length ? (
            candidates.map((p) => (
              <button
                key={p.id}
                type="button"
                className="person-pick"
                aria-pressed={picked.includes(p.id)}
                onClick={() => setPicked((cur) => (cur.includes(p.id) ? cur.filter((v) => v !== p.id) : [...cur, p.id]))}
              >
                <Avatar name={p.name} seed={p.id} size="sm" />
                <span>{p.name}</span>
              </button>
            ))
          ) : (
            <p className="settings-card__text">Некого добавить</p>
          )}
        </div>
        <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={busy || !picked.length}>Пригласить</Button>
      </form>
    </Modal>
  );
}

function MemberRow({
  client,
  member,
  invited,
  canKick,
  onKick,
}: {
  client: MatrixClient;
  member: RoomMember;
  invited: boolean;
  canKick: boolean;
  onKick: () => void;
}) {
  const name = memberName(client, member);
  const isMe = member.userId === client.getUserId();
  return (
    <li className="member-row">
      <button type="button" className="member-row__open" aria-label={`Профиль: ${name}`} onClick={() => navigate.user(member.userId)}>
        <Avatar client={client} name={name} seed={member.userId} mxc={member.getMxcAvatarUrl()} size="md" />
        <span className="member-row__name">
          <span>{name}{isMe ? ' (вы)' : ''}</span>
          {invited && <span className="member-row__sub">приглашён</span>}
        </span>
      </button>
      {canKick && (
        <Button variant="ghost" icon aria-label={`Исключить ${name}`} onClick={onKick}>
          <Icon name="trash" />
        </Button>
      )}
    </li>
  );
}

export function RoomInfo({ roomId }: { roomId: string }) {
  const client = useClient();
  useRoomRefresh(client);
  const room = client.getRoom(roomId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [kickTarget, setKickTarget] = useState<{ id: string; name: string } | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const back = () => navigate.back(`#/room/${encodeURIComponent(roomId)}`);

  useEffect(() => {
    if (pendingName && client.getRoom(roomId)?.name === pendingName) setPendingName(null);
  });

  if (!room || room.getMyMembership() !== KnownMembership.Join) {
    return (
      <InfoFrame title="О группе" onBack={() => navigate.back('#/')}>
        <p className="info__muted">Чат не найден или вы в нём не состоите</p>
      </InfoFrame>
    );
  }

  const power = roomPower(client, room);
  const joined = room.getMembersWithMembership(KnownMembership.Join);
  const invited = room.getMembersWithMembership(KnownMembership.Invite);
  const muted = isRoomMuted(client, roomId);
  const shownName = pendingName ?? room.name;
  const mxc = room.getMxcAvatarUrl();
  const meId = client.getUserId();

  const run = async (key: string, fn: () => Promise<void>, errText: string) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      console.error(e);
      toast(errText, { variant: 'error' });
    }
    setBusy(null);
  };

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    const n = draft.trim();
    if (n.length < 1 || n.length > NAME_MAX) return setNameError(`От 1 до ${NAME_MAX} символов`);
    if (n === room.name) return setEditing(false);
    // новое имя видно сразу; запрос идёт в фоне, при ошибке возвращаем старое
    setPendingName(n);
    setEditing(false);
    client.setRoomName(roomId, n).catch((err) => {
      console.error(err);
      setPendingName(null);
      toast('Не удалось переименовать', { variant: 'error' });
    });
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    void run('photo', async () => {
      const blob = await squareAvatar(file);
      const { content_uri: url } = await client.uploadContent(blob, { name: 'avatar.jpg', type: 'image/jpeg' });
      await client.sendStateEvent(roomId, 'm.room.avatar' as never, { url } as never, '');
    }, 'Не удалось сменить фото');
  };

  const removePhoto = () =>
    run('photo', async () => {
      await client.sendStateEvent(roomId, 'm.room.avatar' as never, {} as never, '');
    }, 'Не удалось убрать фото');

  const kick = () => {
    if (!kickTarget) return;
    const target = kickTarget;
    void run('kick', async () => {
      await client.kick(roomId, target.id);
      setKickTarget(null);
    }, 'Не удалось исключить');
  };

  const leave = () => {
    setLeaveOpen(false);
    location.hash = '#/';
    leaveRoom(client, roomId).catch((e) => {
      console.error(e);
      toast('Не удалось выйти из группы', { variant: 'error' });
    });
  };

  return (
    <InfoFrame title="О группе" onBack={back}>
      <Card solid className="settings-card">
        <div className="info__head" style={{ width: '100%' }}>
          <BigAvatar client={client} name={room.name} seed={roomId} mxc={mxc} label={`Фото группы ${shownName}`} />
          {editing ? (
            <form className="info__row" onSubmit={saveName}>
              <Field
                label="Название"
                value={draft}
                maxLength={NAME_MAX}
                error={nameError}
                autoFocus
                onChange={(e) => {
                  setDraft(e.target.value);
                  setNameError(null);
                }}
              />
              <Button type="submit" variant="primary" busy={busy === 'name'} disabled={!!busy}>Сохранить</Button>
              <Button variant="ghost" aria-label="Отмена" onClick={() => setEditing(false)}><Icon name="close" /></Button>
            </form>
          ) : (
            <h1 className="info__name">{shownName}</h1>
          )}
          <p className="info__muted">{pluralMembers(joined.length)}</p>
        </div>
        {(power.canRename || power.canAvatar) && (
          <div className="info__actions">
            {power.canRename && !editing && (
              <Button variant="outline" onClick={() => { setDraft(room.name); setNameError(null); setEditing(true); }}>
                <ExtraIcon name="edit" /> Переименовать
              </Button>
            )}
            {power.canAvatar && (
              <>
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
                <Button variant="outline" busy={busy === 'photo'} disabled={!!busy} onClick={() => fileRef.current?.click()}>
                  <Icon name="image" /> {mxc ? 'Сменить фото' : 'Добавить фото'}
                </Button>
                {mxc && <Button variant="ghost" disabled={!!busy} onClick={() => void removePhoto()}>Убрать фото</Button>}
              </>
            )}
          </div>
        )}
      </Card>

      <Card solid className="settings-card">
        <div className="info__actions">
          <Button
            variant="outline"
            onClick={() => {
              setRoomMuted(client, roomId, !muted).catch((e) => {
                console.error(e);
                toast('Не получилось изменить уведомления', { variant: 'error' });
              });
            }}
          >
            <ExtraIcon name="bellOff" /> {muted ? 'Включить звук' : 'Без звука'}
          </Button>
        </div>
      </Card>

      <Card solid className="settings-card">
        <h2 className="settings-card__title">{pluralMembers(joined.length)}</h2>
        {power.canInvite && (
          <div className="info__actions">
            <Button variant="outline" onClick={() => setAddOpen(true)}><Icon name="plus" /> Добавить участника</Button>
          </div>
        )}
        <ul className="info__members">
          {[...joined.map((m) => [m, false] as const), ...invited.map((m) => [m, true] as const)].map(([m, inv]) => (
            <MemberRow
              key={m.userId}
              client={client}
              member={m}
              invited={inv}
              canKick={m.userId !== meId && power.canKickLevel(m.powerLevel)}
              onKick={() => setKickTarget({ id: m.userId, name: memberName(client, m) })}
            />
          ))}
        </ul>
      </Card>

      <Card solid className="settings-card">
        <div className="info__actions">
          <Button variant="outline" className="info__danger" onClick={() => setLeaveOpen(true)}>
            <Icon name="logout" /> Покинуть группу
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={!!kickTarget}
        title="Исключить участника"
        text={`Исключить ${kickTarget?.name ?? ''} из группы?`}
        confirmLabel="Исключить"
        busy={busy === 'kick'}
        onConfirm={kick}
        onClose={() => setKickTarget(null)}
      />
      <ConfirmDialog
        open={leaveOpen}
        title="Покинуть группу"
        text={`Покинуть группу «${room.name}»? История для вас пропадёт.`}
        confirmLabel="Покинуть"
        onConfirm={leave}
        onClose={() => setLeaveOpen(false)}
      />
      <AddMembers client={client} room={room} open={addOpen} onClose={() => setAddOpen(false)} />
    </InfoFrame>
  );
}
