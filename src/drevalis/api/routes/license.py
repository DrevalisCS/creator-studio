"""License management routes.

These endpoints are intentionally exempt from ``LicenseGateMiddleware`` so
an unactivated install can still respond to ``GET /status`` (for the
frontend to know what screen to show) and ``POST /activate`` (to accept a
key from the user).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from drevalis.core.database import get_db_session
from drevalis.core.deps import get_redis, get_settings
from drevalis.core.license.activation import (
    ActivationError,
    ActivationNetworkError,
    deactivate_machine_with_server,
    deactivate_with_server,
    exchange_key_for_jwt,
    list_activations_with_server,
    looks_like_jwt,
)
from drevalis.core.license.claims import LicenseClaims
from drevalis.core.license.machine import stable_machine_id
from drevalis.core.license.state import LicenseStatus, get_state, set_state
from drevalis.core.license.verifier import (
    LicenseState,
    LicenseVerificationError,
    bump_state_version,
    refresh_if_stale,
    verify_jwt,
)
from drevalis.repositories.license_state import LicenseStateRepository

if TYPE_CHECKING:
    from redis.asyncio import Redis
    from sqlalchemy.ext.asyncio import AsyncSession

    from drevalis.core.config import Settings


router = APIRouter(prefix="/api/v1/license", tags=["license"])


class LicenseStatusResponse(BaseModel):
    state: str = Field(description="LicenseStatus value: unactivated|active|grace|expired|invalid")
    tier: str | None = None
    features: list[str] = Field(default_factory=list)
    machines_cap: int | None = None
    machine_id: str
    activated_at: datetime | None = None
    last_heartbeat_at: datetime | None = None
    last_heartbeat_status: str | None = None
    period_end: datetime | None = None
    exp: datetime | None = None
    error: str | None = None


class ActivateRequest(BaseModel):
    license_jwt: str = Field(
        description=(
            "Accepts either a short license key (UUID, as emailed to the "
            "customer) OR a raw signed JWT. If a key is passed and "
            "LICENSE_SERVER_URL is configured, the server exchanges it for "
            "a JWT; otherwise the value is verified locally."
        ),
        min_length=8,
    )


@router.get("/status", response_model=LicenseStatusResponse)
async def get_license_status(
    session: AsyncSession = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    redis: Redis = Depends(get_redis),
) -> LicenseStatusResponse:
    # Status is exempt from LicenseGateMiddleware, so we re-check the
    # cross-process version here ourselves. Otherwise a revocation handled
    # by another uvicorn worker (or the arq heartbeat job) wouldn't be
    # visible in the UI until some other protected route was hit first.
    from drevalis.core.database import get_session_factory as _gsf

    try:
        await refresh_if_stale(
            _gsf(),
            redis,
            public_key_override_pem=settings.license_public_key_override,
        )
    except Exception:
        pass

    state = get_state()
    repo = LicenseStateRepository(session)
    row = await repo.get()
    claims = state.claims
    return LicenseStatusResponse(
        state=state.status.value,
        tier=claims.tier if claims else None,
        features=list(claims.features) if claims and claims.features else [],
        machines_cap=claims.machines if claims else None,
        machine_id=stable_machine_id(),
        activated_at=row.activated_at if row else None,
        last_heartbeat_at=row.last_heartbeat_at if row else None,
        last_heartbeat_status=row.last_heartbeat_status if row else None,
        period_end=claims.period_end_datetime() if claims else None,
        exp=claims.exp_datetime() if claims else None,
        error=state.error,
    )


def _classify_now(claims: LicenseClaims) -> LicenseStatus:
    now = int(datetime.now(tz=UTC).timestamp())
    if now < claims.nbf:
        return LicenseStatus.INVALID
    if now >= claims.exp:
        return LicenseStatus.EXPIRED
    if now >= claims.period_end:
        return LicenseStatus.GRACE
    return LicenseStatus.ACTIVE


@router.post("/activate", response_model=LicenseStatusResponse)
async def activate_license(
    body: ActivateRequest,
    session: AsyncSession = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    redis: Redis = Depends(get_redis),
) -> LicenseStatusResponse:
    """Activate a license on this install.

    Accepts either a JWT (paste directly, Phase 1 path) or a license key
    UUID (Phase 2: exchange with the license server, get a fresh JWT).

    The final stored value is always a JWT, verified with the embedded
    public key before being persisted.
    """
    payload = body.license_jwt.strip()
    machine_id = stable_machine_id()

    # Phase 2 path: license key UUID + server configured. Exchange it.
    if not looks_like_jwt(payload):
        if not settings.license_server_url:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "license_server_not_configured",
                    "hint": (
                        "This install is configured for offline-only "
                        "activation. Paste the raw JWT from your license "
                        "email instead of the short key."
                    ),
                },
            )
        try:
            payload = await exchange_key_for_jwt(
                settings.license_server_url,
                license_key=body.license_jwt.strip(),
                machine_id=machine_id,
            )
        except ActivationNetworkError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"error": "license_server_unreachable", "reason": str(exc)[:200]},
            ) from exc
        except ActivationError as exc:
            raise HTTPException(
                status_code=exc.status_code,
                detail={"error": exc.error, **exc.detail},
            ) from exc

    # Either directly-pasted JWT or server-exchanged — verify before storing.
    try:
        claims = verify_jwt(
            payload,
            public_key_override_pem=settings.license_public_key_override,
        )
    except LicenseVerificationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "invalid_license", "reason": str(exc)[:200]},
        ) from exc

    classification = _classify_now(claims)
    if classification in (LicenseStatus.EXPIRED, LicenseStatus.INVALID):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "license_not_active", "state": classification.value},
        )

    repo = LicenseStateRepository(session)
    await repo.upsert(jwt=payload, machine_id=machine_id)
    await session.commit()

    set_state(LicenseState(status=classification, claims=claims))
    # Invalidate other uvicorn worker processes' cached state.
    await bump_state_version(redis)
    return await get_license_status(session, settings, redis)


@router.post("/deactivate", response_model=LicenseStatusResponse)
async def deactivate_license(
    session: AsyncSession = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    redis: Redis = Depends(get_redis),
) -> LicenseStatusResponse:
    """Remove the stored JWT. App flips back to UNACTIVATED on next request.

    If a license server is configured, best-effort releases the seat so the
    user can activate another machine. Network errors here don't block the
    local deactivate — the JWT is always cleared.
    """
    # Best-effort server-side seat release before we wipe local state.
    current = get_state()
    if settings.license_server_url and current.claims is not None and current.claims.jti:
        await deactivate_with_server(
            settings.license_server_url,
            license_key=current.claims.jti,
            machine_id=stable_machine_id(),
        )

    repo = LicenseStateRepository(session)
    await repo.clear()
    await session.commit()
    set_state(LicenseState(status=LicenseStatus.UNACTIVATED))
    await bump_state_version(redis)
    return await get_license_status(session, settings, redis)


# ─────────────────────────── Activations management ───────────────────


class ActivationEntry(BaseModel):
    machine_id: str
    first_seen: int | None = None
    last_heartbeat: int | None = None
    last_known_version: str | None = None
    is_this_machine: bool = False


class ActivationsResponse(BaseModel):
    tier: str
    cap: int
    this_machine_id: str
    activations: list[ActivationEntry]


@router.get("/activations", response_model=ActivationsResponse)
async def list_activations(
    session: AsyncSession = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
) -> ActivationsResponse:
    """Return every machine currently holding a seat on this license.

    Reads the license key from the locally-stored JWT's ``jti`` claim
    and forwards it to the license server. The ``is_this_machine`` flag
    on each entry tells the UI which row is the one the user is looking
    at right now (so it can label it differently and prevent accidental
    self-deactivation of the session in use).
    """
    if not settings.license_server_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "license_server_not_configured"},
        )
    state = get_state()
    if state.claims is None or not state.claims.jti:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "no_active_license"},
        )

    try:
        raw = await list_activations_with_server(
            settings.license_server_url,
            license_key=state.claims.jti,
        )
    except ActivationNetworkError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "license_server_unreachable", "reason": str(exc)[:200]},
        ) from exc
    except ActivationError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"error": exc.error, **exc.detail},
        ) from exc

    this_id = stable_machine_id()
    entries: list[ActivationEntry] = []
    for a in raw.get("activations", []) or []:
        if not isinstance(a, dict):
            continue
        mid = str(a.get("machine_id") or "")
        entries.append(
            ActivationEntry(
                machine_id=mid,
                first_seen=a.get("first_seen"),
                last_heartbeat=a.get("last_heartbeat"),
                last_known_version=a.get("last_known_version"),
                is_this_machine=(mid == this_id),
            )
        )
    return ActivationsResponse(
        tier=str(raw.get("tier", "")),
        cap=int(raw.get("cap", 1)),
        this_machine_id=this_id,
        activations=entries,
    )


class ActivationsByKeyRequest(BaseModel):
    license_key: str = Field(min_length=8)


class DeactivateByKeyRequest(BaseModel):
    license_key: str = Field(min_length=8)
    machine_id: str = Field(min_length=4, max_length=64)


@router.post(
    "/activations/query",
    response_model=ActivationsResponse,
    summary="List seats for a license key (no local activation required)",
)
async def list_activations_by_key(
    body: ActivationsByKeyRequest,
    settings: Settings = Depends(get_settings),
) -> ActivationsResponse:
    """List seats using a license key supplied in the request body.

    Used by the activation wizard when the local JWT is missing (new
    install or seat-cap lockout). Accepts the key the user pastes from
    their purchase email; relays to the license server which itself
    treats the key as the auth credential.
    """
    if not settings.license_server_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "license_server_not_configured"},
        )
    try:
        raw = await list_activations_with_server(
            settings.license_server_url,
            license_key=body.license_key,
        )
    except ActivationNetworkError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "license_server_unreachable", "reason": str(exc)[:200]},
        ) from exc
    except ActivationError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"error": exc.error, **exc.detail},
        ) from exc

    this_id = stable_machine_id()
    entries: list[ActivationEntry] = []
    for a in raw.get("activations", []) or []:
        if not isinstance(a, dict):
            continue
        mid = str(a.get("machine_id") or "")
        entries.append(
            ActivationEntry(
                machine_id=mid,
                first_seen=a.get("first_seen"),
                last_heartbeat=a.get("last_heartbeat"),
                last_known_version=a.get("last_known_version"),
                is_this_machine=(mid == this_id),
            )
        )
    return ActivationsResponse(
        tier=str(raw.get("tier", "")),
        cap=int(raw.get("cap", 1)),
        this_machine_id=this_id,
        activations=entries,
    )


@router.post(
    "/activations/free-seat",
    response_model=ActivationsResponse,
    summary="Deactivate a machine via license key (works pre-activation)",
)
async def deactivate_machine_by_key(
    body: DeactivateByKeyRequest,
    settings: Settings = Depends(get_settings),
) -> ActivationsResponse:
    """Release the seat for *machine_id* using a license key supplied
    in the request body.

    Used by the activation wizard to recover from seat-cap lockout when
    the user can't access the other machines holding seats. Does NOT
    touch local state (there's nothing to clear pre-activation).
    """
    if not settings.license_server_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "license_server_not_configured"},
        )
    try:
        await deactivate_machine_with_server(
            settings.license_server_url,
            license_key=body.license_key,
            machine_id=body.machine_id,
        )
    except ActivationNetworkError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "license_server_unreachable", "reason": str(exc)[:200]},
        ) from exc
    except ActivationError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"error": exc.error, **exc.detail},
        ) from exc

    return await list_activations_by_key(
        ActivationsByKeyRequest(license_key=body.license_key), settings
    )


@router.post(
    "/activations/{machine_id}/deactivate",
    response_model=ActivationsResponse,
    summary="Deactivate a specific machine",
)
async def deactivate_machine(
    machine_id: str,
    session: AsyncSession = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    redis: Redis = Depends(get_redis),
) -> ActivationsResponse:
    """Release the seat held by ``machine_id`` on this license.

    If ``machine_id`` matches the caller's own machine, additionally
    clears the local JWT — same effect as POST /deactivate. If it's a
    different machine, only the server-side seat is released; the other
    install will lock on its next heartbeat (24h) or next protected
    request that tries to re-bootstrap.
    """
    if not settings.license_server_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "license_server_not_configured"},
        )
    state = get_state()
    if state.claims is None or not state.claims.jti:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "no_active_license"},
        )

    try:
        await deactivate_machine_with_server(
            settings.license_server_url,
            license_key=state.claims.jti,
            machine_id=machine_id,
        )
    except ActivationNetworkError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "license_server_unreachable", "reason": str(exc)[:200]},
        ) from exc
    except ActivationError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail={"error": exc.error, **exc.detail},
        ) from exc

    # If the caller just released this very install's seat, also zero
    # our local JWT so the next request flips the UI to the activation
    # wizard. Otherwise the UI would keep showing "active" while the
    # server has already revoked us.
    if machine_id == stable_machine_id():
        repo = LicenseStateRepository(session)
        await repo.clear()
        await session.commit()
        set_state(LicenseState(status=LicenseStatus.UNACTIVATED))
        await bump_state_version(redis)

    # Re-fetch the list so the UI can render the new state in one round-trip.
    return await list_activations(session, settings)


# ─────────────────────────── Billing portal ───────────────────────────


class PortalResponse(BaseModel):
    url: str


@router.post("/portal", response_model=PortalResponse)
async def open_billing_portal(
    settings: Settings = Depends(get_settings),
) -> PortalResponse:
    """Relay the current license to the server's ``/portal`` endpoint.

    Returns a Stripe billing-portal URL the frontend can redirect to.
    Requires the license_key (``jti``) from the currently-verified JWT, so
    only an actively-licensed install can open the portal.
    """
    import httpx

    state = get_state()
    if not state.is_usable or state.claims is None:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={"error": "license_required"},
        )
    if not settings.license_server_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "license_server_not_configured",
                "hint": "Billing portal requires the online license server. "
                "Manage your subscription at drevalis.com/account instead.",
            },
        )

    url = settings.license_server_url.rstrip("/") + "/portal"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json={"license_key": state.claims.jti})
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "license_server_unreachable", "reason": str(exc)[:200]},
        ) from exc

    if resp.status_code >= 400:
        detail: dict[str, Any] = {}
        try:
            detail = resp.json().get("detail", {})
        except Exception:
            pass
        raise HTTPException(
            status_code=resp.status_code,
            detail=detail if isinstance(detail, dict) else {"raw": str(detail)},
        )
    body = resp.json()
    return PortalResponse(url=body.get("url") or "")
