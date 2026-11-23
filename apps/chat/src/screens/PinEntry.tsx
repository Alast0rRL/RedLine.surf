import { useEffect, useState, type FormEvent } from 'react';
import { friendlyError } from '../lib/account';
import { loadConfig } from '../config';
import { ACCOUNT_DELETED, forgetLink, linkState, PIN_LENGTH, type LinkState, type PersonalLink } from '../lib/pin';
import { useMatrix } from '../state/MatrixContext';
import { Button, Field, RedLines } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';

type ScreenState = 'checking' | 'network-error' | LinkState;

export function PinEntry({ link }: { link: PersonalLink }) {
  const { enterPin, error: sessionError } = useMatrix();
  const [state, setState] = useState<ScreenState>('checking');
  const [attempt, setAttempt] = useState(0);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletedByAdmin, setDeletedByAdmin] = useState(false);

  useEffect(() => {
    let alive = true;
    setState('checking');
    (async () => {
      try {
        const { homeserverUrl } = await loadConfig();
        const result = await linkState(homeserverUrl, link);
        if (alive) setState(result);
      } catch {
        if (alive) setState('network-error');
      }
    })();
    return () => {
      alive = false;
    };
    // loadLink() каждый раз отдаёт новый объект: следим за значениями, иначе форма сбрасывается при вводе
  }, [link.user, link.key, link.token, attempt]);

  const deleted = deletedByAdmin || sessionError === ACCOUNT_DELETED;
  const shownError = [error, sessionError].filter(Boolean).join(' ');

  const otherLink = () => {
    forgetLink();
    location.hash = '#/';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || pin.length !== PIN_LENGTH) return;
    setBusy(true);
    setError(null);
    try {
      await enterPin(link, pin);
    } catch (err) {
      const message = (err as Error).message;
      if (message === ACCOUNT_DELETED) {
        setDeletedByAdmin(true);
        setPin('');
        return;
      }
      setError(friendlyError(err, 'Не удалось войти. Попробуйте ещё раз'));
      setPin('');
      setAttempt((n) => n + 1);
    } finally {
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

        {deleted && (
          <div className="stack">
            <p className="login__note" role="alert">{ACCOUNT_DELETED}</p>
            <Button variant="ghost" size="sm" className="login__link" onClick={otherLink}>Другая ссылка</Button>
          </div>
        )}

        {!deleted && state === 'checking' && (
          <div className="splash__content">
            <span className="rl-spinner" />
            <p className="splash__text">Проверяем ссылку…</p>
          </div>
        )}

        {!deleted && state === 'network-error' && (
          <div className="stack">
            <p className="login__note">Не удалось проверить ссылку. Проверь интернет и попробуй ещё раз.</p>
            {shownError && <p className="rl-hint rl-hint--error" role="alert">{shownError}</p>}
            <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>Повторить</Button>
          </div>
        )}

        {!deleted && state === 'invalid' && (
          <div className="stack">
            <p className="login__note">Ссылка больше не действует. Попроси новую</p>
            {shownError && <p className="rl-hint rl-hint--error" role="alert">{shownError}</p>}
            <Button variant="ghost" size="sm" className="login__link" onClick={otherLink}>Другая ссылка</Button>
          </div>
        )}

        {!deleted && (state === 'create' || state === 'enter') && (
          <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
            <p className="login__note">Привет, {link.name}!</p>
            <Field
              name="pin"
              label={state === 'create' ? 'Придумай PIN' : 'Введи PIN'}
              type={state === 'create' ? 'text' : 'password'}
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={PIN_LENGTH}
              autoComplete="off"
              autoFocus
              className="pin-input"
              value={pin}
              error={shownError || null}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
              disabled={busy}
            />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              busy={busy}
              disabled={busy || pin.length !== PIN_LENGTH}
            >
              Войти
            </Button>
            <Button variant="ghost" size="sm" className="login__link" onClick={otherLink}>Другая ссылка</Button>
          </form>
        )}
      </div>
    </main>
  );
}
