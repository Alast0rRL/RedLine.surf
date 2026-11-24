// Сайт Redline. Каждый блок независим: если что-то одно упало (например, не загрузилась
// библиотека), остальное работает, а контент виден и без JS.
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const safely = (name, fn) => { try { fn(); } catch (e) { console.error(`[redline] ${name}:`, e); } };

  // --- Плавная прокрутка (Lenis) ---
  let lenis = null;
  safely('lenis', () => {
    if (reducedMotion || typeof window.Lenis !== 'function') return;
    lenis = new window.Lenis({
      duration: 1.2,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    });
    const raf = (time) => { lenis.raf(time); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
  });

  const scrollToTarget = (target) => {
    if (lenis) lenis.scrollTo(target, { offset: target === 0 ? 0 : -72 });
    else if (target === 0) window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
    else target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
  };

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const id = a.getAttribute('href').slice(1);
    const target = id === 'top' || id === '' ? 0 : document.getElementById(id);
    if (target === null) return;
    e.preventDefault();
    // ссылка из мобильного меню: сначала закрыть диалог, потом ехать
    const dlg = a.closest('dialog');
    if (dlg) closeDialog(dlg);
    scrollToTarget(target);
    history.replaceState(null, '', id && id !== 'top' ? `#${id}` : location.pathname);
  });

  // --- Свечение за курсором: rAF только пока догоняем мышь ---
  safely('glow', () => {
    const glow = $('#glow-overlay');
    if (!glow || reducedMotion || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    let dot = $('.glow-dot', glow);
    if (!dot) {
      dot = document.createElement('div');
      dot.className = 'glow-dot';
      const bright = document.createElement('div');
      bright.className = 'glow-dot__bright';
      dot.appendChild(bright);
      glow.appendChild(dot);
    }
    const interactive = 'a, button, summary, [data-copy]';
    let mx = 0, my = 0, cx = 0, cy = 0, scale = 1, targetScale = 1;
    let running = false, started = false;
    document.body.classList.add('glow-hidden');
    const render = () => { dot.style.transform = `translate3d(${cx}px, ${cy}px, 0) scale(${scale})`; };
    const tick = () => {
      cx += (mx - cx) * 0.15;
      cy += (my - cy) * 0.15;
      scale += (targetScale - scale) * 0.15;
      const moving = Math.abs(mx - cx) + Math.abs(my - cy) > 0.5;
      const scaling = Math.abs(targetScale - scale) > 0.003;
      if (!moving && !scaling) { cx = mx; cy = my; scale = targetScale; render(); running = false; return; }
      render();
      requestAnimationFrame(tick);
    };
    const kick = () => { if (!running) { running = true; requestAnimationFrame(tick); } };
    const show = () => document.body.classList.remove('glow-hidden');
    const hide = () => document.body.classList.add('glow-hidden');
    document.addEventListener('pointermove', (e) => {
      if (!started) { mx = cx = e.clientX; my = cy = e.clientY; started = true; render(); }
      else { mx = e.clientX; my = e.clientY; }
      show();
      const over = e.target instanceof Element && !!e.target.closest(interactive);
      document.body.classList.toggle('is-hovering', over);
      targetScale = over ? 1.25 : 1;
      kick();
    }, { passive: true });
    document.documentElement.addEventListener('pointerleave', hide);
    document.documentElement.addEventListener('pointerenter', () => { if (started) show(); });
    window.addEventListener('blur', hide);
    window.addEventListener('focus', () => { if (started) show(); });
  });

  // --- Появление блоков ---
  safely('reveal', () => {
    const els = $$('.reveal');
    if (!('IntersectionObserver' in window)) { els.forEach((el) => el.classList.add('active')); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) { entry.target.classList.add('active'); io.unobserve(entry.target); }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -5% 0px' });
    els.forEach((el) => io.observe(el));
  });

  // --- Тема ---
  safely('theme', () => {
    $$('[data-theme-toggle]').forEach((btn) => btn.addEventListener('click', () => {
      const dark = document.documentElement.classList.toggle('dark');
      try { localStorage.theme = dark ? 'dark' : 'light'; } catch (e) { /* приватный режим */ }
    }));
  });

  // --- Кнопка «наверх» ---
  safely('back-to-top', () => {
    const btn = $('#back-to-top');
    const hidden = ['opacity-0', 'translate-y-10', 'pointer-events-none'];
    let shown = false;
    const update = () => {
      const show = window.scrollY > 500;
      if (show === shown) return;
      shown = show;
      hidden.forEach((c) => btn.classList.toggle(c, !show));
    };
    window.addEventListener('scroll', update, { passive: true });
    update();
    btn.addEventListener('click', () => scrollToTarget(0));
  });

  // --- Онлайн сервера: раз в минуту, только пока вкладка видна ---
  safely('status', () => {
    const countEl = $('#online-count');
    const maxEl = $('#online-max');
    const dot = $('#status-dot');
    const setDot = (cls) => { dot.className = `w-2.5 h-2.5 rounded-full ${cls}`; };
    const show = (text) => {
      countEl.classList.remove('skeleton', 'text-transparent');
      countEl.classList.add('text-redline-red', 'font-bold');
      countEl.textContent = text;
    };
    let timer = null;
    const update = async () => {
      try {
        const res = await fetch('/api/status', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.online) {
          show(String(data.players));
          maxEl.textContent = String(data.max_players);
          setDot('bg-green-500 shadow-[0_0_10px_theme(colors.green.500)]');
        } else {
          show('OFF');
          maxEl.textContent = '—';
          setDot('bg-red-500');
        }
      } catch (e) {
        show('?');
        setDot('bg-gray-500');
      }
    };
    const schedule = () => {
      clearInterval(timer);
      if (document.visibilityState === 'visible') { update(); timer = setInterval(update, 60000); }
    };
    document.addEventListener('visibilitychange', schedule);
    schedule();
  });

  // --- Диалоги (<dialog>): Esc, фокус и затемнение — силами браузера ---
  function openDialog(dlg) {
    if (!dlg || dlg.open) return;
    dlg.showModal();
    lenis?.stop();
    document.documentElement.style.overflow = 'hidden';
  }
  function closeDialog(dlg) {
    if (dlg?.open) dlg.close();
  }
  $$('dialog').forEach((dlg) => {
    dlg.addEventListener('close', () => {
      if (!$('dialog[open]')) {
        lenis?.start();
        document.documentElement.style.overflow = '';
      }
    });
    // клик по затемнению вокруг окна закрывает его
    dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(dlg); });
  });

  // --- Копирование (IP, Discord) ---
  const toastEl = $('#toast');
  let toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const el = document.createElement('textarea');
      el.value = text;
      el.setAttribute('readonly', '');
      el.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand('copy');
      el.remove();
      return ok;
    }
  }
  function confettiBurst() {
    if (reducedMotion || typeof window.confetti !== 'function') return;
    const red = getComputedStyle(document.documentElement).getPropertyValue('--rl-red-500').trim() || '#C4001D';
    window.confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 }, colors: [red, '#ffffff'] });
  }

  document.addEventListener('click', async (e) => {
    const opener = e.target.closest('[data-open]');
    if (opener) { openDialog(document.getElementById(opener.dataset.open)); return; }

    const btn = e.target.closest('[data-copy], [data-close]');
    if (!btn) return;
    if (btn.hasAttribute('data-close') && btn.tagName !== 'A') closeDialog(btn.closest('dialog'));
    if (btn.dataset.copy) {
      const ok = await copy(btn.dataset.copy);
      toast(ok ? (btn.dataset.toast || 'IP скопирован!') : btn.dataset.copy);
      if (ok && btn.hasAttribute('data-confetti')) confettiBurst();
    }
  });

  // --- Галерея: бесконечная лента + просмотр ---
  safely('gallery', () => {
    const track = $('#gallery-track');
    if (!track) return;
    const sources = $$('.gallery-item img', track).map((img) => img.getAttribute('src'));
    const lightbox = $('#lightbox');
    const lbImg = $('#lightbox-img');
    const lbCurrent = $('#lb-current');
    let index = 0;
    let animating = false;
    const easing = 'transform 0.5s cubic-bezier(0.25, 1, 0.5, 1)';

    const step = () => {
      const first = track.firstElementChild;
      return first.offsetWidth + (parseFloat(getComputedStyle(track).columnGap) || 0);
    };
    function slide(dir) {
      if (animating || track.children.length < 2) return;
      animating = true;
      const move = step();
      if (dir === 'next') {
        track.style.transition = easing;
        track.style.transform = `translateX(-${move}px)`;
        setTimeout(() => {
          track.style.transition = 'none';
          track.appendChild(track.firstElementChild);
          track.style.transform = 'translateX(0)';
          animating = false;
        }, 500);
      } else {
        track.style.transition = 'none';
        track.prepend(track.lastElementChild);
        track.style.transform = `translateX(-${move}px)`;
        void track.offsetWidth;
        track.style.transition = easing;
        track.style.transform = 'translateX(0)';
        setTimeout(() => { animating = false; }, 500);
      }
    }
    $('#nextBtn').addEventListener('click', () => slide('next'));
    $('#prevBtn').addEventListener('click', () => slide('prev'));

    // свайп по ленте на телефоне
    let startX = null;
    let swipedAt = 0;
    track.addEventListener('pointerdown', (e) => { startX = e.clientX; }, { passive: true });
    track.addEventListener('pointerup', (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      startX = null;
      if (Math.abs(dx) > 40) { slide(dx < 0 ? 'next' : 'prev'); swipedAt = Date.now(); }
    }, { passive: true });

    // Фото грузятся через ретранслятор по секунде-две. Пока новое не готово, старое не показываем
    // (иначе счётчик бежит, а на экране «застывает» прежний кадр), соседей качаем заранее.
    const cache = new Map();
    const load = (i) => {
      const src = sources[(i + sources.length) % sources.length];
      if (!cache.has(src)) {
        const im = new Image();
        im.src = src;
        cache.set(src, im.decode().catch(() => {}));
      }
      return cache.get(src);
    };
    const lbSpinner = $('[data-lb-spinner]', lightbox);
    let token = 0;
    async function show(i) {
      index = (i + sources.length) % sources.length;
      const my = ++token;
      lbCurrent.textContent = String(index + 1);
      lbImg.style.opacity = '0';
      const spin = setTimeout(() => lbSpinner.classList.remove('hidden'), 200);
      await load(index);
      clearTimeout(spin);
      if (my !== token) return; // пока грузилось, уже листнули дальше
      lbSpinner.classList.add('hidden');
      lbImg.src = sources[index];
      lbImg.alt = `Фото ${index + 1} из ${sources.length}`;
      lbImg.style.opacity = '1';
      load(index + 1);
      load(index - 1);
    }
    const change = (delta) => show(index + delta);

    track.addEventListener('click', (e) => {
      const item = e.target.closest('.gallery-item');
      if (!item) return;
      if (Date.now() - swipedAt < 400) return; // это был свайп, а не клик
      show(Number(item.dataset.index));
      openDialog(lightbox);
    });
    $$('[data-lb]', lightbox).forEach((b) => b.addEventListener('click', () => change(b.dataset.lb === 'next' ? 1 : -1)));
    // клик мимо фото закрывает, по самому фото — нет
    $('[data-lb-backdrop]', lightbox).addEventListener('click', (e) => { if (e.target !== lbImg) closeDialog(lightbox); });
    lightbox.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') change(1);
      if (e.key === 'ArrowLeft') change(-1);
    });
  });
})();
