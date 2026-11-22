# app/main.py
import os
from fastapi import FastAPI, Request, Depends
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from . import models, database, utils
from .paths import SITE_DIR, UI_DIR

# 1. Инициализация БД (создает таблицы при запуске)
models.Base.metadata.create_all(bind=database.engine)

app = FastAPI(title="Redline Server")

# 2. Подключение папок (пути от apps/site, а не от текущей директории)
STATIC_DIR = SITE_DIR / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
# Общая дизайн-система (packages/redline-ui/src): токены, красные линии
app.mount("/ui", StaticFiles(directory=UI_DIR), name="ui")

# Шаблоны (твои HTML файлы)
templates = Jinja2Templates(directory=SITE_DIR / "templates")

# --- МАРШРУТЫ (ROUTES) ---

@app.get("/")
async def read_root(request: Request):
    """Отображает главную страницу"""
    # Мы можем передать данные сразу при загрузке, но лучше подгружать JS-ом
    return templates.TemplateResponse(request, "index.html")

@app.get("/api/status")
async def get_server_status():
    """API для получения онлайна (вызывается из JS)"""
    status = await utils.get_minecraft_status()
    return status

@app.get("/api/gallery")
async def get_gallery():
    """API для получения списка фото галереи"""
    folder = STATIC_DIR / "gallery"
    if not os.path.isdir(folder):
        return {"images": []}
    files = sorted(
        f for f in os.listdir(folder)
        if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))
    )
    return {"images": files}

# Пример работы с БД (на будущее)
@app.post("/api/players/")
def create_player(username: str, db: Session = Depends(database.get_db)):
    # Здесь будет логика добавления игрока
    return {"msg": f"Player {username} checked"}