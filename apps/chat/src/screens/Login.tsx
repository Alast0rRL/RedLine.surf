import { useState, type FormEvent } from 'react';
import { getConfig } from '../config';
import { formatLink, parseLink, PIN_LENGTH, saveLink, type PersonalLink } from '../lib/pin';
import { fetchLinkByPhone, normalizePhone } from '../lib/phone';
import { useMatrix } from '../state/MatrixContext';
import { Button, Field, RedLines } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';

export function Login() {
  const { login, enterPin, error: sessionError } = useMatrix();
  const [admin, setAdmin] = useState(false);
  const [byPhone, setByPhone] = useState(false);
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [value, setValue] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { serverName } = getConfig();

  const submitLink = (e: FormEvent) => {
    e.preventDefault();
    const link: PersonalLink | null = parseLink(value);
    if (!link) {
      setError('Это не похоже на личную ссылку');
      return;
    }
    setError(null);
    saveLink(link);
    location.hash = new URL(formatLink(link)).hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  const submitPhone = async (e: FormEvent) => {
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
      setError((err as Error).message || 'Не удалось войти');
      setPin('');
      setBusy(false);
    }
  };

  const submitAdmin = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError((err as Error).message);
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

        {admin ? (
          <form className="stack" onSubmit={(e) => void submitAdmin(e)} noValidate>
            <Field
              label="Логин"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="имя"
              hint={`Адрес будет @имя:${serverName}`}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
              required
            />
            <Field
              label="Пароль"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={error ?? sessionError}
              disabled={busy}
              required
            />
            <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={!username.trim() || !password}>
              Войти
            </Button>
            <Button variant="ghost" size="sm" className="login__link" onClick={() => { setAdmin(false); setError(null); }}>
              Назад
            </Button>
          </form>
        ) : byPhone ? (
          <form className="stack" onSubmit={(e) => void submitPhone(e)} noValidate>
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
            <Button variant="ghost" size="sm" className="login__link" disabled={busy} onClick={() => { setByPhone(false); setError(null); }}>
              Назад
            </Button>
          </form>
        ) : (
          <form className="stack" onSubmit={submitLink} noValidate>
            <Button variant="primary" size="lg" block onClick={() => { setByPhone(true); setError(null); }}>
              Войти по номеру телефона
            </Button>
            <Field
              label="Вставь свою ссылку"
              name="link"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={value}
              error={error ?? sessionError}
              onChange={(e) => setValue(e.target.value)}
              required
            />
            <Button type="submit" variant="primary" size="lg" block>Продолжить</Button>
            <Button variant="ghost" size="sm" className="login__link" onClick={() => { setAdmin(true); setError(null); }}>
              Вход по паролю
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
