# Деплой Redline Chat

```
браузер / PWA ──https──▶ обратный прокси (Caddy, TLS)
                           ├─ chat.<домен>   → 127.0.0.1:8090  chat          nginx + статика клиента
                           └─ matrix.<домен> → 127.0.0.1:8008  continuwuity  homeserver
continuwuity ──http (внутренняя сеть 10.89.0.0/24)──▶ push:8080 ──Web Push──▶ FCM / Mozilla / Apple
```

| Сервис | Что это |
|---|---|
| `continuwuity` | Matrix homeserver (Rust, RocksDB). Регистрация только по приглашению, федерации нет. |
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

Приглашать ещё некому, поэтому первый аккаунт создаётся командой при старте (`--execute`).
Первый пользователь становится администратором сам. `users make-user-admin` следом не добавлять:
команда падает и останавливает сервер.

```bash
umask 077; openssl rand -base64 24 | tr -d '/+=' > ~/redline-admin-password
# у образа нет ENTRYPOINT — бинарник указываем явно
docker compose run -d --name rl-bootstrap continuwuity /sbin/conduwuit --execute "users create admin $(cat ~/redline-admin-password)"
sleep 20; docker stop rl-bootstrap; docker rm rl-bootstrap
docker compose up -d
```

Сервер печатает этот пароль в лог `rl-bootstrap`, поэтому считать его временным: войти как `admin`,
сразу **Настройки → Сменить пароль**, затем **Настройки → Шифрование → Задать фразу**.

### Остальные аккаунты

Команды не нужны:

1. Администратор: **Настройки → Пригласить и управлять → Создать ссылку**, отправить ссылку или показать QR.
2. Человек открывает ссылку, задаёт имя, логин, пароль и фразу восстановления и попадает в чат «Семья».
3. На новом устройстве он входит с паролем и вводит фразу, чтобы прочитать старую переписку.
4. **Настройки → Уведомления → Включить.** На iPhone push работает только у приложения,
   добавленного на экран «Домой» (Safari → Поделиться → На экран «Домой»), iOS 16.4+.

Что важно знать:

- Ссылка одноразовая, это проверяет сервер. Семидневного срока у сервера нет: старые ссылки отзывает
  клиент администратора, когда тот открывает приложение.
- Сброс пароля: **Пригласить и управлять → Сбросить пароль**. Фразу он не восстанавливает.
- Короткую фразу может подобрать тот, у кого есть доступ к серверу. Лучше 3–4 случайных слова.
- В `#family` может войти любой аккаунт этого сервера. Поэтому не включать федерацию и открытую регистрацию.
- Аккаунты, созданные раньше, в «Семью» сами не попадают: их нужно пригласить в комнату.

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

Бот — обычный аккаунт (создать по приглашению), его ID в `BOT_USERS`. Клиент показывает метку
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
docker compose restart continuwuity   # если менялся continuwuity.toml: up -d этого не замечает
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
