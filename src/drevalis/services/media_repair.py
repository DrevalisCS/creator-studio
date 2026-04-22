"""Repair ``media_assets.file_path`` entries after a storage move.

Restoring a backup is clean — the DB rows come back with their
original ``file_path``s. But if the operator re-copies the media
folder into a *different* directory structure (or renames the
per-episode UUID dirs), those rows now point nowhere. This service
scans the DB + filesystem and relinks them automatically.

Matching strategy (in order of confidence):

1. **Exact-path hit** — row's ``file_path`` resolves as-is. Keep.
2. **Filename + kind match** — find a unique file on disk under
   ``storage/episodes/`` with the same basename and an asset-type-
   consistent subdir (``output/final.mp4``, ``scenes/*.png``,
   ``voice/full.wav``, etc.). Relink.
3. **Episode-id dir match** — the DB row has
   ``episodes/OLD-UUID/…`` but the UUID no longer exists; find a dir
   under ``storage/episodes/`` that contains a file with the matching
   basename in the matching subpath.

Rows that still don't resolve after step 3 are reported — the UI
shows them in the Backup section so the operator can choose to
re-assemble or drop them.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from drevalis.models.media_asset import MediaAsset

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)


@dataclass
class RepairReport:
    scanned: int = 0
    already_ok: int = 0
    relinked: int = 0
    unresolved: int = 0
    relinked_paths: list[tuple[str, str]] = None  # (old, new)
    unresolved_paths: list[str] = None

    def __post_init__(self) -> None:
        if self.relinked_paths is None:
            self.relinked_paths = []
        if self.unresolved_paths is None:
            self.unresolved_paths = []

    def to_dict(self) -> dict[str, Any]:
        return {
            "scanned": self.scanned,
            "already_ok": self.already_ok,
            "relinked": self.relinked,
            "unresolved": self.unresolved,
            "relinked_paths": [{"from": a, "to": b} for a, b in self.relinked_paths[:50]],
            "unresolved_paths": self.unresolved_paths[:50],
        }


# Asset type → list of (subdir, filename-glob) candidates on disk.
_TYPE_CANDIDATES: dict[str, list[tuple[str, str]]] = {
    "video": [("output", "final.mp4"), ("output", "*.mp4")],
    "video_proxy": [("output", "proxy.mp4")],
    "thumbnail": [("output", "thumbnail.jpg"), ("output", "*.jpg")],
    "voiceover": [
        ("voice", "full.wav"),
        ("audio", "voiceover.wav"),
        ("voice", "*.wav"),
        ("audio", "*.wav"),
    ],
    "scene": [("scenes", "*.png"), ("scenes", "*.jpg")],
    "scene_video": [("scenes", "*.mp4")],
    "caption": [("captions", "*.ass"), ("captions", "*.srt")],
}


async def repair_media_links(
    session: AsyncSession,
    storage_base: Path,
) -> RepairReport:
    """Walk every ``media_assets`` row, fix broken ``file_path``s where
    we can locate a matching file on disk, and commit.
    """
    report = RepairReport()
    episodes_root = storage_base / "episodes"
    if not episodes_root.exists():
        return report

    # Index existing files under storage/episodes by (subdir, filename)
    # once so lookups are O(1).
    index: dict[tuple[str, str], list[Path]] = {}
    for ep_dir in episodes_root.iterdir():
        if not ep_dir.is_dir():
            continue
        for sub in ("output", "voice", "audio", "scenes", "captions"):
            sd = ep_dir / sub
            if not sd.exists():
                continue
            for f in sd.iterdir():
                if not f.is_file():
                    continue
                index.setdefault((sub, f.name), []).append(f)

    rows = (await session.execute(select(MediaAsset))).scalars().all()
    for row in rows:
        report.scanned += 1
        current = row.file_path or ""
        abs_current = (storage_base / current).resolve() if current else None
        if abs_current and abs_current.exists():
            report.already_ok += 1
            continue

        # Try to find a matching file on disk.
        new_path = _find_candidate(row, index, episodes_root)
        if new_path is not None:
            rel = new_path.relative_to(storage_base).as_posix()
            old = row.file_path
            row.file_path = rel
            row.file_size_bytes = new_path.stat().st_size
            report.relinked += 1
            report.relinked_paths.append((old or "", rel))
        else:
            report.unresolved += 1
            if current:
                report.unresolved_paths.append(current)

    if report.relinked:
        await session.commit()
    return report


def _find_candidate(
    row: MediaAsset, index: dict[tuple[str, str], list[Path]], _episodes_root: Path
) -> Path | None:
    """Given a broken media_asset, locate its file via three strategies."""
    current = row.file_path or ""
    basename = Path(current).name if current else ""

    # 1. Same basename in the expected subdir. Uses the asset type's
    #    candidate subdirs so a "thumbnail" doesn't match a random
    #    thumbnail.jpg in the wrong episode.
    candidates = _TYPE_CANDIDATES.get(row.asset_type, [])
    for subdir, _glob in candidates:
        if basename:
            hits = index.get((subdir, basename)) or []
            if len(hits) == 1:
                return hits[0]

    # 2. Same basename anywhere (weaker).
    if basename:
        for (sub, name), hits in index.items():
            if name == basename and len(hits) == 1:
                return hits[0]

    # 3. For scenes specifically — if the DB has a scene_number but no
    #    unique filename match, try ``scene_{NN}.png``.
    if row.asset_type == "scene" and row.scene_number is not None:
        needle = f"scene_{int(row.scene_number):02d}.png"
        hits = index.get(("scenes", needle)) or []
        if hits:
            # Prefer a file within an episode dir that matches part of
            # the current file_path; otherwise just take the first.
            for h in hits:
                if row.episode_id is not None and str(row.episode_id) in h.as_posix():
                    return h
            return hits[0]

    return None
