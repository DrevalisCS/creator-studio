"""Scheduled backup arq job.

Runs once per day at 03:00 UTC when ``BACKUP_AUTO_ENABLED=true``. Creates
a tarball in ``BACKUP_DIRECTORY`` and prunes older archives beyond
``BACKUP_RETENTION``. Failures are logged but not fatal - the worker
keeps running; the user sees the most recent successful archive in the
Settings / Backup tab.
"""

from __future__ import annotations

from typing import Any

import structlog

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)


async def scheduled_backup(ctx: dict[str, Any]) -> dict[str, Any]:
    from drevalis.core.config import Settings
    from drevalis.services.updates import _resolve_current_version

    settings = Settings()
    if not settings.backup_auto_enabled:
        logger.debug("scheduled_backup_disabled")
        return {"skipped": "disabled"}

    session_factory = ctx["session_factory"]

    from drevalis.services.backup import BackupService

    svc = BackupService(
        storage_base_path=settings.storage_base_path,
        backup_directory=settings.backup_directory,
        encryption_key=settings.encryption_key,
        app_version=_resolve_current_version(),
    )

    try:
        async with session_factory() as session:
            archive = await svc.create_backup(session)
        removed = svc.prune(settings.backup_retention)
        logger.info(
            "scheduled_backup_ok",
            archive=archive.name,
            size_bytes=archive.stat().st_size,
            pruned=len(removed),
        )
        return {
            "status": "ok",
            "archive": archive.name,
            "size_bytes": archive.stat().st_size,
            "pruned": removed,
        }
    except Exception as exc:  # noqa: BLE001 - background job; log + move on
        logger.error("scheduled_backup_failed", error=str(exc)[:200], exc_info=True)
        return {"status": "failed", "error": str(exc)[:200]}
