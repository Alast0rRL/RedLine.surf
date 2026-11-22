import { useEffect, useState } from 'react';

export type Route =
  | { name: 'list' }
  | { name: 'room'; roomId: string }
  | { name: 'settings' };

function parse(hash: string): Route {
  const m = hash.match(/^#\/room\/(.+)$/);
  if (m) return { name: 'room', roomId: decodeURIComponent(m[1]) };
  if (hash === '#/settings') return { name: 'settings' };
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
};
