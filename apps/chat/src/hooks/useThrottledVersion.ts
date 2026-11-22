import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Счётчик-«версия» для перерисовки по событиям SDK. Несколько событий
 * за кадр схлопываются в одну перерисовку (sync приносит пачки).
 */
export function useThrottledVersion(): [number, () => void] {
  const [version, setVersion] = useState(0);
  const frame = useRef(0);
  const bump = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setVersion((v) => v + 1);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  return [version, bump];
}
