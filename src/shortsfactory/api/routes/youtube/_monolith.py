"""YouTube integration API routes — OAuth, upload, and status."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from shortsfactory.core.config import Settings
from shortsfactory.core.deps import get_db, get_settings
from shortsfactory.repositories.episode import EpisodeRepository
from shortsfactory.repositories.media_asset import MediaAssetRepository
from shortsfactory.repositories.youtube import (
    YouTubeChannelRepository,
    YouTubePlaylistRepository,
    YouTubeUploadRepository,
)
from shortsfactory.schemas.youtube import (
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
from shortsfactory.services.youtube import YouTubeService

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/youtube", tags=["youtube"])


# ── Helpers ──────────────────────────────────────────────────────────────


def _get_youtube_service(settings: Settings) -> YouTubeService:
    """Build a YouTubeService from application settings."""
    if not settings.youtube_client_id or not settings.youtube_client_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="YouTube integration is not configured. "
            "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET environment variables.",
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
) -> YouTubeAuthURLResponse:
    """Generate and return the Google OAuth consent URL."""
    svc = _get_youtube_service(settings)
    url, state = svc.get_auth_url()
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
) -> YouTubeChannelResponse:
    """Exchange the OAuth authorization code for tokens, store channel info."""
    svc = _get_youtube_service(settings)

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
        from shortsfactory.core.license.features import TIER_CHANNEL_CAP
        from shortsfactory.core.license.state import get_state as _get_license_state

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
    """Remove a YouTube channel connection. Defaults to the active channel."""
    repo = YouTubeChannelRepository(db)

    if channel_id:
        channel = await repo.get_by_id(channel_id)
    else:
        channel = await repo.get_active()

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
    db: AsyncSession = Depends(get_db),
) -> list[YouTubeChannelResponse]:
    """Return all connected YouTube channels."""
    repo = YouTubeChannelRepository(db)
    channels = await repo.get_all_channels()
    return [YouTubeChannelResponse.model_validate(c) for c in channels]


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
    svc = _get_youtube_service(settings)
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
    svc = _get_youtube_service(settings)

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
        from shortsfactory.repositories.series import SeriesRepository

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
    seo_data: dict = {}
    episode_meta = episode.metadata_ or {}
    if isinstance(episode_meta, dict) and "seo" in episode_meta:
        seo_data = episode_meta["seo"]
    elif episode.script:
        # Generate SEO on-the-fly
        try:
            import json as _json

            from shortsfactory.repositories.llm_config import LLMConfigRepository
            from shortsfactory.schemas.script import EpisodeScript
            from shortsfactory.services.llm import (
                LLMService,
                OpenAICompatibleProvider,
                _extract_json,
            )

            script_obj = EpisodeScript.model_validate(episode.script)
            narration = " ".join(s.narration for s in script_obj.scenes if s.narration)

            configs = await LLMConfigRepository(db).get_all(limit=1)
            if configs:
                llm_svc = LLMService(storage=None, encryption_key=settings.encryption_key)  # type: ignore[arg-type]
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

    # Refresh tokens if needed.
    updated_tokens = await svc.refresh_tokens_if_needed(
        channel.access_token_encrypted or "",
        channel.refresh_token_encrypted,
        channel.token_expiry,
    )
    if updated_tokens:
        for key, value in updated_tokens.items():
            setattr(channel, key, value)
        await db.flush()

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
        result = await svc.upload_video(
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

        upload.youtube_video_id = result["video_id"]
        upload.youtube_url = result["url"]
        upload.upload_status = "done"

        # Update episode status to exported
        await ep_repo.update_status(episode_id, "exported")

        await db.commit()
        await db.refresh(upload)

        logger.info(
            "youtube_upload_success",
            episode_id=str(episode_id),
            video_id=result["video_id"],
        )

        # Auto-add to series playlist (create playlist if it doesn't exist)
        try:
            from shortsfactory.repositories.series import SeriesRepository

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
                        video_id=result["video_id"],
                    )
                    logger.info(
                        "youtube_added_to_playlist",
                        video_id=result["video_id"],
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
    """Raise 400 if no active channel is connected."""
    if channel is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No YouTube channel connected. Please authorize first.",
        )
    return channel


@router.post(
    "/playlists",
    response_model=PlaylistResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a YouTube playlist",
)
async def create_playlist(
    payload: PlaylistCreate,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> PlaylistResponse:
    """Create a new playlist on the connected YouTube channel.

    The playlist is also persisted in the local ``youtube_playlists`` table
    for reference.
    """
    svc = _get_youtube_service(settings)

    channel_repo = YouTubeChannelRepository(db)
    channel = _require_active_channel(await channel_repo.get_active())

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
    db: AsyncSession = Depends(get_db),
) -> list[PlaylistResponse]:
    """Return all playlists stored locally for the active channel.

    These are playlists previously created through this application.
    """
    channel_repo = YouTubeChannelRepository(db)
    channel = _require_active_channel(await channel_repo.get_active())

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

    ``playlist_id`` is the local database UUID; the YouTube playlist ID is
    looked up automatically.  ``payload.video_id`` is the YouTube video ID
    (e.g. ``dQw4w9WgXcQ``).
    """
    svc = _get_youtube_service(settings)

    channel_repo = YouTubeChannelRepository(db)
    channel = _require_active_channel(await channel_repo.get_active())

    playlist_repo = YouTubePlaylistRepository(db)
    playlist = await playlist_repo.get_by_id(playlist_id)
    if playlist is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Playlist {playlist_id} not found",
        )
    if playlist.channel_id != channel.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Playlist does not belong to the active channel",
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

    ``playlist_id`` is the local database UUID.
    """
    svc = _get_youtube_service(settings)

    channel_repo = YouTubeChannelRepository(db)
    channel = _require_active_channel(await channel_repo.get_active())

    playlist_repo = YouTubePlaylistRepository(db)
    playlist = await playlist_repo.get_by_id(playlist_id)
    if playlist is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Playlist {playlist_id} not found",
        )
    if playlist.channel_id != channel.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Playlist does not belong to the active channel",
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
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> list[VideoStatsResponse]:
    """Return view, like, and comment counts for a list of YouTube video IDs.

    ``video_ids`` is a comma-separated string, e.g.
    ``?video_ids=abc123,def456``.  The YouTube API silently omits any IDs
    that are not accessible, so the response may be shorter than the input.
    """
    svc = _get_youtube_service(settings)

    channel_repo = YouTubeChannelRepository(db)
    channel = _require_active_channel(await channel_repo.get_active())

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
        stats = await svc.get_video_stats(
            access_token_encrypted=channel.access_token_encrypted or "",
            refresh_token_encrypted=channel.refresh_token_encrypted,
            token_expiry=channel.token_expiry,
            video_ids=ids,
        )
    except Exception as exc:
        logger.error("youtube_analytics_failed", error=str(exc), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to fetch video statistics: {exc}",
        ) from exc

    return [VideoStatsResponse(**s) for s in stats]
