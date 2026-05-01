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

TODO(refactor): Task 13 envisions extracting this monolith into stage modules.
The render_plan.py module landed in the scoped foundation; the rest is
deferred. Planned extraction map (each commit moves ONE block):

  * ``chaptering.py``     ← _CHAPTER_PATTERN_*, _score_chapter_split,
                            _filter_*_matches, _parse_chapters
  * ``script_tags.py``    ← _parse_voice_blocks, the [SFX:] modifier parser
  * ``chunking.py``       ← _split_text, _split_long_sentence,
                            _repair_bracket_splits, CHUNK_LIMITS,
                            _chunk_limit
  * ``tts_render.py``     ← _safety_filter_chunk,
                            _synthesize_chunk_with_retry,
                            _generate_single_voice, _generate_multi_voice,
                            _generate_silence, PROVIDER_CONCURRENCY,
                            _PROVIDER_SEMAPHORES
  * ``plan_builder.py``   ← already extracted (render_plan.py)
  * ``concat_executor.py``← _concatenate_with_context, _is_overlay_sfx,
                            _probe_audio_format, _apply_clip_override
                            (currently a closure)
  * ``mix_executor.py``   ← _mix_overlay_sfx, _add_music, _add_chapter_music,
                            _apply_master_loudnorm, DUCKING_PRESETS,
                            SFX_DUCKING, _build_music_mix_graph
  * ``image_gen.py``      ← _generate_chapter_images, _generate_title_card
  * ``music_gen.py``      ← _resolve_music_service, render_music_preview
  * ``video_render.py``   ← _create_audiobook_video,
                            _create_chapter_aware_video
  * ``metadata.py``       ← Task 13's LAME priming + write_audiobook_id3
                            wrapping (id3.py stays as the mutagen-touching
                            module)
  * ``captions.py``       ← the captions-from-audio block in generate(),
                            with the future ASS-from-RenderPlan rewiring
  * ``job_state.py``      ← already extracted (Task 11)

Once every module above is populated, _monolith.py becomes a thin
backwards-compat shim and ultimately gets deleted. The render_plan.py
data structures are the seam those modules will share.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

import structlog

from drevalis.schemas.audiobook import AudiobookSettings
from drevalis.services.audiobook import job_state as _js
from drevalis.services.audiobook.render_plan import RenderPlan
from drevalis.services.audiobook.versions import AUDIO_PIPELINE_VERSION

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

# ── Silence-trim policy (Task 2) ─────────────────────────────────────────────
# The MP3 export filter chain used to run ``silenceremove`` at both ends, which
# also removed intentional dramatic pauses *inside* the audiobook (the filter
# matches anything below the threshold for the configured duration, not just
# at the boundaries). It also drifted CHAP frame timestamps relative to the
# encoded stream and broke ASS caption sync.
#
# Defaults below preserve every internal pause and skip leading/trailing
# trimming entirely. When ``TRIM_LEADING_TRAILING_SILENCE`` is flipped on
# (Task 9 will wire this through the settings object), the trim runs on the
# WAV BEFORE chapter timings and captions are produced, and the recorded
# leading offset is propagated through both so audible boundaries still
# match CHAP frames within ±50 ms.
TRIM_LEADING_TRAILING_SILENCE = False
PRESERVE_INTERNAL_PAUSES = True

# ── Loudness strategy (Task 3) ───────────────────────────────────────────────
# Single audible loudnorm pass, performed at the master stage with EBU R128's
# two-pass measure-then-apply algorithm. Per-chunk loudnorm is gone — running
# integrated-loudness on sub-second audio doesn't converge and only produced
# inter-sentence loudness jitter when chained with the master pass. Per-chunk
# work is now peak safety only (highpass + alimiter).
#
# MP3 export no longer carries its own loudnorm; the WAV the encoder reads is
# already mastered. End-to-end this means: the audiobook is loudnorm'd exactly
# once, at the right time, against integrated content rather than fragments.
#
# Defaults below are the narrative preset. Task 9 will route platform-specific
# overrides (-16 LUFS / LRA 11 for podcast, -14 LUFS for streaming, -20 LUFS /
# LRA 18 for ACX) through the settings object.
LOUDNESS_TARGET_LUFS = -18.0
TRUE_PEAK_DBFS = -2.0
LOUDNESS_LRA = 14.0

# ── Music-bed ducking presets (Task 6) ───────────────────────────────────────
# Pre-Task-6 the sidechain compressor ran with hardcoded
# ``threshold=0.05:ratio=10:attack=20:release=400`` numerics, which ducked on
# every breath and pumped audibly between sentences. The new defaults give:
#
#   * ``static``    — no sidechain. Music sits at a fixed -22 dB under voice.
#                     Default for narrative audiobooks; predictable, no pumping.
#   * ``subtle``    — gentle sidechain, slow release. Best for ambient beds.
#   * ``normal``    — moderate ducking; the new podcast default.
#   * ``strong``    — heavier ducking; voice clearly above music at all times.
#   * ``cinematic`` — film-mix style, fast attack, deep duck.
#
# Task 9 will wire this through the settings object so it's per-audiobook.
DUCKING_PRESETS: dict[str, dict[str, Any]] = {
    "static": {
        "mode": "static",
        "music_db": -22.0,
    },
    "subtle": {
        "mode": "sidechain",
        "music_db": -20.0,
        "threshold": 0.125,
        "ratio": 3,
        "attack": 15,
        "release": 800,
    },
    "normal": {
        "mode": "sidechain",
        "music_db": -18.0,
        "threshold": 0.1,
        "ratio": 4,
        "attack": 10,
        "release": 600,
    },
    "strong": {
        "mode": "sidechain",
        "music_db": -15.0,
        "threshold": 0.1,
        "ratio": 6,
        "attack": 8,
        "release": 400,
    },
    "cinematic": {
        "mode": "sidechain",
        "music_db": -12.0,
        "threshold": 0.08,
        "ratio": 8,
        "attack": 5,
        "release": 350,
    },
}
DEFAULT_DUCKING_PRESET = "static"

# SFX overlay ducking — separate from the music-bed presets above. SFX overlays
# need a slightly different feel: faster attack to cut through dialogue, faster
# release so the voice doesn't push the SFX way down for half a second after a
# breath. These numerics are softer than the pre-Task-6 hardcoded
# ``threshold=0.05:ratio=8:attack=50:release=300``.
SFX_DUCKING: dict[str, float | int] = {
    "threshold": 0.1,
    "ratio": 5,
    "attack": 8,
    "release": 250,
}

# Master pre-loudnorm limiter ceiling. Lower than the per-mix stage (which uses
# the same value here) so loudnorm has headroom to apply gain reduction without
# intersample peaking. Format string with the ffmpeg-5+ ``dB`` suffix.
MASTER_LIMITER_CEILING_DB = -1.0


def _build_music_mix_graph(
    *,
    preset: dict[str, Any],
    voice_gain_db: float,
    music_volume_db: float,
    music_pad_ms: int,
) -> str:
    """Build the filter_complex graph for the voice + music master mix.

    ``preset`` is one of the ``DUCKING_PRESETS`` values. ``static`` mode
    skips sidechain compression entirely; sidechain modes apply
    threshold / ratio / attack / release from the preset.

    The chain ends with ``alimiter`` at ``MASTER_LIMITER_CEILING_DB`` to
    catch intersample peaks before the master loudnorm pass picks up
    the WAV in ``_apply_master_loudnorm``.
    """
    voice_branch = f"[0:a]volume={voice_gain_db:+.1f}dB[voice]"
    bgm_branch = f"[1:a]apad=whole_dur={music_pad_ms}ms,volume={music_volume_db}dB[bgm]"
    if preset.get("mode") == "static":
        # No sidechain — straight amix at fixed gains.
        return (
            f"{voice_branch};"
            f"{bgm_branch};"
            "[voice][bgm]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[mixed];"
            f"[mixed]alimiter=limit={MASTER_LIMITER_CEILING_DB}dB[out]"
        )
    # Sidechain mode.
    threshold = preset["threshold"]
    ratio = preset["ratio"]
    attack = preset["attack"]
    release = preset["release"]
    return (
        f"{voice_branch};"
        f"{bgm_branch};"
        f"[bgm][voice]sidechaincompress=threshold={threshold}:ratio={ratio}"
        f":attack={attack}:release={release}[ducked];"
        "[voice][ducked]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[mixed];"
        f"[mixed]alimiter=limit={MASTER_LIMITER_CEILING_DB}dB[out]"
    )


def _mp3_encoder_args(mode: str) -> list[str]:
    """Return the libmp3lame encoder argv tail for *mode*.

    Recognised modes (Task 9): ``cbr_128``, ``cbr_192``, ``cbr_256``,
    ``vbr_v0``, ``vbr_v2``. Unknown modes fall back to CBR 192 kbps —
    the pre-Task-9 default — so a mistyped mode never fails the
    audiobook.
    """
    if mode.startswith("cbr_"):
        bitrate = mode.split("_", 1)[1]
        return ["-codec:a", "libmp3lame", "-b:a", f"{bitrate}k"]
    if mode == "vbr_v0":
        return ["-codec:a", "libmp3lame", "-q:a", "0"]
    if mode == "vbr_v2":
        return ["-codec:a", "libmp3lame", "-q:a", "2"]
    log.warning("audiobook.mp3_encoder.unknown_mode_falling_back", mode=mode)
    return ["-codec:a", "libmp3lame", "-b:a", "192k"]


def _resolve_ducking_preset(name: str | None) -> dict[str, Any]:
    """Look up *name* in ``DUCKING_PRESETS`` (case-insensitive).

    Unknown names log a warning and fall back to the default
    ``static`` preset so an upstream typo can't fail generation.
    """
    if name is None:
        return DUCKING_PRESETS[DEFAULT_DUCKING_PRESET]
    key = name.strip().lower()
    if key in DUCKING_PRESETS:
        return DUCKING_PRESETS[key]
    log.warning(
        "audiobook.ducking.unknown_preset_falling_back",
        requested=name,
        fallback=DEFAULT_DUCKING_PRESET,
        known=sorted(DUCKING_PRESETS.keys()),
    )
    return DUCKING_PRESETS[DEFAULT_DUCKING_PRESET]


# ── Per-provider TTS concurrency (Task 4) ────────────────────────────────────
# Within-chapter chunks used to render strictly sequentially even though most
# providers happily handle parallel requests. This map sets the per-provider
# in-flight cap; ElevenLabs is intentionally conservative (Creator plan = 2
# concurrent), Edge / Kokoro can take more, ComfyUI-routed SFX is serialised
# because the underlying ComfyUI pool already manages concurrency. Unknown
# providers default to 2 — safe for any cloud TTS.
#
# ELEVENLABS_CONCURRENCY env var overrides the ElevenLabs cap at lookup time
# so operators on Pro/Scale plans don't need a code change.
_DEFAULT_ELEVENLABS_CONCURRENCY = 2

# ── Per-provider chunk size (Task 12) ────────────────────────────────────────
# Pre-Task-12 every provider got ``max_chars=500``, which shipped ElevenLabs
# (Creator plan ceiling 2500 chars) ~5× more requests than necessary. Larger
# chunks also cut cache-key churn on text edits because changes touch fewer
# chunks. ``_DEFAULT_CHUNK_LIMIT`` is the conservative fallback for any
# provider not in the map.
_DEFAULT_CHUNK_LIMIT = 700

CHUNK_LIMITS: dict[str, int] = {
    "piper": 700,
    "kokoro": 900,
    "edge": 1200,
    # Longest-key-wins: ``comfyui_elevenlabs`` resolves before plain
    # ``elevenlabs``. The ComfyUI route also accepts 2200 — its
    # back-end is ElevenLabs, just a different request shape.
    "comfyui_elevenlabs": 2200,
    "elevenlabs": 2200,
}


def _chunk_limit(provider_name: str) -> int:
    """Return the per-provider ``max_chars`` (case-insensitive)."""
    name = provider_name.lower().replace("_", "")
    best: tuple[int, int] | None = None  # (key length, limit)
    for key, limit in CHUNK_LIMITS.items():
        normalised_key = key.replace("_", "")
        if normalised_key in name and (best is None or len(normalised_key) > best[0]):
            best = (len(normalised_key), limit)
    return best[1] if best is not None else _DEFAULT_CHUNK_LIMIT


# Substring → concurrency. Keys are matched case-insensitively against the
# provider's class name (or its ``name`` / ``provider_name`` attribute).
_PROVIDER_CONCURRENCY: dict[str, int] = {
    "piper": 2,
    "kokoro": 4,
    "edge": 6,
    # ElevenLabs entries — the substring lookup picks the longest matching
    # key, so ``comfyui_elevenlabs`` resolves before plain ``elevenlabs``.
    "comfyui_elevenlabs": 1,
    "elevenlabs": _DEFAULT_ELEVENLABS_CONCURRENCY,
}

# Module-level semaphore registry. Created lazily on first lookup so importing
# this module doesn't require a running event loop.
_PROVIDER_SEMAPHORES: dict[str, asyncio.Semaphore] = {}


class CancelChecker:
    """Debounced Redis poller for the audiobook cancel flag (Task 10).

    Pre-Task-10, polls happened only at chapter boundaries — a long-form
    chapter with hundreds of chunks running in parallel could drag a
    Cancel click out for minutes while the in-flight gather drained.
    The new design polls Redis at every reasonable seam (TTS attempts,
    ffmpeg invocations, image / music generation) but caps the actual
    Redis traffic to one GET per second per checker; intermediate calls
    are no-ops.

    Failures from Redis (network blip, broken pool) are swallowed —
    cancellation is a UX feature, not a correctness one, and a Redis
    outage shouldn't fail the audiobook.
    """

    __slots__ = ("_redis", "_key", "_last_check")

    def __init__(self, redis: Any, audiobook_id: UUID) -> None:
        self._redis = redis
        self._key = f"cancel:audiobook:{audiobook_id}"
        self._last_check = 0.0

    async def check(self) -> None:
        now = time.monotonic()
        if now - self._last_check < 1.0:
            return
        self._last_check = now
        if self._redis is None:
            return
        try:
            flag = await self._redis.get(self._key)
        except Exception:
            return
        if flag:
            raise asyncio.CancelledError(f"audiobook cancelled by user (key={self._key})")


def _provider_concurrency(provider_name: str) -> int:
    """Return the in-flight cap for *provider_name* (case-insensitive).

    Substring match, longest-key-wins so ``ComfyUIElevenLabsProvider``
    binds to the ComfyUI cap rather than the plain ElevenLabs cap.
    Underscores are stripped on both sides because provider class
    names don't contain them but the keys are written for readability.
    Unknown providers fall back to 2 — safe for any cloud TTS.
    """
    name = provider_name.lower().replace("_", "")
    best: tuple[int, int] | None = None  # (key length, concurrency)
    for key, cap in _PROVIDER_CONCURRENCY.items():
        normalised_key = key.replace("_", "")
        if normalised_key in name and (best is None or len(normalised_key) > best[0]):
            best = (len(normalised_key), cap)
    if best is not None:
        cap = best[1]
        # Env override applies only to the ElevenLabs cap.
        if "elevenlabs" in name and "comfyui" not in name:
            import os as _os

            override = _os.environ.get("ELEVENLABS_CONCURRENCY")
            if override and override.isdigit() and int(override) > 0:
                return int(override)
        return cap
    return 2


def _get_provider_semaphore(provider_name: str) -> asyncio.Semaphore:
    """Singleton ``asyncio.Semaphore`` for the provider's in-flight cap.

    Multiple ``AudiobookService`` instances share one rate budget per
    provider — the worker process is single-threaded async, so a
    process-wide semaphore is the natural unit for "ElevenLabs is at
    its rate limit" coordination.
    """
    name = provider_name.lower()
    sem = _PROVIDER_SEMAPHORES.get(name)
    if sem is None:
        sem = asyncio.Semaphore(_provider_concurrency(name))
        _PROVIDER_SEMAPHORES[name] = sem
    return sem


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


# ── Hash-keyed chunk cache ────────────────────────────────────────────────
#
# Chunk filenames embed a 12-hex-char content hash so changing any input
# that influences the rendered audio (voice profile, provider, speed,
# pitch, pipeline version, …) produces a new filename and forces re-render.
# The hash sits at the END of the stem so the chapter / chunk index prefix
# remains a stable, human-readable handle for the editor.

# Matches a trailing ``_<12 hex>`` suffix on a chunk stem.
_CHUNK_HASH_SUFFIX_RE = re.compile(r"_(?P<h>[0-9a-f]{12})$")


def _chunk_cache_hash(
    *,
    text: str,
    speaker_id: str,
    voice_profile_id: str,
    provider: str,
    model: str,
    speed: float,
    pitch: float,
    sample_rate: int,
) -> str:
    """Return the 12-hex-char cache hash for a TTS chunk.

    The set of inputs is the contract: any field that can change the
    bytes ffmpeg ultimately writes for this chunk MUST be in here. If a
    new input is added, also bump ``AUDIO_PIPELINE_VERSION`` so existing
    caches are invalidated cleanly even when the new field defaults match
    the old behaviour.
    """
    payload = json.dumps(
        {
            "text": text,
            "speaker_id": speaker_id,
            "voice_profile_id": voice_profile_id,
            "provider": provider,
            "model": model,
            "speed": float(speed),
            "pitch": float(pitch),
            "sample_rate": int(sample_rate),
            "pipeline_version": AUDIO_PIPELINE_VERSION,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:12]


def _strip_chunk_hash(stem: str) -> str:
    """Return the editor-facing stable id for a chunk file stem.

    ``ch003_chunk_0007_a1b2c3d4e5f6`` → ``ch003_chunk_0007``.
    Stems without a recognised hash suffix are returned unchanged, so
    legacy index-only filenames keep working through the migration.
    """
    return _CHUNK_HASH_SUFFIX_RE.sub("", stem)


def _provider_identity(provider: Any, voice_profile: Any) -> tuple[str, str]:
    """Best-effort ``(provider_name, model_id)`` for cache hashing.

    Providers don't share a strict interface for these attributes; we
    pull whatever is available without forcing every TTSProvider impl
    to grow new public surface. Fallbacks are stable strings so the
    hash is still deterministic across runs.
    """
    provider_name = (
        getattr(provider, "name", None)
        or getattr(provider, "provider_name", None)
        or type(provider).__name__
    )
    model = (
        getattr(voice_profile, "model_name", None)
        or getattr(voice_profile, "model", None)
        or getattr(voice_profile, "voice_id", None)
        or ""
    )
    return str(provider_name), str(model)


class AudiobookService:
    """High-level service for generating audiobooks from text."""

    # Per-call state attributes are populated by ``_initialize_call_state``
    # at the top of ``generate``. Declared at class scope so mypy can
    # type-check helper methods that read them (``_dag_chapter`` etc.)
    # without having to follow every ``generate`` code path.
    _job_state: dict[str, Any]

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
        """Raise ``CancelledError`` if a cancel flag is set for this audiobook.

        Chapter-boundary entry point — kept for legacy callers that
        don't have a ``CancelChecker`` (one-shot regeneration jobs that
        instantiate the service outside ``generate``).
        """
        if not self.redis:
            return
        try:
            flag = await self.redis.get(f"cancel:audiobook:{audiobook_id}")
        except Exception:
            return
        if flag:
            log.info("audiobook.generate.cancelled_by_user", audiobook_id=str(audiobook_id))
            raise asyncio.CancelledError(f"Audiobook {audiobook_id} cancelled by user")

    async def _cancel(self) -> None:
        """Debounced cancel poll — fires at every reasonable seam.

        Reads ``self._cancel_checker`` (set in ``generate``); no-op
        when unset so deeper helpers called outside ``generate``
        (e.g. the regenerate-image one-shot job) don't break.
        """
        checker = getattr(self, "_cancel_checker", None)
        if checker is None:
            return
        await checker.check()

    # ══════════════════════════════════════════════════════════════════════
    # DAG job state mutation helpers (Task 11)
    # ══════════════════════════════════════════════════════════════════════

    async def _dag_chapter(self, chapter_index: int, stage: str, value: _js.State) -> None:
        """Mutate the chapter stage and fire the persist callback."""
        if not getattr(self, "_job_state", None):
            return
        _js.set_chapter_stage(self._job_state, chapter_index, stage, value)
        await self._persist_dag()

    async def _dag_global(self, stage: str, value: _js.State) -> None:
        """Mutate a global stage and fire the persist callback."""
        if not getattr(self, "_job_state", None):
            return
        _js.set_global_stage(self._job_state, stage, value)
        await self._persist_dag()

    async def _persist_dag(self) -> None:
        """Push the current DAG to the worker's persistence callback.

        Failures from the callback are logged + swallowed — the DAG is
        a recovery aid, not a correctness one. We never want a Postgres
        blip during the persist to fail the whole audiobook.
        """
        cb = getattr(self, "_persist_job_state_cb", None)
        if cb is None:
            return
        try:
            res = cb(dict(self._job_state))
            if asyncio.iscoroutine(res):
                await res
        except Exception as exc:  # noqa: BLE001
            log.warning("audiobook.job_state.persist_failed", error=str(exc)[:200])

    def _dag_chapter_done(self, chapter_index: int, stage: str) -> bool:
        """``True`` iff the chapter stage is already ``done`` (skip)."""
        if not getattr(self, "_job_state", None):
            return False
        return _js.is_done(self._job_state, stage, chapter_index)

    def _dag_global_done(self, stage: str) -> bool:
        if not getattr(self, "_job_state", None):
            return False
        return _js.is_done(self._job_state, stage)

    async def _persist_render_plan(self, plan: RenderPlan) -> None:
        """Push the current ``RenderPlan`` to the worker's persist callback.

        Failures are logged + swallowed — the plan is an inspectable
        artifact, not a correctness one. A Postgres blip during the
        persist must not fail the whole audiobook.
        """
        cb = getattr(self, "_persist_render_plan_cb", None)
        if cb is None:
            return
        try:
            res = cb(plan.to_dict())
            if asyncio.iscoroutine(res):
                await res
        except Exception as exc:  # noqa: BLE001
            log.warning("audiobook.render_plan.persist_failed", error=str(exc)[:200])

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

        # Match both single-voice (``ch003_chunk_*``) and multi-voice
        # block-style (``ch003_block_*_chunk_*``) chunks. The previous
        # implementation only cleared single-voice files, so a per-
        # chapter regenerate of a multi-voice audiobook silently
        # reused stale block chunks.
        deleted = 0
        single_prefix = f"ch{int(chapter_index):03d}_chunk_"
        block_prefix = f"ch{int(chapter_index):03d}_block_"
        for child in output_dir.iterdir():
            if child.suffix != ".wav":
                continue
            if child.name.startswith(single_prefix) or child.name.startswith(block_prefix):
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
    # Legacy chunk cache purge (one-shot, idempotent)
    # ══════════════════════════════════════════════════════════════════════
    #
    # Pre-hash chunk filenames had no content key, so a voice / speed /
    # pipeline change silently reused stale audio. On first generation
    # after upgrade we walk the audiobook output dir once and delete any
    # chunk file that doesn't carry the new ``_<12hex>`` suffix. The
    # next ``generate`` call re-renders those chunks under the new
    # naming scheme. Idempotent: subsequent runs find nothing to do.

    _LEGACY_SINGLE_RE = re.compile(r"^ch\d{3}_chunk_\d{4}\.wav$")
    _LEGACY_BLOCK_RE = re.compile(r"^ch\d{3}_block_\d{4}_chunk_\d{4}\.wav$")

    async def _purge_legacy_chunks(self, output_dir: Path) -> int:
        """Delete pre-hash chunk files in *output_dir*. Returns the count."""
        if not output_dir.exists():
            return 0
        deleted = 0
        for child in output_dir.iterdir():
            if not child.is_file():
                continue
            if self._LEGACY_SINGLE_RE.match(child.name) or self._LEGACY_BLOCK_RE.match(child.name):
                try:
                    child.unlink()
                    deleted += 1
                except OSError:
                    pass
        if deleted:
            log.info(
                "audiobook.cache.legacy_format_purged",
                output_dir=str(output_dir),
                deleted=deleted,
                pipeline_version=AUDIO_PIPELINE_VERSION,
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

    # Hash suffix is optional so legacy index-only files (created before
    # the hash-keyed cache) still surface in the editor during the
    # migration window. The editor's clip_id is the stem with any
    # trailing ``_<12hex>`` stripped — see ``_strip_chunk_hash`` — so
    # per-clip overrides survive a cache bust caused by a voice change.
    _CLIP_PATTERNS: tuple[tuple[str, str], ...] = (
        # single-voice voice chunks: ch003_chunk_0007[_<hash12>].wav
        ("voice_single", r"^ch(?P<ch>\d{3})_chunk_(?P<i>\d{4})(?:_[0-9a-f]{12})?\.wav$"),
        # multi-voice voice chunks: ch003_block_0002_chunk_0007[_<hash12>].wav
        (
            "voice_multi",
            r"^ch(?P<ch>\d{3})_block_(?P<b>\d{4})_chunk_(?P<j>\d{4})(?:_[0-9a-f]{12})?\.wav$",
        ),
        # SFX: ch003_sfx_0002.wav (no hash — SFX cache key is just
        # the script position; description changes require an explicit
        # regenerate today, same as before).
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
            # Strip the optional hash suffix so the clip_id is stable
            # across cache busts (voice profile / speed / pipeline
            # version changes). track_mix.clips overrides keyed off
            # this id continue to apply to whichever rendered version
            # is currently on disk.
            clip_id = _strip_chunk_hash(path.stem)
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
        # Task 4 + 10: poll the cancel flag inside the retry loop. The
        # debounced ``_cancel`` checker caps Redis traffic to ~1 GET/s
        # even when 30+ chunks are racing through their first attempt,
        # while still letting Cancel propagate within 5 seconds (Task
        # 10 acceptance).
        for attempt in range(1, max_attempts + 1):
            await self._cancel()
            try:
                await provider.synthesize(
                    text,
                    voice_id,
                    chunk_path,
                    speed=speed,
                    pitch=pitch,
                )
                if chunk_path.exists() and chunk_path.stat().st_size > 100:
                    await self._safety_filter_chunk(chunk_path)
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

    async def _safety_filter_chunk(self, chunk_path: Path) -> None:
        """Run lightweight peak-safety filtering on the chunk, in place.

        Replaces the previous per-chunk EBU R128 loudnorm pass. Running
        integrated-loudness on a single sentence (typically <2 s of
        audio) doesn't actually converge — the LUFS measurement window
        is 3 s by default — so the per-chunk pass produced unstable
        results that then got compounded by the post-concat loudnorm
        and the MP3-export loudnorm, audibly pumping inter-sentence
        levels.

        The new pass does only what's safe to apply at the chunk level:

          * ``aresample=24000`` — canonical 24 kHz mono PCM so concat
            doesn't have to re-encode (Task 7 will skip re-encode when
            inputs are uniform).
          * ``highpass=f=60`` — kills the sub-60 Hz rumble most TTS
            providers leak (especially Edge), which would otherwise
            eat headroom from the master loudnorm pass.
          * ``alimiter=limit=0.95`` — clamps any inter-sample peaks
            below ~-0.4 dBFS so downstream stages have headroom to
            work with.

        Failure here is non-fatal — the un-filtered chunk is better
        than no chunk. We log + move on.
        """
        tmp = chunk_path.with_suffix(".norm.wav")
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(chunk_path),
            "-af",
            "aresample=24000,highpass=f=60,alimiter=limit=0.95",
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
                    "audiobook.tts.safety_replace_failed",
                    error=str(exc)[:120],
                )
                tmp.unlink(missing_ok=True)
        else:
            log.warning(
                "audiobook.tts.safety_filter_failed",
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

    async def _run_captions_phase(
        self,
        *,
        audiobook_id: UUID,
        abs_dir: Path,
        final_audio: Path,
        caption_style_preset: str | None,
        video_width: int,
        video_height: int,
    ) -> tuple[Path | None, str | None, str | None]:
        """Generate ASS + SRT captions from the mastered audio.

        Returns ``(ass_path, ass_rel, srt_rel)``. The .ass path is an
        absolute filesystem path used downstream by the video assembly
        step; the rel paths are storage-relative for API responses.

        Three terminal states distinguished:

        - **success**: full captions written, DAG ``captions`` → done.
        - **skipped**: faster-whisper not installed (optional dep);
          DAG ``captions`` → skipped, all return values ``None`` so
          downstream video creation falls through to the no-captions
          path.
        - **failed**: any other exception during ASR; logged at
          ERROR with full traceback, DAG ``captions`` → failed,
          return values ``None`` (audiobook still completes).

        The CaptionStyle is built with the YouTube-highlight defaults
        — Impact 60pt, gold highlight, white text, black 5px outline,
        bottom-positioned, 4 words/line, uppercase. The
        ``caption_style_preset`` arg overrides only the preset name
        (the per-field defaults stay constant so a future preset
        addition doesn't silently change every other field).

        Pulled out of ``generate`` (F-CQ-01 step 10).
        """
        await self._check_cancelled(audiobook_id)
        await self._broadcast_progress(audiobook_id, "captions", 85, "Generating captions...")
        await self._dag_global("captions", "in_progress")

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
            await self._dag_global("captions", "done")
        except ImportError:
            log.warning(
                "audiobook.generate.captions_skipped",
                audiobook_id=str(audiobook_id),
                reason="faster-whisper not installed",
            )
            await self._dag_global("captions", "skipped")
        except Exception as exc:
            log.error(
                "audiobook.generate.captions_failed",
                audiobook_id=str(audiobook_id),
                error=str(exc),
                exc_info=True,
            )
            await self._dag_global("captions", "failed")

        return captions_ass_path, captions_ass_rel, captions_srt_rel

    async def _run_master_mix_phase(
        self,
        *,
        audiobook_id: UUID,
        final_audio: Path,
    ) -> None:
        """Apply master loudnorm to ``final_audio``.

        Single audible-loudness pass. Runs AFTER music mixing so it
        integrates over the actual final content, and BEFORE captions
        ASR + MP3 export so both consume the already-mastered WAV.

        Failures are non-fatal (warning is logged inside
        ``_apply_master_loudnorm``); the un-mastered audiobook is still
        produced — the user gets working output even when the loudnorm
        ffmpeg pass blows up. Cancellation is honoured immediately
        before the master pass.

        Pulled out of ``generate`` (F-CQ-01 step 9).
        """
        await self._check_cancelled(audiobook_id)
        await self._dag_global("master_mix", "in_progress")
        await self._apply_master_loudnorm(final_audio)
        await self._dag_global("master_mix", "done")

    async def _run_music_phase(
        self,
        *,
        chapters: list[dict[str, Any]],
        abs_dir: Path,
        audiobook_id: UUID,
        final_audio: Path,
        chapter_timings: list[ChapterTiming],
        duration: float,
        file_size: int,
        music_enabled: bool,
        music_mood: str | None,
        music_volume_db: float,
        per_chapter_music: bool,
    ) -> int:
        """Mix per-chapter or global background music onto ``final_audio``.

        Skipped when music is disabled OR no music_mood was supplied
        AND per_chapter_music is False.

        Per-chapter music takes precedence when ``per_chapter_music``
        is True AND chapter_timings exist (without timings the
        per-chapter crossfade can't be placed). Otherwise falls back to
        the global ``_add_music`` path.

        On a successful mix, the output WAV swaps into ``final_audio``
        via the safe-rename pattern (backup → rename mixed → drop
        backup; on failure → restore backup, re-raise). Returns the
        post-swap file_size, or the original file_size when no mix
        ran.

        On any failure, every chapter's DAG ``music`` is flipped to
        ``failed`` and the exception is swallowed — the audiobook
        still completes with the un-music-mixed audio.

        Pulled out of ``generate`` (F-CQ-01 step 8). The two-branch
        backup-rename pattern is collapsed into ``_swap_in_mixed_audio``.
        """
        if not (music_enabled and (music_mood or per_chapter_music)):
            return file_size

        await self._check_cancelled(audiobook_id)
        await self._broadcast_progress(audiobook_id, "music", 70, "Adding background music...")
        for ch_idx in range(len(chapters)):
            await self._dag_chapter(ch_idx, "music", "in_progress")
        try:
            music_output = abs_dir / "audiobook_with_music.wav"
            if per_chapter_music and chapter_timings:
                # Per-chapter music with crossfades
                mixed_path = await self._add_chapter_music(
                    audio_path=final_audio,
                    output_path=music_output,
                    chapter_timings=chapter_timings,
                    chapters=chapters,
                    global_mood=music_mood or "calm",
                    volume_db=music_volume_db,
                    audiobook_id=audiobook_id,
                )
                file_size = self._swap_in_mixed_audio(
                    final_audio=final_audio,
                    mixed_path=mixed_path,
                    file_size=file_size,
                    log_event="audiobook.generate.chapter_music_mixed",
                    audiobook_id=audiobook_id,
                )
            elif music_mood:
                # Global music (existing behaviour)
                mixed_path = await self._add_music(
                    audio_path=final_audio,
                    output_path=music_output,
                    mood=music_mood,
                    volume_db=music_volume_db,
                    duration=duration,
                )
                file_size = self._swap_in_mixed_audio(
                    final_audio=final_audio,
                    mixed_path=mixed_path,
                    file_size=file_size,
                    log_event="audiobook.generate.music_mixed",
                    audiobook_id=audiobook_id,
                )
            for ch_idx in range(len(chapters)):
                await self._dag_chapter(ch_idx, "music", "done")
        except Exception as exc:
            log.warning(
                "audiobook.generate.music_failed",
                audiobook_id=str(audiobook_id),
                error=str(exc),
            )
            for ch_idx in range(len(chapters)):
                await self._dag_chapter(ch_idx, "music", "failed")
        return file_size

    @staticmethod
    def _swap_in_mixed_audio(
        *,
        final_audio: Path,
        mixed_path: Path,
        file_size: int,
        log_event: str,
        audiobook_id: UUID,
    ) -> int:
        """Atomically swap ``mixed_path`` into ``final_audio``.

        Backup the existing WAV, rename the mixed output over it, drop
        the backup. On failure, restore the backup and re-raise so
        callers' ``except`` blocks see the original error.

        Returns the post-swap ``file_size`` (or the original if the
        mixer returned the same path → no swap needed).
        """
        if mixed_path == final_audio:
            return file_size
        backup = final_audio.with_suffix(".wav.bak")
        final_audio.rename(backup)
        try:
            mixed_path.rename(final_audio)
            backup.unlink(missing_ok=True)
        except Exception:
            backup.rename(final_audio)
            raise
        new_size = final_audio.stat().st_size
        log.info(log_event, audiobook_id=str(audiobook_id))
        return new_size

    async def _run_image_phase(
        self,
        *,
        chapters: list[dict[str, Any]],
        abs_dir: Path,
        audiobook_id: UUID,
        output_format: str,
        image_generation_enabled: bool,
        video_width: int,
        video_height: int,
    ) -> list[Path]:
        """Generate one image per chapter via ComfyUI when enabled.

        Skipped entirely (returns ``[]``) when image generation is
        disabled or the output format has no place to display an image
        (``audio_only``). Otherwise:

        - Broadcasts ``images`` stage at 55% and flips every chapter's
          DAG ``image`` to ``in_progress``.
        - Calls ``_generate_chapter_images`` to render the actual PNGs.
        - On success: writes ``image_path`` into each chapter dict and
          flips DAG to ``done``.
        - On any failure: catches, logs a warning, flips every chapter's
          DAG ``image`` to ``failed`` (the audiobook still completes —
          missing chapter images are non-fatal).

        Pulled out of ``generate`` (F-CQ-01 step 7).
        """
        chapter_image_paths: list[Path] = []
        if not (image_generation_enabled and output_format in ("audio_image", "audio_video")):
            return chapter_image_paths

        await self._broadcast_progress(audiobook_id, "images", 55, "Generating chapter images...")
        for ch_idx in range(len(chapters)):
            await self._dag_chapter(ch_idx, "image", "in_progress")
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
                    chapters[i]["image_path"] = f"audiobooks/{audiobook_id}/images/ch{i:03d}.png"
                await self._dag_chapter(i, "image", "done")
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
            for ch_idx in range(len(chapters)):
                await self._dag_chapter(ch_idx, "image", "failed")
        return chapter_image_paths

    async def _run_concat_phase(
        self,
        *,
        all_chunks: list[AudioChunk],
        abs_dir: Path,
        audiobook_id: UUID,
        chapters: list[dict[str, Any]],
    ) -> tuple[Path, list[ChapterTiming]]:
        """Concatenate per-chapter chunks, build the RenderPlan, and
        optionally trim leading silence.

        Returns:
            ``(final_audio_path, chapter_timings)``. The chapters list
            is mutated in-place — each chapter dict gets ``start_seconds``,
            ``end_seconds``, ``duration_seconds`` populated from the
            timings (rounded to 3 decimal places).

        Side effects:
            - Cancellation check at the top of the phase.
            - Progress broadcast at 50% (mixing).
            - DAG ``concat`` transitions: ``in_progress`` → ``done``.
            - ``self._render_plan`` populated; persistence callback fired.
            - When ``self._settings.trim_leading_trailing_silence`` is True,
              shifts every chapter timing by the trimmed offset.

        Pulled out of ``generate`` (F-CQ-01 step 6).
        """
        # 3. Concatenate all chunks with context-aware silence gaps
        await self._check_cancelled(audiobook_id)
        await self._broadcast_progress(audiobook_id, "mixing", 50, "Concatenating audio...")
        final_audio = abs_dir / "audiobook.wav"
        await self._dag_global("concat", "in_progress")
        chapter_timings = await self._concatenate_with_context(all_chunks, final_audio)
        await self._dag_global("concat", "done")

        # Task 13: build the RenderPlan from concat outputs. Inline-only
        # AudioChunk list (overlay SFX excluded — they don't appear on
        # the inline timeline). Chunk durations probed via the FFmpeg
        # service so each event carries a real ``duration_ms`` value.
        # The plan is persisted as an inspectable artifact and
        # consumed by ``list_clips`` + the ID3 CHAP writer; future
        # tasks will rewire concat / captions / track-mix to drive
        # off it directly.
        inline_only = [c for c in all_chunks if not self._is_overlay_sfx(c)]
        chunk_durations: dict[str, float] = {}
        for c in inline_only:
            try:
                chunk_durations[c.path.stem] = await self.ffmpeg.get_duration(c.path)
            except Exception:
                chunk_durations[c.path.stem] = 0.0
        render_plan: RenderPlan = RenderPlan.from_pipeline_outputs(
            audiobook_id=audiobook_id,
            inline_chunks=inline_only,
            chapter_timings=chapter_timings,
            chapters=chapters,
            chunk_durations_seconds=chunk_durations,
        )
        self._render_plan = render_plan
        await self._persist_render_plan(render_plan)

        # 3b. Optional leading/trailing silence trim — runs BEFORE captions,
        # MP3 export, and timing persistence so CHAP frames + ASS captions
        # stay locked to audible boundaries within ±50 ms. Off by default;
        # Task 9 routes the toggle through ``self._settings``.
        if self._settings.trim_leading_trailing_silence:
            leading_offset = await self._trim_silence_in_place(final_audio)
            if leading_offset > 0:
                chapter_timings = self._shift_chapter_timings(chapter_timings, leading_offset)

        # Store timing metadata in chapters
        for timing in chapter_timings:
            if timing.chapter_index < len(chapters):
                chapters[timing.chapter_index]["start_seconds"] = round(timing.start_seconds, 3)
                chapters[timing.chapter_index]["end_seconds"] = round(timing.end_seconds, 3)
                chapters[timing.chapter_index]["duration_seconds"] = round(
                    timing.duration_seconds, 3
                )

        return final_audio, chapter_timings

    async def _run_tts_phase(
        self,
        *,
        chapters: list[dict[str, Any]],
        abs_dir: Path,
        audiobook_id: UUID,
        voice_profile: VoiceProfile,
        voice_casting: dict[str, str] | None,
        speed: float,
        pitch: float,
    ) -> list[AudioChunk]:
        """Render TTS for every chapter and return the concat-input list.

        Honours cancellation between chapters, broadcasts progress
        (5%-50% range — TTS is the bulk of the wall-clock for most
        audiobooks), and routes through ``_generate_multi_voice`` when
        either ``voice_casting`` is non-empty AND there are multiple
        speaker blocks, OR the chapter contains ``[SFX:]`` blocks
        (sequential order matters in either case). Single-speaker
        chapters take the simpler ``_generate_single_voice`` path.

        Pulled out of ``generate`` (F-CQ-01 step 5) — by far the
        biggest single phase, ~75 lines lifted.
        """
        all_chunks: list[AudioChunk] = []
        total_chapters = len(chapters)
        for ch_idx, chapter in enumerate(chapters):
            # Honour the user's Cancel button between chapters. The
            # in-flight TTS / ComfyUI calls aren't interruptible, but
            # we won't queue another chapter once the flag is set.
            await self._check_cancelled(audiobook_id)

            chapter_text = chapter["text"]
            voice_blocks = self._parse_voice_blocks(chapter_text)

            # Task 11: skip TTS work entirely if this chapter is
            # already ``done`` in the DAG. The chunk-cache fast path
            # (Task 1) is the per-chunk equivalent — they coexist.
            tts_already_done = self._dag_chapter_done(ch_idx, "tts")

            pct = 5 + int((ch_idx / total_chapters) * 45)
            await self._broadcast_progress(
                audiobook_id,
                "tts",
                pct,
                f"Generating speech for chapter {ch_idx + 1}/{total_chapters}...",
            )

            await self._dag_chapter(ch_idx, "tts", "in_progress")

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
            await self._dag_chapter(ch_idx, "tts", "done")
            log.debug(
                "audiobook.generate.chapter_done",
                audiobook_id=str(audiobook_id),
                chapter_index=ch_idx,
                chunks=len(chunks),
                tts_already_done=tts_already_done,
            )
        return all_chunks

    async def _reshape_dag_for_chapters(
        self,
        *,
        chapters: list[dict[str, Any]],
        image_generation_enabled: bool,
        output_format: str,
        music_enabled: bool,
        chapter_moods: list[str] | None,
    ) -> None:
        """Reshape the persisted DAG to fit the parsed chapter count
        and mark inapplicable stages as ``skipped`` so the progress
        percentage stays honest.

        Also applies ``chapter_moods[i]`` to each chapter's
        ``music_mood`` slot when supplied (the per-chapter override
        for the global ``music_mood`` arg).

        Pulled out of ``generate`` (F-CQ-01 step 4) so the
        orchestrator stays focused on phase sequencing.
        """
        # Task 11: reshape the DAG to fit the parsed chapter count.
        # Stages that don't apply for this audiobook get marked
        # ``skipped`` up front so the progress percentage is honest.
        self._job_state = _js._normalise(self._job_state, len(chapters))
        if not image_generation_enabled or output_format == "audio_only":
            for ch_key in list(self._job_state["chapters"].keys()):
                self._job_state["chapters"][ch_key]["image"] = "skipped"
        if not music_enabled:
            for ch_key in list(self._job_state["chapters"].keys()):
                self._job_state["chapters"][ch_key]["music"] = "skipped"
        if output_format == "audio_only":
            self._job_state["mp4_export"] = "skipped"
        await self._persist_dag()

        # Apply chapter_moods to chapter metadata
        if chapter_moods:
            for i, chapter in enumerate(chapters):
                if i < len(chapter_moods) and chapter_moods[i]:
                    chapter["music_mood"] = chapter_moods[i]

    @staticmethod
    def _resolve_output_format(output_format: str, generate_video: bool) -> str:
        """Resolve the legacy ``generate_video`` flag.

        Older callers passed ``generate_video=True`` separately from
        ``output_format``. The newer contract is a single
        ``output_format`` value with ``audio_video`` covering the
        old "audio + video" case. This helper bridges the two without
        breaking either form.
        """
        if generate_video and output_format == "audio_only":
            return "audio_video"
        return output_format

    @staticmethod
    def _resolve_video_dims(video_orientation: str) -> tuple[int, int]:
        """Map ``video_orientation`` to ``(width, height)``.

        ``"vertical"`` → 1080 × 1920 (Shorts/TikTok). Anything else
        (including ``"landscape"`` and any unexpected value) →
        1920 × 1080. The default-to-landscape fallback prevents a
        typoed orientation from silently producing a 0×0 video.
        """
        if video_orientation == "vertical":
            return 1080, 1920
        return 1920, 1080

    async def _initialize_call_state(
        self,
        *,
        audiobook_id: UUID,
        title: str,
        initial_job_state: dict[str, Any] | None,
        persist_job_state_cb: Any | None,
        persist_render_plan_cb: Any | None,
    ) -> None:
        """Wire up per-call instance state at the top of ``generate``.

        Side effects:
        - Binds ``audiobook_id`` + ``title`` into the structlog
          contextvars so every helper's log line carries them.
        - Refreshes the ComfyUI server pool from the DB so retries
          always see current servers.
        - Stashes ``audiobook_id`` on the instance for cancellation
          polling inside ``asyncio.gather``'d coroutines.
        - Builds a single ``CancelChecker`` so the 1-second debounce
          survives across helpers rather than resetting per-helper.
        - Hydrates ``self._job_state`` from the worker's persisted
          blob, plus the two persistence callbacks.

        Pulled out of ``generate`` (F-CQ-01 step 2) so the orchestrator
        stays focused on phase sequencing.
        """
        structlog.contextvars.bind_contextvars(
            audiobook_id=str(audiobook_id),
            title=title,
        )

        # Refresh ComfyUI pool from DB so retries always use current servers
        if self.comfyui_service and self.db_session:
            try:
                await self.comfyui_service._pool.sync_from_db(self.db_session)
            except Exception:
                log.warning("audiobook.comfyui_pool_refresh_failed", exc_info=True)

        # Stash audiobook_id on the instance so cancellation polling
        # (Task 4) inside per-chunk gather'd coroutines can reach it
        # without changing helper signatures.
        self._current_audiobook_id = audiobook_id

        # Task 10: debounced cancel poller. Built once per generate
        # call so the 1-second debounce survives across all helpers
        # rather than resetting per-helper.
        self._cancel_checker = CancelChecker(self.redis, audiobook_id)

        # Task 11: per-stage DAG. Hydrated from the worker's persisted
        # blob (``audiobook.job_state``); we reshape to fit the actual
        # parsed chapter count once parsing has run. The persistence
        # callback is invoked after every state transition so a worker
        # crash leaves the DAG at the last successful step.
        self._job_state = initial_job_state or {}
        self._persist_job_state_cb = persist_job_state_cb
        # Task 13: parallel callback for the render_plan_json column.
        self._persist_render_plan_cb = persist_render_plan_cb

    def _apply_settings_and_mix(
        self,
        *,
        audiobook_settings: AudiobookSettings | None,
        ducking_preset: str | None,
        track_mix: dict[str, Any] | None,
        music_volume_db: float,
    ) -> float:
        """Resolve ``audiobook_settings`` + unpack ``track_mix``.

        Mutates the per-call instance state (``self._settings``,
        ``self._ducking_preset``, ``self._track_mix_full``, the six
        gain/mute fields) and returns the (possibly user-gain-adjusted)
        ``music_volume_db`` so the caller can keep using a local var.

        Pulled out of ``generate`` (F-CQ-01) so the orchestrator stays
        focused on phase sequencing rather than instance-state setup.
        """
        # Task 9: ``audiobook_settings`` is the single source of truth.
        # If the caller supplies a settings object, every downstream
        # consumer reads from it; otherwise we fall back to the
        # narrative-default ``AudiobookSettings()`` so existing call
        # sites behave exactly as before. The legacy ``ducking_preset``
        # kwarg from Task 6 still works — when settings is None we
        # build a settings instance carrying that preset.
        if audiobook_settings is None:
            base = AudiobookSettings()
            if ducking_preset is not None:
                base = base.model_copy(update={"ducking_preset": ducking_preset})
            self._settings = base
        else:
            self._settings = audiobook_settings
        # Backwards-compat: the Task-6 dict-shaped preset still feeds
        # ``_build_music_mix_graph``. Sync from settings.
        self._ducking_preset = _resolve_ducking_preset(self._settings.ducking_preset)

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
        return music_volume_db

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
        ducking_preset: str | None = None,
        audiobook_settings: AudiobookSettings | None = None,
        initial_job_state: dict[str, Any] | None = None,
        persist_job_state_cb: Any | None = None,
        persist_render_plan_cb: Any | None = None,
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
        # Bind audiobook_id at the call boundary so every log line
        # produced by helpers further down — including module-level
        # `log = structlog.get_logger(__name__)` callers — carries the
        # id without each helper having to take or rebind it. Cleared
        # in the matching finally so other tasks running on this loop
        # don't inherit the binding.
        # F-CQ-01 step 2: per-call instance state init (log binding,
        # ComfyUI pool refresh, cancel checker, DAG state) extracted
        # into ``_initialize_call_state`` so this orchestrator stays
        # focused on phase sequencing.
        await self._initialize_call_state(
            audiobook_id=audiobook_id,
            title=title,
            initial_job_state=initial_job_state,
            persist_job_state_cb=persist_job_state_cb,
            persist_render_plan_cb=persist_render_plan_cb,
        )

        # F-CQ-01 step 1: settings + track_mix unpacking extracted into
        # ``_apply_settings_and_mix`` so this orchestrator stays focused
        # on phase sequencing rather than per-instance state setup.
        music_volume_db = self._apply_settings_and_mix(
            audiobook_settings=audiobook_settings,
            ducking_preset=ducking_preset,
            track_mix=track_mix,
            music_volume_db=music_volume_db,
        )

        # F-CQ-01 step 3: pure resolution helpers — output_format
        # legacy compat + video dimensions from orientation.
        output_format = self._resolve_output_format(output_format, generate_video)
        video_width, video_height = self._resolve_video_dims(video_orientation)

        output_dir = Path(f"audiobooks/{audiobook_id}")
        abs_dir = self.storage.resolve_path(str(output_dir))
        abs_dir.mkdir(parents=True, exist_ok=True)

        # One-shot purge of pre-hash chunk filenames. Cheap on a clean
        # audiobook (single iterdir + zero unlinks); meaningful only on
        # the first generation after the upgrade to AUDIO_PIPELINE_VERSION
        # >= 2. See ``_purge_legacy_chunks``.
        await self._purge_legacy_chunks(abs_dir)

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

        # F-CQ-01 step 4: DAG reshape + chapter_moods application
        # extracted into ``_reshape_dag_for_chapters``.
        await self._reshape_dag_for_chapters(
            chapters=chapters,
            image_generation_enabled=image_generation_enabled,
            output_format=output_format,
            music_enabled=music_enabled,
            chapter_moods=chapter_moods,
        )

        # F-CQ-01 step 5: per-chapter TTS loop extracted into
        # ``_run_tts_phase`` so this orchestrator stays focused on
        # phase sequencing.
        all_chunks = await self._run_tts_phase(
            chapters=chapters,
            abs_dir=abs_dir,
            audiobook_id=audiobook_id,
            voice_profile=voice_profile,
            voice_casting=voice_casting,
            speed=speed,
            pitch=pitch,
        )

        # F-CQ-01 step 6: concat + RenderPlan + silence trim + chapter
        # timing storage extracted into ``_run_concat_phase``.
        final_audio, chapter_timings = await self._run_concat_phase(
            all_chunks=all_chunks,
            abs_dir=abs_dir,
            audiobook_id=audiobook_id,
            chapters=chapters,
        )

        # 4. Get duration and file size
        duration = await self.ffmpeg.get_duration(final_audio)
        file_size = final_audio.stat().st_size

        # F-CQ-01 step 7: per-chapter image generation extracted
        # into ``_run_image_phase``.
        chapter_image_paths = await self._run_image_phase(
            chapters=chapters,
            abs_dir=abs_dir,
            audiobook_id=audiobook_id,
            output_format=output_format,
            image_generation_enabled=image_generation_enabled,
            video_width=video_width,
            video_height=video_height,
        )

        # F-CQ-01 step 8: music mixing (per-chapter or global) extracted
        # into ``_run_music_phase``.
        file_size = await self._run_music_phase(
            chapters=chapters,
            abs_dir=abs_dir,
            audiobook_id=audiobook_id,
            final_audio=final_audio,
            chapter_timings=chapter_timings,
            duration=duration,
            file_size=file_size,
            music_enabled=music_enabled,
            music_mood=music_mood,
            music_volume_db=music_volume_db,
            per_chapter_music=per_chapter_music,
        )

        # F-CQ-01 step 9: master loudnorm phase extracted into
        # ``_run_master_mix_phase``.
        await self._run_master_mix_phase(
            audiobook_id=audiobook_id,
            final_audio=final_audio,
        )

        # F-CQ-01 step 10: captions phase extracted into
        # ``_run_captions_phase``.
        captions_ass_path, captions_ass_rel, captions_srt_rel = await self._run_captions_phase(
            audiobook_id=audiobook_id,
            abs_dir=abs_dir,
            final_audio=final_audio,
            caption_style_preset=caption_style_preset,
            video_width=video_width,
            video_height=video_height,
        )

        audio_rel_path = f"audiobooks/{audiobook_id}/audiobook.wav"
        video_rel_path: str | None = None
        mp3_rel_path: str | None = None

        # 7. Convert to MP3 + write ID3 tags / chapter markers.
        try:
            await self._dag_global("mp3_export", "in_progress")
            await self._convert_to_mp3(final_audio)
            mp3_rel_path = f"audiobooks/{audiobook_id}/audiobook.mp3"
            await self._dag_global("mp3_export", "done")
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

                await self._dag_global("id3_tags", "in_progress")
                mp3_abs = final_audio.with_suffix(".mp3")
                cover_abs: Path | None = None
                if cover_image_path:
                    maybe_cover = self.storage.resolve_path(cover_image_path)
                    if maybe_cover.exists():
                        cover_abs = maybe_cover

                # Task 13: LAME priming offset. The encoder prepends
                # ~26 ms of silence to the MP3 stream; CHAP frames
                # written without compensation drift relative to the
                # audible audio by that amount. Probe both files,
                # take the difference, shift the plan's chapter
                # timestamps by it. Within ±5 ms of audible
                # boundaries instead of ±50 ms.
                priming_offset_ms = 0
                try:
                    wav_dur = await self.ffmpeg.get_duration(final_audio)
                    mp3_dur = await self.ffmpeg.get_duration(mp3_abs)
                    if wav_dur > 0 and mp3_dur > 0:
                        priming_offset_ms = int(round((mp3_dur - wav_dur) * 1000))
                except Exception:
                    priming_offset_ms = 0

                shifted_plan = self._render_plan.apply_priming_offset(priming_offset_ms)
                # Build chapter dicts in the shape ``write_audiobook_id3``
                # expects (start_seconds / end_seconds / title), but
                # source the timestamps from the priming-adjusted plan.
                id3_chapters: list[dict[str, Any]] = []
                for marker in shifted_plan.chapters:
                    id3_chapters.append(
                        {
                            "title": marker.title,
                            "start_seconds": marker.start_ms / 1000.0,
                            "end_seconds": marker.end_ms / 1000.0,
                        }
                    )

                await write_audiobook_id3(
                    mp3_abs,
                    title=title,
                    album=title,
                    chapters=id3_chapters or (chapters if isinstance(chapters, list) else None),
                    cover_path=cover_abs,
                )
                log.info(
                    "audiobook.generate.id3_tagged",
                    audiobook_id=str(audiobook_id),
                    priming_offset_ms=priming_offset_ms,
                )
                await self._dag_global("id3_tags", "done")
            except Exception as id3_exc:
                log.warning(
                    "audiobook.generate.id3_failed",
                    audiobook_id=str(audiobook_id),
                    error=str(id3_exc),
                )
                await self._dag_global("id3_tags", "failed")
        except Exception as exc:
            log.warning(
                "audiobook.generate.mp3_failed",
                audiobook_id=str(audiobook_id),
                error=str(exc),
            )
            await self._dag_global("mp3_export", "failed")

        # 8. Handle output format
        await self._check_cancelled(audiobook_id)
        await self._broadcast_progress(audiobook_id, "assembly", 90, "Assembling video...")

        if output_format in ("audio_image", "audio_video"):
            await self._dag_global("mp4_export", "in_progress")
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
                        # User-supplied path failed sanitisation or is
                        # outside the storage root — log so they see why
                        # the auto-generated title card replaced their art.
                        log.warning(
                            "audiobook.cover_image_resolve_failed",
                            path=cover_image_path,
                            exc_info=True,
                        )
                if not resolved_cover and background_image_path:
                    try:
                        resolved_cover = str(self.storage.resolve_path(background_image_path))
                    except Exception:
                        log.warning(
                            "audiobook.background_image_resolve_failed",
                            path=background_image_path,
                            exc_info=True,
                        )
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
            await self._dag_global("mp4_export", "done")

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

    # Chapter heading patterns accepted by ``_parse_chapters`` (Task 8).
    # Each pattern exposes a ``title`` named group; matches are scored by
    # ``_score_chapter_split`` and the highest-scoring pattern above
    # threshold wins, so the cascade is "best fit" rather than first-fit.
    #
    # Tightened regex notes:
    #   * Markdown: ``\S`` after the hashes blocks bare ``## ``; the
    #     post-filter requires a blank line above (or BOF) and below.
    #   * Prose chapter: word-number form added (one..twelve), ``CHAP``
    #     short form added, dollar-anchored.
    #   * Roman: length min 2 — lone ``I`` no longer counts.
    #   * All-caps: post-filter rejects rows ending in punctuation that
    #     suggests dialogue / scene cue, and enforces ≥ 80% alpha ratio.
    _CHAPTER_PATTERN_MARKDOWN = r"(?m)^##\s+(?P<title>\S[^\n]{0,80})$"
    _CHAPTER_PATTERN_PROSE = (
        r"(?im)^\s*(?P<title>(?:chapter|chap\.?)\s+"
        r"(?:\d+|[IVXLCDM]+|"
        r"one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
        r"\b[^\n]{0,80})$"
    )
    _CHAPTER_PATTERN_ROMAN = r"(?m)^\s{0,3}(?P<title>[IVXLCDM]{2,8}\s*[.:)]?)\s*$"
    _CHAPTER_PATTERN_ALLCAPS = r"(?m)^\s*(?P<title>[A-Z][A-Z0-9 '\-:,]{3,60})\s*$"

    _SCORE_THRESHOLD = 800.0
    _MIN_SEGMENT_CHARS = 500

    @staticmethod
    def _score_chapter_split(matches: list[re.Match[str]], text: str) -> float:
        """Score a candidate chapter split.

        Higher is better. Two splits are required at minimum; any
        segment shorter than ``_MIN_SEGMENT_CHARS`` returns 0 (false-
        positive guard). Otherwise the score is mean segment length
        divided by ``1 + coefficient_of_variation`` so consistent chunk
        sizes (real chapters) win against noisy ones (false splits).
        """
        if len(matches) < 2:
            return 0.0
        boundaries = [m.start() for m in matches] + [len(text)]
        segs = [boundaries[i + 1] - boundaries[i] for i in range(len(boundaries) - 1)]
        if min(segs) < AudiobookService._MIN_SEGMENT_CHARS:
            return 0.0
        import statistics as _stats

        mean = _stats.mean(segs)
        if mean == 0:
            return 0.0
        cv = _stats.stdev(segs) / mean if len(segs) > 1 else 0.0
        return mean / (1.0 + cv)

    @staticmethod
    def _filter_markdown_matches(matches: list[re.Match[str]], text: str) -> list[re.Match[str]]:
        """Markdown-heading post-filter: require blank line above + below.

        The regex matches every ``## Foo`` line; a heading inside a
        prose paragraph (``some sentence.\n## Note: ...``) shouldn't
        count as a chapter break.
        """
        kept: list[re.Match[str]] = []
        for m in matches:
            start = m.start()
            end = m.end()
            # Above: BOF, or the previous non-newline char is preceded
            # by a blank line.
            above_ok = start == 0 or text[max(0, start - 2) : start] == "\n\n"
            # Below: EOF, or the next char chain is ``\n\n`` or just ``\n``
            # at end of text.
            tail = text[end : end + 2]
            below_ok = end == len(text) or tail.startswith("\n\n") or tail == "\n"
            if above_ok and below_ok:
                kept.append(m)
        return kept

    @staticmethod
    def _filter_allcaps_matches(matches: list[re.Match[str]]) -> list[re.Match[str]]:
        """All-caps post-filter: reject screenplay scene cues + low alpha ratio.

        Real chapter headers (``THE FIRST ENCOUNTER``) are mostly letters.
        Screenplay scene cues (``INT. KITCHEN — DAY``) end in a content
        word but are short enough that the regex would still bite; the
        ratio guard rejects them when the alpha share dips below 80%.
        Rows ending in ``,;:`` are usually mid-sentence fragments.
        """
        kept: list[re.Match[str]] = []
        for m in matches:
            title = m.group("title").strip()
            if not title:
                continue
            if title[-1] in ",;":
                continue
            alpha = sum(1 for c in title if c.isalpha())
            if alpha == 0 or alpha / len(title) < 0.8:
                continue
            kept.append(m)
        return kept

    def _parse_chapters(self, text: str) -> list[dict[str, Any]]:
        """Split text into chapters via scored heading patterns + fallbacks.

        Pattern set tried (Task 8 — scoring, not first-match):
          1. Markdown ``## Title`` headings (blank-line-anchored)
          2. Prose ``Chapter 1`` / ``CHAPTER IV`` / ``chap. one``
          3. Roman numerals ``II.`` (length ≥ 2 — no lone ``I``)
          4. All-caps single-line headings (≥ 80% alpha, no trailing
             ``,;``)
          5. ``---`` horizontal-rule separators (unscored fallback)
          6. Single chapter (final fallback)

        Highest-scoring pattern above ``_SCORE_THRESHOLD`` wins. The
        score is mean-segment-length / (1 + CV); shorter than 500 chars
        per segment automatically scores 0.
        """
        candidates: list[tuple[float, list[re.Match[str]]]] = []

        # Inlined dispatch: post-filters have different signatures
        # (markdown wants ``(matches, text)``; all-caps wants
        # ``(matches,)``; the others take no post-filter), so keep the
        # call sites explicit instead of trying to unify them through a
        # shared callable.
        for pattern in (
            self._CHAPTER_PATTERN_MARKDOWN,
            self._CHAPTER_PATTERN_PROSE,
            self._CHAPTER_PATTERN_ROMAN,
            self._CHAPTER_PATTERN_ALLCAPS,
        ):
            compiled = re.compile(pattern)
            matches = list(compiled.finditer(text))
            if pattern is self._CHAPTER_PATTERN_MARKDOWN:
                matches = self._filter_markdown_matches(matches, text)
            elif pattern is self._CHAPTER_PATTERN_ALLCAPS:
                matches = self._filter_allcaps_matches(matches)
            score = self._score_chapter_split(matches, text)
            if score > 0:
                candidates.append((score, matches))

        if candidates:
            best_score, best_matches = max(candidates, key=lambda c: c[0])
            if best_score >= self._SCORE_THRESHOLD:
                chapters: list[dict[str, Any]] = []
                prologue = text[: best_matches[0].start()].strip()
                if prologue:
                    chapters.append({"title": "Introduction", "text": prologue})
                for i, m in enumerate(best_matches):
                    start = m.end()
                    end = best_matches[i + 1].start() if i + 1 < len(best_matches) else len(text)
                    body = text[start:end].strip()
                    if body:
                        chapters.append(
                            {
                                "title": (m.group("title") or "").strip()[:120],
                                "text": body,
                            }
                        )
                if chapters:
                    return chapters

        # Horizontal-rule separators (unscored fallback — they're
        # explicit and rarely false-positive).
        sections = re.split(r"^---+$", text, flags=re.MULTILINE)
        if len(sections) > 1:
            return [
                {"title": f"Part {i + 1}", "text": s.strip()}
                for i, s in enumerate(sections)
                if s.strip()
            ]

        # Single-chapter final fallback.
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
        """Generate TTS for a single voice, splitting text into chunks.

        Task 4: chunks render concurrently up to the per-provider cap
        from ``_PROVIDER_CONCURRENCY``. Cache hits short-circuit before
        the semaphore so they don't burn a slot.
        """
        provider = self.tts.get_provider(voice_profile)
        voice_id = self.tts._voice_id_for(voice_profile)
        provider_name, model_name = _provider_identity(provider, voice_profile)
        voice_profile_id = str(getattr(voice_profile, "id", "") or "")
        sem = _get_provider_semaphore(provider_name)
        max_chars = _chunk_limit(provider_name)  # Task 12

        chunks = self._split_text(text, max_chars=max_chars)

        async def _render_chunk(i: int, text_chunk: str) -> AudioChunk | None:
            stripped = text_chunk.strip()
            if not stripped or len(stripped) < 2:
                return None

            chunk_hash = _chunk_cache_hash(
                text=text_chunk,
                speaker_id="Narrator",
                voice_profile_id=voice_profile_id,
                provider=provider_name,
                model=model_name,
                speed=speed,
                pitch=pitch,
                sample_rate=24000,
            )
            chunk_path = output_dir / f"ch{chapter_index:03d}_chunk_{i:04d}_{chunk_hash}.wav"
            if chunk_path.exists() and chunk_path.stat().st_size > 100:
                log.debug(
                    "audiobook.generate.chunk_cached",
                    chapter_index=chapter_index,
                    chunk_index=i,
                )
            else:
                async with sem:
                    ok = await self._synthesize_chunk_with_retry(
                        provider,
                        text_chunk,
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
                        chunk_length=len(text_chunk),
                    )
                    await self._generate_silence(chunk_path)

            if not chunk_path.exists():
                return None
            return AudioChunk(
                path=chunk_path,
                chapter_index=chapter_index,
                speaker="Narrator",
                block_index=0,
                chunk_index=i,
            )

        outcomes = await asyncio.gather(
            *(_render_chunk(i, c) for i, c in enumerate(chunks)),
            return_exceptions=True,
        )

        # Re-raise the first cancellation so the worker job marks the
        # audiobook as cancelled rather than failed.
        for outcome in outcomes:
            if isinstance(outcome, asyncio.CancelledError):
                raise outcome

        result: list[AudioChunk] = []
        for outcome in outcomes:
            if isinstance(outcome, AudioChunk):
                result.append(outcome)
            elif isinstance(outcome, Exception):
                log.warning(
                    "audiobook.generate.chunk_exception",
                    chapter_index=chapter_index,
                    error=f"{type(outcome).__name__}: {str(outcome)[:160]}",
                )
        # Stable order regardless of provider completion order.
        result.sort(key=lambda c: c.chunk_index)
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
            provider_name, model_name = _provider_identity(provider, voice_profile)
            voice_profile_id_str = str(getattr(voice_profile, "id", "") or "")
            sem = _get_provider_semaphore(provider_name)
            max_chars = _chunk_limit(provider_name)  # Task 12

            text_chunks = self._split_text(block["text"], max_chars=max_chars)

            async def _render_block_chunk(
                j: int,
                text_chunk: str,
                # Bind closure-captured loop vars into defaults so each
                # gathered coroutine sees its own block / speaker /
                # provider rather than the last-seen iteration values.
                _block_index: int = i,
                _speaker: str = speaker,
                _provider: Any = provider,
                _voice_id: str = voice_id,
                _provider_name: str = provider_name,
                _model_name: str = model_name,
                _voice_profile_id_str: str = voice_profile_id_str,
                _sem: asyncio.Semaphore = sem,
            ) -> AudioChunk | None:
                stripped = text_chunk.strip()
                if not stripped or len(stripped) < 2:
                    return None

                chunk_hash = _chunk_cache_hash(
                    text=text_chunk,
                    speaker_id=_speaker,
                    voice_profile_id=_voice_profile_id_str,
                    provider=_provider_name,
                    model=_model_name,
                    speed=speed,
                    pitch=pitch,
                    sample_rate=24000,
                )
                chunk_path = (
                    output_dir / f"ch{chapter_index:03d}_block_{_block_index:04d}"
                    f"_chunk_{j:04d}_{chunk_hash}.wav"
                )
                if chunk_path.exists() and chunk_path.stat().st_size > 100:
                    log.debug(
                        "audiobook.generate.chunk_cached",
                        chapter_index=chapter_index,
                        block_index=_block_index,
                        chunk_index=j,
                    )
                else:
                    async with _sem:
                        ok = await self._synthesize_chunk_with_retry(
                            _provider,
                            text_chunk,
                            _voice_id,
                            chunk_path,
                            speed=speed,
                            pitch=pitch,
                        )
                    if not ok:
                        log.warning(
                            "audiobook.generate.tts_chunk_failed",
                            chapter_index=chapter_index,
                            block_index=_block_index,
                            speaker=_speaker,
                            chunk_index=j,
                            chunk_length=len(text_chunk),
                        )
                        await self._generate_silence(chunk_path)

                if not chunk_path.exists():
                    return None
                return AudioChunk(
                    path=chunk_path,
                    chapter_index=chapter_index,
                    speaker=_speaker,
                    block_index=_block_index,
                    chunk_index=j,
                )

            block_outcomes = await asyncio.gather(
                *(_render_block_chunk(j, c) for j, c in enumerate(text_chunks)),
                return_exceptions=True,
            )

            for outcome in block_outcomes:
                if isinstance(outcome, asyncio.CancelledError):
                    raise outcome

            block_chunks: list[AudioChunk] = []
            for outcome in block_outcomes:
                if isinstance(outcome, AudioChunk):
                    block_chunks.append(outcome)
                elif isinstance(outcome, Exception):
                    log.warning(
                        "audiobook.generate.chunk_exception",
                        chapter_index=chapter_index,
                        block_index=i,
                        error=f"{type(outcome).__name__}: {str(outcome)[:160]}",
                    )
            block_chunks.sort(key=lambda c: c.chunk_index)
            result.extend(block_chunks)

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

    def _split_text(self, text: str, max_chars: int) -> list[str]:
        """Split text into chunks ≤ *max_chars*, bracket-safe (Task 12).

        Priority:

          1. Paragraph boundaries (``\\n\\n``) — pack whole paragraphs
             when they fit.
          2. Sentence boundaries (``. ! ?``) inside any oversize
             paragraph.
          3. Comma fallback for sentences that themselves exceed
             ``max_chars`` (rare).

        Bracket invariant: split points that fall *inside* a ``[...]``
        group are skipped so a ``[SFX: ...]`` or ``[Speaker]`` tag
        never lands across two chunks.
        """
        text = text.strip()
        if not text:
            return [""]
        if len(text) <= max_chars:
            return [text]

        # 1. Paragraph split → list of paragraph strings.
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        if not paragraphs:
            paragraphs = [text]

        # 2. Within each paragraph, sentence-split if too long.
        units: list[str] = []
        for para in paragraphs:
            if len(para) <= max_chars:
                units.append(para)
                continue
            sentences = re.split(r"(?<=[.!?])\s+", para)
            for sent in sentences:
                sent = sent.strip()
                if not sent:
                    continue
                if len(sent) <= max_chars:
                    units.append(sent)
                else:
                    # 3. Comma fallback for runaway sentences.
                    units.extend(self._split_long_sentence(sent, max_chars))

        # Greedy pack units, preferring ``\n\n`` between paragraph
        # units that started on a paragraph boundary. We approximate
        # that with a single space — the TTS provider doesn't see
        # paragraph spacing as a pause cue; the audiobook's silence
        # gaps come from the inter-chunk silence files anyway.
        chunks: list[str] = []
        current = ""
        for unit in units:
            if not unit:
                continue
            if current and len(current) + 1 + len(unit) > max_chars:
                chunks.append(current)
                current = unit
            else:
                current = f"{current} {unit}" if current else unit
        if current:
            chunks.append(current)

        # Bracket invariant: shift any boundary that splits a
        # ``[...]`` token. Walk pairwise, repair in-place.
        chunks = self._repair_bracket_splits(chunks)

        return chunks or [text]

    @staticmethod
    def _split_long_sentence(sentence: str, max_chars: int) -> list[str]:
        """Comma-fallback for a sentence longer than *max_chars*.

        Falls all the way back to a hard character split if even the
        comma-separated pieces exceed *max_chars* on their own (e.g.
        a URL or a long quoted block with no internal punctuation).
        """
        pieces = [p.strip() for p in re.split(r",\s+", sentence) if p.strip()]
        out: list[str] = []
        current = ""
        for piece in pieces:
            if len(piece) > max_chars:
                # Hard split — no smaller boundary available.
                if current:
                    out.append(current)
                    current = ""
                for i in range(0, len(piece), max_chars):
                    out.append(piece[i : i + max_chars])
                continue
            if current and len(current) + 2 + len(piece) > max_chars:
                out.append(current)
                current = piece
            else:
                current = f"{current}, {piece}" if current else piece
        if current:
            out.append(current)
        return out or [sentence[:max_chars]]

    @staticmethod
    def _repair_bracket_splits(chunks: list[str]) -> list[str]:
        """Ensure no chunk boundary splits a ``[...]`` token.

        Walk pairwise. If chunk N has an unclosed ``[`` and chunk N+1
        starts with the closing portion (contains a ``]`` before the
        next ``[``), shift the unclosed prefix forward into chunk N+1.
        Pathological inputs (deeply nested brackets, unmatched ``]``)
        return unchanged — bracket safety is a best-effort guarantee.
        """
        if len(chunks) < 2:
            return chunks
        out = list(chunks)
        i = 0
        while i < len(out) - 1:
            current = out[i]
            nxt = out[i + 1]
            # Find the last unmatched '[' in current.
            depth = 0
            last_open = -1
            for k, c in enumerate(current):
                if c == "[":
                    depth += 1
                    last_open = k
                elif c == "]":
                    depth -= 1
            if depth > 0 and last_open >= 0 and "]" in nxt:
                # Move the trailing ``[...`` from current into nxt.
                tail = current[last_open:]
                out[i] = current[:last_open].rstrip()
                out[i + 1] = f"{tail} {nxt}".strip()
                if not out[i]:
                    # Current is empty after the shift — drop it.
                    del out[i]
                    continue
            i += 1
        return out

    # ══════════════════════════════════════════════════════════════════════
    # Context-aware audio concatenation
    # ══════════════════════════════════════════════════════════════════════

    # ══════════════════════════════════════════════════════════════════════
    # Audio format probe (Task 7)
    # ══════════════════════════════════════════════════════════════════════
    #
    # Concat used to always re-encode to canonical 44.1 kHz stereo s16le.
    # That's safe but wasteful when every input chunk is already
    # uniform — Piper / Kokoro / Edge all land at 24 kHz mono after the
    # Task-3 ``_safety_filter_chunk`` pass, so the demuxer's stream-copy
    # path produces the same audio in a fraction of the I/O cost.

    @staticmethod
    async def _probe_audio_format(path: Path) -> tuple[int, int, str, str] | None:
        """Return ``(sample_rate, channels, codec_name, sample_fmt)`` or None.

        ``None`` on ffprobe failure / missing audio stream / unparseable
        JSON. Callers treat any ``None`` as "not uniform" and fall back
        to the re-encode concat path.
        """
        cmd = [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate,channels,codec_name,sample_fmt",
            "-of",
            "json",
            str(path),
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            out, _ = await proc.communicate()
            if proc.returncode != 0:
                return None
            data = json.loads(out.decode("utf-8", errors="replace"))
        except (FileNotFoundError, json.JSONDecodeError, ValueError):
            return None
        streams = data.get("streams") or []
        if not streams:
            return None
        s = streams[0]
        try:
            sample_rate = int(s["sample_rate"])
            channels = int(s["channels"])
            codec_name = str(s["codec_name"])
            sample_fmt = str(s.get("sample_fmt") or "")
        except (KeyError, ValueError, TypeError):
            return None
        return sample_rate, channels, codec_name, sample_fmt

    def _pauses(self) -> tuple[float, float, float]:
        """Return ``(within_speaker, between_speakers, between_chapters)``
        in seconds, sourced from ``self._settings`` when available.

        Pre-Task-9 callers (and tests that build a service without
        going through ``generate``) get the module-level defaults.
        """
        settings = getattr(self, "_settings", None) or AudiobookSettings()
        return (
            settings.intra_speaker_silence_ms / 1000.0,
            settings.speaker_change_silence_ms / 1000.0,
            settings.chapter_silence_ms / 1000.0,
        )

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

        # Task 9: silence durations from settings, fall back to constants.
        pause_within, pause_speaker, pause_chapter = self._pauses()

        # Pre-generate silence files for each duration
        silence_files: dict[float, Path] = {}
        for dur in (pause_within, pause_speaker, pause_chapter):
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
            # Editor stores overrides keyed by the hash-stripped stem
            # (``ch003_chunk_0007``) so per-clip mixes survive a
            # voice-profile / speed change that re-hashes the file.
            stable_id = _strip_chunk_hash(chunk.path.stem)
            override = clip_overrides.get(stable_id)
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
                sil = adjusted_dir / f"{stable_id}_muted.wav"
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
            adjusted = adjusted_dir / f"{stable_id}_g{int(gain_db * 10):+d}.wav"
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

        # Build concat list with context-aware silence. Collect the
        # effective paths once so both the concat-list file and the
        # uniformity probe (Task 7) can reuse them without re-running
        # ``_apply_clip_override``.
        ordered_paths: list[Path] = []
        for i, chunk in enumerate(inline_chunks):
            effective_path = await _apply_clip_override(chunk)
            if effective_path is None:
                continue
            ordered_paths.append(effective_path)

            if i < len(inline_chunks) - 1:
                next_chunk = inline_chunks[i + 1]
                if chunk.chapter_index != next_chunk.chapter_index:
                    pause = pause_chapter
                elif chunk.speaker != next_chunk.speaker:
                    pause = pause_speaker
                else:
                    pause = pause_within
                ordered_paths.append(silence_files[pause])

        lines = [f"file '{str(p).replace(chr(92), '/')}'" for p in ordered_paths]
        concat_list.write_text("\n".join(lines), encoding="utf-8")

        # Task 7: probe every input that will go through the concat
        # demuxer. If they share ``(sample_rate, channels, codec,
        # sample_fmt)`` we can use ``-c copy`` and skip the full
        # decode/encode round-trip. Mixed-provider chapters (Piper
        # 24 kHz mono next to ElevenLabs 44.1 kHz stereo) trip the
        # fallback path, which re-encodes to the canonical 44.1 kHz
        # stereo s16le stream — the pre-Task-7 default behaviour,
        # preserved as the safe fallback.
        formats = await asyncio.gather(
            *(self._probe_audio_format(p) for p in ordered_paths),
            return_exceptions=False,
        )
        uniform = (
            len(formats) > 0
            and all(f is not None for f in formats)
            and len({f for f in formats}) == 1
        )

        if uniform:
            log.info(
                "audiobook.concat.stream_copy",
                chunk_count=len(ordered_paths),
                format=formats[0],
            )
            cmd = [
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
            ]
        else:
            mixed_summary = sorted({f for f in formats if f is not None})
            log.info(
                "audiobook.concat.reencode",
                chunk_count=len(ordered_paths),
                distinct_formats=len(mixed_summary),
                formats=mixed_summary,
            )
            cmd = [
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
            ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0 and uniform:
            # Stream-copy failed (rare WAV header mismatch). Retry as
            # re-encode in place rather than losing the audiobook.
            log.warning(
                "audiobook.concat.stream_copy_failed_retrying_reencode",
                stderr=stderr.decode("utf-8", errors="replace")[:200],
            )
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
            await self._dag_global("overlay_sfx", "in_progress")
            try:
                await self._mix_overlay_sfx(
                    base_path=output,
                    chunks_in_order=chunks,
                    inline_chunks=inline_chunks,
                    overlays=overlays,
                )
                await self._dag_global("overlay_sfx", "done")
            except Exception as exc:  # noqa: BLE001
                # Never lose the audiobook because an overlay mix
                # failed — log and continue with the bare inline.
                log.warning(
                    "audiobook.overlay_sfx.mix_failed",
                    error=f"{type(exc).__name__}: {str(exc)[:200]}",
                )
                await self._dag_global("overlay_sfx", "failed")
        else:
            await self._dag_global("overlay_sfx", "skipped")

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
        await self._cancel()  # Task 10: cancel before the single-pass mix.
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

        # Task 9: silence durations from settings.
        pause_within, pause_speaker, pause_chapter = self._pauses()

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
                    t += pause_chapter
                elif a.speaker != b.speaker:
                    t += pause_speaker
                else:
                    t += pause_within
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
                    pause_chapter
                    if inline_chunks[k].chapter_index != inline_chunks[k + 1].chapter_index
                    else (
                        pause_speaker
                        if inline_chunks[k].speaker != inline_chunks[k + 1].speaker
                        else pause_within
                    )
                    for k in range(len(inline_chunks) - 1)
                )
            else:
                start = inline_start(orig_to_inline[next_inline_orig])

            sfx_dur = await self.ffmpeg.get_duration(sfx_chunk.path)
            overlay_plans.append((sfx_chunk.path, start, sfx_dur, float(sfx_chunk.overlay_duck_db)))

        if not overlay_plans:
            return

        # Task 5: single ``filter_complex`` for ALL overlays. The previous
        # implementation ran one ffmpeg invocation per overlay, each
        # decoding + re-encoding the entire audiobook — for 10 overlays
        # on a 1h audiobook that's ~10× the I/O cost of the one-pass
        # graph below. The new chain prepares each SFX in its own branch
        # (adelay → apad → atrim → volume), bus-mixes them with amix,
        # ducks the COMBINED bus against the voice, and amix-es the
        # ducked bus back onto the original voice in a single pass.
        #
        # Note on ducking scope: the sidechain compressor here ducks the
        # SFX bus globally — wherever voice is louder than threshold
        # over the whole audiobook. A targeted "duck only the voice
        # region overlapping each SFX" graph would need an asplit + N
        # concat segments per overlay, which is gnarly enough to make
        # debugging painful. The chapter-wide ducker is the documented
        # trade-off (Task 5 brief).
        #
        # Filter ordering invariant for SFX prep: ``apad`` MUST come
        # before ``atrim``. ``adelay`` adds the lead silence; ``apad``
        # makes the stream long enough to be trimmed cleanly; ``atrim``
        # cuts to the exact end timestamp. Reversing apad/atrim
        # produces hard cuts at the SFX tail.
        tmp_dir = base_path.parent
        mixed = tmp_dir / "_overlay_pass.wav"

        # Per-overlay branches.
        sfx_branches: list[str] = []
        for i, (_path, start_sec, sfx_dur, duck_db) in enumerate(overlay_plans):
            start_ms = max(0, int(start_sec * 1000))
            end_sec = start_sec + sfx_dur
            input_idx = i + 1  # input 0 is the base; SFX inputs start at 1
            sfx_branches.append(
                f"[{input_idx}:a]adelay={start_ms}|{start_ms},apad,"
                f"atrim=0:{end_sec:.2f},"
                f"volume={duck_db:.1f}dB[sfx{i}]"
            )

        # Bus-mix all SFX branches.
        if len(overlay_plans) == 1:
            bus_label = "[sfx0]"
            bus_step = ""
        else:
            sfx_inputs = "".join(f"[sfx{i}]" for i in range(len(overlay_plans)))
            bus_step = (
                f";{sfx_inputs}amix=inputs={len(overlay_plans)}:"
                "duration=longest:dropout_transition=0[sfxbus]"
            )
            bus_label = "[sfxbus]"

        # Sidechain duck the SFX bus against the voice, then amix the
        # ducked bus back over the voice.
        # Task 6: parameters live in ``SFX_DUCKING`` instead of inline
        # constants. Dialogue-friendly defaults (faster attack, faster
        # release, gentler ratio) than the pre-Task-6 numerics.
        sfx_threshold = SFX_DUCKING["threshold"]
        sfx_ratio = SFX_DUCKING["ratio"]
        sfx_attack = SFX_DUCKING["attack"]
        sfx_release = SFX_DUCKING["release"]
        graph = (
            ";".join(sfx_branches)
            + bus_step
            + f";{bus_label}[0:a]sidechaincompress=threshold={sfx_threshold}"
            f":ratio={sfx_ratio}:attack={sfx_attack}:release={sfx_release}[ducked]"
            + ";[0:a][ducked]amix=inputs=2:duration=longest:"
            "dropout_transition=0[out]"
        )

        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(base_path),
        ]
        for path, _start_sec, _sfx_dur, _duck_db in overlay_plans:
            cmd.extend(["-i", str(path)])
        cmd.extend(
            [
                "-filter_complex",
                graph,
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
        )

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0 or not mixed.exists():
            log.warning(
                "audiobook.overlay_sfx.single_pass_failed",
                overlay_count=len(overlay_plans),
                rc=proc.returncode,
                stderr=err.decode("utf-8", errors="replace")[:300],
            )
            mixed.unlink(missing_ok=True)
            return

        mixed.replace(base_path)
        log.info(
            "audiobook.overlay_sfx.mixed_single_pass",
            overlay_count=len(overlay_plans),
            duck_db=[round(p[3], 1) for p in overlay_plans],
        )

    async def _compute_chapter_timings(self, chunks: list[AudioChunk]) -> list[ChapterTiming]:
        """Compute chapter start/end times from chunk audio durations."""
        # Task 9: silence durations from settings.
        pause_within, pause_speaker, pause_chapter = self._pauses()

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
                chapter_start = current_time + pause_chapter
                current_chapter = chunk.chapter_index

            current_time += dur

            # Add pause duration
            if i < len(chunks) - 1:
                next_chunk = chunks[i + 1]
                if chunk.chapter_index != next_chunk.chapter_index:
                    current_time += pause_chapter
                elif chunk.speaker != next_chunk.speaker:
                    current_time += pause_speaker
                else:
                    current_time += pause_within

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
                # Task 10: cancel poll before each ComfyUI submit.
                await self._cancel()
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
                    # Use ComfyUI pool to generate image. Audiobooks
                    # without a configured ComfyUI server have no way
                    # to render chapter art — fall back to title cards
                    # rather than crash with AttributeError.
                    if self.comfyui_service is None:
                        log.info(
                            "audiobook.image_generation_skipped_no_comfyui",
                            chapter=ch_idx,
                        )
                        return None
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
        await self._cancel()  # Task 10: cancel before music gen + ffmpeg.
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
        # Task 3: per-track and master loudnorm passes were stripped from
        # this filter graph. The single audible loudnorm runs once at the
        # master stage (``_apply_master_loudnorm``) AFTER music + SFX are
        # mixed in, so chained loudnorm passes can't compound into
        # inter-sentence pumping. ``alimiter=0.95`` keeps inter-sample
        # peaks safe through the mix.
        voice_gain_db = float(getattr(self, "_voice_gain_db", 0.0) or 0.0)
        sfx_gain_db = float(getattr(self, "_sfx_gain_db", 0.0) or 0.0)  # noqa: F841 (reserved)

        # Task 5: pad music to at least voice duration so it never dries
        # up before the voiceover ends. Without this, ``amix`` (with
        # ``duration=longest``) would output silence under the tail of
        # any chapter where the resolved music track was shorter than
        # the voice. ``apad`` pads with silence at the end — preferable
        # to ``aloop``, which would seam-loop the music and audibly
        # restart at the worst possible moment.
        try:
            voice_dur_seconds = await self.ffmpeg.get_duration(audio_path)
        except Exception:
            voice_dur_seconds = duration  # fall back to caller-provided
        voice_pad_ms = max(0, int(voice_dur_seconds * 1000))

        # Task 6: ducking parameters come from the resolved preset.
        # ``static`` mode skips sidechain entirely — music sits at a
        # fixed volume under voice, no pumping. Sidechain modes apply
        # threshold/ratio/attack/release from the preset dict.
        preset = getattr(self, "_ducking_preset", None) or DUCKING_PRESETS[DEFAULT_DUCKING_PRESET]
        graph = _build_music_mix_graph(
            preset=preset,
            voice_gain_db=voice_gain_db,
            music_volume_db=volume_db,
            music_pad_ms=voice_pad_ms,
        )

        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(audio_path),
            "-i",
            str(music_path),
            "-filter_complex",
            graph,
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
        await self._cancel()  # Task 10: cancel before per-chapter music gen.
        music_svc = self._resolve_music_service()
        if music_svc is None:
            return audio_path

        music_dir = audio_path.parent / "music"
        music_dir.mkdir(parents=True, exist_ok=True)

        # Generate music for each chapter
        chapter_music_paths: list[Path | None] = []
        for i, timing in enumerate(chapter_timings):
            await self._cancel()  # Task 10: poll between per-chapter music calls.
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
        # Task 3: same gain-staging change as ``_add_music`` — no per-track
        # or master loudnorm here. Single audible pass runs in
        # ``_apply_master_loudnorm`` after this mix completes.
        # Task 5: pad the chapter-music track to voice duration so the
        # acrossfaded music chain doesn't dry up before the voiceover
        # ends. See ``_add_music`` for the rationale.
        try:
            voice_dur_seconds = await self.ffmpeg.get_duration(audio_path)
        except Exception:
            voice_dur_seconds = sum(t.duration_seconds for t in chapter_timings)
        voice_pad_ms = max(0, int(voice_dur_seconds * 1000))

        preset = getattr(self, "_ducking_preset", None) or DUCKING_PRESETS[DEFAULT_DUCKING_PRESET]
        graph = _build_music_mix_graph(
            preset=preset,
            voice_gain_db=voice_gain_db,
            music_volume_db=volume_db,
            music_pad_ms=voice_pad_ms,
        )

        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(audio_path),
            "-i",
            str(combined_music),
            "-filter_complex",
            graph,
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
    # Optional leading/trailing silence trim (Task 2)
    # ══════════════════════════════════════════════════════════════════════
    #
    # Runs on the concatenated WAV BEFORE chapter timings, captions, and
    # MP3 export are produced. Returns the leading-silence offset in
    # seconds so callers can subtract it from any timing data computed
    # earlier in the pipeline. Off by default (PRESERVE_INTERNAL_PAUSES).
    #
    # Implementation: probe the original WAV duration, then run an
    # anchored silenceremove pass that only strips the leading and
    # trailing edges. Compare durations to recover the leading offset.
    # We can't directly read silenceremove's offset from stderr — ffmpeg
    # only emits an unparseable summary — so we infer it from a second
    # probe that strips trailing silence only (areverse + silenceremove +
    # areverse). Two ffmpeg passes total; cheap on a single audiobook.

    async def _trim_silence_in_place(self, wav_path: Path) -> float:
        """Trim leading + trailing silence from *wav_path* in place.

        Returns the leading-silence offset (seconds) that was removed,
        so callers can shift any chapter timings or caption timestamps
        that were computed against the un-trimmed WAV. Returns 0.0 if
        the trim failed (left the original file untouched).
        """
        try:
            original_duration = await self.ffmpeg.get_duration(wav_path)
        except Exception:
            return 0.0

        # Pass 1: trailing-only trim (reverse, strip leading-as-trailing,
        # reverse back). The resulting duration tells us how much
        # trailing silence the original had.
        trailing_only = wav_path.with_suffix(".trail.wav")
        cmd_trailing = [
            "ffmpeg",
            "-y",
            "-i",
            str(wav_path),
            "-af",
            "areverse,"
            "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-40dB,"
            "areverse",
            "-c:a",
            "pcm_s16le",
            str(trailing_only),
        ]
        proc1 = await asyncio.create_subprocess_exec(
            *cmd_trailing,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc1.communicate()
        if proc1.returncode != 0 or not trailing_only.exists():
            return 0.0

        # Pass 2: full leading + trailing trim. Compare the duration
        # difference between (trailing-only) and (both) to recover the
        # leading offset.
        both = wav_path.with_suffix(".trim.wav")
        cmd_both = [
            "ffmpeg",
            "-y",
            "-i",
            str(trailing_only),
            "-af",
            "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-40dB",
            "-c:a",
            "pcm_s16le",
            str(both),
        ]
        proc2 = await asyncio.create_subprocess_exec(
            *cmd_both,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc2.communicate()
        if proc2.returncode != 0 or not both.exists():
            trailing_only.unlink(missing_ok=True)
            return 0.0

        try:
            trailing_only_dur = await self.ffmpeg.get_duration(trailing_only)
            trimmed_dur = await self.ffmpeg.get_duration(both)
        except Exception:
            trailing_only.unlink(missing_ok=True)
            both.unlink(missing_ok=True)
            return 0.0

        leading_offset = max(0.0, trailing_only_dur - trimmed_dur)
        # Replace the original WAV with the fully trimmed copy.
        try:
            both.replace(wav_path)
        except OSError:
            trailing_only.unlink(missing_ok=True)
            both.unlink(missing_ok=True)
            return 0.0
        trailing_only.unlink(missing_ok=True)

        log.info(
            "audiobook.silence_trim.applied",
            original_duration=round(original_duration, 3),
            trimmed_duration=round(trimmed_dur, 3),
            leading_offset=round(leading_offset, 3),
            trailing_offset=round(original_duration - trailing_only_dur, 3),
        )
        return leading_offset

    @staticmethod
    def _shift_chapter_timings(
        timings: list[ChapterTiming], offset_seconds: float
    ) -> list[ChapterTiming]:
        """Subtract *offset_seconds* from every chapter start/end so the
        timings still match the audible boundaries after a leading-trim.
        """
        if offset_seconds <= 0:
            return timings
        shifted: list[ChapterTiming] = []
        for t in timings:
            new_start = max(0.0, t.start_seconds - offset_seconds)
            new_end = max(new_start, t.end_seconds - offset_seconds)
            shifted.append(
                ChapterTiming(
                    chapter_index=t.chapter_index,
                    start_seconds=new_start,
                    end_seconds=new_end,
                    duration_seconds=new_end - new_start,
                )
            )
        return shifted

    # ══════════════════════════════════════════════════════════════════════
    # Master loudnorm (Task 3)
    # ══════════════════════════════════════════════════════════════════════
    #
    # Runs once on the fully-mixed WAV, after voice + SFX + music are
    # combined and before captions / MP3 / video. EBU R128 two-pass
    # measure-then-apply: pass 1 measures the integrated loudness, pass 2
    # applies the corrected gain with ``linear=true`` so the algorithm
    # converges to the target on a single application.
    #
    # If pass 1's stderr can't be parsed (ffmpeg version mismatch, audio
    # too short for the measurement window, etc.) we fall back to a
    # single-pass loudnorm — within ~±1 LUFS instead of ±0.5, but still
    # produces a usable mastered file rather than failing the audiobook.

    # Loudnorm prints a summary banner before the JSON block when
    # ``print_format=json`` is set. The block always carries an
    # ``input_i`` key, so we anchor the search there.
    _LOUDNORM_JSON_RE = re.compile(
        r"(\{[^{}]*\"input_i\"[^{}]*\})",
        re.DOTALL,
    )

    @classmethod
    def _parse_loudnorm_json(cls, stderr_text: str) -> dict[str, str] | None:
        """Extract loudnorm pass-1 measurements from ffmpeg stderr.

        Returns ``None`` if the JSON block can't be located or is
        missing any required field. Required fields are the five values
        pass 2 needs: ``input_i``, ``input_tp``, ``input_lra``,
        ``input_thresh``, ``target_offset``.
        """
        match = cls._LOUDNORM_JSON_RE.search(stderr_text)
        if not match:
            return None
        try:
            data = json.loads(match.group(1))
        except (json.JSONDecodeError, ValueError):
            return None
        required = {
            "input_i",
            "input_tp",
            "input_lra",
            "input_thresh",
            "target_offset",
        }
        if not required.issubset(data.keys()):
            return None
        return {k: str(data[k]) for k in required}

    async def _apply_master_loudnorm(self, wav_path: Path) -> None:
        """Master loudnorm pass on *wav_path*. Replaces in place.

        Two-pass when possible (±0.5 LUFS); single-pass fallback when
        pass 1 measurements can't be parsed (~±1 LUFS).
        """
        await self._cancel()  # Task 10: cancel before each major ffmpeg pass.
        # Task 9: targets come from ``self._settings`` so platform
        # presets (narrative / podcast / streaming / acx) reach the
        # actual ffmpeg invocation. Pre-Task-9 callers without a
        # service-level settings object get the narrative defaults.
        settings = getattr(self, "_settings", None) or AudiobookSettings()
        target_i = settings.loudness_target_lufs
        target_tp = settings.true_peak_dbfs
        target_lra = settings.loudness_lra
        export_sample_rate = settings.sample_rate

        # Pass 1: measure only. ``-f null -`` discards the audio output;
        # we only care about stderr.
        measure_cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(wav_path),
            "-af",
            (f"loudnorm=I={target_i}:TP={target_tp}:LRA={target_lra}:print_format=json"),
            "-f",
            "null",
            "-",
        ]
        proc = await asyncio.create_subprocess_exec(
            *measure_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        measurements: dict[str, str] | None = None
        if proc.returncode == 0:
            measurements = self._parse_loudnorm_json(err.decode("utf-8", errors="replace"))

        out_tmp = wav_path.with_suffix(".master.wav")
        if measurements is not None:
            # Pass 2: apply with measured values + ``linear=true`` for
            # single-pass corrected gain.
            af = (
                f"loudnorm=I={target_i}:TP={target_tp}:LRA={target_lra}"
                f":measured_I={measurements['input_i']}"
                f":measured_TP={measurements['input_tp']}"
                f":measured_LRA={measurements['input_lra']}"
                f":measured_thresh={measurements['input_thresh']}"
                f":offset={measurements['target_offset']}"
                ":linear=true"
                ":print_format=summary"
            )
        else:
            # Fallback: single-pass loudnorm. Less accurate, still safe.
            log.warning(
                "audiobook.master_loudnorm.measure_failed_falling_back_to_single_pass",
                rc=proc.returncode,
            )
            af = f"loudnorm=I={target_i}:TP={target_tp}:LRA={target_lra}:print_format=summary"

        apply_cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(wav_path),
            "-af",
            af,
            "-ar",
            str(export_sample_rate),
            "-ac",
            "2",
            "-c:a",
            "pcm_s16le",
            str(out_tmp),
        ]
        proc2 = await asyncio.create_subprocess_exec(
            *apply_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err2 = await proc2.communicate()
        if proc2.returncode != 0 or not out_tmp.exists() or out_tmp.stat().st_size < 1024:
            log.warning(
                "audiobook.master_loudnorm.apply_failed",
                rc=proc2.returncode,
                stderr=err2.decode("utf-8", errors="replace")[:200],
            )
            out_tmp.unlink(missing_ok=True)
            return

        try:
            out_tmp.replace(wav_path)
        except OSError as exc:
            log.warning(
                "audiobook.master_loudnorm.replace_failed",
                error=str(exc)[:120],
            )
            out_tmp.unlink(missing_ok=True)
            return

        log.info(
            "audiobook.master_loudnorm.applied",
            target_i=target_i,
            target_tp=target_tp,
            target_lra=target_lra,
            two_pass=measurements is not None,
        )

    # ══════════════════════════════════════════════════════════════════════
    # MP3 conversion
    # ══════════════════════════════════════════════════════════════════════

    async def _convert_to_mp3(self, wav_path: Path) -> Path:
        """Convert a WAV file to MP3 using the configured encoder mode.

        Task 2 removed ``silenceremove`` from the export chain so
        internal pauses survive. Task 3 removed ``loudnorm`` — the
        single audible loudnorm pass runs once at the master stage
        before this encoder call. Task 9 makes the encoder mode
        configurable: ``cbr_128 / cbr_192 / cbr_256 / vbr_v0 / vbr_v2``.
        """
        mp3_path = wav_path.with_suffix(".mp3")
        settings = getattr(self, "_settings", None) or AudiobookSettings()
        encoder_args = _mp3_encoder_args(settings.mp3_mode)
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(wav_path),
            *encoder_args,
            str(mp3_path),
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            # Task 3: previously a retry-without-filters fallback ran here
            # to defend against ffmpeg loudnorm-version incompatibilities.
            # The encoder no longer applies any filter, so the primary
            # command IS the raw fallback — there's nothing left to fall
            # back to.
            raise RuntimeError(
                f"Failed to convert to MP3: {stderr.decode('utf-8', 'replace')[:300]}"
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

        slug = hashlib.sha1(
            title.encode("utf-8", errors="replace"),
            usedforsecurity=False,
        ).hexdigest()[:8]
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
        await self._cancel()  # Task 10: cancel before x264/x265 encode.
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

        # Task 9: video codec / CRF / preset from settings.
        settings = getattr(self, "_settings", None) or AudiobookSettings()
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
            settings.video_codec,
            "-crf",
            str(settings.video_crf),
            "-preset",
            settings.video_preset,
            "-pix_fmt",
            "yuv420p",
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
        assert proc.stderr is not None  # PIPE'd above; mypy can't narrow
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
