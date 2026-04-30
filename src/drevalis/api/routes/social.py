"""Social platform integration API routes -- connect, upload, and stats."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from drevalis.core.config import Settings
from drevalis.core.deps import get_db, get_settings
from drevalis.core.license.features import fastapi_dep_require_feature
from drevalis.core.security import encrypt_value
from drevalis.models.social_platform import SocialPlatform
from drevalis.repositories.social import (
    SocialPlatformRepository,
    SocialUploadRepository,
)
from drevalis.schemas.social import (
    OverallStats,
    PlatformConnect,
    PlatformResponse,
    PlatformStats,
    SocialUploadRequest,
    SocialUploadResponse,
    TikTokAuthURLResponse,
    TikTokConnectionStatus,
)

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

router = APIRouter(
    prefix="/api/v1/social",
    tags=["social"],
    # Studio tier only. Solo/Pro receive 402 on every endpoint here.
    dependencies=[Depends(fastapi_dep_require_feature("social_platforms"))],
)

# TikTok API base URLs (constants to avoid magic strings)
_TIKTOK_AUTH_BASE = "https://www.tiktok.com/v2/auth/authorize/"
_TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/"
_TIKTOK_USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/"
_TIKTOK_SCOPES = "user.info.basic,video.publish,video.upload"


# ── Helpers ──────────────────────────────────────────────────────────────


async def _get_tiktok_credentials(db: AsyncSession, settings: Settings) -> tuple[str, str, str]:
    """Resolve TikTok client_key, client_secret, redirect_uri.

    Checks the api_key_store DB table first (user-configured via Settings UI),
    then falls back to environment variables.
    Raises HTTP 400 if neither source has credentials.
    """
    from drevalis.core.security import decrypt_value
    from drevalis.repositories.api_key_store import ApiKeyStoreRepository

    repo = ApiKeyStoreRepository(db)
    client_key = settings.tiktok_client_key
    client_secret = settings.tiktok_client_secret
    redirect_uri = settings.tiktok_redirect_uri

    # Try DB-stored keys first
    key_row = await repo.get_by_key_name("tiktok_client_key")
    if key_row:
        client_key = decrypt_value(key_row.encrypted_value, settings.encryption_key)
    secret_row = await repo.get_by_key_name("tiktok_client_secret")
    if secret_row:
        client_secret = decrypt_value(secret_row.encrypted_value, settings.encryption_key)
    uri_row = await repo.get_by_key_name("tiktok_redirect_uri")
    if uri_row:
        redirect_uri = decrypt_value(uri_row.encrypted_value, settings.encryption_key)

    if not client_key or not client_secret:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "TikTok integration is not configured. "
                "Go to Settings → API Keys and add 'tiktok_client_key' and 'tiktok_client_secret'."
            ),
        )

    return client_key, client_secret, redirect_uri


def _platform_to_response(platform: SocialPlatform) -> PlatformResponse:
    """Convert a SocialPlatform ORM instance to a response schema."""
    return PlatformResponse(
        id=platform.id,
        platform=platform.platform,
        account_id=platform.account_id,
        account_name=platform.account_name,
        is_active=platform.is_active,
        has_access_token=platform.access_token_encrypted is not None,
        has_refresh_token=platform.refresh_token_encrypted is not None,
        created_at=platform.created_at,
        updated_at=platform.updated_at,
    )


# ── TikTok OAuth flow ────────────────────────────────────────────────────


@router.get(
    "/tiktok/auth-url",
    response_model=TikTokAuthURLResponse,
    status_code=status.HTTP_200_OK,
    summary="Get TikTok OAuth authorization URL",
    description=(
        "Generate a TikTok Login Kit OAuth 2.0 consent URL. "
        "The caller should redirect the user to `auth_url` and store the "
        "returned `state` value for CSRF verification on callback."
    ),
)
async def tiktok_auth_url(
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> TikTokAuthURLResponse:
    """Return the TikTok OAuth authorization URL with PKCE challenge."""
    import base64
    import hashlib

    client_key, _, redirect_uri = await _get_tiktok_credentials(db, settings)

    state = secrets.token_urlsafe(32)

    # PKCE: generate code_verifier and code_challenge (S256)
    code_verifier = secrets.token_urlsafe(64)
    code_challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode("ascii")).digest())
        .rstrip(b"=")
        .decode("ascii")
    )

    # Store code_verifier in Redis so the callback can retrieve it
    from redis.asyncio import Redis

    from drevalis.core.redis import get_pool

    redis_client: Redis = Redis(connection_pool=get_pool())
    try:
        await redis_client.set(
            f"tiktok_pkce:{state}",
            code_verifier,
            ex=600,  # 10 min expiry
        )
    finally:
        await redis_client.aclose()

    from urllib.parse import quote

    url = (
        f"{_TIKTOK_AUTH_BASE}"
        f"?client_key={client_key}"
        f"&response_type=code"
        f"&scope={quote(_TIKTOK_SCOPES, safe='')}"
        f"&redirect_uri={quote(redirect_uri, safe='')}"
        f"&state={state}"
        f"&code_challenge={code_challenge}"
        f"&code_challenge_method=S256"
    )

    logger.info("tiktok_auth_url_generated", state=state)
    return TikTokAuthURLResponse(auth_url=url, state=state)


@router.get(
    "/tiktok/callback",
    status_code=status.HTTP_302_FOUND,
    summary="Handle TikTok OAuth callback",
    description=(
        "Exchange the authorization code for access/refresh tokens, fetch "
        "the connected TikTok user's display name, persist encrypted tokens "
        "in the database, and redirect to the frontend settings page."
    ),
    response_class=RedirectResponse,
)
async def tiktok_callback(
    code: str = Query(..., description="Authorization code returned by TikTok"),
    state: str = Query(default="", description="OAuth state parameter for CSRF"),
    error: str | None = Query(default=None, description="Error code if user denied access"),
    error_description: str | None = Query(
        default=None, description="Human-readable error description"
    ),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> RedirectResponse:
    """Complete the TikTok OAuth 2.0 authorization code flow.

    On success: stores encrypted tokens and redirects to the frontend.
    On failure: redirects to the frontend with an ``error`` query parameter
    so the UI can display an appropriate message without exposing raw API
    error details to the browser's address bar.
    """
    client_key, client_secret, redirect_uri = await _get_tiktok_credentials(db, settings)

    frontend_settings_url = "http://localhost:3000/settings?section=social"

    # Surface any access-denied errors from TikTok's redirect back to the UI.
    if error:
        logger.warning(
            "tiktok_oauth_denied",
            error=error,
            error_description=error_description,
        )
        return RedirectResponse(
            url=f"{frontend_settings_url}&tiktok_error={error}",
            status_code=status.HTTP_302_FOUND,
        )

    # ── Step 0: validate state + retrieve PKCE code_verifier atomically ──
    # An empty/forged/replayed `state` must not fall through to the token
    # exchange — TikTok's PKCE enforcement is optional, so without state
    # validation an attacker who tricks an operator into following a
    # crafted callback URL can connect their TikTok account to the
    # victim's install. `getdel` makes the lookup-and-consume atomic so
    # a parallel callback cannot reuse the same state.
    from redis.asyncio import Redis as RedisClient

    from drevalis.core.redis import get_pool

    if not state:
        logger.warning("tiktok_oauth_state_missing")
        return RedirectResponse(
            url=f"{frontend_settings_url}&tiktok_error=invalid_state",
            status_code=status.HTTP_302_FOUND,
        )

    code_verifier = ""
    redis_client: RedisClient = RedisClient(connection_pool=get_pool())
    try:
        raw = await redis_client.getdel(f"tiktok_pkce:{state}")
    finally:
        await redis_client.aclose()

    if not raw:
        logger.warning("tiktok_oauth_state_unknown_or_replayed")
        return RedirectResponse(
            url=f"{frontend_settings_url}&tiktok_error=invalid_state",
            status_code=status.HTTP_302_FOUND,
        )
    code_verifier = raw if isinstance(raw, str) else raw.decode()

    # ── Step 1: exchange authorization code for tokens ──────────────────
    token_payload = {
        "client_key": client_key,
        "client_secret": client_secret,
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
    }
    if code_verifier:
        token_payload["code_verifier"] = code_verifier

    token_data: dict[str, Any]
    async with httpx.AsyncClient(timeout=30.0) as client:
        token_resp = await client.post(
            _TIKTOK_TOKEN_URL,
            data=token_payload,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        token_data = token_resp.json()

    if "access_token" not in token_data:
        tiktok_error = token_data.get("error", "unknown_error")
        logger.error(
            "tiktok_token_exchange_failed",
            error=tiktok_error,
            error_description=token_data.get("error_description", ""),
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"TikTok authorization failed: {tiktok_error}",
        )

    access_token: str = token_data["access_token"]
    refresh_token: str = token_data.get("refresh_token", "")
    open_id: str = token_data.get("open_id", "")
    expires_in: int = int(token_data.get("expires_in", 86400))
    refresh_expires_in: int = int(token_data.get("refresh_expires_in", 31536000))

    token_expires_at = datetime.now(tz=UTC) + timedelta(seconds=expires_in)

    # ── Step 2: fetch user profile for a human-readable account name ────
    display_name = "TikTok User"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            user_resp = await client.get(
                _TIKTOK_USER_INFO_URL,
                params={"fields": "open_id,display_name,avatar_url"},
                headers={"Authorization": f"Bearer {access_token}"},
            )
            user_data = user_resp.json()
            user_obj = user_data.get("data", {}).get("user", {})
            if user_obj.get("display_name"):
                display_name = user_obj["display_name"]
    except Exception:
        # Non-fatal: we already have the tokens; just log and continue.
        logger.warning("tiktok_user_info_fetch_failed", exc_info=True)

    # ── Step 3: encrypt tokens and persist ──────────────────────────────
    enc_access, key_version = encrypt_value(access_token, settings.encryption_key)
    enc_refresh: str | None = None
    if refresh_token:
        enc_refresh, _ = encrypt_value(refresh_token, settings.encryption_key)

    repo = SocialPlatformRepository(db)

    # Deactivate any existing TikTok connection before creating the new one.
    await repo.deactivate_platform("tiktok")

    await repo.create(
        platform="tiktok",
        account_name=display_name,
        account_id=open_id or None,
        access_token_encrypted=enc_access,
        refresh_token_encrypted=enc_refresh,
        token_key_version=key_version,
        token_expires_at=token_expires_at,
        is_active=True,
    )
    await db.commit()

    logger.info(
        "tiktok_account_connected",
        open_id=open_id,
        display_name=display_name,
        expires_in=expires_in,
        refresh_expires_in=refresh_expires_in,
    )

    return RedirectResponse(
        url=frontend_settings_url,
        status_code=status.HTTP_302_FOUND,
    )


@router.get(
    "/tiktok/status",
    response_model=TikTokConnectionStatus,
    status_code=status.HTTP_200_OK,
    summary="Check TikTok connection status",
    description="Return whether a TikTok account is connected and its basic info.",
)
async def tiktok_status(
    db: AsyncSession = Depends(get_db),
) -> TikTokConnectionStatus:
    """Return the active TikTok connection, if one exists."""
    repo = SocialPlatformRepository(db)
    platform = await repo.get_active_by_platform("tiktok")

    if platform is None:
        return TikTokConnectionStatus(connected=False, account=None)

    return TikTokConnectionStatus(
        connected=True,
        account=_platform_to_response(platform),
    )


# ── Platform CRUD ────────────────────────────────────────────────────────


@router.get(
    "/platforms",
    response_model=list[PlatformResponse],
    status_code=status.HTTP_200_OK,
)
async def list_platforms(
    db: AsyncSession = Depends(get_db),
) -> list[PlatformResponse]:
    """List all connected social platform accounts."""
    repo = SocialPlatformRepository(db)
    platforms = await repo.get_all()
    return [_platform_to_response(p) for p in platforms]


@router.post(
    "/platforms",
    response_model=PlatformResponse,
    status_code=status.HTTP_201_CREATED,
)
async def connect_platform(
    body: PlatformConnect,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> PlatformResponse:
    """Connect a new social platform account.

    Encrypts access and refresh tokens before storage.
    Deactivates any existing account for the same platform.
    """
    repo = SocialPlatformRepository(db)

    # Guard against the known "connector not working" surprises:
    # Facebook needs the Page ID on account_id; Instagram needs both
    # the Business/Creator account ID AND a public HTTPS base URL on
    # account_metadata.public_video_base_url before Reels uploads can
    # succeed. Fail loudly here instead of silently at upload time.
    if body.platform == "facebook" and not (body.account_id or "").strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Facebook needs the Page ID. Paste the numeric Page ID "
                "into the 'Page / Account ID' field."
            ),
        )
    if body.platform == "instagram":
        if not (body.account_id or "").strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Instagram needs the Business/Creator account ID. "
                    "Paste it into the 'Page / Account ID' field."
                ),
            )
        meta = body.account_metadata or {}
        if not (meta.get("public_video_base_url") or "").strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Instagram Reels need a public HTTPS URL that maps "
                    "to your storage folder. Set the 'Public video base "
                    "URL' field before connecting."
                ),
            )

    # Deactivate existing accounts for this platform
    await repo.deactivate_platform(body.platform)

    # Encrypt tokens
    access_encrypted, key_version = encrypt_value(body.access_token, settings.encryption_key)
    refresh_encrypted = None
    if body.refresh_token:
        refresh_encrypted, _ = encrypt_value(body.refresh_token, settings.encryption_key)

    platform = await repo.create(
        platform=body.platform,
        account_name=body.account_name,
        account_id=(body.account_id or "").strip() or None,
        access_token_encrypted=access_encrypted,
        refresh_token_encrypted=refresh_encrypted,
        token_key_version=key_version,
        account_metadata=body.account_metadata,
        is_active=True,
    )
    await db.commit()

    logger.info(
        "social_platform_connected",
        platform=body.platform,
        account_name=body.account_name,
    )
    return _platform_to_response(platform)


@router.delete(
    "/platforms/{platform_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def disconnect_platform(
    platform_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Disconnect (delete) a social platform account and all its uploads."""
    repo = SocialPlatformRepository(db)
    deleted = await repo.delete(platform_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Platform account not found.",
        )
    await db.commit()
    logger.info("social_platform_disconnected", platform_id=str(platform_id))


# ── Uploads ──────────────────────────────────────────────────────────────


@router.post(
    "/uploads",
    response_model=SocialUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_upload(
    body: SocialUploadRequest,
    db: AsyncSession = Depends(get_db),
) -> SocialUploadResponse:
    """Create a new social media upload record.

    The actual upload processing is handled asynchronously by the worker.
    """
    platform_repo = SocialPlatformRepository(db)
    platform = await platform_repo.get_by_id(body.platform_id)
    if platform is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Platform account not found.",
        )
    if not platform.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Platform account is not active.",
        )

    upload_repo = SocialUploadRepository(db)
    upload = await upload_repo.create(
        platform_id=body.platform_id,
        episode_id=body.episode_id,
        content_type=body.content_type,
        title=body.title,
        description=body.description or None,
        hashtags=body.hashtags or None,
        upload_status="pending",
    )
    await db.commit()

    logger.info(
        "social_upload_created",
        upload_id=str(upload.id),
        platform=platform.platform,
        content_type=body.content_type,
    )
    return SocialUploadResponse.model_validate(upload)


@router.get(
    "/uploads",
    response_model=list[SocialUploadResponse],
    status_code=status.HTTP_200_OK,
)
async def list_uploads(
    platform_id: UUID | None = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
) -> list[SocialUploadResponse]:
    """List recent social media uploads, optionally filtered by platform."""
    upload_repo = SocialUploadRepository(db)
    if platform_id:
        uploads = await upload_repo.get_by_platform(platform_id, limit=limit)
    else:
        uploads = await upload_repo.get_recent(limit=limit)
    return [SocialUploadResponse.model_validate(u) for u in uploads]


# ── Stats ────────────────────────────────────────────────────────────────


@router.get(
    "/stats",
    response_model=OverallStats,
    status_code=status.HTTP_200_OK,
)
async def get_stats(
    db: AsyncSession = Depends(get_db),
) -> OverallStats:
    """Get aggregated upload and engagement statistics across all platforms."""
    platform_repo = SocialPlatformRepository(db)
    upload_repo = SocialUploadRepository(db)

    active_platforms = await platform_repo.get_all_active()
    raw_stats = await upload_repo.get_platform_stats()

    platform_stats = [PlatformStats(**s) for s in raw_stats]

    return OverallStats(
        platforms=platform_stats,
        total_platforms_connected=len(active_platforms),
        total_uploads=sum(s.total_uploads for s in platform_stats),
        total_views=sum(s.total_views for s in platform_stats),
        total_likes=sum(s.total_likes for s in platform_stats),
    )
