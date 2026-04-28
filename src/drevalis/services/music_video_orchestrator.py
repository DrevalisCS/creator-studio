"""Music-video orchestrator (Phase 2a).

Sibling of :class:`PipelineOrchestrator`. When an episode's series has
``content_format == 'music_video'``, the worker dispatches here instead
of the regular pipeline so the music-video-shaped script + audio + beat
data is produced without trying to TTS the lyrics or feed scene-gen a
narration script.

Phase 2a delivers SCRIPT + AUDIO real:

  1. ``plan_song`` (LLM) → ``SongStructure``
  2. Persist plan to ``episode.script`` (music-video JSONB shape)
  3. ``MusicService.get_music_for_episode`` → instrumental WAV at the
     song's mood + duration. Vocals via ACE Step v3 / ElevenLabs Music
     are Phase 3.
  4. ``detect_beats`` → list of beat times + BPM
  5. ``slice_scenes_to_beats`` → list of ``(start, end, prompt)`` slots
  6. Persist beat data + scene slots to ``episode.script.music_video``
  7. Mark episode ``status='review'`` so the user can preview the
     plan + audio before Phase 2b's visual generation lands

Phase 2b (follow-up) will fill in SCENES + CAPTIONS + ASSEMBLY +
THUMBNAIL by reusing the existing ComfyUI / FFmpeg infrastructure.

The orchestrator deliberately does NOT subclass ``PipelineOrchestrator``
— their step lists differ (no VOICE for music videos; no SCRIPT for
music videos in the narration sense), and inheritance would force
both classes to deal with each other's edge cases.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

import structlog

if TYPE_CHECKING:
    from redis.asyncio import Redis
    from sqlalchemy.ext.asyncio import AsyncSession

    from drevalis.services.ffmpeg._monolith import FFmpegService
    from drevalis.services.llm._monolith import LLMPool
    from drevalis.services.music import MusicService
    from drevalis.services.storage import LocalStorage

from drevalis.repositories.episode import EpisodeRepository
from drevalis.services.music_video import (
    SongStructure,
    detect_beats,
    plan_song,
    slice_scenes_to_beats,
)


class MusicVideoOrchestrator:
    """Phase 2a music-video pipeline (SCRIPT + AUDIO)."""

    def __init__(
        self,
        episode_id: UUID,
        db_session: AsyncSession,
        redis: Redis,
        llm_pool: LLMPool,
        music_service: MusicService,
        ffmpeg_service: FFmpegService,
        storage: LocalStorage,
    ) -> None:
        self.episode_id = episode_id
        self.db = db_session
        self.redis = redis
        self.llm_pool = llm_pool
        self.music_service = music_service
        self.ffmpeg_service = ffmpeg_service
        self.storage = storage
        self.log = structlog.get_logger(__name__).bind(
            episode_id=str(episode_id), pipeline="music_video"
        )
        self.episode_repo = EpisodeRepository(db_session)

    # ── Cancellation ────────────────────────────────────────────────────

    async def _check_cancelled(self) -> None:
        """Raise ``CancelledError`` if a cancel flag is set."""
        try:
            flag = await self.redis.get(f"cancel:{self.episode_id}")
        except Exception:
            return
        if flag:
            self.log.info("music_video.cancelled_by_user")
            raise asyncio.CancelledError(f"Episode {self.episode_id} cancelled")

    # ── Progress broadcast ──────────────────────────────────────────────

    async def _broadcast(self, step: str, pct: int, message: str) -> None:
        import json as _json

        try:
            await self.redis.publish(
                f"progress:{self.episode_id}",
                _json.dumps(
                    {
                        "episode_id": str(self.episode_id),
                        "step": step,
                        "progress_pct": pct,
                        "message": message,
                    }
                ),
            )
        except Exception:
            pass

    # ── Step 1: SCRIPT (song plan) ──────────────────────────────────────

    async def _run_script(self, episode: Any, series: Any) -> SongStructure:
        await self._broadcast("script", 5, "Planning the song...")
        target_seconds = (getattr(series, "target_duration_minutes", None) or 3) * 60.0
        topic = (episode.topic or series.title or "untitled").strip()[:300]
        genre_hint = getattr(series, "music_genre", None)
        mood_hint = getattr(series, "music_mood", None) or getattr(series, "visual_style", None)

        plan = await plan_song(
            self.llm_pool,
            topic=topic,
            target_duration_seconds=target_seconds,
            genre_hint=genre_hint,
            mood_hint=mood_hint,
        )
        await self._broadcast(
            "script",
            30,
            f"Song planned: '{plan.title}' ({len(plan.sections)} sections)",
        )
        return plan

    # ── Step 2: AUDIO (instrumental + beats + slots) ────────────────────

    async def _run_audio(self, episode: Any, series: Any, plan: SongStructure) -> dict[str, Any]:
        await self._check_cancelled()
        await self._broadcast("audio", 40, "Rendering backing track...")

        # Resolve where to save the song.
        episode_dir = Path(self.storage.resolve_path(f"episodes/{self.episode_id}/voice"))
        episode_dir.mkdir(parents=True, exist_ok=True)
        song_path = episode_dir / "song.wav"

        # Use the song's mood as the music-mood key. Fall back to the
        # series' configured mood, then to "calm" so MusicService always
        # has a valid mood string.
        mood = plan.mood or getattr(series, "music_mood", None) or "calm"
        target_seconds = plan.total_duration_seconds or 60.0

        try:
            resolved = await self.music_service.get_music_for_episode(
                mood=mood,
                target_duration=target_seconds,
                episode_id=uuid4(),  # MusicService uses this as a cache key
            )
        except Exception as exc:  # noqa: BLE001
            self.log.warning(
                "music_video.audio.music_service_failed",
                error=f"{type(exc).__name__}: {str(exc)[:200]}",
            )
            resolved = None

        if resolved is None:
            raise RuntimeError(
                "Music backing track could not be resolved. Either populate "
                f"the curated music library for mood '{mood}' or register a "
                "ComfyUI server with AceStep generation enabled."
            )

        # Copy / move the resolved track to the episode-scoped path so
        # downstream steps (Phase 2b assembly) find it deterministically.
        try:
            import shutil as _shutil

            _shutil.copy2(resolved, song_path)
        except Exception as exc:  # noqa: BLE001
            self.log.warning(
                "music_video.audio.copy_failed",
                src=str(resolved),
                dst=str(song_path),
                error=str(exc)[:200],
            )
            song_path = Path(resolved)

        await self._broadcast("audio", 70, "Detecting beats...")
        beat_times, bpm = detect_beats(song_path)

        # Build scene slots even when beat detection failed — the
        # slicer falls back to evenly-spaced cuts.
        scenes_per_section = max(2, int(getattr(series, "scenes_per_chapter", 4) or 4))
        scene_slots = slice_scenes_to_beats(
            beats=beat_times,
            sections=plan.sections,
            scenes_per_section=scenes_per_section,
        )

        rel_song_path = f"episodes/{self.episode_id}/voice/song.wav"
        audio_meta: dict[str, Any] = {
            "song_path": rel_song_path,
            "duration_seconds": plan.total_duration_seconds,
            "bpm": round(bpm, 1) if bpm else 0.0,
            "beat_count": len(beat_times),
            "scene_slots": [
                {
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "visual_prompt": prompt,
                }
                for (start, end, prompt) in scene_slots
            ],
        }
        await self._broadcast(
            "audio",
            90,
            f"Backing track ready · {bpm:.0f} BPM · {len(scene_slots)} scenes",
        )
        return audio_meta

    # ── Persistence ─────────────────────────────────────────────────────

    async def _persist_script(self, plan: SongStructure, audio_meta: dict[str, Any]) -> None:
        """Store the music-video-shaped script blob on the episode row."""
        script_blob = {
            "kind": "music_video",
            "music_video": {
                "song": plan.to_dict(),
                "audio": audio_meta,
            },
        }
        await self.episode_repo.update(
            self.episode_id,
            script=script_blob,
            title=plan.title,
        )
        await self.db.commit()

    # ── Run ─────────────────────────────────────────────────────────────

    async def run(self) -> None:
        """Execute the music-video pipeline (Phase 2a: SCRIPT + AUDIO)."""
        episode = await self.episode_repo.get_by_id(self.episode_id)
        if episode is None:
            raise RuntimeError(f"Episode {self.episode_id} not found")

        # Eager-loaded relationship.
        series = episode.series
        if series is None:
            raise RuntimeError(
                f"Episode {self.episode_id} has no series — orchestrator "
                "needs the series for genre / mood / target_duration."
            )

        try:
            await self._check_cancelled()
            await self.episode_repo.update_status(self.episode_id, "generating")
            await self.db.commit()

            plan = await self._run_script(episode, series)
            await self._check_cancelled()
            audio_meta = await self._run_audio(episode, series, plan)
            await self._check_cancelled()

            await self._persist_script(plan, audio_meta)

            # Phase 2a stops here. Episode is in 'review' so the user
            # can inspect the song plan + audio + scene slots before
            # the Phase 2b visual generation kicks in.
            await self.episode_repo.update_status(self.episode_id, "review")
            await self.db.commit()
            await self._broadcast(
                "done",
                100,
                "Music-video Phase 2a complete: song plan + audio ready for review.",
            )
            self.log.info("music_video.run_done", title=plan.title)
        except asyncio.CancelledError:
            await self.episode_repo.update_status(self.episode_id, "failed")
            await self.db.commit()
            try:
                await self.redis.delete(f"cancel:{self.episode_id}")
            except Exception:
                pass
            raise
        except Exception as exc:  # noqa: BLE001
            self.log.error(
                "music_video.run_failed",
                error=f"{type(exc).__name__}: {str(exc)[:300]}",
                exc_info=True,
            )
            await self.episode_repo.update(
                self.episode_id,
                status="failed",
                error_message=str(exc)[:1000],
            )
            await self.db.commit()
            raise


__all__ = ["MusicVideoOrchestrator"]
