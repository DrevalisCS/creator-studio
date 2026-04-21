"""ComfyUI API router -- CRUD for servers and workflows, connection testing."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from drevalis.core.config import Settings
from drevalis.core.deps import get_db, get_settings
from drevalis.core.security import decrypt_value, encrypt_value
from drevalis.models.comfyui import ComfyUIServer
from drevalis.repositories.comfyui import (
    ComfyUIServerRepository,
    ComfyUIWorkflowRepository,
)
from drevalis.schemas.comfyui import WorkflowInputMapping
from drevalis.schemas.comfyui_crud import (
    ComfyUIServerCreate,
    ComfyUIServerResponse,
    ComfyUIServerTestResponse,
    ComfyUIServerUpdate,
    ComfyUIWorkflowCreate,
    ComfyUIWorkflowResponse,
    ComfyUIWorkflowUpdate,
)

router = APIRouter(prefix="/api/v1/comfyui", tags=["comfyui"])


# ── Helpers ───────────────────────────────────────────────────────────────


def _server_to_response(server: ComfyUIServer) -> ComfyUIServerResponse:
    """Convert a ComfyUIServer ORM object to a response with has_api_key."""
    return ComfyUIServerResponse(
        id=server.id,
        name=server.name,
        url=server.url,
        has_api_key=server.api_key_encrypted is not None,
        max_concurrent=server.max_concurrent,
        is_active=server.is_active,
        last_tested_at=server.last_tested_at,
        last_test_status=server.last_test_status,
        created_at=server.created_at,
        updated_at=server.updated_at,
    )


# ═══════════════════════════════════════════════════════════════════════════
# Servers
# ═══════════════════════════════════════════════════════════════════════════


@router.get(
    "/servers",
    response_model=list[ComfyUIServerResponse],
    status_code=status.HTTP_200_OK,
    summary="List all ComfyUI servers",
)
async def list_servers(
    db: AsyncSession = Depends(get_db),
) -> list[ComfyUIServerResponse]:
    """Return all registered ComfyUI servers."""
    repo = ComfyUIServerRepository(db)
    servers = await repo.get_all()
    return [_server_to_response(s) for s in servers]


@router.post(
    "/servers",
    response_model=ComfyUIServerResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new ComfyUI server",
)
async def create_server(
    payload: ComfyUIServerCreate,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ComfyUIServerResponse:
    """Register a new ComfyUI server instance."""
    from drevalis.core.validators import validate_safe_url_or_localhost

    try:
        validate_safe_url_or_localhost(payload.url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid server URL: {exc}") from exc

    repo = ComfyUIServerRepository(db)

    # Encrypt API key if provided.
    api_key_encrypted = None
    api_key_version = 1
    if payload.api_key:
        api_key_encrypted, api_key_version = encrypt_value(payload.api_key, settings.encryption_key)

    server = await repo.create(
        name=payload.name,
        url=payload.url,
        api_key_encrypted=api_key_encrypted,
        api_key_version=api_key_version,
        max_concurrent=payload.max_concurrent,
        is_active=payload.is_active,
    )
    await db.commit()
    await db.refresh(server)
    return _server_to_response(server)


@router.get(
    "/servers/{server_id}",
    response_model=ComfyUIServerResponse,
    status_code=status.HTTP_200_OK,
    summary="Get a ComfyUI server by ID",
)
async def get_server(
    server_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> ComfyUIServerResponse:
    """Fetch a single ComfyUI server by ID."""
    repo = ComfyUIServerRepository(db)
    server = await repo.get_by_id(server_id)
    if server is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"ComfyUI server {server_id} not found",
        )
    return _server_to_response(server)


@router.put(
    "/servers/{server_id}",
    response_model=ComfyUIServerResponse,
    status_code=status.HTTP_200_OK,
    summary="Update a ComfyUI server",
)
async def update_server(
    server_id: UUID,
    payload: ComfyUIServerUpdate,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ComfyUIServerResponse:
    """Update an existing ComfyUI server."""
    repo = ComfyUIServerRepository(db)
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

    server = await repo.update(server_id, **update_data)
    if server is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"ComfyUI server {server_id} not found",
        )
    await db.commit()
    await db.refresh(server)
    return _server_to_response(server)


@router.delete(
    "/servers/{server_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a ComfyUI server",
)
async def delete_server(
    server_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Remove a ComfyUI server registration."""
    repo = ComfyUIServerRepository(db)
    deleted = await repo.delete(server_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"ComfyUI server {server_id} not found",
        )
    await db.commit()


@router.post(
    "/servers/{server_id}/test",
    response_model=ComfyUIServerTestResponse,
    status_code=status.HTTP_200_OK,
    summary="Test ComfyUI server connection",
)
async def test_server(
    server_id: UUID,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ComfyUIServerTestResponse:
    """Test connectivity to a ComfyUI server and update its health status."""
    repo = ComfyUIServerRepository(db)
    server = await repo.get_by_id(server_id)
    if server is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"ComfyUI server {server_id} not found",
        )

    # Decrypt API key if present.
    api_key: str | None = None
    if server.api_key_encrypted:
        try:
            api_key = decrypt_value(server.api_key_encrypted, settings.encryption_key)
        except Exception:
            api_key = None

    try:
        from drevalis.services.comfyui import ComfyUIClient

        client = ComfyUIClient(base_url=server.url, api_key=api_key)
        try:
            reachable = await client.test_connection()
        finally:
            await client.close()

        now = datetime.now(UTC)
        test_status = "ok" if reachable else "unreachable"
        await repo.update_test_status(server_id, test_status, now)
        await db.commit()

        if reachable:
            return ComfyUIServerTestResponse(
                success=True,
                message=f"Server '{server.name}' is reachable",
                server_id=server_id,
            )
        else:
            return ComfyUIServerTestResponse(
                success=False,
                message=f"Server '{server.name}' is unreachable",
                server_id=server_id,
            )
    except Exception as exc:
        now = datetime.now(UTC)
        await repo.update_test_status(server_id, f"error: {exc}", now)
        await db.commit()
        return ComfyUIServerTestResponse(
            success=False,
            message=f"Connection test failed: {exc}",
            server_id=server_id,
        )


# ═══════════════════════════════════════════════════════════════════════════
# Workflows
# ═══════════════════════════════════════════════════════════════════════════


@router.get(
    "/workflows",
    response_model=list[ComfyUIWorkflowResponse],
    status_code=status.HTTP_200_OK,
    summary="List all ComfyUI workflows",
)
async def list_workflows(
    db: AsyncSession = Depends(get_db),
) -> list[ComfyUIWorkflowResponse]:
    """Return all registered ComfyUI workflows."""
    repo = ComfyUIWorkflowRepository(db)
    workflows = await repo.get_all()
    return [ComfyUIWorkflowResponse.model_validate(w) for w in workflows]


@router.post(
    "/workflows",
    response_model=ComfyUIWorkflowResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new ComfyUI workflow",
)
async def create_workflow(
    payload: ComfyUIWorkflowCreate,
    db: AsyncSession = Depends(get_db),
) -> ComfyUIWorkflowResponse:
    """Register a new ComfyUI workflow template.

    The input_mappings field is validated against the WorkflowInputMapping schema.
    """
    # Validate input_mappings structure.
    try:
        WorkflowInputMapping.model_validate(payload.input_mappings)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid input_mappings: {exc}",
        ) from exc

    repo = ComfyUIWorkflowRepository(db)
    workflow = await repo.create(**payload.model_dump())
    await db.commit()
    await db.refresh(workflow)
    return ComfyUIWorkflowResponse.model_validate(workflow)


@router.get(
    "/workflows/{workflow_id}",
    response_model=ComfyUIWorkflowResponse,
    status_code=status.HTTP_200_OK,
    summary="Get a ComfyUI workflow by ID",
)
async def get_workflow(
    workflow_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> ComfyUIWorkflowResponse:
    """Fetch a single ComfyUI workflow by ID."""
    repo = ComfyUIWorkflowRepository(db)
    workflow = await repo.get_by_id(workflow_id)
    if workflow is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"ComfyUI workflow {workflow_id} not found",
        )
    return ComfyUIWorkflowResponse.model_validate(workflow)


@router.put(
    "/workflows/{workflow_id}",
    response_model=ComfyUIWorkflowResponse,
    status_code=status.HTTP_200_OK,
    summary="Update a ComfyUI workflow",
)
async def update_workflow(
    workflow_id: UUID,
    payload: ComfyUIWorkflowUpdate,
    db: AsyncSession = Depends(get_db),
) -> ComfyUIWorkflowResponse:
    """Update an existing ComfyUI workflow."""
    repo = ComfyUIWorkflowRepository(db)
    update_data = payload.model_dump(exclude_unset=True)

    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No fields to update",
        )

    # Validate input_mappings if provided.
    if "input_mappings" in update_data and update_data["input_mappings"] is not None:
        try:
            WorkflowInputMapping.model_validate(update_data["input_mappings"])
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid input_mappings: {exc}",
            ) from exc

    workflow = await repo.update(workflow_id, **update_data)
    if workflow is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"ComfyUI workflow {workflow_id} not found",
        )
    await db.commit()
    await db.refresh(workflow)
    return ComfyUIWorkflowResponse.model_validate(workflow)


@router.delete(
    "/workflows/{workflow_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a ComfyUI workflow",
)
async def delete_workflow(
    workflow_id: UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Remove a ComfyUI workflow registration."""
    repo = ComfyUIWorkflowRepository(db)
    deleted = await repo.delete(workflow_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"ComfyUI workflow {workflow_id} not found",
        )
    await db.commit()
