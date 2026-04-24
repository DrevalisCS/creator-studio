"""Character pack routes.

Packs are reusable bundles of ``character_lock`` + ``style_lock`` with
a display name, optional description, and thumbnail asset. Applying a
pack copies its lock payloads onto a series; deleting the pack does
not retroactively affect series that used it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession  # runtime import — FastAPI Depends

from drevalis.core.deps import get_db
from drevalis.models.character_pack import CharacterPack
from drevalis.repositories.series import SeriesRepository

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/character-packs", tags=["character-packs"])


class CharacterPackResponse(BaseModel):
    id: UUID
    name: str
    description: str | None
    thumbnail_asset_id: UUID | None
    character_lock: dict[str, Any] | None
    style_lock: dict[str, Any] | None
    created_at: datetime


class CharacterPackCreate(BaseModel):
    name: str
    description: str | None = None
    thumbnail_asset_id: UUID | None = None
    character_lock: dict[str, Any] | None = None
    style_lock: dict[str, Any] | None = None


class ApplyPackRequest(BaseModel):
    series_id: UUID


@router.get("", response_model=list[CharacterPackResponse])
async def list_packs(db: AsyncSession = Depends(get_db)) -> list[CharacterPackResponse]:
    result = await db.execute(select(CharacterPack).order_by(CharacterPack.created_at.desc()))
    rows = list(result.scalars().all())
    return [
        CharacterPackResponse(
            id=r.id,
            name=r.name,
            description=r.description,
            thumbnail_asset_id=r.thumbnail_asset_id,
            character_lock=r.character_lock,
            style_lock=r.style_lock,
            created_at=r.created_at,
        )
        for r in rows
    ]


@router.post(
    "",
    response_model=CharacterPackResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_pack(
    body: CharacterPackCreate,
    db: AsyncSession = Depends(get_db),
) -> CharacterPackResponse:
    if not body.name.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "name required")
    pack = CharacterPack(
        name=body.name.strip()[:120],
        description=(body.description or "").strip() or None,
        thumbnail_asset_id=body.thumbnail_asset_id,
        character_lock=body.character_lock,
        style_lock=body.style_lock,
    )
    db.add(pack)
    await db.commit()
    await db.refresh(pack)
    return CharacterPackResponse(
        id=pack.id,
        name=pack.name,
        description=pack.description,
        thumbnail_asset_id=pack.thumbnail_asset_id,
        character_lock=pack.character_lock,
        style_lock=pack.style_lock,
        created_at=pack.created_at,
    )


@router.delete("/{pack_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_pack(pack_id: UUID, db: AsyncSession = Depends(get_db)) -> None:
    pack = await db.get(CharacterPack, pack_id)
    if pack is None:
        return
    await db.delete(pack)
    await db.commit()


@router.post("/{pack_id}/apply", response_model=dict)
async def apply_pack(
    pack_id: UUID,
    body: ApplyPackRequest,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Copy this pack's lock payloads onto a series. Overwrites existing
    character_lock + style_lock on the series.
    """
    pack = await db.get(CharacterPack, pack_id)
    if pack is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "character pack not found")

    series_repo = SeriesRepository(db)
    series = await series_repo.get_by_id(body.series_id)
    if series is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "series not found")

    await series_repo.update(
        series.id,
        character_lock=pack.character_lock,
        style_lock=pack.style_lock,
    )
    await db.commit()
    logger.info("character_pack_applied", pack=str(pack_id), series=str(series.id))
    return {
        "series_id": str(series.id),
        "character_lock": pack.character_lock,
        "style_lock": pack.style_lock,
    }
