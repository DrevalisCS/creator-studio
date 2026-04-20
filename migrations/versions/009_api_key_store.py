"""Add api_key_store table for encrypted third-party API keys.

Revision ID: 009
Revises: 008
Create Date: 2026-03-27
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "009"
down_revision: Union[str, None] = "008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "api_key_store",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("key_name", sa.TEXT(), nullable=False),
        sa.Column("encrypted_value", sa.TEXT(), nullable=False),
        sa.Column(
            "key_version",
            sa.INTEGER(),
            server_default="1",
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_api_key_store"),
        sa.UniqueConstraint("key_name", name="uq_api_key_store_key_name"),
    )

    # Maintain updated_at via the same trigger used by other tables.
    op.execute(
        """
        CREATE TRIGGER trg_api_key_store_updated_at
        BEFORE UPDATE ON api_key_store
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_api_key_store_updated_at ON api_key_store")
    op.drop_table("api_key_store")
