import { useEffect, useState } from 'react';
import { parseLink, type PersonalLink } from '../lib/pin';

export type Route =
  | { name: 'list' }
  | { name: 'room'; roomId: string }
  | { name: 'settings' }
  | { name: 'people' }
  | { name: 'user'; userId: string }
  | { name: 'room-info'; roomId: string }
  | { name: 'personal'; link: PersonalLink }
  | { name: 'old-invite' };

function parse(hash: string): Route {
  const link = parseLink(hash);
  if (link) return { name: 'personal', link };
  if (/^#?\/?invite\//.test(hash.trim())) return { name: 'old-invite' };
  const info = hash.match(/^#\/room\/([^/]+)\/info$/);
  if (info) return { name: 'room-info', roomId: decodeURIComponent(info[1]) };
  const u = hash.match(/^#\/user\/([^/]+)$/);
  if (u) return { name: 'user', userId: decodeURIComponent(u[1]) };
  const m = hash.match(/^#\/room\/(.+)$/);
  if (m) return { name: 'room', roomId: decodeURIComponent(m[1]) };
  if (hash === '#/settings') return { name: 'settings' };
  if (hash === '#/people') return { name: 'people' };
  return { name: 'list' };
}

/** Маршрут в hash — работает системная кнопка «назад» на Android и в PWA. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const navigate = {
  list: () => {
    // если пришли из списка — шаг назад сохраняет историю чистой
    if (history.state?.rlFromList) history.back();
    else location.hash = '#/';
  },
  room: (roomId: string) => {
    history.pushState({ rlFromList: true }, '', `#/room/${encodeURIComponent(roomId)}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  },
  settings: () => {
    history.pushState({ rlFromList: true }, '', '#/settings');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  },
  backToSettings: () => {
    // шаг назад, иначе «Назад» в настройках вернёт обратно в «Семью»
    if (history.state?.rlFromList) history.back();
    else location.hash = '#/settings';
  },
  people: () => {
    history.pushState({ rlFromList: true }, '', '#/people');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  },
  user: (userId: string) => {
    history.pushState({ rlFromList: true }, '', `#/user/${encodeURIComponent(userId)}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  },
  roomInfo: (roomId: string) => {
    history.pushState({ rlFromList: true }, '', `#/room/${encodeURIComponent(roomId)}/info`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  },
  /** Назад из информации/профиля: шаг истории, иначе — запасной экран. */
  back: (fallback: string) => {
    if (history.state?.rlFromList) history.back();
    else location.hash = fallback;
  },
};
