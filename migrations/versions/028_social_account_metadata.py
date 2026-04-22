"""Add account_metadata JSONB to social_platforms.

Used by the Instagram uploader to store ``public_video_base_url``
(the HTTPS prefix that replaces the local storage path when handing
a video URL to the Graph API). Generic shape so future platforms can
stash platform-specific knobs without new migrations.

Revision ID: 028
Revises: 027
Create Date: 2026-04-22
"""

from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "028"
down_revision: Union[str, None] = "027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "social_platforms",
        sa.Column("account_metadata", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("social_platforms", "account_metadata")
