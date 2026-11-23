import { useEffect, useState, type FormEvent } from 'react';
import { friendlyError } from '../lib/account';
import { useClient } from '../state/MatrixContext';
import { bindPhone, getBoundPhone, normalizePhone, unbindPhone, verifyPin } from '../lib/phone';
import { loadLink, PIN_LENGTH } from '../lib/pin';
import { Button, Card, Field, Icon, toast } from '../components/ui';

/** Настройки: вход по номеру телефона и PIN (только для тех, кто входит по ссылке). */
export function PhoneSection() {
  const client = useClient();
  const token = client.getAccessToken();
  const link = loadLink();
  const [mask, setMask] = useState<string | null | undefined>(undefined);
  const [form, setForm] = useState(false);
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    getBoundPhone(token).then(setMask).catch(() => setMask(null));
  }, [token]);

  if (!link || !token) return null;

  const close = () => {
    setForm(false);
    setPhone('');
    setPin('');
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || pin.length !== PIN_LENGTH) return;
    if (!normalizePhone(phone)) {
      setError('Проверьте номер');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await verifyPin(link, pin);
      setMask(await bindPhone(token, link, phone, pin));
      toast('Номер привязан');
      close();
    } catch (err) {
      setError(friendlyError(err, 'Не удалось привязать номер'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await unbindPhone(token);
      setMask(null);
      toast('Номер отвязан');
    } catch {
      toast('Не удалось отвязать номер. Проверьте интернет и попробуйте ещё раз', { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card solid className="settings-card">
      <h2 className="settings-card__title"><Icon name="key" size={18} /> Вход по номеру</h2>
      {form ? (
        <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
          <Field
            label="Номер телефона"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+7 900 123-45-67"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={busy}
          />
          <Field
            label="Ваш PIN"
            hint={`${PIN_LENGTH} цифр`}
            name="pin"
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={PIN_LENGTH}
            autoComplete="off"
            className="pin-input"
            value={pin}
            error={error}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
            disabled={busy}
          />
          <Button type="submit" variant="primary" busy={busy} disabled={busy || !phone.trim() || pin.length !== PIN_LENGTH}>
            Привязать
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={close}>Отмена</Button>
        </form>
      ) : mask === undefined ? (
        <p className="settings-card__text">…</p>
      ) : mask ? (
        <>
          <p className="settings-card__text">Привязан номер {mask}. На новом устройстве хватит номера и PIN.</p>
          <Button variant="secondary" disabled={busy} onClick={() => setForm(true)}>Изменить</Button>
          <Button variant="ghost" busy={busy} disabled={busy} onClick={() => void remove()}>Отвязать</Button>
        </>
      ) : (
        <>
          <p className="settings-card__text">Привяжите номер, чтобы входить на новом устройстве по номеру и PIN, без ссылки. SMS не нужно.</p>
          <Button variant="primary" onClick={() => setForm(true)}>Привязать номер</Button>
        </>
      )}
    </Card>
  );
}
