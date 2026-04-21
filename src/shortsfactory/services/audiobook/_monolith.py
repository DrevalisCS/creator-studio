"""Audiobook generation service -- text-to-audiobook with chapters, multi-voice,
background music, output formats, and audio controls.

Converts long-form text into a single WAV audiobook by splitting on sentence
boundaries, generating TTS for each chunk, and concatenating with
context-aware silence gaps.  Supports:

- **Chapters**: Text split by ``## headers`` or ``---`` separators.
- **Multi-voice**: ``[Speaker]`` tagged blocks mapped to voice profiles.
- **Per-chapter images**: AI-generated chapter illustrations via ComfyUI.
- **Per-chapter music**: Different mood-based music per chapter with crossfades.
- **Output formats**: ``audio_only`` (WAV + MP3), ``audio_image`` (MP4 with cover),
  ``audio_video`` (MP4 with dark background or chapter images).
- **Audio controls**: Per-audiobook speed and pitch overrides.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

import structlog

if TYPE_CHECKING:
    from redis.asyncio import Redis
    from sqlalchemy.ext.asyncio import AsyncSession

    from shortsfactory.models.voice_profile import VoiceProfile
    from shortsfactory.services.comfyui import ComfyUIService
    from shortsfactory.services.ffmpeg import FFmpegService
    from shortsfactory.services.storage import StorageBackend
    from shortsfactory.services.tts import TTSService

log = structlog.get_logger(__name__)

# ── Context-aware pause durations (seconds) ──────────────────────────────────
PAUSE_WITHIN_SPEAKER = 0.15  # 150 ms between chunks of the same speaker
PAUSE_BETWEEN_SPEAKERS = 0.4  # 400 ms between different speakers
PAUSE_BETWEEN_CHAPTERS = 1.2  # 1.2 s between chapters


@dataclass
class AudioChunk:
    """An audio chunk with metadata for context-aware concatenation."""

    path: Path
    chapter_index: int
    speaker: str
    block_index: int
    chunk_index: int


@dataclass
class ChapterTiming:
    """Timing information for a chapter in the concatenated audio."""

    chapter_index: int
    start_seconds: float
    end_seconds: float
    duration_seconds: float


class AudiobookService:
    """High-level service for generating audiobooks from text."""

    def __init__(
        self,
        tts_service: TTSService,
        ffmpeg_service: FFmpegService,
        storage: StorageBackend,
        db_session: AsyncSession | None = None,
        comfyui_service: ComfyUIService | None = None,
        redis: Redis | None = None,
    ) -> None:
        self.tts = tts_service
        self.ffmpeg = ffmpeg_service
        self.storage = storage
        self.db_session = db_session
        self.comfyui_service = comfyui_service
        self.redis = redis

    # ══════════════════════════════════════════════════════════════════════
    # Progress broadcasting
    # ══════════════════════════════════════════════════════════════════════

    async def _broadcast_progress(
        self,
        audiobook_id: UUID,
        step: str,
        progress_pct: int,
        message: str = "",
    ) -> None:
        """Publish a progress update via Redis pub/sub."""
        if not self.redis:
            return
        import json as _json

        channel = f"progress:audiobook:{audiobook_id}"
        payload = _json.dumps(
            {
                "audiobook_id": str(audiobook_id),
                "step": step,
                "progress_pct": progress_pct,
                "message": message,
            }
        )
        try:
            await self.redis.publish(channel, payload)
        except Exception:
            pass  # non-critical

    # ══════════════════════════════════════════════════════════════════════
    # Main generation entry point
    # ══════════════════════════════════════════════════════════════════════

    async def generate(
        self,
        audiobook_id: UUID,
        text: str,
        voice_profile: VoiceProfile,
        *,
        generate_video: bool = False,
        background_image_path: str | None = None,
        output_format: str = "audio_only",
        cover_image_path: str | None = None,
        voice_casting: dict[str, str] | None = None,
        music_enabled: bool = False,
        music_mood: str | None = None,
        music_volume_db: float = -14.0,
        speed: float = 1.0,
        pitch: float = 1.0,
        video_orientation: str = "landscape",
        caption_style_preset: str | None = None,
        image_generation_enabled: bool = False,
        per_chapter_music: bool = False,
        chapter_moods: list[str] | None = None,
    ) -> dict[str, Any]:
        """Generate an audiobook from text.

        Steps:
        1. Parse chapters from text (## headers or --- separators).
        2. Parse voice blocks ([Speaker] tags) for multi-voice.
        3. Generate TTS for each block with the appropriate voice.
        4. Concatenate chunks with context-aware silence gaps.
        5. Optionally generate per-chapter images via ComfyUI.
        6. Optionally add background music (global or per-chapter).
        7. Generate captions, convert to MP3.
        8. Create video (chapter-aware with Ken Burns or single-image fallback).
        9. Clean up intermediate files.

        Returns
        -------
        dict with keys: audio_rel_path, video_rel_path, mp3_rel_path,
                        duration_seconds, file_size_bytes, chapters
        """
        # Refresh ComfyUI pool from DB so retries always use current servers
        if self.comfyui_service and self.db_session:
            try:
                await self.comfyui_service._pool.sync_from_db(self.db_session)
            except Exception:
                log.warning("audiobook.comfyui_pool_refresh_failed", exc_info=True)

        # Handle legacy generate_video flag
        if generate_video and output_format == "audio_only":
            output_format = "audio_video"

        # Determine video resolution from orientation.
        if video_orientation == "vertical":
            video_width, video_height = 1080, 1920
        else:
            video_width, video_height = 1920, 1080

        output_dir = Path(f"audiobooks/{audiobook_id}")
        abs_dir = self.storage.resolve_path(str(output_dir))
        abs_dir.mkdir(parents=True, exist_ok=True)

        log.info(
            "audiobook.generate.start",
            audiobook_id=str(audiobook_id),
            text_length=len(text),
            provider=voice_profile.provider,
            output_format=output_format,
            music_enabled=music_enabled,
            has_voice_casting=voice_casting is not None,
            video_orientation=video_orientation,
            caption_style_preset=caption_style_preset,
            image_generation_enabled=image_generation_enabled,
            per_chapter_music=per_chapter_music,
        )

        await self._broadcast_progress(audiobook_id, "parsing", 0, "Parsing chapters...")

        # 1. Parse chapters
        chapters = self._parse_chapters(text)
        log.info(
            "audiobook.generate.chapters_parsed",
            audiobook_id=str(audiobook_id),
            chapter_count=len(chapters),
            chapter_titles=[ch["title"] for ch in chapters],
        )

        # Apply chapter_moods to chapter metadata
        if chapter_moods:
            for i, chapter in enumerate(chapters):
                if i < len(chapter_moods) and chapter_moods[i]:
                    chapter["music_mood"] = chapter_moods[i]

        # 2. Generate TTS for all chapters
        all_chunks: list[AudioChunk] = []
        total_chapters = len(chapters)
        for ch_idx, chapter in enumerate(chapters):
            chapter_text = chapter["text"]
            voice_blocks = self._parse_voice_blocks(chapter_text)

            pct = 5 + int((ch_idx / total_chapters) * 45)
            await self._broadcast_progress(
                audiobook_id,
                "tts",
                pct,
                f"Generating speech for chapter {ch_idx + 1}/{total_chapters}...",
            )

            if voice_casting and len(voice_blocks) > 1:
                log.info(
                    "audiobook.generate.multi_voice",
                    audiobook_id=str(audiobook_id),
                    chapter=ch_idx,
                    speakers=[b["speaker"] for b in voice_blocks],
                )
                chunks = await self._generate_multi_voice(
                    blocks=voice_blocks,
                    voice_casting=voice_casting,
                    default_voice_profile=voice_profile,
                    output_dir=abs_dir,
                    chapter_index=ch_idx,
                    speed=speed,
                    pitch=pitch,
                )
            else:
                plain_text = chapter_text
                if voice_blocks and len(voice_blocks) == 1:
                    plain_text = voice_blocks[0]["text"]

                chunks = await self._generate_single_voice(
                    text=plain_text,
                    voice_profile=voice_profile,
                    output_dir=abs_dir,
                    chapter_index=ch_idx,
                    speed=speed,
                    pitch=pitch,
                )

            all_chunks.extend(chunks)
            log.debug(
                "audiobook.generate.chapter_done",
                audiobook_id=str(audiobook_id),
                chapter_index=ch_idx,
                chunks=len(chunks),
            )

        # 3. Concatenate all chunks with context-aware silence gaps
        await self._broadcast_progress(audiobook_id, "mixing", 50, "Concatenating audio...")
        final_audio = abs_dir / "audiobook.wav"
        chapter_timings = await self._concatenate_with_context(all_chunks, final_audio)

        # Store timing metadata in chapters
        for timing in chapter_timings:
            if timing.chapter_index < len(chapters):
                chapters[timing.chapter_index]["start_seconds"] = round(timing.start_seconds, 3)
                chapters[timing.chapter_index]["end_seconds"] = round(timing.end_seconds, 3)
                chapters[timing.chapter_index]["duration_seconds"] = round(
                    timing.duration_seconds, 3
                )

        # 4. Get duration and file size
        duration = await self.ffmpeg.get_duration(final_audio)
        file_size = final_audio.stat().st_size

        # 5. Generate per-chapter images via ComfyUI (if enabled)
        chapter_image_paths: list[Path] = []
        if image_generation_enabled and output_format in ("audio_image", "audio_video"):
            await self._broadcast_progress(
                audiobook_id, "images", 55, "Generating chapter images..."
            )
            try:
                chapter_image_paths = await self._generate_chapter_images(
                    chapters=chapters,
                    output_dir=abs_dir,
                    audiobook_id=audiobook_id,
                    video_width=video_width,
                    video_height=video_height,
                )
                # Store image paths in chapter metadata
                for i, img_path in enumerate(chapter_image_paths):
                    if i < len(chapters):
                        chapters[i]["image_path"] = (
                            f"audiobooks/{audiobook_id}/images/ch{i:03d}.png"
                        )
                log.info(
                    "audiobook.generate.images_done",
                    audiobook_id=str(audiobook_id),
                    image_count=len(chapter_image_paths),
                )
            except Exception as exc:
                log.warning(
                    "audiobook.generate.images_failed",
                    audiobook_id=str(audiobook_id),
                    error=str(exc),
                    exc_info=True,
                )

        # 6. Optionally add background music
        if music_enabled and (music_mood or per_chapter_music):
            await self._broadcast_progress(audiobook_id, "music", 70, "Adding background music...")
            try:
                if per_chapter_music and chapter_timings:
                    # Per-chapter music with crossfades
                    music_output = abs_dir / "audiobook_with_music.wav"
                    mixed_path = await self._add_chapter_music(
                        audio_path=final_audio,
                        output_path=music_output,
                        chapter_timings=chapter_timings,
                        chapters=chapters,
                        global_mood=music_mood or "calm",
                        volume_db=music_volume_db,
                        audiobook_id=audiobook_id,
                    )
                    if mixed_path != final_audio:
                        backup = final_audio.with_suffix(".wav.bak")
                        final_audio.rename(backup)
                        try:
                            mixed_path.rename(final_audio)
                            backup.unlink(missing_ok=True)
                        except Exception:
                            backup.rename(final_audio)
                            raise
                        file_size = final_audio.stat().st_size
                        log.info(
                            "audiobook.generate.chapter_music_mixed",
                            audiobook_id=str(audiobook_id),
                        )
                elif music_mood:
                    # Global music (existing behaviour)
                    music_output = abs_dir / "audiobook_with_music.wav"
                    mixed_path = await self._add_music(
                        audio_path=final_audio,
                        output_path=music_output,
                        mood=music_mood,
                        volume_db=music_volume_db,
                        duration=duration,
                    )
                    if mixed_path != final_audio:
                        backup = final_audio.with_suffix(".wav.bak")
                        final_audio.rename(backup)
                        try:
                            mixed_path.rename(final_audio)
                            backup.unlink(missing_ok=True)
                        except Exception:
                            backup.rename(final_audio)
                            raise
                        file_size = final_audio.stat().st_size
                        log.info(
                            "audiobook.generate.music_mixed",
                            audiobook_id=str(audiobook_id),
                        )
            except Exception as exc:
                log.warning(
                    "audiobook.generate.music_failed",
                    audiobook_id=str(audiobook_id),
                    error=str(exc),
                )

        # 6b. Generate captions from audio
        await self._broadcast_progress(audiobook_id, "captions", 85, "Generating captions...")
        captions_ass_path: Path | None = None
        captions_ass_rel: str | None = None
        captions_srt_rel: str | None = None

        try:
            from shortsfactory.services.captions import CaptionService, CaptionStyle

            caption_service = CaptionService()
            caption_dir = abs_dir / "captions"
            caption_dir.mkdir(parents=True, exist_ok=True)

            effective_preset = caption_style_preset or "youtube_highlight"
            caption_style = CaptionStyle(
                preset=effective_preset,
                font_name="Impact",
                font_size=60,
                primary_color="#FFFFFF",
                highlight_color="#FFD700",
                outline_color="#000000",
                outline_width=5,
                position="bottom",
                margin_v=100,
                words_per_line=4,
                uppercase=True,
                play_res_x=video_width,
                play_res_y=video_height,
            )

            caption_result = await caption_service.generate_from_audio(
                audio_path=final_audio,
                output_dir=caption_dir,
                language="en",
                style=caption_style,
            )
            captions_ass_path = Path(caption_result.ass_path)
            Path(caption_result.srt_path)
            captions_ass_rel = f"audiobooks/{audiobook_id}/captions/captions.ass"
            captions_srt_rel = f"audiobooks/{audiobook_id}/captions/captions.srt"

            log.info(
                "audiobook.generate.captions_done",
                audiobook_id=str(audiobook_id),
                caption_count=len(caption_result.captions),
            )
        except ImportError:
            log.warning(
                "audiobook.generate.captions_skipped",
                audiobook_id=str(audiobook_id),
                reason="faster-whisper not installed",
            )
        except Exception as exc:
            log.error(
                "audiobook.generate.captions_failed",
                audiobook_id=str(audiobook_id),
                error=str(exc),
                exc_info=True,
            )

        audio_rel_path = f"audiobooks/{audiobook_id}/audiobook.wav"
        video_rel_path: str | None = None
        mp3_rel_path: str | None = None

        # 7. Convert to MP3
        try:
            await self._convert_to_mp3(final_audio)
            mp3_rel_path = f"audiobooks/{audiobook_id}/audiobook.mp3"
            log.info(
                "audiobook.generate.mp3_done",
                audiobook_id=str(audiobook_id),
            )
        except Exception as exc:
            log.warning(
                "audiobook.generate.mp3_failed",
                audiobook_id=str(audiobook_id),
                error=str(exc),
            )

        # 8. Handle output format
        await self._broadcast_progress(audiobook_id, "assembly", 90, "Assembling video...")

        if output_format in ("audio_image", "audio_video"):
            video_path = abs_dir / "audiobook.mp4"

            # Check if we have chapter images for chapter-aware assembly
            if chapter_image_paths and len(chapter_image_paths) == len(chapters):
                # Chapter-aware video with Ken Burns transitions
                await self._create_chapter_aware_video(
                    audio_path=final_audio,
                    output_path=video_path,
                    chapter_timings=chapter_timings,
                    chapter_image_paths=chapter_image_paths,
                    captions_path=captions_ass_path,
                    width=video_width,
                    height=video_height,
                    background_music_path=None,  # already mixed into audio
                    audiobook_id=audiobook_id,
                )
                video_rel_path = f"audiobooks/{audiobook_id}/audiobook.mp4"
                log.info(
                    "audiobook.generate.chapter_video_done",
                    audiobook_id=str(audiobook_id),
                )
            else:
                # Fallback: single-image video (existing behaviour)
                resolved_cover = None
                if cover_image_path:
                    try:
                        resolved_cover = str(self.storage.resolve_path(cover_image_path))
                    except Exception:
                        pass
                if not resolved_cover and background_image_path:
                    try:
                        resolved_cover = str(self.storage.resolve_path(background_image_path))
                    except Exception:
                        pass
                if not resolved_cover or not Path(resolved_cover).exists():
                    title_for_card = chapters[0]["title"] if chapters else "Audiobook"
                    resolved_cover = str(
                        await self._generate_title_card(
                            abs_dir,
                            title_for_card,
                            width=video_width,
                            height=video_height,
                        )
                    )
                await self._create_audiobook_video(
                    audio_path=final_audio,
                    output_path=video_path,
                    cover_image_path=resolved_cover,
                    duration=duration,
                    captions_path=captions_ass_path,
                    with_waveform=output_format == "audio_video",
                    width=video_width,
                    height=video_height,
                    audiobook_id=audiobook_id,
                )
                video_rel_path = f"audiobooks/{audiobook_id}/audiobook.mp4"
                log.info(
                    "audiobook.generate.video_done",
                    audiobook_id=str(audiobook_id),
                )

        # NOTE: Chunk files are NOT deleted here. The caller must clean them
        # up AFTER a successful DB commit to prevent data loss on retry.
        # Chunk paths are returned in the result dict for deferred cleanup.

        await self._broadcast_progress(audiobook_id, "done", 100, "Complete!")

        log.info(
            "audiobook.generate.done",
            audiobook_id=str(audiobook_id),
            duration_seconds=duration,
            file_size_bytes=file_size,
            has_video=video_rel_path is not None,
            has_mp3=mp3_rel_path is not None,
            chapter_count=len(chapters),
        )

        return {
            "audio_rel_path": audio_rel_path,
            "video_rel_path": video_rel_path,
            "mp3_rel_path": mp3_rel_path,
            "captions_ass_rel_path": captions_ass_rel,
            "captions_srt_rel_path": captions_srt_rel,
            "duration_seconds": duration,
            "file_size_bytes": file_size,
            "chapters": chapters,
            "_chunk_paths": [c.path for c in all_chunks],
        }

    # ══════════════════════════════════════════════════════════════════════
    # Chapter parsing
    # ══════════════════════════════════════════════════════════════════════

    def _parse_chapters(self, text: str) -> list[dict[str, Any]]:
        """Split text by ``## headers`` or ``---`` separators into chapters.

        Returns a list of ``{"title": ..., "text": ...}`` dicts.  Falls back
        to a single chapter containing the full text when no markers are found.
        """
        # Try ## headers first
        parts = re.split(r"^##\s+(.+)$", text, flags=re.MULTILINE)
        if len(parts) > 1:
            chapters: list[dict[str, Any]] = []
            if parts[0].strip():
                chapters.append({"title": "Introduction", "text": parts[0].strip()})
            for i in range(1, len(parts), 2):
                title = parts[i].strip()
                body = parts[i + 1].strip() if i + 1 < len(parts) else ""
                if body:
                    chapters.append({"title": title, "text": body})
            return chapters or [{"title": "Full Text", "text": text}]

        # Try --- separators
        sections = re.split(r"^---+$", text, flags=re.MULTILINE)
        if len(sections) > 1:
            return [
                {"title": f"Part {i + 1}", "text": s.strip()}
                for i, s in enumerate(sections)
                if s.strip()
            ]

        # No markers found -- single chapter
        return [{"title": "Full Text", "text": text}]

    # ══════════════════════════════════════════════════════════════════════
    # Voice block parsing
    # ══════════════════════════════════════════════════════════════════════

    def _parse_voice_blocks(self, text: str) -> list[dict[str, str]]:
        """Parse ``[Speaker]`` tagged text into blocks.

        Untagged text defaults to ``[Narrator]``.
        Returns a list of ``{"speaker": ..., "text": ...}`` dicts.
        """
        blocks: list[dict[str, str]] = []
        current_speaker = "Narrator"
        current_text: list[str] = []

        for line in text.split("\n"):
            line = line.strip()
            if not line:
                if current_text:
                    current_text.append("")
                continue

            if line.startswith("##"):
                continue

            match = re.match(r"^\[([^\]]+)\]\s*(.*)", line)
            if match:
                if current_text:
                    joined = "\n".join(current_text).strip()
                    if joined:
                        blocks.append({"speaker": current_speaker, "text": joined})
                    current_text = []
                current_speaker = match.group(1).strip()
                if match.group(2).strip():
                    current_text.append(match.group(2).strip())
            else:
                current_text.append(line)

        if current_text:
            joined = "\n".join(current_text).strip()
            if joined:
                blocks.append({"speaker": current_speaker, "text": joined})

        return [b for b in blocks if b["text"]]

    # ══════════════════════════════════════════════════════════════════════
    # TTS generation (returns AudioChunk list)
    # ══════════════════════════════════════════════════════════════════════

    async def _generate_silence(self, output_path: Path, duration: float = 0.5) -> None:
        """Generate a short silence WAV file as a TTS fallback."""
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=24000:cl=mono",
            "-t",
            str(duration),
            str(output_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()

    async def _generate_single_voice(
        self,
        text: str,
        voice_profile: VoiceProfile,
        output_dir: Path,
        chapter_index: int,
        speed: float,
        pitch: float,
    ) -> list[AudioChunk]:
        """Generate TTS for a single voice, splitting text into chunks."""
        provider = self.tts.get_provider(voice_profile)
        voice_id = self.tts._voice_id_for(voice_profile)

        chunks = self._split_text(text, max_chars=500)
        result: list[AudioChunk] = []

        for i, chunk in enumerate(chunks):
            stripped = chunk.strip()
            if not stripped or len(stripped) < 2:
                continue

            chunk_path = output_dir / f"ch{chapter_index:03d}_chunk_{i:04d}.wav"
            if chunk_path.exists() and chunk_path.stat().st_size > 100:
                log.debug(
                    "audiobook.generate.chunk_cached", chapter_index=chapter_index, chunk_index=i
                )
            else:
                try:
                    await provider.synthesize(
                        chunk,
                        voice_id,
                        chunk_path,
                        speed=speed,
                        pitch=pitch,
                    )
                except Exception as exc:
                    log.warning(
                        "audiobook.generate.tts_chunk_failed",
                        chapter_index=chapter_index,
                        chunk_index=i,
                        chunk_length=len(chunk),
                        error=str(exc)[:200],
                    )
                    await self._generate_silence(chunk_path)

            if chunk_path.exists():
                result.append(
                    AudioChunk(
                        path=chunk_path,
                        chapter_index=chapter_index,
                        speaker="Narrator",
                        block_index=0,
                        chunk_index=i,
                    )
                )
            log.debug(
                "audiobook.generate.chunk_done",
                chapter_index=chapter_index,
                chunk_index=i,
                chunk_length=len(chunk),
            )

        return result

    async def _generate_multi_voice(
        self,
        blocks: list[dict[str, str]],
        voice_casting: dict[str, str],
        default_voice_profile: VoiceProfile,
        output_dir: Path,
        chapter_index: int,
        speed: float,
        pitch: float,
    ) -> list[AudioChunk]:
        """Generate TTS for each speaker block with their assigned voice.

        Falls back to the default voice profile for speakers not in the
        casting map.
        """
        result: list[AudioChunk] = []

        for i, block in enumerate(blocks):
            speaker = block["speaker"]
            # Match speaker to voice casting: try exact, stripped, then partial
            voice_profile_id = voice_casting.get(speaker)
            if not voice_profile_id:
                stripped = speaker.strip()
                voice_profile_id = voice_casting.get(stripped)
            if not voice_profile_id:
                stripped_lower = speaker.strip().lower()
                for cast_name, cast_id in voice_casting.items():
                    if (
                        cast_name.lower().startswith(stripped_lower)
                        or stripped_lower.startswith(cast_name.lower())
                        or stripped_lower in cast_name.lower()
                        or cast_name.lower() in stripped_lower
                    ):
                        voice_profile_id = cast_id
                        break

            if voice_profile_id:
                voice_profile = await self._get_voice_profile(voice_profile_id)
                if voice_profile is None:
                    log.warning(
                        "audiobook.generate.voice_profile_not_found",
                        speaker=speaker,
                        voice_profile_id=voice_profile_id,
                        detail="Falling back to default voice profile",
                    )
                    voice_profile = default_voice_profile
            else:
                voice_profile = default_voice_profile

            provider = self.tts.get_provider(voice_profile)
            voice_id = self.tts._voice_id_for(voice_profile)

            text_chunks = self._split_text(block["text"], max_chars=500)
            for j, chunk in enumerate(text_chunks):
                stripped = chunk.strip()
                if not stripped or len(stripped) < 2:
                    continue

                chunk_path = output_dir / f"ch{chapter_index:03d}_block_{i:04d}_chunk_{j:04d}.wav"
                if chunk_path.exists() and chunk_path.stat().st_size > 100:
                    log.debug(
                        "audiobook.generate.chunk_cached",
                        chapter_index=chapter_index,
                        block_index=i,
                        chunk_index=j,
                    )
                else:
                    try:
                        await provider.synthesize(
                            chunk,
                            voice_id,
                            chunk_path,
                            speed=speed,
                            pitch=pitch,
                        )
                    except Exception as exc:
                        log.warning(
                            "audiobook.generate.tts_chunk_failed",
                            chapter_index=chapter_index,
                            block_index=i,
                            speaker=speaker,
                            chunk_index=j,
                            chunk_length=len(chunk),
                            error=str(exc)[:200],
                        )
                        await self._generate_silence(chunk_path)

                if chunk_path.exists():
                    result.append(
                        AudioChunk(
                            path=chunk_path,
                            chapter_index=chapter_index,
                            speaker=speaker,
                            block_index=i,
                            chunk_index=j,
                        )
                    )
                log.debug(
                    "audiobook.generate.multi_voice_chunk_done",
                    chapter_index=chapter_index,
                    block_index=i,
                    speaker=speaker,
                    chunk_index=j,
                    chunk_length=len(chunk),
                )

        return result

    async def _get_voice_profile(self, voice_profile_id: str) -> VoiceProfile | None:
        """Load a voice profile by ID from the database."""
        if self.db_session is None:
            log.warning(
                "audiobook.get_voice_profile.no_session",
                voice_profile_id=voice_profile_id,
            )
            return None

        try:
            import uuid as _uuid

            from shortsfactory.repositories.voice_profile import VoiceProfileRepository

            vp_repo = VoiceProfileRepository(self.db_session)
            parsed_id = _uuid.UUID(voice_profile_id)
            return await vp_repo.get_by_id(parsed_id)
        except Exception as exc:
            log.warning(
                "audiobook.get_voice_profile.failed",
                voice_profile_id=voice_profile_id,
                error=str(exc),
            )
            return None

    # ══════════════════════════════════════════════════════════════════════
    # Text splitting
    # ══════════════════════════════════════════════════════════════════════

    def _split_text(self, text: str, max_chars: int = 500) -> list[str]:
        """Split text into chunks at sentence boundaries."""
        sentences = re.split(r"(?<=[.!?])\s+", text.strip())

        chunks: list[str] = []
        current = ""
        for sentence in sentences:
            if len(current) + len(sentence) > max_chars and current:
                chunks.append(current.strip())
                current = sentence
            else:
                current = f"{current} {sentence}" if current else sentence
        if current.strip():
            chunks.append(current.strip())

        return chunks or [text]

    # ══════════════════════════════════════════════════════════════════════
    # Context-aware audio concatenation
    # ══════════════════════════════════════════════════════════════════════

    async def _concatenate_with_context(
        self, chunks: list[AudioChunk], output: Path
    ) -> list[ChapterTiming]:
        """Concatenate WAV files with context-aware silence gaps.

        Pause durations vary based on context:
        - Between chapters: 1.2 s
        - Between speakers: 400 ms
        - Within same speaker: 150 ms

        Returns chapter timing metadata.
        """
        if not chunks:
            raise RuntimeError("No audio chunks to concatenate")

        concat_list = output.parent / "_concat_list.txt"

        # Pre-generate silence files for each duration
        silence_files: dict[float, Path] = {}
        for dur in (PAUSE_WITHIN_SPEAKER, PAUSE_BETWEEN_SPEAKERS, PAUSE_BETWEEN_CHAPTERS):
            sil_path = output.parent / f"_silence_{int(dur * 1000)}ms.wav"
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=24000:cl=mono",
                "-t",
                str(dur),
                str(sil_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                stderr_text = stderr.decode("utf-8", errors="replace")
                raise RuntimeError(f"Failed to generate silence: {stderr_text[:300]}")
            silence_files[dur] = sil_path

        # Build concat list with context-aware silence
        lines: list[str] = []
        # Track which silence to insert between chunks
        for i, chunk in enumerate(chunks):
            safe_path = str(chunk.path).replace("\\", "/")
            lines.append(f"file '{safe_path}'")

            if i < len(chunks) - 1:
                next_chunk = chunks[i + 1]
                if chunk.chapter_index != next_chunk.chapter_index:
                    pause = PAUSE_BETWEEN_CHAPTERS
                elif chunk.speaker != next_chunk.speaker:
                    pause = PAUSE_BETWEEN_SPEAKERS
                else:
                    pause = PAUSE_WITHIN_SPEAKER

                sil_safe = str(silence_files[pause]).replace("\\", "/")
                lines.append(f"file '{sil_safe}'")

        concat_list.write_text("\n".join(lines), encoding="utf-8")

        # Concatenate
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-c",
            "copy",
            str(output),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            stderr_text = stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"Failed to concatenate chunks: {stderr_text[:300]}")

        # Compute chapter timings by summing chunk durations
        chapter_timings = await self._compute_chapter_timings(chunks)

        # Cleanup temp files
        concat_list.unlink(missing_ok=True)
        for sil in silence_files.values():
            sil.unlink(missing_ok=True)

        return chapter_timings

    async def _compute_chapter_timings(self, chunks: list[AudioChunk]) -> list[ChapterTiming]:
        """Compute chapter start/end times from chunk audio durations."""
        # Get duration of each chunk
        chunk_durations: list[float] = []
        for chunk in chunks:
            dur = await self.ffmpeg.get_duration(chunk.path)
            chunk_durations.append(dur)

        timings: list[ChapterTiming] = []
        current_time = 0.0
        current_chapter = chunks[0].chapter_index if chunks else 0
        chapter_start = 0.0

        for i, (chunk, dur) in enumerate(zip(chunks, chunk_durations, strict=False)):
            if chunk.chapter_index != current_chapter:
                # Close previous chapter
                timings.append(
                    ChapterTiming(
                        chapter_index=current_chapter,
                        start_seconds=chapter_start,
                        end_seconds=current_time,
                        duration_seconds=current_time - chapter_start,
                    )
                )
                chapter_start = current_time + PAUSE_BETWEEN_CHAPTERS
                current_chapter = chunk.chapter_index

            current_time += dur

            # Add pause duration
            if i < len(chunks) - 1:
                next_chunk = chunks[i + 1]
                if chunk.chapter_index != next_chunk.chapter_index:
                    current_time += PAUSE_BETWEEN_CHAPTERS
                elif chunk.speaker != next_chunk.speaker:
                    current_time += PAUSE_BETWEEN_SPEAKERS
                else:
                    current_time += PAUSE_WITHIN_SPEAKER

        # Close final chapter
        timings.append(
            ChapterTiming(
                chapter_index=current_chapter,
                start_seconds=chapter_start,
                end_seconds=current_time,
                duration_seconds=current_time - chapter_start,
            )
        )

        return timings

    # ══════════════════════════════════════════════════════════════════════
    # Per-chapter image generation
    # ══════════════════════════════════════════════════════════════════════

    async def _generate_chapter_images(
        self,
        chapters: list[dict[str, Any]],
        output_dir: Path,
        audiobook_id: UUID,
        video_width: int,
        video_height: int,
    ) -> list[Path]:
        """Generate an image for each chapter via ComfyUI.

        Uses the qwen_image_2512 workflow. Chapters that already have an
        ``image_path`` are skipped. Generation is parallelised with a
        concurrency semaphore of 3.
        """
        if not self.comfyui_service:
            log.warning("audiobook.images.no_comfyui_service")
            return []

        images_dir = output_dir / "images"
        images_dir.mkdir(parents=True, exist_ok=True)

        sem = asyncio.Semaphore(3)

        async def _gen_one(ch_idx: int, chapter: dict[str, Any]) -> Path | None:
            async with sem:
                img_path = images_dir / f"ch{ch_idx:03d}.png"

                # Skip if already exists (user-uploaded or previous run)
                if img_path.exists():
                    return img_path

                # Build visual prompt from chapter content
                visual_prompt = chapter.get("visual_prompt")
                if not visual_prompt:
                    title = chapter.get("title", "Scene")
                    text_preview = chapter.get("text", "")[:200].replace("\n", " ")
                    mood = chapter.get("music_mood", "cinematic")
                    visual_prompt = (
                        f"Cinematic illustration, {title}, {mood} atmosphere, "
                        f"{text_preview}, masterpiece, ultra detailed, "
                        f"professional digital art"
                    )

                try:
                    # Use ComfyUI pool to generate image
                    workflow = await self.comfyui_service._load_workflow(
                        "workflows/qwen_image_2512.json"
                    )

                    # Inject prompt into the workflow
                    if "238:227" in workflow:
                        workflow["238:227"]["inputs"]["text"] = visual_prompt
                    if "238:232" in workflow:
                        workflow["238:232"]["inputs"]["width"] = video_width
                        workflow["238:232"]["inputs"]["height"] = video_height

                    async with self.comfyui_service._pool.acquire() as (_, client):
                        prompt_id = await client.queue_prompt(workflow)
                        history = await self.comfyui_service._poll_until_complete(client, prompt_id)

                        output_images = self.comfyui_service._extract_output_images(
                            history, "60", "images"
                        )
                        if output_images:
                            img_data = await client.download_image(
                                output_images[0]["filename"],
                                output_images[0].get("subfolder", ""),
                                output_images[0].get("type", "output"),
                            )
                            img_path.write_bytes(img_data)
                            log.info(
                                "audiobook.images.chapter_done",
                                chapter_index=ch_idx,
                                path=str(img_path),
                            )
                            return img_path

                except Exception as exc:
                    log.warning(
                        "audiobook.images.chapter_failed",
                        chapter_index=ch_idx,
                        error=str(exc),
                    )

                # Fallback: generate a title card
                return await self._generate_title_card(
                    images_dir,
                    chapter.get("title", f"Chapter {ch_idx + 1}"),
                    width=video_width,
                    height=video_height,
                )

        tasks = [_gen_one(i, ch) for i, ch in enumerate(chapters)]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        image_paths: list[Path] = []
        for i, result in enumerate(results):
            if isinstance(result, Path) and result.exists():
                image_paths.append(result)
            elif isinstance(result, Exception):
                log.warning(
                    "audiobook.images.chapter_exception",
                    chapter_index=i,
                    error=str(result),
                )
                # Generate title card as fallback
                fallback = await self._generate_title_card(
                    images_dir,
                    chapters[i].get("title", f"Chapter {i + 1}"),
                    width=video_width,
                    height=video_height,
                )
                image_paths.append(fallback)
            else:
                fallback = await self._generate_title_card(
                    images_dir,
                    chapters[i].get("title", f"Chapter {i + 1}"),
                    width=video_width,
                    height=video_height,
                )
                image_paths.append(fallback)

        return image_paths

    # ══════════════════════════════════════════════════════════════════════
    # Background music
    # ══════════════════════════════════════════════════════════════════════

    async def _add_music(
        self,
        audio_path: Path,
        output_path: Path,
        mood: str,
        volume_db: float,
        duration: float,
    ) -> Path:
        """Mix a single background music track under the voiceover.

        Uses sidechain compression so the music ducks under speech.
        Returns the path to the mixed file, or *audio_path* unchanged
        if no music is available.
        """
        from shortsfactory.services.music import MusicService

        storage_base = getattr(self.storage, "base_path", None)
        if storage_base is None:
            log.warning("audiobook.music.no_storage_base")
            return audio_path

        music_svc = MusicService(
            storage_base_path=storage_base,
            ffmpeg_path="ffmpeg",
        )

        music_path = await music_svc.get_music_for_episode(
            mood=mood,
            target_duration=duration,
            episode_id=uuid4(),
        )
        if not music_path:
            log.info("audiobook.music.no_music_available", mood=mood)
            return audio_path

        log.info(
            "audiobook.music.mixing",
            music_path=str(music_path),
            volume_db=volume_db,
        )

        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(audio_path),
            "-i",
            str(music_path),
            "-filter_complex",
            (
                f"[1:a]volume={volume_db}dB[bgm];"
                "[bgm][0:a]sidechaincompress=threshold=0.02:ratio=6:attack=200:release=1000[ducked];"
                "[0:a][ducked]amix=inputs=2:duration=first:dropout_transition=2[out]"
            ),
            "-map",
            "[out]",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            stderr_text = stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"Failed to mix background music: {stderr_text[:300]}")

        log.info("audiobook.music.mix_done", output=str(output_path))
        return output_path

    async def _add_chapter_music(
        self,
        audio_path: Path,
        output_path: Path,
        chapter_timings: list[ChapterTiming],
        chapters: list[dict[str, Any]],
        global_mood: str,
        volume_db: float,
        audiobook_id: UUID,
        crossfade_duration: float = 2.0,
    ) -> Path:
        """Generate per-chapter music with crossfades, then mix under voiceover.

        For each chapter, generates music using the chapter's mood (or global
        fallback), trims to chapter duration, crossfades between chapters,
        and mixes the resulting continuous music track under the voiceover.
        """
        from shortsfactory.services.music import MusicService

        storage_base = getattr(self.storage, "base_path", None)
        if storage_base is None:
            log.warning("audiobook.chapter_music.no_storage_base")
            return audio_path

        music_svc = MusicService(
            storage_base_path=storage_base,
            ffmpeg_path="ffmpeg",
        )

        music_dir = audio_path.parent / "music"
        music_dir.mkdir(parents=True, exist_ok=True)

        # Generate music for each chapter
        chapter_music_paths: list[Path | None] = []
        for i, timing in enumerate(chapter_timings):
            mood = global_mood
            if i < len(chapters):
                mood = chapters[i].get("music_mood") or global_mood

            target_dur = timing.duration_seconds + crossfade_duration
            music_path = await music_svc.get_music_for_episode(
                mood=mood,
                target_duration=target_dur,
                episode_id=uuid4(),
            )
            if music_path:
                # Trim to exact chapter duration + crossfade
                trimmed = music_dir / f"ch{i:03d}_music.wav"
                trim_cmd = [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(music_path),
                    "-t",
                    str(target_dur),
                    "-af",
                    f"afade=t=out:st={max(0, target_dur - crossfade_duration):.2f}:d={crossfade_duration:.2f}",
                    "-c:a",
                    "pcm_s16le",
                    str(trimmed),
                ]
                proc = await asyncio.create_subprocess_exec(
                    *trim_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await proc.communicate()
                chapter_music_paths.append(trimmed if trimmed.exists() else None)

                # Store music path in chapter metadata
                if i < len(chapters):
                    chapters[i]["music_path"] = (
                        f"audiobooks/{audiobook_id}/music/ch{i:03d}_music.wav"
                    )
            else:
                chapter_music_paths.append(None)

            log.debug(
                "audiobook.chapter_music.generated",
                chapter_index=i,
                mood=mood,
                duration=target_dur,
                available=music_path is not None,
            )

        # Filter to chapters that have music
        valid_music = [(i, p) for i, p in enumerate(chapter_music_paths) if p]
        if not valid_music:
            log.info("audiobook.chapter_music.no_music_available")
            return audio_path

        # Concatenate chapter music tracks into one continuous track
        if len(valid_music) == 1:
            combined_music = valid_music[0][1]
        else:
            # Use concat to join all music (crossfade already applied via afade)
            concat_list = music_dir / "_music_concat.txt"
            lines = []
            for _, mp in valid_music:
                safe = str(mp).replace("\\", "/")
                lines.append(f"file '{safe}'")
            concat_list.write_text("\n".join(lines), encoding="utf-8")

            combined_music = music_dir / "combined_music.wav"
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_list),
                "-c:a",
                "pcm_s16le",
                str(combined_music),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await proc.communicate()
            concat_list.unlink(missing_ok=True)

            if not combined_music.exists():
                log.warning("audiobook.chapter_music.concat_failed")
                return audio_path

        # Mix combined music under voiceover with sidechain compression
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(audio_path),
            "-i",
            str(combined_music),
            "-filter_complex",
            (
                f"[1:a]volume={volume_db}dB[bgm];"
                "[bgm][0:a]sidechaincompress=threshold=0.02:ratio=6:attack=200:release=1000[ducked];"
                "[0:a][ducked]amix=inputs=2:duration=first:dropout_transition=2[out]"
            ),
            "-map",
            "[out]",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            stderr_text = stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"Failed to mix chapter music: {stderr_text[:300]}")

        log.info("audiobook.chapter_music.mix_done", output=str(output_path))
        return output_path

    # ══════════════════════════════════════════════════════════════════════
    # MP3 conversion
    # ══════════════════════════════════════════════════════════════════════

    async def _convert_to_mp3(self, wav_path: Path) -> Path:
        """Convert a WAV file to MP3 at 192 kbps."""
        mp3_path = wav_path.with_suffix(".mp3")
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(wav_path),
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "192k",
            str(mp3_path),
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            stderr_text = stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"Failed to convert to MP3: {stderr_text[:300]}")

        log.debug("audiobook.mp3_conversion_done", path=str(mp3_path))
        return mp3_path

    # ══════════════════════════════════════════════════════════════════════
    # Video creation
    # ══════════════════════════════════════════════════════════════════════

    async def _generate_title_card(
        self,
        output_dir: Path,
        title: str,
        width: int = 1920,
        height: int = 1080,
    ) -> Path:
        """Generate a simple title card image using FFmpeg."""
        card_path = output_dir / "title_card.jpg"
        safe_title = title.replace("'", "").replace('"', "")[:50]
        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=0x0f0f1a:s={width}x{height}:d=1",
            "-vf",
            f"drawtext=text='{safe_title}':fontsize=64:fontcolor=white"
            f":x=(w-text_w)/2:y=(h-text_h)/2:borderw=3:bordercolor=black",
            "-frames:v",
            "1",
            str(card_path),
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        return card_path

    async def _create_chapter_aware_video(
        self,
        audio_path: Path,
        output_path: Path,
        chapter_timings: list[ChapterTiming],
        chapter_image_paths: list[Path],
        captions_path: Path | None = None,
        width: int = 1920,
        height: int = 1080,
        background_music_path: Path | None = None,
        audiobook_id: UUID | None = None,
    ) -> None:
        """Create a video with Ken Burns transitions between chapter images.

        Reuses ``FFmpegService.assemble_video()`` which already handles
        zoompan, xfade, audio mastering, and subtitle burn-in.
        """
        from shortsfactory.services.ffmpeg import (
            AssemblyConfig,
            AudioMixConfig,
            SceneInput,
        )

        scenes = [
            SceneInput(
                image_path=img_path,
                duration_seconds=timing.duration_seconds,
            )
            for img_path, timing in zip(chapter_image_paths, chapter_timings, strict=False)
        ]

        config = AssemblyConfig(
            width=width,
            height=height,
            fps=25,
            ken_burns_enabled=True,
            transition_duration=1.0,
        )

        audio_config = AudioMixConfig(
            voice_normalize=False,  # already mixed
            voice_compressor=False,
            voice_eq=False,
        )

        async def _on_encode_progress(pct: float) -> None:
            if audiobook_id:
                encode_pct = 90 + int(pct * 0.09)  # map 0-100% to 90-99%
                await self._broadcast_progress(
                    audiobook_id,
                    "assembly",
                    encode_pct,
                    f"Encoding video... {int(pct)}%",
                )

        await self.ffmpeg.assemble_video(
            scenes=scenes,
            voiceover_path=audio_path,
            output_path=output_path,
            captions_path=captions_path,
            background_music_path=background_music_path,
            audio_config=audio_config,
            config=config,
            on_progress=_on_encode_progress,
        )

        log.info(
            "audiobook.chapter_video.done",
            output=str(output_path),
            chapters=len(scenes),
        )

    async def _create_audiobook_video(
        self,
        audio_path: Path,
        output_path: Path,
        cover_image_path: str | None,
        duration: float,
        captions_path: Path | None = None,
        with_waveform: bool = True,
        width: int = 1920,
        audiobook_id: UUID | None = None,
        height: int = 1080,
    ) -> None:
        """Create a single-image audiobook video (fallback when no chapter images).

        Features:
        - Cover image with slow Ken Burns zoom (or a dark background if no image).
        - Optional waveform overlay at the bottom of the frame.
        - Optional burned-in captions from an ASS subtitle file.
        """
        PIPE = asyncio.subprocess.PIPE
        filter_parts: list[str] = []

        has_cover = bool(cover_image_path and Path(cover_image_path).exists())
        audio_input_idx = 1 if has_cover else 0

        if has_cover:
            frames = max(1, int(duration * 25))
            filter_parts.append(
                f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                f"crop={width}:{height},"
                f"zoompan=z='1.0+0.0003*on':d={frames}:s={width}x{height}:fps=25,"
                "format=yuv420p[bg]"
            )
        else:
            filter_parts.append(
                f"color=c=0x0f0f1a:s={width}x{height}:d={duration}:r=25,format=yuv420p[bg]"
            )

        if with_waveform:
            waveform_h = max(80, round(height * 0.14 / 2) * 2)
            waveform_margin = round(waveform_h * 0.2)
            filter_parts.append(
                f"[{audio_input_idx}:a]showwaves=s={width}x{waveform_h}:mode=cline"
                f":colors=white@0.3:rate=25[waves]"
            )
            filter_parts.append(f"[bg][waves]overlay=0:H-{waveform_h + waveform_margin}[v]")
            video_label = "v"
        else:
            video_label = "bg"

        if captions_path and captions_path.exists():
            escaped = str(captions_path).replace("\\", "/").replace(":", "\\:")
            filter_parts.append(f"[{video_label}]subtitles='{escaped}'[vout]")
            output_label = "vout"
        else:
            output_label = video_label

        input_args: list[str] = ["-y"]
        if has_cover:
            input_args.extend(["-loop", "1", "-i", str(cover_image_path)])
        input_args.extend(["-i", str(audio_path)])

        cmd = [
            "ffmpeg",
            *input_args,
            "-filter_complex",
            ";".join(filter_parts),
            "-map",
            f"[{output_label}]",
            "-map",
            f"{audio_input_idx}:a",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-b:v",
            "2M",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-t",
            str(duration),
            "-movflags",
            "+faststart",
            str(output_path),
        ]

        proc = await asyncio.create_subprocess_exec(*cmd, stdout=PIPE, stderr=PIPE)

        # Stream stderr for progress tracking
        stderr_lines: list[str] = []
        last_pct = -1
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").strip()
            stderr_lines.append(text)
            if audiobook_id and duration > 10:
                import re as _re

                m = _re.search(r"time=(\d+):(\d+):(\d+\.\d+)", text)
                if m:
                    t = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
                    pct = min(99, int(t / duration * 100))
                    if pct > last_pct + 2:
                        last_pct = pct
                        await self._broadcast_progress(
                            audiobook_id,
                            "assembly",
                            90 + int(pct * 0.09),
                            f"Encoding video... {pct}%",
                        )

        await proc.wait()
        if proc.returncode != 0:
            stderr_text = "\n".join(stderr_lines)
            raise RuntimeError(f"Failed to create audiobook video: {stderr_text[-300:]}")
