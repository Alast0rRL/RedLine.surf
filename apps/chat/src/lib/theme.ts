import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'theme';
const listeners = new Set<() => void>();

const isTheme = (v: unknown): v is Theme => v === 'light' || v === 'dark';

function readSaved(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return isTheme(v) ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function current(): Theme {
  const v = document.documentElement.dataset.theme;
  return isTheme(v) ? v : 'dark';
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0a0a0a' : '#ffffff');
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, current, () => 'dark');
}

export function toggleTheme() {
  const next: Theme = current() === 'dark' ? 'light' : 'dark';
  apply(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* хранилище недоступно — тема всё равно переключена */
  }
}

export type ThemeMode = Theme | 'system';

export function getThemeMode(): ThemeMode {
  return readSaved() ?? 'system';
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, getThemeMode, () => 'system');
}

export function setThemeMode(mode: ThemeMode) {
  try {
    if (mode === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* хранилище недоступно — тема всё равно переключена */
  }
  apply(mode === 'system' ? systemTheme() : mode);
}

export function initTheme() {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!readSaved()) apply(systemTheme());
  });
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === null) apply(readSaved() ?? systemTheme());
  });
}
