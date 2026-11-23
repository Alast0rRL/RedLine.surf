# app/config.py — все адреса в одном месте, переопределяются переменными окружения
import os

# Адрес Minecraft-сервера: его копирует кнопка «Играть», по нему же сайт пингует онлайн
MC_SERVER_ADDRESS = (os.getenv("MC_SERVER_ADDRESS") or "redline.necr0manth.dev")

# Публичный адрес сайта (canonical, og:url)
SITE_URL = (os.getenv("SITE_URL") or "https://minecraft.redline.surf").rstrip("/")

# 3D-карта (BlueMap и т. п.)
MAP_URL = (os.getenv("MAP_URL") or f"{SITE_URL}/map/#world:0:0:0:1500:0:0:0:0:perspective")

DISCORD_URL = (os.getenv("DISCORD_URL") or "https://discord.gg/F9JJpa5VsE")

DESCRIPTION = "Redline — классическое выживание в Minecraft без вайпов: вечный мир, защита вещей, голосовой чат и живая 3D-карта."
