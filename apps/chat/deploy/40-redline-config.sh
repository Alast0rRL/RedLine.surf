#!/bin/sh
# Генерирует /config.json клиента из переменных окружения при старте контейнера.
set -eu

: "${HOMESERVER_URL:?HOMESERVER_URL is required}"
: "${SERVER_NAME:?SERVER_NAME is required}"

# Проверка — до генерации: exit внутри $(...) завершил бы только подоболочку.
for v in "$HOMESERVER_URL" "$SERVER_NAME" "${PUSH_GATEWAY_URL:-}" "${VAPID_PUBLIC_KEY:-}" "${BOT_USERS:-}"; do
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

cat > /usr/share/nginx/html/config.json <<EOF
{
  "homeserverUrl": $(json_str "$HOMESERVER_URL"),
  "serverName": $(json_str "$SERVER_NAME"),
  "pushGatewayUrl": $(json_str "${PUSH_GATEWAY_URL:-}"),
  "vapidPublicKey": $(json_str "${VAPID_PUBLIC_KEY:-}"),
  "botUsers": [$bots]
}
EOF
echo "40-redline-config: config.json для $SERVER_NAME готов"
