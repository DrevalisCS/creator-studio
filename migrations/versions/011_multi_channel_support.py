"""Add multi-channel upload support.

- youtube_channels: add upload_days (JSONB), upload_time (TEXT)
- series: add youtube_channel_id FK
- audiobooks: add youtube_channel_id FK
- scheduled_posts: add youtube_channel_id FK

Revision ID: 011
Revises: 010
Create Date: 2026-04-02
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "011"
down_revision: Union[str, None] = "010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # youtube_channels: scheduling fields
    op.add_column(
        "youtube_channels",
        sa.Column("upload_days", postgresql.JSONB(), nullable=True),
    )
    op.add_column(
        "youtube_channels",
        sa.Column("upload_time", sa.TEXT(), nullable=True),
    )

    # series: channel assignment
    op.add_column(
        "series",
        sa.Column(
            "youtube_channel_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("youtube_channels.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # audiobooks: channel assignment
    op.add_column(
        "audiobooks",
        sa.Column(
            "youtube_channel_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("youtube_channels.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # scheduled_posts: channel assignment
    op.add_column(
        "scheduled_posts",
        sa.Column(
            "youtube_channel_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("youtube_channels.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("scheduled_posts", "youtube_channel_id")
    op.drop_column("audiobooks", "youtube_channel_id")
    op.drop_column("series", "youtube_channel_id")
    op.drop_column("youtube_channels", "upload_time")
    op.drop_column("youtube_channels", "upload_days")
