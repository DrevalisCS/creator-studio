"""Episode-related arq job functions.

Jobs
----
- ``generate_episode``     -- full pipeline run for an episode.
- ``retry_episode_step``   -- retry a specific failed pipeline step.
- ``reassemble_episode``   -- re-run captions + assembly + thumbnail only.
- ``regenerate_voice``     -- re-run voice + downstream steps.
- ``regenerate_scene``     -- regenerate a single scene image then reassemble.
"""

from __future__ import annotations

import uuid

import structlog

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)


async def generate_episode(ctx: dict, episode_id: str) -> dict:
    """Main arq job: run the full pipeline for an episode.

    Parameters
    ----------
    ctx:
        arq context dict populated by ``startup``.
    episode_id:
        UUID string of the episode to generate.

    Returns
    -------
    dict:
        Summary of the pipeline run including status.
    """
    from shortsfactory.services.pipeline import PipelineOrchestrator

    log = logger.bind(episode_id=episode_id, job="generate_episode")
    log.info("job_start")

    # License gate: 4th validation site (on_job_start is the first, middleware
    # the second, lifespan bootstrap the third). Duplicating the check here
    # means bypassing the on_job_start hook alone isn't enough to resume
    # generation. Raises a RuntimeError the worker treats as a hard failure.
    from shortsfactory.core.license.state import get_state as _license_state

    _lic = _license_state()
    if not _lic.is_usable:
        log.warning("generate_episode_blocked_license", status=_lic.status.value)
        raise RuntimeError(
            f"license_not_usable:{_lic.status.value}"
        )

    parsed_id = uuid.UUID(episode_id)
    session_factory = ctx["session_factory"]

    # ── Priority check: defer longform if shorts are waiting ─────────
    try:
        priority_mode = await ctx["redis"].get("job:priority_mode")
        if priority_mode and isinstance(priority_mode, bytes):
            priority_mode = priority_mode.decode()
    except Exception:
        priority_mode = None

    if priority_mode == "shorts_first":
        async with session_factory() as _ps:
            from shortsfactory.repositories.episode import EpisodeRepository as _ER
            from shortsfactory.repositories.series import SeriesRepository as _SR
            _ep = await _ER(_ps).get_by_id(parsed_id)
            if _ep:
                _series = await _SR(_ps).get_by_id(_ep.series_id)
                is_longform = _series and getattr(_series, "content_format", "shorts") == "longform"
                if is_longform:
                    # Check if any shorts episodes are generating or queued
                    from sqlalchemy import text as _text
                    _result = await _ps.execute(_text(
                        "SELECT COUNT(*) FROM episodes e JOIN series s ON e.series_id = s.id "
                        "WHERE e.status = 'generating' AND s.content_format = 'shorts'"
                    ))
                    shorts_generating = _result.scalar() or 0
                    _result2 = await _ps.execute(_text(
                        "SELECT COUNT(*) FROM episodes e JOIN series s ON e.series_id = s.id "
                        "WHERE e.status IN ('draft', 'failed') AND s.content_format = 'shorts'"
                    ))
                    shorts_waiting = _result2.scalar() or 0
                    if shorts_generating > 0 or shorts_waiting > 2:
                        # Defer longform — re-enqueue with 60s delay
                        log.info("longform_deferred", shorts_generating=shorts_generating, shorts_waiting=shorts_waiting)
                        await ctx["redis"].enqueue_job("generate_episode", episode_id, _defer_by=60)
                        return {"episode_id": episode_id, "status": "deferred", "reason": "shorts_first"}

    # Acquire a fresh DB session for this job
    async with session_factory() as session:
        orchestrator = PipelineOrchestrator(
            episode_id=parsed_id,
            db_session=session,
            redis=ctx["redis"],
            llm_service=ctx["llm_service"],
            comfyui_service=ctx["comfyui_service"],
            tts_service=ctx["tts_service"],
            ffmpeg_service=ctx["ffmpeg_service"],
            caption_service=ctx["caption_service"],
            storage=ctx["storage"],
            music_service=ctx.get("music_service"),
        )

        try:
            await orchestrator.run()
            log.info("job_complete", status="success")
            return {"episode_id": episode_id, "status": "success"}
        except (OSError, TimeoutError, ConnectionError) as exc:
            # Transient errors: let arq retry (max_tries=3)
            log.error("job_transient_error", error=str(exc), exc_info=True)
            raise
        except Exception as exc:
            log.error("job_failed", error=str(exc), exc_info=True)
            return {"episode_id": episode_id, "status": "failed", "error": str(exc)}


async def reassemble_episode(ctx: dict, episode_id: str) -> dict:
    """Re-run captions + assembly + thumbnail only.

    Voice and scene assets are kept.  Existing caption/video/thumbnail
    assets for the affected steps are replaced by new ones.

    Parameters
    ----------
    ctx:
        arq context dict populated by ``startup``.
    episode_id:
        UUID string of the episode to reassemble.
    """
    from shortsfactory.repositories.generation_job import GenerationJobRepository
    from shortsfactory.services.pipeline import PipelineOrchestrator

    log = logger.bind(episode_id=episode_id, job="reassemble_episode")
    log.info("job_start")

    parsed_id = uuid.UUID(episode_id)

    session_factory = ctx["session_factory"]
    async with session_factory() as session:
        job_repo = GenerationJobRepository(session)

        # Mark any previous done jobs for captions/assembly/thumbnail as non-done
        # so the orchestrator will re-execute them.
        for step_name in ("captions", "assembly", "thumbnail"):
            existing = await job_repo.get_latest_by_episode_and_step(
                parsed_id, step_name
            )
            if existing and existing.status == "done":
                await job_repo.update(
                    existing.id,
                    status="queued",
                    progress_pct=0,
                    error_message=None,
                )
        await session.commit()
        log.info("steps_reset", steps=["captions", "assembly", "thumbnail"])

        # Run the full pipeline -- voice and scenes steps are already 'done'
        # and will be skipped automatically.
        orchestrator = PipelineOrchestrator(
            episode_id=parsed_id,
            db_session=session,
            redis=ctx["redis"],
            llm_service=ctx["llm_service"],
            comfyui_service=ctx["comfyui_service"],
            tts_service=ctx["tts_service"],
            ffmpeg_service=ctx["ffmpeg_service"],
            caption_service=ctx["caption_service"],
            storage=ctx["storage"],
            music_service=ctx.get("music_service"),
        )

        try:
            await orchestrator.run()
            log.info("job_complete", status="success")
            return {"episode_id": episode_id, "status": "success"}
        except Exception as exc:
            log.error("job_failed", error=str(exc), exc_info=True)
            return {"episode_id": episode_id, "status": "failed", "error": str(exc)}


async def regenerate_voice(ctx: dict, episode_id: str) -> dict:
    """Re-run voice + captions + assembly + thumbnail.

    Scene images are kept.  Useful when changing voice profiles or
    editing narration text.

    Parameters
    ----------
    ctx:
        arq context dict populated by ``startup``.
    episode_id:
        UUID string of the episode.
    """
    from shortsfactory.repositories.generation_job import GenerationJobRepository
    from shortsfactory.services.pipeline import PipelineOrchestrator

    log = logger.bind(episode_id=episode_id, job="regenerate_voice")
    log.info("job_start")

    parsed_id = uuid.UUID(episode_id)

    session_factory = ctx["session_factory"]
    async with session_factory() as session:
        job_repo = GenerationJobRepository(session)

        # Mark voice, captions, assembly, thumbnail as queued so the
        # orchestrator will re-execute them.
        for step_name in ("voice", "captions", "assembly", "thumbnail"):
            existing = await job_repo.get_latest_by_episode_and_step(
                parsed_id, step_name
            )
            if existing and existing.status == "done":
                await job_repo.update(
                    existing.id,
                    status="queued",
                    progress_pct=0,
                    error_message=None,
                )
        await session.commit()
        log.info("steps_reset", steps=["voice", "captions", "assembly", "thumbnail"])

        orchestrator = PipelineOrchestrator(
            episode_id=parsed_id,
            db_session=session,
            redis=ctx["redis"],
            llm_service=ctx["llm_service"],
            comfyui_service=ctx["comfyui_service"],
            tts_service=ctx["tts_service"],
            ffmpeg_service=ctx["ffmpeg_service"],
            caption_service=ctx["caption_service"],
            storage=ctx["storage"],
            music_service=ctx.get("music_service"),
        )

        try:
            await orchestrator.run()
            log.info("job_complete", status="success")
            return {"episode_id": episode_id, "status": "success"}
        except Exception as exc:
            log.error("job_failed", error=str(exc), exc_info=True)
            return {"episode_id": episode_id, "status": "failed", "error": str(exc)}


async def regenerate_scene(
    ctx: dict,
    episode_id: str,
    scene_number: int,
    visual_prompt: str | None = None,
) -> dict:
    """Regenerate a single scene's image/video and then reassemble.

    Parameters
    ----------
    ctx:
        arq context dict populated by ``startup``.
    episode_id:
        UUID string of the episode.
    scene_number:
        1-based scene number to regenerate.
    visual_prompt:
        Optional override for the scene's visual prompt.
    """
    from shortsfactory.repositories.episode import EpisodeRepository
    from shortsfactory.repositories.generation_job import GenerationJobRepository
    from shortsfactory.repositories.media_asset import MediaAssetRepository
    from shortsfactory.schemas.script import EpisodeScript
    from shortsfactory.services.pipeline import PipelineOrchestrator

    log = logger.bind(
        episode_id=episode_id,
        scene_number=scene_number,
        job="regenerate_scene",
    )
    log.info("job_start")

    parsed_id = uuid.UUID(episode_id)

    session_factory = ctx["session_factory"]
    async with session_factory() as session:
        ep_repo = EpisodeRepository(session)
        job_repo = GenerationJobRepository(session)
        asset_repo = MediaAssetRepository(session)

        # Optionally update the visual prompt.
        if visual_prompt:
            episode = await ep_repo.get_by_id(parsed_id)
            if episode and episode.script:
                script = EpisodeScript.model_validate(episode.script)
                for scene in script.scenes:
                    if scene.scene_number == scene_number:
                        scene.visual_prompt = visual_prompt
                        break
                episode.script = script.model_dump()
                await session.commit()
                log.info("visual_prompt_updated")

        # Delete existing media assets for this scene so they get regenerated.
        deleted = await asset_repo.delete_by_episode_and_scene(
            parsed_id, scene_number
        )
        log.info("scene_assets_deleted", count=deleted)

        # Mark scenes, captions, assembly, thumbnail steps as queued.
        for step_name in ("scenes", "captions", "assembly", "thumbnail"):
            existing = await job_repo.get_latest_by_episode_and_step(
                parsed_id, step_name
            )
            if existing and existing.status == "done":
                await job_repo.update(
                    existing.id,
                    status="queued",
                    progress_pct=0,
                    error_message=None,
                )
        await session.commit()

        # Run the full pipeline -- script and voice steps remain 'done'
        # and will be skipped.
        orchestrator = PipelineOrchestrator(
            episode_id=parsed_id,
            db_session=session,
            redis=ctx["redis"],
            llm_service=ctx["llm_service"],
            comfyui_service=ctx["comfyui_service"],
            tts_service=ctx["tts_service"],
            ffmpeg_service=ctx["ffmpeg_service"],
            caption_service=ctx["caption_service"],
            storage=ctx["storage"],
            music_service=ctx.get("music_service"),
        )

        try:
            await orchestrator.run()
            log.info("job_complete", status="success")
            return {
                "episode_id": episode_id,
                "scene_number": scene_number,
                "status": "success",
            }
        except Exception as exc:
            log.error("job_failed", error=str(exc), exc_info=True)
            return {
                "episode_id": episode_id,
                "scene_number": scene_number,
                "status": "failed",
                "error": str(exc),
            }


async def retry_episode_step(ctx: dict, episode_id: str, step: str) -> dict:
    """Retry a specific failed step for an episode.

    Resets the failed job status to ``queued`` so the orchestrator will
    re-execute it.  Completed steps before it are automatically skipped.

    Parameters
    ----------
    ctx:
        arq context dict.
    episode_id:
        UUID string of the episode.
    step:
        Pipeline step name to retry (e.g. ``"scenes"``).
    """
    from shortsfactory.repositories.generation_job import GenerationJobRepository
    from shortsfactory.services.pipeline import PipelineOrchestrator

    log = logger.bind(episode_id=episode_id, step=step, job="retry_episode_step")
    log.info("retry_start")

    parsed_id = uuid.UUID(episode_id)

    session_factory = ctx["session_factory"]
    async with session_factory() as session:
        # Reset the specific failed step so the orchestrator picks it up
        job_repo = GenerationJobRepository(session)
        existing = await job_repo.get_latest_by_episode_and_step(parsed_id, step)
        if existing and existing.status == "failed":
            await job_repo.update(
                existing.id,
                status="queued",
                progress_pct=0,
                error_message=None,
            )
            await session.commit()
            log.info("failed_step_reset", job_id=str(existing.id))

        # Run the full pipeline -- completed steps will be skipped
        orchestrator = PipelineOrchestrator(
            episode_id=parsed_id,
            db_session=session,
            redis=ctx["redis"],
            llm_service=ctx["llm_service"],
            comfyui_service=ctx["comfyui_service"],
            tts_service=ctx["tts_service"],
            ffmpeg_service=ctx["ffmpeg_service"],
            caption_service=ctx["caption_service"],
            storage=ctx["storage"],
            music_service=ctx.get("music_service"),
        )

        try:
            await orchestrator.run()
            log.info("retry_complete", status="success")
            return {"episode_id": episode_id, "step": step, "status": "success"}
        except Exception as exc:
            log.error("retry_failed", error=str(exc), exc_info=True)
            return {
                "episode_id": episode_id,
                "step": step,
                "status": "failed",
                "error": str(exc),
            }
