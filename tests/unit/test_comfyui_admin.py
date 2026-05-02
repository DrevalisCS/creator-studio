"""Tests for ``services/comfyui_admin.py`` — URL validation narrowing.

Pin the SSRF-validator catch contract: only ``UnsafeURLError`` (the
explicit subclass of ValueError that the validator raises) gets wrapped
into a domain ``ValidationError``. Unrelated ``ValueError`` from inside
the create path must propagate so a real bug isn't silently masked as
"Invalid server URL".
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from drevalis.core.exceptions import ValidationError
from drevalis.core.validators import UnsafeURLError
from drevalis.services.comfyui_admin import ComfyUIServerService


def _service() -> ComfyUIServerService:
    db = MagicMock()
    db.commit = AsyncMock()
    db.refresh = AsyncMock()
    return ComfyUIServerService(db, encryption_key="dummy")


class TestCreateUrlValidationNarrowing:
    async def test_unsafe_url_wrapped_into_validation_error(self) -> None:
        # Pin: a private-network URL surfaces as a domain ValidationError
        # (which the route maps to 422) rather than a 500.
        svc = _service()
        with pytest.raises(ValidationError, match="Invalid server URL"):
            await svc.create(
                name="bad",
                # ftp:// scheme is blocked by validate_safe_url_or_localhost.
                url="ftp://example.com/",
                max_concurrent=1,
                api_key=None,
                is_active=True,
            )

    async def test_unrelated_valueerror_not_swallowed(self) -> None:
        # Pin: an unrelated ``ValueError`` raised AFTER the URL passes
        # validation must propagate untouched. Previously we caught
        # ``ValueError`` broadly which would have re-labelled this as
        # "Invalid server URL" — masking the real bug.
        svc = _service()
        with patch(
            "drevalis.services.comfyui_admin.encrypt_value",
            side_effect=ValueError("encryption-internal-bug"),
        ):
            with pytest.raises(ValueError, match="encryption-internal-bug"):
                await svc.create(
                    name="ok",
                    url="http://localhost:8188",
                    max_concurrent=1,
                    api_key="some-key",  # forces encrypt_value path
                    is_active=True,
                )

    async def test_unsafe_url_error_subclasses_value_error(self) -> None:
        # Sanity: defenders that *do* want to catch ValueError still
        # see UnsafeURLError. Subclass relationship is load-bearing —
        # don't accidentally break it.
        assert issubclass(UnsafeURLError, ValueError)


class TestCreateHappyPath:
    async def test_localhost_passes_validation(self) -> None:
        # Pin: localhost is permitted (Drevalis is local-first); the
        # service hands off to the repository.
        svc = _service()
        with patch.object(svc, "_repo") as repo:
            repo.create = AsyncMock(return_value=MagicMock())
            await svc.create(
                name="local",
                url="http://localhost:8188",
                max_concurrent=2,
                api_key=None,
                is_active=True,
            )
        repo.create.assert_awaited_once()
