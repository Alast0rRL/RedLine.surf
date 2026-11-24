# app/main.py
from datetime import date
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import config, models, database, utils
from .paths import SITE_DIR, UI_DIR

models.Base.metadata.create_all(bind=database.engine)

app = FastAPI(title="Redline Server", docs_url=None, redoc_url=None, openapi_url=None)

STATIC_DIR = SITE_DIR / "static"
GALLERY_DIR = STATIC_DIR / "gallery"
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".avif")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
# Общая дизайн-система (packages/redline-ui/src): токены, красные линии
app.mount("/ui", StaticFiles(directory=UI_DIR), name="ui")

templates = Jinja2Templates(directory=SITE_DIR / "templates")

# Версия для сброса кэша CSS/JS: время изменения собранных файлов
def _asset_version() -> str:
    files = [STATIC_DIR / "build" / "site.css", STATIC_DIR / "js" / "site.js", STATIC_DIR / "js" / "world.js"]
    return str(int(max((f.stat().st_mtime for f in files if f.exists()), default=0)))


def gallery_images() -> list[str]:
    if not GALLERY_DIR.is_dir():
        return []
    return sorted(f.name for f in GALLERY_DIR.iterdir() if f.suffix.lower() in IMAGE_EXT)


def _map_label(url: str) -> str:
    parts = urlsplit(url)
    return (parts.netloc + parts.path).rstrip("/")


@app.get("/")
async def read_root(request: Request):
    return templates.TemplateResponse(request, "index.html", {
        "mc_address": config.MC_SERVER_ADDRESS,
        "gallery": gallery_images(),
        "year": date.today().year,
        "asset_version": _asset_version(),
        "site": {
            "url": config.SITE_URL,
            "description": config.DESCRIPTION,
            "discord": config.DISCORD_URL,
            "map_url": config.MAP_URL,
            "map_label": _map_label(config.MAP_URL),
        },
    })


@app.head("/", include_in_schema=False)
async def head_root():
    return PlainTextResponse("")


@app.get("/api/status")
async def get_server_status():
    """Онлайн Minecraft-сервера (кэш 30 с)"""
    return await utils.get_minecraft_status()


@app.get("/api/gallery")
async def get_gallery():
    """Список фото галереи"""
    return {"images": gallery_images()}


@app.get("/robots.txt", include_in_schema=False)
async def robots():
    return PlainTextResponse(f"User-agent: *\nAllow: /\nSitemap: {config.SITE_URL}/sitemap.xml\n")


@app.get("/sitemap.xml", include_in_schema=False)
async def sitemap():
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        f"<url><loc>{config.SITE_URL}/</loc></url></urlset>\n"
    )
    return PlainTextResponse(xml, media_type="application/xml")


@app.get("/healthz", include_in_schema=False)
async def healthz():
    return {"ok": True}
