"""Long-form script generation service.

Generates multi-chapter scripts for long-form videos (15-60+ minutes)
using a 3-phase chunked LLM approach:

1. **Outline**: Generate chapter structure with summaries and moods.
2. **Chapters**: Generate scenes for each chapter sequentially,
   maintaining narrative continuity via previous-chapter context.
3. **Quality pass** (optional): Review and fix inconsistencies.

Uses the existing ``LLMProvider`` protocol — no new providers needed.
"""

from __future__ import annotations

import json
import re
from typing import Any

import structlog

log = structlog.get_logger(__name__)


# ── Data structures ──────────────────────────────────────────────────────


class ChapterOutline:
    """A chapter in the outline phase."""

    def __init__(
        self,
        title: str,
        summary: str,
        key_points: list[str] | None = None,
        target_scene_count: int = 8,
        mood: str = "neutral",
        visual_prompt_hint: str = "",
    ) -> None:
        self.title = title
        self.summary = summary
        self.key_points = key_points or []
        self.target_scene_count = target_scene_count
        self.mood = mood
        self.visual_prompt_hint = visual_prompt_hint


class LongFormScriptService:
    """Generates structured multi-chapter scripts for long-form videos."""

    def __init__(
        self,
        provider: Any,  # LLMProvider protocol
        *,
        visual_consistency_prompt: str = "",
        character_description: str = "",
    ) -> None:
        self._provider = provider
        self._visual_consistency_prompt = visual_consistency_prompt
        self._character_description = character_description

    async def generate(
        self,
        topic: str,
        series_description: str,
        target_duration_minutes: int,
        chapter_count: int | None = None,
        scenes_per_chapter: int = 8,
        visual_style: str = "",
        negative_prompt: str = "",
    ) -> dict[str, Any]:
        """Generate a full long-form script.

        Returns a dict with:
        - ``title``: episode title
        - ``script``: EpisodeScript-compatible dict (flat scene list)
        - ``chapters``: list of chapter metadata dicts
        """
        if chapter_count is None:
            chapter_count = max(3, target_duration_minutes // 8)

        # Bind phase explicitly per phase below so log lines coming
        # from individual provider.generate() calls inside helpers
        # carry the phase tag rather than only inheriting episode_id
        # and step from the calling pipeline.
        log.info(
            "longform_script.generate.start",
            topic=topic[:80],
            target_minutes=target_duration_minutes,
            chapters=chapter_count,
            scenes_per_chapter=scenes_per_chapter,
        )

        # Phase 1: Outline
        structlog.contextvars.bind_contextvars(longform_phase="outline")
        outline = await self._generate_outline(
            topic=topic,
            series_description=series_description,
            target_duration_minutes=target_duration_minutes,
            chapter_count=chapter_count,
            scenes_per_chapter=scenes_per_chapter,
        )

        log.info(
            "longform_script.outline_done",
            title=outline.get("title", "?"),
            chapters=len(outline.get("chapters", [])),
        )

        # Phase 2: Chapter-by-chapter scene generation
        structlog.contextvars.bind_contextvars(longform_phase="chapters")
        all_scenes: list[dict[str, Any]] = []
        chapter_metadata: list[dict[str, Any]] = []
        previous_last_scene: str = ""
        scene_number = 1

        for ch_idx, ch_outline in enumerate(outline.get("chapters", [])):
            ch_scenes = await self._generate_chapter_scenes(
                chapter_outline=ch_outline,
                full_outline=outline,
                chapter_index=ch_idx,
                series_description=series_description,
                visual_style=visual_style,
                negative_prompt=negative_prompt,
                previous_last_scene=previous_last_scene,
                scene_start_number=scene_number,
                target_scene_count=ch_outline.get("target_scene_count", scenes_per_chapter),
            )

            # Build chapter metadata
            scene_indices = list(range(scene_number, scene_number + len(ch_scenes)))
            chapter_metadata.append(
                {
                    "title": ch_outline.get("title", f"Chapter {ch_idx + 1}"),
                    "scenes": scene_indices,
                    "mood": ch_outline.get("mood", "neutral"),
                    "music_mood": ch_outline.get("mood", "neutral"),
                }
            )

            all_scenes.extend(ch_scenes)

            # Continuity: carry the last 2 scenes' narrations into the next
            # chapter prompt so the LLM has richer context to continue from.
            if ch_scenes:
                if len(ch_scenes) >= 2:
                    prev_context = (
                        ch_scenes[-2].get("narration", "")[:300]
                        + " "
                        + ch_scenes[-1].get("narration", "")[:300]
                    )
                else:
                    prev_context = ch_scenes[-1].get("narration", "")[:500]
                previous_last_scene = prev_context[:800]

            scene_number += len(ch_scenes)

            log.info(
                "longform_script.chapter_done",
                chapter=ch_idx + 1,
                total_chapters=len(outline.get("chapters", [])),
                scenes=len(ch_scenes),
            )

        # Build EpisodeScript-compatible dict
        title = outline.get("title", topic[:80])
        script = {
            "title": title,
            "hook": outline.get("hook", ""),
            "scenes": all_scenes,
            "outro": outline.get("outro", ""),
            "total_duration_seconds": sum(s.get("duration_seconds", 10) for s in all_scenes),
            "language": "en-US",
            "description": outline.get("description", ""),
            "hashtags": outline.get("hashtags", []),
        }

        log.info(
            "longform_script.generate.done",
            title=title,
            total_scenes=len(all_scenes),
            total_chapters=len(chapter_metadata),
        )

        return {
            "title": title,
            "script": script,
            "chapters": chapter_metadata,
        }

    # ── Phase 1: Outline ─────────────────────────────────────────────────

    async def _generate_outline(
        self,
        topic: str,
        series_description: str,
        target_duration_minutes: int,
        chapter_count: int,
        scenes_per_chapter: int,
    ) -> dict[str, Any]:
        """Generate the chapter outline via LLM."""
        system_prompt = (
            "You are a professional video scriptwriter specializing in long-form "
            "content. Generate a detailed chapter outline for a video.\n\n"
            "Output ONLY valid JSON with this structure:\n"
            '{"title": "Video Title", "hook": "Opening hook text", '
            '"description": "Video description for SEO", '
            '"hashtags": ["#tag1", "#tag2"], '
            '"outro": "Closing text", '
            '"chapters": [{"title": "Chapter 1: ...", '
            '"summary": "2-3 sentence summary", '
            '"key_points": ["point1", "point2"], '
            f'"target_scene_count": {scenes_per_chapter}, '
            '"mood": "dramatic|calm|tense|mysterious|epic|educational|funny", '
            '"visual_prompt_hint": "Brief visual style note for this chapter"}]}'
        )

        character_ctx = ""
        if self._character_description:
            character_ctx = f"\nNarrator/Character: {self._character_description}"

        user_prompt = (
            f"Create a chapter outline for a {target_duration_minutes}-minute video.\n\n"
            f"Topic: {topic}\n"
            f"Series context: {series_description}\n"
            f"{character_ctx}\n"
            f"Number of chapters: {chapter_count}\n"
            f"Scenes per chapter: ~{scenes_per_chapter}\n\n"
            f"Each chapter should have a clear narrative arc. "
            f"Distribute pacing naturally — intro chapters shorter, "
            f"climax chapters longer. Vary moods across chapters."
        )

        result = await self._provider.generate(
            system_prompt,
            user_prompt,
            temperature=0.7,
            max_tokens=1500,
            json_mode=True,
        )

        parsed = self._parse_json(result.content)
        if not isinstance(parsed, dict):
            raise ValueError(f"Expected JSON object, got {type(parsed).__name__}")
        return parsed

    # ── Phase 2: Chapter scenes ──────────────────────────────────────────

    async def _generate_chapter_scenes(
        self,
        chapter_outline: dict[str, Any],
        full_outline: dict[str, Any],
        chapter_index: int,
        series_description: str,
        visual_style: str,
        negative_prompt: str,
        previous_last_scene: str,
        scene_start_number: int,
        target_scene_count: int,
    ) -> list[dict[str, Any]]:
        """Generate scenes for a single chapter."""
        # Build outline summary for context (truncated to save context window)
        outline_summary = "\n".join(
            f"- {ch.get('title', f'Chapter {i + 1}')}: {ch.get('summary', '')[:80]}"
            for i, ch in enumerate(full_outline.get("chapters", []))
        )

        consistency = ""
        if self._visual_consistency_prompt:
            consistency = f"\nVisual consistency: {self._visual_consistency_prompt}"

        continuity = ""
        if previous_last_scene:
            continuity = (
                f"\n\nThe previous chapter ended with this narration:\n"
                f'"{previous_last_scene}"\n'
                f"Continue naturally from this point."
            )

        # Foreshadow the upcoming chapter when one exists, so the LLM can
        # plant subtle narrative seeds at the end of the current chapter.
        all_chapters = full_outline.get("chapters", [])
        if chapter_index + 1 < len(all_chapters):
            next_ch = all_chapters[chapter_index + 1]
            next_hint = (
                f"\nThe next chapter will be: {next_ch.get('title', '?')}"
                f" — {next_ch.get('summary', '')[:100]}"
            )
            continuity += next_hint

        system_prompt = (
            "You are a professional video scriptwriter. Generate scenes for "
            "one chapter of a long-form video.\n\n"
            "Output ONLY valid JSON: a list of scene objects:\n"
            '[{"scene_number": 1, "narration": "Voice-over text", '
            '"visual_prompt": "Detailed image/video generation prompt", '
            '"duration_seconds": 10, '
            '"keywords": ["keyword1", "keyword2"]}]\n\n'
            "Rules:\n"
            "- Each scene has 2-4 sentences of narration\n"
            "- visual_prompt must be detailed and self-contained\n"
            "- duration_seconds should vary naturally (5-20s) based on narration length\n"
            "- keywords are 2-4 important words shown on screen\n"
            f"{consistency}"
        )

        user_prompt = (
            f"Generate {target_scene_count} scenes for this chapter:\n\n"
            f"Chapter: {chapter_outline.get('title', '?')}\n"
            f"Summary: {chapter_outline.get('summary', '')[:200]}\n"
            f"Mood: {chapter_outline.get('mood', 'neutral')}\n\n"
            f"Outline:\n{outline_summary}\n"
            f"{continuity}\n\n"
            f"Start scene numbering at {scene_start_number}."
        )

        result = await self._provider.generate(
            system_prompt,
            user_prompt,
            temperature=0.8,
            max_tokens=3000,
            json_mode=True,
        )

        scenes = self._parse_json(result.content)

        # Handle both list and dict-with-scenes responses
        if isinstance(scenes, dict):
            scenes = scenes.get("scenes", [])
        if not isinstance(scenes, list):
            scenes = []

        # Prepend visual consistency prompt to each scene
        if self._visual_consistency_prompt:
            for scene in scenes:
                vp = scene.get("visual_prompt", "")
                scene["visual_prompt"] = f"{self._visual_consistency_prompt}, {vp}"

        # Renumber scenes sequentially
        for i, scene in enumerate(scenes):
            scene["scene_number"] = scene_start_number + i

        return scenes

    # ── Helpers ───────────────────────────────────────────────────────────

    @staticmethod
    def _parse_json(text: str) -> Any:
        """Extract and parse JSON from LLM output.

        Raises ``ValueError`` rather than returning ``{}`` on total
        failure — the previous silent fallback let a bad outline
        propagate through every chapter, leaving the user with a "it
        generated but the chapters are empty" mystery. Raising here
        lets the LLMPool retry on the next provider.
        """
        text = text.strip()
        # Strip markdown fences
        if "```" in text:
            match = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
            if match:
                text = match.group(1).strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # Try to find JSON object or array in the text
            for start_char, end_char in [("{", "}"), ("[", "]")]:
                start = text.find(start_char)
                end = text.rfind(end_char)
                if start != -1 and end > start:
                    try:
                        return json.loads(text[start : end + 1])
                    except json.JSONDecodeError:
                        continue
            log.warning("longform_script.json_parse_failed", text=text[:200])
            raise ValueError("LLM did not return parseable JSON") from None
