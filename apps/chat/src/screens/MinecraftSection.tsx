import { useEffect, useState, type FormEvent } from 'react';
import { hasMcRealm } from '../config';
import { friendlyError } from '../lib/account';
import { logoutStored } from '../lib/matrix';
import { getBindStatus, linkMinecraft, NEED_NICK_PIN, normalizeLogin, unlinkMinecraft, type BindStatus } from '../lib/phone';
import { forgetLink, loadLink, PIN_HINT, pinOk, saveLink } from '../lib/pin';
import { useClient, useMatrix } from '../state/MatrixContext';
import { Button, Card, Field, Modal, toast } from '../components/ui';
import { PinInput } from '../components/PinInput';

/**
 * Настройки семьи: свой ник Minecraft. Роль «Minecraft» выдаёт админ в «Людях»; после связки
 * один вход (номер или ник + PIN) открывает оба чата, переключатель — вверху списка.
 */
export function MinecraftSection() {
  const client = useClient();
  const { switchRealm, refreshOther } = useMatrix();
  const token = client.getAccessToken();
  const family = loadLink('family');
  const [st, setSt] = useState<BindStatus | null>(null);
  const [nick, setNick] = useState('');
  const [pin, setPin] = useState('');
  const [nickPin, setNickPin] = useState('');
  const [needNickPin, setNeedNickPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!token || !hasMcRealm()) return;
    getBindStatus(token).then(setSt).catch(() => setSt(null));
  }, [token]);

  if (!hasMcRealm() || !token || !st || (!st.mc && !st.mcAllowed)) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !family) return;
    if (!normalizeLogin(nick)) return setError('Ник: латиница, цифры и _, от 3 до 16 символов');
    if (!pinOk(pin)) return setError(`PIN — ${PIN_HINT.toLowerCase()}`);
    if (needNickPin && !pinOk(nickPin)) return setError('Введите PIN от ника');
    setBusy(true);
    setError(null);
    try {
      const r = await linkMinecraft(token, family, nick, pin, needNickPin ? nickPin : undefined);
      saveLink(r.link, 'mc');
      toast('Ник подключён');
      await switchRealm('mc', r);
    } catch (err) {
      if ((err as Error)?.message === NEED_NICK_PIN) {
        setNeedNickPin(true);
        setError(`Ник ${nick.trim()} уже есть. Введите PIN, который задавали при его регистрации, и нажмите «Подключить» ещё раз`);
      } else setError(friendlyError(err, 'Не удалось подключить ник'));
      setBusy(false);
    }
  };

  const unlink = async () => {
    setBusy(true);
    try {
      await unlinkMinecraft(token);
      await logoutStored('mc');
      forgetLink('mc');
      refreshOther();
      setSt({ ...st, mc: null });
      setConfirm(false);
      toast('Ник отвязан');
    } catch (err) {
      toast(friendlyError(err, 'Не удалось отвязать'), { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card solid className="settings-card">
      <h2 className="settings-card__title">Minecraft</h2>
      {st.mc ? (
        <>
          <p className="settings-card__text">
            Подключён ник <b>{st.mc}</b>. Вход по номеру или нику с этим PIN открывает оба чата, переключатель — вверху списка.
          </p>
          <div className="stack">
            <Button variant="primary" onClick={() => void switchRealm('mc')}>
              Открыть Minecraft
            </Button>
            <Button variant="outline" onClick={() => setConfirm(true)}>
              Отвязать ник
            </Button>
          </div>
        </>
      ) : !st.mask || !family ? (
        <p className="settings-card__text">Чтобы подключить ник, сначала привяжите номер телефона и войдите по нему.</p>
      ) : (
        <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
          <p className="settings-card__text">
            Вам открыт чат сервера. Введите свой ник: новый зарегистрируется, уже существующий подключится (нужен и его PIN). Игроки
            семью не видят.
          </p>
          <Field
            label="Ник в Minecraft"
            name="mc-nick"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={16}
            value={nick}
            onChange={(e) => {
              setNick(e.target.value);
              setNeedNickPin(false);
            }}
            disabled={busy}
          />
          <PinInput
            label="Ваш PIN"
            name="mc-pin"
            hint="Тот же, что для входа сюда: он станет PIN и для ника"
            value={pin}
            error={needNickPin ? null : error}
            onChange={(e) => setPin(e.target.value)}
            disabled={busy}
          />
          {needNickPin && (
            <PinInput
              label={`PIN от ника ${nick.trim()}`}
              name="mc-oldpin"
              autoFocus
              value={nickPin}
              error={error}
              onChange={(e) => setNickPin(e.target.value)}
              disabled={busy}
            />
          )}
          <Button type="submit" variant="primary" busy={busy} disabled={busy || !nick.trim() || !pinOk(pin)}>
            Подключить
          </Button>
        </form>
      )}
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Отвязать ник?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)} disabled={busy}>
              Отмена
            </Button>
            <Button variant="danger" busy={busy} onClick={() => void unlink()}>
              Отвязать
            </Button>
          </>
        }
      >
        <p>Чат Minecraft останется, но входить в него придётся отдельно — по нику и PIN.</p>
      </Modal>
    </Card>
  );
}
