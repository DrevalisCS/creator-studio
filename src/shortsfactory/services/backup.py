"""Backup + restore service.

A backup is a ``.tar.gz`` archive containing:

- ``manifest.json``   — schema version, created_at, installed app version,
                        encryption_key_hash (so a restore can refuse to run
                        against the wrong install), table row counts.
- ``data/*.json``     — one file per ORM table, rows serialized via the
                        corresponding Pydantic response schema. UUIDs,
                        datetimes, and enum values round-trip cleanly.
- ``storage/*``       — user-generated media (episodes, audiobooks,
                        voice_previews). Re-downloadable model files
                        under ``storage/models`` are intentionally
                        excluded to keep the archive small.

Restore drops all user rows in dependency-safe order, then re-inserts
from the JSON files, then extracts the storage tree. OAuth tokens and
API keys are Fernet-encrypted with the install's ENCRYPTION_KEY — they
restore correctly only if the target install uses the same key (checked
against ``encryption_key_hash`` in the manifest).
"""

from __future__ import annotations

import hashlib
import json
import shutil
import tarfile
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import structlog
from sqlalchemy import delete, select

from shortsfactory.models.api_key_store import ApiKeyStore
from shortsfactory.models.audiobook import Audiobook
from shortsfactory.models.comfyui import ComfyUIServer, ComfyUIWorkflow
from shortsfactory.models.episode import Episode
from shortsfactory.models.generation_job import GenerationJob
from shortsfactory.models.llm_config import LLMConfig
from shortsfactory.models.media_asset import MediaAsset
from shortsfactory.models.prompt_template import PromptTemplate
from shortsfactory.models.scheduled_post import ScheduledPost
from shortsfactory.models.series import Series
from shortsfactory.models.social_platform import SocialPlatform, SocialUpload
from shortsfactory.models.video_template import VideoTemplate
from shortsfactory.models.voice_profile import VoiceProfile
from shortsfactory.models.youtube_channel import YouTubeChannel, YouTubeUpload

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)

BACKUP_SCHEMA_VERSION = "1"

# Ordered so that dependents come after their parents (import order);
# reverse is deletion order.
_TABLE_ORDER: list[tuple[str, type[Any]]] = [
    ("series", Series),
    ("voice_profiles", VoiceProfile),
    ("llm_configs", LLMConfig),
    ("comfyui_servers", ComfyUIServer),
    ("comfyui_workflows", ComfyUIWorkflow),
    ("prompt_templates", PromptTemplate),
    ("api_key_store", ApiKeyStore),
    ("youtube_channels", YouTubeChannel),
    ("social_platforms", SocialPlatform),
    ("video_templates", VideoTemplate),
    ("episodes", Episode),
    ("audiobooks", Audiobook),
    ("generation_jobs", GenerationJob),
    ("media_assets", MediaAsset),
    ("youtube_uploads", YouTubeUpload),
    ("social_uploads", SocialUpload),
    ("scheduled_posts", ScheduledPost),
]

_STORAGE_SUBDIRS_TO_BACKUP: tuple[str, ...] = (
    "episodes",
    "audiobooks",
    "voice_previews",
)


def _json_default(obj: Any) -> Any:
    """JSON encoder for UUID / datetime / Path / Decimal / set."""
    if isinstance(obj, uuid.UUID):
        return str(obj)
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, Path):
        return str(obj)
    try:
        import decimal

        if isinstance(obj, decimal.Decimal):
            return float(obj)
    except ImportError:
        pass
    if isinstance(obj, (set, frozenset)):
        return list(obj)
    raise TypeError(f"not JSON serializable: {type(obj).__name__}")


def _row_to_dict(row: Any) -> dict[str, Any]:
    """Serialise a SQLAlchemy model instance to a plain dict."""
    return {c.name: getattr(row, c.name) for c in row.__table__.columns}


def _encryption_key_hash(key: str) -> str:
    """Short fingerprint of the install's Fernet key.

    Stored in the manifest so a restore can detect and refuse a mismatched
    target install (which would produce a DB full of un-decryptable OAuth
    tokens and API keys).
    """
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


class BackupError(Exception):
    """Raised when backup creation or restoration fails."""


class BackupService:
    """Create and restore full-install backups."""

    def __init__(
        self,
        *,
        storage_base_path: Path,
        backup_directory: Path,
        encryption_key: str,
        app_version: str,
    ) -> None:
        self.storage_base_path = storage_base_path.resolve()
        self.backup_directory = backup_directory.resolve()
        self.backup_directory.mkdir(parents=True, exist_ok=True)
        self.encryption_key = encryption_key
        self.app_version = app_version

    # ── Create ───────────────────────────────────────────────────────────

    async def create_backup(
        self,
        session: AsyncSession,
        *,
        include_media: bool = True,
    ) -> Path:
        """Dump DB + selected storage into a timestamped .tar.gz.

        Returns the absolute path to the archive. The archive is world-
        readable by the container user only (``chmod 600``).
        """
        timestamp = datetime.now(tz=UTC).strftime("%Y%m%dT%H%M%SZ")
        archive_name = f"drevalis-backup-{timestamp}.tar.gz"
        archive_path = self.backup_directory / archive_name

        with tempfile.TemporaryDirectory(prefix="drevalis-backup-") as tmpdir:
            tmp = Path(tmpdir)

            # 1. Dump each table to data/<table>.json.
            data_dir = tmp / "data"
            data_dir.mkdir()
            row_counts: dict[str, int] = {}
            for table_name, model in _TABLE_ORDER:
                result = await session.execute(select(model))
                rows = result.scalars().all()
                serialised = [_row_to_dict(r) for r in rows]
                (data_dir / f"{table_name}.json").write_text(
                    json.dumps(serialised, default=_json_default, indent=2),
                    encoding="utf-8",
                )
                row_counts[table_name] = len(rows)
                logger.debug("backup_table_dumped", table=table_name, rows=len(rows))

            # 2. Copy storage subdirs.
            if include_media:
                for subdir in _STORAGE_SUBDIRS_TO_BACKUP:
                    src = self.storage_base_path / subdir
                    if src.exists():
                        dst = tmp / "storage" / subdir
                        shutil.copytree(src, dst, symlinks=False)

            # 3. Manifest.
            manifest = {
                "schema_version": BACKUP_SCHEMA_VERSION,
                "created_at": datetime.now(tz=UTC).isoformat(),
                "app_version": self.app_version,
                "encryption_key_hash": _encryption_key_hash(self.encryption_key),
                "row_counts": row_counts,
                "include_media": include_media,
            }
            (tmp / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

            # 4. Tarball.
            with tarfile.open(archive_path, "w:gz") as tar:
                tar.add(tmp, arcname=".")

        archive_path.chmod(0o600)
        logger.info(
            "backup_created",
            path=str(archive_path),
            size_mb=round(archive_path.stat().st_size / (1024 * 1024), 2),
            rows=sum(row_counts.values()),
        )
        return archive_path

    # ── Restore ──────────────────────────────────────────────────────────

    async def restore_backup(
        self,
        session: AsyncSession,
        archive_path: Path,
        *,
        allow_key_mismatch: bool = False,
    ) -> dict[str, Any]:
        """Restore a backup archive into the current install.

        Truncates every user table then re-inserts from the archive. Extracts
        the ``storage/`` tree, overwriting any existing files. Does NOT
        touch ``license_state`` — a restored backup does not carry over the
        license; the target install stays on its own license.

        Raises :class:`BackupError` if the archive is malformed, was created
        with a different Fernet key (unless ``allow_key_mismatch=True``), or
        refers to a schema version this code cannot read.
        """
        if not archive_path.exists():
            raise BackupError(f"archive not found: {archive_path}")

        with tempfile.TemporaryDirectory(prefix="drevalis-restore-") as tmpdir:
            tmp = Path(tmpdir)
            try:
                with tarfile.open(archive_path, "r:gz") as tar:
                    self._safe_extract(tar, tmp)
            except tarfile.TarError as exc:
                raise BackupError(f"corrupt archive: {exc}") from exc

            manifest_path = tmp / "manifest.json"
            if not manifest_path.exists():
                raise BackupError("archive missing manifest.json")
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

            if str(manifest.get("schema_version")) != BACKUP_SCHEMA_VERSION:
                raise BackupError(
                    f"schema version {manifest.get('schema_version')!r} "
                    f"is not readable by this install (expected "
                    f"{BACKUP_SCHEMA_VERSION!r})"
                )

            expected_hash = _encryption_key_hash(self.encryption_key)
            archive_hash = manifest.get("encryption_key_hash")
            if archive_hash != expected_hash and not allow_key_mismatch:
                raise BackupError(
                    "encryption key of the archive does not match this "
                    "install. Restoring would leave OAuth tokens and API "
                    "keys un-decryptable. Set allow_key_mismatch=True to "
                    "restore anyway (you will need to re-enter all secrets)."
                )

            # 1. Drop all user rows (reverse dependency order).
            for table_name, model in reversed(_TABLE_ORDER):
                await session.execute(delete(model))
            await session.flush()

            # 2. Insert rows in forward order.
            inserted: dict[str, int] = {}
            data_dir = tmp / "data"
            for table_name, model in _TABLE_ORDER:
                path = data_dir / f"{table_name}.json"
                if not path.exists():
                    inserted[table_name] = 0
                    continue
                rows = json.loads(path.read_text(encoding="utf-8"))
                if rows:
                    await session.execute(model.__table__.insert(), rows)
                inserted[table_name] = len(rows)

            await session.commit()

            # 3. Extract storage/.
            src_storage = tmp / "storage"
            restored_paths: list[str] = []
            if src_storage.exists():
                for subdir in _STORAGE_SUBDIRS_TO_BACKUP:
                    src = src_storage / subdir
                    if src.exists():
                        dst = self.storage_base_path / subdir
                        if dst.exists():
                            shutil.rmtree(dst)
                        shutil.copytree(src, dst)
                        restored_paths.append(str(dst))

        logger.info(
            "backup_restored",
            archive=str(archive_path),
            rows=sum(inserted.values()),
            paths=len(restored_paths),
        )
        return {
            "schema_version": manifest["schema_version"],
            "created_at": manifest["created_at"],
            "app_version_origin": manifest.get("app_version"),
            "rows_inserted": inserted,
            "storage_paths_restored": restored_paths,
        }

    @staticmethod
    def _safe_extract(tar: tarfile.TarFile, dst: Path) -> None:
        """Guard against tar path traversal (CVE-2007-4559)."""
        dst_resolved = dst.resolve()
        for member in tar.getmembers():
            member_path = (dst / member.name).resolve()
            if not str(member_path).startswith(str(dst_resolved)):
                raise BackupError(f"tar entry escapes target: {member.name!r}")
        tar.extractall(dst)

    # ── Listing / housekeeping ───────────────────────────────────────────

    def list_backups(self) -> list[dict[str, Any]]:
        """Return metadata for every archive in the backup directory,
        newest first."""
        entries: list[dict[str, Any]] = []
        for p in self.backup_directory.glob("drevalis-backup-*.tar.gz"):
            try:
                stat = p.stat()
            except OSError:
                continue
            entries.append(
                {
                    "filename": p.name,
                    "size_bytes": stat.st_size,
                    "created_at": datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat(),
                }
            )
        entries.sort(key=lambda e: e["created_at"], reverse=True)
        return entries

    def prune(self, retention: int) -> list[str]:
        """Delete all but the most recent *retention* backups. Returns
        the filenames that were removed."""
        if retention < 1:
            return []
        archives = sorted(
            self.backup_directory.glob("drevalis-backup-*.tar.gz"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        removed: list[str] = []
        for old in archives[retention:]:
            try:
                old.unlink()
                removed.append(old.name)
            except OSError as exc:
                logger.warning("backup_prune_failed", path=str(old), error=str(exc))
        if removed:
            logger.info("backups_pruned", count=len(removed))
        return removed
