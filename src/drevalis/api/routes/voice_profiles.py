"""Voice Profiles API router -- CRUD and voice testing."""

from __future__ import annotations

import asyncio
from pathlib import Path
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from drevalis.core.config import Settings
from drevalis.core.deps import get_db, get_settings
from drevalis.core.security import decrypt_value
from drevalis.repositories.comfyui import ComfyUIServerRepository
from drevalis.repositories.voice_profile import VoiceProfileRepository
from drevalis.schemas.voice_profile import (
    VoiceProfileCreate,
    VoiceProfileResponse,
    VoiceProfileUpdate,
    VoiceTestRequest,
    VoiceTestResponse,
)

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/voice-profiles", tags=["voice-profiles"])


# ── List voice profiles ──────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[VoiceProfileResponse],
    status_code=status.HTTP_200_OK,
    summary="List all voice profiles",
)
async def list_voice_profiles(
    provider: str | None = Query(default=None, description="Filter by provider"),
    db: AsyncSession = Depends(get_db),
) -> list[VoiceProfileResponse]:
    """Return all voice profiles, optionally filtered by provider."""
    repo = VoiceProfileRepository(db)
    if provider is not None:
        profiles = await repo.get_by_provider(provider)
    else:
        profiles = await repo.get_all()
    return [VoiceProfileResponse.model_validate(p) for p in profiles]


# ── Generate ElevenLabs voice previews ───────────────────────────────────

#: Maximum seconds to wait for a single voice synthesis before skipping it.
_PREVIEW_SYNTHESIS_TIMEOUT: int = 60

#: Sample text template for generated previews.  ``{voice_name}`` is replaced
#: with the human-readable part of the voice ID (e.g. "Roger").
_PREVIEW_TEXT_TEMPLATE = (
    "Hello, this is {voice_name}. "
    "I can narrate your stories, bring characters to life, "
    "and create engaging content."
)


@router.post(
    "/generate-previews",
    status_code=status.HTTP_200_OK,
    summary="Generate audio previews for all ElevenLabs voice profiles",
    description=(
        "Iterates over every voice profile whose provider is "
        "``comfyui_elevenlabs`` and that does not yet have a valid preview "
        "file on disk. For each one a short TTS sample is synthesised via "
        "ComfyUI, saved to ``storage/voice_previews/{profile_id}.wav``, and "
        "the ``sample_audio_path`` column is updated. Already-previewed "
        "profiles are skipped. Returns counts of generated, skipped, and "
        "failed profiles."
    ),
)
async def generate_voice_previews(
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, int | str]:
    """Generate and cache audio previews for all ComfyUI ElevenLabs profiles.

    Processing is sequential so that a single overloaded ComfyUI server is
    not flooded with concurrent prompt submissions.  Each synthesis attempt
    is wrapped in an ``asyncio.timeout`` guard; profiles that time out or
    raise are counted as failures and logged, but do not abort the batch.

    Returns:
        A dict with ``generated``, ``skipped``, ``failed``, and ``message``
        keys summarising the batch result.
    """
    from drevalis.services.tts import ComfyUIElevenLabsTTSProvider

    vp_repo = VoiceProfileRepository(db)
    profiles = await vp_repo.get_by_provider("comfyui_elevenlabs")

    if not profiles:
        return {
            "generated": 0,
            "skipped": 0,
            "failed": 0,
            "message": "No comfyui_elevenlabs voice profiles found.",
        }

    # Resolve the first active ComfyUI server -- the provider handles its own
    # HTTP connection lifecycle, so we only need the URL and optional API key.
    comfyui_repo = ComfyUIServerRepository(db)
    active_servers = await comfyui_repo.get_active_servers()
    if not active_servers:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No active ComfyUI server is configured.",
        )

    server = active_servers[0]
    comfyui_api_key: str | None = None
    if server.api_key_encrypted:
        try:
            comfyui_api_key = decrypt_value(server.api_key_encrypted, settings.encryption_key)
        except Exception:
            # Proceed without the key; ComfyUI may still accept the request if
            # it does not enforce authentication locally.
            log.warning(
                "voice_preview.comfyui_key_decrypt_failed",
                server_id=str(server.id),
            )

    provider = ComfyUIElevenLabsTTSProvider(
        comfyui_base_url=server.url,
        comfyui_api_key=comfyui_api_key,
    )

    preview_dir: Path = settings.storage_base_path / "voice_previews"
    preview_dir.mkdir(parents=True, exist_ok=True)

    generated = 0
    skipped = 0
    failed = 0

    for profile in profiles:
        # Skip profiles that already have a valid preview file on disk.
        if profile.sample_audio_path:
            full_path: Path = settings.storage_base_path / profile.sample_audio_path
            if full_path.exists():
                skipped += 1
                continue

        voice_id: str | None = profile.elevenlabs_voice_id
        if not voice_id:
            log.warning(
                "voice_preview.no_voice_id",
                profile_id=str(profile.id),
                profile_name=profile.name,
            )
            failed += 1
            continue

        # Extract the human-readable name before the parenthesised metadata,
        # e.g. "Roger (male, american)" -> "Roger".
        voice_name = voice_id.split(" (")[0].strip()
        sample_text = _PREVIEW_TEXT_TEMPLATE.format(voice_name=voice_name)

        output_path: Path = preview_dir / f"{profile.id}.wav"

        try:
            async with asyncio.timeout(_PREVIEW_SYNTHESIS_TIMEOUT):
                await provider.synthesize(sample_text, voice_id, output_path)
        except TimeoutError:
            log.warning(
                "voice_preview.timeout",
                profile_id=str(profile.id),
                profile_name=profile.name,
                timeout_seconds=_PREVIEW_SYNTHESIS_TIMEOUT,
            )
            failed += 1
            continue
        except Exception as exc:
            log.warning(
                "voice_preview.synthesis_failed",
                profile_id=str(profile.id),
                profile_name=profile.name,
                error=str(exc),
            )
            failed += 1
            continue

        # Persist the relative path so the frontend can derive the static URL.
        rel_path = f"voice_previews/{profile.id}.wav"
        await vp_repo.update(profile.id, sample_audio_path=rel_path)
        generated += 1
        log.info(
            "voice_preview.generated",
            profile_id=str(profile.id),
            profile_name=profile.name,
            path=rel_path,
        )

    # A single commit covers all `vp_repo.update` calls above.
    await db.commit()

    message = f"Generated {generated} preview(s), skipped {skipped} existing, {failed} failed."
    return {
        "generated": generated,
        "skipped": skipped,
        "failed": failed,
        "message": message,
    }


# ── Create voice profile ─────────────────────────────────────────────────


@router.post(
    "",
    response_model=VoiceProfileResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new voice profile",
)
async def create_voice_profile(
    payload: VoiceProfileCreate,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> VoiceProfileResponse:
    """Create a new voice profile and auto-generate a voice preview."""
    repo = VoiceProfileRepository(db)
    profile = await repo.create(**payload.model_dump())
    await db.commit()
    await db.refresh(profile)

    # Auto-generate a voice preview (best-effort, does not block creation)
    preview_text = (
        "Welcome to Drevalis. This is how I sound when narrating "
        "your videos. Pretty cool, right?"
    )
    try:
        preview_dir = settings.storage_base_path / "voice_previews"
        preview_dir.mkdir(parents=True, exist_ok=True)
        preview_path = preview_dir / f"{profile.id}.wav"

        from drevalis.services.tts import TTSProvider

        provider: TTSProvider | None = None
        voice_id: str | None = None

        if profile.provider == "edge":
            from drevalis.services.tts import EdgeTTSProvider

            provider = EdgeTTSProvider()
            voice_id = profile.edge_voice_id
        elif profile.provider == "piper":
            from drevalis.services.tts import PiperTTSProvider

            provider = PiperTTSProvider(models_path=settings.piper_models_path)
            voice_id = (
                Path(profile.piper_model_path).stem
                if profile.piper_model_path
                else profile.piper_speaker_id
            )
        elif profile.provider == "kokoro":
            from drevalis.services.tts import KokoroTTSProvider

            provider = KokoroTTSProvider(models_path=settings.kokoro_models_path)
            voice_id = profile.kokoro_voice_name

        if provider and voice_id:
            await provider.synthesize(
                preview_text,
                voice_id,
                preview_path,
                speed=float(profile.speed) if profile.speed else 1.0,
            )
            profile.sample_audio_path = f"voice_previews/{profile.id}.wav"
            await db.commit()
            await db.refresh(profile)
    except Exception as e:
        log.warning("voice_preview_generation_failed", error=str(e))

    return VoiceProfileResponse.model_validate(profile)


# ── Get voice profile ────────────────────────────────────────────────────


@router.get(
    "/{profile_id}",
    response_model=VoiceProfileResponse,
    status_code=status.HTTP_200_OK,
    summary="Get a voice profile by ID",
)
async def get_voice_profile(
    profile_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> VoiceProfileResponse:
    """Fetch a single voice profile by ID."""
    repo = VoiceProfileRepository(db)
    profile = await repo.get_by_id(profile_id)
    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"VoiceProfile {profile_id} not found",
        )
    return VoiceProfileResponse.model_validate(profile)


# ── Update voice profile ─────────────────────────────────────────────────


@router.put(
    "/{profile_id}",
    response_model=VoiceProfileResponse,
    status_code=status.HTTP_200_OK,
    summary="Update a voice profile",
)
async def update_voice_profile(
    profile_id: UUID,
    payload: VoiceProfileUpdate,
    db: AsyncSession = Depends(get_db),
) -> VoiceProfileResponse:
    """Update an existing voice profile."""
    repo = VoiceProfileRepository(db)
    update_data = payload.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No fields to update",
        )
    profile = await repo.update(profile_id, **update_data)
    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"VoiceProfile {profile_id} not found",
        )
    await db.commit()
    await db.refresh(profile)
    return VoiceProfileResponse.model_validate(profile)


# ── Delete voice profile ─────────────────────────────────────────────────


@router.delete(
    "/{profile_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a voice profile",
)
async def delete_voice_profile(
    profile_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a voice profile by ID."""
    repo = VoiceProfileRepository(db)
    deleted = await repo.delete(profile_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"VoiceProfile {profile_id} not found",
        )
    await db.commit()


# ── Test voice profile ───────────────────────────────────────────────────


@router.post(
    "/{profile_id}/test",
    response_model=VoiceTestResponse,
    status_code=status.HTTP_200_OK,
    summary="Test voice with sample text",
)
async def test_voice_profile(
    profile_id: UUID,
    payload: VoiceTestRequest | None = None,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> VoiceTestResponse:
    """Synthesise a short sample and return the result.

    Uses Piper or ElevenLabs depending on the voice profile's provider.
    """
    repo = VoiceProfileRepository(db)
    profile = await repo.get_by_id(profile_id)
    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"VoiceProfile {profile_id} not found",
        )

    text = "Hello, this is a test of the voice profile."
    if payload is not None:
        text = payload.text

    try:
        from drevalis.services.tts import (
            EdgeTTSProvider,
            KokoroTTSProvider,
            PiperTTSProvider,
            TTSProvider,
        )

        output_dir = settings.storage_base_path / "temp" / "voice_tests"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"test_{profile_id}.wav"

        provider: TTSProvider
        voice_id: str

        if profile.provider == "piper":
            provider = PiperTTSProvider(models_path=settings.piper_models_path)
            voice_id = (
                Path(profile.piper_model_path).stem
                if profile.piper_model_path
                else profile.piper_speaker_id or ""
            )
        elif profile.provider == "elevenlabs":
            if not profile.elevenlabs_voice_id:
                return VoiceTestResponse(
                    success=False,
                    message="ElevenLabs voice ID is not configured on this profile",
                )
            # ElevenLabs requires an API key -- for now we return an error
            # if it cannot be resolved.
            return VoiceTestResponse(
                success=False,
                message="ElevenLabs voice testing requires API key configuration "
                "at the application level. Use the TTS service directly.",
            )
        elif profile.provider == "edge":
            provider = EdgeTTSProvider()
            voice_id = profile.edge_voice_id or ""
        elif profile.provider == "kokoro":
            provider = KokoroTTSProvider(models_path=settings.kokoro_models_path)
            voice_id = profile.kokoro_voice_name or ""
        else:
            return VoiceTestResponse(
                success=False,
                message=f"Unknown provider: {profile.provider}",
            )

        result = await provider.synthesize(
            text,
            voice_id,
            output_path,
            speed=float(profile.speed),
            pitch=float(profile.pitch),
        )
        return VoiceTestResponse(
            success=True,
            message="Voice test completed successfully",
            audio_path=result.audio_path,
            duration_seconds=result.duration_seconds,
        )
    except Exception as exc:
        return VoiceTestResponse(
            success=False,
            message=f"Voice test failed: {exc}",
        )
