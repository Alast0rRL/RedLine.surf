import { useEffect, useState } from 'react';
import { otherRealm, type Realm } from '../config';
import { loadSession } from '../lib/session';
import { useMatrix } from '../state/MatrixContext';

const POLL_MS = 60_000;
/** Лёгкая синхронизация: только счётчики непрочитанного, без ленты, состояния и присутствия. */
const FILTER = JSON.stringify({
  presence: { types: [] },
  account_data: { types: [] },
  room: { timeline: { limit: 1 }, state: { types: [] }, ephemeral: { types: [] }, account_data: { types: [] } },
});

/** Непрочитанное во втором мире: его клиент не запущен, спрашиваем сервер раз в минуту, пока окно видно. */
function useOtherUnread(r: Realm | null): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!r) return;
    let stopped = false;
    const check = async () => {
      const s = loadSession(r);
      if (!s || stopped || document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(`${s.baseUrl}/_matrix/client/v3/sync?timeout=0&filter=${encodeURIComponent(FILTER)}`, {
          headers: { authorization: `Bearer ${s.accessToken}` },
        });
        if (res.status === 401) {
          stopped = true;
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as { rooms?: { join?: Record<string, { unread_notifications?: { notification_count?: number } }> } };
        const total = Object.values(data.rooms?.join ?? {}).reduce((sum, room) => sum + (room.unread_notifications?.notification_count ?? 0), 0);
        if (!stopped) setN(total);
      } catch {
        /* нет связи — покажем при следующей проверке */
      }
    };
    void check();
    const t = setInterval(() => void check(), POLL_MS);
    const onVisible = () => void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [r]);
  return r ? n : 0;
}

const TABS: Array<[Realm, string]> = [
  ['family', 'Семья'],
  ['mc', 'Minecraft'],
];

/** «Семья | Minecraft» — у кого оба мира. Как роли в Discord: какие выданы, туда и есть вход. */
export function RealmSwitch() {
  const { realm, hasOther, switchRealm } = useMatrix();
  const unread = useOtherUnread(hasOther ? otherRealm(realm) : null);
  if (!hasOther) return null;
  return (
    <nav className="realm-switch" aria-label="Чаты">
      {TABS.map(([r, label]) => (
        <button
          key={r}
          type="button"
          className={`realm-switch__tab${r === realm ? ' is-active' : ''}`}
          aria-pressed={r === realm}
          onClick={() => void switchRealm(r)}
        >
          {label}
          {r !== realm && unread > 0 && <span className="realm-switch__badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
      ))}
    </nav>
  );
}
