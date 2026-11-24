# app/utils.py
import asyncio
import logging
import time

from mcstatus import JavaServer

from .config import MC_SERVER_ADDRESS

log = logging.getLogger(__name__)

# Сервер пингуется не чаще раза в CACHE_TTL, сколько бы людей ни открыло сайт.
CACHE_TTL = 30
# Через ретранслятор ответ идёт до ~8 с — короткий таймаут давал ложный «OFF».
TIMEOUT = 10

_cache: dict = {"at": 0.0, "data": None}
_refresh: asyncio.Task | None = None


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


async def _update() -> dict:
    data = await _ping()
    _cache["data"], _cache["at"] = data, time.monotonic()
    return data


async def get_minecraft_status() -> dict:
    """Отдаёт последний известный статус сразу, свежий запрашивает в фоне (stale-while-revalidate).
    Ждать приходится только самому первому запросу после старта."""
    global _refresh
    stale = time.monotonic() - _cache["at"] > CACHE_TTL
    if stale and (_refresh is None or _refresh.done()):
        _refresh = asyncio.create_task(_update())
    if _cache["data"] is None:
        return await asyncio.shield(_refresh)
    return _cache["data"]
