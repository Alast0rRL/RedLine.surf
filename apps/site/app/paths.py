# app/paths.py
import os
from pathlib import Path

# apps/site — всё остальное считается от неё, а не от директории запуска
SITE_DIR = Path(__file__).resolve().parent.parent

# Дизайн-система из монорепо; в Docker-образе путь задаётся REDLINE_UI_DIR
UI_DIR = Path(os.getenv("REDLINE_UI_DIR", SITE_DIR.parent.parent / "packages" / "redline-ui" / "src"))
