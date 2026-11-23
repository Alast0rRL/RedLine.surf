import { useEffect } from 'react';

const EDGE_PX = 24;
const LOCK_PX = 10;
const DISTANCE_PX = 80;
const FLICK_PX_PER_MS = 0.5;
const FLICK_MIN_PX = 30;
/** Двухпанельная раскладка (см. app.css): жест не нужен. */
const WIDE = '(min-width: 900px)';

/** Жест нужен в установленном PWA и на Android; в iOS Safari свой «назад» — не мешаем. */
function enabled(): boolean {
  if (window.matchMedia(WIDE).matches) return false;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  return standalone || /Android/i.test(navigator.userAgent);
}

const blocked = () => !!document.querySelector('dialog[open], [role="dialog"], [role="menu"]');

/**
 * Свайп от левого края вправо = кнопка «Назад» в шапке текущего экрана.
 * Экран едет за пальцем, при отпускании уезжает вправо.
 */
export function useEdgeSwipeBack(): void {
  useEffect(() => {
    let st: { x: number; y: number; t: number; mode: 'idle' | 'h'; pane: HTMLElement; id: number } | null = null;

    const findPane = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('.app[data-view="detail"] > .pane--room:not(.pane--placeholder)');
    const backButton = (pane: HTMLElement) => pane.querySelector<HTMLButtonElement>('.topbar button[aria-label^="Назад"]');

    const reset = (pane: HTMLElement, animate: boolean) => {
      pane.style.transition = animate ? 'transform 0.2s ease-out' : '';
      pane.style.transform = '';
      if (animate) window.setTimeout(() => { pane.style.transition = ''; }, 250);
    };

    const onStart = (e: TouchEvent) => {
      st = null;
      if (e.touches.length !== 1 || !enabled() || blocked()) return;
      const t = e.touches[0];
      if (t.clientX > EDGE_PX) return;
      const pane = findPane();
      if (!pane || !backButton(pane)) return;
      st = { x: t.clientX, y: t.clientY, t: e.timeStamp, mode: 'idle', pane, id: t.identifier };
    };

    const onMove = (e: TouchEvent) => {
      if (!st) return;
      const t = [...e.touches].find((x) => x.identifier === st!.id);
      if (!t) return;
      const dx = t.clientX - st.x;
      const dy = t.clientY - st.y;
      if (st.mode === 'idle') {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK_PX) return;
        if (dx > Math.abs(dy) * 1.2) {
          st.mode = 'h';
          st.pane.style.transition = '';
          st.pane.style.willChange = 'transform';
        } else {
          st = null; // вертикальная прокрутка
          return;
        }
      }
      if (e.cancelable) e.preventDefault();
      st.pane.style.transform = `translateX(${Math.max(0, dx)}px)`;
    };

    const onEnd = (e: TouchEvent) => {
      const s = st;
      st = null;
      if (!s || s.mode !== 'h') return;
      const t = [...e.changedTouches].find((x) => x.identifier === s.id);
      const dx = (t?.clientX ?? s.x) - s.x;
      const speed = dx / Math.max(1, e.timeStamp - s.t);
      s.pane.style.willChange = '';
      const go = e.type === 'touchend' && (dx >= DISTANCE_PX || (dx >= FLICK_MIN_PX && speed >= FLICK_PX_PER_MS));
      if (!go) {
        reset(s.pane, true);
        return;
      }
      const btn = backButton(s.pane);
      s.pane.style.transition = 'transform 0.18s ease-out';
      s.pane.style.transform = 'translateX(100%)';
      window.setTimeout(() => {
        btn?.click();
        // экран обычно уже заменён; если остался на месте (нет перехода) — вернём на место
        window.setTimeout(() => { if (s.pane.isConnected) reset(s.pane, false); }, 80);
      }, 170);
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, []);
}
