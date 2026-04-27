"""Content scheduling API routes."""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from drevalis.core.config import Settings
from drevalis.core.deps import get_db, get_settings
from drevalis.models.scheduled_post import ScheduledPost
from drevalis.repositories.episode import EpisodeRepository
from drevalis.repositories.scheduled_post import ScheduledPostRepository
from drevalis.repositories.series import SeriesRepository
from drevalis.repositories.youtube import YouTubeChannelRepository
from drevalis.schemas.schedule import (
    AutoScheduleRequest,
    AutoScheduleResponse,
    CalendarDay,
    ChannelHealth,
    DiagnosticsResponse,
    PlannedSlot,
    RetryFailedRequest,
    RetryFailedResponse,
    ScheduleCreate,
    ScheduleResponse,
    ScheduleUpdate,
    UploadDiagnostic,
)
from drevalis.services.auto_schedule import plan_auto_schedule

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


# ── Auto-schedule (series-level batch scheduling) ─────────────────────────


@router.post(
    "/series/{series_id}/auto-schedule",
    response_model=AutoScheduleResponse,
    status_code=status.HTTP_200_OK,
    summary="Distribute review-ready unuploaded episodes across the calendar",
)
async def auto_schedule_series(
    series_id: UUID,
    payload: AutoScheduleRequest,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> AutoScheduleResponse:
    """Walk a series' unuploaded episodes and queue scheduled YouTube posts.

    The first slot lands on the channel's first ``upload_days``-allowed
    date at the channel's ``upload_time``. Subsequent slots step by
    ``cadence`` (daily / every_n_days / weekly).

    ``dry_run=true`` returns the plan without persisting so callers can
    preview before committing.
    """
    series_repo = SeriesRepository(db)
    series = await series_repo.get_by_id(series_id)
    if not series:
        raise HTTPException(404, f"Series {series_id} not found")

    # Resolve channel: payload override > series default. No fallback —
    # uploads need an explicit channel to avoid silent misroutes.
    channel_id = payload.youtube_channel_id or getattr(series, "youtube_channel_id", None)
    if channel_id is None:
        raise HTTPException(
            422,
            "Series has no YouTube channel assigned and the request did not "
            "supply ``youtube_channel_id``. Set one before auto-scheduling.",
        )
    ch_repo = YouTubeChannelRepository(db)
    channel = await ch_repo.get_by_id(channel_id)
    if channel is None:
        raise HTTPException(404, f"YouTube channel {channel_id} not found")

    # Collect upload-ready episodes.
    ep_repo = EpisodeRepository(db)
    review_eps = await ep_repo.get_by_series(series_id, status_filter="review", limit=500)
    if payload.episode_filter == "all_unuploaded":
        exported_eps = await ep_repo.get_by_series(series_id, status_filter="exported", limit=500)
        candidates = list(review_eps) + list(exported_eps)
    else:
        candidates = list(review_eps)

    # Drop episodes that already have a scheduled YouTube post (status
    # in scheduled / publishing / published).
    sched_repo = ScheduledPostRepository(db)
    skipped: list[UUID] = []
    fresh: list[Any] = []
    for ep in candidates:
        existing = await sched_repo.get_by_content("episode", ep.id)
        has_yt_lock = any(
            p.platform == "youtube" and p.status in ("scheduled", "publishing", "published")
            for p in existing
        )
        if has_yt_lock:
            skipped.append(ep.id)
        else:
            fresh.append(ep)

    # Build the plan.
    fresh.sort(key=lambda e: getattr(e, "created_at", datetime.now(UTC)))
    start_at_utc = _normalize_to_utc(payload.start_at, settings.app_timezone)
    slots = plan_auto_schedule(
        episodes=fresh,
        start_at_utc=start_at_utc,
        cadence=payload.cadence,
        every_n=payload.every_n,
        upload_days=channel.upload_days,
        upload_time=channel.upload_time,
        timezone=settings.app_timezone,
        youtube_channel_id=channel_id,
        privacy=payload.privacy,
        description_template=payload.description_template,
        tags_template=payload.tags_template,
    )

    planned_payload = [
        PlannedSlot(
            episode_id=s.episode_id,
            episode_title=s.title,
            scheduled_at=s.scheduled_at_utc,
            privacy=s.privacy,
            youtube_channel_id=s.youtube_channel_id,
        )
        for s in slots
    ]

    if payload.dry_run:
        return AutoScheduleResponse(
            series_id=series_id,
            cadence=payload.cadence,
            planned=planned_payload,
            persisted=False,
            skipped_already_scheduled=skipped,
        )

    # Persist each slot. Single transaction: if any insert fails, roll
    # back so the user doesn't end up with a half-scheduled series.
    for slot in slots:
        await sched_repo.create(
            content_type="episode",
            content_id=slot.episode_id,
            platform="youtube",
            scheduled_at=slot.scheduled_at_utc,
            title=slot.title,
            description=slot.description or None,
            tags=slot.tags or None,
            privacy=slot.privacy,
            youtube_channel_id=slot.youtube_channel_id,
        )
    await db.commit()

    logger.info(
        "auto_schedule.created",
        series_id=str(series_id),
        cadence=payload.cadence,
        scheduled_count=len(slots),
        skipped_count=len(skipped),
    )
    return AutoScheduleResponse(
        series_id=series_id,
        cadence=payload.cadence,
        planned=planned_payload,
        persisted=True,
        skipped_already_scheduled=skipped,
    )


# ── Diagnostics + manual retry ────────────────────────────────────────────


@router.get(
    "/diagnostics",
    response_model=DiagnosticsResponse,
    status_code=status.HTTP_200_OK,
    summary="Why are uploads failing? Aggregate health of channels + recent posts",
)
async def get_diagnostics(
    within_hours: int = Query(default=72, ge=1, le=720),
    db: AsyncSession = Depends(get_db),
) -> DiagnosticsResponse:
    """Aggregate the data needed to diagnose 'uploads not working'.

    Returns:
      * Per-channel health (token expiry + refreshability + upload rules)
      * The N most recent failed scheduled posts with their error messages
      * Overdue posts still in ``scheduled`` status (worker-not-running
        smoke signal)
      * Summary counters
    """
    now = datetime.now(UTC)
    cutoff = now - timedelta(hours=within_hours)

    ch_repo = YouTubeChannelRepository(db)
    channels = await ch_repo.get_all()

    channel_healths: list[ChannelHealth] = []
    for ch in channels:
        issues: list[str] = []
        has_access = bool(getattr(ch, "access_token_encrypted", None))
        has_refresh = bool(getattr(ch, "refresh_token_encrypted", None))
        expiry = getattr(ch, "token_expiry", None)
        expired = bool(expiry and expiry <= now)
        if not has_access:
            issues.append("No access token stored — channel needs to be reconnected.")
        if expired and not has_refresh:
            issues.append("Access token expired and no refresh token — operator must reconnect.")
        if not getattr(ch, "upload_days", None):
            issues.append("upload_days unset (defaults to every weekday).")
        if not getattr(ch, "upload_time", None):
            issues.append("upload_time unset (defaults to 09:00).")
        channel_healths.append(
            ChannelHealth(
                channel_id=ch.id,
                channel_name=getattr(ch, "channel_name", None) or getattr(ch, "name", None),
                has_access_token=has_access,
                has_refresh_token=has_refresh,
                token_expires_at=expiry,
                token_expired=expired,
                can_refresh=has_refresh and has_access,
                upload_days=getattr(ch, "upload_days", None),
                upload_time=getattr(ch, "upload_time", None),
                issues=issues,
            )
        )

    # Recent failed scheduled posts (any platform).
    failed_stmt = (
        select(ScheduledPost)
        .where(
            ScheduledPost.status == "failed",
            ScheduledPost.scheduled_at >= cutoff,
        )
        .order_by(ScheduledPost.scheduled_at.desc())
        .limit(50)
    )
    failed_rows = list((await db.execute(failed_stmt)).scalars().all())

    # Overdue posts that never published — strong signal that the
    # worker / cron isn't running.
    overdue_stmt = (
        select(ScheduledPost)
        .where(
            ScheduledPost.status == "scheduled",
            ScheduledPost.scheduled_at <= now - timedelta(minutes=10),
        )
        .order_by(ScheduledPost.scheduled_at)
        .limit(50)
    )
    overdue_rows = list((await db.execute(overdue_stmt)).scalars().all())

    def _diag(post: ScheduledPost, kind: str) -> UploadDiagnostic:
        issues = []
        if kind == "overdue":
            mins_late = int((now - post.scheduled_at).total_seconds() / 60)
            issues.append(
                f"Scheduled {mins_late} min ago and still 'scheduled' — worker may not be running."
            )
        if post.platform == "youtube" and post.youtube_channel_id is None:
            issues.append(
                "youtube_channel_id is null on this post — falls back to "
                "series.youtube_channel_id, which can fail at upload time."
            )
        return UploadDiagnostic(
            post_id=post.id,
            status=post.status,
            scheduled_at=post.scheduled_at,
            title=post.title,
            platform=post.platform,
            error_message=post.error_message,
            issues=issues,
        )

    summary = {
        "channel_count": len(channel_healths),
        "channels_with_issues": sum(1 for c in channel_healths if c.issues),
        "channels_expired_no_refresh": sum(
            1 for c in channel_healths if c.token_expired and not c.can_refresh
        ),
        "recent_failed_count": len(failed_rows),
        "overdue_count": len(overdue_rows),
    }

    return DiagnosticsResponse(
        channels=channel_healths,
        recent_failed_posts=[_diag(p, "failed") for p in failed_rows],
        overdue_scheduled_posts=[_diag(p, "overdue") for p in overdue_rows],
        summary=summary,
    )


@router.post(
    "/retry-failed",
    response_model=RetryFailedResponse,
    status_code=status.HTTP_200_OK,
    summary="Reset failed scheduled posts so the next cron tick re-attempts them",
)
async def retry_failed(
    payload: RetryFailedRequest,
    db: AsyncSession = Depends(get_db),
) -> RetryFailedResponse:
    """Manual companion to the 48h auto-retry-on-startup behaviour.

    Resets ``status='failed'`` posts back to ``'scheduled'`` (clearing
    ``error_message``) so the next ``publish_scheduled_posts`` cron
    tick picks them up. ``post_ids`` filters to specific posts;
    omitted/null = every failed post within ``within_hours``.
    """
    now = datetime.now(UTC)
    cutoff = now - timedelta(hours=payload.within_hours)

    stmt = select(ScheduledPost).where(ScheduledPost.status == "failed")
    if payload.post_ids:
        stmt = stmt.where(ScheduledPost.id.in_(payload.post_ids))
    else:
        stmt = stmt.where(ScheduledPost.scheduled_at >= cutoff)
    rows = list((await db.execute(stmt)).scalars().all())

    repo = ScheduledPostRepository(db)
    requeued: list[UUID] = []
    skipped: list[UUID] = []
    for post in rows:
        # Only reset posts within the window even when explicit ids
        # were supplied — protects against accidentally requeuing an
        # ancient failure.
        if post.scheduled_at < cutoff:
            skipped.append(post.id)
            continue
        await repo.update(post.id, status="scheduled", error_message=None)
        requeued.append(post.id)
    await db.commit()

    logger.info(
        "schedule.retry_failed",
        requeued_count=len(requeued),
        skipped_count=len(skipped),
        within_hours=payload.within_hours,
    )
    return RetryFailedResponse(requeued=requeued, skipped=skipped)
