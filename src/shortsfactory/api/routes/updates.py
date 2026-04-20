"""Update status + apply endpoints."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from shortsfactory.core.deps import get_redis, get_settings
from shortsfactory.core.license.features import fastapi_dep_require_feature
from shortsfactory.services.updates import check_for_updates, request_update_apply

if TYPE_CHECKING:
    from redis.asyncio import Redis

    from shortsfactory.core.config import Settings


router = APIRouter(
    prefix="/api/v1/updates",
    tags=["updates"],
    # Updates are part of the subscription — gate behind an active license.
    dependencies=[Depends(fastapi_dep_require_feature("basic_generation"))],
)


class UpdateStatusResponse(BaseModel):
    current_installed: str | None = None
    current_stable: str | None = None
    update_available: bool = False
    mandatory_security_update: bool = False
    changelog_url: str | None = None
    image_tags: dict[str, str] = {}
    unavailable: bool = False
    reason: str | None = None


class ApplyResponse(BaseModel):
    queued: bool
    hint: str


@router.get("/status", response_model=UpdateStatusResponse)
async def get_status(
    force: bool = Query(False, description="Bypass cache"),
    settings: "Settings" = Depends(get_settings),
    redis: "Redis" = Depends(get_redis),
) -> UpdateStatusResponse:
    manifest = await check_for_updates(
        redis,
        server_url=settings.license_server_url,
        force=force,
    )
    return UpdateStatusResponse(**manifest)


@router.post("/apply", response_model=ApplyResponse)
async def apply_update() -> ApplyResponse:
    """Ask the updater sidecar to pull new images and restart the stack.

    This is fire-and-forget: the sidecar reads a flag file, runs
    ``docker compose pull && up -d --remove-orphans``, and the new
    containers take over. The browser will reconnect automatically when
    the new frontend comes back online.
    """
    try:
        await request_update_apply()
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "could_not_queue_update", "reason": str(exc)[:200]},
        ) from exc
    return ApplyResponse(
        queued=True,
        hint=(
            "Update queued. The updater sidecar pulls new images and "
            "restarts the stack within ~60 seconds. Reload the page once "
            "you see the connection drop and recover."
        ),
    )
