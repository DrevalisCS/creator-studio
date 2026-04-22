"""Pydantic schemas for content scheduling."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ScheduleCreate(BaseModel):
    content_type: Literal["episode", "audiobook"]
    content_id: UUID
    platform: Literal["youtube", "tiktok", "instagram", "x", "facebook"]
    scheduled_at: datetime
    title: str = Field(..., min_length=1, max_length=500)
    description: str = ""
    tags: str = ""
    privacy: Literal["public", "unlisted", "private"] = "private"
    youtube_channel_id: UUID | None = None


class ScheduleUpdate(BaseModel):
    scheduled_at: datetime | None = None
    title: str | None = None
    description: str | None = None
    tags: str | None = None
    privacy: Literal["public", "unlisted", "private"] | None = None


class ScheduleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    content_type: str
    content_id: UUID
    platform: str
    scheduled_at: datetime
    title: str
    description: str | None
    tags: str | None
    privacy: str
    status: str
    error_message: str | None
    published_at: datetime | None
    remote_id: str | None
    remote_url: str | None
    youtube_channel_id: UUID | None = None
    created_at: datetime


class CalendarDay(BaseModel):
    date: str  # ISO date "2026-03-28"
    posts: list[ScheduleResponse]
