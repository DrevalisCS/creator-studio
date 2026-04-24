"""A/B test pair management — link two same-series episodes for comparison.

Endpoints:

- ``POST   /api/v1/ab-tests``               create a new pair
- ``GET    /api/v1/ab-tests``               list all pairs (optionally per series)
- ``GET    /api/v1/ab-tests/{id}``          one pair + per-episode YouTube stats
- ``DELETE /api/v1/ab-tests/{id}``          untrack the pair (episodes kept)

The comparison itself (``winner_episode_id``, ``comparison_at``) is
populated by a future scheduled worker that pulls YouTube analytics
for both episodes 7 days after the later upload. For v1 we just
surface the raw view counts side-by-side so the operator can eyeball
the result.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession  # runtime import — FastAPI Depends

from drevalis.core.deps import get_db, get_settings
from drevalis.models.ab_test import ABTest
from drevalis.models.episode import Episode
from drevalis.repositories.youtube import YouTubeUploadRepository

if TYPE_CHECKING:
    from drevalis.core.config import Settings

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/ab-tests", tags=["ab-tests"])


class ABTestCreate(BaseModel):
    series_id: UUID
    episode_a_id: UUID
    episode_b_id: UUID
    variant_label: str = Field(..., min_length=1, max_length=255)
    notes: str | None = None


class ABTestResponse(BaseModel):
    id: UUID
    series_id: UUID
    episode_a_id: UUID
    episode_b_id: UUID
    variant_label: str
    notes: str | None
    winner_episode_id: UUID | None
    comparison_at: str | None
    created_at: str


class ABTestStats(BaseModel):
    episode_id: UUID
    title: str
    status: str
    youtube_video_id: str | None
    youtube_url: str | None
    youtube_views: int | None
    youtube_likes: int | None
    youtube_comments: int | None


class ABTestDetail(ABTestResponse):
    episode_a_stats: ABTestStats
    episode_b_stats: ABTestStats


def _serialise(t: ABTest) -> ABTestResponse:
    return ABTestResponse(
        id=t.id,
        series_id=t.series_id,
        episode_a_id=t.episode_a_id,
        episode_b_id=t.episode_b_id,
        variant_label=t.variant_label,
        notes=t.notes,
        winner_episode_id=t.winner_episode_id,
        comparison_at=t.comparison_at.isoformat() if t.comparison_at else None,
        created_at=t.created_at.isoformat() if t.created_at else "",
    )


@router.post(
    "",
    response_model=ABTestResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Link two episodes as an A/B test pair",
)
async def create_ab_test(
    body: ABTestCreate,
    db: AsyncSession = Depends(get_db),
) -> ABTestResponse:
    if body.episode_a_id == body.episode_b_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "An A/B test needs two different episodes.",
        )

    # Verify both episodes exist and belong to the same series.
    ep_rows = await db.execute(
        select(Episode).where(Episode.id.in_([body.episode_a_id, body.episode_b_id]))
    )
    eps = {e.id: e for e in ep_rows.scalars().all()}
    if len(eps) != 2:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "One or both episodes not found.")
    if eps[body.episode_a_id].series_id != body.series_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "episode_a does not belong to the specified series.",
        )
    if eps[body.episode_b_id].series_id != body.series_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "episode_b does not belong to the specified series.",
        )

    test = ABTest(
        series_id=body.series_id,
        episode_a_id=body.episode_a_id,
        episode_b_id=body.episode_b_id,
        variant_label=body.variant_label,
        notes=body.notes,
    )
    db.add(test)
    await db.commit()
    await db.refresh(test)
    logger.info("ab_test_created", id=str(test.id), series_id=str(body.series_id))
    return _serialise(test)


@router.get("", response_model=list[ABTestResponse])
async def list_ab_tests(
    series_id: UUID | None = Query(None, description="Filter by series."),
    db: AsyncSession = Depends(get_db),
) -> list[ABTestResponse]:
    q = select(ABTest).order_by(ABTest.created_at.desc())
    if series_id is not None:
        q = q.where(ABTest.series_id == series_id)
    rows = (await db.execute(q)).scalars().all()
    return [_serialise(t) for t in rows]


@router.get("/{test_id}", response_model=ABTestDetail)
async def get_ab_test(
    test_id: UUID,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ABTestDetail:
    """Return the pair plus side-by-side YouTube view counts.

    View counts come from our local YouTubeUpload rows (populated by
    the upload + periodic refresh path). We deliberately don't call
    the Data API here to keep the page snappy — if the user wants
    fresh numbers they can hit YouTube → Analytics which does a live
    fetch.
    """
    test = await db.get(ABTest, test_id)
    if not test:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ab_test_not_found")

    stats: dict[UUID, ABTestStats] = {}
    upload_repo = YouTubeUploadRepository(db)
    for ep_id in (test.episode_a_id, test.episode_b_id):
        ep = await db.get(Episode, ep_id)
        if ep is None:
            continue
        uploads = await upload_repo.get_by_episode(ep_id)
        last = uploads[-1] if uploads else None
        stats[ep_id] = ABTestStats(
            episode_id=ep_id,
            title=ep.title,
            status=ep.status,
            youtube_video_id=last.youtube_video_id if last else None,
            youtube_url=last.youtube_url if last else None,
            # Views/likes/comments cached on upload row if the worker has
            # refreshed them; otherwise None. The UI shows "—" for None.
            youtube_views=getattr(last, "view_count", None) if last else None,
            youtube_likes=getattr(last, "like_count", None) if last else None,
            youtube_comments=getattr(last, "comment_count", None) if last else None,
        )

    return ABTestDetail(
        **_serialise(test).model_dump(),
        episode_a_stats=stats.get(
            test.episode_a_id,
            ABTestStats(
                episode_id=test.episode_a_id,
                title="(missing episode)",
                status="deleted",
                youtube_video_id=None,
                youtube_url=None,
                youtube_views=None,
                youtube_likes=None,
                youtube_comments=None,
            ),
        ),
        episode_b_stats=stats.get(
            test.episode_b_id,
            ABTestStats(
                episode_id=test.episode_b_id,
                title="(missing episode)",
                status="deleted",
                youtube_video_id=None,
                youtube_url=None,
                youtube_views=None,
                youtube_likes=None,
                youtube_comments=None,
            ),
        ),
    )


@router.delete("/{test_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_ab_test(
    test_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    test = await db.get(ABTest, test_id)
    if not test:
        return
    await db.delete(test)
    await db.commit()
    logger.info("ab_test_deleted", id=str(test_id))


async def _unused_settings(s: Any = Depends(get_settings)) -> Any:
    """Kept to silence unused-import warnings — get_settings is on
    the module path to allow future endpoints to use it."""
    return s
