"""RunPod API router -- cloud GPU pod management and ComfyUI server registration.

Endpoints
---------
GET  /api/v1/runpod/gpu-types                    List GPU types with pricing & VRAM
GET  /api/v1/runpod/pods                         List all pods for this API key
POST /api/v1/runpod/pods                         Provision a new pod
POST /api/v1/runpod/pods/{pod_id}/start          Start (resume) a stopped pod
POST /api/v1/runpod/pods/{pod_id}/stop           Stop a running pod
DELETE /api/v1/runpod/pods/{pod_id}              Delete a pod permanently
POST /api/v1/runpod/pods/{pod_id}/register       Register pod as a ComfyUI server in the DB

The RunPod API key is resolved at request time: the DB store (``api_key_store``
table) is checked first, then the ``RUNPOD_API_KEY`` env var falls back.  This
lets users set the key via the Settings UI without needing to restart the server.

All RunPod operations use the GraphQL API at https://api.runpod.io/graphql.
"""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from shortsfactory.core.config import Settings
from shortsfactory.core.deps import get_db, get_settings
from shortsfactory.core.license.features import fastapi_dep_require_feature
from shortsfactory.core.security import decrypt_value
from shortsfactory.repositories.api_key_store import ApiKeyStoreRepository
from shortsfactory.repositories.comfyui import ComfyUIServerRepository
from shortsfactory.schemas.runpod import (
    RunPodCreatePodRequest,
    RunPodGpuTypeResponse,
    RunPodPodResponse,
    RunPodRegisterPodRequest,
    RunPodRegisterResponse,
    RunPodTemplateResponse,
)
from shortsfactory.services.runpod import RunPodAPIError, RunPodService

router = APIRouter(
    prefix="/api/v1/runpod",
    tags=["runpod"],
    # Pro / Studio only. Solo tiers get 402 on every route in this module.
    dependencies=[Depends(fastapi_dep_require_feature("runpod"))],
)

# -- Internal key name used in api_key_store -----------------------------------
_RUNPOD_KEY_NAME = "runpod"


# -- Dependency: resolve RunPod API key ----------------------------------------


async def _get_runpod_api_key(
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> str:
    """Resolve the RunPod API key from DB store or env var.

    Priority:
    1. Encrypted value in the ``api_key_store`` table (set via Settings UI).
    2. ``RUNPOD_API_KEY`` environment variable / .env file.

    Raises ``HTTP 503`` when neither source has a value, giving the user an
    actionable error message rather than a cryptic 500.
    """
    # 1 -- check DB store first
    repo = ApiKeyStoreRepository(db)
    entry = await repo.get_by_key_name(_RUNPOD_KEY_NAME)
    if entry is not None:
        try:
            return decrypt_value(entry.encrypted_value, settings.encryption_key)
        except Exception:
            # Decryption failure means the key is corrupt -- fall through to env.
            pass

    # 2 -- fall back to env var
    if settings.runpod_api_key:
        return settings.runpod_api_key

    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=(
            "RunPod API key is not configured. "
            "Add it via POST /api/v1/settings/api-keys or set RUNPOD_API_KEY in .env."
        ),
    )


# -- Error handler helper -----------------------------------------------------


def _handle_runpod_error(exc: RunPodAPIError) -> HTTPException:
    """Map a RunPodAPIError to an appropriate FastAPI HTTPException.

    - 401 / 403 from RunPod -> 401 (invalid or missing API key)
    - 404 from RunPod       -> 404 (pod or resource not found)
    - 429 from RunPod       -> 429 (rate limited)
    - everything else       -> 502 (bad gateway / upstream error)
    """
    match exc.status_code:
        case 401 | 403:
            http_status = status.HTTP_401_UNAUTHORIZED
            message = "RunPod API key is invalid or lacks permissions."
        case 404:
            http_status = status.HTTP_404_NOT_FOUND
            message = f"Resource not found on RunPod: {exc.detail}"
        case 429:
            http_status = status.HTTP_429_TOO_MANY_REQUESTS
            message = "RunPod API rate limit exceeded. Please retry shortly."
        case _:
            http_status = status.HTTP_502_BAD_GATEWAY
            message = f"RunPod API returned an error: {exc.detail}"
    return HTTPException(status_code=http_status, detail=message)


# -- GPU types -----------------------------------------------------------------


@router.get(
    "/gpu-types",
    response_model=list[RunPodGpuTypeResponse],
    status_code=status.HTTP_200_OK,
    summary="List available RunPod GPU types with pricing",
    description=(
        "Returns GPU types with VRAM, pricing (on-demand and spot/bid), and "
        "availability in secure and community clouds.  "
        "Use the ``id`` field as the ``gpu_type_id`` parameter in POST /pods."
    ),
)
async def list_gpu_types(
    api_key: str = Depends(_get_runpod_api_key),
) -> list[RunPodGpuTypeResponse]:
    """Fetch the current list of GPU types from RunPod via GraphQL."""
    async with RunPodService(api_key) as svc:
        try:
            raw = await svc.get_gpu_types()
        except RunPodAPIError as exc:
            raise _handle_runpod_error(exc) from exc

    return [RunPodGpuTypeResponse(**entry) for entry in raw]


# -- Templates -----------------------------------------------------------------


@router.get(
    "/templates",
    response_model=list[RunPodTemplateResponse],
    status_code=status.HTTP_200_OK,
    summary="List RunPod pod templates",
    description=(
        "Returns available RunPod pod templates.  Optionally filter by "
        "category (e.g. 'comfyui', 'pytorch').  Use the ``id`` field as the "
        "``template_id`` parameter in POST /pods."
    ),
)
async def list_templates(
    category: str | None = Query(default=None),
    api_key: str = Depends(_get_runpod_api_key),
) -> list[RunPodTemplateResponse]:
    """Fetch pod templates from RunPod, optionally filtered by category."""
    async with RunPodService(api_key) as svc:
        try:
            raw = await svc.get_templates(category=category)
        except RunPodAPIError as exc:
            raise _handle_runpod_error(exc) from exc

    return [RunPodTemplateResponse(**entry) for entry in raw]


# -- Pod listing ---------------------------------------------------------------


@router.get(
    "/pods",
    response_model=list[RunPodPodResponse],
    status_code=status.HTTP_200_OK,
    summary="List all RunPod pods",
    description="Returns all pods associated with the configured RunPod API key.",
)
async def list_pods(
    api_key: str = Depends(_get_runpod_api_key),
) -> list[RunPodPodResponse]:
    """Fetch all pods from the RunPod account via GraphQL."""
    async with RunPodService(api_key) as svc:
        try:
            raw = await svc.list_pods()
        except RunPodAPIError as exc:
            raise _handle_runpod_error(exc) from exc

    return [RunPodPodResponse(**pod) for pod in raw]


# -- Pod creation --------------------------------------------------------------


@router.post(
    "/pods",
    response_model=RunPodPodResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create (provision) a new RunPod pod",
    description=(
        "Provisions a new GPU pod on RunPod via the GraphQL API.  "
        "By default the pod exposes ports 8188 (ComfyUI) and 1234 (LM Studio) "
        "via RunPod's HTTP proxy.  Billing starts as soon as the pod is running."
    ),
)
async def create_pod(
    payload: RunPodCreatePodRequest,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
    api_key: str = Depends(_get_runpod_api_key),
) -> RunPodPodResponse:
    """Provision a new GPU pod on RunPod. Auto-injects HF_TOKEN if stored."""
    from shortsfactory.core.security import decrypt_value as _dec
    from shortsfactory.repositories.api_key_store import ApiKeyStoreRepository

    async with RunPodService(api_key) as svc:
        try:
            # Build env vars
            pod_env: dict[str, str] = {}
            if payload.env:
                pod_env.update(payload.env)

            # Auto-inject HF_TOKEN from api_key_store if not already set
            if "HF_TOKEN" not in pod_env:
                try:
                    hf_row = await ApiKeyStoreRepository(db).get_by_key_name("hf_token")
                    if hf_row:
                        pod_env["HF_TOKEN"] = _dec(hf_row.encrypted_value, settings.encryption_key)
                except Exception:
                    pass

            result = await svc.create_pod(
                name=payload.name,
                gpu_type_id=payload.gpu_type_id,
                image=payload.image,
                gpu_count=payload.gpu_count,
                volume_gb=payload.volume_gb,
                ports=payload.ports,
                template_id=payload.template_id,
                env=pod_env if pod_env else None,
                docker_args=payload.docker_args,
            )
        except RunPodAPIError as exc:
            raise _handle_runpod_error(exc) from exc

    # Enqueue the poll-and-register background job so the caller does not
    # have to manually wait for the pod to reach RUNNING status.
    pod_id = result.get("id", "")
    if pod_id:
        from shortsfactory.core.redis import get_arq_pool

        arq = get_arq_pool()

        # Infer pod type from the image name; default to vllm when ambiguous.
        image_lower = payload.image.lower()
        if "comfyui" in image_lower:
            pod_type = "comfyui"
            register_port = 8188
        else:
            pod_type = "vllm"
            register_port = 8000

        await arq.enqueue_job(
            "auto_deploy_runpod_pod",
            pod_id,
            pod_type,
            api_key,
            register_port,
        )

    return RunPodPodResponse(**result)


# -- Pod start -----------------------------------------------------------------


@router.post(
    "/pods/{pod_id}/start",
    response_model=RunPodPodResponse,
    status_code=status.HTTP_200_OK,
    summary="Start (resume) a stopped RunPod pod",
    description="Resumes a stopped pod.  Billing restarts once the pod is running.",
)
async def start_pod(
    pod_id: str,
    api_key: str = Depends(_get_runpod_api_key),
) -> RunPodPodResponse:
    """Start a stopped RunPod pod."""
    async with RunPodService(api_key) as svc:
        try:
            result = await svc.start_pod(pod_id)
        except RunPodAPIError as exc:
            raise _handle_runpod_error(exc) from exc

    return RunPodPodResponse(**result)


# -- Pod stop ------------------------------------------------------------------


@router.post(
    "/pods/{pod_id}/stop",
    response_model=RunPodPodResponse,
    status_code=status.HTTP_200_OK,
    summary="Stop a running RunPod pod",
    description=(
        "Stops the pod without deleting its persistent volume.  "
        "Billing is suspended while the pod is stopped."
    ),
)
async def stop_pod(
    pod_id: str,
    api_key: str = Depends(_get_runpod_api_key),
) -> RunPodPodResponse:
    """Stop a running RunPod pod."""
    async with RunPodService(api_key) as svc:
        try:
            result = await svc.stop_pod(pod_id)
        except RunPodAPIError as exc:
            raise _handle_runpod_error(exc) from exc

    return RunPodPodResponse(**result)


# -- Pod deletion --------------------------------------------------------------


@router.delete(
    "/pods/{pod_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a RunPod pod",
    description=(
        "Permanently deletes the pod and its persistent volume.  This action cannot be undone."
    ),
)
async def delete_pod(
    pod_id: str,
    api_key: str = Depends(_get_runpod_api_key),
) -> None:
    """Permanently delete a RunPod pod."""
    async with RunPodService(api_key) as svc:
        try:
            await svc.delete_pod(pod_id)
        except RunPodAPIError as exc:
            raise _handle_runpod_error(exc) from exc


# -- Pod registration as ComfyUI server ----------------------------------------


@router.post(
    "/pods/{pod_id}/register",
    response_model=RunPodRegisterResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register a running pod as a ComfyUI server",
    description=(
        "Fetches pod runtime info, derives the public ComfyUI proxy URL, "
        "creates a ComfyUI server entry in the database, and tests the connection.  "
        "The pod must be running and its HTTP port must be exposed."
    ),
)
async def register_pod_as_comfyui_server(
    pod_id: str,
    payload: RunPodRegisterPodRequest,
    db: AsyncSession = Depends(get_db),
    api_key: str = Depends(_get_runpod_api_key),
) -> RunPodRegisterResponse:
    """Register a RunPod pod's ComfyUI instance as a local ComfyUI server.

    Steps:
    1. Fetch current pod list from RunPod and find the target pod.
    2. Extract the proxy URL for the ComfyUI port from pod runtime.
    3. Create (or return existing) ComfyUI server row in DB.
    4. Test the connection with a GET /system_stats call.
    """
    # 1 -- Fetch pod info from the pod list (GraphQL API)
    async with RunPodService(api_key) as svc:
        try:
            pods = await svc.list_pods()
        except RunPodAPIError as exc:
            raise _handle_runpod_error(exc) from exc

    # Find the target pod in the list
    pod = next((p for p in pods if p.get("id") == pod_id), None)
    if pod is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Pod '{pod_id}' not found in RunPod account.",
        )

    # 2 -- Extract proxy URL
    comfyui_url = _extract_proxy_url(pod, payload.comfyui_port)
    if comfyui_url is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Could not find a proxy URL for port {payload.comfyui_port} "
                f"in pod '{pod_id}' runtime info.  "
                "Ensure the pod is running and the port is exposed."
            ),
        )

    # 3 -- Determine server name
    server_name = payload.server_name or f"runpod-{pod_id}"

    # Create or get the ComfyUI server entry.
    comfyui_repo = ComfyUIServerRepository(db)
    existing_servers = await comfyui_repo.get_all()
    existing = next((s for s in existing_servers if s.url == comfyui_url), None)

    if existing is None:
        server = await comfyui_repo.create(
            name=server_name,
            url=comfyui_url,
            api_key_encrypted=api_key,  # Store RunPod API key for auth
            max_concurrent=payload.max_concurrent,
            is_active=True,
        )
        await db.commit()
        await db.refresh(server)
    else:
        server = existing

    # 4 -- Test the connection (with auth)
    connection_ok = False
    message: str
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(10.0), headers={"Authorization": f"Bearer {api_key}"}
        ) as client:
            resp = await client.get(f"{comfyui_url}/system_stats")
            connection_ok = resp.status_code == 200
            message = (
                f"ComfyUI at {comfyui_url} is reachable."
                if connection_ok
                else f"ComfyUI returned HTTP {resp.status_code}."
            )
    except Exception as exc:
        message = f"Connection test failed: {str(exc)[:200]}"

    return RunPodRegisterResponse(
        pod_id=pod_id,
        comfyui_server_id=str(server.id),
        comfyui_url=comfyui_url,
        connection_ok=connection_ok,
        message=message,
    )


# ── Register pod as LLM server ──────────────────────────────────────────


@router.post(
    "/pods/{pod_id}/register-llm",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Register a running pod as an LLM server",
)
async def register_pod_as_llm_server(
    pod_id: str,
    payload: dict[str, Any] | None = None,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
    api_key: str = Depends(_get_runpod_api_key),
) -> dict[str, Any]:
    """Register a RunPod pod's vLLM/Ollama instance as an LLM config.

    Derives the proxy URL, creates an LLM config entry, and tests the connection.
    """
    from shortsfactory.repositories.llm_config import LLMConfigRepository

    llm_port = (payload or {}).get("port", 8000)
    model_name = (payload or {}).get("model", "auto")

    # Fetch pod info
    async with RunPodService(api_key) as svc:
        try:
            pods = await svc.list_pods()
        except RunPodAPIError as exc:
            raise _handle_runpod_error(exc) from exc

    pod = next((p for p in pods if p.get("id") == pod_id), None)
    if pod is None:
        raise HTTPException(404, f"Pod '{pod_id}' not found")

    # Extract proxy URL for the LLM port
    llm_url = _extract_proxy_url(pod, llm_port)
    if llm_url is None:
        raise HTTPException(
            422,
            f"Could not find proxy URL for port {llm_port} on pod '{pod_id}'. "
            "Ensure the pod is running and the port is exposed.",
        )

    # Ensure it ends with /v1 for OpenAI compatibility
    base_url = llm_url.rstrip("/")
    if not base_url.endswith("/v1"):
        base_url += "/v1"

    server_name = f"runpod-llm-{pod_id}"

    # Create or update LLM config
    llm_repo = LLMConfigRepository(db)
    existing_configs = await llm_repo.get_all()
    existing = next((c for c in existing_configs if c.base_url == base_url), None)

    # vLLM pods deployed without API key (RunPod proxy strips auth headers)
    encrypted_key, key_ver = "", 1

    if existing is None:
        config = await llm_repo.create(
            name=server_name,
            base_url=base_url,
            model_name=model_name,
            api_key_encrypted=encrypted_key,
            api_key_version=key_ver,
        )
        await db.commit()
        await db.refresh(config)
    else:
        # Update the API key if it changed
        await llm_repo.update(existing.id, api_key_encrypted=encrypted_key, api_key_version=key_ver)
        await db.commit()
        config = existing

    # Test connection (with auth header)
    connection_ok = False
    message = ""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.get(f"{base_url}/models")
            connection_ok = resp.status_code == 200
            if connection_ok:
                models = resp.json().get("data", [])
                if models and model_name == "auto":
                    # Auto-detect model name
                    detected = models[0].get("id", "auto")
                    await llm_repo.update(config.id, model_name=detected)
                    await db.commit()
                    model_name = detected
                message = f"LLM at {base_url} is reachable. Model: {model_name}"
            else:
                message = f"LLM returned HTTP {resp.status_code}"
    except Exception as exc:
        message = f"Connection test failed: {str(exc)[:200]}"

    return {
        "pod_id": pod_id,
        "llm_config_id": str(config.id),
        "llm_url": base_url,
        "model_name": model_name,
        "connection_ok": connection_ok,
        "message": message,
    }


# -- Auto-deploy status --------------------------------------------------------


@router.get(
    "/pods/{pod_id}/deploy-status",
    response_model=dict[str, Any],
    status_code=status.HTTP_200_OK,
    summary="Get auto-deploy status for a pod",
    description=(
        "Returns the current status of the background poll-and-register job "
        "that was enqueued automatically when the pod was created via POST /pods. "
        "Possible ``status`` values: ``deploying``, ``starting``, ``registering``, "
        "``ready``, ``failed``, ``unknown``."
    ),
)
async def get_deploy_status(pod_id: str) -> dict[str, Any]:
    """Return the Redis-persisted auto-deploy status for a given pod ID.

    The status key is written by the ``auto_deploy_runpod_pod`` arq job and
    expires after 1 hour.  If no key is found the pod was either never
    provisioned through this API or the TTL has elapsed.
    """
    import json

    from redis.asyncio import Redis

    from shortsfactory.core.redis import get_pool

    redis_client: Redis = Redis(connection_pool=get_pool())  # type: ignore[type-arg]
    try:
        raw = await redis_client.get(f"runpod_deploy:{pod_id}:status")
        if raw is None:
            return {
                "pod_id": pod_id,
                "status": "unknown",
                "message": "No deployment tracking found",
            }
        payload_str = raw if isinstance(raw, str) else raw.decode()
        return json.loads(payload_str)  # type: ignore[no-any-return]
    finally:
        await redis_client.aclose()


# -- Helpers -------------------------------------------------------------------


def _extract_proxy_url(pod: dict, port: int) -> str | None:  # type: ignore[type-arg]
    """Derive the public RunPod proxy URL for a given container port.

    RunPod embeds proxy URL info in different places depending on the API
    version and pod state.  This function checks the most common locations:

    1. ``pod["runtime"]["ports"]`` list -- each entry has ``privatePort``,
       ``publicPort``, ``ip``, and ``isIpPublic``.  HTTP proxy URLs follow
       the pattern ``https://{pod_id}-{port}.proxy.runpod.net``.
    2. Falls back to constructing the canonical RunPod proxy URL from the
       pod ID when runtime ports are not available.
    """
    pod_id: str = pod.get("id", "")

    # Primary: look for an explicit proxy URL in the ports list.
    runtime = pod.get("runtime") or {}
    ports: list[dict] = runtime.get("ports", [])  # type: ignore[type-arg]
    for port_info in ports:
        if port_info.get("privatePort") == port:
            # RunPod proxy URL is embedded here on newer API responses.
            proxy_url: str | None = port_info.get("url") or port_info.get("proxyUrl")
            if proxy_url:
                return proxy_url.rstrip("/")
            # Internal IPs are not accessible from outside RunPod.
            # Always use the canonical HTTPS proxy URL instead.
            break

    # Construct the canonical RunPod HTTPS proxy URL.
    # Format: https://{pod_id}-{private_port}.proxy.runpod.net
    if pod_id:
        return f"https://{pod_id}-{port}.proxy.runpod.net"

    return None
