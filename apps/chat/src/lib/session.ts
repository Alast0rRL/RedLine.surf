/** Сохранённая сессия Matrix. Токен лежит в localStorage — как у Element Web. */
export interface StoredSession {
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
}

const KEY = 'rl.session';

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    return s.accessToken && s.userId && s.deviceId && s.baseUrl ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession(): void {
  localStorage.removeItem(KEY);
}
