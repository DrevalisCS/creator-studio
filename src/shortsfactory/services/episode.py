"""Episode service — business logic extracted from route handlers.

Provides reusable operations for episode lifecycle management,
deduplicating patterns that were previously repeated 12+ times
across route handlers.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from shortsfactory.models.episode import Episode
from shortsfactory.repositories.episode import EpisodeRepository
from shortsfactory.repositories.generation_job import GenerationJobRepository
from shortsfactory.schemas.script import EpisodeScript

log = structlog.get_logger(__name__)


class EpisodeNotFoundError(Exception):
    """Raised when an episode does not exist."""

    def __init__(self, episode_id: UUID) -> None:
        self.episode_id = episode_id
        super().__init__(f"Episode {episode_id} not found")


class EpisodeNoScriptError(Exception):
    """Raised when an episode has no script."""

    def __init__(self, episode_id: UUID) -> None:
        self.episode_id = episode_id
        super().__init__(f"Episode {episode_id} has no script")


class EpisodeInvalidStatusError(Exception):
    """Raised when an episode is in an invalid status for the requested operation."""

    def __init__(self, episode_id: UUID, current_status: str, allowed: list[str]) -> None:
        self.episode_id = episode_id
        self.current_status = current_status
        self.allowed = allowed
        super().__init__(
            f"Episode {episode_id} has status '{current_status}', "
            f"expected one of {allowed}"
        )


class EpisodeService:
    """Reusable episode operations — extracted from route handlers.

    This service does NOT import FastAPI and raises domain exceptions
    (EpisodeNotFoundError, etc.) that routes catch and convert to
    HTTPException status codes.
    """

    def __init__(self, db: AsyncSession) -> None:
        self._db = db
        self._ep_repo = EpisodeRepository(db)
        self._job_repo = GenerationJobRepository(db)

    # ── Fetch helpers ────────────────────────────────────────────────

    async def get_or_raise(self, episode_id: UUID) -> Episode:
        """Fetch an episode or raise EpisodeNotFoundError."""
        episode = await self._ep_repo.get_by_id(episode_id)
        if episode is None:
            raise EpisodeNotFoundError(episode_id)
        return episode

    async def get_with_script_or_raise(self, episode_id: UUID) -> tuple[Episode, EpisodeScript]:
        """Fetch an episode and validate it has a script.

        Returns (episode, parsed_script) or raises.
        """
        episode = await self.get_or_raise(episode_id)
        if not episode.script:
            raise EpisodeNoScriptError(episode_id)
        script = EpisodeScript.model_validate(episode.script)
        return episode, script

    # ── Job creation helpers ─────────────────────────────────────────

    async def create_reassembly_jobs(
        self,
        episode_id: UUID,
        steps: list[str] | None = None,
    ) -> list[Any]:
        """Create generation job records for reassembly steps.

        This pattern was duplicated 3x across reassemble, regenerate_captions,
        and set_music endpoints.
        """
        if steps is None:
            steps = ["captions", "assembly", "thumbnail"]

        jobs = []
        for step in steps:
            job = await self._job_repo.create(
                episode_id=episode_id,
                step=step,
                status="queued",
            )
            jobs.append(job)
        return jobs

    # ── Status validation ────────────────────────────────────────────

    def require_status(
        self,
        episode: Episode,
        allowed: list[str],
    ) -> None:
        """Raise EpisodeInvalidStatusError if episode status is not in allowed list."""
        if episode.status not in allowed:
            raise EpisodeInvalidStatusError(
                episode.id, episode.status, allowed
            )