"""User ORM model — team / workspace membership."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BOOLEAN, TEXT, TIMESTAMP, CheckConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A human who logs into this Drevalis install.

    Role constraints:
    - ``owner``  : everything, including user management + billing.
    - ``editor`` : generate / publish / edit; cannot manage users or
                   change billing.
    - ``viewer`` : read-only; can inspect but not change anything.

    Self-hosted installs usually have exactly one owner and zero-to-a-
    few editors. The schema supports more but the UI is deliberately
    optimised for small teams.
    """

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(
            "role IN ('owner', 'editor', 'viewer')",
            name="role_valid",
        ),
        Index("ix_users_email", "email", unique=True),
    )

    email: Mapped[str] = mapped_column(TEXT, nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(TEXT, nullable=False)
    role: Mapped[str] = mapped_column(TEXT, nullable=False, server_default="'owner'")
    display_name: Mapped[str | None] = mapped_column(TEXT, nullable=True)
    is_active: Mapped[bool] = mapped_column(BOOLEAN, nullable=False, server_default="true")
    last_login_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
