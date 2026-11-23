import { useCallback, useEffect, useRef } from 'react';

/**
 * Оверлей закрывается системной кнопкой «назад»: при открытии кладём запись в историю,
 * popstate закрывает. dismiss() закрывает программно (шагом назад, чтобы история осталась чистой).
 */
export function useBackClose(onClose: () => void): () => void {
  const pushed = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    history.pushState({ ...(history.state ?? {}), rlOverlay: true }, '');
    pushed.current = true;
    const onPop = () => {
      pushed.current = false;
      closeRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return useCallback(() => {
    if (pushed.current) history.back();
    else closeRef.current();
  }, []);
}
