# Деплой Redline Chat

```
браузер / PWA ──https──▶ обратный прокси (Caddy, TLS)
                           ├─ chat.<домен>   → 127.0.0.1:8090  chat          nginx + статика клиента
                           └─ matrix.<домен> → 127.0.0.1:8008  continuwuity  homeserver
continuwuity ──http (внутренняя сеть 10.89.0.0/24)──▶ push:8080 ──Web Push──▶ FCM / Mozilla / Apple
```

| Сервис | Что это |
|---|---|
| `continuwuity` | Matrix homeserver (Rust, RocksDB). Регистрация и федерация выключены. |
| `push` | свой push gateway (`apps/push-gateway`): Matrix Push API → Web Push (VAPID). |
| `chat` | клиент (`apps/chat`): nginx, строгий CSP, `config.json` собирается из `.env` при старте. |

## Первый запуск

```bash
cd deploy
cp .env.example .env
pnpm --filter @redline/push-gateway vapid   # → VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY в .env
# заполнить SERVER_NAME, HOMESERVER_URL, CONTINUWUITY_VERSION, BOT_USERS
docker compose build
```

`SERVER_NAME` — часть всех Matrix ID (`@mama:redline.surf`); после первого запуска его не поменять.

### Первый администратор

Регистрация закрыта полностью, поэтому первый аккаунт создаётся админ-командой при старте
(`--execute`). Пароль генерируется на сервере и сразу ложится в файл, в логи и терминал не попадает:

```bash
umask 077; openssl rand -base64 24 | tr -d '/+=' > ~/redline-admin-password
# у образа нет ENTRYPOINT — бинарник указываем явно; server shutdown — выйти после команд
docker compose run -d --name rl-bootstrap continuwuity /sbin/conduwuit   --execute "users create admin $(cat ~/redline-admin-password)"   --execute "users make-user-admin @admin:${SERVER_NAME}"   --execute "server shutdown"
sleep 20; docker logs rl-bootstrap 2>&1 | grep -i -E "admin privileges|failed"; docker rm -f rl-bootstrap
docker compose up -d
```

Войти в клиент как `admin` — там будет комната `#admins` с консолью сервера.

### Остальные аккаунты

В комнате `#admins` отправить (имя — только латиница, цифры, `._=-`):

```
!admin users create mama            # пароль сгенерируется и придёт ответом
!admin users create papa ПарольПапы
!admin users make-user-admin @papa:redline.surf
!admin users reset-password mama
```

Пароль передать человеку лично. Дальше он входит на `https://chat.<домен>` и:

1. **Настройки → Шифрование → Создать ключ** — сохранить ключ восстановления. Без него
   переписку не прочитать на новом телефоне.
2. **Настройки → Уведомления → Включить.** На iPhone push работает только у приложения,
   добавленного на экран «Домой» (Safari → Поделиться → На экран «Домой»), iOS 16.4+.

## Обратный прокси

- [`proxy/Caddyfile.snippet`](proxy/Caddyfile.snippet) — сайты `matrix.` и `chat.`.
- [`proxy/haproxy.snippet`](proxy/haproxy.snippet) — если 443 приходит через SNI-роутер.
- DNS: `A`-записи `matrix.<домен>` и `chat.<домен>` на публичный адрес входа.
- Ни один контейнер не слушает внешний интерфейс: только `127.0.0.1`.

## Push

Homeserver зовёт шлюз по внутреннему адресу `http://push:8080/_matrix/push/v1/notify` — этот URL
клиент записывает в pusher. Поэтому в `continuwuity.toml` из запрета на исходящие запросы в частные
сети вырезана ровно подсеть compose `10.89.0.0/24` (остальные частные адреса закрыты — защита от SSRF).
Если подсеть занята — поменять её в обоих файлах.

Шлюз сам ходит наружу в FCM (Chrome/Android), Mozilla, Apple и Windows. Если оттуда они недоступны —
`PUSH_PROXY=http://…` в `.env`. В зашифрованных комнатах сервер не видит текст: уведомление
«Новое сообщение» с именем отправителя и чата.

## Боты (Мари)

Бот — обычный аккаунт (`!admin users create mari`), его ID в `BOT_USERS`. Клиент показывает метку
«бот» и рисует его сообщения карточкой с красной кромкой. Рекомендуемый формат — `m.notice`
с HTML:

```json
{
  "msgtype": "m.notice",
  "body": "Погода: +12, облачно",
  "format": "org.matrix.custom.html",
  "formatted_body": "<h3>Погода</h3><p><b>+12°C</b>, облачно</p><ul><li>Утро: +8</li></ul>"
}
```

Разрешены теги из спецификации Matrix (`h1–h6 p div span br b strong i em u s del strike code pre
blockquote ul ol li a table thead tbody tr th td caption hr details summary font sub sup`) и атрибуты
`data-mx-color`/`data-mx-bg-color`/`data-mx-spoiler`; `class` — только `language-*` у `<code>`. Скрипты,
стили, картинки и обработчики событий вырезаются (список — `apps/chat/src/lib/html.ts`). `m.notice` не вызывает push у людей — бот,
которому нужно уведомление, шлёт `m.text`. Для своих типов сообщений в клиенте есть
`registerMessageRenderer` (`apps/chat/src/bots/registry.ts`).

## Обновление

```bash
git pull && cd deploy && docker compose up -d --build
```

Клиент — PWA: после деплоя открытые вкладки покажут «Доступно обновление».
`sw.js`, `index.html` и `config.json` отдаются с `no-cache`, ассеты с хешем — навсегда.

## Бэкап

Всё состояние сервера — том `continuwuity-data` (RocksDB). Копировать при остановленном контейнере:

```bash
docker compose stop continuwuity
docker run --rm -v redline-chat_continuwuity-data:/d -v "$PWD":/b alpine tar czf /b/continuwuity-$(date +%F).tgz -C /d .
docker compose start continuwuity
```
