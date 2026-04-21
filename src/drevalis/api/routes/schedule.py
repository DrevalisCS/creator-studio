"""Content scheduling API routes."""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from drevalis.core.config import Settings
from drevalis.core.deps import get_db, get_settings
from drevalis.repositories.scheduled_post import ScheduledPostRepository
from drevalis.schemas.schedule import (
    CalendarDay,
    ScheduleCreate,
    ScheduleResponse,
    ScheduleUpdate,
)

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/schedule", tags=["schedule"])


def _normalize_to_utc(dt: datetime, tz_name: str) -> datetime:
    """Ensure *dt* is a UTC-aware datetime.

    * If *dt* is naive (no tzinfo), treat it as local time in *tz_name* and
      convert to UTC.
    * If *dt* is already timezone-aware, convert to UTC (no-op when already
      UTC).
    """
    if dt.tzinfo is None:
        local_tz = ZoneInfo(tz_name)
        dt = dt.replace(tzinfo=local_tz)
    return dt.astimezone(UTC)


@router.post(
    "",
    response_model=ScheduleResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Schedule a post for future publishing",
)
async def create_scheduled_post(
    payload: ScheduleCreate,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ScheduleResponse:
    repo = ScheduledPostRepository(db)
    create_kwargs: dict[str, Any] = dict[str, Any](
        content_type=payload.content_type,
        content_id=payload.content_id,
        platform=payload.platform,
        scheduled_at=_normalize_to_utc(payload.scheduled_at, settings.app_timezone),
        title=payload.title,
        description=payload.description or None,
        tags=payload.tags or None,
        privacy=payload.privacy,
    )
    if payload.youtube_channel_id:
        create_kwargs["youtube_channel_id"] = payload.youtube_channel_id
    post = await repo.create(**create_kwargs)
    await db.commit()
    logger.info("post_scheduled", post_id=str(post.id), platform=payload.platform)
    return ScheduleResponse.model_validate(post)


@router.get(
    "",
    response_model=list[ScheduleResponse],
    status_code=status.HTTP_200_OK,
    summary="List scheduled posts",
)
async def list_scheduled_posts(
    status_filter: str | None = Query(default=None, alias="status"),
    platform: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> list[ScheduleResponse]:
    repo = ScheduledPostRepository(db)
    posts = await repo.get_all(limit=limit)
    # Apply filters in Python (simple, small dataset)
    if status_filter:
        posts = [p for p in posts if p.status == status_filter]
    if platform:
        posts = [p for p in posts if p.platform == platform]
    return [ScheduleResponse.model_validate(p) for p in posts]


@router.get(
    "/calendar",
    response_model=list[CalendarDay],
    status_code=status.HTTP_200_OK,
    summary="Get calendar view of scheduled posts",
)
async def get_calendar(
    start: str = Query(..., description="ISO date e.g. 2026-03-01"),
    end: str = Query(..., description="ISO date e.g. 2026-03-31"),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> list[CalendarDay]:
    app_tz = ZoneInfo(settings.app_timezone)
    start_dt = datetime.fromisoformat(start).replace(tzinfo=app_tz).astimezone(UTC)
    end_dt = (
        datetime.fromisoformat(end)
        .replace(hour=23, minute=59, second=59, tzinfo=app_tz)
        .astimezone(UTC)
    )

    repo = ScheduledPostRepository(db)
    posts = await repo.get_calendar(start_dt, end_dt)

    # Group by date in the app's configured timezone
    by_date: dict[str, list[ScheduleResponse]] = defaultdict(list)
    for p in posts:
        local_dt = p.scheduled_at.astimezone(app_tz)
        date_key = local_dt.strftime("%Y-%m-%d")
        by_date[date_key].append(ScheduleResponse.model_validate(p))

    return [CalendarDay(date=d, posts=ps) for d, ps in sorted(by_date.items())]


@router.put(
    "/{post_id}",
    response_model=ScheduleResponse,
    status_code=status.HTTP_200_OK,
    summary="Update a scheduled post",
)
async def update_scheduled_post(
    post_id: UUID,
    payload: ScheduleUpdate,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ScheduleResponse:
    repo = ScheduledPostRepository(db)
    post = await repo.get_by_id(post_id)
    if not post:
        raise HTTPException(404, "Scheduled post not found")
    if post.status != "scheduled":
        raise HTTPException(409, f"Cannot update post with status '{post.status}'")

    updates = payload.model_dump(exclude_unset=True)
    if "scheduled_at" in updates and updates["scheduled_at"] is not None:
        updates["scheduled_at"] = _normalize_to_utc(updates["scheduled_at"], settings.app_timezone)
    updated = await repo.update(post_id, **updates)
    await db.commit()
    return ScheduleResponse.model_validate(updated)


@router.delete(
    "/{post_id}",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Delete a scheduled post",
)
async def delete_scheduled_post(
    post_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    repo = ScheduledPostRepository(db)
    post = await repo.get_by_id(post_id)
    if not post:
        raise HTTPException(404, "Scheduled post not found")
    if post.status == "published":
        raise HTTPException(409, "Cannot delete a published post")

    await repo.delete(post_id)
    await db.commit()
    return {"message": "Scheduled post deleted", "post_id": str(post_id)}
