"""Add content quality configuration fields to series.

New fields:
- thumbnail_mode: smart_frame|text_overlay|comfyui (default smart_frame)
- thumbnail_comfyui_workflow_id: optional FK for custom thumbnail generation
- music_bpm: override BPM for music generation (null = auto from mood)
- music_key: override musical key (null = auto from mood)
- audio_preset: podcast|cinematic|energetic|ambient
- video_clip_duration: video mode clip length in seconds (default 5)

Revision ID: 014
Revises: 013
Create Date: 2026-04-12
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "014"
down_revision: Union[str, None] = "013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "series",
        sa.Column("thumbnail_mode", sa.String(20), nullable=False, server_default="smart_frame"),
    )
    op.add_column(
        "series",
        sa.Column(
            "thumbnail_comfyui_workflow_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("comfyui_workflows.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "series",
        sa.Column("music_bpm", sa.Integer(), nullable=True),
    )
    op.add_column(
        "series",
        sa.Column("music_key", sa.String(20), nullable=True),
    )
    op.add_column(
        "series",
        sa.Column("audio_preset", sa.String(20), nullable=True),
    )
    op.add_column(
        "series",
        sa.Column("video_clip_duration", sa.Integer(), nullable=False, server_default="5"),
    )


def downgrade() -> None:
    op.drop_column("series", "video_clip_duration")
    op.drop_column("series", "audio_preset")
    op.drop_column("series", "music_key")
    op.drop_column("series", "music_bpm")
    op.drop_column("series", "thumbnail_comfyui_workflow_id")
    op.drop_column("series", "thumbnail_mode")
