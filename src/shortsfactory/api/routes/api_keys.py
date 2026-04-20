"""API key store router -- encrypted storage/retrieval of third-party API keys.

Endpoints
---------
GET  /api/v1/settings/api-keys                   List stored key names (values never returned)
POST /api/v1/settings/api-keys                   Store or update an encrypted API key
DELETE /api/v1/settings/api-keys/{key_name}      Delete a stored API key
GET  /api/v1/settings/integrations               Report configuration status of all integrations

These endpoints let the frontend Settings UI read/write integration credentials
without the user needing direct access to ``.env`` or environment variables.
Values are Fernet-encrypted before being persisted to the ``api_key_store`` table.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from shortsfactory.core.config import Settings
from shortsfactory.core.deps import get_db, get_settings
from shortsfactory.core.security import encrypt_value
from shortsfactory.repositories.api_key_store import ApiKeyStoreRepository
from shortsfactory.schemas.runpod import (
    ApiKeyStoreListItem,
    ApiKeyStoreListResponse,
    ApiKeyStoreRequest,
    IntegrationsStatusResponse,
    IntegrationStatus,
)

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])


# ── API key CRUD ──────────────────────────────────────────────────────────


@router.get(
    "/api-keys",
    response_model=ApiKeyStoreListResponse,
    status_code=status.HTTP_200_OK,
    summary="List stored API key names",
    description=(
        "Returns the names (slugs) of all API keys stored in the database.  "
        "The encrypted values are never included in the response."
    ),
)
async def list_api_keys(
    db: AsyncSession = Depends(get_db),
) -> ApiKeyStoreListResponse:
    """Return all stored API key names without their values."""
    repo = ApiKeyStoreRepository(db)
    entries = await repo.get_all()
    items = [ApiKeyStoreListItem(key_name=e.key_name) for e in entries]
    return ApiKeyStoreListResponse(items=items)


@router.post(
    "/api-keys",
    response_model=ApiKeyStoreListItem,
    status_code=status.HTTP_200_OK,
    summary="Store or update an encrypted API key",
    description=(
        "Encrypts the provided API key with the application Fernet key and stores "
        "it in the database.  If a key for ``key_name`` already exists it is "
        "overwritten.  The plain-text value is never persisted."
    ),
)
async def upsert_api_key(
    payload: ApiKeyStoreRequest,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ApiKeyStoreListItem:
    """Encrypt and persist a third-party API key."""
    encrypted, key_version = encrypt_value(payload.api_key, settings.encryption_key)

    repo = ApiKeyStoreRepository(db)
    await repo.upsert(
        key_name=payload.key_name,
        encrypted_value=encrypted,
        key_version=key_version,
    )
    await db.commit()
    return ApiKeyStoreListItem(key_name=payload.key_name, has_value=True)


@router.delete(
    "/api-keys/{key_name}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a stored API key",
    description="Permanently removes the encrypted API key for the given name.",
)
async def delete_api_key(
    key_name: str,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Remove a stored API key entry by name."""
    repo = ApiKeyStoreRepository(db)
    deleted = await repo.delete_by_key_name(key_name)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No API key stored for '{key_name}'.",
        )
    await db.commit()


# ── Integrations status ───────────────────────────────────────────────────


@router.get(
    "/integrations",
    response_model=IntegrationsStatusResponse,
    status_code=status.HTTP_200_OK,
    summary="Integration configuration status",
    description=(
        "Reports whether each supported third-party integration has a key "
        "configured.  Checks both the DB store and env vars.  "
        "Actual key values are never returned."
    ),
)
async def get_integrations_status(
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> IntegrationsStatusResponse:
    """Check which third-party integrations are configured."""
    repo = ApiKeyStoreRepository(db)
    all_entries = await repo.get_all()
    stored_keys = {e.key_name for e in all_entries}

    def _status(key_name: str, env_value: str) -> IntegrationStatus:
        """Determine source for a given integration key."""
        if key_name in stored_keys:
            return IntegrationStatus(configured=True, source="db")
        if env_value:
            return IntegrationStatus(configured=True, source="env")
        return IntegrationStatus(configured=False, source="none")

    return IntegrationsStatusResponse(
        runpod=_status("runpod", settings.runpod_api_key),
        elevenlabs=_status("elevenlabs", ""),  # ElevenLabs key is per voice-profile
        anthropic=_status("anthropic", settings.anthropic_api_key),
        youtube=_status(
            "youtube",
            # YouTube is configured when the OAuth client ID is present.
            settings.youtube_client_id,
        ),
    )
