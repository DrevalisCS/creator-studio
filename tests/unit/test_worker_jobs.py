"""Smoke tests for new arq worker job functions (music, SEO)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4


class TestGenerateEpisodeMusicJob:
    """Tests for workers/jobs/music.py::generate_episode_music."""

    async def test_returns_error_when_episode_not_found(self):
        from drevalis.workers.jobs.music import generate_episode_music

        mock_db = AsyncMock()
        ctx = {"db": mock_db}

        with patch("drevalis.workers.jobs.music.EpisodeRepository") as MockRepo:
            MockRepo.return_value.get_by_id = AsyncMock(return_value=None)

            result = await generate_episode_music(ctx, str(uuid4()), "epic", 30.0)

        assert "error" in result
        assert "not found" in result["error"]

    async def test_returns_error_when_no_comfyui_server(self):
        from drevalis.workers.jobs.music import generate_episode_music

        mock_db = AsyncMock()
        ctx = {"db": mock_db}
        mock_episode = MagicMock()

        with (
            patch("drevalis.workers.jobs.music.EpisodeRepository") as MockEpRepo,
            patch("drevalis.workers.jobs.music.ComfyUIServerRepository") as MockServerRepo,
        ):
            MockEpRepo.return_value.get_by_id = AsyncMock(return_value=mock_episode)
            MockServerRepo.return_value.get_active_servers = AsyncMock(return_value=[])

            result = await generate_episode_music(ctx, str(uuid4()), "calm", 60.0)

        assert "error" in result
        assert "ComfyUI" in result["error"]


class TestGenerateSeoAsyncJob:
    """Tests for workers/jobs/seo.py::generate_seo_async."""

    async def test_returns_error_when_episode_not_found(self):
        from drevalis.workers.jobs.seo import generate_seo_async

        mock_db = AsyncMock()
        ctx = {"db": mock_db}

        with patch("drevalis.workers.jobs.seo.EpisodeRepository") as MockRepo:
            MockRepo.return_value.get_by_id = AsyncMock(return_value=None)

            result = await generate_seo_async(ctx, str(uuid4()))

        assert "error" in result
        assert "not found" in result["error"]

    async def test_returns_error_when_no_script(self):
        from drevalis.workers.jobs.seo import generate_seo_async

        mock_db = AsyncMock()
        ctx = {"db": mock_db}
        mock_episode = MagicMock()
        mock_episode.script = None

        with patch("drevalis.workers.jobs.seo.EpisodeRepository") as MockRepo:
            MockRepo.return_value.get_by_id = AsyncMock(return_value=mock_episode)

            result = await generate_seo_async(ctx, str(uuid4()))

        assert "error" in result
        assert "no script" in result["error"]
