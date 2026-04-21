"""Audiobook ORM model."""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy import BIGINT, BOOLEAN, NUMERIC, TEXT, CheckConstraint, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from .voice_profile import VoiceProfile


class Audiobook(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A text-to-audiobook conversion job and its output artefacts."""

    __tablename__ = "audiobooks"
    __table_args__ = (
        CheckConstraint(
            "status IN ('draft', 'generating', 'done', 'failed')",
            name="status_valid",
        ),
        CheckConstraint(
            "output_format IN ('audio_only', 'audio_image', 'audio_video')",
            name="ck_audiobooks_output_format",
        ),
    )

    title: Mapped[str] = mapped_column(TEXT, nullable=False)
    text: Mapped[str] = mapped_column(TEXT, nullable=False)

    voice_profile_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("voice_profiles.id", ondelete="SET NULL"),
        nullable=True,
    )

    status: Mapped[str] = mapped_column(TEXT, nullable=False, server_default="draft")

    # Output format: audio_only | audio_image | audio_video
    output_format: Mapped[str] = mapped_column(TEXT, nullable=False, server_default="audio_only")

    # Cover image for audio_image output format
    cover_image_path: Mapped[str | None] = mapped_column(TEXT, nullable=True)

    # Parsed chapters (list of {"title": str, "text": str})
    chapters: Mapped[Any | None] = mapped_column(JSONB, nullable=True)

    # Voice casting mapping: {"Speaker": "voice_profile_id"}
    voice_casting: Mapped[Any | None] = mapped_column(JSONB, nullable=True)

    # Background music settings
    music_enabled: Mapped[bool] = mapped_column(BOOLEAN, nullable=False, server_default="false")
    music_mood: Mapped[str | None] = mapped_column(TEXT, nullable=True)
    music_volume_db: Mapped[Decimal] = mapped_column(
        NUMERIC, nullable=False, server_default="-14.0"
    )

    # Audio controls
    speed: Mapped[Decimal] = mapped_column(NUMERIC, nullable=False, server_default="1.0")
    pitch: Mapped[Decimal] = mapped_column(NUMERIC, nullable=False, server_default="1.0")

    # Output paths (relative to STORAGE_BASE_PATH)
    audio_path: Mapped[str | None] = mapped_column(TEXT, nullable=True)
    video_path: Mapped[str | None] = mapped_column(TEXT, nullable=True)
    mp3_path: Mapped[str | None] = mapped_column(TEXT, nullable=True)

    duration_seconds: Mapped[float | None] = mapped_column(NUMERIC, nullable=True)
    file_size_bytes: Mapped[int | None] = mapped_column(BIGINT, nullable=True)

    error_message: Mapped[str | None] = mapped_column(TEXT, nullable=True)
    background_image_path: Mapped[str | None] = mapped_column(TEXT, nullable=True)

    # Video generation settings
    video_orientation: Mapped[str] = mapped_column(TEXT, nullable=False, server_default="landscape")
    caption_style_preset: Mapped[str | None] = mapped_column(TEXT, nullable=True)

    # Per-chapter image generation via ComfyUI
    image_generation_enabled: Mapped[bool] = mapped_column(
        BOOLEAN, nullable=False, server_default="false"
    )

    # ── YouTube channel assignment ────────────────────────────────────
    youtube_channel_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("youtube_channels.id", ondelete="SET NULL"),
        nullable=True,
    )

    # ── Relationships ──────────────────────────────────────────────────
    voice_profile: Mapped[VoiceProfile | None] = relationship("VoiceProfile", lazy="selectin")
