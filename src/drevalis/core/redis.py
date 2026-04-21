"""Redis connection pool management."""

from __future__ import annotations

from collections.abc import AsyncGenerator

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings
from redis.asyncio import ConnectionPool, Redis

from drevalis.core.config import Settings

# Module-level singletons, initialised during app lifespan.
_pool: ConnectionPool | None = None
_arq_pool: ArqRedis | None = None


def _parse_redis_settings(url: str) -> RedisSettings:
    """Parse a redis:// URL into arq RedisSettings."""
    from urllib.parse import urlparse

    parsed = urlparse(url)
    return RedisSettings(
        host=parsed.hostname or "localhost",
        port=parsed.port or 6379,
        database=int(parsed.path.lstrip("/") or "0"),
        password=parsed.password,
    )


async def init_redis(settings: Settings) -> None:
    """Create the Redis connection pool and arq pool.

    Called once during the FastAPI lifespan startup phase.
    """
    global _pool, _arq_pool  # noqa: PLW0603

    _pool = ConnectionPool.from_url(
        settings.redis_url,
        decode_responses=True,
        max_connections=20,
    )

    _arq_pool = await create_pool(_parse_redis_settings(settings.redis_url))


async def close_redis() -> None:
    """Close and release the Redis connection pool.

    Called once during the FastAPI lifespan shutdown phase.
    """
    global _pool, _arq_pool  # noqa: PLW0603

    if _arq_pool is not None:
        await _arq_pool.aclose()
        _arq_pool = None

    if _pool is not None:
        await _pool.aclose()
        _pool = None


def get_pool() -> ConnectionPool:
    """Return the current connection pool (must be initialised)."""
    if _pool is None:
        raise RuntimeError(
            "Redis connection pool is not initialised. "
            "Ensure init_redis() has been called during application startup."
        )
    return _pool


def get_arq_pool() -> ArqRedis:
    """Return the arq connection pool for enqueuing jobs."""
    if _arq_pool is None:
        raise RuntimeError(
            "arq connection pool is not initialised. "
            "Ensure init_redis() has been called during application startup."
        )
    return _arq_pool


async def get_redis() -> AsyncGenerator[Redis, None]:
    """FastAPI dependency that yields a Redis client from the pool.

    The client is automatically closed when the request finishes.
    """
    pool = get_pool()
    client: Redis = Redis(connection_pool=pool)
    try:
        yield client
    finally:
        await client.aclose()
