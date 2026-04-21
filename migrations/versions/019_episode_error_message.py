"""Add episodes.error_message column.

Previously only ``generation_jobs`` carried an ``error_message``. If the
pipeline aborts before any job row is created (DB hiccup on initial
load, license flip mid-run, worker crash in startup code), the episode
flips to ``failed`` with no user-visible reason - the UI reads
``job.error_message`` and shows "Unknown error".

This column fills that gap. Written by the pipeline on any top-level
failure; cleared at the start of the next successful step.

Revision ID: 019
Revises: 018
Create Date: 2026-04-21
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "019"
down_revision: Union[str, None] = "018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "episodes",
        sa.Column("error_message", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("episodes", "error_message")
