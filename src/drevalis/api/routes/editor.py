"""Video editor session routes.

One session row per episode. ``GET`` auto-creates a session seeded
from the episode's existing scenes/voice/music. ``PUT`` overwrites
the timeline. ``POST /render`` enqueues an FFmpeg render.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from drevalis.core.deps import get_db
from drevalis.core.redis import get_arq_pool
from drevalis.repositories.episode import EpisodeRepository
from drevalis.repositories.media_asset import MediaAssetRepository
from drevalis.repositories.video_edit_session import VideoEditSessionRepository
from drevalis.schemas.script import EpisodeScript

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

router = APIRouter(tags=["editor"])


class EditSessionResponse(BaseModel):
    id: UUID
    episode_id: UUID
    version: int
    timeline: dict[str, Any]
    last_render_job_id: UUID | None
    last_rendered_at: datetime | None


class TimelineUpdate(BaseModel):
    timeline: dict[str, Any]


async def _seed_timeline_from_episode(
    episode_id: UUID,
    db: AsyncSession,
) -> dict[str, Any]:
    """Build a starter timeline from the episode's existing scenes and
    voice / music assets. One clip per scene on the video track,
    voiceover on the audio track, music (if set) on its own track.
    """
    ep_repo = EpisodeRepository(db)
    episode = await ep_repo.get_by_id(episode_id)
    if episode is None:
        return {"duration_s": 0.0, "tracks": []}

    asset_repo = MediaAssetRepository(db)

    video_clips: list[dict[str, Any]] = []
    voice_clips: list[dict[str, Any]] = []
    music_clips: list[dict[str, Any]] = []

    running = 0.0
    # Tolerate malformed / stale scripts — the editor should open with
    # an empty timeline rather than 500. Fills in missing ``title`` from
    # the episode row so strict EpisodeScript validation passes.
    script = None
    if episode.script:
        raw_script = dict(episode.script) if isinstance(episode.script, dict) else {}
        if not raw_script.get("title"):
            raw_script["title"] = episode.title or "Untitled episode"
        try:
            script = EpisodeScript.model_validate(raw_script)
        except Exception as exc:
            logger.warning(
                "editor_seed_script_invalid",
                episode_id=str(episode_id),
                error=str(exc)[:200],
            )
            script = None

    if script:
        scene_assets_by_number: dict[int, Any] = {}
        for a in await asset_repo.get_by_episode_and_type(episode_id, "scene"):
            if a.scene_number is not None:
                scene_assets_by_number[a.scene_number] = a
        for a in await asset_repo.get_by_episode_and_type(episode_id, "scene_video"):
            if a.scene_number is not None:
                scene_assets_by_number[a.scene_number] = a

        for scene in script.scenes:
            dur = float(scene.duration_seconds or 0)
            asset = scene_assets_by_number.get(scene.scene_number)
            video_clips.append(
                {
                    "id": f"v-{scene.scene_number}",
                    "scene_number": scene.scene_number,
                    "source": "scene",
                    "asset_path": asset.file_path if asset else None,
                    "in_s": 0.0,
                    "out_s": dur,
                    "start_s": round(running, 3),
                    "end_s": round(running + dur, 3),
                    "speed": 1.0,
                }
            )
            running += dur

    voiceovers = await asset_repo.get_by_episode_and_type(episode_id, "voiceover")
    if voiceovers:
        va = voiceovers[-1]
        voice_clips.append(
            {
                "id": "voice-main",
                "asset_path": va.file_path,
                "in_s": 0.0,
                "out_s": va.duration_seconds or running,
                "start_s": 0.0,
                "end_s": va.duration_seconds or running,
                "gain_db": 0.0,
            }
        )

    meta = episode.metadata_ or {}
    selected_music_path = meta.get("selected_music_path") if isinstance(meta, dict) else None
    if selected_music_path:
        music_clips.append(
            {
                "id": "music-main",
                "asset_path": selected_music_path,
                "in_s": 0.0,
                "out_s": running,
                "start_s": 0.0,
                "end_s": running,
                "gain_db": -18.0,  # low floor, sidechain in render
                "duck_to_voice": True,
            }
        )

    return {
        "duration_s": round(running, 3),
        "tracks": [
            {"id": "video", "kind": "video", "clips": video_clips},
            {"id": "voice", "kind": "audio", "clips": voice_clips},
            {"id": "music", "kind": "audio", "clips": music_clips},
            {"id": "overlay", "kind": "overlay", "clips": []},
            {"id": "captions", "kind": "captions", "clips": []},
        ],
    }


@router.get(
    "/api/v1/episodes/{episode_id}/editor",
    response_model=EditSessionResponse,
)
async def get_editor_session(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> EditSessionResponse:
    """Return the edit session for this episode, auto-creating it from
    the current scene state if one doesn't yet exist.
    """
    ep_repo = EpisodeRepository(db)
    if await ep_repo.get_by_id(episode_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "episode_not_found")

    repo = VideoEditSessionRepository(db)
    session = await repo.get_by_episode(episode_id)
    if session is None:
        timeline = await _seed_timeline_from_episode(episode_id, db)
        session = await repo.create(
            episode_id=episode_id,
            version=1,
            timeline=timeline,
        )
        await db.commit()
    return EditSessionResponse.model_validate(
        {
            "id": session.id,
            "episode_id": session.episode_id,
            "version": session.version,
            "timeline": session.timeline,
            "last_render_job_id": session.last_render_job_id,
            "last_rendered_at": session.last_rendered_at,
        }
    )


@router.put(
    "/api/v1/episodes/{episode_id}/editor",
    response_model=EditSessionResponse,
)
async def save_editor_session(
    episode_id: UUID,
    body: TimelineUpdate,
    db: AsyncSession = Depends(get_db),
) -> EditSessionResponse:
    """Overwrite the timeline. The editor autosaves; callers should
    debounce so we aren't doing one commit per keystroke.
    """
    repo = VideoEditSessionRepository(db)
    session = await repo.get_by_episode(episode_id)
    if session is None:
        session = await repo.create(
            episode_id=episode_id,
            version=1,
            timeline=body.timeline,
        )
    else:
        session = await repo.update(session.id, timeline=body.timeline) or session
    await db.commit()
    return EditSessionResponse.model_validate(
        {
            "id": session.id,
            "episode_id": session.episode_id,
            "version": session.version,
            "timeline": session.timeline,
            "last_render_job_id": session.last_render_job_id,
            "last_rendered_at": session.last_rendered_at,
        }
    )


@router.post(
    "/api/v1/episodes/{episode_id}/editor/render",
    status_code=status.HTTP_202_ACCEPTED,
)
async def render_editor_session(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """Enqueue an FFmpeg render from the current timeline."""
    repo = VideoEditSessionRepository(db)
    session = await repo.get_by_episode(episode_id)
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no edit session")

    arq = get_arq_pool()
    await arq.enqueue_job("render_from_edit", str(episode_id))
    await repo.update(
        session.id,
        last_rendered_at=datetime.now(tz=UTC),
    )
    await db.commit()
    logger.info("editor_render_enqueued", episode_id=str(episode_id))
    return {"status": "enqueued"}


# ── Caption word editor ─────────────────────────────────────────────


class CaptionWord(BaseModel):
    word: str
    start_seconds: float
    end_seconds: float
    emphasis: bool = False
    color: str | None = None


class CaptionWordsPayload(BaseModel):
    words: list[CaptionWord]


def _words_storage_path(episode_id: UUID, storage_base: str) -> Path:
    return Path(storage_base) / "episodes" / str(episode_id) / "captions" / "words.json"


@router.get(
    "/api/v1/episodes/{episode_id}/editor/captions",
    response_model=CaptionWordsPayload,
)
async def get_captions(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> CaptionWordsPayload:
    """Return the editable word-level caption list for the episode."""
    import json

    from drevalis.core.deps import get_settings

    ep_repo = EpisodeRepository(db)
    if await ep_repo.get_by_id(episode_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "episode_not_found")

    settings = get_settings()
    path = _words_storage_path(episode_id, str(settings.storage_base_path))

    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return CaptionWordsPayload(
                words=[CaptionWord.model_validate(w) for w in data.get("words", [])]
            )
        except Exception:
            pass
    return CaptionWordsPayload(words=[])


@router.put(
    "/api/v1/episodes/{episode_id}/editor/captions",
    response_model=CaptionWordsPayload,
)
async def put_captions(
    episode_id: UUID,
    body: CaptionWordsPayload,
    db: AsyncSession = Depends(get_db),
) -> CaptionWordsPayload:
    """Overwrite the word-level caption list. The render worker reads
    this file (when present) to produce an edited ASS before burning
    captions over the final video.
    """
    import json

    from drevalis.core.deps import get_settings

    ep_repo = EpisodeRepository(db)
    if await ep_repo.get_by_id(episode_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "episode_not_found")

    settings = get_settings()
    path = _words_storage_path(episode_id, str(settings.storage_base_path))
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"words": [w.model_dump() for w in body.words]}
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    logger.info(
        "captions_overwritten",
        episode_id=str(episode_id),
        words=len(body.words),
    )
    return body


# ── Waveform generation ─────────────────────────────────────────────


@router.get(
    "/api/v1/episodes/{episode_id}/editor/waveform",
)
async def get_waveform(
    episode_id: UUID,
    track: str = "voice",
    db: AsyncSession = Depends(get_db),
) -> Any:
    """Render (or reuse) a waveform PNG for the voice or music track
    and stream it. Returns 404 if the track has no source asset.
    """
    from fastapi.responses import FileResponse

    from drevalis.core.deps import get_settings

    if track not in ("voice", "music"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "track must be 'voice' or 'music'")

    settings = get_settings()
    asset_type = "voiceover" if track == "voice" else "music"

    asset_repo = MediaAssetRepository(db)
    assets = await asset_repo.get_by_episode_and_type(episode_id, asset_type)
    if not assets:
        # Music may live in episode.metadata_.selected_music_path instead
        # of media_assets.
        if track == "music":
            ep = await EpisodeRepository(db).get_by_id(episode_id)
            if ep:
                meta = ep.metadata_ or {}
                path = meta.get("selected_music_path") if isinstance(meta, dict) else None
                if path:
                    src_path = Path(settings.storage_base_path) / path
                    return await _render_waveform(src_path, settings.ffmpeg_path, episode_id, track)
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no audio asset on this track")

    src_path = Path(settings.storage_base_path) / assets[-1].file_path
    out_path = await _render_waveform(src_path, settings.ffmpeg_path, episode_id, track)
    return FileResponse(str(out_path), media_type="image/png")


async def _render_waveform(src: Path, ffmpeg_path: str, episode_id: UUID, track: str) -> Path:
    """Idempotent waveform render via FFmpeg's ``showwavespic`` filter.
    Caches to storage/episodes/{id}/captions/waveform_{track}.png."""
    import asyncio

    out = src.parent / f"waveform_{track}.png"
    # Cheap cache: regenerate only when the source is newer than the PNG.
    if out.exists() and src.exists() and out.stat().st_mtime >= src.stat().st_mtime:
        return out

    cmd = [
        ffmpeg_path,
        "-y",
        "-i",
        str(src),
        "-filter_complex",
        "showwavespic=s=1600x160:colors=#7c8cff",
        "-frames:v",
        "1",
        str(out),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    rc = await proc.wait()
    if rc != 0 or not out.exists():
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "waveform render failed")
    return out


# ── Proxy preview ────────────────────────────────────────────────────


@router.post(
    "/api/v1/episodes/{episode_id}/editor/preview",
    status_code=status.HTTP_202_ACCEPTED,
)
async def enqueue_preview(
    episode_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """Enqueue a low-bitrate proxy render so scrubbing shows overlays
    + audio mixed without waiting for a full-quality export.

    Uses the same ``render_from_edit`` worker but hints proxy=true via
    an env-style sentinel in Redis. The worker reads it and outputs
    to ``output/proxy.mp4`` at 480p.
    """
    repo = VideoEditSessionRepository(db)
    session = await repo.get_by_episode(episode_id)
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no edit session")

    arq = get_arq_pool()
    await arq.enqueue_job("render_from_edit", str(episode_id), proxy=True)
    logger.info("preview_enqueued", episode_id=str(episode_id))
    return {"status": "enqueued"}
