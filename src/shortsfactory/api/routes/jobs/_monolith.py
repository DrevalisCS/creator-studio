"""Generation Jobs API router -- list, detail, active-jobs, status, cancel-all, cancel, and unified tasks."""

from __future__ import annotations

import json
from datetime import UTC
from typing import Any
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from shortsfactory.core.config import Settings
from shortsfactory.core.deps import get_db, get_settings
from shortsfactory.core.redis import get_arq_pool, get_pool
from shortsfactory.repositories.episode import EpisodeRepository
from shortsfactory.repositories.generation_job import GenerationJobRepository
from shortsfactory.schemas.generation_job import (
    GenerationJobExtendedResponse,
    GenerationJobListResponse,
    GenerationJobResponse,
)

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/jobs", tags=["jobs"])


# ── Active jobs (must be before /{job_id} to avoid path conflict) ────────


@router.get(
    "/active",
    response_model=list[GenerationJobListResponse],
    status_code=status.HTTP_200_OK,
    summary="All currently running or queued jobs",
)
async def list_active_jobs(
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> list[GenerationJobListResponse]:
    """Return all generation jobs with status 'queued' or 'running'."""
    repo = GenerationJobRepository(db)
    jobs = await repo.get_active_jobs(limit=limit)
    return [GenerationJobListResponse.model_validate(j) for j in jobs]


# ── Queue status (must be before /{job_id} to avoid path conflict) ────────


@router.get(
    "/status",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Queue status and generation statistics",
)
async def get_queue_status(
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Return the current queue status and generation statistics.

    Provides counts of active/queued jobs, available generation slots,
    and the number of episodes currently generating.
    """
    job_repo = GenerationJobRepository(db)
    ep_repo = EpisodeRepository(db)

    active_jobs = await job_repo.get_active_jobs(limit=500)

    running_jobs = [j for j in active_jobs if j.status == "running"]
    queued_jobs = [j for j in active_jobs if j.status == "queued"]

    # Count episodes by status (DB-based, consistent with the concurrency gate).
    generating_count = await ep_repo.count_by_status("generating")
    failed_count = await ep_repo.count_by_status("failed")
    max_concurrent = settings.max_concurrent_generations

    return {
        "active": len(running_jobs),
        "queued": len(queued_jobs),
        "max_concurrent": max_concurrent,
        "slots_available": max(0, max_concurrent - generating_count),
        "generating_episodes": generating_count,
        "total_generating_episodes": generating_count,
        "total_failed_episodes": failed_count,
    }


# ── Unified active tasks (must be before /{job_id} to avoid path conflict) ─


@router.get(
    "/tasks/active",
    status_code=status.HTTP_200_OK,
    summary="Get ALL active background tasks from all sources",
)
async def get_active_tasks(
    db: AsyncSession = Depends(get_db),
) -> dict[str, list[dict[str, Any]]]:
    """Return a unified list of all active background tasks across the system.

    This includes:
    - Episode generation jobs (from the database)
    - Audiobook generation jobs (from the database)
    - LLM script/series generation jobs (from Redis)

    The frontend Activity Monitor polls this single endpoint.
    """
    tasks: list[dict[str, Any]] = []

    # ── 1. Episode generation jobs (running/queued) ───────────────────
    job_repo = GenerationJobRepository(db)
    active_jobs = await job_repo.get_active_jobs(limit=200)

    # Group by episode: pick the running job (or the most recent queued)
    by_episode: dict[UUID, Any] = {}
    for job in active_jobs:
        existing = by_episode.get(job.episode_id)
        if existing is None or job.status == "running":
            by_episode[job.episode_id] = job

    # Fetch episode titles in bulk to avoid lazy-load MissingGreenlet errors
    ep_titles: dict[UUID, str] = {}
    if by_episode:
        from shortsfactory.repositories.episode import EpisodeRepository as _EpRepo

        _ep_repo = _EpRepo(db)
        for eid in by_episode:
            ep = await _ep_repo.get_by_id(eid)
            if ep:
                ep_titles[eid] = ep.title

    for ep_id, job in by_episode.items():
        ep_title = ep_titles.get(ep_id, f"Episode {str(ep_id)[:8]}")

        tasks.append(
            {
                "type": "episode_generation",
                "id": str(ep_id),
                "title": ep_title,
                "step": job.step,
                "status": job.status,
                "progress": job.progress_pct,
                "url": f"/episodes/{ep_id}",
            }
        )

    # ── 2. Audiobook generation (running in arq) ─────────────────────
    try:
        from shortsfactory.repositories.audiobook import AudiobookRepository

        ab_repo = AudiobookRepository(db)
        generating_abs = await ab_repo.get_by_status("generating")
        for ab in generating_abs:
            tasks.append(
                {
                    "type": "audiobook_generation",
                    "id": str(ab.id),
                    "title": ab.title,
                    "step": "tts",
                    "status": "running",
                    "progress": -1,
                    "url": f"/audiobooks/{ab.id}",
                }
            )
    except Exception:
        logger.debug("tasks_audiobook_query_failed", exc_info=True)

    # ── 3. LLM script/series jobs (from Redis) ───────────────────────
    redis_client: Redis = Redis(connection_pool=get_pool())  # type: ignore[type-arg]
    try:
        cursor: int = 0
        while True:
            cursor, keys = await redis_client.scan(cursor, match="script_job:*:status", count=50)
            for key in keys:
                raw_val = await redis_client.get(key)
                if not raw_val:
                    continue
                val = raw_val if isinstance(raw_val, str) else raw_val.decode()
                if val != "generating":
                    continue

                # Extract job_id from key pattern "script_job:{jid}:status"
                key_str = key if isinstance(key, str) else key.decode()
                parts = key_str.split(":")
                if len(parts) < 3:
                    continue
                jid = parts[1]

                # Read input data for a better title
                title = "AI Script"
                input_raw = await redis_client.get(f"script_job:{jid}:input")
                if input_raw:
                    try:
                        raw_input = input_raw if isinstance(input_raw, str) else input_raw.decode()
                        data = json.loads(raw_input)
                        # Could be audiobook script or series generation
                        if data.get("type") == "series":
                            idea = data.get("idea", "")
                            title = f"AI Series: {idea[:30]}" if idea else "AI Series"
                        else:
                            concept = data.get("concept", data.get("idea", ""))
                            title = f"AI Script: {concept[:30]}" if concept else "AI Script"
                    except Exception:
                        pass

                task_type = "script_generation"
                url = "/audiobooks"
                if "Series" in title:
                    url = "/series"

                tasks.append(
                    {
                        "type": task_type,
                        "id": jid,
                        "title": title,
                        "step": "llm",
                        "status": "running",
                        "progress": -1,
                        "url": url,
                    }
                )

            if cursor == 0:
                break
    except Exception:
        logger.debug("tasks_redis_scan_failed", exc_info=True)
    finally:
        await redis_client.aclose()

    return {"tasks": tasks}


# ── Cleanup stale jobs (must be before /{job_id} to avoid path conflict) ──


@router.post(
    "/cleanup",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Clean up orphaned queued/running jobs and stale generating episodes",
)
async def cleanup_stale_jobs(
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Clean up orphaned jobs and stale episodes.

    Marks orphaned ``queued`` and ``running`` generation jobs as ``failed``
    when their parent episode is no longer in ``generating`` status.
    Also resets any ``generating`` episodes that have no active arq jobs
    back to ``draft``.
    """
    job_repo = GenerationJobRepository(db)
    ep_repo = EpisodeRepository(db)

    # 1. Find all queued/running jobs whose episode is NOT generating
    active_jobs = await job_repo.get_active_jobs(limit=1000)
    cleaned_jobs = 0
    for job in active_jobs:
        ep = await ep_repo.get_by_id(job.episode_id)
        if ep is None or ep.status != "generating":
            await job_repo.update_status(job.id, "failed", error_message="Cleaned up: orphaned job")
            cleaned_jobs += 1

    # 2. Reset stale generating episodes to draft
    generating_eps = await ep_repo.get_by_status("generating", limit=500)
    reset_episodes = 0
    for ep in generating_eps:
        jobs = await job_repo.get_by_episode(ep.id)
        has_active = any(j.status in ("queued", "running") for j in jobs)
        if not has_active:
            await ep_repo.update_status(ep.id, "draft")
            reset_episodes += 1

    await db.commit()

    logger.info(
        "cleanup_complete",
        cleaned_jobs=cleaned_jobs,
        reset_episodes=reset_episodes,
    )
    return {
        "message": f"Cleaned up {cleaned_jobs} orphaned job(s), reset {reset_episodes} stale episode(s)",
        "cleaned_jobs": cleaned_jobs,
        "reset_episodes": reset_episodes,
    }


# ── Cancel all (must be before /{job_id} to avoid path conflict) ─────────


@router.post(
    "/cancel-all",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Emergency stop: cancel all generating episodes",
)
async def cancel_all_jobs(
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Emergency stop: cancel all currently generating episodes.

    Sets cancel flags in Redis for every generating episode, marks all
    running/queued jobs as failed, and updates all generating episodes
    to ``failed`` status.
    """
    ep_repo = EpisodeRepository(db)
    job_repo = GenerationJobRepository(db)
    redis = get_arq_pool()

    # Find all generating episodes.
    generating_episodes = await ep_repo.get_by_status("generating", limit=500)

    cancelled_episodes = 0
    cancelled_jobs = 0

    for episode in generating_episodes:
        # Set cancel flag in Redis.
        await redis.set(f"cancel:{episode.id}", "1", ex=3600)

        # Mark all running/queued jobs as failed.
        jobs = await job_repo.get_by_episode(episode.id)
        for job in jobs:
            if job.status in ("running", "queued"):
                await job_repo.update_status(
                    job.id, "failed", error_message="Cancelled by emergency stop"
                )
                cancelled_jobs += 1

        # Update episode status.
        await ep_repo.update_status(episode.id, "failed")
        cancelled_episodes += 1

        # Broadcast cancellation via WebSocket.
        from shortsfactory.schemas.progress import ProgressMessage

        cancel_msg = ProgressMessage(
            episode_id=str(episode.id),
            job_id="",
            step="script",
            status="failed",
            progress_pct=0,
            message="Generation cancelled by emergency stop",
            error="Emergency stop: all jobs cancelled",
        )
        channel = f"progress:{episode.id}"
        try:
            await redis.publish(channel, cancel_msg.model_dump_json())
        except Exception:
            logger.debug("cancel_all_broadcast_failed", episode_id=str(episode.id), exc_info=True)

    await db.commit()

    logger.info(
        "all_jobs_cancelled",
        cancelled_episodes=cancelled_episodes,
        cancelled_jobs=cancelled_jobs,
    )
    return {
        "message": f"Emergency stop: cancelled {cancelled_episodes} episode(s)",
        "cancelled_episodes": cancelled_episodes,
        "cancelled_jobs": cancelled_jobs,
    }


# ── Retry all failed episodes ─────────────────────────────────────────────


@router.post(
    "/retry-all-failed",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Retry all failed episodes from their first failed step",
)
async def retry_all_failed(
    priority: str = Query(
        default="shorts_first", description="Queue order: shorts_first, longform_first, fifo"
    ),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Find all episodes with status 'failed' and enqueue retry jobs.

    Priority ordering:
    - ``shorts_first``: shorts episodes queued before longform (default, best for algo)
    - ``longform_first``: longform episodes queued first
    - ``fifo``: no reordering, process in creation order
    """
    ep_repo = EpisodeRepository(db)
    arq = get_arq_pool()

    failed_episodes = await ep_repo.get_by_status("failed", limit=500)

    # Sort by priority — shorts first by default
    if priority == "shorts_first":
        failed_episodes.sort(
            key=lambda e: 0 if getattr(e, "content_format", "shorts") == "shorts" else 1
        )
    elif priority == "longform_first":
        failed_episodes.sort(
            key=lambda e: 0 if getattr(e, "content_format", "shorts") == "longform" else 1
        )

    retried = 0
    for episode in failed_episodes:
        try:
            await arq.enqueue_job("retry_episode_step", str(episode.id), None)
            await ep_repo.update_status(episode.id, "generating")
            retried += 1
        except Exception:
            logger.debug("retry_all_enqueue_failed", episode_id=str(episode.id))

    await db.commit()
    logger.info(
        "retry_all_failed_done", retried=retried, total=len(failed_episodes), priority=priority
    )
    return {
        "message": f"Retried {retried} failed episode(s) (priority: {priority})",
        "retried": retried,
        "total_failed": len(failed_episodes),
        "priority": priority,
    }


# ── Pause all generation ─────────────────────────────────────────────────


@router.post(
    "/pause-all",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Pause all generating episodes (sets cancel flag, keeps status as failed for easy retry)",
)
async def pause_all(
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Pause all currently generating episodes.

    Sets cancel flags so the pipeline stops between steps, and marks
    episodes as 'failed' so they can be retried later from where they
    stopped.
    """
    ep_repo = EpisodeRepository(db)
    job_repo = GenerationJobRepository(db)
    redis = get_arq_pool()

    generating = await ep_repo.get_by_status("generating", limit=500)
    paused = 0

    for episode in generating:
        await redis.set(f"cancel:{episode.id}", "1", ex=3600)

        jobs = await job_repo.get_by_episode(episode.id)
        for job in jobs:
            if job.status in ("running", "queued"):
                await job_repo.update_status(job.id, "failed", error_message="Paused by user")

        await ep_repo.update_status(episode.id, "failed")
        paused += 1

    await db.commit()
    logger.info("pause_all_done", paused=paused)
    return {
        "message": f"Paused {paused} generating episode(s)",
        "paused": paused,
    }


# ── Priority mode ─────────────────────────────────────────────────────────


@router.post(
    "/set-priority",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Set job processing priority mode",
)
async def set_priority(
    mode: str = Query(..., description="shorts_first, longform_first, or fifo"),
) -> dict[str, Any]:
    """Set the priority mode for job processing.

    - ``shorts_first``: Longform jobs defer when shorts are waiting (default)
    - ``longform_first``: Not implemented yet (same as fifo)
    - ``fifo``: No priority, first-in-first-out
    """
    if mode not in ("shorts_first", "longform_first", "fifo"):
        raise HTTPException(422, f"Invalid priority mode: {mode}")

    redis_client: Redis = Redis(connection_pool=get_pool())
    try:
        await redis_client.set("job:priority_mode", mode, ex=86400 * 30)  # 30-day TTL
    finally:
        await redis_client.aclose()

    return {"message": f"Priority mode set to '{mode}'", "mode": mode}


@router.get(
    "/priority",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Get current job priority mode",
)
async def get_priority() -> dict[str, Any]:
    """Return the current priority mode."""
    redis_client: Redis = Redis(connection_pool=get_pool())
    try:
        raw = await redis_client.get("job:priority_mode")
    finally:
        await redis_client.aclose()

    mode = raw.decode() if isinstance(raw, bytes) else (raw or "fifo")
    return {"mode": mode}


# ── List ALL jobs (with pagination, filters, and episode metadata) ────────


@router.get(
    "/all",
    response_model=list[GenerationJobExtendedResponse],
    status_code=status.HTTP_200_OK,
    summary="List all jobs with filters and episode metadata",
)
async def list_all_jobs(
    status_filter: str | None = Query(default=None, alias="status"),
    episode_id: UUID | None = Query(default=None),
    step: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> list[GenerationJobExtendedResponse]:
    """List all generation jobs with optional filters.

    Joins with episodes and series to return episode titles and series names.
    Supports pagination via ``limit`` and ``offset``.
    """
    repo = GenerationJobRepository(db)
    jobs = await repo.get_all_filtered(
        status_filter=status_filter,
        episode_id=episode_id,
        step=step,
        offset=offset,
        limit=limit,
    )

    results: list[GenerationJobExtendedResponse] = []
    for job in jobs:
        episode_title: str | None = None
        series_name: str | None = None
        # Episode and series are eagerly loaded by get_all_filtered.
        if job.episode is not None:
            episode_title = job.episode.title
            if job.episode.series is not None:
                series_name = job.episode.series.name

        results.append(
            GenerationJobExtendedResponse(
                id=job.id,
                episode_id=job.episode_id,
                step=job.step,
                status=job.status,
                progress_pct=job.progress_pct,
                started_at=job.started_at,
                completed_at=job.completed_at,
                error_message=job.error_message,
                retry_count=job.retry_count,
                worker_id=job.worker_id,
                created_at=job.created_at,
                updated_at=job.updated_at,
                episode_title=episode_title,
                series_name=series_name,
            )
        )
    return results


# ── Worker health ────────────────────────────────────────────────────────


@router.get(
    "/worker/health",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Check if the arq worker is alive via Redis heartbeat",
)
async def worker_health(
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Return the worker liveness status based on the Redis heartbeat key.

    The arq worker writes ``worker:heartbeat`` to Redis every 60 seconds with
    a 120-second TTL.  If the key is present and was written within the last
    120 seconds the worker is considered alive.
    """
    from datetime import datetime

    redis_client: Redis = Redis(connection_pool=get_pool())  # type: ignore[type-arg]
    try:
        raw = await redis_client.get("worker:heartbeat")
    finally:
        await redis_client.aclose()

    now = datetime.now(UTC)

    if raw is None:
        return {
            "alive": False,
            "last_heartbeat": None,
            "age_seconds": None,
            "message": "Worker heartbeat key not found. Worker may be down or not yet started.",
        }

    heartbeat_str = raw if isinstance(raw, str) else raw.decode()
    try:
        last_beat = datetime.fromisoformat(heartbeat_str)
        # Ensure the timestamp is timezone-aware for comparison
        if last_beat.tzinfo is None:
            last_beat = last_beat.replace(tzinfo=UTC)
        age_seconds = (now - last_beat).total_seconds()
    except ValueError:
        return {
            "alive": False,
            "last_heartbeat": heartbeat_str,
            "age_seconds": None,
            "message": "Worker heartbeat value could not be parsed.",
        }

    ep_repo = EpisodeRepository(db)
    generating_count = await ep_repo.count_by_status("generating")

    return {
        "alive": age_seconds < 120,
        "last_heartbeat": heartbeat_str,
        "age_seconds": round(age_seconds, 1),
        "generating_episodes": generating_count,
        "message": "Worker is alive." if age_seconds < 120 else "Worker heartbeat is stale.",
    }


@router.post(
    "/worker/restart",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Signal the worker to restart and reset all generating episodes",
)
async def restart_worker(
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Set a restart signal in Redis and reset all generating episodes to failed.

    The worker polls ``worker:restart_signal`` on startup.  Setting this key
    signals that any orphaned ``generating`` episodes should be treated as
    failed so they can be retried manually.
    """
    redis = get_arq_pool()

    # Signal the worker to restart (TTL of 5 minutes — long enough for a cold restart)
    await redis.set("worker:restart_signal", "1", ex=300)

    # Reset all generating episodes to failed so they are not stuck
    ep_repo = EpisodeRepository(db)
    job_repo = GenerationJobRepository(db)

    generating_episodes = await ep_repo.get_by_status("generating", limit=500)
    reset_count = 0

    for episode in generating_episodes:
        jobs = await job_repo.get_by_episode(episode.id)
        for job in jobs:
            if job.status in ("running", "queued"):
                await job_repo.update_status(
                    job.id,
                    "failed",
                    error_message="Reset by worker restart signal",
                )
        await ep_repo.update_status(episode.id, "failed")
        reset_count += 1

    await db.commit()

    logger.info("worker_restart_signalled", reset_episodes=reset_count)
    return {
        "message": f"Worker restart signalled. Reset {reset_count} generating episode(s) to failed.",
        "reset_episodes": reset_count,
        "restart_signal_set": True,
    }


# ── Cancel a single job ──────────────────────────────────────────────────


@router.post(
    "/{job_id}/cancel",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Cancel a specific generation job",
)
async def cancel_job(
    job_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Cancel a specific generation job.

    Marks the job as failed with "Cancelled by user".  If no other running
    or queued jobs remain for the same episode, the episode is also marked
    as failed and a Redis cancel flag is set.
    """
    job_repo = GenerationJobRepository(db)
    ep_repo = EpisodeRepository(db)
    redis = get_arq_pool()

    job = await job_repo.get_by_id(job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Generation job {job_id} not found",
        )

    if job.status not in ("running", "queued"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Job is in '{job.status}' status. Only running or queued jobs can be cancelled.",
        )

    # Mark this job as failed.
    await job_repo.update_status(job.id, "failed", error_message="Cancelled by user")

    # Check if there are other running/queued jobs for this episode.
    episode_jobs = await job_repo.get_by_episode(job.episode_id)
    remaining_active = [
        j for j in episode_jobs if j.id != job.id and j.status in ("running", "queued")
    ]

    episode_cancelled = False
    if not remaining_active:
        # No other active jobs — cancel the episode too.
        await redis.set(f"cancel:{job.episode_id}", "1", ex=3600)
        episode = await ep_repo.get_by_id(job.episode_id)
        if episode is not None and episode.status == "generating":
            await ep_repo.update_status(job.episode_id, "failed")
            episode_cancelled = True

        # Broadcast cancellation via WebSocket.
        from shortsfactory.schemas.progress import ProgressMessage

        cancel_msg = ProgressMessage(
            episode_id=str(job.episode_id),
            job_id=str(job.id),
            step=job.step,  # type: ignore[arg-type]
            status="failed",
            progress_pct=0,
            message="Job cancelled by user",
            error="Cancelled by user",
        )
        channel = f"progress:{job.episode_id}"
        try:
            await redis.publish(channel, cancel_msg.model_dump_json())
        except Exception:
            logger.debug(
                "cancel_job_broadcast_failed",
                job_id=str(job_id),
                exc_info=True,
            )

    await db.commit()

    logger.info(
        "job_cancelled",
        job_id=str(job_id),
        episode_id=str(job.episode_id),
        episode_cancelled=episode_cancelled,
    )
    return {
        "message": f"Job {job_id} cancelled",
        "job_id": str(job_id),
        "episode_id": str(job.episode_id),
        "episode_cancelled": episode_cancelled,
    }


# ── List jobs ─────────────────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[GenerationJobListResponse],
    status_code=status.HTTP_200_OK,
    summary="List generation jobs (filter by status, episode_id)",
)
async def list_jobs(
    episode_id: UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
) -> list[GenerationJobListResponse]:
    """List generation jobs, optionally filtered by episode and/or status."""
    repo = GenerationJobRepository(db)

    if episode_id is not None:
        jobs = await repo.get_by_episode(episode_id)
        # Apply status filter in-memory if both filters are provided.
        if status_filter is not None:
            jobs = [j for j in jobs if j.status == status_filter]
        jobs = jobs[:limit]
    elif status_filter == "failed":
        jobs = await repo.get_failed_jobs(limit=limit)
    elif status_filter in ("queued", "running"):
        jobs = await repo.get_active_jobs(limit=limit)
        if status_filter:
            jobs = [j for j in jobs if j.status == status_filter]
    else:
        jobs = await repo.get_all(limit=limit)

    return [GenerationJobListResponse.model_validate(j) for j in jobs]


# ── Get job detail ────────────────────────────────────────────────────────


@router.get(
    "/{job_id}",
    response_model=GenerationJobResponse,
    status_code=status.HTTP_200_OK,
    summary="Get generation job detail",
)
async def get_job(
    job_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> GenerationJobResponse:
    """Fetch a single generation job by ID."""
    repo = GenerationJobRepository(db)
    job = await repo.get_by_id(job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Generation job {job_id} not found",
        )
    return GenerationJobResponse.model_validate(job)
