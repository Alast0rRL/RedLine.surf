import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getMediaUrl } from '../lib/media';
import { saveUrl, type RoomMediaItem } from '../lib/roomMedia';
import { useMediaUrl } from '../hooks/useMediaUrl';
import { useBackClose } from '../hooks/useBackClose';
import { useClient } from '../state/MatrixContext';
import { Button, Icon, toast } from './ui';
import '../styles/viewer.css';

const MAX_SCALE = 6;
const DOUBLE_TAP_SCALE = 2.5;

interface Tf {
  s: number;
  x: number;
  y: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Полноэкранный просмотр фото: pinch/double-tap/колесо, свайп вниз — закрыть, влево-вправо — соседние. */
export function MediaViewer({
  items,
  index: startIndex,
  onClose,
}: {
  items: RoomMediaItem[];
  index: number;
  onClose: () => void;
}) {
  const client = useClient();
  const [index, setIndex] = useState(Math.min(Math.max(0, startIndex), items.length - 1));
  const [fade, setFade] = useState(1);
  const dismiss = useBackClose(onClose);
  const item = items[index];

  const go = useCallback(
    (d: number) => setIndex((i) => clamp(i + d, 0, items.length - 1)),
    [items.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      } else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss, go]);

  const save = async () => {
    if (!item) return;
    try {
      saveUrl(await getMediaUrl(client, item.src), item.name);
    } catch (e) {
      console.warn('save failed', e);
      toast('Не удалось сохранить фото', { variant: 'error' });
    }
  };

  if (!item) return null;
  return createPortal(
    // порталы пропускают события вверх по дереву React — не даём сообщению принять их за долгое нажатие
    <div
      className="mviewer"
      role="dialog"
      aria-modal="true"
      aria-label="Фото"
      style={{ ['--mv-fade' as string]: fade }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onPointerCancel={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <div className="mviewer__top">
        <Button variant="ghost" onClick={() => void save()} aria-label="Сохранить фото">Сохранить</Button>
        {items.length > 1 && <span className="mviewer__count">{index + 1} / {items.length}</span>}
        <button type="button" className="rl-btn rl-btn--icon rl-btn--ghost" aria-label="Закрыть" onClick={dismiss}>
          <Icon name="close" />
        </button>
      </div>
      <Slide
        key={item.id || index}
        item={item}
        onFade={setFade}
        onDismiss={dismiss}
        onStep={go}
        canPrev={index > 0}
        canNext={index < items.length - 1}
      />
    </div>,
    document.body,
  );
}

function Slide({
  item,
  onFade,
  onDismiss,
  onStep,
  canPrev,
  canNext,
}: {
  item: RoomMediaItem;
  onFade: (v: number) => void;
  onDismiss: () => void;
  onStep: (d: number) => void;
  canPrev: boolean;
  canNext: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  return <SlideLoader key={attempt} item={item} onRetry={() => setAttempt((a) => a + 1)} onFade={onFade} onDismiss={onDismiss} onStep={onStep} canPrev={canPrev} canNext={canNext} />;
}

function SlideLoader({
  item,
  onRetry,
  ...rest
}: {
  item: RoomMediaItem;
  onRetry: () => void;
  onFade: (v: number) => void;
  onDismiss: () => void;
  onStep: (d: number) => void;
  canPrev: boolean;
  canNext: boolean;
}) {
  const url = useMediaUrl(item.src);
  if (url === 'error') {
    return (
      <div className="mviewer__state">
        <p>Не удалось открыть фото</p>
        <Button variant="outline" onClick={onRetry}>Повторить</Button>
      </div>
    );
  }
  if (!url) {
    return (
      <div className="mviewer__state">
        <span className="rl-spinner" aria-label="Загрузка" />
      </div>
    );
  }
  return <Stage url={url} alt={item.name} {...rest} />;
}

function Stage({
  url,
  alt,
  onFade,
  onDismiss,
  onStep,
  canPrev,
  canNext,
}: {
  url: string;
  alt: string;
  onFade: (v: number) => void;
  onDismiss: () => void;
  onStep: (d: number) => void;
  canPrev: boolean;
  canNext: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [tf, setTf] = useState<Tf>({ s: 1, x: 0, y: 0 });
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [settling, setSettling] = useState(true);
  const tfRef = useRef(tf);
  tfRef.current = tf;

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const g = useRef({
    mode: 'none' as 'none' | 'pan' | 'swipe' | 'pinch',
    axis: null as 'x' | 'y' | null,
    sx: 0, sy: 0, t0: 0, moved: 0,
    base: { s: 1, x: 0, y: 0 },
    dist0: 1, mid0: { x: 0, y: 0 },
    lastTap: { t: 0, x: 0, y: 0 },
  });

  const bounds = (s: number) => {
    const b = box.current;
    const i = img.current;
    if (!b || !i) return { mx: 0, my: 0 };
    return {
      mx: Math.max(0, (i.offsetWidth * s - b.clientWidth) / 2),
      my: Math.max(0, (i.offsetHeight * s - b.clientHeight) / 2),
    };
  };

  const apply = (s: number, x: number, y: number) => {
    const ns = clamp(s, 1, MAX_SCALE);
    const { mx, my } = bounds(ns);
    setTf({ s: ns, x: ns === 1 ? 0 : clamp(x, -mx, mx), y: ns === 1 ? 0 : clamp(y, -my, my) });
  };

  /** Масштаб с неподвижной точкой (cx, cy) — в координатах экрана. */
  const zoomAt = (ns: number, cx: number, cy: number, from: Tf) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const px = cx - (r.left + r.width / 2);
    const py = cy - (r.top + r.height / 2);
    const k = clamp(ns, 1, MAX_SCALE) / from.s;
    apply(from.s * k, px - (px - from.x) * k, py - (py - from.y) * k);
  };

  // колесо мыши: нужен не-passive обработчик
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setSettling(false);
      const cur = tfRef.current;
      zoomAt(cur.s * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY, cur);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    const st = g.current;
    st.mode = 'pinch';
    st.dist0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    st.mid0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    st.base = tfRef.current;
  };

  const startSingle = (x: number, y: number) => {
    const st = g.current;
    st.sx = x;
    st.sy = y;
    st.t0 = Date.now();
    st.moved = 0;
    st.axis = null;
    st.base = tfRef.current;
    st.mode = tfRef.current.s > 1 ? 'pan' : 'swipe';
  };

  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setSettling(false);
    if (pointers.current.size === 2) {
      setDrag(null);
      onFade(1);
      startPinch();
    } else if (pointers.current.size === 1) startSingle(e.clientX, e.clientY);
  };

  const onMove = (e: React.PointerEvent) => {
    const p = pointers.current.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const st = g.current;
    if (st.mode === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      const ns = clamp(st.base.s * (dist / st.dist0), 1, MAX_SCALE);
      const k = ns / st.base.s;
      const px = st.mid0.x - (r.left + r.width / 2);
      const py = st.mid0.y - (r.top + r.height / 2);
      apply(ns, mid.x - (r.left + r.width / 2) - (px - st.base.x) * k, mid.y - (r.top + r.height / 2) - (py - st.base.y) * k);
      return;
    }
    const dx = e.clientX - st.sx;
    const dy = e.clientY - st.sy;
    st.moved = Math.max(st.moved, Math.hypot(dx, dy));
    if (st.mode === 'pan') {
      apply(st.base.s, st.base.x + dx, st.base.y + dy);
    } else if (st.mode === 'swipe') {
      if (!st.axis && st.moved > 10) st.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
      if (st.axis === 'y') {
        setDrag({ x: 0, y: dy });
        onFade(clamp(1 - Math.abs(dy) / 400, 0.2, 1));
      } else if (st.axis === 'x') setDrag({ x: dx, y: 0 });
    }
  };

  const onUp = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const st = g.current;
    if (st.mode === 'pinch') {
      if (pointers.current.size === 1) {
        const [only] = [...pointers.current.values()];
        startSingle(only.x, only.y);
      } else {
        st.mode = 'none';
      }
      if (tfRef.current.s < 1.03) apply(1, 0, 0);
      return;
    }
    if (st.mode === 'none') return;
    const dx = e.clientX - st.sx;
    const dy = e.clientY - st.sy;
    const dt = Date.now() - st.t0;
    const wasMode = st.mode;
    st.mode = 'none';
    setSettling(true);

    // касание без движения: двойной тап — зум
    if (st.moved < 10 && dt < 350) {
      const now = Date.now();
      const lt = st.lastTap;
      if (now - lt.t < 320 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 30) {
        const cur = tfRef.current;
        if (cur.s > 1.05) apply(1, 0, 0);
        else zoomAt(DOUBLE_TAP_SCALE, e.clientX, e.clientY, cur);
        st.lastTap = { t: 0, x: 0, y: 0 };
      } else st.lastTap = { t: now, x: e.clientX, y: e.clientY };
      setDrag(null);
      return;
    }

    if (wasMode === 'swipe') {
      if (st.axis === 'y' && (Math.abs(dy) > 110 || (Math.abs(dy) > 50 && dt < 250 && dy > 0))) {
        onDismiss();
        return;
      }
      if (st.axis === 'x' && Math.abs(dx) > 60) {
        if (dx < 0 && canNext) onStep(1);
        else if (dx > 0 && canPrev) onStep(-1);
      }
      setDrag(null);
      onFade(1);
    }
  };

  const onCancel = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      g.current.mode = 'none';
      setDrag(null);
      onFade(1);
      setSettling(true);
    }
  };

  const tx = tf.x + (drag?.x ?? 0);
  const ty = tf.y + (drag?.y ?? 0);
  return (
    <div
      ref={box}
      className="mviewer__stage"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onDoubleClick={(e) => e.preventDefault()}
    >
      <img
        ref={img}
        src={url}
        alt={alt}
        draggable={false}
        className={settling ? 'is-settling' : undefined}
        style={{ transform: `translate3d(${tx}px, ${ty}px, 0) scale(${tf.s})` }}
      />
    </div>
  );
}
