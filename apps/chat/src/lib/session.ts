/** Сохранённая сессия Matrix. Токен лежит в localStorage — как у Element Web. */
export interface StoredSession {
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
}

import { getRealm, type Realm } from '../config';

/** У каждого мира своя сессия: семья — прежний ключ, Minecraft — с суффиксом. */
const key = (r: Realm) => (r === 'mc' ? 'rl.session.mc' : 'rl.session');

export function loadSession(r: Realm = getRealm()): StoredSession | null {
  try {
    const raw = localStorage.getItem(key(r));
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    return s.accessToken && s.userId && s.deviceId && s.baseUrl ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession, r: Realm = getRealm()): void {
  localStorage.setItem(key(r), JSON.stringify(s));
}

export function clearSession(r: Realm = getRealm()): void {
  localStorage.removeItem(key(r));
}
