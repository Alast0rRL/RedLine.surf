import { useState, type FormEvent } from 'react';
import { Button, Card, Field, Icon } from '../components/ui';
import { navigate } from '../hooks/useHashRoute';
import { disconnectTg, getTg, isTgConnected, markSignedIn, rpcCode, tgAvailable, tgErrorText } from './client';
import { useTgVersion } from './hooks';

type Step = { kind: 'phone' } | { kind: 'code'; phone: string; hash: string; app: boolean } | { kind: 'password'; hint: string | null };

/** Подключение Telegram: номер → код (придёт в Telegram или SMS) → пароль 2FA, если включён. */
export function TgConnect() {
  useTgVersion();
  const connected = isTgConnected();
  const [step, setStep] = useState<Step>({ kind: 'phone' });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      console.error(e);
      setError(tgErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const done = async () => {
    await markSignedIn();
    navigate.tg();
  };

  const sendCode = (e: FormEvent) => {
    e.preventDefault();
    const p = phone.replace(/[^\d+]/g, '');
    if (p.replace(/\D/g, '').length < 10) {
      setError('Введите номер полностью, с кодом страны');
      return;
    }
    void run(async () => {
      const tg = await getTg();
      const sent = await tg.sendCode({ phone: p });
      if (!('phoneCodeHash' in sent)) {
        // сессия уже вошла (например, после прерванной попытки)
        await done();
        return;
      }
      setCode('');
      setStep({ kind: 'code', phone: p, hash: sent.phoneCodeHash, app: sent.type === 'app' });
    });
  };

  const signIn = (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== 'code') return;
    void run(async () => {
      const tg = await getTg();
      try {
        await tg.signIn({ phone: step.phone, phoneCodeHash: step.hash, phoneCode: code.trim() });
      } catch (err) {
        if (rpcCode(err) === 'SESSION_PASSWORD_NEEDED') {
          const hint = await tg.call({ _: 'account.getPassword' }).then((r) => r.hint ?? null, () => null);
          setPassword('');
          setStep({ kind: 'password', hint });
          return;
        }
        throw err;
      }
      await done();
    });
  };

  const checkPassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const tg = await getTg();
      await tg.checkPassword(password);
      await done();
    });
  };

  const disconnect = () => void run(async () => {
    await disconnectTg();
    navigate.list();
  });

  return (
    <section className="pane pane--room" aria-label="Telegram">
      <header className="topbar topbar--room">
        <Button variant="ghost" icon aria-label="Назад" className="topbar__back" onClick={() => navigate.back('#/settings')}>
          <Icon name="back" />
        </Button>
        <span className="topbar__title"><span className="topbar__name">Telegram</span></span>
      </header>
      <div className="settings">
        {!tgAvailable() ? (
          <Card solid className="settings-card">
            <p className="settings-card__text">Telegram на этом сервере пока не настроен.</p>
          </Card>
        ) : connected ? (
          <Card solid className="settings-card">
            <h2 className="settings-card__title"><Icon name="check" size={18} /> Telegram подключён</h2>
            <p className="settings-card__text">Чаты Telegram открываются во вкладке «Telegram» над списком чатов. Сессия хранится только на этом устройстве.</p>
            <div className="stack">
              <Button variant="primary" onClick={() => navigate.tg()}>Открыть чаты</Button>
              <Button variant="ghost" busy={busy} onClick={disconnect}>Отключить Telegram</Button>
            </div>
            {error && <p className="rl-hint rl-hint--error" role="alert">{error}</p>}
          </Card>
        ) : (
          <Card solid className="settings-card">
            <h2 className="settings-card__title"><Icon name="key" size={18} /> Подключить Telegram</h2>
            {step.kind === 'phone' && (
              <>
                <p className="settings-card__text">
                  Войдите в свой Telegram — чаты появятся здесь, можно читать и отвечать. Вход хранится только на этом устройстве,
                  на наш сервер он не попадает. Отключить можно в любой момент.
                </p>
                <form className="stack" onSubmit={sendCode} noValidate>
                  <Field label="Номер телефона" name="tel" type="tel" inputMode="tel" autoComplete="tel" placeholder="+7 900 000-00-00" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={busy} autoFocus />
                  {error && <p className="rl-hint rl-hint--error" role="alert">{error}</p>}
                  <Button variant="primary" type="submit" busy={busy}>Получить код</Button>
                </form>
              </>
            )}
            {step.kind === 'code' && (
              <>
                <p className="settings-card__text">{step.app ? 'Код пришёл в Telegram на другом устройстве (чат «Telegram»).' : 'Код придёт по SMS.'}</p>
                <form className="stack" onSubmit={signIn} noValidate>
                  <Field label="Код" name="code" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} disabled={busy} autoFocus />
                  {error && <p className="rl-hint rl-hint--error" role="alert">{error}</p>}
                  <Button variant="primary" type="submit" busy={busy} disabled={code.length < 5}>Войти</Button>
                  <Button variant="ghost" type="button" disabled={busy} onClick={() => { setStep({ kind: 'phone' }); setError(null); }}>Другой номер</Button>
                </form>
              </>
            )}
            {step.kind === 'password' && (
              <>
                <p className="settings-card__text">Включена двухэтапная проверка — введите облачный пароль Telegram.</p>
                <form className="stack" onSubmit={checkPassword} noValidate>
                  <Field label="Пароль" name="password" type="password" autoComplete="current-password" hint={step.hint ? `Подсказка: ${step.hint}` : undefined} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} autoFocus />
                  {error && <p className="rl-hint rl-hint--error" role="alert">{error}</p>}
                  <Button variant="primary" type="submit" busy={busy} disabled={!password}>Войти</Button>
                </form>
              </>
            )}
          </Card>
        )}
      </div>
    </section>
  );
}
