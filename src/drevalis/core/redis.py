"""Redis connection pool management."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator

import structlog
from arq import create_pool
from arq.connections import ArqRedis, RedisSettings
from redis.asyncio import ConnectionPool, Redis

from drevalis.core.config import Settings

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

# Module-level singletons, initialised during app lifespan.
_pool: ConnectionPool | None = None
_arq_pool: ArqRedis | None = None


def _parse_redis_settings(url: str) -> RedisSettings:
    """Parse a redis:// URL into arq RedisSettings.

    The conn_timeout / retry knobs are bumped well above arq's
    defaults (1s timeout, 5 retries × 1s delay = ~6s total). On a
    multi-container update Redis can need 10-30 seconds to load its
    RDB and accept connections; the old defaults caused the app
    container to crash with ``redis.exceptions.TimeoutError`` before
    Redis was ready, which then crash-looped under the supervisor.
    """
    from urllib.parse import urlparse

    parsed = urlparse(url)
    return RedisSettings(
        host=parsed.hostname or "localhost",
        port=parsed.port or 6379,
        database=int(parsed.path.lstrip("/") or "0"),
        password=parsed.password,
        conn_timeout=30,
        conn_retries=10,
        conn_retry_delay=2,
    )


async def init_redis(settings: Settings) -> None:
    """Create the Redis connection pool and arq pool.

    Called once during the FastAPI lifespan startup phase. Retries
    the arq pool creation on transient ConnectionError / TimeoutError
    so a slow-warming Redis container doesn't crash the app at boot.
    """
    global _pool, _arq_pool  # noqa: PLW0603

    _pool = ConnectionPool.from_url(
        settings.redis_url,
        decode_responses=True,
        max_connections=20,
        socket_connect_timeout=30,
        socket_timeout=30,
    )

    arq_settings = _parse_redis_settings(settings.redis_url)
    last_exc: Exception | None = None
    for attempt in range(1, 11):
        try:
            _arq_pool = await create_pool(arq_settings)
            return
        except Exception as exc:
            last_exc = exc
            logger.warning(
                "redis_init_retry",
                attempt=attempt,
                error=f"{type(exc).__name__}: {exc}",
            )
            await asyncio.sleep(min(2 * attempt, 10))
    # Out of retries — surface the original error so the operator
    # sees something actionable in the logs.
    raise RuntimeError(
        f"Redis still unreachable after 10 retries; last error: {last_exc}"
    ) from last_exc


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
