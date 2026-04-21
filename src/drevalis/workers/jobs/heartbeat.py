"""Worker heartbeat arq job function.

Jobs
----
- ``worker_heartbeat`` -- write a heartbeat timestamp to Redis every minute.
"""

from __future__ import annotations

from datetime import UTC
from typing import Any

import structlog

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)


async def worker_heartbeat(ctx: dict[str, Any]) -> None:
    """Write a heartbeat timestamp to Redis every minute.

    The key ``worker:heartbeat`` is set with a 120-second TTL so that the
    API can detect a dead worker within two minutes.
    """
    from datetime import datetime

    from redis.asyncio import Redis as _Redis

    try:
        # Use a fresh Redis connection — the arq pool's set() may not
        # work reliably for plain key/value operations.
        _r = _Redis.from_url(ctx.get("redis_url", "redis://redis:6379/0"))
        try:
            await _r.set(
                "worker:heartbeat",
                datetime.now(UTC).isoformat(),
                ex=120,
            )
        finally:
            await _r.aclose()
    except Exception:
        pass
