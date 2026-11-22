import { useEffect, useState, type FormEvent } from 'react';
import { EventType, Preset, Visibility, type MatrixClient } from 'matrix-js-sdk';
import { getConfig } from '../config';
import { isPinUser } from '../lib/pin';
import { useClient } from '../state/MatrixContext';
import { navigate } from '../hooks/useHashRoute';
import { Avatar, Button, Field, Modal } from '../components/ui';

/** «мари», «@mari», «@mari:server» → полный Matrix ID на нашем сервере. */
export function toUserId(input: string): string {
  const v = input.trim().replace(/^@/, '');
  return v.includes(':') ? `@${v}` : `@${v}:${getConfig().serverName}`;
}

export async function addDirect(client: MatrixClient, userId: string, roomId: string) {
  const direct = client.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>() ?? {};
  const list = direct[userId] ?? [];
  if (!list.includes(roomId)) {
    await client.setAccountData(EventType.Direct, { ...direct, [userId]: [...list, roomId] } as never);
  }
}

export function findExistingDm(client: MatrixClient, userId: string): string | null {
  const direct = client.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>() ?? {};
  for (const roomId of direct[userId] ?? []) {
    const room = client.getRoom(roomId);
    if (room?.getMyMembership() === 'join' && room.getMember(userId)?.membership !== 'leave') return roomId;
  }
  return null;
}

/** E2E включено всегда: и в личных, и в групповых чатах. */
export const encryption = [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }];

interface PersonPick {
  id: string;
  name: string;
}

export function NewChatModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useClient();
  const pin = isPinUser(client.getUserId());
  const [mode, setMode] = useState<'dm' | 'group'>('dm');
  const [who, setWho] = useState('');
  const [name, setName] = useState('');
  const [people, setPeople] = useState<PersonPick[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const me = client.getUserId();
    const conduit = `@conduit:${getConfig().serverName}`;
    const seen = new Set<string>();
    const list: PersonPick[] = [];
    for (const room of client.getRooms()) {
      if (room.getMyMembership() !== 'join') continue;
      for (const member of room.getJoinedMembers()) {
        const id = member.userId;
        if (id === me || id === conduit || seen.has(id)) continue;
        seen.add(id);
        const display = member.name && member.name !== id ? member.name : pin ? 'Участник' : id;
        list.push({ id, name: display });
      }
    }
    setPeople(list);
    setPicked([]);
    setError(null);
  }, [open, client, pin]);

  const reset = () => {
    setWho('');
    setName('');
    setPicked([]);
    setError(null);
    setBusy(false);
  };

  const toggle = (id: string) => {
    setError(null);
    setPicked((current) =>
      mode === 'dm' ? [id] : current.includes(id) ? current.filter((v) => v !== id) : [...current, id],
    );
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const manual = pin ? [] : who.split(/[\s,]+/).filter(Boolean).map(toUserId);
    const users = [...new Set([...picked, ...manual])];
    if (users.length === 0) return setError(pin ? 'Выбери, кого пригласить' : 'Укажите, кого пригласить');
    if (!pin && users.includes(client.getUserId()!)) return setError('Себя приглашать не нужно');
    if (mode === 'dm' && users.length !== 1) {
      return setError(pin ? 'Выбери одного человека' : 'Для личного чата нужен один человек');
    }
    setBusy(true);
    try {
      if (!pin) {
        // проверяем, что пользователи существуют — иначе понятная ошибка вместо пустой комнаты
        for (const u of users) {
          await client.getProfileInfo(u).catch(() => {
            throw new Error(`Пользователь ${u} не найден`);
          });
        }
      }
      let roomId: string;
      if (mode === 'dm') {
        const existing = findExistingDm(client, users[0]);
        if (existing) {
          onClose();
          reset();
          navigate.room(existing);
          return;
        }
        ({ room_id: roomId } = await client.createRoom({
          is_direct: true,
          invite: [users[0]],
          preset: Preset.TrustedPrivateChat,
          visibility: Visibility.Private,
          initial_state: encryption,
        }));
        await addDirect(client, users[0], roomId);
      } else {
        if (!name.trim()) {
          setBusy(false);
          return setError('Придумайте название');
        }
        ({ room_id: roomId } = await client.createRoom({
          name: name.trim(),
          invite: users,
          preset: Preset.PrivateChat,
          visibility: Visibility.Private,
          initial_state: encryption,
        }));
      }
      onClose();
      reset();
      navigate.room(roomId);
    } catch (err) {
      setError(pin ? 'Не удалось создать чат' : (err as Error).message || 'Не удалось создать чат');
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="Новый чат"
    >
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'dm'} onClick={() => { setMode('dm'); setPicked((p) => p.slice(0, 1)); setError(null); }}>Личный</button>
          <button type="button" role="tab" aria-selected={mode === 'group'} onClick={() => { setMode('group'); setError(null); }}>Группа</button>
        </div>
        {mode === 'group' && (
          <Field label="Название" value={name} onChange={(e) => setName(e.target.value)} placeholder="Семья" maxLength={80} />
        )}
        <div className="person-picker" role="group" aria-label="Люди">
          {people.length ? (
            people.map((person) => (
              <button
                key={person.id}
                type="button"
                className="person-pick"
                aria-pressed={picked.includes(person.id)}
                onClick={() => toggle(person.id)}
              >
                <Avatar name={person.name} seed={person.id} size="sm" />
                <span>{person.name}</span>
              </button>
            ))
          ) : (
            <p className="settings-card__text">Пока некого пригласить</p>
          )}
        </div>
        {!pin && (
          <Field
            label={mode === 'dm' ? 'Кому' : 'Участники'}
            value={who}
            onChange={(e) => setWho(e.target.value)}
            placeholder={mode === 'dm' ? 'mama' : 'mama, papa'}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            hint={mode === 'dm' ? 'Логин собеседника' : 'Логины через запятую'}
            error={error}
          />
        )}
        {pin && error && <p className="rl-hint rl-hint--error" role="alert">{error}</p>}
        <Button type="submit" variant="primary" size="lg" block busy={busy}>
          Создать
        </Button>
      </form>
    </Modal>
  );
}
