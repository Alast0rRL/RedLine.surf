# Сайт Minecraft-сервера. Контекст сборки — корень репозитория (см. deploy/docker-compose.yml).
# CSS и библиотеки уже собраны в apps/site/static (pnpm --filter @redline/site build) — Node здесь не нужен.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    REDLINE_UI_DIR=/app/ui \
    DATABASE_URL=sqlite:////data/redline.db

WORKDIR /app
COPY apps/site/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY packages/redline-ui/src /app/ui
COPY apps/site/app /app/site/app
COPY apps/site/templates /app/site/templates
COPY apps/site/static /app/site/static

RUN useradd --system --uid 10001 site && mkdir /data && chown site /data
USER site
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2)" || exit 1
# --proxy-headers: схема и адрес клиента приходят от Caddy
CMD ["uvicorn", "app.main:app", "--app-dir", "/app/site", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
