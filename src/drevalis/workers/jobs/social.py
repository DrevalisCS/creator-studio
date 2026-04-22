"""Social platform upload workers.

Dispatches per ``SocialPlatform.platform``:

* ``tiktok``    — Direct Post v2 (init + single-shot PUT + status poll).
* ``instagram`` — Graph API v21 Reels container → publish flow.
* ``x``         — v1.1 chunked media/upload + v2 tweet creation.

All three record success/failure into ``SocialUpload`` so the UI can
show the operator exactly why an upload didn't make it.

Cron schedule: ``publish_pending_social_uploads`` runs every 5 minutes.
Picks up ``SocialUpload`` rows with ``upload_status='pending'``, routes
them to the right adapter, flips them to ``'done'`` or ``'failed'``.
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

            if platform.platform not in ("tiktok", "instagram", "x"):
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
                if platform.platform == "tiktok":
                    publish_id = await _tiktok_upload(
                        token=token,
                        video_path=video_path,
                        title=upload.title,
                        description=upload.description or "",
                        hashtags=upload.hashtags or "",
                    )
                    video_url = await _tiktok_wait_for_publish(token, publish_id)
                    upload.platform_content_id = publish_id
                    upload.platform_url = video_url
                elif platform.platform == "instagram":
                    ig_user_id = platform.account_id or ""
                    meta = platform.account_metadata or {}
                    content_id, url = await _instagram_reels_upload(
                        token=token,
                        ig_user_id=ig_user_id,
                        video_path=video_path,
                        title=upload.title,
                        description=upload.description or "",
                        hashtags=upload.hashtags or "",
                        public_video_url_override=meta.get("public_video_base_url"),
                    )
                    upload.platform_content_id = content_id
                    upload.platform_url = url
                elif platform.platform == "x":
                    content_id, url = await _x_video_upload(
                        token=token,
                        video_path=video_path,
                        title=upload.title,
                        description=upload.description or "",
                        hashtags=upload.hashtags or "",
                    )
                    upload.platform_content_id = content_id
                    upload.platform_url = url
                else:
                    raise RuntimeError(f"no uploader for {platform.platform}")

                upload.upload_status = "done"
                upload.error_message = None
                succeeded += 1
                logger.info(
                    "social_upload_done",
                    platform=platform.platform,
                    upload_id=str(upload.id),
                    content_id=upload.platform_content_id,
                    url=upload.platform_url,
                )
            except Exception as exc:  # noqa: BLE001 — any failure → show reason in UI
                upload.upload_status = "failed"
                upload.error_message = str(exc)[:500]
                failed += 1
                logger.warning(
                    "social_upload_failed",
                    platform=platform.platform,
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


# ── Instagram Reels ─────────────────────────────────────────────────
#
# Instagram's Content Publishing API requires the video to be
# reachable via a public HTTPS URL. The operator configures a public
# base URL (e.g. their reverse-proxy-fronted /storage/ path) via
# ``SocialPlatform.metadata_json.public_video_base_url``. We compose
# ``{public_video_base_url}/{relative_video_path}`` and pass that to
# the ``/media`` container endpoint.

_IG_GRAPH_BASE = "https://graph.facebook.com/v21.0"


async def _instagram_reels_upload(
    *,
    token: str,
    ig_user_id: str,
    video_path: Path,
    title: str,
    description: str,
    hashtags: str,
    public_video_url_override: str | None,
) -> tuple[str, str]:
    """Create a Reels container then publish it. Returns (media_id, permalink)."""
    if not ig_user_id:
        raise RuntimeError(
            "Instagram Business account ID missing on the SocialPlatform "
            "(platform_account_id). Re-authorize the channel."
        )
    if not public_video_url_override:
        raise RuntimeError(
            "Instagram Reels requires the video to be reachable via HTTPS. "
            "Set SocialPlatform.metadata_json.public_video_base_url "
            "(e.g. https://cdn.example.com/storage) before uploading."
        )

    # Build the publicly-accessible URL from the storage path.
    # ``video_path`` is absolute — we need the relative-to-storage suffix.
    # Simpler: the caller knows the storage base; here we treat
    # public_video_url_override as "the base that replaces the local
    # storage prefix" — the SocialPlatform row tracks the mapping.
    rel = _relative_storage_url(video_path)
    public_url = f"{public_video_url_override.rstrip('/')}/{rel.lstrip('/')}"

    caption = _compose_caption_multiline(title, description, hashtags, limit=2200)

    async with httpx.AsyncClient(timeout=30.0) as client:
        # 1. Create Reels container.
        create_resp = await client.post(
            f"{_IG_GRAPH_BASE}/{ig_user_id}/media",
            data={
                "media_type": "REELS",
                "video_url": public_url,
                "caption": caption,
                "access_token": token,
            },
        )
        if create_resp.status_code >= 400:
            raise RuntimeError(
                f"Instagram container create failed ({create_resp.status_code}): "
                f"{create_resp.text[:300]}"
            )
        container_id = (create_resp.json() or {}).get("id")
        if not container_id:
            raise RuntimeError(f"Instagram container missing id: {create_resp.text[:300]}")

        # 2. Poll container status until FINISHED.
        for _ in range(_MAX_POLLS):
            await asyncio.sleep(_POLL_INTERVAL_S)
            status_resp = await client.get(
                f"{_IG_GRAPH_BASE}/{container_id}",
                params={"fields": "status_code", "access_token": token},
            )
            status_resp.raise_for_status()
            code = (status_resp.json() or {}).get("status_code") or ""
            if code == "FINISHED":
                break
            if code in ("ERROR", "EXPIRED"):
                raise RuntimeError(f"Instagram container {code}")
        else:
            raise TimeoutError("Instagram container did not finish in time")

        # 3. Publish.
        publish_resp = await client.post(
            f"{_IG_GRAPH_BASE}/{ig_user_id}/media_publish",
            data={"creation_id": container_id, "access_token": token},
        )
        if publish_resp.status_code >= 400:
            raise RuntimeError(
                f"Instagram publish failed ({publish_resp.status_code}): {publish_resp.text[:300]}"
            )
        media_id = (publish_resp.json() or {}).get("id") or container_id

        # 4. Fetch permalink.
        perm_resp = await client.get(
            f"{_IG_GRAPH_BASE}/{media_id}",
            params={"fields": "permalink", "access_token": token},
        )
        permalink = ""
        if perm_resp.status_code < 400:
            permalink = (perm_resp.json() or {}).get("permalink") or ""

    return str(media_id), permalink


# ── X (Twitter) video upload ────────────────────────────────────────
#
# Uses v1.1 media/upload (chunked INIT/APPEND/FINALIZE) for the video,
# then v2 /2/tweets to post. Both require OAuth 2.0 user context with
# appropriate scopes (media.write, tweet.write). The token we store on
# SocialPlatform is the OAuth 2.0 access token — X accepts it on the
# v1.1 media endpoint as of late 2025.

_X_MEDIA_UPLOAD = "https://upload.twitter.com/1.1/media/upload.json"
_X_TWEETS = "https://api.twitter.com/2/tweets"
_X_CHUNK_BYTES = 4 * 1024 * 1024


async def _x_video_upload(
    *,
    token: str,
    video_path: Path,
    title: str,
    description: str,
    hashtags: str,
) -> tuple[str, str]:
    """Chunked INIT → APPEND → FINALIZE → tweet. Returns (tweet_id, url)."""
    size = video_path.stat().st_size
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(timeout=120.0) as client:
        # INIT
        init_resp = await client.post(
            _X_MEDIA_UPLOAD,
            data={
                "command": "INIT",
                "media_type": "video/mp4",
                "media_category": "tweet_video",
                "total_bytes": size,
            },
            headers=headers,
        )
        if init_resp.status_code >= 400:
            raise RuntimeError(f"X INIT failed ({init_resp.status_code}): {init_resp.text[:300]}")
        media_id = (init_resp.json() or {}).get("media_id_string")
        if not media_id:
            raise RuntimeError(f"X INIT missing media_id: {init_resp.text[:300]}")

        # APPEND (chunked)
        with video_path.open("rb") as fh:
            segment_index = 0
            while True:
                chunk = fh.read(_X_CHUNK_BYTES)
                if not chunk:
                    break
                append_resp = await client.post(
                    _X_MEDIA_UPLOAD,
                    data={
                        "command": "APPEND",
                        "media_id": media_id,
                        "segment_index": segment_index,
                    },
                    files={"media": ("chunk", chunk, "application/octet-stream")},
                    headers=headers,
                )
                if append_resp.status_code >= 400:
                    raise RuntimeError(
                        f"X APPEND seg={segment_index} failed "
                        f"({append_resp.status_code}): {append_resp.text[:300]}"
                    )
                segment_index += 1

        # FINALIZE
        finalize_resp = await client.post(
            _X_MEDIA_UPLOAD,
            data={"command": "FINALIZE", "media_id": media_id},
            headers=headers,
        )
        if finalize_resp.status_code >= 400:
            raise RuntimeError(
                f"X FINALIZE failed ({finalize_resp.status_code}): {finalize_resp.text[:300]}"
            )
        processing = (finalize_resp.json() or {}).get("processing_info") or {}

        # If processing, poll STATUS until succeeded.
        while (processing.get("state") or "") in ("pending", "in_progress"):
            await asyncio.sleep(max(1.0, float(processing.get("check_after_secs") or 4)))
            status_resp = await client.get(
                _X_MEDIA_UPLOAD,
                params={"command": "STATUS", "media_id": media_id},
                headers=headers,
            )
            status_resp.raise_for_status()
            processing = (status_resp.json() or {}).get("processing_info") or {}
            if processing.get("state") == "failed":
                err = processing.get("error") or {}
                raise RuntimeError(f"X media processing failed: {err}")

        # Post the tweet referencing the media_id.
        text = _compose_caption_multiline(title, description, hashtags, limit=280)
        tweet_resp = await client.post(
            _X_TWEETS,
            json={"text": text, "media": {"media_ids": [media_id]}},
            headers={**headers, "Content-Type": "application/json"},
        )
        if tweet_resp.status_code >= 400:
            raise RuntimeError(
                f"X tweet create failed ({tweet_resp.status_code}): {tweet_resp.text[:300]}"
            )
        data = (tweet_resp.json() or {}).get("data") or {}
        tweet_id = str(data.get("id") or "")
        url = f"https://x.com/i/web/status/{tweet_id}" if tweet_id else ""
        return tweet_id, url


# ── Shared helpers ──────────────────────────────────────────────────


def _compose_caption_multiline(title: str, description: str, hashtags: str, *, limit: int) -> str:
    """Multi-line caption: title, blank, description, blank, hashtags.

    Suitable for Instagram / X where newlines render. Truncated to *limit*.
    """
    parts: list[str] = []
    if title:
        parts.append(title.strip())
    if description:
        parts.append(description.strip())
    if hashtags:
        parts.append(hashtags.strip())
    joined = "\n\n".join(p for p in parts if p)
    return joined[:limit]


def _relative_storage_url(video_path: Path) -> str:
    """Return the video path relative to ``storage/``.

    The ``storage`` directory is served at ``/storage/`` on our frontend;
    combined with ``public_video_base_url`` the caller can derive a URL
    that Instagram / X can reach.
    """
    parts = video_path.parts
    try:
        idx = parts.index("storage")
    except ValueError:
        # Fallback: use last three components.
        idx = max(0, len(parts) - 3)
    return "/".join(parts[idx + 1 :])
