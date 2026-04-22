"""Add 'facebook' to social_platforms.platform and scheduled_posts.platform
check constraints.

Drevalis already supports tiktok / instagram / x via Graph-like APIs;
Facebook pages share the Meta Graph API with Instagram so the upload
path is nearly identical. This migration only widens the allowed set —
existing rows are untouched.

Revision ID: 030
Revises: 029
Create Date: 2026-04-22
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "030"
down_revision: Union[str, None] = "029"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # social_platforms.platform
    op.drop_constraint("platform_valid", "social_platforms", type_="check")
    op.create_check_constraint(
        "platform_valid",
        "social_platforms",
        "platform IN ('tiktok', 'instagram', 'x', 'facebook')",
    )

    # scheduled_posts.platform
    op.drop_constraint("sched_platform_valid", "scheduled_posts", type_="check")
    op.create_check_constraint(
        "sched_platform_valid",
        "scheduled_posts",
        "platform IN ('youtube', 'tiktok', 'instagram', 'x', 'facebook')",
    )


def downgrade() -> None:
    op.drop_constraint("platform_valid", "social_platforms", type_="check")
    op.create_check_constraint(
        "platform_valid",
        "social_platforms",
        "platform IN ('tiktok', 'instagram', 'x')",
    )

    op.drop_constraint("sched_platform_valid", "scheduled_posts", type_="check")
    op.create_check_constraint(
        "sched_platform_valid",
        "scheduled_posts",
        "platform IN ('youtube', 'tiktok', 'instagram', 'x')",
    )
