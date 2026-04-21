"""YouTube API router package — backward-compatible re-export."""

from drevalis.api.routes.youtube._monolith import router  # noqa: F401

__all__ = ["router"]
