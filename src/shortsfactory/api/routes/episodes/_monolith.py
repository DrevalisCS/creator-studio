"""Episodes API router -- CRUD, generation, retry, script management, and export."""

from __future__ import annotations

import asyncio
import io
import re
import zipfile
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

import structlog
from arq.connections import ArqRedis
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from shortsfactory.core.config import Settings
from shortsfactory.core.deps import get_db, get_redis, get_settings
from shortsfactory.core.redis import get_arq_pool
from shortsfactory.core.security import decrypt_value
from shortsfactory.models.episode import Episode
from shortsfactory.repositories.comfyui import ComfyUIServerRepository
from shortsfactory.repositories.episode import EpisodeRepository
from shortsfactory.repositories.generation_job import GenerationJobRepository
from shortsfactory.repositories.media_asset import MediaAssetRepository
from shortsfactory.schemas.episode import (
    BulkGenerateRequest,
    BulkGenerateResponse,
    EpisodeCreate,
    EpisodeListResponse,
    EpisodeResponse,
    EpisodeUpdate,
    GenerateRequest,
    GenerateResponse,
    RetryResponse,
    ScriptUpdate,
    SetMusicRequest,
    VideoEditRequest,
    VideoEditResponse,
)
from shortsfactory.schemas.script import EpisodeScript
from shortsfactory.services.storage import LocalStorage

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/episodes", tags=["episodes"])

# Pipeline steps in execution order.
_PIPELINE_STEPS: list[str] = [
    "script",
    "voice",
    "scenes",
    "captions",
    "assembly",
    "thumbnail",
]

# ── Concurrency gate (DB-based) ───────────────────────────────────────────


_slot_cache: dict = {"value": None, "expires": 0.0}


async def _get_dynamic_max_slots(settings: Settings, db: AsyncSession) -> int:
    """Calculate max concurrent generation slots based on registered infrastructure.

    Base: ``settings.max_concurrent_generations`` (default 4).
    Bonus: +2 slots per additional ComfyUI server beyond the first.
    Cached for 60 seconds to avoid querying the DB on every request.
    """
    import time

    if _slot_cache["value"] is not None and time.time() < _slot_cache["expires"]:
        return _slot_cache["value"]

    base = settings.max_concurrent_generations
    result = base
    try:
        from shortsfactory.repositories.comfyui import ComfyUIServerRepository
        repo = ComfyUIServerRepository(db)
        servers = await repo.get_active_servers()
        if len(servers) > 1:
            bonus = (len(servers) - 1) * 2
            result = base + bonus
    except Exception:
        pass

    _slot_cache["value"] = result
    _slot_cache["expires"] = time.time() + 60
    return result


async def _check_generation_slots(
    ep_repo: EpisodeRepository,
    settings: Settings,
    db: AsyncSession | None = None,
) -> None:
    """Raise HTTP 429 if the maximum number of concurrent generations is reached.

    Uses a DB count of episodes with status ``"generating"`` instead of an
    in-memory counter so the check survives API restarts and works correctly
    across separate worker processes.

    The max slots scale dynamically with registered ComfyUI servers.
    """
    if db is not None:
        max_slots = await _get_dynamic_max_slots(settings, db)
    else:
        max_slots = settings.max_concurrent_generations

    generating_count = await ep_repo.count_by_status("generating")
    if generating_count >= max_slots:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Maximum concurrent generations ({max_slots}) reached. "
            "Please wait for existing jobs to complete.",
        )


# ── Helper: build EpisodeResponse with relations ─────────────────────────


def _episode_to_response(episode) -> EpisodeResponse:
    """Convert an Episode ORM object (with relations loaded) to a response."""
    return EpisodeResponse.model_validate(episode)


def _episode_to_list(episode) -> EpisodeListResponse:
    """Convert an Episode ORM object to a list response."""
    return EpisodeListResponse.model_validate(episode)


# ── Recent episodes (must be before /{episode_id} to avoid path conflict) ─


@router.get(
    "/recent",
    response_model=list[EpisodeListResponse],
    status_code=status.HTTP_200_OK,
    summary="Recent episodes across all series",
)
async def list_recent_episodes(
    limit: int = Query(default=10, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
) -> list[EpisodeListResponse]:
    """Return the most recently created episodes across all series."""
    repo = EpisodeRepository(db)
    episodes = await repo.get_recent(limit=limit)
    return [_episode_to_list(ep) for ep in episodes]


# ── List episodes ─────────────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[EpisodeListResponse],
    status_code=status.HTTP_200_OK,
    summary="List episodes (filter by series_id, status)",
)
async def list_episodes(
    series_id: UUID | None = Query(default=None),
    status_filter: Literal[
        "draft", "generating", "review", "editing", "exported", "failed"
    ]
    | None = Query(default=None, alias="status"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
) -> list[EpisodeListResponse]:
    """List episodes, optionally filtered by series and/or status."""
    repo = EpisodeRepository(db)

    if series_id is not None:
        episodes = await repo.get_by_series(
            series_id=series_id,
            status_filter=status_filter,
            offset=offset,
            limit=limit,
        )
    elif status_filter is not None:
        episodes = await repo.get_by_status(status=status_filter, limit=limit)
    else:
        episodes = await repo.get_all(offset=offset, limit=limit)

    return [_episode_to_list(ep) for ep in episodes]


# ── Create episode ────────────────────────────────────────────────────────


@router.post(
    "",
    response_model=EpisodeResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new episode (draft status)",
)
async def create_episode(
    payload: EpisodeCreate,
    db: AsyncSession = Depends(get_db),
) -> EpisodeResponse:
    """Create a new episode in draft status."""
    repo = EpisodeRepository(db)
    episode = await repo.create(
        series_id=payload.series_id,
        title=payload.title,
        topic=payload.topic,
        status="draft",
    )
    await db.commit()
    await db.refresh(episode)
    # Re-fetch with relations for a full response.
    full = await repo.get_with_assets(episode.id)
    return _episode_to_response(full)


# ── Bulk generate ─────────────────────────────────────────────────────────


@router.post(
    "/bulk-generate",
    response_model=BulkGenerateResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Enqueue generation for multiple episodes at once",
    description=(
        "Accepts a list of episode UUIDs and enqueues the full generation pipeline "
        "for each one that is in ``draft`` or ``failed`` status. Episodes in any "
        "other status, or those that would exceed the concurrency cap, are silently "
        "skipped and reported in the ``skipped_ids`` list."
    ),
)
async def bulk_generate(
    payload: BulkGenerateRequest,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> BulkGenerateResponse:
    """Enqueue the full generation pipeline for each eligible episode.

    Only episodes with ``draft`` or ``failed`` status are eligible. The
    concurrency gate is applied per-episode: once ``MAX_CONCURRENT_GENERATIONS``
    is reached, remaining episodes are skipped rather than raising an error.
    This allows partial-success bulk submissions.

    Args:
        payload: Request body containing a list of up to 100 episode UUIDs.
        db: Injected async database session.
        settings: Injected application settings.

    Returns:
        A summary with counts and IDs for both queued and skipped episodes.
    """
    ep_repo = EpisodeRepository(db)
    job_repo = GenerationJobRepository(db)
    arq = get_arq_pool()

    queued_ids: list[UUID] = []
    skipped_ids: list[UUID] = []

    # Batch-query all episodes at once instead of N individual queries
    from sqlalchemy import select as sa_select
    result = await db.execute(
        sa_select(Episode).where(Episode.id.in_(payload.episode_ids))
    )
    episodes_by_id = {ep.id: ep for ep in result.scalars().all()}

    for episode_id in payload.episode_ids:
        episode = episodes_by_id.get(episode_id)

        # Skip episodes that don't exist or aren't in a re-generatable status.
        if episode is None or episode.status not in ("draft", "failed"):
            skipped_ids.append(episode_id)
            continue

        # Check the concurrency cap individually so the loop can continue past
        # the limit rather than aborting the entire batch.
        generating_count = await ep_repo.count_by_status("generating")
        if generating_count >= settings.max_concurrent_generations:
            skipped_ids.append(episode_id)
            continue

        # Create per-step GenerationJob rows.
        for step in _PIPELINE_STEPS:
            await job_repo.create(
                episode_id=episode_id,
                step=step,
                status="queued",
            )

        await ep_repo.update_status(episode_id, "generating")

        await arq.enqueue_job("generate_episode", str(episode_id))
        queued_ids.append(episode_id)
        logger.info("bulk_generate_enqueued", episode_id=str(episode_id))

    # Single commit for all job records
    await db.commit()

    return BulkGenerateResponse(
        queued=len(queued_ids),
        skipped=len(skipped_ids),
        total=len(payload.episode_ids),
        queued_ids=queued_ids,
        skipped_ids=skipped_ids,
    )


# ── Get episode detail ────────────────────────────────────────────────────


@router.get(
    "/{episode_id}",
    response_model=EpisodeResponse,
    status_code=status.HTTP_200_OK,
    summary="Get episode with assets and jobs",
)
async def get_episode(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> EpisodeResponse:
    """Fetch a single episode by ID with media assets and generation jobs."""
    repo = EpisodeRepository(db)
    episode = await repo.get_with_assets(episode_id)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )
    return _episode_to_response(episode)


# ── Update episode ────────────────────────────────────────────────────────


@router.put(
    "/{episode_id}",
    response_model=EpisodeResponse,
    status_code=status.HTTP_200_OK,
    summary="Update an episode",
)
async def update_episode(
    episode_id: UUID,
    payload: EpisodeUpdate,
    db: AsyncSession = Depends(get_db),
) -> EpisodeResponse:
    """Update an existing episode. Only provided (non-None) fields are changed."""
    repo = EpisodeRepository(db)
    update_data = payload.model_dump(exclude_unset=True)

    # Validate script if provided.
    if "script" in update_data and update_data["script"] is not None:
        try:
            EpisodeScript.model_validate(update_data["script"])
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid script format: {exc}",
            )

    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No fields to update",
        )

    episode = await repo.update(episode_id, **update_data)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )
    await db.commit()
    full = await repo.get_with_assets(episode.id)
    return _episode_to_response(full)


# ── Delete episode ────────────────────────────────────────────────────────


@router.delete(
    "/{episode_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an episode and cleanup files",
)
async def delete_episode(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> None:
    """Delete an episode, its generation jobs, media assets, and storage files."""
    repo = EpisodeRepository(db)
    episode = await repo.get_by_id(episode_id)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )

    # Clean up files on disk.
    storage = LocalStorage(settings.storage_base_path)
    await storage.delete_episode_dir(episode_id)

    # Delete the DB record (cascades to media_assets and generation_jobs).
    await repo.delete(episode_id)
    await db.commit()


# ── Generate episode ──────────────────────────────────────────────────────


@router.post(
    "/{episode_id}/generate",
    response_model=GenerateResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Kick off the generation pipeline",
)
async def generate_episode(
    episode_id: UUID,
    payload: GenerateRequest | None = None,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> GenerateResponse:
    """Enqueue generation jobs for the episode's pipeline steps.

    Creates a GenerationJob row per step and enqueues an arq task.
    Returns immediately with the job IDs.
    """
    # License tier: enforce daily episode quota before any DB work.
    from shortsfactory.core.license.quota import check_and_increment_episode_quota
    from shortsfactory.core.redis import get_redis as _get_redis_gen

    async for _redis in _get_redis_gen():
        await check_and_increment_episode_quota(_redis)
        break

    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )

    if episode.status not in ("draft", "failed"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Episode is in '{episode.status}' status and cannot be regenerated. "
            "Only 'draft' or 'failed' episodes can be generated.",
        )

    await _check_generation_slots(ep_repo, settings, db)

    # Determine which steps to run.
    steps = _PIPELINE_STEPS
    if payload and payload.steps:
        steps = [s for s in _PIPELINE_STEPS if s in payload.steps]

    # Create generation jobs (skip steps that already completed successfully
    # so the orchestrator preserves existing work like scripts and voice).
    job_repo = GenerationJobRepository(db)
    job_ids: list[UUID] = []
    for step in steps:
        existing = await job_repo.get_latest_by_episode_and_step(episode_id, step)
        if existing and existing.status == "done":
            continue
        job = await job_repo.create(
            episode_id=episode_id,
            step=step,
            status="queued",
        )
        job_ids.append(job.id)

    # Update episode status.
    await ep_repo.update_status(episode_id, "generating")
    await db.commit()

    # Enqueue arq job for async processing.
    arq = get_arq_pool()
    await arq.enqueue_job("generate_episode", str(episode_id))

    return GenerateResponse(
        episode_id=episode_id,
        job_ids=job_ids,
        message=f"Generation enqueued with {len(job_ids)} steps",
    )


# ── Retry from failed step ───────────────────────────────────────────────


@router.post(
    "/{episode_id}/retry",
    response_model=RetryResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Retry from the first failed step",
)
async def retry_episode(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> RetryResponse:
    """Find the first failed generation job and re-enqueue it."""
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )

    await _check_generation_slots(ep_repo, settings, db)

    job_repo = GenerationJobRepository(db)
    jobs = await job_repo.get_by_episode(episode_id)

    failed_job = None
    for job in jobs:
        if job.status == "failed":
            failed_job = job
            break

    if failed_job is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No failed jobs found for this episode",
        )

    # Reset the failed job.
    await job_repo.update_status(failed_job.id, "queued")
    failed_job.retry_count += 1
    await db.flush()

    # Update episode status.
    await ep_repo.update_status(episode_id, "generating")
    await db.commit()

    # Enqueue arq retry.
    arq = get_arq_pool()
    await arq.enqueue_job("retry_episode_step", str(episode_id), failed_job.step)

    return RetryResponse(
        episode_id=episode_id,
        job_id=failed_job.id,
        step=failed_job.step,
        message=f"Retry enqueued for step '{failed_job.step}'",
    )


# ── Retry specific step ──────────────────────────────────────────────────


@router.post(
    "/{episode_id}/retry/{step}",
    response_model=RetryResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Retry a specific pipeline step",
)
async def retry_episode_step(
    episode_id: UUID,
    step: Literal["script", "voice", "scenes", "captions", "assembly", "thumbnail"],
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> RetryResponse:
    """Re-enqueue a specific pipeline step for the episode."""
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )

    await _check_generation_slots(ep_repo, settings, db)

    job_repo = GenerationJobRepository(db)
    existing = await job_repo.get_latest_by_episode_and_step(episode_id, step)

    if existing is not None:
        # Reset the existing job.
        await job_repo.update_status(existing.id, "queued")
        existing.retry_count += 1
        await db.flush()
        job_id = existing.id
    else:
        # Create a new job for this step.
        job = await job_repo.create(
            episode_id=episode_id,
            step=step,
            status="queued",
        )
        job_id = job.id

    # Update episode status.
    await ep_repo.update_status(episode_id, "generating")
    await db.commit()

    # Enqueue arq retry.
    arq = get_arq_pool()
    await arq.enqueue_job("retry_episode_step", str(episode_id), step)

    return RetryResponse(
        episode_id=episode_id,
        job_id=job_id,
        step=step,
        message=f"Retry enqueued for step '{step}'",
    )


# ── Get episode script ───────────────────────────────────────────────────


@router.get(
    "/{episode_id}/script",
    response_model=dict | None,
    status_code=status.HTTP_200_OK,
    summary="Get just the script",
)
async def get_episode_script(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> dict | None:
    """Return the script JSONB field for an episode."""
    repo = EpisodeRepository(db)
    episode = await repo.get_by_id(episode_id)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )
    return episode.script


# ── Update episode script ────────────────────────────────────────────────


@router.put(
    "/{episode_id}/script",
    response_model=dict,
    status_code=status.HTTP_200_OK,
    summary="Update the script",
)
async def update_episode_script(
    episode_id: UUID,
    payload: ScriptUpdate,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Validate and persist a new script for the episode."""
    # Validate against EpisodeScript schema.
    try:
        EpisodeScript.model_validate(payload.script)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid script format: {exc}",
        )

    repo = EpisodeRepository(db)
    episode = await repo.update(episode_id, script=payload.script)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )
    await db.commit()
    return episode.script


# ── Update a single scene ─────────────────────────────────────────────


@router.put(
    "/{episode_id}/scenes/{scene_number}",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Update a single scene in the episode script",
)
async def update_scene(
    episode_id: UUID,
    scene_number: int,
    payload: dict[str, Any],
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Modify fields of a specific scene within the episode's script JSONB.

    Accepted payload keys: ``narration``, ``visual_prompt``,
    ``duration_seconds``, ``keywords``.  Only provided keys are changed.
    """
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if not episode or not episode.script:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found or has no script",
        )

    script = EpisodeScript.model_validate(episode.script)
    scene_idx = next(
        (i for i, s in enumerate(script.scenes) if s.scene_number == scene_number),
        None,
    )
    if scene_idx is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Scene {scene_number} not found",
        )

    scene = script.scenes[scene_idx]
    if "narration" in payload:
        scene.narration = payload["narration"]
    if "visual_prompt" in payload:
        scene.visual_prompt = payload["visual_prompt"]
    if "duration_seconds" in payload:
        scene.duration_seconds = payload["duration_seconds"]
    if "keywords" in payload:
        scene.keywords = payload["keywords"]

    # Recalculate total duration.
    script.total_duration_seconds = sum(s.duration_seconds for s in script.scenes)

    episode.script = script.model_dump()
    await db.commit()

    logger.info(
        "scene_updated",
        episode_id=str(episode_id),
        scene_number=scene_number,
        updated_fields=[k for k in payload if k in ("narration", "visual_prompt", "duration_seconds", "keywords")],
    )
    return {"message": f"Scene {scene_number} updated", "scene": scene.model_dump()}


# ── Delete a scene ────────────────────────────────────────────────────


@router.delete(
    "/{episode_id}/scenes/{scene_number}",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Remove a scene from the episode script",
)
async def delete_scene(
    episode_id: UUID,
    scene_number: int,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Delete a scene from the script and remove associated media assets."""
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if not episode or not episode.script:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found or has no script",
        )

    script = EpisodeScript.model_validate(episode.script)
    scene_idx = next(
        (i for i, s in enumerate(script.scenes) if s.scene_number == scene_number),
        None,
    )
    if scene_idx is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Scene {scene_number} not found",
        )

    if len(script.scenes) <= 1:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Cannot delete the last remaining scene",
        )

    # Remove scene from script.
    script.scenes.pop(scene_idx)

    # Renumber remaining scenes sequentially.
    for i, scene in enumerate(script.scenes):
        scene.scene_number = i + 1

    # Recalculate total duration.
    script.total_duration_seconds = sum(s.duration_seconds for s in script.scenes)

    episode.script = script.model_dump()

    # Delete associated media assets for this scene.
    asset_repo = MediaAssetRepository(db)
    deleted_count = await asset_repo.delete_by_episode_and_scene(
        episode_id, scene_number
    )

    await db.commit()

    logger.info(
        "scene_deleted",
        episode_id=str(episode_id),
        scene_number=scene_number,
        media_assets_deleted=deleted_count,
    )
    return {
        "message": f"Scene {scene_number} deleted",
        "remaining_scenes": len(script.scenes),
        "media_assets_deleted": deleted_count,
    }


# ── Reorder scenes ───────────────────────────────────────────────────


@router.post(
    "/{episode_id}/scenes/reorder",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Reorder scenes in the episode script",
)
async def reorder_scenes(
    episode_id: UUID,
    payload: dict[str, Any],
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Reorder scenes by providing the desired scene number order.

    Payload: ``{"order": [3, 1, 2, 5, 4, 6]}``

    The ``order`` array must contain exactly the same scene numbers as the
    current script (no duplicates, no missing values).
    """
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if not episode or not episode.script:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found or has no script",
        )

    order = payload.get("order")
    if not order or not isinstance(order, list):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Payload must include 'order' as a list of scene numbers",
        )

    script = EpisodeScript.model_validate(episode.script)
    current_numbers = {s.scene_number for s in script.scenes}
    order_set = set(order)

    if order_set != current_numbers or len(order) != len(script.scenes):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Order must contain exactly the current scene numbers "
                f"{sorted(current_numbers)}, got {order}"
            ),
        )

    # Build a lookup by current scene_number.
    scene_map = {s.scene_number: s for s in script.scenes}

    # Reorder and renumber.
    reordered = [scene_map[num] for num in order]
    for i, scene in enumerate(reordered):
        scene.scene_number = i + 1

    script.scenes = reordered
    episode.script = script.model_dump()
    await db.commit()

    logger.info(
        "scenes_reordered",
        episode_id=str(episode_id),
        new_order=order,
    )
    return {
        "message": "Scenes reordered",
        "order": [s.scene_number for s in script.scenes],
    }


# ── Regenerate a single scene's image ────────────────────────────────


@router.post(
    "/{episode_id}/regenerate-scene/{scene_number}",
    response_model=dict[str, Any],
    status_code=status.HTTP_202_ACCEPTED,
    summary="Regenerate a single scene's image and reassemble",
)
async def regenerate_scene(
    episode_id: UUID,
    scene_number: int,
    payload: dict[str, Any] | None = None,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Enqueue a job to regenerate a single scene's image/video.

    Optionally accepts ``{"visual_prompt": "new prompt"}`` to override
    the prompt before regenerating.  After the scene is regenerated,
    the video is automatically reassembled.
    """
    ep_repo = EpisodeRepository(db)
    await _check_generation_slots(ep_repo, settings, db)
    episode = await ep_repo.get_by_id(episode_id)
    if not episode or not episode.script:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found or has no script",
        )

    script = EpisodeScript.model_validate(episode.script)
    scene_idx = next(
        (i for i, s in enumerate(script.scenes) if s.scene_number == scene_number),
        None,
    )
    if scene_idx is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Scene {scene_number} not found",
        )

    # Optionally update the visual prompt before regenerating.
    if payload and "visual_prompt" in payload:
        script.scenes[scene_idx].visual_prompt = payload["visual_prompt"]
        episode.script = script.model_dump()
        await db.commit()

    # Create generation jobs for the scene regeneration.
    job_repo = GenerationJobRepository(db)
    scene_job = await job_repo.create(
        episode_id=episode_id,
        step="scenes",
        status="queued",
    )
    assembly_job = await job_repo.create(
        episode_id=episode_id,
        step="assembly",
        status="queued",
    )

    await ep_repo.update_status(episode_id, "generating")
    await db.commit()

    # Enqueue arq job.
    arq = get_arq_pool()
    await arq.enqueue_job(
        "regenerate_scene",
        str(episode_id),
        scene_number,
        payload.get("visual_prompt") if payload else None,
    )

    logger.info(
        "regenerate_scene_enqueued",
        episode_id=str(episode_id),
        scene_number=scene_number,
    )
    return {
        "message": f"Scene {scene_number} regeneration enqueued",
        "episode_id": str(episode_id),
        "scene_number": scene_number,
        "job_ids": [str(scene_job.id), str(assembly_job.id)],
    }


# ── Regenerate voice ─────────────────────────────────────────────────


@router.post(
    "/{episode_id}/regenerate-voice",
    response_model=dict[str, Any],
    status_code=status.HTTP_202_ACCEPTED,
    summary="Re-run voice + captions + assembly",
    description=(
        "Re-runs voice synthesis, captions, and assembly while keeping scene images. "
        "Optional query parameters allow overriding the voice profile, speed, and pitch "
        "for this regeneration without permanently changing the series configuration."
    ),
)
async def regenerate_voice(
    episode_id: UUID,
    voice_profile_id: UUID | None = Query(
        None,
        description="Override voice profile for this regeneration only",
    ),
    speed: float | None = Query(
        None,
        ge=0.5,
        le=2.0,
        description="Playback speed multiplier override (0.5–2.0)",
    ),
    pitch: float | None = Query(
        None,
        ge=-12.0,
        le=12.0,
        description="Pitch shift in semitones override (-12 to +12)",
    ),
    payload: dict[str, Any] | None = None,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Enqueue a job to re-run voice synthesis, captions, and assembly.

    Scene images are kept. Useful when changing voice profiles or editing
    narration text.

    Override precedence: query parameters take priority over the JSON body's
    ``voice_profile_id`` field, which itself takes priority over the episode's
    existing stored override.

    Args:
        episode_id: UUID of the episode to regenerate.
        voice_profile_id: Query-param override for the voice profile.
        speed: Query-param speed multiplier (stored in episode ``metadata_``).
        pitch: Query-param pitch shift in semitones (stored in episode ``metadata_``).
        payload: Optional JSON body; legacy ``voice_profile_id`` key still accepted.
        db: Injected async database session.
        settings: Injected application settings.

    Returns:
        Confirmation dict with the enqueued job IDs.

    Raises:
        HTTPException 404: if the episode does not exist or has no script.
        HTTPException 429: if the concurrency cap is reached.
    """
    ep_repo = EpisodeRepository(db)
    await _check_generation_slots(ep_repo, settings, db)
    episode = await ep_repo.get_by_id(episode_id)
    if not episode or not episode.script:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found or has no script",
        )

    # Apply voice profile override: query param wins over body field.
    resolved_vp_id: UUID | None = voice_profile_id
    if resolved_vp_id is None and payload and "voice_profile_id" in payload:
        resolved_vp_id = payload["voice_profile_id"]

    if resolved_vp_id is not None:
        await ep_repo.update(episode_id, override_voice_profile_id=resolved_vp_id)

    # Apply speed / pitch overrides into metadata_ so the TTS step can read them.
    if speed is not None or pitch is not None:
        current_meta: dict[str, Any] = (
            dict(episode.metadata_) if episode.metadata_ else {}
        )
        tts_overrides: dict[str, Any] = dict(current_meta.get("tts_overrides", {}))
        if speed is not None:
            tts_overrides["speed"] = speed
        if pitch is not None:
            tts_overrides["pitch"] = pitch
        current_meta["tts_overrides"] = tts_overrides
        await ep_repo.update(episode_id, metadata_=current_meta)

    # Create generation jobs for the steps that will be re-run.
    job_repo = GenerationJobRepository(db)
    job_ids: list[UUID] = []
    for step in ("voice", "captions", "assembly", "thumbnail"):
        job = await job_repo.create(
            episode_id=episode_id,
            step=step,
            status="queued",
        )
        job_ids.append(job.id)

    await ep_repo.update_status(episode_id, "generating")
    await db.commit()

    arq = get_arq_pool()
    await arq.enqueue_job("regenerate_voice", str(episode_id))

    logger.info("regenerate_voice_enqueued", episode_id=str(episode_id))
    return {
        "message": "Voice regeneration enqueued (voice + captions + assembly + thumbnail)",
        "episode_id": str(episode_id),
        "job_ids": [str(j) for j in job_ids],
    }


# ── Reassemble ───────────────────────────────────────────────────────


@router.post(
    "/{episode_id}/reassemble",
    response_model=dict[str, Any],
    status_code=status.HTTP_202_ACCEPTED,
    summary="Re-run captions + assembly + thumbnail",
)
async def reassemble(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Enqueue a job to re-run captions, assembly, and thumbnail extraction.

    Voice and scene assets are kept.  Useful after reordering scenes
    or editing captions style.
    """
    ep_repo = EpisodeRepository(db)
    await _check_generation_slots(ep_repo, settings, db)
    episode = await ep_repo.get_by_id(episode_id)
    if not episode or not episode.script:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found or has no script",
        )

    # Create generation jobs for the steps that will be re-run.
    job_repo = GenerationJobRepository(db)
    job_ids: list[UUID] = []
    for step in ("captions", "assembly", "thumbnail"):
        job = await job_repo.create(
            episode_id=episode_id,
            step=step,
            status="queued",
        )
        job_ids.append(job.id)

    await ep_repo.update_status(episode_id, "generating")
    await db.commit()

    arq = get_arq_pool()
    await arq.enqueue_job("reassemble_episode", str(episode_id))

    logger.info("reassemble_enqueued", episode_id=str(episode_id))
    return {
        "message": "Reassembly enqueued (captions + assembly + thumbnail)",
        "episode_id": str(episode_id),
        "job_ids": [str(j) for j in job_ids],
    }


# ── Regenerate captions ───────────────────────────────────────────────────


@router.post(
    "/{episode_id}/regenerate-captions",
    response_model=dict[str, Any],
    status_code=status.HTTP_202_ACCEPTED,
    summary="Change caption style and reassemble",
    description=(
        "Stores the requested caption style preset on the episode as an override, "
        "then enqueues a reassembly job (captions + assembly + thumbnail). "
        "Voice audio and scene images are kept. "
        "Valid preset names match those understood by the CaptionService "
        "(e.g. ``youtube_highlight``, ``minimal``, ``karaoke``)."
    ),
)
async def regenerate_captions(
    episode_id: UUID,
    caption_style: str = Query(
        "youtube_highlight",
        description="Caption style preset name to apply before reassembling",
    ),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Store a new caption style override and enqueue reassembly.

    This is a focused variant of ``/reassemble`` that also sets the caption
    style in a single request, removing the need for a separate ``PUT`` call.

    Args:
        episode_id: UUID of the episode to update.
        caption_style: Name of the caption preset to apply.
        db: Injected async database session.
        settings: Injected application settings.

    Returns:
        Confirmation dict with the enqueued job IDs and the applied style.

    Raises:
        HTTPException 404: if the episode does not exist or has no script.
        HTTPException 429: if the concurrency cap is reached.
    """
    ep_repo = EpisodeRepository(db)
    await _check_generation_slots(ep_repo, settings, db)
    episode = await ep_repo.get_by_id(episode_id)
    if not episode or not episode.script:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found or has no script",
        )

    # Persist the caption style override on the episode record.
    await ep_repo.update(episode_id, override_caption_style=caption_style)

    # Create generation jobs for the downstream steps.
    job_repo = GenerationJobRepository(db)
    job_ids: list[UUID] = []
    for step in ("captions", "assembly", "thumbnail"):
        job = await job_repo.create(
            episode_id=episode_id,
            step=step,
            status="queued",
        )
        job_ids.append(job.id)

    await ep_repo.update_status(episode_id, "generating")
    await db.commit()

    arq = get_arq_pool()
    await arq.enqueue_job("reassemble_episode", str(episode_id))

    logger.info(
        "regenerate_captions_enqueued",
        episode_id=str(episode_id),
        caption_style=caption_style,
    )
    return {
        "message": f"Caption style '{caption_style}' applied; reassembly enqueued",
        "episode_id": str(episode_id),
        "caption_style": caption_style,
        "job_ids": [str(j) for j in job_ids],
    }


# ── Cost estimation ─────────────────────────────────────────────────


@router.post(
    "/{episode_id}/estimate-cost",
    status_code=status.HTTP_200_OK,
    summary="Estimate generation cost for an episode",
)
async def estimate_cost(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict:
    """Estimate TTS cost and duration for generating this episode.

    Useful before long-form generation to show expected cost.
    """
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if episode is None:
        raise HTTPException(404, f"Episode {episode_id} not found")

    from shortsfactory.repositories.series import SeriesRepository

    series = await SeriesRepository(db).get_by_id(episode.series_id)
    content_format = getattr(episode, "content_format", "shorts")
    script = episode.script or {}
    scenes = script.get("scenes", [])

    total_chars = sum(len(s.get("narration", "")) for s in scenes)
    estimated_minutes = round(total_chars / 900, 1)  # ~150 wpm, ~6 chars/word

    # ElevenLabs pricing: ~$0.15 per 1000 chars (rough estimate)
    voice_profile_id = None
    if series:
        voice_profile_id = series.voice_profile_id
    provider = "unknown"
    if voice_profile_id:
        from shortsfactory.repositories.voice_profile import VoiceProfileRepository
        vp = await VoiceProfileRepository(db).get_by_id(voice_profile_id)
        if vp:
            provider = vp.provider

    cost_per_1k = 0.15 if "elevenlabs" in provider else 0.0
    estimated_cost = round(total_chars / 1000 * cost_per_1k, 2)

    return {
        "content_format": content_format,
        "scene_count": len(scenes),
        "total_characters": total_chars,
        "estimated_duration_minutes": estimated_minutes,
        "estimated_tts_cost_usd": estimated_cost,
        "provider": provider,
    }


# ── Duplicate episode ────────────────────────────────────────────────


@router.post(
    "/{episode_id}/duplicate",
    response_model=EpisodeResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Duplicate an episode as a new draft",
)
async def duplicate_episode(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> EpisodeResponse:
    """Create a copy of the episode with ``draft`` status and the same script.

    The duplicate retains the script, title, topic, and per-episode
    overrides but none of the media assets or generation jobs.
    """
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )

    new_episode = await ep_repo.create(
        series_id=episode.series_id,
        title=f"{episode.title} (copy)",
        topic=episode.topic,
        status="draft",
        script=episode.script,
        override_voice_profile_id=episode.override_voice_profile_id,
        override_llm_config_id=episode.override_llm_config_id,
    )
    await db.commit()
    await db.refresh(new_episode)

    full = await ep_repo.get_with_assets(new_episode.id)

    logger.info(
        "episode_duplicated",
        source_episode_id=str(episode_id),
        new_episode_id=str(new_episode.id),
    )
    return _episode_to_response(full)


# ── Reset to draft ───────────────────────────────────────────────────


@router.post(
    "/{episode_id}/reset",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Reset episode to draft status",
)
async def reset_episode(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Reset the episode to ``draft`` status, clearing all generation jobs.

    Media assets are preserved so the user can review them or delete
    them separately.
    """
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )

    # Bulk delete all generation jobs for this episode.
    from shortsfactory.models.generation_job import GenerationJob
    from sqlalchemy import delete as sa_delete, func as sa_func, select as sa_select_count

    count_result = await db.execute(
        sa_select_count(sa_func.count()).select_from(GenerationJob).where(
            GenerationJob.episode_id == episode_id
        )
    )
    deleted_jobs = count_result.scalar() or 0
    await db.execute(
        sa_delete(GenerationJob).where(GenerationJob.episode_id == episode_id)
    )

    # Reset status to draft.
    await ep_repo.update_status(episode_id, "draft")
    await db.commit()

    logger.info(
        "episode_reset",
        episode_id=str(episode_id),
        jobs_deleted=deleted_jobs,
    )
    return {
        "message": "Episode reset to draft",
        "episode_id": str(episode_id),
        "jobs_deleted": deleted_jobs,
    }


# ── Cancel generation ───────────────────────────────────────────────


@router.post(
    "/{episode_id}/cancel",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Cancel a generating episode",
)
async def cancel_episode(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Cancel an in-progress generation for the episode.

    Sets a cancel flag in Redis that the pipeline checks between steps.
    Marks all running/queued jobs as failed and updates the episode
    status to ``failed``.
    """
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )

    if episode.status != "generating":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Episode is in '{episode.status}' status, not 'generating'. "
            "Only generating episodes can be cancelled.",
        )

    # Set cancel flag in Redis so the pipeline checks it between steps.
    redis = get_arq_pool()
    await redis.set(f"cancel:{episode_id}", "1", ex=3600)

    # Mark all running/queued jobs as failed with cancellation message.
    job_repo = GenerationJobRepository(db)
    jobs = await job_repo.get_by_episode(episode_id)
    cancelled_jobs = 0
    for job in jobs:
        if job.status in ("running", "queued"):
            await job_repo.update_status(job.id, "failed", error_message="Cancelled by user")
            cancelled_jobs += 1

    # Update episode status.
    await ep_repo.update_status(episode_id, "failed")
    await db.commit()

    # Broadcast cancellation via WebSocket so the frontend updates immediately.
    from shortsfactory.schemas.progress import ProgressMessage

    cancel_msg = ProgressMessage(
        episode_id=str(episode_id),
        job_id="",
        step="script",
        status="failed",
        progress_pct=0,
        message="Generation cancelled by user",
        error="Cancelled by user",
    )
    channel = f"progress:{episode_id}"
    try:
        await redis.publish(channel, cancel_msg.model_dump_json())
    except Exception:
        logger.debug("cancel_broadcast_failed", episode_id=str(episode_id), exc_info=True)

    logger.info(
        "episode_cancelled",
        episode_id=str(episode_id),
        cancelled_jobs=cancelled_jobs,
    )
    return {
        "message": "Episode generation cancelled",
        "episode_id": str(episode_id),
        "cancelled_jobs": cancelled_jobs,
    }


# ── Music tab endpoints ───────────────────────────────────────────────────

# Maximum AceStep generation duration in seconds (AceStep hard cap).
_ACESTEP_MAX_DURATION_SECONDS: float = 120.0

# Audio extensions scanned when listing music tracks for an episode.
_AUDIO_EXTENSIONS: tuple[str, ...] = (".mp3", ".wav", ".ogg", ".flac")


async def _ffprobe_duration(path: Path, ffprobe_exe: str = "ffprobe") -> float:
    """Return the duration of an audio/video file in seconds via ffprobe.

    Args:
        path: Absolute path to the audio file.
        ffprobe_exe: Name or path of the ffprobe binary.

    Returns:
        Duration in seconds, or 0.0 if ffprobe fails or the file has no
        parseable duration.
    """
    cmd = [
        ffprobe_exe,
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    if proc.returncode != 0:
        return 0.0
    try:
        return float(stdout.decode().strip())
    except ValueError:
        return 0.0


@router.get(
    "/{episode_id}/music/moods",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="List available music mood options",
    description=(
        "Returns the full set of mood keywords understood by the AceStep music "
        "generator, with human-readable labels and truncated tag descriptions."
    ),
)
async def list_music_moods(episode_id: UUID) -> dict[str, Any]:
    """Return the static mood catalogue from the music service.

    The ``episode_id`` path parameter is accepted for URL consistency with the
    other music endpoints but is not used — moods are global, not per-episode.
    """
    from shortsfactory.services.music import _MOOD_TAGS

    moods = [
        {
            "value": key,
            "label": key.replace("_", " ").title(),
            "description": tags[:80],
        }
        for key, tags in _MOOD_TAGS.items()
    ]
    return {"moods": moods}


@router.get(
    "/{episode_id}/music",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="List available music tracks for an episode",
    description=(
        "Scans ``storage/episodes/{episode_id}/music/`` and "
        "``storage/music/generated/`` for audio files and returns their "
        "relative paths and ffprobe-measured durations."
    ),
)
async def list_episode_music(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """List all music tracks available for the given episode.

    Two directories are scanned:

    1. ``storage/episodes/{episode_id}/music/`` -- tracks generated
       specifically for this episode.
    2. ``storage/music/generated/`` -- tracks generated for other episodes
       that are available for reuse (organised by mood subdirectory).

    Each entry contains the relative storage path so the frontend can
    construct the static-file URL as ``/storage/{relative_path}``.
    """
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )

    base = settings.storage_base_path
    tracks: list[dict[str, Any]] = []

    # 1. Episode-specific music directory.
    episode_music_dir = base / "episodes" / str(episode_id) / "music"
    if episode_music_dir.exists():
        for audio_file in sorted(episode_music_dir.iterdir()):
            if audio_file.suffix.lower() in _AUDIO_EXTENSIONS:
                relative = f"episodes/{episode_id}/music/{audio_file.name}"
                duration = await _ffprobe_duration(audio_file)
                # Derive mood from filename prefix (e.g. "epic_1234.mp3" -> "epic").
                mood_guess = audio_file.stem.split("_")[0] if "_" in audio_file.stem else ""
                tracks.append(
                    {
                        "filename": audio_file.name,
                        "path": relative,
                        "mood": mood_guess,
                        "duration": duration,
                        "source": "episode",
                    }
                )

    # 2. Shared generated library (mood subdirectories).
    generated_dir = base / "music" / "generated"
    if generated_dir.exists():
        for mood_dir in sorted(generated_dir.iterdir()):
            if not mood_dir.is_dir():
                continue
            mood_name = mood_dir.name
            for audio_file in sorted(mood_dir.iterdir()):
                if audio_file.suffix.lower() in _AUDIO_EXTENSIONS:
                    relative = f"music/generated/{mood_name}/{audio_file.name}"
                    duration = await _ffprobe_duration(audio_file)
                    tracks.append(
                        {
                            "filename": audio_file.name,
                            "path": relative,
                            "mood": mood_name,
                            "duration": duration,
                            "source": "library",
                        }
                    )

    # Highlight currently selected track.
    selected_path: str | None = (
        episode.metadata_.get("selected_music_path")
        if episode.metadata_
        else None
    )

    return {
        "episode_id": str(episode_id),
        "tracks": tracks,
        "selected_path": selected_path,
    }


@router.post(
    "/{episode_id}/music/generate",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Generate a background music track via AceStep / ComfyUI",
    description=(
        "Submits an AceStep 1.5 workflow to the first active ComfyUI server, "
        "polls for completion, downloads the resulting MP3, and saves it to "
        "``storage/episodes/{episode_id}/music/``.  Returns the relative path "
        "and measured duration of the new track."
    ),
)
async def generate_episode_music(
    episode_id: UUID,
    payload: dict[str, Any],
    db: AsyncSession = Depends(get_db),
    redis: ArqRedis = Depends(get_redis),
) -> dict[str, Any]:
    """Enqueue music generation as a background job.

    The actual generation runs in the arq worker to avoid blocking
    a uvicorn worker for up to 10 minutes.
    """
    # Validate episode exists
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if episode is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Episode {episode_id} not found")

    # Validate request body
    mood = payload.get("mood")
    if not mood or not isinstance(mood, str):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="'mood' is required and must be a non-empty string.")
    mood = mood.lower().strip()

    raw_duration = payload.get("duration", 30)
    try:
        duration_seconds = float(raw_duration)
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="'duration' must be a number (seconds).")
    if not (1.0 <= duration_seconds <= _ACESTEP_MAX_DURATION_SECONDS):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"'duration' must be between 1 and {int(_ACESTEP_MAX_DURATION_SECONDS)} seconds.",
        )

    # Enqueue background job
    from shortsfactory.workers.jobs.music import generate_episode_music as music_job
    await redis.enqueue_job(
        "generate_episode_music",
        str(episode_id),
        mood,
        duration_seconds,
    )

    return {"status": "queued", "message": "Music generation started in background"}


@router.post(
    "/{episode_id}/music/select",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Select a music track for the episode's next assembly",
    description=(
        "Persists ``selected_music_path`` in the episode's ``metadata_`` JSONB "
        "field.  The pipeline's assembly step reads this field and uses the "
        "specified track instead of auto-generating music."
    ),
)
async def select_episode_music(
    episode_id: UUID,
    payload: dict[str, Any],
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Store the user's chosen music track on the episode record.

    Args:
        episode_id: UUID of the episode to update.
        payload: JSON body with ``music_path`` key (relative to storage base,
            e.g. ``"episodes/{id}/music/epic_1234.mp3"``).  Pass ``null`` to
            clear the selection.
        db: Injected async database session.
        settings: Injected application settings.

    Returns:
        Confirmation dict with ``episode_id`` and ``selected_music_path``.

    Raises:
        HTTPException 400: if ``music_path`` is missing from the payload.
        HTTPException 404: if the episode does not exist or the specified file
            is not found on disk.
    """
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )

    if "music_path" not in payload:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="'music_path' is required (pass null to clear the selection).",
        )

    music_path: str | None = payload["music_path"]

    if music_path is not None:
        # Validate the referenced file actually exists on disk.
        resolved = settings.storage_base_path / music_path
        if not resolved.exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Music file not found at storage path '{music_path}'.",
            )

    # Merge into the existing metadata_ JSONB without overwriting other keys.
    current_meta: dict[str, Any] = dict(episode.metadata_) if episode.metadata_ else {}
    if music_path is None:
        current_meta.pop("selected_music_path", None)
    else:
        current_meta["selected_music_path"] = music_path

    await ep_repo.update(episode_id, metadata_=current_meta)
    await db.commit()

    logger.info(
        "music_selected",
        episode_id=str(episode_id),
        selected_music_path=music_path,
    )

    return {
        "episode_id": str(episode_id),
        "selected_music_path": music_path,
        "message": (
            f"Music track selected: {music_path}"
            if music_path
            else "Music selection cleared"
        ),
    }


# ── Set music settings ────────────────────────────────────────────────────


@router.post(
    "/{episode_id}/set-music",
    response_model=dict[str, Any],
    status_code=status.HTTP_202_ACCEPTED,
    summary="Configure background music and optionally reassemble",
    description=(
        "Stores ``music_enabled``, ``music_mood``, and ``music_volume_db`` in the "
        "episode's ``metadata_`` JSONB under the ``music_settings`` key. "
        "When ``reassemble`` is ``true`` (the default), a reassembly job is also "
        "enqueued so the change takes effect immediately in the output video."
    ),
)
async def set_music(
    episode_id: UUID,
    payload: SetMusicRequest,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Store music configuration on the episode and optionally trigger reassembly.

    Only fields explicitly provided in the request body are stored. Existing
    ``metadata_`` keys outside of ``music_settings`` are preserved.

    Args:
        episode_id: UUID of the episode to configure.
        payload: Music settings and optional reassembly flag.
        db: Injected async database session.
        settings: Injected application settings.

    Returns:
        Confirmation dict including the persisted music settings and,
        if reassembly was triggered, the enqueued job IDs.

    Raises:
        HTTPException 404: if the episode does not exist.
        HTTPException 429: if reassembly was requested but the concurrency cap
            is reached.
    """
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )

    # Build the music_settings dict from explicitly provided fields.
    music_settings: dict[str, Any] = {"music_enabled": payload.music_enabled}
    if payload.music_mood is not None:
        music_settings["music_mood"] = payload.music_mood
    if payload.music_volume_db is not None:
        music_settings["music_volume_db"] = payload.music_volume_db

    # Merge into existing metadata_, preserving unrelated keys.
    current_meta: dict[str, Any] = dict(episode.metadata_) if episode.metadata_ else {}
    current_meta["music_settings"] = music_settings

    await ep_repo.update(episode_id, metadata_=current_meta)
    await db.commit()

    logger.info(
        "music_settings_updated",
        episode_id=str(episode_id),
        music_settings=music_settings,
    )

    response: dict[str, Any] = {
        "episode_id": str(episode_id),
        "music_settings": music_settings,
        "message": "Music settings saved",
    }

    if not payload.reassemble:
        return response

    # Trigger reassembly so the new music settings are applied to the video.
    await _check_generation_slots(ep_repo, settings, db)

    if not episode.script:
        # No script yet — store the settings but skip reassembly silently.
        response["message"] = (
            "Music settings saved; reassembly skipped (episode has no script)"
        )
        return response

    job_repo = GenerationJobRepository(db)
    job_ids: list[UUID] = []
    for step in ("captions", "assembly", "thumbnail"):
        job = await job_repo.create(
            episode_id=episode_id,
            step=step,
            status="queued",
        )
        job_ids.append(job.id)

    await ep_repo.update_status(episode_id, "generating")
    await db.commit()

    arq = get_arq_pool()
    await arq.enqueue_job("reassemble_episode", str(episode_id))

    logger.info("set_music_reassemble_enqueued", episode_id=str(episode_id))
    response["message"] = "Music settings saved; reassembly enqueued"
    response["job_ids"] = [str(j) for j in job_ids]
    return response


# ── Export helpers ────────────────────────────────────────────────────────


def _sanitize_filename(series_name: str, episode_title: str) -> str:
    """Build a filesystem-safe filename from series and episode names."""
    raw = f"{series_name}_{episode_title}"
    safe = re.sub(r"[^\w\s-]", "", raw)
    safe = re.sub(r"\s+", "_", safe.strip())
    return safe[:100] or "export"


async def _load_episode_with_series(
    episode_id: UUID, db: AsyncSession
) -> Episode:
    """Load an episode with its series relationship eagerly loaded."""
    from sqlalchemy import select

    stmt = (
        select(Episode)
        .where(Episode.id == episode_id)
        .options(selectinload(Episode.series))
    )
    result = await db.execute(stmt)
    episode = result.scalar_one_or_none()
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )
    return episode


def _build_description(episode: Episode) -> str:
    """Build a text description from the episode's script and series metadata."""
    script = None
    if episode.script:
        try:
            script = EpisodeScript.model_validate(episode.script)
        except Exception:
            pass

    lines: list[str] = []
    lines.append(script.title if script else episode.title)
    lines.append("")

    if script and script.description:
        lines.append(script.description)
        lines.append("")

    if script and script.hashtags:
        lines.append(" ".join(f"#{tag}" for tag in script.hashtags))
        lines.append("")

    series_name = episode.series.name if episode.series else "N/A"
    lines.append(f"Series: {series_name}")
    lines.append("")

    lines.append("--- Script ---")
    if script:
        for scene in script.scenes:
            lines.append(f"\n[Scene {scene.scene_number}]")
            lines.append(scene.narration)

    return "\n".join(lines)


# ── Export video ─────────────────────────────────────────────────────────


@router.get(
    "/{episode_id}/export/video",
    status_code=status.HTTP_200_OK,
    summary="Download the final video with a friendly filename",
    tags=["export"],
)
async def export_video(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> FileResponse:
    """Serve the episode's final video file with a sanitized filename."""
    episode = await _load_episode_with_series(episode_id, db)
    series_name = episode.series.name if episode.series else "Short"
    safe_name = _sanitize_filename(series_name, episode.title)

    asset_repo = MediaAssetRepository(db)
    video_assets = await asset_repo.get_by_episode_and_type(episode_id, "video")
    if not video_assets:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No video asset found for this episode",
        )

    video_path = Path(settings.storage_base_path) / video_assets[-1].file_path
    if not video_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Video file not found on disk",
        )

    logger.info("export_video", episode_id=str(episode_id), path=str(video_path))
    return FileResponse(
        path=str(video_path),
        filename=f"{safe_name}.mp4",
        media_type="video/mp4",
    )


# ── Export thumbnail ─────────────────────────────────────────────────────


@router.get(
    "/{episode_id}/export/thumbnail",
    status_code=status.HTTP_200_OK,
    summary="Download the thumbnail image with a friendly filename",
    tags=["export"],
)
async def export_thumbnail(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> FileResponse:
    """Serve the episode's thumbnail image with a sanitized filename."""
    episode = await _load_episode_with_series(episode_id, db)
    series_name = episode.series.name if episode.series else "Short"
    safe_name = _sanitize_filename(series_name, episode.title)

    asset_repo = MediaAssetRepository(db)
    thumb_assets = await asset_repo.get_by_episode_and_type(episode_id, "thumbnail")
    if not thumb_assets:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No thumbnail asset found for this episode",
        )

    thumb_path = Path(settings.storage_base_path) / thumb_assets[-1].file_path
    if not thumb_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Thumbnail file not found on disk",
        )

    logger.info("export_thumbnail", episode_id=str(episode_id), path=str(thumb_path))
    return FileResponse(
        path=str(thumb_path),
        filename=f"{safe_name}_thumbnail.jpg",
        media_type="image/jpeg",
    )


# ── Export description ───────────────────────────────────────────────────


@router.get(
    "/{episode_id}/export/description",
    status_code=status.HTTP_200_OK,
    summary="Download a text description file for the episode",
    tags=["export"],
)
async def export_description(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Generate and serve a plain-text description file with title, description,
    hashtags, series info, and full script narration."""
    episode = await _load_episode_with_series(episode_id, db)
    series_name = episode.series.name if episode.series else "Short"
    safe_name = _sanitize_filename(series_name, episode.title)

    content = _build_description(episode)

    logger.info("export_description", episode_id=str(episode_id))
    return Response(
        content=content,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}_description.txt"',
        },
    )


# ── Export bundle (ZIP) ──────────────────────────────────────────────────


@router.get(
    "/{episode_id}/export/bundle",
    status_code=status.HTTP_200_OK,
    summary="Download a ZIP bundle with video, thumbnail, description, and captions",
    tags=["export"],
)
async def export_bundle(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Create an in-memory ZIP archive containing the video, thumbnail,
    description text, and SRT captions (when available)."""
    episode = await _load_episode_with_series(episode_id, db)
    series_name = episode.series.name if episode.series else "Short"
    safe_name = _sanitize_filename(series_name, episode.title)

    asset_repo = MediaAssetRepository(db)
    base = Path(settings.storage_base_path)

    # Collect assets.
    video_assets = await asset_repo.get_by_episode_and_type(episode_id, "video")
    thumb_assets = await asset_repo.get_by_episode_and_type(episode_id, "thumbnail")
    caption_assets = await asset_repo.get_by_episode_and_type(episode_id, "caption")

    if not video_assets:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No video asset found for this episode; cannot create bundle",
        )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        # Video
        video_path = base / video_assets[-1].file_path
        if video_path.exists():
            zf.write(str(video_path), f"{safe_name}.mp4")

        # Thumbnail
        if thumb_assets:
            thumb_path = base / thumb_assets[-1].file_path
            if thumb_path.exists():
                zf.write(str(thumb_path), f"{safe_name}_thumbnail.jpg")

        # Description
        description_content = _build_description(episode)
        zf.writestr(f"{safe_name}_description.txt", description_content)

        # Captions (SRT)
        if caption_assets:
            srt_path = base / caption_assets[-1].file_path
            if srt_path.exists():
                zf.write(str(srt_path), f"{safe_name}_captions.srt")

    buffer.seek(0)

    logger.info("export_bundle", episode_id=str(episode_id), zip_size=buffer.getbuffer().nbytes)
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}_bundle.zip"',
        },
    )


# ── Video editing ─────────────────────────────────────────────────────────


@router.post(
    "/{episode_id}/edit",
    response_model=VideoEditResponse,
    status_code=status.HTTP_200_OK,
    summary="Apply video edits (trim, border, effects) and save",
)
async def edit_video(
    episode_id: UUID,
    payload: VideoEditRequest,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> VideoEditResponse:
    """Apply edits to the episode's final video.

    Backs up the original video on first edit so it can be restored via
    the ``/edit/reset`` endpoint.
    """
    from shortsfactory.services.ffmpeg import FFmpegService

    asset_repo = MediaAssetRepository(db)
    base = Path(settings.storage_base_path)

    video_assets = await asset_repo.get_by_episode_and_type(episode_id, "video")
    if not video_assets:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No video asset found for this episode",
        )

    video_asset = video_assets[-1]
    video_path = base / video_asset.file_path
    if not video_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Video file not found on disk",
        )

    # Back up original on first edit
    original_path = video_path.parent / "final_original.mp4"
    if not original_path.exists():
        import shutil
        await asyncio.to_thread(shutil.copy2, str(video_path), str(original_path))

    # Apply edits
    ffmpeg = FFmpegService(ffmpeg_path=settings.ffmpeg_path)
    edited_path = video_path.parent / "final_edited.mp4"

    await ffmpeg.apply_video_effects(
        input_path=original_path,
        output_path=edited_path,
        start_seconds=payload.trim_start,
        end_seconds=payload.trim_end,
        border_width=payload.border.width if payload.border else 0,
        border_color=payload.border.color if payload.border else "black",
        border_style=payload.border.style if payload.border else "solid",
        color_filter=payload.color_filter,
        speed=payload.speed,
    )

    # Replace the final video with the edited version
    import shutil
    await asyncio.to_thread(shutil.move, str(edited_path), str(video_path))

    # Update asset metadata
    duration = await ffmpeg.get_duration(video_path)
    file_size = video_path.stat().st_size
    await asset_repo.update(
        video_asset.id,
        file_size_bytes=file_size,
        duration_seconds=duration,
    )
    await db.commit()

    logger.info("video_edited", episode_id=str(episode_id))
    return VideoEditResponse(
        episode_id=episode_id,
        message="Video edits applied successfully",
        video_path=video_asset.file_path,
        duration_seconds=duration,
    )


@router.post(
    "/{episode_id}/edit/preview",
    response_model=VideoEditResponse,
    status_code=status.HTTP_200_OK,
    summary="Generate a low-quality preview of video edits",
)
async def edit_preview(
    episode_id: UUID,
    payload: VideoEditRequest,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> VideoEditResponse:
    """Generate a quick low-res preview with the requested edits applied."""
    from shortsfactory.services.ffmpeg import FFmpegService

    asset_repo = MediaAssetRepository(db)
    base = Path(settings.storage_base_path)

    video_assets = await asset_repo.get_by_episode_and_type(episode_id, "video")
    if not video_assets:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No video asset found for this episode",
        )

    video_path = base / video_assets[-1].file_path
    # Use the original if it exists, otherwise use the current video
    original_path = video_path.parent / "final_original.mp4"
    source_path = original_path if original_path.exists() else video_path

    preview_path = video_path.parent / "preview.mp4"
    ffmpeg = FFmpegService(ffmpeg_path=settings.ffmpeg_path)

    await ffmpeg.generate_preview(
        input_path=source_path,
        output_path=preview_path,
        start_seconds=payload.trim_start,
        end_seconds=payload.trim_end,
        border_width=payload.border.width if payload.border else 0,
        border_color=payload.border.color if payload.border else "black",
        border_style=payload.border.style if payload.border else "solid",
        color_filter=payload.color_filter,
        speed=payload.speed,
    )

    preview_relative = f"episodes/{episode_id}/output/preview.mp4"
    duration = await ffmpeg.get_duration(preview_path)

    return VideoEditResponse(
        episode_id=episode_id,
        message="Preview generated",
        video_path=preview_relative,
        duration_seconds=duration,
    )


@router.post(
    "/{episode_id}/edit/reset",
    response_model=VideoEditResponse,
    status_code=status.HTTP_200_OK,
    summary="Reset video to the original assembly output",
)
async def edit_reset(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> VideoEditResponse:
    """Restore the original assembled video, undoing all edits."""
    from shortsfactory.services.ffmpeg import FFmpegService

    asset_repo = MediaAssetRepository(db)
    base = Path(settings.storage_base_path)

    video_assets = await asset_repo.get_by_episode_and_type(episode_id, "video")
    if not video_assets:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No video asset found for this episode",
        )

    video_asset = video_assets[-1]
    video_path = base / video_asset.file_path
    original_path = video_path.parent / "final_original.mp4"

    if not original_path.exists():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No original video backup found -- video has not been edited",
        )

    # Restore original
    import shutil
    await asyncio.to_thread(shutil.copy2, str(original_path), str(video_path))

    # Update asset metadata
    ffmpeg = FFmpegService(ffmpeg_path=settings.ffmpeg_path)
    duration = await ffmpeg.get_duration(video_path)
    file_size = video_path.stat().st_size
    await asset_repo.update(
        video_asset.id,
        file_size_bytes=file_size,
        duration_seconds=duration,
    )
    await db.commit()

    # Clean up preview if it exists
    preview_path = video_path.parent / "preview.mp4"
    if preview_path.exists():
        preview_path.unlink()

    logger.info("video_edit_reset", episode_id=str(episode_id))
    return VideoEditResponse(
        episode_id=episode_id,
        message="Video restored to original",
        video_path=video_asset.file_path,
        duration_seconds=duration,
    )


# ── SEO optimization ─────────────────────────────────────────────────────


@router.post(
    "/{episode_id}/seo",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Generate SEO-optimized metadata using AI",
)
async def generate_seo(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
    redis: ArqRedis = Depends(get_redis),
) -> dict[str, Any]:
    """Enqueue SEO generation as a background job.

    The actual LLM inference runs in the arq worker to avoid blocking
    a uvicorn worker for up to 30 minutes on slow local models.
    """
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if not episode or not episode.script:
        raise HTTPException(404, "Episode not found or has no script")

    await redis.enqueue_job("generate_seo_async", str(episode_id))

    return {"status": "queued", "message": "SEO generation started in background"}
