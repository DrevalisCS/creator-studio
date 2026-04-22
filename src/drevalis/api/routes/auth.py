"""Authentication + user management routes.

Endpoints:

- ``POST /api/v1/auth/login``    email+password → session cookie.
- ``POST /api/v1/auth/logout``   clears the cookie.
- ``GET  /api/v1/auth/me``       current user (when logged in).
- ``GET  /api/v1/users``         list all users (owner only).
- ``POST /api/v1/users``         invite a new user (owner only).
- ``PUT  /api/v1/users/{id}``    change role / enable-disable (owner only).
- ``DELETE /api/v1/users/{id}``  remove a user (owner only; can't remove self).

The login endpoint writes an HTTP-only ``drevalis_session`` cookie
rather than returning a token — same-origin XHR through the frontend
automatically sends it, so nothing else needs to change.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from drevalis.core.deps import get_db, get_settings
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
    from sqlalchemy.ext.asyncio import AsyncSession

    from drevalis.core.config import Settings

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

router = APIRouter(tags=["auth"])

_COOKIE_NAME = "drevalis_session"


class LoginRequest(BaseModel):
    email: str = Field(..., pattern=_EMAIL_RE)
    password: str = Field(..., min_length=1)


class UserResponse(BaseModel):
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


async def _current_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User | None:
    token = request.cookies.get(_COOKIE_NAME)
    if not token:
        return None
    payload = parse_session_token(token, secret=settings.encryption_key)
    if not payload:
        return None
    try:
        uid = UUID(payload["uid"])
    except (KeyError, ValueError):
        return None
    user = await db.get(User, uid)
    if not user or not user.is_active:
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


# ── Auth ──────────────────────────────────────────────────────────────


@router.post("/api/v1/auth/login")
async def login(
    body: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    # First-run bootstrap from env vars — creates the owner account
    # if the users table is empty and OWNER_EMAIL/OWNER_PASSWORD are set.
    await ensure_owner_from_env(db)

    row = await db.execute(select(User).where(User.email == body.email.lower().strip()))
    user = row.scalar_one_or_none()
    if not user or not user.is_active or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")

    user.last_login_at = datetime.now(tz=UTC)
    await db.commit()

    token = mint_session_token(user_id=user.id, role=user.role, secret=settings.encryption_key)
    response.set_cookie(
        _COOKIE_NAME,
        token,
        httponly=True,
        secure=False,  # flip to True behind HTTPS — the reverse proxy terminates TLS
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
