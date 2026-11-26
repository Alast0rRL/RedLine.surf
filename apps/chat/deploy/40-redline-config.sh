#!/bin/sh
# Генерирует /config.json клиента из переменных окружения при старте контейнера.
set -eu

: "${HOMESERVER_URL:?HOMESERVER_URL is required}"
: "${SERVER_NAME:?SERVER_NAME is required}"

# Проверка — до генерации: exit внутри $(...) завершил бы только подоболочку.
for v in "$HOMESERVER_URL" "$SERVER_NAME" "${PUSH_GATEWAY_URL:-}" "${VAPID_PUBLIC_KEY:-}" "${BOT_USERS:-}" "${MC_HOMESERVER_URL:-}" "${MC_SERVER_NAME:-}" "${TELEGRAM_API_ID:-}" "${TELEGRAM_API_HASH:-}" "${LIVEKIT_ORIGINS:-}"; do
  case "$v" in
    *'"'* | *'\'*) echo "40-redline-config: недопустимый символ в значении: $v" >&2; exit 1 ;;
  esac
done

json_str() { printf '"%s"' "$1"; }

bots=""
old_ifs=$IFS
IFS=','
for b in ${BOT_USERS:-}; do
  b=$(printf '%s' "$b" | tr -d ' ')
  [ -n "$b" ] && bots="${bots:+$bots,}$(json_str "$b")"
done
IFS=$old_ifs

# второй сервер (Minecraft): если задан, клиент входит туда по нику
mc=""
if [ -n "${MC_HOMESERVER_URL:-}" ]; then
  mc=",
  \"mc\": { \"homeserverUrl\": $(json_str "$MC_HOMESERVER_URL"), \"serverName\": $(json_str "${MC_SERVER_NAME:-mc.redline.surf}") }"
fi

# Звонки: адреса LiveKit для CSP заданы — кнопки звонков включены
calls=false
if [ -n "${LIVEKIT_ORIGINS:-}" ]; then
  calls=true
fi

# Telegram: ключи приложения с my.telegram.org; без них вкладки Telegram нет
tg=""
if [ -n "${TELEGRAM_API_ID:-}" ] && [ -n "${TELEGRAM_API_HASH:-}" ]; then
  case "$TELEGRAM_API_ID" in
    *[!0-9]*) echo "40-redline-config: TELEGRAM_API_ID — только цифры" >&2; exit 1 ;;
  esac
  tg=",
  \"telegram\": { \"apiId\": $TELEGRAM_API_ID, \"apiHash\": $(json_str "$TELEGRAM_API_HASH") }"
fi

cat > /usr/share/nginx/html/config.json <<EOF
{
  "homeserverUrl": $(json_str "$HOMESERVER_URL"),
  "serverName": $(json_str "$SERVER_NAME"),
  "pushGatewayUrl": $(json_str "${PUSH_GATEWAY_URL:-}"),
  "vapidPublicKey": $(json_str "${VAPID_PUBLIC_KEY:-}"),
  "botUsers": [$bots],
  "calls": $calls$mc$tg
}
EOF
echo "40-redline-config: config.json для $SERVER_NAME готов"
