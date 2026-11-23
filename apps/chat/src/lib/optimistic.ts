/** Мгновенные (оптимистичные) правки интерфейса: подписчики перерисовываются сразу, без ожидания сервера. */
const bus = new EventTarget();
const NAME = 'rl:optimistic';

export function emitOptimistic(): void {
  bus.dispatchEvent(new Event(NAME));
}

export function onOptimistic(fn: () => void): () => void {
  bus.addEventListener(NAME, fn);
  return () => bus.removeEventListener(NAME, fn);
}
