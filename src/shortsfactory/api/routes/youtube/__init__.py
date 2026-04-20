"""YouTube API router package — backward-compatible re-export."""

from shortsfactory.api.routes.youtube._monolith import router  # noqa: F401

__all__ = ["router"]
