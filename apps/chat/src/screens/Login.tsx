import { useState, type FormEvent } from 'react';
import { friendlyError } from '../lib/account';
import { PIN_HINT, pinOk } from '../lib/pin';
import { fetchLinkByPhone, isWrongCredentials, loginExists, normalizeFamilyLogin, normalizeLogin, normalizePhone } from '../lib/phone';
import { hasMcRealm, setRealm } from '../config';
import { useMatrix } from '../state/MatrixContext';
import { Button, Field, RedLines } from '../components/ui';
import { PinInput } from '../components/PinInput';
import { ThemeToggle } from '../components/ThemeToggle';

/** Ник, с которым ушли со входа на регистрацию: экран регистрации подставит его. */
export const REG_NICK_KEY = 'rl.regNick';

export function Login({ mode }: { mode: 'family' | 'mc' | 'any' }) {
  const mc = mode === 'mc';
  const any = mode === 'any';
  const { enterPin, error: sessionError } = useMatrix();
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Логина нет ни в одном мире: предлагаем регистрацию (ник Minecraft — он и есть логин). */
  const [notFound, setNotFound] = useState<string | null>(null);

  const toRegister = (nick: string) => {
    try { sessionStorage.setItem(REG_NICK_KEY, nick); } catch { /* приватный режим */ }
    location.hash = '#/mc';
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !pinOk(pin)) return;
    // номер — сервер семьи; с нейтрального входа сначала пробуем семью, потом Minecraft
    const isPhone = /^[\d\s+()-]+$/.test(phone.trim()) && !!normalizePhone(phone);
    if (any || isPhone) setRealm('family');
    else if (mode === 'family' && normalizeFamilyLogin(phone)) setRealm('family');
    else if (hasMcRealm() && normalizeLogin(phone)) setRealm('mc');
    else {
      setError(mode === 'family' ? 'Введите номер телефона или логин' : 'Введите номер телефона или ник');
      return;
    }
    setBusy(true);
    setError(null);
    setNotFound(null);
    if (!isPhone && (await loginExists(phone)) === false) {
      setNotFound(phone.trim());
      setError('Аккаунт не найден');
      setBusy(false);
      return;
    }
    let familyError: string | null = null;
    try {
      // ссылку отдаёт сервер, дальше вход идёт ровно как по ссылке (enterPin запомнит её)
      let link: Awaited<ReturnType<typeof fetchLinkByPhone>>;
      if (any && !isPhone) {
        try {
          link = await fetchLinkByPhone(phone, pin, 'family');
        } catch (err) {
          familyError = isWrongCredentials(err) ? 'Неверный логин или PIN' : friendlyError(err, 'Неверный логин или PIN');
          if (!isWrongCredentials(err) || !hasMcRealm()) throw err;
          setRealm('mc');
          link = await fetchLinkByPhone(phone, pin, 'mc');
        }
      } else {
        link = await fetchLinkByPhone(phone, pin);
      }
      await enterPin(link, pin);
    } catch (err) {
      setError(familyError ?? friendlyError(err, 'Не удалось войти'));
      if (any) setRealm('family');
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
        {!any && <span className="rl-eyebrow">{mc ? 'Minecraft' : 'Семейный чат'}</span>}
        <h1 className="login__title">
          Redline <span>Chat</span>
        </h1>

        <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
          <Field
            label={any ? 'Телефон, логин или ник' : mc ? 'Ник' : 'Телефон или ник'}
            name="phone"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={phone}
            onChange={(e) => { setPhone(e.target.value); setNotFound(null); }}
            disabled={busy}
            required
          />
          <PinInput
            label="PIN"
            name="pin"
            labelHint={PIN_HINT}
            value={pin}
            error={error ?? sessionError}
            onChange={(e) => setPin(e.target.value)}
            disabled={busy}
            required
          />
          <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={busy || !phone.trim() || !pinOk(pin)}>
            Войти
          </Button>
          {notFound && mode !== 'family' && hasMcRealm() && normalizeLogin(notFound) && (
            <Button variant="secondary" size="lg" block disabled={busy} onClick={() => toRegister(notFound)}>
              Зарегистрироваться?
            </Button>
          )}
          {mc && !notFound && (
            <Button variant="ghost" size="sm" className="login__link" disabled={busy} onClick={() => { location.hash = '#/mc'; }}>
              Нет аккаунта? Регистрация
            </Button>
          )}
        </form>
      </div>
    </main>
  );
}
