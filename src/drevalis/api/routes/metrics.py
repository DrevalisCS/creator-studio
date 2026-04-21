"""Metrics API router -- exposes pipeline execution metrics.

Endpoints:
- GET /api/v1/metrics/steps       -- per-step average duration & success rate
- GET /api/v1/metrics/generations  -- overall generation counts
- GET /api/v1/metrics/recent       -- recent step execution history
- GET /api/v1/metrics/events      -- recent pipeline events for log viewer (DB-backed)
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from drevalis.core.deps import get_db
from drevalis.core.metrics import metrics

router = APIRouter(prefix="/api/v1/metrics", tags=["metrics"])


@router.get(
    "/steps",
    status_code=status.HTTP_200_OK,
    summary="Per-step pipeline statistics",
)
async def step_stats() -> dict[str, Any]:
    """Return average duration, min/max, and success rate for each pipeline step.

    Response shape::

        {
            "script": {
                "count": 12,
                "avg_duration_seconds": 4.32,
                "min_duration_seconds": 2.1,
                "max_duration_seconds": 8.7,
                "success_rate": 0.917,
                "last_duration_seconds": 3.8
            },
            ...
        }
    """
    return await metrics.get_step_stats()


@router.get(
    "/generations",
    status_code=status.HTTP_200_OK,
    summary="Overall generation pipeline statistics",
)
async def generation_stats() -> dict[str, Any]:
    """Return total, success, and failed generation counts plus success rate.

    Response shape::

        {
            "total": 25,
            "success": 20,
            "failed": 5,
            "success_rate": 0.8
        }
    """
    return await metrics.get_generation_stats()


@router.get(
    "/recent",
    status_code=status.HTTP_200_OK,
    summary="Recent step execution history",
)
async def recent_metrics(
    limit: int = Query(default=50, ge=1, le=500, description="Max entries to return"),
) -> list[dict[str, Any]]:
    """Return the most recent step executions (newest first).

    Each entry contains step name, duration, success flag, episode ID,
    and timestamp.
    """
    return await metrics.get_recent_metrics(limit=limit)


@router.get(
    "/events",
    status_code=status.HTTP_200_OK,
    summary="Recent pipeline events for the log viewer",
)
async def get_recent_events(
    limit: int = Query(default=100, ge=1, le=500, description="Max events to return"),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Get recent pipeline events from the database.

    Returns completed/failed generation jobs with duration, step, and
    episode info.  Uses the DB instead of in-process metrics so events
    persist across API restarts and include worker-side data.
    """
    from sqlalchemy import select

    from drevalis.models.generation_job import GenerationJob

    stmt = (
        select(GenerationJob)
        .where(GenerationJob.status.in_(["done", "failed"]))
        .order_by(GenerationJob.completed_at.desc().nullslast())
        .limit(limit)
    )
    result = await db.execute(stmt)
    jobs = result.scalars().all()

    events = []
    for job in jobs:
        started = job.started_at
        completed = job.completed_at
        duration = 0.0
        if started and completed:
            duration = (completed - started).total_seconds()

        events.append(
            {
                "step": job.step,
                "duration_seconds": round(duration, 3),
                "success": job.status == "done",
                "episode_id": str(job.episode_id),
                "timestamp": (completed or started or job.created_at).isoformat(),
                "error_message": job.error_message,
            }
        )

    return events
