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
}

let config: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (config) return config;
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config.json: HTTP ${res.status}`);
  const raw = (await res.json()) as Partial<AppConfig>;
  if (!raw.homeserverUrl || !raw.serverName) throw new Error('config.json: нужны homeserverUrl и serverName');
  config = {
    homeserverUrl: raw.homeserverUrl.replace(/\/+$/, ''),
    serverName: raw.serverName,
    pushGatewayUrl: raw.pushGatewayUrl ?? '',
    vapidPublicKey: raw.vapidPublicKey ?? '',
    botUsers: (raw.botUsers ?? []).filter(Boolean),
  };
  return config;
}

export function getConfig(): AppConfig {
  if (!config) throw new Error('config not loaded');
  return config;
}
