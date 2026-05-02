"""Tests for ``core/config.py``.

Settings is the source of truth for every env var. Pin:

* ``encryption_key`` is required (no default).
* The Fernet validator rejects non-base64 / wrong-length keys at startup
  so a misconfigured install fails fast instead of crashing on the first
  encrypt() call.
* ``get_session_secret`` falls back to the Fernet key when the dedicated
  ``session_secret`` is unset (backwards compat).
"""

from __future__ import annotations

import base64

import pytest
from pydantic import ValidationError

from drevalis.core.config import Settings


def _valid_fernet_key() -> str:
    return base64.urlsafe_b64encode(b"\x00" * 32).decode()


# ── Required field ──────────────────────────────────────────────────


class TestEncryptionKeyRequired:
    def test_missing_encryption_key_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Pydantic-settings reads env first, so wipe ENCRYPTION_KEY
        # plus any .env shadowing for this test.
        monkeypatch.delenv("ENCRYPTION_KEY", raising=False)
        monkeypatch.setattr(
            "drevalis.core.config.SettingsConfigDict",
            lambda **kw: {**kw, "env_file": None},
        )
        # Direct construction without the env var must fail.
        with pytest.raises(ValidationError):
            Settings(_env_file=None)  # type: ignore[call-arg]


# ── validate_encryption_key (model_validator) ───────────────────────


class TestValidateEncryptionKey:
    def test_valid_fernet_key_accepted(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("ENCRYPTION_KEY", _valid_fernet_key())
        s = Settings(_env_file=None)  # type: ignore[call-arg]
        assert s.encryption_key

    def test_non_base64_rejected(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Using padding/character that base64.urlsafe_b64decode rejects.
        monkeypatch.setenv("ENCRYPTION_KEY", "!!!not-base64!!!")
        with pytest.raises(ValidationError, match="not a valid Fernet key"):
            Settings(_env_file=None)  # type: ignore[call-arg]

    def test_wrong_decoded_length_rejected(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # 16-byte key — decodes fine but Fernet requires 32 bytes.
        short = base64.urlsafe_b64encode(b"\x00" * 16).decode()
        monkeypatch.setenv("ENCRYPTION_KEY", short)
        with pytest.raises(ValidationError, match="decoded length"):
            Settings(_env_file=None)  # type: ignore[call-arg]


# ── get_session_secret ──────────────────────────────────────────────


class TestGetSessionSecret:
    def test_falls_back_to_encryption_key_when_unset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The fallback exists so legacy installs (pre-session_secret)
        # keep their cookies valid across upgrades.
        key = _valid_fernet_key()
        monkeypatch.setenv("ENCRYPTION_KEY", key)
        monkeypatch.delenv("SESSION_SECRET", raising=False)
        s = Settings(_env_file=None)  # type: ignore[call-arg]
        assert s.session_secret is None
        assert s.get_session_secret() == key

    def test_uses_dedicated_session_secret_when_set(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("ENCRYPTION_KEY", _valid_fernet_key())
        monkeypatch.setenv("SESSION_SECRET", "dedicated-cookie-hmac")
        s = Settings(_env_file=None)  # type: ignore[call-arg]
        assert s.get_session_secret() == "dedicated-cookie-hmac"
