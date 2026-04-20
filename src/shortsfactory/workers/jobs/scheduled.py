"""Scheduled-post arq job function.

Jobs
----
- ``publish_scheduled_posts`` -- periodic cron job that publishes due posts.
"""

from __future__ import annotations

import structlog

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)


async def publish_scheduled_posts(ctx: dict) -> dict:
    """Periodic job: check for scheduled posts that are due and publish them.

    Runs every 5 minutes via arq cron. For YouTube posts, performs the actual
    upload using the channel's OAuth tokens. Other platforms are TODO.
    """
    import asyncio as _asyncio
    from datetime import datetime, timezone
    from pathlib import Path

    from shortsfactory.core.config import Settings
    from shortsfactory.repositories.episode import EpisodeRepository
    from shortsfactory.repositories.media_asset import MediaAssetRepository
    from shortsfactory.repositories.scheduled_post import ScheduledPostRepository
    from shortsfactory.repositories.series import SeriesRepository
    from shortsfactory.repositories.youtube import (
        YouTubeChannelRepository,
        YouTubeUploadRepository,
    )
    from shortsfactory.services.youtube import YouTubeService

    log = logger.bind(job="publish_scheduled_posts")
    log.info("job_start")

    settings = Settings()  # type: ignore[call-arg]
    session_factory = ctx["session_factory"]

    async with session_factory() as session:
        repo = ScheduledPostRepository(session)
        pending = await repo.get_pending(before=datetime.now(timezone.utc))

        published = 0
        failed = 0

        for post in pending:
            try:
                await repo.update(post.id, status="publishing")
                await session.commit()

                if post.platform == "youtube":
                    # ── Actual YouTube upload ────────────────────────
                    if not settings.youtube_client_id or not settings.youtube_client_secret:
                        raise RuntimeError("YouTube not configured (missing client_id/secret)")

                    svc = YouTubeService(
                        client_id=settings.youtube_client_id,
                        client_secret=settings.youtube_client_secret,
                        redirect_uri=settings.youtube_redirect_uri,
                        encryption_key=settings.encryption_key,
                    )

                    # Resolve YouTube channel
                    ch_repo = YouTubeChannelRepository(session)
                    channel = None
                    if post.youtube_channel_id:
                        channel = await ch_repo.get_by_id(post.youtube_channel_id)
                    if channel is None:
                        # Fall back to series channel
                        ep_repo = EpisodeRepository(session)
                        episode = await ep_repo.get_by_id(post.content_id)
                        if episode:
                            series = await SeriesRepository(session).get_by_id(episode.series_id)
                            if series and getattr(series, "youtube_channel_id", None):
                                channel = await ch_repo.get_by_id(series.youtube_channel_id)
                    if channel is None:
                        channel = await ch_repo.get_active()
                    if channel is None:
                        raise RuntimeError("No YouTube channel available for upload")

                    # Refresh tokens
                    updated = await svc.refresh_tokens_if_needed(
                        channel.access_token_encrypted or "",
                        channel.refresh_token_encrypted,
                        channel.token_expiry,
                    )
                    if updated:
                        for k, v in updated.items():
                            setattr(channel, k, v)
                        await session.flush()

                    # Find video file
                    asset_repo = MediaAssetRepository(session)
                    video_assets = await asset_repo.get_by_episode_and_type(post.content_id, "video")
                    if not video_assets:
                        raise RuntimeError(f"No video asset for episode {post.content_id}")
                    video_path = Path(settings.storage_base_path) / video_assets[-1].file_path
                    if not video_path.exists():
                        raise RuntimeError(f"Video file not found: {video_path}")

                    # Find thumbnail
                    thumb_path = None
                    thumb_assets = await asset_repo.get_by_episode_and_type(post.content_id, "thumbnail")
                    if thumb_assets:
                        candidate = Path(settings.storage_base_path) / thumb_assets[-1].file_path
                        if candidate.exists():
                            thumb_path = candidate

                    # Upload with retry
                    result = None
                    for attempt in range(3):
                        try:
                            result = await svc.upload_video(
                                access_token_encrypted=channel.access_token_encrypted or "",
                                refresh_token_encrypted=channel.refresh_token_encrypted,
                                token_expiry=channel.token_expiry,
                                video_path=video_path,
                                title=post.title[:100],
                                description=post.description or "",
                                tags=post.tags.split(",") if post.tags else [],
                                privacy_status=post.privacy or "public",
                                thumbnail_path=thumb_path,
                            )
                            break
                        except Exception as upload_exc:
                            if attempt < 2:
                                log.warning("upload_retry", attempt=attempt + 1, error=str(upload_exc)[:100])
                                await _asyncio.sleep(10 * (attempt + 1))
                            else:
                                raise

                    await repo.update(
                        post.id,
                        status="published",
                        published_at=datetime.now(timezone.utc),
                        remote_id=result["video_id"] if result else None,
                        remote_url=result["url"] if result else None,
                    )

                    # Also create a youtube_uploads record so the Uploads tab
                    # reflects scheduled uploads alongside manual ones.
                    if result and post.content_type == "episode":
                        upload_repo = YouTubeUploadRepository(session)
                        await upload_repo.create(
                            episode_id=post.content_id,
                            channel_id=channel.id,
                            youtube_video_id=result["video_id"],
                            youtube_url=result["url"],
                            title=post.title[:100],
                            description=post.description or "",
                            privacy_status=post.privacy or "public",
                            upload_status="done",
                        )

                    await session.commit()
                    published += 1
                    log.info(
                        "post_published_youtube",
                        post_id=str(post.id),
                        video_id=result.get("video_id") if result else None,
                    )
                else:
                    # Other platforms: mark as failed with clear message
                    await repo.update(
                        post.id,
                        status="failed",
                        error_message=f"Platform '{post.platform}' upload not yet implemented",
                    )
                    await session.commit()
                    failed += 1

            except Exception as exc:
                log.error("post_publish_failed", post_id=str(post.id), error=str(exc)[:200])
                try:
                    await repo.update(
                        post.id,
                        status="failed",
                        error_message=str(exc)[:500],
                    )
                    await session.commit()
                except Exception:
                    pass
                failed += 1

    log.info("job_complete", published=published, failed=failed, pending_checked=len(pending))
    return {"published": published, "failed": failed, "pending_checked": len(pending)}
