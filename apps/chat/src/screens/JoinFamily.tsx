import { useEffect, useState, type FormEvent } from 'react';
import { friendlyError } from '../lib/account';
import { loadConfig, setRealm } from '../config';
import { checkInviteCode, registerByInvite, type InviteCheck } from '../lib/guestInvites';
import { bindInvitedLogin, NO_TOKEN, normalizeFamilyLogin } from '../lib/phone';
import { newPerson, PIN_HINT, PIN_MAX, pinOk, pinPassword, type PersonalLink } from '../lib/pin';
import { useMatrix } from '../state/MatrixContext';
import { Button, Field, RedLines } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';

export function JoinFamily({ code }: { code: string }) {
  const { enterPin } = useMatrix();
  const [check, setCheck] = useState<InviteCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [serverName, setServerName] = useState('');
  const [name, setName] = useState('');
  const [login, setLogin] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, PIN_MAX);

  useEffect(() => {
    let alive = true;
    checkInviteCode(code)
      .then((r) => {
        if (!alive) return;
        setCheck(r);
        if (r.valid) {
          setName(r.name ?? '');
          setLogin(r.login ?? '');
        }
      })
      .catch((e) => {
        if (alive) setError(friendlyError(e, 'Не удалось проверить ссылку'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    void loadConfig()
      .then((c) => {
        if (alive) setServerName(c.serverName);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [code]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !check?.valid) return;
    const user = normalizeFamilyLogin(login);
    if (!user) return setError('Логин: латиница, цифры и . _ = -, от 1 до 32 символов');
    if (!name.trim()) return setError('Введите имя');
    if (!pinOk(pin)) return setError(`PIN — ${PIN_HINT.toLowerCase()}`);
    setBusy(true);
    setError(null);
    try {
      setRealm('family');
      const link: PersonalLink = { ...newPerson(name.trim(), user), token: NO_TOKEN };
      const password = await pinPassword(link, pin);
      const session = await registerByInvite({ code, login: user, name: name.trim(), password });
      await bindInvitedLogin(session.access_token, user, link, pin);
      await enterPin(link, pin);
    } catch (err) {
      setError(friendlyError(err, 'Не удалось войти. Попросите новую ссылку'));
      setBusy(false);
    }
  };

  return (
    <main className="screen login">
      <RedLines />
      <ThemeToggle className="screen__theme" />
      <div className="login__glow" aria-hidden="true" />
      <div className="login__card rl-card rl-card--lg">
        <span className="rl-eyebrow">Семейный чат</span>
        <h1 className="login__title">
          Redline <span>Chat</span>
        </h1>
        {!loading && check && !check.valid ? (
          <p className="login__note">Ссылка недействительна, попросите новую</p>
        ) : (
          <>
            {check?.valid && <p className="login__note">Вас пригласил(а) {check.inviter || check.invitedBy}</p>}
            <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
              <Field
                label="Как вас зовут"
                name="name"
                autoComplete="name"
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy || !check?.valid}
                required
              />
              <Field
                label="Логин"
                name="login"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={32}
                suffix={serverName ? `@${serverName}` : undefined}
                value={login}
                onChange={(e) => setLogin(e.target.value.toLowerCase())}
                disabled={busy || !check?.valid}
                required
              />
              <Field
                label="Придумайте PIN"
                name="pin"
                labelHint={`${PIN_HINT}. Запомните его: PIN нужен для входа на других устройствах`}
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={PIN_MAX}
                autoComplete="off"
                className="pin-input"
                value={pin}
                error={error}
                onChange={(e) => setPin(digits(e.target.value))}
                disabled={busy || !check?.valid}
                required
              />
              <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={busy || !check?.valid || !name.trim() || !login.trim() || !pinOk(pin)}>
                Войти в чат
              </Button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
