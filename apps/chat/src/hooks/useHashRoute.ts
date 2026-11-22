import { useEffect, useState } from 'react';
import { parseInviteHash } from '../lib/invites';

export type Route =
  | { name: 'list' }
  | { name: 'room'; roomId: string }
  | { name: 'settings' }
  | { name: 'people' }
  | { name: 'invite'; token: string; roomId: string | null };

function parse(hash: string): Route {
  const invite = parseInviteHash(hash);
  if (invite) return { name: 'invite', token: invite.token, roomId: invite.roomId };
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
};
