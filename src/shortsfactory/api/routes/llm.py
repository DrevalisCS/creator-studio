"""LLM configuration API router -- CRUD and connection testing."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from shortsfactory.core.config import Settings
from shortsfactory.core.deps import get_db, get_settings
from shortsfactory.core.security import encrypt_value
from shortsfactory.models.llm_config import LLMConfig
from shortsfactory.repositories.llm_config import LLMConfigRepository
from shortsfactory.schemas.llm_config import (
    LLMConfigCreate,
    LLMConfigResponse,
    LLMConfigUpdate,
    LLMTestRequest,
    LLMTestResponse,
)

router = APIRouter(prefix="/api/v1/llm", tags=["llm"])


# ── Helpers ───────────────────────────────────────────────────────────────


def _config_to_response(config: LLMConfig) -> LLMConfigResponse:
    """Convert an LLMConfig ORM object to a response with has_api_key."""
    return LLMConfigResponse(
        id=config.id,
        name=config.name,
        base_url=config.base_url,
        model_name=config.model_name,
        has_api_key=config.api_key_encrypted is not None,
        max_tokens=config.max_tokens,
        temperature=float(config.temperature),
        created_at=config.created_at,
        updated_at=config.updated_at,
    )


# ── List LLM configs ─────────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[LLMConfigResponse],
    status_code=status.HTTP_200_OK,
    summary="List all LLM configurations",
)
async def list_llm_configs(
    db: AsyncSession = Depends(get_db),
) -> list[LLMConfigResponse]:
    """Return all registered LLM configurations."""
    repo = LLMConfigRepository(db)
    configs = await repo.get_all()
    return [_config_to_response(c) for c in configs]


# ── Create LLM config ────────────────────────────────────────────────────


@router.post(
    "",
    response_model=LLMConfigResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new LLM configuration",
)
async def create_llm_config(
    payload: LLMConfigCreate,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> LLMConfigResponse:
    """Create a new LLM configuration.

    If an api_key is provided, it will be encrypted before storage.
    """
    repo = LLMConfigRepository(db)

    # Encrypt API key if provided.
    api_key_encrypted = None
    api_key_version = 1
    if payload.api_key:
        api_key_encrypted, api_key_version = encrypt_value(payload.api_key, settings.encryption_key)

    config = await repo.create(
        name=payload.name,
        base_url=payload.base_url,
        model_name=payload.model_name,
        api_key_encrypted=api_key_encrypted,
        api_key_version=api_key_version,
        max_tokens=payload.max_tokens,
        temperature=payload.temperature,
    )
    await db.commit()
    await db.refresh(config)
    return _config_to_response(config)


# ── Get LLM config ───────────────────────────────────────────────────────


@router.get(
    "/{config_id}",
    response_model=LLMConfigResponse,
    status_code=status.HTTP_200_OK,
    summary="Get an LLM configuration by ID",
)
async def get_llm_config(
    config_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> LLMConfigResponse:
    """Fetch a single LLM configuration by ID."""
    repo = LLMConfigRepository(db)
    config = await repo.get_by_id(config_id)
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"LLM config {config_id} not found",
        )
    return _config_to_response(config)


# ── Update LLM config ────────────────────────────────────────────────────


@router.put(
    "/{config_id}",
    response_model=LLMConfigResponse,
    status_code=status.HTTP_200_OK,
    summary="Update an LLM configuration",
)
async def update_llm_config(
    config_id: UUID,
    payload: LLMConfigUpdate,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> LLMConfigResponse:
    """Update an existing LLM configuration."""
    repo = LLMConfigRepository(db)
    update_data = payload.model_dump(exclude_unset=True)

    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No fields to update",
        )

    # Handle API key encryption.
    if "api_key" in update_data:
        raw_key = update_data.pop("api_key")
        if raw_key is not None:
            encrypted, version = encrypt_value(raw_key, settings.encryption_key)
            update_data["api_key_encrypted"] = encrypted
            update_data["api_key_version"] = version
        else:
            update_data["api_key_encrypted"] = None

    config = await repo.update(config_id, **update_data)
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"LLM config {config_id} not found",
        )
    await db.commit()
    await db.refresh(config)
    return _config_to_response(config)


# ── Delete LLM config ────────────────────────────────────────────────────


@router.delete(
    "/{config_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an LLM configuration",
)
async def delete_llm_config(
    config_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete an LLM configuration by ID."""
    repo = LLMConfigRepository(db)
    deleted = await repo.delete(config_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"LLM config {config_id} not found",
        )
    await db.commit()


# ── Test LLM config ──────────────────────────────────────────────────────


@router.post(
    "/{config_id}/test",
    response_model=LLMTestResponse,
    status_code=status.HTTP_200_OK,
    summary="Test LLM configuration with sample prompt",
)
async def test_llm_config(
    config_id: UUID,
    payload: LLMTestRequest | None = None,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> LLMTestResponse:
    """Send a test prompt to the configured LLM endpoint and return the result."""
    repo = LLMConfigRepository(db)
    config = await repo.get_by_id(config_id)
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"LLM config {config_id} not found",
        )

    prompt_text = "Say hello in one sentence."
    if payload is not None:
        prompt_text = payload.prompt

    try:
        from shortsfactory.services.llm import LLMService
        from shortsfactory.services.storage import LocalStorage

        storage = LocalStorage(settings.storage_base_path)
        # Pass the encryption key to LLMService so it can decrypt API keys
        # internally without mutating the ORM object (M5 fix).
        service = LLMService(storage=storage, encryption_key=settings.encryption_key)

        # Expunge the config from the session so that no accidental
        # autoflush can persist decrypted values to the database.
        db.expunge(config)

        provider = service.get_provider(config)
        result = await provider.generate(
            system_prompt="You are a helpful assistant.",
            user_prompt=prompt_text,
            temperature=float(config.temperature),
            max_tokens=min(config.max_tokens, 256),
        )

        return LLMTestResponse(
            success=True,
            message="LLM test completed successfully",
            response_text=result.content[:500],
            model=result.model,
            tokens_used=result.total_tokens,
        )
    except Exception:
        return LLMTestResponse(
            success=False,
            message="LLM test failed. Check server logs for details.",
        )
