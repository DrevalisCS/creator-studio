"""Composite index on generation_jobs(episode_id, step).

The pipeline calls ``get_latest_by_episode_and_step`` once per step
(6 times per run) to resume skipping already-completed steps. Without
this index the query is an index-seek on ``ix_generation_jobs_episode_id``
followed by a sort on ``created_at`` — fine at one episode, but under
bulk generation the sort cost compounds. This composite index turns
each call into a single index range-scan.

Also adds an index on ``series.youtube_channel_id`` used by the
publish-scheduled-posts cron to resolve channel per series.

Revision ID: 018
Revises: 017
Create Date: 2026-04-21
"""

from typing import Sequence, Union

from alembic import op

revision: str = "018"
down_revision: Union[str, None] = "017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "ix_generation_jobs_episode_id_step",
        "generation_jobs",
        ["episode_id", "step"],
    )
    op.create_index(
        "ix_series_youtube_channel_id",
        "series",
        ["youtube_channel_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_series_youtube_channel_id", table_name="series")
    op.drop_index("ix_generation_jobs_episode_id_step", table_name="generation_jobs")
