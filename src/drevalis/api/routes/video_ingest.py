"""Video-ingest routes.

Flow:

1. ``POST /api/v1/video-ingest`` — upload a raw video. The endpoint
   creates (or dedups to) an Asset, enqueues an ``analyze_video_ingest``
   worker job, and returns a ``VideoIngestJobResponse`` the UI polls.
2. ``GET  /api/v1/video-ingest/{job_id}`` — status + candidate clips
   once ``status=done``.
3. ``POST /api/v1/video-ingest/{job_id}/pick`` — operator commits to
   one of the candidates, optionally assigning the new episode to a
   series. Returns the freshly created ``episode_id``.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

import structlog
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel

from drevalis.core.deps import get_db, get_settings
from drevalis.core.redis import get_arq_pool
from drevalis.repositories.asset import AssetRepository, VideoIngestJobRepository

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from drevalis.core.config import Settings

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

router = APIRouter(tags=["video-ingest"])


class CandidateClip(BaseModel):
    start_s: float
    end_s: float
    title: str
    reason: str
    score: float


class VideoIngestJobResponse(BaseModel):
    id: UUID
    asset_id: UUID
    status: str
    stage: str | None
    progress_pct: int
    candidate_clips: list[CandidateClip] | None
    selected_clip_index: int | None
    resulting_episode_id: UUID | None
    error_message: str | None


class PickRequest(BaseModel):
    clip_index: int
    series_id: UUID


@router.post(
    "/api/v1/video-ingest",
    response_model=VideoIngestJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def start_video_ingest(
    file: UploadFile = File(...),
    description: str | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> VideoIngestJobResponse:
    """Upload a video and kick off the analyze-and-pick pipeline."""
    # Duplicate the slimmed-down upload logic from /assets inline so we
    # can control the hash-dedup vs job-creation ordering (we always
    # want a job, even for a de-duped asset).
    from drevalis.api.routes.assets import _kind_from_mime, _probe_media, _safe_filename

    if not (file.content_type or "").startswith("video/"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "file must be a video")

    contents = await file.read()
    if not contents:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "empty file")

    sha = hashlib.sha256(contents).hexdigest()
    asset_repo = AssetRepository(db)
    existing = await asset_repo.get_by_hash(sha)
    if existing is not None:
        asset = existing
    else:
        kind = _kind_from_mime(file.content_type)
        if kind != "video":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "file must be a video")
        filename = _safe_filename(file.filename or "video.mp4")
        asset_id = uuid4()
        rel = Path("assets") / "videos" / str(asset_id) / filename
        abs_path = Path(settings.storage_base_path) / rel
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_bytes(contents)
        w, h, dur = await _probe_media(abs_path)
        asset = await asset_repo.create(
            id=asset_id,
            kind=kind,
            filename=filename,
            file_path=rel.as_posix(),
            file_size_bytes=len(contents),
            mime_type=file.content_type,
            hash_sha256=sha,
            width=w,
            height=h,
            duration_seconds=dur,
            tags=["ingest"],
            description=description,
            created_at=datetime.now(tz=UTC),
            updated_at=datetime.now(tz=UTC),
        )

    # Create the ingest job row.
    job_repo = VideoIngestJobRepository(db)
    job = await job_repo.create(
        asset_id=asset.id,
        status="queued",
        stage=None,
        progress_pct=0,
    )
    await db.commit()

    # Enqueue the worker.
    arq = get_arq_pool()
    await arq.enqueue_job("analyze_video_ingest", str(job.id))

    logger.info("video_ingest_enqueued", job_id=str(job.id), asset_id=str(asset.id))
    return VideoIngestJobResponse(
        id=job.id,
        asset_id=asset.id,
        status=job.status,
        stage=job.stage,
        progress_pct=job.progress_pct,
        candidate_clips=None,
        selected_clip_index=None,
        resulting_episode_id=None,
        error_message=None,
    )


@router.get(
    "/api/v1/video-ingest/{job_id}",
    response_model=VideoIngestJobResponse,
)
async def get_video_ingest_job(
    job_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> VideoIngestJobResponse:
    job = await VideoIngestJobRepository(db).get_by_id(job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ingest job not found")
    return VideoIngestJobResponse(
        id=job.id,
        asset_id=job.asset_id,
        status=job.status,
        stage=job.stage,
        progress_pct=job.progress_pct,
        candidate_clips=[CandidateClip.model_validate(c) for c in (job.candidate_clips or [])],
        selected_clip_index=job.selected_clip_index,
        resulting_episode_id=job.resulting_episode_id,
        error_message=job.error_message,
    )


@router.post(
    "/api/v1/video-ingest/{job_id}/pick",
    status_code=status.HTTP_201_CREATED,
)
async def pick_video_ingest_clip(
    job_id: UUID,
    body: PickRequest,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """Commit to a candidate clip — creates a draft Episode from it."""
    job = await VideoIngestJobRepository(db).get_by_id(job_id)
    if job is None or job.status != "done":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "job is not ready")
    if not 0 <= body.clip_index < len(job.candidate_clips or []):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "clip_index out of range")

    arq = get_arq_pool()
    await arq.enqueue_job(
        "commit_video_ingest_clip",
        str(job_id),
        int(body.clip_index),
        str(body.series_id),
    )
    return {"status": "enqueued"}
