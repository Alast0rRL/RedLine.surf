/**
 * Настройки приходят во время выполнения из /config.json — его генерирует
 * контейнер из .env (docker/config.sh), в разработке — public/config.json.
 * Так один и тот же билд работает с любым сервером, а в репозитории нет адресов.
 */
export interface AppConfig {
  /** Адрес homeserver для клиента, например https://matrix.example.org */
  homeserverUrl: string;
  /** server_name — домен в адресах пользователей (@name:server_name) */
  serverName: string;
  /** URL push-шлюза, как его видит homeserver (…/_matrix/push/v1/notify). Пусто — без web push */
  pushGatewayUrl: string;
  /** Публичный VAPID-ключ (base64url). Пусто — без web push */
  vapidPublicKey: string;
  /** Пользователи-боты: их сообщения рисуются как карточки бота */
  botUsers: string[];
  /** Кнопки звонков показываются только когда заданы адреса LiveKit */
  calls: boolean;
}

/** Мир: сервер семьи или отдельный сервер Minecraft (своя база, общей связи нет). */
export type Realm = 'family' | 'mc';
const REALM_KEY = 'rl.realm';

let base: AppConfig | null = null;
let mc: Pick<AppConfig, 'homeserverUrl' | 'serverName'> | null = null;
/** Ключи приложения Telegram (my.telegram.org). Нет — вкладки Telegram нет. */
let telegram: { apiId: number; apiHash: string } | null = null;
let realm: Realm = (() => {
  try {
    return localStorage.getItem(REALM_KEY) === 'mc' ? 'mc' : 'family';
  } catch {
    return 'family';
  }
})();

export function getRealm(): Realm {
  return realm === 'mc' && mc ? 'mc' : 'family';
}

export function hasMcRealm(): boolean {
  return !!mc;
}

/** Выбор мира до входа (по введённому номеру или нику); запоминается на устройстве. */
export function setRealm(r: Realm): void {
  realm = r;
  try {
    localStorage.setItem(REALM_KEY, r);
  } catch {
    /* приватный режим: до перезагрузки */
  }
}

/** Префикс API push-шлюза для текущего мира: '' или '/mc'. */
export function apiBase(): string {
  return getRealm() === 'mc' ? '/mc' : '';
}

/** Второй мир этого человека (для переключателя «Семья | Minecraft»). */
export function otherRealm(r: Realm = getRealm()): Realm {
  return r === 'mc' ? 'family' : 'mc';
}

/** Настройки конкретного мира (не обязательно текущего). */
export function realmConfig(r: Realm): AppConfig {
  if (!base) throw new Error('config not loaded');
  if (r === 'mc' && mc) return { ...base, ...mc, botUsers: [] };
  return base;
}

function current(): AppConfig {
  return realmConfig(getRealm());
}

export async function loadConfig(): Promise<AppConfig> {
  if (base) return current();
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config.json: HTTP ${res.status}`);
  const raw = (await res.json()) as Partial<AppConfig> & { mc?: Partial<AppConfig>; telegram?: { apiId?: number | string; apiHash?: string } };
  if (!raw.homeserverUrl || !raw.serverName) throw new Error('config.json: нужны homeserverUrl и serverName');
  base = {
    homeserverUrl: raw.homeserverUrl.replace(/\/+$/, ''),
    serverName: raw.serverName,
    pushGatewayUrl: raw.pushGatewayUrl ?? '',
    vapidPublicKey: raw.vapidPublicKey ?? '',
    botUsers: (raw.botUsers ?? []).filter(Boolean),
    calls: raw.calls === true,
  };
  mc = raw.mc?.homeserverUrl && raw.mc.serverName
    ? { homeserverUrl: raw.mc.homeserverUrl.replace(/\/+$/, ''), serverName: raw.mc.serverName }
    : null;
  const tgId = Number(raw.telegram?.apiId);
  telegram = tgId > 0 && raw.telegram?.apiHash ? { apiId: tgId, apiHash: raw.telegram.apiHash } : null;
  return current();
}

export function telegramConfig(): { apiId: number; apiHash: string } | null {
  return telegram;
}

/** Звонки включены на сервере: mc-мир наследует флаг основного config.json. */
export function callsEnabled(): boolean {
  return current().calls;
}

export function getConfig(): AppConfig {
  return current();
}
