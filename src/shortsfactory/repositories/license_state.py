"""Repository for the singleton ``license_state`` row."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import select

from shortsfactory.models.license_state import LicenseStateRow

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


class LicenseStateRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get(self) -> LicenseStateRow | None:
        result = await self._session.execute(select(LicenseStateRow).where(LicenseStateRow.id == 1))
        return result.scalar_one_or_none()

    async def upsert(
        self,
        *,
        jwt: str,
        machine_id: str | None,
    ) -> LicenseStateRow:
        """Write or replace the singleton license row."""
        row = await self.get()
        now = datetime.now(tz=UTC)
        if row is None:
            row = LicenseStateRow(
                id=1,
                jwt=jwt,
                machine_id=machine_id,
                activated_at=now,
                updated_at=now,
            )
            self._session.add(row)
        else:
            row.jwt = jwt
            row.machine_id = machine_id
            if row.activated_at is None:
                row.activated_at = now
            row.updated_at = now
        await self._session.flush()
        return row

    async def clear(self) -> None:
        """Zero the JWT but keep the row for historical fields."""
        row = await self.get()
        if row is None:
            return
        row.jwt = None
        row.updated_at = datetime.now(tz=UTC)
        await self._session.flush()

    async def record_heartbeat(self, status: str) -> None:
        row = await self.get()
        if row is None:
            return
        now = datetime.now(tz=UTC)
        row.last_heartbeat_at = now
        row.last_heartbeat_status = status
        row.updated_at = now
        await self._session.flush()
