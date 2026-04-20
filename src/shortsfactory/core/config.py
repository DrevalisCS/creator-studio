"""Application settings loaded from environment variables / .env file."""

from __future__ import annotations

from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Central configuration for ShortsFactory.

    Values are read from environment variables (case-insensitive) and fall back
    to a ``.env`` file when present.  Required fields that have no default
    **must** be supplied at runtime.
    """

    # ── Application ───────────────────────────────────────────────────────
    app_name: str = "ShortsFactory"
    debug: bool = False
    app_timezone: str = "UTC"  # IANA timezone (e.g. "Europe/Amsterdam")

    # ── Database ──────────────────────────────────────────────────────────
    database_url: str = (
        "postgresql+asyncpg://shortsfactory:shortsfactory@localhost:5432/shortsfactory"
    )
    db_pool_size: int = 10
    db_max_overflow: int = 20

    # ── Redis ─────────────────────────────────────────────────────────────
    redis_url: str = "redis://localhost:6379/0"

    # ── Storage ───────────────────────────────────────────────────────────
    storage_base_path: Path = Path("./storage")

    # ── Encryption (Fernet) ───────────────────────────────────────────────
    encryption_key: str  # Required — no default

    # ── LM Studio (local LLM) ────────────────────────────────────────────
    lm_studio_base_url: str = "http://localhost:1234/v1"
    lm_studio_default_model: str = "local-model"

    # ── Anthropic (Claude fallback) ───────────────────────────────────────
    anthropic_api_key: str = ""

    # ── ComfyUI ───────────────────────────────────────────────────────────
    comfyui_default_url: str = "http://localhost:8188"

    # ── Piper TTS ─────────────────────────────────────────────────────────
    piper_models_path: Path = Path("./storage/models/piper")

    # ── Kokoro TTS ────────────────────────────────────────────────────────
    kokoro_models_path: Path = Path("./storage/models/kokoro")

    # ── FFmpeg ────────────────────────────────────────────────────────────
    ffmpeg_path: str = "ffmpeg"

    # ── Video defaults ────────────────────────────────────────────────────
    video_width: int = 1080
    video_height: int = 1920
    video_fps: int = 30
    video_max_duration: int = 60

    # ── YouTube OAuth ──────────────────────────────────────────────────────
    youtube_client_id: str = ""
    youtube_client_secret: str = ""
    youtube_redirect_uri: str = "http://localhost:8000/api/v1/youtube/callback"

    # ── TikTok OAuth ─────────────────────────────────────────────────────
    tiktok_client_key: str = ""
    tiktok_client_secret: str = ""
    tiktok_redirect_uri: str = "http://localhost:8000/api/v1/social/tiktok/callback"

    # ── Authentication (H4) ───────────────────────────────────────────────
    api_auth_token: str | None = None

    # ── RunPod cloud GPU ──────────────────────────────────────────────────
    runpod_api_key: str = ""

    # ── Rate limiting (M3) ────────────────────────────────────────────────
    max_concurrent_generations: int = 4

    # ── Job timeouts ─────────────────────────────────────────────────────
    shorts_job_timeout: int = 7200  # 2 hours
    longform_job_timeout: int = 14400  # 4 hours

    # ── Licensing ─────────────────────────────────────────────────────────
    # Base URL of the owner-operated license server (Phase 2). None in
    # Phase 1 since licenses are minted offline with scripts/mint_license.py.
    license_server_url: str | None = None
    # Dev/test escape hatch: when set, replaces the embedded public key list
    # with this single PEM. Never set in production.
    license_public_key_override: str | None = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    @model_validator(mode="after")
    def validate_encryption_key(self) -> Settings:
        """Validate encryption_key is a valid Fernet key at startup (M1)."""
        import base64

        key = self.encryption_key
        try:
            key_bytes = key.encode() if isinstance(key, str) else key
            decoded = base64.urlsafe_b64decode(key_bytes)
        except Exception:
            raise ValueError(
                "ENCRYPTION_KEY is not a valid Fernet key (base64 decode failed). "
                'Generate one with: python -c "from cryptography.fernet import Fernet; '
                'print(Fernet.generate_key().decode())"'
            ) from None
        if len(decoded) != 32:
            raise ValueError(
                f"ENCRYPTION_KEY decoded length is {len(decoded)}, expected 32. "
                "Generate a proper Fernet key."
            )
        return self
