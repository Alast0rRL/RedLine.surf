# Контекст сборки — корень репозитория (см. deploy/docker-compose.yml)

FROM node:24-alpine AS build
WORKDIR /src
RUN npm install -g pnpm@11.25.0 --no-audit --no-fund
# сначала только манифесты — слой с зависимостями кешируется
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/redline-ui/package.json packages/redline-ui/
COPY apps/chat/package.json apps/chat/
COPY apps/push-gateway/package.json apps/push-gateway/
RUN pnpm install --frozen-lockfile --filter @redline/chat...
COPY packages/redline-ui packages/redline-ui
COPY apps/chat apps/chat
RUN pnpm --filter @redline/chat build

FROM nginx:1.29-alpine
COPY apps/chat/deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY apps/chat/deploy/security-headers.conf /etc/nginx/redline-headers.conf
COPY --chmod=755 apps/chat/deploy/40-redline-config.sh /docker-entrypoint.d/
COPY --from=build /src/apps/chat/dist /usr/share/nginx/html
# envsubst подставит только эти переменные — $uri и прочие nginx-переменные не тронет
ENV NGINX_ENVSUBST_FILTER=^HOMESERVER_URL$
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/config.json >/dev/null || exit 1
