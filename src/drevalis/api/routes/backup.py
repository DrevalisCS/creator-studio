"""Backup + restore API routes.

Endpoints
---------
- ``GET  /api/v1/backup``             list archives in BACKUP_DIRECTORY
- ``POST /api/v1/backup``             create a new archive, return metadata
- ``GET  /api/v1/backup/{filename}``  download an existing archive
- ``DEL  /api/v1/backup/{filename}``  delete an archive
- ``POST /api/v1/backup/restore``     upload an archive and restore it

The restore endpoint is destructive: it truncates every user table and
overwrites storage files. The frontend gates it behind a typed-confirm
dialog; the backend still demands ``X-Confirm-Restore: i-understand`` on
every call so a bug in the UI can't wipe the DB.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Annotated, Any

import structlog
from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession  # runtime import — required

# for FastAPI to resolve ``Annotated[AsyncSession, Depends(get_db)]``
# into a dependency instead of a query parameter. ``from __future__
# import annotations`` turns annotations into strings, so the
# previous TYPE_CHECKING-only import made FastAPI fall back to
# treating ``db`` as a query param, producing 422 on every request.
from drevalis.core.config import Settings
from drevalis.core.deps import get_db, get_settings
from drevalis.services.backup import BackupError, BackupService
from drevalis.services.media_repair import repair_media_links

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/backup", tags=["backup"])


def _service(settings: Settings) -> BackupService:
    from drevalis.services.updates import _resolve_current_version

    return BackupService(
        storage_base_path=settings.storage_base_path,
        backup_directory=settings.backup_directory,
        encryption_key=settings.encryption_key,
        app_version=_resolve_current_version(),
    )


def _safe_backup_path(settings: Settings, filename: str) -> Path:
    """Resolve *filename* inside the configured backup directory.

    Refuses anything containing path separators or resolving outside the
    directory (CVE-class path-traversal guard on a user-provided name).
    """
    if "/" in filename or "\\" in filename or filename.startswith("."):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid filename",
        )
    root = settings.backup_directory.resolve()
    candidate = (root / filename).resolve()
    if not str(candidate).startswith(str(root)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="filename escapes backup directory",
        )
    return candidate


# ── List ─────────────────────────────────────────────────────────────────


@router.get("", summary="List existing backup archives")
async def list_backups(settings: Settings = Depends(get_settings)) -> dict[str, object]:
    svc = _service(settings)
    return {
        "backup_directory": str(settings.backup_directory),
        "retention": settings.backup_retention,
        "auto_enabled": settings.backup_auto_enabled,
        "archives": svc.list_backups(),
    }


# ── Create ───────────────────────────────────────────────────────────────


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a new backup")
async def create_backup(
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Settings = Depends(get_settings),
    include_media: bool = True,
) -> dict[str, object]:
    svc = _service(settings)
    try:
        archive = await svc.create_backup(db, include_media=include_media)
    except Exception as exc:  # noqa: BLE001 - surface to UI
        logger.error("backup_create_failed", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"backup failed: {exc}",
        ) from exc
    # Prune old archives per retention policy so disk usage stays bounded.
    removed = svc.prune(settings.backup_retention)
    return {
        "filename": archive.name,
        "size_bytes": archive.stat().st_size,
        "pruned": removed,
    }


# ── Download ─────────────────────────────────────────────────────────────


@router.get("/{filename}", summary="Download an archive")
async def download_backup(
    filename: str,
    settings: Settings = Depends(get_settings),
) -> FileResponse:
    path = _safe_backup_path(settings, filename)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="backup not found")
    return FileResponse(
        path,
        media_type="application/gzip",
        filename=filename,
    )


# ── Delete ───────────────────────────────────────────────────────────────


@router.delete(
    "/{filename}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an archive",
)
async def delete_backup(
    filename: str,
    settings: Settings = Depends(get_settings),
) -> None:
    path = _safe_backup_path(settings, filename)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="backup not found")
    path.unlink()


# ── Restore (destructive) ────────────────────────────────────────────────


@router.post(
    "/restore",
    summary="Restore from an uploaded archive (DESTRUCTIVE)",
    description=(
        "Truncates all user tables and overwrites storage files with the "
        "contents of the uploaded archive. Must include the header "
        "`X-Confirm-Restore: i-understand` to succeed."
    ),
)
async def restore_backup(
    file: UploadFile = File(...),
    confirm: str = Header(..., alias="X-Confirm-Restore"),
    allow_key_mismatch: bool = False,
    restore_db: bool = True,
    restore_media: bool = True,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    if confirm != "i-understand":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="missing or invalid X-Confirm-Restore header",
        )
    if not file.filename or not file.filename.endswith(".tar.gz"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="expected a .tar.gz archive",
        )

    # Stream to a temp file so we don't have to buffer the whole thing.
    import tempfile

    tmp = Path(tempfile.mkstemp(suffix=".tar.gz")[1])
    try:
        with tmp.open("wb") as f:
            while chunk := await file.read(4 * 1024 * 1024):
                f.write(chunk)

        svc = _service(settings)
        try:
            return await svc.restore_backup(
                db,
                tmp,
                allow_key_mismatch=allow_key_mismatch,
                restore_db=restore_db,
                restore_media=restore_media,
            )
        except BackupError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            logger.error("restore_failed", exc_info=True)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"restore failed: {exc}",
            ) from exc
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _detect_mount_fs(path: Path) -> str | None:
    """Return the filesystem type backing *path* (``ext4``, ``cifs``,
    ``nfs``, ``overlay`` …) by reading ``/proc/mounts`` — or ``None``
    when that isn't readable (Windows, restricted containers).

    Used purely as a diagnostic so the Settings UI can show whether
    the media volume is local, SMB, NFS, or something else.
    """
    try:
        mounts = Path("/proc/mounts").read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return None

    path_str = str(path)
    best: tuple[int, str] | None = None
    for line in mounts:
        parts = line.split()
        if len(parts) < 3:
            continue
        mount_point = parts[1]
        fs_type = parts[2]
        if path_str == mount_point or path_str.startswith(mount_point.rstrip("/") + "/"):
            depth = len(mount_point)
            if best is None or depth > best[0]:
                best = (depth, fs_type)
    return best[1] if best else None


# ── Storage probe (diagnose "can't see videos / images") ─────────────────


@router.get(
    "/storage-probe",
    summary="Probe the storage mount + serve path for common post-restore issues",
)
async def storage_probe(
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, object]:
    """Return a focused diagnostic for each of: does the app see the
    right ``storage_base_path``? are the files readable by the Python
    process that's going to serve them? is the storage directory a
    symlink (StaticFiles mounts are ``follow_symlink=False``)? does
    the auth middleware guard ``/storage/*``?

    The frontend's Backup section renders the output as a checklist
    so the user can tell at a glance which layer is broken.
    """
    import os

    from sqlalchemy import func, select

    from drevalis.models.media_asset import MediaAsset

    storage_base = settings.storage_base_path.resolve()
    episodes_dir = (storage_base / "episodes").resolve()
    audiobooks_dir = (storage_base / "audiobooks").resolve()
    report: dict[str, Any] = {
        "storage_base_path": str(storage_base),
        "storage_base_exists": storage_base.exists(),
        "storage_base_is_symlink": storage_base.is_symlink(),
        "episodes_dir_exists": episodes_dir.exists(),
        "episodes_dir_is_symlink": episodes_dir.is_symlink(),
        "audiobooks_dir_exists": audiobooks_dir.exists(),
        "api_auth_token_configured": bool(settings.api_auth_token),
        "api_auth_blocks_storage": bool(settings.api_auth_token),
        "process_uid": None,
        "process_gid": None,
        "mount_fs": _detect_mount_fs(storage_base),
    }
    # ``os.getuid`` / ``os.getgid`` only exist on POSIX. On Windows the
    # probe simply omits those fields.
    report["process_uid"] = getattr(os, "getuid", lambda: None)()
    report["process_gid"] = getattr(os, "getgid", lambda: None)()

    # Pull a representative sample of media_assets across types so the
    # probe covers video / image / caption / audio. For each row
    # actually attempt a read of the first byte — that's what
    # StaticFiles.send_file does under the hood, and it's the only
    # way to know whether the container user can actually serve the
    # file.
    sample_types = ["video", "thumbnail", "scene", "caption", "voiceover"]
    samples: list[dict[str, Any]] = []
    for asset_type in sample_types:
        rows = (
            (
                await db.execute(
                    select(MediaAsset)
                    .where(MediaAsset.asset_type == asset_type)
                    .order_by(func.random())
                    .limit(1)
                )
            )
            .scalars()
            .all()
        )
        for row in rows:
            fp = row.file_path or ""
            abs_p = (storage_base / fp).resolve() if fp else None
            entry: dict[str, Any] = {
                "asset_type": asset_type,
                "file_path": fp,
                "episode_id": str(row.episode_id) if row.episode_id else None,
                "abs_path": str(abs_p) if abs_p else None,
                "exists": False,
                "readable": False,
                "is_symlink": False,
                "size_bytes": None,
                "url_served_at": f"/storage/{fp}" if fp else None,
                "error": None,
            }
            if abs_p and abs_p.exists():
                entry["exists"] = True
                entry["is_symlink"] = abs_p.is_symlink()
                try:
                    entry["size_bytes"] = abs_p.stat().st_size
                except OSError as exc:
                    entry["error"] = f"stat: {exc}"
                try:
                    with abs_p.open("rb") as f:
                        _ = f.read(1)
                    entry["readable"] = True
                except OSError as exc:
                    entry["error"] = f"read: {exc}"
            samples.append(entry)

    report["samples"] = samples
    report["hints"] = _storage_probe_hints(report)
    return report


def _storage_probe_hints(report: dict[str, Any]) -> list[str]:
    hints: list[str] = []
    if not report.get("storage_base_exists"):
        hints.append(
            "The storage_base_path doesn't exist inside the app container. "
            "Check your Docker volume mount — the host path with your media "
            "must map to this path inside the container."
        )
    if report.get("api_auth_token_configured"):
        hints.append(
            "API_AUTH_TOKEN is set. Browser <video> / <img> tags can't send "
            "Bearer headers, so every /storage/* request gets blocked by "
            "the auth middleware. Either unset API_AUTH_TOKEN or move the "
            "media behind a signed-URL scheme."
        )
    if report.get("storage_base_is_symlink") or report.get("episodes_dir_is_symlink"):
        hints.append(
            "storage_base_path or storage/episodes/ is a symlink. FastAPI "
            "StaticFiles is mounted with follow_symlink=False so symlinked "
            "directories return 404. Replace the symlink with the real "
            "directory (or its contents)."
        )
    samples = report.get("samples") or []
    exists_but_unreadable = [s for s in samples if s["exists"] and not s["readable"]]
    if exists_but_unreadable:
        hints.append(
            f"{len(exists_but_unreadable)} of {len(samples)} probe files exist "
            "but aren't readable by the app process — a permission problem. "
            f"Inside the container run ``chown -R {report.get('process_uid')}:"
            f"{report.get('process_gid')} /app/storage`` (or the equivalent "
            "host-side chown on the mapped directory)."
        )
    samples_with_symlink = [s for s in samples if s["is_symlink"]]
    if samples_with_symlink:
        hints.append(
            f"{len(samples_with_symlink)} sample files are symlinks. "
            "StaticFiles is mounted with follow_symlink=False — serve "
            "real files, or flip the mount to follow_symlinks=True "
            "(weighs the path-traversal trade-off yourself)."
        )
    if not hints:
        hints.append(
            "No obvious storage-serving problem detected. If videos still "
            "don't play, open browser DevTools → Network and look at the "
            "actual HTTP status of the /storage/... request; share that "
            "status + response headers."
        )
    return hints


# ── Repair media links (after a rough restore or manual copy) ────────────


@router.post(
    "/repair-media",
    summary="Relink media_assets rows to files on disk",
    description=(
        "Walks every media_assets row and, for those whose file_path no "
        "longer resolves, tries to locate the matching file on disk under "
        "storage/episodes/ and updates the row. Use after restoring a DB "
        "backup into a directory structure that doesn't match the original "
        "storage layout, or after manually copying media. Non-destructive: "
        "only updates rows whose current path is broken."
    ),
)
async def repair_media(
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, object]:
    # No request body is accepted or required — both deps are dependency-
    # injected. Switched to Annotated+Depends for both so FastAPI never
    # tries to treat one as a query/body parameter (that was producing
    # a spurious 422 when the frontend fired POST with no body).
    try:
        report = await repair_media_links(db, settings.storage_base_path)
    except Exception as exc:  # noqa: BLE001
        logger.error("media_repair_failed", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"media repair failed: {exc}",
        ) from exc
    return report.to_dict()


# ── Nightly cron hook (called by the arq worker) ─────────────────────────


async def run_scheduled_backup(
    db: AsyncSession,
    settings: Settings,
) -> Path | None:
    """Invoked by the arq cron when BACKUP_AUTO_ENABLED is True."""
    if not settings.backup_auto_enabled:
        return None
    svc = _service(settings)
    archive = await svc.create_backup(db)
    svc.prune(settings.backup_retention)
    return archive


# placate static analysis — shutil is imported but only used indirectly.
_ = shutil
