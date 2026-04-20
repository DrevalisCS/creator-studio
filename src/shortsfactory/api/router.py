"""Main API router -- aggregates all sub-routers under ``/api/v1``."""

from __future__ import annotations

from fastapi import APIRouter, status
from pydantic import BaseModel

from shortsfactory.api.routes.api_keys import router as api_keys_router
from shortsfactory.api.routes.audiobooks import router as audiobooks_router
from shortsfactory.api.routes.comfyui import router as comfyui_router
from shortsfactory.api.routes.episodes import router as episodes_router
from shortsfactory.api.routes.jobs import router as jobs_router
from shortsfactory.api.routes.license import router as license_router
from shortsfactory.api.routes.llm import router as llm_router
from shortsfactory.api.routes.metrics import router as metrics_router
from shortsfactory.api.routes.prompt_templates import router as prompt_templates_router
from shortsfactory.api.routes.runpod import router as runpod_router
from shortsfactory.api.routes.schedule import router as schedule_router
from shortsfactory.api.routes.series import router as series_router
from shortsfactory.api.routes.settings import router as settings_router
from shortsfactory.api.routes.social import router as social_router
from shortsfactory.api.routes.updates import router as updates_router
from shortsfactory.api.routes.video_templates import router as video_templates_router
from shortsfactory.api.routes.voice_profiles import router as voice_profiles_router
from shortsfactory.api.routes.youtube import router as youtube_router

# -- Top-level router ------------------------------------------------------
router = APIRouter()

# -- Health check (no prefix) ---------------------------------------------


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str = "0.1.0"


@router.get(
    "/health",
    response_model=HealthResponse,
    status_code=status.HTTP_200_OK,
    tags=["health"],
)
async def health_check() -> HealthResponse:
    """Liveness / readiness probe."""
    return HealthResponse()


# -- Include all sub-routers ----------------------------------------------
router.include_router(series_router)
router.include_router(episodes_router)
router.include_router(voice_profiles_router)
router.include_router(audiobooks_router)
router.include_router(comfyui_router)
router.include_router(llm_router)
router.include_router(prompt_templates_router)
router.include_router(jobs_router)
router.include_router(license_router)
router.include_router(updates_router)
router.include_router(metrics_router)
router.include_router(settings_router)
router.include_router(api_keys_router)
router.include_router(runpod_router)
router.include_router(social_router)
router.include_router(youtube_router)
router.include_router(schedule_router)
router.include_router(video_templates_router)
