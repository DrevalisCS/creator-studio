"""FastAPI dependency injection providers."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from functools import lru_cache

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from shortsfactory.core.config import Settings
from shortsfactory.core.database import get_db_session
from shortsfactory.core.redis import get_redis as _get_redis


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the cached application settings singleton.

    Uses ``functools.lru_cache`` so the ``.env`` file is read at most once.
    """
    return Settings()  # type: ignore[call-arg]


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield an async database session (delegates to ``database.get_db_session``)."""
    async for session in get_db_session():
        yield session


async def get_redis() -> AsyncGenerator[Redis, None]:  # type: ignore[type-arg]
    """Yield a Redis client from the connection pool."""
    async for client in _get_redis():
        yield client
