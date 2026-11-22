/**
 * <rl-red-lines> — фирменные красные линии Redline (web component, light DOM).
 *
 * Атрибуты:
 *   lines       количество линий (плотность), 1..24, по умолчанию 2
 *   speed       множитель скорости, 0.1..5, по умолчанию 1 (цикл 12s / speed)
 *   brightness  яркость 0..1, по умолчанию 1
 *   disabled    выключить эффект
 *   no-intro    без въезда — сразу «дыхание» (для фонов, где эффект живёт постоянно)
 *
 * Анимация целиком на CSS (red-lines.css): браузер считает её на композиторе,
 * JS не крутит кадры, поэтому отдельный лимит FPS не нужен. JS только
 * раскладывает линии и ставит паузу, когда вкладка скрыта или элемент вне экрана.
 * prefers-reduced-motion обрабатывается в CSS — линии стоят на месте.
 */

const BASE_CYCLE_S = 12;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const num = (v, fallback) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Раскладка линий. Для двух линий воспроизводит исходный эффект сайта:
 * 10% ↔ 25% и 90% ↔ 75%, въезд с -50% и 150%.
 * @param {number} count
 * @returns {{x:number, to:number, from:number, cycle:number, phase:number}[]}
 */
export function layoutLines(count) {
  const n = clamp(Math.round(count), 1, 24);
  if (n === 1) return [{ x: 10, to: 25, from: -50, cycle: 1, phase: 0 }];
  const step = 80 / (n - 1);
  const amp = n === 2 ? 15 : Math.min(15, step * 0.6);
  return Array.from({ length: n }, (_, i) => {
    const x = 10 + step * i;
    const dir = i % 2 === 0 ? 1 : -1;
    return {
      x,
      to: x + amp * dir,
      from: x < 50 ? x - 60 : x + 60,
      // при n > 2 рассинхронизируем линии, чтобы не двигались строем
      cycle: n === 2 ? 1 : 1 + ((i * 0.37) % 0.5),
      phase: n === 2 ? 0 : (i * 0.61) % 1,
    };
  });
}

const instances = new Set();
let visibilityBound = false;

function syncVisibility() {
  for (const el of instances) el._updatePaused();
}

export class RedLines extends HTMLElement {
  static observedAttributes = ['lines', 'speed', 'brightness'];

  constructor() {
    super();
    this._inView = true;
    this._io = null;
    this._layout = [];
  }

  connectedCallback() {
    instances.add(this);
    if (!visibilityBound) {
      document.addEventListener('visibilitychange', syncVisibility);
      visibilityBound = true;
    }
    if ('IntersectionObserver' in window) {
      this._io = new IntersectionObserver((entries) => {
        this._inView = entries[entries.length - 1].isIntersecting;
        this._updatePaused();
      });
      this._io.observe(this);
    }
    this.setAttribute('aria-hidden', 'true');
    this._render();
    this._applyBrightness();
    this._updatePaused();
  }

  disconnectedCallback() {
    instances.delete(this);
    this._io?.disconnect();
    this._io = null;
  }

  attributeChangedCallback(name) {
    if (!this.isConnected) return;
    if (name === 'brightness') this._applyBrightness();
    else if (name === 'speed') this._applySpeed();
    else this._render();
  }

  get lines() { return clamp(Math.round(num(this.getAttribute('lines'), 2)), 1, 24); }
  set lines(v) { this.setAttribute('lines', String(v)); }

  get speed() { return clamp(num(this.getAttribute('speed'), 1), 0.1, 5); }
  set speed(v) { this.setAttribute('speed', String(v)); }

  get brightness() { return clamp(num(this.getAttribute('brightness'), 1), 0, 1); }
  set brightness(v) { this.setAttribute('brightness', String(v)); }

  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { this.toggleAttribute('disabled', !!v); }

  /** Проиграть въезд заново. */
  replay() {
    this._render();
  }

  _render() {
    this._layout = layoutLines(this.lines);
    const frag = document.createDocumentFragment();
    for (const l of this._layout) {
      const line = document.createElement('span');
      line.className = 'rl-line';
      line.style.setProperty('--x', `${l.x}%`);
      line.style.setProperty('--x-to', `${l.to}%`);
      line.style.setProperty('--x-from', `${l.from}%`);
      frag.append(line);
    }
    this.replaceChildren(frag);
    this._applySpeed();
  }

  // Меняет только длительность — линии не перерисовываются и не въезжают заново
  _applySpeed() {
    const cycle = BASE_CYCLE_S / this.speed;
    this._layout.forEach((l, i) => {
      const line = this.children[i];
      line.style.setProperty('--cycle', `${(cycle * l.cycle).toFixed(3)}s`);
      line.style.setProperty('--phase', `${(-cycle * l.cycle * l.phase).toFixed(3)}s`);
    });
  }

  _applyBrightness() {
    if (this.hasAttribute('brightness')) {
      this.style.setProperty('--rl-lines-brightness', String(this.brightness));
    } else {
      this.style.removeProperty('--rl-lines-brightness');
    }
  }

  _updatePaused() {
    this.toggleAttribute('data-paused', document.hidden || !this._inView);
  }
}

export function defineRedLines(tag = 'rl-red-lines') {
  if (!customElements.get(tag)) customElements.define(tag, RedLines);
}

defineRedLines();
