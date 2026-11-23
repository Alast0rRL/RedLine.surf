/** Кольцо фокуса при программном фокусе — только если последним вводом была клавиатура. */
let keyboard = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => { keyboard = true; }, true);
  window.addEventListener('pointerdown', () => { keyboard = false; }, true);
}

/** Фокус без кольца для мыши/касания; с клавиатуры — на первом элементе, как обычно. */
export function focusForInput(first: HTMLElement | null | undefined, container: HTMLElement | null | undefined): void {
  if (keyboard) {
    first?.focus({ preventScroll: true });
    return;
  }
  if (!container) return;
  if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
  container.focus({ preventScroll: true });
}
