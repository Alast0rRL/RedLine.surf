import { useState, type FormEvent } from 'react';
import { friendlyError } from '../lib/account';
import { PIN_LENGTH } from '../lib/pin';
import { fetchLinkByPhone, normalizePhone } from '../lib/phone';
import { useMatrix } from '../state/MatrixContext';
import { Button, Field, RedLines } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';

export function Login() {
  const { enterPin, error: sessionError } = useMatrix();
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      // ссылку отдаёт сервер, дальше вход идёт ровно как по ссылке (enterPin запомнит её)
      const link = await fetchLinkByPhone(phone, pin);
      await enterPin(link, pin);
    } catch (err) {
      setError(friendlyError(err, 'Не удалось войти'));
      setPin('');
      setBusy(false);
    }
  };

  return (
    <main className="screen login">
      <RedLines />
      <ThemeToggle className="screen__theme" />
      <div className="login__glow" aria-hidden="true" />
      <div className="login__card rl-card rl-card--lg">
        <span className="rl-eyebrow">Redline Chat</span>
        <h1 className="login__title">
          Redline <span>Chat</span>
        </h1>

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
            required
          />
          <Field
            label="PIN"
            name="pin"
            hint={`${PIN_LENGTH} цифр`}
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={PIN_LENGTH}
            autoComplete="off"
            className="pin-input"
            value={pin}
            error={error ?? sessionError}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
            disabled={busy}
            required
          />
          <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={busy || !phone.trim() || pin.length !== PIN_LENGTH}>
            Войти
          </Button>
        </form>
      </div>
    </main>
  );
}
