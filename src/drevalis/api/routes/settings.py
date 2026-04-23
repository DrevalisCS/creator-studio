"""Settings API router -- storage usage, system health, FFmpeg info."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, status
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from drevalis.core.config import Settings
from drevalis.core.deps import get_db, get_redis, get_settings
from drevalis.schemas.settings import (
    FFmpegInfoResponse,
    HealthCheckResponse,
    ServiceHealth,
    StorageUsageResponse,
)
from drevalis.services.storage import LocalStorage

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])


# ── Helpers ───────────────────────────────────────────────────────────────


def _human_size(size_bytes: int) -> str:
    """Convert bytes to a human-readable string."""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(size_bytes) < 1024.0:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024.0  # type: ignore[assignment]
    return f"{size_bytes:.1f} PB"


# ── Storage usage ─────────────────────────────────────────────────────────


@router.get(
    "/storage",
    response_model=StorageUsageResponse,
    status_code=status.HTTP_200_OK,
    summary="Storage usage info",
)
async def storage_usage(
    settings: Settings = Depends(get_settings),
) -> StorageUsageResponse:
    """Return total disk usage of the storage directory, the absolute
    container path, the host-side bind-mount root, and a per-subdir
    byte breakdown. The breakdown is the useful bit when a user has
    copied media into a host directory that isn't actually bind-
    mounted: every subdir shows 0 bytes and the mismatch is obvious.
    """
    storage = LocalStorage(settings.storage_base_path)
    total = await storage.get_total_size_bytes()
    base_abs = Path(settings.storage_base_path).resolve()

    # Subdir breakdown — walk each top-level folder the app ships.
    subdir_sizes: dict[str, int] = {}
    for name in (
        "episodes",
        "audiobooks",
        "voice_previews",
        "backups",
        "models",
        "temp",
        "music",
        "workflows",
    ):
        sub = base_abs / name
        if not sub.exists():
            continue
        sub_total = 0
        try:
            for f in sub.rglob("*"):
                if f.is_file():
                    try:
                        sub_total += f.stat().st_size
                    except OSError:
                        pass
        except OSError:
            pass
        subdir_sizes[name] = sub_total

    # Host-side bind-mount root via /proc/self/mountinfo.
    host_source: str | None = None
    try:
        lines = Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines()
        path_str = str(base_abs)
        best: tuple[int, str] | None = None
        for line in lines:
            parts = line.split()
            if len(parts) < 5:
                continue
            root = parts[3]
            mount_point = parts[4]
            if path_str == mount_point or path_str.startswith(mount_point.rstrip("/") + "/"):
                tail = path_str[len(mount_point) :]
                suffix = tail if tail.startswith("/") else ("/" + tail if tail else "")
                source = root.rstrip("/") + suffix
                depth = len(mount_point)
                if best is None or depth > best[0]:
                    best = (depth, source)
        if best:
            host_source = best[1]
    except (OSError, UnicodeDecodeError):
        pass

    return StorageUsageResponse(
        total_size_bytes=total,
        total_size_human=_human_size(total),
        storage_base_path=str(settings.storage_base_path),
        storage_base_abs=str(base_abs),
        host_source_path=host_source,
        subdir_sizes=subdir_sizes,
    )


# ── System health check ──────────────────────────────────────────────────


async def _check_database(db: AsyncSession) -> ServiceHealth:
    """Check PostgreSQL connectivity with a simple query."""
    try:
        from sqlalchemy import text

        await db.execute(text("SELECT 1"))
        return ServiceHealth(name="database", status="ok")
    except Exception as exc:
        return ServiceHealth(
            name="database",
            status="unreachable",
            message=str(exc)[:200],
        )


async def _check_redis(redis: Redis) -> ServiceHealth:
    """Check Redis connectivity with PING."""
    try:
        pong = await redis.ping()
        if pong:
            return ServiceHealth(name="redis", status="ok")
        return ServiceHealth(name="redis", status="degraded", message="Ping returned False")
    except Exception as exc:
        return ServiceHealth(
            name="redis",
            status="unreachable",
            message=str(exc)[:200],
        )


async def _check_comfyui_servers(db: AsyncSession, default_url: str) -> list[ServiceHealth]:
    """Check each active ComfyUI server's connectivity.

    Queries the database for all active servers and tests each one.
    Also tests the default URL from settings if no DB servers are configured.
    """
    import httpx

    from drevalis.repositories.comfyui import ComfyUIServerRepository

    results: list[ServiceHealth] = []

    # Try to fetch active servers from DB
    try:
        repo = ComfyUIServerRepository(db)
        active_servers = await repo.get_active_servers()
    except Exception:
        active_servers = []

    if active_servers:
        for server in active_servers:
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                    resp = await client.get(f"{server.url}/system_stats")
                    if resp.status_code == 200:
                        results.append(
                            ServiceHealth(
                                name=f"comfyui:{server.name}",
                                status="ok",
                                message=server.url,
                            )
                        )
                    else:
                        results.append(
                            ServiceHealth(
                                name=f"comfyui:{server.name}",
                                status="degraded",
                                message=f"HTTP {resp.status_code} at {server.url}",
                            )
                        )
            except Exception as exc:
                results.append(
                    ServiceHealth(
                        name=f"comfyui:{server.name}",
                        status="unreachable",
                        message=f"{server.url} -- {str(exc)[:150]}",
                    )
                )
    else:
        # Fall back to checking the default URL from settings
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                resp = await client.get(f"{default_url}/system_stats")
                if resp.status_code == 200:
                    results.append(ServiceHealth(name="comfyui", status="ok"))
                else:
                    results.append(
                        ServiceHealth(
                            name="comfyui",
                            status="degraded",
                            message=f"HTTP {resp.status_code}",
                        )
                    )
        except Exception as exc:
            results.append(
                ServiceHealth(
                    name="comfyui",
                    status="unreachable",
                    message=str(exc)[:200],
                )
            )

    return results


async def _check_ffmpeg(ffmpeg_path: str) -> ServiceHealth:
    """Check that the FFmpeg binary exists and report its version."""
    try:
        proc = await asyncio.create_subprocess_exec(
            ffmpeg_path,
            "-version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0:
            version_line = stdout.decode("utf-8", errors="replace").split("\n")[0]
            return ServiceHealth(
                name="ffmpeg",
                status="ok",
                message=version_line.strip(),
            )
        return ServiceHealth(
            name="ffmpeg",
            status="degraded",
            message=f"Exit code {proc.returncode}",
        )
    except Exception as exc:
        return ServiceHealth(
            name="ffmpeg",
            status="unreachable",
            message=str(exc)[:200],
        )


async def _check_piper_tts(models_path: Path) -> ServiceHealth:
    """Check that the Piper TTS models directory exists and contains models."""
    try:
        if not models_path.exists():
            return ServiceHealth(
                name="piper_tts",
                status="unreachable",
                message=f"Models directory not found: {models_path}",
            )

        if not models_path.is_dir():
            return ServiceHealth(
                name="piper_tts",
                status="degraded",
                message=f"Path exists but is not a directory: {models_path}",
            )

        # Count .onnx model files (Piper uses ONNX models)
        model_files = list(models_path.glob("*.onnx"))
        if not model_files:
            return ServiceHealth(
                name="piper_tts",
                status="degraded",
                message=f"Models directory exists but contains no .onnx files: {models_path}",
            )

        return ServiceHealth(
            name="piper_tts",
            status="ok",
            message=f"{len(model_files)} model(s) found in {models_path}",
        )
    except Exception as exc:
        return ServiceHealth(
            name="piper_tts",
            status="unreachable",
            message=str(exc)[:200],
        )


async def _check_lm_studio(base_url: str) -> ServiceHealth:
    """Check LM Studio connectivity by hitting the /models endpoint."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
            resp = await client.get(f"{base_url}/models")
            if resp.status_code == 200:
                data = resp.json()
                model_count = len(data.get("data", []))
                return ServiceHealth(
                    name="lm_studio",
                    status="ok",
                    message=f"{model_count} model(s) loaded at {base_url}",
                )
            return ServiceHealth(
                name="lm_studio",
                status="degraded",
                message=f"HTTP {resp.status_code} from {base_url}/models",
            )
    except Exception as exc:
        return ServiceHealth(
            name="lm_studio",
            status="unreachable",
            message=f"{base_url} -- {str(exc)[:150]}",
        )


@router.get(
    "/health",
    response_model=HealthCheckResponse,
    status_code=status.HTTP_200_OK,
    summary="System health check (DB, Redis, ComfyUI, FFmpeg, Piper TTS, LM Studio)",
)
async def system_health(
    db: AsyncSession = Depends(get_db),
    redis: Redis = Depends(get_redis),
    settings: Settings = Depends(get_settings),
) -> HealthCheckResponse:
    """Check the health of all backend services concurrently.

    Returns structured status for: PostgreSQL, Redis, ComfyUI server(s),
    FFmpeg, Piper TTS models, and LM Studio.
    """
    # Run all health checks concurrently for faster response
    (
        db_health,
        redis_health,
        comfyui_healths,
        ffmpeg_health,
        piper_health,
        lm_studio_health,
    ) = await asyncio.gather(
        _check_database(db),
        _check_redis(redis),
        _check_comfyui_servers(db, settings.comfyui_default_url),
        _check_ffmpeg(settings.ffmpeg_path),
        _check_piper_tts(settings.piper_models_path),
        _check_lm_studio(settings.lm_studio_base_url),
    )

    services: list[ServiceHealth] = [
        db_health,
        redis_health,
        *comfyui_healths,
        ffmpeg_health,
        piper_health,
        lm_studio_health,
    ]

    # -- Overall status -----------------------------------------------------
    statuses = {s.status for s in services}
    if statuses == {"ok"}:
        overall = "ok"
    elif "unreachable" in statuses:
        overall = "unhealthy"
    else:
        overall = "degraded"

    return HealthCheckResponse(overall=overall, services=services)


# ── FFmpeg info ───────────────────────────────────────────────────────────


@router.get(
    "/ffmpeg",
    response_model=FFmpegInfoResponse,
    status_code=status.HTTP_200_OK,
    summary="FFmpeg version and path info",
)
async def ffmpeg_info(
    settings: Settings = Depends(get_settings),
) -> FFmpegInfoResponse:
    """Return FFmpeg installation details."""
    ffmpeg_path = settings.ffmpeg_path

    # Check if ffmpeg is available on PATH or at the configured path.
    resolved = shutil.which(ffmpeg_path)
    if resolved is None:
        return FFmpegInfoResponse(
            ffmpeg_path=ffmpeg_path,
            available=False,
            message=f"FFmpeg not found at '{ffmpeg_path}'",
        )

    try:
        proc = await asyncio.create_subprocess_exec(
            resolved,
            "-version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0:
            version_line = stdout.decode("utf-8", errors="replace").split("\n")[0]
            return FFmpegInfoResponse(
                ffmpeg_path=resolved,
                available=True,
                version=version_line.strip(),
                message="FFmpeg is available",
            )
        else:
            return FFmpegInfoResponse(
                ffmpeg_path=resolved,
                available=False,
                message=f"FFmpeg exited with code {proc.returncode}",
            )
    except Exception as exc:
        return FFmpegInfoResponse(
            ffmpeg_path=ffmpeg_path,
            available=False,
            message=f"Error checking FFmpeg: {exc}",
        )
