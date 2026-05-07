"""Authentication + user management routes.

Endpoints:

- ``POST /api/v1/auth/login``              email+password → session cookie.
- ``POST /api/v1/auth/logout``             clears the cookie.
- ``POST /api/v1/auth/logout-everywhere``  increments session_version → all
                                           existing tokens on all devices are
                                           invalidated immediately.
- ``GET  /api/v1/auth/me``                 current user (when logged in).
- ``GET  /api/v1/auth/login-history``      current user's last N login events.
- ``GET  /api/v1/auth/mode``               public — team / demo mode flags.
- ``GET  /api/v1/users``                   list all users (owner only).
- ``POST /api/v1/users``                   invite a new user (owner only).
- ``PUT  /api/v1/users/{id}``              change role / enable-disable (owner only).
- ``DELETE /api/v1/users/{id}``            remove a user (owner only; can't remove self).
- ``GET  /api/v1/users/{id}/login-history`` per-user events (owner only).

The login endpoint writes an HTTP-only ``drevalis_session`` cookie
rather than returning a token — same-origin XHR through the frontend
automatically sends it, so nothing else needs to change.
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession  # runtime import — FastAPI Depends

from drevalis.core.auth import (
    LoginRateLimitedError,
    check_login_rate_limit,
    record_login_failure,
)
from drevalis.core.deps import get_db, get_settings
from drevalis.models.login_event import LoginEvent
from drevalis.models.user import User
from drevalis.services.team import (
    ensure_owner_from_env,
    hash_password,
    mint_session_token,
    parse_session_token,
    verify_password,
)

# Plain-string email with a light regex — avoids a hard dep on
# ``email-validator`` (pydantic[email]) which isn't in the runtime image.
_EMAIL_RE = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


if TYPE_CHECKING:
    from drevalis.core.config import Settings

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

router = APIRouter(tags=["auth"])

_COOKIE_NAME = "drevalis_session"

# ---------------------------------------------------------------------------
# A.1 — Constant-time dummy hash for email enumeration prevention.
#
# PBKDF2 at 480k iterations takes ~150ms. When a login attempt uses an
# unknown email, we skip verify_password — making that branch ~150ms faster
# than a valid-email/wrong-password branch. An attacker can measure this
# delta to enumerate which emails are registered.
#
# Fix: compute one real PBKDF2 hash at import time (pays the cost once) and
# run verify_password against it whenever the user doesn't exist or is
# inactive. The result is discarded; only the timing matters.
#
# The dummy password is a random sentinel so no submitted string will ever
# accidentally match it (verify_password always returns False here).
# ---------------------------------------------------------------------------
_DUMMY_HASH: str = hash_password("__drevalis_dummy_sentinel__")


class LoginRequest(BaseModel):
    email: str = Field(..., pattern=_EMAIL_RE)
    password: str = Field(..., min_length=1)


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: str
    role: str
    display_name: str | None
    is_active: bool
    last_login_at: datetime | None

    @classmethod
    def from_orm(cls, u: User) -> UserResponse:
        return cls(
            id=u.id,
            email=u.email,
            role=u.role,
            display_name=u.display_name,
            is_active=u.is_active,
            last_login_at=u.last_login_at,
        )


class LoginEventResponse(BaseModel):
    """Login history row returned to the authenticated user."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    timestamp: datetime
    ip: str
    user_agent: str | None
    success: bool
    failure_reason: str | None


# ── Session helpers ────────────────────────────────────────────────────


async def _current_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User | None:
    token = request.cookies.get(_COOKIE_NAME)
    if not token:
        return None
    payload = parse_session_token(token, secret=settings.get_session_secret())
    if not payload:
        return None
    try:
        uid = UUID(str(payload["uid"]))
    except (KeyError, ValueError):
        return None
    user = await db.get(User, uid)
    if not user or not user.is_active:
        return None
    # A.3 — session-version check: reject tokens minted before a
    # logout-everywhere that incremented the counter.
    token_sv = int(payload.get("sv", 0))
    if token_sv != user.session_version:
        return None
    return user


async def require_user(user: User | None = Depends(_current_user)) -> User:
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not_authenticated")
    return user


async def require_owner(user: User = Depends(require_user)) -> User:
    if user.role != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "owner_role_required")
    return user


# ── Audit helpers ──────────────────────────────────────────────────────


def _client_ip(request: Request) -> str:
    """Best-effort client IP: prefer X-Forwarded-For, fallback to socket peer."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",", 1)[0].strip() or "unknown"
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else "unknown"


async def _record_login_event(
    db: AsyncSession,
    *,
    user_id: UUID | None,
    email_attempted: str | None,
    ip: str,
    user_agent: str | None,
    success: bool,
    failure_reason: str | None,
) -> None:
    """Insert a login_events row.  Called via asyncio.create_task so a slow
    DB write never delays the auth response.  Errors are logged and swallowed.
    """
    try:
        event = LoginEvent(
            user_id=user_id,
            email_attempted=email_attempted,
            ip=ip,
            user_agent=user_agent,
            success=success,
            failure_reason=failure_reason,
        )
        db.add(event)
        await db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("auth.login_event_write_failed", exc_info=True)


# ── Auth ──────────────────────────────────────────────────────────────


@router.post("/api/v1/auth/login")
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    # First-run bootstrap from env vars — creates the owner account
    # if the users table is empty and OWNER_EMAIL/OWNER_PASSWORD are set.
    await ensure_owner_from_env(db)

    # F-S-09: per-(IP, email) rate limit on login attempts.
    # PBKDF2 at 480k iterations gives ~6 attempts/sec; without this a
    # patient attacker could still bruteforce a weak password over hours.
    ip = _client_ip(request)
    ua = request.headers.get("user-agent")
    email_norm = body.email.lower().strip()
    try:
        await check_login_rate_limit(ip, email_norm)
    except LoginRateLimitedError as exc:
        logger.warning("auth.login_rate_limited", ip=ip, email=email_norm)
        # A.2 — fire-and-forget: record rate-limited attempt (no user_id known).
        asyncio.create_task(
            _record_login_event(
                db,
                user_id=None,
                email_attempted=email_norm,
                ip=ip,
                user_agent=ua,
                success=False,
                failure_reason="rate_limited",
            )
        )
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)) from exc

    row = await db.execute(select(User).where(User.email == email_norm))
    user = row.scalar_one_or_none()

    # A.1 — Constant-time login: always run verify_password so the
    # response time is uniform whether or not the email exists.
    # The structlog events below still carry the true reason so operators
    # can audit — the information never reaches the HTTP response body.
    if user is None:
        verify_password(body.password, _DUMMY_HASH)  # constant-time burn
        logger.warning("auth.login_failure", reason="unknown_email", ip=ip)
        await record_login_failure(ip, email_norm)
        # A.2
        asyncio.create_task(
            _record_login_event(
                db,
                user_id=None,
                email_attempted=email_norm,
                ip=ip,
                user_agent=ua,
                success=False,
                failure_reason="unknown_email",
            )
        )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")

    if not user.is_active:
        verify_password(body.password, _DUMMY_HASH)  # constant-time burn
        logger.warning("auth.login_failure", reason="inactive_user", user_id=str(user.id), ip=ip)
        await record_login_failure(ip, email_norm)
        asyncio.create_task(
            _record_login_event(
                db,
                user_id=user.id,
                email_attempted=None,
                ip=ip,
                user_agent=ua,
                success=False,
                failure_reason="inactive_user",
            )
        )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")

    if not verify_password(body.password, user.password_hash):
        logger.warning("auth.login_failure", reason="wrong_password", user_id=str(user.id), ip=ip)
        await record_login_failure(ip, email_norm)
        asyncio.create_task(
            _record_login_event(
                db,
                user_id=user.id,
                email_attempted=None,
                ip=ip,
                user_agent=ua,
                success=False,
                failure_reason="wrong_password",
            )
        )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")

    user.last_login_at = datetime.now(tz=UTC)
    await db.commit()

    # A.2 — record success (fire-and-forget).
    asyncio.create_task(
        _record_login_event(
            db,
            user_id=user.id,
            email_attempted=None,
            ip=ip,
            user_agent=ua,
            success=True,
            failure_reason=None,
        )
    )

    token = mint_session_token(
        user_id=user.id,
        role=user.role,
        secret=settings.get_session_secret(),
        session_version=user.session_version,
    )
    response.set_cookie(
        _COOKIE_NAME,
        token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        max_age=60 * 60 * 24 * 14,  # 14 days
        path="/",
    )
    logger.info("auth.login_success", user_id=str(user.id), email=user.email)
    return {"message": "logged_in", "role": user.role, "display_name": user.display_name or ""}


@router.post("/api/v1/auth/logout")
async def logout(response: Response) -> dict[str, str]:
    response.delete_cookie(_COOKIE_NAME, path="/")
    return {"message": "logged_out"}


@router.post("/api/v1/auth/logout-everywhere")
async def logout_everywhere(
    response: Response,
    me: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """Invalidate all existing session tokens for the current user.

    Increments ``session_version`` on the user row.  Every token minted
    before this call carries the old ``sv`` value and will be rejected by
    ``_current_user``.  The caller's own cookie is also cleared so they
    are signed out immediately.

    CWE-613 (Insufficient Session Expiration), OWASP A07:2021.
    """
    me.session_version = me.session_version + 1
    await db.commit()
    response.delete_cookie(_COOKIE_NAME, path="/")
    logger.info("auth.logout_everywhere", user_id=str(me.id), new_version=me.session_version)
    return {"message": "logged_out_everywhere"}


@router.get("/api/v1/auth/me", response_model=UserResponse | None)
async def whoami(user: User | None = Depends(_current_user)) -> UserResponse | None:
    return UserResponse.from_orm(user) if user else None


@router.get("/api/v1/auth/mode")
async def auth_mode(
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, bool]:
    """Public endpoint — reports whether team mode and/or demo mode are active.

    The frontend's login gate calls this when ``/auth/me`` returns null:
    if ``team_mode`` is true, redirect to ``/login``; otherwise keep
    the single-user no-auth path. ``demo_mode`` is surfaced separately
    so the UI can render the banner and disable destructive actions.
    """
    count = (await db.execute(select(func.count()).select_from(User))).scalar_one() or 0
    owner_env = bool((os.environ.get("OWNER_EMAIL") or "").strip())
    return {
        "team_mode": count > 0 or owner_env,
        "demo_mode": bool(settings.demo_mode),
    }


# ── Login history ─────────────────────────────────────────────────────


@router.get("/api/v1/auth/login-history", response_model=list[LoginEventResponse])
async def my_login_history(
    me: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=20, ge=1, le=200),
) -> list[LoginEventResponse]:
    """Return the current user's most-recent login events (self only).

    IP and user-agent are included because this is the owner querying
    their own history — they have legitimate interest in spotting
    unfamiliar IPs.  The owner-gated ``/users/{id}/login-history`` route
    applies the same column set.
    """
    rows = (
        (
            await db.execute(
                select(LoginEvent)
                .where(LoginEvent.user_id == me.id)
                .order_by(LoginEvent.timestamp.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return [LoginEventResponse.model_validate(r, from_attributes=True) for r in rows]


# ── User management ───────────────────────────────────────────────────


class UserCreate(BaseModel):
    email: str = Field(..., pattern=_EMAIL_RE)
    password: str = Field(..., min_length=8)
    role: str = Field(default="editor", pattern="^(owner|editor|viewer)$")
    display_name: str | None = None


class UserUpdate(BaseModel):
    role: str | None = Field(default=None, pattern="^(owner|editor|viewer)$")
    display_name: str | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=8)


@router.get("/api/v1/users", response_model=list[UserResponse])
async def list_users(
    _: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db),
) -> list[UserResponse]:
    rows = (await db.execute(select(User).order_by(User.created_at))).scalars().all()
    return [UserResponse.from_orm(u) for u in rows]


@router.post("/api/v1/users", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreate,
    _: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    existing = await db.execute(select(User).where(User.email == body.email.lower().strip()))
    if existing.scalar_one_or_none():
        raise HTTPException(status.HTTP_409_CONFLICT, "email_already_registered")
    user = User(
        email=body.email.lower().strip(),
        password_hash=hash_password(body.password),
        role=body.role,
        display_name=body.display_name,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return UserResponse.from_orm(user)


@router.put("/api/v1/users/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: UUID,
    body: UserUpdate,
    me: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user_not_found")

    # Prevent an owner from demoting themselves to a non-owner role if
    # they're the only owner — guards against accidental lockout.
    if user.id == me.id and body.role and body.role != "owner":
        owner_count = (
            (await db.execute(select(User).where(User.role == "owner", User.is_active.is_(True))))
            .scalars()
            .all()
        )
        if len([o for o in owner_count if o.id != user.id]) == 0:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "cannot_remove_last_owner",
            )

    if body.role is not None:
        user.role = body.role
    if body.display_name is not None:
        user.display_name = body.display_name
    if body.is_active is not None:
        user.is_active = body.is_active
    if body.password:
        user.password_hash = hash_password(body.password)
    await db.commit()
    await db.refresh(user)
    return UserResponse.from_orm(user)


@router.delete("/api/v1/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: UUID,
    me: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db),
) -> None:
    if user_id == me.id:
        raise HTTPException(status.HTTP_409_CONFLICT, "cannot_delete_self")
    user = await db.get(User, user_id)
    if not user:
        return
    await db.delete(user)
    await db.commit()


@router.get("/api/v1/users/{user_id}/login-history", response_model=list[LoginEventResponse])
async def user_login_history(
    user_id: UUID,
    _: User = Depends(require_owner),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=20, ge=1, le=200),
) -> list[LoginEventResponse]:
    """Return login events for any user (owner-gated).

    Returns the same columns as ``/auth/login-history`` since the owner
    already has elevated privileges over all user data.
    """
    rows = (
        (
            await db.execute(
                select(LoginEvent)
                .where(LoginEvent.user_id == user_id)
                .order_by(LoginEvent.timestamp.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return [LoginEventResponse.model_validate(r, from_attributes=True) for r in rows]
