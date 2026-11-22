import { useState, type FormEvent } from 'react';
import { getConfig } from '../config';
import { formatLink, parseLink, saveLink, type PersonalLink } from '../lib/pin';
import { useMatrix } from '../state/MatrixContext';
import { Button, Field, RedLines } from '../components/ui';

export function Login() {
  const { login, error: sessionError } = useMatrix();
  const [admin, setAdmin] = useState(false);
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
      <div className="login__glow" aria-hidden="true" />
      <div className="login__card rl-card rl-card--lg">
        <span className="rl-eyebrow">Семейный чат</span>
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
        ) : (
          <form className="stack" onSubmit={submitLink} noValidate>
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
