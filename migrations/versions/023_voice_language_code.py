"""Add language_code to voice_profiles.

Lets the UI filter voice pickers by series language and lets the
pipeline pass the correct language hint to faster-whisper. We also
seed it for known Edge-TTS voices where the locale is deterministic
from the ``edge_voice_id`` (e.g. ``en-US-AriaNeural`` → ``en-US``).

Revision ID: 023
Revises: 022
Create Date: 2026-04-22
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "023"
down_revision: Union[str, None] = "022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "voice_profiles",
        sa.Column("language_code", sa.Text(), nullable=True),
    )
    # Derive language_code for Edge voices where the locale is the
    # first two dash-separated segments of edge_voice_id.
    # e.g. 'en-US-AriaNeural' → 'en-US'.
    op.execute(
        """
        UPDATE voice_profiles
        SET language_code = split_part(edge_voice_id, '-', 1) || '-' || split_part(edge_voice_id, '-', 2)
        WHERE provider = 'edge' AND edge_voice_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_column("voice_profiles", "language_code")
