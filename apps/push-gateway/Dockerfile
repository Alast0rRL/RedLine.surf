# Контекст сборки — корень репозитория (см. deploy/docker-compose.yml)
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY apps/push-gateway/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY apps/push-gateway/server.mjs ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "server.mjs"]
