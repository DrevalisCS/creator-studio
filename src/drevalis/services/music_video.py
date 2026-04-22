"""Music-video content-format service (Shorts + long-form).

The long-standing ``shorts`` / ``longform`` pipeline produces
*narrated* video — an LLM writes a script, TTS voices it, ComfyUI
generates scenes, FFmpeg composites everything. Music videos flip
that: the **backing track is the content**, scenes are visual
choreography cut to the beats.

High-level flow (shorts + long-form share it; target_duration_seconds
is the only delta):

    1. LLM generates a **song concept** — title, artist persona, mood,
       genre, structure (intro / verse / chorus / bridge / outro).
    2. LLM writes **lyrics** for each structure block.
    3. Lyric-aware TTS-like audio model (e.g. ACE Step, a Suno-class
       local model, or an ElevenLabs Music call) renders the full
       song including vocals, instrumentation, and optional stems.
    4. We ingest the stereo mix, detect beats/onsets, and decide
       scene boundaries (one scene per lyric line or per bar).
    5. ComfyUI generates each scene image/video using the song mood
       as a style anchor. Animation-style prompts are optional (e.g.
       "music video · anime · neon rain").
    6. FFmpeg composites: burned-in lyric captions synced to the
       vocal track, optional beat-cut transitions.

This file is the service scaffold. The real ACE Step / Suno wiring
lives in the ``music`` service and a new ``services.comfyui`` workflow
tag (``music_video``). Until all three models are installed, the
pipeline orchestrator falls back to the long-form path with a
warning — the user never gets a hard failure, just a ``music_video``
tagged episode rendered like a standard long-form series.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import structlog

if TYPE_CHECKING:
    from drevalis.services.llm import LLMPool

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)


@dataclass
class SongStructure:
    """LLM-generated song plan used by :class:`MusicVideoService`."""

    title: str
    artist_persona: str
    genre: str
    mood: str
    key_bpm: tuple[str, int]  # e.g. ("C minor", 128)
    sections: list[SongSection] = field(default_factory=list)


@dataclass
class SongSection:
    name: str  # intro | verse1 | chorus | bridge | outro
    lyrics: str
    duration_seconds: float
    visual_prompt: str


# ── Song-concept + lyrics planning (LLM phase) ─────────────────────


SYSTEM_PROMPT = (
    "You are a songwriter and music-video director. Given a topic and a "
    "target duration, produce a structured plan: title, artist persona, "
    "genre, mood, key/BPM estimate, and sections (intro / verse / chorus / "
    "bridge / outro) with lyrics for each. Match the duration. Return "
    "compact JSON only — no commentary."
)


async def plan_song(
    llm_pool: LLMPool,
    topic: str,
    target_duration_seconds: float,
    genre_hint: str | None = None,
) -> SongStructure:
    """Ask the LLM for a full song plan. Returns a validated
    :class:`SongStructure`. Kept deliberately small so the orchestrator
    can swap the prompt / provider without reaching inside.
    """
    # TODO: wire through LLMPool.chat() + json_mode + the SongStructure
    # JSON schema. Returning a harmless stub keeps the signature honest
    # for callers while the lyric-generation prompt is iterated.
    logger.info("music_video_song_plan_stub", topic=topic, seconds=target_duration_seconds)
    return SongStructure(
        title=topic[:60],
        artist_persona="Drevalis default",
        genre=genre_hint or "synth-pop",
        mood="cinematic",
        key_bpm=("C minor", 120),
        sections=[],
    )


# ── Song render (AI music with lyrics) ─────────────────────────────


async def render_song(
    structure: SongStructure,
    output_path: Any,
    comfyui_service: Any,
    provider_preference: str = "acestep",
) -> dict[str, Any]:
    """Render the full song to ``output_path`` (WAV 24-bit 44.1 kHz).

    ``provider_preference`` selects which backend to try first:
      * ``"acestep"``   — the ComfyUI ACE Step node pack (local, free)
      * ``"elevenlabs"``— ElevenLabs Music API (paid, fastest path)
      * ``"suno"``      — Suno / BandLab Songster (experimental)

    Fallback order is always tried; if every backend is unavailable the
    caller should degrade gracefully (e.g. swap to an instrumental
    library track and render a pure-instrumental music video).

    Returns ``{"path": ..., "duration": float, "beats": [float, ...]}``.
    """
    # TODO: ACE Step workflow file + lyric-timestamp extraction. Until
    # the workflow is checked in and the beat detector is wired, callers
    # should catch ``NotImplementedError`` and fall back to library music.
    raise NotImplementedError("music_video render_song: ACE Step / Suno backend not yet installed")


# ── Scene beat-matching ────────────────────────────────────────────


def slice_scenes_to_beats(
    beats: list[float],
    sections: list[SongSection],
    *,
    scenes_per_section: int = 4,
) -> list[tuple[float, float, str]]:
    """Return a list of ``(start, end, visual_prompt)`` scene slots.

    For each section we space scenes evenly across its beat range and
    assign the section's ``visual_prompt`` to each slot; downstream the
    pipeline can enrich each prompt with the specific lyric line it
    covers so the ComfyUI output matches what's being sung.
    """
    if not beats or not sections:
        return []

    slots: list[tuple[float, float, str]] = []
    t = 0.0
    for sec in sections:
        sec_end = t + sec.duration_seconds
        bars = [b for b in beats if t <= b < sec_end]
        if len(bars) < scenes_per_section or scenes_per_section <= 1:
            step = sec.duration_seconds / max(1, scenes_per_section)
            for i in range(scenes_per_section):
                slots.append((t + i * step, t + (i + 1) * step, sec.visual_prompt))
        else:
            step = max(1, len(bars) // scenes_per_section)
            for i in range(scenes_per_section):
                start = bars[i * step] if i * step < len(bars) else bars[-1]
                end = bars[(i + 1) * step] if (i + 1) * step < len(bars) else sec_end
                slots.append((start, end, sec.visual_prompt))
        t = sec_end
    return slots


__all__ = [
    "SongStructure",
    "SongSection",
    "plan_song",
    "render_song",
    "slice_scenes_to_beats",
]
