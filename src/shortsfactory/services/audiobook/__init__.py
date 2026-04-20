"""Audiobook service package — backward-compatible re-exports."""
from shortsfactory.services.audiobook._monolith import (  # noqa: F401
    AudiobookService,
    AudioChunk,
    ChapterTiming,
    PAUSE_BETWEEN_CHAPTERS,
    PAUSE_BETWEEN_SPEAKERS,
    PAUSE_WITHIN_SPEAKER,
)

__all__ = [
    "AudiobookService",
    "AudioChunk",
    "ChapterTiming",
    "PAUSE_BETWEEN_CHAPTERS",
    "PAUSE_BETWEEN_SPEAKERS",
    "PAUSE_WITHIN_SPEAKER",
]