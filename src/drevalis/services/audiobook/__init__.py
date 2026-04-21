"""Audiobook service package — backward-compatible re-exports."""

from drevalis.services.audiobook._monolith import (  # noqa: F401
    PAUSE_BETWEEN_CHAPTERS,
    PAUSE_BETWEEN_SPEAKERS,
    PAUSE_WITHIN_SPEAKER,
    AudiobookService,
    AudioChunk,
    ChapterTiming,
)

__all__ = [
    "AudiobookService",
    "AudioChunk",
    "ChapterTiming",
    "PAUSE_BETWEEN_CHAPTERS",
    "PAUSE_BETWEEN_SPEAKERS",
    "PAUSE_WITHIN_SPEAKER",
]
