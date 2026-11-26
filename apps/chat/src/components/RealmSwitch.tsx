import { useEffect, useRef, useState, type RefObject } from 'react';
import { otherRealm, type Realm } from '../config';
import { loadSession } from '../lib/session';
import { useMatrix } from '../state/MatrixContext';
import { useHashRoute } from '../hooks/useHashRoute';
import { isTgConnected } from '../tg/client';
import { useTgVersion } from '../tg/hooks';

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

type Tab = Realm | 'tg';
const SWIPE_LOCK_PX = 12;
const SWIPE_GO_PX = 70;

/**
 * Свайп влево/вправо по списку чатов — соседняя вкладка, как в Telegram.
 * Список чуть едет за пальцем; вертикальная прокрутка не мешает.
 */
function useTabSwipe(nav: RefObject<HTMLElement | null>, go: RefObject<(dir: 1 | -1) => boolean>, on: boolean) {
  useEffect(() => {
    if (!on) return;
    const pane = nav.current?.closest<HTMLElement>('.pane--list');
    if (!pane) return;
    let st: { x: number; y: number; id: number; mode: 'idle' | 'h' } | null = null;
    const blocked = () => !!document.querySelector('dialog[open], [role="dialog"], [role="menu"], .side-menu');
    const reset = (animate: boolean) => {
      pane.style.transition = animate ? 'transform 0.18s ease-out' : '';
      pane.style.transform = '';
    };
    const onStart = (e: TouchEvent) => {
      st = null;
      if (e.touches.length !== 1 || blocked()) return;
      if ((e.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return;
      const t = e.touches[0];
      // у левого края — системный «назад» Android
      if (t.clientX < 24) return;
      st = { x: t.clientX, y: t.clientY, id: t.identifier, mode: 'idle' };
    };
    const onMove = (e: TouchEvent) => {
      if (!st) return;
      const t = [...e.touches].find((x) => x.identifier === st!.id);
      if (!t) return;
      const dx = t.clientX - st.x;
      const dy = t.clientY - st.y;
      if (st.mode === 'idle') {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_LOCK_PX) return;
        if (Math.abs(dx) > Math.abs(dy) * 1.5) {
          st.mode = 'h';
          pane.style.transition = '';
        } else {
          st = null;
          return;
        }
      }
      if (e.cancelable) e.preventDefault();
      pane.style.transform = `translateX(${dx * 0.35}px)`;
    };
    const onEnd = (e: TouchEvent) => {
      const s = st;
      st = null;
      if (!s || s.mode !== 'h') return;
      const t = [...e.changedTouches].find((x) => x.identifier === s.id);
      const dx = (t?.clientX ?? s.x) - s.x;
      reset(true);
      if (e.type === 'touchend' && Math.abs(dx) >= SWIPE_GO_PX) go.current(dx < 0 ? 1 : -1);
    };
    pane.addEventListener('touchstart', onStart, { passive: true });
    pane.addEventListener('touchmove', onMove, { passive: false });
    pane.addEventListener('touchend', onEnd, { passive: true });
    pane.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      pane.removeEventListener('touchstart', onStart);
      pane.removeEventListener('touchmove', onMove);
      pane.removeEventListener('touchend', onEnd);
      pane.removeEventListener('touchcancel', onEnd);
      reset(false);
    };
  }, [nav, go, on]);
}

/** «Семья | Minecraft | Telegram» — у кого оба мира или подключён Telegram. Как роли в Discord: какие выданы, туда и есть вход. */
export function RealmSwitch() {
  const { realm, hasOther, switchRealm } = useMatrix();
  const route = useHashRoute();
  useTgVersion();
  const tg = isTgConnected();
  const onTg = route.name === 'tg' || route.name === 'tg-chat';
  const unread = useOtherUnread(hasOther ? otherRealm(realm) : null);
  const nav = useRef<HTMLElement>(null);
  const tabs = hasOther ? TABS : TABS.filter(([r]) => r === realm);
  const order: Tab[] = [...tabs.map(([r]) => r), ...(tg ? (['tg'] as const) : [])];
  const current: Tab = onTg ? 'tg' : realm;
  const go = useRef<(dir: 1 | -1) => boolean>(() => false);
  go.current = (dir) => {
    const next = order[order.indexOf(current) + dir];
    if (!next) return false;
    if (next === 'tg') location.hash = '#/tg';
    else open(next);
    return true;
  };
  useTabSwipe(nav, go, order.length > 1);
  if (!hasOther && !tg) return null;
  function open(r: Realm) {
    if (r === realm) {
      location.hash = '#/';
      return;
    }
    if (onTg) {
      history.replaceState(null, '', '/#/');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
    void switchRealm(r);
  }
  return (
    <nav ref={nav} className="realm-switch" aria-label="Чаты">
      {tabs.map(([r, label]) => {
        const active = r === realm && !onTg;
        return (
          <button
            key={r}
            type="button"
            className={`realm-switch__tab${active ? ' is-active' : ''}`}
            aria-pressed={active}
            onClick={() => !active && open(r)}
          >
            {label}
            {r !== realm && unread > 0 && <span className="realm-switch__badge">{unread > 99 ? '99+' : unread}</span>}
          </button>
        );
      })}
      {tg && (
        <button
          type="button"
          className={`realm-switch__tab${onTg ? ' is-active' : ''}`}
          aria-pressed={onTg}
          onClick={() => {
            if (!onTg) location.hash = '#/tg';
          }}
        >
          Telegram
        </button>
      )}
    </nav>
  );
}
