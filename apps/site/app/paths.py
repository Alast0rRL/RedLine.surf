# app/paths.py
from pathlib import Path

# apps/site — всё остальное считается от неё, а не от директории запуска
SITE_DIR = Path(__file__).resolve().parent.parent
