"""Scheduled-post arq job function.

Jobs
----
- ``publish_scheduled_posts`` -- periodic cron job that publishes due posts.
"""

from __future__ import annotations

from datetime import UTC
from typing import Any

import structlog

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)


async def publish_scheduled_posts(ctx: dict[str, Any]) -> dict[str, Any]:
    """Periodic job: check for scheduled posts that are due and publish them.

    Runs every 5 minutes via arq cron. For YouTube posts, performs the actual
    upload using the channel's OAuth tokens. Other platforms are TODO.

    Guarded by :func:`cron_lock` — in a multi-worker deployment, only one
    instance actually runs each 5-minute tick. Without this, two workers
    firing at the same timestamp would race YouTube uploads and could
    publish the same scheduled post twice.
    """
    import asyncio as _asyncio
    from datetime import datetime
    from pathlib import Path

    from drevalis.workers.cron_lock import cron_lock

    async with cron_lock(ctx, "publish_scheduled_posts", ttl_s=280) as owner:
        if not owner:
            return {"status": "skipped_not_cron_owner"}
        return await _publish_scheduled_posts_locked(ctx, _asyncio, datetime, Path)


async def _publish_scheduled_posts_locked(
    ctx: dict[str, Any],
    _asyncio: Any,
    datetime: Any,
    Path: Any,
) -> dict[str, Any]:

    from drevalis.core.config import Settings
    from drevalis.repositories.episode import EpisodeRepository
    from drevalis.repositories.media_asset import MediaAssetRepository
    from drevalis.repositories.scheduled_post import ScheduledPostRepository
    from drevalis.repositories.series import SeriesRepository
    from drevalis.repositories.youtube import (
        YouTubeChannelRepository,
        YouTubeUploadRepository,
    )
    from drevalis.services.youtube import YouTubeService

    log = logger.bind(job="publish_scheduled_posts")
    log.info("job_start")

    settings = Settings()
    session_factory = ctx["session_factory"]

    async with session_factory() as session:
        repo = ScheduledPostRepository(session)
        pending = await repo.get_pending(before=datetime.now(UTC))

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

                    # Resolve YouTube channel: per-post override first, then
                    # the series' assigned channel. No "active channel"
                    # fallback — multi-channel contract requires the
                    # operator to declare the target explicitly so uploads
                    # never silently land on the wrong channel.
                    ch_repo = YouTubeChannelRepository(session)
                    channel = None
                    if post.youtube_channel_id:
                        channel = await ch_repo.get_by_id(post.youtube_channel_id)
                    if channel is None:
                        ep_repo = EpisodeRepository(session)
                        episode = await ep_repo.get_by_id(post.content_id)
                        if episode:
                            series = await SeriesRepository(session).get_by_id(episode.series_id)
                            if series and getattr(series, "youtube_channel_id", None):
                                channel = await ch_repo.get_by_id(series.youtube_channel_id)
                    if channel is None:
                        raise RuntimeError(
                            "No YouTube channel assigned: set youtube_channel_id on "
                            "the scheduled post or on the episode's series."
                        )

                    # Refresh tokens once up-front; the per-attempt loop below
                    # also refreshes before each retry so a 401 mid-upload
                    # doesn't cascade through all attempts.
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
                    video_assets = await asset_repo.get_by_episode_and_type(
                        post.content_id, "video"
                    )
                    if not video_assets:
                        raise RuntimeError(f"No video asset for episode {post.content_id}")
                    video_path = Path(settings.storage_base_path) / video_assets[-1].file_path
                    if not video_path.exists():
                        raise RuntimeError(f"Video file not found: {video_path}")

                    # Find thumbnail
                    thumb_path = None
                    thumb_assets = await asset_repo.get_by_episode_and_type(
                        post.content_id, "thumbnail"
                    )
                    if thumb_assets:
                        candidate = Path(settings.storage_base_path) / thumb_assets[-1].file_path
                        if candidate.exists():
                            thumb_path = candidate

                    # Upload with retry. Refresh tokens on each attempt —
                    # a multi-minute upload can exhaust the 1h access token
                    # between attempts #2 and #3, so re-using the original
                    # refreshed token would 401 on subsequent retries.
                    result = None
                    for attempt in range(3):
                        try:
                            refreshed = await svc.refresh_tokens_if_needed(
                                channel.access_token_encrypted or "",
                                channel.refresh_token_encrypted,
                                channel.token_expiry,
                            )
                            if refreshed:
                                for k, v in refreshed.items():
                                    setattr(channel, k, v)
                                await session.flush()
                                await session.commit()

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
                                log.warning(
                                    "upload_retry", attempt=attempt + 1, error=str(upload_exc)[:100]
                                )
                                await _asyncio.sleep(10 * (attempt + 1))
                            else:
                                raise

                    await repo.update(
                        post.id,
                        status="published",
                        published_at=datetime.now(UTC),
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

                    # Broadcast so the frontend refreshes episode list/
                    # detail without a manual F5 - previously a scheduled
                    # publish happening at 2am left the UI showing stale
                    # status indefinitely.
                    if post.content_type == "episode" and ctx.get("redis") is not None:
                        import json as _json

                        try:
                            await ctx["redis"].publish(
                                f"progress:{post.content_id}",
                                _json.dumps(
                                    {
                                        "episode_id": str(post.content_id),
                                        "step": "publish",
                                        "status": "published",
                                        "progress_pct": 100,
                                        "message": "Scheduled upload complete",
                                        "detail": {
                                            "remote_url": result["url"] if result else None,
                                            "video_id": result.get("video_id") if result else None,
                                        },
                                    }
                                ),
                            )
                        except Exception:
                            log.debug("progress_broadcast_failed", exc_info=True)
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
                except Exception as nested:
                    # Failure-recording itself failed. Don't silently
                    # swallow — at worst the row stays in 'publishing'
                    # but the operator needs to see the DB error.
                    log.exception(
                        "post_fail_record_failed",
                        post_id=str(post.id),
                        nested_error=str(nested)[:200],
                    )
                failed += 1

    log.info("job_complete", published=published, failed=failed, pending_checked=len(pending))
    return {"published": published, "failed": failed, "pending_checked": len(pending)}
