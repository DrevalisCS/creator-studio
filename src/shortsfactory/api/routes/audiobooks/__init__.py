"""Audiobooks API router package — backward-compatible re-export."""

from shortsfactory.api.routes.audiobooks._monolith import router  # noqa: F401

__all__ = ["router"]
