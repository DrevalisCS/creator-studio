"""Pydantic v2 request/response schemas for the Series entity."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class SeriesCreate(BaseModel):
    """Payload for creating a new series."""

    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    voice_profile_id: UUID | None = None
    comfyui_server_id: UUID | None = None
    comfyui_workflow_id: UUID | None = None
    llm_config_id: UUID | None = None
    script_prompt_template_id: UUID | None = None
    visual_prompt_template_id: UUID | None = None
    visual_style: str = ""
    character_description: str = ""
    target_duration_seconds: Literal[15, 30, 60] = 30
    default_language: str = "en-US"
    caption_style: dict[str, Any] | None = None
    negative_prompt: str | None = None
    scene_mode: str = "image"  # "image" or "video"
    video_comfyui_workflow_id: UUID | None = None
    music_mood: str | None = None
    music_volume_db: float = -14.0
    music_enabled: bool = True
    youtube_channel_id: UUID | None = None
    content_format: str = "shorts"
    target_duration_minutes: int | None = None
    chapter_enabled: bool = True
    scenes_per_chapter: int = 8
    transition_style: str | None = None
    transition_duration: float = 0.5
    duration_match_strategy: str = "hold_frame"
    base_seed: int | None = None
    intro_template: dict[str, Any] | None = None
    outro_template: dict[str, Any] | None = None
    visual_consistency_prompt: str | None = None
    aspect_ratio: str = "9:16"
    thumbnail_mode: str = "smart_frame"
    thumbnail_comfyui_workflow_id: UUID | None = None
    music_bpm: int | None = None
    music_key: str | None = None
    audio_preset: str | None = None
    video_clip_duration: int = 5


class SeriesUpdate(BaseModel):
    """Payload for updating a series. All fields are optional."""

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    voice_profile_id: UUID | None = None
    comfyui_server_id: UUID | None = None
    comfyui_workflow_id: UUID | None = None
    llm_config_id: UUID | None = None
    script_prompt_template_id: UUID | None = None
    visual_prompt_template_id: UUID | None = None
    visual_style: str | None = None
    character_description: str | None = None
    target_duration_seconds: Literal[15, 30, 60] | None = None
    default_language: str | None = None
    caption_style: dict[str, Any] | None = None
    negative_prompt: str | None = None
    scene_mode: str | None = None
    video_comfyui_workflow_id: UUID | None = None
    music_mood: str | None = None
    music_volume_db: float | None = None
    music_enabled: bool | None = None
    youtube_channel_id: UUID | None = None
    content_format: str | None = None
    target_duration_minutes: int | None = None
    chapter_enabled: bool | None = None
    scenes_per_chapter: int | None = None
    transition_style: str | None = None
    transition_duration: float | None = None
    duration_match_strategy: str | None = None
    base_seed: int | None = None
    intro_template: dict[str, Any] | None = None
    outro_template: dict[str, Any] | None = None
    visual_consistency_prompt: str | None = None
    aspect_ratio: str | None = None
    thumbnail_mode: str | None = None
    thumbnail_comfyui_workflow_id: UUID | None = None
    music_bpm: int | None = None
    music_key: str | None = None
    audio_preset: str | None = None
    video_clip_duration: int | None = None


class SeriesResponse(BaseModel):
    """Full series detail response including all fields."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    description: str | None
    voice_profile_id: UUID | None
    comfyui_server_id: UUID | None
    comfyui_workflow_id: UUID | None
    llm_config_id: UUID | None
    script_prompt_template_id: UUID | None
    visual_prompt_template_id: UUID | None
    visual_style: str | None
    character_description: str | None
    target_duration_seconds: int
    default_language: str
    caption_style: dict[str, Any] | None
    negative_prompt: str | None
    scene_mode: str
    video_comfyui_workflow_id: UUID | None
    music_mood: str | None
    music_volume_db: float
    music_enabled: bool
    youtube_channel_id: UUID | None
    content_format: str
    target_duration_minutes: int | None
    chapter_enabled: bool
    scenes_per_chapter: int
    transition_style: str | None
    transition_duration: float
    duration_match_strategy: str
    base_seed: int | None
    intro_template: dict[str, Any] | None
    outro_template: dict[str, Any] | None
    visual_consistency_prompt: str | None
    aspect_ratio: str
    thumbnail_mode: str
    thumbnail_comfyui_workflow_id: UUID | None
    music_bpm: int | None
    music_key: str | None
    audio_preset: str | None
    video_clip_duration: int
    created_at: datetime
    updated_at: datetime


class SeriesListResponse(BaseModel):
    """Lightweight series representation for list views."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    description: str | None
    target_duration_seconds: int
    episode_count: int
    created_at: datetime
