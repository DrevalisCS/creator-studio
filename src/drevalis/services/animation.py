"""Animation content-format service (Shorts + long-form animated video).

Where ``shorts`` and ``longform`` produce *narrated* video with live-
action-style AI scenes, ``animation`` routes the same pipeline through
animation-tagged ComfyUI workflows and style-directs every prompt
toward an animated look (anime, cartoon, Pixar-style, motion-comic).

The pipeline re-uses every existing building block:

* Script        — standard narrative LLM flow (short or chapter-based
  for long-form). The prompt template receives an ``animation_style``
  hint (e.g. "Studio Ghibli pastoral", "Adult Swim rubber-hose") so
  the LLM writes beats that lend themselves to animation.
* Voice         — standard TTS. Optional: per-character voices via
  audiobook-style ``[Speaker]`` tags so an anime cast has distinct
  voices without any cloning setup.
* Scenes        — either image-mode (stylised stills, Ken-Burns zoom
  panel-to-panel) OR video-mode (AnimateDiff / Wan 2.2 with animation
  LoRAs). Scene mode is already a series field; we keep it.
* Captions      — same faster-whisper path. Optional subtitle style
  presets (manga-panel style, karaoke with bouncing beat).
* Assembly      — same FFmpeg composition; adds an "animation intro
  card" and "to be continued" outro for long-form.
* Thumbnail     — same.

This file holds the style-director helper that enriches any prompt
with animation-specific anchors, plus a ComfyUI workflow selector
that picks the best animation-tagged workflow from the pool.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

import structlog

if TYPE_CHECKING:
    from drevalis.models.comfyui import ComfyUIWorkflow

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

AnimationStyle = Literal[
    "anime_classic",  # '90s cel-shaded, strong line art
    "anime_modern",  # modern TV anime (Demon Slayer / JJK vibe)
    "studio_ghibli",  # pastel watercolour backgrounds, soft light
    "cartoon_network",  # Adult Swim / rubber-hose
    "pixar_3d",  # clean 3D render, stylised characters
    "disney_3d",  # polished 3D, fairy-tale lighting
    "motion_comic",  # panel-based, still art with Ken Burns
    "stop_motion",  # claymation / stop-motion
    "pixel_art",  # 16-bit retro pixel art animation
]

_STYLE_PROMPT_ANCHORS: dict[str, str] = {
    "anime_classic": "90s anime, cel-shaded, clear line art, vibrant colours, key-frame pose",
    "anime_modern": "modern TV anime, detailed key frame, dramatic lighting, clean inking",
    "studio_ghibli": "Studio Ghibli watercolour backgrounds, pastel palette, soft natural light",
    "cartoon_network": "flat-shaded cartoon, bold outlines, rubber-hose motion, saturated palette",
    "pixar_3d": "Pixar-style 3D render, stylised proportions, soft global illumination",
    "disney_3d": "polished 3D, fairy-tale lighting, expressive faces, cinematic composition",
    "motion_comic": "comic-book panel art, halftone shading, dynamic action lines",
    "stop_motion": "claymation stop-motion, handcrafted textures, slight frame wobble",
    "pixel_art": "16-bit pixel art animation, limited palette, crisp sprites, dithered shading",
}

_STYLE_NEGATIVE = (
    "photorealistic, real photograph, dslr, hdr, lens flare, skin pores, film grain noise"
)


@dataclass
class AnimationDirection:
    """Everything the pipeline needs to coerce a prompt toward a style.

    Prepend ``prefix`` to every scene prompt, append ``suffix``, and
    feed ``negative`` to the ComfyUI negative-prompt input. The values
    are stable across scenes — a whole episode keeps the same look.
    """

    style: AnimationStyle
    prefix: str
    suffix: str
    negative: str


def resolve_direction(style: AnimationStyle | str) -> AnimationDirection:
    """Return the :class:`AnimationDirection` for a given style name.

    Unknown styles silently fall back to ``anime_modern`` so a typo in
    the series config never hard-fails the pipeline.
    """
    anchor = _STYLE_PROMPT_ANCHORS.get(str(style))
    if anchor is None:
        logger.info("animation_style_fallback", requested=style, chosen="anime_modern")
        anchor = _STYLE_PROMPT_ANCHORS["anime_modern"]
        style = "anime_modern"
    return AnimationDirection(
        style=str(style),  # type: ignore[arg-type]
        prefix=f"({anchor}), ",
        suffix=", masterpiece, best quality, sharp focus",
        negative=_STYLE_NEGATIVE,
    )


def decorate_prompt(prompt: str, direction: AnimationDirection) -> str:
    """Wrap ``prompt`` with the style anchors."""
    core = prompt.strip().rstrip(",.")
    return f"{direction.prefix}{core}{direction.suffix}"


def pick_workflow(
    candidates: list[ComfyUIWorkflow],
    *,
    scene_mode: Literal["image", "video"],
    style: AnimationStyle | str,
) -> ComfyUIWorkflow | None:
    """Pick the best animation-tagged workflow for a scene.

    Heuristic:
      1. Prefer workflows tagged ``content_format='animation'``.
      2. Among those, prefer ones whose ``name`` / ``description``
         matches the requested ``style`` (substring match on a few
         keywords).
      3. Fallback to the first animation-tagged workflow regardless.
      4. If none is tagged animation, caller should fall back to the
         generic picker — returned ``None`` signals "no preference".
    """
    if not candidates:
        return None

    animation_wfs = [c for c in candidates if getattr(c, "content_format", None) == "animation"]
    if not animation_wfs:
        return None

    needle = str(style).split("_")[0]  # "anime_modern" → "anime"
    matching = [
        w
        for w in animation_wfs
        if needle in (w.name or "").lower() or needle in ((w.description or "").lower())
    ]
    if matching:
        # Respect scene_mode if the workflow name advertises it
        for w in matching:
            name = (w.name or "").lower()
            if scene_mode == "video" and ("video" in name or "animate" in name):
                return w
            if scene_mode == "image" and "image" in name:
                return w
        return matching[0]

    return animation_wfs[0]


__all__ = [
    "AnimationStyle",
    "AnimationDirection",
    "resolve_direction",
    "decorate_prompt",
    "pick_workflow",
]
