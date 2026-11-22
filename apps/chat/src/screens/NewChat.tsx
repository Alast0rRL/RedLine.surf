import { useState, type FormEvent } from 'react';
import { EventType, Preset, Visibility, type MatrixClient } from 'matrix-js-sdk';
import { getConfig } from '../config';
import { useClient } from '../state/MatrixContext';
import { navigate } from '../hooks/useHashRoute';
import { Button, Field, Modal } from '../components/ui';

/** «мари», «@mari», «@mari:server» → полный Matrix ID на нашем сервере. */
export function toUserId(input: string): string {
  const v = input.trim().replace(/^@/, '');
  return v.includes(':') ? `@${v}` : `@${v}:${getConfig().serverName}`;
}

async function addDirect(client: MatrixClient, userId: string, roomId: string) {
  const direct = client.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>() ?? {};
  const list = direct[userId] ?? [];
  if (!list.includes(roomId)) {
    await client.setAccountData(EventType.Direct, { ...direct, [userId]: [...list, roomId] } as never);
  }
}

function findExistingDm(client: MatrixClient, userId: string): string | null {
  const direct = client.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>() ?? {};
  for (const roomId of direct[userId] ?? []) {
    const room = client.getRoom(roomId);
    if (room?.getMyMembership() === 'join' && room.getMember(userId)?.membership !== 'leave') return roomId;
  }
  return null;
}

/** E2E включено всегда: и в личных, и в групповых чатах. */
const encryption = [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }];

export function NewChatModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useClient();
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
    const users = who.split(/[\s,]+/).filter(Boolean).map(toUserId);
    if (users.length === 0) return setError('Укажите, кого пригласить');
    if (users.includes(client.getUserId()!)) return setError('Себя приглашать не нужно');
    setBusy(true);
    try {
      // проверяем, что пользователи существуют — иначе понятная ошибка вместо пустой комнаты
      for (const u of users) {
        await client.getProfileInfo(u).catch(() => {
          throw new Error(`Пользователь ${u} не найден`);
        });
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
      setError((err as Error).message || 'Не удалось создать чат');
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
      <form className="stack" onSubmit={submit}>
        <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'dm'} onClick={() => setMode('dm')}>Личный</button>
          <button type="button" role="tab" aria-selected={mode === 'group'} onClick={() => setMode('group')}>Группа</button>
        </div>
        {mode === 'group' && (
          <Field label="Название" value={name} onChange={(e) => setName(e.target.value)} placeholder="Семья" maxLength={80} />
        )}
        <Field
          label={mode === 'dm' ? 'Кому' : 'Участники'}
          value={who}
          onChange={(e) => setWho(e.target.value)}
          placeholder={mode === 'dm' ? 'имя' : 'мама, папа'}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          hint={mode === 'dm' ? 'Логин собеседника' : 'Логины через запятую'}
          error={error}
        />
        <Button type="submit" variant="primary" size="lg" block busy={busy}>
          Создать
        </Button>
      </form>
    </Modal>
  );
}
