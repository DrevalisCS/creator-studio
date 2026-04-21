"""Pydantic v2 response schemas for the Settings / system-health endpoints."""

from __future__ import annotations

from pydantic import BaseModel


class StorageUsageResponse(BaseModel):
    """Storage usage statistics."""

    total_size_bytes: int
    total_size_human: str
    storage_base_path: str


class ServiceHealth(BaseModel):
    """Health status of a single backend service."""

    name: str
    status: str  # "ok" | "degraded" | "unreachable"
    message: str = ""


class HealthCheckResponse(BaseModel):
    """Aggregated system health check result."""

    overall: str  # "ok" | "degraded" | "unhealthy"
    services: list[ServiceHealth]


class FFmpegInfoResponse(BaseModel):
    """FFmpeg installation information."""

    ffmpeg_path: str
    available: bool
    version: str | None = None
    message: str = ""
