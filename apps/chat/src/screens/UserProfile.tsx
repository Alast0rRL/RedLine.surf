import { useEffect, useState } from 'react';
import { useClient } from '../state/MatrixContext';
import { navigate } from '../hooks/useHashRoute';
import { findExistingDm } from './NewChat';
import { isPinUser } from '../lib/pin';
import { formatLogin } from '../lib/login';
import { isRoomMuted, openDm, setRoomMuted } from '../lib/rooms';
import { Button, Card, toast } from '../components/ui';
import { ExtraIcon } from '../components/extraIcons';
import { BigAvatar, InfoFrame, useRoomRefresh } from './infoParts';

interface Info {
  name: string;
  mxc: string | null;
}

export function UserProfile({ userId }: { userId: string }) {
  const client = useClient();
  useRoomRefresh(client);
  const me = client.getUserId();
  const own = me === userId;
  const hideId = isPinUser(me);
  const fallbackName = hideId ? 'Участник' : userId;
  const cached = client.getUser(userId);
  const [info, setInfo] = useState<Info>({
    name: cached?.displayName || fallbackName,
    mxc: cached?.avatarUrl ?? null,
  });
  const [busy, setBusy] = useState<'dm' | null>(null);

  useEffect(() => {
    let alive = true;
    client
      .getProfileInfo(userId)
      .then((p) => alive && setInfo({ name: p.displayname || fallbackName, mxc: p.avatar_url ?? null }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, userId, fallbackName]);

  const dmId = own ? null : findExistingDm(client, userId);
  const muted = dmId ? isRoomMuted(client, dmId) : false;

  const write = async () => {
    setBusy('dm');
    try {
      navigate.room(await openDm(client, userId));
    } catch (e) {
      console.error(e);
      toast('Не удалось открыть чат. Проверьте интернет и попробуйте ещё раз', { variant: 'error' });
      setBusy(null);
    }
  };

  const toggleMute = () => {
    if (!dmId) return;
    setRoomMuted(client, dmId, !muted).catch((e) => {
      console.error(e);
      toast('Не получилось изменить уведомления. Проверьте интернет и попробуйте ещё раз', { variant: 'error' });
    });
  };

  return (
    <InfoFrame title="Профиль" onBack={() => navigate.back('#/')}>
      <Card solid className="settings-card">
        <div className="info__head" style={{ width: '100%' }}>
          <BigAvatar client={client} name={info.name} seed={userId} mxc={info.mxc} label={`Фото: ${info.name}`} />
          <h1 className="info__name">{info.name}</h1>
          <p className="info__id">{formatLogin(userId)}</p>
          {own && <p className="info__muted">Это вы</p>}
        </div>
        <div className="info__actions">
          {own ? (
            <Button variant="outline" onClick={() => navigate.settings()}>Открыть настройки</Button>
          ) : (
            <>
              <Button variant="primary" busy={busy === 'dm'} disabled={!!busy} onClick={() => void write()}>Написать</Button>
              {dmId && (
                <Button variant="outline" onClick={toggleMute}>
                  <ExtraIcon name="bellOff" /> {muted ? 'Включить звук' : 'Без звука'}
                </Button>
              )}
            </>
          )}
        </div>
      </Card>
    </InfoFrame>
  );
}
