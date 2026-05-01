"""Tests for the animation content-format service (services/animation.py).

Pure helpers — no I/O, no DB. Misses ship as either wrong style anchors
in every animation prompt for an entire episode (silent quality regression)
or a workflow picker that consistently picks the wrong workflow.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from drevalis.services.animation import (
    AnimationDirection,
    decorate_prompt,
    pick_workflow,
    resolve_direction,
)


@dataclass
class _StubWorkflow:
    """Minimal stand-in for ComfyUIWorkflow."""

    name: str
    description: str = ""
    content_format: str = "animation"


# ── resolve_direction ────────────────────────────────────────────────


class TestResolveDirection:
    def test_known_style_returns_matching_anchor(self) -> None:
        d = resolve_direction("anime_classic")
        assert isinstance(d, AnimationDirection)
        assert d.style == "anime_classic"
        assert "90s anime" in d.prefix
        assert "cel-shaded" in d.prefix

    def test_prefix_wraps_anchor_in_parens(self) -> None:
        d = resolve_direction("studio_ghibli")
        assert d.prefix.startswith("(")
        assert d.prefix.rstrip().endswith(", ") or d.prefix.endswith(", ")
        assert d.prefix.count("(") == d.prefix.count(")")

    def test_suffix_includes_quality_anchors(self) -> None:
        d = resolve_direction("pixar_3d")
        assert "masterpiece" in d.suffix
        assert "best quality" in d.suffix

    def test_negative_includes_photorealistic_signals(self) -> None:
        d = resolve_direction("anime_modern")
        # Negative prompt blocks photoreal artifacts.
        assert "photorealistic" in d.negative
        assert "dslr" in d.negative

    def test_unknown_style_falls_back_to_anime_modern(self) -> None:
        d = resolve_direction("totally_made_up_style")
        assert d.style == "anime_modern"
        assert "modern TV anime" in d.prefix

    def test_empty_string_falls_back(self) -> None:
        d = resolve_direction("")
        assert d.style == "anime_modern"

    @pytest.mark.parametrize(
        "style",
        [
            "anime_classic",
            "anime_modern",
            "studio_ghibli",
            "cartoon_network",
            "pixar_3d",
            "disney_3d",
            "motion_comic",
            "stop_motion",
            "pixel_art",
        ],
    )
    def test_every_documented_style_resolves(self, style: str) -> None:
        d = resolve_direction(style)
        assert d.style == style
        assert d.prefix
        assert d.suffix
        assert d.negative


# ── decorate_prompt ──────────────────────────────────────────────────


class TestDecoratePrompt:
    def test_decorates_basic_prompt(self) -> None:
        d = resolve_direction("anime_modern")
        out = decorate_prompt("a cat sitting on a porch", d)
        assert out.startswith(d.prefix)
        assert "a cat sitting on a porch" in out
        assert out.endswith(d.suffix)

    def test_strips_trailing_comma(self) -> None:
        d = resolve_direction("anime_modern")
        out = decorate_prompt("a cat,", d)
        # The trailing comma is stripped before the suffix is appended;
        # the resulting prompt has exactly one comma between core and suffix.
        assert "a cat," + d.suffix.lstrip(", ") not in out  # not double-comma'd
        assert out.startswith(d.prefix)

    def test_strips_trailing_period(self) -> None:
        d = resolve_direction("anime_modern")
        out = decorate_prompt("a cat.", d)
        assert "a cat." not in out

    def test_strips_surrounding_whitespace(self) -> None:
        d = resolve_direction("anime_modern")
        out = decorate_prompt("   a cat   ", d)
        # No double spaces from the strip.
        assert "  a cat" not in out

    def test_empty_prompt_still_produces_output(self) -> None:
        d = resolve_direction("anime_modern")
        out = decorate_prompt("", d)
        # Just prefix + suffix glued together — a valid (if vacuous) prompt.
        assert d.prefix in out
        assert d.suffix in out


# ── pick_workflow ────────────────────────────────────────────────────


class TestPickWorkflow:
    def test_empty_candidates_returns_none(self) -> None:
        assert pick_workflow([], scene_mode="image", style="anime_modern") is None

    def test_no_animation_tagged_returns_none(self) -> None:
        # Mixed in non-animation workflows; without an animation-tagged
        # candidate the picker returns None so the generic fallback runs.
        wfs: list[Any] = [
            _StubWorkflow(name="Shorts narrative", content_format="shorts"),
            _StubWorkflow(name="Long-form narrative", content_format="longform"),
        ]
        assert pick_workflow(wfs, scene_mode="image", style="anime_modern") is None

    def test_falls_back_to_first_animation_when_no_keyword_match(self) -> None:
        wfs = [
            _StubWorkflow(name="Generic animation"),
            _StubWorkflow(name="Other animation"),
        ]
        out = pick_workflow(wfs, scene_mode="image", style="anime_modern")
        assert out is wfs[0]

    def test_keyword_match_in_name(self) -> None:
        wfs = [
            _StubWorkflow(name="Generic animation"),
            _StubWorkflow(name="Anime image generator"),
        ]
        out = pick_workflow(wfs, scene_mode="image", style="anime_modern")
        # Anime keyword + image scene mode → second candidate wins.
        assert out is wfs[1]

    def test_keyword_match_in_description(self) -> None:
        wfs = [
            _StubWorkflow(name="WF-A", description="general purpose"),
            _StubWorkflow(name="WF-B", description="specialised anime renderer"),
        ]
        out = pick_workflow(wfs, scene_mode="image", style="anime_modern")
        assert out is wfs[1]

    def test_video_scene_mode_prefers_video_workflow(self) -> None:
        wfs = [
            _StubWorkflow(name="Anime image gen"),  # image
            _StubWorkflow(name="Anime video animate"),  # video
        ]
        out = pick_workflow(wfs, scene_mode="video", style="anime_modern")
        assert out is wfs[1]

    def test_image_scene_mode_prefers_image_workflow(self) -> None:
        wfs = [
            _StubWorkflow(name="Anime video animate"),  # video
            _StubWorkflow(name="Anime image gen"),  # image
        ]
        out = pick_workflow(wfs, scene_mode="image", style="anime_modern")
        assert out is wfs[1]

    def test_animate_keyword_treated_as_video(self) -> None:
        wfs = [
            _StubWorkflow(name="Anime keyframe gen"),
            _StubWorkflow(name="Anime AnimateDiff motion"),  # video by 'animate'
        ]
        out = pick_workflow(wfs, scene_mode="video", style="anime_modern")
        assert out is wfs[1]

    def test_style_split_on_underscore(self) -> None:
        # "studio_ghibli" → needle "studio"; the picker should match
        # workflows whose name contains "studio".
        wfs = [
            _StubWorkflow(name="Generic animation"),
            _StubWorkflow(name="Studio-style watercolour"),
        ]
        out = pick_workflow(wfs, scene_mode="image", style="studio_ghibli")
        assert out is wfs[1]

    def test_non_animation_tagged_filtered_out_even_with_keyword_match(self) -> None:
        # An animation-keyword name on a non-animation-tagged workflow is
        # ignored; only animation-tagged candidates are considered.
        wfs: list[Any] = [
            _StubWorkflow(name="Anime overlord", content_format="shorts"),
            _StubWorkflow(name="Generic animation", content_format="animation"),
        ]
        out = pick_workflow(wfs, scene_mode="image", style="anime_modern")
        assert out is wfs[1]
        assert out.content_format == "animation"
