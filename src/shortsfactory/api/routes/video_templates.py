"""Video Templates API router.

Provides CRUD for :class:`VideoTemplate` records plus two convenience
endpoints that bridge templates and series:

- ``POST /{id}/apply/{series_id}``  -- push template settings onto a series
- ``POST /from-series/{series_id}`` -- capture a series's settings as a new template
"""

from __future__ import annotations

from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from shortsfactory.core.deps import get_db
from shortsfactory.repositories.series import SeriesRepository
from shortsfactory.repositories.video_template import VideoTemplateRepository
from shortsfactory.schemas.video_template import (
    ApplyTemplateResponse,
    CreateFromSeriesResponse,
    VideoTemplateCreate,
    VideoTemplateResponse,
    VideoTemplateUpdate,
)

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/video-templates", tags=["video-templates"])

# ---------------------------------------------------------------------------
# Mapping: VideoTemplate field -> Series field
# Only fields that exist on both models and make semantic sense to copy are
# listed.  When a template field is None it is silently skipped so partial
# templates remain useful.
# ---------------------------------------------------------------------------
_TEMPLATE_TO_SERIES_FIELD_MAP: dict[str, str] = {
    "voice_profile_id": "voice_profile_id",
    "visual_style": "visual_style",
    "scene_mode": "scene_mode",
    "music_enabled": "music_enabled",
    "music_mood": "music_mood",
    "music_volume_db": "music_volume_db",
    "target_duration_seconds": "target_duration_seconds",
}

# caption_style_preset on VideoTemplate maps to caption_style["preset"] on
# Series (which stores a full JSONB dict).  Handled separately in the apply
# logic below to avoid a lossy overwrite of the whole caption_style JSONB.


# ── List ─────────────────────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[VideoTemplateResponse],
    status_code=status.HTTP_200_OK,
    summary="List all video templates",
    description="Return every video template ordered by creation date (newest first).",
)
async def list_video_templates(
    db: AsyncSession = Depends(get_db),
) -> list[VideoTemplateResponse]:
    """Return all video templates."""
    repo = VideoTemplateRepository(db)
    templates = await repo.get_all()
    return [VideoTemplateResponse.model_validate(t) for t in templates]


# ── Create ────────────────────────────────────────────────────────────────


@router.post(
    "",
    response_model=VideoTemplateResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new video template",
    description=(
        "Create a named preset capturing voice, visual, caption, music, and "
        "audio-mastering settings.  If ``is_default`` is ``true`` any previously "
        "default template is demoted automatically."
    ),
)
async def create_video_template(
    payload: VideoTemplateCreate,
    db: AsyncSession = Depends(get_db),
) -> VideoTemplateResponse:
    """Create a new video template.

    When the payload marks the template as default, all other templates are
    updated to ``is_default=False`` within the same transaction before the
    new row is inserted.
    """
    repo = VideoTemplateRepository(db)

    if payload.is_default:
        await repo.clear_default_flag()

    template = await repo.create(**payload.model_dump())
    await db.commit()
    await db.refresh(template)

    log.info(
        "video_template.created",
        template_id=str(template.id),
        name=template.name,
        is_default=template.is_default,
    )

    return VideoTemplateResponse.model_validate(template)


# ── Get by ID ─────────────────────────────────────────────────────────────


@router.get(
    "/{template_id}",
    response_model=VideoTemplateResponse,
    status_code=status.HTTP_200_OK,
    summary="Get a video template by ID",
)
async def get_video_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> VideoTemplateResponse:
    """Fetch a single video template by primary key."""
    repo = VideoTemplateRepository(db)
    template = await repo.get_by_id(template_id)
    if template is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"VideoTemplate {template_id} not found",
        )
    return VideoTemplateResponse.model_validate(template)


# ── Update ────────────────────────────────────────────────────────────────


@router.put(
    "/{template_id}",
    response_model=VideoTemplateResponse,
    status_code=status.HTTP_200_OK,
    summary="Update a video template",
    description=(
        "Partial update: only the fields present in the request body are "
        "modified.  Setting ``is_default=true`` demotes the current default."
    ),
)
async def update_video_template(
    template_id: UUID,
    payload: VideoTemplateUpdate,
    db: AsyncSession = Depends(get_db),
) -> VideoTemplateResponse:
    """Update an existing video template.

    Raises 422 if no updatable fields are supplied to avoid silent no-ops.
    """
    update_data = payload.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No fields to update",
        )

    repo = VideoTemplateRepository(db)

    # If the caller is promoting this template to default, first clear others.
    if update_data.get("is_default") is True:
        await repo.clear_default_flag()

    template = await repo.update(template_id, **update_data)
    if template is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"VideoTemplate {template_id} not found",
        )
    await db.commit()
    await db.refresh(template)

    log.info("video_template.updated", template_id=str(template_id))
    return VideoTemplateResponse.model_validate(template)


# ── Delete ────────────────────────────────────────────────────────────────


@router.delete(
    "/{template_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a video template",
)
async def delete_video_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a video template by ID."""
    repo = VideoTemplateRepository(db)
    deleted = await repo.delete(template_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"VideoTemplate {template_id} not found",
        )
    await db.commit()
    log.info("video_template.deleted", template_id=str(template_id))


# ── Apply template to series ──────────────────────────────────────────────


@router.post(
    "/{template_id}/apply/{series_id}",
    response_model=ApplyTemplateResponse,
    status_code=status.HTTP_200_OK,
    summary="Apply a video template to a series",
    description=(
        "Copy the template's settings onto the target series.  Fields that "
        "are ``None`` on the template are skipped — the series retains its "
        "existing values for those fields.  ``caption_style_preset`` is merged "
        "into the series ``caption_style`` JSONB as a ``preset`` key rather "
        "than replacing the entire caption config.  The template's "
        "``times_used`` counter is incremented atomically."
    ),
)
async def apply_template_to_series(
    template_id: UUID,
    series_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> ApplyTemplateResponse:
    """Apply a video template to a series.

    Loads both the template and the series, then writes every non-None template
    field onto the series.  The caption_style_preset is merged into the
    series-level caption_style dict rather than overwriting the whole object.

    Returns:
        An :class:`ApplyTemplateResponse` listing the fields that were changed.
    """
    template_repo = VideoTemplateRepository(db)
    series_repo = SeriesRepository(db)

    template = await template_repo.get_by_id(template_id)
    if template is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"VideoTemplate {template_id} not found",
        )

    series = await series_repo.get_by_id(series_id)
    if series is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Series {series_id} not found",
        )

    # Collect the series update kwargs and track which fields were applied.
    series_update: dict[str, object] = {}
    applied_fields: list[str] = []

    for template_field, series_field in _TEMPLATE_TO_SERIES_FIELD_MAP.items():
        value = getattr(template, template_field)
        if value is not None:
            series_update[series_field] = value
            applied_fields.append(series_field)

    # Special-case: caption_style_preset is merged into caption_style JSONB.
    if template.caption_style_preset is not None:
        existing_caption_style: dict[str, object] = dict(series.caption_style or {})
        existing_caption_style["preset"] = template.caption_style_preset
        series_update["caption_style"] = existing_caption_style
        applied_fields.append("caption_style.preset")

    if series_update:
        await series_repo.update(series_id, **series_update)

    # Atomically increment the usage counter — do not abort the whole
    # operation if this fails, but let the outer transaction propagate errors.
    await template_repo.increment_usage(template_id)

    await db.commit()

    log.info(
        "video_template.applied",
        template_id=str(template_id),
        series_id=str(series_id),
        fields_applied=applied_fields,
    )

    return ApplyTemplateResponse(
        series_id=series_id,
        template_id=template_id,
        applied_fields=applied_fields,
        message=(
            f"Template '{template.name}' applied to series. "
            f"{len(applied_fields)} field(s) updated."
        ),
    )


# ── Create template from series ───────────────────────────────────────────


@router.post(
    "/from-series/{series_id}",
    response_model=CreateFromSeriesResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a video template from an existing series",
    description=(
        "Snapshot the current series settings into a new video template.  "
        "The template name defaults to the series name prefixed with 'Template: '.  "
        "``caption_style_preset`` is extracted from the series ``caption_style['preset']`` "
        "key if it exists.  The new template starts with ``times_used=0`` and "
        "``is_default=False``."
    ),
)
async def create_template_from_series(
    series_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> CreateFromSeriesResponse:
    """Create a new video template by capturing the current state of a series.

    Reads the series configuration and stores relevant fields as a new
    :class:`VideoTemplate`.  The reverse mapping is the inverse of
    ``_TEMPLATE_TO_SERIES_FIELD_MAP``, plus the special caption_style handling.

    Returns:
        A :class:`CreateFromSeriesResponse` containing the new template.
    """
    series_repo = SeriesRepository(db)
    series = await series_repo.get_by_id(series_id)
    if series is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Series {series_id} not found",
        )

    # Extract caption_style preset from the series JSONB if present.
    caption_preset: str | None = None
    if series.caption_style and isinstance(series.caption_style, dict):
        caption_preset = series.caption_style.get("preset")  # type: ignore[assignment]

    template_repo = VideoTemplateRepository(db)
    template = await template_repo.create(
        name=f"Template: {series.name}",
        description=(
            f"Snapshot of series '{series.name}' settings captured automatically."
        ),
        voice_profile_id=series.voice_profile_id,
        visual_style=series.visual_style,
        scene_mode=series.scene_mode,
        caption_style_preset=caption_preset,
        music_enabled=series.music_enabled,
        music_mood=series.music_mood,
        music_volume_db=float(series.music_volume_db),
        target_duration_seconds=series.target_duration_seconds,
        is_default=False,
        times_used=0,
    )
    await db.commit()
    await db.refresh(template)

    log.info(
        "video_template.created_from_series",
        template_id=str(template.id),
        series_id=str(series_id),
    )

    return CreateFromSeriesResponse(
        template=VideoTemplateResponse.model_validate(template),
        message=(
            f"Template '{template.name}' created from series '{series.name}'."
        ),
    )
