"""ScheduledPost repository."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from shortsfactory.models.scheduled_post import ScheduledPost

from .base import BaseRepository


class ScheduledPostRepository(BaseRepository[ScheduledPost]):
    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, ScheduledPost)

    async def get_pending(self, before: datetime) -> list[ScheduledPost]:
        stmt = (
            select(ScheduledPost)
            .where(ScheduledPost.status == "scheduled", ScheduledPost.scheduled_at <= before)
            .order_by(ScheduledPost.scheduled_at)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_by_content(self, content_type: str, content_id: UUID) -> list[ScheduledPost]:
        stmt = (
            select(ScheduledPost)
            .where(ScheduledPost.content_type == content_type, ScheduledPost.content_id == content_id)
            .order_by(ScheduledPost.scheduled_at.desc())
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_upcoming(self, limit: int = 20) -> list[ScheduledPost]:
        stmt = (
            select(ScheduledPost)
            .where(ScheduledPost.status == "scheduled")
            .order_by(ScheduledPost.scheduled_at)
            .limit(limit)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_calendar(self, start: datetime, end: datetime) -> list[ScheduledPost]:
        stmt = (
            select(ScheduledPost)
            .where(ScheduledPost.scheduled_at >= start, ScheduledPost.scheduled_at <= end)
            .order_by(ScheduledPost.scheduled_at)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())
