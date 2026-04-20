"""arq WorkerSettings for ShortsFactory.

This module is the arq entry point.  It imports all job functions from
their respective sub-modules and wires them into ``WorkerSettings``.

Usage::

    arq shortsfactory.workers.settings.WorkerSettings
"""

from __future__ import annotations

from arq import cron
from arq.connections import RedisSettings

from shortsfactory.core.config import Settings
from shortsfactory.workers.jobs.audiobook import (
    generate_ai_audiobook,
    generate_audiobook,
    generate_script_async,
    regenerate_audiobook_chapter,
)

# ---------------------------------------------------------------------------
# Job function imports
# ---------------------------------------------------------------------------
from shortsfactory.workers.jobs.episode import (
    generate_episode,
    reassemble_episode,
    regenerate_scene,
    regenerate_voice,
    retry_episode_step,
)
from shortsfactory.workers.jobs.heartbeat import worker_heartbeat
from shortsfactory.workers.jobs.license_heartbeat import license_heartbeat
from shortsfactory.workers.jobs.music import generate_episode_music
from shortsfactory.workers.jobs.runpod import auto_deploy_runpod_pod
from shortsfactory.workers.jobs.scheduled import publish_scheduled_posts
from shortsfactory.workers.jobs.seo import generate_seo_async
from shortsfactory.workers.jobs.series import generate_series_async

# ---------------------------------------------------------------------------
# Lifecycle hook imports
# ---------------------------------------------------------------------------
from shortsfactory.workers.lifecycle import on_job_start, shutdown, startup

# ---------------------------------------------------------------------------
# Redis settings helper
# ---------------------------------------------------------------------------


def _redis_settings_from_config() -> RedisSettings:
    """Parse the application Redis URL into arq ``RedisSettings``."""
    settings = Settings()  # type: ignore[call-arg]
    url = settings.redis_url  # e.g. "redis://localhost:6379/0"

    from urllib.parse import urlparse

    parsed = urlparse(url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 6379

    # Database number from path (e.g. "/0")
    database = 0
    if parsed.path and parsed.path.strip("/"):
        try:
            database = int(parsed.path.strip("/"))
        except ValueError:
            database = 0

    password = parsed.password

    return RedisSettings(
        host=host,
        port=port,
        database=database,
        password=password,
    )


# ---------------------------------------------------------------------------
# arq WorkerSettings
# ---------------------------------------------------------------------------


class WorkerSettings:
    """arq worker configuration.

    Discovered by::

        arq shortsfactory.workers.settings.WorkerSettings
    """

    functions = [
        generate_episode,
        generate_audiobook,
        generate_ai_audiobook,
        regenerate_audiobook_chapter,
        retry_episode_step,
        reassemble_episode,
        regenerate_voice,
        regenerate_scene,
        generate_script_async,
        generate_series_async,
        generate_episode_music,
        generate_seo_async,
        publish_scheduled_posts,
        auto_deploy_runpod_pod,
        worker_heartbeat,
        license_heartbeat,
    ]
    cron_jobs = [
        # Check for due scheduled posts every 15 minutes
        cron(publish_scheduled_posts, minute={0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55}),
        # Write worker heartbeat every minute so the API can detect dead workers
        cron(worker_heartbeat, minute=set(range(60))),
        # License heartbeat — once per day at 04:17 UTC (off-peak, arbitrary).
        cron(license_heartbeat, hour={4}, minute={17}),
    ]
    on_startup = startup
    on_shutdown = shutdown
    on_job_start = on_job_start

    redis_settings = _redis_settings_from_config()

    # Concurrency: max 4 episodes generating in parallel
    max_jobs = 8

    # 10-minute hard timeout per pipeline run
    job_timeout = 7200  # 1 hour — scene generation on AMD ROCm can be slow

    # Retry configuration
    retry_jobs = True
    max_tries = 3

    # Log results
    keep_result = 3600  # keep results for 1 hour
    keep_result_forever = False
