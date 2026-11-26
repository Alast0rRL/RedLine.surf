import { useCallback, useEffect, useRef, useState } from 'react';

/** Окно схлопывания: sync приносит пачки событий — одна перерисовка на пачку. */
const THROTTLE_MS = 32;

/**
 * Счётчик-«версия» для перерисовки по событиям SDK. Несколько событий
 * подряд схлопываются в одну перерисовку. setTimeout, а не requestAnimationFrame:
 * rAF в фоновой вкладке не срабатывает, и лента застревала бы на старых данных
 * (например, «Расшифровка…» после того, как событие уже расшифровано).
 */
export function useThrottledVersion(): [number, () => void] {
  const [version, setVersion] = useState(0);
  const timer = useRef(0);
  const bump = useCallback(() => {
    if (timer.current) return;
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      setVersion((v) => v + 1);
    }, THROTTLE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [version, bump];
}
