"""Prompt Templates API router -- CRUD endpoints."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from shortsfactory.core.deps import get_db
from shortsfactory.repositories.prompt_template import PromptTemplateRepository
from shortsfactory.schemas.prompt_template import (
    PromptTemplateCreate,
    PromptTemplateResponse,
    PromptTemplateUpdate,
)

router = APIRouter(prefix="/api/v1/prompt-templates", tags=["prompt-templates"])


# ── List prompt templates ─────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[PromptTemplateResponse],
    status_code=status.HTTP_200_OK,
    summary="List all prompt templates",
)
async def list_prompt_templates(
    template_type: str | None = Query(
        default=None,
        description="Filter by type: script, visual, hook, hashtag",
    ),
    db: AsyncSession = Depends(get_db),
) -> list[PromptTemplateResponse]:
    """Return all prompt templates, optionally filtered by type."""
    repo = PromptTemplateRepository(db)
    if template_type is not None:
        templates = await repo.get_by_type(template_type)
    else:
        templates = await repo.get_all()
    return [PromptTemplateResponse.model_validate(t) for t in templates]


# ── Create prompt template ────────────────────────────────────────────────


@router.post(
    "",
    response_model=PromptTemplateResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new prompt template",
)
async def create_prompt_template(
    payload: PromptTemplateCreate,
    db: AsyncSession = Depends(get_db),
) -> PromptTemplateResponse:
    """Create a new prompt template."""
    repo = PromptTemplateRepository(db)
    template = await repo.create(**payload.model_dump())
    await db.commit()
    await db.refresh(template)
    return PromptTemplateResponse.model_validate(template)


# ── Get prompt template ──────────────────────────────────────────────────


@router.get(
    "/{template_id}",
    response_model=PromptTemplateResponse,
    status_code=status.HTTP_200_OK,
    summary="Get a prompt template by ID",
)
async def get_prompt_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> PromptTemplateResponse:
    """Fetch a single prompt template by ID."""
    repo = PromptTemplateRepository(db)
    template = await repo.get_by_id(template_id)
    if template is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Prompt template {template_id} not found",
        )
    return PromptTemplateResponse.model_validate(template)


# ── Update prompt template ───────────────────────────────────────────────


@router.put(
    "/{template_id}",
    response_model=PromptTemplateResponse,
    status_code=status.HTTP_200_OK,
    summary="Update a prompt template",
)
async def update_prompt_template(
    template_id: UUID,
    payload: PromptTemplateUpdate,
    db: AsyncSession = Depends(get_db),
) -> PromptTemplateResponse:
    """Update an existing prompt template."""
    repo = PromptTemplateRepository(db)
    update_data = payload.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No fields to update",
        )
    template = await repo.update(template_id, **update_data)
    if template is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Prompt template {template_id} not found",
        )
    await db.commit()
    await db.refresh(template)
    return PromptTemplateResponse.model_validate(template)


# ── Delete prompt template ───────────────────────────────────────────────


@router.delete(
    "/{template_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a prompt template",
)
async def delete_prompt_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a prompt template by ID."""
    repo = PromptTemplateRepository(db)
    deleted = await repo.delete(template_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Prompt template {template_id} not found",
        )
    await db.commit()
