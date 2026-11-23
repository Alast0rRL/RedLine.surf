# app/utils.py
import asyncio
import logging
import time

from mcstatus import JavaServer

from .config import MC_SERVER_ADDRESS

log = logging.getLogger(__name__)

# Ответ кэшируется: сколько бы людей ни открыло сайт, сервер пингуется не чаще раза в CACHE_TTL
CACHE_TTL = 30
TIMEOUT = 4

_cache: dict = {"at": 0.0, "data": None}
_lock = asyncio.Lock()


async def _ping() -> dict:
    try:
        server = await JavaServer.async_lookup(MC_SERVER_ADDRESS, timeout=TIMEOUT)
        status = await asyncio.wait_for(server.async_status(), TIMEOUT)
        return {
            "online": True,
            "players": status.players.online,
            "max_players": status.players.max,
            "latency": round(status.latency),
        }
    except Exception as e:  # сервер выключен, DNS, таймаут
        log.info("Minecraft status failed: %s", e)
        # текст ошибки наружу не отдаём
        return {"online": False, "players": 0, "max_players": 0}


async def get_minecraft_status() -> dict:
    async with _lock:
        if _cache["data"] is None or time.monotonic() - _cache["at"] > CACHE_TTL:
            _cache["data"] = await _ping()
            _cache["at"] = time.monotonic()
        return _cache["data"]
