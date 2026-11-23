import { useCallback, useEffect, useRef } from 'react';

/**
 * Оверлеи закрываются системной кнопкой «назад». Все открытые оверлеи лежат в одном стеке,
 * у каждого одна запись в истории. popstate закрывает только верхний; закрытие через UI
 * делает history.back() и помечает этот popstate как «свой» — остальные оверлеи его игнорируют.
 */
interface Entry {
  close: () => void;
  removed: boolean;
  stale: boolean;
}

const stack: Entry[] = [];
/** Ожидаемые «свои» popstate; элемент — что выполнить после него. */
const expected: Array<(() => void) | null> = [];
let listening = false;

function onPop() {
  if (expected.length) {
    expected.shift()?.();
    return;
  }
  const top = stack.pop();
  if (!top) return;
  top.removed = true;
  if (!top.stale) top.close();
}

function register(entry: Entry) {
  if (!listening) {
    window.addEventListener('popstate', onPop);
    listening = true;
  }
  history.pushState({ ...(history.state ?? {}), rlOverlay: true }, '');
  stack.push(entry);
}

/** Убрать запись из истории без вызова close; after — после того как история сдвинулась. */
function release(entry: Entry, after?: () => void) {
  if (entry.removed) {
    after?.();
    return;
  }
  const i = stack.indexOf(entry);
  if (i === stack.length - 1 && !entry.stale) {
    stack.pop();
    entry.removed = true;
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      after?.();
    };
    expected.push(once);
    history.back();
    // popstate мог не прийти (нет записи для возврата) — не теряем действие
    if (after) setTimeout(once, 400);
  } else {
    // запись не на вершине истории: пропустим её молча, когда до неё дойдёт popstate
    entry.stale = true;
    after?.();
  }
}

export function useBackClose(onClose: () => void): (after?: unknown) => void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const entryRef = useRef<Entry | null>(null);

  useEffect(() => {
    const entry: Entry = { close: () => closeRef.current(), removed: false, stale: false };
    entryRef.current = entry;
    register(entry);
    return () => {
      // размонтирование без popstate (смена маршрута, ключа, родителя)
      if (!entry.removed) release(entry);
    };
  }, []);

  return useCallback((after?: unknown) => {
    const fn = typeof after === 'function' ? (after as () => void) : undefined;
    const entry = entryRef.current;
    if (!entry) {
      closeRef.current();
      fn?.();
      return;
    }
    release(entry, fn);
    closeRef.current();
  }, []);
}
