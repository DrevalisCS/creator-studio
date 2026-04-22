"""Social platform upload workers.

Today ships the TikTok Direct Post v2 upload path. Instagram and X are
deliberately not included — their OAuth flows aren't implemented, so a
worker for them would always fail.

Cron schedule:
- ``publish_pending_social_uploads`` runs every 5 minutes (mirrors the
  YouTube cron). Picks up SocialUpload rows with ``upload_status='pending'``,
  attempts the per-platform upload, flips them to ``'done'`` or
  ``'failed'`` with ``error_message`` set.

Per-upload flow (TikTok):

1.  POST ``/v2/post/publish/video/init/`` with the channel token. Body
    carries post metadata (title, privacy, hashtags). Response gives
    ``publish_id`` + ``upload_url`` + chunking hints.
2.  PUT the MP4 bytes to ``upload_url`` in one shot (we cap our videos
    at 64 MB via the pipeline anyway, well under TikTok's single-shot
    limit).
3.  Poll ``/v2/post/publish/status/fetch/`` until the job leaves
    ``PROCESSING_UPLOAD`` / ``PROCESSING_DOWNLOAD``.
4.  On ``PUBLISH_COMPLETE``, store the resulting video URL on the
    ``SocialUpload`` row.

Errors are captured into ``SocialUpload.error_message`` so the UI can
show the operator exactly why an upload didn't make it.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx
import structlog
from sqlalchemy import select

from drevalis.core.security import decrypt_value
from drevalis.models.media_asset import MediaAsset
from drevalis.models.social_platform import SocialPlatform, SocialUpload

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

_TIKTOK_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/"
_TIKTOK_STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/"
_MAX_POLLS = 30  # 30 × 4 s = 2 minutes max wait per upload
_POLL_INTERVAL_S = 4.0


async def publish_pending_social_uploads(ctx: dict[str, Any]) -> dict[str, int]:
    """arq cron entrypoint — process every pending social upload."""
    session_factory = ctx.get("db_session_factory")
    if session_factory is None:
        # Defer to the lifecycle hook that populated ctx.
        from drevalis.core.database import get_session_factory

        session_factory = get_session_factory()

    settings = ctx.get("settings")
    if settings is None:
        from drevalis.core.config import Settings

        settings = Settings()

    processed = 0
    succeeded = 0
    failed = 0
    skipped = 0

    async with session_factory() as session:
        result = await session.execute(
            select(SocialUpload).where(SocialUpload.upload_status == "pending")
        )
        pending = list(result.scalars().all())

        for upload in pending:
            processed += 1

            platform = await session.get(SocialPlatform, upload.platform_id)
            if not platform or not platform.is_active:
                upload.upload_status = "failed"
                upload.error_message = "Platform connection missing or inactive."
                failed += 1
                continue

            if platform.platform != "tiktok":
                # Non-TikTok rows are skipped — no worker for them yet.
                # Leave pending so a future release can pick them up.
                skipped += 1
                continue

            # Find the episode's final video.
            video_rows = await session.execute(
                select(MediaAsset)
                .where(MediaAsset.episode_id == upload.episode_id)
                .where(MediaAsset.asset_type == "video")
                .order_by(MediaAsset.created_at.desc())
                .limit(1)
            )
            video = video_rows.scalar_one_or_none()
            if not video:
                upload.upload_status = "failed"
                upload.error_message = "No final video asset on this episode."
                failed += 1
                continue

            video_path = Path(settings.storage_base_path) / video.file_path
            if not video_path.exists():
                upload.upload_status = "failed"
                upload.error_message = f"Video file missing on disk: {video_path}"
                failed += 1
                continue

            try:
                token = decrypt_value(
                    platform.access_token_encrypted or "",
                    settings.encryption_key,
                )
                publish_id = await _tiktok_upload(
                    token=token,
                    video_path=video_path,
                    title=upload.title,
                    description=upload.description or "",
                    hashtags=upload.hashtags or "",
                )
                video_url = await _tiktok_wait_for_publish(token, publish_id)
                upload.upload_status = "done"
                upload.platform_content_id = publish_id
                upload.platform_url = video_url
                upload.error_message = None
                succeeded += 1
                logger.info(
                    "tiktok_upload_done",
                    upload_id=str(upload.id),
                    publish_id=publish_id,
                    url=video_url,
                )
            except Exception as exc:  # noqa: BLE001 — any failure → show reason in UI
                upload.upload_status = "failed"
                upload.error_message = str(exc)[:500]
                failed += 1
                logger.warning(
                    "tiktok_upload_failed",
                    upload_id=str(upload.id),
                    error=str(exc)[:300],
                )

        await session.commit()

    return {
        "processed": processed,
        "succeeded": succeeded,
        "failed": failed,
        "skipped_other_platforms": skipped,
    }


async def _tiktok_upload(
    token: str,
    video_path: Path,
    title: str,
    description: str,
    hashtags: str,
) -> str:
    """Init a TikTok Direct Post + upload the video bytes. Returns publish_id."""
    size = video_path.stat().st_size
    caption = _compose_caption(title, description, hashtags)

    init_body = {
        "post_info": {
            "title": caption[:150],  # TikTok caption hard cap
            "privacy_level": "PUBLIC_TO_EVERYONE",
            "disable_duet": False,
            "disable_stitch": False,
            "disable_comment": False,
        },
        "source_info": {
            "source": "FILE_UPLOAD",
            "video_size": size,
            "chunk_size": size,
            "total_chunk_count": 1,
        },
    }
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        init_resp = await client.post(_TIKTOK_INIT_URL, json=init_body, headers=headers)
        init_resp.raise_for_status()
        init_data = init_resp.json().get("data") or {}
        publish_id = init_data.get("publish_id")
        upload_url = init_data.get("upload_url")
        if not publish_id or not upload_url:
            raise RuntimeError(f"TikTok init malformed: {init_resp.text[:300]}")

    # Single-shot PUT of the whole MP4.
    with video_path.open("rb") as f:
        body = f.read()
    async with httpx.AsyncClient(timeout=300.0) as client:
        put_resp = await client.put(
            upload_url,
            content=body,
            headers={
                "Content-Type": "video/mp4",
                "Content-Length": str(size),
                "Content-Range": f"bytes 0-{size - 1}/{size}",
            },
        )
        # TikTok's upload URL returns 2xx on success, no body guaranteed.
        if put_resp.status_code >= 400:
            raise RuntimeError(
                f"TikTok upload PUT failed ({put_resp.status_code}): {put_resp.text[:200]}"
            )

    return str(publish_id)


async def _tiktok_wait_for_publish(token: str, publish_id: str) -> str:
    """Poll /status/fetch/ until PUBLISH_COMPLETE (or we give up)."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        for _ in range(_MAX_POLLS):
            await asyncio.sleep(_POLL_INTERVAL_S)
            resp = await client.post(
                _TIKTOK_STATUS_URL,
                json={"publish_id": publish_id},
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json().get("data") or {}
            status = (data.get("status") or "").upper()
            if status == "PUBLISH_COMPLETE":
                return str(data.get("publicaly_available_post_id") or data.get("public_url") or "")
            if status.startswith("FAIL"):
                msg = data.get("fail_reason") or status
                raise RuntimeError(f"TikTok publish failed: {msg}")
    raise TimeoutError("TikTok publish did not complete within the polling window")


def _compose_caption(title: str, description: str, hashtags: str) -> str:
    """Compose a single caption line for TikTok.

    TikTok captions cap at 150 chars including hashtags. We prefer title
    first, then hashtags, then truncate description into whatever's left.
    """
    parts: list[str] = []
    if title:
        parts.append(title.strip())
    if hashtags:
        parts.append(hashtags.strip())
    if description:
        parts.append(description.strip())
    joined = " ".join(p for p in parts if p)
    return joined[:150]
