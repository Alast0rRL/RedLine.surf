/**
 * Модалка на нативном <dialog class="rl-modal">: фокус-ловушка, Esc и
 * инертный фон даёт браузер. Здесь — анимация закрытия и закрытие по фону.
 *
 *   openModal(dialog)   / closeModal(dialog, returnValue?)
 *   <button data-rl-close> внутри диалога закрывает его.
 */

const enhanced = new WeakSet();
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function enhance(dialog) {
  if (enhanced.has(dialog)) return;
  enhanced.add(dialog);

  // Esc: вместо мгновенного закрытия — с анимацией
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeModal(dialog);
  });

  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-rl-close]')) {
      closeModal(dialog);
      return;
    }
    // клик по ::backdrop приходит с target === dialog и вне его прямоугольника
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) closeModal(dialog);
  });
}

/** @param {HTMLDialogElement} dialog */
export function openModal(dialog) {
  enhance(dialog);
  dialog.removeAttribute('data-closing');
  if (!dialog.open) dialog.showModal();
}

/**
 * @param {HTMLDialogElement} dialog
 * @param {string} [returnValue]
 * @returns {Promise<void>} резолвится, когда диалог закрыт
 */
export function closeModal(dialog, returnValue) {
  if (!dialog.open || dialog.hasAttribute('data-closing')) return Promise.resolve();
  if (reducedMotion()) {
    dialog.close(returnValue);
    return Promise.resolve();
  }
  dialog.setAttribute('data-closing', '');
  return new Promise((resolve) => {
    const done = () => {
      dialog.removeAttribute('data-closing');
      dialog.close(returnValue);
      resolve();
    };
    dialog.addEventListener('animationend', (e) => { if (e.target === dialog) done(); }, { once: true });
    // страховка, если анимацию отключили стилями
    setTimeout(() => dialog.hasAttribute('data-closing') && done(), 400);
  });
}
