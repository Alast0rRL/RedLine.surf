import { useState, type FormEvent } from 'react';
import type { Realm } from '../config';
import { friendlyError } from '../lib/account';
import { PIN_HINT, PIN_MAX, pinOk } from '../lib/pin';
import { Button, Field, Modal } from '../components/ui';

/** PIN для второго мира, если вход в него не случился вместе с основным (на этом устройстве один раз). */
export function RealmPin({
  realm,
  title,
  onSubmit,
  onClose,
}: {
  realm: Realm;
  title?: string;
  onSubmit: (pin: string) => Promise<void>;
  onClose: () => void;
}) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !pinOk(pin)) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(pin);
    } catch (err) {
      setError(friendlyError(err, 'Неверный PIN'));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={title ?? (realm === 'mc' ? 'Открыть Minecraft' : 'Открыть Семью')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" busy={busy} disabled={busy || !pinOk(pin)} onClick={() => void submit()}>
            Открыть
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} noValidate>
        <Field
          label="PIN"
          name="pin"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={PIN_MAX}
          autoComplete="off"
          autoFocus
          className="pin-input"
          hint={PIN_HINT}
          value={pin}
          error={error}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_MAX))}
          disabled={busy}
        />
      </form>
    </Modal>
  );
}
