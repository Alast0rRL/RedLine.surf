import { useEffect, useState } from 'react';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { Button, Modal, toast } from '../components/ui';
import { canClearForAll, clearForAll, clearForMe } from '../lib/clear';

const CLEAR_HISTORY_EVENT = 'rl:open-clear-history';

export function askClearHistory(roomId: string): void {
  window.dispatchEvent(new CustomEvent(CLEAR_HISTORY_EVENT, { detail: { roomId } }));
}

export function ClearHistory({ client, room }: { client: MatrixClient; room: Room }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const me = client.getUserId() ?? '';

  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<{ roomId: string }>).detail?.roomId === room.roomId) setOpen(true);
    };
    window.addEventListener(CLEAR_HISTORY_EVENT, onOpen);
    return () => window.removeEventListener(CLEAR_HISTORY_EVENT, onOpen);
  }, [room.roomId]);

  const doClear = async (all: boolean) => {
    setBusy(true);
    try {
      if (all) {
        setOpen(false);
        await clearForAll(client, room);
      } else {
        await clearForMe(client, room);
        toast('История очищена', { variant: 'success' });
      }
    } catch (e) {
      console.warn('clear failed', e);
      toast('Не удалось очистить историю', { variant: 'error' });
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const canAll = canClearForAll(room, me);
  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Очистить историю чата?"
      actions={
        <>
          <Button variant="primary" size="lg" busy={busy} disabled={busy} onClick={() => void doClear(false)}>Только у меня</Button>
          {canAll && <Button variant="secondary" size="lg" disabled={busy} onClick={() => void doClear(true)}>У всех</Button>}
          <Button variant="ghost" size="lg" data-rl-close>Отмена</Button>
        </>
      }
    >
      {canAll && <p>У всех: сообщения удалятся у всех участников. Отменить нельзя.</p>}
    </Modal>
  );
}
