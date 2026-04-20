"""MediaAsset repository — episode scoping, type filtering, storage stats."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from shortsfactory.models.media_asset import MediaAsset

from .base import BaseRepository


class MediaAssetRepository(BaseRepository[MediaAsset]):
    """Repository for :class:`MediaAsset` entities."""

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, MediaAsset)

    async def get_by_episode(self, episode_id: UUID) -> list[MediaAsset]:
        """Return all media assets belonging to an episode."""
        stmt = (
            select(MediaAsset)
            .where(MediaAsset.episode_id == episode_id)
            .order_by(MediaAsset.created_at)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_by_episode_and_type(
        self,
        episode_id: UUID,
        asset_type: str,
    ) -> list[MediaAsset]:
        """Return assets for an episode filtered by asset_type."""
        stmt = (
            select(MediaAsset)
            .where(
                MediaAsset.episode_id == episode_id,
                MediaAsset.asset_type == asset_type,
            )
            .order_by(MediaAsset.created_at)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_total_size_bytes(self) -> int:
        """Sum of all file_size_bytes (for storage reporting).

        Returns 0 when there are no assets or all sizes are NULL.
        """
        stmt = select(func.coalesce(func.sum(MediaAsset.file_size_bytes), 0))
        result = await self.session.execute(stmt)
        return result.scalar_one()

    async def delete_by_episode(self, episode_id: UUID) -> int:
        """Bulk-delete all media assets for an episode.

        Returns the number of rows deleted.
        """
        stmt = (
            delete(MediaAsset)
            .where(MediaAsset.episode_id == episode_id)
            .returning(MediaAsset.id)
        )
        result = await self.session.execute(stmt)
        await self.session.flush()
        return result.rowcount  # type: ignore[return-value]

    async def get_by_episode_and_scene(
        self,
        episode_id: UUID,
        scene_number: int,
    ) -> list[MediaAsset]:
        """Return all media assets for an episode with the given scene_number."""
        stmt = (
            select(MediaAsset)
            .where(
                MediaAsset.episode_id == episode_id,
                MediaAsset.scene_number == scene_number,
            )
            .order_by(MediaAsset.created_at)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def delete_by_episode_and_scene(
        self,
        episode_id: UUID,
        scene_number: int,
    ) -> int:
        """Bulk-delete all media assets for a specific scene of an episode.

        Returns the number of rows deleted.
        """
        stmt = (
            delete(MediaAsset)
            .where(
                MediaAsset.episode_id == episode_id,
                MediaAsset.scene_number == scene_number,
            )
            .returning(MediaAsset.id)
        )
        result = await self.session.execute(stmt)
        await self.session.flush()
        return result.rowcount  # type: ignore[return-value]
