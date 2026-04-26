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

    from drevalis.models.voice_profile import VoiceProfile
    from drevalis.services.comfyui import ComfyUIService
    from drevalis.services.ffmpeg import FFmpegService
    from drevalis.services.storage import StorageBackend
    from drevalis.services.tts import TTSService

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
    # SFX overlay metadata — populated only when this chunk is an
    # SFX clip with an ``under=...`` modifier. The concatenator
    # treats overlay SFX as a sidechain layer on subsequent voice
    # chunks instead of an inline chunk in the timeline.
    overlay_voice_blocks: int | None = None
    overlay_seconds: float | None = None
    overlay_duck_db: float = -12.0


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
    # Cancellation
    # ══════════════════════════════════════════════════════════════════════
    #
    # Mirrors the episode pipeline's pattern: the API endpoint sets
    # ``cancel:audiobook:{id}`` in Redis with a short TTL; long-running
    # steps inside ``generate()`` poll this between chapters and raise
    # ``asyncio.CancelledError`` on a hit. The flag is cleared once
    # the audiobook reaches a terminal status so a subsequent
    # generation of the same audiobook doesn't see the stale signal.

    async def _check_cancelled(self, audiobook_id: UUID) -> None:
        """Raise ``CancelledError`` if a cancel flag is set for this audiobook."""
        if not self.redis:
            return
        try:
            flag = await self.redis.get(f"cancel:audiobook:{audiobook_id}")
        except Exception:
            return
        if flag:
            log.info("audiobook.generate.cancelled_by_user", audiobook_id=str(audiobook_id))
            raise asyncio.CancelledError(f"Audiobook {audiobook_id} cancelled by user")

    async def _clear_cancel_flag(self, audiobook_id: UUID) -> None:
        if not self.redis:
            return
        try:
            await self.redis.delete(f"cancel:audiobook:{audiobook_id}")
        except Exception:
            pass

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
    # Per-chapter fast path — invalidate only the chunk cache for one
    # chapter so the next ``generate`` call re-TTSes just that chapter
    # while reusing every other chapter's cached WAVs.
    # ══════════════════════════════════════════════════════════════════════

    async def invalidate_chapter_chunks(
        self,
        audiobook_id: UUID,
        chapter_index: int,
    ) -> int:
        """Delete the on-disk chunk cache for ``chapter_index``.

        Returns the number of WAVs deleted. A subsequent call to
        :meth:`generate` will re-synthesise only those chunks (the
        existing per-chunk ``if chunk_path.exists()`` cache skips every
        unaffected chapter) and re-concatenate the whole audiobook.
        """
        from pathlib import Path

        # StorageBackend is a Protocol that doesn't declare ``base_path``
        # (it's on the LocalStorage concrete impl). Resolve via
        # ``resolve_path`` which every implementation provides and which
        # returns an absolute Path under the storage root.
        rel_dir = f"audiobooks/{audiobook_id}"
        output_dir = Path(self.storage.resolve_path(rel_dir))
        if not output_dir.exists():
            return 0

        deleted = 0
        prefix = f"ch{int(chapter_index):03d}_chunk_"
        for child in output_dir.iterdir():
            if child.name.startswith(prefix) and child.suffix == ".wav":
                try:
                    child.unlink()
                    deleted += 1
                except OSError:
                    pass
        log.info(
            "audiobook.chapter_chunks_invalidated",
            audiobook_id=str(audiobook_id),
            chapter_index=chapter_index,
            deleted=deleted,
        )
        return deleted

    # ══════════════════════════════════════════════════════════════════════
    # Clip listing — used by the Audiobook Editor (v0.25.0)
    # ══════════════════════════════════════════════════════════════════════
    #
    # Walks the audiobook's storage dir and emits a structured list
    # of every cached audio clip the editor can address. Filenames
    # are deterministic (see ``_generate_single_voice``,
    # ``_generate_multi_voice``, ``_generate_sfx_chunk``,
    # ``_add_chapter_music``) so we can derive stable, URL-safe
    # clip IDs without persisting a separate registry.

    _CLIP_PATTERNS: tuple[tuple[str, str], ...] = (
        # single-voice voice chunks: ch003_chunk_0007.wav
        ("voice_single", r"^ch(?P<ch>\d{3})_chunk_(?P<i>\d{4})\.wav$"),
        # multi-voice voice chunks: ch003_block_0002_chunk_0007.wav
        (
            "voice_multi",
            r"^ch(?P<ch>\d{3})_block_(?P<b>\d{4})_chunk_(?P<j>\d{4})\.wav$",
        ),
        # SFX: ch003_sfx_0002.wav
        ("sfx", r"^ch(?P<ch>\d{3})_sfx_(?P<b>\d{4})\.wav$"),
    )

    async def list_clips(self, audiobook_id: UUID) -> dict[str, Any]:
        """Return all addressable clips for the audiobook + persisted overrides.

        Output shape::

            {
              "tracks": {
                "voice": [Clip, ...],
                "sfx":   [Clip, ...],
                "music": [Clip, ...]
              },
              "overrides": { "<clip_id>": {gain_db, mute}, ... }
            }

        Each ``Clip`` carries ``id`` (URL-safe), ``kind``, ``chapter``,
        ``filename``, ``duration_seconds``, ``url`` (under /storage),
        and ``label`` (display string).
        """
        from re import compile as _re_compile

        rel_dir = f"audiobooks/{audiobook_id}"
        abs_dir = Path(self.storage.resolve_path(rel_dir))
        result: dict[str, Any] = {
            "tracks": {"voice": [], "sfx": [], "music": []},
            "overrides": {},
        }
        if not abs_dir.exists():
            return result

        compiled = [(kind, _re_compile(pat)) for kind, pat in self._CLIP_PATTERNS]

        async def _emit(track: str, path: Path, kind: str, label: str, chapter: int) -> None:
            try:
                duration = await self.ffmpeg.get_duration(path)
            except Exception:
                duration = 0.0
            clip_id = path.stem  # already URL-safe alnum + underscore
            result["tracks"][track].append(
                {
                    "id": clip_id,
                    "kind": kind,
                    "chapter": chapter,
                    "filename": path.name,
                    "duration_seconds": round(duration, 3),
                    "url": f"/storage/{rel_dir}/{path.name}",
                    "label": label,
                }
            )

        # Voice + SFX clips live directly under the audiobook dir.
        for child in sorted(abs_dir.iterdir()):
            if not child.is_file() or child.suffix != ".wav":
                continue
            for kind, regex in compiled:
                m = regex.match(child.name)
                if not m:
                    continue
                ch = int(m.group("ch"))
                if kind == "voice_single":
                    label = f"Ch {ch + 1} · chunk {int(m.group('i')) + 1}"
                    await _emit("voice", child, kind, label, ch)
                elif kind == "voice_multi":
                    label = (
                        f"Ch {ch + 1} · block {int(m.group('b')) + 1}"
                        f" · chunk {int(m.group('j')) + 1}"
                    )
                    await _emit("voice", child, kind, label, ch)
                elif kind == "sfx":
                    label = f"Ch {ch + 1} · SFX {int(m.group('b')) + 1}"
                    await _emit("sfx", child, kind, label, ch)
                break

        # Per-chapter music tracks are written to ``music/``.
        music_dir = abs_dir / "music"
        if music_dir.exists():
            music_re = _re_compile(r"^ch(?P<ch>\d{3})_music\.wav$")
            for child in sorted(music_dir.iterdir()):
                m = music_re.match(child.name)
                if not m:
                    continue
                ch = int(m.group("ch"))
                # Use a path-aware id so it doesn't collide with voice clip stems.
                try:
                    duration = await self.ffmpeg.get_duration(child)
                except Exception:
                    duration = 0.0
                result["tracks"]["music"].append(
                    {
                        "id": f"music_{child.stem}",
                        "kind": "music",
                        "chapter": ch,
                        "filename": child.name,
                        "duration_seconds": round(duration, 3),
                        "url": f"/storage/{rel_dir}/music/{child.name}",
                        "label": f"Ch {ch + 1} · music",
                    }
                )

        # Sort each track by chapter then filename for stable display.
        for tk in result["tracks"].values():
            tk.sort(key=lambda c: (c["chapter"], c["filename"]))

        return result

    # ══════════════════════════════════════════════════════════════════════
    # TTS chunk synthesis with retry + loudnorm
    # ══════════════════════════════════════════════════════════════════════

    async def _synthesize_chunk_with_retry(
        self,
        provider: Any,
        text: str,
        voice_id: str,
        chunk_path: Path,
        *,
        speed: float,
        pitch: float,
        max_attempts: int = 3,
    ) -> bool:
        """Run ``provider.synthesize`` with bounded retry + post-loudnorm.

        Per-chunk retry isolates a single transient failure (cloud
        TTS 5xx, ComfyUI queue eviction, brief network blip) from
        torpedoing the whole chapter, which previously meant losing
        199 successful chunks because chunk 200 hit a one-off blip.

        After a successful synth, we run ffmpeg ``loudnorm`` to
        EBU R128 ``I=-16 LUFS / TP=-1.5`` on the chunk in place.
        Multi-voice audiobooks otherwise have a noticeable
        chunk-to-chunk loudness wobble: each provider hands back
        audio at its own default level (Edge ≈ -22 LUFS, ElevenLabs
        ≈ -16, Piper varies by voice). Normalising per-chunk
        flattens that into a uniform broadcast level before concat.

        Returns True if a real audio file landed on disk; False if we
        exhausted retries (caller is expected to fall back to
        ``_generate_silence`` so the timing structure stays intact).
        """
        last_exc: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            try:
                await provider.synthesize(
                    text,
                    voice_id,
                    chunk_path,
                    speed=speed,
                    pitch=pitch,
                )
                if chunk_path.exists() and chunk_path.stat().st_size > 100:
                    await self._normalise_chunk_loudness(chunk_path)
                    if attempt > 1:
                        log.info(
                            "audiobook.tts.chunk_recovered",
                            attempt=attempt,
                            chunk_path=str(chunk_path),
                        )
                    return True
                # Provider returned without raising but produced no
                # usable file — treat as a soft failure.
                last_exc = RuntimeError("Provider returned but no audio file was written")
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
            if attempt < max_attempts:
                # Exponential backoff capped at 5s. Small first wait
                # so a single jitter doesn't add a second per chunk.
                delay = min(0.5 * (2 ** (attempt - 1)), 5.0)
                log.warning(
                    "audiobook.tts.chunk_retry",
                    attempt=attempt,
                    next_delay=delay,
                    error=f"{type(last_exc).__name__}: {str(last_exc)[:160]}",
                )
                await asyncio.sleep(delay)

        log.error(
            "audiobook.tts.chunk_exhausted",
            max_attempts=max_attempts,
            chunk_path=str(chunk_path),
            error=f"{type(last_exc).__name__}: {str(last_exc)[:200]}" if last_exc else "unknown",
        )
        return False

    async def _normalise_chunk_loudness(self, chunk_path: Path) -> None:
        """Run ffmpeg loudnorm on the chunk, in place.

        Failure here is non-fatal — the un-normalised chunk is
        better than no chunk. We log + move on.
        """
        tmp = chunk_path.with_suffix(".norm.wav")
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(chunk_path),
            "-af",
            "loudnorm=I=-16:TP=-1.5:LRA=11",
            "-ar",
            "24000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(tmp),
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode == 0 and tmp.exists() and tmp.stat().st_size > 100:
            try:
                tmp.replace(chunk_path)
            except OSError as exc:
                log.warning(
                    "audiobook.tts.loudnorm_replace_failed",
                    error=str(exc)[:120],
                )
                tmp.unlink(missing_ok=True)
        else:
            log.warning(
                "audiobook.tts.loudnorm_failed",
                rc=proc.returncode,
                stderr=err.decode("utf-8", errors="replace")[:200],
            )
            tmp.unlink(missing_ok=True)

    # ══════════════════════════════════════════════════════════════════════
    # Sound effects ([SFX: ...] tag handling)
    # ══════════════════════════════════════════════════════════════════════

    def _resolve_sfx_provider(self) -> Any | None:
        """Build a ComfyUIElevenLabsSoundEffectsProvider on the
        first registered ComfyUI server, or ``None`` if no server
        is available. SFX blocks gracefully degrade to silence in
        that case so the audiobook still completes.
        """
        if self.comfyui_service is None:
            return None
        try:
            servers = getattr(self.comfyui_service._pool, "_servers", {})
            if not servers:
                return None
            first_id = next(iter(servers))
            client = servers[first_id][0]
            base_url = getattr(client, "base_url", None)
            api_key = getattr(client, "api_key", None)
            if not base_url:
                return None
        except Exception as exc:
            log.warning("audiobook.sfx.provider_resolve_failed", error=str(exc)[:120])
            return None

        from drevalis.services.tts import ComfyUIElevenLabsSoundEffectsProvider

        return ComfyUIElevenLabsSoundEffectsProvider(
            comfyui_base_url=base_url,
            comfyui_api_key=api_key,
        )

    async def _generate_sfx_chunk(
        self,
        block: dict[str, Any],
        output_dir: Path,
        chapter_index: int,
        block_index: int,
    ) -> AudioChunk | None:
        """Generate a single SFX chunk for a parsed [SFX:] block.

        Returns the AudioChunk on success, or None if the SFX
        provider isn't available / the call failed (the chapter
        still completes — SFX is enrichment, not a hard requirement).
        """
        description = block.get("description", "").strip()
        if not description:
            return None
        duration = float(block.get("duration", 4.0) or 4.0)
        loop = bool(block.get("loop", False))
        prompt_influence = block.get("prompt_influence")

        # Cache by chapter + block index so a retry doesn't re-pay
        # the SFX cost.
        chunk_path = output_dir / f"ch{chapter_index:03d}_sfx_{block_index:04d}.wav"
        if chunk_path.exists() and chunk_path.stat().st_size > 100:
            log.info(
                "audiobook.sfx.cached",
                chapter_index=chapter_index,
                block_index=block_index,
                description=description[:80],
            )
        else:
            provider = self._resolve_sfx_provider()
            if provider is None:
                log.warning(
                    "audiobook.sfx.no_provider",
                    description=description[:80],
                    hint="No ComfyUI server registered; SFX will be silent.",
                )
                await self._generate_silence(chunk_path, duration=duration)
            else:
                try:
                    log.info(
                        "audiobook.sfx.generate.start",
                        description=description[:120],
                        duration=duration,
                    )
                    await provider.synthesize_sfx(
                        description=description,
                        duration=duration,
                        output_path=chunk_path,
                        loop=loop,
                        prompt_influence=prompt_influence,
                    )
                except Exception as exc:  # noqa: BLE001
                    log.warning(
                        "audiobook.sfx.generate.failed",
                        description=description[:120],
                        error=f"{type(exc).__name__}: {str(exc)[:200]}",
                    )
                    await self._generate_silence(chunk_path, duration=duration)

        if not chunk_path.exists():
            return None
        return AudioChunk(
            path=chunk_path,
            chapter_index=chapter_index,
            speaker="__SFX__",
            block_index=block_index,
            chunk_index=0,
            overlay_voice_blocks=block.get("under_voice_blocks"),
            overlay_seconds=block.get("under_seconds"),
            overlay_duck_db=float(block.get("duck_db", -12.0) or -12.0),
        )

    # ══════════════════════════════════════════════════════════════════════
    # Preflight
    # ══════════════════════════════════════════════════════════════════════

    @dataclass
    class PreflightWarning:
        code: str
        message: str
        severity: str  # "info" | "warning" | "error"

    async def preflight(
        self,
        text: str,
        voice_profile: Any | None,
        *,
        voice_casting: dict[str, str] | None = None,
        music_enabled: bool = False,
        music_mood: str | None = None,
        per_chapter_music: bool = False,
        image_generation_enabled: bool = False,
        output_format: str = "audio_only",
    ) -> list[AudiobookService.PreflightWarning]:
        """Validate inputs cheaply and return any blockers / hints.

        Runs in <1s and surfaces every condition that would otherwise
        only trip the user up 30+ minutes into a real generation
        (missing voice profiles, empty / untagged text, ComfyUI not
        wired up when image gen or AceStep music is on, etc.).

        Severity ``error`` items will block ``generate``; the worker
        layer can choose to refuse-with-message rather than starting.
        """
        warnings: list[AudiobookService.PreflightWarning] = []
        W = AudiobookService.PreflightWarning

        # --- Text shape ----------------------------------------------------
        if not text or not text.strip():
            warnings.append(W("empty_text", "Audiobook text is empty.", "error"))
            return warnings  # everything else depends on text
        if len(text.strip()) < 80:
            warnings.append(
                W(
                    "very_short_text",
                    f"Text is only {len(text.strip())} chars. Generation will work but the result will be a few seconds long.",
                    "warning",
                )
            )

        # --- Voice profile -------------------------------------------------
        if voice_profile is None:
            warnings.append(
                W(
                    "no_voice_profile",
                    "No voice profile is assigned. Pick one in the audiobook settings before generating.",
                    "error",
                )
            )

        # --- Voice casting / [Speaker] tags --------------------------------
        speaker_tags = re.findall(r"\[([^\]]+)\]", text)
        unique_speakers = sorted(set(speaker_tags))
        if voice_casting and unique_speakers:
            missing = [s for s in unique_speakers if s not in voice_casting]
            if missing:
                warnings.append(
                    W(
                        "voice_casting_missing",
                        f"voice_casting has no entry for: {', '.join(missing)}. These speakers will fall back to the default voice.",
                        "warning",
                    )
                )

        # --- Music ---------------------------------------------------------
        if music_enabled:
            if not music_mood and not per_chapter_music:
                warnings.append(
                    W(
                        "music_no_mood",
                        "music_enabled is true but no music_mood is set and per_chapter_music is off.",
                        "warning",
                    )
                )
            # If AceStep (ComfyUI) is the only way to fulfil this mood,
            # warn when no ComfyUI server is registered.
            if not self.comfyui_service or not getattr(self.comfyui_service._pool, "_servers", {}):
                warnings.append(
                    W(
                        "music_no_comfyui",
                        "Music is enabled but no ComfyUI server is registered for AceStep generation. The curated library will be tried first; missing moods will be silent.",
                        "info",
                    )
                )

        # --- Image generation ---------------------------------------------
        if image_generation_enabled:
            if not self.comfyui_service or not getattr(self.comfyui_service._pool, "_servers", {}):
                warnings.append(
                    W(
                        "images_no_comfyui",
                        "image_generation_enabled is true but no ComfyUI server is registered. Chapter images will fall back to title cards.",
                        "warning",
                    )
                )

        # --- Output format vs assets --------------------------------------
        if output_format not in ("audio_only", "audio_image", "audio_video"):
            warnings.append(
                W(
                    "unknown_output_format",
                    f"Unknown output_format {output_format!r} — falling back to audio_only.",
                    "warning",
                )
            )

        log.info(
            "audiobook.preflight",
            warning_count=len(warnings),
            errors=[w.code for w in warnings if w.severity == "error"],
            warnings=[w.code for w in warnings if w.severity == "warning"],
            info=[w.code for w in warnings if w.severity == "info"],
        )
        return warnings

    # ══════════════════════════════════════════════════════════════════════
    # Main generation entry point
    # ══════════════════════════════════════════════════════════════════════

    async def generate(
        self,
        audiobook_id: UUID,
        text: str,
        voice_profile: VoiceProfile,
        *,
        title: str = "Audiobook",
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
        track_mix: dict[str, Any] | None = None,
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

        # Stash track_mix on the instance so the mix filter chains
        # (in ``_add_music`` / ``_add_chapter_music``) can read user
        # gain offsets without threading them through every helper.
        # Default = passthrough.
        mix = track_mix or {}
        # Stash the full mix dict so the concat path can read
        # ``track_mix.clips`` per-clip overrides without changing
        # signatures down the call stack.
        self._track_mix_full = mix
        self._voice_gain_db = float(mix.get("voice_db", 0.0) or 0.0)
        self._music_gain_db = float(mix.get("music_db", 0.0) or 0.0)
        self._sfx_gain_db = float(mix.get("sfx_db", 0.0) or 0.0)
        self._voice_muted = bool(mix.get("voice_mute", False))
        self._music_muted = bool(mix.get("music_mute", False))
        self._sfx_muted = bool(mix.get("sfx_mute", False))
        # Music user gain stacks on top of the per-call ``volume_db``
        # arg (which already represents the music bed level), so a
        # +3 dB user gain on top of -14 dB call value = -11 dB.
        if self._music_gain_db:
            music_volume_db = music_volume_db + self._music_gain_db

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
            # Honour the user's Cancel button between chapters. The
            # in-flight TTS / ComfyUI calls aren't interruptible, but
            # we won't queue another chapter once the flag is set.
            await self._check_cancelled(audiobook_id)

            chapter_text = chapter["text"]
            voice_blocks = self._parse_voice_blocks(chapter_text)

            pct = 5 + int((ch_idx / total_chapters) * 45)
            await self._broadcast_progress(
                audiobook_id,
                "tts",
                pct,
                f"Generating speech for chapter {ch_idx + 1}/{total_chapters}...",
            )

            has_sfx = any(b.get("kind") == "sfx" for b in voice_blocks)
            multi_voice_active = bool(voice_casting) and len(voice_blocks) > 1
            if multi_voice_active or has_sfx:
                # SFX blocks must preserve sequential order with voice
                # blocks, so route through the multi-voice path even
                # when only one speaker exists. The voice-casting map
                # may be empty in that case — _generate_multi_voice
                # falls back to ``default_voice_profile`` per block.
                log.info(
                    "audiobook.generate.multi_voice",
                    audiobook_id=str(audiobook_id),
                    chapter=ch_idx,
                    speakers=[b.get("speaker", "SFX") for b in voice_blocks],
                    sfx_count=sum(1 for b in voice_blocks if b.get("kind") == "sfx"),
                )
                chunks = await self._generate_multi_voice(
                    blocks=voice_blocks,
                    voice_casting=voice_casting or {},
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
        await self._check_cancelled(audiobook_id)
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
            await self._check_cancelled(audiobook_id)
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
        await self._check_cancelled(audiobook_id)
        await self._broadcast_progress(audiobook_id, "captions", 85, "Generating captions...")
        captions_ass_path: Path | None = None
        captions_ass_rel: str | None = None
        captions_srt_rel: str | None = None

        try:
            from drevalis.services.captions import CaptionService, CaptionStyle

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

        # 7. Convert to MP3 + write ID3 tags / chapter markers.
        try:
            await self._convert_to_mp3(final_audio)
            mp3_rel_path = f"audiobooks/{audiobook_id}/audiobook.mp3"
            log.info(
                "audiobook.generate.mp3_done",
                audiobook_id=str(audiobook_id),
            )

            # Best-effort ID3 + chapters. Failing here should not fail
            # the whole generation - the MP3 itself is already on disk
            # and playable. Distribution platforms (Audible, Apple Books,
            # Google Play Books) use these tags to show titles, cover
            # art, and chapter navigation.
            try:
                from drevalis.services.audiobook.id3 import write_audiobook_id3

                mp3_abs = final_audio.with_suffix(".mp3")
                cover_abs: Path | None = None
                if cover_image_path:
                    maybe_cover = self.storage.resolve_path(cover_image_path)
                    if maybe_cover.exists():
                        cover_abs = maybe_cover

                await write_audiobook_id3(
                    mp3_abs,
                    title=title,
                    album=title,
                    chapters=chapters if isinstance(chapters, list) else None,
                    cover_path=cover_abs,
                )
                log.info("audiobook.generate.id3_tagged", audiobook_id=str(audiobook_id))
            except Exception as id3_exc:
                log.warning(
                    "audiobook.generate.id3_failed",
                    audiobook_id=str(audiobook_id),
                    error=str(id3_exc),
                )
        except Exception as exc:
            log.warning(
                "audiobook.generate.mp3_failed",
                audiobook_id=str(audiobook_id),
                error=str(exc),
            )

        # 8. Handle output format
        await self._check_cancelled(audiobook_id)
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

    # Chapter heading patterns accepted by ``_parse_chapters``. Each
    # pattern must expose a ``title`` named group (or nothing, in which
    # case the match text itself is used). They run in priority order.
    _CHAPTER_PATTERNS: tuple[str, ...] = (
        # "## Chapter One" / "## 1. Title"
        r"^##\s+(?P<title>.+?)\s*$",
        # "Chapter 1", "Chapter One", "CHAPTER III:", "Chapter 2 — Title"
        r"^\s*(?P<title>(?:CHAPTER|Chapter)\s+(?:\d+|[IVXLCDM]+|[A-Z][a-z]+)\b[^\n]{0,120})$",
        # Roman numeral chapter prefix on its own line ("I.", "IV —")
        r"^\s*(?P<title>[IVXLCDM]{1,4}[\.\)\s—-][^\n]{0,120})$",
        # All-caps heading on its own line (at least 3 letters)
        r"^\s*(?P<title>[A-Z][A-Z0-9 \-'!?]{2,80})\s*$",
    )

    def _parse_chapters(self, text: str) -> list[dict[str, Any]]:
        """Split text into chapters by heading, --- separator, or fallback.

        Matching order:
          1. Markdown ``## Title`` headings
          2. Prose-style ``Chapter 1`` / ``CHAPTER IV`` / Roman numerals
          3. All-caps single-line headings (``THE FIRST ENCOUNTER``)
          4. ``---`` horizontal-rule separators → unnamed "Part N"
          5. No markers → single chapter
        """
        # 1-3 — heading regexes; try each and return on the first that
        # yields ≥ 2 parts so we don't over-split on false positives.
        for pattern in self._CHAPTER_PATTERNS:
            compiled = re.compile(pattern, flags=re.MULTILINE)
            matches = list(compiled.finditer(text))
            if len(matches) < 2:
                continue
            chapters: list[dict[str, Any]] = []
            prologue = text[: matches[0].start()].strip()
            if prologue:
                chapters.append({"title": "Introduction", "text": prologue})
            for i, m in enumerate(matches):
                start = m.end()
                end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
                body = text[start:end].strip()
                if body:
                    chapters.append({"title": (m.group("title") or "").strip()[:120], "text": body})
            if chapters:
                return chapters

        # 4 — horizontal-rule separators
        sections = re.split(r"^---+$", text, flags=re.MULTILINE)
        if len(sections) > 1:
            return [
                {"title": f"Part {i + 1}", "text": s.strip()}
                for i, s in enumerate(sections)
                if s.strip()
            ]

        # 5 — single chapter fallback
        return [{"title": "Full Text", "text": text}]

    # ══════════════════════════════════════════════════════════════════════
    # Voice block parsing
    # ══════════════════════════════════════════════════════════════════════

    def _parse_voice_blocks(self, text: str) -> list[dict[str, str]]:
        """Parse ``[Speaker]`` and ``[SFX: ...]`` tagged text into blocks.

        Each block dict has either ``kind="voice"`` (with
        ``speaker``/``text``) or ``kind="sfx"`` (with
        ``description`` and optional ``duration`` /
        ``prompt_influence`` / ``loop`` keys).

        SFX tag grammar (compatible with the existing speaker tag
        regex so unknown ``[Foo]`` doesn't get silently treated as
        a sound effect):

            [SFX: description]
            [SFX: description | dur=5 | influence=0.4 | loop]
            [SFX: description | dur=8 | under=next | duck=-12]
            [SFX: description | dur=20 | under=4 | duck=-15]

        Modifiers:
            ``dur`` / ``duration``  — seconds, default 4, clamped 0.5-22
            ``influence``           — 0.0-1.0 prompt adherence
            ``loop``                — valueless flag
            ``under=next``          — overlay under the next voice block
            ``under=N``             — overlay under the next N seconds
                                       of voice (across blocks)
            ``duck`` / ``duck_db``  — dB to attenuate the SFX while
                                       voice is speaking on top
                                       (default -12, more negative =
                                       quieter SFX during dialogue)

        Without an ``under`` modifier, the SFX is *sequential* —
        played at exactly its script position, voice resumes after.
        With ``under``, the SFX is *overlay* — written to disk now
        but spliced in by the concatenator on top of subsequent
        voice chunks with sidechain ducking.

        Untagged text defaults to ``[Narrator]``.
        """
        blocks: list[dict[str, Any]] = []
        current_speaker = "Narrator"
        current_text: list[str] = []

        def _flush_voice() -> None:
            if not current_text:
                return
            joined = "\n".join(current_text).strip()
            if joined:
                blocks.append({"kind": "voice", "speaker": current_speaker, "text": joined})

        for raw_line in text.split("\n"):
            line = raw_line.strip()
            if not line:
                if current_text:
                    current_text.append("")
                continue

            if line.startswith("##"):
                continue

            # SFX tag — handled before generic [Speaker] match so
            # ``SFX`` isn't accidentally treated as a speaker name.
            sfx_m = re.match(
                r"^\[\s*SFX\s*:\s*([^\]]+?)\s*\]\s*$",
                line,
                flags=re.IGNORECASE,
            )
            if sfx_m:
                _flush_voice()
                current_text = []
                payload = sfx_m.group(1)
                # Pipe-separated key=value modifiers after the desc.
                parts = [p.strip() for p in payload.split("|")]
                description = parts[0]
                duration = 4.0
                influence: float | None = None
                loop = False
                # Overlay modifiers — None means "sequential
                # placement, no overlay". under_voice_blocks=int OR
                # under_seconds=float describes how much subsequent
                # voice the SFX should ride under.
                under_voice_blocks: int | None = None
                under_seconds: float | None = None
                duck_db = -12.0
                for mod in parts[1:]:
                    if not mod:
                        continue
                    if mod.lower() == "loop":
                        loop = True
                        continue
                    if "=" in mod:
                        k, v = mod.split("=", 1)
                        k = k.strip().lower()
                        v = v.strip()
                        try:
                            if k in ("dur", "duration"):
                                duration = float(v)
                            elif k in ("influence", "prompt_influence"):
                                influence = float(v)
                            elif k == "loop":
                                loop = v.lower() in ("1", "true", "yes")
                            elif k == "under":
                                vl = v.lower()
                                if vl in ("next", "1"):
                                    under_voice_blocks = 1
                                elif vl == "all":
                                    # "all remaining voice blocks in
                                    # the chapter" — handled via a
                                    # very large block count.
                                    under_voice_blocks = 999
                                else:
                                    # Numeric: treat as seconds when
                                    # >2 (a single voice block of
                                    # duration ≤2s is unusual);
                                    # otherwise as block count.
                                    try:
                                        n = float(v)
                                        if n.is_integer() and n <= 5:
                                            under_voice_blocks = int(n)
                                        else:
                                            under_seconds = n
                                    except ValueError:
                                        pass
                            elif k in ("duck", "duck_db"):
                                duck_db = float(v)
                        except ValueError:
                            pass
                blocks.append(
                    {
                        "kind": "sfx",
                        "description": description,
                        "duration": duration,
                        "loop": loop,
                        "prompt_influence": influence,
                        # Overlay metadata — both None for the
                        # sequential default.
                        "under_voice_blocks": under_voice_blocks,
                        "under_seconds": under_seconds,
                        "duck_db": duck_db,
                    }
                )
                continue

            match = re.match(r"^\[([^\]]+)\]\s*(.*)", line)
            if match:
                _flush_voice()
                current_text = []
                current_speaker = match.group(1).strip()
                if match.group(2).strip():
                    current_text.append(match.group(2).strip())
            else:
                current_text.append(line)

        _flush_voice()

        # Drop empty voice blocks but always keep SFX blocks (they
        # carry their own non-text payload).
        return [b for b in blocks if b.get("kind") == "sfx" or b.get("text")]

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
                ok = await self._synthesize_chunk_with_retry(
                    provider,
                    chunk,
                    voice_id,
                    chunk_path,
                    speed=speed,
                    pitch=pitch,
                )
                if not ok:
                    log.warning(
                        "audiobook.generate.tts_chunk_failed",
                        chapter_index=chapter_index,
                        chunk_index=i,
                        chunk_length=len(chunk),
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

        def _normalise_speaker(name: str) -> str:
            """Lower-case + strip + drop non-alphanumerics.

            This is what a human reader would think of as "the same name
            without punctuation" — it lets ``Narrator``, ``narrator.``
            and ``NARRATOR`` match each other, but does **not** match
            ``Narrator`` to ``Nate`` (the old substring fallback did).
            """
            import re as _re

            return _re.sub(r"[^a-z0-9]+", "", name.strip().lower())

        # Pre-compute the normalised casting keys so we're not doing
        # this inside the block loop.
        normalised_cast: dict[str, str] = {
            _normalise_speaker(k): v for k, v in voice_casting.items() if k
        }

        for i, block in enumerate(blocks):
            # SFX block — generate via the dedicated provider and
            # splice the resulting WAV in at this position so its
            # placement in the script is preserved exactly.
            if block.get("kind") == "sfx":
                sfx_chunk = await self._generate_sfx_chunk(
                    block=block,
                    output_dir=output_dir,
                    chapter_index=chapter_index,
                    block_index=i,
                )
                if sfx_chunk is not None:
                    result.append(sfx_chunk)
                continue

            speaker = block["speaker"]
            voice_profile_id = (
                voice_casting.get(speaker)
                or voice_casting.get(speaker.strip())
                or normalised_cast.get(_normalise_speaker(speaker))
            )

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
                    ok = await self._synthesize_chunk_with_retry(
                        provider,
                        chunk,
                        voice_id,
                        chunk_path,
                        speed=speed,
                        pitch=pitch,
                    )
                    if not ok:
                        log.warning(
                            "audiobook.generate.tts_chunk_failed",
                            chapter_index=chapter_index,
                            block_index=i,
                            speaker=speaker,
                            chunk_index=j,
                            chunk_length=len(chunk),
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

            from drevalis.repositories.voice_profile import VoiceProfileRepository

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

    def _is_overlay_sfx(self, chunk: AudioChunk) -> bool:
        return chunk.speaker == "__SFX__" and (
            chunk.overlay_voice_blocks is not None or chunk.overlay_seconds is not None
        )

    async def _concatenate_with_context(
        self, chunks: list[AudioChunk], output: Path
    ) -> list[ChapterTiming]:
        """Concatenate WAV files with context-aware silence gaps.

        Pause durations vary based on context:
        - Between chapters: 1.2 s
        - Between speakers: 400 ms
        - Within same speaker: 150 ms

        SFX chunks marked with overlay metadata
        (``[SFX: ... | under=...]``) are NOT placed in the inline
        timeline — they are mixed under subsequent voice chunks in
        a second pass with sidechain ducking.

        Returns chapter timing metadata.
        """
        if not chunks:
            raise RuntimeError("No audio chunks to concatenate")

        # Partition: inline vs overlay-SFX. For each overlay, remember
        # its position in the original list so we can compute its
        # start offset against the inline timeline below.
        inline_chunks: list[AudioChunk] = []
        overlays: list[tuple[int, AudioChunk]] = []
        for orig_idx, chunk in enumerate(chunks):
            if self._is_overlay_sfx(chunk):
                overlays.append((orig_idx, chunk))
            else:
                inline_chunks.append(chunk)

        if not inline_chunks:
            # All chunks were overlay SFX with no voice — fall back
            # to treating them as inline so we still produce audio.
            inline_chunks = list(chunks)
            overlays = []

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

        # Per-clip overrides from ``track_mix.clips`` (v0.25.0). The
        # editor writes ``{clip_id: {gain_db, mute}}`` entries; we
        # apply them here by either skipping the clip (mute) or
        # writing a gain-adjusted copy and substituting the path.
        clip_overrides: dict[str, dict[str, Any]] = {}
        try:
            mix = getattr(self, "_track_mix_full", None) or {}
            clip_overrides = dict(mix.get("clips") or {})
        except Exception:
            clip_overrides = {}

        adjusted_dir = output.parent / "_adjusted"
        if clip_overrides:
            adjusted_dir.mkdir(parents=True, exist_ok=True)

        async def _apply_clip_override(chunk: AudioChunk) -> Path | None:
            override = clip_overrides.get(chunk.path.stem)
            if not override:
                return chunk.path
            if override.get("mute"):
                # Substitute a silence file the length of this chunk so
                # downstream timing stays exact.
                try:
                    dur = await self.ffmpeg.get_duration(chunk.path)
                except Exception:
                    dur = 0.0
                if dur <= 0:
                    return None
                sil = adjusted_dir / f"{chunk.path.stem}_muted.wav"
                proc = await asyncio.create_subprocess_exec(
                    "ffmpeg",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=24000:cl=mono",
                    "-t",
                    f"{dur:.3f}",
                    "-c:a",
                    "pcm_s16le",
                    str(sil),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await proc.communicate()
                return sil if sil.exists() else chunk.path
            gain_db = float(override.get("gain_db", 0.0) or 0.0)
            if abs(gain_db) < 0.01:
                return chunk.path
            adjusted = adjusted_dir / f"{chunk.path.stem}_g{int(gain_db * 10):+d}.wav"
            if not adjusted.exists():
                proc = await asyncio.create_subprocess_exec(
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(chunk.path),
                    "-af",
                    f"volume={gain_db:+.2f}dB",
                    "-c:a",
                    "pcm_s16le",
                    str(adjusted),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                _, err = await proc.communicate()
                if proc.returncode != 0:
                    log.warning(
                        "audiobook.clip_override.failed",
                        clip_id=chunk.path.stem,
                        gain_db=gain_db,
                        stderr=err.decode("utf-8", errors="replace")[:200],
                    )
                    return chunk.path
            return adjusted

        # Build concat list with context-aware silence
        lines: list[str] = []
        for i, chunk in enumerate(inline_chunks):
            effective_path = await _apply_clip_override(chunk)
            if effective_path is None:
                continue
            safe_path = str(effective_path).replace("\\", "/")
            lines.append(f"file '{safe_path}'")

            if i < len(inline_chunks) - 1:
                next_chunk = inline_chunks[i + 1]
                if chunk.chapter_index != next_chunk.chapter_index:
                    pause = PAUSE_BETWEEN_CHAPTERS
                elif chunk.speaker != next_chunk.speaker:
                    pause = PAUSE_BETWEEN_SPEAKERS
                else:
                    pause = PAUSE_WITHIN_SPEAKER

                sil_safe = str(silence_files[pause]).replace("\\", "/")
                lines.append(f"file '{sil_safe}'")

        concat_list.write_text("\n".join(lines), encoding="utf-8")

        # Concatenate. ``-c copy`` corrupts output silently when chunks
        # differ in sample rate / channels (a Piper 22.05 kHz mono clip
        # next to an ElevenLabs 44.1 kHz stereo clip is a common real-
        # world shape). Re-encode to a single canonical PCM stream —
        # 44.1 kHz stereo s16le — so the mix is guaranteed playable
        # regardless of which TTS provider voiced which chapter. The
        # audiobook post-step re-encodes to MP3/AAC from this anyway,
        # so the intermediate WAV size is not a concern.
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-ar",
            "44100",
            "-ac",
            "2",
            "-sample_fmt",
            "s16",
            "-c:a",
            "pcm_s16le",
            str(output),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            stderr_text = stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"Failed to concatenate chunks: {stderr_text[:300]}")

        # Compute chapter timings by summing chunk durations.
        # Overlay SFX don't influence the timeline so timings come
        # from the inline list only.
        chapter_timings = await self._compute_chapter_timings(inline_chunks)

        # ── Overlay SFX pass ────────────────────────────────────
        # Mix overlay SFX onto the inline base with a sidechain
        # ducker so the SFX rides under the next voice block(s).
        if overlays:
            try:
                await self._mix_overlay_sfx(
                    base_path=output,
                    chunks_in_order=chunks,
                    inline_chunks=inline_chunks,
                    overlays=overlays,
                )
            except Exception as exc:  # noqa: BLE001
                # Never lose the audiobook because an overlay mix
                # failed — log and continue with the bare inline.
                log.warning(
                    "audiobook.overlay_sfx.mix_failed",
                    error=f"{type(exc).__name__}: {str(exc)[:200]}",
                )

        # Cleanup temp files
        concat_list.unlink(missing_ok=True)
        for sil in silence_files.values():
            sil.unlink(missing_ok=True)

        return chapter_timings

    async def _mix_overlay_sfx(
        self,
        base_path: Path,
        chunks_in_order: list[AudioChunk],
        inline_chunks: list[AudioChunk],
        overlays: list[tuple[int, AudioChunk]],
    ) -> None:
        """Mix overlay SFX onto the inline audiobook base.

        For each overlay, computes its start offset in the inline
        timeline (= cumulative duration of all inline chunks +
        between-chunk silences up to and including the gap that
        precedes the next inline chunk after the overlay's script
        position), then sidechain-ducks it and amix-es onto the
        running track.
        """
        # Build position lookup: original_index -> position in inline
        # list. Overlays themselves are not in inline; we use the
        # next inline chunk after the overlay as the start anchor.
        orig_to_inline: dict[int, int] = {}
        inline_set: set[int] = set()
        running_inline_idx = 0
        for orig_idx, chunk in enumerate(chunks_in_order):
            if chunk in inline_chunks[running_inline_idx : running_inline_idx + 1]:
                orig_to_inline[orig_idx] = running_inline_idx
                inline_set.add(orig_idx)
                running_inline_idx += 1
                if running_inline_idx >= len(inline_chunks):
                    break
        # Re-walk to be safe (above loop assumes inline_chunks
        # appears in same relative order — which it does, but
        # guarding against future refactor).
        if len(orig_to_inline) != len(inline_chunks):
            orig_to_inline = {}
            inline_set = set()
            j = 0
            for orig_idx, chunk in enumerate(chunks_in_order):
                if j < len(inline_chunks) and chunk is inline_chunks[j]:
                    orig_to_inline[orig_idx] = j
                    inline_set.add(orig_idx)
                    j += 1

        # Pre-compute durations + cumulative inline starts.
        inline_durations: list[float] = []
        for c in inline_chunks:
            inline_durations.append(await self.ffmpeg.get_duration(c.path))

        # Position-on-disk of inline chunk i (in seconds) =
        # sum(inline_durations[:i]) + sum(silences before each
        # boundary up to i). Compute on demand.
        def inline_start(i: int) -> float:
            t = 0.0
            for k in range(i):
                t += inline_durations[k]
                # Add silence between chunks k and k+1 (already
                # written to disk between the chunks during concat).
                a, b = inline_chunks[k], inline_chunks[k + 1]
                if a.chapter_index != b.chapter_index:
                    t += PAUSE_BETWEEN_CHAPTERS
                elif a.speaker != b.speaker:
                    t += PAUSE_BETWEEN_SPEAKERS
                else:
                    t += PAUSE_WITHIN_SPEAKER
            return t

        # For each overlay, find the next inline chunk after its
        # original position; that's our start anchor.
        overlay_plans: list[tuple[Path, float, float, float]] = []
        for orig_idx, sfx_chunk in overlays:
            # Find next inline orig_idx > this one.
            next_inline_orig: int | None = None
            for j in range(orig_idx + 1, len(chunks_in_order)):
                if j in inline_set:
                    next_inline_orig = j
                    break
            if next_inline_orig is None:
                # Overlay was after every voice chunk — start at
                # end of last inline chunk.
                start = sum(inline_durations) + sum(
                    PAUSE_BETWEEN_CHAPTERS
                    if inline_chunks[k].chapter_index != inline_chunks[k + 1].chapter_index
                    else (
                        PAUSE_BETWEEN_SPEAKERS
                        if inline_chunks[k].speaker != inline_chunks[k + 1].speaker
                        else PAUSE_WITHIN_SPEAKER
                    )
                    for k in range(len(inline_chunks) - 1)
                )
            else:
                start = inline_start(orig_to_inline[next_inline_orig])

            sfx_dur = await self.ffmpeg.get_duration(sfx_chunk.path)
            overlay_plans.append((sfx_chunk.path, start, sfx_dur, float(sfx_chunk.overlay_duck_db)))

        if not overlay_plans:
            return

        # Mix overlays one-by-one onto the base. Doing them all in a
        # single filter_complex is theoretically faster but the per-
        # overlay sidechain compressor wiring gets unwieldy; one
        # pass per overlay is much easier to debug and the cost is
        # bounded (a 1h audiobook with 10 overlays is 10 ffmpeg
        # passes, each <2s of CPU).
        tmp_dir = base_path.parent
        for i, (sfx_path, start_sec, sfx_dur, duck_db) in enumerate(overlay_plans):
            start_ms = max(0, int(start_sec * 1000))
            mixed = tmp_dir / f"_overlay_pass_{i:03d}.wav"
            # adelay → place SFX at the right timestamp
            # apad      → ensure the SFX is at least as long as the base segment
            # sidechaincompress → duck the SFX wherever the base voice is loud
            # amix      → final mix (duration=longest keeps base intact)
            cmd = [
                "ffmpeg",
                "-y",
                "-i",
                str(base_path),
                "-i",
                str(sfx_path),
                "-filter_complex",
                (
                    f"[1:a]adelay={start_ms}|{start_ms},apad,"
                    f"atrim=0:{start_sec + sfx_dur:.2f},"
                    f"volume={duck_db:.1f}dB[sfxprep];"
                    "[sfxprep][0:a]sidechaincompress=threshold=0.05:"
                    "ratio=8:attack=50:release=300[ducked];"
                    "[0:a][ducked]amix=inputs=2:duration=longest:"
                    "dropout_transition=0[out]"
                ),
                "-map",
                "[out]",
                "-ar",
                "44100",
                "-ac",
                "2",
                "-c:a",
                "pcm_s16le",
                str(mixed),
            ]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, err = await proc.communicate()
            if proc.returncode != 0 or not mixed.exists():
                log.warning(
                    "audiobook.overlay_sfx.pass_failed",
                    pass_index=i,
                    sfx_path=str(sfx_path),
                    start_sec=start_sec,
                    rc=proc.returncode,
                    stderr=err.decode("utf-8", errors="replace")[:300],
                )
                mixed.unlink(missing_ok=True)
                continue
            # Replace the base atomically. tmp.replace ≥ rename; on
            # Windows it requires the destination to be writable —
            # we just wrote it, so it is.
            mixed.replace(base_path)
            log.info(
                "audiobook.overlay_sfx.mixed",
                pass_index=i,
                start_sec=round(start_sec, 2),
                duration_sec=round(sfx_dur, 2),
                duck_db=duck_db,
            )

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
        chapter_indices: list[int] | None = None,
    ) -> list[Path]:
        """Generate an image for each chapter via ComfyUI.

        Uses the qwen_image_2512 workflow. Chapters that already have an
        ``image_path`` are skipped. Generation is parallelised with a
        concurrency semaphore of 3.

        Parameters
        ----------
        chapters:
            List of chapter dicts.
        chapter_indices:
            Optional explicit indices to use when naming output files
            (``ch{idx:03d}.png``). When ``None``, indices are derived
            from ``enumerate(chapters)``. Pass explicit indices when
            re-generating a single chapter so its existing image at
            the right index is overwritten rather than writing to
            ``ch000.png``.
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
                    # Drop sampler steps from the template's 20 → 10
                    # by default. Qwen-Image-2512 with the Auraflow
                    # shift produces production-quality output at 10
                    # steps; 20 was safety-padded and roughly doubled
                    # generation time. ``AUDIOBOOK_QWEN_STEPS`` env
                    # var lets power users dial it back up.
                    import os as _os

                    qwen_steps = int(_os.environ.get("AUDIOBOOK_QWEN_STEPS", "10"))
                    if "238:230" in workflow:
                        workflow["238:230"]["inputs"]["steps"] = qwen_steps

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

        # Use explicit indices when given (single-chapter regen case)
        # so the output filename targets the correct slot.
        effective_indices = (
            chapter_indices if chapter_indices is not None else list(range(len(chapters)))
        )
        tasks = [_gen_one(idx, ch) for idx, ch in zip(effective_indices, chapters, strict=True)]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        image_paths: list[Path] = []
        for i, result in enumerate(results):
            chapter_idx = effective_indices[i]
            if isinstance(result, Path) and result.exists():
                image_paths.append(result)
            elif isinstance(result, Exception):
                log.warning(
                    "audiobook.images.chapter_exception",
                    chapter_index=chapter_idx,
                    error=str(result),
                )
                # Generate title card as fallback
                fallback = await self._generate_title_card(
                    images_dir,
                    chapters[i].get("title", f"Chapter {chapter_idx + 1}"),
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

    def _resolve_music_service(self) -> Any | None:
        """Construct a MusicService that can ALSO call AceStep via ComfyUI.

        Earlier versions instantiated MusicService without
        ``comfyui_base_url`` / ``comfyui_api_key``, so AceStep
        generation never ran for audiobooks — every request fell
        straight through to the curated library, which could be
        empty for moods we hadn't pre-stocked. The first registered
        ComfyUI server on the pool is used; the music backend is
        cheap to run alongside image / TTS workloads.
        """
        from drevalis.services.music import MusicService

        storage_base = getattr(self.storage, "base_path", None)
        if storage_base is None:
            log.warning("audiobook.music.no_storage_base")
            return None

        comfyui_url: str | None = None
        comfyui_key: str | None = None
        if self.comfyui_service is not None:
            try:
                servers = getattr(self.comfyui_service._pool, "_servers", {})
                if servers:
                    first_id = next(iter(servers))
                    client = servers[first_id][0]
                    comfyui_url = getattr(client, "base_url", None)
                    comfyui_key = getattr(client, "api_key", None)
            except Exception as exc:
                log.warning(
                    "audiobook.music.comfyui_url_resolve_failed",
                    error=str(exc)[:120],
                )

        return MusicService(
            storage_base_path=storage_base,
            ffmpeg_path="ffmpeg",
            comfyui_base_url=comfyui_url,
            comfyui_api_key=comfyui_key,
        )

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
        log.info(
            "audiobook.music.requested",
            mood=mood,
            duration_seconds=duration,
            volume_db=volume_db,
        )
        music_svc = self._resolve_music_service()
        if music_svc is None:
            return audio_path

        music_path = await music_svc.get_music_for_episode(
            mood=mood,
            target_duration=duration,
            episode_id=uuid4(),
        )
        if not music_path:
            log.warning(
                "audiobook.music.no_track_resolved",
                mood=mood,
                duration_seconds=duration,
                hint=(
                    "MusicService returned no track. Either the mood is missing "
                    "from the curated library AND no ComfyUI server is registered "
                    "for AceStep generation, or the requested duration was 0. "
                    "Check Settings → ComfyUI Servers."
                ),
            )
            return audio_path

        log.info(
            "audiobook.music.track_resolved",
            music_path=str(music_path),
            mood=mood,
            volume_db=volume_db,
        )

        # Mix chain rebuilt for v0.24.0 — previously voice ended up
        # ~6 dB quieter than music because:
        #   1. ``amix`` defaults to ``normalize=1`` which scales each
        #      input by 1/N. With 2 inputs voice was halved.
        #   2. The ``volume_db`` arg was applied to BGM but voice got
        #      no boost, so the implicit -6 dB from amix-normalize
        #      dragged voice well below intelligibility.
        # New chain:
        #   - Voice: optional user gain (default 0 dB), then loudnorm
        #     pre-mix to -16 LUFS for consistent broadcast level.
        #   - Music: user volume_db (default -14 dB) then sidechain
        #     ducked under voice with a more aggressive ducker
        #     (threshold lower, ratio higher) so it actually gets out
        #     of the way during dialogue.
        #   - amix: normalize=0 preserves original gains; voice goes
        #     through unchanged at -16 LUFS, music sits below.
        #   - Final loudnorm sets the master to broadcast standard so
        #     listeners don't have to ride the volume knob.
        voice_gain_db = float(getattr(self, "_voice_gain_db", 0.0) or 0.0)
        sfx_gain_db = float(getattr(self, "_sfx_gain_db", 0.0) or 0.0)  # noqa: F841 (reserved)
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(audio_path),
            "-i",
            str(music_path),
            "-filter_complex",
            (
                f"[0:a]volume={voice_gain_db:+.1f}dB,"
                "loudnorm=I=-16:TP=-1.5:LRA=11[voice];"
                f"[1:a]volume={volume_db}dB[bgm];"
                "[bgm][voice]sidechaincompress=threshold=0.05:ratio=10:attack=20:release=400[ducked];"
                "[voice][ducked]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[mixed];"
                "[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[out]"
            ),
            "-map",
            "[out]",
            "-ar",
            "44100",
            "-ac",
            "2",
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

        log.info(
            "audiobook.music.mix_done",
            output=str(output_path),
            duration_seconds=duration,
            mood=mood,
        )
        return output_path

    async def render_music_preview(
        self,
        audiobook_id: UUID,
        mood: str,
        volume_db: float = -14.0,
        seconds: float = 30.0,
    ) -> Path:
        """Render a short mixed preview so users can sanity-check music
        before committing to a full generation run.

        Mixes the resolved music track (from the library or AceStep)
        under the audiobook's existing voiceover when one exists, or
        under a synthesised silent track otherwise. Output:
        ``audiobooks/{id}/music_preview.wav``. Always overwrites.
        """
        rel_dir = f"audiobooks/{audiobook_id}"
        abs_dir = self.storage.resolve_path(rel_dir)
        abs_dir.mkdir(parents=True, exist_ok=True)
        preview_path = abs_dir / "music_preview.wav"

        existing_voice = abs_dir / "audiobook.wav"
        if existing_voice.exists():
            voice_input: Path = existing_voice
            trim_voice = True
        else:
            # No voice yet — synthesise a silent ``seconds`` baseline
            # so the preview still demonstrates loudness + ducking
            # behaviour against silence.
            voice_input = abs_dir / "_preview_silence.wav"
            silence_cmd = [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=24000:cl=mono",
                "-t",
                f"{seconds:.1f}",
                "-c:a",
                "pcm_s16le",
                str(voice_input),
            ]
            sproc = await asyncio.create_subprocess_exec(
                *silence_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await sproc.communicate()
            trim_voice = False

        # Trim voice to ``seconds`` if it exists; otherwise we already
        # produced exactly ``seconds`` of silence above.
        clip_voice = abs_dir / "_preview_voice_clip.wav"
        if trim_voice:
            trim_cmd = [
                "ffmpeg",
                "-y",
                "-i",
                str(voice_input),
                "-t",
                f"{seconds:.1f}",
                "-c:a",
                "pcm_s16le",
                str(clip_voice),
            ]
            tproc = await asyncio.create_subprocess_exec(
                *trim_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await tproc.communicate()
        else:
            # Voice IS the silence file — just rename our reference.
            clip_voice = voice_input

        await self._add_music(
            audio_path=clip_voice,
            output_path=preview_path,
            mood=mood,
            volume_db=volume_db,
            duration=seconds,
        )

        # Best-effort cleanup of the intermediate silence file.
        try:
            if not trim_voice and voice_input.exists():
                voice_input.unlink()
            if trim_voice and clip_voice.exists():
                clip_voice.unlink()
        except Exception:
            pass

        return preview_path

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
        music_svc = self._resolve_music_service()
        if music_svc is None:
            return audio_path

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

        # Join chapter-music tracks with a real ``acrossfade`` chain
        # between successive tracks. Previously the code concat-demuxed
        # pre-faded tracks — each clip had its own fade-out, but the
        # tracks just touched end-to-end with no overlap, so the mix
        # dipped to silence briefly at every boundary instead of the
        # advertised crossfade.
        if len(valid_music) == 1:
            combined_music = valid_music[0][1]
        else:
            combined_music = music_dir / "combined_music.wav"
            inputs: list[str] = []
            for _, mp in valid_music:
                inputs.extend(["-i", str(mp)])

            # Filter graph: chain acrossfade between each pair.
            # For N inputs we need N-1 acrossfade steps.
            xfd = max(0.05, float(crossfade_duration))
            filter_parts: list[str] = []
            prev = "[0:a]"
            for idx in range(1, len(valid_music)):
                out_label = f"[x{idx}]" if idx < len(valid_music) - 1 else "[out]"
                filter_parts.append(
                    f"{prev}[{idx}:a]acrossfade=d={xfd:.3f}:c1=tri:c2=tri{out_label}"
                )
                prev = out_label
            filter_graph = ";".join(filter_parts)

            proc = await asyncio.create_subprocess_exec(
                "ffmpeg",
                "-y",
                *inputs,
                "-filter_complex",
                filter_graph,
                "-map",
                "[out]",
                "-c:a",
                "pcm_s16le",
                str(combined_music),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr_b = await proc.communicate()
            if not combined_music.exists() or proc.returncode != 0:
                log.warning(
                    "audiobook.chapter_music.crossfade_failed",
                    error=stderr_b.decode("utf-8", errors="replace")[:200],
                )
                return audio_path

        # Mix combined music under voiceover. See ``_add_music`` for
        # the rationale behind the filter chain — same gain-staging
        # approach (per-track loudnorm + sidechain ducker + amix
        # normalize=0 + master loudnorm) so the chapter-music path
        # produces the same broadcast-level output as the global
        # music path. Voice gain pulled from instance attribute when
        # set by an explicit remix call.
        voice_gain_db = float(getattr(self, "_voice_gain_db", 0.0) or 0.0)
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(audio_path),
            "-i",
            str(combined_music),
            "-filter_complex",
            (
                f"[0:a]volume={voice_gain_db:+.1f}dB,"
                "loudnorm=I=-16:TP=-1.5:LRA=11[voice];"
                f"[1:a]volume={volume_db}dB[bgm];"
                "[bgm][voice]sidechaincompress=threshold=0.05:ratio=10:attack=20:release=400[ducked];"
                "[voice][ducked]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[mixed];"
                "[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[out]"
            ),
            "-map",
            "[out]",
            "-ar",
            "44100",
            "-ac",
            "2",
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
        """Convert a WAV file to MP3 at 192 kbps, EBU R128 normalised,
        with leading/trailing silence trimmed.

        The filter chain is:

          * ``silenceremove`` at both ends — drops any leading /
            trailing audio < -40 dBFS lasting ≥ 0.1 s. Stops listeners
            hearing a hang before chapter 1 kicks in when the first
            TTS chunk has a slow onset.
          * ``loudnorm`` with broadcast target ``I=-16 LUFS`` and
            ``TP=-1.5 dBFS`` — keeps audiobooks inside Apple Books'
            recommended loudness window and well under the -14 LUFS
            Spotify ceiling. ``linear=true`` uses the EBU R128
            single-pass algorithm; that's fine for already-concatenated
            speech where dynamic range is modest.
        """
        mp3_path = wav_path.with_suffix(".mp3")
        af = (
            "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-40dB,"
            "areverse,"
            "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-40dB,"
            "areverse,"
            "loudnorm=I=-16:TP=-1.5:LRA=11:linear=true:print_format=summary"
        )
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(wav_path),
            "-af",
            af,
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
            # Retry once without the filter chain so a ffmpeg-version
            # incompat never loses the user's audiobook.
            log.warning(
                "audiobook.mp3_normalisation_failed_retrying_raw",
                error=stderr_text[:200],
            )
            proc2 = await asyncio.create_subprocess_exec(
                "ffmpeg",
                "-y",
                "-i",
                str(wav_path),
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "192k",
                str(mp3_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr2 = await proc2.communicate()
            if proc2.returncode != 0:
                raise RuntimeError(
                    f"Failed to convert to MP3: {stderr2.decode('utf-8', 'replace')[:300]}"
                )

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
        """Generate a simple title card image using FFmpeg.

        The previous version returned the output path even when
        ffmpeg's drawtext filter rejected the title (titles with
        ``:``, ``\\``, ``%`` or other drawtext-meta characters
        crashed the filter). The path then got passed into the
        Ken-Burns assembler which choked on the missing input file:

            Error opening input file .../title_card.jpg

        The new flow:

          1. Properly escape drawtext-meta in the title (``\\``,
             ``:`` and ``'``).
          2. Try drawtext first; if ffmpeg returns non-zero OR the
             output file isn't on disk, fall back to a plain
             solid-color image so the assembler always has a real
             input.
          3. Defensive ``mkdir(parents=True)`` so a missing parent
             directory can never be the cause again.
          4. The first call writes ``title_card.jpg`` (preserved as
             the legacy filename) but subsequent calls get a unique
             slug-suffixed filename so concurrent fallbacks for
             different chapters don't race-overwrite each other.
        """
        output_dir.mkdir(parents=True, exist_ok=True)

        # Make the output filename unique per title so chapter-N's
        # fallback doesn't clobber chapter-(N-1)'s. Hash keeps it
        # deterministic for the "regenerate same chapter" retry case.
        import hashlib

        slug = hashlib.sha1(title.encode("utf-8", errors="replace")).hexdigest()[:8]
        card_path = output_dir / f"title_card_{slug}.jpg"

        # Drawtext escaping rules: backslash escapes itself; the
        # filter argument is single-quoted so single quotes inside
        # have to be replaced (drawtext can't escape quotes inside a
        # quoted value); ``:`` is the parameter separator and must
        # be escaped; ``%`` triggers expansion and must be doubled.
        # Truncate AFTER escaping so we don't cut a half-escape.
        safe_title = (
            title.replace("\\", "\\\\")
            .replace("'", "")
            .replace('"', "")
            .replace(":", "\\:")
            .replace("%", "%%")
        )[:50] or "Audiobook"

        async def _run(cmd: list[str]) -> tuple[int, bytes]:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, err = await proc.communicate()
            return proc.returncode or 0, err

        primary_cmd = [
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
        rc, err = await _run(primary_cmd)
        if rc == 0 and card_path.exists() and card_path.stat().st_size > 0:
            return card_path

        log.warning(
            "audiobook.title_card.drawtext_failed",
            title=title[:80],
            rc=rc,
            stderr=err.decode("utf-8", errors="replace")[:400],
        )

        # Fallback: solid-color frame with no text. Always succeeds
        # as long as ffmpeg is on PATH and the disk has space.
        fallback_cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=0x0f0f1a:s={width}x{height}:d=1",
            "-frames:v",
            "1",
            str(card_path),
        ]
        rc, err = await _run(fallback_cmd)
        if rc != 0 or not card_path.exists():
            raise RuntimeError(
                "Title card generation failed even with the no-text fallback. "
                f"ffmpeg rc={rc}; stderr={err.decode('utf-8', errors='replace')[:200]}"
            )
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
        from drevalis.services.ffmpeg import (
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
