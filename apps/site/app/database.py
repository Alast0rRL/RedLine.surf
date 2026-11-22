# app/database.py
import os
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from .paths import SITE_DIR

# Для продакшена здесь будет ссылка на PostgreSQL
SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{(SITE_DIR / 'redline.db').as_posix()}")

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

# Функция для получения сессии БД в эндпоинтах
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()