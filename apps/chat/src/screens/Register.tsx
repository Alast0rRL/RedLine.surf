import { useEffect, useState, type FormEvent } from 'react';
import { getConfig, loadConfig } from '../config';
import { checkInvite, passwordProblem, slugUsername, usernameProblem } from '../lib/account';
import { normalizePhrase, phraseProblem } from '../lib/security';
import { useMatrix } from '../state/MatrixContext';
import { Button, Field, RedLines } from '../components/ui';

type Check = 'checking' | 'valid' | 'invalid' | 'error';

export function Register({ token, roomId }: { token: string; roomId: string | null }) {
  const { register, error: sessionError } = useMatrix();
  const [check, setCheck] = useState<Check>('checking');
  const [attempt, setAttempt] = useState(0);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [phrase2, setPhrase2] = useState('');
  const [showSecrets, setShowSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    setCheck('checking');
    (async () => {
      try {
        const { homeserverUrl } = await loadConfig();
        const valid = await checkInvite(homeserverUrl, token);
        if (alive) setCheck(valid ? 'valid' : 'invalid');
      } catch {
        if (alive) setCheck('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, attempt]);

  const toLogin = () => {
    location.hash = '#/';
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!displayName.trim()) next.displayName = 'Напишите, как вас зовут';
    const loginProblem = usernameProblem(username);
    if (loginProblem) next.username = loginProblem;
    const passProblem = passwordProblem(password);
    if (passProblem) next.password = passProblem;
    const secretProblem = phraseProblem(phrase, password);
    if (secretProblem) next.phrase = secretProblem;
    if (!next.phrase && normalizePhrase(phrase) !== normalizePhrase(phrase2)) {
      next.phrase2 = 'Фразы не совпадают';
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setError(null);
    try {
      await register({ token, roomId, displayName: displayName.trim(), username, password, phrase });
    } catch (err) {
      setError((err as Error).message || 'Не удалось создать аккаунт');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="screen login">
      <RedLines />
      <div className="login__glow" aria-hidden="true" />
      <div className="login__card rl-card rl-card--lg">
        <span className="rl-eyebrow">Вас пригласили</span>
        <h1 className="login__title">
          Redline <span>Chat</span>
        </h1>

        {check === 'checking' && (
          <div className="splash__content">
            <span className="rl-spinner" />
            <p className="splash__text">Проверяем приглашение…</p>
          </div>
        )}

        {check === 'invalid' && (
          <div className="stack">
            <p className="login__note">Приглашение уже использовано или отозвано. Попросите новое.</p>
            <Button variant="secondary" onClick={toLogin}>У меня есть аккаунт</Button>
          </div>
        )}

        {check === 'error' && (
          <div className="stack">
            <p className="login__note">Не удалось проверить приглашение. Проверьте интернет и попробуйте ещё раз.</p>
            <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>Повторить</Button>
          </div>
        )}

        {check === 'valid' && (
          <form className="stack" onSubmit={submit} noValidate>
            <Field
              label="Как вас зовут"
              name="displayName"
              autoComplete="name"
              maxLength={40}
              value={displayName}
              error={errors.displayName ?? null}
              onChange={(e) => {
                const value = e.target.value;
                setDisplayName(value);
                if (!usernameEdited) setUsername(slugUsername(value));
              }}
              disabled={busy}
              required
            />
            <Field
              label="Логин"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={username}
              error={errors.username ?? null}
              onChange={(e) => {
                setUsername(e.target.value.toLowerCase());
                setUsernameEdited(true);
              }}
              hint={`Адрес будет @логин:${getConfig().serverName}`}
              disabled={busy}
              required
            />
            <Field
              label="Пароль"
              name="password"
              type={showSecrets ? 'text' : 'password'}
              autoComplete="new-password"
              value={password}
              error={errors.password ?? null}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              required
            />
            <Field
              label="Фраза восстановления"
              name="phrase"
              type={showSecrets ? 'text' : 'password'}
              autoComplete="off"
              value={phrase}
              error={errors.phrase ?? null}
              hint="Нужна на новом телефоне, чтобы прочитать старую переписку. Лучше 3–4 слова. Запишите её"
              onChange={(e) => setPhrase(e.target.value)}
              disabled={busy}
              required
            />
            <Field
              label="Повторите фразу"
              name="phrase2"
              type={showSecrets ? 'text' : 'password'}
              autoComplete="off"
              value={phrase2}
              error={errors.phrase2 ?? null}
              onChange={(e) => setPhrase2(e.target.value)}
              disabled={busy}
              required
            />
            <label className="check-row">
              <input
                type="checkbox"
                checked={showSecrets}
                onChange={(e) => setShowSecrets(e.target.checked)}
              />
              <span>Показать пароль и фразу</span>
            </label>
            {(error || sessionError) && <p className="login__error" role="alert">{error || sessionError}</p>}
            <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={busy}>
              Создать аккаунт
            </Button>
            <Button variant="ghost" size="sm" className="login__link" onClick={toLogin}>У меня есть аккаунт</Button>
          </form>
        )}
      </div>
    </main>
  );
}
