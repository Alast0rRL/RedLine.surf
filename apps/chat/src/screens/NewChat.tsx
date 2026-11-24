import { useState, type FormEvent } from 'react';
import { friendlyError } from '../lib/account';
import { EventType, Preset, Visibility, type MatrixClient } from 'matrix-js-sdk';
import { getConfig } from '../config';
import { formatLogin, parseLogins } from '../lib/login';
import { useClient } from '../state/MatrixContext';
import { navigate } from '../hooks/useHashRoute';
import { Button, Field, Modal } from '../components/ui';

/** «мари», «@mari», «@mari:server» → полный Matrix ID на нашем сервере. */
export function toUserId(input: string): string {
  const v = input.trim().replace(/^@/, '');
  return v.includes(':') ? `@${v}` : `@${v}:${getConfig().serverName}`;
}

export function localpart(input: string): string {
  return input.trim().replace(/^@+/, '').split(/[@:]/)[0];
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

/** Проверяет, что такие люди есть, — иначе понятная ошибка вместо пустой комнаты. */
export async function checkUsersExist(client: MatrixClient, users: string[]): Promise<void> {
  for (const u of users) {
    await client.getProfileInfo(u).catch(() => {
      throw new Error(`Не нашли ${formatLogin(u)}. Проверьте логин`);
    });
  }
}

export function NewChatModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useClient();
  const server = getConfig().serverName;
  const [mode, setMode] = useState<'dm' | 'group'>('dm');
  const [who, setWho] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setWho('');
    setName('');
    setError(null);
    setBusy(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = parseLogins(mode === 'dm' && who ? `${who}@${server}` : who);
    if ('error' in parsed) return setError(parsed.error);
    const users = parsed.userIds;
    if (users.includes(client.getUserId()!)) return setError('Себя приглашать не нужно');
    if (mode === 'dm' && users.length !== 1) return setError('Для личного чата нужен один логин');
    if (mode === 'group' && !name.trim()) return setError('Придумайте название');
    setBusy(true);
    try {
      await checkUsersExist(client, users);
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
      setError(friendlyError(err, 'Не удалось создать чат. Попробуйте ещё раз'));
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
          <button type="button" role="tab" aria-selected={mode === 'dm'} onClick={() => { setMode('dm'); setError(null); }}>Личный</button>
          <button type="button" role="tab" aria-selected={mode === 'group'} onClick={() => { setMode('group'); setError(null); }}>Группа</button>
        </div>
        {mode === 'group' && (
          <Field label="Название" value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, Друзья" maxLength={80} />
        )}
        <Field
          label={mode === 'dm' ? 'Кому' : 'Участники'}
          value={who}
          onChange={(e) => {
            setWho(mode === 'dm' ? localpart(e.target.value) : e.target.value);
            setError(null);
          }}
          placeholder={mode === 'dm' ? 'login' : `example@${server}, friend@${server}`}
          suffix={mode === 'dm' ? `@${server}` : undefined}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="email"
          hint={mode === 'group' ? 'Логины через запятую' : undefined}
          error={error}
        />
        <Button type="submit" variant="primary" size="lg" block busy={busy}>
          Создать
        </Button>
      </form>
    </Modal>
  );
}
