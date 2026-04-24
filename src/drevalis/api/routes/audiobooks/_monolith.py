"""Audiobooks API router -- CRUD, generation, cover image upload, and AI script generation."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from drevalis.core.config import Settings
from drevalis.core.deps import get_db, get_settings
from drevalis.core.redis import get_arq_pool, get_pool
from drevalis.repositories.audiobook import AudiobookRepository
from drevalis.repositories.voice_profile import VoiceProfileRepository
from drevalis.schemas.audiobook import (
    AudiobookCreate,
    AudiobookListResponse,
    AudiobookResponse,
    AudiobookUpdate,
)

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/audiobooks", tags=["audiobooks"])


# ── AI Script Generation schemas ───────────────────────────────────────


class AudiobookScriptRequest(BaseModel):
    concept: str = Field(..., min_length=10)
    characters: list[dict[str, Any]] = Field(
        default_factory=lambda: [{"name": "Narrator", "description": "Omniscient narrator"}]
    )
    target_minutes: int = Field(default=10, ge=1, le=180)
    mood: str = Field(default="neutral")


class AudiobookScriptResponse(BaseModel):
    title: str
    script: str
    characters: list[str]
    chapters: list[str]
    word_count: int
    estimated_minutes: float


# ── AI Script Generation endpoint (async via arq) ─────────────────────


class ScriptJobResponse(BaseModel):
    job_id: str
    status: str


class ScriptJobStatusResponse(BaseModel):
    job_id: str
    status: str
    result: AudiobookScriptResponse | None = None
    error: str | None = None


@router.post(
    "/generate-script",
    response_model=ScriptJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Start async AI audiobook script generation",
)
async def generate_audiobook_script(
    payload: AudiobookScriptRequest,
    settings: Settings = Depends(get_settings),
) -> ScriptJobResponse:
    """Enqueue an LLM job to generate a full audiobook script.

    Returns immediately with a ``job_id``.  Poll
    ``GET /api/v1/audiobooks/script-job/{job_id}`` for the result.
    """
    job_id = str(uuid4())

    redis_client: Redis = Redis(connection_pool=get_pool())
    try:
        await redis_client.set(f"script_job:{job_id}:status", "generating", ex=3600)
        await redis_client.set(
            f"script_job:{job_id}:input",
            json.dumps(payload.model_dump()),
            ex=3600,
        )

        arq = get_arq_pool()
        await arq.enqueue_job("generate_script_async", job_id, payload.model_dump())
    finally:
        await redis_client.aclose()

    log.info(
        "audiobook.script.job_enqueued",
        job_id=job_id,
        concept_length=len(payload.concept),
        target_minutes=payload.target_minutes,
    )

    return ScriptJobResponse(job_id=job_id, status="generating")


@router.get(
    "/script-job/{job_id}",
    response_model=ScriptJobStatusResponse,
    status_code=status.HTTP_200_OK,
    summary="Poll for script generation job status",
)
async def get_script_job(job_id: str) -> ScriptJobStatusResponse:
    """Return the current status (and result when done) of a script job."""
    redis_client: Redis = Redis(connection_pool=get_pool())
    try:
        raw_status = await redis_client.get(f"script_job:{job_id}:status")
        if not raw_status:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Job not found",
            )

        job_status = raw_status if isinstance(raw_status, str) else raw_status.decode()

        result: AudiobookScriptResponse | None = None
        error: str | None = None

        if job_status == "done":
            result_json = await redis_client.get(f"script_job:{job_id}:result")
            if result_json:
                raw = result_json if isinstance(result_json, str) else result_json.decode()
                result = AudiobookScriptResponse.model_validate(json.loads(raw))
        elif job_status == "failed":
            raw_error = await redis_client.get(f"script_job:{job_id}:error")
            if raw_error:
                error = raw_error if isinstance(raw_error, str) else raw_error.decode()

        return ScriptJobStatusResponse(
            job_id=job_id,
            status=job_status,
            result=result,
            error=error,
        )
    finally:
        await redis_client.aclose()


@router.post(
    "/script-job/{job_id}/cancel",
    status_code=status.HTTP_200_OK,
    summary="Cancel a script generation job",
)
async def cancel_script_job(job_id: str) -> dict[str, str]:
    """Mark a script generation job as cancelled."""
    redis_client: Redis = Redis(connection_pool=get_pool())
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

    log.info("audiobook.script.job_cancelled", job_id=job_id)
    return {"message": "Cancelled"}


# ── Combined AI Create (single-form) ───────────────────────────────────


class AudiobookAICreateRequest(BaseModel):
    """Request body for the single-form AI audiobook creator.

    The LLM writes the script, then TTS generates audio -- all in one
    background job.
    """

    concept: str = Field(..., min_length=10)
    characters: list[dict[str, Any]] = Field(
        default_factory=lambda: [
            {
                "name": "Narrator",
                "description": "Omniscient narrator",
                "gender": "male",
                "voice_profile_id": None,
            }
        ]
    )
    target_minutes: float = Field(default=5, ge=1, le=180)
    mood: str = "neutral"
    output_format: str = "audio_only"
    music_enabled: bool = False
    music_mood: str | None = None
    music_volume_db: float = -14.0
    speed: float = 1.0
    pitch: float = 1.0
    image_generation_enabled: bool = False
    per_chapter_music: bool = False


@router.post(
    "/create-ai",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Create an AI audiobook -- LLM writes script, then TTS generates audio",
)
async def create_ai_audiobook(
    payload: AudiobookAICreateRequest,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Create an AI audiobook: the LLM writes the script, then TTS generates
    audio.  All heavy work runs in the background.

    Returns immediately with the audiobook ID and ``generating`` status.
    """
    # 1. Build a title from the concept (first 50 chars)
    title = payload.concept.strip()[:50].rstrip(".") + "..."

    # 2. Build voice_casting dict from characters
    # ALL characters get a voice — use explicit assignment or auto-assign by gender
    voice_casting: dict[str, str] = {}
    default_voice_id: str | None = None

    # Get available voices for auto-assignment
    vp_repo = VoiceProfileRepository(db)
    all_voices = await vp_repo.get_all()
    male_voices = [v for v in all_voices if getattr(v, "gender", None) == "male"]
    female_voices = [v for v in all_voices if getattr(v, "gender", None) == "female"]

    for char in payload.characters:
        vp_id = char.get("voice_profile_id")
        if vp_id:
            voice_casting[char["name"]] = vp_id
            if not default_voice_id:
                default_voice_id = vp_id
        else:
            # Auto-assign based on gender
            gender = char.get("gender", "male")
            pool = female_voices if gender == "female" else male_voices
            if pool:
                # Pick a voice not already used if possible
                used_ids = set(voice_casting.values())
                available = [v for v in pool if str(v.id) not in used_ids]
                chosen = available[0] if available else pool[0]
                voice_casting[char["name"]] = str(chosen.id)
                if not default_voice_id:
                    default_voice_id = str(chosen.id)

    if not default_voice_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No voice profiles available. Create voice profiles first.",
        )

    # Validate the default voice profile exists
    vp_repo = VoiceProfileRepository(db)
    voice_profile = await vp_repo.get_by_id(UUID(default_voice_id))
    if voice_profile is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"VoiceProfile {default_voice_id} not found",
        )

    # Validate output_format
    valid_formats = ("audio_only", "audio_image", "audio_video")
    if payload.output_format not in valid_formats:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"output_format must be one of {valid_formats}",
        )

    # 3. Create audiobook record
    repo = AudiobookRepository(db)
    audiobook = await repo.create(
        title=title,
        text="",  # Will be filled by the LLM in the background job
        voice_profile_id=UUID(default_voice_id),
        status="generating",
        output_format=payload.output_format,
        voice_casting=voice_casting if voice_casting else None,
        music_enabled=payload.music_enabled,
        music_mood=payload.music_mood,
        music_volume_db=payload.music_volume_db,
        speed=payload.speed,
        pitch=payload.pitch,
        image_generation_enabled=payload.image_generation_enabled,
    )
    await db.commit()

    # 4. Enqueue combined LLM + TTS job
    arq = get_arq_pool()
    await arq.enqueue_job("generate_ai_audiobook", str(audiobook.id), payload.model_dump())

    log.info(
        "audiobook.ai_create.enqueued",
        audiobook_id=str(audiobook.id),
        concept_length=len(payload.concept),
        character_count=len(payload.characters),
        target_minutes=payload.target_minutes,
    )

    return {
        "audiobook_id": str(audiobook.id),
        "status": "generating",
        "title": title,
    }


# ── Synchronous fallback (kept for backwards compatibility) ────────────


@router.post(
    "/generate-script-sync",
    response_model=AudiobookScriptResponse,
    status_code=status.HTTP_200_OK,
    summary="Generate an audiobook script using AI (synchronous fallback)",
)
async def generate_audiobook_script_sync(
    payload: AudiobookScriptRequest,
    settings: Settings = Depends(get_settings),
) -> AudiobookScriptResponse:
    """Synchronous fallback: generate a script and wait for the result inline."""
    from drevalis.services.llm import OpenAICompatibleProvider

    provider = OpenAICompatibleProvider(
        base_url=settings.lm_studio_base_url,
        model=settings.lm_studio_default_model,
    )

    target_words = payload.target_minutes * 150

    char_list = "\n".join(f"- {c['name']}: {c['description']}" for c in payload.characters)

    system_prompt = """You are a professional audiobook scriptwriter.

CRITICAL FORMATTING RULES:
- EVERY single line of text MUST start with [CharacterName]
- Non-dialogue narration MUST use [Narrator]
- NEVER write any text without a [Speaker] tag at the start
- Each speaker change requires a new [Speaker] tag on a new line
- Use ## Chapter Title for chapter breaks

Example format:
## Chapter 1: The Beginning

[Narrator] The rain hadn't stopped for three days. The city was drowning.

[Jack] I need a drink.

[Narrator] He reached for the bottle on his desk, but it was empty. Like everything else in his life.

[Rosie] Mr. Hartley? Are you there?

Write naturally with emotion and tension. Every line tagged."""

    user_prompt = f"""Write an audiobook script based on this concept:

{payload.concept}

Characters:
{char_list}

Mood/tone: {payload.mood}
Target length: approximately {target_words} words ({payload.target_minutes} minutes of narration)

Write the complete script now. Start with a title line, then ## Chapter 1, and continue through the story."""

    log.info(
        "audiobook.script.generate_start_sync",
        concept_length=len(payload.concept),
        character_count=len(payload.characters),
        target_minutes=payload.target_minutes,
        mood=payload.mood,
    )

    try:
        result = await provider.generate(
            system_prompt,
            user_prompt,
            temperature=0.85,
            max_tokens=8000,
            json_mode=False,
        )
    except Exception as exc:
        log.error("audiobook.script.generate_failed", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"LLM generation failed: {exc}",
        ) from exc

    script_text = result.content.strip()
    lines = script_text.split("\n")
    title = lines[0].strip().lstrip("#").strip() if lines else "Untitled"
    chapters = re.findall(r"^##\s+(.+)$", script_text, re.MULTILINE)
    characters_found = list(set(re.findall(r"^\[([^\]]+)\]", script_text, re.MULTILINE)))
    word_count = len(script_text.split())

    log.info(
        "audiobook.script.generate_done_sync",
        title=title,
        word_count=word_count,
        chapters=len(chapters),
        characters=characters_found,
    )

    return AudiobookScriptResponse(
        title=title,
        script=script_text,
        characters=characters_found,
        chapters=chapters,
        word_count=word_count,
        estimated_minutes=round(word_count / 150, 1),
    )


# ── List audiobooks ─────────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[AudiobookListResponse],
    status_code=status.HTTP_200_OK,
    summary="List all audiobooks",
)
async def list_audiobooks(
    status_filter: str | None = Query(default=None, alias="status", description="Filter by status"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> list[AudiobookListResponse]:
    """Return all audiobooks, optionally filtered by status."""
    repo = AudiobookRepository(db)
    if status_filter is not None:
        audiobooks = await repo.get_by_status(status_filter)
    else:
        audiobooks = await repo.get_all(offset=offset, limit=limit)
    return [AudiobookListResponse.model_validate(a) for a in audiobooks]


# ── Create audiobook ────────────────────────────────────────────────────


@router.post(
    "",
    response_model=AudiobookResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Create an audiobook and start generation",
)
async def create_audiobook(
    payload: AudiobookCreate,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> AudiobookResponse:
    """Create an audiobook record and enqueue the generation job.

    The response is returned immediately with status ``generating``.
    The actual TTS work runs asynchronously in the arq worker.
    """
    # Validate voice profile exists
    vp_repo = VoiceProfileRepository(db)
    voice_profile = await vp_repo.get_by_id(payload.voice_profile_id)
    if voice_profile is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"VoiceProfile {payload.voice_profile_id} not found",
        )

    # Validate voice casting profiles exist (if provided)
    if payload.voice_casting:
        for speaker, vp_id in payload.voice_casting.items():
            try:
                from uuid import UUID as _UUID

                cast_vp = await vp_repo.get_by_id(_UUID(vp_id))
                if cast_vp is None:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail=f"VoiceProfile {vp_id} for speaker '{speaker}' not found",
                    )
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Invalid UUID '{vp_id}' for speaker '{speaker}'",
                ) from None

    # Validate output_format
    valid_formats = ("audio_only", "audio_image", "audio_video")
    if payload.output_format not in valid_formats:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"output_format must be one of {valid_formats}",
        )

    repo = AudiobookRepository(db)
    audiobook = await repo.create(
        title=payload.title,
        text=payload.text,
        voice_profile_id=payload.voice_profile_id,
        status="generating",
        background_image_path=payload.background_image_path,
        output_format=payload.output_format,
        cover_image_path=payload.cover_image_path,
        voice_casting=payload.voice_casting,
        music_enabled=payload.music_enabled,
        music_mood=payload.music_mood,
        music_volume_db=payload.music_volume_db,
        speed=payload.speed,
        pitch=payload.pitch,
        video_orientation=payload.video_orientation,
        caption_style_preset=payload.caption_style_preset,
        image_generation_enabled=payload.image_generation_enabled,
    )
    await db.commit()
    await db.refresh(audiobook)

    # Enqueue arq job for async generation
    arq = get_arq_pool()
    await arq.enqueue_job(
        "generate_audiobook",
        str(audiobook.id),
        payload.generate_video,
    )

    log.info(
        "audiobook.created",
        audiobook_id=str(audiobook.id),
        text_length=len(payload.text),
        output_format=payload.output_format,
        generate_video=payload.generate_video,
        music_enabled=payload.music_enabled,
        has_voice_casting=payload.voice_casting is not None,
    )

    return AudiobookResponse.model_validate(audiobook)


# ── Upload cover image ─────────────────────────────────────────────────


@router.post(
    "/upload-cover",
    status_code=status.HTTP_201_CREATED,
    summary="Upload a cover image for audiobook generation",
)
async def upload_cover_image(
    file: UploadFile,
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    """Upload a cover image to be used with audio_image output format.

    Size-capped at 10 MiB and magic-byte-verified via Pillow so an
    operator (or malicious LAN client on an exposed install) can't OOM
    the worker with a multi-GB body or smuggle an HTML/JS polyglot
    through the ``.png`` extension filter and have it served back from
    ``/storage/audiobooks/``.
    """
    MAX_COVER_BYTES = 10 * 1024 * 1024

    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"File must be an image, got {file.content_type}",
        )

    # Stream-read with an explicit cap so `file.read()` can't be used to
    # exhaust process memory. `UploadFile` chunks into a SpooledTemporaryFile
    # so memory usage stays bounded until we copy out.
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_COVER_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Cover image exceeds {MAX_COVER_BYTES // (1024 * 1024)} MiB limit.",
            )
        chunks.append(chunk)
    content = b"".join(chunks)

    # Verify real image bytes (magic + structure) — rejects HTML polyglots
    # and corrupt uploads. Fail fast before anything hits disk.
    try:
        import io as _io

        from PIL import Image as _Image
        from PIL import UnidentifiedImageError as _UnidentifiedImageError

        with _Image.open(_io.BytesIO(content)) as img:
            img.verify()
    except (_UnidentifiedImageError, Exception) as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Uploaded file is not a valid image.",
        ) from exc

    # Generate a unique filename
    ext = Path(file.filename).suffix.lower() if file.filename else ".png"
    if ext not in (".png", ".jpg", ".jpeg", ".webp", ".bmp"):
        ext = ".png"
    unique_name = f"{uuid4()}{ext}"

    covers_dir = settings.storage_base_path / "audiobooks" / "covers"
    covers_dir.mkdir(parents=True, exist_ok=True)

    dest = covers_dir / unique_name
    dest.write_bytes(content)

    rel_path = f"audiobooks/covers/{unique_name}"

    log.info(
        "audiobook.cover_uploaded",
        path=rel_path,
        size_bytes=len(content),
        content_type=file.content_type,
    )

    return {"cover_image_path": rel_path}


# ── Get audiobook detail ────────────────────────────────────────────────


@router.get(
    "/{audiobook_id}",
    response_model=AudiobookResponse,
    status_code=status.HTTP_200_OK,
    summary="Get audiobook detail",
)
async def get_audiobook(
    audiobook_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> AudiobookResponse:
    """Fetch a single audiobook by ID."""
    repo = AudiobookRepository(db)
    audiobook = await repo.get_by_id(audiobook_id)
    if audiobook is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Audiobook {audiobook_id} not found",
        )
    return AudiobookResponse.model_validate(audiobook)


# ── Update audiobook ────────────────────────────────────────────────────


@router.put(
    "/{audiobook_id}",
    response_model=AudiobookResponse,
    status_code=status.HTTP_200_OK,
    summary="Update audiobook metadata",
)
async def update_audiobook(
    audiobook_id: UUID,
    payload: AudiobookUpdate,
    db: AsyncSession = Depends(get_db),
) -> AudiobookResponse:
    """Update an audiobook's title or status."""
    repo = AudiobookRepository(db)
    update_data = payload.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No fields to update",
        )
    audiobook = await repo.update(audiobook_id, **update_data)
    if audiobook is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Audiobook {audiobook_id} not found",
        )
    await db.commit()
    await db.refresh(audiobook)
    return AudiobookResponse.model_validate(audiobook)


# ── Update audiobook text ──────────────────────────────────────────────


class AudiobookTextUpdate(BaseModel):
    text: str = Field(..., min_length=1)


@router.put(
    "/{audiobook_id}/text",
    response_model=AudiobookResponse,
    status_code=status.HTTP_200_OK,
    summary="Update audiobook text without regenerating",
)
async def update_audiobook_text(
    audiobook_id: UUID,
    payload: AudiobookTextUpdate,
    db: AsyncSession = Depends(get_db),
) -> AudiobookResponse:
    """Update the audiobook's text content. Does NOT regenerate audio.

    The user can then manually trigger regeneration after editing.
    """
    repo = AudiobookRepository(db)
    audiobook = await repo.get_by_id(audiobook_id)
    if audiobook is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Audiobook {audiobook_id} not found",
        )

    audiobook = await repo.update(audiobook_id, text=payload.text)
    await db.commit()
    await db.refresh(audiobook)

    log.info(
        "audiobook.text_updated",
        audiobook_id=str(audiobook_id),
        text_length=len(payload.text),
    )

    return AudiobookResponse.model_validate(audiobook)


# ── Regenerate chapter ─────────────────────────────────────────────────


class ChapterRegeneratePayload(BaseModel):
    text: str | None = Field(default=None, description="Optional replacement text for the chapter")


@router.post(
    "/{audiobook_id}/regenerate-chapter/{chapter_index}",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Regenerate a single chapter's audio",
)
async def regenerate_chapter(
    audiobook_id: UUID,
    chapter_index: int,
    payload: ChapterRegeneratePayload | None = None,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Regenerate a single chapter's audio, then re-concatenate the full audiobook.

    If ``text`` is provided in the payload, the chapter text is updated before
    regeneration.  The response is returned immediately with status 202.
    The actual work runs asynchronously in the arq worker.
    """
    repo = AudiobookRepository(db)
    audiobook = await repo.get_by_id(audiobook_id)
    if audiobook is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Audiobook {audiobook_id} not found",
        )

    # Validate chapter index
    if audiobook.chapters:
        if chapter_index < 0 or chapter_index >= len(audiobook.chapters):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"chapter_index {chapter_index} is out of range (0..{len(audiobook.chapters) - 1})",
            )

    new_text = payload.text if payload else None

    # Enqueue arq job
    arq = get_arq_pool()
    await arq.enqueue_job(
        "regenerate_audiobook_chapter",
        str(audiobook_id),
        chapter_index,
        new_text,
    )

    log.info(
        "audiobook.regenerate_chapter.enqueued",
        audiobook_id=str(audiobook_id),
        chapter_index=chapter_index,
        has_new_text=new_text is not None,
    )

    return {
        "message": f"Chapter {chapter_index} regeneration enqueued",
        "audiobook_id": str(audiobook_id),
        "chapter_index": chapter_index,
    }


class ChapterImageRegeneratePayload(BaseModel):
    prompt_override: str | None = Field(
        default=None,
        description=(
            "Optional ComfyUI prompt to use instead of the chapter title. "
            "Useful when the auto-derived prompt produces a poor image."
        ),
    )


@router.post(
    "/{audiobook_id}/regenerate-chapter-image/{chapter_index}",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Regenerate a single chapter's illustration",
)
async def regenerate_chapter_image(
    audiobook_id: UUID,
    chapter_index: int,
    payload: ChapterImageRegeneratePayload | None = None,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Regenerate a single chapter's image only.

    Faster than the full chapter regen (which re-synthesizes audio +
    re-assembles the audiobook). Only the ComfyUI image generation
    runs; the audiobook video is NOT re-rendered, but the chapter's
    ``image_path`` is updated so the next assembly picks it up.
    """
    repo = AudiobookRepository(db)
    audiobook = await repo.get_by_id(audiobook_id)
    if audiobook is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Audiobook {audiobook_id} not found",
        )
    if audiobook.chapters:
        if chapter_index < 0 or chapter_index >= len(audiobook.chapters):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"chapter_index {chapter_index} is out of range "
                    f"(0..{len(audiobook.chapters) - 1})"
                ),
            )
    else:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Audiobook has no chapters yet",
        )

    prompt_override = payload.prompt_override if payload else None

    arq = get_arq_pool()
    await arq.enqueue_job(
        "regenerate_audiobook_chapter_image",
        str(audiobook_id),
        chapter_index,
        prompt_override,
    )

    log.info(
        "audiobook.regenerate_chapter_image.enqueued",
        audiobook_id=str(audiobook_id),
        chapter_index=chapter_index,
        has_prompt_override=prompt_override is not None,
    )

    return {
        "message": f"Chapter {chapter_index} image regeneration enqueued",
        "audiobook_id": str(audiobook_id),
        "chapter_index": chapter_index,
    }


# ── Regenerate full audiobook ──────────────────────────────────────────


@router.put(
    "/{audiobook_id}/voices",
    status_code=status.HTTP_200_OK,
    summary="Update voice casting and optionally regenerate",
)
async def update_audiobook_voices(
    audiobook_id: UUID,
    payload: dict[
        str, Any
    ],  # {"voice_casting": {"Narrator": "id", "Jack": "id"}, "regenerate": true}
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Update voice assignments for an audiobook. Optionally regenerate audio."""
    repo = AudiobookRepository(db)
    audiobook = await repo.get_by_id(audiobook_id)
    if audiobook is None:
        raise HTTPException(status_code=404, detail="Audiobook not found")

    voice_casting = payload.get("voice_casting")
    default_voice_id = payload.get("voice_profile_id")

    updates: dict[str, Any] = {}
    if voice_casting:
        updates["voice_casting"] = voice_casting
    if default_voice_id:
        updates["voice_profile_id"] = UUID(default_voice_id)

    if updates:
        await repo.update(audiobook_id, **updates)
        await db.commit()

    # Optionally regenerate
    if payload.get("regenerate", False):
        await repo.update(audiobook_id, status="generating", error_message=None)
        await db.commit()
        arq = get_arq_pool()
        await arq.enqueue_job("generate_audiobook", str(audiobook_id))
        return {"message": "Voices updated and regeneration started", "status": "generating"}

    return {"message": "Voices updated"}


@router.post(
    "/{audiobook_id}/regenerate",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Regenerate the entire audiobook audio",
)
async def regenerate_audiobook(
    audiobook_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Regenerate the entire audiobook from its current text.

    Marks the audiobook as ``generating`` and enqueues the job.
    """
    repo = AudiobookRepository(db)
    audiobook = await repo.get_by_id(audiobook_id)
    if audiobook is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Audiobook {audiobook_id} not found",
        )

    await repo.update(audiobook_id, status="generating", error_message=None)
    await db.commit()

    arq = get_arq_pool()
    await arq.enqueue_job(
        "generate_audiobook",
        str(audiobook_id),
        False,
    )

    log.info(
        "audiobook.regenerate.enqueued",
        audiobook_id=str(audiobook_id),
    )

    return {
        "message": "Full audiobook regeneration enqueued",
        "audiobook_id": str(audiobook_id),
    }


# ── Delete audiobook ────────────────────────────────────────────────────


@router.delete(
    "/{audiobook_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an audiobook and its files",
)
async def delete_audiobook(
    audiobook_id: UUID,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> None:
    """Delete an audiobook record and clean up generated files."""
    repo = AudiobookRepository(db)
    audiobook = await repo.get_by_id(audiobook_id)
    if audiobook is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Audiobook {audiobook_id} not found",
        )

    # Clean up files on disk
    audiobook_dir = settings.storage_base_path / "audiobooks" / str(audiobook_id)
    if audiobook_dir.exists():
        shutil.rmtree(audiobook_dir, ignore_errors=True)
        log.info(
            "audiobook.files_deleted",
            audiobook_id=str(audiobook_id),
            path=str(audiobook_dir),
        )

    await repo.delete(audiobook_id)
    await db.commit()


# ── YouTube upload ────────────────────────────────────────────────────


class AudiobookYouTubeUploadRequest(BaseModel):
    """Payload for uploading an audiobook video to YouTube."""

    title: str = Field(..., min_length=1, max_length=100)
    description: str = Field(default="", max_length=5000)
    tags: list[str] = Field(default_factory=list)
    privacy_status: str = Field(default="private")


@router.post(
    "/{audiobook_id}/upload-youtube",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Upload audiobook video to YouTube",
)
async def upload_audiobook_to_youtube(
    audiobook_id: UUID,
    payload: AudiobookYouTubeUploadRequest,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Upload the audiobook's video to YouTube.

    Requires an active YouTube channel connection and a generated video
    (``output_format`` must be ``audio_image`` or ``audio_video``).

    Creates a :class:`YouTubeAudiobookUpload` record to track the upload.
    """
    from drevalis.api.routes.youtube._monolith import _build_youtube_service
    from drevalis.repositories.youtube import (
        YouTubeAudiobookUploadRepository,
        YouTubeChannelRepository,
    )

    # Build the YouTube service with env OR db-stored credentials.
    # Raises 503 with a helpful message if neither source has keys set.
    yt_service = await _build_youtube_service(settings, db)

    # Validate audiobook exists and has a video FIRST so we can use its
    # per-audiobook youtube_channel_id to resolve the channel (respects
    # the multi-channel contract; falls back to single-channel install).
    repo = AudiobookRepository(db)
    audiobook = await repo.get_by_id(audiobook_id)
    if audiobook is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Audiobook {audiobook_id} not found",
        )

    channel_repo = YouTubeChannelRepository(db)
    channel = None
    # 1. Per-audiobook assignment.
    if getattr(audiobook, "youtube_channel_id", None):
        channel = await channel_repo.get_by_id(audiobook.youtube_channel_id)
    # 2. Single-channel install: implicit pick.
    if channel is None:
        all_channels = await channel_repo.get_all_channels()
        if len(all_channels) == 1:
            channel = all_channels[0]
    if channel is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "no_channel_selected",
                "hint": (
                    "Assign a youtube_channel_id to the audiobook, or connect a "
                    "single YouTube channel so the target is unambiguous."
                ),
            },
        )

    if not audiobook.video_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No video file found for this audiobook. "
            "Generate with output_format 'audio_image' or 'audio_video' first.",
        )

    video_path = Path(settings.storage_base_path) / audiobook.video_path
    if not video_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Video file not found on disk",
        )

    # Refresh tokens if needed
    updated_tokens = await yt_service.refresh_tokens_if_needed(
        channel.access_token_encrypted or "",
        channel.refresh_token_encrypted,
        channel.token_expiry,
    )
    if updated_tokens:
        for key, value in updated_tokens.items():
            setattr(channel, key, value)
        await db.flush()

    # Create an upload tracking record before the network call
    upload_repo = YouTubeAudiobookUploadRepository(db)
    upload = await upload_repo.create(
        audiobook_id=audiobook_id,
        channel_id=channel.id,
        title=payload.title,
        privacy_status=payload.privacy_status,
        upload_status="uploading",
    )
    await db.commit()
    await db.refresh(upload)

    # Perform the upload
    try:
        result = await yt_service.upload_video(
            access_token_encrypted=channel.access_token_encrypted or "",
            refresh_token_encrypted=channel.refresh_token_encrypted,
            token_expiry=channel.token_expiry,
            video_path=video_path,
            title=payload.title,
            description=payload.description,
            tags=payload.tags,
            privacy_status=payload.privacy_status,
            thumbnail_path=None,
        )

        upload.youtube_video_id = result["video_id"]
        upload.youtube_url = result["url"]
        upload.upload_status = "done"
        await db.commit()

        log.info(
            "audiobook.youtube_upload_success",
            audiobook_id=str(audiobook_id),
            video_id=result["video_id"],
            upload_id=str(upload.id),
        )

        return {
            "status": "done",
            "youtube_video_id": result["video_id"],
            "youtube_url": result["url"],
            "upload_id": str(upload.id),
        }

    except Exception as exc:
        upload.upload_status = "failed"
        upload.error_message = str(exc)[:1000]
        await db.commit()

        log.error(
            "audiobook.youtube_upload_failed",
            audiobook_id=str(audiobook_id),
            error=str(exc),
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"YouTube upload failed: {exc}",
        ) from exc


@router.get(
    "/{audiobook_id}/uploads",
    status_code=status.HTTP_200_OK,
    summary="List YouTube upload history for an audiobook",
)
async def list_audiobook_uploads(
    audiobook_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return all YouTube upload attempts for a given audiobook, newest first."""
    from drevalis.repositories.youtube import YouTubeAudiobookUploadRepository

    # Verify the audiobook exists first
    repo = AudiobookRepository(db)
    audiobook = await repo.get_by_id(audiobook_id)
    if audiobook is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Audiobook {audiobook_id} not found",
        )

    upload_repo = YouTubeAudiobookUploadRepository(db)
    uploads = await upload_repo.get_by_audiobook(audiobook_id)

    return [
        {
            "id": str(u.id),
            "audiobook_id": str(u.audiobook_id),
            "youtube_video_id": u.youtube_video_id,
            "youtube_url": u.youtube_url,
            "title": u.title,
            "privacy_status": u.privacy_status,
            "upload_status": u.upload_status,
            "error_message": u.error_message,
            "playlist_id": u.playlist_id,
            "created_at": u.created_at.isoformat(),
            "updated_at": u.updated_at.isoformat(),
        }
        for u in uploads
    ]
