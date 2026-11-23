import { useEffect } from 'react';
import { avatarColor, initials } from '@redline/ui';
import { useMediaUrl } from './useMediaUrl';

/** Цвета заглушек — те же, что у .rl-avatar[data-color] в @redline/ui. */
const COLORS = ['#C4001D', '#B4541A', '#8A6A00', '#2F7D32', '#00796B', '#1D5FC4', '#5E35B1', '#AD1457'];
const SIZE = 64;

function iconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]');
}

let defaultHref: string | null = null;
function setIcon(href: string | null) {
  const link = iconLink();
  if (!link) return;
  if (defaultHref === null) defaultHref = link.getAttribute('href');
  const next = href ?? defaultHref ?? '/icons/favicon.svg';
  link.type = href ? 'image/png' : 'image/svg+xml';
  if (link.getAttribute('href') !== next) link.setAttribute('href', next);
}

function roundRect(ctx: CanvasRenderingContext2D) {
  const r = SIZE * 0.22;
  ctx.beginPath();
  ctx.roundRect(0, 0, SIZE, SIZE, r);
  ctx.clip();
}

function drawInitials(name: string, seed: string): string {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d')!;
  roundRect(ctx);
  ctx.fillStyle = COLORS[Number(avatarColor(seed)) % COLORS.length] ?? COLORS[0];
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${SIZE * 0.42}px Montserrat, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials(name), SIZE / 2, SIZE / 2 + 2);
  return c.toDataURL('image/png');
}

function drawImage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = SIZE;
      const ctx = c.getContext('2d')!;
      roundRect(ctx);
      // как object-fit: cover
      const s = Math.max(SIZE / img.width, SIZE / img.height);
      const w = img.width * s, h = img.height * s;
      ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Значок вкладки: аватарка открытого чата (или собеседника), без чата — значок Redline.
 * Передай null, чтобы вернуть значок Redline.
 */
export function useTabIcon(chat: { name: string; seed: string; mxc: string | null } | null) {
  const url = useMediaUrl(chat?.mxc ? { url: chat.mxc } : null, { width: SIZE, height: SIZE });
  const name = chat?.name ?? null;
  const seed = chat?.seed ?? null;
  const hasImage = !!chat?.mxc;

  useEffect(() => {
    if (name === null || seed === null) {
      setIcon(null);
      return;
    }
    let alive = true;
    const fallback = () => alive && setIcon(drawInitials(name, seed));
    if (url && url !== 'error') drawImage(url).then((d) => alive && setIcon(d), fallback);
    else if (!hasImage || url === 'error') fallback();
    // иначе картинка ещё грузится — дождёмся её, без мигания буквами
    return () => {
      alive = false;
    };
  }, [name, seed, url, hasImage]);

  // уходим из чата — значок Redline
  useEffect(() => () => setIcon(null), []);
}
