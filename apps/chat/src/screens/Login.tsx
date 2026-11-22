import { useState, type FormEvent } from 'react';
import { getConfig } from '../config';
import { useMatrix } from '../state/MatrixContext';
import { Button, Field, RedLines } from '../components/ui';

export function Login() {
  const { login, error: sessionError } = useMatrix();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { serverName } = getConfig();

  const submit = async (e: FormEvent) => {
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
      <form className="login__card rl-card rl-card--lg" onSubmit={submit} noValidate>
        <span className="rl-eyebrow">Семейный чат</span>
        <h1 className="login__title">
          Redline <span>Chat</span>
        </h1>
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
        <p className="login__note">Аккаунты создаёт администратор. Регистрации нет.</p>
      </form>
    </main>
  );
}
