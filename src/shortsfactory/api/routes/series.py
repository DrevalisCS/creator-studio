"""Series API router -- CRUD for content series + AI generation."""

from __future__ import annotations

import json
from typing import Any, Literal
from uuid import UUID, uuid4

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from shortsfactory.core.config import Settings
from shortsfactory.core.deps import get_db, get_settings
from shortsfactory.core.redis import get_arq_pool, get_pool
from shortsfactory.repositories.episode import EpisodeRepository
from shortsfactory.repositories.llm_config import LLMConfigRepository
from shortsfactory.repositories.series import SeriesRepository
from shortsfactory.schemas.series import (
    SeriesCreate,
    SeriesListResponse,
    SeriesResponse,
    SeriesUpdate,
)
from shortsfactory.services.llm import (
    LLMService,
    OpenAICompatibleProvider,
    _extract_json,
)

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/series", tags=["series"])


# ── AI generation schemas ────────────────────────────────────────────────


class SeriesGenerateRequest(BaseModel):
    """Payload for AI-generating a complete series from a natural language idea."""

    idea: str = Field(..., min_length=10, description="Natural language description of the series idea")
    episode_count: int = Field(default=10, ge=1, le=50)
    target_duration_seconds: Literal[15, 30, 60] = 30
    voice_profile_id: UUID | None = None
    llm_config_id: UUID | None = None


class _GeneratedEpisode(BaseModel):
    title: str
    topic: str


class SeriesGenerateResponse(BaseModel):
    """Response after AI-generating a series with episodes."""

    series_id: UUID
    series_name: str
    episode_count: int
    episodes: list[_GeneratedEpisode]


class SeriesGenerateJobResponse(BaseModel):
    """Response from the async generate endpoint."""

    job_id: str
    status: str


class SeriesGenerateJobStatusResponse(BaseModel):
    """Poll response for series generation job."""

    job_id: str
    status: str
    result: SeriesGenerateResponse | None = None
    error: str | None = None


# ── AI generate endpoint (async via arq) ──────────────────────────────


@router.post(
    "/generate",
    response_model=SeriesGenerateJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="AI-generate a series + episodes (async via background job)",
)
async def generate_series(
    payload: SeriesGenerateRequest,
    settings: Settings = Depends(get_settings),
) -> SeriesGenerateJobResponse:
    """Enqueue an LLM job to generate a complete series from a natural language
    idea.  Returns immediately with a ``job_id``.  Poll
    ``GET /api/v1/series/generate-job/{job_id}`` for the result.
    """
    job_id = str(uuid4())

    redis_client: Redis = Redis(connection_pool=get_pool())  # type: ignore[type-arg]
    try:
        await redis_client.set(f"script_job:{job_id}:status", "generating", ex=3600)
        await redis_client.set(
            f"script_job:{job_id}:input",
            json.dumps({"type": "series", "idea": payload.idea}),
            ex=3600,
        )

        arq = get_arq_pool()
        await arq.enqueue_job("generate_series_async", job_id, payload.model_dump(mode="json"))
    finally:
        await redis_client.aclose()

    logger.info(
        "series_generate_job_enqueued",
        job_id=job_id,
        idea_length=len(payload.idea),
        episode_count=payload.episode_count,
    )

    return SeriesGenerateJobResponse(job_id=job_id, status="generating")


@router.get(
    "/generate-job/{job_id}",
    response_model=SeriesGenerateJobStatusResponse,
    status_code=status.HTTP_200_OK,
    summary="Poll for series generation job status",
)
async def get_series_generate_job(job_id: str) -> SeriesGenerateJobStatusResponse:
    """Return the current status (and result when done) of a series generation job."""
    redis_client: Redis = Redis(connection_pool=get_pool())  # type: ignore[type-arg]
    try:
        raw_status = await redis_client.get(f"script_job:{job_id}:status")
        if not raw_status:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Job not found",
            )

        job_status = raw_status if isinstance(raw_status, str) else raw_status.decode()

        result: SeriesGenerateResponse | None = None
        error: str | None = None

        if job_status == "done":
            result_json = await redis_client.get(f"script_job:{job_id}:result")
            if result_json:
                raw = result_json if isinstance(result_json, str) else result_json.decode()
                result = SeriesGenerateResponse.model_validate(json.loads(raw))
        elif job_status == "failed":
            raw_error = await redis_client.get(f"script_job:{job_id}:error")
            if raw_error:
                error = raw_error if isinstance(raw_error, str) else raw_error.decode()

        return SeriesGenerateJobStatusResponse(
            job_id=job_id,
            status=job_status,
            result=result,
            error=error,
        )
    finally:
        await redis_client.aclose()


@router.post(
    "/generate-job/{job_id}/cancel",
    status_code=status.HTTP_200_OK,
    summary="Cancel a series generation job",
)
async def cancel_series_generate_job(job_id: str) -> dict[str, str]:
    """Mark a series generation job as cancelled."""
    redis_client: Redis = Redis(connection_pool=get_pool())  # type: ignore[type-arg]
    try:
        existing = await redis_client.get(f"script_job:{job_id}:status")
        if not existing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Job not found",
            )
        await redis_client.set(f"script_job:{job_id}:status", "cancelled", ex=3600)
    finally:
        await redis_client.aclose()

    logger.info("series_generate_job_cancelled", job_id=job_id)
    return {"message": "Cancelled"}


# ── Synchronous fallback (kept for backwards compatibility) ────────────


_SERIES_GEN_SYSTEM_PROMPT = """\
You are a premium YouTube Shorts series strategist. You create series that go viral because of genuinely fascinating, specific content — not generic clickbait.
Output ONLY valid JSON with this exact structure:
{
    "name": "compelling series name (max 50 chars)",
    "description": "2-3 sentence description of the series concept and what makes it unique",
    "visual_style": "ultra-detailed visual style for AI image generation: specific color palette, dramatic lighting style, cinematic composition, mood, aesthetic reference",
    "character_description": "describe the narrator/character IF the series features a specific character. Leave empty string '' for topics about landscapes, space, science, nature, cities, or abstract concepts where no character is needed",
    "episodes": [
        {"title": "specific compelling title with a number or bold claim", "topic": "2-3 sentences describing the SPECIFIC angle, including real names/dates/numbers. Must teach something 99% of people don't know."}
    ]
}
CRITICAL RULES:
- Series name must be bold and specific, not generic
- Each episode title MUST contain a specific detail (a name, year, number, or bold claim)
- Episode topics MUST be specific and fascinating — NOT generic overviews. Each should focus on ONE specific story, case, event, or revelation
- BAD example: "The history of hacking" — too generic
- GOOD example: "The teenager who hacked NASA at age 15 — and what he found"
- Visual style must be specific enough for AI to generate consistent, cinematic imagery
- Character description: leave '' for non-character content (landscapes, space, science, etc.)"""

_MAX_GENERATE_RETRIES = 2


@router.post(
    "/generate-sync",
    response_model=SeriesGenerateResponse,
    status_code=status.HTTP_201_CREATED,
    summary="AI-generate a series + episodes (synchronous fallback)",
)
async def generate_series_sync(
    payload: SeriesGenerateRequest,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> SeriesGenerateResponse:
    """Synchronous fallback: generate a series and wait for the result inline."""

    # ── Resolve LLM provider ──────────────────────────────────────────
    if payload.llm_config_id:
        llm_config = await LLMConfigRepository(db).get_by_id(payload.llm_config_id)
        if not llm_config:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="LLM config not found",
            )
        llm_service = LLMService(storage=None, encryption_key=settings.encryption_key)  # type: ignore[arg-type]
        provider = llm_service.get_provider(llm_config)
    else:
        # Auto-select first available LLM config from DB
        configs = await LLMConfigRepository(db).get_all(limit=1)
        if configs:
            llm_service = LLMService(storage=None, encryption_key=settings.encryption_key)  # type: ignore[arg-type]
            provider = llm_service.get_provider(configs[0])
        else:
            provider = OpenAICompatibleProvider(
                base_url=settings.lm_studio_base_url,
                model=settings.lm_studio_default_model,
            )

    # ── Build user prompt ─────────────────────────────────────────────
    user_prompt = (
        f"Create a YouTube Shorts series based on this idea:\n\n"
        f"{payload.idea}\n\n"
        f"Generate exactly {payload.episode_count} episode ideas.\n"
        f"Target duration per episode: {payload.target_duration_seconds} seconds.\n\n"
        f"Return the JSON now:"
    )

    # ── Call LLM with retry on malformed JSON ─────────────────────────
    last_error: Exception | None = None
    data: dict | None = None

    for attempt in range(_MAX_GENERATE_RETRIES + 1):
        try:
            result = await provider.generate(
                _SERIES_GEN_SYSTEM_PROMPT,
                user_prompt,
                temperature=0.8,
                max_tokens=4096,
                json_mode=True,
            )

            raw = result.content
            extracted = _extract_json(raw)
            data = json.loads(extracted)

            # Validate minimum structure
            if not isinstance(data, dict) or "name" not in data or "episodes" not in data:
                raise ValueError("Response missing required 'name' or 'episodes' keys")

            logger.info(
                "series_generate_llm_complete",
                attempt=attempt + 1,
                series_name=data.get("name"),
                episodes_count=len(data.get("episodes", [])),
            )
            break

        except (json.JSONDecodeError, ValueError, KeyError) as exc:
            last_error = exc
            logger.warning(
                "series_generate_json_parse_failed",
                attempt=attempt + 1,
                max_retries=_MAX_GENERATE_RETRIES,
                error=str(exc),
            )

    if data is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"LLM returned invalid JSON after {_MAX_GENERATE_RETRIES + 1} attempts: {last_error}",
        )

    # ── Create the Series ─────────────────────────────────────────────
    series_repo = SeriesRepository(db)
    series = await series_repo.create(
        name=data["name"][:255],
        description=data.get("description", ""),
        visual_style=data.get("visual_style", ""),
        character_description=data.get("character_description", ""),
        target_duration_seconds=payload.target_duration_seconds,
        voice_profile_id=payload.voice_profile_id,
    )

    # ── Create Episodes in draft status ───────────────────────────────
    episode_repo = EpisodeRepository(db)
    episodes_created: list[_GeneratedEpisode] = []

    for ep_data in data.get("episodes", [])[:payload.episode_count]:
        title = str(ep_data.get("title", "Untitled"))[:500]
        topic = str(ep_data.get("topic", ""))
        ep = await episode_repo.create(
            series_id=series.id,
            title=title,
            topic=topic,
        )
        episodes_created.append(_GeneratedEpisode(title=ep.title, topic=ep.topic or ""))

    await db.commit()

    logger.info(
        "series_generate_complete",
        series_id=str(series.id),
        series_name=series.name,
        episode_count=len(episodes_created),
    )

    return SeriesGenerateResponse(
        series_id=series.id,
        series_name=series.name,
        episode_count=len(episodes_created),
        episodes=episodes_created,
    )


# ── List all series ───────────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[SeriesListResponse],
    status_code=status.HTTP_200_OK,
    summary="List all series with episode counts",
)
async def list_series(
    db: AsyncSession = Depends(get_db),
) -> list[SeriesListResponse]:
    """Return every series together with a computed episode count."""
    repo = SeriesRepository(db)
    rows = await repo.list_with_episode_counts()
    return [
        SeriesListResponse(
            id=series.id,
            name=series.name,
            description=series.description,
            target_duration_seconds=series.target_duration_seconds,
            episode_count=count,
            created_at=series.created_at,
        )
        for series, count in rows
    ]


# ── Create series ─────────────────────────────────────────────────────────


@router.post(
    "",
    response_model=SeriesResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new series",
)
async def create_series(
    payload: SeriesCreate,
    db: AsyncSession = Depends(get_db),
) -> SeriesResponse:
    """Create a new content series with the provided configuration."""
    repo = SeriesRepository(db)
    series = await repo.create(**payload.model_dump())
    await db.commit()
    await db.refresh(series)
    return SeriesResponse.model_validate(series)


# ── Get series detail ─────────────────────────────────────────────────────


@router.get(
    "/{series_id}",
    response_model=SeriesResponse,
    status_code=status.HTTP_200_OK,
    summary="Get series with all relations",
)
async def get_series(
    series_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> SeriesResponse:
    """Fetch a single series by ID with eagerly loaded configuration relations."""
    repo = SeriesRepository(db)
    series = await repo.get_with_relations(series_id)
    if series is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Series {series_id} not found",
        )
    return SeriesResponse.model_validate(series)


# ── Update series ─────────────────────────────────────────────────────────


@router.put(
    "/{series_id}",
    response_model=SeriesResponse,
    status_code=status.HTTP_200_OK,
    summary="Update a series",
)
async def update_series(
    series_id: UUID,
    payload: SeriesUpdate,
    db: AsyncSession = Depends(get_db),
) -> SeriesResponse:
    """Update an existing series. Only provided (non-None) fields are changed."""
    repo = SeriesRepository(db)
    update_data = payload.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No fields to update",
        )
    series = await repo.update(series_id, **update_data)
    if series is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Series {series_id} not found",
        )
    await db.commit()
    await db.refresh(series)
    return SeriesResponse.model_validate(series)


# ── Delete series ─────────────────────────────────────────────────────────


@router.delete(
    "/{series_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a series (cascades to episodes)",
)
async def delete_series(
    series_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a series and all its episodes (cascade)."""
    repo = SeriesRepository(db)
    deleted = await repo.delete(series_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Series {series_id} not found",
        )
    await db.commit()


# ── Add AI-generated episodes to an existing series ──────────────────────


_ADD_EPISODES_SYSTEM_PROMPT = """\
You are a premium YouTube Shorts content strategist. Given a series concept and existing episodes, \
suggest NEW episode ideas with genuinely fascinating, specific content that 99% of people don't know.
Output ONLY valid JSON: {"episodes": [{"title": "...", "topic": "..."}]}
RULES:
- Each title MUST contain a specific detail (name, year, number, or bold claim)
- Each topic must be 2-3 sentences describing ONE specific story, case, or revelation
- Focus on insider knowledge, counterintuitive facts, and stories that make people stop scrolling
- NEVER suggest generic overviews — every episode should have a unique, specific angle
- BAD: "Interesting facts about the ocean" / GOOD: "The 11,000m trench where pressure crushes steel — but life thrives" """


class AddEpisodesRequest(BaseModel):
    count: int = Field(5, ge=1, le=20)
    llm_config_id: UUID | None = None


@router.post(
    "/{series_id}/add-episodes",
    response_model=dict[str, Any],
    status_code=status.HTTP_201_CREATED,
    summary="AI-generate new episode ideas and add them as drafts",
)
async def add_episodes_ai(
    series_id: UUID,
    payload: AddEpisodesRequest,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Use the LLM to generate new episode ideas for an existing series.

    Creates episodes as drafts so they can be reviewed before generation.
    """
    series_repo = SeriesRepository(db)
    series = await series_repo.get_by_id(series_id)
    if not series:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Series {series_id} not found",
        )

    # Get existing episodes to avoid duplicates (limit to 30 most recent to save context)
    ep_repo = EpisodeRepository(db)
    existing_eps = await ep_repo.get_by_series(series_id, limit=30)
    existing_titles = [ep.title[:60] for ep in existing_eps]

    # Resolve LLM provider
    if payload.llm_config_id:
        llm_config = await LLMConfigRepository(db).get_by_id(payload.llm_config_id)
        if not llm_config:
            raise HTTPException(status_code=404, detail="LLM config not found")
        llm_service = LLMService(storage=None, encryption_key=settings.encryption_key)  # type: ignore[arg-type]
        provider = llm_service.get_provider(llm_config)
    else:
        # Auto-select first available LLM config
        configs = await LLMConfigRepository(db).get_all(limit=1)
        if configs:
            llm_service = LLMService(storage=None, encryption_key=settings.encryption_key)  # type: ignore[arg-type]
            provider = llm_service.get_provider(configs[0])
        else:
            provider = OpenAICompatibleProvider(
                base_url=settings.lm_studio_base_url,
                model=settings.lm_studio_default_model,
            )

    user_prompt = (
        f"Series: {series.name}\n"
        f"Description: {series.description or 'N/A'}\n"
        f"Existing episodes: {', '.join(existing_titles) if existing_titles else 'None yet'}\n\n"
        f"Generate exactly {payload.count} NEW episode ideas that fit this series.\n"
        f"Do NOT repeat existing episode topics.\n"
        f"Return the JSON now:"
    )

    data: dict | None = None
    for attempt in range(3):
        try:
            result = await provider.generate(
                _ADD_EPISODES_SYSTEM_PROMPT,
                user_prompt,
                temperature=0.8,
                max_tokens=2048,
                json_mode=True,
            )
            extracted = _extract_json(result.content)
            data = json.loads(extracted)
            if not isinstance(data, dict) or "episodes" not in data:
                raise ValueError("Missing 'episodes' key")
            break
        except (json.JSONDecodeError, ValueError):
            continue

    if data is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LLM returned invalid JSON after retries",
        )

    # Create episode drafts
    created_ids = []
    for ep_data in data["episodes"][:payload.count]:
        title = ep_data.get("title", "Untitled")[:500]
        topic = ep_data.get("topic", "")
        ep = await ep_repo.create(
            series_id=series_id,
            title=title,
            topic=topic,
        )
        created_ids.append(str(ep.id))

    await db.commit()

    logger.info(
        "add_episodes_ai_done",
        series_id=str(series_id),
        count=len(created_ids),
    )
    return {
        "message": f"Created {len(created_ids)} new episode draft(s)",
        "episode_ids": created_ids,
        "episodes": data["episodes"][:payload.count],
    }


# ── Trending topics suggestion ───────────────────────────────────────────


@router.post(
    "/{series_id}/trending-topics",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="AI-suggest trending topic ideas for this series",
)
async def suggest_trending_topics(
    series_id: UUID,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Use LLM to suggest trending/viral topic ideas based on the series theme."""
    series_repo = SeriesRepository(db)
    series = await series_repo.get_by_id(series_id)
    if not series:
        raise HTTPException(404, f"Series {series_id} not found")

    ep_repo = EpisodeRepository(db)
    existing_eps = await ep_repo.get_by_series(series_id, limit=100)
    existing_titles = [ep.title for ep in existing_eps]

    # Resolve LLM
    configs = await LLMConfigRepository(db).get_all(limit=1)
    if configs:
        llm_service = LLMService(storage=None, encryption_key=settings.encryption_key)  # type: ignore[arg-type]
        provider = llm_service.get_provider(configs[0])
    else:
        provider = OpenAICompatibleProvider(
            base_url=settings.lm_studio_base_url,
            model=settings.lm_studio_default_model,
        )

    system_prompt = (
        "You are a viral content strategist. Suggest trending YouTube Shorts topics. "
        "Output ONLY valid JSON: {\"topics\": [{\"title\": \"...\", \"angle\": \"unique angle\", "
        "\"hook\": \"attention-grabbing first line\", \"estimated_engagement\": \"high|medium|low\"}]}"
    )
    user_prompt = (
        f"Series: {series.name}\n"
        f"Description: {series.description or 'N/A'}\n"
        f"Existing episodes: {', '.join(existing_titles[:20]) if existing_titles else 'None'}\n\n"
        "Suggest 10 trending/viral topic ideas. Focus on what's currently popular "
        "and would get maximum views. Return JSON now:"
    )

    result = await provider.generate(system_prompt, user_prompt, temperature=0.8, max_tokens=2048, json_mode=True)
    try:
        data = json.loads(_extract_json(result.content))
    except Exception:
        data = {"topics": []}

    return {"series_id": str(series_id), "topics": data.get("topics", [])}
