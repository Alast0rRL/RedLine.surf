/**
 * Тосты: toast('Скопировано!') / toast('Ошибка сети', { variant: 'error' }).
 * Контейнер .rl-toaster создаётся сам, объявляется скринридерам (aria-live).
 */

const MAX_VISIBLE = 3;
let toaster = null;

function getToaster() {
  if (toaster?.isConnected) return toaster;
  toaster = document.createElement('div');
  toaster.className = 'rl-toaster';
  toaster.setAttribute('role', 'status');
  toaster.setAttribute('aria-live', 'polite');
  document.body.append(toaster);
  return toaster;
}

/**
 * @param {string} message
 * @param {{variant?: 'default'|'success'|'error', duration?: number}} [options]
 * @returns {() => void} закрыть тост раньше времени
 */
export function toast(message, { variant = 'default', duration = 3000 } = {}) {
  const root = getToaster();
  const el = document.createElement('div');
  el.className = 'rl-toast';
  el.dataset.variant = variant;
  el.textContent = message;
  root.append(el);

  while (root.children.length > MAX_VISIBLE) root.firstElementChild.remove();

  // следующий кадр — чтобы сработал transition появления
  requestAnimationFrame(() => requestAnimationFrame(() => { el.dataset.state = 'open'; }));

  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    if (el.dataset.state === 'closed') return;
    el.dataset.state = 'closed';
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 600);
  };
  if (duration > 0) timer = setTimeout(dismiss, duration);
  el.addEventListener('click', dismiss);
  return dismiss;
}
