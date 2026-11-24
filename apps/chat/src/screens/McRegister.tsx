import { useState, type FormEvent } from 'react';
import { friendlyError } from '../lib/account';
import { hasMcRealm, setRealm } from '../config';
import { normalizeLogin, registerPlayer } from '../lib/phone';
import { PIN_HINT, PIN_MAX, pinOk } from '../lib/pin';
import { useMatrix } from '../state/MatrixContext';
import { Button, Field, RedLines } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';

/** Регистрация игрока Minecraft: ник — это логин, дальше вход по нику и PIN. Ссылка #/mc — кнопка на сайте сервера. */
export function McRegister() {
  const { enterPin } = useMatrix();
  const [nick, setNick] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, PIN_MAX);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!normalizeLogin(nick)) return setError('Ник: латиница, цифры и _, от 3 до 16 символов');
    if (!pinOk(pin)) return setError(`PIN — ${PIN_HINT.toLowerCase()}`);
    if (pin !== pin2) return setError('PIN не совпадает');
    setBusy(true);
    setError(null);
    try {
      setRealm('mc');
      const link = await registerPlayer(nick, pin);
      await enterPin(link, pin);
    } catch (err) {
      setError(friendlyError(err, 'Не удалось зарегистрироваться'));
      setBusy(false);
    }
  };

  const toLogin = () => {
    history.replaceState(null, '', '/#/');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  return (
    <main className="screen login">
      <RedLines />
      <ThemeToggle className="screen__theme" />
      <div className="login__glow" aria-hidden="true" />
      <div className="login__card rl-card rl-card--lg">
        <span className="rl-eyebrow">Redline Minecraft</span>
        <h1 className="login__title">
          Redline <span>Chat</span>
        </h1>
        {!hasMcRealm() ? (
          <p className="login__note">Регистрация игроков пока закрыта</p>
        ) : (
          <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
            <Field
              label="Ник в Minecraft"
              name="nick"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={16}
              hint="Он же будет логином для входа"
              value={nick}
              onChange={(e) => setNick(e.target.value)}
              disabled={busy}
            />
            <Field label="Придумай PIN" name="pin" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={PIN_MAX} autoComplete="off" className="pin-input" hint={PIN_HINT} value={pin} onChange={(e) => setPin(digits(e.target.value))} disabled={busy} />
            <Field label="PIN ещё раз" name="pin2" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={PIN_MAX} autoComplete="off" className="pin-input" value={pin2} error={error} onChange={(e) => setPin2(digits(e.target.value))} disabled={busy} />
            <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={busy || !nick.trim() || !pinOk(pin)}>
              Зарегистрироваться
            </Button>
          </form>
        )}
        <Button variant="ghost" size="sm" className="login__link" disabled={busy} onClick={toLogin}>
          Уже есть аккаунт? Войти
        </Button>
      </div>
    </main>
  );
}
