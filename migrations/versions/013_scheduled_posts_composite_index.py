"""Add composite index on scheduled_posts(status, scheduled_at).

The publish_scheduled_posts cron job filters by:
    WHERE status = 'scheduled' AND scheduled_at <= now()

A composite index allows Postgres to satisfy both predicates in one
index scan instead of combining two bitmap scans.

Revision ID: 013
Revises: 012
Create Date: 2026-04-12
"""

from typing import Sequence, Union

from alembic import op

revision: str = "013"
down_revision: Union[str, None] = "012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "ix_scheduled_posts_status_scheduled_at",
        "scheduled_posts",
        ["status", "scheduled_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_scheduled_posts_status_scheduled_at", table_name="scheduled_posts")
