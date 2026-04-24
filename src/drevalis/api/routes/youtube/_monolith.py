"""YouTube integration API routes — OAuth, upload, and status."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from uuid import UUID, uuid4

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from drevalis.core.config import Settings
from drevalis.core.deps import get_db, get_redis, get_settings
from drevalis.repositories.episode import EpisodeRepository
from drevalis.repositories.media_asset import MediaAssetRepository
from drevalis.repositories.youtube import (
    YouTubeChannelRepository,
    YouTubePlaylistRepository,
    YouTubeUploadRepository,
)
from drevalis.schemas.youtube import (
    PlaylistAddVideo,
    PlaylistCreate,
    PlaylistResponse,
    VideoStatsResponse,
    YouTubeAuthURLResponse,
    YouTubeChannelResponse,
    YouTubeChannelUpdate,
    YouTubeConnectionStatus,
    YouTubeUploadListResponse,
    YouTubeUploadRequest,
    YouTubeUploadResponse,
)
from drevalis.services.youtube import AnalyticsNotAuthorized, YouTubeService

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/youtube", tags=["youtube"])


# ── Helpers ──────────────────────────────────────────────────────────────


async def _resolve_youtube_credentials(settings: Settings, db: AsyncSession) -> tuple[str, str]:
    """Resolve the YouTube OAuth client credentials.

    Priority order:
    1. ``.env`` / environment variables (``YOUTUBE_CLIENT_ID`` /
       ``YOUTUBE_CLIENT_SECRET``) — fastest, no DB lookup.
    2. Database ``api_key_store`` table — where the Settings → API Keys
       UI writes keys after Fernet encryption.

    Before this helper existed, the Settings UI's "Save YouTube key"
    path persisted to the DB but the YouTube router only read from the
    Settings object → user saved creds successfully yet every YouTube
    call returned 503 ``not_configured``. Now both sources merge; the
    UI is a first-class configuration surface.
    """
    from drevalis.core.security import decrypt_value
    from drevalis.repositories.api_key_store import ApiKeyStoreRepository

    client_id = settings.youtube_client_id
    client_secret = settings.youtube_client_secret

    # Fall back to the DB store for anything that's blank in settings.
    if not client_id or not client_secret:
        repo = ApiKeyStoreRepository(db)
        if not client_id:
            row = await repo.get_by_key_name("youtube_client_id")
            if row and row.encrypted_value:
                try:
                    client_id = decrypt_value(
                        row.encrypted_value,
                        settings.encryption_key,
                    )
                except Exception as exc:  # noqa: BLE001
                    # v0.20.16 — surface decryption failures instead of
                    # silently falling back to empty. The most common
                    # cause is a backup restored onto a different
                    # ENCRYPTION_KEY; the user needs to know the key
                    # is stored but can't be read with the current
                    # Fernet key, not "integration not configured".
                    logger.warning(
                        "youtube_client_id_decrypt_failed",
                        error=f"{type(exc).__name__}: {str(exc)[:120]}",
                    )
                    client_id = ""
        if not client_secret:
            row = await repo.get_by_key_name("youtube_client_secret")
            if row and row.encrypted_value:
                try:
                    client_secret = decrypt_value(
                        row.encrypted_value,
                        settings.encryption_key,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "youtube_client_secret_decrypt_failed",
                        error=f"{type(exc).__name__}: {str(exc)[:120]}",
                    )
                    client_secret = ""

    return client_id, client_secret


async def _build_youtube_service(settings: Settings, db: AsyncSession) -> YouTubeService:
    """Build a YouTubeService, pulling credentials from env + DB store."""
    client_id, client_secret = await _resolve_youtube_credentials(settings, db)
    if not client_id or not client_secret:
        # If there ARE rows in api_key_store for these names but we still
        # ended up with blanks, decryption failed — ENCRYPTION_KEY was
        # rotated or the rows came from a backup made with a different
        # key. Surface that specifically.
        from drevalis.repositories.api_key_store import ApiKeyStoreRepository

        repo = ApiKeyStoreRepository(db)
        has_id_row = await repo.get_by_key_name("youtube_client_id") is not None
        has_secret_row = await repo.get_by_key_name("youtube_client_secret") is not None
        if has_id_row or has_secret_row:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "error": "youtube_key_decrypt_failed",
                    "hint": (
                        "YouTube keys ARE stored in the DB but can't be "
                        "decrypted with the current ENCRYPTION_KEY. This "
                        "usually means a backup was restored onto a "
                        "different encryption key. Either restore the "
                        "original ENCRYPTION_KEY in your .env, or delete "
                        "the old keys under Settings → API Keys and "
                        "re-enter them so they're re-encrypted."
                    ),
                    "id_stored": has_id_row,
                    "secret_stored": has_secret_row,
                },
            )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "YouTube integration is not configured. Set "
                "YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET in your .env "
                "file, OR add them via Settings → Integrations → YouTube "
                "(they'll be Fernet-encrypted at rest)."
            ),
        )
    return YouTubeService(
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=settings.youtube_redirect_uri,
        encryption_key=settings.encryption_key,
    )


def _get_youtube_service(settings: Settings) -> YouTubeService:
    """Legacy sync wrapper — kept only for callers that haven't been
    converted to the async resolver yet. Ignores the DB-stored keys;
    new code should call ``_build_youtube_service(settings, db)``.
    """
    if not settings.youtube_client_id or not settings.youtube_client_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "YouTube integration is not configured. Set "
                "YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET in your .env, "
                "OR add them via Settings → Integrations → YouTube."
            ),
        )
    return YouTubeService(
        client_id=settings.youtube_client_id,
        client_secret=settings.youtube_client_secret,
        redirect_uri=settings.youtube_redirect_uri,
        encryption_key=settings.encryption_key,
    )


# ── OAuth flow ───────────────────────────────────────────────────────────


@router.get(
    "/auth-url",
    response_model=YouTubeAuthURLResponse,
    status_code=status.HTTP_200_OK,
    summary="Get YouTube OAuth authorization URL",
)
async def get_auth_url(
    settings: Settings = Depends(get_settings),
    redis: Redis = Depends(get_redis),
    db: AsyncSession = Depends(get_db),
) -> YouTubeAuthURLResponse:
    """Generate and return the Google OAuth consent URL.

    The ``state`` parameter is recorded in Redis (10-minute TTL) so the
    callback endpoint can verify it has not been forged. This prevents
    CSRF attacks where an attacker tricks the operator into binding an
    attacker-controlled YouTube channel to this install.
    """
    svc = await _build_youtube_service(settings, db)
    url, state = svc.get_auth_url()
    try:
        await redis.setex(f"youtube_oauth_state:{state}", 600, "1")
    except Exception:
        logger.warning("youtube_oauth_state_persist_failed", exc_info=True)
    logger.info("youtube_auth_url_generated", state=state)
    return YouTubeAuthURLResponse(auth_url=url)


@router.get(
    "/callback",
    response_model=YouTubeChannelResponse,
    status_code=status.HTTP_200_OK,
    summary="Handle YouTube OAuth callback",
)
async def oauth_callback(
    code: str = Query(..., description="Authorization code from Google"),
    state: str | None = Query(None, description="OAuth state parameter"),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
    redis: Redis = Depends(get_redis),
) -> YouTubeChannelResponse:
    """Exchange the OAuth authorization code for tokens, store channel info.

    Validates that ``state`` was issued by this install (via Redis lookup).
    Rejects callbacks where ``state`` is missing, unknown, or already
    consumed — these indicate either a forged/replayed flow or a stale
    browser tab, neither of which should be allowed to bind a channel.
    """
    if not state:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing OAuth state parameter.",
        )
    state_key = f"youtube_oauth_state:{state}"
    try:
        # GETDEL is atomic — prevents state reuse (double-submit replay).
        stored = await redis.getdel(state_key)
    except Exception as exc:
        logger.error("youtube_oauth_state_lookup_failed", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OAuth state store unavailable.",
        ) from exc
    if not stored:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired OAuth state; retry the connect flow.",
        )

    svc = await _build_youtube_service(settings, db)

    try:
        channel_info = await svc.handle_callback(code, state=state)
    except Exception as exc:
        logger.error("youtube_oauth_callback_failed", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="OAuth callback failed. Check server logs for details.",
        ) from exc

    repo = YouTubeChannelRepository(db)

    # Check if this channel already exists.
    existing = await repo.get_by_channel_id(channel_info["channel_id"])
    if existing:
        existing.channel_name = channel_info["channel_name"]
        existing.access_token_encrypted = channel_info["access_token_encrypted"]
        existing.refresh_token_encrypted = channel_info["refresh_token_encrypted"]
        existing.token_key_version = channel_info["token_key_version"]
        existing.token_expiry = channel_info.get("token_expiry")
        existing.is_active = True
        await db.flush()
        await db.refresh(existing)
        channel = existing
    else:
        # Enforce tier-based YouTube channel cap before creating a new one.
        # Re-connecting an already-linked channel is always allowed (above).
        from drevalis.core.license.features import TIER_CHANNEL_CAP
        from drevalis.core.license.state import get_state as _get_license_state

        _lic = _get_license_state()
        if _lic.is_usable and _lic.claims is not None:
            cap = TIER_CHANNEL_CAP.get(_lic.claims.tier, 1)
            existing_count = len(await repo.get_all_channels())
            if existing_count >= cap:
                raise HTTPException(
                    status_code=status.HTTP_402_PAYMENT_REQUIRED,
                    detail={
                        "error": "channel_cap_exceeded",
                        "tier": _lic.claims.tier,
                        "limit": cap,
                        "hint": "Upgrade tier to connect more YouTube channels.",
                    },
                )

        channel = await repo.create(
            channel_id=channel_info["channel_id"],
            channel_name=channel_info["channel_name"],
            access_token_encrypted=channel_info["access_token_encrypted"],
            refresh_token_encrypted=channel_info["refresh_token_encrypted"],
            token_key_version=channel_info["token_key_version"],
            token_expiry=channel_info.get("token_expiry"),
            is_active=True,
        )

    await db.commit()
    await db.refresh(channel)

    logger.info(
        "youtube_channel_connected",
        channel_id=channel.channel_id,
        channel_name=channel.channel_name,
    )
    return YouTubeChannelResponse.model_validate(channel)


# ── Connection status ────────────────────────────────────────────────────


@router.get(
    "/status",
    response_model=YouTubeConnectionStatus,
    status_code=status.HTTP_200_OK,
    summary="Check YouTube connection status",
)
async def connection_status(
    db: AsyncSession = Depends(get_db),
) -> YouTubeConnectionStatus:
    """Return whether a YouTube channel is connected and its basic info."""
    repo = YouTubeChannelRepository(db)
    all_channels = await repo.get_all_channels()
    channel = await repo.get_active()

    if not all_channels:
        return YouTubeConnectionStatus(connected=False, channel=None, channels=[])

    channel_responses = [YouTubeChannelResponse.model_validate(c) for c in all_channels]
    return YouTubeConnectionStatus(
        connected=True,
        channel=YouTubeChannelResponse.model_validate(channel) if channel else channel_responses[0],
        channels=channel_responses,
    )


# ── Disconnect ───────────────────────────────────────────────────────────


@router.post(
    "/disconnect",
    status_code=status.HTTP_200_OK,
    summary="Disconnect YouTube channel",
)
async def disconnect(
    channel_id: UUID | None = Query(None, description="Specific channel to disconnect"),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """Remove a YouTube channel connection.

    Destructive by design. When multiple channels are connected,
    ``channel_id`` is REQUIRED so the operator can't accidentally
    disconnect the wrong account via the UI's default state.
    """
    repo = YouTubeChannelRepository(db)

    if channel_id:
        channel = await repo.get_by_id(channel_id)
    else:
        all_channels = await repo.get_all_channels()
        if len(all_channels) > 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "channel_id_required",
                    "reason": (
                        "Multiple channels are connected; disconnect is "
                        "destructive, so the caller must specify which one. "
                        "Pass ?channel_id=<uuid>."
                    ),
                    "connected_channels": [
                        {"id": str(c.id), "name": c.channel_name} for c in all_channels
                    ],
                },
            )
        channel = all_channels[0] if all_channels else None

    if channel is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No YouTube channel found to disconnect",
        )

    # Wipe tokens and deactivate.
    channel.access_token_encrypted = None
    channel.refresh_token_encrypted = None
    channel.token_expiry = None
    channel.is_active = False
    await db.commit()

    logger.info(
        "youtube_channel_disconnected",
        channel_id=channel.channel_id,
    )
    return {"message": f"Disconnected YouTube channel: {channel.channel_name}"}


@router.get(
    "/channels",
    response_model=list[YouTubeChannelResponse],
    status_code=status.HTTP_200_OK,
    summary="List all connected YouTube channels",
)
async def list_channels(
    include_inactive: bool = Query(
        False,
        description="Include channels that have been disconnected",
    ),
    db: AsyncSession = Depends(get_db),
) -> list[YouTubeChannelResponse]:
    """Return connected YouTube channels.

    By default only *active* (currently-connected) channels are returned.
    A "disconnected" channel still exists in the database (so we can
    preserve its upload history and re-upsert tokens on reconnect via the
    OAuth callback), but it should not appear in the default list — the
    UI would otherwise render stale, token-less rows that look broken.
    Callers that genuinely need the full history (e.g. admin tooling)
    can pass ``?include_inactive=true``.
    """
    repo = YouTubeChannelRepository(db)
    channels = await repo.get_all_channels()
    if not include_inactive:
        channels = [c for c in channels if c.is_active]
    return [YouTubeChannelResponse.model_validate(c) for c in channels]


# ── Delete (full removal) ────────────────────────────────────────────────


@router.delete(
    "/channels/{channel_id}",
    status_code=status.HTTP_200_OK,
    summary="Permanently delete a YouTube channel connection",
)
async def delete_channel(
    channel_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """Hard-delete a channel row plus its cascaded upload history.

    Differs from ``/disconnect`` which only wipes tokens and sets
    ``is_active=False``. This endpoint is for operators who genuinely
    want the channel (and all of its bookkeeping) gone — e.g. because
    they connected the wrong Google account. Upload records pointing
    at this channel cascade-delete via the FK constraint.
    """
    repo = YouTubeChannelRepository(db)
    channel = await repo.get_by_id(channel_id)
    if channel is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"YouTube channel {channel_id} not found",
        )
    name = channel.channel_name
    await db.delete(channel)
    await db.commit()
    logger.info("youtube_channel_deleted", channel_id=str(channel_id))
    return {"message": f"Deleted YouTube channel: {name}"}


@router.put(
    "/channels/{channel_id}",
    response_model=YouTubeChannelResponse,
    status_code=status.HTTP_200_OK,
    summary="Update a YouTube channel's scheduling config",
)
async def update_channel(
    channel_id: UUID,
    payload: YouTubeChannelUpdate,
    db: AsyncSession = Depends(get_db),
) -> YouTubeChannelResponse:
    """Update upload_days and upload_time for a channel."""
    repo = YouTubeChannelRepository(db)
    channel = await repo.get_by_id(channel_id)
    if channel is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"YouTube channel {channel_id} not found",
        )

    updates = payload.model_dump(exclude_unset=True)
    for key, value in updates.items():
        setattr(channel, key, value)
    await db.commit()
    await db.refresh(channel)
    return YouTubeChannelResponse.model_validate(channel)


# ── Delete video ─────────────────────────────────────────────────────────


@router.delete(
    "/videos/{youtube_video_id}",
    status_code=status.HTTP_200_OK,
    summary="Delete a video from YouTube",
)
async def delete_video(
    youtube_video_id: str,
    channel_id: UUID = Query(..., description="Channel that owns the video"),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    """Delete a video from YouTube using the owning channel's tokens."""
    svc = await _build_youtube_service(settings, db)
    channel_repo = YouTubeChannelRepository(db)
    channel = await channel_repo.get_by_id(channel_id)
    if channel is None:
        raise HTTPException(status_code=404, detail="Channel not found")

    # Refresh tokens if needed
    updated = await svc.refresh_tokens_if_needed(
        channel.access_token_encrypted or "",
        channel.refresh_token_encrypted,
        channel.token_expiry,
    )
    if updated:
        for key, value in updated.items():
            setattr(channel, key, value)
        await db.flush()

    await svc.delete_video(
        channel.access_token_encrypted or "",
        channel.refresh_token_encrypted,
        channel.token_expiry,
        youtube_video_id,
    )
    await db.commit()

    return {"message": f"Deleted video {youtube_video_id}"}


# ── Upload ───────────────────────────────────────────────────────────────


@router.post(
    "/upload/{episode_id}",
    response_model=YouTubeUploadResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Upload an episode to YouTube",
)
async def upload_episode(
    episode_id: UUID,
    payload: YouTubeUploadRequest,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> YouTubeUploadResponse:
    """Upload the episode's video to YouTube.

    Requires an active YouTube channel connection.  The upload runs
    asynchronously via ``asyncio.to_thread``.
    """
    # Demo mode: return a simulated successful upload instead of calling
    # the real YouTube API (the demo install has no real OAuth tokens).
    if settings.demo_mode:
        fake_id = "demo_" + episode_id.hex[:11]
        now = datetime.now(tz=UTC)
        return YouTubeUploadResponse(
            id=uuid4(),
            episode_id=episode_id,
            channel_id=payload.channel_id or uuid4(),
            youtube_video_id=fake_id,
            youtube_url=f"https://www.youtube.com/watch?v={fake_id}",
            title=payload.title or "Demo episode",
            description=payload.description or "",
            privacy_status=payload.privacy_status or "private",
            upload_status="done",
            created_at=now,
            updated_at=now,
        )

    svc = await _build_youtube_service(settings, db)

    # Validate episode exists.
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if episode is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Episode {episode_id} not found",
        )

    # Resolve YouTube channel: request override > series assignment.
    channel_repo = YouTubeChannelRepository(db)
    channel = None
    if payload.channel_id:
        channel = await channel_repo.get_by_id(payload.channel_id)
    if channel is None and episode.series_id:
        from drevalis.repositories.series import SeriesRepository

        series_repo = SeriesRepository(db)
        series = await series_repo.get_by_id(episode.series_id)
        if series and series.youtube_channel_id:
            channel = await channel_repo.get_by_id(series.youtube_channel_id)
    if channel is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No YouTube channel assigned to this series. "
            "Assign a channel in the series settings or pass channel_id in the request.",
        )

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

    # Auto-generate SEO-optimized metadata using LLM if not already cached.
    seo_data: dict[str, Any] = {}
    episode_meta = episode.metadata_ or {}
    if isinstance(episode_meta, dict) and "seo" in episode_meta:
        seo_data = episode_meta["seo"]
    elif episode.script:
        # Generate SEO on-the-fly
        try:
            import json as _json

            from drevalis.repositories.llm_config import LLMConfigRepository
            from drevalis.schemas.script import EpisodeScript
            from drevalis.services.llm import (
                LLMService,
                OpenAICompatibleProvider,
                _extract_json,
            )

            script_obj = EpisodeScript.model_validate(episode.script)
            narration = " ".join(s.narration for s in script_obj.scenes if s.narration)

            configs = await LLMConfigRepository(db).get_all(limit=1)
            if configs:
                llm_svc = LLMService(storage=None, encryption_key=settings.encryption_key)
                provider = llm_svc.get_provider(configs[0])
            else:
                provider = OpenAICompatibleProvider(
                    base_url=settings.lm_studio_base_url,
                    model=settings.lm_studio_default_model,
                )

            seo_prompt = (
                "You are a YouTube SEO expert. Generate optimized metadata. "
                "Output ONLY valid JSON: "
                '{"title": "SEO title (max 60 chars)", "description": "engaging description with keywords and hashtags (max 2000 chars)", '
                '"hashtags": ["#tag1", "#tag2"], "tags": ["keyword1", "keyword2"]}'
            )
            result = await provider.generate(
                seo_prompt,
                f"Video title: {episode.title}\nContent: {narration[:1000]}\nGenerate SEO metadata:",
                temperature=0.7,
                max_tokens=1024,
                json_mode=True,
            )
            seo_data = _json.loads(_extract_json(result.content))

            # Cache it in episode metadata
            new_meta = dict(episode_meta)
            new_meta["seo"] = seo_data
            await ep_repo.update(episode_id, metadata_=new_meta)
            await db.flush()
            logger.info("seo_auto_generated_for_upload", episode_id=str(episode_id))
        except Exception as exc:
            logger.warning("seo_auto_generation_failed", error=str(exc)[:200])

    # Use SEO data for upload, with payload overrides
    upload_title = payload.title or seo_data.get("title", episode.title)
    upload_description = payload.description or seo_data.get("description", "")
    upload_tags = payload.tags if payload.tags else seo_data.get("tags", [])

    # Append hashtags to description
    seo_hashtags = seo_data.get("hashtags", [])
    if seo_hashtags and isinstance(seo_hashtags, list):
        hashtag_str = " ".join(h if h.startswith("#") else f"#{h}" for h in seo_hashtags)
        if hashtag_str and hashtag_str not in upload_description:
            upload_description = f"{upload_description}\n\n{hashtag_str}"

    # Fallback to script data if no SEO
    script = episode.script or {}
    if not upload_description and isinstance(script, dict):
        parts: list[str] = []
        script_title = script.get("title")
        script_desc = script.get("description")
        script_hashtags = script.get("hashtags")
        if script_title and isinstance(script_title, str):
            parts.append(script_title)
        if script_desc and isinstance(script_desc, str):
            parts.append(script_desc)
        if script_hashtags and isinstance(script_hashtags, list):
            hashtag_str = " ".join(
                f"#{h.lstrip('#')}" for h in script_hashtags if isinstance(h, str)
            )
            if hashtag_str:
                parts.append(hashtag_str)
        upload_description = "\n\n".join(parts)

    if not upload_tags and isinstance(script, dict):
        script_hashtags = script.get("hashtags")
        if script_hashtags and isinstance(script_hashtags, list):
            upload_tags = [h.lstrip("#") for h in script_hashtags if isinstance(h, str)]

    # Check for thumbnail.
    thumb_path: Path | None = None
    thumb_assets = await asset_repo.get_by_episode_and_type(episode_id, "thumbnail")
    if thumb_assets:
        candidate = Path(settings.storage_base_path) / thumb_assets[-1].file_path
        if candidate.exists():
            thumb_path = candidate

    # Refresh tokens if needed. COMMIT immediately so a crash during the
    # multi-minute upload_video call below doesn't lose the newly-minted
    # token - Google has already rotated on their side, and the old one
    # in-memory is stale once upload_video returns or errors.
    from drevalis.services.youtube import YouTubeTokenExpiredError

    try:
        updated_tokens = await svc.refresh_tokens_if_needed(
            channel.access_token_encrypted or "",
            channel.refresh_token_encrypted,
            channel.token_expiry,
        )
    except YouTubeTokenExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": "youtube_token_expired",
                "reason": str(exc),
                "hint": "Reconnect this channel via Settings -> YouTube.",
            },
        ) from exc
    if updated_tokens:
        for key, value in updated_tokens.items():
            setattr(channel, key, value)
        await db.flush()
        await db.commit()

    # Create upload record.
    upload_repo = YouTubeUploadRepository(db)
    upload = await upload_repo.create(
        episode_id=episode_id,
        channel_id=channel.id,
        title=upload_title,
        description=upload_description,
        privacy_status=payload.privacy_status,
        upload_status="uploading",
    )
    await db.commit()
    await db.refresh(upload)

    # Perform the upload.
    try:
        upload_result = await svc.upload_video(
            access_token_encrypted=channel.access_token_encrypted or "",
            refresh_token_encrypted=channel.refresh_token_encrypted,
            token_expiry=channel.token_expiry,
            video_path=video_path,
            title=upload_title,
            description=upload_description,
            tags=upload_tags,
            privacy_status=payload.privacy_status,
            thumbnail_path=thumb_path,
        )

        upload.youtube_video_id = upload_result["video_id"]
        upload.youtube_url = upload_result["url"]
        upload.upload_status = "done"

        # Update episode status to exported
        await ep_repo.update_status(episode_id, "exported")

        await db.commit()
        await db.refresh(upload)

        logger.info(
            "youtube_upload_success",
            episode_id=str(episode_id),
            video_id=upload_result["video_id"],
        )

        # Auto-add to series playlist (create playlist if it doesn't exist)
        try:
            from drevalis.repositories.series import SeriesRepository

            series_repo = SeriesRepository(db)
            series = await series_repo.get_by_id(episode.series_id)
            if series:
                series_meta = series.metadata_ if hasattr(series, "metadata_") else {}
                if not isinstance(series_meta, dict):
                    series_meta = {}

                playlist_id = series_meta.get("youtube_playlist_id")

                if not playlist_id:
                    # Create a new playlist for this series
                    playlist_result = await svc.create_playlist(
                        access_token_encrypted=channel.access_token_encrypted or "",
                        refresh_token_encrypted=channel.refresh_token_encrypted,
                        token_expiry=channel.token_expiry,
                        title=series.name,
                        description=series.description or f"Episodes from {series.name}",
                        privacy_status=payload.privacy_status,
                    )
                    playlist_id = playlist_result.get("playlist_id", "")
                    if playlist_id:
                        # Store playlist ID in series metadata for reuse
                        series_meta["youtube_playlist_id"] = playlist_id
                        # Use raw SQL update to avoid model attribute issues
                        import json as _json

                        from sqlalchemy import text as sa_text

                        await db.execute(
                            sa_text("UPDATE series SET metadata = :meta WHERE id = :sid"),
                            {"meta": _json.dumps(series_meta), "sid": str(series.id)},
                        )
                        await db.commit()
                        logger.info(
                            "youtube_playlist_created", series=series.name, playlist_id=playlist_id
                        )

                if playlist_id:
                    # Add video to the playlist
                    await svc.add_to_playlist(
                        access_token_encrypted=channel.access_token_encrypted or "",
                        refresh_token_encrypted=channel.refresh_token_encrypted,
                        token_expiry=channel.token_expiry,
                        playlist_id=playlist_id,
                        video_id=upload_result["video_id"],
                    )
                    logger.info(
                        "youtube_added_to_playlist",
                        video_id=upload_result["video_id"],
                        playlist_id=playlist_id,
                    )

        except Exception as playlist_exc:
            # Non-fatal — video is uploaded, playlist is bonus
            logger.warning("youtube_playlist_failed", error=str(playlist_exc)[:200])

    except Exception as exc:
        upload.upload_status = "failed"
        upload.error_message = str(exc)[:1000]
        await db.commit()
        await db.refresh(upload)

        logger.error(
            "youtube_upload_failed",
            episode_id=str(episode_id),
            error=str(exc),
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"YouTube upload failed: {exc}",
        ) from exc

    return YouTubeUploadResponse.model_validate(upload)


# ── Upload history ───────────────────────────────────────────────────────


@router.get(
    "/uploads",
    response_model=list[YouTubeUploadListResponse],
    status_code=status.HTTP_200_OK,
    summary="List past YouTube uploads",
)
async def list_uploads(
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> list[YouTubeUploadListResponse]:
    """Return the most recent YouTube upload records."""
    repo = YouTubeUploadRepository(db)
    uploads = await repo.get_recent(limit=limit)
    return [YouTubeUploadListResponse.model_validate(u) for u in uploads]


# ── Playlist management ───────────────────────────────────────────────────


def _require_active_channel(channel: Any | None) -> Any:
    """Raise 400 if no active channel is connected.

    Deprecated: prefer :func:`_resolve_channel` which respects the
    multi-channel contract (several connected channels, operator
    explicitly picks one).
    """
    if channel is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No YouTube channel connected. Please authorize first.",
        )
    return channel


async def _resolve_channel(
    repo: YouTubeChannelRepository,
    channel_id: UUID | None,
) -> Any:
    """Resolve which YouTube channel a playlist / analytics call should
    target.

    Rules (in order):
      1. If ``channel_id`` is supplied, look it up; 404 on miss.
      2. Otherwise, if exactly one channel is connected, use it
         implicitly - single-channel installs don't need to specify.
      3. In demo mode, default to the first channel rather than 400
         so casual clicks through the UI don't trip errors.
      4. Otherwise, 400 with instructions to pass ``channel_id``.

    Prevents the multi-channel foot-gun where a legacy call to
    ``get_active()`` picked an arbitrary row and silently sent
    playlist mutations to the wrong account.
    """
    if channel_id is not None:
        ch = await repo.get_by_id(channel_id)
        if ch is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"YouTube channel {channel_id} not found",
            )
        return ch
    all_channels = await repo.get_all_channels()
    if not all_channels:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No YouTube channel connected. Please authorize first.",
        )
    if len(all_channels) == 1:
        return all_channels[0]
    # Demo mode: casual clicks to /youtube/playlists etc. without a
    # channel_id shouldn't 400. Fall back to the first channel.
    try:
        from drevalis.core.deps import get_settings

        if get_settings().demo_mode:
            return all_channels[0]
    except Exception:
        pass
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={
            "error": "channel_id_required",
            "reason": (
                "Multiple YouTube channels are connected. Pass "
                "?channel_id=<uuid> to specify which channel this "
                "operation targets."
            ),
            "connected_channels": [
                {"id": str(c.id), "channel_id": c.channel_id, "name": c.channel_name}
                for c in all_channels
            ],
        },
    )


@router.post(
    "/playlists",
    response_model=PlaylistResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a YouTube playlist",
)
async def create_playlist(
    payload: PlaylistCreate,
    channel_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> PlaylistResponse:
    """Create a new playlist on the specified YouTube channel.

    Pass ``?channel_id=<uuid>`` to target a specific channel. When only
    one channel is connected, the parameter is optional.
    """
    svc = await _build_youtube_service(settings, db)

    channel_repo = YouTubeChannelRepository(db)
    channel = await _resolve_channel(channel_repo, channel_id)

    updated_tokens = await svc.refresh_tokens_if_needed(
        channel.access_token_encrypted or "",
        channel.refresh_token_encrypted,
        channel.token_expiry,
    )
    if updated_tokens:
        for key, value in updated_tokens.items():
            setattr(channel, key, value)
        await db.flush()

    try:
        yt_playlist = await svc.create_playlist(
            access_token_encrypted=channel.access_token_encrypted or "",
            refresh_token_encrypted=channel.refresh_token_encrypted,
            token_expiry=channel.token_expiry,
            title=payload.title,
            description=payload.description,
            privacy_status=payload.privacy_status,
        )
    except Exception as exc:
        logger.error("youtube_create_playlist_failed", error=str(exc), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to create playlist: {exc}",
        ) from exc

    playlist_repo = YouTubePlaylistRepository(db)
    playlist = await playlist_repo.create(
        channel_id=channel.id,
        youtube_playlist_id=yt_playlist["playlist_id"],
        title=yt_playlist["title"],
        description=yt_playlist["description"] or None,
        privacy_status=yt_playlist["privacy_status"],
        item_count=yt_playlist["item_count"],
    )
    await db.commit()
    await db.refresh(playlist)

    logger.info(
        "youtube_playlist_created_local",
        playlist_db_id=str(playlist.id),
        youtube_playlist_id=playlist.youtube_playlist_id,
    )
    return PlaylistResponse.model_validate(playlist)


@router.get(
    "/playlists",
    response_model=list[PlaylistResponse],
    status_code=status.HTTP_200_OK,
    summary="List managed YouTube playlists",
)
async def list_playlists(
    channel_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
) -> list[PlaylistResponse]:
    """Return all playlists stored locally for a channel.

    Pass ``?channel_id=<uuid>`` to scope to that channel. With a single
    channel connected the parameter is optional.
    """
    channel_repo = YouTubeChannelRepository(db)
    channel = await _resolve_channel(channel_repo, channel_id)

    playlist_repo = YouTubePlaylistRepository(db)
    playlists = await playlist_repo.get_by_channel(channel.id)
    return [PlaylistResponse.model_validate(p) for p in playlists]


@router.post(
    "/playlists/{playlist_id}/add",
    status_code=status.HTTP_200_OK,
    summary="Add a video to a YouTube playlist",
)
async def add_video_to_playlist(
    playlist_id: UUID,
    payload: PlaylistAddVideo,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    """Add a YouTube video to one of the managed playlists.

    ``playlist_id`` is the local database UUID; the channel is inferred
    from the playlist's ``channel_id`` so operators never have to pass
    it alongside.
    """
    svc = await _build_youtube_service(settings, db)

    playlist_repo = YouTubePlaylistRepository(db)
    playlist = await playlist_repo.get_by_id(playlist_id)
    if playlist is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Playlist {playlist_id} not found",
        )

    # Resolve the channel from the playlist itself. Multi-channel safe:
    # the playlist knows which account created it.
    channel_repo = YouTubeChannelRepository(db)
    channel = await channel_repo.get_by_id(playlist.channel_id)
    if channel is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Channel {playlist.channel_id} for playlist not found",
        )

    updated_tokens = await svc.refresh_tokens_if_needed(
        channel.access_token_encrypted or "",
        channel.refresh_token_encrypted,
        channel.token_expiry,
    )
    if updated_tokens:
        for key, value in updated_tokens.items():
            setattr(channel, key, value)
        await db.flush()

    try:
        item = await svc.add_to_playlist(
            access_token_encrypted=channel.access_token_encrypted or "",
            refresh_token_encrypted=channel.refresh_token_encrypted,
            token_expiry=channel.token_expiry,
            playlist_id=playlist.youtube_playlist_id,
            video_id=payload.video_id,
        )
    except Exception as exc:
        logger.error(
            "youtube_add_to_playlist_failed",
            playlist_id=str(playlist_id),
            video_id=payload.video_id,
            error=str(exc),
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to add video to playlist: {exc}",
        ) from exc

    # Increment local item count to keep it roughly in sync.
    await playlist_repo.update(playlist_id, item_count=playlist.item_count + 1)
    await db.commit()

    return {
        "message": "Video added to playlist",
        "playlist_item_id": item.get("id", ""),
        "video_id": payload.video_id,
        "youtube_playlist_id": playlist.youtube_playlist_id,
    }


@router.delete(
    "/playlists/{playlist_id}",
    status_code=status.HTTP_200_OK,
    summary="Delete a YouTube playlist",
)
async def delete_playlist(
    playlist_id: UUID,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    """Delete a playlist from YouTube and remove it from the local database.

    Channel is inferred from the playlist's ``channel_id``.
    """
    svc = await _build_youtube_service(settings, db)

    playlist_repo = YouTubePlaylistRepository(db)
    playlist = await playlist_repo.get_by_id(playlist_id)
    if playlist is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Playlist {playlist_id} not found",
        )
    channel_repo = YouTubeChannelRepository(db)
    channel = await channel_repo.get_by_id(playlist.channel_id)
    if channel is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Channel {playlist.channel_id} for playlist not found",
        )

    updated_tokens = await svc.refresh_tokens_if_needed(
        channel.access_token_encrypted or "",
        channel.refresh_token_encrypted,
        channel.token_expiry,
    )
    if updated_tokens:
        for key, value in updated_tokens.items():
            setattr(channel, key, value)
        await db.flush()

    try:
        await svc.delete_playlist(
            access_token_encrypted=channel.access_token_encrypted or "",
            refresh_token_encrypted=channel.refresh_token_encrypted,
            token_expiry=channel.token_expiry,
            playlist_id=playlist.youtube_playlist_id,
        )
    except Exception as exc:
        logger.error(
            "youtube_delete_playlist_failed",
            playlist_id=str(playlist_id),
            youtube_playlist_id=playlist.youtube_playlist_id,
            error=str(exc),
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to delete playlist on YouTube: {exc}",
        ) from exc

    youtube_playlist_id = playlist.youtube_playlist_id
    await playlist_repo.delete(playlist_id)
    await db.commit()

    logger.info(
        "youtube_playlist_deleted_local",
        playlist_db_id=str(playlist_id),
        youtube_playlist_id=youtube_playlist_id,
    )
    return {
        "message": f"Playlist '{playlist.title}' deleted",
        "youtube_playlist_id": youtube_playlist_id,
    }


# ── Analytics ─────────────────────────────────────────────────────────────


@router.get(
    "/analytics",
    response_model=list[VideoStatsResponse],
    status_code=status.HTTP_200_OK,
    summary="Fetch YouTube video statistics",
)
async def get_video_analytics(
    video_ids: str = Query(
        ...,
        description="Comma-separated list of YouTube video IDs (max 50)",
    ),
    channel_id: UUID | None = Query(
        None,
        description="Channel whose OAuth token is used to query the Data API. "
        "Required when multiple channels are connected.",
    ),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> list[VideoStatsResponse]:
    """Return view, like, and comment counts for a list of YouTube video IDs.

    ``video_ids`` is a comma-separated string. Pass ``channel_id`` to
    specify which connected channel's credentials to use (optional with
    a single channel connected).
    """
    # Demo mode: return plausible fake stats; no external API call.
    if settings.demo_mode:
        import random as _r

        ids = [v.strip() for v in video_ids.split(",") if v.strip()]
        rng = _r.Random(sum(ord(c) for c in (ids[0] if ids else "demo")))
        return [
            VideoStatsResponse(
                video_id=vid,
                title=f"Demo video {vid[:8]}",
                views=rng.randint(1_200, 58_000),
                likes=rng.randint(40, 2_200),
                comments=rng.randint(0, 180),
                published_at=None,
            )
            for vid in ids[:50]
        ]

    svc = await _build_youtube_service(settings, db)

    channel_repo = YouTubeChannelRepository(db)
    channel = await _resolve_channel(channel_repo, channel_id)

    ids = [v.strip() for v in video_ids.split(",") if v.strip()]
    if not ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="video_ids must contain at least one video ID",
        )
    if len(ids) > 50:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="video_ids must contain at most 50 IDs per request",
        )

    # v0.20.30 — wrap token refresh in the same error-handling envelope
    # as the stats call itself. Previously an expired refresh token (or
    # a corrupted ciphertext after a key rotation) propagated as an
    # unhandled exception → FastAPI returned an opaque 500 that the UI
    # couldn't distinguish from a real server bug. Now it surfaces as
    # a structured 502 with a helpful reason.
    try:
        updated_tokens = await svc.refresh_tokens_if_needed(
            channel.access_token_encrypted or "",
            channel.refresh_token_encrypted,
            channel.token_expiry,
        )
        if updated_tokens:
            for key, value in updated_tokens.items():
                setattr(channel, key, value)
            await db.flush()
            await db.commit()

        stats = await svc.get_video_stats(
            access_token_encrypted=channel.access_token_encrypted or "",
            refresh_token_encrypted=channel.refresh_token_encrypted,
            token_expiry=channel.token_expiry,
            video_ids=ids,
        )
    except Exception as exc:
        logger.error(
            "youtube_analytics_failed",
            channel_id=str(channel.id),
            video_count=len(ids),
            error_type=type(exc).__name__,
            error=str(exc),
            exc_info=True,
        )
        # Reason string carries just enough detail for the UI to show
        # a useful message without leaking tokens. Most common cases:
        # "invalid_grant" (refresh token expired — reconnect channel),
        # "quotaExceeded" (wait for daily reset), "forbidden" (OAuth
        # scope missing — reconnect with the needed scope).
        reason = str(exc)[:240]
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "error": "youtube_analytics_failed",
                "reason": reason,
                "channel_id": str(channel.id),
                "hint": (
                    "If this says 'invalid_grant' or 'unauthorized', the "
                    "channel's OAuth token expired — disconnect and "
                    "reconnect the channel in Settings. If it says "
                    "'quotaExceeded', YouTube's daily quota is exhausted "
                    "— retry tomorrow."
                ),
            },
        ) from exc

    return [VideoStatsResponse(**s) for s in stats]


# ── Channel analytics (Analytics API v2) ──────────────────────────────────


@router.get(
    "/analytics/channel",
    status_code=status.HTTP_200_OK,
    summary="Pull channel-level analytics (views, watch time, retention, CTR)",
)
async def get_channel_analytics(
    channel_id: UUID | None = Query(
        None,
        description="Channel whose OAuth token is used. Required when multiple channels are connected.",
    ),
    days: int = Query(28, ge=1, le=365, description="Window length in days (1-365)."),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Fetch aggregate + daily KPIs for the window.

    Returns ``{window_days, start_date, end_date, totals, daily}`` where
    ``totals`` is a dict of integer KPIs (views / watch time / subs gained
    / etc.) and ``daily`` is a list of ``{day, views, minutes_watched}``.

    If the channel's OAuth token was minted before v0.3.7 it won't carry
    the ``yt-analytics.readonly`` scope; this endpoint returns 403 with
    ``{"error": "analytics_scope_missing"}`` so the frontend can prompt
    the user to reconnect the channel.
    """
    # Demo mode: synthesise a plausible time series so the analytics UI
    # lights up without touching Google.
    if settings.demo_mode:
        import random as _r
        from datetime import UTC as _UTC
        from datetime import date as _date
        from datetime import datetime as _dt
        from datetime import timedelta as _td

        rng = _r.Random(days)
        end = _date.today()
        start = end - _td(days=days - 1)
        daily = []
        for i in range(days):
            d = start + _td(days=i)
            base = 800 + rng.randint(-120, 200) + (i * 18)
            daily.append(
                {
                    "day": d.isoformat(),
                    "views": max(100, base),
                    "minutes_watched": max(80, int(base * rng.uniform(0.8, 1.6))),
                }
            )
        totals = {
            "views": sum(cast(int, d["views"]) for d in daily),
            "minutes_watched": sum(cast(int, d["minutes_watched"]) for d in daily),
            "subscribers_gained": rng.randint(40, 220),
            "likes": rng.randint(600, 2400),
            "comments": rng.randint(30, 180),
            "shares": rng.randint(20, 160),
        }
        return {
            "window_days": days,
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "totals": totals,
            "daily": daily,
            "fetched_at": _dt.now(tz=_UTC).isoformat(),
        }

    svc = await _build_youtube_service(settings, db)
    channel_repo = YouTubeChannelRepository(db)
    channel = await _resolve_channel(channel_repo, channel_id)

    updated_tokens = await svc.refresh_tokens_if_needed(
        channel.access_token_encrypted or "",
        channel.refresh_token_encrypted,
        channel.token_expiry,
    )
    if updated_tokens:
        for key, value in updated_tokens.items():
            setattr(channel, key, value)
        await db.flush()
        await db.commit()

    try:
        result = await svc.get_channel_analytics(
            access_token_encrypted=channel.access_token_encrypted or "",
            refresh_token_encrypted=channel.refresh_token_encrypted,
            token_expiry=channel.token_expiry,
            days=days,
        )
    except AnalyticsNotAuthorized as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "analytics_scope_missing",
                "hint": str(exc),
                "channel_id": str(channel.id),
            },
        ) from exc
    except Exception as exc:
        logger.error("youtube_channel_analytics_failed", error=str(exc), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to fetch channel analytics: {exc}",
        ) from exc

    return {"channel_id": str(channel.id), **result}
