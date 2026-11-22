# Redline

Монорепо домашнего сервера [redline.surf](https://redline.surf).

```
apps/site/            сайт Minecraft-сервера (FastAPI + Jinja + Tailwind CDN)
apps/chat/            семейный мессенджер — PWA-клиент Matrix (React + matrix-js-sdk)
apps/push-gateway/    push-шлюз Matrix → Web Push
packages/redline-ui/  дизайн-система: токены, красные линии, компоненты
deploy/               docker-compose: Continuwuity + push-шлюз + клиент
```

## Сайт

```bash
python -m venv .venv
.venv/bin/pip install -r apps/site/requirements.txt   # Windows: .venv\Scripts\pip
.venv/bin/uvicorn app.main:app --app-dir apps/site --port 8000
```

Сайт отдаёт `packages/redline-ui/src` по пути `/ui`. Если пакет лежит в другом месте
(например, в Docker-образе) — задай `REDLINE_UI_DIR`. Базу можно переопределить через `DATABASE_URL`.

## Чат

```bash
pnpm install
cp apps/chat/public/config.example.json apps/chat/public/config.json   # адрес своего homeserver
pnpm --filter @redline/chat dev      # http://localhost:5173
pnpm --filter @redline/chat build    # typecheck + сборка в apps/chat/dist
```

Что умеет: вход по логину и паролю (регистрации нет), список чатов с непрочитанными, личные и
групповые чаты, текст и фото со статусом отправки, голосовые (удержание — запись, влево — отмена,
вверх — зафиксировать; Ogg/Opus, совместимы с Element), E2E-шифрование (rust-crypto, ключ
восстановления), push-уведомления и бейдж на иконке, сообщения ботов (`m.notice` + HTML) карточкой.
Звонков нет.

Развёртывание — [deploy/README.md](deploy/README.md).

## Дизайн-система

```bash
pnpm demo   # http://127.0.0.1:5180/ — все компоненты и живые настройки линий
```

Подключение без сборки:

```html
<link rel="stylesheet" href="/ui/index.css">   <!-- токены + base + линии + компоненты -->
<script type="module" src="/ui/red-lines.js"></script>

<rl-red-lines lines="2" speed="1" brightness="1"></rl-red-lines>
```

| Файл | Что внутри |
|---|---|
| `tokens.css` | палитра, типографика, отступы, радиусы, тени, тайминги, z-index; тема — `.dark` или `[data-theme="dark"]` |
| `red-lines.css/js` | `<rl-red-lines>`: `lines`, `speed`, `brightness`, `disabled`, `no-intro`; пауза в скрытой вкладке и вне экрана, `prefers-reduced-motion` |
| `components.css` | `.rl-btn`, `.rl-input`, `.rl-card`, `.rl-avatar`, `.rl-badge`, `.rl-modal`, `.rl-toast`, `.rl-skeleton` |
| `modal.js`, `toast.js` | `openModal/closeModal` для `<dialog>`, `toast(text, {variant})` |
