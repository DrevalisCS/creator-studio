"""Add per-job LLM token counters.

Makes the Usage dashboard able to report real token spend instead of
showing "not yet instrumented". Columns default to 0 so existing rows
stay consistent, and they're nullable='false' so aggregation queries
don't have to COALESCE.

Revision ID: 022
Revises: 021
Create Date: 2026-04-22
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "022"
down_revision: Union[str, None] = "021"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "generation_jobs",
        sa.Column(
            "tokens_prompt",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.add_column(
        "generation_jobs",
        sa.Column(
            "tokens_completion",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )


def downgrade() -> None:
    op.drop_column("generation_jobs", "tokens_completion")
    op.drop_column("generation_jobs", "tokens_prompt")
