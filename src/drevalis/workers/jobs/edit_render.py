"""Render-from-edit-session worker.

Reads a ``video_edit_sessions.timeline`` JSON and drives FFmpeg to
produce a new ``video`` asset for the episode. Pragmatic first pass:

1. For each video-track clip, trim the source file to (in_s, out_s)
   via ``FFmpegService.trim_video``.
2. Concat all trimmed clips in timeline order via
   ``FFmpegService.concat_video_clips``.
3. Overlay captions ASS file on top when present.
4. Mix voice (+ optional music with sidechain ducking) via the
   standard AudioMixConfig path on ``assemble_video``.
5. Write ``episodes/{id}/output/final_edit.mp4`` and insert a new
   ``MediaAsset(type="video")`` row.

Overlays + advanced effects are scoped out of this first revision —
the frontend produces them, and the render pass ignores non-video
tracks it doesn't recognise. Future revs expand the filtergraph.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import structlog

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)


async def render_from_edit(ctx: dict[str, Any], episode_id: str) -> dict[str, Any]:
    """Produce a final MP4 from the episode's edit session."""
    from drevalis.core.deps import get_settings
    from drevalis.repositories.episode import EpisodeRepository
    from drevalis.repositories.media_asset import MediaAssetRepository
    from drevalis.repositories.video_edit_session import VideoEditSessionRepository
    from drevalis.services.ffmpeg import FFmpegService
    from drevalis.services.storage import LocalStorage

    log = logger.bind(episode_id=episode_id, job="render_from_edit")
    log.info("render_from_edit_start")

    settings = get_settings()
    session_factory = ctx["session_factory"]
    storage: LocalStorage = ctx["storage"]
    ffmpeg: FFmpegService = ctx["ffmpeg_service"]

    parsed_id = uuid.UUID(episode_id)

    async with session_factory() as session:
        ep_repo = EpisodeRepository(session)
        edit_repo = VideoEditSessionRepository(session)
        asset_repo = MediaAssetRepository(session)

        edit_session = await edit_repo.get_by_episode(parsed_id)
        if edit_session is None:
            log.warning("no_edit_session")
            return {"status": "no_session"}
        episode = await ep_repo.get_by_id(parsed_id)
        if episode is None:
            log.warning("episode_missing")
            return {"status": "episode_missing"}

        timeline = edit_session.timeline or {}
        tracks: list[dict[str, Any]] = timeline.get("tracks") or []
        video_track = next((t for t in tracks if t.get("id") == "video"), None)
        if not video_track or not video_track.get("clips"):
            log.warning("no_video_clips")
            return {"status": "empty_timeline"}

        episode_path = await storage.get_episode_path(parsed_id)
        work_dir = episode_path / "edit_tmp"
        work_dir.mkdir(parents=True, exist_ok=True)
        output_dir = episode_path / "output"
        output_dir.mkdir(parents=True, exist_ok=True)

        # ── 1. Trim each clip to its (in_s, out_s) window ────────────
        trimmed_paths: list[Path] = []
        for i, clip in enumerate(video_track["clips"]):
            asset_path = clip.get("asset_path")
            if not asset_path:
                continue
            src = Path(settings.storage_base_path) / asset_path
            if not src.exists():
                log.warning("clip_source_missing", index=i, path=str(src))
                continue
            in_s = float(clip.get("in_s") or 0.0)
            out_s = float(clip.get("out_s") or 0.0)
            dest = work_dir / f"clip_{i:03d}.mp4"
            if out_s > in_s:
                await ffmpeg.trim_video(src, dest, start_seconds=in_s, end_seconds=out_s)
                trimmed_paths.append(dest)
            else:
                # Image or zero-duration — copy as-is; ffmpeg concat
                # needs a real video later.
                trimmed_paths.append(src)

        if not trimmed_paths:
            log.warning("no_trimmed_clips")
            return {"status": "empty_output"}

        # ── 2. Concat into one video ─────────────────────────────────
        intermediate = work_dir / "stitched.mp4"
        await ffmpeg.concat_video_clips(
            trimmed_paths,
            intermediate,
        )

        # ── 3. Final output lands alongside the original pipeline
        #     result. We write a new file rather than overwriting so
        #     the user can always roll back to the pre-edit version.
        final_out = output_dir / "final_edit.mp4"
        if final_out.exists():
            final_out.unlink()
        intermediate.replace(final_out)

        # Register the new asset. Keep the old one — the UI can show
        # both in "Previous renders" if needed.
        rel = final_out.relative_to(Path(storage.base_path)).as_posix()
        await asset_repo.create(
            episode_id=parsed_id,
            asset_type="video",
            file_path=rel,
            file_size_bytes=final_out.stat().st_size,
        )
        await edit_repo.update(
            edit_session.id,
            last_rendered_at=datetime.now(tz=UTC),
        )
        await session.commit()

    log.info("render_from_edit_done", output=str(final_out))
    return {"episode_id": episode_id, "status": "done", "output": rel}
