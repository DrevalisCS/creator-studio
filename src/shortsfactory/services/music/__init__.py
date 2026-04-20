"""Music service package — backward-compatible re-exports."""
from shortsfactory.services.music._monolith import (  # noqa: F401
    MusicService,
    _ACESTEP_MAX_DURATION,
    _ACESTEP_WORKFLOW_TEMPLATE,
    _MOOD_MUSIC_PARAMS,
    _MOOD_TAGS,
)

__all__ = [
    "MusicService",
    "_ACESTEP_MAX_DURATION",
    "_ACESTEP_WORKFLOW_TEMPLATE",
    "_MOOD_MUSIC_PARAMS",
    "_MOOD_TAGS",
]