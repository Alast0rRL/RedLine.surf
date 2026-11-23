import { useState, type FormEvent } from 'react';
import { friendlyError } from '../lib/account';
import { bindPhone, normalizePhone } from '../lib/phone';
import type { PersonalLink } from '../lib/pin';
import { Button, Field, RedLines, toast } from '../components/ui';

export interface PhoneOfferData {
  link: PersonalLink;
  pin: string;
  token: string;
}

/** Шаг сразу после ввода PIN: пока он ещё в памяти, предлагаем привязать номер. */
export function PhoneOffer({ offer, onClose }: { offer: PhoneOfferData; onClose: () => void }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!normalizePhone(phone)) {
      setError('Проверьте номер');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bindPhone(offer.token, offer.link, phone, offer.pin);
      toast('Номер привязан');
      onClose();
    } catch (err) {
      setError(friendlyError(err, 'Не удалось привязать номер'));
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--chat-bg)' }}>
      <main className="screen login">
        <RedLines />
        <div className="login__glow" aria-hidden="true" />
        <div className="login__card rl-card rl-card--lg">
          <span className="rl-eyebrow">Redline Chat</span>
          <h1 className="login__title">Вход по номеру телефона</h1>
          <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
            <p className="login__note">
              Привяжи номер, и на новом устройстве хватит номера и PIN. SMS не будет, номер хранится только в виде хеша.
            </p>
            <Field
              label="Номер телефона"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+7 900 123-45-67"
              autoFocus
              value={phone}
              error={error}
              onChange={(e) => setPhone(e.target.value)}
              disabled={busy}
            />
            <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={busy || !phone.trim()}>
              Привязать
            </Button>
            <Button variant="ghost" size="sm" className="login__link" disabled={busy} onClick={onClose}>
              Позже
            </Button>
          </form>
        </div>
      </main>
    </div>
  );
}
